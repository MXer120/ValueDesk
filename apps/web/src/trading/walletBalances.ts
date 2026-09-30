/**
 * What the owner's EVM wallet holds, for the address menu's EVM row.
 *
 *   - ValueChain: every SoDEX token in ONE batched JSON-RPC request straight to
 *     ValueChain's RPC (balanceOf per token plus the SOSO balance) - about
 *     0.3 s, where the backend's deposit-asset read took 0.6-1.6 s.
 *   - Ethereum, Arbitrum, Base, BNB Chain, Polygon: USDC and the gas token, one
 *     batched request per chain to its public RPC (onboard.ts).
 *
 * WHY IT IS A STORE. The menu used to wait for prices, then for all six reads,
 * and only then show anything - and only started when the menu opened. Now the
 * six reads start together, without waiting for prices (amounts are valued
 * when they are shown), each chain lands the moment it answers, and the navbar
 * starts the first read as soon as an address is known, so opening the menu
 * normally finds it ready. After TTL_MS a read is refreshed in the background
 * while the last figures stay on screen.
 *
 * A chain that does not answer keeps its last figures, or is left out - never
 * shown as 0. A coin SoDEX cannot price (POL) is not listed rather than shown
 * "unpriced". Read-only: nothing here signs or sends.
 */
import { cachedAssetConfigs } from './funds';
import { CANONICAL_USDC, EVM_CHAINS, formatUnits } from './onboard';
import { priceOf } from './prices';
import { VALUECHAIN_RPC, balanceOfCall, hexUnits, nativeBalanceCall, rpcBatch } from './rpc';

export interface WalletHolding {
  /** SoDEX chain key: VALUECHAIN, ETH, ARBITRUM_ETH, ... */
  chain: string;
  chainLabel: string;
  symbol: string;
  amount: string;
  usd: number;
}

/** An amount as read on chain, before it is priced. */
export interface RawHolding {
  chain: string;
  chainLabel: string;
  symbol: string;
  amount: string;
}

/** What is known for one owner. A new object on every change (useSyncExternalStore). */
export interface WalletRead {
  rows: RawHolding[];
  /** Chains still being read. */
  pending: number;
  /** When the current read started. */
  at: number;
}

const TTL_MS = 30_000;

interface Entry {
  byChain: Map<string, RawHolding[]>;
  read: WalletRead;
}
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();

export function subscribeWallet(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current figures for `owner`; null before the first read started. */
export const walletRead = (owner: string): WalletRead | null => entries.get(owner.toLowerCase())?.read ?? null;

/**
 * Read `owner`'s wallet unless a read is running or the last one is fresh
 * (`force`: after the sheets moved funds). The previous figures stay until the
 * new ones land, chain by chain.
 */
export function refreshWallet(owner: string, force = false): void {
  const key = owner.toLowerCase();
  const prev = entries.get(key);
  if (prev && (prev.read.pending > 0 || (!force && Date.now() - prev.read.at < TTL_MS))) return;
  const sources: Array<[string, () => Promise<RawHolding[]>]> = [
    ['VALUECHAIN', () => valueChainRows(key)],
    ...Object.values(EVM_CHAINS).map((c): [string, () => Promise<RawHolding[]>] => [c.key, () => otherChainRows(key, c)]),
  ];
  const byChain = new Map(prev?.byChain ?? []);
  const at = Date.now();
  let pending = sources.length;
  const entry: Entry = { byChain, read: { rows: flatten(byChain), pending, at } };
  entries.set(key, entry);
  const publish = () => {
    entry.read = { rows: flatten(byChain), pending, at };
    for (const l of listeners) l();
  };
  publish();
  for (const [chain, read] of sources) {
    read()
      .then((rows) => byChain.set(chain, rows))
      .catch(() => undefined) // unanswered: its last figures stay (or it is left out)
      .finally(() => {
        pending -= 1;
        publish();
      });
  }
}

/** For tests. */
export const _resetWallet = (): void => entries.clear();

const flatten = (byChain: Map<string, RawHolding[]>): RawHolding[] => [...byChain.values()].flat();

/** Rows priced in USD, largest first; unpriceable coins left out. */
export function valueHoldings(rows: RawHolding[], prices: Map<string, number>): WalletHolding[] {
  const out: WalletHolding[] = [];
  for (const r of rows) {
    const px = priceOf(prices, r.symbol);
    if (px === undefined) continue;
    out.push({ ...r, usd: Number(r.amount) * px });
  }
  return out.sort((a, b) => b.usd - a.usd || Number(b.amount) - Number(a.amount));
}

// --- the reads ---------------------------------------------------------------------------

/** A positive amount from a hex answer, or null. */
const amountOf = (hex: string | undefined, decimals: number): string | null => {
  const v = hexUnits(hex);
  return v !== null && v > 0n ? formatUnits(v, decimals) : null;
};

async function valueChainRows(owner: string): Promise<RawHolding[]> {
  const coins = await cachedAssetConfigs();
  const native = coins.find((c) => c.valuechain.native);
  const seen = new Set<string>();
  const tokens = coins.filter((c) => {
    const t = c.valuechain.token.toLowerCase();
    if (c.valuechain.native || seen.has(t)) return false;
    seen.add(t);
    return true;
  });
  const answers = await rpcBatch(VALUECHAIN_RPC, [nativeBalanceCall(owner), ...tokens.map((c) => balanceOfCall(c.valuechain.token, owner))]);
  const out: RawHolding[] = [];
  const row = (symbol: string, amount: string | null) => {
    if (amount) out.push({ chain: 'VALUECHAIN', chainLabel: 'ValueChain', symbol, amount });
  };
  row(native?.coin ?? 'SOSO', amountOf(answers.get(0), native?.valuechain.decimals ?? 18));
  tokens.forEach((c, i) => row(c.coin, amountOf(answers.get(i + 1), c.valuechain.decimals)));
  return out;
}

async function otherChainRows(owner: string, c: (typeof EVM_CHAINS)[keyof typeof EVM_CHAINS]): Promise<RawHolding[]> {
  const usdc = CANONICAL_USDC[c.key];
  const answers = await rpcBatch(c.rpcUrl, [nativeBalanceCall(owner), ...(usdc ? [balanceOfCall(usdc.address, owner)] : [])]);
  const out: RawHolding[] = [];
  const native = amountOf(answers.get(0), c.native.decimals);
  if (native) out.push({ chain: c.key, chainLabel: c.name, symbol: c.native.symbol, amount: native });
  const token = usdc ? amountOf(answers.get(1), usdc.decimals) : null;
  if (token) out.push({ chain: c.key, chainLabel: c.name, symbol: 'USDC', amount: token });
  return out;
}

/**
 * Read-only helpers: chain balances, the deposit-wallet registry, receipts,
 * SoDEX state, and the "where are my funds" snapshot.
 *
 * Built from the app's own read primitives (trading/rpc.ts rpcBatch,
 * trading/gateway.ts readGateway, trading/funds.ts assetConfigs/unitsDown,
 * trading/prices.ts) so the numbers are the ones the UI shows. Nothing here
 * signs or sends.
 */
import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem';
import { unwrapList } from '@sodex-core';
import { readGateway } from '../../src/trading/gateway';
import { CANONICAL_USDC, EVM_CHAINS, formatUnits } from '../../src/trading/onboard';
import { VALUECHAIN_RPC, balanceOfCall, hexUnits, nativeBalanceCall, rpcBatch } from '../../src/trading/rpc';
import { unitsDown, type CoinConfig } from '../../src/trading/funds';
import { coinPrices, priceOf } from '../../src/trading/prices';
import { approx, cut, usd } from './util';

/** sodex.com's deposit-wallet registry on ValueChain (see apps/server/src/sodex/depositWallets.ts). */
export const DEPOSIT_WALLET_REGISTRY = '0x07E28Aa1BB34A625c94870476b24213AB4d2E7C8';
const REGISTRY_ABI = parseAbi(['function getDepositWalletList(address account, string coinSymbol) view returns (string[] chains, string[][] wallets)']);

/** One JSON-RPC read, through the app's batch reader. Throws when the node gives no answer. */
export async function rpcRead(url: string, method: string, params: unknown[]): Promise<unknown> {
  const answers = await rpcBatch(url, [{ method, params }]);
  if (!answers.has(0)) throw new Error(`${method}: no answer from ${new URL(url).host}`);
  return answers.get(0) ?? null;
}

export async function nativeBalance(url: string, holder: string): Promise<bigint> {
  const v = hexUnits((await rpcBatch(url, [nativeBalanceCall(holder)])).get(0));
  if (v === null) throw new Error(`eth_getBalance: unreadable answer from ${new URL(url).host}`);
  return v;
}

export async function tokenBalance(url: string, token: string, holder: string): Promise<bigint> {
  const v = hexUnits((await rpcBatch(url, [balanceOfCall(token, holder)])).get(0));
  if (v === null) throw new Error(`balanceOf: unreadable answer from ${new URL(url).host}`);
  return v;
}

/** The wallet's deposit address per chain for `coinSymbol`, read straight from the on-chain registry (wallets[i][0], as sodex.com uses it). */
export async function registryDepositAddresses(owner: string, coinSymbol: string): Promise<Map<string, string>> {
  const data = encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'getDepositWalletList', args: [owner as `0x${string}`, coinSymbol] });
  const res = await rpcRead(VALUECHAIN_RPC, 'eth_call', [{ to: DEPOSIT_WALLET_REGISTRY, data }, 'latest']);
  if (typeof res !== 'string' || !/^0x[0-9a-fA-F]*$/.test(res)) throw new Error('getDepositWalletList: unreadable answer');
  return decodeDepositWalletList(res);
}

/** Decode getDepositWalletList's (string[] chains, string[][] wallets) - viem's decoder, independent of the backend's own. */
export function decodeDepositWalletList(result: string): Map<string, string> {
  const [chains, wallets] = decodeFunctionResult({ abi: REGISTRY_ABI, functionName: 'getDepositWalletList', data: result as `0x${string}` });
  if (chains.length !== wallets.length) throw new Error('getDepositWalletList: chains and wallets differ in length');
  const out = new Map<string, string>();
  chains.forEach((chain, i) => {
    const w = wallets[i]?.[0]?.trim();
    if (chain && w) out.set(chain.toUpperCase(), w);
  });
  return out;
}

export interface Receipt {
  status: 'success' | 'failed';
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  blockNumber: number;
}

export async function receipt(url: string, hash: string): Promise<Receipt | null> {
  const r = (await rpcRead(url, 'eth_getTransactionReceipt', [hash])) as Record<string, string> | null;
  if (!r || !r.status) return null;
  return {
    status: r.status === '0x1' ? 'success' : 'failed',
    gasUsed: BigInt(r.gasUsed ?? '0x0'),
    effectiveGasPrice: BigInt(r.effectiveGasPrice ?? r.gasPrice ?? '0x0'),
    blockNumber: Number(BigInt(r.blockNumber ?? '0x0')),
  };
}

export async function gasPrice(url: string): Promise<bigint> {
  const v = hexUnits((await rpcRead(url, 'eth_gasPrice', [])) as string);
  if (v === null) throw new Error('eth_gasPrice: unreadable answer');
  return v;
}

// --- SoDEX state ---------------------------------------------------------------------------

export interface StateRow {
  i?: number;
  a?: string;
  t?: string;
  l?: string;
  wb?: string;
  at?: string;
}
export interface EngineState {
  aid?: number;
  B?: StateRow[];
  P?: Array<{ s?: string; sz?: string; ur?: string; ep?: string }>;
  O?: Array<{ s?: string; i?: number; c?: string }>;
  S?: Array<{ s?: string; l?: number; m?: string }>;
  am?: string;
  av?: string;
}

export const engineState = (engine: 'spot' | 'perps', owner: string): Promise<EngineState | null> =>
  readGateway<EngineState | null>(`/api/v1/${engine}/accounts/${owner}/state`);

export interface OpenOrder {
  orderID?: number;
  clOrdID?: string;
  symbol?: string;
  side?: string;
  price?: string;
  origQty?: string;
  status?: string;
}
export const openOrders = async (engine: 'spot' | 'perps', owner: string, symbol?: string): Promise<OpenOrder[]> =>
  unwrapList<OpenOrder>(await readGateway(`/api/v1/${engine}/accounts/${owner}/orders${symbol ? `?symbol=${encodeURIComponent(symbol)}` : ''}`), 'orders');

export interface HistoryOrder extends OpenOrder {
  executedQty?: string;
  executedValue?: string;
}
export const orderHistory = async (engine: 'spot' | 'perps', owner: string, symbol: string, limit = 20): Promise<HistoryOrder[]> =>
  unwrapList<HistoryOrder>(await readGateway(`/api/v1/${engine}/accounts/${owner}/orders/history?symbol=${encodeURIComponent(symbol)}&limit=${limit}`), 'orders');

export interface Position {
  symbol?: string;
  size?: string;
  avgEntryPrice?: string;
  leverage?: number;
  marginMode?: string;
  realizedPnL?: string;
}
export const positions = async (owner: string): Promise<Position[]> =>
  unwrapList<Position>(await readGateway(`/api/v1/perps/accounts/${owner}/positions`), 'positions');

// --- the snapshot: everything the wallet holds, where, and what it is worth --------------------

export interface Holding {
  place: string;
  coin: string;
  amount: string;
  usd: number | null;
}

export interface Snapshot {
  at: number;
  holdings: Holding[];
  totalUsd: number;
  unpriced: string[];
  /** Places that could not be read (their holdings are missing from the total). */
  unreadable: string[];
  openOrders: string[];
  positions: string[];
}

/** Read everything the wallet holds: SoDEX Spot and Perps, its ValueChain wallet, and every EVM chain the app knows. */
export async function snapshot(owner: string, coins: CoinConfig[]): Promise<Snapshot> {
  const unreadable: string[] = [];
  const holdings: Holding[] = [];
  const prices = await coinPrices().catch(() => new Map<string, number>());
  const priced = (coin: string, amount: string): number | null => {
    if (/^v?USDC$/i.test(coin)) return approx(amount);
    const px = priceOf(prices, coin);
    return px === undefined ? null : approx(amount) * px;
  };
  const add = (place: string, coin: string, amount: string) => {
    if (/^0(\.0+)?$/.test(amount)) return;
    holdings.push({ place, coin, amount, usd: priced(coin, amount) });
  };
  const decimalsOf = (assetName: string | undefined, id: number | undefined): number =>
    coins.find((c) => c.assetId === id || c.asset.toUpperCase() === (assetName ?? '').toUpperCase())?.valuechain.decimals ?? 18;

  const [spot, perps, pos, oo] = await Promise.all([
    engineState('spot', owner).catch(() => (unreadable.push('SoDEX Spot'), null)),
    engineState('perps', owner).catch(() => (unreadable.push('SoDEX Perps'), null)),
    positions(owner).catch(() => [] as Position[]),
    Promise.all([openOrders('spot', owner).catch(() => []), openOrders('perps', owner).catch(() => [])]),
  ]);
  for (const r of spot?.B ?? []) {
    const dp = decimalsOf(r.a, r.i);
    add('SoDEX Spot', r.a ?? `#${r.i}`, formatUnits(unitsDown(r.t, dp), dp));
  }
  for (const r of perps?.B ?? []) {
    const dp = decimalsOf(r.a, r.i);
    add('SoDEX Perps', r.a ?? `#${r.i}`, formatUnits(unitsDown(r.wb, dp), dp));
  }
  const upnl = (perps?.P ?? []).reduce((s, p) => s + approx(p.ur), 0);
  if (upnl !== 0) holdings.push({ place: 'SoDEX Perps', coin: 'unrealised PnL (USD)', amount: upnl.toFixed(6), usd: upnl });

  // ValueChain: the gas coin plus every SoDEX token (one batched request, like the app's address menu).
  const native = coins.find((c) => c.valuechain.native);
  const seen = new Set<string>();
  const tokens = coins.filter((c) => {
    const t = c.valuechain.token.toLowerCase();
    if (c.valuechain.native || seen.has(t)) return false;
    seen.add(t);
    return true;
  });
  try {
    const answers = await rpcBatch(VALUECHAIN_RPC, [nativeBalanceCall(owner), ...tokens.map((c) => balanceOfCall(c.valuechain.token, owner))]);
    const n = hexUnits(answers.get(0));
    if (n !== null) add('ValueChain wallet', native?.coin ?? 'SOSO', formatUnits(n, native?.valuechain.decimals ?? 18));
    tokens.forEach((c, i) => {
      const v = hexUnits(answers.get(i + 1));
      if (v !== null) add('ValueChain wallet', c.coin, formatUnits(v, c.valuechain.decimals));
    });
  } catch {
    unreadable.push('ValueChain wallet');
  }
  await Promise.all(
    Object.values(EVM_CHAINS).map(async (c) => {
      const usdc = CANONICAL_USDC[c.key];
      try {
        const a = await rpcBatch(c.rpcUrl, [nativeBalanceCall(owner), ...(usdc ? [balanceOfCall(usdc.address, owner)] : [])]);
        const n = hexUnits(a.get(0));
        if (n !== null) add(`${c.name} wallet`, c.native.symbol, formatUnits(n, c.native.decimals));
        const u = usdc ? hexUnits(a.get(1)) : null;
        if (u !== null && usdc) add(`${c.name} wallet`, 'USDC', formatUnits(u, usdc.decimals));
      } catch {
        unreadable.push(`${c.name} wallet`);
      }
    }),
  );
  const unpriced = holdings.filter((h) => h.usd === null).map((h) => `${h.coin} (${h.place})`);
  return {
    at: Date.now(),
    holdings,
    totalUsd: holdings.reduce((s, h) => s + (h.usd ?? 0), 0),
    unpriced,
    unreadable,
    openOrders: [...oo[0].map((o) => `spot ${o.symbol} #${o.orderID} ${o.side} ${o.origQty}@${o.price}`), ...oo[1].map((o) => `perps ${o.symbol} #${o.orderID} ${o.side} ${o.origQty}@${o.price}`)],
    positions: pos.filter((p) => approx(p.size) !== 0).map((p) => `${p.symbol} size ${p.size} entry ${p.avgEntryPrice}`),
  };
}

export interface InFlight {
  what: string;
  since: number;
  /** Where to look it up (explorer / SoDEX tx). */
  ref?: string;
}

/** "Where your funds are now" - printed at every stop, so nothing has to be guessed. */
export function whereFundsLines(s: Snapshot, inFlight: InFlight[]): string[] {
  const lines: string[] = [];
  const places = [...new Set(s.holdings.map((h) => h.place))];
  if (!places.length) lines.push('  (nothing found on SoDEX, ValueChain or the EVM chains)');
  for (const p of places) {
    const row = s.holdings
      .filter((h) => h.place === p)
      .map((h) => `${h.coin} ${cut(h.amount, 8)}${h.usd !== null && Math.abs(h.usd) >= 0.01 ? ` (${usd(h.usd)})` : ''}`)
      .join(', ');
    lines.push(`  ${p.padEnd(24)} ${row}`);
  }
  lines.push(`  ${'Open orders'.padEnd(24)} ${s.openOrders.length ? s.openOrders.join('; ') : 'none'}`);
  lines.push(`  ${'Perps positions'.padEnd(24)} ${s.positions.length ? s.positions.join('; ') : 'none'}`);
  for (const f of inFlight) lines.push(`  ${'IN FLIGHT'.padEnd(24)} ${f.what}${f.ref ? ` [${f.ref}]` : ''} (since ${new Date(f.since).toISOString()})`);
  if (s.unreadable.length) lines.push(`  ${'Could not read'.padEnd(24)} ${s.unreadable.join(', ')}`);
  lines.push(`  ${'Total (priced)'.padEnd(24)} ${usd(s.totalUsd)}${s.unpriced.length ? ` - unpriced: ${s.unpriced.join(', ')}` : ''}`);
  return lines;
}

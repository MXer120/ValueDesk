/**
 * Deposit from the connected wallet on Base, through SoDEX's bridge - sodex.com's
 * "Deposit from connected wallet" (live for Base USDC since 2026-11-27, researched
 * from its bundle that day): no deposit address, the wallet hands the coin to
 * SoDEX's bridge contract on Base itself and SoDEX credits it to Spot.
 *
 *   1. the wallet allows the bridge to take exactly the amount (ERC-20 approve,
 *      only when the allowance is short) and the approval is mined (2 blocks);
 *   2. the wallet sends ONE call to the bridge:
 *        bridge(string coinSymbol, address receiver, uint256 amount, bool toClob)
 *      or for SOSO bridgeNativeToken(address receiver, uint256 amount, bool toClob),
 *      receiver = the wallet itself, toClob = true (credited to Spot);
 *   3. SoDEX lists it in its deposit history as a "BridgeDeposit" (account_flow,
 *      keyed by the Base transaction hash) - the sheet follows it there.
 *
 * STRICTER THAN SODEX.COM, NEVER LAXER. Before the wallet is asked for anything:
 * SoDEX's maintenance switch, the route's own switch (asset config `bridge`), and
 * the token and bridge contracts as ValueChain itself names them (the Query
 * contract's getTokenConfig for USDC and the index tokens, the mirror registry
 * for SOSO) - a route whose addresses do not match is refused. USDC must be
 * Circle's own Base USDC. Then on Base: the token's symbol and decimals, the
 * balance, gas, and the bridge call is simulated (eth_call) before it is sent -
 * a deposit the contract would refuse is never sent.
 *
 * Staked SOSO (sSOSO) is left out: SoDEX's bridge pays it to the ValueChain
 * wallet, not to Spot.
 */
import { abiEncode, bytesToHex, concat, keccak256, utf8 } from '@sodex-core';
import { MIRROR_REGISTRY, MIRROR_SELECTORS, decodeRemoteNativeTokens } from '@sign/sodex/mirrorCore.js';
import { addOrSwitchChain, getChainId, sendTransaction, WalletError, type Eip1193Provider } from '../wallet';
import { requireTermsOrThrow } from '../legal/acceptance';
import { logger } from '../log';
import { CANONICAL_USDC, EVM_CHAINS, formatUnits, parseUnits, type EvmChain } from './onboard';
import { QUERY_CONTRACT, maintenanceFor, maintenanceNote, valueChainCall, type Maintenance } from './relay';
import { rpcCall } from './rpc';
import { promptCounter, type ChainRoute, type CoinConfig, type StepSink } from './funds';

const log = logger('trade');

/** The one network SoDEX bridges deposits from today. */
export const BRIDGE_CHAIN: EvmChain = EVM_CHAINS.BASE_ETH!;
/** Coins the bridge pays somewhere other than Spot (sSOSO: the ValueChain wallet), or that are not offered for deposit (soUSDC). */
const NOT_OFFERED = new Set(['SSOSO', 'SOUSDC']);
/** Base confirmations before an approval counts and a deposit is reported sent (sodex.com waits 2). */
const CONFIRMATIONS = 2;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const same = (a: string | null | undefined, b: string | null | undefined): boolean => !!a && !!b && a.toLowerCase() === b.toLowerCase();

// --- what is offered ----------------------------------------------------------------------

export interface BridgeRoute {
  /** SoDEX's coin name, e.g. "USDC" (the bridge call's coinSymbol). */
  coin: string;
  /** What Spot is credited with, e.g. "vUSDC". */
  asset: string;
  /** The token contract on Base, as SoDEX's asset config names it. */
  token: string;
  /** SoDEX's bridge contract on Base, as SoDEX's asset config names it. */
  bridge: string;
  /** SoDEX's minimum, in the coin (decimal string), when it gave one. */
  min: string | null;
  etaSeconds: number | null;
}

/**
 * The coins SoDEX takes through its Base bridge right now (its own switch on),
 * USDC first. Their addresses are re-checked on ValueChain before anything is
 * sent (depositViaBridge).
 */
export function bridgeRoutes(configs: readonly CoinConfig[]): BridgeRoute[] {
  const out: BridgeRoute[] = [];
  for (const c of configs) {
    if (NOT_OFFERED.has(c.coin.toUpperCase())) continue;
    const r: ChainRoute | undefined = c.chains.find((x) => x.key === BRIDGE_CHAIN.key);
    const b = r?.bridge;
    if (!r || !b?.deposit || !ADDRESS_RE.test(b.address) || !ADDRESS_RE.test(r.tokenAddress ?? '')) continue;
    out.push({ coin: c.coin, asset: c.asset, token: r.tokenAddress!, bridge: b.address, min: b.min ?? r.deposit.min, etaSeconds: b.etaSeconds ?? r.deposit.etaSeconds });
  }
  return out.sort((a, b) => (a.coin === 'USDC' ? -1 : b.coin === 'USDC' ? 1 : a.coin.localeCompare(b.coin)));
}

// --- calldata -------------------------------------------------------------------------------

const sel = (sig: string): Uint8Array => keccak256(utf8(sig)).slice(0, 4);
const call = (sig: string, types: Parameters<typeof abiEncode>[0], values: unknown[]): string => bytesToHex(concat(sel(sig), abiEncode(types, values)));

/** The bridge call that deposits `amount` of `coin` for `receiver` (SOSO has its own entry point). */
export function bridgeCallData(coin: string, receiver: string, amount: bigint, toClob = true): string {
  if (!ADDRESS_RE.test(receiver)) throw new Error('bad receiver address');
  if (amount <= 0n) throw new RangeError('amount must be positive');
  if (NOT_OFFERED.has(coin.toUpperCase())) throw new Error(`${coin} is not deposited through this route`);
  return coin.toUpperCase() === 'SOSO'
    ? call('bridgeNativeToken(address,uint256,bool)', ['address', 'uint256', 'bool'], [receiver, amount, toClob])
    : call('bridge(string,address,uint256,bool)', ['string', 'address', 'uint256', 'bool'], [coin, receiver, amount, toClob]);
}
export const approveData = (spender: string, amount: bigint): string => call('approve(address,uint256)', ['address', 'uint256'], [spender, amount]);
export const allowanceData = (owner: string, spender: string): string => call('allowance(address,address)', ['address', 'address'], [owner, spender]);
export const tokenConfigData = (coin: string): string => call('getTokenConfig(string)', ['string'], [coin]);

// --- what ValueChain itself says ------------------------------------------------------------

export interface OnChainRoute {
  token: string;
  bridge: string;
}

const word = (h: string, i: number): bigint => BigInt(`0x${h.slice(i * 64, i * 64 + 64) || '0'}`);
function stringArray(h: string, head: number): string[] {
  const at = Number(word(h, head)) / 32;
  const n = Number(word(h, at));
  const out: string[] = [];
  for (let k = 0; k < n; k++) {
    const off = at + 1 + Number(word(h, at + 1 + k)) / 32;
    const len = Number(word(h, off));
    const hex = h.slice((off + 1) * 64, (off + 1) * 64 + len * 2);
    out.push(decodeURIComponent(hex.replace(/(..)/g, '%$1')));
  }
  return out;
}

/**
 * The Base token and bridge in the Query contract's
 * `getTokenConfig(coin) -> (string[] chains, string[] coinAddrs, string[] bridgeAddrs, ...)`; null when Base is not listed.
 */
export function decodeTokenConfigBase(result: string): OnChainRoute | null {
  const h = result.replace(/^0x/, '');
  if (h.length < 64 * 3) return null;
  const chains = stringArray(h, 0);
  const i = chains.findIndex((c) => c.toUpperCase() === BRIDGE_CHAIN.key);
  if (i < 0) return null;
  const token = stringArray(h, 1)[i] ?? '';
  const bridge = stringArray(h, 2)[i] ?? '';
  return ADDRESS_RE.test(token) && ADDRESS_RE.test(bridge) ? { token, bridge } : null;
}

export interface BridgeDeps {
  valueChainCall: (to: string, data: string) => Promise<string>;
  maintenance: (coin: string, owner: string) => Promise<Maintenance>;
  /** A read on Base's public node; errors are returned, not thrown (rpc.ts rpcCall). */
  baseRpc: <T>(method: string, params: unknown[]) => Promise<{ result?: T; error?: { message?: string } }>;
  requireTerms: (owner: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}

export const defaultBridgeDeps: BridgeDeps = {
  valueChainCall,
  maintenance: (coin, owner) => maintenanceFor(coin, owner),
  baseRpc: <T,>(method: string, params: unknown[]) => rpcCall<T>(BRIDGE_CHAIN.rpcUrl, method, params),
  requireTerms: (owner) => requireTermsOrThrow({ owner, reason: 'make this deposit' }),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** The Base token and bridge ValueChain names for `coin`: the Query contract, or for SOSO the mirror registry. */
export async function onChainRoute(coin: string, deps: Pick<BridgeDeps, 'valueChainCall'> = defaultBridgeDeps): Promise<OnChainRoute | null> {
  if (coin.toUpperCase() === 'SOSO') {
    const row = decodeRemoteNativeTokens(await deps.valueChainCall(MIRROR_REGISTRY, MIRROR_SELECTORS.listRemoteNativeTokens))
      .find((t) => t.chain.toUpperCase() === BRIDGE_CHAIN.key);
    return row && ADDRESS_RE.test(row.coinAddr) && ADDRESS_RE.test(row.bridgeAddr) ? { token: row.coinAddr, bridge: row.bridgeAddr } : null;
  }
  return decodeTokenConfigBase(await deps.valueChainCall(QUERY_CONTRACT, tokenConfigData(coin)));
}

/**
 * Everything that can be checked before the wallet is asked: SoDEX's
 * maintenance, its switch, and the addresses against ValueChain. Throws with
 * the reason; nothing has been signed or sent when it does.
 */
export async function checkBridgeRoute(route: BridgeRoute, owner: string, deps: BridgeDeps = defaultBridgeDeps): Promise<void> {
  const m = await deps.maintenance(route.coin, owner);
  const off = maintenanceNote(m, BRIDGE_CHAIN.key, 'deposit');
  if (off?.severity === 'unavailable') {
    throw new WalletError(off.message ? `SoDEX has ${route.coin} deposits on Base paused: ${off.message}. Nothing was sent.` : `SoDEX has ${route.coin} deposits on Base paused. Nothing was sent.`);
  }
  if (route.coin.toUpperCase() === 'USDC' && !same(route.token, CANONICAL_USDC[BRIDGE_CHAIN.key]?.address)) {
    throw new WalletError(`SoDEX lists ${route.token} as USDC on Base, which is not Circle's USDC. Nothing was sent.`);
  }
  let chain: OnChainRoute | null;
  try {
    chain = await onChainRoute(route.coin, deps);
  } catch (e) {
    throw new WalletError(`ValueChain could not confirm SoDEX's Base bridge (${(e as Error).message}). Nothing was sent - try again in a moment.`);
  }
  if (!chain) throw new WalletError(`ValueChain lists no Base bridge for ${route.coin}. Nothing was sent.`);
  if (!same(chain.token, route.token) || !same(chain.bridge, route.bridge)) {
    log.warn('bridge route refused: SoDEX config and ValueChain disagree', { coin: route.coin, config: { token: route.token, bridge: route.bridge }, chain });
    throw new WalletError(`SoDEX's ${route.coin} bridge on Base does not match what ValueChain names. Nothing was sent.`);
  }
}

// --- the deposit -----------------------------------------------------------------------------

export interface BridgeDeposit {
  hash: string;
  explorerUrl: string;
  /** The amount as sent, in the coin. */
  amount: string;
  /** false: sent, but Base had not shown it mined with 2 confirmations in time - it may still be. */
  confirmed: boolean;
}

/** Wait for `hash` on Base: the receipt's status once `CONFIRMATIONS` blocks have it; null when it took longer than `timeoutMs`. */
async function mined(hash: string, deps: BridgeDeps, timeoutMs: number): Promise<'success' | 'reverted' | null> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const r = await deps.baseRpc<{ status?: string; blockNumber?: string } | null>('eth_getTransactionReceipt', [hash]).catch(() => ({ result: null }));
    const rc = r.result;
    if (rc && typeof rc.status === 'string' && typeof rc.blockNumber === 'string') {
      if (BigInt(rc.status) !== 1n) return 'reverted';
      const head = await deps.baseRpc<string>('eth_blockNumber', []).catch(() => ({ result: undefined }));
      if (typeof head.result === 'string' && BigInt(head.result) - BigInt(rc.blockNumber) + 1n >= BigInt(CONFIRMATIONS)) return 'success';
    }
    if (Date.now() > until) return null;
    await deps.sleep(2000);
  }
}

/** One eth_call on Base's public node: the hex answer, or a throw with the node's reason (a revert). */
async function baseCall(deps: BridgeDeps, tx: { from?: string; to: string; data: string }): Promise<string> {
  const r = await deps.baseRpc<string>('eth_call', [tx, 'latest']);
  if (r.error || typeof r.result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(r.result)) throw new Error(r.error?.message || 'Base did not answer');
  return r.result;
}
const asUint = (hex: string): bigint => (hex === '0x' ? 0n : BigInt(hex));
/** Wei as ETH with at most 6 significant decimals, rounded UP (a fee shown lower than it is would mislead). */
export function ethText(wei: bigint): string {
  if (wei <= 0n) return '0';
  const s = formatUnits(wei, 18);
  const [w, f = ''] = s.split('.');
  const lead = f.search(/[1-9]/);
  if (lead < 0) return w!;
  const keep = Math.min(18, lead + 2);
  const step = 10n ** BigInt(18 - keep);
  const up = ((wei + step - 1n) / step) * step;
  return formatUnits(up, 18);
}

/** ABI `string` return (symbol). */
function abiString(hex: string): string {
  const h = hex.replace(/^0x/, '');
  if (h.length < 128) return '';
  const len = Number(BigInt(`0x${h.slice(64, 128)}`));
  return decodeURIComponent(h.slice(128, 128 + len * 2).replace(/(..)/g, '%$1'));
}

export interface BaseHoldings {
  symbol: string;
  decimals: number;
  /** The coin in the wallet on Base, base units. */
  balance: bigint;
  /** What the bridge may already take, base units. */
  allowance: bigint;
  /** ETH for gas, wei. */
  gas: bigint;
  /** Base's gas price now, wei. */
  gasPrice: bigint;
}

/**
 * Gas the two steps take on Base, measured 2026-11-27: bridge() 78,979 and 83,767 gas, bridgeNativeToken() 69,686
 * (real deposits' receipts); a USDC approve 56,240 (eth_estimateGas). Rounded up; the fee check doubles the price.
 */
const DEPOSIT_GAS = 110_000n;
const APPROVE_GAS = 70_000n;
/** Base's L1 data fee per transaction was 0.45-4.3 gwei-ETH on those receipts; this covers it with room. */
const L1_FEE_ROOM = 100_000_000_000n;

/** The ETH (wei) the wallet needs on Base for the network fee: the deposit, plus the approval when it is due - at twice today's gas price. */
export const networkFeeWei = (h: Pick<BaseHoldings, 'gasPrice'>, approving: boolean): bigint =>
  ((approving ? APPROVE_GAS : 0n) + DEPOSIT_GAS) * h.gasPrice * 2n + (approving ? 2n : 1n) * L1_FEE_ROOM;

/** The token as Base itself reports it, and the wallet's balance, allowance for the bridge and gas - Base's public node. */
export async function readBaseHoldings(route: BridgeRoute, owner: string, deps: BridgeDeps = defaultBridgeDeps): Promise<BaseHoldings> {
  const quantity = (method: string, params: unknown[]) =>
    deps.baseRpc<string>(method, params).then((r) => {
      if (typeof r.result !== 'string') throw new Error(r.error?.message || 'Base did not answer');
      return r.result;
    });
  const [sym, dec, bal, allow, gas, price] = await Promise.all([
    baseCall(deps, { to: route.token, data: '0x95d89b41' }),
    baseCall(deps, { to: route.token, data: '0x313ce567' }),
    baseCall(deps, { to: route.token, data: `0x70a08231${owner.replace(/^0x/, '').toLowerCase().padStart(64, '0')}` }),
    baseCall(deps, { to: route.token, data: allowanceData(owner, route.bridge) }),
    quantity('eth_getBalance', [owner, 'latest']),
    quantity('eth_gasPrice', []),
  ]);
  return { symbol: abiString(sym), decimals: Number(asUint(dec)), balance: asUint(bal), allowance: asUint(allow), gas: asUint(gas), gasPrice: asUint(price) };
}

/**
 * Deposit `amount` of `route.coin` from the connected wallet on Base into the
 * owner's SoDEX Spot through SoDEX's bridge. The wallet's prompts, counted up
 * front: the switch to Base (when it is elsewhere), the approval (only when the
 * allowance is short), the deposit.
 */
export async function depositViaBridge(
  o: { provider: Eip1193Provider; owner: string; route: BridgeRoute; amount: string; onStep?: StepSink },
  deps: BridgeDeps = defaultBridgeDeps,
): Promise<BridgeDeposit> {
  const { provider, route } = o;
  const owner = o.owner.toLowerCase();
  const amount = o.amount.trim();
  if (!/^\d+(\.\d+)?$/.test(amount) || !(Number(amount) > 0)) throw new RangeError('Enter an amount.');
  await deps.requireTerms(owner);
  await checkBridgeRoute(route, owner, deps);

  // The token as Base reports it, the amount in its own decimals, the minimum, the balance and gas.
  let h: BaseHoldings;
  try {
    h = await readBaseHoldings(route, owner, deps);
  } catch (e) {
    throw new WalletError(`Base could not be read (${(e as Error).message}). Nothing was sent - try again in a moment.`);
  }
  const canon = CANONICAL_USDC[BRIDGE_CHAIN.key];
  if (route.coin.toUpperCase() === 'USDC' && (!/^USDC$/i.test(h.symbol) || h.decimals !== canon?.decimals)) {
    throw new WalletError(`The token at ${route.token} on Base is not USDC (${h.symbol}, ${h.decimals} decimals). Nothing was sent.`);
  }
  const units = parseUnits(amount, h.decimals);
  if (route.min && units < parseUnits(route.min, h.decimals)) throw new RangeError(`The minimum deposit is ${route.min} ${route.coin}.`);
  if (h.balance < units) throw new WalletError(`Your wallet holds ${formatUnits(h.balance, h.decimals)} ${route.coin} on Base - not enough for ${amount} ${route.coin}.`);
  const approving = h.allowance < units;
  // Base charges a network fee in ETH for each step (SoDEX's bridge itself takes none on a deposit).
  if (h.gas === 0n) throw new WalletError('Your wallet has no ETH on Base to pay the network fee. Nothing was sent.');
  const fee = networkFeeWei(h, approving);
  if (h.gas < fee) throw new WalletError(`Your wallet needs about ${ethText(fee)} ETH on Base for the network fee and holds ${ethText(h.gas)}. Nothing was sent.`);

  const wantChain = BRIDGE_CHAIN.chainId;
  const switching = (await getChainId(provider)) !== wantChain;
  const ask = promptCounter(o.onStep, (switching ? 1 : 0) + (approving ? 1 : 0) + 1);
  if (switching) ask('approve');
  await addOrSwitchChain(provider, {
    chainId: `0x${wantChain.toString(16)}`,
    chainName: BRIDGE_CHAIN.name,
    rpcUrls: [BRIDGE_CHAIN.rpcUrl],
    blockExplorerUrls: [BRIDGE_CHAIN.explorer],
    nativeCurrency: BRIDGE_CHAIN.native,
  });

  // 1. The allowance: exactly the amount (as sodex.com), only when short, mined before the deposit goes.
  if (approving) {
    ask('approve');
    const approval = await sendTransaction(provider, { from: owner, to: route.token, data: approveData(route.bridge, units), value: '0x0', chainId: wantChain });
    o.onStep?.({ wallet: null });
    const done = await mined(approval, deps, 180_000);
    if (done !== 'success') {
      throw new WalletError(done === 'reverted' ? 'The approval failed on Base. Nothing was deposited.' : 'Base has not confirmed the approval yet. Nothing was deposited - try again in a minute.');
    }
    const now = asUint(await baseCall(deps, { to: route.token, data: allowanceData(owner, route.bridge) }).catch(() => '0x'));
    if (now < units) throw new WalletError('The approval does not cover the amount yet. Nothing was deposited - try again in a minute.');
  }

  // 2. The deposit: run first exactly as the wallet will send it - a call the bridge refuses is never sent.
  const deposit = bridgeCallData(route.coin, owner, units, true);
  try {
    await baseCall(deps, { from: owner, to: route.bridge, data: deposit });
  } catch (e) {
    throw new WalletError(`SoDEX's bridge would refuse this deposit (${(e as Error).message || 'reverted'}). Nothing was sent.`);
  }
  ask('confirm');
  log.info('bridge deposit: asking the wallet to send it', { coin: route.coin, amount });
  const hash = await sendTransaction(provider, { from: owner, to: route.bridge, data: deposit, value: '0x0', chainId: wantChain });
  o.onStep?.({ wallet: null });
  const done = await mined(hash, deps, 120_000);
  if (done === 'reverted') throw new WalletError(`The deposit failed on Base (${hash}). Your ${route.coin} stayed in your wallet.`);
  return { hash, explorerUrl: `${BRIDGE_CHAIN.explorer}/tx/${hash}`, amount: formatUnits(units, h.decimals), confirmed: done === 'success' };
}

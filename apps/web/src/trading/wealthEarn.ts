/**
 * USDC Earn (fundId Morpho-Earn, share vsoUSDC): subscribe and redeem in the app, so the shares can be held as Futures
 * margin (owner 2026-11-27: "use usdc earn as margin"). SoDEX's bridged vault, docs.sodex.com/for-developers Bridged
 * Vaults (added 2026-11-17), direct submission: the wallet calls the Caller and pays SOSO gas; no approval, no permit.
 *
 *   deposit  createBridgeCallFor("BASE_ETH", 3, "USDC", assets, "soUSDC", minShares, false)
 *   redeem   createBridgeCallFor("BASE_ETH", 4, "soUSDC", shares, "USDC", minAssets, false)
 *
 * toClob=false: the result lands in the signing wallet's ValueChain balance (the docs' example). The Caller is not
 * hard-coded: the Portal names it (caller()), and getToken("soUSDC") must be the fund's share token or nothing is sent.
 *
 * Measured read-only 2026-11-27 on the Caller's last 60 orders: each settled in 0.8-1.3 minutes, in and out at the
 * fund's NAV with no fee taken; sodex.com sends a minimum of 99% of the expected amount (so do we, EARN_KEEP).
 * Minimums are the Caller's own (callForMinAmounts: 5 USDC in, 4 soUSDC out that day), read each time.
 * Not run against the contracts from this app yet: calldata is checked against the verified ABI in wealthEarn.test.ts.
 */
import { WalletError, type Eip1193Provider } from '../wallet';
import { VALUECHAIN_RPC, balanceOfCall, hexUnits, nativeBalanceCall, rpcBatch, rpcCall } from './rpc';
import { waitForReceipt, type Receipt } from './relay';
import { cachedAssetConfigs, promptCounter, type CoinConfig, type StepSink } from './funds';
import { ensureChain, preflight, readFund, readMarkets, send, uintWord, type WealthQuote } from './wealth';
import { logger } from '../log';

const log = logger('wealth-earn');

/** SoDEX's Mainnet Portal (docs, Wealth Contracts: "start from Portal ..., read the active addresses"). */
export const PORTAL = '0x07E28Aa1BB34A625c94870476b24213AB4d2E7C8';
export const EARN_FUND = 'Morpho-Earn';
/** The external execution network of this vault (docs: Base, BASE_ETH). */
export const EARN_CHAIN = 'BASE_ETH';
/** Bridge calls use SoDEX's symbols: the share is "soUSDC" there, "vsoUSDC" on the Wealth page. */
export const EARN_SYMBOL = { usdc: 'USDC', share: 'soUSDC' } as const;
export const CALL_TYPE = { deposit: 3, redeem: 4 } as const;
/** The least of the expected amount the request accepts, in basis points (sodex.com's own orders: 99%). */
export const EARN_KEEP = 9_900n;

export const EARN_SELECTOR = {
  caller: '0xfc9c8d39', // caller()
  getToken: '0xc1733f68', // getToken(string)
  createBridgeCallFor: '0xb88670e7', // createBridgeCallFor(string,uint8,string,uint256,string,uint256,bool)
  getCallForById: '0x8797ff41', // getCallForById(uint256)
  callForMinAmounts: '0xd954bf9d', // callForMinAmounts(string,string)
  isCallForCoinSymbolPair: '0x9036d9e6', // isCallForCoinSymbolPair(string,string,string)
} as const;
/** BridgeCallForCreated((uint256,string,string,address,uint8,string,string,uint256,string,string,uint256,uint256,uint8,uint256,uint256,string,bool,uint256)). */
export const CALL_CREATED_TOPIC = '0xee66fdf3605015adecc8fae2d15605aee8ee073bea64c34ba5547f744ff15060';

// --- ABI with strings ------------------------------------------------------------------------------

const strTail = (s: string): string => {
  const hex = Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('');
  return uintWord(BigInt(hex.length / 2)) + (hex.length ? hex.padEnd(Math.ceil(hex.length / 64) * 64, '0') : '');
};

type Arg = { s: string } | { w: string };

/** Head words and tails of an argument list, in the Solidity ABI's order: a string's head is its tail's offset. */
export function encodeArgs(args: readonly Arg[]): string {
  let offset = args.length * 32;
  const heads: string[] = [];
  const tails: string[] = [];
  for (const a of args) {
    if ('w' in a) { heads.push(a.w); continue; }
    const t = strTail(a.s);
    heads.push(uintWord(BigInt(offset)));
    tails.push(t);
    offset += t.length / 2;
  }
  return heads.join('') + tails.join('');
}

const boolWord = (b: boolean): string => uintWord(b ? 1n : 0n);

export function bridgeCallData(side: 'buy' | 'sell', amount: bigint, minOut: bigint): string {
  const [inSym, outSym] = side === 'buy' ? [EARN_SYMBOL.usdc, EARN_SYMBOL.share] : [EARN_SYMBOL.share, EARN_SYMBOL.usdc];
  return EARN_SELECTOR.createBridgeCallFor + encodeArgs([
    { s: EARN_CHAIN },
    { w: uintWord(BigInt(side === 'buy' ? CALL_TYPE.deposit : CALL_TYPE.redeem)) },
    { s: inSym },
    { w: uintWord(amount) },
    { s: outSym },
    { w: uintWord(minOut) },
    { w: boolWord(false) },
  ]);
}

export const getTokenData = (symbol: string): string => EARN_SELECTOR.getToken + encodeArgs([{ s: symbol }]);
export const minAmountData = (symbol: string): string => EARN_SELECTOR.callForMinAmounts + encodeArgs([{ s: EARN_CHAIN }, { s: symbol }]);
export const pairData = (inSym: string, outSym: string): string => EARN_SELECTOR.isCallForCoinSymbolPair + encodeArgs([{ s: EARN_CHAIN }, { s: inSym }, { s: outSym }]);
export const callForData = (id: bigint): string => EARN_SELECTOR.getCallForById + uintWord(id);

/** One bridge order, its static fields (the strings are not needed here). */
export interface CallFor {
  callForId: bigint;
  user: string;
  callForType: number;
  inAmount: bigint;
  minOutAmount: bigint;
  outAmount: bigint;
  /** 0 PENDING, 1 SUCCESS, 2 FAILED, 3 REJECTED, 4 APPROVED (docs, Settlement and recovery). */
  status: number;
  createdAt: number;
  settledAt: number;
  toClob: boolean;
}

/**
 * The BridgeCallFor tuple, from a getCallForById return or a BridgeCallForCreated log's data: one dynamic tuple, so
 * the first word is the tuple's offset and its head holds the static fields at their places (verified ABI order).
 */
export function decodeCallFor(hex: string): CallFor {
  const d = hex.startsWith('0x') ? hex.slice(2) : hex;
  const at = Number(BigInt(`0x${d.slice(0, 64)}`)) * 2;
  const w = (i: number): bigint => {
    const s = d.slice(at + i * 64, at + (i + 1) * 64);
    if (s.length !== 64) throw new RangeError('short bridge order');
    return BigInt(`0x${s}`);
  };
  return {
    callForId: w(0),
    user: `0x${(w(3) & ((1n << 160n) - 1n)).toString(16).padStart(40, '0')}`,
    callForType: Number(w(4)),
    inAmount: w(7),
    minOutAmount: w(10),
    outAmount: w(11),
    status: Number(w(12)),
    createdAt: Number(w(13)),
    settledAt: Number(w(14)),
    toClob: w(16) === 1n,
  };
}

/** The order this wallet's request created, from its receipt (the Caller's BridgeCallForCreated naming this user). */
export function callForOfReceipt(receipt: Receipt, caller: string, owner: string): CallFor | null {
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== caller.toLowerCase() || l.topics[0]?.toLowerCase() !== CALL_CREATED_TOPIC) continue;
    try {
      const o = decodeCallFor(l.data);
      if (o.user.toLowerCase() === owner.toLowerCase()) return o;
    } catch { /* not ours */ }
  }
  return null;
}

// --- amounts --------------------------------------------------------------------------------------

const TEN = (n: number): bigint => 10n ** BigInt(n);

/** A decimal string as an integer scaled by 1e18 (the NAV), exact to 18 places. */
export function wad(v: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(v.trim());
  if (!m) throw new RangeError('bad NAV');
  return BigInt(m[1]!) * TEN(18) + BigInt((m[2] ?? '').slice(0, 18).padEnd(18, '0'));
}

/** What the request expects back at the fund's NAV, in the output token's base units. */
export function expectedOut(side: 'buy' | 'sell', amount: bigint, nav: bigint, usdcDp: number, shareDp: number): bigint {
  if (nav <= 0n) return 0n;
  return side === 'buy'
    ? (amount * TEN(shareDp) * TEN(18)) / (nav * TEN(usdcDp))
    : (amount * nav * TEN(usdcDp)) / (TEN(18) * TEN(shareDp));
}

/** The least the request accepts: EARN_KEEP of the expected amount, rounded down. */
export const minOutOf = (expected: bigint): bigint => (expected * EARN_KEEP) / 10_000n;

// --- reads ----------------------------------------------------------------------------------------

/** USDC Earn's row on SoDEX's Wealth board (its live 7-day APY), or null when the board has none. */
export const readEarnBoard = (): Promise<WealthQuote | null> => readMarkets().then((q) => q.find((x) => x.fundId === EARN_FUND) ?? null);

export interface EarnFacts {
  caller: string;
  usdc: CoinConfig;
  share: CoinConfig;
  /** The fund's NAV, scaled by 1e18, and when SoDEX struck it. */
  nav: bigint;
  navAsOf: string | null;
  /** Base units. */
  minIn: bigint;
  minRedeem: bigint;
  usdcBalance: bigint;
  shareBalance: bigint;
  gasBalance: bigint;
  /** Both directions enabled on the Caller and the share token is the fund's. */
  open: boolean;
  why: string | null;
}

const word = (hex: string | undefined): bigint | null => hexUnits(hex);
const addressOf = (hex: string | undefined): string | null => {
  const v = word(hex);
  return v === null || v === 0n ? null : `0x${v.toString(16).padStart(40, '0')}`;
};

/** The coin configs SoDEX lists for USDC and soUSDC (tokens, decimals, collateral ratio). */
export async function earnCoins(): Promise<{ usdc: CoinConfig; share: CoinConfig }> {
  const all = await cachedAssetConfigs();
  const usdc = all.find((c) => c.coin === 'USDC');
  const share = all.find((c) => c.coin === EARN_SYMBOL.share);
  if (!usdc || !share) throw new WalletError('SoDEX does not list USDC Earn\'s tokens right now.');
  return { usdc, share };
}

/** Everything off the chain and the API at the moment of asking. */
export async function readEarnFacts(owner: string): Promise<EarnFacts> {
  const [fund, coins, callerRes] = await Promise.all([
    readFund(EARN_FUND),
    earnCoins(),
    rpcCall<string>(VALUECHAIN_RPC, 'eth_call', [{ to: PORTAL, data: EARN_SELECTOR.caller }, 'latest']),
  ]);
  const caller = addressOf(callerRes.result);
  if (!caller) throw new WalletError('Could not read SoDEX\'s bridge from ValueChain. Nothing was sent.');
  const call = (to: string, data: string) => ({ method: 'eth_call', params: [{ to, data }, 'latest'] });
  const r = await rpcBatch(VALUECHAIN_RPC, [
    call(PORTAL, getTokenData(EARN_SYMBOL.share)),
    call(caller, minAmountData(EARN_SYMBOL.usdc)),
    call(caller, minAmountData(EARN_SYMBOL.share)),
    call(caller, pairData(EARN_SYMBOL.usdc, EARN_SYMBOL.share)),
    call(caller, pairData(EARN_SYMBOL.share, EARN_SYMBOL.usdc)),
    balanceOfCall(coins.usdc.valuechain.token, owner),
    balanceOfCall(coins.share.valuechain.token, owner),
    nativeBalanceCall(owner),
  ]);
  const shareToken = addressOf(r.get(0));
  const sameShare = !!shareToken && shareToken.toLowerCase() === fund.share.address.toLowerCase()
    && shareToken.toLowerCase() === coins.share.valuechain.token.toLowerCase();
  const pairs = word(r.get(3)) === 1n && word(r.get(4)) === 1n;
  const nav = fund.nav ? wad(fund.nav) : 0n;
  const why = !sameShare ? 'SoDEX\'s bridge names another share token than the fund. Nothing can be sent.'
    : !pairs ? 'SoDEX has this route switched off right now.'
    : nav <= 0n ? 'SoDEX has no NAV for USDC Earn right now.'
    : fund.fundStatus !== 'live' ? 'USDC Earn is not live right now.'
    : null;
  return {
    caller,
    usdc: coins.usdc,
    share: coins.share,
    nav,
    navAsOf: fund.asOf ?? null,
    minIn: word(r.get(1)) ?? 0n,
    minRedeem: word(r.get(2)) ?? 0n,
    usdcBalance: word(r.get(5)) ?? 0n,
    shareBalance: word(r.get(6)) ?? 0n,
    gasBalance: word(r.get(7)) ?? 0n,
    open: why === null,
    why,
  };
}

/** Why a request cannot go, in words, or null. `amount` in base units of what is spent. */
export function earnProblem(side: 'buy' | 'sell', amount: bigint, f: EarnFacts): string | null {
  if (!f.open) return f.why;
  if (amount <= 0n) return 'Enter an amount.';
  if (side === 'buy') {
    if (amount < f.minIn) return 'Below SoDEX\'s minimum for USDC Earn.';
    if (amount > f.usdcBalance) return 'Not enough USDC in your wallet on ValueChain.';
  } else {
    if (amount < f.minRedeem) return 'Below SoDEX\'s minimum redemption.';
    if (amount > f.shareBalance) return 'More than the shares in your wallet.';
  }
  if (f.gasBalance === 0n) return 'This wallet has no SOSO for gas on ValueChain.';
  return null;
}

/** USDC Earn's smallest subscription, in USDC (the Caller's own minimum, read now); 0 when it cannot be read. */
export async function readEarnMinIn(): Promise<number> {
  const c = await rpcCall<string>(VALUECHAIN_RPC, 'eth_call', [{ to: PORTAL, data: EARN_SELECTOR.caller }, 'latest']);
  const caller = addressOf(c.result);
  if (!caller) return 0;
  const r = await rpcCall<string>(VALUECHAIN_RPC, 'eth_call', [{ to: caller, data: minAmountData(EARN_SYMBOL.usdc) }, 'latest']);
  const v = word(r.result);
  return v === null ? 0 : Number(v) / 1e6;
}

export async function readCallFor(caller: string, id: bigint): Promise<CallFor | null> {
  const r = await rpcCall<string>(VALUECHAIN_RPC, 'eth_call', [{ to: caller, data: callForData(id) }, 'latest']);
  if (r.error || !r.result || r.result === '0x') return null;
  try { return decodeCallFor(r.result); } catch { return null; }
}

/** SUCCESS, FAILED or REJECTED: the order will not change again. */
export const settled = (o: CallFor): boolean => o.status === 1 || o.status === 2 || o.status === 3;

/** Asks for the order every 5 s (the docs: 5-10 s) until it settles or `timeoutMs` passes; the last read either way. */
export async function waitCallFor(caller: string, id: bigint, timeoutMs = 10 * 60_000, onRead?: (o: CallFor) => void): Promise<CallFor | null> {
  const until = Date.now() + timeoutMs;
  let last: CallFor | null = null;
  for (;;) {
    const o = await readCallFor(caller, id).catch(() => null);
    if (o) { last = o; onRead?.(o); if (settled(o)) return o; }
    if (Date.now() > until) return last;
    await new Promise((res) => setTimeout(res, 5000));
  }
}

// --- sending --------------------------------------------------------------------------------------

export interface EarnRequest { hash: string; caller: string; order: CallFor | null }

/**
 * One request from the wallet: subscribe (USDC -> vsoUSDC) or redeem (vsoUSDC -> USDC), into the wallet's own
 * ValueChain balance. A confirmed transaction is a created order, not a settled one: watch it with waitCallFor.
 */
export async function requestEarn(o: { provider: Eip1193Provider; owner: string; side: 'buy' | 'sell'; amount: bigint; onStep?: StepSink }): Promise<EarnRequest> {
  await preflight(o.owner, o.side);
  const f = await readEarnFacts(o.owner);
  const problem = earnProblem(o.side, o.amount, f);
  if (problem) throw new RangeError(problem);
  const exp = expectedOut(o.side, o.amount, f.nav, f.usdc.valuechain.decimals, f.share.valuechain.decimals);
  const min = minOutOf(exp);
  if (min <= 0n) throw new RangeError('That amount is too small to price.');
  const { chainId, switched } = await ensureChain(o.provider);
  const ask = promptCounter(o.onStep, (switched ? 1 : 0) + 1);
  if (switched) ask('approve');
  ask('confirm');
  const hash = await send(o.provider, o.owner, chainId, f.caller, bridgeCallData(o.side, o.amount, min), o.side === 'buy' ? 'USDC Earn subscription' : 'USDC Earn redemption');
  const receipt = await waitForReceipt(hash, 30_000);
  const order = receipt ? callForOfReceipt(receipt, f.caller, o.owner) : null;
  log.info('earn request', { side: o.side, order: order?.callForId.toString() ?? null });
  return { hash, caller: f.caller, order };
}


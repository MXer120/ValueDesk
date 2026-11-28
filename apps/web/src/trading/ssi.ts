/**
 * SSI index funds (fundType ssi-v2, channel ssi-v2-rfq: ANT Believers Index), bought and redeemed in the app (owner
 * 2026-11-28: "EVERYTHING should be fully doable on valuedesk"). Not in SoDEX's docs; this is the flow sodex.com runs
 * (its Wealth bundle, read 2026-11-28), with the same checks:
 *
 *   quote   our relay -> wealth.sodex.dev POST /funds/{id}/rfq/quote: a maker's EIP-712 order for this wallet
 *   buy     approve USDC to the issuer (order.taker), then issuer.mintViaRFQ(token, usdc, pay, minShareOut, order, sig)
 *   sell    issuer.redeemViaRFQ(token, shares, usdc, minReceive, order, sig)
 *
 * Every order is checked against the fund (requester, beneficiary, legs, amounts, expiry) and simulated on ValueChain
 * (eth_call from the wallet) before the wallet is asked. Calldata is checked against viem in ssi.test.ts.
 */
import { WalletError, type Eip1193Provider } from '../wallet';
import { VALUECHAIN_RPC, balanceOfCall, hexUnits, nativeBalanceCall, rpcBatch, rpcCall } from './rpc';
import { promptCounter, type StepSink } from './funds';
import { addrWord, allowanceOf, approveData, ensureChain, preflight, send, uintWord } from './wealth';

// --- a small ABI encoder (address, uint256, bytes, address[], uint256[], tuples) ----------------------

export type AbiT = 'address' | 'uint256' | 'bytes' | 'address[]' | 'uint256[]' | { tuple: AbiT[] };
const isDyn = (t: AbiT): boolean => t === 'bytes' || t === 'address[]' || t === 'uint256[]' || (typeof t === 'object' && t.tuple.some(isDyn));
const hex = (h: string) => (h.startsWith('0x') ? h.slice(2) : h).toLowerCase();

function encStatic(t: AbiT, v: unknown): string {
  if (t === 'address') return addrWord(v as string);
  if (t === 'uint256') return uintWord(BigInt(v as bigint | string));
  if (typeof t === 'object') return encodeAbi(t.tuple, v as unknown[]);
  throw new RangeError(`not static: ${String(t)}`);
}
function encDyn(t: AbiT, v: unknown): string {
  if (t === 'bytes') {
    const h = hex(v as string);
    if (!/^([0-9a-f]{2})*$/.test(h)) throw new RangeError('bad bytes');
    return uintWord(BigInt(h.length / 2)) + (h.length ? h.padEnd(Math.ceil(h.length / 64) * 64, '0') : '');
  }
  if (t === 'address[]') { const a = v as string[]; return uintWord(BigInt(a.length)) + a.map(addrWord).join(''); }
  if (t === 'uint256[]') { const a = v as Array<bigint | string>; return uintWord(BigInt(a.length)) + a.map((x) => uintWord(BigInt(x))).join(''); }
  if (typeof t === 'object') return encodeAbi(t.tuple, v as unknown[]);
  throw new RangeError(`not dynamic: ${String(t)}`);
}
/** The ABI encoding of `values` as `types` (no selector). */
export function encodeAbi(types: readonly AbiT[], values: readonly unknown[]): string {
  if (types.length !== values.length) throw new RangeError('arity');
  let off = types.length * 32;
  const heads: string[] = [];
  const tails: string[] = [];
  types.forEach((t, i) => {
    if (!isDyn(t)) { heads.push(encStatic(t, values[i])); return; }
    const body = encDyn(t, values[i]);
    heads.push(uintWord(BigInt(off)));
    tails.push(body);
    off += body.length / 2;
  });
  return heads.join('') + tails.join('');
}

// --- the order -------------------------------------------------------------------------------------

export interface SsiOrder {
  requester: string; maker: string; taker: string; beneficiary: string;
  expiry: bigint; nonce: bigint; makerRate: bigint; takerRate: bigint;
  makerTokens: string[]; makerAmounts: bigint[]; takerTokens: string[]; takerAmounts: bigint[];
}
export const ORDER_T: AbiT = { tuple: ['address', 'address', 'address', 'address', 'uint256', 'uint256', 'uint256', 'uint256', 'address[]', 'uint256[]', 'address[]', 'uint256[]'] };
const orderValues = (o: SsiOrder) => [o.requester, o.maker, o.taker, o.beneficiary, o.expiry, o.nonce, o.makerRate, o.takerRate, o.makerTokens, o.makerAmounts, o.takerTokens, o.takerAmounts];

export const SSI_SELECTOR = {
  mintViaRFQ: '0x10024b19', // mintViaRFQ(address,address,uint256,uint256,(order),bytes)
  redeemViaRFQ: '0x92e94e8f', // redeemViaRFQ(address,uint256,address,uint256,(order),bytes)
  digest: '0xbe048620', // digest((order)) on SSIRFQ
} as const;

export const mintData = (token: string, asset: string, pay: bigint, minOut: bigint, o: SsiOrder, sig: string) =>
  SSI_SELECTOR.mintViaRFQ + encodeAbi(['address', 'address', 'uint256', 'uint256', ORDER_T, 'bytes'], [token, asset, pay, minOut, orderValues(o), sig]);
export const redeemData = (token: string, shares: bigint, asset: string, minOut: bigint, o: SsiOrder, sig: string) =>
  SSI_SELECTOR.redeemViaRFQ + encodeAbi(['address', 'uint256', 'address', 'uint256', ORDER_T, 'bytes'], [token, shares, asset, minOut, orderValues(o), sig]);
export const digestData = (o: SsiOrder) => SSI_SELECTOR.digest + encodeAbi([ORDER_T], [orderValues(o)]);

export interface SsiQuote {
  side: 'buy' | 'sell';
  payAmount: bigint;
  receive: bigint;
  minReceive: bigint;
  order: SsiOrder;
  signature: string;
  digest: string;
  /** Seconds since 1970 the order stops. */
  expiry: number;
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const big = (v: unknown, what: string): bigint => {
  if (typeof v !== 'string' || !/^[0-9]{1,78}$/.test(v)) throw new WalletError(`SoDEX's quote has a bad ${what}.`);
  return BigInt(v);
};
const addr = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !ADDR.test(v) || /^0x0{40}$/i.test(v)) throw new WalletError(`SoDEX's quote has a bad ${what}.`);
  return v;
};
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * SoDEX's answer, checked as sodex.com checks it: the order is this wallet's, pays or delivers this fund's token and
 * USDC, the amounts are the ones asked for, and it has not expired. `assetDecimals` is USDC's on ValueChain (6).
 */
export function parseSsiQuote(raw: unknown, want: { side: 'buy' | 'sell'; owner: string; token: string; asset: string; payAmount: bigint; assetDecimals: number }): SsiQuote {
  const d = (raw ?? {}) as { protocol?: string; quotable?: boolean; side?: string; ssi?: Record<string, unknown> };
  if (d.quotable === false) throw new WalletError('The maker did not quote this right now.');
  if (d.protocol !== 'ssi-v2-rfq' || !d.ssi) throw new WalletError('SoDEX did not answer with an index order.');
  const s = d.ssi;
  const o = (s.order ?? {}) as Record<string, unknown>;
  const list = (a: unknown, what: string, f: (x: unknown, w: string) => unknown) => {
    if (!Array.isArray(a) || a.length === 0 || a.length > 64) throw new WalletError(`SoDEX's quote has a bad ${what}.`);
    return a.map((x) => f(x, what));
  };
  const order: SsiOrder = {
    requester: addr(o.requester, 'requester'), maker: addr(o.maker, 'maker'), taker: addr(o.taker, 'issuer'), beneficiary: addr(o.beneficiary, 'beneficiary'),
    expiry: big(o.expiry, 'expiry'), nonce: big(o.nonce, 'nonce'), makerRate: big(o.makerRate, 'maker rate'), takerRate: big(o.takerRate, 'taker rate'),
    makerTokens: list(o.makerTokens, 'maker leg', addr) as string[], makerAmounts: list(o.makerAmounts, 'maker leg', big) as bigint[],
    takerTokens: list(o.takerTokens, 'taker leg', addr) as string[], takerAmounts: list(o.takerAmounts, 'taker leg', big) as bigint[],
  };
  if (order.makerTokens.length !== order.makerAmounts.length || order.takerTokens.length !== order.takerAmounts.length) throw new WalletError('SoDEX\'s quote has uneven legs.');
  const signature = typeof s.signature === 'string' && /^0x[0-9a-fA-F]{130}$/.test(s.signature) ? s.signature : null;
  const digest = typeof s.digest === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s.digest) ? s.digest : null;
  if (!signature || !digest) throw new WalletError('SoDEX\'s quote has no valid signature.');
  const receive = big(s.expectedReceiveAmount, 'expected amount');
  const minReceive = big(s.minimumReceiveAmount, 'minimum amount');
  if (!same(order.requester, want.owner)) throw new WalletError('SoDEX\'s quote is for another wallet.');
  if (order.makerRate <= 0n || order.takerRate <= 0n || minReceive <= 0n || minReceive > receive) throw new WalletError('SoDEX\'s quote amounts do not add up.');
  if (want.side === 'buy') {
    const scaled = want.payAmount * 10n ** BigInt(18 - want.assetDecimals);
    if (!same(order.beneficiary, want.token) || order.takerTokens.length !== 1 || !same(order.takerTokens[0]!, want.asset) || order.takerRate !== 10n ** 18n || order.takerAmounts[0] !== scaled) {
      throw new WalletError('SoDEX\'s quote does not match this payment.');
    }
  } else if (!same(order.beneficiary, want.owner) || order.makerTokens.length !== 1 || !same(order.makerTokens[0]!, want.asset) || order.makerAmounts[0] !== 10n ** 18n) {
    throw new WalletError('SoDEX\'s quote does not pay USDC to this wallet.');
  }
  return { side: want.side, payAmount: want.payAmount, receive, minReceive, order, signature, digest, expiry: Number(order.expiry) };
}

// --- reads and sending --------------------------------------------------------------------------------

export async function requestSsiQuote(fundId: string, side: 'buy' | 'sell', owner: string, payAmount: bigint): Promise<unknown> {
  const r = await fetch('/api/vs/wealth/ssi-quote', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ fundId, side, owner, payAmount: payAmount.toString() }), cache: 'no-store',
  });
  const j = (await r.json().catch(() => null)) as { ok?: boolean; error?: string; data?: unknown } | null;
  if (!j?.ok) throw new WalletError(j?.error || 'SoDEX did not answer with a quote.');
  return j.data;
}

export interface SsiFacts { usdc: bigint; shares: bigint; gas: bigint }
export async function readSsiFacts(owner: string, token: string, asset: string): Promise<SsiFacts> {
  const r = await rpcBatch(VALUECHAIN_RPC, [balanceOfCall(asset, owner), balanceOfCall(token, owner), nativeBalanceCall(owner)]);
  return { usdc: hexUnits(r.get(0)) ?? 0n, shares: hexUnits(r.get(1)) ?? 0n, gas: hexUnits(r.get(2)) ?? 0n };
}

/** Approve USDC if a buy needs it, check the order on chain (digest, simulation), then send it from the wallet. */
export async function fillSsiQuote(o: { provider: Eip1193Provider; owner: string; token: string; asset: string; rfq: string; q: SsiQuote; onStep?: StepSink }): Promise<string> {
  const { q } = o;
  await preflight(o.owner, q.side);
  const left = () => q.expiry - Math.floor(Date.now() / 1000);
  if (left() < 5) throw new WalletError('The quote expired. Ask for a new one.');
  const dg = await rpcCall<string>(VALUECHAIN_RPC, 'eth_call', [{ to: o.rfq, data: digestData(q.order) }, 'latest']);
  if (dg.error || !dg.result || !same(dg.result, q.digest)) throw new WalletError('The order does not match SoDEX\'s index contract. Nothing was sent.');
  const issuer = q.order.taker;
  const data = q.side === 'buy' ? mintData(o.token, o.asset, q.payAmount, q.minReceive, q.order, q.signature) : redeemData(o.token, q.payAmount, o.asset, q.minReceive, q.order, q.signature);
  const { chainId, switched } = await ensureChain(o.provider);
  const needApprove = q.side === 'buy' && (await allowanceOf(o.asset, o.owner, issuer)) < q.payAmount;
  const ask = promptCounter(o.onStep, (switched ? 1 : 0) + (needApprove ? 1 : 0) + 1);
  if (switched) ask('approve');
  if (needApprove) {
    ask('approve');
    await send(o.provider, o.owner, chainId, o.asset, approveData(issuer, q.payAmount), 'approval');
    if (left() < 5) throw new WalletError('The quote expired while approving. Ask for a new one; the approval stays.');
  }
  const sim = await rpcCall<string>(VALUECHAIN_RPC, 'eth_call', [{ from: o.owner, to: issuer, data }, 'latest']);
  if (sim.error) throw new WalletError('SoDEX\'s index contract would refuse this order right now. Nothing was sent; ask for a new quote.');
  ask('confirm');
  return send(o.provider, o.owner, chainId, issuer, data, q.side === 'buy' ? 'index buy' : 'index redemption');
}

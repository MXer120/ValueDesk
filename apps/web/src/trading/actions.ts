/**
 * Trading actions, signed in this browser and sent straight to SoDEX.
 *
 * Each one: the trading key from session.ts, the symbol's rules from the
 * market list, the payload from orderParams.ts, a nonce from the cross-tab
 * nonce manager, sodex-core's signer, and gateway.ts's transport. The result
 * shapes match what the backend's trading routes returned, so the order
 * ticket, the account tables and the chart need no changes.
 *
 * A batch that SoDEX accepts as a whole can still reject single orders inside
 * it (per-order `code`). Those are raised, naming what went through and what
 * did not - never reported as a clean "submitted".
 */
import {
  OrderValidationError,
  SodexApiError,
  failedOrders,
  signAndBuildWithNonceManager,
  unwrapList,
  type BuilderParams,
  type Engine,
  type OrderResult,
  type SignableAction,
} from '@sodex-core';
import { api } from '../api';
import { activeBuilder, orderBuilder, type BuilderApproval } from './builder';
import { tradingConfig } from './config';
import { readGateway, sendSigned } from './gateway';
import {
  cancelManyActions,
  cancelOrderAction,
  crossTransferAction,
  leverageAction,
  marginAction,
  modifyOrderAction,
  placeOrderAction,
  replaceOrderAction,
  scheduleCancelAction,
  withdrawAction,
  type MarketSymbol,
  type OpenOrderRef,
  type OrderTicket,
} from './orderParams';
import {
  TradingError,
  builderApprovalPending,
  checkKeyAfterRejection,
  keyRejected,
  nonces,
  refreshBuilderApproval,
  requireSigner,
} from './session';
import { logger } from '../log';

const log = logger('trade');

// --- markets -----------------------------------------------------------------

const SYMBOL_TTL_MS = 5 * 60_000;
const symbolCache = new Map<Engine, { at: number; list: Promise<MarketSymbol[]> }>();

async function symbols(engine: Engine): Promise<MarketSymbol[]> {
  const hit = symbolCache.get(engine);
  if (hit && Date.now() - hit.at < SYMBOL_TTL_MS) return hit.list;
  const list = api.symbols(engine).then((r) => r.symbols as unknown as MarketSymbol[]);
  symbolCache.set(engine, { at: Date.now(), list });
  list.catch(() => symbolCache.delete(engine));
  return list;
}

export async function symbolFor(engine: Engine, ref: string): Promise<MarketSymbol> {
  const want = String(ref).toUpperCase();
  const list = await symbols(engine);
  const hit = list.find((s) => s.name.toUpperCase() === want || s.displayName.toUpperCase() === want);
  if (!hit) throw new OrderValidationError(`unknown ${engine} market ${ref}`);
  return hit;
}

// --- signing + sending ---------------------------------------------------------

/**
 * The builder fee to attach on `engine`: only where SoDEX lists an approval of
 * the configured builder that covers the fee, per engine (builder.ts). An order
 * naming an unapproved builder is rejected, so "not listed" means "not sent".
 */
function builderFor(engine: Engine, approved: BuilderApproval | null): BuilderParams | undefined {
  return orderBuilder(tradingConfig().builder, approved, engine);
}

/**
 * The builder for an order placed NOW. Where the approval is not listed and it
 * matters - SoDEX accepted one moments ago, or this build requires one - it is
 * re-read first. A build that requires the fee refuses the order rather than
 * send it without one.
 */
async function builderForOrder(engine: Engine): Promise<BuilderParams | undefined> {
  const cfg = activeBuilder(tradingConfig().builder);
  if (!cfg || cfg.fee[engine] <= 0) return undefined;
  let builder = builderFor(engine, requireSigner(undefined, engine).meta.builder);
  if (!builder && (cfg.required || builderApprovalPending())) {
    builder = builderFor(engine, await refreshBuilderApproval());
  }
  if (!builder && cfg.required) {
    throw new TradingError(
      `SoDEX does not list your approval of the Valuescan builder fee for ${engine} orders, and trading through Valuescan requires it. If you approved it a moment ago, try again shortly; otherwise press "Valuescan fee" in the order ticket and approve it there.`,
      'builder-required',
    );
  }
  return builder;
}

/**
 * SoDEX refused something and names the builder: the approval this browser
 * remembers may be gone (revoked on another device) or too low. Re-read it, so
 * the next order goes out the way SoDEX will accept. Nothing is re-sent.
 */
function noteBuilderRejection(e: unknown): void {
  if (!(e instanceof SodexApiError) || !/builder/i.test(e.message)) return;
  if (!activeBuilder(tradingConfig().builder)) return;
  log.warn('SoDEX refused an order over its builder fee; re-reading the approval', { code: e.code, message: e.message });
  void refreshBuilderApproval();
}

async function signAndSend<T = unknown>(action: SignableAction, what: string): Promise<T> {
  const s = requireSigner(undefined, action.engine);
  const cfg = tradingConfig();
  const req = await signAndBuildWithNonceManager(action, s.key, { chainId: cfg.chainId, nonces: nonces(), base: '' });
  try {
    return await sendSigned<T>(req, what);
  } catch (e) {
    if (e instanceof SodexApiError) {
      if (/api key not found|key not found|unknown api key|key.*expired/i.test(e.message)) keyRejected();
      // A signature/auth refusal can mean the key was replaced on another
      // device: ask SoDEX, and drop the key if so (the next click re-enables).
      else if (e.httpStatus === 401 || e.code === 401 || /signature|unauthori[sz]ed|api key/i.test(e.message)) void checkKeyAfterRejection();
      noteBuilderRejection(e);
    }
    throw e;
  }
}

/** Raise per-order rejections inside an accepted batch. */
function checkBatch(result: unknown, what: string, labels: readonly string[] = []): void {
  const list = Array.isArray(result) ? (result as OrderResult[]) : unwrapList<OrderResult>(result, 'orders');
  const failed = failedOrders(list);
  if (!failed.length) return;
  const ok = list.length - failed.length;
  const describe = (r: OrderResult) => {
    const i = list.indexOf(r);
    const label = labels[i] ?? r.clOrdID;
    return `${label}: ${r.error || `code ${r.code}`}`;
  };
  const msg =
    ok > 0
      ? `Part of the ${what} went through, but SoDEX rejected ${failed.map(describe).join('; ')}. Check your open orders.`
      : `SoDEX rejected the ${what}: ${failed.map(describe).join('; ')}`;
  log.warn(`${what}: rejected inside an accepted batch`, { failed: failed.length, total: list.length });
  throw new SodexApiError(failed[0]!.code, msg, 200, '', result);
}

// --- orders ----------------------------------------------------------------------

export async function placeOrder(engine: Engine, t: OrderTicket) {
  const s = requireSigner(undefined, engine);
  const sym = await symbolFor(engine, t.symbol);
  const builder = await builderForOrder(engine);
  const built = placeOrderAction(engine, t, sym, s.meta.accountId, builder);
  const labels = ['the order', ...(t.takeProfit ? ['the take-profit'] : []), ...(t.stopLoss ? ['the stop-loss'] : [])];
  const result = await signAndSend(built.action, 'order');
  try {
    checkBatch(result, 'order', labels);
  } catch (e) {
    noteBuilderRejection(e);
    throw e;
  }
  log.info('order placed', { engine, symbol: sym.name, legs: built.orderCount, ...(builder ? { builderFee: builder.fee } : {}) });
  return { engine, symbol: built.symbol, orderCount: built.orderCount, result };
}

export async function cancelOrder(engine: Engine, b: { symbol: string; orderID?: number; clOrdID?: string }) {
  const s = requireSigner(undefined, engine);
  const sym = await symbolFor(engine, b.symbol);
  const result = await signAndSend(cancelOrderAction(engine, sym, s.meta.accountId, b), 'cancel');
  checkBatch(result, 'cancel');
  return { result };
}

/** Cancel every open order (optionally on one market), read fresh from SoDEX. */
export async function cancelAll(engine: Engine, symbol?: string) {
  const s = requireSigner();
  const qs = symbol ? `?symbol=${encodeURIComponent((await symbolFor(engine, symbol)).name)}` : '';
  const open = unwrapList<OpenOrderRef>(await readGateway(`/api/v1/${engine}/accounts/${s.meta.owner}/orders${qs}`), 'orders');
  if (!open.length) return { cancelled: 0, result: null };
  const results: unknown[] = [];
  for (const action of cancelManyActions(engine, s.meta.accountId, open)) {
    const r = await signAndSend(action, 'cancel-all');
    checkBatch(r, 'cancel-all');
    results.push(r);
  }
  return { cancelled: open.length, result: results.length === 1 ? results[0] : results };
}

export async function modifyOrder(b: {
  symbol: string;
  orderID?: number;
  clOrdID?: string;
  price?: string;
  quantity?: string;
  stopPrice?: string;
}) {
  const s = requireSigner();
  const sym = await symbolFor('perps', b.symbol);
  return { result: await signAndSend(modifyOrderAction(sym, s.meta.accountId, b), 'order change') };
}

export async function replaceOrder(
  engine: Engine,
  b: { symbol: string; origOrderID?: number; origClOrdID?: string; price?: string; quantity?: string },
) {
  const s = requireSigner(undefined, engine);
  const sym = await symbolFor(engine, b.symbol);
  const result = await signAndSend(replaceOrderAction(engine, sym, s.meta.accountId, b), 'order replace');
  checkBatch(result, 'order replace');
  return { result };
}

export async function setLeverage(symbol: string, leverage: number, marginMode: 'isolated' | 'cross') {
  const s = requireSigner();
  const sym = await symbolFor('perps', symbol);
  return { result: await signAndSend(leverageAction(sym, s.meta.accountId, leverage, marginMode), 'leverage change') };
}

/** vUSDC precision from the perps coin list. 6 is what mainnet published; a failed read uses that rather than signing a precision the gateway will reject. */
let usdcPrecision: Promise<number> | null = null;
function vusdcPrecision(): Promise<number> {
  if (!usdcPrecision) {
    usdcPrecision = readGateway<Array<{ name?: string; precision?: number }>>('/api/v1/perps/markets/coins')
      .then((coins) => {
        const hit = (coins ?? []).find((c) => c.name === 'vUSDC');
        const p = hit?.precision;
        if (typeof p !== 'number' || !Number.isInteger(p) || p < 0) throw new Error('no vUSDC precision');
        return p;
      })
      .catch((e) => {
        usdcPrecision = null;
        throw e;
      });
  }
  return usdcPrecision;
}

export async function adjustMargin(symbol: string, amount: string) {
  const s = requireSigner();
  const sym = await symbolFor('perps', symbol);
  // Live coin precision when the gateway answers; 6 is what vUSDC publishes,
  // so a failed read still refuses a 7-place amount instead of signing one
  // SoDEX will reject.
  const precision = await vusdcPrecision().catch(() => 6);
  return { result: await signAndSend(marginAction(sym, s.meta.accountId, amount, precision), 'margin change') };
}

/** Dead-man's switch: SoDEX cancels every open order `afterMs` from now unless re-armed. Omit to clear. */
export async function scheduleCancel(engine: Engine, afterMs?: number) {
  const s = requireSigner();
  const ts = afterMs ? Date.now() + afterMs : undefined;
  return { scheduledTimestamp: ts ?? null, result: await signAndSend(scheduleCancelAction(engine, s.meta.accountId, ts), 'cancel schedule') };
}

// --- money ------------------------------------------------------------------------

/** Spot <-> perps between the owner's own accounts. */
export async function transferCross(direction: string, coinId: number, amount: string) {
  const s = requireSigner();
  const dir = direction === 'spot-to-perps' ? 'spot-to-perps' : 'perps-to-spot';
  const { engine, action } = crossTransferAction(dir, s.meta.accountId, coinId, amount);
  const result = await signAndSend(action, 'transfer');
  log.info('transfer between own accounts', { direction: dir, coinId });
  return { direction: dir, engine, amount, result };
}

/** Withdraw to the owner's own wallet on ValueChain (the only destination SoDEX pays out to). */
/** The free balance of `coinId` on `engine` for `owner`, as SoDEX reports it (null: unknown). */
async function freeBalance(engine: Engine, owner: string, coinId: number): Promise<number | null> {
  try {
    const st = await readGateway<{ B?: Array<{ i?: number; t?: string; l?: string; wb?: string }> } | null>(
      `/api/v1/${engine}/accounts/${owner}/state`,
    );
    const row = st?.B?.find((r) => r.i === coinId);
    if (!row) return 0;
    const total = Number(row.t ?? row.wb ?? '0');
    const locked = Number(row.l ?? '0');
    return Number.isFinite(total) ? Math.max(0, total - (Number.isFinite(locked) ? locked : 0)) : null;
  } catch {
    return null;
  }
}

/**
 * Withdraw to the owner's own wallet on ValueChain. Spot pays out directly.
 * Perps has no route to the wallet, so a perps withdrawal is two signed steps
 * (the official SDK's order): perps -> spot, WAIT until spot shows the credit,
 * then spot -> wallet. Nothing is sent twice: if the credit does not show in
 * time, the funds are safe in spot and the user is told to finish from there.
 */
export async function withdraw(b: { engine?: Engine; coinId: number; amount: string }) {
  const s = requireSigner();
  const from: Engine = b.engine === 'perps' ? 'perps' : 'spot';
  if (from === 'perps') {
    const before = await freeBalance('spot', s.meta.owner, b.coinId);
    await transferCross('perps-to-spot', b.coinId, b.amount);
    const want = (before ?? 0) + Number(b.amount) - 1e-9;
    let credited = false;
    for (const wait of [700, 1000, 1500, 2000, 2500, 3000, 4000, 5000]) {
      await new Promise((r) => setTimeout(r, wait));
      const now = await freeBalance('spot', s.meta.owner, b.coinId);
      if (now !== null && now >= want) {
        credited = true;
        break;
      }
    }
    if (!credited) {
      throw new OrderValidationError(
        `Moved ${b.amount} from perps to spot, but SoDEX has not credited spot yet. The funds are safe in your spot account - withdraw from spot in a moment.`,
      );
    }
  }
  const result = await signAndSend(withdrawAction(s.meta.accountId, b.coinId, b.amount), 'withdrawal');
  log.info('withdrawal to own wallet', { from, coinId: b.coinId });
  return { engine: 'spot' as Engine, destination: s.meta.owner, amount: b.amount, result };
}

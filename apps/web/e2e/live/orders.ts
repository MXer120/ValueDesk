/**
 * What the order steps share: sizing at a market's minimum, the EXACT body an
 * order must have when it leaves (the guard's check), placing through the app,
 * reading the outcome back (open orders, positions, the account stream), and
 * judging every fill's fees.
 *
 * An order is placed with the app's own placeOrder. What the runner adds is the
 * expectation: before the call it tells the guard precisely which request may
 * leave - account, market, side, type, time in force, price, quantity or funds,
 * reduce-only, trigger, modifier, attached exits and the builder - so an order
 * that differs in any of them is refused before it leaves the process.
 */
import { CROSS_ENGINE_ACCOUNT_ID, OrderModifier, TransferType, canonicalDecimal, signAndBuildWithNonceManager, unwrapList, type SignableAction } from '@sodex-core';
import { sendSigned } from '../../src/trading/gateway';
import { tradingConfig } from '../../src/trading/config';
import { balancesOf, transferFunds, unitsDown, type CoinConfig } from '../../src/trading/funds';
import { formatUnits } from '../../src/trading/onboard';
import type { OrderTicket } from '../../src/trading/orderParams';
import { getTradingState, nonces, requireSigner } from '../../src/trading/session';
import { app, appOrderBuilder } from './app';
import { CheckFailure, SafetyStop, armed, isDefiniteRefusal, type Ctx } from './context';
import { bps, checkFill, fillFeeUsd, fillKey, fillOk, fillRow, rateBp, type Engine, type FeeRates, type Fill, type FillCheck } from './fees';
import type { Expectation, WriteRequest } from './guard';
import type { BuilderRef, LedgerOrder } from './ledger';
import { marketQty, restingBuy, type Market } from './plan';
import { accountUsdc, engineState, feeRates, openOrders, positions, type OpenOrder, type Position } from './reads';
import { approx, cut, dAdd, dCmp, dDiv, dMax, dMul, dSub, dur, errText, lessPct, morePct, paced, pollUntil, sleep, toStep } from './util';

export class WaitTimeout extends Error {
  override name = 'WaitTimeout';
}

export const settleMs = (ctx: Ctx): number => ctx.cfg.timeouts.settleSeconds * 1000;
export const orderMs = (ctx: Ctx): number => ctx.cfg.timeouts.orderSeconds * 1000;
export const streamMs = (ctx: Ctx): number => ctx.cfg.timeouts.streamSeconds * 1000;

/** Poll until `done`, printing progress every 30 s; a timeout stops the run (WaitTimeout). */
export async function waitFor<T>(
  ctx: Ctx,
  what: string,
  o: { timeoutMs: number; intervalMs?: number; probe: () => Promise<T>; done: (v: T) => boolean; show: (v: T | undefined) => string },
): Promise<T> {
  const r = await pollUntil({
    timeoutMs: o.timeoutMs,
    intervalMs: o.intervalMs,
    probe: o.probe,
    done: o.done,
    progressEveryMs: 30_000,
    progress: (v, ms) => ctx.rec.line(`... ${dur(ms)} waiting for ${what}: ${o.show(v)}`, 7),
  });
  if (r.ok) return r.value;
  throw new WaitTimeout(`timed out after ${dur(r.ms)} waiting for ${what} - last seen: ${o.show(r.last)}${r.lastError ? ` (last read failed: ${r.lastError})` : ''}`);
}

/** As waitFor, but "it did not happen" is an answer (null), not a stop. */
export async function waitMaybe<T>(o: { timeoutMs: number; intervalMs?: number; probe: () => Promise<T>; done: (v: T) => boolean }): Promise<{ ok: boolean; value: T | undefined }> {
  const r = await pollUntil({ timeoutMs: o.timeoutMs, intervalMs: o.intervalMs, probe: o.probe, done: o.done });
  return r.ok ? { ok: true, value: r.value } : { ok: false, value: r.last };
}

/** The trading engines' account id, from the trading key. */
export const tradingAccount = (): number | null => getTradingState().accountId;

const rule = (v: string | undefined | null): string => (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()) ? v.trim() : '0');

// --- sizing ------------------------------------------------------------------------------------------

/** The smallest quantity whose value at `price` clears the minimum notional by `headroomPct`, on the step. */
export function minQtyAt(m: Market, price: string, headroomPct: number): string {
  const minN = rule(m.sym.minNotional);
  let q = dCmp(minN, '0') > 0 ? toStep(dDiv(morePct(minN, headroomPct), price, 'ceil'), rule(m.sym.stepSize), 'ceil') : rule(m.sym.minQuantity);
  q = dMax(q, rule(m.sym.minQuantity));
  return toStep(q, rule(m.sym.stepSize), 'ceil');
}

/** The smallest market SELL whose value at the bid clears the minimum notional by `headroomPct`. */
export function marketSellQty(m: Market, headroomPct: number): string {
  const q = minQtyAt(m, m.bid, headroomPct);
  const mm = rule(m.sym.marketMinQuantity);
  return toStep(dMax(q, mm), rule(m.sym.stepSize), 'ceil');
}

/**
 * A limit BUY price that crosses the book: a little above the best ask, on the
 * tick, well inside the market's upward price band.
 */
export function crossingBuyPrice(m: Market): string {
  const band = approx(m.sym.buyLimitUpRatio) * 100;
  const pct = band > 0 ? Math.min(0.5, band * 0.2) : 0.5;
  let p = toStep(morePct(m.ask, pct), rule(m.sym.tickSize), 'ceil');
  const max = rule(m.sym.maxPrice);
  if (dCmp(max, '0') > 0 && dCmp(p, max) > 0) p = toStep(max, rule(m.sym.tickSize), 'floor');
  return p;
}

/** `price` moved by `ticks` ticks (negative: down). */
export function ticksFrom(m: Market, price: string, ticks: number): string {
  const tick = rule(m.sym.tickSize);
  if (dCmp(tick, '0') <= 0) return price;
  return ticks >= 0 ? dAdd(price, dMul(tick, String(ticks))) : dSub(price, dMul(tick, String(-ticks)));
}

/** A trigger price `pct` percent away from the market (down for a stop-loss of a long, up for its take-profit), on the tick. */
export function triggerPrice(m: Market, side: 'below' | 'above', pct: number): string {
  const tick = rule(m.sym.tickSize);
  return side === 'below' ? toStep(lessPct(m.bid, pct), tick, 'floor') : toStep(morePct(m.ask, pct), tick, 'ceil');
}

// --- the builder an order must carry ---------------------------------------------------------------

/** The run's default fee on `engine` (0: no builder there). */
export const defaultFee = (ctx: Ctx, engine: Engine): number => (ctx.cfg.builder ? (engine === 'perps' ? ctx.cfg.builder.feePerps : ctx.cfg.builder.feeSpot) : 0);

/**
 * Why an order body's builder is not acceptable (null: it is).
 *
 * Three independent rules:
 *   1. shape: `{id, fee}` in that order, the LAST field of the batch, the run's builder id;
 *   2. the fee is the default, or one the RUNNER has seen the server sign for this
 *      wallet and that is still in force (terms.ts) - the app saying so is not enough;
 *   3. it is what the app itself says an order placed now carries.
 * `pin` (a number) demands exactly that fee; `pin: null` demands no builder at all.
 */
export function builderProblem(ctx: Ctx, engine: Engine, body: Record<string, unknown>, pin?: number | null): string | null {
  const b = ctx.cfg.builder;
  const got = body.builder as { id?: unknown; fee?: unknown } | undefined | null;
  const dflt = defaultFee(ctx, engine);
  if (!b || dflt === 0) return got === undefined ? null : `carries a builder (${JSON.stringify(got)}) although this run has none on ${engine}`;
  if (pin === null) return got === undefined ? null : 'carries a builder; this order must carry none';
  if (got === undefined) {
    if (b.required) return `carries no builder; this run requires builder #${b.id} on every ${engine} order`;
    return appOrderBuilder(engine) === undefined ? null : 'carries no builder although the app says an order placed now carries one';
  }
  if (got === null || typeof got !== 'object') return 'the builder is not an object';
  if (Object.keys(got).join(',') !== 'id,fee') return 'the builder must be {id, fee} in that order';
  if (Object.keys(body).at(-1) !== 'builder') return 'the builder must be the last field of the batch';
  if (got.id !== b.id) return `builder ${String(got.id)}, expected ${b.id}`;
  if (typeof got.fee !== 'number' || !Number.isInteger(got.fee)) return `builder fee ${String(got.fee)} is not a whole number`;
  const allowed = ctx.terms ? ctx.terms.allowedFees(engine) : [dflt];
  if (!allowed.includes(got.fee)) {
    return `builder fee ${got.fee} is neither the default ${dflt} nor a fee the server has signed for this wallet that is in force now (${allowed.filter((f) => f !== dflt).join(', ') || 'none'})`;
  }
  if (pin !== undefined && got.fee !== pin) return `builder fee ${got.fee}, expected exactly ${pin}`;
  const says = appOrderBuilder(engine);
  if (says && says.fee !== got.fee) return `builder fee ${got.fee}, but the app says an order placed now carries ${says.fee}`;
  return null;
}

// --- the exact order ----------------------------------------------------------------------------------

const TIF = { gtc: 1, fok: 2, ioc: 3, gtx: 4 } as const;
const TIF_NAME: Record<number, string> = { 1: 'GTC', 2: 'FOK', 3: 'IOC', 4: 'GTX' };

export interface OrderSpec {
  market: Market;
  side: 'buy' | 'sell';
  type: 'limit' | 'market';
  /** Default: gtc for a limit order, ioc for a market order. */
  tif?: keyof typeof TIF;
  /** As they must be ON THE WIRE: canonical, on the tick / step. */
  price?: string;
  quantity?: string;
  funds?: string;
  reduceOnly?: boolean;
  /** A trigger order (perps): a stop-loss or take-profit that fires on the mark price. */
  stop?: { price: string; kind: 'sl' | 'tp' };
  /** Attached exits (perps): trigger prices of the legs sent with the entry. */
  takeProfit?: string;
  stopLoss?: string;
  /** undefined: whatever is owed now (within what the runner allows); a number: exactly that fee; null: no builder. */
  builderFee?: number | null;
  /** The check this order belongs to, and what to call it. */
  tag: string;
  label: string;
}

const SPOT_KEYS = new Set(['symbolID', 'clOrdID', 'side', 'type', 'timeInForce', 'price', 'quantity', 'funds']);
const PERPS_KEYS = new Set(['clOrdID', 'modifier', 'side', 'type', 'timeInForce', 'price', 'quantity', 'funds', 'stopPrice', 'stopType', 'triggerType', 'reduceOnly', 'positionSide']);
const canon = (v: string | undefined): string | undefined => (v === undefined ? undefined : canonicalDecimal(v));
const MARK_PRICE = 2;

/** Why one order of a batch is not the expected one (null: it is). */
function orderProblem(engine: Engine, x: Record<string, unknown>, want: { side: number; type: number; tif: number; price?: string; quantity?: string; funds?: string; reduceOnly: boolean; stopPrice?: string; stopType?: number; modifier: number }): string | null {
  const keys = engine === 'spot' ? SPOT_KEYS : PERPS_KEYS;
  const extra = Object.keys(x).filter((k) => !keys.has(k));
  if (extra.length) return `carries field(s) this order must not have: ${extra.join(', ')}`;
  if (typeof x.clOrdID !== 'string' || !/^[0-9a-zA-Z_-]{1,36}$/.test(x.clOrdID)) return `clOrdID ${String(x.clOrdID)}`;
  if (x.side !== want.side) return `side ${String(x.side)}, expected ${want.side}`;
  if (x.type !== want.type) return `type ${String(x.type)}, expected ${want.type}`;
  if (x.timeInForce !== want.tif) return `time in force ${TIF_NAME[Number(x.timeInForce)] ?? String(x.timeInForce)}, expected ${TIF_NAME[want.tif]}`;
  if (x.price !== want.price) return `price ${String(x.price)}, expected ${want.price ?? 'none'}`;
  if (x.quantity !== want.quantity) return `quantity ${String(x.quantity)}, expected ${want.quantity ?? 'none'}`;
  if (x.funds !== want.funds) return `funds ${String(x.funds)}, expected ${want.funds ?? 'none'}`;
  if (engine === 'spot') return null;
  if ((x.reduceOnly ?? false) !== want.reduceOnly) return `reduceOnly ${String(x.reduceOnly)}, expected ${want.reduceOnly}`;
  if (x.positionSide !== 1) return `positionSide ${String(x.positionSide)}, expected 1 (BOTH)`;
  if (x.stopPrice !== want.stopPrice) return `stopPrice ${String(x.stopPrice)}, expected ${want.stopPrice ?? 'none'}`;
  if (want.stopPrice !== undefined) {
    if (x.stopType !== want.stopType) return `stopType ${String(x.stopType)}, expected ${want.stopType}`;
    if (x.triggerType !== MARK_PRICE) return `triggerType ${String(x.triggerType)}, expected ${MARK_PRICE} (the mark price - the only one SoDEX takes)`;
  } else if (x.stopType !== undefined || x.triggerType !== undefined) return 'carries a stop type / trigger type without a trigger price';
  // SoDEX's schema: NORMAL for a plain order, STOP for a TP/SL on a position or on its own,
  // BRACKET for an entry sent with exits and ATTACHED_STOP for those exits.
  if (x.modifier !== want.modifier) return `modifier ${String(x.modifier)}, expected ${want.modifier} (${Object.entries(OrderModifier).find(([, v]) => v === want.modifier)?.[0] ?? '?'})`;
  return null;
}

/** Expect exactly this order (and its attached exits), and nothing else in the request. */
export function orderExpect(ctx: Ctx, o: OrderSpec): Expectation {
  const engine = o.market.engine;
  const side = o.side === 'buy' ? 1 : 2;
  const type = o.type === 'market' ? 2 : 1;
  const tif = TIF[o.tif ?? (o.type === 'market' ? 'ioc' : 'gtc')];
  const legs = [...(o.takeProfit !== undefined ? [{ price: o.takeProfit, stopType: 2 }] : []), ...(o.stopLoss !== undefined ? [{ price: o.stopLoss, stopType: 1 }] : [])];
  return {
    kind: 'order',
    label: o.label,
    tag: o.tag,
    check: (r: WriteRequest) => {
      const b = (r.body ?? {}) as Record<string, unknown>;
      if (r.engine !== engine) return `sent to ${r.engine}, expected ${engine}`;
      const acct = tradingAccount();
      if (acct && b.accountID !== acct) return `account ${String(b.accountID)}, expected ${acct}`;
      const list = (Array.isArray(b.orders) ? b.orders : []) as Array<Record<string, unknown>>;
      if (list.length !== 1 + legs.length) return `${list.length} order(s) in the request, expected ${1 + legs.length}`;
      const x = list[0]!;
      const symbolID = engine === 'spot' ? x.symbolID : b.symbolID;
      if (symbolID !== o.market.sym.id) return `symbol ${String(symbolID)}, expected ${o.market.sym.id}`;
      const entry = orderProblem(engine, x, {
        side,
        type,
        tif,
        price: canon(o.price),
        quantity: canon(o.quantity),
        funds: canon(o.funds),
        reduceOnly: o.reduceOnly ?? false,
        stopPrice: canon(o.stop?.price),
        stopType: o.stop ? (o.stop.kind === 'tp' ? 2 : 1) : undefined,
        modifier: o.stop ? OrderModifier.STOP : legs.length ? OrderModifier.BRACKET : OrderModifier.NORMAL,
      });
      if (entry) return entry;
      for (const [i, leg] of legs.entries()) {
        const why = orderProblem(engine, list[i + 1]!, {
          side: side === 1 ? 2 : 1,
          type: 2,
          tif: TIF.ioc,
          quantity: canon(o.quantity),
          reduceOnly: true,
          stopPrice: canon(leg.price),
          stopType: leg.stopType,
          modifier: OrderModifier.ATTACHED_STOP,
        });
        if (why) return `exit leg ${i + 1}: ${why}`;
      }
      return builderProblem(ctx, engine, b, o.builderFee);
    },
  };
}

/** What the app's placeOrder is given for a spec (the ticket the order form builds). */
export function ticketOf(o: OrderSpec): OrderTicket {
  return {
    symbol: o.market.sym.name,
    side: o.side,
    type: o.type,
    ...(o.price !== undefined ? { price: o.price } : {}),
    ...(o.quantity !== undefined ? { quantity: o.quantity } : {}),
    ...(o.funds !== undefined ? { funds: o.funds } : {}),
    tif: o.tif ?? (o.type === 'market' ? 'ioc' : 'gtc'),
    ...(o.reduceOnly ? { reduceOnly: true } : {}),
    ...(o.stop ? { stopPrice: o.stop.price, stopType: o.stop.kind, triggerType: 'mark' as const } : {}),
    ...(o.takeProfit !== undefined ? { takeProfit: { price: o.takeProfit } } : {}),
    ...(o.stopLoss !== undefined ? { stopLoss: { price: o.stopLoss } } : {}),
  };
}

export interface Placed {
  orderID: number | null;
  clOrdID: string | null;
}

export type PlaceOutcome =
  | { ok: true; id: Placed; legs: Placed[]; order: LedgerOrder | null }
  | {
      ok: false;
      /** true: the request left and SoDEX answered no. false: the app refused before anything was sent. */
      sent: boolean;
      reason: string;
    };

const idsOf = (result: unknown): Placed[] => {
  const list = Array.isArray(result) ? result : unwrapList<{ orderID?: number; clOrdID?: string }>(result, 'orders');
  return (list as Array<{ orderID?: unknown; clOrdID?: unknown }>).map((r) => ({ orderID: typeof r?.orderID === 'number' ? r.orderID : null, clOrdID: typeof r?.clOrdID === 'string' ? r.clOrdID : null }));
};

export const isOurs = (o: { orderID?: number; clOrdID?: string }, id: Placed): boolean => (id.orderID !== null && o.orderID === id.orderID) || (id.clOrdID !== null && o.clOrdID === id.clOrdID);
export const idText = (id: Placed): string => (id.orderID !== null ? `#${id.orderID}` : `clOrdID ${id.clOrdID}`);

/**
 * Place one order through the app's placeOrder, with exactly `spec` allowed out.
 * A refusal that moved nothing - by the app before signing, or by SoDEX - is an
 * outcome, not an exception; anything else (no answer, a refusal by the guard) is thrown.
 * `ticket` overrides what the app is handed (the refusal tests hand it off-grid values).
 */
export async function place(ctx: Ctx, spec: OrderSpec, ticket: OrderTicket = ticketOf(spec)): Promise<PlaceOutcome> {
  const engine = spec.market.engine;
  ctx.ledger.nameSymbol(engine, spec.market.sym.id, spec.market.sym.name);
  await noteBuilderBaseline(ctx);
  const before = ctx.ledger.orders.length;
  try {
    const res = await armed(ctx, { expect: [orderExpect(ctx, spec)] }, () => app.placeOrder(engine, ticket));
    const ids = idsOf(res.result);
    const id = ids[0] ?? { orderID: null, clOrdID: null };
    if (id.orderID === null && id.clOrdID === null) throw new CheckFailure(`${spec.label}: SoDEX accepted the order but returned no order id to follow`);
    return { ok: true, id, legs: ids.slice(1), order: ctx.ledger.find(engine, id) ?? null };
  } catch (e) {
    if (!isDefiniteRefusal(e)) throw e;
    return { ok: false, sent: ctx.ledger.orders.length > before, reason: errText(e) };
  }
}

/** Place an order that MUST be accepted. */
export async function mustPlace(ctx: Ctx, spec: OrderSpec): Promise<{ id: Placed; legs: Placed[]; order: LedgerOrder | null }> {
  const r = await place(ctx, spec);
  if (!r.ok) throw new CheckFailure(`${spec.label}: ${r.sent ? 'SoDEX rejected it' : 'the app refused it before sending'}: ${r.reason}`);
  return r;
}

// --- cancels, changes ------------------------------------------------------------------------------------

/** Expect ONE cancel request naming exactly these orders. */
export function cancelExpect(engine: Engine, ids: readonly Placed[], label: string, tag?: string): Expectation {
  return {
    kind: 'cancel',
    label,
    ...(tag ? { tag } : {}),
    check: (r) => {
      const list = (Array.isArray(r.body?.cancels) ? r.body.cancels : []) as Array<{ orderID?: number; clOrdID?: string; origClOrdID?: string }>;
      if (r.engine !== engine) return `sent to ${r.engine}, expected ${engine}`;
      const acct = tradingAccount();
      if (acct && r.body?.accountID !== acct) return `account ${String(r.body?.accountID)}, expected ${acct}`;
      if (list.length !== ids.length) return `${list.length} cancel(s) in the request, expected ${ids.length}`;
      const match = (c: { orderID?: number; clOrdID?: string; origClOrdID?: string }, id: Placed): boolean =>
        id.orderID !== null ? c.orderID === id.orderID : c.clOrdID === id.clOrdID || c.origClOrdID === id.clOrdID;
      const stray = list.find((c) => !ids.some((id) => match(c, id)));
      if (stray) return `cancels an order the step did not name (${JSON.stringify(stray)})`;
      const missing = ids.find((id) => !list.some((c) => match(c, id)));
      return missing ? `does not cancel ${idText(missing)}` : null;
    },
  };
}

export async function cancel(ctx: Ctx, m: Market, id: Placed, label: string, tag?: string): Promise<void> {
  await armed(ctx, { expect: [cancelExpect(m.engine, [id], label, tag)] }, () =>
    app.cancelOrder(m.engine, id.orderID !== null ? { symbol: m.sym.name, orderID: id.orderID } : { symbol: m.sym.name, clOrdID: id.clOrdID! }),
  );
}

// --- reading the outcome back ----------------------------------------------------------------------------

export const openOn = (ctx: Ctx, m: Market): Promise<OpenOrder[]> => openOrders(m.engine, ctx.owner, m.sym.name);

/** Wait until the order is listed as open; its row (also noted in the ledger: it names the order's builder). */
export async function expectOpen(ctx: Ctx, m: Market, id: Placed, what: string): Promise<OpenOrder> {
  const list = await waitFor(ctx, `${what} in the open orders`, {
    timeoutMs: orderMs(ctx),
    intervalMs: 2000,
    probe: () => openOn(ctx, m),
    done: (l) => l.some((o) => isOurs(o, id)),
    show: (l) => `${l?.length ?? 0} open order(s) on ${m.sym.name}, ours not among them`,
  });
  const row = list.find((o) => isOurs(o, id))!;
  ctx.ledger.noteRecord(m.engine, row as Record<string, unknown>, 'open-orders');
  return row;
}

/** Is the order listed as open after `ms`? (For orders that must NOT rest: one look after a short settle time.) */
export async function restsAfter(ctx: Ctx, m: Market, id: Placed, ms = 1500): Promise<OpenOrder | null> {
  if (ms > 0) await sleep(paced(Math.min(ms, streamMs(ctx))));
  return (await openOn(ctx, m)).find((o) => isOurs(o, id)) ?? null;
}

export async function expectGone(ctx: Ctx, m: Market, id: Placed, what: string): Promise<void> {
  await waitFor(ctx, `${what} to leave the open orders`, {
    timeoutMs: orderMs(ctx),
    intervalMs: 2000,
    probe: () => openOn(ctx, m),
    done: (l) => !l.some((o) => isOurs(o, id)),
    show: () => 'still open',
  });
}

export async function positionOf(ctx: Ctx, symbol: string): Promise<Position | null> {
  return (await positions(ctx.owner)).find((p) => p.symbol === symbol && approx(p.size) !== 0) ?? null;
}

/** Wait until the position's size is exactly `size` (a signed decimal; '0' = flat). */
export async function expectPosition(ctx: Ctx, symbol: string, size: string, what: string): Promise<Position | null> {
  const want = canonicalDecimal(size);
  return waitFor(ctx, what, {
    timeoutMs: orderMs(ctx),
    intervalMs: 2000,
    probe: () => positionOf(ctx, symbol),
    done: (p) => canonicalDecimal(String(p?.size ?? '0')) === want,
    show: (p) => `position ${p?.size ?? '0'} (want ${want})`,
  });
}

/** The account's leverage and margin mode on a perps market (what the ticket shows), or the market's defaults. */
export async function symbolConfig(ctx: Ctx, m: Market): Promise<{ leverage: number; mode: 'CROSS' | 'ISOLATED'; touched: boolean }> {
  const st = await engineState('perps', ctx.owner);
  const s = st?.S?.find((x) => x.s === m.sym.name);
  return { leverage: s?.l ?? m.sym.initLeverage ?? 1, mode: String(s?.m ?? 'CROSS').toUpperCase() === 'ISOLATED' ? 'ISOLATED' : 'CROSS', touched: !!s };
}

// --- fills and their fees ---------------------------------------------------------------------------------

const FINAL = new Set(['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED']);

/** What the stream has reported of an order so far: its fills and its state. */
export function seen(ctx: Ctx, engine: Engine, id: Placed): { fills: Fill[]; filledQty: string; status: string | null } {
  const fills = ctx.ledger.fillsOf(engine, id);
  return { fills, filledQty: fills.reduce((s, f) => dAdd(s, f.quantity), '0'), status: ctx.ledger.find(engine, id)?.status ?? null };
}

/**
 * Give the account stream time to report an order's fills (`qty`: all of this
 * quantity; without it: until the order reaches a final state). Returns what was
 * seen; with no stream the answer is "nothing seen" at once, and the fills are
 * judged in the final cross-check instead.
 */
export async function awaitFills(ctx: Ctx, engine: Engine, id: Placed, qty?: string): Promise<{ fills: Fill[]; filledQty: string; status: string | null; stream: boolean }> {
  const live = !!ctx.stream?.ready(engine);
  if (live) {
    await ctx.ledger.wait(() => {
      const s = seen(ctx, engine, id);
      if (qty !== undefined && dCmp(s.filledQty, qty) >= 0) return true;
      // Final, and - when it filled - its fill has arrived too (the two travel separately).
      return s.status !== null && FINAL.has(s.status) && (s.status !== 'FILLED' || s.fills.length > 0);
    }, streamMs(ctx));
    // A fill and its order update travel separately: one more beat for the other to land.
    await sleep(paced(Math.min(250, streamMs(ctx))));
  }
  return { ...seen(ctx, engine, id), stream: live };
}

const marketRates = (m: Market): FeeRates => ({ taker: String(m.sym.takerFee ?? '0'), maker: String(m.sym.makerFee ?? '0') });

const symbolRates = new Map<string, FeeRates | null>();

/** Every rate a fill on this market may have been charged at: the account's, the account's for this market, the market's published. */
async function ratesFor(ctx: Ctx, m: Market): Promise<Array<{ source: string; rates: FeeRates }>> {
  const engine = m.engine;
  if (ctx.feeRates[engine] === undefined) ctx.feeRates[engine] = await feeRates(engine, ctx.owner).catch(() => null);
  const key = `${ctx.owner}:${engine}:${m.sym.name}`;
  if (!symbolRates.has(key)) symbolRates.set(key, await feeRates(engine, ctx.owner, m.sym.name).catch(() => null));
  const out: Array<{ source: string; rates: FeeRates }> = [];
  const acct = ctx.feeRates[engine];
  if (acct) out.push({ source: 'the account\'s', rates: acct });
  const sym = symbolRates.get(key);
  if (sym && (!acct || sym.taker !== acct.taker || sym.maker !== acct.maker)) out.push({ source: `the account's on ${m.sym.name}`, rates: sym });
  const pub = marketRates(m);
  if (!out.some((r) => r.rates.taker === pub.taker && r.rates.maker === pub.maker)) out.push({ source: 'the market\'s published', rates: pub });
  return out;
}

const markets = new Map<string, Market>();
/** Remember a market by engine and name, so a fill can be judged against its coins and rates later. */
export function rememberMarket(m: Market): void {
  markets.set(`${m.engine}:${m.sym.name}`, m);
}
export const knownMarket = (engine: Engine, symbol: string): Market | undefined => markets.get(`${engine}:${symbol}`);

/**
 * Judge every fill of the run that has not been judged yet (or was judged from
 * the stream and now has its history row), and rewrite the four fee checks from
 * all judged fills. Fills of orders the run did not send are left alone.
 */
export async function judgeFills(ctx: Ctx): Promise<FillCheck[]> {
  const fresh: FillCheck[] = [];
  for (const f of ctx.ledger.fills) {
    const key = fillKey(f);
    const had = ctx.fillChecks.get(key);
    if (had && (had.fill.source === 'history' || f.source === 'stream')) continue;
    const order = ctx.ledger.orderOf(f);
    const m = knownMarket(f.engine, f.symbol);
    if (!order || !m) continue;
    const c = checkFill(f, {
      builderRate: order.builder ? order.builder.fee : null,
      rates: await ratesFor(ctx, m),
      quoteCoin: String(m.sym.quoteCoin ?? 'vUSDC'),
      baseCoin: String(m.sym.baseCoin ?? ''),
      label: order.label,
    });
    ctx.fillChecks.set(key, c);
    fresh.push(c);
  }
  for (const engine of ['perps', 'spot'] as const) {
    const all = [...ctx.fillChecks.values()].filter((c) => c.fill.engine === engine);
    if (!all.length) continue;
    const rows = all.map(fillRow);
    const cost = all.reduce((s, c) => s + fillFeeUsd(c), 0);
    const badC = all.filter((c) => c.commissionProblems.length);
    ctx.checks.set(
      `${engine}-fees-commission`,
      badC.length ? 'fail' : 'pass',
      badC.length
        ? `${badC.length} of ${all.length} fill(s): ${badC[0]!.label}: ${badC[0]!.commissionProblems[0]}`
        : `${all.length} fill(s), each at ${[...new Set(all.map((c) => `${bps(c.expectedRate)} (${c.rateSource})`))].join(' / ')}`,
      { fills: rows },
      cost,
    );
    const badB = all.filter((c) => c.builderProblems.length);
    const charged = all.filter((c) => !/^0(\.0+)?$/.test(c.fill.builderFee));
    ctx.checks.set(
      `${engine}-fees-builder`,
      badB.length ? 'fail' : 'pass',
      badB.length
        ? `${badB.length} of ${all.length} fill(s): ${badB[0]!.label}: ${badB[0]!.builderProblems[0]}`
        : ctx.cfg.builder
          ? `${charged.length} of ${all.length} fill(s) paid a builder fee, each exactly the share its order carried (${[...new Set(charged.map((c) => rateBp(c.builderRate ?? 0)))].join(', ') || 'none due'})`
          : `no builder in this run: none of the ${all.length} fill(s) paid a builder fee`,
      { fills: rows.map((r) => ({ order: r.order, side: r.side, notional: r.notional, builderFee: r.builderFee, orderCarried: r.orderBuilderFee, expected: r.expectedBuilderFee, verdict: r.verdict })) },
    );
  }
  return fresh;
}

/**
 * After an order that should have filled `qty`: wait for the stream, judge the
 * fills, and say in one line what they were charged. No stream: says so (the
 * final cross-check judges them from the fill history).
 */
export async function settleFills(ctx: Ctx, m: Market, id: Placed, qty?: string): Promise<{ fills: Fill[]; filledQty: string; note: string; costUsd: number }> {
  rememberMarket(m);
  const s = await awaitFills(ctx, m.engine, id, qty);
  if (!s.stream) return { fills: [], filledQty: '0', note: 'the account stream is not connected - the fills are judged in the final cross-check', costUsd: 0 };
  if (!s.fills.length) return { fills: [], filledQty: '0', note: `the account stream reported no fill within ${dur(streamMs(ctx))}`, costUsd: 0 };
  await judgeFills(ctx);
  const mine = s.fills.map((f) => ctx.fillChecks.get(fillKey(f))).filter((c): c is FillCheck => !!c);
  const bad = mine.filter((c) => !fillOk(c));
  const fee = mine.reduce((sum, c) => sum + fillFeeUsd(c), 0);
  const note = bad.length
    ? `FEE PROBLEM: ${[...bad[0]!.commissionProblems, ...bad[0]!.builderProblems][0]}`
    : `${mine.length} fill(s), ${cut(s.filledQty, 8)} @ ${[...new Set(mine.map((c) => c.fill.price))].join('/')}, commission ${[...new Set(mine.map((c) => bps(c.commissionRate)))].join('/')}${mine.some((c) => c.fill.builderFee !== '0') ? `, builder fee ${[...new Set(mine.filter((c) => c.fill.builderFee !== '0').map((c) => bps(dDiv(c.fill.builderFee, c.notional))))].join('/')}` : ''}`;
  return { fills: s.fills, filledQty: s.filledQty, note, costUsd: fee };
}

/** What SoDEX's record of one of the run's orders says about its builder, in words. */
export function recordBuilderText(o: LedgerOrder | null | undefined): string {
  if (!o || o.recordBuilder === undefined) return 'no record of the order seen yet';
  return o.recordBuilder === null ? 'the record names no builder' : `the record names builder #${o.recordBuilder.id} at ${o.recordBuilder.fee}`;
}

export const sameBuilder = (a: BuilderRef | null | undefined, b: BuilderRef | null | undefined): boolean => (a?.id ?? null) === (b?.id ?? null) && (a?.fee ?? null) === (b?.fee ?? null);

// --- the builder account's income ---------------------------------------------------------------------------

/** Before the run's first order: what the builder account holds (public reads). Once per run. */
export async function noteBuilderBaseline(ctx: Ctx): Promise<void> {
  const b = ctx.cfg.builder;
  if (!b || !b.address || ctx.builderBaseline) return;
  const [spot, perps] = await Promise.all([accountUsdc('spot', b.address, b.id).catch(() => null), accountUsdc('perps', b.address, b.id).catch(() => null)]);
  ctx.builderBaseline = { at: Date.now(), spot, perps };
  ctx.rec.line(`builder account #${b.id} before the run's first order: Spot ${spot ?? '?'} vUSDC, Perps ${perps ?? '?'} vUSDC`, 5);
}

// --- collateral --------------------------------------------------------------------------------------------

/** Expect one engine transfer between the owner's OWN accounts (toAccountID 999), exactly this coin and amount. */
export function engineTransfer(engine: Engine, type: number, coin: CoinConfig, amount: string, label: string): Expectation {
  const want = canonicalDecimal(amount);
  return {
    kind: 'engine-transfer',
    label,
    check: (r) => {
      const b = r.body ?? {};
      const acct = tradingAccount();
      if (r.engine !== engine) return `sent to ${r.engine}, expected ${engine}`;
      if (b.type !== type) return `transfer type ${b.type}, expected ${type}`;
      if (b.coinID !== coin.assetId) return `coin ${b.coinID}, expected ${coin.assetId} (${coin.coin})`;
      if (b.toAccountID !== CROSS_ENGINE_ACCOUNT_ID) return `to account ${b.toAccountID}, expected ${CROSS_ENGINE_ACCOUNT_ID} (the owner's own accounts)`;
      if (acct && b.fromAccountID !== acct) return `from account ${b.fromAccountID}, expected ${acct}`;
      if (b.amount !== want) return `amount ${b.amount}, expected ${want}`;
      return null;
    },
  };
}

/** Make sure Perps can release at least `need` USDC: move the difference in from Spot. */
export async function ensurePerpsCollateral(ctx: Ctx, need: string): Promise<void> {
  const { owner, rec } = ctx;
  const usdc = ctx.pre.usdc;
  const dp = usdc.valuechain.decimals;
  const b0 = await balancesOf(owner, usdc);
  if (unitsDown(b0.perps, dp) >= unitsDown(need, dp)) return;
  const move = toStep(dSub(need, b0.perps), '0.000001', 'ceil');
  if (unitsDown(b0.spot, dp) < unitsDown(move, dp)) throw new SafetyStop(`Perps needs ~${need} USDC of collateral; Perps holds ${b0.perps} and Spot only ${b0.spot}`);
  await rec.sub(`Spot -> Perps ${move} USDC (collateral)`, () =>
    armed(ctx, { expect: [engineTransfer('spot', TransferType.PERPS_WITHDRAW, usdc, move, 'collateral Spot -> Perps')] }, () =>
      transferFunds({ owner, provider: ctx.provider, coin: usdc, from: 'spot', to: 'perps', amount: move }),
    ),
  );
  await waitFor(ctx, 'the collateral in Perps', {
    timeoutMs: settleMs(ctx),
    probe: () => balancesOf(owner, usdc),
    done: (b) => unitsDown(b.perps, dp) >= unitsDown(b0.perps, dp) + unitsDown(move, dp),
    show: (b) => `Perps ${b?.perps ?? '?'}`,
  });
}

/** Whatever Perps can release goes back to Spot (the next steps pay from Spot). */
export async function releasePerpsCollateral(ctx: Ctx): Promise<void> {
  const { owner, rec } = ctx;
  const usdc = ctx.pre.usdc;
  const dp = usdc.valuechain.decimals;
  const b = await balancesOf(owner, usdc);
  if (unitsDown(b.perps, dp) === 0n) return;
  const back = formatUnits(unitsDown(b.perps, dp), dp);
  await rec.sub(`Perps -> Spot ${back} USDC (all Perps can release)`, () =>
    armed(ctx, { expect: [engineTransfer('perps', TransferType.SPOT_WITHDRAW, usdc, back, 'Perps -> Spot (collateral back)')] }, () =>
      transferFunds({ owner, provider: ctx.provider, coin: usdc, from: 'perps', to: 'spot', amount: back }),
    ),
  );
  await waitFor(ctx, 'the collateral back in Spot', {
    timeoutMs: settleMs(ctx),
    probe: () => balancesOf(owner, usdc),
    done: (x) => unitsDown(x.spot, dp) >= unitsDown(b.spot, dp) + unitsDown(back, dp),
    show: (x) => `Spot ${x?.spot ?? '?'}, Perps ${x?.perps ?? '?'}`,
  });
}

// --- putting a market back in order ------------------------------------------------------------------------

/** Cancel every open order on this market (the app's cancelAll - it reads the list fresh), and wait until none is left. */
export async function cancelEverything(ctx: Ctx, m: Market, why: string): Promise<number> {
  const open = await openOn(ctx, m);
  if (!open.length) return 0;
  const ids = open.map((o) => ({ orderID: o.orderID ?? null, clOrdID: o.clOrdID ?? null }));
  ctx.rec.line(`${why}: cancelling ${open.length} open order(s) on ${m.engine} ${m.sym.name}`, 5);
  await armed(ctx, { expect: [cancelExpect(m.engine, ids, `cancel all on ${m.sym.name} (${why})`)] }, () => app.cancelAll(m.engine, m.sym.name));
  await waitFor(ctx, `the open orders on ${m.sym.name} to clear`, { timeoutMs: orderMs(ctx), intervalMs: 2000, probe: () => openOn(ctx, m), done: (l) => l.length === 0, show: (l) => `${l?.length ?? '?'} still open` });
  return open.length;
}

/** Close whatever position is open on this perps market with ONE reduce-only market order; returns what was closed. */
export async function flatten(ctx: Ctx, m: Market, tag: string, label: string): Promise<{ closed: string; id: Placed | null; note: string }> {
  const pos = await positionOf(ctx, m.sym.name);
  if (!pos) return { closed: '0', id: null, note: 'already flat' };
  const size = String(pos.size);
  const long = approx(size) > 0;
  const qty = canonicalDecimal(size.replace(/^-/, ''));
  const r = await mustPlace(ctx, { market: m, side: long ? 'sell' : 'buy', type: 'market', quantity: qty, reduceOnly: true, tag, label });
  await expectPosition(ctx, m.sym.name, '0', `the ${m.sym.name} position to close`);
  const s = await settleFills(ctx, m, r.id, qty);
  return { closed: size, id: r.id, note: s.note };
}

/** After a failed scenario: no open orders and no position on this market. */
export async function putInOrder(ctx: Ctx, m: Market, tag: string): Promise<void> {
  await cancelEverything(ctx, m, `after ${tag}`);
  if (m.engine === 'perps') await flatten(ctx, m, tag, `close what ${tag} left`);
}

/** The order ids the app gives (trading/orderParams.ts genClOrdID): "vs-" for a new order, "rp-" for a replacement. */
export const APP_ORDER_ID = /^(vs|rp)-/;

/**
 * Before a step that needs a market to itself: what an earlier run of this
 * wallet left there - orders the app placed, and a position - is cleared
 * through the app first and said so (a stopped run left three resting orders
 * on 2026-10-03, and the resumed run must not stop on them). An order the app
 * did not place (sodex.com, another tool) still stops the step: it is the
 * owner's, not the run's.
 */
export async function clearLeftovers(ctx: Ctx, m: Market, step: string): Promise<void> {
  const open = await openOn(ctx, m);
  const pos = m.engine === 'perps' ? await positionOf(ctx, m.sym.name) : null;
  if (!open.length && !pos) return;
  const foreign = open.filter((o) => !APP_ORDER_ID.test(o.clOrdID ?? ''));
  if (foreign.length) {
    throw new SafetyStop(`the account has ${foreign.length} open order(s) on ${m.engine} ${m.sym.name} that Valuescan did not place (${foreign.map((o) => o.clOrdID ?? `#${o.orderID}`).join(', ')}) - this step needs that market to itself (cancel them first)`);
  }
  ctx.rec.note(`${step}: an earlier run left ${open.length} open order(s)${pos ? ` and a position of ${pos.size}` : ''} on ${m.engine} ${m.sym.name} - cleared through the app before the step starts`);
  await putInOrder(ctx, m, `${step} (what an earlier run left)`);
}

// --- orders the runner builds itself ------------------------------------------------------------------------

export interface DirectResult {
  /** SoDEX's answer: accepted (with the ids it gave) or rejected (with its words). */
  accepted: boolean;
  id: Placed;
  rejection: string | null;
  order: LedgerOrder | null;
}

/**
 * Sign `action` with the trading key and send it - NOT through the app's order
 * path. This stands in for a modified client (docs/BUILDER-TIERS.md section 1:
 * "a person who rewrites the app's code"), and is labelled so in the report.
 * The guard lets out exactly these bytes, once (`direct-order`).
 */
export async function sendDirect(ctx: Ctx, engine: Engine, action: SignableAction, o: { tag: string; label: string; purpose: string }): Promise<DirectResult> {
  const s = requireSigner(ctx.owner, engine);
  const req = await signAndBuildWithNonceManager(action, s.key, { chainId: tradingConfig().chainId, nonces: nonces(), base: '' });
  return sendPrepared(ctx, engine, req, o);
}

/** A signed order request, as built (not yet sent). */
export interface PreparedOrder {
  method: 'POST' | 'DELETE';
  gatewayPath: string;
  headers: Record<string, string>;
  body: string;
}

export async function prepareDirect(ctx: Ctx, engine: Engine, action: SignableAction): Promise<PreparedOrder> {
  const s = requireSigner(ctx.owner, engine);
  const req = await signAndBuildWithNonceManager(action, s.key, { chainId: tradingConfig().chainId, nonces: nonces(), base: '' });
  return { method: req.method, gatewayPath: req.gatewayPath, headers: req.headers, body: req.body };
}

export async function sendPrepared(ctx: Ctx, engine: Engine, req: PreparedOrder, o: { tag: string; label: string; purpose: string }): Promise<DirectResult> {
  const before = ctx.ledger.orders.length;
  let rejection: string | null = null;
  let result: unknown = null;
  try {
    result = await armed(ctx, { expect: [{ kind: 'direct-order', label: `DIRECT (${o.purpose}): ${o.label}`, exact: req.body, tag: o.tag }] }, () => sendSigned(req, 'order'));
  } catch (e) {
    if (!isDefiniteRefusal(e)) throw e;
    rejection = errText(e);
  }
  const order = ctx.ledger.orders.slice(before).find((x) => x.engine === engine) ?? null;
  if (order) {
    order.origin = 'direct';
    order.purpose = o.purpose;
  }
  const ids = rejection === null ? idsOf(result) : [];
  // A batch SoDEX accepts as a whole can still reject the order inside it.
  const inner = rejection === null && order?.accepted === false ? order.rejection : null;
  return { accepted: rejection === null && inner === null, id: ids[0] ?? { orderID: order?.orderID ?? null, clOrdID: order?.clOrdID ?? null }, rejection: rejection ?? inner, order };
}

/** A resting limit BUY far below the market, as `restingBuy` sizes it, for callers that only need "an order that rests". */
export const resting = (m: Market, offsetPct: number): { price: string; qty: string; offsetPct: number; lock: string } => restingBuy(m, offsetPct);
export { marketQty };

// --- what the app must refuse by itself ---------------------------------------------------------------------

/**
 * Call something the app must refuse BEFORE anything is signed or sent. Nothing
 * is armed: had the app tried, the guard (or the test wallet) would have stopped
 * it - and that is reported as "the app tried", not as a refusal of the app's.
 */
export async function refusedLocally(ctx: Ctx, fn: () => Promise<unknown>): Promise<{ refused: true; reason: string } | { refused: false; why: string }> {
  const before = ctx.guard.refusals.length;
  const signed = ctx.walletRefusals.length;
  ctx.provider.setPolicy(null);
  let threw = false;
  let thrown: unknown;
  try {
    await fn();
  } catch (e) {
    threw = true;
    thrown = e;
  }
  const blocked = ctx.guard.refusals.slice(before);
  if (blocked.length) return { refused: false, why: `the app tried to send ${blocked.map((b) => `${b.what} (${b.blocked})`).join('; ')} - the runner's guard stopped it, nothing left the process` };
  const sig = ctx.walletRefusals.slice(signed);
  if (sig.length) return { refused: false, why: `the app asked the wallet to sign (${sig.join('; ')}) - the test wallet refused, nothing was signed` };
  if (!threw) return { refused: false, why: 'the app raised no error (and sent nothing)' };
  return { refused: true, reason: errText(thrown) };
}

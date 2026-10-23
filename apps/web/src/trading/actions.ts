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
 *
 * THE BUILDER FEE (docs/BUILDER-TIERS.md section 2). `signAndSend` below is
 * the ONLY place an exchange action is signed, and the fee guard (feeGuard.ts)
 * stands in it: nothing is signed that creates or changes an order outside
 * the builder rules. An order carries the pinned builder at the fee the wallet
 * owes NOW (terms.ts `feeNow`: the build's default, lowered only by terms the
 * server signed) - or, in a build that requires the builder, it is not sent.
 */
import {
  OrderModifier,
  OrderSide,
  OrderType,
  OrderValidationError,
  SodexApiError,
  TimeInForce,
  decimalCompare,
  failedOrders,
  perpsActions,
  signAndBuildWithNonceManager,
  unwrapList,
  type BuilderParams,
  type Engine,
  type OrderResult,
  type OrderRow,
  type SignableAction,
} from '@sodex-core';
import { api } from '../api';
import { activeBuilder, orderBuilder, type BuilderApproval } from './builder';
import { tradingConfig } from './config';
import { guardAction, mustRecreate } from './feeGuard';
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
import { ensureTerms, feeNow, hintTerms } from './terms';
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
 * The builder to attach on `engine` for `owner`: the pinned builder at the fee
 * that wallet owes now (terms.ts), only where SoDEX lists an approval that
 * covers it, per engine (builder.ts). An order naming an unapproved builder is
 * rejected, so "not listed" means "not sent".
 */
function builderFor(engine: Engine, owner: string, approved: BuilderApproval | null): BuilderParams | undefined {
  return orderBuilder(tradingConfig().builder, approved, engine, feeNow(engine, owner));
}

/**
 * The builder for an order placed NOW. Where the approval is not listed and it
 * matters - SoDEX accepted one moments ago, or this build requires one - it is
 * re-read first. A build that requires the fee refuses the order rather than
 * send it without one. What this browser remembers about the approval only
 * saves a read: remembered as missing, SoDEX is asked; remembered as there when
 * it is not, SoDEX rejects the order - neither ends in an order without it.
 */
async function builderForOrder(engine: Engine): Promise<BuilderParams | undefined> {
  const cfg = activeBuilder(tradingConfig().builder);
  if (!cfg || cfg.fee[engine] <= 0) return undefined;
  // A wallet entitled to a lower fee should not pay the default because its terms ran
  // out a moment ago: ask (briefly, never failing the order). No terms: the default.
  await ensureTerms(requireSigner(undefined, engine).meta.owner);
  const { owner, builder: remembered } = requireSigner(undefined, engine).meta;
  let builder = builderFor(engine, owner, remembered);
  if (!builder && (cfg.required || builderApprovalPending())) {
    builder = builderFor(engine, owner, await refreshBuilderApproval());
  }
  if (!builder && cfg.required) {
    throw new TradingError(
      `SoDEX does not list your approval of the ValueDesk builder fee for ${engine} orders, and trading through ValueDesk requires it. If you approved it a moment ago, try again shortly; otherwise press "ValueDesk fee" in the order ticket and approve it there.`,
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

/**
 * Sign one exchange action with the trading key and send it. EVERY signed
 * action of the app goes through here, so the fee guard stands here: an action
 * that would create or change an order outside the builder rules is refused
 * before anything is signed (feeGuard.ts).
 */
async function signAndSend<T = unknown>(action: SignableAction, what: string): Promise<T> {
  const s = requireSigner(undefined, action.engine);
  guardAction(action, s.meta.owner);
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
  // It may have filled: the server is told to look at this wallet's volume (debounced, terms.ts).
  if (builder) hintTerms(s.meta.owner);
  return { engine, symbol: built.symbol, orderCount: built.orderCount, result };
}

/**
 * ALGO CHILDREN: one signed batch of plain perps limit orders on one market
 * (IOC to take, GTX to rest, GTC for a ladder), each with the client order id
 * the algo engine chose, carrying the builder like every other order - the
 * fee guard checks it here as anywhere. Returns SoDEX's answer as it is: the
 * engine reads it order by order (one refused level does not fail a ladder).
 */
export async function placeAlgoChildren(
  symbol: string,
  orders: ReadonlyArray<{ clOrdID: string; side: 'buy' | 'sell'; price: string; quantity: string; tif: 'ioc' | 'gtx' | 'gtc'; reduceOnly: boolean }>,
): Promise<unknown> {
  const s = requireSigner(undefined, 'perps');
  const sym = await symbolFor('perps', symbol);
  const builder = await builderForOrder('perps');
  const tif = { ioc: TimeInForce.IOC, gtx: TimeInForce.GTX, gtc: TimeInForce.GTC } as const;
  const action = perpsActions.newOrder(
    s.meta.accountId,
    sym.id,
    orders.map((o) => ({
      clOrdID: o.clOrdID,
      modifier: OrderModifier.NORMAL,
      side: o.side === 'buy' ? OrderSide.BUY : OrderSide.SELL,
      type: OrderType.LIMIT,
      timeInForce: tif[o.tif],
      price: o.price,
      quantity: o.quantity,
      reduceOnly: o.reduceOnly,
    })),
    builder,
  );
  const result = await signAndSend(action, orders.length === 1 ? 'algo order' : 'algo orders');
  if (builder) hintTerms(s.meta.owner);
  return result;
}

/**
 * The SoDEX account a new live algo of `owner` trades: the one trading is
 * enabled for in this browser. Throws (as any order would) when it is not.
 * The trading key itself never leaves this module.
 */
export function algoAccountId(owner: string): number {
  return requireSigner(owner, 'perps').meta.accountId;
}

/** Cancel algo children by client order id (one signed request). An order already gone is not an error. */
export async function cancelAlgoChildren(symbol: string, clOrdIDs: readonly string[]): Promise<void> {
  if (!clOrdIDs.length) return;
  const s = requireSigner(undefined, 'perps');
  const sym = await symbolFor('perps', symbol);
  try {
    await signAndSend(perpsActions.cancelOrder(s.meta.accountId, clOrdIDs.map((clOrdID) => ({ symbolID: sym.id, clOrdID }))), 'cancel');
  } catch (e) {
    if (e instanceof SodexApiError && /not found|unknown order|does not exist|already/i.test(e.message)) return;
    throw e;
  }
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
  const listed = unwrapList<OpenOrderRef & { symbol?: string }>(await readGateway(`/api/v1/${engine}/accounts/${s.meta.owner}/orders${qs}`), 'orders');
  if (!listed.length) return { cancelled: 0, result: null };
  // The REST list names each order's market (`symbol: "BTC-USD"`) but not its numeric
  // id, which the cancel request needs - without this nothing was cancelled at all
  // (found by the live run: three resting orders stayed on the book).
  const ids = new Map<string, number>();
  const open: OpenOrderRef[] = [];
  for (const o of listed) {
    let symbolID = o.symbolID ?? o.si;
    if (typeof symbolID !== 'number' && typeof o.symbol === 'string') {
      if (!ids.has(o.symbol)) ids.set(o.symbol, (await symbolFor(engine, o.symbol)).id);
      symbolID = ids.get(o.symbol);
    }
    open.push({ ...o, symbolID });
  }
  const actions = cancelManyActions(engine, s.meta.accountId, open);
  if (!actions.length) throw new OrderValidationError('SoDEX listed open orders, but none could be matched to a market - nothing was cancelled. Reload and try again.');
  const results: unknown[] = [];
  for (const action of actions) {
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
  // G6: where SoDEX's modify request is not known to keep the builder, the change is cancel + new order.
  if (mustRecreate('modifyOrder', 'perps')) {
    return recreateOrder('perps', { symbol: b.symbol, orderID: b.orderID, clOrdID: b.clOrdID }, { price: b.price, quantity: b.quantity, stopPrice: b.stopPrice });
  }
  const s = requireSigner();
  const sym = await symbolFor('perps', b.symbol);
  return { result: await signAndSend(modifyOrderAction(sym, s.meta.accountId, b), 'order change') };
}

export async function replaceOrder(
  engine: Engine,
  b: { symbol: string; origOrderID?: number; origClOrdID?: string; price?: string; quantity?: string },
) {
  // G6: SoDEX's replace request creates a new order from a body with no builder field.
  if (mustRecreate('replaceOrder', engine)) {
    return recreateOrder(engine, { symbol: b.symbol, orderID: b.origOrderID, clOrdID: b.origClOrdID }, { price: b.price, quantity: b.quantity });
  }
  const s = requireSigner(undefined, engine);
  const sym = await symbolFor(engine, b.symbol);
  const result = await signAndSend(replaceOrderAction(engine, sym, s.meta.accountId, b), 'order replace');
  checkBatch(result, 'order replace');
  return { result };
}

const PLAIN_DECIMAL = /^\d+(\.\d+)?$/;

/** a - b on decimal strings, exactly; '0' when nothing is left. */
function decimalLeft(a: string, b: string): string {
  const [ai = '0', af = ''] = a.split('.');
  const [bi = '0', bf = ''] = b.split('.');
  const n = Math.max(af.length, bf.length);
  const x = BigInt(ai + af.padEnd(n, '0')) - BigInt(bi + bf.padEnd(n, '0'));
  if (x <= 0n) return '0';
  const s = x.toString().padStart(n + 1, '0');
  return n ? `${s.slice(0, -n)}.${s.slice(-n)}`.replace(/\.?0+$/, '') : s;
}

const TIFS = ['gtc', 'ioc', 'gtx', 'fok'] as const;
const TRIGGERS: Record<string, 'mark' | 'last' | 'index'> = { MARK_PRICE: 'mark', LAST_PRICE: 'last', INDEX_PRICE: 'index' };

/** What a change to a resting order may set. A blank field is not a change. */
export interface OrderChange {
  price?: string;
  quantity?: string;
  stopPrice?: string;
}

const given = (v: string | undefined): v is string => typeof v === 'string' && v.trim() !== '';
const changeOf = (c: OrderChange): OrderChange => ({
  ...(given(c.price) ? { price: c.price.trim() } : {}),
  ...(given(c.quantity) ? { quantity: c.quantity.trim() } : {}),
  ...(given(c.stopPrice) ? { stopPrice: c.stopPrice.trim() } : {}),
});

/** An enum field as SoDEX's REST lists it (a name), or as its stream sends it (the number). */
const named = (v: unknown, names: Record<number, string>): string =>
  typeof v === 'number' ? (names[v] ?? String(v)) : String(v ?? '').trim().toUpperCase();

/** The fields of an open order a change depends on, normalised. */
function rowFacts(o: OrderRow) {
  const stop = o.stopPrice !== undefined && PLAIN_DECIMAL.test(String(o.stopPrice)) && Number(o.stopPrice) > 0 ? String(o.stopPrice) : undefined;
  const stopType = named(o.stopType, { 1: 'STOP_LOSS', 2: 'TAKE_PROFIT' });
  return {
    side: named(o.side, { 1: 'BUY', 2: 'SELL' }),
    type: named(o.type, { 1: 'LIMIT', 2: 'MARKET' }),
    tif: named(o.timeInForce, { 1: 'GTC', 2: 'FOK', 3: 'IOC', 4: 'GTX' }),
    status: named(o.status, { 1: 'NEW', 2: 'PARTIALLY_FILLED' }),
    stopPrice: stop,
    stopType: stopType === 'TAKE_PROFIT' || stopType === 'STOP_LOSS' ? stopType : '',
    triggerType: named(o.triggerType, { 1: 'LAST_PRICE', 2: 'MARK_PRICE', 3: 'INDEX_PRICE' }),
    /** A take-profit / stop-loss (position, stand-alone or attached): what SoDEX's modify request is for. */
    tpsl: stop !== undefined || stopType === 'TAKE_PROFIT' || stopType === 'STOP_LOSS',
  };
}

/**
 * The ticket that places `o` again with `change` applied. Throws when the open
 * order cannot be rebuilt exactly from what SoDEX lists - BEFORE anything is
 * cancelled, so a refusal leaves the order as it was.
 *
 * The size is a TOTAL, as on the order: the new order is for that total minus
 * what has already filled. Unchanged, that is what is left to fill; changed on
 * a partly filled order, the position ends up with the new total, never more.
 */
export function ticketFromOpenOrder(symbol: string, o: OrderRow, changeIn: OrderChange): OrderTicket {
  const change = changeOf(changeIn);
  const cannot = (why: string) => new OrderValidationError(`This order cannot be changed in place here (${why}). Cancel it and place a new one.`);
  const r = rowFacts(o);
  const side = r.side;
  const type = r.type;
  if (side !== 'BUY' && side !== 'SELL') throw cannot('SoDEX does not list its side');
  if (type !== 'LIMIT' && type !== 'MARKET') throw cannot(`its type is ${type || 'not listed'}`);
  if ((o.attachedOrderIDs?.length ?? 0) > 0) throw cannot('it has a take-profit or stop-loss attached');
  if (o.primaryOrderID) throw cannot('it is attached to another order');
  const tif = r.tif.toLowerCase() as (typeof TIFS)[number] | '';
  if (tif && !TIFS.includes(tif)) throw cannot(`its time in force is ${tif}`);
  const executed = o.executedQty === undefined || o.executedQty === null ? '0' : String(o.executedQty);
  const total = change.quantity ?? (o.origQty === undefined || o.origQty === null ? undefined : String(o.origQty));
  if (!total || !PLAIN_DECIMAL.test(total) || !PLAIN_DECIMAL.test(executed)) throw cannot('its size is not listed as a quantity');
  const quantity = decimalLeft(total, executed);
  if (quantity === '0') throw cannot(change.quantity === undefined ? 'nothing of it is left to fill' : 'the new size is not above what has already filled');
  const listedStop = r.stopPrice;
  if (change.stopPrice !== undefined && !listedStop) throw cannot('it has no trigger price to change');
  const stopPrice = change.stopPrice ?? listedStop;
  const stopType = r.stopType === 'TAKE_PROFIT' ? 'tp' : r.stopType === 'STOP_LOSS' ? 'sl' : undefined;
  const triggerType = TRIGGERS[r.triggerType];
  if (stopPrice && (!stopType || !triggerType)) throw cannot('SoDEX does not list what its trigger is');
  const price = type === 'LIMIT' ? (change.price ?? o.price) : undefined;
  if (type === 'LIMIT' && !price) throw cannot('SoDEX does not list its price');
  if (type === 'MARKET' && change.price !== undefined) throw cannot('a market order has no price to change');
  return {
    symbol,
    side: side === 'BUY' ? 'buy' : 'sell',
    type: type === 'MARKET' ? 'market' : 'limit',
    ...(price ? { price } : {}),
    quantity,
    ...(tif ? { tif } : {}),
    reduceOnly: o.reduceOnly === true,
    ...(stopPrice ? { stopPrice, stopType, triggerType } : {}),
  };
}

/**
 * Change a resting order as CANCEL + NEW ORDER (G6). SoDEX's own change
 * requests have no builder field; where they are not known to keep the
 * order's builder, this is how a build that requires the builder changes an
 * order: the new one is an ordinary order, built here, with the builder.
 *
 * Not atomic - SoDEX has no cancel-and-place with a builder. So everything
 * that can be known beforehand is settled BEFORE the cancel: the order is read
 * from SoDEX, rebuilt (or refused), validated against the market's rules, and
 * its builder decided. If SoDEX then still refuses the new order, the error
 * says in plain words that the original is gone.
 */
export async function recreateOrder(
  engine: Engine,
  ref: { symbol: string; orderID?: number; clOrdID?: string },
  change: OrderChange,
) {
  const sym = await symbolFor(engine, ref.symbol);
  const row = await openOrderRow(engine, sym, ref);
  return recreateFrom(engine, sym, row, change);
}

/** The open order `ref` names, as SoDEX lists it now - or a refusal: there is nothing to change. */
async function openOrderRow(engine: Engine, sym: MarketSymbol, ref: { orderID?: number; clOrdID?: string }): Promise<OrderRow> {
  const s = requireSigner(undefined, engine);
  if (ref.orderID === undefined && !ref.clOrdID) throw new OrderValidationError('orderID or clOrdID is required');
  const open = unwrapList<OrderRow>(await readGateway(`/api/v1/${engine}/accounts/${s.meta.owner}/orders?symbol=${encodeURIComponent(sym.name)}`), 'orders');
  const row = open.find((o) => (ref.orderID !== undefined && Number(o.orderID) === ref.orderID) || (!!ref.clOrdID && o.clOrdID === ref.clOrdID));
  if (!row || !Number.isSafeInteger(Number(row.orderID))) throw new OrderValidationError('That order is no longer open on SoDEX, so there is nothing to change.');
  return row;
}

async function recreateFrom(engine: Engine, sym: MarketSymbol, row: OrderRow, change: OrderChange) {
  const s = requireSigner(undefined, engine);
  const ticket = ticketFromOpenOrder(sym.name, row, change);
  const builder = await builderForOrder(engine);
  const built = placeOrderAction(engine, ticket, sym, s.meta.accountId, builder);

  const cancelled = await signAndSend(cancelOrderAction(engine, sym, s.meta.accountId, { orderID: Number(row.orderID) }), 'cancel');
  checkBatch(cancelled, 'cancel');
  let result: unknown;
  try {
    result = await signAndSend(built.action, 'order');
    checkBatch(result, 'order');
  } catch (e) {
    noteBuilderRejection(e);
    const why = e instanceof Error ? e.message : String(e);
    log.error('order change: the original was cancelled, the new order was not accepted', { engine, symbol: sym.name, orderID: row.orderID, error: why });
    throw new TradingError(
      `Your order was cancelled, but the changed order was not accepted (${why.replace(/[.\s]+$/, '')}). Nothing is resting on SoDEX for it now - place it again.`,
      'recreate-failed',
    );
  }
  log.info('order changed as cancel + new order', { engine, symbol: sym.name, was: row.orderID, ...(builder ? { builderFee: builder.fee } : {}) });
  return { result, recreated: true as const };
}

/** How `changeOrder` changes an open order. */
export type ChangeRoute = 'modify' | 'replace' | 'recreate';

/**
 * Which of SoDEX's requests changes this open order - or why none does. Pure.
 *
 * SoDEX has two (perps "Modify TP/SL order" and "Replace multiple orders"):
 *   modify   is for take-profit / stop-loss orders only ("the order must be a
 *            TP/SL order"), and changes the order in place;
 *   replace  is for plain limit orders only - GTC or post-only (GTX), status
 *            NEW or PARTIALLY_FILLED, not a TP/SL - on spot and perps.
 * Neither request has a builder field. Where it is not known to keep the
 * order's builder (feeGuard.ts MODIFY_KEEPS_BUILDER / REPLACE_KEEPS_BUILDER)
 * and the build requires the builder, the change is made as cancel + new
 * order with the builder instead ('recreate', G6).
 */
export function changeRoute(engine: Engine, o: OrderRow, changeIn: OrderChange): ChangeRoute {
  const change = changeOf(changeIn);
  if (!change.price && !change.quantity && !change.stopPrice) throw new OrderValidationError('Nothing to change: enter a new price, size or trigger price.');
  const cannot = (why: string) => new OrderValidationError(`This order cannot be changed here: ${why}. Cancel it and place a new one.`);
  const r = rowFacts(o);
  if (r.tpsl) {
    if (engine !== 'perps') throw cannot('spot has no take-profit or stop-loss orders');
    return mustRecreate('modifyOrder', engine) ? 'recreate' : 'modify';
  }
  if (change.stopPrice) throw cannot('it has no trigger price');
  if (r.type !== 'LIMIT') throw cannot(`only resting limit orders and take-profit / stop-loss orders can be changed, and this is a ${r.type ? r.type.toLowerCase() : 'not listed'} order`);
  if (r.tif !== 'GTC' && r.tif !== 'GTX') throw cannot(`SoDEX changes only good-till-cancelled and post-only limit orders, and this one is ${r.tif || 'not listed'}`);
  if (r.status && r.status !== 'NEW' && r.status !== 'PARTIALLY_FILLED') throw cannot(`its status is ${r.status.toLowerCase().replace(/_/g, ' ')}`);
  return mustRecreate('replaceOrder', engine) ? 'recreate' : 'replace';
}

/**
 * CHANGE A RESTING ORDER - the one function the app calls for it (the open
 * orders' Modify, the positions table's take-profit / stop-loss edit, the
 * chart drag). The order is read from SoDEX first and the request chosen by
 * what it is (`changeRoute`):
 *   a take-profit / stop-loss (perps)  -> SoDEX's modify request (POST /trade/orders/modify);
 *   a plain limit GTC / GTX order      -> SoDEX's replace request (POST /trade/orders/replace)
 *                                         when REPLACE_KEEPS_BUILDER is true or no builder is
 *                                         required; otherwise cancel + new order with the builder;
 *   anything else                      -> refused before anything is signed.
 * Every request still passes the fee guard. Returns which way it went:
 * after 'recreate' the order has a NEW order id.
 */
export async function changeOrder(
  engine: Engine,
  ref: { symbol: string; orderID?: number; clOrdID?: string },
  changeIn: OrderChange,
): Promise<{ route: ChangeRoute; result: unknown }> {
  const s = requireSigner(undefined, engine);
  const sym = await symbolFor(engine, ref.symbol);
  const row = await openOrderRow(engine, sym, ref);
  const change = changeOf(changeIn);
  const route = changeRoute(engine, row, change);
  const orderID = Number(row.orderID);
  log.info('order change', { engine, symbol: sym.name, orderID, route, fields: Object.keys(change) });
  if (route === 'recreate') return { route, result: (await recreateFrom(engine, sym, row, change)).result };
  if (route === 'modify') {
    // One id, never both (SoDEX: "either orderID or clOrdID").
    return { route, result: await signAndSend(modifyOrderAction(sym, s.meta.accountId, { orderID, ...change }), 'order change') };
  }
  // Replace: only what changes is sent - a field left out keeps the order's own (SoDEX).
  const same = (a: string | undefined, b: unknown) => a !== undefined && b !== undefined && b !== null && PLAIN_DECIMAL.test(a) && PLAIN_DECIMAL.test(String(b)) && decimalCompare(a, String(b)) === 0;
  const price = same(change.price, row.price) ? undefined : change.price;
  const quantity = same(change.quantity, row.origQty) ? undefined : change.quantity;
  if (price === undefined && quantity === undefined) throw new OrderValidationError('Nothing to change: the price and size are what the order already has.');
  const result = await signAndSend(replaceOrderAction(engine, sym, s.meta.accountId, { origOrderID: orderID, price, quantity }), 'order replace');
  checkBatch(result, 'order replace');
  return { route, result };
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

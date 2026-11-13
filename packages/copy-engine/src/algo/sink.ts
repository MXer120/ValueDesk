/**
 * Where an algo's child orders go.
 *
 * A child is an ordinary SoDEX perps LIMIT order: IOC to take (priced at the
 * touch plus the slippage cap, so it never fills worse), GTX to rest without
 * ever taking, GTC for a ladder. The children of one request are one signed
 * batch on one market. The builder fee rides at batch level, as on every
 * ValueDesk order.
 *
 * The key sink signs with a registered key (an executor's); the browser
 * passes its own sink that goes through the app's fee guard; paper runs are
 * simulated by the runtime itself and send nothing.
 */
import {
  OrderModifier,
  OrderSide,
  OrderType,
  SodexApiError,
  StopType,
  TimeInForce,
  TriggerType,
  failedOrders,
  perpsActions,
  signAndBuildWithNonceManager,
  unwrapList,
  type BuilderParams,
  type NonceManager,
  type OrderResult,
  type SignableAction,
  type SigningKeyRef,
} from '../../../sodex-core/src/index.ts';
import { leverageAction } from '../orders.ts';
import { OutcomeUnknownError, type SodexClient } from '../sodex.ts';
import type { MarginChoice, MarketInfo } from '../types.ts';
import type { AlgoRecord, ChildTif, Side } from './types.ts';

/** One child as it is signed: canonical decimal strings. */
export interface ChildRequest {
  clOrdID: string;
  side: Side;
  price: string;
  quantity: string;
  tif: ChildTif;
  reduceOnly: boolean;
}

export interface ChildResult {
  clOrdID: string;
  ok: boolean;
  orderId: string | null;
  error: string | null;
  /** No readable answer: it may or may not exist. Never re-sent. */
  outcomeUnknown: boolean;
  /** With outcomeUnknown: SoDEX's gateway turned it away (HTTP 503, or SoDEX in maintenance) - most likely not placed. */
  maintenance?: boolean;
}

/**
 * An exit, as it is signed: a SoDEX position stop - a reduce-only market order
 * that SoDEX fires itself when the MARK reaches `triggerPrice` (the only
 * trigger SoDEX accepts on placement). The same order the copier keeps for a
 * copy's stop-loss / take-profit (orders.ts stopAction).
 */
export interface StopRequest {
  clOrdID: string;
  /** The side that closes the position. */
  side: Side;
  quantity: string;
  triggerPrice: string;
  kind: 'tp' | 'sl';
}

export interface AlgoSink {
  readonly paper: boolean;
  /** One signed batch on one market (at most 100 children). */
  place(a: AlgoRecord, market: MarketInfo, orders: ChildRequest[]): Promise<ChildResult[]>;
  /** Exits (take-profit / stop-loss) on one market, one signed batch. */
  placeStops(a: AlgoRecord, market: MarketInfo, stops: StopRequest[]): Promise<ChildResult[]>;
  /** Cancel by client order id. An order already gone is not an error. */
  /** Resolves with the client ids SoDEX answered as gone already (filled or cancelled before): void = none known. */
  cancel(a: AlgoRecord, market: MarketInfo, clOrdIDs: string[]): Promise<void | string[]>;
  setLeverage(a: AlgoRecord, market: MarketInfo, leverage: number, margin: MarginChoice): Promise<void>;
}

const TIF = { ioc: TimeInForce.IOC, gtx: TimeInForce.GTX, gtc: TimeInForce.GTC } as const;

/** Exits as one perps batch: STOP modifier, market type, IOC, the mark trigger, reduce-only. */
export function stopsAction(accountId: number, market: MarketInfo, stops: readonly StopRequest[], builder: BuilderParams | null): SignableAction {
  return perpsActions.newOrder(
    accountId,
    market.id,
    stops.map((s) => ({
      clOrdID: s.clOrdID,
      modifier: OrderModifier.STOP,
      side: s.side === 'buy' ? OrderSide.BUY : OrderSide.SELL,
      type: OrderType.MARKET,
      timeInForce: TimeInForce.IOC,
      quantity: s.quantity,
      stopPrice: s.triggerPrice,
      stopType: s.kind === 'tp' ? StopType.TAKE_PROFIT : StopType.STOP_LOSS,
      triggerType: TriggerType.MARK_PRICE,
      reduceOnly: true,
    })),
    builder ?? undefined,
  );
}

/** Answer rows matched to stops (their client order ids). */
export const readStops = (data: unknown, stops: readonly StopRequest[]): ChildResult[] =>
  readBatch(
    data,
    stops.map((s) => ({ clOrdID: s.clOrdID, side: s.side, price: s.triggerPrice, quantity: s.quantity, tif: 'ioc' as const, reduceOnly: true })),
  );

export function childrenAction(accountId: number, market: MarketInfo, orders: readonly ChildRequest[], builder: BuilderParams | null): SignableAction {
  return perpsActions.newOrder(
    accountId,
    market.id,
    orders.map((o) => ({
      clOrdID: o.clOrdID,
      modifier: OrderModifier.NORMAL,
      side: o.side === 'buy' ? OrderSide.BUY : OrderSide.SELL,
      type: OrderType.LIMIT,
      timeInForce: TIF[o.tif],
      price: o.price,
      quantity: o.quantity,
      reduceOnly: o.reduceOnly,
    })),
    builder ?? undefined,
  );
}

const describe = (e: unknown): string => (e instanceof SodexApiError ? `${e.message}${e.hint ? ` (${e.hint})` : ''}` : e instanceof Error ? e.message : String(e));

/**
 * Rows of a batch answer, matched to the children by client order id. A failure row that names none of them is
 * SoDEX's pre-validation refusing the whole batch (returned once for all of it): every child is refused. A child
 * with no row of its own proves nothing - it may or may not rest - so it is `outcomeUnknown` (looked up, never
 * re-sent), not placed: counted as placed it was a ghost "open" order that reset the refusal count.
 */
export function readBatch(data: unknown, orders: readonly ChildRequest[]): ChildResult[] {
  const list = (Array.isArray(data) ? (data as OrderResult[]) : unwrapList<OrderResult>(data, 'orders')).filter((r) => r && typeof r === 'object');
  const ids = new Set(orders.map((o) => o.clOrdID));
  const bad = failedOrders(list);
  const failed = new Set(bad.map((r) => r.clOrdID));
  const whole = bad.find((r) => !r.clOrdID || !ids.has(r.clOrdID)) ?? null;
  return orders.map((o) => {
    const row = list.find((r) => r.clOrdID === o.clOrdID);
    const own = failed.has(o.clOrdID);
    if (own || (whole && !(row && row.code === 0))) {
      const r = own ? row : whole;
      return { clOrdID: o.clOrdID, ok: false, orderId: null, error: r?.error || `code ${r?.code}`, outcomeUnknown: false };
    }
    if (!row) return { clOrdID: o.clOrdID, ok: false, orderId: null, error: 'SoDEX answered without a row for this order', outcomeUnknown: true };
    return { clOrdID: o.clOrdID, ok: true, orderId: row.orderID !== undefined ? String(row.orderID) : null, error: null, outcomeUnknown: false };
  });
}

/**
 * An order a cancel could not find is gone already (filled or cancelled): not an error. SoDEX says it as
 * "OrderNotFound" too (no spaces: 2026-11-09, a KORU bot's "cancel failed" storm).
 */
export const GONE = /not ?found|unknown ?order|does ?not ?exist|already/i;

/** The client ids of a cancel's answer SoDEX answered as gone already (filled or cancelled before the cancel). */
export function cancelGone(data: unknown): string[] {
  const list = Array.isArray(data) ? (data as OrderResult[]) : unwrapList<OrderResult>(data, 'orders');
  return failedOrders(list).filter((r) => GONE.test(r.error ?? '') && r.clOrdID).map((r) => String(r.clOrdID));
}

/**
 * The rows of a cancel's answer SoDEX refused for another reason than the order being gone (an order it found and
 * did not cancel: it may still fill). Empty: every order is cancelled or gone.
 */
export function cancelFailures(data: unknown): string[] {
  const list = Array.isArray(data) ? (data as OrderResult[]) : unwrapList<OrderResult>(data, 'orders');
  return failedOrders(list)
    .filter((r) => !GONE.test(r.error ?? ''))
    .map((r) => `${r.clOrdID ? `${r.clOrdID}: ` : ''}${r.error || `code ${r.code}`}`);
}

/** Signs with a key registered on the trader's SoDEX account (the executors' sink). */
export class KeyAlgoSink implements AlgoSink {
  readonly paper = false;
  constructor(
    private readonly client: SodexClient,
    private readonly key: () => SigningKeyRef | null,
    private readonly nonces: NonceManager,
    private readonly chainId: number,
    private readonly builder: (a: AlgoRecord) => Promise<BuilderParams | null>,
  ) {}

  private async signAndSend(action: SignableAction): Promise<unknown> {
    const key = this.key();
    if (!key) throw new SodexApiError(401, 'no trading key is available for this algo', 401, '');
    const req = await signAndBuildWithNonceManager(action, key, { chainId: this.chainId, nonces: this.nonces, base: '' });
    return this.client.send(req);
  }

  async place(a: AlgoRecord, market: MarketInfo, orders: ChildRequest[]): Promise<ChildResult[]> {
    if (!orders.length) return [];
    try {
      // A failed lookup refuses the batch (the catch below) - never an order without our builder.
      const builder = await this.builder(a);
      return readBatch(await this.signAndSend(childrenAction(a.accountId, market, orders, builder)), orders);
    } catch (e) {
      const unknown = e instanceof OutcomeUnknownError;
      const maint = unknown && e.maintenance ? { maintenance: true } : {};
      return orders.map((o) => ({ clOrdID: o.clOrdID, ok: false, orderId: null, error: describe(e), outcomeUnknown: unknown, ...maint }));
    }
  }

  async placeStops(a: AlgoRecord, market: MarketInfo, stops: StopRequest[]): Promise<ChildResult[]> {
    if (!stops.length) return [];
    try {
      // A failed lookup refuses the batch (the catch below) - never an order without our builder.
      const builder = await this.builder(a);
      return readStops(await this.signAndSend(stopsAction(a.accountId, market, stops, builder)), stops);
    } catch (e) {
      const unknown = e instanceof OutcomeUnknownError;
      const maint = unknown && e.maintenance ? { maintenance: true } : {};
      return stops.map((s) => ({ clOrdID: s.clOrdID, ok: false, orderId: null, error: describe(e), outcomeUnknown: unknown, ...maint }));
    }
  }

  /**
   * Cancels of one account that arrive together (a market-wide move pulling a wallet's quotes on several markets) go
   * out as ONE signed request (owner 2026-11-09, Katana's rule: per-symbol cancels in a burst ran past the rate limit
   * and pulls came late). Each caller gets its own orders' outcome: the ids SoDEX answered as gone, or an error naming
   * only its orders that SoDEX did not cancel.
   */
  private pending = new Map<number, { a: AlgoRecord; rows: Array<{ symbolID: number; clOrdID: string }>; waiters: Array<{ ids: string[]; resolve: (v: string[]) => void; reject: (e: unknown) => void }> }>();
  cancel(a: AlgoRecord, market: MarketInfo, clOrdIDs: string[]): Promise<void | string[]> {
    if (!clOrdIDs.length) return Promise.resolve();
    return new Promise<string[]>((resolve, reject) => {
      let b = this.pending.get(a.accountId);
      if (!b) {
        b = { a, rows: [], waiters: [] };
        this.pending.set(a.accountId, b);
        // The same turn of the event loop: whatever else is cancelled for this account now joins this request.
        void Promise.resolve().then(() => this.flushCancels(a.accountId));
      }
      for (const clOrdID of clOrdIDs) b.rows.push({ symbolID: market.id, clOrdID });
      b.waiters.push({ ids: [...clOrdIDs], resolve, reject });
    });
  }

  private async flushCancels(accountId: number): Promise<void> {
    const b = this.pending.get(accountId);
    this.pending.delete(accountId);
    if (!b) return;
    let data: unknown;
    try {
      data = await this.signAndSend(perpsActions.cancelOrder(accountId, b.rows));
    } catch (e) {
      // The whole cancel answered "gone": every order in it was filled or cancelled already.
      if (e instanceof SodexApiError && GONE.test(e.message)) {
        for (const w of b.waiters) w.resolve([...w.ids]);
        return;
      }
      for (const w of b.waiters) w.reject(e);
      return;
    }
    const gone = new Set(cancelGone(data));
    const bad = cancelFailures(data);
    for (const w of b.waiters) {
      // A batch the envelope calls a success can still refuse some rows: those orders rest on, so their caller must know.
      // A refused row that names no order cannot be placed: every caller of the request hears of it.
      const mine = bad.filter((x) => w.ids.some((id) => x.startsWith(`${id}:`)) || !b.rows.some((r) => x.startsWith(`${r.clOrdID}:`)));
      if (mine.length) w.reject(new Error(`SoDEX did not cancel ${mine.length} order${mine.length === 1 ? '' : 's'}: ${mine.join('; ')}`));
      else w.resolve(w.ids.filter((id) => gone.has(id)));
    }
  }

  async setLeverage(a: AlgoRecord, market: MarketInfo, leverage: number, margin: MarginChoice): Promise<void> {
    await this.signAndSend(leverageAction(a.accountId, market, leverage, margin));
  }
}

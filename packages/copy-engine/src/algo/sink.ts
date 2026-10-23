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
  TimeInForce,
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
}

export interface AlgoSink {
  readonly paper: boolean;
  /** One signed batch on one market (at most 100 children). */
  place(a: AlgoRecord, market: MarketInfo, orders: ChildRequest[]): Promise<ChildResult[]>;
  /** Cancel by client order id. An order already gone is not an error. */
  cancel(a: AlgoRecord, market: MarketInfo, clOrdIDs: string[]): Promise<void>;
  setLeverage(a: AlgoRecord, market: MarketInfo, leverage: number, margin: MarginChoice): Promise<void>;
}

const TIF = { ioc: TimeInForce.IOC, gtx: TimeInForce.GTX, gtc: TimeInForce.GTC } as const;

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

/** Rows of a batch answer, matched to the children by client order id. */
export function readBatch(data: unknown, orders: readonly ChildRequest[]): ChildResult[] {
  const list = Array.isArray(data) ? (data as OrderResult[]) : unwrapList<OrderResult>(data, 'orders');
  const failed = new Set(failedOrders(list).map((r) => r.clOrdID));
  return orders.map((o) => {
    const row = list.find((r) => r.clOrdID === o.clOrdID);
    const bad = failed.has(o.clOrdID);
    return {
      clOrdID: o.clOrdID,
      ok: !bad,
      orderId: row?.orderID !== undefined ? String(row.orderID) : null,
      error: bad ? row?.error || `code ${row?.code}` : null,
      outcomeUnknown: false,
    };
  });
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
      const builder = await this.builder(a).catch(() => null);
      return readBatch(await this.signAndSend(childrenAction(a.accountId, market, orders, builder)), orders);
    } catch (e) {
      const unknown = e instanceof OutcomeUnknownError;
      return orders.map((o) => ({ clOrdID: o.clOrdID, ok: false, orderId: null, error: describe(e), outcomeUnknown: unknown }));
    }
  }

  async cancel(a: AlgoRecord, market: MarketInfo, clOrdIDs: string[]): Promise<void> {
    if (!clOrdIDs.length) return;
    try {
      await this.signAndSend(perpsActions.cancelOrder(a.accountId, clOrdIDs.map((clOrdID) => ({ symbolID: market.id, clOrdID }))));
    } catch (e) {
      if (e instanceof SodexApiError && /not found|unknown order|does not exist|already/i.test(e.message)) return;
      throw e;
    }
  }

  async setLeverage(a: AlgoRecord, market: MarketInfo, leverage: number, margin: MarginChoice): Promise<void> {
    await this.signAndSend(leverageAction(a.accountId, market, leverage, margin));
  }
}

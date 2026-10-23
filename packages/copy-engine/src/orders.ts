/**
 * Intents -> SoDEX actions, and the two ways they leave the copier.
 *
 * A copied order is an IOC LIMIT: it fills what it can at once, never worse
 * than the follower's slippage cap, and never rests on the book. Intents of
 * one market go out in ONE signed request (a flip's close and open are one
 * batch, in that order). Protective stop-loss / take-profit orders are SoDEX
 * position stops: reduce-only market orders triggered on the MARK price
 * (SoDEX's only trigger for order placement).
 *
 * The builder fee rides at batch level on every copier order, as the Go SDK
 * carries it, and only where the follower's SoDEX approval covers it.
 */
import {
  MarginMode,
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
} from '../../sodex-core/src/index.ts';
import { OutcomeUnknownError, type SodexClient } from './sodex.ts';
import type { Intent, MarginChoice, MarketInfo } from './types.ts';

export interface StopOrder {
  clOrdID: string;
  /** The side that closes the position. */
  side: 'buy' | 'sell';
  quantity: string;
  triggerPrice: string;
  kind: 'stop-loss' | 'take-profit';
}

export interface SendResult {
  clOrdID: string;
  ok: boolean;
  orderId: string | null;
  error: string | null;
  /** The request may or may not have executed (no readable answer). */
  outcomeUnknown: boolean;
  /** Paper copies report their simulated fill. */
  paperFill?: { qty: number; price: number };
}

export function intentsAction(accountId: number, market: MarketInfo, intents: readonly Intent[], builder: BuilderParams | null): SignableAction {
  return perpsActions.newOrder(
    accountId,
    market.id,
    intents.map((i) => ({
      clOrdID: i.clOrdID,
      modifier: OrderModifier.NORMAL,
      side: i.side === 'buy' ? OrderSide.BUY : OrderSide.SELL,
      type: OrderType.LIMIT,
      timeInForce: TimeInForce.IOC,
      price: i.limitPrice,
      quantity: i.quantity,
      reduceOnly: i.reduceOnly,
    })),
    builder ?? undefined,
  );
}

export function stopAction(accountId: number, market: MarketInfo, s: StopOrder, builder: BuilderParams | null): SignableAction {
  return perpsActions.newOrder(
    accountId,
    market.id,
    [
      {
        clOrdID: s.clOrdID,
        modifier: OrderModifier.STOP,
        side: s.side === 'buy' ? OrderSide.BUY : OrderSide.SELL,
        type: OrderType.MARKET,
        timeInForce: TimeInForce.IOC,
        quantity: s.quantity,
        stopPrice: s.triggerPrice,
        stopType: s.kind === 'take-profit' ? StopType.TAKE_PROFIT : StopType.STOP_LOSS,
        triggerType: TriggerType.MARK_PRICE,
        reduceOnly: true,
      },
    ],
    builder ?? undefined,
  );
}

export const cancelAction = (accountId: number, market: MarketInfo, clOrdID: string): SignableAction =>
  perpsActions.cancelOrder(accountId, [{ symbolID: market.id, clOrdID }]);

export const leverageAction = (accountId: number, market: MarketInfo, leverage: number, margin: MarginChoice): SignableAction =>
  perpsActions.updateLeverage(accountId, market.id, Math.max(1, Math.min(leverage, market.maxLeverage)), margin === 'isolated' ? MarginMode.ISOLATED : MarginMode.CROSS);

/** Where intents go. */
export interface OrderSink {
  readonly paper: boolean;
  place(accountId: number, market: MarketInfo, intents: Intent[], builder: BuilderParams | null, reference: number): Promise<SendResult[]>;
  setLeverage(accountId: number, market: MarketInfo, leverage: number, margin: MarginChoice): Promise<void>;
  placeStop(accountId: number, market: MarketInfo, stop: StopOrder, builder: BuilderParams | null): Promise<SendResult>;
  cancel(accountId: number, market: MarketInfo, clOrdID: string): Promise<void>;
}

const describe = (e: unknown): string => (e instanceof SodexApiError ? `${e.message}${e.hint ? ` (${e.hint})` : ''}` : e instanceof Error ? e.message : String(e));

/** A sink that signs with a registered SoDEX key and sends to the gateway. */
export class KeySink implements OrderSink {
  readonly paper = false;
  constructor(
    private readonly client: SodexClient,
    private readonly key: () => SigningKeyRef | null,
    private readonly nonces: NonceManager,
    private readonly chainId: number,
  ) {}

  private async signAndSend(action: SignableAction): Promise<unknown> {
    const key = this.key();
    if (!key) throw new SodexApiError(401, 'no copy key is available', 401, '');
    const req = await signAndBuildWithNonceManager(action, key, { chainId: this.chainId, nonces: this.nonces, base: '' });
    return this.client.send(req);
  }

  async place(accountId: number, market: MarketInfo, intents: Intent[], builder: BuilderParams | null): Promise<SendResult[]> {
    if (!intents.length) return [];
    try {
      const data = await this.signAndSend(intentsAction(accountId, market, intents, builder));
      const rows = Array.isArray(data) ? (data as OrderResult[]) : unwrapList<OrderResult>(data, 'orders');
      const failed = new Set(failedOrders(rows).map((r) => r.clOrdID));
      return intents.map((i) => {
        const row = rows.find((r) => r.clOrdID === i.clOrdID);
        const bad = failed.has(i.clOrdID);
        return {
          clOrdID: i.clOrdID,
          ok: !bad,
          orderId: row?.orderID !== undefined ? String(row.orderID) : null,
          error: bad ? row?.error || `code ${row?.code}` : null,
          outcomeUnknown: false,
        };
      });
    } catch (e) {
      const unknown = e instanceof OutcomeUnknownError;
      return intents.map((i) => ({ clOrdID: i.clOrdID, ok: false, orderId: null, error: describe(e), outcomeUnknown: unknown }));
    }
  }

  async setLeverage(accountId: number, market: MarketInfo, leverage: number, margin: MarginChoice): Promise<void> {
    await this.signAndSend(leverageAction(accountId, market, leverage, margin));
  }

  async placeStop(accountId: number, market: MarketInfo, stop: StopOrder, builder: BuilderParams | null): Promise<SendResult> {
    try {
      const data = await this.signAndSend(stopAction(accountId, market, stop, builder));
      const rows = Array.isArray(data) ? (data as OrderResult[]) : unwrapList<OrderResult>(data, 'orders');
      const bad = failedOrders(rows)[0];
      return { clOrdID: stop.clOrdID, ok: !bad, orderId: null, error: bad ? bad.error || `code ${bad.code}` : null, outcomeUnknown: false };
    } catch (e) {
      return { clOrdID: stop.clOrdID, ok: false, orderId: null, error: describe(e), outcomeUnknown: e instanceof OutcomeUnknownError };
    }
  }

  async cancel(accountId: number, market: MarketInfo, clOrdID: string): Promise<void> {
    try {
      await this.signAndSend(cancelAction(accountId, market, clOrdID));
    } catch (e) {
      // An order that already triggered or was never placed cannot be cancelled: nothing to do.
      if (e instanceof SodexApiError && /not found|unknown order|does not exist|already/i.test(e.message)) return;
      throw e;
    }
  }
}

/**
 * Paper copy: nothing is signed or sent. Every order "fills" in full at the
 * reference price moved by 1 bp against the follower, which is what the
 * activity log and the copy's PnL then show (labelled paper everywhere).
 */
export class PaperSink implements OrderSink {
  readonly paper = true;
  private n = 0;

  async place(_accountId: number, _market: MarketInfo, intents: Intent[], _builder: BuilderParams | null, reference: number): Promise<SendResult[]> {
    return intents.map((i) => {
      const px = i.side === 'buy' ? reference * 1.0001 : reference * 0.9999;
      return { clOrdID: i.clOrdID, ok: true, orderId: `paper-${++this.n}`, error: null, outcomeUnknown: false, paperFill: { qty: Number(i.quantity), price: px } };
    });
  }

  async setLeverage(): Promise<void> {}

  async placeStop(_a: number, _m: MarketInfo, stop: StopOrder): Promise<SendResult> {
    return { clOrdID: stop.clOrdID, ok: true, orderId: null, error: null, outcomeUnknown: false };
  }

  async cancel(): Promise<void> {}
}

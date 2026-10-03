/**
 * The seam to the app's builder-fee side and to the parts of the trading layer
 * that are still moving: the signed fee terms (trading/terms.ts), "the builder
 * an order placed now carries" (trading/feeGuard.ts builderNow), the change of
 * a resting order, and the two constants that say whether a changed order keeps
 * its builder (feeGuard.ts, contract G6).
 *
 * Everything the steps need of them goes through here, so when a name or a
 * signature changes there is ONE place to follow it. Nothing here reimplements
 * app logic: each function calls the app's own.
 */
import * as actions from '../../src/trading/actions';
import { MODIFY_KEEPS_BUILDER, REPLACE_KEEPS_BUILDER, builderNow, mustRecreate } from '../../src/trading/feeGuard';
import * as termsMod from '../../src/trading/terms';

export type Engine = 'spot' | 'perps';

/** The app's terms module, as docs/BUILDER-TIERS.md section 7 describes it. */
export interface AppTerms {
  configureTerms(o: { keys: readonly string[]; endpoint?: string; fetch?: (input: string, init?: RequestInit) => Promise<Response>; monotonicNow?: () => number }): void;
  /** Verified terms, or null when the answer was refused (then whatever was held before still applies, else the default). */
  refreshTerms(address: string, o?: { hint?: boolean }): Promise<unknown>;
  /** What an order placed now on `engine` carries. */
  feeNow(engine: Engine, address: string): unknown;
}

/** The app's own terms module. */
export const appTermsModule: AppTerms = {
  configureTerms: (o) => termsMod.configureTerms(o),
  refreshTerms: (address, o) => termsMod.refreshTerms(address, o),
  feeNow: (engine, address) => termsMod.feeNow(engine, address),
};

/** A fee as the app answers it: a number, or an object with a `fee`. */
export function feeNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
  const f = v && typeof v === 'object' ? (v as { fee?: unknown }).fee : undefined;
  return typeof f === 'number' && Number.isInteger(f) && f >= 0 ? f : null;
}

/** The builder the app says an order placed NOW on `engine` carries, or undefined (none). */
export function appOrderBuilder(engine: Engine): { id: number; fee: number } | undefined {
  const b = builderNow(engine);
  return b ? { id: Number(b.id), fee: b.fee } : undefined;
}

/** What the app ASSUMES about a changed order's builder (contract G6). */
export const appAssumes = {
  replaceKeepsBuilder: (): boolean => REPLACE_KEEPS_BUILDER,
  modifyKeepsBuilder: (): boolean => MODIFY_KEEPS_BUILDER,
};

/**
 * Does the app change an order of this kind as CANCEL + NEW ORDER (G6: the
 * request is not known to keep the builder, in a build that requires it) rather
 * than with SoDEX's own change request?
 */
export const appRecreates = {
  limit: (engine: Engine): boolean => mustRecreate('replaceOrder', engine),
  stop: (): boolean => mustRecreate('modifyOrder', 'perps'),
};

/**
 * Change the price and/or size of a resting plain limit order through the
 * app's one change-order function (actions.ts changeOrder): SoDEX's replace
 * where it is known to keep the builder (or no builder is required), else
 * cancel + new order with the builder. Returns the route it took.
 */
export function changeLimitOrder(engine: Engine, o: { symbol: string; orderID: number; price?: string; quantity?: string }): Promise<{ route: string; result: unknown }> {
  return actions.changeOrder(engine, { symbol: o.symbol, orderID: o.orderID }, { ...(o.price !== undefined ? { price: o.price } : {}), ...(o.quantity !== undefined ? { quantity: o.quantity } : {}) });
}

/** Change a stand-alone TP/SL order's trigger price through the same function (SoDEX's modify, or cancel + new). */
export function changeStopOrder(o: { symbol: string; orderID: number; stopPrice: string }): Promise<{ route: string; result: unknown }> {
  return actions.changeOrder('perps', { symbol: o.symbol, orderID: o.orderID }, { stopPrice: o.stopPrice });
}

export const app = {
  placeOrder: actions.placeOrder,
  cancelOrder: actions.cancelOrder,
  cancelAll: actions.cancelAll,
  setLeverage: actions.setLeverage,
  adjustMargin: actions.adjustMargin,
  scheduleCancel: actions.scheduleCancel,
};

/**
 * The fee guard: ONE check that every signed action passes before it is signed
 * (docs/BUILDER-TIERS.md section 2 - G2, G6).
 *
 * WHY A SECOND CHECK. actions.ts attaches the builder when it builds an order.
 * This does not build anything: it looks at the finished action, whoever built
 * it, and refuses what must not leave. A code path that forgets the builder, a
 * new action type, a per-order builder that undercuts the batch's - none of
 * them can produce an order outside the rules, because nothing is signed that
 * did not pass here (`signAndSend` in actions.ts calls `guardAction` first, and
 * is the only place in the app that signs an exchange action).
 *
 * EVERY ACTION TYPE IS CLASSIFIED (`ACTION_CLASS`). The table is typed over
 * @sodex-core's `ActionType`, so a type added there does not compile until it
 * has a class here; a type that reaches the guard without one is refused.
 *
 *   order                  creates orders and can carry a builder (newOrder,
 *                          batchNewOrder): the batch must name THE PINNED
 *                          BUILDER at NO LESS THAN THE FEE OWED NOW (terms.ts
 *                          `feeNow`) and no more than the build's default, on
 *                          every engine the build charges on. A build that
 *                          requires the builder sends nothing else; an optional
 *                          build may send an order with no builder at all, but
 *                          never one with another builder or a lower fee.
 *   order-without-builder  creates orders and cannot carry one (TWAP): refused
 *                          in a build that requires the builder.
 *   change                 changes an existing order (modify, replace). SoDEX's
 *                          requests have no builder field; whether the changed
 *                          order keeps the original's builder is what the two
 *                          constants below say. Where it is not known to, the
 *                          request is refused here and actions.ts makes the
 *                          change as cancel + new order instead.
 *   other                  cancel, leverage, margin, transfers, withdrawals,
 *                          schedule-cancel, key revocation: nothing to check.
 *
 * With no builder configured the guard does nothing at all.
 *
 * WHAT IT DOES NOT LOOK AT: anything this browser stored. Whether an order may
 * leave without the builder is decided by the build (required or not), never by
 * a remembered approval - SoDEX itself rejects an order naming a builder the
 * account has not approved, so a forged "approved" only ever gets a refusal.
 *
 * There is no switch that turns the guard off. ONE EXCEPTION IN KIND, by market: where SoDEX
 * itself charges nothing (owner 2026-11-06, `FEE_FREE_SPOT_SYMBOL_IDS`), an order carries no builder.
 */
import { BUILDER_FEE_CAP, type ActionType, type BuilderParams, type Engine, type SignableAction } from '@sodex-core';
import { activeBuilder, orderBuilder } from './builder';
import { tradingConfig, type BuilderConfig } from './config';
import { TradingError, getTradingState } from './session';
import { feeNow } from './terms';
import { logger } from '../log';

const log = logger('trade');

// --- G6: does a change request keep the order's builder? --------------------------------------

/**
 * SoDEX's modify request changes an order in place (same order id): assumed to
 * keep its builder. Set to false when the live run shows otherwise - modify is
 * then done as cancel + new order in a build that requires the builder.
 */
export const MODIFY_KEEPS_BUILDER: boolean = true;
/**
 * SoDEX's replace request has no builder field. PROVEN by the live run of
 * 2026-10-03 (check builder-replace-keeps-builder): on spot and perps the
 * replaced order still names the builder at the fee it carried, so the request
 * is used as it is.
 */
export const REPLACE_KEEPS_BUILDER: boolean = true;

const KEEPS_BUILDER: Readonly<Record<'modifyOrder' | 'replaceOrder', boolean>> = {
  modifyOrder: MODIFY_KEEPS_BUILDER,
  replaceOrder: REPLACE_KEEPS_BUILDER,
};

// --- the classes ---------------------------------------------------------------------------------

export type ActionClass = 'order' | 'order-without-builder' | 'change' | 'other';

/** Every action type @sodex-core can sign. A new one does not compile until it is listed here. */
export const ACTION_CLASS: Readonly<Record<ActionType, ActionClass>> = {
  newOrder: 'order',
  batchNewOrder: 'order',
  newTwapOrder: 'order-without-builder',
  modifyOrder: 'change',
  replaceOrder: 'change',
  cancelOrder: 'other',
  batchCancelOrder: 'other',
  cancelTwapOrder: 'other',
  scheduleCancel: 'other',
  updateLeverage: 'other',
  updateMargin: 'other',
  transferAsset: 'other',
  revokeAPIKey: 'other',
};

/**
 * Spot markets SoDEX charges no fee on, by symbol id on mainnet: 27 is vUSDT_vUSDC, the market
 * behind the swap (evidence: trading/swap.ts). Owner 2026-11-06: "dont charge one if sodex doesnt
 * charge one for swaps". A fixed list on purpose: a market only leaves the builder fee by a change
 * someone reads here, never because of a field in a response.
 */
export const FEE_FREE_SPOT_SYMBOL_IDS: ReadonlySet<number> = new Set([27]);

export const isFeeFreeMarket = (engine: Engine, symbolId: number): boolean =>
  engine === 'spot' && tradingConfig().network === 'mainnet' && FEE_FREE_SPOT_SYMBOL_IDS.has(symbolId);

/** Every leg of this order is on a market SoDEX charges nothing on. */
function allFeeFree(engine: Engine, orders: unknown[]): boolean {
  return orders.length > 0 && orders.every((o) => isFeeFreeMarket(engine, Number((o as { symbolID?: unknown } | null)?.symbolID)));
}

const refuse = (message: string, detail: Record<string, unknown>): TradingError => {
  log.error('fee guard: an action was NOT signed', detail);
  return new TradingError(message, 'fee-guard');
};

/** The class of an action type. One the guard has never heard of is refused, not waved through. */
export function classifyAction(type: string): ActionClass {
  if (Object.prototype.hasOwnProperty.call(ACTION_CLASS, type)) return ACTION_CLASS[type as ActionType];
  throw refuse(`This request (${type}) is not one the builder-fee guard knows, so it was not sent.`, { type, why: 'unclassified action type' });
}

/**
 * G6: must this change be made as cancel + new order? True in a build that
 * requires the builder, on an engine it charges on, for a request that is not
 * known to keep the order's builder.
 */
export function mustRecreate(type: 'modifyOrder' | 'replaceOrder', engine: Engine): boolean {
  const b = activeBuilder(tradingConfig().builder);
  return !!b && b.required && b.fee[engine] > 0 && !KEEPS_BUILDER[type];
}

// --- the gate ----------------------------------------------------------------------------------------

function guardOrder(action: SignableAction, b: BuilderConfig, owner: string): void {
  const engine = action.engine;
  const p = action.params as { builder?: unknown; orders?: unknown };
  const orders: unknown[] = Array.isArray(p.orders) ? p.orders : [];
  const base = { type: action.type, engine, orders: orders.length };
  // Perps allows a builder per order. The app never sets one, and one could undercut the batch's.
  if (orders.some((o) => !!o && typeof o === 'object' && (o as { builder?: unknown }).builder !== undefined)) {
    throw refuse('This order was not sent: one of its legs names a builder of its own.', { ...base, why: 'per-order builder' });
  }
  const got = p.builder as { id?: unknown; fee?: unknown } | null | undefined;
  const dflt = b.fee[engine];
  if (!(dflt > 0)) {
    // An engine this build does not charge on: no builder belongs there.
    if (got !== undefined && got !== null) throw refuse(`This order was not sent: it names a builder on ${engine}, where ValueDesk charges none.`, { ...base, why: 'builder on an engine that is not charged', got });
    return;
  }
  if (got === undefined || got === null) {
    if (allFeeFree(engine, orders)) return;
    if (b.required) {
      throw refuse(
        `This ${engine} order was not sent: it does not carry the ValueDesk builder fee, and trading through ValueDesk requires it. Reload the page; if it happens again, enable trading again.`,
        { ...base, why: 'no builder in a build that requires it' },
      );
    }
    // An optional build: an account that has not approved the fee trades without it.
    return;
  }
  const owed = feeNow(engine, owner);
  const top = Math.min(dflt, BUILDER_FEE_CAP[engine]);
  if (String(got.id) !== String(b.id)) {
    throw refuse('This order was not sent: it names another builder than ValueDesk.', { ...base, why: 'not the pinned builder', got, pinned: b.id });
  }
  if (typeof got.fee !== 'number' || !Number.isInteger(got.fee) || got.fee < owed || got.fee > top) {
    throw refuse(
      'This order was not sent: the builder fee on it is not the fee this wallet owes right now. Try again.',
      { ...base, why: got.fee !== undefined && Number(got.fee) < owed ? 'below the fee owed' : 'not a fee between the fee owed and the default', got, owed, default: dflt },
    );
  }
}

/**
 * Called for EVERY action right before it is signed (actions.ts `signAndSend`).
 * Returns when the action may be signed; throws TradingError('fee-guard') when
 * it may not. `owner` is the wallet the trading key belongs to.
 */
export function guardAction(action: SignableAction, owner: string): void {
  const b = activeBuilder(tradingConfig().builder);
  // No builder configured: nothing is enforced, nothing changes.
  if (!b) return;
  const kind = classifyAction(action.type);
  if (kind === 'other') return;
  if (kind === 'order') {
    guardOrder(action, b, owner);
    return;
  }
  const engine = action.engine;
  // From here: actions that create or change orders and have no builder field of their own.
  if (!b.required || !(b.fee[engine] > 0)) return;
  if (kind === 'order-without-builder') {
    throw refuse('TWAP orders are not available here: SoDEX cannot attach the ValueDesk builder fee to them, and trading through ValueDesk requires it.', {
      type: action.type,
      engine,
      why: 'an order type that cannot carry a builder',
    });
  }
  if (!KEEPS_BUILDER[action.type as 'modifyOrder' | 'replaceOrder']) {
    throw refuse('This change was not sent: it would replace your order with one that may not carry the ValueDesk builder fee. Cancel the order and place a new one.', {
      type: action.type,
      engine,
      why: 'a change request that is not known to keep the builder',
    });
  }
}

// --- what an order placed now carries --------------------------------------------------------------------

/**
 * THE BUILDER AN ORDER PLACED NOW ON `engine` CARRIES, for the wallet trading
 * is enabled for: `{ id: the pinned builder, fee: the fee owed now }`.
 *
 * undefined when it carries none: no builder is configured, the build does not
 * charge on this engine, or SoDEX lists no approval that covers the fee - in
 * which case a build that requires the builder sends no order at all (actions.ts
 * refuses it), and only an optional build sends it without one.
 *
 * It is the same decision the order ticket's fee line and `placeOrder` use.
 */
export function builderNow(engine: Engine): BuilderParams | undefined {
  const st = getTradingState();
  return orderBuilder(tradingConfig().builder, st.builder, engine, feeNow(engine, st.owner));
}

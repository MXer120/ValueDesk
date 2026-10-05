/**
 * Take-profit / stop-loss drafts for one open position.
 *
 * The sheet shows a trigger price and the gain or loss that price makes, as a
 * percent of the entry or as USDC at the exit's size. The two stay in step:
 * editing either one rewrites the other. A price on the profit side of the
 * mark is a take profit; one on the loss side is a stop.
 *
 * `planExit` is what Confirm sends. An unchanged exit is left alone. Clearing
 * the price cancels it. Switching between a market exit and a limit exit
 * replaces the order, because SoDEX's modify request cannot change an order's
 * type. Anything else is a modify of the trigger, and of the size when that
 * changed.
 */

export type Side = 'long' | 'short';
export type Leg = 'tp' | 'sl';
export type GainUnit = 'pct' | 'usd';

/** +1 when profit is a higher price (long take-profit, short stop-loss). */
export function profitSign(side: Side, leg: Leg): 1 | -1 {
  const above = (side === 'long' && leg === 'tp') || (side === 'short' && leg === 'sl');
  return above ? 1 : -1;
}

/** Where this trigger has to sit: above or below the mark (or the entry). */
export function triggerHint(side: Side, leg: Leg, basis: 'mark' | 'entry'): string {
  const above = profitSign(side, leg) === 1;
  const line = basis === 'mark' ? 'the mark' : 'the entry';
  return above ? `Above ${line}.` : `Below ${line}.`;
}

export function triggerSideOk(price: number, bound: number, side: Side, leg: Leg): boolean {
  if (!(price > 0) || !Number.isFinite(price)) return false;
  if (!(bound > 0)) return true;
  const above = price > bound;
  return profitSign(side, leg) === 1 ? above : price < bound;
}

/**
 * Gain (take profit) or loss (stop) of `price` against the entry. Positive
 * when the trigger is on that leg's side. Null when the entry or, for a USDC
 * figure, the size cannot support it.
 */
export function gainFromPrice(
  entry: number,
  price: number,
  side: Side,
  leg: Leg,
  qty: number,
  unit: GainUnit,
): number | null {
  if (!(entry > 0) || !(price > 0)) return null;
  const delta = (price - entry) * profitSign(side, leg);
  if (unit === 'pct') return (delta / entry) * 100;
  if (!(qty > 0)) return null;
  return delta * qty;
}

/** The trigger price that makes `gain` (a positive gain or loss). */
export function priceFromGain(
  entry: number,
  gain: number,
  side: Side,
  leg: Leg,
  qty: number,
  unit: GainUnit,
): number | null {
  if (!(entry > 0) || !Number.isFinite(gain)) return null;
  const sign = profitSign(side, leg);
  const price = unit === 'pct' ? entry + sign * entry * (gain / 100) : qty > 0 ? entry + sign * (gain / qty) : Number.NaN;
  return price > 0 && Number.isFinite(price) ? price : null;
}

export interface ExitExisting {
  orderID?: number;
  price: string;
  quantity: string;
  limit: boolean;
}

export interface ExitDraft {
  /** Empty clears the exit. */
  price: string;
  quantity: string;
  limit: boolean;
}

export type ExitAction =
  | { action: 'keep' }
  | { action: 'cancel' }
  | { action: 'place'; price: string; quantity: string; limit: boolean }
  | { action: 'modify'; price?: string; quantity?: string; limitPrice?: string }
  | { action: 'replace'; price: string; quantity: string; limit: boolean };

export function sameNum(a: string, b: string): boolean {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return a.trim() === b.trim();
  const scale = Math.max(Math.abs(x), Math.abs(y), 1);
  return Math.abs(x - y) <= scale * 1e-8;
}

/** What Confirm should do with one leg. */
export function planExit(existing: ExitExisting | undefined, next: ExitDraft): ExitAction {
  const price = next.price.trim();
  if (!price) return existing ? { action: 'cancel' } : { action: 'keep' };
  if (!existing) return { action: 'place', price, quantity: next.quantity, limit: next.limit };
  const samePrice = sameNum(existing.price, price);
  const sameQty = sameNum(existing.quantity, next.quantity);
  if (existing.limit === next.limit && samePrice && sameQty) return { action: 'keep' };
  // No id, or a market/limit switch: the modify request cannot do this.
  if (!existing.orderID || existing.limit !== next.limit) {
    return { action: 'replace', price, quantity: next.quantity, limit: next.limit };
  }
  return {
    action: 'modify',
    ...(samePrice ? {} : { price }),
    ...(sameQty ? {} : { quantity: next.quantity }),
    ...(next.limit && !samePrice ? { limitPrice: price } : {}),
  };
}

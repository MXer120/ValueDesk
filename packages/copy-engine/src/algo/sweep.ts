/**
 * Sweep ("Fill fast"): fill the whole amount as fast as the book allows, but
 * never further than a set slippage from an outside reference price.
 *
 * THE REFERENCE is a rolling oracle mid, not SoDEX's own print: the median of
 * Binance USD-M futures (mark) and Binance spot (the book's mid) for the same
 * coin, each fresh within `maxAgeMs`. With neither fresh it falls back to
 * SoDEX's own mark, if that is fresh; with nothing fresh there is no
 * reference and the sweep pauses - it never prices an order off a stale one.
 *
 * EACH ROUND is one IOC limit on SoDEX for everything still open, at the band
 * edge: buy at ref x (1 + slip) rounded DOWN to the tick, sell at ref x
 * (1 - slip) rounded UP, so the rounding never widens the band. Whatever the
 * book holds inside the band fills; the rest is cancelled by the IOC, and the
 * next round (after `roundMs`) re-prices from the reference as it moves.
 * It ends when filled, on cancel, or after `timeoutMs`.
 *
 * Everything here is pure: the runtime calls `sweepReference` and `sweepStep`
 * every tick and does what they say.
 */
import { canonicalDecimal, numberToPlainString, roundToStep } from '../../../sodex-core/src/index.ts';
import type { SourceQuote } from '../priceGuard.ts';

/** The sources a sweep reads, in the order they are shown. SoDEX is the fallback only. */
export const SWEEP_SOURCES = ['binance', 'binanceSpot'] as const;
export const SWEEP_SOURCE_NAMES: Readonly<Record<string, string>> = {
  binance: 'Binance USDⓈ-M futures (mark)',
  binanceSpot: 'Binance spot (mid)',
  sodex: 'SoDEX mark (fallback)',
};
/** A quote older than this is stale. */
export const SWEEP_MAX_AGE_MS = 5_000;

export interface SweepReference {
  price: number;
  /** What it is made of. */
  sources: string[];
  /** true: neither Binance quote was fresh; this is SoDEX's mark. */
  fallback: boolean;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** The reference now, or null (stale or missing everywhere: pause). */
export function sweepReference(quotes: readonly SourceQuote[], sodexMark: { price: number; at: number } | null, now: number, maxAgeMs = SWEEP_MAX_AGE_MS): SweepReference | null {
  const fresh = quotes.filter((q) => (SWEEP_SOURCES as readonly string[]).includes(q.source) && Number.isFinite(q.price) && q.price > 0 && now - q.at <= maxAgeMs && q.at <= now + 1_000);
  if (fresh.length) return { price: median(fresh.map((q) => q.price)), sources: fresh.map((q) => q.source), fallback: false };
  if (sodexMark && sodexMark.price > 0 && now - sodexMark.at <= maxAgeMs) return { price: sodexMark.price, sources: ['sodex'], fallback: true };
  return null;
}

const plain = (x: number): string => canonicalDecimal(numberToPlainString(Number(x.toPrecision(12))));

/** `x` on the step grid, down or up (exact multiples stay). */
export function toGrid(x: number, step: string, dir: 'down' | 'up'): number {
  const lo = Number(roundToStep(plain(Math.max(0, x)), step, 'floor'));
  if (dir === 'down' || Math.abs(lo - x) <= Number(step) * 1e-9) return lo;
  return Number(plain(lo + Number(step)));
}

/** The band edge on the tick: never past ref x (1 +- slip). */
export function sweepBand(side: 'buy' | 'sell', ref: number, slippageBps: number, tickSize: string): number {
  const raw = side === 'buy' ? ref * (1 + slippageBps / 10_000) : ref * (1 - slippageBps / 10_000);
  return toGrid(raw, tickSize, side === 'buy' ? 'down' : 'up');
}

export interface SweepState {
  side: 'buy' | 'sell';
  total: number;
  filled: number;
  /** What may still fill from children already out (sending, open, unknown). */
  pending: number;
  startedAt: number;
  now: number;
  timeoutMs: number | null;
  roundMs: number;
  /** When the last round went out (null: none yet). */
  lastRoundAt: number | null;
  slippageBps: number;
  tickSize: string;
  stepSize: string;
  /** SoDEX's minimum order at a price, base units. */
  minQty: (price: number) => number;
  ref: SweepReference | null;
}

export type SweepAction =
  | { type: 'done' }
  | { type: 'expired'; left: number }
  | { type: 'wait'; reason: string | null }
  | { type: 'send'; price: number; qty: number };

const floorTo = (x: number, step: string): number => toGrid(x, step, 'down');

/** What to do this tick. */
export function sweepStep(s: SweepState): SweepAction {
  const left = floorTo(s.total - s.filled, s.stepSize);
  // Something already out: wait for SoDEX to settle it (an IOC lives for one match).
  if (s.pending > 1e-12) return { type: 'wait', reason: null };
  if (left <= 0 || (s.ref && left < s.minQty(s.ref.price) && s.filled > 0)) return { type: 'done' };
  if (s.timeoutMs !== null && s.now - s.startedAt >= s.timeoutMs) return { type: 'expired', left };
  if (!s.ref) return { type: 'wait', reason: 'Paused: no fresh reference price (Binance futures, Binance spot or the SoDEX mark).' };
  if (s.lastRoundAt !== null && s.now - s.lastRoundAt < s.roundMs) return { type: 'wait', reason: null };
  const price = sweepBand(s.side, s.ref.price, s.slippageBps, s.tickSize);
  if (!(price > 0)) return { type: 'wait', reason: 'Paused: the band price is not valid.' };
  if (left < s.minQty(price)) return s.filled > 0 ? { type: 'done' } : { type: 'expired', left };
  return { type: 'send', price, qty: left };
}

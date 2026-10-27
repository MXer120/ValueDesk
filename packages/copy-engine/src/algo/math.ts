/**
 * The arithmetic of algo orders, pure: schedules, curves, volume profiles,
 * ladders, prices. The order ticket's preview and the running engine call the
 * same functions with the same seed, so what the preview draws is what runs.
 */
import { roundToStep } from '../../../sodex-core/src/index.ts';
import { limitPrice as takerLimit } from '../markets.ts';
import type { MarketInfo } from '../types.ts';
import type { ExecSpec, ScaleDistribution, Side } from './types.ts';

export const DAY_MS = 86_400_000;

/* ---------------------------------------------------------------- random ----- */

/** mulberry32: a small seeded generator, so a schedule can be re-derived after a restart. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fresh 32-bit seed. */
export const newSeed = (): number => Math.floor(Math.random() * 0xffffffff) >>> 0;

/** A value moved up to `share` either way: v x (1 + u x share), u uniform in [-1, 1]. */
export const jitter = (v: number, share: number, rand: () => number): number => (share > 0 ? v * (1 + (rand() * 2 - 1) * share) : v);

/* ------------------------------------------------------------- weights ----- */

export function normalise(w: readonly number[]): number[] {
  const pos = w.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  const sum = pos.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return w.map(() => 1 / Math.max(1, w.length));
  return pos.map((x) => x / sum);
}

/**
 * Slice weights along an urgency curve: 0 is even; 1 puts e^3 (about 20x) as
 * much in the first slice as in the last; -1 the reverse. Each weight is then
 * jittered by up to `sizeJitter` either way and the set normalised, so the
 * total never changes.
 */
export function curveWeights(n: number, urgency: number, sizeJitter: number, rand: () => number): number[] {
  const k = Math.max(-1, Math.min(1, urgency)) * 3;
  const w: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = n <= 1 ? 0 : i / (n - 1);
    w.push(jitter(Math.exp(-k * x), sizeJitter, rand));
  }
  return normalise(w);
}

/**
 * When each slice is due: evenly over the duration, the first at the start,
 * each later one moved up to `timeJitter` of the interval either way, kept in
 * order and inside the window.
 */
export function sliceTimes(start: number, durationMs: number, n: number, timeJitter: number, rand: () => number): number[] {
  const step = durationMs / n;
  const out: number[] = [];
  let prev = start - 1;
  for (let i = 0; i < n; i++) {
    let t = start + i * step;
    if (i > 0 && timeJitter > 0) t += (rand() * 2 - 1) * timeJitter * step;
    t = Math.max(prev + 1, Math.min(start + durationMs - 1, t));
    out.push(Math.round(t));
    prev = t;
  }
  return out;
}

/** The share of the total due by `now`: the weights of every slice whose time has come. */
export function dueShare(times: readonly number[], weights: readonly number[], now: number): number {
  let s = 0;
  for (let i = 0; i < times.length; i++) if (times[i]! <= now) s += weights[i] ?? 0;
  return Math.min(1, s);
}

/** Index of the next slice not yet due, or -1. */
export function nextSlice(times: readonly number[], now: number): number {
  for (let i = 0; i < times.length; i++) if (times[i]! > now) return i;
  return -1;
}

/**
 * Split `total` (in steps of `step`) by `weights`, in whole steps: every unit
 * is placed (largest remainders first), so the parts add up to the total
 * exactly and no part is a fraction of a step.
 */
export function allocateSteps(total: number, weights: readonly number[], step: number): number[] {
  const units = Math.floor(total / step + 1e-9);
  const w = normalise(weights);
  const raw = w.map((x) => x * units);
  const out = raw.map((x) => Math.floor(x + 1e-9));
  let left = units - out.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => ({ i, f: x - Math.floor(x + 1e-9) })).sort((a, b) => b.f - a.f || a.i - b.i);
  for (let j = 0; left > 0 && order.length; j = (j + 1) % order.length, left--) out[order[j]!.i]! += 1;
  return out.map((u) => u * step);
}

/* --------------------------------------------------------------- VWAP ----- */

export interface Candle {
  /** Open time, ms. */
  t: number;
  /** Volume, base units. */
  v: number;
}

export const isWeekend = (t: number): boolean => {
  const d = new Date(t).getUTCDay();
  return d === 0 || d === 6;
};

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export interface VolumeProfile {
  /** Share of the window's volume per slice (sum 1). */
  weights: number[];
  /** Volume the profile expects per slice, base units (for the adaptive mode). */
  expected: number[];
  /** Days that had data. */
  days: number;
}

/**
 * The market's own rhythm over the window [start, start + duration): for each
 * slice, the volume traded in the same UTC time slot on each of the past
 * `lookbackDays` days (weekdays matched with weekdays and weekends with
 * weekends once there are two weeks to choose from), the MEDIAN of those, and
 * a floor of a tenth of the average slot so a quiet hour still trades.
 */
export function volumeProfile(candles: readonly Candle[], candleMs: number, start: number, durationMs: number, slices: number, lookbackDays: number): VolumeProfile {
  const byBucket = new Map<number, number>();
  for (const c of candles) if (Number.isFinite(c.v) && c.v >= 0) byBucket.set(Math.floor(c.t / candleMs) * candleMs, c.v);
  const volIn = (a: number, b: number): number | null => {
    let sum = 0;
    let seen = false;
    for (let t = Math.floor(a / candleMs) * candleMs; t < b; t += candleMs) {
      const v = byBucket.get(t);
      if (v === undefined) continue;
      seen = true;
      const lo = Math.max(a, t);
      const hi = Math.min(b, t + candleMs);
      if (hi > lo) sum += (v * (hi - lo)) / candleMs;
    }
    return seen ? sum : null;
  };
  const step = durationMs / slices;
  const matchDays = lookbackDays >= 14;
  const expected: number[] = [];
  const daysSeen = new Set<number>();
  for (let i = 0; i < slices; i++) {
    const a = start + i * step;
    const b = a + step;
    const same: number[] = [];
    const all: number[] = [];
    for (let d = 1; d <= lookbackDays; d++) {
      const v = volIn(a - d * DAY_MS, b - d * DAY_MS);
      if (v === null) continue;
      daysSeen.add(d);
      all.push(v);
      if (!matchDays || isWeekend(a - d * DAY_MS) === isWeekend(a)) same.push(v);
    }
    expected.push(median(same.length >= 3 ? same : all));
  }
  const mean = expected.reduce((x, y) => x + y, 0) / Math.max(1, expected.length);
  const floored = expected.map((v) => Math.max(v, mean / 10));
  return { weights: normalise(floored), expected: floored, days: daysSeen.size };
}

/** The candle interval and lookback a VWAP profile is built from (SoDEX serves at most 1,000 candles a read). */
export function profileCandles(lookbackDays: number): { interval: '15m' | '30m'; ms: number } {
  return lookbackDays > 28 ? { interval: '30m', ms: 30 * 60_000 } : { interval: '15m', ms: 15 * 60_000 };
}

/**
 * Adaptive VWAP: the share due by now, from the profile's own schedule
 * blended half and half with what the market has actually traded against
 * what the profile expected for the whole window, held between half and
 * twice the schedule, and all of it by the end.
 */
export function adaptiveShare(staticShare: number, marketSoFar: number, expectedTotal: number): number {
  if (!(expectedTotal > 0) || staticShare >= 1) return Math.min(1, staticShare);
  const live = marketSoFar / expectedTotal;
  const blend = 0.5 * staticShare + 0.5 * live;
  return Math.min(1, Math.max(staticShare * 0.5, Math.min(staticShare * 2, blend)));
}

/* -------------------------------------------------------------- ladders ----- */

/** Size weights of a ladder from its first order (x = 0) to its last (x = 1). */
export function ladderWeights(n: number, distribution: ScaleDistribution, skew: number, sizeJitter: number, rand: () => number): number[] {
  const w: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = n <= 1 ? 0 : i / (n - 1);
    let v = 1;
    if (distribution === 'linear') v = 1 + (skew - 1) * x;
    else if (distribution === 'exponential') v = Math.pow(skew, x);
    else if (distribution === 'bell') v = Math.exp(-0.5 * Math.pow((x - 0.5) / 0.22, 2));
    w.push(jitter(Math.max(v, 1e-6), sizeJitter, rand));
  }
  return normalise(w);
}

/** The ladder's prices, first to last, snapped to the tick (duplicates on a coarse tick are dropped). */
export function ladderPrices(from: number, to: number, n: number, spacing: 'linear' | 'geometric' | 'front' | 'back', tickSize: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = n <= 1 ? 0 : i / (n - 1);
    let p: number;
    if (spacing === 'geometric' && from > 0 && to > 0) p = from * Math.pow(to / from, x);
    else {
      const f = spacing === 'front' ? x * x : spacing === 'back' ? 1 - (1 - x) * (1 - x) : x;
      p = from + (to - from) * f;
    }
    const s = snapNearest(p, tickSize);
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/* --------------------------------------------------------------- prices ----- */

const dec = (n: number): string => {
  const s = Number(n.toPrecision(12)).toString();
  if (!/e/i.test(s)) return s;
  return Number(n.toPrecision(12)).toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
};

export function snapNearest(p: number, tickSize: string): number {
  return Number(roundToStep(dec(Math.max(p, 0)), tickSize, 'nearest'));
}

export function snapDown(p: number, tickSize: string): number {
  return Number(roundToStep(dec(Math.max(p, 0)), tickSize, 'floor'));
}

export function snapUp(p: number, tickSize: string): number {
  const down = snapDown(p, tickSize);
  const tick = Number(tickSize);
  return down + 1e-12 < p ? Number(roundToStep(dec(down + tick), tickSize, 'nearest')) : down;
}

export interface Quote {
  bid: number;
  ask: number;
  at: number;
}

export const mid = (q: Quote): number => (q.bid + q.ask) / 2;
export const spreadBps = (q: Quote): number => ((q.ask - q.bid) / mid(q)) * 10_000;

/**
 * Where a resting (post-only) child goes: behind the best price on its own
 * side by `offsetTicks` (or `offsetBps`), never at or through the other side,
 * and never past the algo's limit price. A negative offset steps inside the
 * spread where there is room.
 */
export function makerPrice(side: Side, q: Quote, offsetTicks: number, offsetBps: number | null, m: Pick<MarketInfo, 'tickSize'>, limit: number | null): number {
  const tick = Number(m.tickSize);
  let p: number;
  if (side === 'buy') {
    p = offsetBps !== null ? q.bid * (1 - offsetBps / 10_000) : q.bid - offsetTicks * tick;
    p = Math.min(p, q.ask - tick);
    if (limit !== null) p = Math.min(p, limit);
    return snapDown(p, m.tickSize);
  }
  p = offsetBps !== null ? q.ask * (1 + offsetBps / 10_000) : q.ask + offsetTicks * tick;
  p = Math.max(p, q.bid + tick);
  if (limit !== null) p = Math.max(p, limit);
  return snapUp(p, m.tickSize);
}

/**
 * A taker child's limit: the touch moved by `slippageBps` against the trader,
 * inside SoDEX's band around the mark, and never past the algo's limit price.
 * Returns null when the limit price leaves nothing to take (a buy limit under
 * the ask): there is nothing to send.
 */
export function takerPrice(side: Side, q: Quote, slippageBps: number, m: MarketInfo, mark: number | null, limit: number | null, from: number | null = null): number | null {
  const touch = side === 'buy' ? q.ask : q.bid;
  // The slippage is measured from `from` (a mid, mark, index or oracle price) when given, else from the touch.
  let p = Number(takerLimit(side, from !== null && from > 0 ? from : touch, slippageBps, m, mark));
  if (limit !== null) {
    if (side === 'buy' && limit < touch) return null;
    if (side === 'sell' && limit > touch) return null;
    p = side === 'buy' ? Math.min(p, snapDown(limit, m.tickSize)) : Math.max(p, snapUp(limit, m.tickSize));
  }
  return p;
}

/** Whether a price is on the trader's side of a limit (a buy at or under it, a sell at or over it). */
export const withinLimit = (side: Side, price: number, limit: number | null): boolean =>
  limit === null || (side === 'buy' ? price <= limit : price >= limit);

/* ------------------------------------------------------------- sizing ----- */

/**
 * The smallest child SoDEX accepts at `price`: one step, the market minimum
 * quantity, and the minimum order value - whichever is largest.
 */
export function minChildQty(m: MarketInfo, price: number): number {
  const step = Number(m.stepSize);
  const minQ = Math.max(step, Number(m.minQuantity) || 0);
  const byValue = price > 0 ? Math.ceil(m.minNotional / price / step - 1e-9) * step : minQ;
  return Math.max(minQ, byValue);
}

/**
 * The largest child SoDEX accepts at `price`: its maximum quantity and its
 * maximum order value, floored to the step. Infinity where it sets neither.
 */
export function maxOrderQty(m: MarketInfo, price: number): number {
  const step = Number(m.stepSize);
  const byQty = Number(m.maxQuantity) > 0 ? Number(m.maxQuantity) : Infinity;
  const byValue = m.maxNotional && price > 0 ? m.maxNotional / price : Infinity;
  const most = Math.min(byQty, byValue);
  return Number.isFinite(most) ? Math.floor(most / step + 1e-9) * step : Infinity;
}

/** Floor to the step, as a number. */
export const floorStep = (q: number, m: Pick<MarketInfo, 'stepSize'>): number => {
  const step = Number(m.stepSize);
  return Math.floor(q / step + 1e-9) * step;
};

/** A default execution: hybrid, 30 bp cap, join the best price, re-price after 2 ticks, rest for 60% of each slice. */
export const DEFAULT_EXEC: ExecSpec = { style: 'hybrid', slippageBps: 30, offsetTicks: 0, chaseTicks: 2, makerShare: 0.6 };

/* ------------------------------------------------------------- trailing ----- */

export interface TrailState {
  /** Trailing has started (the activation price was reached, or there was none). */
  armed: boolean;
  /** The best price since it armed: the high for a sell stop, the low for a buy stop. */
  extreme: number | null;
}

/**
 * Move a trailing stop with a new price. A SELL stop (protects a long) trails
 * the high and fires at high - distance; a BUY stop (protects a short, or
 * buys the bounce) trails the low and fires at low + distance.
 */
export function trail(
  s: TrailState,
  side: Side,
  price: number,
  o: { trailPct: number | null; trailAbs: number | null; activationPrice: number | null },
): { state: TrailState; stop: number | null; fired: boolean } {
  let { armed, extreme } = s;
  if (!armed) {
    const a = o.activationPrice;
    armed = a === null || (side === 'sell' ? price >= a : price <= a);
    if (armed) extreme = price;
  }
  if (!armed) return { state: { armed, extreme }, stop: null, fired: false };
  extreme = extreme === null ? price : side === 'sell' ? Math.max(extreme, price) : Math.min(extreme, price);
  const dist = o.trailAbs !== null ? o.trailAbs : extreme * (o.trailPct ?? 0);
  const stop = side === 'sell' ? extreme - dist : extreme + dist;
  const fired = side === 'sell' ? price <= stop : price >= stop;
  return { state: { armed, extreme }, stop, fired };
}

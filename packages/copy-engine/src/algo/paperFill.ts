/**
 * How a practice (paper) bot's resting order fills, measured on our own real orders (2026-11-24: tens of thousands of
 * live maker orders of the test wallet against the recorded public tape and Binance futures). Two ways, per market:
 *
 *   QUEUE   A print at the order's price by anyone but the informed taker reaches it only once the queue ahead is gone.
 *           Real orders: under ~1 s of rest almost never, then more and more often (the big maker re-posts behind them).
 *           `age` is that share by rest time; each order draws once, so its place never un-happens.
 *   TAKEN   The informed taker takes quotes by how far they stand past the fair price (the Binance mid times a slow
 *           SoDEX / Binance basis) and how far Binance just moved against them. `rate` is takes per second of rest at
 *           each gap and move (bp; positive = past fair, against the order), `ramp` its share while the order is young.
 *
 * Orders land, and cancels take effect, after a delay drawn from `lat` (measured send -> answer). A market without a
 * curve keeps the older rule (only a print through the price fills): nothing was measured there.
 */
import { PAPER_CURVES } from './paperCurves.ts';

export interface FillCurve {
  /** Half-life of the SoDEX / Binance basis, ms. */
  basisMs: number;
  /** Gap edges (bp), the move's window (ms) and edges (bp), and the take rate per second: rate[gap bucket][move bucket]. */
  gap: number[];
  moveMs: number;
  move: number[];
  rate: number[][];
  /** Rest-time edges (ms) and the share of `rate` that holds from each. */
  rampMs: number[];
  ramp: number[];
  /** Rest-time edges (ms) and the chance that a print at the price reaches the order from each. */
  ageMs: number[];
  age: number[];
  /** Quantiles of the order's send -> answer time, ms. */
  lat: number[];
}

export const paperCurve = (symbol: string): FillCurve | null => PAPER_CURVES[symbol] ?? null;

/** The last bucket whose edge is not above x (0 under the first). */
function at(edges: readonly number[], x: number): number {
  let i = 0;
  while (i + 1 < edges.length && edges[i + 1]! <= x) i++;
  return i;
}

/** The chance that the queue ahead is gone after `ageMs` of rest. */
export const queueChance = (c: FillCurve, ageMs: number): number => c.age[at(c.ageMs, Math.max(0, ageMs))] ?? 0;

const bucket = (edges: readonly number[], x: number): number => {
  let k = 0;
  while (k < edges.length && edges[k]! <= x) k++;
  return k;
};

/** Takes per second at `gap` bp past fair, Binance having moved `against` bp against the order, `ageMs` after landing. */
export function takeRate(c: FillCurve, gap: number, against: number, ageMs: number): number {
  return (c.rate[bucket(c.gap, gap)]?.[bucket(c.move, against)] ?? 0) * (c.ramp[at(c.rampMs, Math.max(0, ageMs))] ?? 1);
}

/** How far an order stands past fair, bp (positive: worse than fair for its owner). */
export const gapBps = (side: 'buy' | 'sell', price: number, fair: number): number => ((side === 'buy' ? price - fair : fair - price) / fair) * 10_000;

export const drawLatency = (c: FillCurve, u: number): number => c.lat[Math.min(c.lat.length - 1, Math.floor(u * c.lat.length))] ?? 0;

/** The SoDEX / Binance basis, from prints (half-life `hl`). */
export class PrintBasis {
  private r: number | null = null;
  private t = 0;
  update(px: number, refMid: number, now: number, hl: number): void {
    const q = px / refMid;
    if (!Number.isFinite(q) || q <= 0) return;
    this.r = this.r === null ? q : this.r + (q - this.r) * (1 - 0.5 ** (Math.max(0, now - this.t) / hl));
    this.t = now;
  }
  fair(refMid: number): number | null {
    return this.r === null ? null : refMid * this.r;
  }
}

/**
 * The weighted DCA curve's tools (DcaCurve.tsx): the average price if every order fills, a
 * Smooth that cleans the user's points, and a fit to an average price the user wants.
 */
import { CURVE_MAX, CURVE_MIN, cleanCurve, curveAt, type CurvePoint } from './draft';

/** Where order i of n sits on the curve (0..1). */
export const levelX = (i: number, n: number): number => (n > 1 ? i / (n - 1) : 0);

/**
 * The average fill price if all the orders fill: coin-weighted. Each order is `each` x its curve
 * size, in USD (`coin` false: the coin bought is that over its price) or in the coin.
 */
export function ladderAvg(points: readonly CurvePoint[], prices: readonly number[], coin: boolean): number | null {
  const n = prices.length;
  let qty = 0;
  let usd = 0;
  for (let i = 0; i < n; i++) {
    const p = prices[i]!;
    if (!(p > 0)) return null;
    const w = curveAt(points, levelX(i, n));
    const q = coin ? w : w / p;
    qty += q;
    usd += q * p;
  }
  return qty > 0 ? usd / qty : null;
}

/** The curve's sizes summed over the orders (what the total spends, in units of Each buy). */
const totalOf = (points: readonly CurvePoint[], n: number, raw = false): number => {
  let s = 0;
  for (let i = 0; i < n; i++) s += curveAt(points, levelX(i, n), raw);
  return s;
};

/** A size on a clean step: quarters from 1x up, twentieths below. */
const clean = (y: number): number => {
  const step = y >= 1 ? 0.25 : 0.05;
  return Math.min(CURVE_MAX, Math.max(CURVE_MIN, Math.round(y / step) * step));
};

/**
 * Smooth: the points as the shape they were meant to be.
 *   - each middle point moves onto the order nearest it, so a bend is at an order, not between two;
 *   - sizes go to clean steps (1.25x, not 1.23x);
 *   - neighbours within 10 % of each other were meant to be level: they become one flat run;
 *   - a point that adds nothing (inside a flat run, or on the straight line between its
 *     neighbours) goes.
 */
export function smoothCurve(points: readonly CurvePoint[], orders: number): CurvePoint[] {
  const n = Math.max(1, Math.trunc(orders) || 1);
  const snapX = (x: number) => (n >= 3 ? Math.round(x * (n - 1)) / (n - 1) : x);
  // Onto orders; two landing on one order become their average.
  const byX = new Map<number, number[]>();
  // A point already on its neighbours' line goes first, before snapping could move it off.
  for (const [x, y] of dropIdle(cleanCurve(points))) {
    const k = Number(snapX(x).toFixed(6));
    byX.set(k, [...(byX.get(k) ?? []), y]);
  }
  let pts: CurvePoint[] = [...byX.entries()].sort((a, b) => a[0] - b[0]).map(([x, ys]) => [x, ys.reduce((a, b) => a + b, 0) / ys.length]);
  // Near-level neighbours as one flat run, at the run's average.
  const runs: CurvePoint[][] = [];
  for (const q of pts) {
    const run = runs[runs.length - 1];
    const ref = run ? run.reduce((a, r) => a + r[1], 0) / run.length : 0;
    if (run && Math.abs(q[1] - ref) <= 0.1 * Math.max(q[1], ref)) run.push(q);
    else runs.push([q]);
  }
  pts = runs.flatMap((run) => {
    const y = clean(run.reduce((a, r) => a + r[1], 0) / run.length);
    return run.map(([x]) => [x, y] as CurvePoint);
  });
  pts = dropIdle(pts);
  return cleanCurve(pts.map(([x, y]) => [Number(x.toFixed(4)), Number(y.toFixed(2))]));
}

/** What adds nothing goes: the inside of a flat run, a point on its neighbours' line. */
function dropIdle(points: CurvePoint[]): CurvePoint[] {
  const pts = [...points];
  for (let i = 1; i < pts.length - 1; ) {
    const [x0, y0] = pts[i - 1]!;
    const [x1, y1] = pts[i]!;
    const [x2, y2] = pts[i + 1]!;
    if (Math.abs(y1 - (y0 + ((y2 - y0) * (x1 - x0)) / (x2 - x0))) < 0.06) pts.splice(i, 1);
    else i++;
  }
  return pts;
}

/**
 * The curve fitted to an average fill price, keeping its shape and what it spends. Its points
 * are tilted by e^(k x) (more size toward one end, every bend kept) and scaled back to the same
 * total; k is found by bisection on the average as it comes out (the curve's limits included).
 * Null when no tilt reaches it: the reach is about the first and last order's prices.
 */
export function fitAvg(points: readonly CurvePoint[], prices: readonly number[], coin: boolean, target: number): CurvePoint[] | null {
  const n = prices.length;
  if (n < 2 || !(target > 0)) return null;
  const shaped = (k: number) => fitShape(points, n, k);
  const avgAt = (k: number) => ladderAvg(shaped(k), prices, coin) ?? Number.NaN;
  // The average moves toward the last order's price as k grows.
  let lo = -12;
  let hi = 12;
  const aLo = avgAt(lo);
  const aHi = avgAt(hi);
  const between = (a: number, b: number) => (target - a) * (target - b) <= 0;
  if (!between(aLo, aHi)) return null;
  for (let it = 0; it < 60; it++) {
    const mid = (lo + hi) / 2;
    if (between(avgAt(lo), avgAt(mid))) hi = mid;
    else lo = mid;
  }
  const out = shaped((lo + hi) / 2);
  const got = ladderAvg(out, prices, coin);
  return got !== null && Math.abs(got - target) / target < 0.002 ? out : null;
}

/** The averages a fit can reach: [low, high]. */
export function avgReach(points: readonly CurvePoint[], prices: readonly number[], coin: boolean): [number, number] | null {
  if (prices.length < 2) return null;
  const a = ladderAvg(fitShape(points, prices.length, -12), prices, coin);
  const b = ladderAvg(fitShape(points, prices.length, 12), prices, coin);
  return a !== null && b !== null ? [Math.min(a, b), Math.max(a, b)] : null;
}

/** The points tilted by e^(k x), scaled back to the curve's total (then held to its limits). */
function fitShape(points: readonly CurvePoint[], n: number, k: number): CurvePoint[] {
  const total = totalOf(points, n);
  const tilted = points.map(([x, y]) => [x, y * Math.exp(k * x)] as CurvePoint);
  const t = totalOf(tilted, n, true);
  return cleanCurve(tilted.map(([x, y]) => [x, Number(((y * total) / (t || 1)).toFixed(4))]));
}

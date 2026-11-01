/**
 * The liquidation heatmap's resolution, per coin (owner 2026-10-31: "are we able via settings to
 * make the map more accurate? E.g. instead 200usd ranges on btc 100 per default. And via settings
 * down to $1 (min tick on sodex) if the user wants? and of course for all coins").
 *
 * A coin's steps are relative to its price, named in its own units: the default is the step the
 * history keeps (server levels.ts HIST_STEP, 0.125%: BTC near $80K $100), then a tenth of it, a
 * hundredth, and the coin's tick on SoDEX last (BTC $1). "Auto" is the grouping from before
 * (Fine / Medium / Coarse, liqMap.ts groupFor). The choice is kept as a level (0 the default, 1 a
 * tenth...), so it means the same on a coin it was not made on.
 *
 * Where the step comes from: a whole number of the live engine's 0.02% buckets is the stream,
 * summed; anything finer (or between) is the API's fine route, exact from the books for the
 * window on screen (server liqRead.ts liqHeatmapFine), at most FINE_MAX_BUCKETS of them - zoomed
 * out past that, the step is coarsened for the view (fineWindow) and the widget says so.
 */
import { niceStep } from '@sign/valuedesk/liquidations/math.js';
import { FINE_MAX_BUCKETS, HIST_STEP } from '@sign/valuedesk/liquidations/levels.js';
import type { Symbol } from '../api';
import { coinOfSymbol } from './liqMap';

export { FINE_MAX_BUCKETS };

/** 'auto' (Fine / Medium / Coarse) or a place on the coin's ladder: 0 the default. */
export type StepLevel = 'auto' | number;

/** Fixed steps below the default, before the tick (the View's row stays five choices wide). */
const DECADES = 2;
const EPS = 1e-9;
const tidy = (x: number) => +x.toPrecision(12);

/**
 * A coin's tick on SoDEX: its perps market's `tickSize`. A coin SoDEX does not list (the index
 * has every venue's coins) gets a hundred-thousandth of its price, about BTC's $1.
 */
export function tickOf(coin: string, symbols: readonly Pick<Symbol, 'name' | 'tickSize'>[], price: number): number {
  const s = symbols.find((x) => coinOfSymbol(x.name) === coin);
  const t = Number(s?.tickSize);
  return t > 0 && Number.isFinite(t) ? t : niceStep(price * 1e-5);
}

/** The coin's fixed steps, coarsest first: the default (HIST_STEP of the price), a tenth, a hundredth, the tick. */
export function stepLadder(price: number, tick: number): number[] {
  if (!(price > 0)) return [];
  const t = tick > 0 ? tick : niceStep(price * 1e-5);
  const out = [tidy(Math.max(t, niceStep(price * HIST_STEP)))];
  for (let s = out[0]! / 10; out.length <= DECADES && s >= t * (1 - EPS); s /= 10) out.push(tidy(s));
  if (t < out.at(-1)! * (1 - EPS)) out.push(tidy(t));
  return out;
}

/** The step a level picks on a ladder (null: Auto); a level past the coin's finest is its finest. */
export function stepAt(level: StepLevel, ladder: readonly number[]): number | null {
  if (level === 'auto' || !ladder.length) return null;
  return ladder[Math.max(0, Math.min(ladder.length - 1, Math.floor(level)))]!;
}

/** A step in the coin's price units: "$100", "$2.5", "$0.0001". */
export function stepLabel(step: number): string {
  if (step >= 1) return `$${step.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  // Plain decimals, never 1e-7: as many places as the step has.
  const places = Math.min(12, Math.max(0, -Math.floor(Math.log10(step)) + 2));
  return `$${step.toFixed(places).replace(/0+$/, '').replace(/\.$/, '')}`;
}

/** The smallest of 1, 2, 2.5, 5 x 10^n at or above `x`. */
export function niceUp(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) return 1;
  const e = 10 ** Math.floor(Math.log10(x));
  for (const k of [1, 2, 2.5, 5, 10]) if (k * e >= x * (1 - EPS)) return tidy(k * e);
  return tidy(10 * e);
}

/** Server buckets per bar when `step` is a whole number of the engine's (`base`), else null (the fine route). */
export function streamGroup(step: number, base: number): number | null {
  if (!(base > 0) || step < base * (1 - EPS)) return null;
  const k = Math.round(step / base);
  return Math.abs(step / base - k) < 1e-6 * k ? k : null;
}

/** Widths the stream sums to (server routes/liqWs.ts MULTIPLES). */
const STREAM_K = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
/** What to ask the stream for a bar of `k` buckets: the widest width it sums to that divides `k` (the rest is summed here). */
export function streamAsk(k: number): number {
  let best = 1;
  for (const m of STREAM_K) if (m <= k && k % m === 0) best = m;
  return best;
}

/**
 * What to ask the fine route for the price window on screen, [lo, hi], at `step`: the window and
 * half of it either side (room to pan before the next read), its edges on a grid of a quarter of
 * it so viewers of the same coin share answers at the edge (perf.ts), and never more than `cap`
 * buckets - zoomed out past that, the step is the round width that fits (the view says so).
 */
export function fineWindow(lo: number, hi: number, step: number, cap = FINE_MAX_BUCKETS): { step: number; from: number; to: number } {
  const span = Math.max(hi - lo, step);
  const g = niceUp(span / 4);
  const st = Math.max(step, niceUp((span * 2 + 2 * g) / cap));
  let from = Math.max(0, Math.floor((lo - span / 2) / g) * g);
  let to = Math.ceil((hi + span / 2) / g) * g;
  from = Math.floor(from / st + EPS) * st;
  to = Math.ceil(to / st - EPS) * st;
  if ((to - from) / st > cap) to = from + cap * st;
  return { step: tidy(st), from: tidy(from), to: tidy(to) };
}

/** Multiples of the fine layer's cell (BTC $1) Auto may draw below the stream's own buckets. */
const FINE_K = [1, 2, 5, 10, 20, 50, 100, 200, 500];

/**
 * The widths the live data holds, finest first: the stream's (its bucket times STREAM_K) and, when the
 * window is within the fine layer's reach, the fine layer's below them (`fine`: its cell; BTC $1).
 */
export function streamSteps(base: number, fine: number | null): number[] {
  const out = STREAM_K.map((k) => tidy(base * k));
  if (fine && fine > 0) for (const k of FINE_K) { const s = tidy(fine * k); if (s < base * (1 - EPS)) out.push(s); }
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * Auto's step (owner 2026-11-01: "auto is bad as its just the 100 steps no matter what"): the finest
 * of `steps` at least `target` wide (the price a cell should span on screen), else the coarsest.
 */
export function autoStep(target: number, steps: readonly number[]): number | null {
  const s = [...steps].filter((x) => x > 0).sort((a, b) => a - b);
  if (!s.length) return null;
  return s.find((x) => x >= target * (1 - EPS)) ?? s.at(-1)!;
}

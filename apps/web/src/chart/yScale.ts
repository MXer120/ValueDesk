/**
 * The price axis: the footer's % A L toggles, and the fit that moves the axis
 * in the same motion as the view (viewTween.ts).
 *
 * THE TOGGLES (scaleReducer). `%` and `L` pick the scale - percentage,
 * logarithmic, or neither (linear) - and exclude each other. `A` is autoscale:
 * klinecharts' own auto-fit, which sizes the axis to the candles on screen
 * every time the view moves. It is on by default and goes off by itself when
 * the user takes the axis: dragging or scrolling on the price axis, or
 * dragging the plot vertically (TradingView's rule). Off, the axis holds its
 * range while the chart pans sideways, and a vertical drag pans it. Only the
 * user switches A: changing the scale type (klinecharts rebuilds the axis, and
 * the old range means nothing on the new scale) refits it, and with A off the
 * fresh fit is then held; the double-click reset eases the axis to the fitted
 * view and, with A off, holds it there. Neither changes A, L or %.
 *
 * THE FIT (PriceFit). klinecharts decides the axis range in YAxisImp's
 * createRangeImp: the candles' extent over the visible bars, handed to the
 * axis' `createRange` hook, then widened by a 20% top / 10% bottom gap. That
 * extent is recomputed on every layout, so during a zoom or a scroll the
 * scale jumps whenever a new high or low enters or leaves the window - which
 * is what made the double-click reset read as steps. PriceFit wraps the hook:
 * normally it is a pass-through (plain auto-fit), but while a move runs it
 * answers the eased blend, in the scale's own space (log10 on the log axis),
 * between the span the axis showed when the move started - automatic or one
 * the user dragged - and the span the DESTINATION view fits. The last frame
 * of the move is the pass-through, which is that same destination fit, so
 * handing back to auto-fit is not a step. A timeframe or market switch primes
 * the span the axis was showing before the bars were replaced (`prime`), and
 * the next move glides from that span instead of from the new series' fit,
 * which is already on the axis by the time the move can start.
 *
 * klinecharts' internals it leans on, all present in 10.0.2 and each guarded:
 * the axis' `_autoCalcTickFlag` (get/setAutoCalcTickFlag: true = auto-fit,
 * false = a range the user set) and `setRange`, the same call its own axis
 * drag makes.
 *
 * The maths is pure and unit-tested (yScale.test.ts).
 */
import type { AxisCreateRangeCallback, AxisRange, Chart as KChart, KLineData, YAxis } from 'klinecharts';
import { CANDLE_PANE_ID } from './theme';
import type { View, YMotion } from './viewTween';

// --- the footer's toggles ----------------------------------------------------

/** klinecharts y-axis names (theme.ts replaces the built-in 'logarithm'). */
export type ScaleMode = 'normal' | 'logarithm' | 'percentage';

export interface ScaleState {
  mode: ScaleMode;
  /** A: the axis fits the visible candles. */
  auto: boolean;
}

export type ScaleAction =
  /** L clicked. */
  | { type: 'log' }
  /** % clicked. */
  | { type: 'percent' }
  /** A clicked. */
  | { type: 'auto' }
  /** The user took the axis (dragged or scrolled it, or dragged the plot vertically). */
  | { type: 'manual' }
  /** Something refitted it: the double-click reset, a new market, klinecharts' own axis double-click. */
  | { type: 'fit' };

export const INITIAL_SCALE: ScaleState = { mode: 'normal', auto: true };

export function scaleReducer(s: ScaleState, a: ScaleAction): ScaleState {
  switch (a.type) {
    // The scale type never touches A (owner's rule): with A off, Chart.tsx
    // pins the rebuilt axis on its fresh fit, so it stays off and on screen.
    case 'log':
      return { mode: s.mode === 'logarithm' ? 'normal' : 'logarithm', auto: s.auto };
    case 'percent':
      return { mode: s.mode === 'percentage' ? 'normal' : 'percentage', auto: s.auto };
    case 'auto':
      return { ...s, auto: !s.auto };
    case 'manual':
      return s.auto ? { ...s, auto: false } : s;
    case 'fit':
      return s.auto ? s : { ...s, auto: true };
  }
}

// --- spans -----------------------------------------------------------------------

/**
 * A price span as the axis' createRange hands it back: the data's extent,
 * BEFORE klinecharts adds its top and bottom gap. Prices on every scale (the
 * percentage axis maps prices to percent of the first visible close, but the
 * pixels are still linear in price).
 */
export interface Span {
  from: number;
  to: number;
}

/** The space the axis is linear in. */
export type ScaleKind = 'linear' | 'log';

export const kindOf = (mode: ScaleMode | string): ScaleKind => (mode === 'logarithm' ? 'log' : 'linear');

const fwd = (v: number, k: ScaleKind): number => (k === 'log' ? Math.log10(v) : v);
const inv = (v: number, k: ScaleKind): number => (k === 'log' ? 10 ** v : v);

/** `a` to `b`, `e` of the way (0..1), linearly in the axis' own space. Exact
 *  at both ends. */
export function lerpSpan(a: Span, b: Span, e: number, kind: ScaleKind): Span {
  if (e <= 0) return { ...a };
  if (e >= 1) return { ...b };
  const l = (x: number, y: number) => inv(fwd(x, kind) + (fwd(y, kind) - fwd(x, kind)) * e, kind);
  return { from: l(a.from, b.from), to: l(a.to, b.to) };
}

export interface GapRates {
  top: number;
  bottom: number;
}

/** klinecharts' gap as fractions of the span (YAxisImp.createRangeImp: a
 *  value of 1 or more is pixels of the pane height). */
export function gapRates(gap: { top?: number; bottom?: number } | undefined, height: number): GapRates {
  const rate = (v: number | undefined, fallback: number) => {
    const x = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
    return x >= 1 && height > 0 ? x / height : x;
  };
  return { top: rate(gap?.top, 0.2), bottom: rate(gap?.bottom, 0.1) };
}

/** createRangeImp's widening: the range the axis shows for a span. */
export function addGap(span: Span, rates: GapRates, kind: ScaleKind): Span {
  const f = fwd(span.from, kind);
  const t = fwd(span.to, kind);
  const r = t - f;
  return { from: inv(f - r * rates.bottom, kind), to: inv(t + r * rates.top, kind) };
}

/** The inverse: the span that gives the range the axis shows. */
export function stripGap(range: Span, rates: GapRates, kind: ScaleKind): Span {
  const f = fwd(range.from, kind);
  const t = fwd(range.to, kind);
  const r = (t - f) / (1 + rates.top + rates.bottom);
  return { from: inv(f + r * rates.bottom, kind), to: inv(t - r * rates.top, kind) };
}

/** A span as klinecharts' createRangeImp builds its `defaultRange`. */
export function rangeOfSpan(s: Span): AxisRange {
  const d = s.to - s.from;
  return { from: s.from, to: s.to, range: d, realFrom: s.from, realTo: s.to, realRange: d, displayFrom: s.from, displayTo: s.to, displayRange: d };
}

// --- what the axis fits ----------------------------------------------------------

/** klinecharts' default `scrollLimitRole` ('bar_count') and its two bars. */
const MIN_VISIBLE_BARS = 2;

/**
 * The bars klinecharts draws for a view: StoreImp._adjustVisibleRange, clamp
 * included, as data indices [from, to) - the range its auto-fit reads.
 */
export function visibleWindow(count: number, barSpace: number, rightBars: number, width: number): { from: number; to: number } {
  if (!(count > 0) || !(barSpace > 0) || !(width > 0)) return { from: 0, to: 0 };
  const visible = width / barSpace;
  const left = Math.min(MIN_VISIBLE_BARS, count);
  const right = Math.min(MIN_VISIBLE_BARS, count);
  let L = Math.min(rightBars, visible - left);
  L = Math.max(L, -count + right);
  let to = Math.round(L + count + 0.5);
  const realTo = to;
  if (to > count) to = count;
  let from = Math.round(to - visible) - 1;
  if (from < 0) from = 0;
  const realFrom = L > 0 ? Math.round(count + L - visible) - 1 : from;
  return { from: Math.max(0, realFrom), to: Math.min(count, realTo) };
}

/** What the candle pane's axis fits, beyond the bars themselves. */
export interface FitSource {
  bars: readonly KLineData[];
  /** 'hl' for candles and bars (high/low); a data key (the line style's
   *  `candle.area.value`, 'close') for the line. */
  value: 'hl' | string;
  /** The candle pane's indicators (MA, BOLL...): their figure values count. */
  indicators?: ReadonlyArray<{
    result: readonly unknown[];
    figures: ReadonlyArray<{ key: string }>;
    minValue?: number | null;
    maxValue?: number | null;
  }>;
}

/**
 * The extent klinecharts' auto-fit finds over bars [from, to): the same
 * values createRangeImp reads, before the gap. Null with nothing to fit.
 */
export function fitSpan(src: FitSource, window: { from: number; to: number }): Span | null {
  let min = Infinity;
  let max = -Infinity;
  let specMin = Infinity;
  let specMax = -Infinity;
  const inds = src.indicators ?? [];
  for (const ind of inds) {
    if (typeof ind.minValue === 'number') specMin = Math.min(specMin, ind.minValue);
    if (typeof ind.maxValue === 'number') specMax = Math.max(specMax, ind.maxValue);
  }
  for (let i = Math.max(0, window.from); i < Math.min(src.bars.length, window.to); i++) {
    const d = src.bars[i];
    if (d) {
      if (src.value === 'hl') {
        if (d.low < min) min = d.low;
        if (d.high > max) max = d.high;
      } else {
        const v = (d as unknown as Record<string, unknown>)[src.value];
        if (typeof v === 'number') {
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
    }
    for (const ind of inds) {
      const row = ind.result[i] as Record<string, unknown> | undefined;
      if (!row) continue;
      for (const f of ind.figures) {
        const v = row[f.key];
        if (typeof v === 'number') {
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
    }
  }
  if (min === Infinity || max === -Infinity) return null;
  return { from: Math.min(specMin, min), to: Math.max(specMax, max) };
}

// --- klinecharts glue ------------------------------------------------------------

/** The candle pane's price axis. */
export const priceAxis = (c: KChart): YAxis | null => c.getYAxes({ paneId: CANDLE_PANE_ID })[0] ?? null;

interface AxisInternals {
  getAutoCalcTickFlag?: () => boolean;
  setAutoCalcTickFlag?: (flag: boolean) => void;
  setRange?: (range: AxisRange) => void;
}
const internals = (a: YAxis): AxisInternals => a as unknown as AxisInternals;

/** Whether klinecharts is fitting the axis to the data. */
export function isAutoFit(axis: YAxis): boolean {
  const get = internals(axis).getAutoCalcTickFlag;
  return typeof get === 'function' ? get.call(axis) !== false : true;
}

/**
 * Let klinecharts fit the axis again. Through the flag when the build has it;
 * otherwise `overrideYAxis`, which resets it (with a heavier layout).
 */
export function resumeAutoFit(c: KChart, axis: YAxis): void {
  const set = internals(axis).setAutoCalcTickFlag;
  if (typeof set === 'function') set.call(axis, true);
  else c.overrideYAxis({ paneId: CANDLE_PANE_ID });
}

/** Pin the axis on `range` (its current one by default): klinecharts stops
 *  fitting it, exactly as after a drag on the axis. False if unsupported. */
export function holdRange(axis: YAxis, range: AxisRange = axis.getRange()): boolean {
  const set = internals(axis).setRange;
  if (typeof set !== 'function') return false;
  set.call(axis, { ...range });
  return true;
}

/**
 * `base` moved by `dy` px of a `height` px pane: the content follows the
 * pointer, so dragging down shows higher prices. In the axis' real space, so
 * the log axis pans evenly too.
 */
export function pannedRange(axis: YAxis, base: AxisRange, dy: number, height: number): AxisRange {
  const shift = height > 0 ? (base.realRange * dy) / height : 0;
  const realFrom = base.realFrom + shift;
  const realTo = base.realTo + shift;
  const from = axis.realValueToValue(realFrom, { range: base });
  const to = axis.realValueToValue(realTo, { range: base });
  const displayFrom = axis.realValueToDisplayValue(realFrom, { range: base });
  const displayTo = axis.realValueToDisplayValue(realTo, { range: base });
  return { from, to, range: to - from, realFrom, realTo, realRange: realTo - realFrom, displayFrom, displayTo, displayRange: displayTo - displayFrom };
}

const paneHeight = (c: KChart): number => c.getSize(CANDLE_PANE_ID, 'main')?.height ?? 0;

/** Largest difference between two spans, in px of a pane showing `ref`. */
function spanDiffPx(a: Span, b: Span, height: number, kind: ScaleKind): number {
  const r = fwd(a.to, kind) - fwd(a.from, kind);
  if (!(r > 0) || !(height > 0)) return Infinity;
  return (Math.max(Math.abs(fwd(a.from, kind) - fwd(b.from, kind)), Math.abs(fwd(a.to, kind) - fwd(b.to, kind))) / r) * height;
}

/**
 * The createRange wrapper and the y half of a view move (viewTween.ts drives
 * it through YMotion). One per chart; Chart.tsx installs `wrap(...)` on the
 * price axis every time it sets the scale.
 */
export class PriceFit implements YMotion {
  private move: { from: Span; to: Span; e: number } | null = null;
  private primed: Span | null = null;
  private kind: ScaleKind = 'linear';

  /**
   * Glide from this span on the next `begin`, once. The axis may already be
   * fitting the new series by then (a timeframe switch replaces the bars
   * before the move can start); this is the span it showed before that.
   * An unusable span clears a prime that has not been consumed yet.
   */
  prime(span: Span): void {
    this.primed = [span.from, span.to].every(Number.isFinite) && span.to > span.from ? span : null;
  }

  /** Wrap the axis template's own createRange (klinecharts' plain auto-fit
   *  for that scale). */
  wrap(base: AxisCreateRangeCallback, kind: ScaleKind): AxisCreateRangeCallback {
    this.kind = kind;
    this.move = null;
    this.primed = null;
    const wrapped: AxisCreateRangeCallback = (params) => {
      const m = this.move;
      if (!m) return base(params);
      return base({ ...params, defaultRange: rangeOfSpan(lerpSpan(m.from, m.to, m.e, kind)) });
    };
    TEMPLATES.set(wrapped, base);
    return wrapped;
  }

  get moving(): boolean {
    return this.move !== null;
  }

  /** What the axis fits when the chart shows `v` on a plot `width` px wide. */
  destination(c: KChart, v: View, width: number): Span | null {
    const bars = c.getDataList();
    const candle = c.getStyles().candle;
    const value = candle.type === 'area' ? candle.area.value || 'close' : 'hl';
    const indicators = c.getIndicators({ paneId: CANDLE_PANE_ID });
    return fitSpan({ bars, value, indicators }, visibleWindow(bars.length, v.barSpace, v.rightBars, width));
  }

  begin(c: KChart, dest: View, width: number): boolean {
    this.move = null;
    const primed = this.primed;
    this.primed = null;
    const axis = priceAxis(c);
    if (!axis) return false;
    const height = paneHeight(c);
    const to = this.destination(c, dest, width);
    const auto = isAutoFit(axis);
    if (!to) {
      if (!auto) resumeAutoFit(c, axis);
      return false;
    }
    const r = axis.getRange();
    const from = primed ?? stripGap({ from: r.from, to: r.to }, gapRates(axis.gap, height), this.kind);
    if (![from.from, from.to].every(Number.isFinite) || !(from.to > from.from)) {
      if (!auto) resumeAutoFit(c, axis);
      return false;
    }
    // Already fitting and already there: nothing for y to do.
    if (auto && spanDiffPx(from, to, height, this.kind) < 0.25) return false;
    this.move = { from, to, e: 0 };
    // klinecharts asks createRange again on every layout from here on - and
    // until the first frame, the answer is where the axis already is.
    if (!auto) resumeAutoFit(c, axis);
    return true;
  }

  step(c: KChart, e: number, dest: View, width: number): void {
    const m = this.move;
    if (!m) return;
    if (e >= 1) {
      // The pass-through IS the destination's fit: no step at the hand-back.
      this.move = null;
      return;
    }
    // Re-read every frame, so a live tick that moves the newest bar's high or
    // low is followed rather than snapped to at the end.
    const to = this.destination(c, dest, width);
    if (to) m.to = to;
    m.e = e;
  }

  end(): void {
    this.move = null;
    // A prime belongs to the next begin. ViewTween.start cancels the move
    // already in flight before that begin, and this is where the cancel lands.
  }
}

/** wrapper -> the template range it wraps, so a re-wrap never stacks. */
const TEMPLATES = new WeakMap<AxisCreateRangeCallback, AxisCreateRangeCallback>();

/** The axis template's own createRange behind any wrapper of ours. */
export const templateRange = (fn: AxisCreateRangeCallback): AxisCreateRangeCallback => TEMPLATES.get(fn) ?? fn;

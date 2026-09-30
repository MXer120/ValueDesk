/**
 * THE PLOT INVARIANT: the klinecharts plot is never on screen while it shows
 * nothing true.
 *
 * "Nothing true" is any of:
 *   - no bars at all (the empty chart);
 *   - a price axis that is not a range: NaN, infinite, or empty;
 *   - klinecharts' empty default: with no bars in view its auto-fit falls back
 *     to 0..10, which it widens by its 10% / 20% gap to exactly -1..12 - the
 *     "0-10 scale" users saw;
 *   - an auto-fitted axis whose range misses every bar in view;
 *   - candles made transparent for the morph with no morph layer drawing them.
 *
 * Chart.tsx checks it before every frame that unmasks the plot and on a timer
 * while the plot is shown; a violation keeps the placeholder mask up, logs
 * an error with a snapshot, and reloads the series (with the load's own
 * backoff). Pure and unit-tested (invariant.test.ts); `readPlot` is the thin
 * klinecharts read.
 */
import type { Chart as KChart } from 'klinecharts';
import { CANDLE_PANE_ID } from './theme';

export interface PlotState {
  bars: number;
  /** The candle pane's price axis range as klinecharts holds it. */
  range: { from: number; to: number; realFrom: number; realTo: number } | null;
  /** klinecharts is fitting the axis to the data (A on). */
  auto: boolean;
  /** Lowest low / highest high of the bars in view, or null with none in view. */
  low: number | null;
  high: number | null;
  /** klinecharts draws its candles transparent (MORPH_HIDDEN)... */
  candlesHidden: boolean;
  /** ...and the morph layer is on screen drawing them instead. */
  layerDrawing: boolean;
}

export type Violation = 'no-bars' | 'invalid-range' | 'empty-default-range' | 'range-misses-bars' | 'candles-hidden';

/** klinecharts' range for an empty view: 0..10 widened by its 10% / 20% gap. */
const EMPTY_FROM = -1;
const EMPTY_TO = 12;

/** What is wrong with a plot about to be (or being) shown; null when nothing. */
export function plotViolation(s: PlotState): Violation | null {
  if (!(s.bars > 0)) return 'no-bars';
  const r = s.range;
  if (!r || ![r.from, r.to, r.realFrom, r.realTo].every(Number.isFinite) || !(r.to > r.from) || !(r.realTo > r.realFrom)) {
    return 'invalid-range';
  }
  if (s.auto && s.low !== null && s.high !== null) {
    // The empty default, unless the bars in view really do span 0..10.
    if (Math.abs(r.from - EMPTY_FROM) < 1e-9 && Math.abs(r.to - EMPTY_TO) < 1e-9 && !(s.low <= 0.5 && s.high >= 9.5)) {
      return 'empty-default-range';
    }
    if (s.high < r.from || s.low > r.to) return 'range-misses-bars';
  }
  if (s.candlesHidden && !s.layerDrawing) return 'candles-hidden';
  return null;
}

interface AxisFlag {
  getAutoCalcTickFlag?: () => boolean;
}

/** Read what the plot shows, through the public API (plus the axis' auto flag). */
export function readPlot(c: KChart, layerDrawing: boolean): PlotState {
  const list = c.getDataList();
  const axis = c.getYAxes({ paneId: CANDLE_PANE_ID })[0];
  const r = axis?.getRange();
  const flag = (axis as unknown as AxisFlag | undefined)?.getAutoCalcTickFlag;
  const vr = c.getVisibleRange();
  let low = Infinity;
  let high = -Infinity;
  for (let i = Math.max(0, vr.realFrom); i < Math.min(list.length, vr.realTo); i++) {
    const d = list[i];
    if (!d) continue;
    if (d.low < low) low = d.low;
    if (d.high > high) high = d.high;
  }
  const bar = c.getStyles().candle.bar;
  return {
    bars: list.length,
    range: r ? { from: r.from, to: r.to, realFrom: r.realFrom, realTo: r.realTo } : null,
    auto: typeof flag === 'function' ? flag.call(axis) !== false : true,
    low: low === Infinity ? null : low,
    high: high === -Infinity ? null : high,
    candlesHidden: bar.upColor === 'transparent' && bar.downColor === 'transparent',
    layerDrawing,
  };
}

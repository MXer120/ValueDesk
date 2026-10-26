/**
 * A small time-series chart for the data widgets (an indicator's history, the
 * FOMC probabilities over time, ETF flows), built on the trading chart's own
 * klinecharts and its helpers, so it moves and reads the same way: the theme
 * and fonts (chart/theme.ts), the TradingView-style time axis
 * (chart/timeAxis.ts), the eased price fit (chart/yScale.ts' PriceFit) driven
 * by the same camera move (chart/viewTween.ts), the axis hand-off on a switch
 * (chart/axisHandoff.ts), the double-click reset and the L (logarithmic) scale.
 *
 * Each series is a line or bars; `scale: 'left'` puts one on a second axis (ETF
 * flows: the daily bars on the right, the running total on the left); `mark`
 * picks out one point with a dot and a label. Times are ms.
 *
 * HOW SERIES BECOME KLINECHARTS DATA. klinecharts is candle based: one bar per
 * timestamp. The bars here are the union of every series' timestamps, each
 * carrying the values that exist at that time (`vals`, keyed by series). The
 * candles themselves draw nothing - the candle type is `area` on a key no bar
 * has, so klinecharts neither paints them nor fits the axis to them - and one
 * custom indicator per axis draws the series instead: its `calc` hands
 * klinecharts that axis' values (which is what the axis auto-fits to), and its
 * `draw` paints the lines (joined across the times a series has no value at,
 * so monthly data with gaps stays one line), the bars (coloured by sign) and
 * the mark. The left axis is a second y-axis in the same pane, which
 * klinecharts creates for an indicator given its own `yAxisId`; it fits only
 * that indicator.
 *
 * THE SWITCH. When the caller swaps the series (1Y to 5Y, another asset), the
 * chart does what the trading chart does on a timeframe switch: the labels on
 * screen are kept over the axes (AxisHold), and the price scale eases from the
 * span it showed to the new data's fit (PriceFit, primed with that span). On
 * top of that the camera starts on the time window that was on screen - the
 * last year, inside the new five - and eases out to the whole new range on the
 * same clock, so a range switch reads as one zoom instead of a cut. The left
 * axis eases with it (AxisFit below, the same maths for the second axis).
 *
 * The double click resets exactly as Chart.tsx's resetView does - one eased
 * move, x and y together, back to the fitted view (here: every point on
 * screen) - and is caught on the second release because klinecharts consumes
 * the dblclick. Wheel zoom and drag pan are klinecharts' own.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type {
  AxisCreateRangeCallback,
  AxisCreateTicksCallback,
  AxisTick,
  Chart as KChart,
  DeepPartial,
  IndicatorDrawParams,
  KLineData,
  Point,
  Styles,
  YAxis,
  YAxisOverride,
} from 'klinecharts';
import {
  AXIS_FONT_SIZE,
  AXIS_FONT_WEIGHT,
  CANDLE_PANE_ID,
  FAMILY,
  NUM_FAMILY,
  T,
  X_AXIS_NAME,
  chartStyles,
  createDenseYTicks,
  formatBigNumber,
  registerChartAxes,
} from '../../chart/theme';
import {
  INITIAL_SCALE,
  PriceFit,
  fitSpan,
  gapRates,
  isAutoFit,
  kindOf,
  lerpSpan,
  priceAxis,
  rangeOfSpan,
  resumeAutoFit,
  scaleReducer,
  stripGap,
  templateRange,
  visibleWindow,
  type FitSource,
  type ScaleKind,
  type ScaleMode,
  type Span,
} from '../../chart/yScale';
import { captureAxis, type AxisHold } from '../../chart/axisHandoff';
import { TWEEN_MS, ViewTween, applyView, paintNow, plotWidth, readView, sameView, type View, type YMotion } from '../../chart/viewTween';
import { MORPH_MS, prefersReducedMotion } from '../../chart/morph';
import { crosshairLabel, timeTicks, type TimeZoneMode } from '../../chart/timeAxis';
import { logger } from '../../log';
import './SeriesChart.css';

const log = logger('chart');

export interface ChartSeries {
  key: string;
  kind: 'line' | 'bars';
  color: string;
  points: ReadonlyArray<readonly [number, number]>;
  /** Bars below zero in this colour (flows out). */
  negColor?: string;
  scale?: 'right' | 'left';
  /** How values print on the axis and crosshair. */
  format?: (v: number) => string;
  title?: string;
  /** One point picked out with a dot and a label (a calendar card: the release just out). Time in ms. */
  mark?: { time: number; text?: string; color?: string };
}

// --- the data --------------------------------------------------------------------

/** One bar: a timestamp and the series' values at it. The OHLC fields carry a
 *  representative value only because klinecharts requires them; nothing reads
 *  them except the log axis' rescue for a non-positive floor (theme.ts). */
type Row = KLineData & { vals: Record<string, number> };

interface Model {
  rows: Row[];
  /** `rows[i].vals`, as the result array PriceFit's fitSpan reads. */
  vals: Array<Record<string, number>>;
  right: ChartSeries[];
  left: ChartSeries[];
  /** Typical spacing of the points (the median gap), ms: the time axis' and
   *  the crosshair's interval, and the step past either end of the data. */
  stepMs: number;
  /** The data itself (times, values, kinds, axes). Equal means only the look
   *  changed (a colour, a mark), which repaints without moving the view. */
  sig: string;
}

const DAY = 86_400_000;

function median(xs: number[]): number {
  if (!xs.length) return DAY;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function buildModel(series: readonly ChartSeries[]): Model {
  const byTime = new Map<number, Record<string, number>>();
  const sig: string[] = [];
  for (const s of series) {
    const seen = new Set<number>();
    let h = 0;
    for (const [t, v] of s.points) {
      if (!Number.isFinite(t) || !Number.isFinite(v) || seen.has(t)) continue;
      seen.add(t);
      let r = byTime.get(t);
      if (!r) byTime.set(t, (r = {}));
      r[s.key] = v;
      h = (h * 31 + Math.round(t / 1000) + Math.round(v * 1e6)) | 0;
    }
    sig.push(`${s.key}:${s.kind}:${s.scale ?? 'right'}:${seen.size}:${h}`);
  }
  let right = series.filter((s) => s.scale !== 'left');
  let left = series.filter((s) => s.scale === 'left');
  // Everything on the left is simply one axis: draw it on the main one.
  if (!right.length) {
    right = left;
    left = [];
  }
  const times = [...byTime.keys()].sort((a, b) => a - b);
  const rows: Row[] = times.map((t) => {
    const vals = byTime.get(t)!;
    const rep = [...right, ...left].map((s) => vals[s.key]).find((v) => typeof v === 'number') ?? 0;
    return { timestamp: t, open: rep, high: rep, low: rep, close: rep, vals };
  });
  const gaps: number[] = [];
  for (let i = 1; i < rows.length; i++) gaps.push(rows[i]!.timestamp - rows[i - 1]!.timestamp);
  return { rows, vals: rows.map((r) => r.vals), right, left, stepMs: Math.max(1, median(gaps)), sig: sig.join(';') };
}

/** The time at a (fractional) bar index; past either end, one step per bar. */
function timeAt(m: Model, fi: number): number {
  const n = m.rows.length;
  if (!n) return Number.NaN;
  const first = m.rows[0]!.timestamp;
  const last = m.rows[n - 1]!.timestamp;
  if (fi <= 0) return first + fi * m.stepMs;
  if (fi >= n - 1) return last + (fi - (n - 1)) * m.stepMs;
  const i = Math.floor(fi);
  const a = m.rows[i]!.timestamp;
  const b = m.rows[i + 1]!.timestamp;
  return a + (b - a) * (fi - i);
}

/** The bar nearest a time. */
function nearestRow(rows: readonly Row[], t: number): number {
  let lo = 0;
  let hi = rows.length - 1;
  if (hi < 0) return -1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (rows[mid]!.timestamp <= t) lo = mid;
    else hi = mid;
  }
  return Math.abs(rows[hi]!.timestamp - t) < Math.abs(rows[lo]!.timestamp - t) ? hi : lo;
}

/** The inverse: the fractional bar index a time falls on. */
function indexAt(m: Model, t: number): number {
  const n = m.rows.length;
  if (!n) return Number.NaN;
  const first = m.rows[0]!.timestamp;
  const last = m.rows[n - 1]!.timestamp;
  if (t <= first) return (t - first) / m.stepMs;
  if (t >= last) return n - 1 + (t - last) / m.stepMs;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (m.rows[mid]!.timestamp <= t) lo = mid;
    else hi = mid;
  }
  const a = m.rows[lo]!.timestamp;
  const b = m.rows[hi]!.timestamp;
  return lo + (b > a ? (t - a) / (b - a) : 0);
}

// --- the view ----------------------------------------------------------------------

/** Narrowest bar pitch: thousands of daily points still fit a small card.
 *  klinecharts' own floor (1px) would leave most of "All" off screen. */
const BAR_SPACE_FLOOR = 0.02;
/** Widest pitch. klinecharts' own limit (50px, viewTween's BAR_SPACE_MAX) is
 *  a candle's: it kept 1Y of quarterly data at 14 bars on a 700px card, three
 *  and a half years. A span shows what it says, so here a bar may take the
 *  plot - four quarters across a card are four wide bars. */
const BAR_SPACE_CEIL = 4000;
const clampSpace = (v: number) => Math.min(BAR_SPACE_CEIL, Math.max(BAR_SPACE_FLOOR, v));

/**
 * Every point on screen, half a bar in from each edge (klinecharts centres a
 * bar on its slot); a series too short to fill the width at the widest pitch
 * sits in the middle. This is the fresh view and where the reset lands.
 */
function fitView(n: number, width: number): View {
  if (!(n > 0) || !(width > 0)) return { barSpace: 6, rightBars: 0 };
  const barSpace = clampSpace(width / n);
  const spare = Math.max(0, width - n * barSpace);
  return { barSpace, rightBars: spare / 2 / barSpace };
}

/** The bar indices at the plot's two edges for a view: klinecharts maps index
 *  i to x = W - (n + rightBars - i - 0.5) * barSpace. */
function edgesOf(v: View, width: number, n: number): [number, number] {
  const right = n + v.rightBars - 0.5;
  return [right - width / v.barSpace, right];
}

/** The view whose edges sit on bar indices [l, r]. */
function viewOf(l: number, r: number, width: number, n: number): View | null {
  if (!(r > l) || !(width > 0)) return null;
  const barSpace = clampSpace(width / (r - l));
  return { barSpace, rightBars: r + 0.5 - n };
}

// --- the second axis' share of a move ------------------------------------------------

/** wrapper -> the axis template's own createRange, for the left axis (the
 *  right one's live in yScale.ts' own map, read through templateRange). */
const LEFT_TEMPLATES = new WeakMap<AxisCreateRangeCallback, AxisCreateRangeCallback>();

/** The span an axis shows, its gap removed; null when there is none. */
function spanOf(c: KChart, axis: YAxis, kind: ScaleKind): Span | null {
  const r = axis.getRange();
  if (![r.from, r.to].every(Number.isFinite) || !(r.to > r.from)) return null;
  if (r.from === 0 && r.to === 10) return null;
  const height = c.getSize(CANDLE_PANE_ID, 'main')?.height ?? 0;
  const s = stripGap({ from: r.from, to: r.to }, gapRates(axis.gap, height), kind);
  return [s.from, s.to].every(Number.isFinite) && s.to > s.from ? s : null;
}

/**
 * PriceFit's move for an axis other than the pane's default one: the same
 * blend (lerpSpan in the axis' own space, from the span it showed or a primed
 * one to the destination's fit), the same hand-back (the last frame is the
 * pass-through). PriceFit itself is bound to the default axis.
 */
class AxisFit implements YMotion {
  private move: { from: Span; to: Span; e: number } | null = null;
  private primed: Span | null = null;
  private kind: ScaleKind = 'linear';

  constructor(
    private readonly axisOf: (c: KChart) => YAxis | null,
    private readonly source: () => FitSource | null,
  ) {}

  prime(span: Span | null): void {
    this.primed = span && [span.from, span.to].every(Number.isFinite) && span.to > span.from ? span : null;
  }

  wrap(base: AxisCreateRangeCallback, kind: ScaleKind): AxisCreateRangeCallback {
    this.kind = kind;
    this.move = null;
    this.primed = null;
    const wrapped: AxisCreateRangeCallback = (params) => {
      const m = this.move;
      if (!m) return base(params);
      return base({ ...params, defaultRange: rangeOfSpan(lerpSpan(m.from, m.to, m.e, kind)) });
    };
    LEFT_TEMPLATES.set(wrapped, base);
    return wrapped;
  }

  private destination(v: View, width: number): Span | null {
    const src = this.source();
    return src ? fitSpan(src, visibleWindow(src.bars.length, v.barSpace, v.rightBars, width)) : null;
  }

  begin(c: KChart, dest: View, width: number): boolean {
    this.move = null;
    const primed = this.primed;
    this.primed = null;
    const axis = this.axisOf(c);
    if (!axis) return false;
    const auto = isAutoFit(axis);
    const to = this.destination(dest, width);
    const from = primed ?? spanOf(c, axis, this.kind);
    if (!to || !from) {
      if (!auto) resumeAutoFit(c, axis);
      return false;
    }
    const same = Math.abs(from.from - to.from) + Math.abs(from.to - to.to) <= (from.to - from.from) * 1e-4;
    if (auto && same) return false;
    this.move = { from, to, e: 0 };
    if (!auto) resumeAutoFit(c, axis);
    return true;
  }

  step(_c: KChart, e: number, dest: View, width: number): void {
    const m = this.move;
    if (!m) return;
    if (e >= 1) {
      this.move = null;
      return;
    }
    const to = this.destination(dest, width);
    if (to) m.to = to;
    m.e = e;
  }

  end(): void {
    this.move = null;
  }
}

/** PriceFit, with the destination read from this chart's own values: the
 *  default axis fits only its own series (the left axis' are not its business),
 *  and the answer is ready the moment the data is, before klinecharts has run
 *  the indicator's calc. */
class SeriesFit extends PriceFit {
  constructor(private readonly source: () => FitSource | null) {
    super();
  }

  override destination(_c: KChart, v: View, width: number): Span | null {
    const src = this.source();
    return src ? fitSpan(src, visibleWindow(src.bars.length, v.barSpace, v.rightBars, width)) : null;
  }
}

/** What an axis fits: exactly what klinecharts' createRangeImp reads for it -
 *  the indicator's figure values, and zero when it draws bars (minValue and
 *  maxValue 0, the same numbers the indicator is given). */
function fitSource(m: Model | null, side: 'right' | 'left'): FitSource | null {
  const list = m ? (side === 'right' ? m.right : m.left) : [];
  if (!m || !list.length) return null;
  const bars = list.some((s) => s.kind === 'bars');
  return {
    bars: m.rows,
    value: NO_VALUE,
    indicators: [{ result: m.vals, figures: list.map((s) => ({ key: s.key })), minValue: bars ? 0 : null, maxValue: bars ? 0 : null }],
  };
}

// --- klinecharts glue ------------------------------------------------------------

/** The data key the (invisible) area candles read: no bar has it. */
const NO_VALUE = '__dc_none';
const INDICATOR = 'dc_series';
const CLEAR = 'rgba(0, 0, 0, 0)';

/** On top of chartStyles: no candles, no last-price rule, no canvas tooltips
 *  (the DOM legend reads the values), and a time axis sized to its labels -
 *  the trading chart's 32px band is room for its footer, which this has not. */
const SERIES_STYLES: DeepPartial<Styles> = {
  candle: {
    type: 'area',
    area: { value: NO_VALUE, lineColor: CLEAR, backgroundColor: CLEAR, point: { show: false } },
    priceMark: { show: false, high: { show: false }, low: { show: false }, last: { show: false } },
    tooltip: { showRule: 'none' },
  },
  indicator: { tooltip: { showRule: 'none' }, lastValueMark: { show: false } },
  xAxis: { size: 'auto' },
};

/** indicator id -> the series it draws, for the shared template's calc and draw. */
const DRAWS = new Map<string, () => ChartSeries[]>();

let indicatorRegistered = false;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function registerSeriesIndicator(kc: typeof import('klinecharts')): void {
  if (indicatorRegistered) return;
  indicatorRegistered = true;
  kc.registerIndicator<Record<string, number>>({
    name: INDICATOR,
    figures: [],
    calc: (list, ind) => {
      const keys = (DRAWS.get(ind.id)?.() ?? []).map((s) => s.key);
      return list.map((d) => {
        const vals = (d as Row).vals;
        const out: Record<string, number> = {};
        for (const k of keys) {
          const v = vals?.[k];
          if (isNum(v)) out[k] = v;
        }
        return out;
      });
    },
    draw: (p) => {
      const list = DRAWS.get(p.indicator.id)?.();
      if (list?.length) drawSeries(p, list);
      // Always covers: klinecharts' own figures would draw every key as a line.
      return true;
    },
  });
}

/**
 * Paint one axis' series onto the pane: bars first, lines over them, the mark
 * on top. Only the visible bars are walked - plus, for a line, the nearest
 * point beyond each edge, so it runs off the plot instead of stopping short.
 */
function drawSeries({ ctx, chart, xAxis, yAxis, bounding }: IndicatorDrawParams<Record<string, number>, unknown, unknown>, list: ChartSeries[]): void {
  const rows = chart.getDataList() as Row[];
  const n = rows.length;
  if (!n) return;
  const vr = chart.getVisibleRange();
  const from = Math.max(0, vr.from - 1);
  const to = Math.min(n, vr.to + 1);
  const x = (i: number) => xAxis.convertToPixel(i);
  const y = (v: number) => yAxis.convertToPixel(v);

  const bs = chart.getBarSpace();
  const w = Math.max(1, bs.gapBar);
  const half = Math.floor(w / 2);
  for (const s of list) {
    if (s.kind !== 'bars') continue;
    const y0 = y(0);
    ctx.globalAlpha = 0.85;
    for (let i = from; i < to; i++) {
      const v = rows[i]!.vals[s.key];
      if (!isNum(v)) continue;
      const yv = y(v);
      ctx.fillStyle = v < 0 && s.negColor ? s.negColor : s.color;
      ctx.fillRect(x(i) - half, Math.min(y0, yv), w, Math.max(1, Math.abs(yv - y0)));
    }
    ctx.globalAlpha = 1;
  }

  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const s of list) {
    if (s.kind !== 'line') continue;
    let lo = from - 1;
    while (lo > 0 && !isNum(rows[lo]?.vals[s.key])) lo--;
    let hi = to;
    while (hi < n - 1 && !isNum(rows[hi]?.vals[s.key])) hi++;
    ctx.beginPath();
    let started = false;
    for (let i = Math.max(0, lo); i <= Math.min(n - 1, hi); i++) {
      const v = rows[i]!.vals[s.key];
      if (!isNum(v)) continue;
      if (started) ctx.lineTo(x(i), y(v));
      else {
        ctx.moveTo(x(i), y(v));
        started = true;
      }
    }
    ctx.strokeStyle = s.color;
    ctx.stroke();
  }

  for (const s of list) {
    if (!s.mark) continue;
    const i = nearestRow(rows, s.mark.time);
    const v = rows[i]?.vals[s.key];
    if (i < from || i >= to || !isNum(v)) continue;
    const px = x(i);
    const py = y(v);
    const color = s.mark.color ?? s.color;
    ctx.beginPath();
    ctx.arc(px, py, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = T.bg;
    ctx.stroke();
    const text = s.mark.text;
    if (!text) continue;
    ctx.font = `500 11px ${FAMILY}`;
    const tw = ctx.measureText(text).width;
    const tx = Math.min(bounding.width - tw / 2 - 2, Math.max(tw / 2 + 2, px));
    const above = py - 9 - 11 > 2;
    ctx.textAlign = 'center';
    ctx.textBaseline = above ? 'bottom' : 'top';
    const ty = above ? py - 8 : py + 8;
    ctx.lineWidth = 3;
    ctx.strokeStyle = T.bg;
    ctx.strokeText(text, tx, ty);
    ctx.fillStyle = color;
    ctx.fillText(text, tx, ty);
  }
}

/** A plain number when the caller gave no format: grouped thousands folded to
 *  K/M/B as the trading chart's volume axis prints them, four figures below. */
const plainFormat = (v: number): string => (Math.abs(v) >= 1e3 ? formatBigNumber(v) : String(Number(v.toPrecision(4))));

const formatOf = (list: readonly ChartSeries[]): ((v: number) => string) => list.find((s) => s.format)?.format ?? plainFormat;

/** A coarse format can print two neighbouring ticks the same ("20%", "20%"):
 *  the second says nothing and goes. */
const denseTicks: AxisCreateTicksCallback = (params) => {
  const ticks = createDenseYTicks(params);
  return ticks.filter((t: AxisTick, i: number) => i === 0 || t.text !== ticks[i - 1]!.text);
};

/*
 * THE LINEAR AXIS' LABELS. klinecharts lays its ticks on a ladder of 1, 2, 3,
 * 4, 5, 6 or 8 per decade and then thins them on the way: walking up from
 * the bottom, a tick within two label heights (24px) of the last one kept is
 * dropped. On a small card that thinning starts from whichever tick cleared
 * the bottom edge, not from zero - measured on the Employment cost index bars
 * (0 to 1.3%, 136px of plot): the ladder 0, 0.2 ... 1.4 lost its 0 to the
 * edge and came out 0.2, 0.6, 1.0, 1.4, with no 0.4 or 0.8, and denseYTicks
 * (theme.ts) hands that set back as it is, since its own 1-1.5-2-2.5-5 ladder
 * found nothing at least as dense. The trading chart keeps that path (it has
 * the height for it); this chart lays its own: multiples of the smallest step
 * on a 1-2-4-5 ladder that leaves a label's room between labels and that the
 * caller's format prints without two neighbours reading the same, so the
 * labels are always round multiples counted from zero.
 */
const TICK_STEPS = [1, 2, 4, 5];
/** A label (12px) and a gap. */
const TICK_MIN_PX = 28;

function ladderTicks(params: Parameters<AxisCreateTicksCallback>[0], format: (v: number) => string): AxisTick[] | null {
  const { range, bounding } = params;
  const height = bounding.height;
  const lo = range.realFrom;
  const hi = range.realTo;
  if (![lo, hi].every(Number.isFinite) || !(hi > lo) || !(height > 0)) return null;
  const pxPerUnit = height / (hi - lo);
  // A label is drawn centred on its tick: keep it whole inside the axis.
  const edge = AXIS_FONT_SIZE / 2 + 1;
  const from = lo + edge / pxPerUnit;
  const to = hi - edge / pxPerUnit;
  const e = Math.floor(Math.log10(TICK_MIN_PX / pxPerUnit));
  for (const exp of [e - 1, e, e + 1, e + 2]) {
    for (const s of TICK_STEPS) {
      const step = s * 10 ** exp;
      if (step * pxPerUnit < TICK_MIN_PX) continue;
      const ticks: AxisTick[] = [];
      for (let k = Math.ceil(from / step); k * step <= to && ticks.length < 64; k++) {
        const v = Number((k * step).toFixed(12)) || 0;
        ticks.push({ coord: Math.round(height - (v - lo) * pxPerUnit), value: v, text: format(v) });
      }
      if (ticks.length < 2) continue;
      if (ticks.some((t, i) => i > 0 && t.text === ticks[i - 1]!.text)) continue;
      return ticks;
    }
  }
  return null;
}

/** The ticks for one axis: our ladder on a linear scale, the trading chart's
 *  dense ticks on the log one (pixels are not linear in value there). */
const ticksFor = (format: () => (v: number) => string, kind: ScaleKind): AxisCreateTicksCallback => (params) =>
  (kind === 'linear' ? ladderTicks(params, format()) : null) ?? denseTicks(params);

const YEAR_MS = 365 * DAY;
/** The range buttons' spans: the history on screen up to the newest point. */
const SPANS: Record<string, number | null> = {
  '7d': 7 * DAY,
  '30d': 30 * DAY,
  '1m': 30 * DAY,
  '90d': 91 * DAY,
  '3m': 91 * DAY,
  '1y': YEAR_MS,
  '5y': 5 * YEAR_MS,
  '10y': 10 * YEAR_MS,
  max: null,
  all: null,
};

/** A range key ("1y", "5y", "10y", "max", "all", "3m") as SeriesChart's `span`;
 *  an unknown key is everything. */
export const rangeSpan = (range: string): number | null => SPANS[range.toLowerCase()] ?? null;

/**
 * The view for a span: its right edge on the newest point (half a bar in, as
 * klinecharts centres a bar), its left edge `span` before that. Null, or a
 * span reaching past the first point, is every point on screen (fitView).
 */
function spanView(m: Model | null, width: number, span: number | null): View {
  const n = m?.rows.length ?? 0;
  if (!m || !n || span === null || !(span > 0)) return fitView(n, width);
  const last = m.rows[n - 1]!.timestamp;
  const l = indexAt(m, last - span) - 0.5;
  if (!(l > -0.5)) return fitView(n, width);
  return viewOf(l, n - 0.5, width, n) ?? fitView(n, width);
}

/** How far the magnet reaches, px from the pointer. */
const MAGNET_PX = 32;

const motionOk = () => !prefersReducedMotion() && !document.documentElement.classList.contains('is-potato');
const viewMs = (): number | undefined => (prefersReducedMotion() ? 0 : undefined);

let uidSeq = 0;

// --- the component ---------------------------------------------------------------

/**
 * `span`: how much history is on screen, in ms, up to the newest point (null
 * or left out: all of it) - what a range button sets, the way a timeframe
 * does on the trading chart. The caller loads the whole history once; the
 * wheel and a drag then reach every point of it, and a new span is one eased
 * move to it. A double click goes back to the span.
 */
export function SeriesChart({ series, height = 220, daily = true, span = null }: { series: ChartSeries[]; height?: number; daily?: boolean; span?: number | null }) {
  const host = useRef<HTMLDivElement>(null);
  /** The span asked for now, and the one the view was last put on. */
  const spanNow = useRef<number | null>(span);
  spanNow.current = span;
  const spanShown = useRef<number | null | undefined>(undefined);
  const chart = useRef<KChart | null>(null);
  const [ready, setReady] = useState(false);
  const uid = useRef('');
  uid.current ||= `dc${++uidSeq}`;
  const ids = useMemo(() => ({ right: `${uid.current}_r`, left: `${uid.current}_l`, leftAxis: `${uid.current}_ly` }), []);

  /** The data on the chart (klinecharts holds `rows` itself, by reference). */
  const model = useRef<Model | null>(null);
  /** Daily and monthly points are dates: read them on the UTC calendar. */
  const tz = useRef<TimeZoneMode>(daily ? 'utc' : 'local');
  tz.current = daily ? 'utc' : 'local';

  const [scale, dispatchScale] = useReducer(scaleReducer, INITIAL_SCALE);
  const mode = useRef<ScaleMode>(scale.mode);
  mode.current = scale.mode;

  const leftAxis = useCallback((c: KChart): YAxis | null => c.getYAxes({ paneId: CANDLE_PANE_ID, id: ids.leftAxis })[0] ?? null, [ids]);

  /** The price axis' fit and the left axis' (one per chart), and the move
   *  that carries both (chart/viewTween.ts). */
  const fit = useRef<SeriesFit | null>(null);
  fit.current ??= new SeriesFit(() => fitSource(model.current, 'right'));
  const leftFit = useRef<AxisFit | null>(null);
  leftFit.current ??= new AxisFit((c) => (model.current?.left.length ? leftAxis(c) : null), () => fitSource(model.current, 'left'));
  const tween = useRef<ViewTween | null>(null);
  if (!tween.current) {
    const a = fit.current;
    const b = leftFit.current;
    const both: YMotion = {
      begin: (c, d, w) => {
        const ra = a.begin(c, d, w);
        const rb = b.begin(c, d, w);
        return ra || rb;
      },
      step: (c, e, d, w) => {
        a.step(c, e, d, w);
        b.step(c, e, d, w);
      },
      end: () => {
        a.end();
        b.end();
      },
    };
    tween.current = new ViewTween(() => chart.current, both);
  }

  /** The previous labels held over the axes through a switch. */
  const hold = useRef<AxisHold | null>(null);
  /** The user zoomed or panned: a resize no longer refits. */
  const userMoved = useRef(false);
  /** Frames we asked for, cancelled on unmount. */
  const frames = useRef(new Set<number>());
  const frame = useCallback((cb: () => void) => {
    const id = requestAnimationFrame(() => {
      frames.current.delete(id);
      cb();
    });
    frames.current.add(id);
  }, []);

  /** The bar under the crosshair, or null for the newest values. */
  const [hover, setHover] = useState<number | null>(null);
  /** Where the plot starts (a left axis pushes it right): the legend sits on it. */
  const [plotLeft, setPlotLeft] = useState(0);
  /** Bumped when new data lands, so the legend re-reads the model. */
  const [, setDataGen] = useState(0);

  /**
   * State both axes on the chart: the scale (by klinecharts' axis name - a new
   * name rebuilds the axis, which drops everything set on it, hence restating
   * the rest every time), the dense ticks, the caller's format for the labels
   * and the crosshair's value tag, and the createRange wrapper that lets a move
   * carry the axis.
   */
  const applyAxes = useCallback((c: KChart) => {
    const m = model.current;
    const f = fit.current;
    const lf = leftFit.current;
    if (!f || !lf) return;
    const kind = kindOf(mode.current);
    const rightFormat = () => formatOf(model.current?.right ?? []);
    const leftFormat = () => formatOf(model.current?.left ?? []);
    const def = priceAxis(c);
    if (def) {
      const text = (v: number) => rightFormat()(v);
      // displayValueToText is the axis template's label hook; klinecharts merges
      // it from an override like createTicks, though its types leave it out.
      c.overrideYAxis({ paneId: CANDLE_PANE_ID, id: def.id, name: mode.current, createTicks: ticksFor(rightFormat, kind), displayValueToText: text } as YAxisOverride);
      const axis = priceAxis(c);
      if (axis) c.overrideYAxis({ paneId: CANDLE_PANE_ID, id: axis.id, createRange: f.wrap(templateRange(axis.createRange), kind) });
    }
    if (m?.left.length && leftAxis(c)) {
      const text = (v: number) => leftFormat()(v);
      c.overrideYAxis({ paneId: CANDLE_PANE_ID, id: ids.leftAxis, name: mode.current, position: 'left', createTicks: ticksFor(leftFormat, kind), displayValueToText: text } as YAxisOverride);
      const axis = leftAxis(c);
      if (axis) {
        const base = LEFT_TEMPLATES.get(axis.createRange) ?? axis.createRange;
        c.overrideYAxis({ paneId: CANDLE_PANE_ID, id: ids.leftAxis, createRange: lf.wrap(base, kind) });
      }
    }
  }, [ids, leftAxis]);

  /** One indicator per axis, created on first use, its figures (the keys the
   *  axis fits) restated; the left one, and with it klinecharts' left axis,
   *  removed when no series wants it. */
  const syncIndicators = useCallback((c: KChart, m: Model) => {
    const state = (list: ChartSeries[]) => {
      const bars = list.some((s) => s.kind === 'bars');
      return { figures: list.map((s) => ({ key: s.key })), minValue: bars ? 0 : null, maxValue: bars ? 0 : null };
    };
    const right = state(m.right);
    if (c.getIndicators({ id: ids.right }).length) c.overrideIndicator({ name: INDICATOR, id: ids.right, ...right });
    else c.createIndicator({ name: INDICATOR, id: ids.right, paneId: CANDLE_PANE_ID, precision: 6, ...right }, true);
    const hasLeft = c.getIndicators({ id: ids.left }).length > 0;
    if (m.left.length) {
      const left = state(m.left);
      if (hasLeft) c.overrideIndicator({ name: INDICATOR, id: ids.left, ...left });
      else c.createIndicator({ name: INDICATOR, id: ids.left, paneId: CANDLE_PANE_ID, yAxisId: ids.leftAxis, precision: 6, ...left }, true);
    } else if (hasLeft) {
      c.removeIndicator({ id: ids.left });
    }
  }, [ids]);

  /** The plot's left edge, once klinecharts has laid the axes out. */
  const readPlotLeft = useCallback(() => {
    frame(() => {
      const left = chart.current?.getSize(CANDLE_PANE_ID, 'main')?.left ?? 0;
      setPlotLeft((p) => (p === left ? p : left));
    });
  }, [frame]);

  /** The span's view, now (no move): a first load, a resize, a move's landing. */
  const fitNow = useCallback((c: KChart) => {
    const n = c.getDataList().length;
    const w = plotWidth(c);
    if (!n || !(w > 0)) return;
    const v = spanView(model.current, w, spanNow.current);
    if (!sameView(readView(c), v)) paintNow(() => applyView(c, v));
  }, []);

  /** The double-click reset: back to the span (every point on screen without
   *  one) and the axes fitting it, in one eased move (Chart.tsx's resetView,
   *  with autoscale always on - this chart has no A). */
  const lastReset = useRef(-Infinity);
  const resetView = useCallback(() => {
    const now = performance.now();
    if (now - lastReset.current < 600) return;
    lastReset.current = now;
    if (!chart.current || !model.current?.rows.length) return;
    userMoved.current = false;
    log.debug('series chart: view reset (double-click)');
    tween.current?.start((_from, width) => spanView(model.current, width, spanNow.current), { ms: viewMs(), fitY: true });
  }, []);

  /**
   * The magnet: the crosshair (both lines, the value tag, the legend) jumps to
   * the nearest real point within MAGNET_PX of the pointer - its time and its
   * value; on bars, the bar's value, the whole bar counting as near. Always on.
   * Null when nothing is that close, and the crosshair follows the pointer.
   */
  const magnet = useCallback((c: KChart, px: number, py: number): { x: number; y: number; index: number } | null => {
    const m = model.current;
    const rows = c.getDataList() as Row[];
    const n = rows.length;
    if (!m || !n) return null;
    const ends = c.convertFromPixel([{ x: px - MAGNET_PX }, { x: px + MAGNET_PX }], { paneId: CANDLE_PANE_ID }) as Array<Partial<Point>>;
    const i0 = Math.max(0, ends[0]?.dataIndex ?? 0);
    const i1 = Math.min(n - 1, ends[1]?.dataIndex ?? n - 1);
    if (i1 < i0) return null;
    const x0 = (c.convertToPixel({ dataIndex: i0 }, { paneId: CANDLE_PANE_ID }) as { x?: number }).x;
    if (typeof x0 !== 'number') return null;
    const bar = c.getBarSpace().bar;
    let best: { d: number; x: number; y: number; index: number } | null = null;
    const sides: Array<[ChartSeries[], YAxis | null]> = [[m.right, priceAxis(c)], [m.left, m.left.length ? leftAxis(c) : null]];
    for (const [list, axis] of sides) {
      if (!axis) continue;
      for (const s of list) {
        const zero = s.kind === 'bars' ? axis.convertToPixel(0) : 0;
        for (let i = i0; i <= i1; i++) {
          const v = rows[i]!.vals[s.key];
          if (!isNum(v)) continue;
          const x = x0 + (i - i0) * bar;
          const y = axis.convertToPixel(v);
          // Measured from the point's column, not its centre: anywhere over a
          // bar (or a line's point) left or right is as near as its middle, so
          // only the height counts there - on a wide bar the centre can be
          // further off sideways than the whole reach. The bar itself, top to
          // zero, is distance 0; above it or below a line's point, the gap.
          const dx = Math.max(0, Math.abs(px - x) - bar / 2);
          const inBar = s.kind === 'bars' && py >= Math.min(y, zero) && py <= Math.max(y, zero);
          const d = Math.hypot(dx, inBar ? 0 : py - y);
          if (d <= MAGNET_PX && (!best || d < best.d)) best = { d, x, y, index: i };
        }
      }
    }
    return best;
  }, [leftAxis]);

  // --- the chart itself -------------------------------------------------------
  useEffect(() => {
    let disposed = false;
    let kc: typeof import('klinecharts') | null = null;
    let c: KChart | null = null;
    let ro: ResizeObserver | null = null;
    const pending = frames.current;
    DRAWS.set(ids.right, () => model.current?.right ?? []);
    DRAWS.set(ids.left, () => model.current?.left ?? []);

    void import('klinecharts')
      .then((lib) => {
        const el = host.current;
        if (disposed || !el) return;
        kc = lib;
        registerChartAxes(lib);
        registerSeriesIndicator(lib);
        c = lib.init(el, {
          styles: chartStyles,
          formatter: {
            formatBigNumber,
            formatDate: ({ dateTimeFormat, timestamp, template, type }) =>
              type === 'crosshair' ? crosshairLabel(timestamp, model.current?.stepMs ?? DAY, tz.current) : lib.utils.formatDate(dateTimeFormat, timestamp, template),
          },
          // The labels are the caller's format, exactly as it prints them.
          thousandsSeparator: { sign: '' },
          decimalFold: { threshold: 20 },
          layout: { barSpaceLimit: { min: BAR_SPACE_FLOOR, max: BAR_SPACE_CEIL } },
        });
        if (!c) {
          log.error('series chart: klinecharts failed to initialise (empty container)');
          return;
        }
        const ch = c;
        ch.setStyles(SERIES_STYLES);
        ch.resize();
        const measure = (text: string) => lib.utils.calcTextWidth(text, AXIS_FONT_SIZE, AXIS_FONT_WEIGHT, NUM_FAMILY);
        ch.overrideXAxis({
          name: X_AXIS_NAME,
          scrollZoomEnabled: true,
          createTicks: ({ range, bounding }) => {
            const m = model.current;
            const n = ch.getDataList().length;
            if (!m || !n) return [];
            return timeTicks({
              from: range.realFrom,
              to: range.realTo,
              timestampAt: (i) => timeAt(m, i),
              coordAt: (i) => (ch.convertToPixel({ dataIndex: i }, { paneId: CANDLE_PANE_ID }) as { x?: number }).x ?? Number.NaN,
              barSpace: ch.getBarSpace().bar,
              intervalMs: m.stepMs,
              width: bounding.width,
              tz: tz.current,
              measure,
            });
          },
        });
        // The bars come from the model, all at once: no history to page in.
        ch.setDataLoader({
          getBars: ({ type, callback }) => callback(type === 'init' ? (model.current?.rows ?? []) : [], false),
        });
        ch.setSymbol({ ticker: uid.current, pricePrecision: 6, volumePrecision: 0 });
        ch.setPeriod({ type: 'day', span: 1 });
        ch.subscribeAction('onCrosshairChange', (data?: unknown) => {
          const cr = data as { x?: number; y?: number; paneId?: string } | null | undefined;
          if (!cr || typeof cr.x !== 'number') {
            setHover(null);
            return;
          }
          // klinecharts reports the pointer before it paints the crosshair; a
          // crosshair set from here (executeAction, which reports nothing back)
          // is the one it paints.
          const snap = cr.paneId === CANDLE_PANE_ID && typeof cr.y === 'number' ? magnet(ch, cr.x, cr.y) : null;
          if (snap) {
            const set = () => ch.executeAction('onCrosshairChange', { x: snap.x, y: snap.y, paneId: CANDLE_PANE_ID });
            set();
            // And once more when this pointer event is done with, before the
            // frame paints: whatever klinecharts does after reporting it, the
            // snapped crosshair is the one on screen. The next move reports
            // again, so this never outlives the pointer.
            queueMicrotask(() => {
              if (chart.current === ch) set();
            });
            setHover(snap.index);
            return;
          }
          const pts = ch.convertFromPixel([{ x: cr.x }], { paneId: cr.paneId ?? CANDLE_PANE_ID }) as Array<Partial<Point>>;
          const idx = pts[0]?.dataIndex;
          const n = ch.getDataList().length;
          setHover(typeof idx === 'number' && idx >= 0 && idx < n ? idx : null);
        });
        // klinecharts follows its container's size itself; this refits the
        // view to the new width, unless the user has moved it.
        ro = new ResizeObserver(() => {
          ch.resize();
          // After the layout resize() queued, so the plot width is the new one.
          queueMicrotask(() => {
            if (chart.current !== ch || userMoved.current || tween.current?.running) return;
            fitNow(ch);
            readPlotLeft();
          });
        });
        ro.observe(el);
        chart.current = ch;
        setReady(true);
      })
      .catch((e: unknown) => log.error('series chart: klinecharts did not load', { error: String(e) }));

    return () => {
      disposed = true;
      ro?.disconnect();
      tween.current?.cancel();
      hold.current?.clear();
      hold.current = null;
      for (const id of pending) cancelAnimationFrame(id);
      pending.clear();
      DRAWS.delete(ids.right);
      DRAWS.delete(ids.left);
      if (c) {
        c.unsubscribeAction('onCrosshairChange');
        kc?.dispose(c);
      }
      chart.current = null;
      model.current = null;
      setReady(false);
    };
  }, [ids, fitNow, readPlotLeft, magnet]);

  // --- the data ---------------------------------------------------------------
  useEffect(() => {
    const c = chart.current;
    const f = fit.current;
    const lf = leftFit.current;
    const tw = tween.current;
    if (!ready || !c || !f || !lf || !tw) return;
    const prev = model.current;
    const next = buildModel(series);

    // Same data, another look (a colour, a format, the mark): repaint in place.
    if (prev && prev.sig === next.sig) {
      next.rows = prev.rows;
      next.vals = prev.vals;
      model.current = next;
      syncIndicators(c, next);
      applyAxes(c);
      setDataGen((g) => g + 1);
      return;
    }

    const width = plotWidth(c);
    const animate = !!prev && prev.rows.length > 0 && next.rows.length > 0 && width > 0 && motionOk();
    tw.cancel();
    hold.current?.clear();
    hold.current = null;
    const kind = kindOf(mode.current);
    // What is on screen now, before the bars are replaced: the axes' labels
    // and spans, and the time window the camera shows.
    let shot: AxisHold | null = null;
    let leftSpan: Span | null = null;
    let seen: [number, number] | null = null;
    if (animate && prev) {
      shot = captureAxis(c, kind);
      const la = prev.left.length ? leftAxis(c) : null;
      leftSpan = la ? spanOf(c, la, kind) : null;
      const [l, r] = edgesOf(readView(c), width, prev.rows.length);
      seen = [timeAt(prev, l), timeAt(prev, r)];
    }

    // The user's own zoom or pan survives new data (a poll, another asset):
    // the same time window stays on screen. Otherwise the view is the span's.
    const keep = userMoved.current && !!prev && prev.rows.length > 0 && width > 0;
    if (keep && !seen && prev) {
      const [l, r] = edgesOf(readView(c), width, prev.rows.length);
      seen = [timeAt(prev, l), timeAt(prev, r)];
    }

    model.current = next;
    syncIndicators(c, next);
    applyAxes(c);
    c.resetData();
    spanShown.current = spanNow.current;
    setHover(null);
    setDataGen((g) => g + 1);
    readPlotLeft();
    const n = next.rows.length;

    // The time window that was on screen, mapped into the new bars; null when
    // the new data does not reach it (another series altogether).
    let mapped: View | null = null;
    if (seen && n) {
      const first = next.rows[0]!.timestamp;
      const last = next.rows[n - 1]!.timestamp;
      if (Math.min(seen[1], last) > Math.max(seen[0], first)) mapped = viewOf(indexAt(next, seen[0]), indexAt(next, seen[1]), width, n);
    }
    if (!keep || !mapped) userMoved.current = false;
    /** Where this view lands: the user's window, or the span's. */
    const destOf = (w: number): View => (userMoved.current && mapped ? mapped : spanView(next, w, spanNow.current));

    if (!animate) {
      if (userMoved.current && mapped) paintNow(() => applyView(c, mapped));
      else {
        fitNow(c);
        // Once klinecharts has measured the new labels (the axis may have widened).
        frame(() => {
          if (chart.current === c && !userMoved.current && !tw.running) fitNow(c);
        });
      }
      return;
    }

    // The camera starts on the time window that was on screen and eases to
    // the span's view (a poll or another asset: the same window, so only the
    // price scale moves). A window the new data does not reach starts there.
    const dest = destOf(width);
    const start = mapped ?? dest;
    applyView(c, start);
    const moves = !sameView(start, dest);

    // Chart.tsx's switch from here: the old labels stay over the axes, the
    // price scale glides from the span they showed.
    if (shot) {
      hold.current = shot;
      shot.stick(c);
      f.prime(shot.span);
    }
    lf.prime(leftSpan);
    const ms = MORPH_MS;
    tw.start((_from, w) => destOf(w), {
      ms,
      fitY: true,
      onEnd: (completed) => {
        if (!completed) shot?.clear();
        if (hold.current === shot) hold.current = null;
        // The axes may have changed width under the move: land on the span's
        // view of the plot as it is now.
        if (completed && chart.current === c && !userMoved.current) fitNow(c);
      },
    });
    const reveal = () => {
      if (hold.current !== shot || !shot) return;
      shot.releasePrice();
      // While the camera moves, the new time labels move under the old ones:
      // a short crossfade. Standing still, the trading chart's full one.
      shot.fadeTime(moves ? TWEEN_MS / 3 : ms);
    };
    if (tw.running) frame(reveal);
    else {
      // Nothing to move, or the move could not start (onEnd is not called).
      f.prime({ from: Number.NaN, to: Number.NaN });
      lf.prime(null);
      reveal();
      if (hold.current === shot) hold.current = null;
      if (!userMoved.current) fitNow(c);
    }
  }, [ready, series, syncIndicators, applyAxes, leftAxis, fitNow, readPlotLeft, frame]);

  // --- the span -----------------------------------------------------------------
  // A range button: one eased move to the new span, x and y together - the
  // same move as the reset. New data with it is the data effect's (above),
  // which also lands on the span.
  useEffect(() => {
    const c = chart.current;
    const tw = tween.current;
    if (!ready || !c || !tw || !model.current?.rows.length) return;
    if (spanShown.current === span) return;
    spanShown.current = span;
    userMoved.current = false;
    tw.start((_from, w) => spanView(model.current, w, spanNow.current), {
      ms: motionOk() ? MORPH_MS : 0,
      fitY: true,
      onEnd: (completed) => {
        if (completed && chart.current === c && !userMoved.current) fitNow(c);
      },
    });
  }, [ready, span, fitNow]);

  // --- the price scale --------------------------------------------------------
  const logShown = useMemo(() => !series.some((s) => s.kind === 'bars'), [series]);
  const logOk = useMemo(
    () => logShown && series.some((s) => s.points.length > 0) && series.every((s) => s.points.every(([, v]) => v > 0)),
    [series, logShown],
  );
  useEffect(() => {
    // A log axis cannot place zero or a negative: back to linear.
    if (!logOk && scale.mode === 'logarithm') dispatchScale({ type: 'log' });
  }, [logOk, scale.mode]);
  useEffect(() => {
    const c = chart.current;
    if (!ready || !c) return;
    // A move in flight belongs to the scale being left.
    tween.current?.cancel();
    applyAxes(c);
  }, [ready, scale.mode, applyAxes]);

  // --- the pointer ------------------------------------------------------------
  // Chart.tsx's rules, minus autoscale: a wheel, a press or a touch stops a
  // running move where it is; the second press of a double click does not
  // drag (scrolling is off for exactly that press) and its release resets.
  useEffect(() => {
    const el = host.current;
    if (!ready || !el) return;
    const stop = () => tween.current?.cancel();
    let held: KChart | null = null;
    let pressed: { x: number; y: number } | null = null;
    const onDown = (e: MouseEvent) => {
      const c = chart.current;
      pressed = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
      if (c && e.button === 0 && e.detail >= 2) {
        held = c;
        c.setScrollEnabled(false);
        return;
      }
      stop();
    };
    const onMove = (e: MouseEvent) => {
      if (!pressed || !(e.buttons & 1)) return;
      if (Math.abs(e.clientX - pressed.x) + Math.abs(e.clientY - pressed.y) > 3) userMoved.current = true;
    };
    const onUp = (e: MouseEvent) => {
      held?.setScrollEnabled(true);
      held = null;
      const was = pressed !== null;
      pressed = null;
      if (was && e.button === 0 && e.detail === 2 && el.contains(e.target as Node)) resetView();
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      stop();
      userMoved.current = true;
    };
    const onWheel = () => {
      stop();
      userMoved.current = true;
    };
    const onLeave = () => setHover(null);
    const passive = { capture: true, passive: true } as const;
    el.addEventListener('wheel', onWheel, passive);
    el.addEventListener('touchstart', stop, passive);
    el.addEventListener('pointerdown', onPointerDown, true);
    el.addEventListener('mousedown', onDown, true);
    el.addEventListener('mouseleave', onLeave);
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
    return () => {
      el.removeEventListener('wheel', onWheel, passive);
      el.removeEventListener('touchstart', stop, passive);
      el.removeEventListener('pointerdown', onPointerDown, true);
      el.removeEventListener('mousedown', onDown, true);
      el.removeEventListener('mouseleave', onLeave);
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      held?.setScrollEnabled(true);
      held = null;
      stop();
    };
  }, [ready, resetView]);

  // --- the legend -------------------------------------------------------------
  // The values at the crosshair, or each series' latest when the pointer is
  // elsewhere, in the series' own format and colour.
  const m = model.current;
  const legend = (() => {
    if (!m || !m.rows.length) return null;
    const at = hover !== null && hover < m.rows.length ? hover : null;
    const idx = at ?? m.rows.length - 1;
    const items: Array<{ key: string; color: string; title?: string; text: string }> = [];
    for (const s of [...m.right, ...m.left]) {
      let v: number | undefined = m.rows[idx]!.vals[s.key];
      if (at === null) {
        for (let i = m.rows.length - 1; i >= 0 && !isNum(v); i--) v = m.rows[i]!.vals[s.key];
      }
      if (!isNum(v)) continue;
      const color = s.kind === 'bars' && v < 0 && s.negColor ? s.negColor : s.color;
      items.push({ key: s.key, color, title: s.title, text: (s.format ?? plainFormat)(v) });
    }
    return { time: crosshairLabel(m.rows[idx]!.timestamp, m.stepMs, tz.current), items };
  })();

  return (
    <div className="dc-chart" style={{ height }}>
      <div ref={host} className="dc-chart__plot" onDoubleClick={resetView} />
      {legend && (
        <div className="dc-legend" style={{ left: plotLeft + 6 }} aria-hidden="true">
          <span className="dc-legend__time">{legend.time}</span>
          {legend.items.map((it) => (
            <span key={it.key} className="dc-legend__item">
              <i style={{ background: it.color }} />
              {it.title && <span className="dc-legend__name">{it.title}</span>}
              <b>{it.text}</b>
            </span>
          ))}
        </div>
      )}
      {logShown && (
        <div className="dc-scale" role="group" aria-label="Price scale">
          <button
            type="button"
            title={logOk ? 'Logarithmic scale' : 'Logarithmic scale (needs every value above zero)'}
            aria-label="Logarithmic scale"
            className={scale.mode === 'logarithm' ? 'on' : ''}
            aria-pressed={scale.mode === 'logarithm'}
            disabled={!ready || !logOk}
            onClick={() => dispatchScale({ type: 'log' })}
          >
            L
          </button>
        </div>
      )}
    </div>
  );
}

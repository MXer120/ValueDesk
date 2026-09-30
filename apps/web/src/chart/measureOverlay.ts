/**
 * The measure (ruler) tool — a custom klinecharts overlay.
 *
 * klinecharts 10.0.2 registers sixteen overlays and none of them is a measure:
 * verified by calling `getSupportedOverlays()` on the installed build, not read
 * off a changelog. So this one is registered with `registerOverlay()`, which is
 * the same seam the order-line template already uses.
 *
 * WHAT IT REPORTS, AND WHERE THE NUMBERS COME FROM.
 *
 * Every figure this file draws is positioned in pixels, but not one number it
 * PRINTS is derived from a pixel. klinecharts hands a drawing overlay its anchor
 * points as `{ dataIndex, timestamp, value }` — the output of the chart's own
 * y-axis `convertFromPixel` and of `floatIndexToTimestamp` on the x side — and
 * those are what the readout is computed from:
 *
 *   price change   points[last].value  -  points[0].value
 *   percent        that difference over points[0].value
 *   bars crossed   points[last].dataIndex - points[0].dataIndex, rounded
 *   time span      that same rounded bar count at the bar period measured
 *                  across the drag — see `readSpan` for why the clock is
 *                  derived from the bar count rather than read beside it
 *
 * Measuring off `coordinates` instead would look identical on a linear scale and
 * be silently wrong on a log or percentage one, where equal pixel distances are
 * not equal price distances. The library already owns that conversion; asking it
 * is the only correct way to answer "how much".
 *
 * AND WHEN THE NUMBER IS NOT THERE, IT SAYS SO. A point can legitimately arrive
 * with no timestamp (dragged past the end of the data into projection space
 * before the axis has a period to extrapolate with) or a start value of zero,
 * which makes a percentage undefined rather than 0.00%. Each field is formatted
 * independently and each falls back to an em-dash on its own, so a missing time
 * span never invents itself and never takes the price change down with it.
 *
 * THE GESTURE IS A DRAG, which is what a ruler is on every other terminal. That
 * comes from `drawingMode: 'continuous'` — the mode klinecharts added for the
 * brush, where mousedown starts the overlay, every pressed move appends a point,
 * and mouseup completes it. Only the first and last of those points are ever
 * read here, and `finishMeasure()` collapses the overlay to exactly those two
 * once the drag ends, so the finished object is a clean two-point overlay that
 * drags and re-renders like any other rather than a hundred-point polyline.
 *
 * Colour is the direction and nothing else: --pos when B is above A, --neg when
 * below, and the neutral canvas grey when the two prices are identical — a flat
 * measure is not a gain, and painting it green would be the one lie a measure
 * tool is in a position to tell.
 */
import type { Chart as KChart, Overlay, OverlayTemplate, Point } from 'klinecharts';
import { NUM_FAMILY, T } from './theme';

/** Registry name. Prefixed like the order line so it can never collide with a
 *  library overlay, and so Chart.tsx can tell ours apart from theirs. */
export const MEASURE_OVERLAY = 'ot_measure';

/** Label shown in the rail. The generic titleizer would render the raw id. */
export const MEASURE_LABEL = 'Measure';

/* Box fill. Low alpha because the candles under it still have to be readable —
   the box is a region marker, not a highlight. Written as literal rgba rather
   than composed from T at runtime: these are the two accent hues with one
   channel changed, and a hex-to-rgba helper would be three lines of arithmetic
   to produce two constants. */
const FILL_POS = 'rgba(0, 180, 129, 0.13)';
const FILL_NEG = 'rgba(239, 74, 60, 0.13)';
const FILL_FLAT = 'rgba(184, 184, 184, 0.10)';

/** Readout type. 12px on the canvas's four-size scale, weight 400, and the
 *  numeral family — everything in the badge is a figure. */
const FONT_SIZE = 12;
const LINE_H = 18;

/** Em-dash. The single value this file prints when it has no source for one. */
const NONE = '—';

/* `calcTextWidth` is a klinecharts util, and the library is imported
   dynamically so it cannot be pulled in at module scope. `registerMeasureOverlay`
   captures it; until then the badge simply is not clamped against the pane edge,
   which is unreachable in practice because the template cannot be instantiated
   before it is registered. */
let measureText: ((text: string, size: number, weight: number, family: string) => number) | null =
  null;

// --- formatting --------------------------------------------------------------

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Elapsed milliseconds as a human span.
 *
 * Two units at most, largest first, and the second unit is dropped when it is
 * zero — "2h" rather than "2h 0m". Seconds below a minute so a drag across three
 * bars of a 1s chart still says something.
 *
 * The smallest unit shown is rounded, not truncated. What keeps it agreeing
 * with the bar count beside it is not that both round, though — it is that both
 * are computed from the SAME already-rounded distance; see `readSpan`.
 */
function formatSpan(ms: number): string {
  if (!isNum(ms)) return NONE;
  const t = Math.abs(ms);
  if (t < 1000) return `${Math.round(t)}ms`;
  if (t < 60_000) return `${Math.round(t / 1000)}s`;
  if (t < 3_600_000) return `${Math.round(t / 60_000)}m`;
  if (t < 86_400_000) {
    const h = Math.floor(t / 3_600_000);
    const m = Math.round((t - h * 3_600_000) / 60_000);
    return m === 60 ? `${h + 1}h` : m === 0 ? `${h}h` : `${h}h ${m}m`;
  }
  const d = Math.floor(t / 86_400_000);
  const h = Math.round((t - d * 86_400_000) / 3_600_000);
  return h === 24 ? `${d + 1}d` : h === 0 ? `${d}d` : `${d}d ${h}h`;
}

/** Signed price move at the symbol's own precision, thousands-separated by the
 *  same formatter the price axis uses so the two agree digit for digit. */
function formatDelta(chart: KChart, delta: number, precision: number): string {
  if (!isNum(delta)) return NONE;
  const body = chart
    .getDecimalFold()
    .format(chart.getThousandsSeparator().format(Math.abs(delta).toFixed(precision)));
  return `${delta > 0 ? '+' : delta < 0 ? '-' : ''}${body}`;
}

/** Percent move. Undefined — not zero — when the starting price is zero or
 *  missing, which is the whole reason this is a separate function. */
function formatPct(from: number, to: number): string {
  if (!isNum(from) || !isNum(to) || from === 0) return NONE;
  const pct = ((to - from) / Math.abs(from)) * 100;
  if (!Number.isFinite(pct)) return NONE;
  return `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

/** Whole bars, pluralised. */
const formatBars = (n: number): string => `${n} ${n === 1 ? 'bar' : 'bars'}`;

/**
 * The horizontal distance, read once and then said two ways.
 *
 * These two numbers sit side by side in one badge and describe one gap, so they
 * cannot be computed independently. They were: the bar count rounded each
 * endpoint's `dataIndex` and subtracted, while the clock rounded the millisecond
 * DIFFERENCE. Rounding two endpoints and rounding their difference are not the
 * same operation, and they part company whenever the anchors sit at different
 * sub-bar phases. A drag from index 3.6 to 24.4 on a 1m chart is 20.8 bars:
 * round(24.4) − round(3.6) is 24 − 4 = 20, while 20.8 × 60,000ms rounds to 21
 * minutes. That is the reported "20 bars · 21m", on a chart whose bars are
 * exactly 60,000ms apart and where N bars therefore IS N minutes.
 *
 * So the fractional bar distance is rounded EXACTLY ONCE, and both readings come
 * off that single integer:
 *
 *   bars   the integer itself
 *   span   that many bars at the average bar period measured across the drag,
 *          i.e. `bars * (elapsed / fractionalBars)`
 *
 * The period is measured rather than assumed, so a window containing a gap (a
 * session break, a halt) still reports the real elapsed time rather than a bar
 * count multiplied by a nominal interval. On a chart with no gaps the ratio is
 * the bar interval exactly and the span is unchanged from the raw measurement —
 * it just can no longer disagree with the count printed next to it.
 *
 * Each half still falls back on its own: no `dataIndex` costs the bar count but
 * not the clock, and vice versa.
 */
function readSpan(a: Partial<Point>, b: Partial<Point>): { bars: string; span: string } {
  const hasIndex = isNum(a.dataIndex) && isNum(b.dataIndex);
  const hasTime = isNum(a.timestamp) && isNum(b.timestamp);
  const rawBars = hasIndex ? Math.abs(b.dataIndex! - a.dataIndex!) : Number.NaN;
  const rawMs = hasTime ? Math.abs(b.timestamp! - a.timestamp!) : Number.NaN;

  // The one rounding. A measure that reported "11.4 bars" would be precision
  // the axis does not have, and it is this integer the clock is derived from.
  const bars = hasIndex ? Math.round(rawBars) : Number.NaN;

  if (!hasIndex) return { bars: NONE, span: formatSpan(rawMs) };
  if (!hasTime) return { bars: formatBars(bars), span: NONE };
  // Both anchors on the same fractional index: no distance at all, and no bar
  // period to measure. Zero both ways rather than a clock the count contradicts.
  if (rawBars === 0) return { bars: formatBars(0), span: formatSpan(0) };
  // Rounded to whole milliseconds because timestamps ARE whole milliseconds: the
  // ratio is exact in arithmetic but not in binary floating point, and a residue
  // of 59999.99999999999 prints as "60s" where "1m" is the same number.
  return { bars: formatBars(bars), span: formatSpan(Math.round(bars * (rawMs / rawBars))) };
}

// --- reading -----------------------------------------------------------------

export interface MeasureReading {
  /** Signed price move, or an em-dash. */
  delta: string;
  /** Signed percent move, or an em-dash. */
  pct: string;
  /** Whole bars crossed, or an em-dash. */
  bars: string;
  /** Elapsed time, or an em-dash. */
  span: string;
  /** +1 up, -1 down, 0 flat, null when there is no price to compare. */
  direction: 1 | -1 | 0 | null;
}

/**
 * Everything the badge prints, from the two anchor points and nothing else.
 *
 * Exported so the reading can be tested and read without a canvas: the arithmetic
 * here is the part that has to be right, and it should not be reachable only
 * through a draw call.
 */
export function readMeasure(
  chart: KChart,
  a: Partial<Point>,
  b: Partial<Point>,
  precision: number,
): MeasureReading {
  const priced = isNum(a.value) && isNum(b.value);
  const delta = priced ? b.value! - a.value! : Number.NaN;
  const { bars, span } = readSpan(a, b);
  return {
    delta: priced ? formatDelta(chart, delta, precision) : NONE,
    pct: formatPct(a.value ?? Number.NaN, b.value ?? Number.NaN),
    bars,
    span,
    direction: !priced ? null : delta > 0 ? 1 : delta < 0 ? -1 : 0,
  };
}

/** Price precision for the pane the overlay lives in: the symbol's on the candle
 *  pane, the widest indicator's anywhere else — the same rule klinecharts' own
 *  fibonacciLine uses, so the readout matches the axis it is read against. */
function precisionFor(chart: KChart, overlay: Overlay<unknown>, inCandle: boolean): number {
  if (inCandle) return chart.getSymbol()?.pricePrecision ?? 2;
  let p = 0;
  for (const ind of chart.getIndicators({ paneId: overlay.paneId })) p = Math.max(p, ind.precision);
  return p;
}

// --- template ----------------------------------------------------------------

const template: OverlayTemplate = {
  name: MEASURE_OVERLAY,
  /* 2 with `continuous`: mousedown seeds the first point and takes the overlay
     out of its start step, mouseup completes it. The step count is not what
     bounds the anchors — the drag is. */
  totalStep: 2,
  drawingMode: 'continuous',
  /* No default handles: a continuous drag deposits a point per frame, and the
     library would draw a circle on every one of them. The two ends are marked
     by the box corners instead, and `finishMeasure` collapses the overlay to
     its two real anchors as soon as the drag is over. */
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,

  createPointFigures: ({ chart, coordinates, bounding, overlay, yAxis }) => {
    if (coordinates.length < 2) return [];
    const a = coordinates[0];
    const b = coordinates[coordinates.length - 1];
    const pa = overlay.points[0] ?? {};
    const pb = overlay.points[overlay.points.length - 1] ?? {};
    if (!a || !b) return [];

    const precision = precisionFor(chart, overlay, yAxis?.isInCandle() ?? true);
    const r = readMeasure(chart, pa, pb, precision);

    const color =
      r.direction === 1 ? T.pos
      : r.direction === -1 ? T.neg
      : T.canvasMuted;
    const fill =
      r.direction === 1 ? FILL_POS
      : r.direction === -1 ? FILL_NEG
      : FILL_FLAT;

    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);
    const midX = (a.x + b.x) / 2;

    /* Pixel direction, which is NOT the price direction: on a reversed y-axis
       a rise draws downwards. The box and the arrow follow the pixels because
       they are geometry; the colour and the readout follow the values because
       they are the measurement. */
    const upwards = b.y <= a.y;

    const line1 = `${r.delta} (${r.pct})`;
    const line2 = `${r.bars} · ${r.span}`;

    /* Keep the badge inside the pane. It is centred on the drag, so the clamp
       has to know how wide the wider of the two lines is; klinecharts' own
       measurer is used rather than an estimate, at exactly the size and family
       the text will be drawn in. */
    let half = 60;
    if (measureText) {
      half =
        Math.max(
          measureText(line1, FONT_SIZE, 400, NUM_FAMILY),
          measureText(line2, FONT_SIZE, 400, NUM_FAMILY),
        ) / 2 + 5;
    }
    const labelX = Math.max(half, Math.min(bounding.width - half, midX));

    /* Outside the box on the far side of B, flipped to the near side when there
       is not room — a readout drawn off the top of the pane is a readout that
       is not there. */
    const block = 2 * LINE_H;
    const above =
      upwards ? b.y - 6 - block >= 0 : b.y + 6 + block > bounding.height && b.y - 6 - block >= 0;
    const baseline = above ? ('bottom' as const) : ('top' as const);
    const [y1, y2] =
      above ?
        [b.y - 6 - LINE_H, b.y - 6]
      : [b.y + 6, b.y + 6 + LINE_H];

    const textStyles = {
      color: T.bg,
      backgroundColor: color,
      borderColor: color,
      family: NUM_FAMILY,
      size: FONT_SIZE,
      weight: 400,
      paddingLeft: 5,
      paddingRight: 5,
      paddingTop: 2,
      paddingBottom: 2,
      borderRadius: 2,
    };

    return [
      {
        type: 'rect',
        attrs: { x, y, width: Math.max(w, 1), height: Math.max(h, 1) },
        styles: {
          style: 'stroke_fill',
          color: fill,
          borderColor: color,
          borderSize: 1,
          borderRadius: 2,
        },
      },
      /* The spine. It says which way the measurement runs, which the box alone
         cannot — a box is symmetric and a measure is not. */
      {
        type: 'line',
        ignoreEvent: true,
        attrs: { coordinates: [{ x: midX, y: a.y }, { x: midX, y: b.y }] },
        styles: { color, size: 1 },
      },
      ...(h < 6 ?
        []
      : [
          {
            type: 'line',
            ignoreEvent: true,
            attrs: {
              coordinates: [
                { x: midX - 4, y: upwards ? b.y + 5 : b.y - 5 },
                { x: midX, y: b.y },
                { x: midX + 4, y: upwards ? b.y + 5 : b.y - 5 },
              ],
            },
            styles: { color, size: 1 },
          },
        ]),
      {
        type: 'text',
        ignoreEvent: true,
        attrs: { x: labelX, y: y1, text: line1, align: 'center', baseline },
        styles: textStyles,
      },
      {
        type: 'text',
        ignoreEvent: true,
        attrs: { x: labelX, y: y2, text: line2, align: 'center', baseline },
        styles: textStyles,
      },
    ];
  },
};

/** Idempotent — klinecharts' overlay registry is module-global and keyed by
 *  name, so a second call replaces the template rather than duplicating it. */
export function registerMeasureOverlay(kc: typeof import('klinecharts')): void {
  measureText = kc.utils.calcTextWidth;
  kc.registerOverlay(template);
}

/**
 * Tidy up a finished measure.
 *
 * Two jobs, both about the mess `drawingMode: 'continuous'` leaves behind:
 *
 *   1. A drag that never moved is not a measurement. It has one anchor, no span
 *      and nothing to report, so it is removed rather than left on the chart as
 *      an invisible zero-size overlay the user has to hunt for with Clear.
 *   2. A real drag leaves one point per animation frame. Only the ends were ever
 *      drawn, so the overlay is collapsed to exactly those two through the
 *      public `overrideOverlay` — after which it is an ordinary two-point object
 *      that drags, re-renders and serialises like every other overlay.
 *
 * Returns true when the overlay survived.
 */
export function finishMeasure(chart: KChart, overlay: Overlay<unknown>): boolean {
  const pts = overlay.points;
  const a = pts[0];
  const b = pts[pts.length - 1];
  const moved =
    pts.length > 1 &&
    a !== undefined &&
    b !== undefined &&
    (a.value !== b.value || a.dataIndex !== b.dataIndex);
  if (!moved) {
    chart.removeOverlay({ id: overlay.id });
    return false;
  }
  if (pts.length > 2) chart.overrideOverlay({ id: overlay.id, points: [a, b] });
  return true;
}

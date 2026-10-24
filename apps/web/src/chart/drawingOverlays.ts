/**
 * The drawing tools klinecharts does not ship, written as ordinary overlay
 * templates so they live in the same global registry as the library's sixteen
 * and reach the drawing rail through `getSupportedOverlays()` like every other
 * tool (see DrawingRail.tsx).
 *
 * The set follows what a TradingView user reaches for after the basic lines:
 * an info line and a trend angle, the trend-based Fibonacci and Gann family,
 * the harmonic and Elliott patterns, long / short position, price and date
 * ranges, and three shapes.
 *
 * Conventions every template here keeps, the same ones measureOverlay.ts keeps:
 *
 *   - Names are prefixed `ot_`, so they can never collide with a library
 *     overlay and Chart.tsx can tell ours from theirs.
 *   - Geometry is amber (--accent); a zone that MEANS profit or loss is green
 *     or red. No cold hue anywhere — the canvas is the largest warm surface on
 *     the page.
 *   - Every number is set in the numeral family, every word in the text one.
 *   - Prices print at the precision of the axis they are read against, through
 *     the same thousands separator and decimal fold the axis itself uses.
 *   - A template draws whatever it can at every step, so the preview follows
 *     the pointer from the first click rather than appearing on the last one.
 *   - Fills and readouts ignore events; the lines and zones you would grab to
 *     move the drawing stay hit-testable.
 */
import type {
  Bounding,
  Chart as KChart,
  Coordinate,
  Overlay,
  OverlayFigure,
  OverlayPerformEventParams,
  OverlayTemplate,
  Point,
  YAxis,
} from 'klinecharts';
import { readMeasure } from './measureOverlay';
import { FAMILY, NUM_FAMILY, T } from './theme';

// --- palette -------------------------------------------------------------------

/* The two direction hues with alpha, for zones that MEAN profit or loss. */
const FILL_POS = 'rgba(0, 180, 129, 0.13)';
const FILL_NEG = 'rgba(239, 74, 60, 0.13)';

/**
 * What a drawing is painted with: its own colour, width and dash, set by the
 * user from the style bar (Chart.tsx) and stored on the overlay as
 * `styles.line`. klinecharts merges a figure's own styles OVER the overlay's,
 * so a template that wrote its colour into each figure could never be
 * restyled; instead every figure helper below reads `paint`, which
 * `registerDrawingOverlays` sets from the overlay just before each draw.
 * Unstyled drawings get the accent, so they look exactly as they always did.
 */
export interface Paint {
  color: string;
  size: number;
  dashed: boolean;
  /** The colour at 14% / 8% / 35% - zone fills and the highlighter stroke. */
  fill: string;
  soft: string;
  highlight: string;
}

/** '#ffb547' / 'rgb(255, 181, 71)' at an alpha. Anything else is returned as is. */
export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const n = Number.parseInt(hex[1]!, 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
  return rgb ? `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})` : color;
}

export function paintOf(overlay: Pick<Overlay<unknown>, 'styles'> | null | undefined): Paint {
  const l = (overlay?.styles?.line ?? {}) as { color?: unknown; size?: unknown; style?: unknown };
  const color = typeof l.color === 'string' && l.color ? l.color : T.accent;
  return {
    color,
    size: typeof l.size === 'number' && l.size > 0 ? l.size : 1,
    dashed: l.style === 'dashed',
    fill: withAlpha(color, 0.14),
    soft: withAlpha(color, 0.08),
    highlight: withAlpha(color, 0.35),
  };
}

const DEFAULT_PAINT = paintOf(null);
let paint: Paint = DEFAULT_PAINT;

const FONT_SIZE = 12;
/** Line pitch inside a multi-line readout. */
const LINE_H = 16;

const NONE = '—';
const MINUS = '−';

// --- names ---------------------------------------------------------------------

export const INFO_LINE = 'ot_infoLine';
export const TREND_ANGLE = 'ot_trendAngle';
export const CROSS_LINE = 'ot_crossLine';
export const ARROW = 'ot_arrow';
export const FIB_EXTENSION = 'ot_fibExtension';
export const FIB_TIME_ZONE = 'ot_fibTimeZone';
export const FIB_FAN = 'ot_fibFan';
export const GANN_BOX = 'ot_gannBox';
export const GANN_FAN = 'ot_gannFan';
export const XABCD = 'ot_xabcd';
export const ABCD = 'ot_abcd';
export const TRIANGLE = 'ot_triangle';
export const ELLIOTT_IMPULSE = 'ot_elliottImpulse';
export const ELLIOTT_CORRECTION = 'ot_elliottCorrection';
export const HEAD_SHOULDERS = 'ot_headShoulders';
export const LONG_POSITION = 'ot_longPosition';
export const SHORT_POSITION = 'ot_shortPosition';
export const PRICE_RANGE = 'ot_priceRange';
export const DATE_RANGE = 'ot_dateRange';
export const RECT = 'ot_rect';
export const CIRCLE = 'ot_circle';
export const HIGHLIGHTER = 'ot_highlighter';
export const PATH = 'ot_path';
export const NOTE = 'ot_note';

/** Most anchors a path takes; it finishes by itself at this many. */
export const PATH_MAX_POINTS = 40;

// --- pure geometry and arithmetic (exported for the tests) ---------------------

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Trend-based extension ratios, TradingView's default set. */
export const FIB_EXTENSION_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618, 2, 2.618] as const;
/** Fibonacci numbers the time zones fall on, in units of the first span. */
export const FIB_TIME_ZONES = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89] as const;
/** Speed-resistance fan ratios. */
export const FIB_FAN_LEVELS = [0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;
/** Gann box divisions, both directions. 0 and 1 are the box's own edges. */
export const GANN_BOX_LEVELS = [0, 0.25, 0.382, 0.5, 0.618, 0.75, 1] as const;
/** Gann fan angles as price units per time unit: 8x1 down to 1x8. */
export const GANN_FAN_RATIOS = [8, 4, 3, 2, 1, 1 / 2, 1 / 3, 1 / 4, 1 / 8] as const;

/** The extension levels projected from the third point: the A→B move, scaled
 *  by each ratio and laid off from C. */
export function fibExtensionValues(a: number, b: number, c: number): Array<{ level: number; value: number }> {
  return FIB_EXTENSION_LEVELS.map((level) => ({ level, value: c + (b - a) * level }));
}

/** '1x1', '1x2' (one price unit per two time units), '2x1'. */
export function gannLabel(ratio: number): string {
  if (ratio >= 1) return `${Math.round(ratio)}x1`;
  return `1x${Math.round(1 / ratio)}`;
}

/** How far the move b→c retraces the move a→b, as a positive ratio. NaN when
 *  a→b has no length — there is nothing to retrace. */
export function retracement(a: number, b: number, c: number): number {
  const base = Math.abs(b - a);
  return base === 0 ? Number.NaN : Math.abs(c - b) / base;
}

/** The angle of a→b in PIXEL space, degrees, rising positive — what the eye
 *  sees on screen, which is the angle TradingView prints. */
export function pixelAngle(a: Coordinate, b: Coordinate): number {
  return (Math.atan2(a.y - b.y, b.x - a.x) * 180) / Math.PI;
}

/**
 * The point where the ray from `o` through `q` leaves the box [0,w]×[0,h].
 * Never short of `q` itself, so a ray whose through-point is already outside
 * the pane still reaches it.
 */
export function rayToEdge(o: Coordinate, q: Coordinate, width: number, height: number): Coordinate {
  const dx = q.x - o.x;
  const dy = q.y - o.y;
  if (dx === 0 && dy === 0) return q;
  let t = Number.POSITIVE_INFINITY;
  if (dx > 0) t = Math.min(t, (width - o.x) / dx);
  else if (dx < 0) t = Math.min(t, -o.x / dx);
  if (dy > 0) t = Math.min(t, (height - o.y) / dy);
  else if (dy < 0) t = Math.min(t, -o.y / dy);
  if (!Number.isFinite(t) || t < 1) t = 1;
  return { x: o.x + dx * t, y: o.y + dy * t };
}

export type PositionSide = 'long' | 'short';

/**
 * Target and stop of a position tool.
 *
 * With three points the second is the target and the third the stop, as drawn.
 * With two — the tool mid-drawing, or just finished — the second click is the
 * target when it is on the profitable side of the entry (above for a long,
 * below for a short), and the stop otherwise; the missing level is mirrored
 * around the entry, a 1:1 risk:reward to start from. A second click AT the entry
 * would draw two empty zones, so it opens a 1% target instead.
 */
export function positionLevels(
  side: PositionSide,
  entry: number,
  second: number,
  stop?: number,
): { target: number; stop: number } {
  if (isNum(stop)) return { target: second, stop };
  let p = second;
  if (p === entry) p = side === 'long' ? entry * 1.01 : entry * 0.99;
  const up = p > entry;
  const isTarget = side === 'long' ? up : !up;
  return isTarget ? { target: p, stop: 2 * entry - p } : { target: 2 * entry - p, stop: p };
}

export interface PositionReading {
  /** Percent from entry to target, signed. */
  targetPct: number;
  /** Percent from entry to stop, signed. */
  stopPct: number;
  /** Reward over risk. NaN when the stop sits on the entry. */
  rr: number;
}

export function positionReading(entry: number, target: number, stop: number): PositionReading {
  const pct = (v: number) => (entry === 0 ? Number.NaN : ((v - entry) / Math.abs(entry)) * 100);
  const risk = Math.abs(entry - stop);
  return { targetPct: pct(target), stopPct: pct(stop), rr: risk === 0 ? Number.NaN : Math.abs(target - entry) / risk };
}

/**
 * Keep a position tool coherent while one of its handles is dragged: the
 * target stays on the profitable side of the entry, the stop on the other, and
 * the stop's handle stays on the tool's right edge. Mutates `points`, which is
 * what klinecharts' pressed-move hook expects.
 */
export function constrainPosition(side: PositionSide, points: Array<Partial<Point>>, moved: number): void {
  const [e, t, s] = points;
  if (!e || !t || !s) return;
  s.timestamp = t.timestamp;
  s.dataIndex = t.dataIndex;
  if (!isNum(e.value) || !isNum(t.value) || !isNum(s.value)) return;
  const long = side === 'long';
  if (moved === 1) t.value = long ? Math.max(t.value, e.value) : Math.min(t.value, e.value);
  else if (moved === 2) s.value = long ? Math.min(s.value, e.value) : Math.max(s.value, e.value);
  else if (moved === 0) {
    const lo = long ? s.value : t.value;
    const hi = long ? t.value : s.value;
    e.value = Math.min(Math.max(e.value, lo), hi);
  }
}

// --- formatting ----------------------------------------------------------------

/* Same capture as measureOverlay: the library is imported dynamically, so its
   text measurer arrives with registration. Until then widths are estimated. */
let measureText: ((text: string, size: number, weight: number, family: string) => number) | null = null;

const textWidth = (s: string, family: string = NUM_FAMILY): number =>
  measureText ? measureText(s, FONT_SIZE, 400, family) : s.length * 6.6;

/** Price precision for the pane the overlay is on — the rule measureOverlay and
 *  klinecharts' own fibonacciLine use. */
function precisionFor(chart: KChart, overlay: Overlay<unknown>, yAxis: YAxis | null): number {
  if (yAxis?.isInCandle() ?? true) return chart.getSymbol()?.pricePrecision ?? 2;
  let p = 0;
  for (const ind of chart.getIndicators({ paneId: overlay.paneId })) p = Math.max(p, ind.precision);
  return p;
}

function fmtPrice(chart: KChart, v: number, precision: number): string {
  if (!isNum(v)) return NONE;
  const body = chart.getDecimalFold().format(chart.getThousandsSeparator().format(Math.abs(v).toFixed(precision)));
  return v < 0 ? `${MINUS}${body}` : body;
}

const fmtPct = (v: number): string => {
  if (!isNum(v)) return NONE;
  const body = `${Math.abs(v).toFixed(2)}%`;
  return v > 0 ? `+${body}` : v < 0 ? `${MINUS}${body}` : body;
};

const fmtRatio = (v: number): string => (isNum(v) ? v.toFixed(3) : NONE);

// --- figure helpers --------------------------------------------------------------

type Fig = OverlayFigure;
type C = Coordinate;

/** The drawing's main stroke - dashed too when the user chose dashed. */
const solid = () => ({ style: paint.dashed ? 'dashed' : 'solid', size: paint.size, dashedValue: [4, 3], color: paint.color });
/** Construction lines: always dashed, in the drawing's colour. */
const dashed = () => ({ style: 'dashed', size: paint.size, dashedValue: [4, 3], color: paint.color });

function lines(coords: C[][], styles: object = solid(), ignoreEvent = false): Fig {
  return {
    type: 'line',
    attrs: coords.filter((c) => c.length > 1).map((coordinates) => ({ coordinates })),
    styles,
    ...(ignoreEvent ? { ignoreEvent: true } : {}),
  };
}

const line = (coords: C[], styles: object = solid(), ignoreEvent = false): Fig => lines([coords], styles, ignoreEvent);

function polygon(coordinates: C[], color: string, border: string | null = null, ignoreEvent = true): Fig {
  return {
    type: 'polygon',
    attrs: { coordinates },
    styles:
      border === null ?
        { style: 'fill', color }
      : { style: 'stroke_fill', color, borderColor: border, borderSize: 1 },
    ...(ignoreEvent ? { ignoreEvent: true } : {}),
  };
}

function rect(a: C, b: C, color: string, border: string | null = null, ignoreEvent = false): Fig {
  return {
    type: 'rect',
    attrs: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) },
    styles:
      border === null ?
        { style: 'fill', color }
      : { style: 'stroke_fill', color, borderColor: border, borderSize: 1 },
    ...(ignoreEvent ? { ignoreEvent: true } : {}),
  };
}

/** Text with no box — a label riding next to a line. */
function label(
  x: number,
  y: number,
  text: string,
  o: { align?: CanvasTextAlign; baseline?: CanvasTextBaseline; color?: string; family?: string } = {},
): Fig {
  return {
    type: 'text',
    ignoreEvent: true,
    attrs: { x, y, text, align: o.align ?? 'left', baseline: o.baseline ?? 'bottom' },
    styles: {
      color: o.color ?? paint.color,
      backgroundColor: 'transparent',
      borderColor: 'transparent',
      borderSize: 0,
      family: o.family ?? NUM_FAMILY,
      size: FONT_SIZE,
      weight: 400,
      paddingLeft: 0,
      paddingRight: 0,
      paddingTop: 0,
      paddingBottom: 0,
    },
  };
}

/** A short text on a filled tag — the pattern letters. */
function tag(x: number, y: number, text: string, baseline: CanvasTextBaseline, bg: string = paint.color): Fig {
  return {
    type: 'text',
    ignoreEvent: true,
    attrs: { x, y, text, align: 'center', baseline },
    styles: {
      color: T.bg,
      backgroundColor: bg,
      borderColor: bg,
      borderSize: 0,
      family: FAMILY,
      size: FONT_SIZE,
      weight: 500,
      paddingLeft: 4,
      paddingRight: 4,
      paddingTop: 1,
      paddingBottom: 1,
      borderRadius: 2,
    },
  };
}

/**
 * A readout of one or more lines on one box, anchored at (x, y) and hung below
 * or above it, kept inside the pane — a readout drawn off the edge is a readout
 * that is not there.
 */
function readout(
  textLines: string[],
  x: number,
  y: number,
  bounding: Bounding,
  o: { align: 'left' | 'center'; place: 'below' | 'above'; bg: string; fg: string; border?: string },
): Fig[] {
  const padX = 6;
  const padY = 3;
  const w = Math.max(...textLines.map((l) => textWidth(l))) + padX * 2;
  const h = padY * 2 + (textLines.length - 1) * LINE_H + FONT_SIZE + 1;
  let left = o.align === 'center' ? x - w / 2 : x;
  left = Math.max(2, Math.min(bounding.width - w - 2, left));
  let top = o.place === 'below' ? y : y - h;
  top = Math.max(2, Math.min(bounding.height - h - 2, top));
  return [
    {
      type: 'rect',
      ignoreEvent: true,
      attrs: { x: left, y: top, width: w, height: h },
      styles: { style: 'stroke_fill', color: o.bg, borderColor: o.border ?? o.bg, borderSize: 1, borderRadius: 2 },
    },
    ...textLines.map((text, i) => label(left + padX, top + padY + i * LINE_H, text, { baseline: 'top', color: o.fg })),
  ];
}

/** Filled arrowhead with its tip at `tip`, pointing along from→tip. */
function arrowHead(from: C, tip: C, length = 12, halfWidth = 5): { head: Fig; base: C } {
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const l = Math.min(length, len * 0.6);
  const hw = (halfWidth * l) / length;
  const ux = dx / len;
  const uy = dy / len;
  const base = { x: tip.x - ux * l, y: tip.y - uy * l };
  const head = polygon(
    [tip, { x: base.x - uy * hw, y: base.y + ux * hw }, { x: base.x + uy * hw, y: base.y - ux * hw }],
    paint.color,
    null,
    false,
  );
  return { head, base };
}

/** Is point i a peak among its neighbours on screen? Decides whether its label
 *  goes above or below it. */
function isPeak(coords: C[], i: number): boolean {
  const c = coords[i]!;
  const prev = coords[i - 1];
  const next = coords[i + 1];
  if (prev && next) return c.y <= (prev.y + next.y) / 2;
  const n = prev ?? next;
  return n ? c.y <= n.y : true;
}

/** Labels pinned above a peak or below a trough. */
function pointLabels(coords: C[], names: readonly string[], kind: 'tag' | 'text'): Fig[] {
  return coords.slice(0, names.length).map((c, i) => {
    const up = isPeak(coords, i);
    const y = up ? c.y - 7 : c.y + 7;
    const baseline: CanvasTextBaseline = up ? 'bottom' : 'top';
    return kind === 'tag' ? tag(c.x, y, names[i]!, baseline) : label(c.x, y, names[i]!, { align: 'center', baseline });
  });
}

/** y of a price, through the axis when there is one (correct on a log scale),
 *  else the linear fallback the caller supplies. */
const yOf = (yAxis: YAxis | null, v: number, fallback: number): number =>
  yAxis && isNum(v) ? yAxis.convertToPixel(v) : fallback;

const values = (overlay: Overlay<unknown>): number[] => overlay.points.map((p) => (isNum(p.value) ? p.value : Number.NaN));

// --- lines ---------------------------------------------------------------------

/** Info line: a trend line that says what it spans. */
const infoLine: OverlayTemplate = {
  name: INFO_LINE,
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ chart, overlay, coordinates, bounding, yAxis }) => {
    const [a, b] = coordinates;
    if (!a || !b) return [];
    const pa = overlay.points[0] ?? {};
    const pb = overlay.points[1] ?? {};
    const r = readMeasure(chart, pa, pb, precisionFor(chart, overlay, yAxis));
    const deg = pixelAngle(a, b);
    return [
      line([a, b]),
      ...readout([`${r.delta} (${r.pct})`, `${r.bars}, ${r.span}`, `${deg.toFixed(1)}°`], b.x + 8, b.y + 8, bounding, {
        align: 'left',
        place: 'below',
        bg: T.elevated,
        fg: T.canvasText,
        border: T.control,
      }),
    ];
  },
};

/** Trend angle: the line, a dashed horizontal from its start and the arc
 *  between them, with the angle as the eye sees it on screen. */
const trendAngle: OverlayTemplate = {
  name: TREND_ANGLE,
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ coordinates }) => {
    const [a, b] = coordinates;
    if (!a || !b) return [];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    const dir = dx >= 0 ? 1 : -1;
    const refLen = Math.max(40, Math.abs(dx));
    const r = Math.max(12, Math.min(30, len * 0.6));
    // Canvas angles run clockwise from +x. The arc is drawn between the
    // horizontal reference and the line, whichever way round they are.
    const ref = dir > 0 ? 0 : Math.PI;
    let ang = Math.atan2(dy, dx);
    if (dir < 0 && ang < 0) ang += 2 * Math.PI;
    const deg = (Math.atan2(-dy, Math.abs(dx)) * 180) / Math.PI;
    const rising = dy <= 0;
    return [
      line([a, b]),
      line([a, { x: a.x + dir * refLen, y: a.y }], dashed(), true),
      {
        type: 'arc',
        ignoreEvent: true,
        attrs: { x: a.x, y: a.y, r, startAngle: Math.min(ref, ang), endAngle: Math.max(ref, ang) },
        styles: { style: 'solid', size: paint.size, color: paint.color },
      },
      label(a.x + dir * (r + 6), rising ? a.y - 3 : a.y + 3, `${deg.toFixed(1)}°`, {
        align: dir > 0 ? 'left' : 'right',
        baseline: rising ? 'bottom' : 'top',
      }),
    ];
  },
};

/** Cross line: a horizontal and a vertical through one point, both labelled on
 *  their axes. */
const crossLine: OverlayTemplate = {
  name: CROSS_LINE,
  totalStep: 2,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ coordinates, bounding }) => {
    const [a] = coordinates;
    if (!a) return [];
    return [
      lines([
        [{ x: 0, y: a.y }, { x: bounding.width, y: a.y }],
        [{ x: a.x, y: 0 }, { x: a.x, y: bounding.height }],
      ]),
    ];
  },
};

/** Arrow: a segment ending in a filled head. The shaft stops at the head's
 *  base so the tip is not blunted by the line cap. */
const arrow: OverlayTemplate = {
  name: ARROW,
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ coordinates }) => {
    const [a, b] = coordinates;
    if (!a || !b) return [];
    if (a.x === b.x && a.y === b.y) return [];
    const { head, base } = arrowHead(a, b);
    return [line([a, base], { ...solid(), size: Math.max(2, paint.size) }), head];
  },
};

// --- Fibonacci and Gann --------------------------------------------------------

/** Trend-based Fibonacci extension: the A→B move, scaled by each ratio, laid
 *  off from C. */
const fibExtension: OverlayTemplate = {
  name: FIB_EXTENSION,
  totalStep: 4,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ chart, overlay, coordinates, yAxis }) => {
    const figs: Fig[] = [];
    if (coordinates.length > 1) figs.push(line(coordinates.slice(0, 3), dashed()));
    const [a, b, c] = coordinates;
    const [va, vb, vc] = values(overlay);
    if (!a || !b || !c || !isNum(va) || !isNum(vb) || !isNum(vc)) return figs;
    const precision = precisionFor(chart, overlay, yAxis);
    const minX = Math.min(a.x, b.x, c.x);
    const maxX = Math.max(a.x, b.x, c.x);
    const endX = Math.max(maxX + (maxX - minX) * 0.25, minX + 40);
    const levels = fibExtensionValues(va, vb, vc);
    const ys = levels.map(({ level, value }) => yOf(yAxis, value, c.y + (b.y - a.y) * level));
    figs.push(lines(ys.map((y) => [{ x: minX, y }, { x: endX, y }])));
    levels.forEach(({ level, value }, i) => {
      figs.push(label(minX, ys[i]! - 2, `${level} (${fmtPrice(chart, value, precision)})`));
    });
    return figs;
  },
};

/** Fibonacci time zones: vertical lines at Fibonacci multiples of the first
 *  span. x is linear in the bar index, so the multiples are taken in pixels. */
const fibTimeZone: OverlayTemplate = {
  name: FIB_TIME_ZONE,
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ coordinates, bounding }) => {
    const [a, b] = coordinates;
    if (!a) return [];
    const unit = b ? b.x - a.x : 0;
    const zones = unit === 0 ? [0] : FIB_TIME_ZONES;
    const figs: Fig[] = [];
    const xs: Array<{ n: number; x: number }> = [];
    for (const n of zones) {
      const x = a.x + unit * n;
      if (x < 0 || x > bounding.width) continue;
      xs.push({ n, x });
    }
    figs.push(lines(xs.map(({ x }) => [{ x, y: 0 }, { x, y: bounding.height }])));
    for (const { n, x } of xs) figs.push(label(x + 3, bounding.height - 4, String(n)));
    return figs;
  },
};

/** Fibonacci speed-resistance fan: rays from the start through each ratio of
 *  the move, measured at the end's time. */
const fibFan: OverlayTemplate = {
  name: FIB_FAN,
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ coordinates, bounding }) => {
    const [a, b] = coordinates;
    if (!a || !b) return [];
    if (a.x === b.x) return [line([a, b])];
    const figs: Fig[] = [line([{ x: b.x, y: a.y }, b], dashed(), true)];
    const rays: C[][] = [];
    for (const f of FIB_FAN_LEVELS) {
      const through = { x: b.x, y: a.y + f * (b.y - a.y) };
      rays.push([a, rayToEdge(a, through, bounding.width, bounding.height)]);
      figs.push(label(b.x + (b.x > a.x ? 4 : -4), through.y, String(f), {
        align: b.x > a.x ? 'left' : 'right',
        baseline: 'middle',
      }));
    }
    figs.unshift(lines(rays));
    return figs;
  },
};

/** Gann box: the rectangle between two corners, divided at the Gann levels
 *  both ways, with 0 at the first corner. */
const gannBox: OverlayTemplate = {
  name: GANN_BOX,
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ coordinates }) => {
    const [a, b] = coordinates;
    if (!a || !b) return [];
    const top = Math.min(a.y, b.y);
    const bottom = Math.max(a.y, b.y);
    const left = Math.min(a.x, b.x);
    const right = Math.max(a.x, b.x);
    const inner = GANN_BOX_LEVELS.filter((l) => l > 0 && l < 1);
    const verticals = inner.map((l) => {
      const x = a.x + l * (b.x - a.x);
      return [{ x, y: top }, { x, y: bottom }];
    });
    const horizontals = inner.map((l) => {
      const y = a.y + l * (b.y - a.y);
      return [{ x: left, y }, { x: right, y }];
    });
    const figs: Fig[] = [
      rect(a, b, paint.soft, paint.color),
      lines([...verticals, ...horizontals], { ...dashed(), dashedValue: [2, 3] }, true),
    ];
    for (const l of GANN_BOX_LEVELS) {
      figs.push(label(a.x + l * (b.x - a.x), top - 3, String(l), { align: 'center', baseline: 'bottom' }));
      figs.push(label(left - 4, a.y + l * (b.y - a.y), String(l), { align: 'right', baseline: 'middle' }));
    }
    return figs;
  },
};

/** Gann fan: rays from the origin at the classic price/time ratios of the box
 *  the two points span — 1x1 is its diagonal. */
const gannFan: OverlayTemplate = {
  name: GANN_FAN,
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ coordinates, bounding }) => {
    const [a, b] = coordinates;
    if (!a || !b) return [];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (dx === 0 && dy === 0) return [];
    const rays: C[][] = [];
    const figs: Fig[] = [];
    for (const r of GANN_FAN_RATIOS) {
      const end = rayToEdge(a, { x: a.x + dx, y: a.y + dy * r }, bounding.width, bounding.height);
      rays.push([a, end]);
      // Pulled back inside the pane along the ray, so the label is never
      // clipped by the edge it ends on.
      const len = Math.hypot(end.x - a.x, end.y - a.y) || 1;
      const back = Math.min(28, len / 2);
      figs.push(label(end.x - ((end.x - a.x) / len) * back, end.y - ((end.y - a.y) / len) * back, gannLabel(r), {
        align: 'center',
        baseline: 'bottom',
      }));
    }
    figs.unshift(lines(rays));
    return figs;
  },
};

// --- patterns ------------------------------------------------------------------

/** Midpoint label with a ratio, for the dashed legs of the harmonic patterns. */
function ratioLeg(p: C, q: C, ratio: number): Fig[] {
  return [
    line([p, q], dashed(), true),
    label((p.x + q.x) / 2, (p.y + q.y) / 2, fmtRatio(ratio), { align: 'center', baseline: 'middle', color: T.canvasText }),
  ];
}

/** XABCD harmonic pattern: the legs, the XAB and BCD triangles, and the four
 *  ratios that name the pattern. */
const xabcd: OverlayTemplate = {
  name: XABCD,
  totalStep: 6,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ overlay, coordinates }) => {
    const cs = coordinates.slice(0, 5);
    const [X, A, B, Cc, D] = cs;
    const [vx, va, vb, vc, vd] = values(overlay);
    const figs: Fig[] = [];
    if (X && A && B) figs.push(polygon([X, A, B], paint.fill));
    if (B && Cc && D) figs.push(polygon([B, Cc, D], paint.fill));
    if (cs.length > 1) figs.push(line(cs));
    if (X && B) figs.push(...ratioLeg(X, B, retracement(vx!, va!, vb!)));
    if (A && Cc) figs.push(...ratioLeg(A, Cc, retracement(va!, vb!, vc!)));
    if (B && D) figs.push(...ratioLeg(B, D, retracement(vb!, vc!, vd!)));
    if (X && D) figs.push(...ratioLeg(X, D, retracement(vx!, va!, vd!)));
    figs.push(...pointLabels(cs, ['X', 'A', 'B', 'C', 'D'], 'tag'));
    return figs;
  },
};

/** ABCD pattern: three legs and the two ratios. */
const abcd: OverlayTemplate = {
  name: ABCD,
  totalStep: 5,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ overlay, coordinates }) => {
    const cs = coordinates.slice(0, 4);
    const [A, B, Cc, D] = cs;
    const [va, vb, vc, vd] = values(overlay);
    const figs: Fig[] = [];
    if (cs.length > 1) figs.push(line(cs));
    if (A && Cc) figs.push(...ratioLeg(A, Cc, retracement(va!, vb!, vc!)));
    if (B && D) figs.push(...ratioLeg(B, D, retracement(vb!, vc!, vd!)));
    figs.push(...pointLabels(cs, ['A', 'B', 'C', 'D'], 'tag'));
    return figs;
  },
};

/** Triangle: three corners, closed and lightly filled. */
const triangle: OverlayTemplate = {
  name: TRIANGLE,
  totalStep: 4,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ coordinates }) => {
    const cs = coordinates.slice(0, 3);
    if (cs.length < 2) return [];
    if (cs.length === 2) return [line(cs)];
    return [polygon(cs, paint.fill, paint.color, false)];
  },
};

/** A labelled wave count: the polyline and a label on every turning point. */
function waveTemplate(name: string, labels: readonly string[]): OverlayTemplate {
  return {
    name,
    totalStep: labels.length + 1,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates }) => {
      const cs = coordinates.slice(0, labels.length);
      const figs: Fig[] = [];
      if (cs.length > 1) figs.push(line(cs));
      figs.push(...pointLabels(cs, labels, 'text'));
      return figs;
    },
  };
}

const elliottImpulse = waveTemplate(ELLIOTT_IMPULSE, ['(0)', '(1)', '(2)', '(3)', '(4)', '(5)']);
const elliottCorrection = waveTemplate(ELLIOTT_CORRECTION, ['(0)', '(A)', '(B)', '(C)']);

/** Head and shoulders: seven turning points, the neckline through the two
 *  troughs either side of the head, and the three humps named. */
const headShoulders: OverlayTemplate = {
  name: HEAD_SHOULDERS,
  totalStep: 8,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ coordinates }) => {
    const cs = coordinates.slice(0, 7);
    const figs: Fig[] = [];
    const [p0, p1, p2, p3, p4, p5, p6] = cs;
    if (p0 && p1 && p2) figs.push(polygon([p0, p1, p2], paint.soft));
    if (p2 && p3 && p4) figs.push(polygon([p2, p3, p4], paint.fill));
    if (p4 && p5 && p6) figs.push(polygon([p4, p5, p6], paint.soft));
    if (cs.length > 1) figs.push(line(cs));
    if (p2 && p4 && p0 && p4.x !== p2.x) {
      const k = (p4.y - p2.y) / (p4.x - p2.x);
      const fromX = p0.x;
      const toX = (p6 ?? cs[cs.length - 1]!).x;
      figs.push(line([{ x: fromX, y: p2.y + k * (fromX - p2.x) }, { x: toX, y: p2.y + k * (toX - p2.x) }], dashed()));
    }
    const named: Array<[C | undefined, number, string]> = [
      [p1, 1, 'Left shoulder'],
      [p3, 3, 'Head'],
      [p5, 5, 'Right shoulder'],
    ];
    for (const [p, i, text] of named) {
      if (!p) continue;
      const up = isPeak(cs, i);
      figs.push(label(p.x, up ? p.y - 7 : p.y + 7, text, { align: 'center', baseline: up ? 'bottom' : 'top', family: FAMILY }));
    }
    return figs;
  },
};

// --- projection and measurement ------------------------------------------------

/**
 * Long / short position, the TradingView tool: entry at the first click, the
 * target at the second (whose time also sets the right edge), and the stop as a
 * third point that `finishDrawing` adds mirrored around the entry. Three handles
 * after that, and `constrainPosition` keeps them coherent as they are dragged.
 */
function positionTemplate(name: string, side: PositionSide): OverlayTemplate {
  return {
    name,
    totalStep: 3,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: true,
    createPointFigures: ({ chart, overlay, coordinates, bounding, yAxis }) => {
      const [e, t, s] = coordinates;
      const [ve, vt, vs] = values(overlay);
      if (!e || !t || !isNum(ve) || !isNum(vt)) return [];
      const { target, stop } = positionLevels(side, ve, vt, s ? vs : undefined);
      // While drawing, the second click may turn out to be the stop, and the
      // level it did not set is placed through the axis.
      const ty = target === vt ? t.y : yOf(yAxis, target, 2 * e.y - t.y);
      const sy = s ? s.y : stop === vt ? t.y : yOf(yAxis, stop, 2 * e.y - t.y);
      const left = Math.min(e.x, t.x);
      const right = Math.max(e.x, t.x);
      const mid = (left + right) / 2;
      const precision = precisionFor(chart, overlay, yAxis);
      const r = positionReading(ve, target, stop);
      const targetAbove = ty <= e.y;
      return [
        rect({ x: left, y: e.y }, { x: right, y: ty }, FILL_POS),
        rect({ x: left, y: e.y }, { x: right, y: sy }, FILL_NEG),
        line([{ x: left, y: e.y }, { x: right, y: e.y }], { style: 'solid', size: 1, color: T.canvasMuted }),
        ...readout([`Target ${fmtPrice(chart, target, precision)} (${fmtPct(r.targetPct)})`], mid, targetAbove ? ty - 4 : ty + 4, bounding, {
          align: 'center',
          place: targetAbove ? 'above' : 'below',
          bg: T.pos,
          fg: T.bg,
        }),
        ...readout([`Stop ${fmtPrice(chart, stop, precision)} (${fmtPct(r.stopPct)})`], mid, targetAbove ? sy + 4 : sy - 4, bounding, {
          align: 'center',
          place: targetAbove ? 'below' : 'above',
          bg: T.neg,
          fg: T.bg,
        }),
        ...readout([`R:R ${isNum(r.rr) ? r.rr.toFixed(2) : NONE}`], mid, e.y - 9, bounding, {
          align: 'center',
          place: 'below',
          bg: T.elevated,
          fg: T.canvasText,
          border: T.control,
        }),
      ];
    },
    performEventPressedMove: ({ points, performPointIndex }: OverlayPerformEventParams) => {
      constrainPosition(side, points, performPointIndex);
    },
  };
}

const longPosition = positionTemplate(LONG_POSITION, 'long');
const shortPosition = positionTemplate(SHORT_POSITION, 'short');

/** Colour of a reading's direction — the measure tool's rule. */
const directionColor = (d: 1 | -1 | 0 | null): string => (d === 1 ? T.pos : d === -1 ? T.neg : T.canvasMuted);

/** Price range: the band between two prices, an arrow up or down it, and the
 *  move in price and percent. */
const priceRange: OverlayTemplate = {
  name: PRICE_RANGE,
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ chart, overlay, coordinates, bounding, yAxis }) => {
    const [a, b] = coordinates;
    if (!a || !b) return [];
    const r = readMeasure(chart, overlay.points[0] ?? {}, overlay.points[1] ?? {}, precisionFor(chart, overlay, yAxis));
    const midX = (a.x + b.x) / 2;
    const figs: Fig[] = [
      rect(a, b, paint.fill),
      lines([
        [{ x: a.x, y: a.y }, { x: b.x, y: a.y }],
        [{ x: a.x, y: b.y }, { x: b.x, y: b.y }],
      ]),
    ];
    if (Math.abs(b.y - a.y) > 4) {
      const tip = { x: midX, y: b.y };
      const { head, base } = arrowHead({ x: midX, y: a.y }, tip, 8, 4);
      figs.push(line([{ x: midX, y: a.y }, base], solid(), true), { ...head, ignoreEvent: true });
    }
    const up = b.y <= a.y;
    figs.push(...readout([`${r.delta} (${r.pct})`], midX, up ? b.y - 6 : b.y + 6, bounding, {
      align: 'center',
      place: up ? 'above' : 'below',
      bg: directionColor(r.direction),
      fg: T.bg,
    }));
    return figs;
  },
};

/** Date range: the band between two times, an arrow across it, and the span in
 *  bars and clock time. */
const dateRange: OverlayTemplate = {
  name: DATE_RANGE,
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ chart, overlay, coordinates, bounding, yAxis }) => {
    const [a, b] = coordinates;
    if (!a || !b) return [];
    const r = readMeasure(chart, overlay.points[0] ?? {}, overlay.points[1] ?? {}, precisionFor(chart, overlay, yAxis));
    const midY = (a.y + b.y) / 2;
    const figs: Fig[] = [
      rect(a, b, paint.fill),
      lines([
        [{ x: a.x, y: a.y }, { x: a.x, y: b.y }],
        [{ x: b.x, y: a.y }, { x: b.x, y: b.y }],
      ]),
    ];
    if (Math.abs(b.x - a.x) > 4) {
      const { head, base } = arrowHead({ x: a.x, y: midY }, { x: b.x, y: midY }, 8, 4);
      figs.push(line([{ x: a.x, y: midY }, base], solid(), true), { ...head, ignoreEvent: true });
    }
    figs.push(...readout([`${r.bars}, ${r.span}`], (a.x + b.x) / 2, Math.max(a.y, b.y) + 6, bounding, {
      align: 'center',
      place: 'below',
      bg: T.elevated,
      fg: T.canvasText,
      border: T.control,
    }));
    return figs;
  },
};

// --- shapes --------------------------------------------------------------------

/** Rectangle between two corners. Its fill is hit-testable on purpose, so the
 *  whole box can be grabbed and moved. */
const rectangle: OverlayTemplate = {
  name: RECT,
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ coordinates }) => {
    const [a, b] = coordinates;
    if (!a || !b) return [];
    return [rect(a, b, paint.fill, paint.color)];
  },
};

/** Circle from its centre and a point on its edge. */
const circle: OverlayTemplate = {
  name: CIRCLE,
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ coordinates }) => {
    const [a, b] = coordinates;
    if (!a || !b) return [];
    return [
      {
        type: 'circle',
        attrs: { x: a.x, y: a.y, r: Math.hypot(b.x - a.x, b.y - a.y) },
        styles: { style: 'stroke_fill', color: paint.fill, borderColor: paint.color, borderSize: 1 },
      },
    ];
  },
};

/** Highlighter: a freehand stroke like the library's brush, but wide and
 *  translucent, for marking a region rather than drawing a line. */
const highlighter: OverlayTemplate = {
  name: HIGHLIGHTER,
  totalStep: 2,
  drawingMode: 'continuous',
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ coordinates }) => {
    if (coordinates.length < 2) return [];
    return [
      {
        type: 'line',
        attrs: { coordinates },
        styles: { style: 'solid', size: 10, color: paint.highlight, smooth: false, lineCap: 'round', lineJoin: 'round' },
      },
    ];
  },
};

/**
 * Path: an open polyline through as many clicks as the user makes, finished
 * with a double click or Enter (Chart.tsx `finishPath` re-creates it with the
 * clicks made so far - klinecharts only knows a fixed step count, so the
 * count here is the ceiling, not the requirement).
 */
const path: OverlayTemplate = {
  name: PATH,
  totalStep: PATH_MAX_POINTS + 1,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ coordinates }) => (coordinates.length > 1 ? [line(coordinates)] : []),
};

/** Text lines of a note, from its extendData. */
export function noteLines(extendData: unknown): string[] {
  const text = typeof extendData === 'string' ? extendData : '';
  const lines = text.split('\n').map((l) => l.trimEnd()).filter((l, i, all) => l !== '' || i < all.length - 1);
  return (lines.length ? lines : ['Note']).slice(0, 8).map((l) => (l.length > 48 ? `${l.slice(0, 47)}…` : l));
}

/**
 * Note: a short text pinned to a candle - one click places it, and the style
 * bar edits the words (they live in `extendData`, like klinecharts' own text
 * tool). The box hangs up and to the right of its anchor on a stem, dark
 * plate, drawn in the note's colour, so it reads on candles of either hue.
 */
const note: OverlayTemplate = {
  name: NOTE,
  totalStep: 2,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ coordinates, overlay, bounding }) => {
    const p = coordinates[0];
    if (!p) return [];
    const textLines = noteLines(overlay.extendData);
    const padX = 7;
    const padY = 5;
    const w = Math.max(...textLines.map((l) => textWidth(l, FAMILY))) + padX * 2;
    const h = padY * 2 + (textLines.length - 1) * LINE_H + FONT_SIZE + 1;
    let left = p.x + 10;
    if (left + w > bounding.width - 2) left = Math.max(2, p.x - 10 - w);
    let top = p.y - 18 - h;
    if (top < 2) top = Math.min(bounding.height - h - 2, p.y + 18);
    const stemTo = { x: left < p.x ? left + w : left, y: top < p.y ? top + h : top };
    return [
      line([p, stemTo], solid(), true),
      {
        type: 'rect',
        attrs: { x: left, y: top, width: w, height: h },
        styles: { style: 'stroke_fill', color: T.elevated, borderColor: paint.color, borderSize: 1, borderRadius: 3 },
      },
      ...textLines.map((text, i) =>
        label(left + padX, top + padY + i * LINE_H, text, { baseline: 'top', color: T.canvasText, family: FAMILY }),
      ),
    ];
  },
};

// --- registry ------------------------------------------------------------------

const TEMPLATES: OverlayTemplate[] = [
  path,
  note,
  infoLine,
  trendAngle,
  crossLine,
  arrow,
  fibExtension,
  fibTimeZone,
  fibFan,
  gannBox,
  gannFan,
  xabcd,
  abcd,
  triangle,
  elliottImpulse,
  elliottCorrection,
  headShoulders,
  longPosition,
  shortPosition,
  priceRange,
  dateRange,
  rectangle,
  circle,
  highlighter,
];

/** Every tool this file registers, with the label the rail shows and the hint
 *  the toolbar prints while it is armed. */
export const DRAWING_OVERLAYS: ReadonlyArray<{ name: string; label: string; hint: string }> = [
  { name: INFO_LINE, label: 'Info line', hint: 'click the start, then the end' },
  { name: TREND_ANGLE, label: 'Trend angle', hint: 'click the start, then the end' },
  { name: CROSS_LINE, label: 'Cross line', hint: 'click where the lines should cross' },
  { name: ARROW, label: 'Arrow', hint: 'click the tail, then the tip' },
  { name: FIB_EXTENSION, label: 'Fib extension', hint: 'click the trend start, the trend end, then the pullback' },
  { name: FIB_TIME_ZONE, label: 'Fib time zone', hint: 'click the start, then one unit later' },
  { name: FIB_FAN, label: 'Fib speed fan', hint: 'click the start, then the end of the move' },
  { name: GANN_BOX, label: 'Gann box', hint: 'click one corner, then the opposite corner' },
  { name: GANN_FAN, label: 'Gann fan', hint: 'click the origin, then the corner of the 1x1 box' },
  { name: XABCD, label: 'XABCD pattern', hint: 'click X, A, B, C, then D' },
  { name: ABCD, label: 'ABCD pattern', hint: 'click A, B, C, then D' },
  { name: TRIANGLE, label: 'Triangle', hint: 'click the three corners' },
  { name: ELLIOTT_IMPULSE, label: 'Elliott impulse wave', hint: 'click the six wave points, (0) to (5)' },
  { name: ELLIOTT_CORRECTION, label: 'Elliott correction wave', hint: 'click the four wave points, (0) to (C)' },
  { name: HEAD_SHOULDERS, label: 'Head and shoulders', hint: 'click the seven turning points, left to right' },
  { name: LONG_POSITION, label: 'Long position', hint: 'click the entry, then the target' },
  { name: SHORT_POSITION, label: 'Short position', hint: 'click the entry, then the target' },
  { name: PRICE_RANGE, label: 'Price range', hint: 'click the start price, then the end price' },
  { name: DATE_RANGE, label: 'Date range', hint: 'click the start, then the end' },
  { name: RECT, label: 'Rectangle', hint: 'click one corner, then the opposite corner' },
  { name: CIRCLE, label: 'Circle', hint: 'click the centre, then a point on the edge' },
  { name: HIGHLIGHTER, label: 'Highlighter', hint: 'drag across the chart' },
  { name: PATH, label: 'Path', hint: 'click each point; double-click or Enter to finish' },
  { name: NOTE, label: 'Note', hint: 'click where the note belongs, then type it in the style bar' },
];

/** Idempotent — the registry is module-global and keyed by name, so a second
 *  call replaces each template rather than duplicating it. */
export function registerDrawingOverlays(kc: typeof import('klinecharts')): void {
  measureText = kc.utils.calcTextWidth;
  for (const t of TEMPLATES) {
    const draw = t.createPointFigures;
    kc.registerOverlay(
      draw ?
        {
          ...t,
          // Drawing is synchronous, so the paint set here is the one every
          // helper reads for exactly this overlay's figures.
          createPointFigures: (params) => {
            paint = paintOf(params.overlay);
            try {
              return draw(params);
            } finally {
              paint = DEFAULT_PAINT;
            }
          },
        }
      : t,
    );
  }
}

/**
 * Called from onDrawEnd for every overlay.
 *
 *   - A position tool gets its third point, the stop, mirrored around the
 *     entry (or the second click becomes the stop, if it was on the losing side).
 *   - A highlighter stroke that never moved is one point with nothing drawn; it
 *     is removed rather than left as an invisible object to hunt for.
 *
 * Every other overlay is left alone.
 */
export function finishDrawing(chart: KChart, overlay: Overlay<unknown>): void {
  if (overlay.name === HIGHLIGHTER) {
    if (overlay.points.length < 2) chart.removeOverlay({ id: overlay.id });
    return;
  }
  if (overlay.name !== LONG_POSITION && overlay.name !== SHORT_POSITION) return;
  const [e, t] = overlay.points;
  if (!e || !t || overlay.points.length !== 2 || !isNum(e.value) || !isNum(t.value)) return;
  const side: PositionSide = overlay.name === LONG_POSITION ? 'long' : 'short';
  const { target, stop } = positionLevels(side, e.value, t.value);
  chart.overrideOverlay({
    id: overlay.id,
    points: [
      { ...e },
      { ...t, value: target },
      { timestamp: t.timestamp, dataIndex: t.dataIndex, value: stop },
    ],
  });
}

/**
 * The overlay `styles` for a drawing in one colour, width and dash - what the
 * style bar writes. Every figure type a drawing can contain gets the colour,
 * so the library's own tools (whose figures carry no colour of their own) and
 * ours (which read `paint`, above) restyle the same way; text tags take dark
 * or light ink by the fill's luminance.
 */
export function drawingStyles(color: string, size: number, dashedLine: boolean): Record<string, unknown> {
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(withAlpha(color, 1));
  const lum = rgb ? (0.2126 * Number(rgb[1]) + 0.7152 * Number(rgb[2]) + 0.0722 * Number(rgb[3])) / 255 : 1;
  return {
    line: { color, size, style: dashedLine ? 'dashed' : 'solid', dashedValue: [4, 3] },
    point: { color, borderColor: withAlpha(color, 0.35), activeColor: color, activeBorderColor: withAlpha(color, 0.35) },
    polygon: { color, borderColor: color },
    rect: { color: withAlpha(color, 0.14), borderColor: color },
    circle: { color: withAlpha(color, 0.14), borderColor: color },
    arc: { color },
    text: { color: lum > 0.55 ? T.bg : T.text, backgroundColor: color, borderColor: color },
  };
}

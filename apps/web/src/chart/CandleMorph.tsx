/**
 * The klinecharts plot's candle layer while it has no candles of its own: the
 * placeholder skeleton - the owner's reference chart, digitised (morph.ts,
 * skeletonSeries.ts) - and the morphs between it and real candles. The plan
 * and the maths live in morph.ts; this is the canvas half.
 *
 * FOUR PHASES, one engine. Every morph starts from exactly what the previous
 * frame drew, so a phase can take over from another mid-way without a jump:
 *
 *   out   a symbol or interval switch: the candles on screen - and the dotted
 *         last-price rule - turn into grey placeholders WHERE THEY STAND
 *         (colour only, RESTYLE_MS) while the old axes fade out with the plot;
 *   rest  the placeholders, shimmering, while the new series loads;
 *   in    the new bars have arrived: the candles grow into them, and the grey
 *         last-price rule glides to the new last price and takes its colour
 *         back, while the new axes fade in. If they arrive during `out`, `in`
 *         takes over from wherever the candles are, easing out of the motion
 *         already going;
 *   fade  a plain crossfade instead: reduced motion, or a series style (OHLC
 *         bars, the line) there are no candles to grow into.
 *
 * A first load has nothing to morph out of and starts at rest; a switch while
 * resting leaves the placeholders where they are.
 *
 * STACKING. The layer sits UNDER klinecharts' canvas (it comes first in the
 * pane and the holder is transparent) and is clipped to the candle pane's
 * drawing area. While it draws candles, klinecharts draws neither its candles
 * nor its grid (morph.ts, MORPH_HIDDEN) and this layer draws both - the grid
 * on its own canvas, the candles on one above it. So the order on screen is
 * exactly the finished chart's: grid, candles, the last-price rule (drawn by
 * this layer too while it owns the candles; klinecharts' is hidden), then
 * everything klinecharts paints over its candles (indicators, overlays,
 * crosshair), with the axes beside the plot.
 *
 * HOW THE HAND-OVER WORKS (Chart.tsx drives it):
 *   1. When a fresh series arrives, Chart.tsx applies MORPH_HIDDEN and hands
 *      the bars to the library in the same tick, so its scale, layout and
 *      axes are final before the plot is unmasked - there is never a 0-10
 *      scale on screen. The plot canvas fades in over ~the first half of the
 *      morph, which is how the axis labels arrive; the grid canvas here follows
 *      the plot's opacity frame by frame, so it arrives with them.
 *   2. Every frame this layer reads every visible bar's geometry through the
 *      library's own API (convertToPixel for index and price, getBarSpace for
 *      the body width) and the grid from the axes' ticks (morph.ts,
 *      gridLines), and draws each candle part-way to its bar. A live tick
 *      moves its bar's target; the morph simply follows.
 *   3. The landing frame is the library's own picture: its grid lines, its
 *      candles - same rects, same colour strings, same pixel grid.
 *   4. On the next frame `onLand` gives the library its candles and grid
 *      back, and paintNow (viewTween.ts) has it repaint inside that same
 *      frame; this layer clears itself straight after. `onDone` follows.
 *   The morph out is the same hand-over in reverse: on its first frame
 *   `onHide` takes klinecharts' candles and grid away (repainted in that
 *   frame) as this layer draws them in their place.
 *
 * Styles: chart.css, "candle layer".
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import type { Chart as KChart, Coordinate, KLineData, Point } from 'klinecharts';
import { onTheme } from '../theme';
import { CANDLE_PANE_ID, DEFAULT_BAR_SPACE, DEFAULT_OFFSET_RIGHT, NUM_FAMILY, chartStyles } from './theme';
import {
  candleGeom,
  direction,
  gridLines,
  matchSlots,
  morphFrame,
  morphProgress,
  outFrame,
  over,
  pairByRecency,
  parseColor,
  prefersReducedMotion,
  niceY,
  MORPH_OUT_TOTAL_MS,
  RESTYLE_MS,
  skeletonFor,
  spritesOf,
  toneOfDir,
  type DrawOp,
  type Geom,
  type MorphCurve,
  type Paint,
  type Palette,
  type Placeholder,
  type RGBA,
  type SkeletonCandle,
  type Target,
  type Tone,
} from './morph';
import { drawPriceLine, lerpLine, readPriceLine, type PriceLine } from './priceLine';
import { drawGrid } from './gridStroke';
import { paintNow } from './viewTween';
import { logger } from '../log';

const log = logger('chart');

/**
 * off       nothing (a chart is on screen, or the market has no candles)
 * skeleton  the placeholders: reached by the morph out on a switch
 * morph     the placeholders becoming the loaded candles
 * fade      a plain crossfade instead of either morph
 */
export type CandleLayerState = 'off' | 'skeleton' | 'morph' | 'fade';

export interface CandleMorphProps {
  state: CandleLayerState;
  chart: RefObject<KChart | null>;
  /**
   * The loading market's last price and price precision, when known. The
   * skeleton has to leave room for a price axis that does not exist yet, and
   * klinecharts sizes that axis to its labels.
   */
  priceHint: () => { price: number; precision: number } | null;
  /** klinecharts draws hollow candles ('candle_stroke'). */
  hollow: boolean;
  /** klinecharts draws candles (not OHLC bars or the line): a switch can morph
   *  them out. */
  morphable?: boolean;
  /** The layer is taking klinecharts' candles over (the morph out). */
  onHide?: () => void;
  /** The colour the last-price rule is drawn in this frame: klinecharts'
   *  badge on the price axis takes it too (grey on a switch, then the new
   *  price's colour on the rule's own progress). */
  onBadge?: (color: RGBA) => void;
  /** Give klinecharts its candles (and grid) back now. */
  onLand: () => void;
  /** The layer is clear. */
  onDone: () => void;
}

/** `.kc-morph.kc-morph-out` fades over 240ms (120ms with reduced motion). */
const FADE_DONE_MS = 300;
/** Price axis width when nothing better is known yet. */
const AXIS_FALLBACK = 48;
/** klinecharts sizes the price axis to its widest label: the last-price badge
 *  (12px/500, 4px padding either side) or a tick label (12px/400 with
 *  thousands separators, margins 4 + theme.ts's 7). */
const BADGE_PAD = 8;
const TICK_PAD = 11;

const X_AXIS_SIZE = typeof chartStyles.xAxis?.size === 'number' ? chartStyles.xAxis.size : 32;

const paletteNow = (): Palette => {
  const BAR = chartStyles.candle?.bar ?? {};
  return {
    up: { body: BAR.upColor ?? '#00b481', border: BAR.upBorderColor ?? '#00b481', wick: BAR.upWickColor ?? '#00b481' },
    down: { body: BAR.downColor ?? '#ef4a3c', border: BAR.downBorderColor ?? '#ef4a3c', wick: BAR.downWickColor ?? '#ef4a3c' },
    flat: { body: BAR.noChangeColor ?? '#c6b6ba', border: BAR.noChangeBorderColor ?? '#c6b6ba', wick: BAR.noChangeWickColor ?? '#c6b6ba' },
  };
};
const PALETTE: Palette = paletteNow();
onTheme(() => { Object.assign(PALETTE, paletteNow()); });

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Plan {
  /** Where the skeleton's plot is, relative to the layer. */
  rect: Rect;
  candles: ReadonlyArray<Pick<SkeletonCandle, 'geom' | 'tone'>>;
  /** Opaque tones per direction, and the brighter copies the shimmer shows. */
  tones: Record<Tone, RGBA>;
  lifted: Record<Tone, RGBA>;
  /** A switch: `candles` are the candles that were on screen, where they
   *  stood (not the reference skeleton), restyled in place. */
  inPlace?: boolean;
  /** The skeleton's own last-price rule (a first load): the row of its
   *  newest candle's close. A switch keeps the rule that was on screen. */
  line?: number;
}

type Phase = 'idle' | 'out' | 'rest' | 'in';

const mainDom = (c: KChart | null): HTMLElement | null => c?.getDom(CANDLE_PANE_ID, 'main') ?? null;

let measureCtx: CanvasRenderingContext2D | null = null;
function textWidth(text: string, weight: number): number {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (!measureCtx) return text.length * 7;
  measureCtx.font = `${weight} 12px ${NUM_FAMILY}`;
  return Math.round(measureCtx.measureText(text).width);
}

/** The price axis a series around `price` will get (see TICK_PAD). */
function axisWidthFor(price: number, precision: number): number {
  const fixed = price.toFixed(Math.max(0, Math.min(12, precision)));
  const [int = '', frac] = fixed.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? `.${frac}` : '');
  return Math.max(textWidth(fixed, 500) + BADGE_PAD, textWidth(grouped, 400) + TICK_PAD);
}

/** The candle pane's drawing area relative to `box`, or null before init. */
function mainRect(c: KChart | null, box: HTMLElement): Rect | null {
  const dom = mainDom(c);
  if (!dom) return null;
  const r = dom.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  return { left: Math.round(r.left - b.left), top: Math.round(r.top - b.top), width: r.width, height: r.height };
}

/** klinecharts' x-axis pane (PaneIdConstants.X_AXIS): it has no grid of its own. */
const X_AXIS_PANE = 'x_axis_pane';

/** Every pane with a plot of its own (the candle pane and indicator panes). */
function plotPanes(c: KChart): string[] {
  try {
    const all = c.getPaneOptions();
    const list = Array.isArray(all) ? all : all ? [all] : [];
    return list.map((p) => p.id).filter((id): id is string => !!id && id !== X_AXIS_PANE);
  } catch {
    return [CANDLE_PANE_ID];
  }
}

/** A pane's drawing area relative to `box`, or null when it has none. */
function paneRect(c: KChart, paneId: string, box: HTMLElement): Rect | null {
  const dom = c.getDom(paneId, 'main');
  if (!dom) return null;
  const r = dom.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  return { left: Math.round(r.left - b.left), top: Math.round(r.top - b.top), width: r.width, height: r.height };
}

function readColor(el: HTMLElement, name: string, fallback: RGBA): RGBA {
  return parseColor(getComputedStyle(el).getPropertyValue(name)) ?? fallback;
}

/**
 * Size a canvas to `r` and clear it. The backing store copies `like` - the
 * klinecharts canvas it has to match pixel for pixel - when given (the library
 * may take its size from the device-pixel content box, which can differ from
 * a rounded width x ratio by a pixel), else the device pixel ratio.
 */
function fit(canvas: HTMLCanvasElement, r: Rect, like?: HTMLCanvasElement | null): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1;
  const pw = like && like.width > 0 ? like.width : Math.round(r.width * dpr);
  const ph = like && like.height > 0 ? like.height : Math.round(r.height * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const w = `${r.width}px`;
  const h = `${r.height}px`;
  if (canvas.style.width !== w) canvas.style.width = w;
  if (canvas.style.height !== h) canvas.style.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, pw, ph);
  ctx.setTransform(pw / r.width, 0, 0, ph / r.height, 0, 0);
  return ctx;
}

function place(el: HTMLElement, r: Rect): void {
  el.style.left = `${r.left}px`;
  el.style.top = `${r.top}px`;
  el.style.width = `${r.width}px`;
  el.style.height = `${r.height}px`;
}

function clear(canvas: HTMLCanvasElement | null): void {
  const g = canvas?.getContext('2d');
  if (!canvas || !g) return;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, canvas.width, canvas.height);
}

type RectFn = (x: number, y: number, w: number, h: number, r?: number) => void;

/**
 * One candle, drawn the way klinecharts' drawRect draws it: path + fill for
 * the wick and the body, then the body's 1px border stroked half a pixel in.
 * Identical calls on an identical pixel grid are what make the landing frame
 * indistinguishable from the library's own.
 */
function drawCandle(ctx: CanvasRenderingContext2D, g: Geom, paint: Paint, hollow: boolean, fill: number): void {
  const rect: RectFn = (ctx.roundRect ?? ctx.rect) as RectFn;
  const box = (x: number, y: number, w: number, h: number) => {
    ctx.beginPath();
    rect.call(ctx, x, y, w, h, 0);
    ctx.closePath();
    ctx.fill();
  };
  ctx.fillStyle = paint.wick;
  if (hollow) {
    box(g.x, g.wickTop, 1, g.bodyTop - g.wickTop);
    box(g.x, g.bodyBottom, 1, g.wickTop + g.wickHeight - g.bodyBottom);
  } else {
    box(g.x, g.wickTop, 1, g.wickHeight);
  }
  if (fill > 0) {
    const alpha = ctx.globalAlpha;
    ctx.globalAlpha = alpha * fill;
    ctx.fillStyle = paint.body;
    box(g.bodyLeft, g.bodyTop, g.bodyWidth, g.bodyHeight);
    ctx.globalAlpha = alpha;
  }
  ctx.strokeStyle = paint.border;
  ctx.fillStyle = paint.border;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  if (g.bodyWidth > 2 && g.bodyHeight > 2) {
    ctx.beginPath();
    rect.call(ctx, g.bodyLeft + 0.5, g.bodyTop + 0.5, g.bodyWidth - 1, g.bodyHeight - 1, 0);
    ctx.closePath();
    ctx.stroke();
  } else if (hollow) {
    ctx.fillRect(g.bodyLeft, g.bodyTop, g.bodyWidth, g.bodyHeight);
  }
}

function drawOps(ctx: CanvasRenderingContext2D, ops: readonly DrawOp[], hollow: boolean): void {
  for (const op of ops) {
    ctx.globalAlpha = op.alpha;
    // A hollow landing: the grey fill thins out as the candle arrives.
    drawCandle(ctx, op.geom, op.paint, hollow, hollow ? 1 - op.e : 1);
  }
  ctx.globalAlpha = 1;
}

/** Every visible bar as klinecharts draws it this frame, oldest first. */
function readTargets(c: KChart): Target[] {
  const list: KLineData[] = c.getDataList();
  const range = c.getVisibleRange();
  const from = Math.max(0, range.realFrom);
  const to = Math.min(list.length, range.realTo);
  if (to <= from) return [];
  const pts: Array<Partial<Point>> = [];
  for (let i = from; i < to; i++) {
    const d = list[i]!;
    pts.push({ dataIndex: i, value: d.open }, { value: d.close }, { value: d.high }, { value: d.low });
  }
  const px = c.convertToPixel(pts, { paneId: CANDLE_PANE_ID }) as Array<Partial<Coordinate>>;
  const barSpace = c.getBarSpace().bar;
  const out: Target[] = [];
  for (let j = 0, i = from; i < to; i++, j += 4) {
    const d = list[i]!;
    const x = px[j]?.x;
    const ys = [px[j]?.y, px[j + 1]?.y, px[j + 2]?.y, px[j + 3]?.y];
    if (typeof x !== 'number' || !ys.every((y): y is number => typeof y === 'number' && Number.isFinite(y))) continue;
    out.push({ index: i, geom: candleGeom(x, ys, barSpace), dir: direction(d.open, d.close) });
  }
  return out;
}

const shift = (g: Geom, dx: number, dy: number): Geom =>
  dx === 0 && dy === 0
    ? g
    : { ...g, x: g.x + dx, bodyLeft: g.bodyLeft + dx, wickTop: g.wickTop + dy, bodyTop: g.bodyTop + dy, bodyBottom: g.bodyBottom + dy };

const cssRgb = (c: RGBA) => `rgb(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])})`;

/** The placeholder tone for a candle known only by its colour (a morph caught
 *  mid-way): whichever of the up/down colours it is nearer to. */
function toneOf(c: RGBA): Tone {
  const up = parseColor(PALETTE.up.body);
  const down = parseColor(PALETTE.down.body);
  if (!up || !down) return 'down';
  const d = (a: RGBA, b: RGBA) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  return d(c, up) <= d(c, down) ? 'up' : 'down';
}

/** klinecharts has candles on screen that a switch could morph out. */
function chartShowsCandles(c: KChart | null): boolean {
  return !!c && c.getDataList().length > 0 && !!mainDom(c);
}

export function CandleMorph({ state, chart, priceHint, hollow, morphable = true, onHide, onBadge, onLand, onDone }: CandleMorphProps) {
  const box = useRef<HTMLDivElement>(null);
  const gridCanvas = useRef<HTMLCanvasElement>(null);
  /** The indicator panes' grids, one canvas per pane (the candle pane's is gridCanvas). */
  const paneGrids = useRef(new Map<string, HTMLCanvasElement>());
  const base = useRef<HTMLCanvasElement>(null);
  const glintBox = useRef<HTMLDivElement>(null);
  const glint = useRef<HTMLCanvasElement>(null);
  const plan = useRef<Plan | null>(null);
  const cb = useRef({ priceHint, onHide, onBadge, onLand, onDone, hollow });
  cb.current = { priceHint, onHide, onBadge, onLand, onDone, hollow };
  const engine = useRef({
    phase: 'idle' as Phase,
    raf: 0,
    /** What the last frame drew: where the next morph starts. */
    sprites: [] as Placeholder[],
    /** The last-price rule as the last frame drew it (null: none drawn). */
    line: null as PriceLine | null,
    /** klinecharts' candles are hidden because this layer took them over. */
    holding: false,
  });

  /*
   * Does this layer open with a morph out? Decided while rendering the frame
   * it appears in, so the layer can skip its fade-in (the candles it draws
   * replace klinecharts' own in that same frame and must not flash).
   */
  const lastState = useRef<CandleLayerState>('off');
  const opensWithOut = useRef(false);
  if (state !== lastState.current) {
    if (state === 'skeleton' && (lastState.current === 'off' || lastState.current === 'morph')) {
      opensWithOut.current =
        morphable && !prefersReducedMotion() && (lastState.current === 'morph' ? engine.current.sprites.length > 0 : chartShowsCandles(chart.current));
    } else if (state !== 'skeleton') {
      opensWithOut.current = false;
    }
    lastState.current = state;
  }

  const stopLoop = () => {
    const e = engine.current;
    if (e.raf) cancelAnimationFrame(e.raf);
    e.raf = 0;
  };

  const land = () => {
    const e = engine.current;
    if (!e.holding) return;
    e.holding = false;
    cb.current.onLand();
  };

  /** Where the placeholders go, for the layer's current size. On a switch the
   *  plot on screen is the best guess; on a first load, the axis the loading
   *  market will get. */
  const layout = (preferCurrent: boolean): Plan | null => {
    const el = box.current;
    if (!el) return null;
    const bw = el.clientWidth;
    const bh = el.clientHeight;
    if (bw <= 0 || bh <= 0) return null;
    const c = chart.current;
    const main = mainRect(c, el);
    const hint = cb.current.priceHint();
    const axis =
      preferCurrent && main
        ? bw - main.left - main.width
        : hint && Number.isFinite(hint.price)
          ? axisWidthFor(hint.price, hint.precision)
          : main && c && c.getDataList().length > 0
            ? bw - main.left - main.width
            : AXIS_FALLBACK;
    const rect: Rect = {
      left: main?.left ?? 0,
      top: main?.top ?? 0,
      width: Math.max(0, bw - (main?.left ?? 0) - axis),
      height: main?.height ?? Math.max(0, bh - X_AXIS_SIZE),
    };
    const panel = readColor(el, '--bg-panel', [26, 26, 27, 1]);
    const soft = readColor(el, '--line-soft', [255, 255, 255, 0.1]);
    const strong = readColor(el, '--line-strong', [255, 255, 255, 0.2]);
    // Two tones from the skeleton tokens - down the quieter, up the lighter,
    // so the reference's rhythm reads - and a shimmer that lifts each one by
    // another --line-soft.
    const tones: Record<Tone, RGBA> = { down: over(soft, panel), up: over(strong, panel) };
    const lifted: Record<Tone, RGBA> = { down: over(soft, tones.down), up: over(soft, tones.up) };
    // The skeleton stands on the grid the bars will land on: klinecharts'
    // current pitch, the newest candle where the load will put the newest bar.
    const bar = c?.getBarSpace().bar;
    const off = c?.getOffsetRightDistance();
    const candles = skeletonFor({
      width: rect.width,
      height: rect.height,
      barSpace: typeof bar === 'number' && bar > 0 ? bar : DEFAULT_BAR_SPACE,
      offsetRight: typeof off === 'number' && Number.isFinite(off) ? off : DEFAULT_OFFSET_RIGHT,
    });
    const newest = candles[candles.length - 1];
    return { rect, candles, tones, lifted, line: newest ? niceY(newest.closeY, rect.height) : undefined };
  };

  /** The placeholders standing still, shimmering. */
  const rest = (p: Plan) => {
    const cv = base.current;
    const gb = glintBox.current;
    const gv = glint.current;
    if (!cv || !gb || !gv) return;
    stopLoop();
    engine.current.phase = 'rest';
    engine.current.sprites = p.candles.map((k) => ({ geom: k.geom, color: p.tones[k.tone], tone: k.tone }));
    place(cv, p.rect);
    place(gb, p.rect);
    const paint = (ctx: CanvasRenderingContext2D | null, colors: Record<Tone, RGBA>) => {
      if (!ctx) return;
      const byTone: Record<Tone, Paint> = {
        up: { body: cssRgb(colors.up), border: cssRgb(colors.up), wick: cssRgb(colors.up) },
        down: { body: cssRgb(colors.down), border: cssRgb(colors.down), wick: cssRgb(colors.down) },
      };
      for (const k of p.candles) drawCandle(ctx, k.geom, byTone[k.tone], false, 1);
    };
    const ctx = fit(cv, p.rect);
    paint(ctx, p.tones);
    // The last-price rule, grey like the candles: a switch keeps the one that
    // was on screen where it was; a first load's skeleton has its own, on its
    // newest candle's close. The shimmer lights it with the candles.
    const e = engine.current;
    if (!e.line && p.line !== undefined) e.line = { y: p.line, color: p.tones.up };
    const line = e.line;
    if (ctx && line) {
      drawPriceLine(ctx, p.rect.width, line.y, p.tones.up);
      e.line = { y: line.y, color: p.tones.up };
    }
    const lit = fit(gv, p.rect);
    paint(lit, p.lifted);
    if (lit && line) drawPriceLine(lit, p.rect.width, line.y, p.lifted.up);
    // A switch keeps the frame: the old series' grid stays where it was. A
    // first load has no grid to show yet (the plot is masked).
    const c = chart.current;
    if (p.inPlace && c && c.getDataList().length) grid(c);
    else clearGrids();
    if (line) cb.current.onBadge?.(p.tones.up);
    gb.classList.remove('kc-off');
  };

  /**
   * Every pane's grid, as klinecharts would draw it now, each on a canvas laid
   * exactly over that pane (the library's own grid is hidden while this layer
   * owns the candles - it is one style for all panes), at the plot's current
   * opacity: on a switch the plot stays, so the grid stays; on a first load it
   * arrives with the plot.
   */
  const grid = (c: KChart) => {
    const el = box.current;
    const gc = gridCanvas.current;
    if (!el || !gc) return;
    const holder = mainDom(c)?.closest<HTMLElement>('.chartholder') ?? null;
    const opacity = holder ? getComputedStyle(holder).opacity : '1';
    const seen = new Set<string>();
    for (const id of plotPanes(c)) {
      const rect = paneRect(c, id, el);
      if (!rect) continue;
      let cv = id === CANDLE_PANE_ID ? gc : paneGrids.current.get(id);
      if (!cv) {
        cv = document.createElement('canvas');
        cv.className = 'kc-morph-grid';
        paneGrids.current.set(id, cv);
      }
      if (cv.parentElement !== el) el.insertBefore(cv, base.current);
      seen.add(id);
      place(cv, rect);
      const ctx = fit(cv, rect, c.getDom(id, 'main')?.querySelector('canvas'));
      const lines = gridLines(c, id);
      if (ctx && lines) drawGrid(ctx, lines, rect.width, rect.height);
      cv.style.opacity = opacity;
    }
    for (const [id, cv] of paneGrids.current) {
      if (seen.has(id)) continue;
      cv.remove();
      paneGrids.current.delete(id);
    }
  };
  const clearGrids = () => {
    clear(gridCanvas.current);
    for (const cv of paneGrids.current.values()) clear(cv);
  };

  /** A switch: the candles on screen settle into the placeholders. */
  const morphOut = (p: Plan, from: Placeholder[]) => {
    const el = box.current;
    const cv = base.current;
    const c = chart.current;
    if (!el || !cv || !c || !from.length) {
      rest(p);
      return;
    }
    stopLoop();
    glintBox.current?.classList.add('kc-off');
    const e = engine.current;
    const interrupted = e.phase === 'in';
    e.phase = 'out';
    const to: Placeholder[] = p.candles.map((k) => ({ geom: k.geom, color: p.tones[k.tone], tone: k.tone }));
    /** The last-price rule as the switch found it: it greys on the candles'
     *  own clock - same curve, same duration, no stagger. */
    const line0 = e.line;
    const curve: MorphCurve = interrupted ? 'out' : 'inOut';
    const restyleMs = p.inPlace ? RESTYLE_MS : MORPH_OUT_TOTAL_MS;
    let t0 = -1;
    let pairs: Map<number, number> | null = null;
    log.debug(interrupted ? 'morph in interrupted by a switch: morphing out from mid-way' : 'morph out (switch)', { candles: from.length });
    const frame = (now: number) => {
      e.raf = 0;
      if (chart.current !== c) return;
      const real = mainRect(c, el) ?? p.rect;
      if (t0 < 0) {
        t0 = now;
        // Take klinecharts' candles and grid over in this same frame.
        if (!e.holding) {
          e.holding = true;
          paintNow(() => cb.current.onHide?.());
        }
      }
      // The placeholders are laid out for the plan's rect; this frame draws
      // in the plot's.
      const dx = p.rect.left - real.left;
      const dy = p.rect.top - real.top;
      const toHere = dx || dy ? to.map((s) => ({ ...s, geom: shift(s.geom, dx, dy) })) : to;
      // The in-morph's pairing run the other way: every candle on screen asks
      // for its nearest placeholder (candle index -> placeholder index).
      pairs ??= matchSlots(
        toHere.map((s) => s.geom.x),
        from.map((s, i) => ({ index: i, x: s.geom.x })),
        c.getBarSpace().bar * 1.5,
      );
      place(cv, real);
      const like = mainDom(c)?.querySelector('canvas');
      const ctx = fit(cv, real, like);
      grid(c);
      if (!ctx) {
        rest(p);
        return;
      }
      const { ops, done } = outFrame({
        from,
        to: toHere,
        pairs,
        elapsed: now - t0,
        width: real.width,
        curve,
        // A switch restyles in place: colour only, quick, all at once.
        ...(p.inPlace ? { ms: RESTYLE_MS, stagger: 0 } : {}),
      });
      drawOps(ctx, ops, false);
      e.sprites = spritesOf(ops, p.tones.down);
      if (line0) {
        const l = lerpLine(line0, { y: line0.y, color: p.tones.up }, done ? 1 : morphProgress(now - t0, curve, restyleMs));
        drawPriceLine(ctx, real.width, l.y, l.color);
        e.line = l;
        cb.current.onBadge?.(l.color);
      }
      if (done) rest(p);
      else e.raf = requestAnimationFrame(frame);
    };
    e.raf = requestAnimationFrame(frame);
  };

  /** The bars are in: the candles grow into them, from wherever they are. */
  const morphIn = () => {
    const el = box.current;
    const cv = base.current;
    const c = chart.current;
    const e = engine.current;
    const p = plan.current ?? (plan.current = layout(false));
    if (!el || !cv || !c || !p) {
      land();
      cb.current.onDone();
      return;
    }
    const retarget = e.phase === 'out' && e.sprites.length > 0;
    const from: Placeholder[] = retarget || e.phase === 'in' ? e.sprites : p.candles.map((k) => ({ geom: k.geom, color: p.tones[k.tone], tone: k.tone }));
    stopLoop();
    glintBox.current?.classList.add('kc-off');
    e.phase = 'in';
    // The bars went in with klinecharts' candles hidden (Chart.tsx); this
    // layer owes them back.
    e.holding = true;
    const curve: MorphCurve = retarget ? 'out' : 'inOut';
    if (retarget) log.debug('new bars arrived during the morph out: morphing in from mid-way');
    let t0 = -1;
    let rect = p.rect;
    let skeleton: Placeholder[] = from;
    let partner: Map<number, number> | null = null;
    /** The grey last-price rule - the skeleton's own on a first load, the old
     *  market's on a switch, or wherever a morph out left it. It glides to
     *  the new last price and takes its colour back on the candles' own
     *  progress, so it stays on the newest candle's close all the way. */
    const line0 = e.line;
    /** Where line0 stands in the plot this frame (see the skeleton shift). */
    let lineFrom = line0;

    /** Give klinecharts its candles and grid back and clear this layer, all
     *  inside this frame (header, step 4). */
    const handOver = () => {
      e.raf = 0;
      paintNow(land, () => {
        clear(cv);
        clearGrids();
        e.phase = 'idle';
        e.sprites = [];
        e.line = null;
        cb.current.onDone();
      });
    };

    const frame = (now: number) => {
      e.raf = 0;
      if (chart.current !== c) {
        land();
        cb.current.onDone();
        return;
      }
      if (t0 < 0) t0 = now;
      const real = mainRect(c, el);
      if (!real) {
        land();
        cb.current.onDone();
        return;
      }
      if (!retarget && (real.left !== rect.left || real.top !== rect.top)) {
        // The skeleton was laid out against an estimated plot; keep it - and
        // its rule - where they are on screen while the canvas moves onto the
        // real one.
        const dx = p.rect.left - real.left;
        const dy = p.rect.top - real.top;
        skeleton = from.map((s) => ({ ...s, geom: shift(s.geom, dx, dy) }));
        lineFrom = line0 ? { ...line0, y: line0.y + dy } : null;
      }
      rect = real;
      place(cv, real);
      // The library's candle canvas is the first in its main widget.
      const like = mainDom(c)?.querySelector('canvas');
      const ctx = fit(cv, real, like);
      if (!ctx) {
        land();
        cb.current.onDone();
        return;
      }
      grid(c);
      const targets = readTargets(c);
      // Pairs are made once, on the bars the morph starts from, by recency:
      // the newest candle on screen becomes the newest bar, and the rest move
      // with it (morph.ts, pairByRecency). A bar that arrives later has no
      // partner and fades in.
      if (!partner) {
        partner = pairByRecency(
          skeleton.map((s) => ({ x: s.geom.x, alpha: s.alpha })),
          targets.map((t) => ({ index: t.index, x: t.geom.x })),
          c.getBarSpace().bar * (retarget ? 1.5 : 1),
        );
        if (!partner.size && targets.length && skeleton.length) {
          log.warn('morph: no bar found a candle to grow from; the bars fade in', { bars: targets.length, candles: skeleton.length });
        }
      }
      const elapsed = now - t0;
      const { ops, done } = morphFrame({ skeleton, partner, targets, palette: PALETTE, elapsed, curve });
      drawOps(ctx, ops, cb.current.hollow);
      e.sprites = spritesOf(ops, p.tones.down);
      // The last-price rule, on top of the candles as klinecharts draws it,
      // the same way along as every candle. On the landing frame it is
      // exactly klinecharts' own (same nice pixel, same colour), which takes
      // over in the next frame with the candles.
      const target = readPriceLine(c, real.height);
      if (target) {
        const le = done ? 1 : morphProgress(elapsed, curve);
        if (lineFrom) {
          const l = lerpLine(lineFrom, target, le);
          drawPriceLine(ctx, real.width, l.y, l.color);
          e.line = l;
          cb.current.onBadge?.(l.color);
        } else {
          drawPriceLine(ctx, real.width, target.y, target.color, le);
          e.line = le >= 1 ? target : null;
        }
      }
      e.raf = requestAnimationFrame(done ? handOver : frame);
    };
    e.raf = requestAnimationFrame(frame);
  };

  // Phase changes follow the state Chart.tsx computes.
  useLayoutEffect(() => {
    const e = engine.current;
    if (state === 'skeleton') {
      if (opensWithOut.current) {
        opensWithOut.current = false;
        const c = chart.current;
        // A switch (pair or timeframe): the candles on screen - or wherever an
        // interrupted morph had got to - turn into placeholders WHERE THEY
        // STAND (colour and style only, owner's spec), wait there, and grow
        // into the new bars when they arrive (morphIn starts from them).
        let from: Placeholder[] = [];
        let tones: Tone[] = [];
        if (e.phase === 'in' && e.sprites.length) {
          from = e.sprites;
          tones = from.map((s) => s.tone ?? toneOf(s.color));
        } else if (c) {
          const targets = readTargets(c);
          from = targets.map((t) => ({ geom: t.geom, color: parseColor(PALETTE[t.dir].body) ?? [128, 128, 128, 1], tone: toneOfDir(t.dir) }));
          tones = targets.map((t) => (t.dir === 'up' ? 'up' : 'down'));
        }
        const base = layout(true);
        const p: Plan | null =
          base && from.length
            ? { ...base, inPlace: true, line: undefined, candles: from.map((s, i) => ({ geom: s.geom, tone: tones[i] ?? 'down' })) }
            : base;
        // The last-price rule goes grey where it stands too - unless a morph
        // in was interrupted, in which case it continues from where it is.
        if (!(e.phase === 'in' && e.line)) e.line = c && base && from.length ? readPriceLine(c, base.rect.height) : null;
        plan.current = p;
        log.debug('switch: restyling the candles on screen into placeholders', { candles: from.length });
        if (p) morphOut(p, from);
      } else if (e.phase !== 'out' && e.phase !== 'rest') {
        // First load: the reference skeleton, and no last-price rule yet.
        e.line = null;
        const p = layout(false);
        plan.current = p;
        if (p) rest(p);
      }
    } else if (state === 'morph') {
      morphIn();
    } else if (state === 'fade') {
      stopLoop();
      e.phase = 'idle';
      e.line = null;
      glintBox.current?.classList.add('kc-off');
      land();
      const t = window.setTimeout(() => cb.current.onDone(), FADE_DONE_MS);
      return () => window.clearTimeout(t);
    } else {
      // Off: nothing to draw (a chart is on screen, or the market is empty).
      if (e.raf) log.debug('candle layer closed mid-morph', { phase: e.phase });
      stopLoop();
      e.phase = 'idle';
      e.sprites = [];
      e.line = null;
      land();
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // While resting, follow the plot's size.
  useEffect(() => {
    if (state !== 'skeleton') return;
    const el = box.current;
    if (!el) return;
    let w = el.clientWidth;
    let h = el.clientHeight;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === w && el.clientHeight === h) return;
      w = el.clientWidth;
      h = el.clientHeight;
      if (engine.current.phase !== 'rest') return;
      // A switch's placeholders are the old candles where they stood; a new
      // layout would swap them for the reference skeleton. Keep them.
      if (plan.current?.inPlace) return;
      const p = layout(false);
      plan.current = p;
      // The skeleton's rule moves with its newest candle.
      engine.current.line = null;
      if (p) rest(p);
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Unmount (the layer is off): never leave the library's candles hidden
  // behind a layer that is no longer drawing them.
  useEffect(
    () => () => {
      const e = engine.current;
      if (e.raf) log.debug('candle layer closed mid-morph', { phase: e.phase });
      stopLoop();
      e.phase = 'idle';
      e.sprites = [];
      e.line = null;
      land();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  if (state === 'off') return null;
  return (
    <div
      className={`kc-morph${state === 'fade' ? ' kc-morph-out' : ''}${opensWithOut.current ? ' kc-morph-cut' : ''}`}
      ref={box}
      aria-hidden="true"
    >
      <canvas className="kc-morph-grid" ref={gridCanvas} />
      <canvas className="kc-morph-candles" ref={base} />
      <div className="kc-morph-glint" ref={glintBox}>
        <div className="kc-skel-glint">
          <canvas ref={glint} />
        </div>
      </div>
    </div>
  );
}

/**
 * One smooth camera move for the chart's view controls: double-click reset,
 * the status bar's jump-to-latest, the zoom buttons, and the footer's A.
 *
 * WHAT IT MOVES. The visible window, as one thing: its two edges, measured in
 * bars from the newest bar, move linearly under one eased clock from where
 * they are to where they should be. Bar space (width / window) and the right
 * offset in pixels (a ratio of two linear functions) each converge
 * monotonically - one motion, no overshoot - and a point that sits at the
 * same pixel at both ends (the plot centre for the zoom buttons) stays there.
 * When asked, the price axis moves on the same clock (a YMotion - yScale.ts'
 * PriceFit): from whatever range it showed, auto-fitted or dragged by hand,
 * to the range the destination view fits.
 *
 * WHY IT LOOKED LAGGY, measured frame by frame on the loaded trade page
 * (chartqa v2, candle draws logged per frame): klinecharts never paints
 * synchronously. A change schedules a layout in a microtask, and the layout
 * asks requestAnimationFrame for each canvas it dirtied. From inside an
 * animation frame that request lands in the NEXT frame - after the tween's
 * own next step, which was registered earlier. So the next frame ran the
 * step first (a new state; its paint request swallowed, one being pending)
 * and then painted, and the frame after that painted nothing. Every tween
 * showed one frame in two: at 60 Hz the chart moved at 30 fps with every
 * frame's motion doubled up (a mid candle drawn moving 0, 10, 0, 13, 0 px
 * where the curve said 4, 6.5, 8, 5.2, 2.5), and the price axis jumped as
 * highs and lows entered the window. paintNow() makes klinecharts paint in
 * the frame that moved it, once; PriceFit makes the axis part of the motion.
 *
 * `scrollByDistance` rather than `setOffsetRightDistance` on the way: the
 * latter also rewrites the store's "initial" right offset, which every later
 * load and jump-to-latest would inherit. Only the final frame of a move that
 * ends on the default view uses it, with the default value, so the resting
 * state is bit-for-bit what a fresh chart shows.
 *
 * The maths is pure and unit-tested (viewTween.test.ts); `ViewTween` at the
 * bottom is the small rAF driver Chart.tsx owns.
 */
import type { Chart as KChart, Coordinate } from 'klinecharts';
import { CANDLE_PANE_ID, DEFAULT_BAR_SPACE, DEFAULT_OFFSET_RIGHT } from './theme';
import { logger } from '../log';

const log = logger('chart');

/** Where the chart is looking. */
export interface View {
  /** Pixels per bar (klinecharts' `getBarSpace().bar`). */
  barSpace: number;
  /**
   * How far the newest bar sits from the plot's right edge, in BARS - the
   * library's own model of the scroll position. Positive leaves a gap on the
   * right (the default view: DEFAULT_OFFSET_RIGHT px); negative means the
   * user has scrolled back into history.
   */
  rightBars: number;
}

/** One move, start to rest: long enough to read as one deliberate motion
 *  across a large jump, short enough not to feel like a wait. */
export const TWEEN_MS = 420;

/** klinecharts' default `layout.barSpaceLimit`; setBarSpace ignores values
 *  outside it, so targets are clamped here instead of silently stalling. */
export const BAR_SPACE_MIN = 1;
export const BAR_SPACE_MAX = 50;

export const easeInOutCubic = (t: number): number => {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
};

/**
 * A CSS cubic-bezier timing function: the same curve a transition with
 * `cubic-bezier(x1, y1, x2, y2)` follows. Newton steps with a bisection
 * fallback; exact 0 and 1 at the ends.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const X = (s: number) => ((ax * s + bx) * s + cx) * s;
  const Y = (s: number) => ((ay * s + by) * s + cy) * s;
  const dX = (s: number) => (3 * ax * s + 2 * bx) * s + cx;
  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let s = t;
    for (let i = 0; i < 8; i++) {
      const err = X(s) - t;
      if (Math.abs(err) < 1e-9) return Y(s);
      const d = dX(s);
      if (Math.abs(d) < 1e-9) break;
      s = Math.min(1, Math.max(0, s - err / d));
    }
    let lo = 0;
    let hi = 1;
    s = t;
    for (let i = 0; i < 50; i++) {
      const x = X(s);
      if (Math.abs(x - t) < 1e-9) break;
      if (x < t) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return Y(s);
  };
}

/**
 * The move's easing: CSS `ease`, cubic-bezier(0.25, 0.1, 0.25, 1). It leaves
 * at once (the first frame covers ~60% of an even frame's distance, where the
 * ease-in-out this replaces covered 1% and read as a pause after the click),
 * peaks early, and lands with zero velocity - no jolt at either end.
 */
export const easeView = cubicBezier(0.25, 0.1, 0.25, 1);

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Exactly what a freshly loaded chart shows. */
export const defaultView = (): View => ({
  barSpace: DEFAULT_BAR_SPACE,
  rightBars: DEFAULT_OFFSET_RIGHT / DEFAULT_BAR_SPACE,
});

/** Same zoom, newest bar back at the default right offset. */
export const latestView = (from: View): View => ({
  barSpace: from.barSpace,
  rightBars: DEFAULT_OFFSET_RIGHT / from.barSpace,
});

/**
 * Zoom by `factor` about plot x `anchorX` (the plot's centre when omitted):
 * the bar under the anchor stays under it.
 */
export function zoomView(from: View, factor: number, width: number, anchorX = width / 2): View {
  const barSpace = clamp(from.barSpace * factor, BAR_SPACE_MIN, BAR_SPACE_MAX);
  // Float index (relative to the newest bar) under the anchor:
  //   rightBars - (width - x) / barSpace, held constant.
  const rightBars = from.rightBars + (width - anchorX) * (1 / barSpace - 1 / from.barSpace);
  return { barSpace, rightBars };
}

/** Whether two views draw the same picture (sub-pixel everywhere). */
export function sameView(a: View, b: View): boolean {
  if (Math.abs(a.barSpace - b.barSpace) > 1e-6) return false;
  return Math.abs(a.rightBars - b.rightBars) * a.barSpace < 0.01;
}

/**
 * The view `e` of the way (eased, 0..1) from `from` to `to` on a plot `width`
 * px wide. Both window edges move linearly in bar space; see the file header.
 */
export function interpolateView(from: View, to: View, width: number, e: number): View {
  if (e <= 0) return { ...from };
  if (e >= 1) return { ...to };
  const r0 = from.rightBars;
  const r1 = to.rightBars;
  const l0 = r0 - width / from.barSpace;
  const l1 = r1 - width / to.barSpace;
  const r = r0 + (r1 - r0) * e;
  const l = l0 + (l1 - l0) * e;
  return { barSpace: width / (r - l), rightBars: r };
}

/** The right offset in px that klinecharts reports for a view (it clamps at 0). */
export const offsetPx = (v: View): number => Math.max(0, v.rightBars * v.barSpace);

/**
 * Recover the exact `rightBars` from the x-axis mapping, for when
 * `getOffsetRightDistance()` cannot say (it clamps at 0 once the user has
 * scrolled back). klinecharts maps a (possibly fractional) data index to
 *
 *   x(i) = floor(W - (n + rightBars - i - 0.5) * barSpace + 0.5)
 *
 * The floor hides the fraction, so find where x steps up by one pixel just
 * right of the newest bar: at that index the expression inside the floor is
 * exactly an integer, which pins `rightBars` to float precision.
 */
export function solveRightBars(
  xAt: (index: number) => number,
  count: number,
  width: number,
  barSpace: number,
): number {
  const i0 = count - 1;
  const x0 = xAt(i0);
  let lo = i0;
  let hi = i0 + 1 / barSpace + 1e-9;
  for (let k = 0; k < 60 && hi - lo > 1e-12; k++) {
    const mid = (lo + hi) / 2;
    if (xAt(mid) >= x0 + 1) hi = mid;
    else lo = mid;
  }
  return (width - 0.5 - x0) / barSpace - count + hi + 0.5;
}

/** The plot's width: klinecharts' `totalBarSpace`. */
export function plotWidth(c: KChart): number {
  return c.getSize(CANDLE_PANE_ID, 'main')?.width ?? 0;
}

/** Read the chart's current view through the public API. */
export function readView(c: KChart): View {
  const barSpace = c.getBarSpace().bar;
  const off = c.getOffsetRightDistance();
  if (off > 0) return { barSpace, rightBars: off / barSpace };
  const count = c.getDataList().length;
  const width = plotWidth(c);
  if (count === 0 || !(width > 0)) return { barSpace, rightBars: 0 };
  const xAt = (i: number) =>
    (c.convertToPixel({ dataIndex: i }, { paneId: CANDLE_PANE_ID }) as Partial<Coordinate>).x ?? Number.NaN;
  return { barSpace, rightBars: solveRightBars(xAt, count, width, barSpace) };
}

/** A scroll the chart takes even while the user's own scrolling is off (the
 *  second press of a double click turns it off - Chart.tsx). */
function scrollBy(c: KChart, distance: number): void {
  const off = !c.isScrollEnabled();
  if (off) c.setScrollEnabled(true);
  c.scrollByDistance(distance);
  if (off) c.setScrollEnabled(false);
}

/**
 * Put the chart on `v`: bar space, then the scroll. The scroll is computed
 * from the chart's actual position after the bar-space change, so whatever
 * the library clamped or a live bar shifted is absorbed rather than
 * accumulated. `relayout` makes sure klinecharts lays out (and so re-fits the
 * price axis) even when the view itself does not change.
 */
export function applyView(c: KChart, v: View, rest = false, relayout = false): void {
  const before = c.getBarSpace().bar;
  c.setBarSpace(v.barSpace);
  if (rest && Math.abs(v.rightBars * v.barSpace - DEFAULT_OFFSET_RIGHT) < 1e-6) {
    // Landing on the default offset: set it exactly (it also re-states the
    // store's initial offset, which is this same value).
    c.setOffsetRightDistance(DEFAULT_OFFSET_RIGHT);
    return;
  }
  const now = readView(c);
  const distance = (now.rightBars - v.rightBars) * now.barSpace;
  if (Math.abs(distance) > 1e-9) scrollBy(c, distance);
  else if (relayout && c.getBarSpace().bar === before) scrollBy(c, 0);
}

/**
 * Run `apply` - something that changes the chart - and have klinecharts paint
 * the result IN THIS FRAME, once; then `after`.
 *
 * klinecharts lays out in a microtask and paints each canvas from its own
 * requestAnimationFrame callback (see the file header for what that does to a
 * tween). For the microtasks in which it lays out, requestAnimationFrame is
 * borrowed: the canvases' paint requests are collected and run straight after
 * the layout, still inside this frame. A canvas that already had a paint
 * pending (a live tick between frames) is not asked again - its pending paint
 * runs later in this same frame, on the new state. Negative ids, so a
 * borrowed request can never be mistaken for a real one.
 *
 * Only requests made from those microtasks are caught: a marker microtask
 * queued before `apply` turns the catching on, so the caller's own
 * requestAnimationFrame right after this call (a tween's next step) is a
 * real one.
 */
export function paintNow(apply: () => void, after?: () => void): void {
  if (typeof window === 'undefined' || typeof queueMicrotask !== 'function') {
    apply();
    after?.();
    return;
  }
  const w = window;
  const real = w.requestAnimationFrame;
  const caught: FrameRequestCallback[] = [];
  let catching = false;
  let id = -1;
  const borrowed = (cb: FrameRequestCallback): number => {
    if (!catching) return real.call(w, cb);
    caught.push(cb);
    return --id;
  };
  w.requestAnimationFrame = borrowed;
  queueMicrotask(() => {
    catching = true;
  });
  try {
    apply();
  } catch (err) {
    w.requestAnimationFrame = real;
    throw err;
  }
  // Queued after klinecharts' own layout microtask, so it runs after it.
  queueMicrotask(() => {
    catching = false;
    if (w.requestAnimationFrame === borrowed) w.requestAnimationFrame = real;
    const now = performance.now();
    for (const cb of caught) {
      try {
        cb(now);
      } catch (err) {
        setTimeout(() => {
          throw err;
        });
      }
    }
    after?.();
  });
}

/** The price axis' half of a move (yScale.ts' PriceFit). */
export interface YMotion {
  /** Start moving the axis toward the fit of `dest`; false when there is
   *  nothing to move. */
  begin(c: KChart, dest: View, width: number): boolean;
  /** This frame's eased progress; at 1 the axis fits on its own again. */
  step(c: KChart, e: number, dest: View, width: number): void;
  /** Stopped (done, cancelled or replaced). */
  end(): void;
}

export interface MoveOptions {
  /** Duration; 0 is a one-frame cut (reduced motion). Default TWEEN_MS. */
  ms?: number;
  /** Move the price axis to the destination's fit on the same clock. */
  fitY?: boolean;
  /** Told once when this move stops: `completed` true when it reached its
   *  destination, false when it was cancelled or replaced. Not called when
   *  there was nothing to move. */
  onEnd?: (completed: boolean) => void;
}

type Destination = View | ((from: View, width: number, heading: View | null) => View);

/**
 * The rAF driver. One move at a time: starting another replaces it from
 * wherever the chart is at that moment, and `cancel()` (any wheel, drag or
 * touch on the plot) stops it dead - the chart stays exactly where the last
 * frame put it, and a price axis that was moving goes back to fitting the
 * data by itself.
 */
export class ViewTween {
  private raf = 0;
  private dest: View | null = null;
  private y: YMotion | null = null;
  private onEnd: ((completed: boolean) => void) | null = null;

  constructor(
    private readonly getChart: () => KChart | null,
    private readonly yMotion?: YMotion,
    /** Told when a move starts and when it stops, for work worth deferring. */
    private readonly onMoving?: (moving: boolean) => void,
  ) {}

  get running(): boolean {
    return this.raf !== 0;
  }

  /**
   * Move to `to`: a view, or a function of where the chart is now, the plot
   * width, and where a move still running was headed (so two quick zoom
   * clicks compound instead of the second one starting from mid-flight).
   */
  start(to: Destination, options?: MoveOptions | number): void {
    const opts: MoveOptions = typeof options === 'number' ? { ms: options } : (options ?? {});
    const ms = opts.ms ?? TWEEN_MS;
    const heading = this.raf !== 0 ? this.dest : null;
    this.cancel();
    const c = this.getChart();
    if (!c) return;
    const width = plotWidth(c);
    if (!(width > 0)) return;
    const from = readView(c);
    const dest = typeof to === 'function' ? to(from, width, heading) : to;
    const y = opts.fitY && this.yMotion?.begin(c, dest, width) ? this.yMotion : null;
    if (sameView(from, dest) && !y) return;
    this.dest = dest;
    this.y = y;
    this.onEnd = opts.onEnd ?? null;
    this.onMoving?.(true);
    let t0 = -1;
    const step = (now: number) => {
      this.raf = 0;
      if (this.getChart() !== c) {
        this.stop();
        return;
      }
      if (t0 < 0) t0 = now;
      const t = ms > 0 ? Math.min(1, (now - t0) / ms) : 1;
      const e = easeView(t);
      this.y?.step(c, e, dest, plotWidth(c) || width);
      paintNow(() => applyView(c, interpolateView(from, dest, width, e), t >= 1, this.y !== null));
      if (t < 1) this.raf = requestAnimationFrame(step);
      else this.stop(true);
    };
    this.raf = requestAnimationFrame(step);
  }

  cancel(): void {
    if (this.raf !== 0) {
      cancelAnimationFrame(this.raf);
      log.debug('view move cancelled', { heading: this.dest, withPriceAxis: this.y !== null });
    }
    this.raf = 0;
    this.stop();
  }

  private stop(completed = false): void {
    const was = this.dest !== null;
    this.dest = null;
    this.y?.end();
    this.y = null;
    const end = this.onEnd;
    this.onEnd = null;
    if (was) this.onMoving?.(false);
    if (was && end) {
      try {
        end(completed);
      } catch (err) {
        log.error('view move end hook failed', { error: err });
      }
    }
  }
}

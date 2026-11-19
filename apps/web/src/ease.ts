/**
 * ONE CURVE FOR THE CHART AND THE UI (motion pass, 2026-11-18).
 *
 * The chart's camera moves on CSS `ease`, cubic-bezier(0.25, 0.1, 0.25, 1) (chart/viewTween.ts): it leaves at
 * once (the first frame of a 200 ms move covers 7% of the way, 0.85x an even frame), peaks early and lands with
 * zero velocity. styles.css carries the same four numbers as `--ease-view`, so a sheet, the page's fade-in and the
 * chart's eased view moves are one motion language; ease.test.ts holds the two in step. This module has no
 * imports, so the entry can use it without pulling the chart in.
 */

/** The control points of `--ease-view` and of the chart's easeView. */
export const EASE_VIEW = [0.25, 0.1, 0.25, 1] as const;
/** The chart's view move, start to rest (chart/viewTween.ts TWEEN_MS, styles.css --dur-view). */
export const DUR_VIEW_MS = 420;
/** A phone sheet's travel in and out (styles.css --dur-sheet). */
export const DUR_SHEET_MS = 280;
/** The incoming page's fade (styles.css --dur-page). */
export const DUR_PAGE_MS = 200;

/** `--ease-view` as a CSS timing function string, for the Web Animations API. */
export const EASE_VIEW_CSS = `cubic-bezier(${EASE_VIEW.join(', ')})`;

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
export const easeView = cubicBezier(...EASE_VIEW);

/** Whether the visitor asked for less motion (false where there is no matchMedia). */
export const reducedMotion = (): boolean => {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

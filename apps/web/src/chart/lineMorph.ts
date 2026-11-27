/**
 * The trading chart's switch, for the app's line charts (owner 2026-11-26: "make switching between all charts like
 * type and timeframe incl on the portfolio page smooth like the main chart on trade").
 *
 * On trade, a timeframe or symbol switch never cuts: the candles on screen turn into the new bars where they stand, on
 * one eased clock (morph.ts). A line chart does the same here: the line on screen - wherever it is, mid-morph included -
 * reshapes into the new line, its fill and its start level travelling with it, while the old axis labels fade out and
 * the new ones fade in. Value to PnL, 7d to 30d, one wallet to another: one move, no blank frame.
 *
 * THE SHAPE. Both lines are sampled at the same number of evenly spaced x positions across the plot (`sampleLine`),
 * in pixels, so any two lines pair point for point whatever their data: a 24-point day and a 400-point month morph
 * into each other. A smooth line is sampled on its own curve - the monotone cubic the charts draw (Fritsch-Carlson,
 * as parts.tsx smoothPath) - so the morph's last frame is the drawn line, and handing back to it does not pop.
 *
 * ONE CLOCK. Every sample moves on the same eased progress, in LINE_MORPH_MS: the trading chart's MORPH_MS and its
 * in-out curve (viewTween.ts easeInOutCubic). A switch during a morph starts from the frame on screen.
 *
 * This file is pure (the hook is useLineMorph.ts), so it can be tested without a page.
 */

/** The trading chart's morph, first frame to landing (chart/morph.ts MORPH_MS; lineMorph.test.ts keeps them equal). */
export const LINE_MORPH_MS = 580;

/**
 * The trading chart's in-out curve (viewTween.ts easeInOutCubic, kept equal by the test). Restated here so a page with
 * a line chart does not load the trading chart's modules.
 */
export const easeLineMorph = (t: number): number => {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
};

export type Pt = readonly [x: number, y: number];

/** A line as drawn, in pixels: its samples and the level its fill and colours are read against. */
export interface LineShape {
  pts: readonly Pt[];
  base: number;
}

/** The slopes the monotone cubic leaves each point with (Fritsch-Carlson): it never swings past a point. */
export function tangents(p: readonly Pt[]): number[] {
  const n = p.length;
  if (n < 2) return p.map(() => 0);
  const m = Array.from({ length: n - 1 }, (_, i) => (p[i + 1]![1] - p[i]![1]) / ((p[i + 1]![0] - p[i]![0]) || 1));
  return p.map((_, i) => {
    if (i === 0) return m[0]!;
    if (i === n - 1) return m[n - 2]!;
    return m[i - 1]! * m[i]! <= 0 ? 0 : (2 * m[i - 1]! * m[i]!) / (m[i - 1]! + m[i]!);
  });
}

/** How many samples a plot this wide gets: about one per 2px, at least 24, at most 320. */
export const samplesFor = (width: number): number => Math.max(24, Math.min(320, Math.round(width / 2)));

/**
 * `n` points evenly spaced in x from the first point to the last, on the line through `p` (x ascending): straight
 * segments, or the monotone cubic when `smooth`.
 */
export function sampleLine(p: readonly Pt[], n: number, smooth: boolean): Pt[] {
  if (p.length === 0 || n < 2) return [];
  if (p.length === 1) return Array.from({ length: n }, () => p[0]!);
  const t = smooth ? tangents(p) : null;
  const x0 = p[0]![0];
  const x1 = p[p.length - 1]![0];
  const out: Pt[] = [];
  let i = 0;
  for (let k = 0; k < n; k++) {
    const x = k === n - 1 ? x1 : x0 + ((x1 - x0) * k) / (n - 1);
    while (i < p.length - 2 && p[i + 1]![0] < x) i++;
    const a = p[i]!;
    const b = p[i + 1]!;
    const dx = b[0] - a[0];
    const s = dx > 0 ? Math.min(1, Math.max(0, (x - a[0]) / dx)) : 0;
    if (!t) {
      out.push([x, a[1] + (b[1] - a[1]) * s]);
      continue;
    }
    // Cubic Hermite with the drawn curve's slopes: the same curve as smoothPath's Bezier (x linear in s).
    const s2 = s * s;
    const s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1;
    const h10 = s3 - 2 * s2 + s;
    const h01 = -2 * s3 + 3 * s2;
    const h11 = s3 - s2;
    out.push([x, h00 * a[1] + h10 * dx * t[i]! + h01 * b[1] + h11 * dx * t[i + 1]!]);
  }
  return out;
}

/** `p` at `n` points, by index (for a frame sampled at another width). */
function resampleTo(p: readonly Pt[], n: number): Pt[] {
  if (p.length === n) return [...p];
  if (p.length === 0) return [];
  return Array.from({ length: n }, (_, k) => {
    const f = n === 1 ? 0 : (k * (p.length - 1)) / (n - 1);
    const i = Math.min(p.length - 2, Math.floor(f));
    if (i < 0) return p[0]!;
    const s = f - i;
    const a = p[i]!;
    const b = p[i + 1]!;
    return [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s] as const;
  });
}

/** The frame `e` of the way (0..1, already eased) from `a` to `b`: every sample and the base on one clock. */
export function blendShapes(a: LineShape, b: LineShape, e: number): LineShape {
  if (e >= 1) return b;
  const from = resampleTo(a.pts, b.pts.length);
  return {
    pts: b.pts.map((q, k) => {
      const f = from[k] ?? q;
      return [f[0] + (q[0] - f[0]) * e, f[1] + (q[1] - f[1]) * e] as const;
    }),
    base: a.base + (b.base - a.base) * e,
  };
}

/** The samples as an SVG path (they are dense enough that straight segments read as the curve). */
export function pathOf(pts: readonly Pt[]): string {
  let d = '';
  for (let k = 0; k < pts.length; k++) d += `${k === 0 ? 'M' : 'L'}${pts[k]![0].toFixed(1)},${pts[k]![1].toFixed(1)}`;
  return d;
}

/** The highest and lowest y the samples reach (top and foot of the line, in pixels). */
export function yExtent(pts: readonly Pt[]): { top: number; foot: number } {
  let top = Infinity;
  let foot = -Infinity;
  for (const p of pts) {
    if (p[1] < top) top = p[1];
    if (p[1] > foot) foot = p[1];
  }
  return { top, foot };
}

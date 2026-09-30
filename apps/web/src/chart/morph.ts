/**
 * The loading skeleton and its morph into the loaded candles - the pure half.
 * CandleMorph.tsx is the canvas that draws it.
 *
 * THE SKELETON is the owner's reference chart (skeletonSeries.ts, digitised
 * from docs/skeleton-reference.png), stood on the grid the loaded bars will
 * land on: klinecharts' own bar pitch, the newest candle exactly where
 * klinecharts will put the newest bar (the right offset in from the axis),
 * the older ones one pitch apart to the left edge (barX). Each candle is
 * klinecharts' own geometry for that pitch (candleGeom) - the same body and
 * wick widths as the bars - with the reference's prices at the same fraction
 * of the pane height, so the reference's composition carries over: 11% of
 * headroom over the highest wick, 8% under the lowest.
 *
 * The reference has 96 candles; a plot rarely has room for exactly 96 bars
 * (skeletonSeriesFor). With more room the reference sits on the newest 96
 * and is led in on the left by itself mirrored in time, which runs on from it
 * without a seam; with less, runs of reference candles merge into one bar the
 * way a higher timeframe merges them, so even a phone shows the whole shape -
 * the dip, then the climb. The newest skeleton candle's close carries the
 * skeleton's own last-price rule (CandleMorph draws it, grey).
 *
 * Two grey tones, one for up and one for down candles (CandleMorph.tsx reads
 * them from the skeleton tokens), so the reference's rhythm reads while the
 * candles stay unmistakably placeholders.
 *
 * THE MORPH. The candles on screen - the skeleton, or on a switch the old
 * market's candles restyled grey where they stood - are paired with the
 * loaded bars BY RECENCY (pairByRecency): the rightmost candle with the
 * newest bar, and every other bar with the candle as far left of that one.
 * Both stand on the same pitch, so every bar finds its own candle; the newest
 * candle always becomes the newest bar, and the last-price rule - attached to
 * the newest close - never parts from it. Each candle grows into its bar: x,
 * body width, body and wick ends interpolate from the placeholder's rects to
 * the rects klinecharts draws for the bar, the tone to the bar's up/down
 * colour. A bar with no candle (a longer history than the candles on screen,
 * or a bar that arrived live) fades in where it is; a candle no bar took
 * fades out where it is.
 *
 * ONE CLOCK. Every candle - and the last-price rule - moves on the same
 * eased progress (morphProgress): nothing starts late, nothing lags, the
 * newest candle and the rule travel together with the rest. The whole morph
 * takes MORPH_MS. On the landing frame every candle is exactly - integer for
 * integer, colour string for colour string - what klinecharts draws, which is
 * what lets CandleMorph hand the plot back without a pop.
 *
 * THE MORPH OUT, on a symbol or interval switch, restyles the candles on
 * screen into placeholders where they stand (outFrame with a pairing of every
 * candle to itself): colour only, all at once, in RESTYLE_MS. If the new bars
 * land before it is over, the in-morph starts from wherever the candles are
 * that frame and eases OUT of it (no second start from rest): one continuous
 * motion.
 *
 * DOM-free and unit-tested: morph.test.ts.
 */
import type { CandleType, Chart as KChart, DeepPartial, Styles } from 'klinecharts';
import { CANDLE_PANE_ID, DEFAULT_BAR_SPACE, DEFAULT_OFFSET_RIGHT, chartStyles } from './theme';
import { easeInOutCubic } from './viewTween';
import { SKELETON_REF, SKELETON_SERIES, type RefCandle } from './skeletonSeries';

/** The morph in, first frame to landing frame: every candle's travel, and
 *  the last-price rule's (one clock, no stagger - see the header). */
export const MORPH_MS = 580;
export const MORPH_TOTAL_MS = MORPH_MS;

/** The morph out, on a switch: a little quicker, the old chart is leaving. */
export const MORPH_OUT_MS = 340;
export const MORPH_OUT_STAGGER_MS = 80;
export const MORPH_OUT_TOTAL_MS = MORPH_OUT_MS + MORPH_OUT_STAGGER_MS;

/** Decelerating from full speed: a morph that takes over a moving one. */
export const easeOutCubic = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : 1 - (1 - t) ** 3);

/**
 * The rects klinecharts draws for one candle (CandleBarView._createSolidBar /
 * _createStrokeBar): a 1px wick at `x` from `wickTop`, and a body `bodyWidth`
 * wide starting `bodyLeft`. `bodyBottom` is the body's lower price edge before
 * the 1px minimum height - where a hollow candle's lower wick starts.
 */
export interface Geom {
  x: number;
  wickTop: number;
  wickHeight: number;
  bodyLeft: number;
  bodyTop: number;
  bodyWidth: number;
  bodyHeight: number;
  bodyBottom: number;
}

export type Dir = 'up' | 'down' | 'flat';

export interface Paint {
  body: string;
  border: string;
  wick: string;
}

/** The candle paint per direction, as klinecharts' `candle.bar` styles state it. */
export type Palette = Record<Dir, Paint>;

export type RGBA = readonly [number, number, number, number];

/**
 * klinecharts' body width for a bar pitch (StoreImp._calcOptimalBarSpace):
 * a gentle ratio of the pitch, floored, and stepped down to an odd number
 * when the body would otherwise nearly touch its neighbours.
 */
export function barBody(barSpace: number): { gapBar: number; halfGapBar: number } {
  const special = 4;
  const ratio = 1 - (0.2 * Math.atan(Math.max(special, barSpace) - special)) / (Math.PI * 0.5);
  let gap = Math.min(Math.floor(barSpace * ratio), Math.floor(barSpace));
  if (gap % 2 === 0 && gap + 2 >= barSpace) --gap;
  gap = Math.max(1, gap);
  return { gapBar: gap, halfGapBar: Math.floor(gap / 2) };
}

/**
 * A candle at centre column `x` with `ys` = the open, close, high and low
 * already mapped to pixels (any order): the wick from the highest to the
 * lowest, the body `2 * half + 1` wide centred on the wick.
 */
function geomWith(x: number, ys: readonly number[], half: number, bodyWidth: number): Geom {
  const p = [...ys].sort((a, b) => a - b);
  const top = p[0] ?? 0;
  const bottom = p[3] ?? top;
  return {
    x,
    wickTop: top,
    wickHeight: bottom - top,
    bodyLeft: x - half,
    bodyTop: p[1] ?? top,
    bodyWidth,
    bodyHeight: Math.max(1, (p[2] ?? top) - (p[1] ?? top)),
    bodyBottom: p[2] ?? top,
  };
}

/**
 * The geometry klinecharts draws for a bar at centre `x` with `ys` = the
 * open, close, high and low already mapped to pixels (any order).
 */
export function candleGeom(x: number, ys: readonly number[], barSpace: number): Geom {
  const { gapBar, halfGapBar } = barBody(barSpace);
  const correction = gapBar % 2 === 0 ? 1 : 0;
  return geomWith(x, ys, halfGapBar, gapBar + correction);
}

/** klinecharts' 'current_open' compare rule. */
export const direction = (open: number, close: number): Dir => (close > open ? 'up' : close < open ? 'down' : 'flat');

// --- the skeleton ------------------------------------------------------------

/** Up candles (and the reference's one flat candle) take the lighter tone. */
export type Tone = 'up' | 'down';

export interface SkeletonCandle {
  geom: Geom;
  tone: Tone;
  /** The pixel row of its close: on the newest candle, the skeleton's
   *  last-price rule. */
  closeY: number;
}

export interface SkeletonSize {
  /** The plot (candle pane drawing area) in CSS px. */
  width: number;
  height: number;
  /** klinecharts' bar pitch (getBarSpace().bar); DEFAULT_BAR_SPACE if omitted. */
  barSpace?: number;
  /** The gap klinecharts leaves right of the newest bar
   *  (getOffsetRightDistance()); DEFAULT_OFFSET_RIGHT if omitted. */
  offsetRight?: number;
}

/** Where the reference put a price, in its own pixel rows. */
function refRow(price: number): number {
  const { top, bottom, priceTop, priceBottom } = SKELETON_REF.rows;
  return top + ((priceTop - price) * (bottom - top)) / (priceTop - priceBottom);
}

/**
 * The centre column klinecharts draws the bar `k` places left of the newest
 * at, on a plot `width` px wide with the newest bar `offsetRight` px in from
 * the axis (StoreImp.dataIndexToCoordinate, the view a load resets to).
 */
export function barX(width: number, k: number, barSpace: number, offsetRight: number): number {
  return Math.floor(width - (k + 1 + offsetRight / barSpace - 0.5) * barSpace + 0.5);
}

/**
 * The reference fitted to `n` bars, oldest first. Exactly the reference for
 * 96. More: the reference on the newest 96, led in by the reference mirrored
 * in time (read backwards, open and close swapped - it closes where the next
 * candle opens, so the path runs on without a seam), and so on, alternating,
 * for very wide plots. Fewer: each bar merges a run of reference candles
 * (first open, highest high, lowest low, last close), the way a higher
 * timeframe does, so the whole shape stays on screen.
 */
export function skeletonSeriesFor(n: number): RefCandle[] {
  const ref = SKELETON_SERIES;
  const len = ref.length;
  const count = Math.floor(n);
  if (!(count > 0)) return [];
  if (count === len) return ref.slice();
  if (count < len) {
    const out: RefCandle[] = [];
    for (let g = 0; g < count; g++) {
      const a = Math.floor((g * len) / count);
      const b = Math.max(a + 1, Math.floor(((g + 1) * len) / count));
      let high = -Infinity;
      let low = Infinity;
      for (let i = a; i < b; i++) {
        high = Math.max(high, ref[i]![1]);
        low = Math.min(low, ref[i]![2]);
      }
      out.push([ref[a]![0], high, low, ref[b - 1]![3]]);
    }
    return out;
  }
  const out: RefCandle[] = [];
  for (let p = len - count; p < len; p++) {
    const q = ((p % (2 * len)) + 2 * len) % (2 * len);
    if (q < len) out.push(ref[q]!);
    else {
      const [o, h, l, c] = ref[2 * len - 1 - q]!;
      out.push([c, h, l, o]);
    }
  }
  return out;
}

/**
 * The placeholder series for a plot, oldest first: one candle on every bar
 * slot from the left edge to where the newest bar will land (see the file
 * header), in klinecharts' own geometry for the pitch.
 */
export function skeletonFor({ width, height, barSpace = DEFAULT_BAR_SPACE, offsetRight = DEFAULT_OFFSET_RIGHT }: SkeletonSize): SkeletonCandle[] {
  if (!(width > 0) || !(height > 0) || !(barSpace > 0) || !Number.isFinite(offsetRight)) return [];
  let n = 0;
  while (n < 20_000 && barX(width, n, barSpace, offsetRight) >= 0) n++;
  if (!n) return [];
  const sy = height / SKELETON_REF.plot.height;
  const y = (price: number) => Math.round(refRow(price) * sy);
  return skeletonSeriesFor(n).map(([o, h, l, c], j) => ({
    geom: candleGeom(barX(width, n - 1 - j, barSpace, offsetRight), [y(o), y(c), y(h), y(l)], barSpace),
    tone: c < o ? 'down' : 'up',
    closeY: y(c),
  }));
}

/**
 * Pair loaded bars with placeholders by position. Every bar asks for the
 * placeholder nearest to it; the nearest pairs are made first and each
 * placeholder goes to one bar only, so pairs never cross. A bar further than
 * `reach` px from every placeholder gets none. `slots` are x positions in any
 * order (sprites mid-morph need not be sorted). Returns bar index -> slot index.
 */
export function matchSlots(
  slots: readonly number[],
  bars: ReadonlyArray<{ index: number; x: number }>,
  reach: number,
): Map<number, number> {
  const out = new Map<number, number>();
  if (!slots.length) return out;
  const order = slots.map((x, i) => ({ x, i })).sort((a, b) => a.x - b.x || a.i - b.i);
  const want: Array<{ index: number; slot: number; d: number }> = [];
  for (const b of bars) {
    // Binary search for the first slot at or right of the bar.
    let lo = 0;
    let hi = order.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (order[mid]!.x < b.x) lo = mid + 1;
      else hi = mid;
    }
    let best = -1;
    let bestD = Infinity;
    for (const k of [lo - 1, lo]) {
      if (k < 0 || k >= order.length) continue;
      const d = Math.abs(order[k]!.x - b.x);
      if (d < bestD) {
        bestD = d;
        best = order[k]!.i;
      }
    }
    if (best >= 0 && bestD <= reach) want.push({ index: b.index, slot: best, d: bestD });
  }
  want.sort((a, b) => a.d - b.d || a.index - b.index);
  const taken = new Set<number>();
  for (const w of want) {
    if (taken.has(w.slot) || out.has(w.index)) continue;
    taken.add(w.slot);
    out.set(w.index, w.slot);
  }
  return out;
}

/**
 * Pair loaded bars with the candles on screen by recency: the newest bar with
 * the rightmost candle, and every other bar with the candle as far left of
 * that one as the bar is of the newest (matchSlots after lining the two up:
 * nearest within `reach`, nearest pairs first, never crossing). On a switch
 * the candles on screen are the old bars on the same pitch, on a first load
 * the skeleton on the bars' own grid, so every bar finds its counterpart and
 * the candles move as one onto the new bars - wherever the old view had been
 * scrolled to, and however much the price axis' width changed. The newest
 * candle always becomes the newest bar: the one the last-price rule is on.
 *
 * Candles mostly faded out (the leftovers of an interrupted morph) are left
 * out: they finish fading where they are. Returns bar index -> slot index.
 */
export function pairByRecency(
  slots: ReadonlyArray<{ x: number; alpha?: number }>,
  bars: ReadonlyArray<{ index: number; x: number }>,
  reach: number,
): Map<number, number> {
  if (!slots.length || !bars.length) return new Map();
  let live = slots.map((s, i) => ({ x: s.x, i, a: s.alpha ?? 1 })).filter((s) => s.a >= 0.5);
  if (!live.length) live = slots.map((s, i) => ({ x: s.x, i, a: s.alpha ?? 1 }));
  let anchor = live[0]!;
  for (const s of live) if (s.x > anchor.x) anchor = s;
  let newest = bars[0]!;
  for (const b of bars) if (b.index > newest.index) newest = b;
  const shift = newest.x - anchor.x;
  const pairs = matchSlots(
    live.map((s) => s.x + shift),
    bars,
    reach,
  );
  const out = new Map<number, number>();
  for (const [index, k] of pairs) out.set(index, live[k]!.i);
  return out;
}

const lerp = (a: number, b: number, e: number) => a + (b - a) * e;

export function lerpGeom(a: Geom, b: Geom, e: number): Geom {
  if (e <= 0) return a;
  if (e >= 1) return b;
  return {
    x: lerp(a.x, b.x, e),
    wickTop: lerp(a.wickTop, b.wickTop, e),
    wickHeight: lerp(a.wickHeight, b.wickHeight, e),
    bodyLeft: lerp(a.bodyLeft, b.bodyLeft, e),
    bodyTop: lerp(a.bodyTop, b.bodyTop, e),
    bodyWidth: lerp(a.bodyWidth, b.bodyWidth, e),
    bodyHeight: lerp(a.bodyHeight, b.bodyHeight, e),
    bodyBottom: lerp(a.bodyBottom, b.bodyBottom, e),
  };
}

// --- colour ------------------------------------------------------------------

const parsed = new Map<string, RGBA | null>();

/** #rgb, #rgba, #rrggbb, #rrggbbaa, rgb() and rgba() - what styles.css and
 *  theme.ts use. Null for anything else. */
export function parseColor(input: string): RGBA | null {
  const s = input.trim().toLowerCase();
  const hit = parsed.get(s);
  if (hit !== undefined) return hit;
  let out: RGBA | null = null;
  const hex = /^#([0-9a-f]{3,8})$/.exec(s)?.[1];
  if (hex && [3, 4, 6, 8].includes(hex.length)) {
    const full = hex.length <= 4 ? [...hex].map((ch) => ch + ch).join('') : hex;
    const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
    out = [n(0), n(2), n(4), full.length === 8 ? n(6) / 255 : 1];
  } else {
    const m = /^rgba?\(\s*([^)]*)\)$/.exec(s);
    const parts = m ? m[1]!.split(/[\s,/]+/).filter(Boolean) : [];
    if (parts.length === 3 || parts.length === 4) {
      const channel = (p: string) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p));
      const alpha = (p: string | undefined) => (p === undefined ? 1 : p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p));
      const c: [number, number, number, number] = [channel(parts[0]!), channel(parts[1]!), channel(parts[2]!), alpha(parts[3])];
      if (c.every(Number.isFinite)) out = c;
    }
  }
  parsed.set(s, out);
  return out;
}

/** `fg` composited over an opaque `bg`: the opaque colour the eye sees. */
export function over(fg: RGBA, bg: RGBA): RGBA {
  const a = fg[3];
  return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
}

export const cssColor = (c: RGBA): string =>
  c[3] >= 1
    ? `rgb(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])})`
    : `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${+c[3].toFixed(3)})`;

/** From `a` towards the colour string `b`; `b` itself, verbatim, at the end. */
export function mixColor(a: RGBA, b: string, e: number): string {
  if (e >= 1) return b;
  const t = parseColor(b);
  if (!t) return e < 0.5 ? cssColor(a) : b;
  return cssColor([lerp(a[0], t[0], e), lerp(a[1], t[1], e), lerp(a[2], t[2], e), lerp(a[3], t[3], e)]);
}

// --- a frame -----------------------------------------------------------------

/** One loaded bar as klinecharts will draw it. */
export interface Target {
  index: number;
  geom: Geom;
  dir: Dir;
}

/**
 * A candle as the layer holds it: rects, an opaque colour, and how much of it
 * shows. A placeholder at rest is alpha 1; a morph interrupted half-way leaves
 * whatever it was drawing - mixed colours, fading extras - and the next morph
 * starts from exactly that.
 */
export interface Placeholder {
  geom: Geom;
  color: RGBA;
  /** 1 when omitted. */
  alpha?: number;
  /** Which placeholder grey it becomes on a switch: the direction of the bar
   *  it is (or is becoming). Carried explicitly - a candle caught half-way
   *  through a morph is neither colour yet, and guessing from its colour
   *  turned every one of them the same grey. */
  tone?: Tone;
}

export interface DrawOp {
  geom: Geom;
  paint: Paint;
  /** 1 for a candle in place; a fading extra otherwise. */
  alpha: number;
  /** Eased progress of this candle, 0..1 (hollow bodies fade their fill by it). */
  e: number;
  /** The placeholder grey this candle takes if a switch catches it (Placeholder.tone). */
  tone?: Tone;
}

/** A bar's direction as a placeholder grey: up (and flat) the lighter. */
export const toneOfDir = (dir: Dir): Tone => (dir === 'down' ? 'down' : 'up');

/** How a morph accelerates: from rest (ease-in-out), or taking over a morph
 *  still moving, from full speed (ease-out) so nothing stops and restarts. */
export type MorphCurve = 'inOut' | 'out';

const progressOn = (curve: MorphCurve | undefined, elapsed: number, delay: number, travel: number): number =>
  (curve === 'out' ? easeOutCubic : easeInOutCubic)((elapsed - delay) / travel);

/**
 * A morph's eased progress `elapsed` ms in: every candle's, and the
 * last-price rule's - one clock for everything on screen.
 */
export const morphProgress = (elapsed: number, curve: MorphCurve = 'inOut', travel: number = MORPH_MS): number =>
  progressOn(curve, elapsed, 0, travel);

const paintOf = (c: RGBA): Paint => {
  const s = cssColor(c);
  return { body: s, border: s, wick: s };
};

export interface MorphInput {
  /** The candles on screen when the bars arrived (the skeleton, or wherever
   *  a morph out had got to), in any order. */
  skeleton: readonly Placeholder[];
  /** Data index -> the candle it grows out of (matchSlots). */
  partner: ReadonlyMap<number, number>;
  /** The visible bars, oldest first, with their geometry this frame. */
  targets: readonly Target[];
  palette: Palette;
  /** Milliseconds since the morph's first frame. */
  elapsed: number;
  curve?: MorphCurve;
}

/**
 * Everything to draw on one frame of the morph in, bottom to top, and
 * whether this is the landing frame. Every candle is the same way along
 * (morphProgress). On the landing frame the ops are exactly the targets, in
 * klinecharts' own left-to-right order, with its colour strings.
 */
export function morphFrame(f: MorphInput): { ops: DrawOp[]; done: boolean } {
  const done = f.elapsed >= MORPH_TOTAL_MS;
  const ops: DrawOp[] = [];
  const e = done ? 1 : morphProgress(f.elapsed, f.curve);
  // Candles no bar took fade out underneath, from however visible they were.
  if (!done) {
    const taken = new Set<number>();
    for (const t of f.targets) {
      const k = f.partner.get(t.index);
      if (k !== undefined) taken.add(k);
    }
    for (let k = 0; k < f.skeleton.length; k++) {
      if (taken.has(k)) continue;
      const s = f.skeleton[k]!;
      const alpha = (s.alpha ?? 1) * (1 - e);
      if (alpha <= 0) continue;
      ops.push({ geom: s.geom, paint: paintOf(s.color), alpha, e: 0, tone: s.tone });
    }
  }
  for (const t of f.targets) {
    const paint = f.palette[t.dir];
    const tone = toneOfDir(t.dir);
    const k = f.partner.get(t.index);
    const from = k === undefined ? undefined : f.skeleton[k];
    if (!from) {
      // A bar no candle stands for (a longer history than the candles on
      // screen, or it arrived live during the morph): it fades in.
      if (e > 0) ops.push({ geom: t.geom, paint, alpha: e, e: 1, tone });
      continue;
    }
    const a0 = from.alpha ?? 1;
    ops.push({
      geom: lerpGeom(from.geom, t.geom, e),
      paint:
        e >= 1
          ? paint
          : { body: mixColor(from.color, paint.body, e), border: mixColor(from.color, paint.border, e), wick: mixColor(from.color, paint.wick, e) },
      alpha: e >= 1 ? 1 : a0 + (1 - a0) * e,
      e,
      tone,
    });
  }
  return { ops, done };
}

export interface OutInput {
  /** The candles on screen as the switch happened, in any order. */
  from: readonly Placeholder[];
  /** The placeholders they settle into, oldest first. */
  to: readonly Placeholder[];
  /** From-candle index -> placeholder index (matchSlots, the in-morph's
   *  pairing run the other way). */
  pairs: ReadonlyMap<number, number>;
  elapsed: number;
  width: number;
  curve?: MorphCurve;
  /** Travel per candle; default MORPH_OUT_MS. A restyle in place (a switch:
   *  same geometry, new colour) uses the short RESTYLE_MS. */
  ms?: number;
  /** Left-to-right stagger; default MORPH_OUT_STAGGER_MS. */
  stagger?: number;
}

/** A switch restyles the candles on screen into placeholders where they
 *  stand: colour only, no geometry, so it is quick and unstaggered. */
export const RESTYLE_MS = 160;

/**
 * One frame of the morph out: every candle on screen onto its paired
 * placeholder, in the placeholder's grey; candles without one fade out,
 * placeholders without one fade in. The last frame is exactly the placeholders.
 * On a switch the placeholders ARE the candles on screen (same geometry), so
 * this is a pure colour change.
 */
export function outFrame(f: OutInput): { ops: DrawOp[]; done: boolean } {
  const travel = f.ms ?? MORPH_OUT_MS;
  const stagger = f.stagger ?? MORPH_OUT_STAGGER_MS;
  const done = f.elapsed >= travel + stagger;
  const ops: DrawOp[] = [];
  const at = (x: number) =>
    progressOn(f.curve, f.elapsed, f.width > 0 ? stagger * Math.min(1, Math.max(0, x / f.width)) : 0, travel);
  if (done) {
    for (const p of f.to) ops.push({ geom: p.geom, paint: paintOf(p.color), alpha: 1, e: 1, tone: p.tone });
    return { ops, done };
  }
  const paired = new Set<number>();
  for (const k of f.pairs.values()) paired.add(k);
  // Leaving candles and arriving placeholders first, underneath.
  f.from.forEach((s, i) => {
    if (f.pairs.has(i)) return;
    const alpha = (s.alpha ?? 1) * (1 - at(s.geom.x));
    if (alpha > 0) ops.push({ geom: s.geom, paint: paintOf(s.color), alpha, e: 0, tone: s.tone });
  });
  f.to.forEach((p, j) => {
    if (paired.has(j)) return;
    const alpha = at(p.geom.x);
    if (alpha > 0) ops.push({ geom: p.geom, paint: paintOf(p.color), alpha, e: 0, tone: p.tone });
  });
  for (const [i, j] of f.pairs) {
    const s = f.from[i];
    const p = f.to[j];
    if (!s || !p) continue;
    const e = at(s.geom.x);
    const a0 = s.alpha ?? 1;
    const c: RGBA = [lerp(s.color[0], p.color[0], e), lerp(s.color[1], p.color[1], e), lerp(s.color[2], p.color[2], e), 1];
    ops.push({ geom: lerpGeom(s.geom, p.geom, e), paint: paintOf(c), alpha: a0 + (1 - a0) * e, e: 0, tone: p.tone ?? s.tone });
  }
  return { ops, done };
}

/** What a frame drew, as candles a following morph can start from. */
export function spritesOf(ops: readonly DrawOp[], fallback: RGBA): Placeholder[] {
  return ops.map((op) => ({ geom: op.geom, color: parseColor(op.paint.body) ?? fallback, alpha: op.alpha, tone: op.tone }));
}

// --- klinecharts hand-over -----------------------------------------------------

/** The user asked for less motion: no shimmer, no morph, a quick crossfade.
 *  (The one read of the environment in this file, and safe without a DOM.) */
export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Candle styles the morph can land on exactly. The others (OHLC bars, the
 *  line) are not candles to grow into, and get the crossfade instead. */
export const morphable = (type: CandleType | undefined): boolean => type === 'candle_solid' || type === 'candle_stroke';

/**
 * The grid klinecharts would draw on a pane (the candle pane by default): its
 * price axis' tick rows and the time axis' tick columns (GridView reads
 * exactly these).
 *
 * The price axis is public (`getYAxes`); the time axis is not, so it is read
 * through the chart's own x-axis pane, and a build without it answers null -
 * in which case the grid stays klinecharts' (MORPH_HIDDEN is not applied).
 */
export function gridLines(c: KChart, paneId: string = CANDLE_PANE_ID): { xs: number[]; ys: number[] } | null {
  const x = (c as unknown as { getXAxisPane?: () => { getXAxisComponent?: () => { getTicks?: () => Array<{ coord: number }> } } })
    .getXAxisPane?.()
    ?.getXAxisComponent?.();
  const y = c.getYAxes({ paneId })[0];
  if (typeof x?.getTicks !== 'function' || !y) return null;
  return { xs: x.getTicks().map((t) => t.coord), ys: y.getTicks().map((t) => t.coord) };
}

const TRANSPARENT_BAR = {
  upColor: 'transparent',
  downColor: 'transparent',
  noChangeColor: 'transparent',
  upBorderColor: 'transparent',
  downBorderColor: 'transparent',
  noChangeBorderColor: 'transparent',
  upWickColor: 'transparent',
  downWickColor: 'transparent',
  noChangeWickColor: 'transparent',
};

/**
 * What klinecharts draws while the candle layer is on screen: no candles
 * (klinecharts skips a rect whose colour is transparent) and no grid - the
 * layer draws both itself, grid first, UNDER klinecharts' canvas, so the
 * library's last-price line, indicators, overlays and crosshair sit on top of
 * the morphing candles exactly as they sit on top of its own. Everything else
 * still draws, so scale, layout and axes are final before the plot shows.
 */
/** klinecharts' dotted last-price rule is the layer's while it owns the
 *  candles: it goes grey with them on a switch and glides to the new price
 *  (CandleMorph, drawPriceLine). The axis badge stays klinecharts'. */
const HIDDEN_PRICE_LINE = { priceMark: { last: { line: { show: false } } } };

export const MORPH_HIDDEN: DeepPartial<Styles> = { candle: { bar: TRANSPARENT_BAR, ...HIDDEN_PRICE_LINE }, grid: { show: false } };

/** klinecharts' candles and grid when the morph cannot draw the grid itself. */
export const MORPH_HIDDEN_CANDLES: DeepPartial<Styles> = { candle: { bar: TRANSPARENT_BAR, ...HIDDEN_PRICE_LINE } };

/** The theme's candle colours, last-price rule and grid (theme.ts): what the
 *  morph lands on, and what klinecharts gets back when it does. */
export const MORPH_SHOWN: DeepPartial<Styles> = {
  candle: {
    bar: { ...chartStyles.candle?.bar },
    priceMark: {
      last: {
        upColor: chartStyles.candle?.priceMark?.last?.upColor,
        downColor: chartStyles.candle?.priceMark?.last?.downColor,
        noChangeColor: chartStyles.candle?.priceMark?.last?.noChangeColor,
        line: { show: chartStyles.candle?.priceMark?.last?.line?.show ?? true },
      },
    },
  },
  grid: { show: chartStyles.grid?.show ?? true },
};

/**
 * The last-price badge on the price axis in one colour, whichever way the
 * price moved: while the candle layer owns the rule, the badge takes the
 * rule's colour frame by frame (grey on a switch, back to its colour with
 * the new bars), and MORPH_SHOWN gives it the theme's colours back.
 */
export const badgeStyles = (color: string): DeepPartial<Styles> => ({
  candle: { priceMark: { last: { upColor: color, downColor: color, noChangeColor: color } } },
});

/** The theme's last-price rule, as klinecharts draws it (CandleLastPriceView). */
export const LAST_PRICE_STYLE = chartStyles.candle?.priceMark?.last;

/**
 * Where klinecharts draws the last-price rule for a close at `pixel` (the
 * axis' plain pixel) on a pane `height` px tall: YAxisImp.convertToNicePixel
 * rounds it and keeps it inside 5%..98% of the pane.
 */
export const niceY = (pixel: number, height: number): number =>
  Math.round(Math.max(height * 0.05, Math.min(pixel, height * 0.98)));

/** The rule's colour key, as CandleLastPriceView picks it: close against the
 *  current open or (the default) the previous close. */
export function lastPriceDir(close: number, open: number, prevClose: number | undefined, rule: string | undefined): Dir {
  const compare = rule === 'current_open' ? open : (prevClose ?? close);
  return close > compare ? 'up' : close < compare ? 'down' : 'flat';
}

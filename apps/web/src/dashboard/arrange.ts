/**
 * Moves for the layout editor (Dock): a panel dropped on a side of another takes that half, on its middle the two
 * trade places (owner 2026-11-26: "keep split"). Pure: grid units in, placements out; Dashboard.tsx turns the pointer
 * into a target panel and a zone, dock/ArrangeOverlay.tsx draws the plan over the page, and a release commits it.
 *
 * Both keep the page tiled - every cell that was covered stays covered - so nothing has to be pushed down out of the
 * way and nothing leaves the screen: a swap trades two rectangles; a split hands the moved panel's rectangle to its
 * neighbours (closeGap) and then cuts the target in two.
 */
import { fillGaps } from './editPlace';
import type { PanelPlacement } from './types';

export interface ArrangeBox {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
  maxW?: number;
  maxH?: number;
  /** False: its width (or height) is not the user's to change - a strip. */
  growW: boolean;
  growH: boolean;
  fixed?: boolean;
}

/** Where over a target the pointer is: one of its four sides (a split) or its middle (a swap). */
export type Zone = 'left' | 'right' | 'top' | 'bottom' | 'center';

export interface MovePlan {
  /** Every panel after the move. */
  placements: PanelPlacement[];
  /** Where the moved panel lands. */
  box: PanelPlacement;
  kind: 'swap' | 'split';
  zone: Zone;
}

/** Why a move cannot happen: the moved panel cannot take the size it would get, or the target cannot. */
export type MoveRefusal = 'moved' | 'target';

export type MoveResult = { ok: true; plan: MovePlan } | { ok: false; why: MoveRefusal };

const place = ({ i, x, y, w, h }: { i: string; x: number; y: number; w: number; h: number }): PanelPlacement => ({ i, x, y, w, h });
const within = (v: number, lo: number | undefined, hi: number | undefined) => v >= Math.max(1, lo ?? 1) && v <= (hi ?? Infinity);
/** Whether `b` may be `w` wide and `h` tall: its own size, or one it may grow or shrink to. */
const takes = (b: ArrangeBox, w: number, h: number) =>
  (w === b.w || (b.growW && within(w, b.minW, b.maxW))) && (h === b.h || (b.growH && within(h, b.minH, b.maxH)));

/** The side band a pointer has to be in for a split; the middle swaps. */
export const SPLIT_BAND = 0.26;

/** The zone of a target the pointer is over, from where it is across (fx) and down (fy) the target, 0..1. */
export function zoneAt(fx: number, fy: number, band = SPLIT_BAND): Zone {
  const sides: [Zone, number][] = [['left', fx], ['right', 1 - fx], ['top', fy], ['bottom', 1 - fy]];
  sides.sort((a, b) => a[1] - b[1]);
  const [side, d] = sides[0]!;
  return d < band ? side : 'center';
}

/** Trade the moved panel's rectangle for the target's. */
export function swapMove(items: readonly ArrangeBox[], id: string, target: string): MoveResult {
  const a = items.find((b) => b.i === id);
  const t = items.find((b) => b.i === target);
  if (!a || !t || a === t) return { ok: false, why: 'target' };
  if (t.fixed || a.fixed) return { ok: false, why: t.fixed ? 'target' : 'moved' };
  if (!takes(a, t.w, t.h)) return { ok: false, why: 'moved' };
  if (!takes(t, a.w, a.h)) return { ok: false, why: 'target' };
  const box = place({ ...t, i: a.i });
  const placements = items.map((b) => (b.i === a.i ? box : b.i === t.i ? place({ ...a, i: t.i }) : place(b)));
  return { ok: true, plan: { placements, box, kind: 'swap', zone: 'center' } };
}

const sideOrder: Array<'left' | 'right' | 'top' | 'bottom'> = ['left', 'right', 'top', 'bottom'];

/**
 * The page with `gap` (a panel's old rectangle) covered again: the panels along one of its sides grow across it.
 * A side qualifies when the panels touching it lie within its length, cover all of it, and may all grow that way
 * that far. Of the sides that qualify the one with the fewest panels wins (a whole column of one panel before two
 * stacked ones); `tall` breaks a tie towards the sides along the gap's long edge. Null when no side qualifies.
 */
export function closeGap(items: readonly ArrangeBox[], gap: { x: number; y: number; w: number; h: number }, tall: boolean): ArrangeBox[] | null {
  let best: { n: number; order: number; out: ArrangeBox[] } | null = null;
  for (const side of sideOrder) {
    const across = side === 'left' || side === 'right';
    const touching = items.filter((b) => {
      if (side === 'left') return b.x + b.w === gap.x && b.y < gap.y + gap.h && b.y + b.h > gap.y;
      if (side === 'right') return b.x === gap.x + gap.w && b.y < gap.y + gap.h && b.y + b.h > gap.y;
      if (side === 'top') return b.y + b.h === gap.y && b.x < gap.x + gap.w && b.x + b.w > gap.x;
      return b.y === gap.y + gap.h && b.x < gap.x + gap.w && b.x + b.w > gap.x;
    });
    if (!touching.length) continue;
    const [lo, len] = across ? [gap.y, gap.h] : [gap.x, gap.w];
    const spans = touching.map((b) => (across ? [b.y, b.y + b.h] : [b.x, b.x + b.w]) as [number, number]).sort((p, q) => p[0] - q[0]);
    // Inside the side's length, end to end, no hole and no overhang.
    let at = lo;
    let ok = true;
    for (const [s, e] of spans) {
      if (s !== at) { ok = false; break; }
      at = e;
    }
    if (!ok || at !== lo + len) continue;
    const grow = across ? gap.w : gap.h;
    if (!touching.every((b) => !b.fixed && (across ? b.growW && b.w + grow <= (b.maxW ?? Infinity) : b.growH && b.h + grow <= (b.maxH ?? Infinity)))) continue;
    const ids = new Set(touching.map((b) => b.i));
    const out = items.map((b) => {
      if (!ids.has(b.i)) return b;
      if (side === 'left') return { ...b, w: b.w + grow };
      if (side === 'right') return { ...b, x: b.x - grow, w: b.w + grow };
      if (side === 'top') return { ...b, h: b.h + grow };
      return { ...b, y: b.y - grow, h: b.h + grow };
    });
    const order = (tall ? across : !across) ? 0 : 1;
    if (!best || touching.length < best.n || (touching.length === best.n && order < best.order)) best = { n: touching.length, order, out };
  }
  return best?.out ?? null;
}

/**
 * The moved panel into one side of the target - the target keeps the rest - or, in the middle, a swap. The moved
 * panel's old rectangle is handed to its neighbours first (closeGap; when no side can take it, the grid's own
 * fill closes it), so a target beside it is cut at its new size.
 *
 * The moved panel takes half the target along the cut, inside its own limits and leaving the target its minimum; a
 * panel that cannot change that way (a strip) keeps its own size there. Across the cut it takes the target's whole
 * length, which it has to be able to.
 */
export function splitMove(items: readonly ArrangeBox[], id: string, target: string, zone: Zone, cols: number, tall: boolean): MoveResult {
  if (zone === 'center') return swapMove(items, id, target);
  const a = items.find((b) => b.i === id);
  const t0 = items.find((b) => b.i === target);
  if (!a || !t0 || a === t0) return { ok: false, why: 'target' };
  if (t0.fixed || a.fixed) return { ok: false, why: t0.fixed ? 'target' : 'moved' };
  const rest = items.filter((b) => b.i !== id);
  const closed = closeGap(rest, a, tall)
    ?? (fillGaps(rest, { start: 0, end: cols }).map((f, k) => ({ ...rest[k]!, x: f.x, y: f.y, w: f.w, h: f.h })));
  const t = closed.find((b) => b.i === target)!;
  const across = zone === 'left' || zone === 'right';
  let box: PanelPlacement;
  let cut: PanelPlacement;
  if (across) {
    if (!t.growW) return { ok: false, why: 'target' };
    const tMin = Math.max(1, t.minW ?? 1);
    const want = a.growW ? Math.min(Math.max(Math.round(t.w / 2), Math.max(1, a.minW ?? 1)), a.maxW ?? Infinity) : a.w;
    const w = Math.min(want, t.w - tMin);
    if (w < (a.growW ? Math.max(1, a.minW ?? 1) : a.w)) return { ok: false, why: 'target' };
    if (!(t.h === a.h || (a.growH && within(t.h, a.minH, a.maxH)))) return { ok: false, why: 'moved' };
    box = { i: a.i, x: zone === 'left' ? t.x : t.x + t.w - w, y: t.y, w, h: t.h };
    cut = { i: t.i, x: zone === 'left' ? t.x + w : t.x, y: t.y, w: t.w - w, h: t.h };
  } else {
    if (!t.growH) return { ok: false, why: 'target' };
    const tMin = Math.max(1, t.minH ?? 1);
    const want = a.growH ? Math.min(Math.max(Math.round(t.h / 2), Math.max(1, a.minH ?? 1)), a.maxH ?? Infinity) : a.h;
    const h = Math.min(want, t.h - tMin);
    if (h < (a.growH ? Math.max(1, a.minH ?? 1) : a.h)) return { ok: false, why: 'target' };
    if (!(t.w === a.w || (a.growW && within(t.w, a.minW, a.maxW)))) return { ok: false, why: 'moved' };
    box = { i: a.i, x: t.x, y: zone === 'top' ? t.y : t.y + t.h - h, w: t.w, h };
    cut = { i: t.i, x: t.x, y: zone === 'top' ? t.y + h : t.y, w: t.w, h: t.h - h };
  }
  const placements = [...closed.map((b) => (b.i === target ? cut : place(b))), box];
  return { ok: true, plan: { placements, box, kind: 'split', zone } };
}

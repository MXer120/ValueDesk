/**
 * A board's geometry, without React (BoardEditor.tsx draws it): boxes, where
 * an arrow attached to a shape meets its edge, moving things (a frame takes
 * what is inside it along, attached arrows follow), resizing one thing or a
 * group, the alignment guides things snap to while they move, fitting the view,
 * and keeping every number inside what the server keeps (validate.ts
 * checkBoard).
 *
 * Board units: an element's box is x, y, w, h. A line or an arrow keeps its two
 * ends as points relative to its box; a pen stroke its points the same way.
 */
import { BOARD_MAX, type BoardElement } from '@sign/folders/types.js';

export type El = BoardElement;
export interface P {
  x: number;
  y: number;
}
export interface Box extends P {
  w: number;
  h: number;
}
export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export const HANDLES: readonly Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export const isLine = (e: El): boolean => e.type === 'line' || e.type === 'arrow';
export const isShape = (e: El): boolean => e.type === 'rect' || e.type === 'ellipse' || e.type === 'diamond';
/** What a line can be attached to. */
export const isAttachable = (e: El): boolean => !isLine(e) && e.type !== 'pen';

const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
export function newId(): string {
  const b = new Uint8Array(10);
  crypto.getRandomValues(b);
  return Array.from(b, (n) => ID_CHARS[n & 63]).join('');
}

export const r1 = (n: number): number => Math.round(n * 10) / 10;

export function boxOf(e: El): Box {
  return { x: e.x, y: e.y, w: e.w, h: e.h };
}

export function unionBox(boxes: readonly Box[]): Box | null {
  if (!boxes.length) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const b of boxes) {
    x1 = Math.min(x1, b.x);
    y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.w);
    y2 = Math.max(y2, b.y + b.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export const intersects = (a: Box, b: Box): boolean => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
export const contains = (o: Box, i: Box): boolean => i.x >= o.x && i.y >= o.y && i.x + i.w <= o.x + o.w && i.y + i.h <= o.y + o.h;
export const center = (b: Box): P => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** A box from two corners, in any order. */
export function boxFrom(a: P, b: P): Box {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

/**
 * Where a ray from the box's center toward `to` leaves its outline - a
 * rectangle's, an ellipse's or a diamond's - plus a small gap, so an arrow's
 * head stops at the edge instead of inside.
 */
export function edgePoint(b: Box, type: El['type'], to: P, gap = 6): P {
  const c = center(b);
  const dx = to.x - c.x;
  const dy = to.y - c.y;
  if (!dx && !dy) return c;
  const hw = b.w / 2 + gap;
  const hh = b.h / 2 + gap;
  let t: number;
  if (type === 'ellipse') t = 1 / Math.sqrt((dx * dx) / (hw * hw || 1) + (dy * dy) / (hh * hh || 1));
  else if (type === 'diamond') t = 1 / (Math.abs(dx) / (hw || 1) + Math.abs(dy) / (hh || 1));
  else t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

/** A line's two ends on the board, an attached end where it meets its element. */
export function lineEnds(e: El, byId: ReadonlyMap<string, El>): { a: P; b: P } {
  const p = e.points ?? [0, 0, e.w, e.h];
  let a = { x: e.x + p[0]!, y: e.y + p[1]! };
  let b = { x: e.x + p[2]!, y: e.y + p[3]! };
  const fa = e.from ? byId.get(e.from) : undefined;
  const fb = e.to ? byId.get(e.to) : undefined;
  // Each attached end aims at the other end (its element's center when attached).
  const aim = (el: El | undefined, fallback: P) => (el ? center(boxOf(el)) : fallback);
  if (fa) a = edgePoint(boxOf(fa), fa.type, aim(fb, b));
  if (fb) b = edgePoint(boxOf(fb), fb.type, aim(fa, a));
  return { a, b };
}

/** A line or an arrow through two points: its box, and its ends relative to it. */
export function lineThrough(e: El, a: P, b: P): El {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { ...e, x: r1(x), y: r1(y), w: r1(Math.abs(b.x - a.x)), h: r1(Math.abs(b.y - a.y)), points: [r1(a.x - x), r1(a.y - y), r1(b.x - x), r1(b.y - y)] };
}

/** Attached lines put where their elements are now; a line whose element is gone keeps its end where it was. */
export function settleLines(els: readonly El[]): El[] {
  const byId = new Map(els.map((e) => [e.id, e]));
  return els.map((e) => {
    if (!isLine(e) || (!e.from && !e.to)) return e;
    const { a, b } = lineEnds(e, byId);
    const next = lineThrough(e, a, b);
    return { ...next, ...(e.from && !byId.has(e.from) ? { from: undefined } : {}), ...(e.to && !byId.has(e.to) ? { to: undefined } : {}) };
  });
}

/** A pen stroke from points on the board: its box, its points relative to it. */
export function penFrom(e: El, pts: readonly P[]): El {
  const b = unionBox(pts.map((p) => ({ ...p, w: 0, h: 0 }))) ?? { x: e.x, y: e.y, w: 0, h: 0 };
  return { ...e, x: r1(b.x), y: r1(b.y), w: r1(b.w), h: r1(b.h), points: pts.flatMap((p) => [r1(p.x - b.x), r1(p.y - b.y)]) };
}

/** Fewer points along a stroke (each at least `min` apart), so a long one stays small. */
export function thin(pts: readonly P[], min: number): P[] {
  if (pts.length < 3) return [...pts];
  const out = [pts[0]!];
  for (let i = 1; i < pts.length - 1; i++) {
    const l = out[out.length - 1]!;
    if (Math.hypot(pts[i]!.x - l.x, pts[i]!.y - l.y) >= min) out.push(pts[i]!);
  }
  out.push(pts[pts.length - 1]!);
  return out;
}

/** What lies wholly inside a frame (and is not a frame itself). */
export function insideFrame(els: readonly El[], frame: El): string[] {
  const fb = boxOf(frame);
  return els.filter((e) => e.id !== frame.id && e.type !== 'frame' && contains(fb, boxOf(e))).map((e) => e.id);
}

/** The ids a move of `ids` takes along: the elements in a moved frame. Locked ones stay. */
export function movedWith(els: readonly El[], ids: ReadonlySet<string>): Set<string> {
  const out = new Set(ids);
  for (const e of els) if (ids.has(e.id) && e.type === 'frame') for (const id of insideFrame(els, e)) out.add(id);
  for (const e of els) if (e.lock) out.delete(e.id);
  return out;
}

/** Move these by (dx, dy); attached lines follow. */
export function moveBy(els: readonly El[], ids: ReadonlySet<string>, dx: number, dy: number): El[] {
  const moved = els.map((e) => (ids.has(e.id) ? { ...e, x: r1(e.x + dx), y: r1(e.y + dy) } : e));
  return settleLines(moved);
}

const MIN = 8;

/** One element's box dragged by a handle to `p`; `ratio` keeps its proportions (Shift, an image). */
export function resizeBox(start: Box, handle: Handle, p: P, ratio: boolean): Box {
  let x1 = start.x;
  let y1 = start.y;
  let x2 = start.x + start.w;
  let y2 = start.y + start.h;
  if (handle.includes('w')) x1 = Math.min(p.x, x2 - MIN);
  if (handle.includes('e')) x2 = Math.max(p.x, x1 + MIN);
  if (handle.includes('n')) y1 = Math.min(p.y, y2 - MIN);
  if (handle.includes('s')) y2 = Math.max(p.y, y1 + MIN);
  let b = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  if (ratio && start.w > 0 && start.h > 0) {
    const k = start.w / start.h;
    const byW = handle === 'n' || handle === 's' ? false : handle === 'e' || handle === 'w' ? true : b.w / b.h > k;
    if (byW) {
      const h = b.w / k;
      b = { ...b, h, y: handle.includes('n') ? y2 - h : handle === 'e' || handle === 'w' ? start.y + (start.h - h) / 2 : y1 };
    } else {
      const w = b.h * k;
      b = { ...b, w, x: handle.includes('w') ? x2 - w : handle === 'n' || handle === 's' ? start.x + (start.w - w) / 2 : x1 };
    }
  }
  return { x: r1(b.x), y: r1(b.y), w: r1(b.w), h: r1(b.h) };
}

/** Elements scaled from one group box to another (a group resized by a handle). */
export function scaleGroup(els: readonly El[], ids: ReadonlySet<string>, from: Box, to: Box): El[] {
  const kx = from.w ? to.w / from.w : 1;
  const ky = from.h ? to.h / from.h : 1;
  const sx = (x: number) => to.x + (x - from.x) * kx;
  const sy = (y: number) => to.y + (y - from.y) * ky;
  const out = els.map((e) => {
    if (!ids.has(e.id) || e.lock) return e;
    const next: El = { ...e, x: r1(sx(e.x)), y: r1(sy(e.y)), w: r1(e.w * kx), h: r1(e.h * ky) };
    if (e.points) next.points = e.points.map((v, i) => r1(v * (i % 2 ? ky : kx)));
    if (e.fs && (e.type === 'text' || e.type === 'sticky')) next.fs = Math.max(6, Math.min(400, r1(e.fs * Math.min(kx, ky))));
    return next;
  });
  return settleLines(out);
}

/* --------------------------------------------------------------- snapping ----- */

export interface Guide {
  /** A vertical line at x (from y1 to y2), or a horizontal one at y. */
  axis: 'x' | 'y';
  at: number;
  from: number;
  to: number;
}

/**
 * How far a moving box should shift to line up with the others - an edge or
 * the center with an edge or a center - within `tol`, and the guides to draw.
 */
export function snap(moving: Box, others: readonly Box[], tol: number): { dx: number; dy: number; guides: Guide[] } {
  const xs = (b: Box) => [b.x, b.x + b.w / 2, b.x + b.w];
  const ys = (b: Box) => [b.y, b.y + b.h / 2, b.y + b.h];
  let best: { dx: number; at: number; o: Box } | null = null;
  let bestY: { dy: number; at: number; o: Box } | null = null;
  for (const o of others) {
    for (const mx of xs(moving)) for (const ox of xs(o)) {
      const d = ox - mx;
      if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.dx))) best = { dx: d, at: ox, o };
    }
    for (const my of ys(moving)) for (const oy of ys(o)) {
      const d = oy - my;
      if (Math.abs(d) <= tol && (!bestY || Math.abs(d) < Math.abs(bestY.dy))) bestY = { dy: d, at: oy, o };
    }
  }
  const guides: Guide[] = [];
  const m = { ...moving, x: moving.x + (best?.dx ?? 0), y: moving.y + (bestY?.dy ?? 0) };
  if (best) guides.push({ axis: 'x', at: best.at, from: Math.min(m.y, best.o.y), to: Math.max(m.y + m.h, best.o.y + best.o.h) });
  if (bestY) guides.push({ axis: 'y', at: bestY.at, from: Math.min(m.x, bestY.o.x), to: Math.max(m.x + m.w, bestY.o.x + bestY.o.w) });
  return { dx: best?.dx ?? 0, dy: bestY?.dy ?? 0, guides };
}

/* ------------------------------------------------------------------- view ----- */

export interface View {
  x: number;
  y: number;
  z: number;
}
export const Z_MIN = 0.1;
export const Z_MAX = 4;
export const clampZ = (z: number): number => Math.max(Z_MIN, Math.min(Z_MAX, z));

/** The view that shows these boxes in a viewport of w × h, with a margin. */
export function fitView(boxes: readonly Box[], w: number, h: number, margin = 60): View {
  const u = unionBox(boxes);
  if (!u || !w || !h) return { x: w / 2, y: h / 2, z: 1 };
  const z = clampZ(Math.min((w - margin * 2) / Math.max(u.w, 1), (h - margin * 2) / Math.max(u.h, 1), 1.5));
  return { x: w / 2 - (u.x + u.w / 2) * z, y: h / 2 - (u.y + u.h / 2) * z, z };
}

/** Zoom to `z` keeping the board point under (sx, sy) where it is on screen. */
export function zoomAt(v: View, z: number, sx: number, sy: number): View {
  const nz = clampZ(z);
  const wx = (sx - v.x) / v.z;
  const wy = (sy - v.y) / v.z;
  return { x: sx - wx * nz, y: sy - wy * nz, z: nz };
}

/* ----------------------------------------------------------------- saving ----- */

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));

/** Elements as the server keeps them: numbers in range and rounded, sizes not negative, ends attached only to what exists. */
export function forSaving(els: readonly El[]): El[] {
  const ids = new Set(els.map((e) => e.id));
  const C = BOARD_MAX.coord;
  return els.slice(0, BOARD_MAX.elements).map((e) => {
    const out: El = { ...e, x: r1(clamp(e.x, -C, C)), y: r1(clamp(e.y, -C, C)), w: r1(clamp(e.w, 0, BOARD_MAX.size)), h: r1(clamp(e.h, 0, BOARD_MAX.size)) };
    if (out.points) out.points = out.points.slice(0, BOARD_MAX.points - (BOARD_MAX.points % 2)).map((v) => r1(clamp(v, -C, C)));
    if (out.text && out.text.length > BOARD_MAX.text) out.text = out.text.slice(0, BOARD_MAX.text);
    if (out.from && !ids.has(out.from)) delete out.from;
    if (out.to && !ids.has(out.to)) delete out.to;
    for (const k of Object.keys(out) as Array<keyof El>) if (out[k] === undefined) delete out[k];
    return out;
  });
}

/** A copy of these elements for pasting: new ids, shifted, links among them kept and links outside dropped. */
export function duplicate(els: readonly El[], dx: number, dy: number): El[] {
  const ids = new Map(els.map((e) => [e.id, newId()]));
  return els.map((e) => ({
    ...e,
    id: ids.get(e.id)!,
    x: r1(e.x + dx),
    y: r1(e.y + dy),
    from: e.from ? ids.get(e.from) : undefined,
    to: e.to ? ids.get(e.to) : undefined,
  }));
}

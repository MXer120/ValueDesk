/**
 * Seams: where panels meet, and what moving that line does.
 *
 * A horizontal seam is a row line Y where some panels end and others start,
 * joined by overlapping columns; dragging it by d rows grows every panel above
 * by d and moves every panel below down by d and shrinks it by d, so nothing
 * beyond the seam moves - drag the line under the chart, the book and the
 * ticket and all three get shorter while the account tables under them get
 * taller. A vertical seam is the same on a column line X with widths.
 *
 * Pure: grid units in, grid units out (Dashboard.tsx draws and drags them).
 */

export interface SeamBox {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
  maxW?: number;
  maxH?: number;
  /** Whether this panel may change height (or width) at all. */
  growH: boolean;
  growW: boolean;
}

export interface Seam {
  /** 'h': a row line (drag up and down); 'v': a column line (drag left and right). */
  axis: 'h' | 'v';
  /** The line, in rows ('h') or columns ('v'). */
  at: number;
  /** The span the seam is drawn over, in the other unit. */
  from: number;
  to: number;
  /** Ids above (or left of) the line, and below (or right of) it. */
  before: string[];
  after: string[];
}

const overlap = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && b0 < a1;

function components(before: SeamBox[], after: SeamBox[], axis: 'h' | 'v'): Array<{ before: SeamBox[]; after: SeamBox[] }> {
  const all = [...before, ...after];
  const parent = all.map((_, k) => k);
  const find = (k: number): number => (parent[k] === k ? k : (parent[k] = find(parent[k]!)));
  const span = (b: SeamBox): [number, number] => (axis === 'h' ? [b.x, b.x + b.w] : [b.y, b.y + b.h]);
  before.forEach((a, ia) => {
    after.forEach((b, ib) => {
      const [a0, a1] = span(a);
      const [b0, b1] = span(b);
      if (overlap(a0, a1, b0, b1)) parent[find(ia)] = find(before.length + ib);
    });
  });
  const groups = new Map<number, { before: SeamBox[]; after: SeamBox[] }>();
  all.forEach((b, k) => {
    const g = groups.get(find(k)) ?? { before: [], after: [] };
    (k < before.length ? g.before : g.after).push(b);
    groups.set(find(k), g);
  });
  return [...groups.values()].filter((g) => g.before.length && g.after.length);
}

/** Every seam a drag can move: each side's panels all resizable that way. */
export function findSeams(items: readonly SeamBox[]): Seam[] {
  const out: Seam[] = [];
  for (const axis of ['h', 'v'] as const) {
    const ends = new Set(items.map((b) => (axis === 'h' ? b.y + b.h : b.x + b.w)));
    for (const at of [...ends].sort((a, b) => a - b)) {
      if (at <= 0) continue;
      const before = items.filter((b) => (axis === 'h' ? b.y + b.h : b.x + b.w) === at);
      const after = items.filter((b) => (axis === 'h' ? b.y : b.x) === at);
      for (const g of components(before, after, axis)) {
        const parts = [...g.before, ...g.after];
        if (!parts.every((b) => (axis === 'h' ? b.growH : b.growW))) continue;
        const lo = Math.min(...parts.map((b) => (axis === 'h' ? b.x : b.y)));
        const hi = Math.max(...parts.map((b) => (axis === 'h' ? b.x + b.w : b.y + b.h)));
        out.push({ axis, at, from: lo, to: hi, before: g.before.map((b) => b.i), after: g.after.map((b) => b.i) });
      }
    }
  }
  return out;
}

/** The move the panels allow: `d` cut so no side goes below its minimum or above its maximum. */
export function clampSeam(items: readonly SeamBox[], seam: Seam, d: number): number {
  const by = new Map(items.map((b) => [b.i, b]));
  let lo = -Infinity;
  let hi = Infinity;
  const size = (b: SeamBox) => (seam.axis === 'h' ? b.h : b.w);
  const min = (b: SeamBox) => Math.max(1, (seam.axis === 'h' ? b.minH : b.minW) ?? 1);
  const max = (b: SeamBox) => (seam.axis === 'h' ? b.maxH : b.maxW) ?? Infinity;
  for (const id of seam.before) {
    const b = by.get(id);
    if (!b) continue;
    lo = Math.max(lo, min(b) - size(b));
    hi = Math.min(hi, max(b) - size(b));
  }
  for (const id of seam.after) {
    const b = by.get(id);
    if (!b) continue;
    hi = Math.min(hi, size(b) - min(b));
    lo = Math.max(lo, size(b) - max(b));
  }
  if (lo > hi) return 0;
  return Math.max(lo, Math.min(hi, Math.round(d)));
}

/** The panels after moving `seam` by `d` (already clamped). */
export function moveSeam<T extends SeamBox>(items: readonly T[], seam: Seam, d: number): T[] {
  if (!d) return [...items];
  const before = new Set(seam.before);
  const after = new Set(seam.after);
  return items.map((b) => {
    if (before.has(b.i)) return seam.axis === 'h' ? { ...b, h: b.h + d } : { ...b, w: b.w + d };
    if (after.has(b.i)) return seam.axis === 'h' ? { ...b, y: b.y + d, h: b.h - d } : { ...b, x: b.x + d, w: b.w - d };
    return b;
  });
}

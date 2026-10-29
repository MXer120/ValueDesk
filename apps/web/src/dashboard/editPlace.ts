/**
 * Geometry for edit mode. Pure: the scaled page is a CSS transform, so a drop
 * has to be converted from visual pixels back into grid cells. Nothing here
 * reads the DOM except the element the caller already measured.
 */
import { resolveLayout } from './resolve';
import type { LayoutSlot } from './storage';
import type { BreakpointName, PanelDefinition, PanelPlacement } from './types';

/** A press shorter than this is a click (preview latches). Longer is a hold. */
export const PREVIEW_HOLD_MS = 250;

/** A panel drag that barely moves is a click, not a reposition. */
export const DRAG_COMMIT_PX = 4;

export interface ThumbBlock {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where a pointer lands in grid units.
 *
 * `grid` may sit under a CSS scale. `getBoundingClientRect` is the visual box;
 * `offsetWidth` is the layout box the columns were resolved against. A grid
 * with no height (an empty canvas before it is stretched) is cell 0,0.
 */
export function cellAt(
  clientX: number,
  clientY: number,
  grid: HTMLElement,
  cols: number,
  rowHeight: number,
  margin: [number, number],
  padding: [number, number],
): { x: number; y: number } {
  const at = pointAt(clientX, clientY, grid, cols, rowHeight, margin, padding);
  return { x: Math.min(cols - 1, Math.max(0, Math.floor(at.x))), y: Math.max(0, Math.floor(at.y)) };
}

/** The same point in fractional cells (0..cols across), for which half of a pane it is over. */
export function pointAt(
  clientX: number,
  clientY: number,
  grid: HTMLElement,
  cols: number,
  rowHeight: number,
  margin: [number, number],
  padding: [number, number],
): { x: number; y: number } {
  const rect = grid.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8 || cols < 1) return { x: 0, y: 0 };
  const scaleX = grid.offsetWidth / rect.width;
  const scaleY = grid.offsetHeight / rect.height;
  const innerW = grid.offsetWidth - padding[0] * 2;
  const strideX = (innerW - margin[0] * (cols - 1)) / cols + margin[0];
  const strideY = rowHeight + margin[1];
  if (strideX <= 0 || strideY <= 0) return { x: 0, y: 0 };
  const lx = (clientX - rect.left) * scaleX - padding[0];
  const ly = (clientY - rect.top) * scaleY - padding[1];
  return { x: Math.min(cols - 0.001, Math.max(0, lx / strideX)), y: Math.max(0, ly / strideY) };
}

export type DropSide = 'left' | 'right' | 'top' | 'bottom';

/** A pane on the canvas, with the limits the registry gives it (resolve.ts). */
export interface DropItem {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
  maxW?: number;
  maxH?: number;
  /** False: its width is not the user's to change (a strip that only resizes one way). */
  growW?: boolean;
  /** False: its height is its content's (a strip). */
  growH?: boolean;
  fixed?: boolean;
}

export interface DropPlan {
  /** Every pane after the drop: a split pane at its new size, the others as they were, the new one last. */
  placements: PanelPlacement[];
  /** Where the new widget lands. */
  box: PanelPlacement;
  /** The pane it splits or goes beside, and on which side; null in free space. */
  target: { i: string; side: DropSide; split: boolean } | null;
}

const clampN = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Where a widget dragged in from the palette lands, from the point under the
 * pointer (fractional cells, `pointAt`).
 *
 * Over a pane, the pane is split on the side the pointer is nearest - its left,
 * right, top or bottom half - when both halves keep their minimum size and the
 * pane may change that way; the other axis is tried next. When neither split
 * fits, the widget goes in above or below the pane at its width and the panes
 * under it move down. In free space it lands centred on the pointer at its
 * default size. The live grid's compaction then settles it, the same for the
 * preview and the drop.
 */
export function dropPlan(
  items: readonly DropItem[],
  at: { x: number; y: number },
  add: { i: string; w: number; h: number; minW?: number; minH?: number; maxW?: number; maxH?: number },
  cols: number,
): DropPlan {
  const base = items.filter((it) => it.i !== add.i).map(({ i, x, y, w, h }) => ({ i, x, y, w, h }));
  const minW = clampN(add.minW ?? 1, 1, cols);
  const minH = Math.max(1, add.minH ?? 1);
  const maxW = Math.min(cols, add.maxW ?? cols);
  const maxH = add.maxH ?? Infinity;
  const target = items.find((it) => it.i !== add.i && !it.fixed && at.x >= it.x && at.x < it.x + it.w && at.y >= it.y && at.y < it.y + it.h);

  if (!target) {
    const w = clampN(Math.round(add.w), minW, maxW);
    const h = clampN(Math.round(add.h), minH, maxH);
    const x = clampN(Math.round(at.x - w / 2), 0, cols - w);
    const box = { i: add.i, x, y: Math.max(0, Math.floor(at.y)), w, h };
    return { placements: [...base, box], box, target: null };
  }

  const fx = (at.x - target.x) / target.w;
  const fy = (at.y - target.y) / target.h;
  const near: [DropSide, number][] = [['left', fx], ['right', 1 - fx], ['top', fy], ['bottom', 1 - fy]];
  near.sort((a, b) => a[1] - b[1]);
  const first = near[0]![0];
  const across = first === 'left' || first === 'right';
  const other = near.find(([s]) => (s === 'left' || s === 'right') !== across)![0];

  const split = (side: DropSide): { box: PanelPlacement; rest: PanelPlacement } | null => {
    const t = target;
    if (side === 'left' || side === 'right') {
      if (t.growW === false) return null;
      const tMin = Math.max(1, t.minW ?? 1);
      const w = Math.min(clampN(Math.round(t.w / 2), minW, maxW), t.w - tMin);
      if (w < minW || t.h < minH || t.h > maxH) return null;
      const box = { i: add.i, x: side === 'left' ? t.x : t.x + t.w - w, y: t.y, w, h: t.h };
      const rest = { i: t.i, x: side === 'left' ? t.x + w : t.x, y: t.y, w: t.w - w, h: t.h };
      return { box, rest };
    }
    if (t.growH === false) return null;
    const tMin = Math.max(1, t.minH ?? 1);
    const h = Math.min(clampN(Math.round(t.h / 2), minH, maxH), t.h - tMin);
    if (h < minH || t.w < minW || t.w > maxW) return null;
    const box = { i: add.i, x: t.x, y: side === 'top' ? t.y : t.y + t.h - h, w: t.w, h };
    const rest = { i: t.i, x: t.x, y: side === 'top' ? t.y + h : t.y, w: t.w, h: t.h - h };
    return { box, rest };
  };

  for (const side of [first, other]) {
    const s = split(side);
    if (!s) continue;
    return {
      placements: [...base.map((p) => (p.i === target.i ? s.rest : p)), s.box],
      box: s.box,
      target: { i: target.i, side, split: true },
    };
  }

  // No room to split: a row of its own above or below the pane, at the pane's width.
  const side: DropSide = fy < 0.5 ? 'top' : 'bottom';
  const w = clampN(target.w, minW, maxW);
  const h = clampN(Math.round(add.h), minH, maxH);
  const x = clampN(target.x, 0, cols - w);
  const y = side === 'top' ? target.y : target.y + target.h;
  const box = { i: add.i, x, y, w, h };
  const moved = base.map((p) => (p.y >= y ? { ...p, y: p.y + h } : p));
  return { placements: [...moved, box], box, target: { i: target.i, side, split: false } };
}

/** Top-left of `cell`, clamped so the panel stays inside the column count. */
export function placementAt(
  id: string,
  cell: { x: number; y: number },
  w: number,
  h: number,
  cols: number,
): PanelPlacement {
  const width = Math.max(1, Math.min(Math.round(w), cols));
  const height = Math.max(1, Math.round(h));
  const x = Math.max(0, Math.min(Math.round(cell.x), cols - width));
  return { i: id, x, y: Math.max(0, Math.round(cell.y)), w: width, h: height };
}

/**
 * The first free `w` x `h` box, row by row from the top and left to right in a
 * row: where a widget added with a click (not dragged) goes. Under everything
 * at the left edge when nothing is free.
 */
export function firstFit(items: readonly { x: number; y: number; w: number; h: number }[], w: number, h: number, cols: number): { x: number; y: number } {
  const width = Math.max(1, Math.min(Math.round(w), cols));
  const height = Math.max(1, Math.round(h));
  const bottom = items.reduce((m, it) => Math.max(m, it.y + it.h), 0);
  const free = (x: number, y: number) => !items.some((o) => o.x < x + width && o.x + o.w > x && o.y < y + height && o.y + o.h > y);
  for (let y = 0; y < bottom; y++) {
    for (let x = 0; x + width <= cols; x++) if (free(x, y)) return { x, y };
  }
  return { x: 0, y: bottom };
}

/** Replace one panel's placement. Order of the others stays put. */
export function upsertPlacement(current: readonly PanelPlacement[], next: PanelPlacement): PanelPlacement[] {
  let found = false;
  const out = current.map((p) => {
    if (p.i !== next.i) return p;
    found = true;
    return next;
  });
  return found ? out : [...out, next];
}

/**
 * Columns the Fill button may grow into.
 *
 * `start` is inclusive and `end` is exclusive. Fixed edit chrome (the right
 * palette, the left bar) is passed as horizontal obstacles. A column is blocked
 * when its cell overlaps one of them. Blocked columns are peeled from both
 * ends, so the sidebar stops a panel from growing underneath it.
 *
 * Only the horizontal edges are used. Vertical scroll moves the grid and the
 * fixed chrome together in x, so the same columns stay blocked at every scroll
 * offset, including rows that are below the fold. A sideways scroll changes
 * `visualLeft` and is picked up because the caller measured the live rects.
 */
export function clearColumnSpan(
  cols: number,
  grid: { layoutWidth: number; visualLeft: number; visualWidth: number },
  obstacles: readonly { left: number; right: number }[],
  marginX: number,
  paddingX: number,
): { start: number; end: number } {
  if (cols < 1 || grid.visualWidth < 8 || grid.layoutWidth < 8) return { start: 0, end: Math.max(0, cols) };
  const scale = grid.layoutWidth / grid.visualWidth;
  const inner = grid.layoutWidth - paddingX * 2;
  const cell = (inner - marginX * Math.max(0, cols - 1)) / cols;
  const stride = cell + marginX;
  if (!(cell > 0) || !(scale > 0)) return { start: 0, end: cols };
  const blocked = (i: number): boolean => {
    const visLeft = grid.visualLeft + (paddingX + i * stride) / scale;
    const visRight = visLeft + cell / scale;
    return obstacles.some((o) => o.right > visLeft + 0.5 && o.left < visRight - 0.5);
  };
  let start = 0;
  while (start < cols && blocked(start)) start += 1;
  let end = cols;
  while (end > start && blocked(end - 1)) end -= 1;
  return { start, end };
}

export interface FillItem {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
  maxW?: number;
  maxH?: number;
  /** Default true. False keeps the width (a panel that only resizes vertically). */
  growW?: boolean;
  /** Default true. False keeps the height. */
  growH?: boolean;
  /** Stays where it is and blocks everyone else. */
  fixed?: boolean;
}

const overlaps = (
  item: FillItem,
  others: readonly FillItem[],
  x: number,
  y: number,
  w: number,
  h: number,
): boolean => others.some((o) =>
  o !== item && o.x < x + w && o.x + o.w > x && o.y < y + h && o.y + o.h > y,
);

/**
 * Close empty cells. Items compact upward (the same direction the live grid
 * already compacts), then each panel that sits fully inside `span` grows
 * sideways and then downward into free cells.
 *
 * Growth stops at the span, so columns under the sidebar are not filled.
 * Height stops at the current content bottom, so the canvas does not grow.
 * Rows below the fold are included: the inputs are the whole layout, not the
 * viewport. Panels that already cross into the blocked columns are left at
 * their size — Fill does not crop a panel the user placed there.
 */
export function fillGaps(
  items: readonly FillItem[],
  span: { start: number; end: number },
): FillItem[] {
  const start = Math.max(0, Math.floor(span.start));
  const end = Math.max(start, Math.floor(span.end));
  const copies: FillItem[] = items.map((item) => ({
    ...item,
    x: Math.max(0, Math.round(item.x)),
    y: Math.max(0, Math.round(item.y)),
    w: Math.max(1, Math.round(item.w)),
    h: Math.max(1, Math.round(item.h)),
  }));
  const byRow = (a: FillItem, b: FillItem) => a.y - b.y || a.x - b.x;
  const placed: FillItem[] = copies.filter((item) => item.fixed);
  const cap = copies.reduce((sum, item) => sum + item.h, 0) + 1;
  for (const item of copies.filter((entry) => !entry.fixed).sort(byRow)) {
    let y = 0;
    let guard = 0;
    while (guard < cap && overlaps(item, placed, item.x, y, item.w, item.h)) {
      let floor = y + 1;
      for (const other of placed) {
        if (other.x < item.x + item.w && other.x + other.w > item.x && other.y + other.h > y && other.y < y + item.h) {
          floor = Math.max(floor, other.y + other.h);
        }
      }
      y = floor;
      guard += 1;
    }
    item.y = y;
    placed.push(item);
  }

  const inside = (item: FillItem): boolean =>
    !item.fixed && item.x >= start && item.x + item.w <= end;
  for (const item of placed.filter(inside).sort(byRow)) {
    if (item.growW === false) continue;
    const minW = Math.max(1, item.minW ?? 1);
    const maxW = Math.max(minW, Math.min(item.maxW ?? (end - start), end - start));
    item.w = Math.min(Math.max(item.w, minW), maxW);
    if (item.x + item.w > end) item.x = Math.max(start, end - item.w);
    while (item.w < maxW && item.x + item.w < end && !overlaps(item, placed, item.x, item.y, item.w + 1, item.h)) {
      item.w += 1;
    }
    while (item.w < maxW && item.x > start && !overlaps(item, placed, item.x - 1, item.y, item.w + 1, item.h)) {
      item.x -= 1;
      item.w += 1;
    }
  }

  const bottom = placed.reduce((max, item) => Math.max(max, item.y + item.h), 0);
  for (const item of placed.filter(inside).sort(byRow)) {
    if (item.growH === false) continue;
    const minH = Math.max(1, item.minH ?? 1);
    const maxH = Math.max(minH, item.maxH ?? bottom);
    item.h = Math.min(Math.max(item.h, minH), maxH);
    while (item.h < maxH && item.y + item.h < bottom && !overlaps(item, placed, item.x, item.y, item.w, item.h + 1)) {
      item.h += 1;
    }
  }

  const byId = new Map(copies.map((item) => [item.i, item]));
  return items.map((item) => byId.get(item.i) ?? { ...item });
}

/**
 * Schematic of a slot that is NOT the one on screen. The active slot uses the
 * live grid instead, so compaction shows up in its thumbnail.
 */
export function slotBlocks<C>(
  panels: readonly PanelDefinition<C>[],
  defaults: readonly PanelPlacement[],
  slot: LayoutSlot,
  bp: BreakpointName,
  cols: number,
  rowHeight: number,
  margin: [number, number],
): ThumbBlock[] {
  const shown = new Set(slot.shown ?? []);
  const hidden = new Set(slot.hidden ?? []);
  const visible = panels.filter((p) => {
    if (slot.blank) return shown.has(p.id);
    if (hidden.has(p.id)) return false;
    if (p.defaultHidden && !shown.has(p.id)) return false;
    return true;
  });
  return resolveLayout([...visible], [...defaults], slot.layouts[bp], cols, { rowHeight, margin })
    .map(({ i, x, y, w, h }) => ({ i, x, y, w, h }));
}

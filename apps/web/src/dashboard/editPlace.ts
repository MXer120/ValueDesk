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
  const x = Math.min(cols - 1, Math.max(0, Math.floor(lx / strideX)));
  const y = Math.max(0, Math.floor(ly / strideY));
  return { x, y };
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

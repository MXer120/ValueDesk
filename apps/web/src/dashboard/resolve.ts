/**
 * Turning three sources of truth into one grid layout.
 *
 *   registry  -> size limits and resize behaviour   (authoritative, always)
 *   saved     -> where the user dragged it          (wins on position/size)
 *   config    -> the designed default               (fallback)
 *
 * The ordering matters. Constraints are re-applied from the registry on every
 * resolve rather than being persisted, so tightening a panel's minimum height
 * takes effect for users who already have a saved layout - otherwise the one
 * thing you can never fix is a panel someone has already made too small.
 */
import type { LayoutItem, ResizeHandleAxis } from 'react-grid-layout';
import type { BreakpointName, PanelDefinition, PanelPlacement, ResizeMode } from './types';
import { BREAKPOINT_ORDER } from './types';

/** Fallback size for a panel that has no placement anywhere yet. */
const AUTO_H = 8;

/**
 * Which resize grips a panel gets.
 *
 * A 'both' panel gets ONLY the corner grip, not one grip per axis plus a
 * corner - 'se' already drags width and height together, so 'e' and 's'
 * were two extra handles doing nothing a single diagonal drag could not.
 * 'horizontal'/'vertical' panels still need their own single grip: there is
 * no corner drag to fall back to when only one axis is allowed to change at
 * all, so restricting to the one axis's own handle IS the constraint. min/max
 * are belt and braces for programmatic changes.
 */
const HANDLES: Record<ResizeMode, ResizeHandleAxis[]> = {
  both: ['se'],
  horizontal: ['e'],
  vertical: ['s'],
  none: [],
};

export function breakpointFor(width: number, breakpoints: Record<BreakpointName, number>): BreakpointName {
  // Ascending order, so the last one whose minimum the width clears wins.
  let match: BreakpointName = BREAKPOINT_ORDER[0] ?? 'xs';
  for (const name of BREAKPOINT_ORDER) {
    if (width >= breakpoints[name]) match = name;
  }
  return match;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Build the react-grid-layout `layout` for one breakpoint.
 *
 * `panels` must already be filtered to the ones currently visible - a hidden
 * panel deliberately gets no layout item, so react-grid-layout does not reserve
 * space for a panel that is not on screen.
 */
export function resolveLayout<C>(
  panels: PanelDefinition<C>[],
  defaults: PanelPlacement[],
  saved: PanelPlacement[] | undefined,
  cols: number,
  /* The live geometry, needed to turn a pixel floor into rows. Optional so the
     existing call shape and every test keep working; without it `minPx` simply
     does not apply. */
  metrics?: { rowHeight: number; margin: [number, number] },
): LayoutItem[] {
  const byId = (list: PanelPlacement[] | undefined): Map<string, PanelPlacement> =>
    new Map((list ?? []).map((p) => [p.i, p]));
  const savedById = byId(saved);
  const defaultById = byId(defaults);

  // Where an unplaced panel lands: under everything that IS placed.
  let autoY = 0;
  for (const p of [...savedById.values(), ...defaultById.values()]) {
    autoY = Math.max(autoY, p.y + p.h);
  }

  return panels.map((panel) => {
    const placement = savedById.get(panel.id) ?? defaultById.get(panel.id);
    const minW = Math.max(1, Math.min(panel.minW ?? 1, cols));
    /* `minPx` is the honest floor; convert it into rows at THIS breakpoint's
       row height and take whichever minimum is larger. `rowHeight` includes the
       gutter between rows, so n rows span n*h + (n-1)*margin. */
    const gutter = metrics?.margin[1] ?? 0;
    const rowSpan = (metrics?.rowHeight ?? 0) + gutter;
    const fromPx = panel.minPx && rowSpan > 0
      ? Math.ceil((panel.minPx + gutter) / rowSpan)
      : 0;
    const minH = Math.max(1, panel.minH ?? 1, fromPx);
    // A max below the min is a config mistake that would otherwise wedge
    // react-grid-layout's constraint solver; the min is the safer winner.
    const maxW = panel.maxW !== undefined ? Math.max(minW, Math.min(panel.maxW, cols)) : undefined;
    const maxH = panel.maxH !== undefined ? Math.max(minH, panel.maxH) : undefined;

    const wanted = placement ?? { i: panel.id, x: 0, y: autoY, w: cols, h: Math.max(minH, AUTO_H) };
    if (!placement) autoY += wanted.h;

    const w = clamp(Math.round(wanted.w), minW, maxW ?? cols);
    const h = Math.max(minH, maxH !== undefined ? Math.min(Math.round(wanted.h), maxH) : Math.round(wanted.h));
    const x = clamp(Math.round(wanted.x), 0, Math.max(0, cols - w));

    const mode: ResizeMode = panel.resize ?? 'both';
    return {
      i: panel.id,
      x,
      y: Math.max(0, Math.round(wanted.y)),
      w,
      h,
      minW,
      minH,
      ...(maxW !== undefined ? { maxW } : {}),
      ...(maxH !== undefined ? { maxH } : {}),
      isResizable: mode !== 'none',
      resizeHandles: HANDLES[mode],
    };
  });
}

/** The subset of a grid layout that is worth persisting. */
export const toPlacements = (layout: readonly LayoutItem[]): PanelPlacement[] =>
  layout.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }));

/** Cheap structural comparison, used to avoid re-saving an unchanged layout. */
export const samePlacements = (a: PanelPlacement[] | undefined, b: PanelPlacement[]): boolean => {
  if (!a || a.length !== b.length) return false;
  return a.every((p, idx) => {
    const q = b[idx];
    return !!q && p.i === q.i && p.x === q.x && p.y === q.y && p.w === q.w && p.h === q.h;
  });
};

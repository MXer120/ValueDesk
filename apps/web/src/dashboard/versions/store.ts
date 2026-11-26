/**
 * Versions of how a panel is dragged and resized in the layout editor (Dock), for the owner to choose between on
 * localhost (2026-11-26: "editor, dock new default, make the dragging & resizing 3 versions tho that are better both ux
 * & UI"). The trade page's own versions were decided for the Original the same day ("keep original trade page").
 *
 * - original: today's - the grid's own drag by a panel's head (the others move down out of its way) and its corner.
 * - swap: drop a panel on another and the two trade places; the lines between panels resize both sides at once.
 * - split: drop a panel on a side of another and it takes that half (the middle swaps); the gap it leaves closes.
 *   The lines between panels resize, as in swap.
 * - flow: the grid's drag, refined: every edge resizes, the size reads out while you drag, and guide lines show
 *   where an edge lines up with another panel's.
 *
 * A DEV-only choice kept in this browser (VersionSwitch.tsx). A build always answers 'original': nothing here can
 * reach a visitor, and the versions' overlay and styles load only in DEV (devVersions.tsx). Every version writes
 * the same saved layout through Dashboard's own commit (Undo, the layout history on Done).
 */
import { useSyncExternalStore } from 'react';

export type DragVersion = 'original' | 'swap' | 'split' | 'flow';

export const DRAG_VERSIONS: ReadonlyArray<{ id: DragVersion; name: string; line: string }> = [
  { id: 'original', name: 'Original', line: 'Today\'s: drag a panel by its head, the others move down; resize by the corner' },
  { id: 'swap', name: 'Swap', line: 'Drop a panel on another to trade places; drag the line between two panels to resize both' },
  { id: 'split', name: 'Split', line: 'Drop on a side of a panel to take that half, in the middle to swap; the gap closes' },
  { id: 'flow', name: 'Flow', line: 'The grid\'s drag, refined: every edge resizes, size and guide lines while you drag' },
];

const DEV = import.meta.env.DEV;
const KEY = 'vs.dev.trade.drag';

function read(): DragVersion {
  if (!DEV) return 'original';
  try {
    const v = localStorage.getItem(KEY);
    return DRAG_VERSIONS.some((o) => o.id === v) ? (v as DragVersion) : 'original';
  } catch {
    return 'original';
  }
}

let current: DragVersion = read();
const subs = new Set<() => void>();
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => { subs.delete(f); };
};

export function setDragVersion(v: DragVersion): void {
  if (!DEV || v === current) return;
  current = v;
  try { localStorage.setItem(KEY, v); } catch { /* this tab only */ }
  for (const f of [...subs]) f();
}

export const dragVersion = (): DragVersion => current;

export function useDragVersion(): DragVersion {
  return useSyncExternalStore(subscribe, dragVersion, () => 'original' as const);
}

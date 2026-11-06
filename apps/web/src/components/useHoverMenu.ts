/**
 * A top-bar pop-up that opens on hover as well as on a press (owner 2026-11-06: "the more pop up etc
 * should be on hover too"). Used by More, the bell and the bar's wallet menu; the settings gear opens
 * a dialog, which does not.
 *
 * Only a mouse hovers: a finger or a pen goes through the press, as does the keyboard (Enter on the
 * button is a click). A short wait before opening, so a pointer on its way past opens nothing, and a
 * longer one before closing, so the gap between button and pop-up closes nothing.
 *
 * A press PINS it. A pop-up the mouse opened stays open when pressed (closing it there would feel
 * like the button did nothing, or worse), and a pinned one stays when the mouse leaves. A second
 * press closes it. `hold` keeps it open while something that belongs to it is in use, such as a
 * pop-over of its own drawn outside it.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

export type HoverMenuMode = 'closed' | 'hover' | 'pinned';

export const HOVER_OPEN_MS = 90;
export const HOVER_CLOSE_MS = 220;

interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

/** The rules, apart from React and the clock (useHoverMenu.test.ts). */
export function createHoverMenu(o: { mode: () => HoverMenuMode; setMode: (m: HoverMenuMode) => void; hold?: () => boolean; timers?: Timers }) {
  const timers: Timers = o.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  let pending: unknown = null;
  const cancel = () => {
    if (pending !== null) timers.clear(pending);
    pending = null;
  };
  const later = (fn: () => void, ms: number) => {
    cancel();
    pending = timers.set(() => { pending = null; fn(); }, ms);
  };
  return {
    enter(pointerType: string) {
      if (pointerType !== 'mouse') return;
      cancel();
      if (o.mode() === 'closed') later(() => o.setMode('hover'), HOVER_OPEN_MS);
    },
    leave(pointerType: string) {
      if (pointerType !== 'mouse') return;
      cancel();
      if (o.mode() === 'hover') later(() => { if (!o.hold?.()) o.setMode('closed'); }, HOVER_CLOSE_MS);
    },
    press() {
      cancel();
      o.setMode(o.mode() === 'pinned' ? 'closed' : 'pinned');
    },
    close() {
      cancel();
      o.setMode('closed');
    },
    cancel,
  };
}

export function useHoverMenu(root: RefObject<HTMLElement | null>, hold?: () => boolean, portalled?: RefObject<HTMLElement | null>) {
  const [mode, setMode] = useState<HoverMenuMode>('closed');
  const now = useRef(mode);
  const holdRef = useRef(hold);
  holdRef.current = hold;
  const menu = useRef<ReturnType<typeof createHoverMenu> | null>(null);
  menu.current ??= createHoverMenu({
    mode: () => now.current,
    setMode: (m) => { now.current = m; setMode(m); },
    hold: () => holdRef.current?.() ?? false,
  });
  const m = menu.current;

  useEffect(() => () => m.cancel(), [m]);

  /* However it opened: a press elsewhere, or Escape, ends it. */
  useEffect(() => {
    if (mode === 'closed') return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!root.current?.contains(t) && !portalled?.current?.contains(t) && !holdRef.current?.()) m.close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') m.close(); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [mode, m, root, portalled]);

  const close = useCallback(() => m.close(), [m]);
  /** Open from elsewhere, as a press would. */
  const openPinned = useCallback(() => { m.cancel(); now.current = 'pinned'; setMode('pinned'); }, [m]);
  const onPointerEnter = useCallback((e: ReactPointerEvent) => m.enter(e.pointerType), [m]);
  const onPointerLeave = useCallback((e: ReactPointerEvent) => m.leave(e.pointerType), [m]);
  const press = useCallback(() => m.press(), [m]);

  return { open: mode !== 'closed', mode, close, openPinned, press, hoverProps: { onPointerEnter, onPointerLeave } };
}

/**
 * Where a portal goes: the navbar's notification lane (#vs-notify-slot, NavBar.tsx) and the toasts' pin
 * (#vs-toast-pin, toast.tsx) - told by the element that renders them, not looked for.
 *
 * Their users (the toast rail, the history, maintenance and incident notes) used to find them with
 * document.getElementById from a MutationObserver on the whole <body> (childList + subtree) each: a lookup and a
 * setState on EVERY change to the DOM, everywhere - on /trade every book and trade row, ~10 commits a second, times
 * four - for elements that move maybe once a session. The element's own ref callback says when it comes and goes,
 * which is exactly the information the observers were reconstructing.
 */
import { useSyncExternalStore } from 'react';

export type SlotId = 'vs-notify-slot' | 'vs-toast-pin';

const els = new Map<SlotId, HTMLElement | null>();
const listeners = new Set<() => void>();
const refs = new Map<SlotId, (el: HTMLElement | null) => void>();

/** The ref callback for the element that IS this slot (stable per id). */
export function slotRef(id: SlotId): (el: HTMLElement | null) => void {
  let r = refs.get(id);
  if (!r) {
    r = (el: HTMLElement | null) => {
      if ((els.get(id) ?? null) === el) return;
      els.set(id, el);
      listeners.forEach((f) => f());
    };
    refs.set(id, r);
  }
  return r;
}

const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

/** The slot's element while it is mounted, else null. */
export const slotEl = (id: SlotId): HTMLElement | null => els.get(id) ?? null;

/** The slot's element, re-rendering when it mounts, moves or goes. */
export function useSlot(id: SlotId): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => slotEl(id), () => null);
}

/**
 * The story or release the pointer is on in a list - the News widget, the
 * economic calendar - so the chart can light its marker and its bar
 * (NewsMarkers.tsx). One at a time, for every chart on the page.
 */
import { useSyncExternalStore } from 'react';

/** A story by its id and headline (the hot list gives the same story another id); a release by its id alone. */
export interface NewsFocus {
  id: string;
  title: string;
}

let focus: NewsFocus | null = null;
const subs = new Set<() => void>();

export function focusNews(next: NewsFocus | null): void {
  if (focus?.id === next?.id) return;
  focus = next;
  for (const f of subs) f();
}

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
};

export const useNewsFocus = (): NewsFocus | null => useSyncExternalStore(subscribe, () => focus, () => null);

/** The props a list row takes to point the chart at its story while hovered or focused. */
export function focusProps(f: NewsFocus): { onMouseEnter: () => void; onMouseLeave: () => void; onFocus: () => void; onBlur: () => void } {
  const off = () => focusNews(null);
  return { onMouseEnter: () => focusNews(f), onMouseLeave: off, onFocus: () => focusNews(f), onBlur: off };
}

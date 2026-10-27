/**
 * The last traded price of the market on screen, as the ticker bar reports it.
 *
 * A module rather than App state, as draftOrders.ts: it changes on every
 * ticker push (about once a second), and while it lived in App.tsx every push
 * re-rendered the whole shell - navbar, rail, footer, palette - and every panel
 * of the trade dashboard, the book, the tape and the account tables included.
 * Only the order ticket, the chart and the size calculator read it, so only
 * they subscribe. They still re-render in the same commit as the push did.
 */
import { useSyncExternalStore } from 'react';

let current = '';
const listeners = new Set<() => void>();

/** What TickerBar's `onLast` is wired to. Stable, so passing it never breaks a memo. */
export function setLastPrice(next: string): void {
  if (next === current) return;
  current = next;
  listeners.forEach((l) => l());
}

export function getLastPrice(): string {
  return current;
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

const none = (): string => '';

/** `off`: always '' and never re-renders (another market's chart shows no ticket price). */
export function useLastPrice(off = false): string {
  const get = off ? none : getLastPrice;
  return useSyncExternalStore(subscribe, get, get);
}

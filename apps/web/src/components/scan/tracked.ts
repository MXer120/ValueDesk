/**
 * Scan's memory, in this browser only (owner 2026-11-28: "Below recent searches & Alias/saved/... right of it. It also
 * needs to be possible to group them in tracked lists"):
 *
 *   - recent searches: the last wallets opened on the Scan page, newest first, with the venue they opened on;
 *   - tracked lists: named groups of wallets ("Whales", "To copy"), a wallet in as many as the owner likes.
 *
 * Names given to wallets stay where they always were (dashboard/scanAliases.ts, `scan-aliases`). Nothing here leaves
 * the browser. One store, so the start page and the wallet page's Track menu agree at once.
 */
import { useSyncExternalStore } from 'react';
import type { Venue } from '../../vsApi';

export interface Recent { address: string; venue: Venue; at: number }
export interface TrackedList { id: string; name: string; wallets: string[] }

const RECENT_KEY = 'vs.scan.recent';
const LISTS_KEY = 'vs.scan.lists';
const RECENT_MAX = 12;

interface State { recent: Recent[]; lists: TrackedList[] }

const read = <T>(key: string, ok: (v: unknown) => v is T, fallback: T): T => {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null') as unknown;
    return ok(v) ? v : fallback;
  } catch {
    return fallback;
  }
};
const isRecent = (v: unknown): v is Recent[] => Array.isArray(v) && v.every((r) => r && typeof (r as Recent).address === 'string' && typeof (r as Recent).at === 'number');
const isLists = (v: unknown): v is TrackedList[] => Array.isArray(v) && v.every((l) => l && typeof (l as TrackedList).id === 'string' && Array.isArray((l as TrackedList).wallets));

let state: State = { recent: read(RECENT_KEY, isRecent, []), lists: read(LISTS_KEY, isLists, []) };
const listeners = new Set<() => void>();

function set(next: Partial<State>): void {
  state = { ...state, ...next };
  try {
    if (next.recent) localStorage.setItem(RECENT_KEY, JSON.stringify(state.recent));
    if (next.lists) localStorage.setItem(LISTS_KEY, JSON.stringify(state.lists));
  } catch { /* this tab only */ }
  for (const f of listeners) f();
}

const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
const snapshot = () => state;

export function useScanMemory(): State {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A wallet opened: first in the recent list (once), with the venue it opened on. */
export function pushRecent(address: string, venue: Venue): void {
  const rest = state.recent.filter((r) => !same(r.address, address));
  set({ recent: [{ address: address.toLowerCase(), venue, at: Date.now() }, ...rest].slice(0, RECENT_MAX) });
}
export function forgetRecent(address?: string): void {
  set({ recent: address ? state.recent.filter((r) => !same(r.address, address)) : [] });
}

/** A new list; returns its id. Its name is trimmed to 32 characters; an empty name becomes "List N". */
export function createList(name: string, first?: string): string {
  const id = `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const n = name.trim().slice(0, 32) || `List ${state.lists.length + 1}`;
  set({ lists: [...state.lists, { id, name: n, wallets: first ? [first.toLowerCase()] : [] }] });
  return id;
}
export function renameList(id: string, name: string): void {
  const n = name.trim().slice(0, 32);
  if (!n) return;
  set({ lists: state.lists.map((l) => (l.id === id ? { ...l, name: n } : l)) });
}
export function deleteList(id: string): void {
  set({ lists: state.lists.filter((l) => l.id !== id) });
}
/** In the list, or out of it. */
export function toggleInList(id: string, address: string): void {
  set({
    lists: state.lists.map((l) => {
      if (l.id !== id) return l;
      const has = l.wallets.some((w) => same(w, address));
      return { ...l, wallets: has ? l.wallets.filter((w) => !same(w, address)) : [...l.wallets, address.toLowerCase()] };
    }),
  });
}
export const listsOf = (s: State, address: string): TrackedList[] => s.lists.filter((l) => l.wallets.some((w) => same(w, address)));

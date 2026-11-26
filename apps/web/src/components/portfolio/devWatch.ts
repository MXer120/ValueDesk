/**
 * Localhost only (import.meta.env.DEV): the portfolio's version switch can show another wallet's portfolio, read-only,
 * so each version can be judged with real figures without connecting that wallet. Every read is the same public read
 * the page makes for the connected wallet; nothing is signed and nothing can act (the page gets `readOnly`, as on Scan).
 * In a build this always answers null, and nothing is read from storage.
 */
import { useSyncExternalStore } from 'react';

const KEY = 'vs.dev.pf.watch';
const listeners = new Set<() => void>();

const valid = (a: string | null | undefined): string | null => (a && /^0x[0-9a-fA-F]{40}$/.test(a.trim()) ? a.trim().toLowerCase() : null);

function load(): string | null {
  if (!import.meta.env.DEV) return null;
  try {
    return valid(localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

let current = load();

export const isAddress = (a: string): boolean => valid(a) !== null;

export function setDevWatch(address: string | null): void {
  if (!import.meta.env.DEV) return;
  current = valid(address);
  try {
    if (current) localStorage.setItem(KEY, current);
    else localStorage.removeItem(KEY);
  } catch { /* this tab only */ }
  for (const f of listeners) f();
}

const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => { listeners.delete(f); };
};
const snapshot = () => current;

/** The wallet the switch shows instead of the connected one, or null. */
export function useDevWatch(): string | null {
  const v = useSyncExternalStore(subscribe, snapshot, snapshot);
  return import.meta.env.DEV ? v : null;
}

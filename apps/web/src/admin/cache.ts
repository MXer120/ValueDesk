/**
 * The admin suite's local copy of what it last read (owner 2026-11-07: "for dev i also need the data to
 * load faster & be cached locally it takes ages").
 *
 * Every answer of a read route is kept in this browser - in memory for this tab, and in IndexedDB for
 * the next visit - under the session's wallet, the route and its body. A page draws the kept copy at
 * once and labels its age, then asks the server and replaces it (stale-while-revalidate, ui.tsx useAdmin).
 *
 * dev.valuedesk.so is its own origin, so nothing on the site can read this. Signing out (api.ts
 * saveSession(null)) deletes all of it. Without IndexedDB (a private window) the tab's memory still works.
 */

export interface Kept<T> {
  data: T;
  at: number;
}

const DB = 'vd-admin-cache';
const STORE = 'answers';
/** Older than this, a kept copy is not shown at all: a week-old page is no help. */
export const KEEP_MS = 7 * 86_400_000;

const memory = new Map<string, Kept<unknown>>();
let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (opening) return opening;
  opening = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

export const cacheKey = (wallet: string, path: string, body: string): string => `${wallet}|${path}|${body}`;

/** The copy in this tab's memory, at once (no await): what a page draws on its first render. */
export function peek<T>(key: string, now = Date.now()): Kept<T> | null {
  const k = memory.get(key) as Kept<T> | undefined;
  return k && now - k.at < KEEP_MS ? k : null;
}

/** The copy from the last visit (IndexedDB), when this tab has none. */
export async function recall<T>(key: string, now = Date.now()): Promise<Kept<T> | null> {
  const hit = peek<T>(key, now);
  if (hit) return hit;
  const db = await open();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => {
        const v = req.result as Kept<T> | undefined;
        if (v && typeof v.at === 'number' && now - v.at < KEEP_MS) {
          memory.set(key, v);
          resolve(v);
        } else resolve(null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export function keep<T>(key: string, data: T, at = Date.now()): void {
  const v: Kept<T> = { data, at };
  memory.set(key, v);
  void open().then((db) => {
    try {
      db?.transaction(STORE, 'readwrite').objectStore(STORE).put(v, key);
    } catch {
      /* full or closed: the tab's memory still has it */
    }
  });
}

/** Forget everything (sign-out, a session for another wallet). */
export function forgetAll(): void {
  memory.clear();
  void open().then((db) => {
    try {
      db?.transaction(STORE, 'readwrite').objectStore(STORE).clear();
    } catch {
      /* nothing kept */
    }
  });
}

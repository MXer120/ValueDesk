/**
 * One poll per resource, shared by every panel that reads it.
 *
 * Several panels poll the same public list on their own timers: the market
 * header and strip (/tickers every 30 s), the positions table's mark-price
 * seed (/tickers every 20 s), the market search (every 15 s while open), the
 * funding scanner and the markets board (every 30 s). Each timer was its own
 * request for the same answer. Here a resource has ONE timer, and it runs at
 * the shortest interval any of its readers asked for - so every reader gets
 * its answer at least as often as it did alone (the slower ones more often),
 * and the second reader costs nothing.
 *
 * - A newcomer gets the last answer at once. It is read again at once only
 *   when that answer is older than half the newcomer's own interval (the
 *   palette's rule): within that, it is as fresh as the newcomer's own poll
 *   would have kept it.
 * - The next read is due `interval` after the last one STARTED, counted again
 *   whenever a reader comes or goes - a reader leaving never stretches the gap
 *   past what the remaining ones asked for.
 * - Nothing is read while the tab is hidden; a read that fell due meanwhile
 *   runs the moment it is shown (visibleTimeout).
 * - Timer reads of our own server ask it for its current answer, as useAsync's
 *   polls do (serverFetch.ts `revalidating`).
 * - The last answer is kept after the last reader leaves (a few KB of public
 *   data): coming back to a panel paints at once.
 */
import { visibleTimeout } from './exchange/visibility';
import { revalidating } from './serverFetch';

export interface SharedState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

interface Reader<T> {
  ms: number;
  on: (s: SharedState<T>) => void;
}

interface Entry<T> extends SharedState<T> {
  load: () => Promise<T>;
  readers: Set<Reader<T>>;
  /** When the last read started (0: never). */
  startedAt: number;
  inflight: boolean;
  cancel?: () => void;
}

const entries = new Map<string, Entry<any>>();

/** Test seam: the clock. */
export const sharedPollEnv = { now: (): number => Date.now() };

function snapshot<T>(e: Entry<T>): SharedState<T> {
  return { data: e.data, error: e.error, loading: e.loading };
}

function notify<T>(e: Entry<T>): void {
  const s = snapshot(e);
  for (const r of [...e.readers]) r.on(s);
}

/** The shortest interval any reader wants, or 0 with no readers. */
function interval<T>(e: Entry<T>): number {
  let ms = 0;
  for (const r of e.readers) if (r.ms > 0 && (ms === 0 || r.ms < ms)) ms = r.ms;
  return ms;
}

function schedule<T>(key: string, e: Entry<T>): void {
  e.cancel?.();
  e.cancel = undefined;
  if (e.inflight) return; // it schedules the next one as it settles
  const ms = interval(e);
  if (!ms) return;
  const wait = Math.max(0, e.startedAt + ms - sharedPollEnv.now());
  e.cancel = visibleTimeout(wait, () => {
    e.cancel = undefined;
    run(key, e, true);
  });
}

function run<T>(key: string, e: Entry<T>, poll: boolean): void {
  if (e.inflight) return;
  e.cancel?.();
  e.cancel = undefined;
  e.inflight = true;
  e.startedAt = sharedPollEnv.now();
  e.loading = true;
  notify(e);
  let p: Promise<T>;
  try {
    p = poll ? revalidating(() => e.load()) : e.load();
  } catch (err) {
    p = Promise.reject(err);
  }
  p.then(
    (data) => {
      e.data = data;
      e.error = null;
    },
    (err: unknown) => {
      // The last good answer stays on screen; the next read tries again.
      e.error = err instanceof Error ? err.message : String(err);
    },
  ).finally(() => {
    e.inflight = false;
    e.loading = false;
    if (entries.get(key) === e) {
      notify(e);
      schedule(key, e);
    }
  });
}

/**
 * Read `key` (loaded by `load`) every `ms` - shared with every other reader of
 * the key. `on` is called with the current state at once, and on every change.
 * `ms` 0: read once (or take the last answer) and never poll for this reader.
 * Returns the unsubscribe.
 */
export function subscribeShared<T>(key: string, load: () => Promise<T>, ms: number, on: (s: SharedState<T>) => void): () => void {
  let e = entries.get(key) as Entry<T> | undefined;
  if (!e) {
    e = { data: null, error: null, loading: false, load, readers: new Set(), startedAt: 0, inflight: false };
    entries.set(key, e);
  }
  // The newest reader's loader: every reader of a key loads the same thing.
  e.load = load;
  const reader: Reader<T> = { ms, on };
  e.readers.add(reader);
  on(snapshot(e));
  const age = sharedPollEnv.now() - e.startedAt;
  const stale = e.data === null || (ms > 0 ? age > ms / 2 : false);
  if (!e.inflight && (stale || e.startedAt === 0)) run(key, e, false);
  else schedule(key, e);
  const entry = e;
  return () => {
    if (!entry.readers.delete(reader)) return;
    schedule(key, entry);
  };
}

/** Read `key` again now (a reader's Retry), shared with a read already on its way. */
export function refreshShared(key: string): void {
  const e = entries.get(key);
  if (e && e.readers.size > 0) run(key, e, false);
}

/** The last answer for `key`, if any. */
export function peekShared<T>(key: string): T | null {
  return (entries.get(key)?.data as T | undefined) ?? null;
}

/** For tests: forget every resource and stop every timer. */
export function _resetSharedPoll(): void {
  for (const e of entries.values()) e.cancel?.();
  entries.clear();
}

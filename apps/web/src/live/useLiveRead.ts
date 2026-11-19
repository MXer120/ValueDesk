/**
 * A read that is pushed while the live socket is up (liveSocket.ts) and polled over HTTP while it is not - usePolled's
 * contract (cohorts/parts.tsx: never blanks, an older key's answer is `stale`), plus `streaming`.
 *
 * `path` is the HTTP path + query `fetcher` reads (vsApi's *Path builders), so both give the same answer. With the socket
 * up the server's whole answer usually comes first (one hop, no Vercel function); HTTP is asked only if it has not come in
 * LIVE_WAIT_MS, and polling stops once it streams. The socket dropping, or the server refusing the path, starts the HTTP read
 * at once and polls at `pollMs` again; the answer held stays on screen throughout, so nothing flickers.
 *
 * A key's FIRST HTTP read, once sent, is kept whatever the socket does meanwhile (phone pass, 2026-11-18): it used to be
 * cancelled when the socket came up while it was on the wire - on a phone the new socket's DNS + TCP + TLS take about as
 * long as the read itself - and the page then waited for the push instead of the answer nearly in. Whichever of the two
 * answers comes first is shown; one that is older than what is shown (by its asOf) never replaces it.
 *
 * `keep`: while nothing has answered this key yet, the path's kept answer (serverFetch.ts KEPT ANSWERS) is shown, as
 * `stale` - for pages that show the answer's own as-of time and mix nothing live into it - and the first read asks the
 * server for the current one.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { pollEvery } from '../exchange/visibility';
import { revalidating } from '../serverFetch';
import type { Read } from '../components/explore/cohorts/parts';
import { liveSocket, type LiveSocket } from './liveSocket';
import { useHeld } from './useHeld';

/** With the socket up, HTTP waits this long for the pushed answer. */
export const LIVE_WAIT_MS = 1_500;

/**
 * When the HTTP read runs (pure, tested): never while it streams; after LIVE_WAIT_MS while the socket is up (its whole
 * answer is on the way); at once otherwise (no socket, socket down, or a path the server does not push). Polling follows
 * whenever it is not streaming.
 */
export function httpPlan(streaming: boolean, socketUp: boolean, pushed: boolean): 'none' | 'wait' | 'now' {
  if (streaming) return 'none';
  return socketUp && pushed ? 'wait' : 'now';
}

/** When an answer was taken (its asOf, else its at), or null when it does not say. */
const takenAt = (x: unknown): number | null => {
  if (!x || typeof x !== 'object') return null;
  const o = x as { asOf?: unknown; at?: unknown };
  return typeof o.asOf === 'number' ? o.asOf : typeof o.at === 'number' ? o.at : null;
};

/** Does `next` replace `shown` (pure, tested)? Not when both say when they were taken and `next` is older. */
export function replaces(shown: unknown, next: unknown): boolean {
  const a = takenAt(shown);
  const b = takenAt(next);
  return a === null || b === null || b >= a;
}

export function useLiveUp(sock: LiveSocket | null): boolean {
  const [up, setUp] = useState(() => !!sock?.up);
  useEffect(() => {
    if (!sock) return;
    setUp(sock.up);
    return sock.onStatus(setUp);
  }, [sock]);
  return up;
}

export function useLiveRead<T>(
  key: string | null,
  path: string | null,
  fetcher: (signal: AbortSignal) => Promise<T>,
  pollMs: number,
  sock: LiveSocket | null = liveSocket(),
  keep = false,
): Read<T> & { streaming: boolean } {
  const [state, setState] = useState<{ key: string | null; data: T | null; error: string | null }>({ key: null, data: null, error: null });
  const [tick, setTick] = useState(0);
  const [streamKey, setStreamKey] = useState<string | null>(null);
  const f = useRef(fetcher);
  f.current = fetcher;
  const up = useLiveUp(sock);
  const pushed = !!path && !!sock;

  /** An answer for `k`, from either source: shown unless it is older than the one shown for that key. */
  const take = useCallback((k: string, data: T) => {
    setState((s) => (s.key === k && s.data !== null && !replaces(s.data, data) ? s : { key: k, data, error: null }));
  }, []);

  useEffect(() => {
    if (!key || !path || !sock) return;
    return sock.subscribe(path, (ev) => {
      if (ev.kind === 'down') { setStreamKey((k) => (k === key ? null : k)); return; }
      const b = ev.body as { ok?: boolean; error?: string } | null;
      // The route's own failure answer ({ok: false}), said as vsApi's unwrap says it.
      if (!b || b.ok === false) setState((s) => ({ key, data: s.key === key ? s.data : null, error: b?.error ?? 'No answer' }));
      else take(key, ev.body as T);
      setStreamKey(key);
    });
  }, [key, path, sock, take]);

  const streaming = key !== null && streamKey === key;
  const mine = state.key === key;
  const held = useHeld<T>(key, path, mine, keep);
  const live = useRef({ streaming, up, held: !!held });
  live.current = { streaming, up, held: !!held };
  /** The first read's wait for the push, so a socket that drops meanwhile reads at once instead (below). */
  const firstWait = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reader = useCallback((k: string, ac: AbortSignal, alive: () => boolean) => () => {
    f.current(ac).then(
      (data) => { if (alive()) take(k, data); },
      (e: unknown) => {
        if (!alive() || ac.aborted) return;
        setState((s) => ({ key: k, data: s.key === k ? s.data : null, error: e instanceof Error ? e.message : String(e) }));
      },
    );
  }, [take]);

  // The key's first HTTP read: planned once, and not cancelled by the socket coming up while it is on the wire.
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const ac = new AbortController();
    const run = reader(key, ac.signal, () => alive);
    const first = () => {
      firstWait.current = null;
      if (live.current.streaming) return; // the push came first
      // A kept answer is on screen: ask the server for the current one, not a copy a cache holds.
      if (live.current.held) revalidating(run);
      else run();
    };
    const plan = httpPlan(live.current.streaming, live.current.up, pushed);
    if (plan === 'now') first();
    else if (plan === 'wait') firstWait.current = setTimeout(first, LIVE_WAIT_MS);
    return () => {
      alive = false;
      ac.abort();
      if (firstWait.current) clearTimeout(firstWait.current);
      firstWait.current = null;
    };
  }, [key, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  // Polls while it does not stream. After the key's first plan, a socket that drops or a push that stops reads at once.
  const planned = useRef<string | null>(null);
  useEffect(() => {
    const initial = planned.current !== key;
    planned.current = key;
    if (!key || streaming) return;
    let alive = true;
    const ac = new AbortController();
    const run = reader(key, ac.signal, () => alive);
    let later: ReturnType<typeof setTimeout> | null = null;
    if (!initial) {
      if (firstWait.current) { clearTimeout(firstWait.current); firstWait.current = null; }
      if (httpPlan(false, up, pushed) === 'now') run();
      else later = setTimeout(run, LIVE_WAIT_MS);
    }
    const stop = pollMs > 0 ? pollEvery(pollMs, () => revalidating(run)) : null;
    return () => { alive = false; ac.abort(); if (later) clearTimeout(later); stop?.(); };
  }, [key, pollMs, streaming, up]); // eslint-disable-line react-hooks/exhaustive-deps

  const retry = useCallback(() => setTick((n) => n + 1), []);
  if (!mine && held) return { data: held.body, stale: true, error: null, loading: true, retry, streaming, heldAt: held.at };
  return {
    data: state.data,
    stale: !mine && state.data !== null,
    error: mine ? state.error : null,
    loading: !!key && (!mine || (state.data === null && state.error === null)),
    retry,
    streaming,
  };
}

/**
 * A read that is pushed while the live socket is up (liveSocket.ts) and polled over HTTP while it is not - usePolled's
 * contract (cohorts/parts.tsx: never blanks, an older key's answer is `stale`), plus `streaming`.
 *
 * `path` is the HTTP path + query `fetcher` reads (vsApi's *Path builders), so both give the same answer. With the socket
 * up the server's whole answer usually comes first (one hop, no Vercel function); HTTP is asked only if it has not come in
 * LIVE_WAIT_MS, and polling stops once it streams. The socket dropping, or the server refusing the path, starts the HTTP read
 * at once and polls at `pollMs` again; the answer held stays on screen throughout, so nothing flickers.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { pollEvery } from '../exchange/visibility';
import { revalidating } from '../serverFetch';
import type { Read } from '../components/explore/cohorts/parts';
import { liveSocket, type LiveSocket } from './liveSocket';

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
): Read<T> & { streaming: boolean } {
  const [state, setState] = useState<{ key: string | null; data: T | null; error: string | null }>({ key: null, data: null, error: null });
  const [tick, setTick] = useState(0);
  const [streamKey, setStreamKey] = useState<string | null>(null);
  const f = useRef(fetcher);
  f.current = fetcher;
  const up = useLiveUp(sock);

  useEffect(() => {
    if (!key || !path || !sock) return;
    return sock.subscribe(path, (ev) => {
      if (ev.kind === 'down') { setStreamKey((k) => (k === key ? null : k)); return; }
      const b = ev.body as { ok?: boolean; error?: string } | null;
      // The route's own failure answer ({ok: false}), said as vsApi's unwrap says it.
      if (!b || b.ok === false) setState((s) => ({ key, data: s.key === key ? s.data : null, error: b?.error ?? 'No answer' }));
      else setState({ key, data: ev.body as T, error: null });
      setStreamKey(key);
    });
  }, [key, path, sock]);

  const streaming = key !== null && streamKey === key;
  useEffect(() => {
    const plan = httpPlan(streaming, up, !!path && !!sock);
    if (!key || plan === 'none') return;
    let alive = true;
    const ac = new AbortController();
    const run = () => {
      f.current(ac.signal).then(
        (data) => { if (alive) setState({ key, data, error: null }); },
        (e: unknown) => {
          if (!alive || ac.signal.aborted) return;
          setState((s) => ({ key, data: s.key === key ? s.data : null, error: e instanceof Error ? e.message : String(e) }));
        },
      );
    };
    const first = plan === 'wait' ? setTimeout(run, LIVE_WAIT_MS) : null;
    if (!first) run();
    const stop = pollMs > 0 ? pollEvery(pollMs, () => revalidating(run)) : null;
    return () => { alive = false; ac.abort(); if (first) clearTimeout(first); stop?.(); };
  }, [key, tick, pollMs, streaming, up]); // eslint-disable-line react-hooks/exhaustive-deps

  const mine = state.key === key;
  return {
    data: state.data,
    stale: !mine && state.data !== null,
    error: mine ? state.error : null,
    loading: !!key && (!mine || (state.data === null && state.error === null)),
    retry: useCallback(() => setTick((n) => n + 1), []),
    streaming,
  };
}

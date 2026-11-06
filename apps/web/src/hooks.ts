import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { api, ApiError, type Engine, type Symbol, type SessionInfo } from './api';
import { hub, type ConnState, type SubParams } from './ws';
import { getTradingState, sessionInfoOf, subscribeTrading } from './trading/session';
import { pollEvery } from './exchange/visibility';
import { revalidating } from './serverFetch';
import { peekShared, refreshShared, subscribeShared, type SharedState } from './sharedPoll';
import type { SodexOiExcluded } from './sodexOi';
import { vsApi } from './vsApi';

/**
 * A promise-backed value with loading/error state and manual refresh.
 * `pollMs` polls only while the tab is visible, and catches up at once when
 * it is shown again (every poll spends the user's own exchange budget).
 * A poll's reads of our own server ask it for its current answer; the first
 * read may be answered by the browser's HTTP cache (serverFetch.ts).
 */
export function useAsync<T>(
  fn: () => Promise<T>,
  deps: unknown[],
  opts: { enabled?: boolean; pollMs?: number } = {},
): { data: T | null; error: string | null; loading: boolean; refresh: () => void } {
  const { enabled = true, pollMs } = opts;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  /** The next run is a poll. */
  const polled = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    const poll = polled.current;
    polled.current = false;
    (poll ? revalidating(() => fnRef.current()) : fnRef.current())
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : String(e));
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, tick]);

  useEffect(() => {
    if (!enabled || !pollMs) return;
    return pollEvery(pollMs, () => {
      polled.current = true;
      setTick((t) => t + 1);
    });
  }, [enabled, pollMs]);

  return { data, error, loading, refresh: useCallback(() => setTick((t) => t + 1), []) };
}

/**
 * useAsync for a resource several panels poll: ONE read per `key` on one timer
 * at the shortest interval any reader wants (sharedPoll.ts). Same shape as
 * useAsync. `key` must name exactly what `fn` reads.
 */
export function useSharedPoll<T>(
  key: string,
  fn: () => Promise<T>,
  opts: { enabled?: boolean; pollMs?: number } = {},
): { data: T | null; error: string | null; loading: boolean; refresh: () => void } {
  const { enabled = true, pollMs = 0 } = opts;
  const [state, setState] = useState<SharedState<T>>(() => ({ data: peekShared<T>(key), error: null, loading: false }));
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (!enabled) return;
    return subscribeShared<T>(key, () => fnRef.current(), pollMs, setState);
  }, [key, enabled, pollMs]);
  return { ...state, refresh: useCallback(() => refreshShared(key), [key]) };
}

/** The engine's /tickers snapshot, one shared poll per engine (see useSharedPoll). */
export function useTickers(engine: Engine, opts: { enabled?: boolean; pollMs: number }) {
  return useSharedPoll(`md:tickers:${engine}`, () => api.tickers(engine), opts);
}

/**
 * What SoDEX's displayed open interest leaves out (sodexOi.ts), one shared poll. Null while it has not
 * loaded or the last read failed: an older answer stays out, and the figures show their dash.
 */
export function useSodexOiExcluded(enabled = true): SodexOiExcluded | null {
  const { data, error } = useSharedPoll('vs:sodex:oi-excluded', () => vsApi.sodexOiExcluded(), { enabled, pollMs: 15_000 });
  return error ? null : data;
}

/** Subscribe to a hub channel for the lifetime of the component. */
export function useChannel(
  engine: Engine,
  params: SubParams | null,
  handler: (data: any, pushType: 'snapshot' | 'update') => void,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const key = params ? JSON.stringify(params) : '';

  useEffect(() => {
    if (!params) return;
    return hub.subscribe(engine, params, (d, t) => handlerRef.current(d, t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, key]);
}

export function useConnState(): { state: ConnState; upstream: Partial<Record<Engine, string>> } {
  const [state, setState] = useState<ConnState>(hub.state);
  const [, force] = useState(0);
  useEffect(() => {
    hub.connect();
    return hub.onState((s) => {
      setState(s);
      force((n) => n + 1);
    });
  }, []);
  return { state, upstream: hub.upstream };
}

/** The engine's market list, one shared poll a minute per engine (useSharedPoll). */
export function useSymbolList(engine: Engine, enabled = true) {
  return useSharedPoll(`md:symbols:${engine}`, () => api.symbols(engine), { enabled, pollMs: 60_000 });
}

/** Symbol list plus a lookup by name. */
export function useSymbols(engine: Engine) {
  // Trading rules (tick, fees, leverage, bands) are SoDEX's, and they move.
  // A minute is the same cadence the server caches them for. One poll per
  // engine however many panels read it (the shell, the portfolio, the boards).
  const { data, error } = useSymbolList(engine);
  const symbols = data?.symbols ?? [];
  const byName = new Map<string, Symbol>(symbols.map((s) => [s.name, s]));
  /* Whose list it is: for a moment after an engine switch the poll still holds the other engine's. */
  return { symbols, byName, error, listEngine: data?.engine ?? null };
}

/**
 * Whether this browser can trade for the connected wallet (trading/session.ts).
 * Nothing to poll: the state lives here, and changes as the key is enabled,
 * expires, is turned off or is turned off in another tab.
 */
export function useSession(): {
  session: SessionInfo | null;
  error: string | null;
  refresh: () => void;
} {
  const t = useSyncExternalStore(subscribeTrading, getTradingState, getTradingState);
  const session = useMemo(() => sessionInfoOf(t) as SessionInfo, [t]);
  return { session, error: null, refresh: noop };
}
const noop = () => {};

/** Whether a media query matches, kept current as the window changes. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (on) => {
      const mq = window.matchMedia(query);
      mq.addEventListener('change', on);
      return () => mq.removeEventListener('change', on);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Persisted-to-localStorage state, for things like the selected market. */
export function useStored<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (next: T) => {
      setV(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* private mode; non-fatal */
      }
    },
    [key],
  );
  return [v, set];
}

/**
 * Like useStored, but LIVE across every component reading the same key
 * within this tab - not just across reloads.
 *
 * `localStorage` alone does not do this: its own `storage` event fires only
 * in OTHER tabs, never the one that made the write, so two sibling
 * components each calling `useStored` on the same key would both persist
 * correctly but never see each other's changes without an unrelated
 * re-render happening to re-read it. This adds a small in-memory pub/sub
 * layer on top - the same shared-feed shape this app already uses for
 * ticker and order-book data (see useTickers / useOrderBook in Market.tsx) -
 * so that, for example, the Order Book panel's own unit toggle and the
 * chart's Depth view can share one live setting instead of drifting apart.
 */
const sharedStores = new Map<string, { value: unknown; subs: Set<(v: unknown) => void> }>();

export function useSharedStored<T>(key: string, initial: T): [T, (v: T) => void] {
  const read = useCallback((): T => {
    let store = sharedStores.get(key);
    if (!store) {
      let value: T = initial;
      try {
        const raw = localStorage.getItem(key);
        if (raw) value = JSON.parse(raw) as T;
      } catch {
        /* private mode or corrupt value; fall back to initial */
      }
      store = { value, subs: new Set() };
      sharedStores.set(key, store);
    }
    return store.value as T;
  }, [key, initial]);

  const [value, setValue] = useState<T>(read);

  useEffect(() => {
    const store = sharedStores.get(key)!;
    const sub = (v: unknown) => setValue(v as T);
    store.subs.add(sub);
    // Pick up whatever the store holds NOW - it may have changed between
    // this component's first render (which called `read` once) and this
    // effect running, if another subscriber wrote in between.
    setValue(store.value as T);
    return () => {
      store.subs.delete(sub);
    };
  }, [key]);

  const set = useCallback(
    (next: T) => {
      const store = sharedStores.get(key) ?? { value: initial, subs: new Set() };
      store.value = next;
      sharedStores.set(key, store);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* private mode; non-fatal */
      }
      for (const s of store.subs) s(next);
    },
    [key, initial],
  );

  return [value, set];
}

/** Transient status line shown under an action. */
export function useStatus() {
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);
  const timer = useRef<number>();
  const show = useCallback((kind: 'ok' | 'err' | 'info', text: string, ms = 8000) => {
    setMsg({ kind, text });
    window.clearTimeout(timer.current);
    if (ms) timer.current = window.setTimeout(() => setMsg(null), ms);
  }, []);
  const fromError = useCallback(
    (e: unknown) => {
      const err = e as ApiError;
      show('err', err?.hint ? `${err.message} — ${err.hint}` : (err?.message ?? String(e)), 12_000);
    },
    [show],
  );
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { msg, show, fromError, clear: () => setMsg(null) };
}

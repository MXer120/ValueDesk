/**
 * The palette's data: the trader screener (paged), the Assets rows and a
 * debounced leaderboard search. Everything is fetched ONLY while the palette
 * is open, every request is abortable, and answers are kept in a small module
 * cache so reopening the palette (or flipping back to a tab) paints at once
 * from the last answer while it revalidates.
 *
 * Markets are SoDEX's only: it is the one venue this app trades on.
 * Traders on venues outside the screener pool (trade.xyz, Lighter, Arcus)
 * come from their leaderboards, the call the leaderboard page makes.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type Engine, type Symbol, type Ticker } from '../../api';
import { vsApi, type BoardWindow, type Positioning, type TraderRow, type Venue } from '../../vsApi';
import type { ScreenerResponse } from '@sign/valuescan/screener/model.js';
import { positioningIndex, withPositioning, toSearch, type AssetRow, type ScreenerRow } from './model';
import { num } from '../../format';
import { logLoadFailure } from '../LoadFailed';

interface CacheEntry<T> {
  at: number;
  data: T;
}
const cache = new Map<string, CacheEntry<unknown>>();
const CACHE_MAX = 60;

function remember<T>(key: string, data: T): void {
  cache.delete(key);
  cache.set(key, { at: Date.now(), data });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
}

function cached<T>(key: string): CacheEntry<T> | undefined {
  return cache.get(key) as CacheEntry<T> | undefined;
}

/**
 * GET JSON with a deadline. A request that hangs (a cold server-side pool
 * build behind a slow upstream, a dropped connection) must end as an ERROR the
 * hook can retry, never as a spinner that spins forever.
 */
async function getJson<T>(url: string, signal?: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal?.aborted) ac.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, timeoutMs);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: ac.signal });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.ok === false) {
      throw new Error(body?.error ?? `HTTP ${res.status}`);
    }
    return body as T;
  } catch (e) {
    if (timedOut) throw new Error(`no answer after ${Math.round(timeoutMs / 1000)} s`);
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Long enough for the server's first pool build (every venue's leaderboards). */
const REQUEST_TIMEOUT_MS = 45_000;
/** An open tab re-reads its first page this often (the server answers from its cache). */
export const REFRESH_MS = 60_000;
/** Retry after a failure: 5 s, 10 s, 20 s, 40 s, then every 60 s. */
export const retryDelay = (failures: number): number => Math.min(60_000, 5_000 * 2 ** Math.max(0, failures - 1));

const isAbort = (e: unknown) => (e as { name?: string })?.name === 'AbortError';

/* ---------------------------------------------------------------------------
 * Screener, paged.
 * ------------------------------------------------------------------------ */

export type ScreenerMeta = Omit<ScreenerResponse, 'rows'>;

export interface ScreenerState {
  rows: ScreenerRow[];
  meta: ScreenerMeta | null;
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
  retry: () => void;
}

/**
 * `params` without limit/offset; `pageSize` rows per page. A change of params
 * starts over (showing the cached first page, if any, while it loads).
 */
export function useScreener(
  params: Record<string, string> | null,
  pageSize: number,
  o: { debounceMs?: number; enabled?: boolean } = {},
): ScreenerState {
  const enabled = o.enabled !== false && params !== null;
  const base = params ? toSearch({ ...params, limit: String(pageSize) }) : '';
  const firstUrl = `/api/vs/screener${base}`;
  const [pages, setPages] = useState<{ url: string; rows: ScreenerRow[]; meta: ScreenerMeta | null }>(() => {
    const hit = cached<ScreenerResponse>(firstUrl);
    return { url: firstUrl, rows: hit?.data.rows ?? [], meta: hit ? stripRows(hit.data) : null };
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [failures, setFailures] = useState(0);
  const moreRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const hit = cached<ScreenerResponse>(firstUrl);
    setPages((p) =>
      p.url === firstUrl && p.rows.length ? p : { url: firstUrl, rows: hit?.data.rows ?? [], meta: hit ? stripRows(hit.data) : null },
    );
    setError(null);
    // A cached answer younger than 20 s is good enough; otherwise revalidate.
    if (hit && Date.now() - hit.at < 20_000 && tick === 0) {
      setLoading(false);
      return;
    }
    const ac = new AbortController();
    setLoading(true);
    const t = window.setTimeout(() => {
      getJson<ScreenerResponse>(firstUrl, ac.signal)
        .then((d) => {
          remember(firstUrl, d);
          setPages({ url: firstUrl, rows: d.rows, meta: stripRows(d) });
          setFailures(0);
          setLoading(false);
        })
        .catch((e) => {
          if (isAbort(e)) return;
          logLoadFailure('Traders', e);
          setError(e instanceof Error ? e.message : String(e));
          setFailures((n) => n + 1);
          setLoading(false);
        });
    }, o.debounceMs ?? 0);
    return () => {
      window.clearTimeout(t);
      ac.abort();
      moreRef.current?.abort();
      setLoading(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstUrl, enabled, tick]);

  const hasMore = !!pages.meta && pages.url === firstUrl && pages.rows.length < pages.meta.total;

  /* Self-healing. A failed load retries on its own with a backoff (the Retry
     button only jumps the queue), and a tab left open re-reads its first page
     every REFRESH_MS so its numbers never sit stale. The rows on screen stay
     up while either happens. A refresh never throws away pages the user
     scrolled down to - it waits until they change the query. */
  const scrolledPastFirstPage = pages.url === firstUrl && pages.rows.length > pageSize;
  useEffect(() => {
    if (!enabled || loading) return;
    if (!error && scrolledPastFirstPage) return;
    const t = window.setTimeout(() => setTick((n) => n + 1), error ? retryDelay(failures) : REFRESH_MS);
    return () => window.clearTimeout(t);
  }, [enabled, loading, error, failures, scrolledPastFirstPage, firstUrl]);

  const loadMore = () => {
    if (!enabled || loading || !hasMore || !params) return;
    const url = `/api/vs/screener${toSearch({ ...params, limit: String(pageSize), offset: String(pages.rows.length) })}`;
    const ac = new AbortController();
    moreRef.current = ac;
    setLoading(true);
    getJson<ScreenerResponse>(url, ac.signal)
      .then((d) => {
        setPages((p) => (p.url === firstUrl ? { ...p, rows: dedupe([...p.rows, ...d.rows]), meta: stripRows(d) } : p));
        setLoading(false);
      })
      .catch((e) => {
        if (!isAbort(e)) setLoading(false);
      });
  };

  return {
    rows: pages.url === firstUrl ? pages.rows : [],
    meta: pages.url === firstUrl ? pages.meta : null,
    loading,
    error,
    hasMore,
    loadMore,
    retry: () => setTick((n) => n + 1),
  };
}

function stripRows(d: ScreenerResponse): ScreenerMeta {
  const { rows: _rows, ...meta } = d;
  return meta;
}

function dedupe(rows: ScreenerRow[]): ScreenerRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = `${r.venue}:${r.address}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* ---------------------------------------------------------------------------
 * Leaderboard search: a fallback for names and addresses outside the pool.
 * ------------------------------------------------------------------------ */

export function useLeaderboardSearch(q: string, venue: Venue | 'all', enabled: boolean): TraderRow[] {
  const [rows, setRows] = useState<TraderRow[]>([]);
  const text = q.trim();
  const on = enabled && text.length >= 3;
  useEffect(() => {
    if (!on) {
      setRows([]);
      return;
    }
    const key = `lb:${venue}:${text.toLowerCase()}`;
    const hit = cached<TraderRow[]>(key);
    setRows(hit ? hit.data : []);
    if (hit && Date.now() - hit.at < 60_000) return;
    const ac = new AbortController();
    // Debounced harder than the screener: a SoDEX search walks ten upstream pages.
    const t = window.setTimeout(() => {
      vsApi
        .leaderboard({ venue, q: text, limit: 8 }, ac.signal)
        .then((d) => {
          remember(key, d.rows);
          setRows(d.rows);
        })
        .catch(() => { /* the pool results stand on their own */ });
    }, 500);
    return () => {
      window.clearTimeout(t);
      ac.abort();
    };
  }, [on, text, venue]);
  return on ? rows : [];
}

/* ---------------------------------------------------------------------------
 * Assets.
 * ------------------------------------------------------------------------ */

interface MarketsState {
  rows: AssetRow[];
  loading: boolean;
  error: string | null;
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`no answer after ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(t));
}

interface JsonState<T> {
  data: T | null;
  error: string | null;
}

/**
 * Poll one JSON source while enabled, keeping the last good answer on screen.
 * A failure (or a request that never answers) retries on the retryDelay
 * backoff instead of waiting out the whole poll interval - a symbols list polled
 * every 5 minutes must not leave the tab empty for 5 minutes after one blip.
 */
function useJson<T>(key: string, load: (signal: AbortSignal) => Promise<T>, enabled: boolean, pollMs: number): JsonState<T> {
  const [data, setData] = useState<T | null>(() => cached<T>(key)?.data ?? null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let ac: AbortController | null = null;
    let timer: number | undefined;
    let failures = 0;
    const schedule = (ms: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(run, Math.max(0, ms));
    };
    function run() {
      ac?.abort();
      const mine = new AbortController();
      ac = mine;
      withDeadline(load(mine.signal), REQUEST_TIMEOUT_MS)
        .then((d) => {
          if (!alive || mine.signal.aborted) return;
          remember(key, d);
          setData(d);
          setError(null);
          failures = 0;
          schedule(pollMs);
        })
        .catch((e) => {
          if (!alive || mine.signal.aborted || isAbort(e)) return;
          failures += 1;
          logLoadFailure(`Search data (${key})`, e);
          setError(e instanceof Error ? e.message : String(e));
          schedule(Math.min(pollMs, retryDelay(failures)));
        });
    }
    const hit = cached<T>(key);
    if (hit) setData(hit.data);
    if (!hit || Date.now() - hit.at > pollMs / 2) run();
    else schedule(pollMs - (Date.now() - hit.at));
    return () => {
      alive = false;
      window.clearTimeout(timer);
      ac?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, pollMs]);
  return { data, error };
}

/**
 * SoDEX spot + perps (symbols and 24h tickers, as SymbolSearch reads them) and
 * the tracked top traders' net positioning per market.
 */
export function useMarkets(enabled: boolean): MarketsState {
  const spotSymbols = useJson<{ symbols: Symbol[] }>('md:spot:symbols', () => api.symbols('spot'), enabled, 300_000);
  const perpsSymbols = useJson<{ symbols: Symbol[] }>('md:perps:symbols', () => api.symbols('perps'), enabled, 300_000);
  const spotTickers = useJson<{ tickers: Ticker[] }>('md:spot:tickers', () => api.tickers('spot'), enabled, 15_000);
  const perpsTickers = useJson<{ tickers: Ticker[] }>('md:perps:tickers', () => api.tickers('perps'), enabled, 15_000);
  const positioning = useJson<Positioning[]>(
    'vs:positioning:all',
    (signal) => vsApi.positioning({ venue: 'all' }, signal),
    enabled,
    180_000,
  );

  const rows = useMemo((): AssetRow[] => {
    const build = (engine: Engine, symbols?: Symbol[], tickers?: Ticker[]): AssetRow[] => {
      const byName = new Map((tickers ?? []).map((t) => [t.symbol, t]));
      return (symbols ?? [])
        .filter((s) => s.status === 'TRADING')
        .map((s) => {
          const t = byName.get(s.name);
          return {
            key: `${engine}:${s.name}`,
            venue: 'sodex' as const,
            engine,
            symbol: s.name,
            display: s.displayName,
            base: s.baseCoin.toUpperCase(),
            coin: s.baseCoin,
            kind: engine === 'perps' ? ('perp' as const) : ('spot' as const),
            maxLeverage: s.maxLeverage ?? null,
            price: t ? num(t.lastPx) || null : null,
            changePct: t && Number.isFinite(t.changePct) ? t.changePct : null,
            // What SymbolSearch displays and sorts by: quote volume, not raw units.
            volume24h: t ? num(t.quoteVolume ?? t.volume) : null,
            longShare: null,
            netUsd: null,
            traders: null,
            tickSize: s.tickSize,
          };
        });
    };
    const idx = positioningIndex(positioning.data ?? []);
    return [
      ...build('perps', perpsSymbols.data?.symbols, perpsTickers.data?.tickers),
      ...build('spot', spotSymbols.data?.symbols, spotTickers.data?.tickers),
    ].map((r) => withPositioning(r, idx));
  }, [spotSymbols.data, perpsSymbols.data, spotTickers.data, perpsTickers.data, positioning.data]);

  // The market LISTS decide the state; tickers and positioning only fill columns.
  const lists = [spotSymbols, perpsSymbols];
  const none = lists.every((s) => !s.data);
  const allFailed = lists.every((s) => !s.data && s.error);
  return {
    rows,
    loading: enabled && none && !allFailed,
    error: enabled && allFailed ? (perpsSymbols.error ?? spotSymbols.error) : null,
  };
}

/** A clock for "3m ago" labels, ticking every 30 s while open. */
export function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [enabled]);
  return now;
}

/* ---------------------------------------------------------------------------
 * Leaderboard venues (outside the screener pool): each venue's own ranking.
 * ------------------------------------------------------------------------ */

export interface BoardState {
  venue: Venue;
  rows: TraderRow[];
  loading: boolean;
  error: string | null;
}

/**
 * Each venue's top by PnL over `win`, from vsApi.leaderboard (one call per
 * venue, so one venue failing or having no ranking says so on its own line).
 * Cached like everything else here, re-read every REFRESH_MS while shown.
 */
export function useVenueBoards(venues: readonly Venue[], win: BoardWindow, limit: number, enabled: boolean): BoardState[] {
  const sig = venues.join(',');
  const keyOf = (v: Venue) => `lbv:${v}:${win}:${limit}`;
  const [state, setState] = useState<Record<string, { rows: TraderRow[]; error: string | null; loading: boolean }>>(() => {
    const init: Record<string, { rows: TraderRow[]; error: string | null; loading: boolean }> = {};
    for (const v of venues) {
      const hit = cached<TraderRow[]>(keyOf(v));
      init[keyOf(v)] = { rows: hit?.data ?? [], error: null, loading: !hit };
    }
    return init;
  });
  useEffect(() => {
    if (!enabled || !venues.length) return;
    const ac = new AbortController();
    let timer: number | undefined;
    const run = () => {
      for (const v of venues) {
        const k = keyOf(v);
        const hit = cached<TraderRow[]>(k);
        setState((s) => ({ ...s, [k]: { rows: hit?.data ?? s[k]?.rows ?? [], error: null, loading: !hit } }));
        if (hit && Date.now() - hit.at < REFRESH_MS / 2) continue;
        vsApi
          .leaderboard({ venue: v, window: win, sort: 'pnl', limit }, ac.signal)
          .then((d) => {
            remember(k, d.rows);
            setState((s) => ({ ...s, [k]: { rows: d.rows, error: null, loading: false } }));
          })
          .catch((e) => {
            if (isAbort(e)) return;
            logLoadFailure(`Traders (${v})`, e);
            setState((s) => ({ ...s, [k]: { rows: s[k]?.rows ?? [], error: e instanceof Error ? e.message : String(e), loading: false } }));
          });
      }
      timer = window.setTimeout(run, REFRESH_MS);
    };
    run();
    return () => {
      ac.abort();
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, win, limit, enabled]);
  return venues.map((v) => {
    const st = state[keyOf(v)];
    return { venue: v, rows: st?.rows ?? [], loading: enabled && (st?.loading ?? true), error: st?.error ?? null };
  });
}

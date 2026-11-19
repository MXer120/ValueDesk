/**
 * THE TRADE PAGE'S FIRST READS, STARTED WHEN ITS CODE ARRIVES - not after it has rendered.
 *
 * A cold /trade load asks for a series that is known before anything renders: the 1m chart
 * (Chart.tsx's default interval; 1m has no mark or index source) of the market a link names, else
 * the one stored, else the default (trading/listed.ts bootMarket). The candle read used to wait for
 * the page to render, the chart library to load and klinecharts to start; on Slow 4G that is one
 * round trip plus the transfer after the first paint. It now leaves when the trade chunk evaluates
 * (Chart.tsx calls startEarlyReads at module level), through the same gateway read the chart makes
 * - the same request, budget and dedupe - and the chart takes it over (takeEarly).
 *
 * The owner's rule for early reads (2026-11-18): only the landing page's own first reads start
 * before the entry runs; the trade page's candles and tickers may start from the trade chunk's
 * evaluation, and nothing else. So: the 1m candles and the engine's tickers (the header and the
 * strip read the shared poll this primes), only on a load that lands on the trade page. Never the
 * order book: an answer seconds old is a stale book.
 *
 * Also here, because it runs once per page with the trade code: the series kept across a reload
 * (seriesStore.ts) are read into the in-memory cache, and written back while the trade chart is up.
 */
import { api, type Engine } from '../api';
import { pollEvery } from '../exchange/visibility';
import { logger } from '../log';
import { subscribeShared } from '../sharedPoll';
import { isExcludedPath, isLimitsPath, isStatusPath, landingTab, legalForPath, sodexViewForPath } from '../router';
import { bootMarket } from '../trading/listed';
import { fetchKlineRows } from './klines';
import { KLINE_LIMIT, seriesKey } from './series';
import { seriesCache, type KeptSeries } from './seriesCache';
import { STORED_SERIES, seriesStore, type SeriesStore } from './seriesStore';

export interface EarlyRead {
  key: string;
  limit: number;
  startedAt: number;
  /** When the answer came (null while it is on its way, or when it failed). */
  answeredAt: number | null;
  /** The raw rows once answered. */
  rows: unknown[] | null;
  promise: Promise<unknown[]>;
}

const log = logger('chart');

let early: EarlyRead | null = null;
let started = false;

/** Whether a page load lands on the trade page (router.ts, the same rules App.tsx's first render follows). */
export function isTradeLanding(pathname: string): boolean {
  if (legalForPath(pathname) || isStatusPath(pathname) || isExcludedPath(pathname) || isLimitsPath(pathname) || sodexViewForPath(pathname)) return false;
  return landingTab(pathname) === 'trade';
}

/** The interval a fresh trade chart opens on (Chart.tsx `useState('1m')`). */
export const BOOT_INTERVAL = '1m';

export interface EarlyEnv {
  pathname: string;
  search: string;
  read: (key: string) => string | null;
  now: () => number;
  store: Pick<SeriesStore, 'read' | 'write'>;
  klines: typeof fetchKlineRows;
  tickers: (e: Engine) => void;
}

const readStorage = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const pageEnv = (): EarlyEnv => ({
  pathname: window.location.pathname,
  search: window.location.search,
  read: readStorage,
  now: () => Date.now(),
  store: seriesStore,
  klines: fetchKlineRows,
  // A reader that asks once and leaves at once: the entry and its answer stay in the shared poll,
  // where the header's and the strip's useTickers find it (sharedPoll.ts).
  tickers: (e) => subscribeShared(`md:tickers:${e}`, () => api.tickers(e), 0, () => undefined)(),
});

/** The read of the series kept across a reload, while it is on its way (null once in, or before it started). */
let seeding: Promise<void> | null = null;
/** The kept series from IndexedDB, once they are in the cache: at once when they already are. */
export function keptSeeded(): Promise<void> | null {
  return seeding;
}

/** Once per page, when the trade code evaluates. */
export function startEarlyReads(env: EarlyEnv = pageEnv()): void {
  if (started) return;
  started = true;
  const t0 = env.now();
  const seed: Promise<void> = env.store.read().then((list) => {
    for (const s of list) seriesCache.offer(s);
    log.debug('kept series read from this browser', { series: list.length, ms: Math.round(env.now() - t0) });
  }).finally(() => {
    if (seeding === seed) seeding = null;
  });
  seeding = seed;
  if (!isTradeLanding(env.pathname)) return;
  const m = bootMarket(env.search, env.read);
  const key = seriesKey(m.engine, m.symbol, BOOT_INTERVAL);
  const read: EarlyRead = {
    key,
    limit: KLINE_LIMIT,
    startedAt: env.now(),
    answeredAt: null,
    rows: null,
    promise: env.klines({ engine: m.engine, symbol: m.symbol, interval: BOOT_INTERVAL, limit: KLINE_LIMIT }),
  };
  read.promise.then(
    (rows) => {
      read.rows = rows;
      read.answeredAt = env.now();
    },
    () => {
      // A market no longer listed (404) or a failed read: the chart makes its own.
      if (early === read) early = null;
    },
  );
  early = read;
  env.tickers(m.engine);
}

/** The early read for `key`, handed over once (null when there is none for it). */
export function takeEarly(key: string): EarlyRead | null {
  if (!early || early.key !== key) return null;
  const e = early;
  early = null;
  return e;
}

/** A load that took the early read was superseded before it used it: the next load of that series takes it. */
export function returnEarly(e: EarlyRead): void {
  early ??= e;
}

/** The series on screen, for the write when the page goes out of view (Chart.tsx registers it). */
let live: (() => KeptSeries | null) | null = null;
/** Register the trade chart's series on screen; returns the unregister (a no-op once another chart took over). */
export function setLiveSeries(fn: () => KeptSeries | null): () => void {
  live = fn;
  return () => {
    if (live === fn) live = null;
  };
}

/** What survives a reload: the series on screen first, then the most recently left. */
export function keptForStore(): KeptSeries[] {
  const out: KeptSeries[] = [];
  const now = live?.() ?? null;
  if (now) out.push(now);
  for (const s of seriesCache.list()) {
    if (out.length >= STORED_SERIES) break;
    if (!out.some((o) => o.key === s.key)) out.push(s);
  }
  return out;
}

/** How often the kept series are written while the page is shown (KEEP_WRITE_MS; nothing when nothing changed). */
export const KEEP_WRITE_MS = 30_000;

/** What a write would hold, in one string: a write that would change nothing is skipped. */
export const keptSignature = (list: readonly KeptSeries[]): string =>
  list.map((s) => `${s.key}@${s.bars[s.bars.length - 1]?.timestamp ?? 0}#${s.bars.length}~${s.unverifiedFrom ?? ''}`).join(',');

let persisting = false;
let saveSoon: (() => void) | null = null;
/**
 * Write the kept series a moment after the chart's series changed (keptChanged), every
 * KEEP_WRITE_MS while the page is shown, and when it goes out of view (a tab switch, the app sent
 * to the background). A write started as the page unloads - a reload, a pull to refresh - is not
 * reliably committed (measured: a Page.reload left nothing), so the earlier ones are what a reload
 * finds: at most KEEP_WRITE_MS old, well inside KEPT_GAP_BARS on 1m. A write that would change
 * nothing is skipped.
 */
export function installKeptPersistence(store: Pick<SeriesStore, 'write'> = seriesStore): void {
  if (persisting || typeof document === 'undefined') return;
  persisting = true;
  let written = '';
  let timer = 0;
  const save = () => {
    window.clearTimeout(timer);
    timer = 0;
    const list = keptForStore();
    const sig = keptSignature(list);
    if (!list.length || sig === written) return;
    written = sig;
    void store.write(list);
  };
  saveSoon = () => {
    if (!timer) timer = window.setTimeout(save, 1_000);
  };
  pollEvery(KEEP_WRITE_MS, save);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') save();
  });
  window.addEventListener('pagehide', save);
}

/** The chart put a series on or left one: the copy kept across a reload is brought up to date in a moment. */
export function keptChanged(): void {
  saveSoon?.();
}

/** For tests. */
export function _resetEarly(): void {
  early = null;
  started = false;
  live = null;
  seeding = null;
}

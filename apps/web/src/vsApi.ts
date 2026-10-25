/**
 * The multi-venue trader API.
 *
 * Two halves. The Valuescan INDEX - leaderboards, cohorts, the screener,
 * Explore, whales and positioning - is ours and comes from /api/vs/* (see
 * apps/server/src/routes/valuescan.ts). One TRADER on one venue - profile,
 * fills, open orders, history, funding, balances - and a coin's price are read
 * straight from that venue in this browser (exchange/venues.ts), with the
 * server's own provider code: each user's own IP and budget, and no address
 * anyone looks at passes through Valuescan.
 *
 * Types come from the server through the `@sign` alias, so both sides share one
 * definition. Every endpoint answers HTTP 200 with {ok:false, code, error} when
 * a venue fails, so `unwrap` turns that into a thrown VsError that the page's
 * useAsync error state can render per section.
 */
import type {
  BoardWindow,
  ExploreResponse,
  LeaderboardResponse,
  LeaderboardSort,
  NewsItem,
  Positioning,
  TraderProfile,
  Venue,
  VsBalance,
  VsFill,
  VsFunding,
  VsOrder,
  WhaleTrade,
  Window,
} from '@sign/valuescan/types.js';
import { VenueError, venues } from './exchange/venues';
import { serverGetJson } from './serverFetch';
import type { CalendarEvent, CalendarSource } from '@sign/valuescan/calendar.js';
import type { LiqHeatmap, LiqHistory, LiqWallets } from '@sign/indexer/liqRead.js';
import type { CohortDetailResponse, CohortFilter, CohortFocusResponse, CohortId, CohortMapResponse, CohortRange, CohortWalletsResponse, CohortsResponse, WalletSort } from '@sign/valuescan/cohorts/model.js';

export type { CalendarEvent, CalendarSource };
export type {
  VsBalance,
  VsFunding,
  VsOrder,
  BoardWindow,
  EquityPoint,
  ExploreResponse,
  ExploreSegment,
  LeaderboardResponse,
  LeaderboardSort,
  NewsItem,
  Positioning,
  TraderProfile,
  TraderRow,
  Venue,
  VsFill,
  VsPosition,
  WhaleTrade,
  Window,
} from '@sign/valuescan/types.js';

export const VS_VENUES: readonly Venue[] = ['sodex', 'hyperliquid'];
/** Venues Scan can open an address on (a profile and fills each). */
export const SCAN_VENUES: readonly Venue[] = ['sodex', 'hyperliquid', 'tradexyz', 'lighter', 'arcus'];
export const VENUE_LABEL: Record<Venue, string> = {
  sodex: 'SoDEX',
  hyperliquid: 'Hyperliquid',
  tradexyz: 'trade.xyz',
  lighter: 'Lighter',
  arcus: 'Arcus',
};

export class VsError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

const qs = (o: Record<string, string | number | undefined>): string => {
  const p = new URLSearchParams(
    Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]),
  ).toString();
  return p ? `?${p}` : '';
};

/**
 * One index read, through serverFetch.ts: identical reads in flight share one
 * request, and a poll (a read made inside `revalidating()`) asks the server -
 * an unchanged answer is a 304 - instead of taking the copy the HTTP cache holds.
 */
async function unwrap<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await serverGetJson<T & { ok?: boolean; error?: string; code?: string }>(path, signal);
  const body = res.body;
  if (!res.ok || !body || body.ok === false) {
    throw new VsError(body?.error ?? `HTTP ${res.status} from ${path}`, body?.code);
  }
  return body as T;
}

/** A venue read done in this browser, failing the way the route did (VsError with its code). */
function direct<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  const mapped = p.catch((e: unknown) => {
    if (e instanceof VenueError) throw new VsError(e.message, e.code === 'bad_request' ? undefined : e.code);
    throw new VsError(e instanceof Error ? e.message : String(e), 'upstream');
  });
  if (!signal) return mapped;
  if (signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    mapped.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

export const vsApi = {
  leaderboard: (
    o: { venue?: Venue | 'all'; venues?: string; view?: 'net' | 'single'; window?: BoardWindow; sort?: LeaderboardSort; limit?: number; offset?: number; q?: string; side?: 'top' | 'worst'; curves?: 1; minTrades?: 2 },
    signal?: AbortSignal,
  ) => unwrap<LeaderboardResponse & { partial?: Venue[] }>(`/api/vs/leaderboard${qs(o)}`, signal),

  explore: (signal?: AbortSignal) => unwrap<ExploreResponse>('/api/vs/explore', signal),

  /** Hyperliquid markets (default dex and xyz), including the hourly funding rate. */
  assets: (signal?: AbortSignal) =>
    unwrap<{ assets?: unknown }>('/api/vs/screener?view=assets', signal),

  // --- one trader on one venue: straight from the venue, in this browser -----
  trader: (venue: Venue, address: string, signal?: AbortSignal): Promise<TraderProfile | null> =>
    direct(venues.trader(venue, address), signal),

  fills: (venue: Venue, address: string, o: { from?: number; to?: number; limit?: number } = {}, signal?: AbortSignal): Promise<VsFill[]> =>
    direct(venues.fills(venue, address, o), signal),
  openOrders: (venue: Venue, address: string, signal?: AbortSignal): Promise<VsOrder[]> =>
    direct(venues.openOrders(venue, address), signal),
  orderHistory: (venue: Venue, address: string, signal?: AbortSignal): Promise<VsOrder[]> =>
    direct(venues.orderHistory(venue, address), signal),
  funding: (venue: Venue, address: string, signal?: AbortSignal): Promise<VsFunding[]> =>
    direct(venues.funding(venue, address), signal),
  balances: (venue: Venue, address: string, signal?: AbortSignal): Promise<VsBalance[]> =>
    direct(venues.balances(venue, address), signal),

  whales: (o: { venue?: Venue | 'all'; minUsd?: number; limit?: number } = {}, signal?: AbortSignal) =>
    unwrap<{ trades: WhaleTrade[] }>(`/api/vs/whales${qs(o)}`, signal).then((b) => b.trades),

  positioning: (o: { venue?: Venue | 'all'; symbol?: string } = {}, signal?: AbortSignal) =>
    unwrap<{ rows: Positioning[] }>(`/api/vs/positioning${qs(o)}`, signal).then((b) => b.rows),

  /**
   * SoSoValue news, already reduced by the server (the key never reaches this browser):
   * the latest, hot or featured list, by type (`category`) and coin, or a keyword search.
   */
  news: (
    o: { feed?: 'latest' | 'hot' | 'featured'; category?: number; coin?: string; q?: string; page?: number; limit?: number; topic?: 'macro'; posts?: 'all'; history?: 1 } = {},
    signal?: AbortSignal,
  ) => unwrap<{ items: NewsItem[]; page: number; total: number | null; source: string }>(`/api/vs/news${qs(o)}`, signal),

  /** News from the sources beside SoSoValue (server valuescan/feeds.ts): `ids` comma-separated, newest first. */
  newsSources: (o: { ids: string; coin?: string; q?: string; limit?: number }, signal?: AbortSignal) =>
    unwrap<{ items: NewsItem[] }>(`/api/vs/news/sources${qs(o)}`, signal),

  /**
   * The economic calendar: the FOMC's meetings, BLS and BEA releases and
   * SoSoValue's macro events (server valuescan/calendar.ts), a week back to
   * two months ahead unless asked otherwise.
   */
  calendar: (o: { from?: number; to?: number } = {}, signal?: AbortSignal) =>
    unwrap<{ events: CalendarEvent[]; sources: Record<CalendarSource, 'ok' | 'stale' | 'none'>; sourceNames: Record<CalendarSource, string> }>(
      `/api/vs/calendar${qs(o)}`,
      signal,
    ),

  /** The video a YouTube channel has on air now, or null (the Live Feed widget). */
  live: (channel: string, signal?: AbortSignal) =>
    unwrap<{ channel: string; video: string | null }>(`/api/vs/live${qs({ channel })}`, signal).then((b) => b.video),

  /** A coin's liquidation levels over a set of venues (the cohort books, priced: server indexer/liqRead.ts). */
  liquidations: (coin: string, venues: readonly Venue[], res: 'fine' | 'medium' | 'coarse', signal?: AbortSignal) =>
    unwrap<LiqHeatmap>(`/api/vs/liquidations${qs({ coin, venues: venues.join(','), res })}`, signal),
  /** The wallets whose longs (or shorts) liquidate in [from, to). */
  liquidationWallets: (coin: string, venues: readonly Venue[], side: 'long' | 'short', from: number, to: number, signal?: AbortSignal) =>
    unwrap<LiqWallets>(`/api/vs/liquidations/wallets${qs({ coin, venues: venues.join(','), side, from, to })}`, signal),
  /** The levels over time: the indexer's 15-minute snapshots (hourly past 3 days). */
  liquidationHistory: (coin: string, venues: readonly Venue[], range: '1d' | '7d' | '30d', signal?: AbortSignal) =>
    unwrap<LiqHistory>(`/api/vs/liquidations/history${qs({ coin, venues: venues.join(','), range })}`, signal),

  /** Every cohort for a set of venues (netted over them), under a sector / coin filter. */
  cohorts: (venues: readonly Venue[], f: CohortFilter, signal?: AbortSignal) =>
    unwrap<CohortsResponse>(`/api/vs/cohorts${qs({ venues: venues.join(','), sector: f.sector ?? undefined, coin: f.coin ?? undefined })}`, signal),
  cohortDetail: (venues: readonly Venue[], cohort: CohortId, range: CohortRange, f: CohortFilter, signal?: AbortSignal) =>
    unwrap<CohortDetailResponse>(`/api/vs/cohorts/detail${qs({ venues: venues.join(','), cohort, range, sector: f.sector ?? undefined, coin: f.coin ?? undefined })}`, signal),
  /** Every asset held, grouped by sector (every wallet, or one cohort's). */
  cohortMap: (venues: readonly Venue[], cohort: CohortId | null, signal?: AbortSignal) =>
    unwrap<CohortMapResponse>(`/api/vs/cohorts/map${qs({ venues: venues.join(','), cohort: cohort ?? undefined })}`, signal),
  /** One asset or sector across every cohort. */
  cohortFocus: (venues: readonly Venue[], f: CohortFilter, range: CohortRange, signal?: AbortSignal) =>
    unwrap<CohortFocusResponse>(`/api/vs/cohorts/focus${qs({ venues: venues.join(','), sector: f.sector ?? undefined, coin: f.coin ?? undefined, range })}`, signal),
  /** A coin's price over a range (Hyperliquid candles: [t, open, high, low, close], and the closes). */
  price: (coin: string, range: CohortRange, signal?: AbortSignal): Promise<{ coin: string; market: string; source: string; interval?: string; points: Array<[number, number]>; candles?: Array<[number, number, number, number, number]> }> =>
    direct(venues.price(coin, range), signal),
  cohortWallets: (
    venues: readonly Venue[], cohort: CohortId, f: CohortFilter,
    /** `range`: what `pnlRange` and the win rate cover (the server's default is 30d). */
    o: { sort: WalletSort; dir: 'asc' | 'desc'; offset: number; limit: number; range?: CohortRange }, signal?: AbortSignal,
  ) =>
    unwrap<CohortWalletsResponse>(`/api/vs/cohorts/wallets${qs({ venues: venues.join(','), cohort, sector: f.sector ?? undefined, coin: f.coin ?? undefined, ...o })}`, signal),
};

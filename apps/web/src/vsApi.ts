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
import type { CohortDetailResponse, CohortFilter, CohortFocusResponse, CohortId, CohortMapResponse, CohortRange, CohortWalletsResponse, CohortsResponse, WalletSort } from '@sign/valuescan/cohorts/model.js';

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

async function unwrap<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { headers: { Accept: 'application/json' }, signal });
  const body = await res.json().catch(() => null);
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

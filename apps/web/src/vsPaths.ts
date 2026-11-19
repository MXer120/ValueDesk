/**
 * The paths (and queries) of ValueDesk's index reads, in one pure module: vsApi.ts fetches them, the live socket
 * subscribes to the very same strings (live/liveSocket.ts), and the build's first-read registry (firstReadDefaults.ts,
 * read by tools/route-preload.mjs at build time) names a landing page's reads with them. No runtime imports: the
 * build config loads this file under Node.
 */
import type { BoardWindow, LeaderboardSort, Venue } from '@sign/valuedesk/types.js';
import type { FlowRole, FlowSide, FlowSort } from '@sign/flow/codec.js';
import type { CohortFilter, CohortId, CohortRange, WalletSort } from '@sign/valuedesk/cohorts/model.js';

/** Venues Scan can open an address on (a profile and fills each); the cohorts' venue set by default. */
export const SCAN_VENUES: readonly Venue[] = ['sodex', 'hyperliquid', 'tradexyz', 'lighter', 'arcus'];

export const qs = (o: Record<string, string | number | undefined>): string => {
  const p = new URLSearchParams(
    Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]),
  ).toString();
  return p ? `?${p}` : '';
};

export type FlowAskQuery = { coin: string; venues: readonly Venue[]; kind?: 'perp' | 'spot'; from: number; to: number; role: FlowRole; side: FlowSide; sort: FlowSort; limit?: number; q?: string };

/** A leaderboard read (the route's query, as /api/vs/leaderboard takes it). */
export type LeaderboardQuery = { venue?: Venue | 'all'; venues?: string; view?: 'net' | 'single'; window?: BoardWindow; sort?: LeaderboardSort; limit?: number; offset?: number; q?: string; side?: 'top' | 'worst'; curves?: 1; minTrades?: 2 };

export const vsPaths = {
  flow: (ask: FlowAskQuery) =>
    `/api/vs/flow${qs({ coin: ask.coin, venues: ask.venues.join(','), kind: ask.kind, from: ask.from, to: ask.to, role: ask.role, side: ask.side, sort: ask.sort, limit: ask.limit, q: ask.q })}`,
  cohorts: (venues: readonly Venue[], f: CohortFilter) =>
    `/api/vs/cohorts${qs({ venues: venues.join(','), sector: f.sector ?? undefined, coin: f.coin ?? undefined })}`,
  cohortDetail: (venues: readonly Venue[], cohort: CohortId, range: CohortRange, f: CohortFilter) =>
    `/api/vs/cohorts/detail${qs({ venues: venues.join(','), cohort, range, sector: f.sector ?? undefined, coin: f.coin ?? undefined })}`,
  cohortMap: (venues: readonly Venue[], cohort: CohortId | null) =>
    `/api/vs/cohorts/map${qs({ venues: venues.join(','), cohort: cohort ?? undefined })}`,
  cohortFocus: (venues: readonly Venue[], f: CohortFilter, range: CohortRange) =>
    `/api/vs/cohorts/focus${qs({ venues: venues.join(','), sector: f.sector ?? undefined, coin: f.coin ?? undefined, range })}`,
  cohortWallets: (
    venues: readonly Venue[], cohort: CohortId, f: CohortFilter,
    o: { sort: WalletSort; dir: 'asc' | 'desc'; offset: number; limit: number; range?: CohortRange },
  ) => `/api/vs/cohorts/wallets${qs({ venues: venues.join(','), cohort, sector: f.sector ?? undefined, coin: f.coin ?? undefined, ...o })}`,
  leaderboard: (o: LeaderboardQuery) => `/api/vs/leaderboard${qs(o)}`,
  /** Hyperliquid markets (default dex and xyz), including the hourly funding rate. */
  screenerAssets: '/api/vs/screener?view=assets',
  sodexOiExcluded: '/api/vs/sodex/oi-excluded',
  /** The bots' regime board: one market or 'ALL', over a window. */
  botRegime: (symbol: string, window: string) => `/api/vs/bots/regime?symbol=${encodeURIComponent(symbol)}&window=${window}`,
  /** What a new market maker pays on every market, over a window. */
  botMarkets: (window: string) => `/api/vs/bots/markets?window=${window}`,
  lotteryMeta: '/api/vs/sodex/lottery/meta',
  lotteryFeed: (limit: number) => `/api/vs/sodex/lottery/feed?limit=${limit}`,
  /** The UTC day start of `fromMs`: the server keys its answer by that day (valuedesk/sodex/mmDaily.ts), so one URL a day. */
  mmDaily: (fromMs: number) => `/api/vs/sodex/mm-daily?from=${Math.floor(fromMs / 86_400_000) * 86_400_000}`,
};

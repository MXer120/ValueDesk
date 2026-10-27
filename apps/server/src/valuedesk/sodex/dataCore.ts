/**
 * SoDEX's analytics host (mainnet-data.sodex.dev) - the official leaderboard,
 * a wallet's rank and the per-account portfolio chart - with the transport
 * injected.
 *
 * The server binds this to its limited, retrying client (data.ts); the browser
 * binds it to its own per-user-IP client. Same paths, same caches, same rule
 * for what counts as an answer.
 */
import type { ChartWindow, LbPage, LbRank, LbWindow, PortfolioChart } from './mappers.js';
import { TtlCache } from './util.js';

/** The leaderboard's page_size is an enum {10, 20, 50}; 50 is the cheapest per row. */
export const LB_PAGE_SIZE = 50;

/** The ranking only moves with the hourly snapshot; 60 s keeps paging instant. */
export const LB_TTL = 60_000;
export const CHART_TTL = 2 * 60_000;

/** Every call goes through one small limiter: 4 in flight, >= 80 ms apart. */
export const DATA_CONCURRENCY = 4;
export const DATA_GAP_MS = 80;
export const DATA_TIMEOUT_MS = 15_000;
export const DATA_ATTEMPTS = 3;

export type Priority = 'high' | 'low';

/** One data-host GET, path relative to the host. Resolves with the envelope's `data`. */
export type DataGet = <T>(path: string, priority?: Priority) => Promise<T>;

/**
 * A data-host body counts only when it positively asserts `code: 0` and
 * carries `data`. `fail` builds the caller's own error type (the server's
 * SodexApiError, the browser's) from (code, message, httpStatus, path, body).
 */
export function parseDataBody<T>(
  status: number,
  ok: boolean,
  text: string,
  path: string,
  fail: (code: number, message: string, httpStatus: number, path: string, body?: unknown) => Error,
): T {
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // Cloudflare's rate-limit page is plain text ("error code: 1015").
    throw fail(-1, `non-JSON response (HTTP ${status}): ${text.slice(0, 120)}`, status, path);
  }
  const obj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const code = typeof obj.code === 'number' ? obj.code : undefined;
  const msg = (obj.message ?? obj.error ?? obj.msg) as string | undefined;
  if (!ok || (code !== undefined && code !== 0) || !('data' in obj)) {
    throw fail(code ?? status, msg || `HTTP ${status}`, status, path, parsed);
  }
  return obj.data as T;
}

export interface DataHostReads {
  lbPage(window: LbWindow, sortBy: 'pnl' | 'volume', page: number, priority?: Priority, sortOrder?: 'asc' | 'desc'): Promise<LbPage>;
  /** One wallet's standing. `found:false` is an answer (not ranked in that window), not an error. */
  lbRank(window: LbWindow, sortBy: 'pnl' | 'volume', address: string, priority?: Priority): Promise<LbRank>;
  /** The venue's own portfolio curve for one account (spot + perps + vaults). */
  portfolioChart(accountId: number, window: ChartWindow, priority?: Priority): Promise<PortfolioChart>;
}

export function dataHostReads(get: DataGet, cache = new TtlCache(4_000)): DataHostReads {
  return {
    lbPage(window, sortBy, page, priority = 'high', sortOrder = 'desc') {
      const qs = new URLSearchParams({
        window_type: window,
        sort_by: sortBy,
        sort_order: sortOrder,
        page: String(page),
        page_size: String(LB_PAGE_SIZE),
      });
      const path = `/api/v1/leaderboard?${qs}`;
      return cache.wrap(path, LB_TTL, () => get<LbPage>(path, priority));
    },

    lbRank(window, sortBy, address, priority = 'high') {
      const qs = new URLSearchParams({ window_type: window, sort_by: sortBy, wallet_address: address });
      const path = `/api/v1/leaderboard/rank?${qs}`;
      return cache.wrap(path, LB_TTL, () => get<LbRank>(path, priority));
    },

    portfolioChart(accountId, window, priority = 'high') {
      const qs = new URLSearchParams({ account_id: String(accountId), window });
      const path = `/api/v1/wallet/portfolio/chart?${qs}`;
      return cache.wrap(path, CHART_TTL, () => get<PortfolioChart>(path, priority));
    },
  };
}

/**
 * Client for SoDEX's analytics host (mainnet-data.sodex.dev): the official
 * leaderboard, a wallet's rank, and the per-account portfolio chart.
 *
 * This host is not the trading gateway, so it is outside `sodex/rest.ts`'s
 * weight budget. It has no published rate limit, sits behind the same
 * Cloudflare zone as the gateway, and a burst from this machine could earn a
 * 1015 that the running Valuetrade app would also feel. So every call goes
 * through one small limiter (4 in flight, >=80 ms apart), every answer is
 * cached, and a 429/1015 trips the shared cooldown instead of being retried.
 *
 * The fetch/envelope logic mirrors routes/external.ts `getJson` and
 * routes/stats.ts `dataGet` (neither is exported): a body counts only when it
 * positively asserts `code: 0` and carries `data`.
 */
import { NET } from '../../config.js';
import { SodexApiError, isTransientFailure } from '../../sodex/rest.js';
import type { ChartWindow, LbPage, LbRank, LbWindow, PortfolioChart } from './mappers.js';
import { Limiter, TtlCache, isRateLimit, noteRateLimited, sleep } from './util.js';

/** Same derivation as routes/external.ts, so a testnet run never shows mainnet rankings. */
export const DATA_API = process.env.SODEX_DATA_API?.trim() || NET.restBase.replace('-gw.', '-data.');

/** The leaderboard's page_size is an enum {10, 20, 50}; 50 is the cheapest per row. */
export const LB_PAGE_SIZE = 50;

const TIMEOUT_MS = 15_000;
const ATTEMPTS = 3;

const limiter = new Limiter(4, 80);
const cache = new TtlCache(4_000);

export type Priority = 'high' | 'low';

async function fetchOnce<T>(path: string): Promise<T> {
  const res = await fetch(DATA_API + path, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // Cloudflare's rate-limit page is plain text ("error code: 1015").
    throw new SodexApiError(-1, `non-JSON response (HTTP ${res.status}): ${text.slice(0, 120)}`, res.status, path);
  }
  const obj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const code = typeof obj.code === 'number' ? obj.code : undefined;
  const msg = (obj.message ?? obj.error ?? obj.msg) as string | undefined;
  if (!res.ok || (code !== undefined && code !== 0) || !('data' in obj)) {
    throw new SodexApiError(code ?? res.status, msg || `HTTP ${res.status}`, res.status, path, parsed);
  }
  return obj.data as T;
}

/** One GET, limited and retried. Rate limits are never retried: they trip the cooldown. */
export function dataGet<T>(path: string, priority: Priority = 'high'): Promise<T> {
  return limiter.run(async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fetchOnce<T>(path);
      } catch (err) {
        if (isRateLimit(err)) {
          noteRateLimited();
          throw err;
        }
        if (attempt >= ATTEMPTS || !isTransientFailure(err)) throw err;
        await sleep(250 * 2 ** (attempt - 1));
      }
    }
  }, priority);
}

/** Requests queued behind the limiter at background priority. */
export const backgroundBacklog = (): number => limiter.pendingLow;

// --- endpoints ---------------------------------------------------------------

/** The ranking only moves with the hourly snapshot; 60 s keeps paging instant. */
const LB_TTL = 60_000;
const CHART_TTL = 2 * 60_000;

export function lbPage(
  window: LbWindow,
  sortBy: 'pnl' | 'volume',
  page: number,
  priority: Priority = 'high',
  sortOrder: 'asc' | 'desc' = 'desc',
): Promise<LbPage> {
  const qs = new URLSearchParams({
    window_type: window,
    sort_by: sortBy,
    sort_order: sortOrder,
    page: String(page),
    page_size: String(LB_PAGE_SIZE),
  });
  const path = `/api/v1/leaderboard?${qs}`;
  return cache.wrap(path, LB_TTL, () => dataGet<LbPage>(path, priority));
}

/** One wallet's standing. `found:false` is an answer (not ranked in that window), not an error. */
export function lbRank(
  window: LbWindow,
  sortBy: 'pnl' | 'volume',
  address: string,
  priority: Priority = 'high',
): Promise<LbRank> {
  const qs = new URLSearchParams({ window_type: window, sort_by: sortBy, wallet_address: address });
  const path = `/api/v1/leaderboard/rank?${qs}`;
  return cache.wrap(path, LB_TTL, () => dataGet<LbRank>(path, priority));
}

/** The venue's own portfolio curve for one account (spot + perps + vaults). */
export function portfolioChart(
  accountId: number,
  window: ChartWindow,
  priority: Priority = 'high',
): Promise<PortfolioChart> {
  const qs = new URLSearchParams({ account_id: String(accountId), window });
  const path = `/api/v1/wallet/portfolio/chart?${qs}`;
  return cache.wrap(path, CHART_TTL, () => dataGet<PortfolioChart>(path, priority));
}

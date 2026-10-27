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
 * The paths, caches and the rule for what counts as an answer (a body that
 * positively asserts `code: 0` and carries `data`) are dataCore.ts, which the
 * browser binds to its own client; this file is the server's transport.
 */
import { NET } from '../../config.js';
import { SodexApiError, isTransientFailure } from '../../sodex/rest.js';
import { envOf } from '../env.js';
import {
  DATA_ATTEMPTS,
  DATA_CONCURRENCY,
  DATA_GAP_MS,
  DATA_TIMEOUT_MS,
  LB_PAGE_SIZE,
  dataHostReads,
  parseDataBody,
  type Priority,
} from './dataCore.js';
import { Limiter, isRateLimit, noteRateLimited, sleep } from './util.js';

export { LB_PAGE_SIZE, type Priority };

/** Same derivation as routes/external.ts, so a testnet run never shows mainnet rankings. */
export const DATA_API = envOf('SODEX_DATA_API')?.trim() || NET.restBase.replace('-gw.', '-data.');

const limiter = new Limiter(DATA_CONCURRENCY, DATA_GAP_MS);

async function fetchOnce<T>(path: string): Promise<T> {
  const res = await fetch(DATA_API + path, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(DATA_TIMEOUT_MS),
  });
  const text = await res.text();
  return parseDataBody<T>(res.status, res.ok, text, path, (code, message, httpStatus, p, body) => new SodexApiError(code, message, httpStatus, p, body));
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
        if (attempt >= DATA_ATTEMPTS || !isTransientFailure(err)) throw err;
        await sleep(250 * 2 ** (attempt - 1));
      }
    }
  }, priority);
}

/** Requests queued behind the limiter at background priority. */
export const backgroundBacklog = (): number => limiter.pendingLow;

// --- endpoints ---------------------------------------------------------------

const reads = dataHostReads(dataGet);

export const lbPage = reads.lbPage;
/** One wallet's standing. `found:false` is an answer (not ranked in that window), not an error. */
export const lbRank = reads.lbRank;
/** The venue's own portfolio curve for one account (spot + perps + vaults). */
export const portfolioChart = reads.portfolioChart;

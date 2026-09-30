/**
 * All-time account statistics.
 *
 * Two sources with very different provenance, deliberately kept apart all the way
 * to the response body so the UI can label each one:
 *
 *  - OUR WALK. Fees, funding, trade count and traded notional are aggregated from
 *    the account's full fill and funding history, paged backwards by
 *    ../history.js and cached on disk. Exact, per-coin, and as complete as the
 *    walk says it is - `sync.complete` is the walk's own claim, not an assumption.
 *
 *  - THE VENUE'S HEADLINE. `mainnet-data.sodex.dev` publishes a precomputed perps
 *    PnL overview. It is fast and it is the venue's own number, but it is
 *    PERPS-ONLY and it is a DAILY SNAPSHOT: the observed `ts_ms` is a UTC midnight
 *    boundary, so it lags live activity by up to a day plus whatever the job
 *    takes. It is returned with that timestamp attached so the panel can say how
 *    old it is instead of implying it is live.
 *
 * The headline reader and the answer's shape are ../statsCore.ts, the same code
 * the browser runs for its own walk (docs/ARCH-traffic.md §1.2) - this route
 * binds them to the server's gateway client and the stats host, and answers
 * what it always answered. The web no longer calls it, and hosted mode does not
 * serve it.
 *
 * A walk over a long history takes minutes, so this route never blocks on one: it
 * starts the sync, answers immediately from whatever the cache holds, and reports
 * progress. The client polls while `sync.running` is true.
 */
import type { FastifyInstance } from 'fastify';
import { sodex, SodexApiError, isTransientFailure } from '../sodex/rest.js';
import { NET, enginePath } from '../config.js';
import {
  SCOPE_KINDS,
  aggregateFunding,
  aggregateTrades,
  cacheStatus,
  ensureSync,
  progressOf,
  rowsFor,
  type SyncProgress,
} from '../history.js';
import { allTimeStatsBody, headlineReader } from '../statsCore.js';

export type { Headline } from '../statsCore.js';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function requireAddress(q: { address?: string }): string {
  if (!q.address || !ADDRESS_RE.test(q.address)) {
    throw Object.assign(new Error('a valid 0x wallet address is required'), { statusCode: 400 });
  }
  return q.address;
}

// --- the venue's precomputed perps headline ---------------------------------

/**
 * The stats host is a different service from the trading gateway, so it is NOT
 * covered by SodexClient's weight budget, cache or retry - all of which are
 * scoped to the gateway. Everything it needs is therefore re-implemented here,
 * narrowly.
 *
 * Derived from the configured gateway base so testnet does not silently read
 * mainnet numbers. Only the mainnet host has been observed to answer; on any
 * other network a 404 simply lands in `reason` and the panel says the headline is
 * unavailable.
 */
const DATA_BASE = process.env.VALUETRADE_DATA_BASE?.trim() || NET.restBase.replace('-gw.', '-data.');

const DATA_ATTEMPTS = 3;

/**
 * GET one JSON envelope from the stats host.
 *
 * Applies the same rule the gateway client applies: a body is only accepted when
 * it positively asserts success. The observed shape is
 *   {"code":0,"message":"","data":{...}}
 * so a non-zero `code` - even under HTTP 200 - is a failure, and a failure is
 * retried only when `isTransientFailure` says it is worth replaying.
 */
async function dataGet<T>(path: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(DATA_BASE + path, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        throw new SodexApiError(-1, `non-JSON response (HTTP ${res.status})`, res.status, path);
      }
      const obj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
      const code = typeof obj.code === 'number' ? obj.code : undefined;
      const msg = (obj.message ?? obj.error ?? obj.msg) as string | undefined;
      if (!res.ok || (code !== undefined && code !== 0) || !('data' in obj)) {
        throw new SodexApiError(code ?? res.status, msg || `HTTP ${res.status}`, res.status, path, parsed);
      }
      return obj.data as T;
    } catch (err) {
      if (attempt >= DATA_ATTEMPTS || !isTransientFailure(err)) throw err;
      await new Promise((r) => setTimeout(r, 200 * 2 ** (attempt - 1)));
    }
  }
}

/**
 * The headline, memoised a minute per wallet (bounded): the underlying figure
 * only moves once a day, and the panel polls. `accountId` is the perps state's
 * `aid` - 0 means this wallet has no SoDEX account, a real answer, not an error.
 */
const headlineFor = headlineReader({
  accountId: async (address) => {
    const state = await sodex.get<{ aid?: number }>(`${enginePath('perps')}/accounts/${address}/state`);
    return Number(state?.aid ?? 0);
  },
  dataGet,
});

// --- routes ------------------------------------------------------------------

export async function statsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * All-time statistics for one wallet.
   *
   * Answers immediately from the cache and kicks the sync along in the
   * background. `?rebuild=1` discards the cached history for this wallet and
   * walks it again from scratch - the escape hatch for a cache written by an
   * older, wronger parse.
   */
  app.get('/api/stats/all-time', async (req, reply) => {
    // A GET with side effects: it starts history walks for any address, and
    // `rebuild=1` throws a wallet's cached history away. So a foreign page must
    // not be able to fire it with an <img> or a no-cors fetch - through the
    // Vite proxy those even carry the local token. Browsers label them
    // Sec-Fetch-Site: cross-site / same-site; the app's own reads are
    // same-origin, and native clients send no such header.
    const site = req.headers['sec-fetch-site'];
    if (site === 'cross-site' || site === 'same-site') {
      return reply.code(403).send({ error: 'cross-site request refused', source: 'server' });
    }
    const q = req.query as { address?: string; rebuild?: string };
    const address = requireAddress(q);
    const rebuild = q.rebuild === '1';

    for (const kind of SCOPE_KINDS) ensureSync(kind, address, rebuild);

    const scopes: Record<string, SyncProgress> = {};
    for (const kind of SCOPE_KINDS) scopes[kind] = progressOf(kind, address);

    const [spot, perps, headline] = await Promise.all([
      aggregateTrades('spot', rowsFor('trades-spot', address)),
      aggregateTrades('perps', rowsFor('trades-perps', address)),
      headlineFor(address),
    ]);
    // Everything is labelled at the source (statsCore.ts allTimeStatsBody): the
    // walk and the venue's daily perps snapshot are never merged.
    return allTimeStatsBody({
      address,
      spot,
      perps,
      funding: aggregateFunding(rowsFor('funding', address)),
      headline,
      scopes,
      cache: cacheStatus(),
    });
  });
}

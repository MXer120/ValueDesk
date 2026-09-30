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
 * There is deliberately NO spot realized-PnL figure. The venue publishes none
 * (`/spot/pnl/overview` 404s), and the only honest alternative is a full
 * FIFO/average-cost reconstruction across several fee and quote denominations.
 * Until that exists, this route returns `spotRealizedPnl: null` with a reason
 * string, and the panel renders the reason. A blank on a trading screen is
 * recoverable; a plausible wrong number is not.
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

export interface Headline {
  available: boolean;
  reason: string | null;
  accountId: number | null;
  /** Snapshot timestamp reported by the venue - the basis for the staleness note. */
  asOf: number | null;
  cumulativePnl: string | null;
  unrealizedPnl: string | null;
  cumulativeQuoteVolume: string | null;
  /** Absent for accounts the venue has no fills for; rendered only when present. */
  firstTradeAt: number | null;
  /** Cumulative (not per-day) perps PnL, one point per UTC day. */
  curve: Array<{ t: number; pnl: string }>;
}

const decOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : null;

const msOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;

/**
 * Resolve the numeric account id the stats host keys on.
 *
 * `aid === 0` means this wallet has no SoDEX account at all, which is a real
 * answer and not an error - the headline is simply unavailable.
 */
async function accountId(address: string): Promise<number> {
  const state = await sodex.get<{ aid?: number }>(`${enginePath('perps')}/accounts/${address}/state`);
  return Number(state?.aid ?? 0);
}

const EMPTY_HEADLINE = (reason: string): Headline => ({
  available: false,
  reason,
  accountId: null,
  asOf: null,
  cumulativePnl: null,
  unrealizedPnl: null,
  cumulativeQuoteVolume: null,
  firstTradeAt: null,
  curve: [],
});

/** 60s memo: the underlying figure only moves once a day, and the panel polls. */
const headlineCache = new Map<string, { at: number; value: Headline }>();
const HEADLINE_TTL = 60_000;

async function headlineFor(address: string): Promise<Headline> {
  const key = address.toLowerCase();
  const hit = headlineCache.get(key);
  if (hit && Date.now() - hit.at < HEADLINE_TTL) return hit.value;

  let value: Headline;
  try {
    const aid = await accountId(address);
    if (!aid) {
      value = EMPTY_HEADLINE('this wallet has no SoDEX account yet');
    } else {
      const overview = await dataGet<Record<string, unknown>>(
        `/api/v1/perps/pnl/overview?account_id=${aid}`,
      );
      // The equity curve is a nicety. Losing it must not lose the headline.
      let curve: Array<{ t: number; pnl: string }> = [];
      try {
        const daily = await dataGet<{ items?: Array<Record<string, unknown>> }>(
          `/api/v1/perps/pnl/daily_stats?account_id=${aid}`,
        );
        curve = (daily?.items ?? [])
          .map((i) => ({ t: msOrNull(i.ts_ms) ?? 0, pnl: decOrNull(i.pnl) ?? '' }))
          .filter((p) => p.t > 0 && p.pnl !== '')
          .sort((a, b) => a.t - b.t);
      } catch {
        curve = [];
      }
      value = {
        available: true,
        reason: null,
        accountId: aid,
        asOf: msOrNull(overview.ts_ms),
        cumulativePnl: decOrNull(overview.cumulative_pnl),
        unrealizedPnl: decOrNull(overview.unrealized_pnl),
        cumulativeQuoteVolume: decOrNull(overview.cumulative_quote_volume),
        firstTradeAt: msOrNull(overview.first_trade_ts_ms),
        curve,
      };
    }
  } catch (e) {
    value = EMPTY_HEADLINE((e as Error).message);
  }

  headlineCache.set(key, { at: Date.now(), value });
  return value;
}

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
  app.get('/api/stats/all-time', async (req) => {
    const q = req.query as { address?: string; rebuild?: string };
    const address = requireAddress(q);
    const rebuild = q.rebuild === '1';

    for (const kind of SCOPE_KINDS) ensureSync(kind, address, rebuild);

    const sync: Record<string, SyncProgress> = {};
    for (const kind of SCOPE_KINDS) sync[kind] = progressOf(kind, address);

    const [spot, perps, headline] = await Promise.all([
      aggregateTrades('spot', rowsFor('trades-spot', address)),
      aggregateTrades('perps', rowsFor('trades-perps', address)),
      headlineFor(address),
    ]);
    const funding = aggregateFunding(rowsFor('funding', address));

    return {
      address,
      /*
       * Everything below is labelled at the source. The panel must not merge
       * these: `trades` is our own exhaustive walk, `headline` is the venue's
       * daily perps snapshot, and the two will not agree - different scopes,
       * different cut-off times, and the venue's volume is quote-denominated
       * across perps only.
       */
      trades: {
        spot: { ...spot, provenance: 'walked from this account\'s full spot fill history' },
        perps: { ...perps, provenance: 'walked from this account\'s full perps fill history' },
      },
      funding: {
        ...funding,
        provenance:
          'walked from the perps funding log; totals carry the venue\'s own sign, unmodified',
      },
      headline: {
        ...headline,
        provenance: 'mainnet-data.sodex.dev perps PnL overview - PERPS ONLY, daily snapshot',
      },
      spotRealizedPnl: {
        value: null,
        reason:
          'The venue publishes no spot realized PnL (/spot/pnl/overview returns 404). Deriving one '
          + 'would need a FIFO/average-cost reconstruction across several fee and quote coins, which '
          + 'would be our estimate rather than the venue\'s figure - so nothing is shown.',
      },
      sync: {
        running: SCOPE_KINDS.some((k) => sync[k]?.status === 'running'),
        scopes: sync,
        cache: cacheStatus(),
      },
    };
  });
}

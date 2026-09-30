/**
 * The all-time Stats answer, pure: the venue's perps headline and the shape the
 * panel reads. Shared by the server's /api/stats/all-time and the browser, which
 * now reads a wallet's history and headline itself.
 *
 * Two sources with very different provenance, deliberately kept apart all the
 * way to the panel so it can label each one:
 *
 *  - OUR WALK. Fees, funding, trade count and traded notional are aggregated from
 *    the account's full fill and funding history (historySync.ts,
 *    historyStats.ts). Exact, per-coin, and as complete as the walk says it is.
 *
 *  - THE VENUE'S HEADLINE. `mainnet-data.sodex.dev` publishes a precomputed perps
 *    PnL overview. It is fast and it is the venue's own number, but it is
 *    PERPS-ONLY and it is a DAILY SNAPSHOT: the observed `ts_ms` is a UTC midnight
 *    boundary, so it lags live activity by up to a day plus whatever the job
 *    takes. It travels with that timestamp so the panel can say how old it is.
 *
 * There is deliberately NO spot realized-PnL figure: the venue publishes none
 * (`/spot/pnl/overview` 404s), and a FIFO/average-cost reconstruction across
 * several fee and quote coins would be our estimate, not the venue's figure.
 */
import type { FundingStats, TradeStats } from './historyStats.js';
import type { SyncProgress } from './historySync.js';

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

export const EMPTY_HEADLINE = (reason: string): Headline => ({
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

export interface HeadlineIo {
  /**
   * The numeric account id the stats host keys on (the perps state's `aid`).
   * 0 means this wallet has no SoDEX account at all - a real answer, not an error.
   */
  accountId(address: string): Promise<number>;
  /** One data-host GET, resolving with the envelope's `data` (throws on a failed or non-zero answer). */
  dataGet<T>(path: string): Promise<T>;
  now?: () => number;
}

/** The underlying figure only moves once a day, and the panel polls. */
export const HEADLINE_TTL_MS = 60_000;
const HEADLINE_MEMO_MAX = 500;

/** The headline reader, memoised per wallet (bounded). Never throws: a failure lands in `reason`. */
export function headlineReader(io: HeadlineIo, ttlMs = HEADLINE_TTL_MS): (address: string) => Promise<Headline> {
  const now = io.now ?? Date.now;
  const memo = new Map<string, { at: number; value: Headline }>();

  return async (address: string): Promise<Headline> => {
    const key = address.toLowerCase();
    const hit = memo.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;

    let value: Headline;
    try {
      const aid = await io.accountId(address);
      if (!aid) {
        value = EMPTY_HEADLINE('this wallet has no SoDEX account yet');
      } else {
        const overview = await io.dataGet<Record<string, unknown>>(`/api/v1/perps/pnl/overview?account_id=${aid}`);
        // The equity curve is a nicety. Losing it must not lose the headline.
        let curve: Array<{ t: number; pnl: string }> = [];
        try {
          const daily = await io.dataGet<{ items?: Array<Record<string, unknown>> }>(
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

    memo.delete(key);
    memo.set(key, { at: now(), value });
    if (memo.size > HEADLINE_MEMO_MAX) memo.delete(memo.keys().next().value as string);
    return value;
  };
}

// --- the answer ------------------------------------------------------------------

export const STATS_PROVENANCE = {
  spot: "walked from this account's full spot fill history",
  perps: "walked from this account's full perps fill history",
  funding: "walked from the perps funding log; totals carry the venue's own sign, unmodified",
  headline: 'mainnet-data.sodex.dev perps PnL overview - PERPS ONLY, daily snapshot',
} as const;

export const SPOT_REALIZED_PNL_REASON =
  'The venue publishes no spot realized PnL (/spot/pnl/overview returns 404). Deriving one '
  + 'would need a FIFO/average-cost reconstruction across several fee and quote coins, which '
  + "would be our estimate rather than the venue's figure - so nothing is shown.";

export interface HistoryCacheStatus {
  path: string;
  ok: boolean;
  error: string | null;
}

export interface AllTimeStats {
  address: string;
  trades: {
    spot: TradeStats & { provenance: string };
    perps: TradeStats & { provenance: string };
  };
  funding: FundingStats & { provenance: string };
  headline: Headline & { provenance: string };
  spotRealizedPnl: { value: null; reason: string };
  sync: { running: boolean; scopes: Record<string, SyncProgress>; cache: HistoryCacheStatus };
}

/**
 * The answer, labelled at the source. The panel must not merge these: `trades`
 * is our own exhaustive walk, `headline` is the venue's daily perps snapshot,
 * and the two will not agree - different scopes, different cut-off times, and
 * the venue's volume is quote-denominated across perps only.
 */
export function allTimeStatsBody(p: {
  address: string;
  spot: TradeStats;
  perps: TradeStats;
  funding: FundingStats;
  headline: Headline;
  scopes: Record<string, SyncProgress>;
  cache: HistoryCacheStatus;
}): AllTimeStats {
  return {
    address: p.address,
    trades: {
      spot: { ...p.spot, provenance: STATS_PROVENANCE.spot },
      perps: { ...p.perps, provenance: STATS_PROVENANCE.perps },
    },
    funding: { ...p.funding, provenance: STATS_PROVENANCE.funding },
    headline: { ...p.headline, provenance: STATS_PROVENANCE.headline },
    spotRealizedPnl: { value: null, reason: SPOT_REALIZED_PNL_REASON },
    sync: {
      running: Object.values(p.scopes).some((s) => s?.status === 'running'),
      scopes: p.scopes,
      cache: p.cache,
    },
  };
}

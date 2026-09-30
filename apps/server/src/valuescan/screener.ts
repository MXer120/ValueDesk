/**
 * Trader screener behind the search / Cmd+K palette (Home, Traders, Screener
 * tabs) and its Hyperliquid market list (Assets tab).
 *
 *   GET /api/vs/screener
 *     venue            all | sodex | hyperliquid       (routes/valuescan.ts picks the providers)
 *     view             traders (default) | assets       assets = Hyperliquid markets, see screener/assets.ts
 *     preset           all | consistent | high-winrate | whales | low-drawdown | rising | most-active
 *     q                address prefix (with or without 0x), label substring, or a SoDEX account id
 *     minWinRate       percent, 60 = win rate >= 60%
 *     volWindow        1d | 7d | 30d | all   window of the volume filter, column and sort (default 1d)
 *     minVolume        USD, over volWindow
 *     minAccountValue  USD
 *     window           1d | 7d | 30d | all   window of PnL / ROI (default 30d, or the preset's)
 *     minRoi           percent over `window`, 10 = +10% (may be negative)
 *     strategy         comma list: scalper, intraday, swing, position, high-leverage, whale, vault (any matches)
 *     active           1h | 24h | 7d | 30d   last active within
 *     dormant          1 = include accounts known not to have traded in 30 days (hidden by default)
 *     sort             pnl | roi | volume | winRate | accountValue | lastActive  (default: the preset's)
 *     dir              desc (default) | asc
 *     limit, offset    paging, limit 1..500 (default 100)
 *
 *   -> { rows: ScreenerRow[], total, poolSize, enrichedCount, updatedAt, venues, partial?,
 *        preset, sort, dir, window, volWindow }
 *   -> view=assets: { assets: HlAsset[], rows: [], total, updatedAt, venues }
 *
 * Filters on a value the screener does not know yet (win rate, drawdown, last
 * active for a trader not enriched) exclude that trader; see screener/model.ts
 * for every rule, the presets and the strategy classification.
 *
 * WHERE THE NUMBERS COME FROM. The pool is the providers' leaderboards
 * (screener/pool.ts), rebuilt every 2 minutes, served stale while it rebuilds.
 * Win rate, trades, last fill, drawdown and open positions come from
 * provider.trader(), read in the BACKGROUND for the top of each venue's pool
 * (screener/enrich.ts) at a fixed slow pace behind a budget gate. A request
 * never waits for enrichment: it reads the cache and says how much of the pool
 * is enriched (`enrichedCount`). Only the very first request per venue waits,
 * for the first pool build.
 */
import { hlInfo } from './hyperliquid/index.js';
import { backgroundBacklog } from './sodex/data.js';
import { coolingDown } from './sodex/util.js';
import { NotAvailable, type CoreVenue, type TraderRow, type Venue, type VenueProvider } from './types.js';
import { hlAssets } from './screener/assets.js';
import { Enricher, type EnricherOptions } from './screener/enrich.js';
import {
  isDormant,
  parseScreenerQuery,
  screen,
  toScreenerRow,
  type ScreenerResponse,
  type ScreenerRow,
} from './screener/model.js';
import { PoolCache, harvestPool, type VenuePool } from './screener/pool.js';
import { indexPool, winRatesFor } from '../indexer/read.js';
import { CORE_VENUES } from './types.js';

const MIN = 60_000;
const ENRICH_ENABLED = process.env.VALUESCAN_SCREENER_ENRICH !== '0';

/**
 * Pace per venue.
 *
 * Hyperliquid: one profile (~145 weight) every 12 s, and only while the shared
 * weight bucket still holds HL_GATE_WEIGHT - i.e. only with weight nobody else
 * is using. The bucket refills at ~16 weight/s, so an interactive profile or
 * positioning sweep always gets there first.
 *
 * SoDEX: one profile every 30 s, never during the rate-limit cooldown and never
 * while the data host already has background work queued. After a 429/1015 the
 * venue pauses for 5 minutes. Fewer targets than HL: each read is a dozen calls
 * into a Cloudflare zone this IP has been limited on.
 */
const HL_GATE_WEIGHT = Math.min(350, Math.round(hlInfo.budget.capacity * 0.7));

export const ENRICH_CONFIG: Record<CoreVenue, Omit<EnricherOptions, 'fetchProfile' | 'venue'>> = {
  hyperliquid: {
    intervalMs: 12_000,
    ttlMs: 45 * MIN,
    maxAgeMs: 12 * 60 * MIN,
    maxTargets: 150,
    idleStopMs: 20 * MIN,
    pauseMs: 2 * MIN,
    retryBaseMs: 5 * MIN,
    gate: () => hlInfo.budget.available() >= HL_GATE_WEIGHT,
    enabled: ENRICH_ENABLED,
  },
  sodex: {
    intervalMs: 30_000,
    ttlMs: 60 * MIN,
    maxAgeMs: 12 * 60 * MIN,
    maxTargets: 80,
    idleStopMs: 20 * MIN,
    pauseMs: 5 * MIN,
    retryBaseMs: 10 * MIN,
    gate: () => !coolingDown() && backgroundBacklog() < 10,
    enabled: ENRICH_ENABLED,
  },
};

/**
 * The core venues' pools come from their leaderboards; trade.xyz, Lighter and
 * Arcus from the index's own boards (no upstream call, and trade.xyz has no
 * leaderboard at all - asking it one threw "reading 'sort'").
 */
const isCore = (v: Venue): boolean => (CORE_VENUES as readonly Venue[]).includes(v);
const pools = new PoolCache(async (p) => {
  if (isCore(p.venue)) return harvestPool(p);
  const got = indexPool(p.venue);
  if (!got) throw new NotAvailable(`${p.venue}: the index has no boards yet`);
  const t = Date.now();
  return { venue: p.venue, rows: got.rows, updatedAt: got.updatedAt || t, builtAt: t, slices: { ok: 1, asked: 1 } };
});
const enrichers = new Map<Venue, Enricher>();

function enricherFor(p: VenueProvider): Enricher {
  let e = enrichers.get(p.venue);
  if (!e) {
    e = new Enricher({ venue: p.venue, fetchProfile: (a) => p.trader(a), ...ENRICH_CONFIG[p.venue as CoreVenue] });
    enrichers.set(p.venue, e);
  }
  return e;
}

const fin = (v: number | null | undefined): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : Number.NEGATIVE_INFINITY;

/**
 * Who to enrich first: the top of four rankings, taken in turn (30D PnL,
 * account value, 24h volume, 7D PnL), so the traders the palette shows first
 * under any default sort are the ones measured first.
 */
export function enrichTargets(rows: readonly TraderRow[], n: number): string[] {
  const orders = [
    (r: TraderRow) => fin(r.pnl['30d']),
    (r: TraderRow) => fin(r.accountValue),
    (r: TraderRow) => fin(r.volume['1d']),
    (r: TraderRow) => fin(r.pnl['7d']),
  ].map((key) => [...rows].sort((a, b) => key(b) - key(a)));
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; out.length < n && i < rows.length; i++) {
    for (const list of orders) {
      const r = list[i];
      if (r && !seen.has(r.address)) {
        seen.add(r.address);
        out.push(r.address);
        if (out.length >= n) break;
      }
    }
  }
  return out;
}

/** Pool rows of the answering venues as screener rows, with enrichment and cross-venue presence. */
export function assemble(
  venuePools: readonly VenuePool[],
  enrichmentOf: (venue: Venue, address: string) => ReturnType<Enricher['get']>,
  now: number,
): { rows: ScreenerRow[]; enrichedCount: number } {
  const venuesOf = new Map<string, Venue[]>();
  for (const p of venuePools) {
    for (const r of p.rows) venuesOf.set(r.address, [...(venuesOf.get(r.address) ?? []), p.venue]);
  }
  let enrichedCount = 0;
  const rows: ScreenerRow[] = [];
  for (const p of venuePools) {
    for (const r of p.rows) {
      const e = enrichmentOf(p.venue, r.address);
      if (e && !e.missing) enrichedCount++;
      const alsoOn = (venuesOf.get(r.address) ?? []).filter((v) => v !== p.venue);
      rows.push(toScreenerRow({ ...r, venue: p.venue }, e, alsoOn, now));
    }
  }
  return { rows, enrichedCount };
}

export async function buildScreener(
  providers: readonly VenueProvider[],
  query: Record<string, string | undefined>,
): Promise<Record<string, unknown>> {
  const q = parseScreenerQuery(query);

  if (q.view === 'assets') {
    const hl = providers.some((p) => p.venue === 'hyperliquid');
    const assets = hl ? await hlAssets(hlInfo) : [];
    return { assets, rows: [], total: assets.length, updatedAt: Date.now(), venues: hl ? ['hyperliquid'] : [] };
  }

  const got = await Promise.allSettled(providers.map((p) => pools.get(p)));
  const live: VenuePool[] = [];
  const failed: Venue[] = [];
  got.forEach((g, i) => (g.status === 'fulfilled' ? live.push(g.value) : failed.push(providers[i]!.venue)));
  if (!live.length) throw (got[0] as PromiseRejectedResult).reason;

  // Keep each live venue's enricher walking the top of its pool. Never awaited.
  for (const p of providers) {
    const pool = live.find((x) => x.venue === p.venue);
    if (!pool || !isCore(p.venue)) continue;
    const e = enricherFor(p);
    e.demand(enrichTargets(pool.rows, e.o.maxTargets));
  }

  const now = Date.now();
  // The index's win rate over the query's window (valuescan/winRate.ts) outranks
  // a profile's recent sample; rows keep their pool figures otherwise.
  const withIndex = live.map((pool) => {
    const stats = winRatesFor(pool.venue, q.window, pool.rows.map((r) => r.address));
    if (!stats.size) return pool;
    return {
      ...pool,
      rows: pool.rows.map((r) => {
        const st = stats.get(r.address);
        if (!st || st.winRate === null) return r;
        return { ...r, winRate: st.winRate, winRateExact: st.winRateExact, winRateCloses: st.winRateCloses, winRateFrom: st.winRateFrom };
      }),
    };
  });
  const { rows, enrichedCount } = assemble(
    withIndex,
    (venue, address) => enrichers.get(venue)?.get(address),
    now,
  );
  const page = screen(rows, q, now);
  const body: ScreenerResponse = {
    rows: page.rows,
    total: page.total,
    poolSize: rows.length,
    dormant: q.dormant ? 0 : rows.filter(isDormant).length,
    enrichedCount,
    updatedAt: Math.min(...live.map((p) => p.updatedAt)),
    venues: live.map((p) => p.venue),
    partial: failed.length ? failed : undefined,
    preset: q.preset,
    sort: q.sort,
    dir: q.dir,
    window: q.window,
    volWindow: q.volWindow,
  };
  return body as unknown as Record<string, unknown>;
}

/**
 * One SoDEX wallet as a TraderProfile, and its fills.
 *
 * Sources, each labelled by what it is:
 *  - live account state (gateway `/{perps,spot}/accounts/{a}/state`, weight 5
 *    each): open perps positions, spot balances, open orders;
 *  - the venue's portfolio chart per window (data host): PnL, ROI, account
 *    value (vaults included) and the equity curve - the same numbers sodex.com
 *    shows on its portfolio page;
 *  - the leaderboard rank per window (data host, what /api/scan/windows reads):
 *    traded volume and the 30-day PnL rank;
 *  - the last 200 closed perps positions (gateway, weight 30): win rate,
 *    holding-time style, last activity.
 *
 * Deliberately NOT history.ts's full sync: walking a busy account's entire fill
 * history costs thousands of weight units. `fills` reuses its pager
 * (`walkBackwards`) and its row hashing, bounded to the rows asked for.
 */
import { normaliseTrade, walkBackwards, type NormalRow } from '../../history.js';
import { WINDOWS, type TraderProfile, type TraderRow, type VsFill } from '../types.js';
import { lbRank, portfolioChart } from './data.js';
import { rememberChart } from './enrich.js';
import {
  CLOSED_LIMIT,
  closedPositions,
  markPrices,
  perpsState,
  spotState,
  spotTickers,
  tradesPage,
} from './gateway.js';
import {
  CHART_WINDOW,
  LB_WINDOW,
  VAULT_TAG_SHARE,
  chartSuspect,
  chartToEquity,
  closedStats,
  rebaseWindow,
  withoutAccountValue,
  markMap,
  maxDrawdown,
  num,
  returnIndex,
  sharpe,
  spotPrices,
  spotValue,
  statePositions,
  styleTags,
  summariseChart,
  tradeToFill,
  type RawTrade,
} from './mappers.js';
import { seedAddress } from './resolver.js';
import { RateLimitedError, TtlCache, coolingDown, isRateLimit } from './util.js';

export const PROFILE_SOURCE = 'SoDEX account state + portfolio chart';

const profiles = new TtlCache(500);
const fillCache = new TtlCache(500);

const PROFILE_TTL = 30_000;
const FILLS_TTL = 20_000;
/** Fills per engine per request. 5 pages x 70 weight x 2 engines is already 700 of the 1200/min budget. */
export const MAX_FILLS = 5_000;

async function build(address: string): Promise<TraderProfile | null> {
  const [ps, ss] = await Promise.all([perpsState(address), spotState(address).catch(() => null)]);
  const aid = Number(ps?.aid || ss?.aid || 0);
  if (!aid) return null; // no SoDEX account behind this wallet
  seedAddress(aid, address);

  const [marksRaw, tickers, charts, lbRanks, closed] = await Promise.all([
    markPrices().catch(() => []),
    spotTickers().catch(() => []),
    Promise.all(WINDOWS.map((w) => portfolioChart(aid, CHART_WINDOW[w]).catch(() => null))),
    Promise.all(WINDOWS.map((w) => lbRank(LB_WINDOW[w], 'pnl', address).catch(() => null))),
    // History endpoints are the first to be throttled; skip them while backing off.
    coolingDown() ? Promise.resolve(null) : closedPositions(address).catch(() => null),
  ]);

  const marks = markMap(marksRaw);
  const positions = statePositions(ps?.P, marks);
  const spot = spotValue(ss?.B, spotPrices(tickers, marks));
  const perpsAv = num(ps?.av);
  const liveAv = perpsAv !== null ? perpsAv + spot.value : null;
  // The 1Y chart ('all') decides whether this account's analytics can be used at all.
  const yearChart = charts[WINDOWS.indexOf('all')] ?? null;
  const suspect = chartSuspect(yearChart, liveAv);
  const year = chartToEquity(yearChart);
  const now = Date.now();
  const SPAN: Record<string, number> = { '1d': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };

  const pnl: TraderRow['pnl'] = {};
  const roi: TraderRow['roi'] = {};
  const volume: TraderRow['volume'] = {};
  const equity: TraderProfile['equity'] = {};
  let chartAv: number | null = null;
  let spark: number[] | undefined;

  for (const [i, w] of WINDOWS.entries()) {
    const chart = charts[i] ?? null;
    const s = rememberChart(aid, CHART_WINDOW[w], chart);
    const rank = lbRanks[i];
    const item = rank?.found ? rank.item : undefined;
    volume[w] = item ? num(item.volume_usd) : null;
    if (suspect) {
      // Unusable analytics: neither their PnL nor their value is shown as fact.
      pnl[w] = null;
      roi[w] = null;
      if (chart) equity[w] = withoutAccountValue(chartToEquity(chart));
      continue;
    }
    // The venue's own ranking figure first, the one the boards show; the chart's
    // total only when the wallet is not ranked (its 'all' is the 1Y chart).
    pnl[w] = (item ? num(item.pnl_usd) : null) ?? s.pnl;
    roi[w] = s.roi;
    let pts = chart ? chartToEquity(chart) : [];
    // An empty window chart while the 1Y chart has points in that window: the
    // window from the 1Y chart, rebased to 0 at its start (hourly vs daily points).
    if (pts.length < 2 && SPAN[w] !== undefined) {
      const derived = rebaseWindow(year, now - SPAN[w]!);
      if (derived) {
        pts = derived;
        if (pnl[w] === null || (!item && (s.pnl === 0 || s.pnl === null))) pnl[w] = derived[derived.length - 1]!.pnl;
      }
    }
    if (pts.length) equity[w] = pts;
    if (s.accountValue !== null) chartAv = s.accountValue;
    if (w === '30d' && s.spark.length > 1) spark = s.spark;
  }

  /*
   * The chart's latest account value first: it includes vault deposits, which
   * the engines' state does not (a vault depositor worth $1M shows $32 in
   * perps + spot), and it is the number the leaderboard rows and the equity
   * curve use. Live perps + spot at market is the fallback when there is no
   * chart. The chart is hourly, so live positions can have moved since.
   */
  const accountValue = suspect ? liveAv : chartAv ?? liveAv;

  const allChart = charts[WINDOWS.indexOf('all')] ?? null;
  const index = suspect ? [] : returnIndex(allChart);
  const cs = closedStats(closed, CLOSED_LIMIT);
  const tags = styleTags({ accountValue, positions, closed: cs });
  // Same basis as the leaderboard's default window, so a row and its profile agree.
  const vaultShare = summariseChart(charts[WINDOWS.indexOf('30d')] ?? null).vaultShare;
  if (vaultShare !== null && vaultShare >= VAULT_TAG_SHARE) tags.push('vault');
  const lastOpen = Math.max(0, ...(ps?.P ?? []).map((p) => Number(p?.ut) || 0));
  const lastActive = Math.max(lastOpen, cs.lastClosedAt ?? 0) || null;
  const rank30 = lbRanks[WINDOWS.indexOf('30d')];

  const summary: TraderRow = {
    venue: 'sodex',
    address,
    label: null,
    accountId: aid,
    accountValue,
    pnl,
    roi,
    volume,
    winRate: cs.winRate,
    winRateExact: cs.winRateExact,
    winRateCloses: cs.closes,
    winRateFrom: cs.winRateExact ? null : cs.firstClosedAt,
    // The sample is capped; a full sample would only give a lower bound, so it is not reported as a count.
    trades: closed ? (cs.count < CLOSED_LIMIT ? cs.count : null) : null,
    maxDrawdown: maxDrawdown(index),
    sharpe: sharpe(index),
    lastActive,
    spark,
    tags,
    rank: rank30?.found && rank30.item ? rank30.item.rank : undefined,
    rankChange: null,
  };

  return {
    summary,
    positions,
    equity,
    openOrders: (ps?.O?.length ?? 0) + (ss?.O?.length ?? 0),
    updatedAt: Date.now(),
    source: suspect ? `${PROFILE_SOURCE} (analytics incomplete: live equity only)` : PROFILE_SOURCE,
    analyticsSuspect: suspect,
  };
}

export function trader(address: string): Promise<TraderProfile | null> {
  const a = address.toLowerCase();
  return profiles.wrap(a, PROFILE_TTL, () => build(a));
}

/**
 * The newest `limit` fills per engine, walked backwards with history.ts's
 * pager. A page shorter than asked for ends that engine's walk locally; the
 * gateway client already refuses to read an error envelope as a short page.
 */
async function walkEngine(
  engine: 'perps' | 'spot',
  address: string,
  o: { from?: number; to?: number },
  limit: number,
): Promise<VsFill[]> {
  const pageSize = Math.min(1_000, limit);
  const raws = new Map<string, RawTrade>();
  let exhausted = false;
  const res = await walkBackwards(
    async (q) => {
      if (exhausted) return [];
      const page = await tradesPage(engine, address, q);
      if (page.length < q.limit) exhausted = true;
      return page.map((t) => {
        const row: NormalRow = normaliseTrade(t as Record<string, unknown>);
        raws.set(row.id, t);
        return row;
      });
    },
    { startTime: o.from, endTime: o.to, limit: pageSize, maxPages: Math.ceil(limit / pageSize) },
  );
  const out: VsFill[] = [];
  for (const row of res.rows) {
    const f = tradeToFill(engine, raws.get(row.id) ?? {}, row.id);
    if (f && (o.from === undefined || f.time >= o.from) && (o.to === undefined || f.time <= o.to)) out.push(f);
  }
  return out;
}

export function fills(address: string, o: { from?: number; to?: number; limit?: number }): Promise<VsFill[]> {
  const a = address.toLowerCase();
  const limit = Math.min(MAX_FILLS, Math.max(1, Math.floor(o.limit ?? 500)));
  const key = `${a}|${o.from ?? ''}|${o.to ?? ''}|${limit}`;
  return fillCache.wrap(key, FILLS_TTL, async () => {
    // Both engines or nothing: a list silently missing its spot half would read as complete.
    if (coolingDown()) throw new RateLimitedError('fill history');
    try {
      const [perps, spot] = await Promise.all([
        walkEngine('perps', a, o, limit),
        walkEngine('spot', a, o, limit),
      ]);
      return [...perps, ...spot].sort((x, y) => y.time - x.time).slice(0, limit);
    } catch (e) {
      if (isRateLimit(e)) throw new RateLimitedError('fill history');
      throw e;
    }
  });
}

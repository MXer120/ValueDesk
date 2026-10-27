/**
 * Per-account figures the leaderboard does not carry: ROI, account value and a
 * PnL sparkline, all taken from the venue's own portfolio chart
 * (`/api/v1/wallet/portfolio/chart`). One chart call per (account, window),
 * kept for 10 minutes and shared by the leaderboard, Explore and the trader
 * profile, so the same wallet is never fetched twice for two pages.
 *
 * Background enrichment is deliberately a trickle: low priority behind every
 * foreground call, capped backlog, and paused while the rate-limit cooldown is
 * set.
 */
import type { TraderRow, Window } from '../types.js';
import { backgroundBacklog, portfolioChart, type Priority } from './data.js';
import {
  CHART_WINDOW,
  VAULT_TAG_SHARE,
  summariseChart,
  type ChartSummary,
  type ChartWindow,
  type PortfolioChart,
} from './mappers.js';
import { TtlCache, coolingDown } from './util.js';

const ENRICH_TTL = 10 * 60_000;
const MAX_BACKLOG = 150;

const store = new TtlCache(20_000);
const keyOf = (accountId: number, w: ChartWindow): string => `${accountId}|${w}`;

export const cachedSummary = (accountId: number, w: ChartWindow): ChartSummary | undefined =>
  store.get<ChartSummary>(keyOf(accountId, w), ENRICH_TTL);

/** Store a summary computed elsewhere (the trader profile already has the chart). */
export function rememberChart(accountId: number, w: ChartWindow, chart: PortfolioChart | null): ChartSummary {
  const s = summariseChart(chart);
  if (chart) store.set(keyOf(accountId, w), s);
  return s;
}

/** Summary for one account/window; null when the chart could not be read. */
export async function summaryFor(accountId: number, w: ChartWindow, priority: Priority): Promise<ChartSummary | null> {
  const key = keyOf(accountId, w);
  const hit = store.get<ChartSummary>(key, ENRICH_TTL);
  if (hit) return hit;
  if (priority === 'low' && coolingDown()) return null;
  return store
    .refresh(key, async () => summariseChart(await portfolioChart(accountId, w, priority)))
    .catch(() => null);
}

/** The freshest account value any cached chart knows for this account. */
export function latestAccountValue(accountId: number): number | null {
  let best: ChartSummary | undefined;
  for (const w of ['24H', '7D', '30D', '90D', '1Y'] as ChartWindow[]) {
    const s = cachedSummary(accountId, w);
    if (s && s.accountValue !== null && (!best || (s.asOf ?? 0) > (best.asOf ?? 0))) best = s;
  }
  return best?.accountValue ?? null;
}

/** Fill roi / accountValue / spark on a row from whatever is cached. Mutates and returns the row. */
export function decorate(row: TraderRow, window: Window): TraderRow {
  if (row.accountId == null) return row;
  const s = cachedSummary(row.accountId, CHART_WINDOW[window]);
  if (s) {
    row.roi = { ...row.roi, [window]: s.roi };
    if (s.spark.length > 1) row.spark = s.spark;
    if (s.vaultShare !== null && s.vaultShare >= VAULT_TAG_SHARE && !row.tags?.includes('vault')) {
      row.tags = [...(row.tags ?? []), 'vault'];
    }
  }
  const av = latestAccountValue(row.accountId);
  if (av !== null) row.accountValue = av;
  return row;
}

/** Fetch summaries for rows, foreground. Resolves when all are in (or failed). */
export function enrichNow(rows: TraderRow[], window: Window): Promise<unknown> {
  const w = CHART_WINDOW[window];
  return Promise.all(rows.map((r) => (r.accountId != null ? summaryFor(r.accountId, w, 'high') : null)));
}

/** Queue summaries for rows in the background, if the backlog has room. */
export function enrichLater(rows: TraderRow[], window: Window): void {
  if (coolingDown()) return;
  const w = CHART_WINDOW[window];
  for (const r of rows) {
    if (backgroundBacklog() >= MAX_BACKLOG) return;
    if (r.accountId == null || cachedSummary(r.accountId, w)) continue;
    void summaryFor(r.accountId, w, 'low');
  }
}

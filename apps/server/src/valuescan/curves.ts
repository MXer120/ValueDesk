/**
 * Podium curves for the leaderboard page.
 *
 * The public rank list (PnL, volume, address) is enough to paint the table.
 * A sparkline and, on SoDEX, account value come from a per-wallet chart.
 * Fetching that for the whole hundred holds the page and spends the rate
 * budget. This fills the three podium cards only, and remembers the result
 * so the next plain leaderboard read can paint those three without waiting.
 */
import type { TraderRow, Window } from './types.js';
import { hlInfo } from './hyperliquid/index.js';
import { mapPortfolio } from './hyperliquid/mappers.js';
import type { HlPortfolio } from './hyperliquid/raw.js';
import { decorate, enrichNow } from './sodex/enrich.js';
import { within } from './sodex/util.js';
import { arcusPortfolio } from './extra/arcus.js';
import { lighterAccounts, lighterPnlSeries } from './extra/lighter.js';

const TTL = 10 * 60_000;
const CURVE_BUDGET_MS = 8_000;

interface CachedCurve {
  at: number;
  spark?: number[];
  accountValue?: number | null;
}

const cache = new Map<string, CachedCurve>();

const keyOf = (row: TraderRow, window: Window): string =>
  `${window}|${row.venues && row.venues.length > 1 ? row.venues.join('+') : row.venue}|${row.address}`;

function take(values: number[], max: number): number[] {
  if (values.length <= max || max < 2) return values.slice();
  const out: number[] = [];
  const step = (values.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(values[Math.round(i * step)]!);
  return out;
}

function remember(row: TraderRow, window: Window): void {
  if ((row.spark?.length ?? 0) < 2 && row.accountValue == null) return;
  cache.set(keyOf(row, window), {
    at: Date.now(),
    spark: row.spark && row.spark.length > 1 ? row.spark : undefined,
    accountValue: row.accountValue,
  });
}

/** Copy any curve already fetched onto these rows. No I/O. */
export function applyCachedCurves(rows: TraderRow[], window: Window): void {
  const now = Date.now();
  for (const row of rows) {
    const hit = cache.get(keyOf(row, window));
    if (!hit || now - hit.at > TTL) continue;
    if (hit.spark && hit.spark.length > 1) row.spark = hit.spark;
    if (row.accountValue == null && hit.accountValue != null) row.accountValue = hit.accountValue;
  }
}

/** `values` resampled to `n` points by position (each venue's series spans the same window). */
function resample(values: number[], n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = (i * (values.length - 1)) / (n - 1);
    const lo = Math.floor(x);
    const hi = Math.min(values.length - 1, lo + 1);
    out.push(values[lo]! + (values[hi]! - values[lo]!) * (x - lo));
  }
  return out;
}

/**
 * A netted row's curve: each venue's PnL curve over the window, rebased to its
 * start and summed point by point. Hyperliquid's own curve already holds its
 * xyz dex, so trade.xyz is not added on top of it.
 */
async function fillNet(row: TraderRow, window: Window): Promise<void> {
  if ((row.spark?.length ?? 0) > 1) return;
  const venues = (row.venues ?? []).filter((v) => !(v === 'tradexyz' && row.venues!.includes('hyperliquid')));
  const sparks = await Promise.all(venues.map(async (venue) => {
    const one: TraderRow = { ...row, venue, venues: undefined, spark: undefined, accountValue: null };
    if (venue === 'sodex' && row.accountId == null) return null;
    await fillOne(one, window).catch(() => undefined);
    return one.spark && one.spark.length > 1 ? one.spark : null;
  }));
  const got = sparks.filter((s): s is number[] => !!s);
  if (!got.length) return;
  const N = 48;
  const sum = new Array<number>(N).fill(0);
  for (const s of got) {
    const r = resample(s, N);
    for (let i = 0; i < N; i++) sum[i]! += r[i]! - r[0]!;
  }
  row.spark = sum;
  remember(row, window);
}

async function fillOne(row: TraderRow, window: Window): Promise<void> {
  if (row.venues && row.venues.length > 1) return fillNet(row, window);
  if ((row.spark?.length ?? 0) > 1 && row.accountValue != null) {
    remember(row, window);
    return;
  }
  if (row.venue === 'sodex') {
    if (row.accountId == null) return;
    await enrichNow([row], window);
    decorate(row, window);
  } else if (row.venue === 'arcus') {
    // Arcus's own portfolio series (its PnL, rebased to the window start).
    const p = await arcusPortfolio(row.address);
    const spark = take((p.equity[window] ?? []).flatMap((pt) => (pt.pnl == null ? [] : [pt.pnl])), 48);
    if (spark.length > 1) row.spark = spark;
    if (row.accountValue == null && p.accountValue != null) row.accountValue = p.accountValue;
  } else if (row.venue === 'lighter') {
    const idx = await lighterAccounts(row.address);
    if (!idx.length) return;
    const spark = take((await lighterPnlSeries(idx[0]!, window)).map((p) => p.pnl), 48);
    if (spark.length > 1) row.spark = spark;
  } else if (row.venue !== 'hyperliquid') {
    // trade.xyz publishes no per-venue curve: none is drawn rather than another venue's.
    return;
  } else {
    const portfolio = await hlInfo.post<HlPortfolio>(
      { type: 'portfolio', user: row.address },
      { ttlMs: TTL },
    );
    const series = mapPortfolio(portfolio)[window] ?? [];
    const spark = take(series.flatMap((p) => (p.pnl == null ? [] : [p.pnl])), 48);
    if (spark.length > 1) row.spark = spark;
    const av = series[series.length - 1]?.accountValue ?? null;
    if (row.accountValue == null && av != null) row.accountValue = av;
  }
  remember(row, window);
}

/** Fill sparks (and missing account values) for the first three rows. */
export function attachPodiumCurves(rows: TraderRow[], window: Window): Promise<void> {
  const job = Promise.all(rows.slice(0, 3).map((row) => fillOne(row, window).catch(() => undefined))).then(() => undefined);
  return within(job, CURVE_BUDGET_MS, undefined);
}

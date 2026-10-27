/**
 * SoDEX's official leaderboard (mainnet-data.sodex.dev, ~134k ranked wallets,
 * hourly snapshot) as ValueDesk TraderRows.
 *
 * What the venue ranks by: PnL and volume, per window (24H / 7D / 30D /
 * ALL_TIME). Those two sorts are served page for page from upstream.
 *
 * What it does not rank by: ROI and account value (`sort_by=roi` is HTTP 400).
 * Those sorts rank a candidate pool instead - the window's top 50 by PnL for
 * ROI, the top 50 by PnL plus the top 50 by volume for account value - using
 * each account's portfolio chart. The response's `source` says so, and `total`
 * is the pool size, not 134k. A ranked pool is kept 5 minutes and then served
 * stale while it is rebuilt in the background, so only the very first request
 * per window waits for the charts.
 *
 * ROI ranking puts two kinds of account last, because their venue ROI is true
 * and useless for choosing someone to copy: accounts worth under $1,000 now (a
 * wallet that made $3k and withdrew to $21 shows 3,300 %), and accounts whose
 * ROI is measured against under $1,000 of capital (PnL / ROI; one that started
 * with $10 and topped up later shows 35,000 %).
 */
import type { LeaderboardPage, LeaderboardQuery, TraderRow, Window } from '../types.js';
import { LB_PAGE_SIZE, lbPage, lbRank } from './data.js';
import { cachedSummary, decorate, enrichLater, enrichNow } from './enrich.js';
import {
  ADDRESS_RE,
  CHART_WINDOW,
  LB_WINDOW,
  RankHistory,
  lbItemToRow,
  matchesQuery,
  pagesFor,
  type LbItem,
  type LbPage,
} from './mappers.js';
import { knownAddress, resolveIds, seedAddress } from './resolver.js';
import { TtlCache, within } from './util.js';

export const SOURCE = 'SoDEX leaderboard';

/** 10 pages = 500 rows, the route's own maximum page. */
const MAX_PAGES = 10;
/** Rows enriched before answering, and how long that may take. */
const FOREGROUND_ENRICH = 25;
/** Rows after those that are enriched in the background (one upstream page). */
const BACKGROUND_ENRICH_TO = LB_PAGE_SIZE;
const FOREGROUND_ENRICH_MS = 2_000;
/** A pool ranking waits this long for its charts on a cold cache. */
const POOL_ENRICH_MS = 12_000;
/** Prefix search looks through this many top rows of the window. */
const SEARCH_PAGES = 10;
/** Ranked pools are rebuilt after this long (served stale meanwhile). */
const POOL_TTL = 5 * 60_000;
/** Below this account value, or this much capital behind the ROI, an ROI is ranked last. */
export const ROI_MIN_ACCOUNT_USD = 1_000;

const pools = new TtlCache(16);

const ranks = new RankHistory();

/** One item as a row; also teaches the resolver its id and the rank history its place. */
function itemRow(it: LbItem, page: LbPage, window: Window, board: string | null): TraderRow | null {
  const r = lbItemToRow(it, window);
  if (!r) return null;
  seedAddress(it.account_id, r.address);
  if (board && typeof it.rank === 'number') r.rankChange = ranks.observe(board, page.snapshot_ts, r.address, it.rank);
  return r;
}

function rowsOf(page: LbPage, window: Window, board: string | null): TraderRow[] {
  return (page.items ?? []).flatMap((it) => itemRow(it, page, window, board) ?? []);
}

const valueFor = (r: TraderRow, sort: LeaderboardQuery['sort'], w: Window): number => {
  const v =
    sort === 'accountValue' ? r.accountValue : sort === 'roi' ? r.roi[w] : sort === 'volume' ? r.volume[w] : r.pnl[w];
  return typeof v === 'number' && Number.isFinite(v) ? v : Number.NEGATIVE_INFINITY;
};

/** Whether an ROI is worth ranking: enough account now, and enough capital behind it. */
function roiRankable(r: TraderRow, w: Window): boolean {
  if ((r.accountValue ?? 0) < ROI_MIN_ACCOUNT_USD) return false;
  const s = r.accountId != null ? cachedSummary(r.accountId, CHART_WINDOW[w]) : undefined;
  if (!s || s.pnl === null || s.roi === null || s.roi === 0) return true;
  return Math.abs(s.pnl / s.roi) >= ROI_MIN_ACCOUNT_USD;
}

/** Sort comparator; ROI ranks the accounts `roiRankable` rejects after all others. */
function compare(sort: LeaderboardQuery['sort'], w: Window) {
  return (a: TraderRow, b: TraderRow): number => {
    if (sort === 'roi') {
      const d = (roiRankable(a, w) ? 0 : 1) - (roiRankable(b, w) ? 0 : 1);
      if (d !== 0) return d;
    }
    return valueFor(b, sort, w) - valueFor(a, sort, w);
  };
}

/** pnl / volume: straight from upstream pages. */
async function ranked(q: LeaderboardQuery): Promise<LeaderboardPage> {
  const lw = LB_WINDOW[q.window];
  // Worst is the low end of the PnL list. SoDEX only publishes its top 1,000,
  // and ascending order is that list reversed, not the bottom of ~134k wallets.
  const worst = q.side === 'worst';
  const sortBy = worst ? 'pnl' : q.sort === 'volume' ? 'volume' : 'pnl';
  const board = `${lw}|${sortBy}|${worst ? 'asc' : 'desc'}`;
  const pages = pagesFor(q.offset, q.limit, LB_PAGE_SIZE).slice(0, MAX_PAGES);
  const got = await Promise.all(pages.map((p) => lbPage(lw, sortBy, p, 'high', worst ? 'asc' : 'desc')));

  const rows: TraderRow[] = [];
  got.forEach((pg, i) => {
    const base = (pages[i]! - 1) * LB_PAGE_SIZE;
    (pg.items ?? []).forEach((it, j) => {
      const idx = base + j;
      if (idx < q.offset || idx >= q.offset + q.limit) return;
      const r = itemRow(it, pg, q.window, board);
      if (r) rows.push(r);
    });
  });

  // The PnL hundred is the public page. Answer with the list. A chart for
  // every row would hold the response and crowd the data host; the page asks
  // for the three podium curves on a follow-up. Anything already cached
  // (a previous podium read) is painted now.
  if (q.side === 'worst' || (q.sort === 'pnl' && q.limit <= 100)) {
    for (const r of rows) decorate(r, q.window);
  } else {
    await within(enrichNow(rows.slice(0, FOREGROUND_ENRICH), q.window), FOREGROUND_ENRICH_MS, undefined);
    enrichLater(rows.slice(FOREGROUND_ENRICH, BACKGROUND_ENRICH_TO), q.window);
    for (const r of rows) decorate(r, q.window);
  }

  const first = got[0];
  return {
    rows,
    total: worst ? Math.min(100, first?.total ?? rows.length) : (first?.total ?? rows.length),
    updatedAt: first?.snapshot_ts ?? Date.now(),
    source: worst ? `${SOURCE} (lowest PnL in the published top 1,000)` : SOURCE,
  };
}

interface Pool {
  rows: TraderRow[];
  updatedAt: number;
  source: string;
  /** False when some charts missed the deadline; such a pool is rebuilt sooner. */
  complete: boolean;
}

/** An incomplete pool (cold cache, slow host) is retried after this long instead of POOL_TTL. */
const PARTIAL_POOL_TTL = 15_000;

/** roi / accountValue: rank a candidate pool by the chart figures. */
async function buildPool(window: Window, sort: 'roi' | 'accountValue'): Promise<Pool> {
  const lw = LB_WINDOW[window];
  const sources = sort === 'roi' ? [lbPage(lw, 'pnl', 1)] : [lbPage(lw, 'pnl', 1), lbPage(lw, 'volume', 1)];
  const pages = await Promise.all(sources);

  const byAddress = new Map<string, TraderRow>();
  for (const pg of pages) for (const r of rowsOf(pg, window, null)) if (!byAddress.has(r.address)) byAddress.set(r.address, r);
  const rows = [...byAddress.values()];

  const done = await within(enrichNow(rows, window).then(() => true), POOL_ENRICH_MS, false);
  for (const r of rows) decorate(r, window);
  rows.sort(compare(sort, window));

  const basis = sort === 'roi' ? `top ${rows.length} by PnL` : `top PnL + volume (${rows.length})`;
  return {
    rows,
    updatedAt: pages[0]?.snapshot_ts ?? Date.now(),
    source: `${SOURCE}, ${basis} ranked by ${sort === 'roi' ? 'ROI' : 'account value'}`,
    complete: done,
  };
}

async function pooled(q: LeaderboardQuery): Promise<LeaderboardPage> {
  const sort = q.sort === 'roi' ? 'roi' : 'accountValue';
  const key = `${q.window}|${sort}`;
  const hit = pools.stale<Pool>(key);
  let pool: Pool;
  if (hit) {
    pool = hit.value;
    const ttl = hit.value.complete ? POOL_TTL : PARTIAL_POOL_TTL;
    if (Date.now() - hit.at > ttl && !pools.isRunning(key)) {
      void pools.refresh(key, () => buildPool(q.window, sort)).catch(() => {});
    }
  } else {
    pool = await pools.refresh(key, () => buildPool(q.window, sort));
  }
  const rows = pool.rows
    .slice(q.offset, q.offset + q.limit)
    .map((r, i) => ({ ...r, rank: q.offset + i + 1, rankChange: null }));
  return { rows, total: pool.rows.length, updatedAt: pool.updatedAt, source: pool.source };
}

/** The one row a full address has on this board, or null when it is not ranked. */
async function rankedRow(lw: ReturnType<typeof lbWindow>, sortBy: 'pnl' | 'volume', address: string, window: Window) {
  const r = await lbRank(lw, sortBy, address);
  const row = r.found && r.item ? lbItemToRow(r.item, window) : null;
  if (row) seedAddress(r.item!.account_id, row.address);
  return { row, snapshot: r.snapshot_ts };
}

const lbWindow = (w: Window) => LB_WINDOW[w];

/**
 * Search. A full address is looked up directly (any of the ~134k wallets);
 * anything else filters the window's top 500 by address prefix or label. A
 * number is also tried as a SoDEX account id and, if it resolves, that
 * wallet's row comes first.
 */
async function search(q: LeaderboardQuery, text: string): Promise<LeaderboardPage> {
  const lw = lbWindow(q.window);
  const sortBy = q.sort === 'volume' ? 'volume' : 'pnl';
  const s = text.trim().toLowerCase();

  let rows: TraderRow[] = [];
  let updatedAt = Date.now();
  if (ADDRESS_RE.test(s)) {
    const { row, snapshot } = await rankedRow(lw, sortBy, s, q.window);
    updatedAt = snapshot || updatedAt;
    if (row) rows = [row];
  } else {
    const byId = /^\d+$/.test(s)
      ? (async () => {
          const id = Number(s);
          const address = knownAddress(id) ?? (await resolveIds([id], 4_000)).get(id);
          return address ? (await rankedRow(lw, sortBy, address, q.window).catch(() => null))?.row ?? null : null;
        })()
      : Promise.resolve(null);
    const [pages, idRow] = await Promise.all([
      Promise.all(Array.from({ length: SEARCH_PAGES }, (_, i) => lbPage(lw, sortBy, i + 1).catch(() => null))),
      byId,
    ]);
    const ok = pages.filter((p): p is LbPage => p !== null);
    if (!ok.length && !idRow) throw new Error('SoDEX leaderboard is unreachable');
    updatedAt = ok[0]?.snapshot_ts || updatedAt;
    rows = ok.flatMap((p) => rowsOf(p, q.window, null)).filter((r) => matchesQuery(r, s));
    if (idRow) rows = [idRow, ...rows.filter((r) => r.address !== idRow.address)];
  }

  await within(enrichNow(rows.slice(0, FOREGROUND_ENRICH), q.window), FOREGROUND_ENRICH_MS, undefined);
  for (const r of rows) decorate(r, q.window);
  if (q.sort === 'roi' || q.sort === 'accountValue') rows.sort(compare(q.sort, q.window));
  return {
    rows: rows.slice(q.offset, q.offset + q.limit),
    total: rows.length,
    updatedAt,
    source: SOURCE,
  };
}

export async function leaderboard(q: LeaderboardQuery): Promise<LeaderboardPage> {
  const text = q.q?.trim();
  if (text) return search(q, text);
  if (q.sort === 'pnl' || q.sort === 'volume') return ranked(q);
  return pooled(q);
}

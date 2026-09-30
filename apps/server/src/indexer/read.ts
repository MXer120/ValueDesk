/**
 * What the API reads from the index: finished boards and per-trader stats.
 *
 * Opens the same file the indexer writes (another thread or process) and
 * never writes to it beyond the idempotent schema check. A missing file or
 * a board not built yet reads as `null`, and the route says "indexing".
 */
import { existsSync } from 'node:fs';
import type { BoardWindow, TraderRow, Venue } from '../valuescan/types.js';
import { VENUES } from '../valuescan/types.js';
import { mergeBoards } from './boards.js';
import type { NetRow } from './store.js';
import { IndexStore, defaultDbPath, type BoardRow, type HistoryKind } from './store.js';
import { BOARD_SIZE, MIN_TRADES, windowStart, type BoardFilter, type Side } from './windows.js';
import {
  COHORT_BY_ID, TAIL_EQUITY, aggregate, cohortsOf, everyWallet, filterKey, longShare, scopeKey, scopeWallets, walletRow,
  type CohortStat,
  type CohortFocusResponse, type CohortMapResponse, type MapSector,
  type CohortDetailResponse, type CohortFilter, type CohortId, type CohortPoint, type CohortRange, type CohortWalletRow,
  type CohortWalletsResponse, type CohortsResponse, type NettedWallet, type Sector, type VenueCoverage, type WalletSort, type WalletVenue,
} from '../valuescan/cohorts/model.js';
import { TAIL_RATE } from './cohortTracker.js';
import { labelMatches, shownLabel } from '../valuescan/labels.js';
import { winRateOf } from '../valuescan/winRate.js';
import { sampledVenue, COHORT_RANGES, type CohortWalletRow as WalletRow } from '../valuescan/cohorts/model.js';

let store: IndexStore | null = null;
let triedAt = 0;

function reader(): IndexStore | null {
  if (store) return store;
  if (Date.now() - triedAt < 10_000) return null;
  triedAt = Date.now();
  const path = defaultDbPath();
  if (!existsSync(path)) return null;
  try {
    store = new IndexStore(path);
  } catch {
    store = null;
  }
  return store;
}

export interface IndexState {
  /** Every board behind this page is final (no unchecked wallet outranks a pick). */
  complete: boolean;
  /** Wallets still waiting for a trade check. */
  pending: number;
  /** When the board was last rebuilt. */
  updatedAt: number;
  /** When the ranks `rankChange` compares against were taken (null = no snapshot old enough yet). */
  rankSince?: number | null;
}

export interface BoardPage {
  rows: TraderRow[];
  total: number;
  updatedAt: number;
  source: string;
  index: IndexState;
}

function toRow(r: BoardRow, window: BoardWindow, rank: number): TraderRow {
  return {
    venue: r.venue,
    address: r.address,
    label: shownLabel(r.address, r.label),
    accountId: r.accountId,
    accountValue: r.accountValue,
    pnl: { [window]: r.pnl },
    roi: {},
    volume: { [window]: r.volume },
    winRate: r.winRate,
    winRateExact: r.winRate === null ? undefined : !!r.winExact,
    winRateCloses: r.winCloses ?? null,
    winRateFrom: r.winFrom ?? null,
    trades: r.trades,
    tradesCapped: r.tradesCapped,
    assets: r.assets,
    rank,
    // Movement on THIS board; a merged multi-venue page has no single previous board.
    rankChange: r.rankChange ?? null,
  };
}

const WINDOW_WORD: Record<BoardWindow, string> = {
  '1d': '24 hours', '7d': '7 days', '30d': '30 days', '90d': '90 days', ytd: 'year to date', all: 'all time',
};

/** One page of a board; `venue: 'all'` merges both venues' hundreds into one. */
export function boardPage(
  venue: Venue | 'all' | readonly Venue[],
  window: BoardWindow,
  side: Side,
  filter: BoardFilter,
  o: { limit: number; offset: number; q?: string },
): BoardPage | null {
  const s = reader();
  if (!s) return null;
  const venues: readonly Venue[] = venue === 'all' ? VENUES : typeof venue === 'string' ? [venue] : venue;
  let boards;
  try {
    boards = venues.map((v) => s.readBoard(v, window, side, filter)).filter((b) => b !== null);
  } catch {
    return null;
  }
  if (!boards.length) return null;
  let rows = boards.length === 1 ? boards[0]!.rows : mergeBoards(boards.map((b) => b.rows), side);
  if (boards.length > 1) rows = rows.map((r) => ({ ...r, rankChange: null }));
  const q = o.q?.trim().toLowerCase();
  if (q) rows = rows.filter((r) => r.address.includes(q) || labelMatches(r.address, r.label, q));
  const which = side === 'worst' ? 'Lowest' : 'Highest';
  const who = filter === 'active' ? 'traders with more than one trade' : 'traders';
  const what = venues.length === 1 && venues[0] === 'tradexyz' ? 'realised PnL (closed trades, net of fees)' : 'PnL';
  return {
    rows: rows.slice(o.offset, o.offset + o.limit).map((r, i) => toRow(r, window, o.offset + i + 1)),
    total: rows.length,
    updatedAt: Math.max(...boards.map((b) => b.meta.sourceAt || b.meta.updatedAt)),
    source: `ValueScan index. ${which} ${what} over ${WINDOW_WORD[window]} among ${who} in that window.`,
    index: {
      complete: boards.every((b) => b.meta.complete) && boards.length === venues.length,
      pending: boards.reduce((n, b) => n + b.meta.pending, 0),
      updatedAt: Math.min(...boards.map((b) => b.meta.updatedAt)),
      rankSince: boards.length === 1 ? boards[0]!.meta.rankSince ?? null : null,
    },
  };
}

const VENUE_WORD: Record<Venue, string> = { sodex: 'SoDEX', hyperliquid: 'Hyperliquid', tradexyz: 'trade.xyz', lighter: 'Lighter', arcus: 'Arcus' };

function netToRow(r: NetRow, window: BoardWindow, rank: number): TraderRow {
  const wr = winRateOf(r.wins, r.closes, r.winExact);
  return {
    venue: r.venues[0]!,
    venues: r.venues,
    address: r.address,
    label: shownLabel(r.address, r.label),
    accountId: r.accountId ?? undefined,
    accountValue: r.accountValue,
    pnl: { [window]: r.pnl },
    roi: {},
    volume: { [window]: r.volume },
    winRate: wr.winRate,
    winRateExact: wr.winRate === null ? undefined : wr.winRateExact,
    winRateCloses: wr.winRateCloses,
    trades: r.trades,
    tradesCapped: !r.exact,
    assets: r.assets.slice(0, 3),
    rank,
    rankChange: null,
  };
}

/**
 * The netted ranking: every address's PnL, volume and trades summed over the
 * selected venues, then ranked. With the trade filter an address needs more
 * than one trade across those venues; one whose count is not final yet is
 * left out and counted as pending.
 */
export function netPage(
  venues: readonly Venue[],
  window: BoardWindow,
  side: Side,
  filter: BoardFilter,
  o: { limit: number; offset: number; q?: string },
): BoardPage | null {
  const s = reader();
  if (!s) return null;
  let rows: NetRow[];
  // Hyperliquid's own figures already include its xyz dex: netting both would count xyz twice.
  const set = venues.includes('hyperliquid') ? venues.filter((v) => v !== 'tradexyz') : venues;
  try {
    rows = s.netCandidates(set, window, side);
  } catch {
    return null;
  }
  if (!rows.length) return null;
  rows.sort((a, b) => (side === 'worst' ? a.pnl - b.pnl : b.pnl - a.pnl));
  const picked: NetRow[] = [];
  let pending = 0;
  for (const r of rows) {
    if (picked.length >= BOARD_SIZE) break;
    if (side === 'top' ? r.pnl <= 0 : r.pnl >= 0) break;
    if (filter === 'active') {
      if ((r.trades ?? 0) < MIN_TRADES) {
        if (!r.exact) pending++;
        continue;
      }
    }
    picked.push(r);
  }
  const q = o.q?.trim().toLowerCase();
  const shown = q ? picked.filter((r) => r.address.includes(q) || labelMatches(r.address, r.label, q)) : picked;
  const metas = venues.map((v) => s.readBoard(v, window, side, filter)?.meta).filter((m) => !!m);
  const which = side === 'worst' ? 'Lowest' : 'Highest';
  const who = filter === 'active' ? ', among traders with more than one trade in that window' : '';
  return {
    rows: shown.slice(o.offset, o.offset + o.limit).map((r, i) => netToRow(r, window, o.offset + i + 1)),
    total: shown.length,
    updatedAt: Math.max(0, ...metas.map((m) => m.sourceAt || m.updatedAt)),
    source: `ValueScan index. ${which} PnL over ${WINDOW_WORD[window]}, netted per address across ${venues.map((v) => VENUE_WORD[v]).join(' + ')}${who}.`,
    index: {
      complete: pending === 0 && metas.length === venues.length && metas.every((m) => m.complete),
      pending,
      updatedAt: Math.min(...metas.map((m) => m.updatedAt), Date.now()),
    },
  };
}

/**
 * Trades, win rate and most-traded assets for rows that came from a venue
 * list (other sorts, searches), for traders the index holds.
 */
export function attachStats(rows: TraderRow[], window: BoardWindow): void {
  const s = reader();
  if (!s) return;
  try {
    const byVenue = new Map<Venue, TraderRow[]>();
    for (const row of rows.slice(0, 500)) byVenue.set(row.venue, [...(byVenue.get(row.venue) ?? []), row]);
    for (const [venue, list] of byVenue) {
      const stats = s.traderStats(venue, window, list.map((r) => r.address));
      for (const row of list) {
        const st = stats.get(row.address);
        if (!st) continue;
        if (st.trades !== null) {
          row.trades = st.trades;
          row.tradesCapped = !st.tradesExact;
        }
        const wr = winRateOf(st.wins, st.closes, st.winExact);
        row.winRate = wr.winRate;
        row.winRateExact = wr.winRateExact;
        row.winRateCloses = wr.winRateCloses;
        row.winRateFrom = wr.winRate !== null && !wr.winRateExact ? st.winFrom : null;
      }
    }
  } catch { /* stats are decoration; the rows stand without them */ }
}

/**
 * The index's win rate for these addresses on one venue and window, by the
 * shared definition (valuescan/winRate.ts). Missing = not indexed.
 */
export function winRatesFor(venue: Venue, window: BoardWindow, addresses: readonly string[]): Map<string, { winRate: number | null; winRateExact: boolean; winRateCloses: number | null; winRateFrom: number | null; trades: number | null; tradesExact: boolean }> {
  const out = new Map<string, { winRate: number | null; winRateExact: boolean; winRateCloses: number | null; winRateFrom: number | null; trades: number | null; tradesExact: boolean }>();
  const s = reader();
  if (!s) return out;
  try {
    for (const [a, st] of s.traderStats(venue, window, addresses)) {
      const wr = winRateOf(st.wins, st.closes, st.winExact);
      out.set(a, { ...wr, winRateFrom: wr.winRate !== null && !wr.winRateExact ? st.winFrom : null, trades: st.trades, tradesExact: st.tradesExact });
    }
  } catch { /* none */ }
  return out;
}

/**
 * A venue's pool for the screener from the index's own boards (trade.xyz,
 * Lighter, Arcus): every board row of the published windows, both sides,
 * merged per address with each window's PnL. No upstream call.
 */
export function indexPool(venue: Venue): { rows: TraderRow[]; updatedAt: number } | null {
  const s = reader();
  if (!s) return null;
  const by = new Map<string, TraderRow>();
  let updatedAt = 0;
  try {
    for (const window of ['1d', '7d', '30d', 'all'] as const) {
      for (const side of ['top', 'worst'] as const) {
        const b = s.readBoard(venue, window, side, 'any');
        if (!b) continue;
        updatedAt = Math.max(updatedAt, b.meta.sourceAt || b.meta.updatedAt);
        for (const r of b.rows) {
          const row = toRow(r, window, r.rank);
          const cur = by.get(r.address);
          if (!cur) {
            by.set(r.address, { ...row, rank: undefined, rankChange: null });
            continue;
          }
          cur.pnl = { ...cur.pnl, ...row.pnl };
          cur.volume = { ...cur.volume, ...row.volume };
          cur.accountValue = cur.accountValue ?? row.accountValue;
          if (window === '30d') {
            cur.winRate = row.winRate;
            cur.winRateExact = row.winRateExact;
            cur.winRateCloses = row.winRateCloses;
            cur.winRateFrom = row.winRateFrom;
            cur.trades = row.trades;
            cur.tradesCapped = row.tradesCapped;
          }
        }
      }
    }
  } catch {
    return null;
  }
  return by.size ? { rows: [...by.values()], updatedAt } : null;
}

// --- cohorts ---------------------------------------------------------------------
//
// Netted and filtered HERE, on request, from what the worker keeps current:
// members (cohort_member), books moved by the streams (cohort_book) and last
// prices (cohort_mark). One load per venue is shared by every request for a
// minute; one netting per set of venues likewise.

const RANGE_MS: Record<CohortRange, number> = { '1d': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };
const SPARK_POINTS = 96;
const LOAD_TTL_MS = 60_000;

interface CohortLoad {
  at: number;
  per: Map<Venue, Map<string, WalletVenue>>;
  marks: Map<string, number>;
  coverage: Partial<Record<Venue, VenueCoverage>>;
  /** Newest book write (ms). */
  booksAt: number;
}

let cohortLoad: CohortLoad | null = null;
const scopeCache = new Map<string, { at: number; wallets: NettedWallet[] }>();

function loadCohorts(s: IndexStore): CohortLoad {
  const now = Date.now();
  if (cohortLoad && now - cohortLoad.at < LOAD_TTL_MS) return cohortLoad;
  const per = new Map<Venue, Map<string, WalletVenue>>();
  const coverage: Partial<Record<Venue, VenueCoverage>> = {};
  let booksAt = 0;
  for (const venue of VENUES) {
    const members = s.cohortMembers(venue);
    const books = s.cohortBooks(venue);
    const m = new Map<string, WalletVenue>();
    let covered = 0;
    for (const address of new Set([...members.keys(), ...books.keys()])) {
      const mem = members.get(address);
      const b = books.get(address);
      const w = sampledVenue(TAIL_RATE[venue], address, mem && {
        pnl: mem.pnl, equity: mem.equity, label: mem.label,
        pnlRange: { '1d': mem.pnl1d ?? null, '7d': mem.pnl7d ?? null, '30d': mem.pnl30d ?? null },
      }, b);
      // Covered = wallets whose positions count (a read tail wallet outside the sample does not).
      if (w.positions) { covered++; booksAt = Math.max(booksAt, b!.at); }
      m.set(address, w);
    }
    per.set(venue, m);
    coverage[venue] = { members: m.size, covered, tailRate: TAIL_RATE[venue] };
  }
  cohortLoad = { at: now, per, marks: s.cohortMarks(), coverage, booksAt };
  scopeCache.clear();
  return cohortLoad;
}

function walletsOf(load: CohortLoad, venues: readonly Venue[]): NettedWallet[] {
  const key = scopeKey(venues);
  const hit = scopeCache.get(key);
  if (hit && hit.at === load.at) return hit.wallets;
  const mark = (v: Venue, sym: string) => load.marks.get(`${v}|${sym}`) ?? null;
  const wallets = scopeWallets(venues, load.per, mark);
  scopeCache.set(key, { at: load.at, wallets });
  return wallets;
}

/**
 * Every cohort's figures for a set of venues under a filter - one aggregation
 * per load (a minute), shared by every request. Summing ~120k wallets takes
 * the API thread a second or two; doing it per request held every route.
 */
const statsCache = new Map<string, { at: number; stats: CohortStat[] }>();
function statsOf(load: CohortLoad, venues: readonly Venue[], f: CohortFilter): CohortStat[] {
  const k = `${scopeKey(venues)}|${filterKey(f)}`;
  const hit = statsCache.get(k);
  if (hit && hit.at === load.at) return hit.stats;
  const stats = aggregate(walletsOf(load, venues), f);
  if (statsCache.size > 200) statsCache.clear();
  statsCache.set(k, { at: load.at, stats });
  return stats;
}

function thin<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows;
  const out: T[] = [];
  const step = (rows.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(rows[Math.round(i * step)]!);
  return out;
}

/** [t, long, short] over time: the 15-minute series unfiltered, the hourly mix under a filter. */
function history(s: IndexStore, scope: string, fromT: number, f: CohortFilter, cohort?: CohortId): Map<string, CohortPoint[]> {
  const out = new Map<string, CohortPoint[]>();
  const push = (c: string, p: CohortPoint) => {
    const l = out.get(c) ?? [];
    l.push(p);
    out.set(c, l);
  };
  try {
    if (!f.coin && !f.sector) {
      for (const p of s.cohortSeries(scope, fromT, cohort)) push(p.cohort, { t: p.t, long: p.long, short: p.short });
    } else {
      for (const r of s.cohortMix(scope, fromT, cohort)) {
        const x = f.coin ? r.c[f.coin] : r.s[f.sector!];
        if (x) push(r.cohort, { t: r.t, long: x[0], short: x[1] });
      }
    }
  } catch { /* the tables arrive with the worker's first start */ }
  return out;
}

/** Every cohort for a set of venues (netted when more than one), under a sector / coin filter. */
export function cohortsRead(venues: readonly Venue[], f: CohortFilter): CohortsResponse | null {
  const s = reader();
  if (!s) return null;
  const load = loadCohorts(s);
  const wallets = walletsOf(load, venues);
  const stats = statsOf(load, venues, f);
  const series = history(s, scopeKey(venues), Date.now() - RANGE_MS['7d'], f);
  // The asset picker: every coin held in this scope, unfiltered.
  const all = f.coin || f.sector ? statsOf(load, venues, {}) : stats;
  const coins = new Map<string, { coin: string; sector: Sector; gross: number }>();
  for (const st of all) {
    if (COHORT_BY_ID[st.id].kind !== 'size') continue; // each wallet is in one size cohort: no double count
    for (const m of st.markets) {
      const cur = coins.get(m.coin) ?? { coin: m.coin, sector: m.sector, gross: 0 };
      cur.gross += m.long + m.short;
      coins.set(m.coin, cur);
    }
  }
  return {
    venues: [...venues],
    filter: f,
    at: load.booksAt,
    coverage: Object.fromEntries(venues.map((v) => [v, load.coverage[v]])),
    coins: [...coins.values()].sort((a, b) => b.gross - a.gross),
    cohorts: stats.map(({ markets: _m, ...rest }) => ({
      ...rest,
      spark: thin((series.get(rest.id) ?? []).flatMap((p) => {
        const sh = longShare(p.long, p.short);
        return sh === null ? [] : [[p.t, sh] as [number, number]];
      }), SPARK_POINTS),
    })),
  };
}

export function cohortDetail(venues: readonly Venue[], cohort: CohortId, range: CohortRange, f: CohortFilter): CohortDetailResponse | null {
  const s = reader();
  if (!s) return null;
  const load = loadCohorts(s);
  const stat = statsOf(load, venues, f).find((x) => x.id === cohort)!;
  const series = history(s, scopeKey(venues), Date.now() - RANGE_MS[range], f, cohort).get(cohort) ?? [];
  return {
    venues: [...venues], filter: f, at: load.booksAt, range, cohort: stat,
    series: thin(series, 500), coverage: Object.fromEntries(venues.map((v) => [v, load.coverage[v]])),
  };
}

const SORT_VALUE: Record<WalletSort, (r: CohortWalletRow) => number | null> = {
  equity: (r) => r.equity, value: (r) => r.value, leverage: (r) => r.leverage, upnl: (r) => r.upnl,
  pnl: (r) => r.pnlRange, pnlAll: (r) => r.pnl, winRate: (r) => r.winRate,
};

/**
 * Win rates for cohort wallet rows over a range, netted over each row's
 * venues: wins and closes summed; exact only when every venue's are.
 * Hyperliquid's fills already hold its xyz dex, so trade.xyz is not added again.
 */
function attachWinRates(s: IndexStore, rows: WalletRow[], range: CohortRange): void {
  const byVenue = new Map<Venue, string[]>();
  for (const r of rows) for (const v of r.venues) byVenue.set(v, [...(byVenue.get(v) ?? []), r.address]);
  const stats = new Map<Venue, ReturnType<IndexStore['traderStats']>>();
  for (const [v, list] of byVenue) stats.set(v, s.traderStats(v, range, list));
  for (const r of rows) {
    let wins = 0;
    let closes = 0;
    let exact = true;
    let any = false;
    for (const v of r.venues) {
      if (v === 'tradexyz' && r.venues.includes('hyperliquid')) continue;
      const st = stats.get(v)?.get(r.address);
      if (!st) { exact = false; continue; }
      any = true;
      wins += st.wins;
      closes += st.closes;
      exact = exact && st.winExact;
    }
    if (!any) continue;
    const wr = winRateOf(wins, closes, exact);
    r.winRate = wr.winRate;
    r.winRateExact = wr.winRateExact;
    r.winRateCloses = wr.winRateCloses;
  }
}

/** The market map: every asset held, grouped by sector, for every wallet or one cohort. */
export function cohortMap(venues: readonly Venue[], cohort: CohortId | null): CohortMapResponse | null {
  const s = reader();
  if (!s) return null;
  const load = loadCohorts(s);
  const stats = statsOf(load, venues, {});
  const markets = cohort ? stats.find((x) => x.id === cohort)!.markets : everyWallet(stats);
  const by = new Map<Sector, MapSector>();
  for (const m of markets) {
    if (!(m.long + m.short > 0)) continue;
    const cur = by.get(m.sector) ?? { sector: m.sector, long: 0, short: 0, upnl: 0, assets: [] };
    cur.long += m.long;
    cur.short += m.short;
    cur.upnl += m.upnl;
    cur.assets.push(m);
    by.set(m.sector, cur);
  }
  return {
    venues: [...venues],
    cohort,
    at: load.booksAt,
    sectors: [...by.values()].sort((a, b) => b.long + b.short - (a.long + a.short)),
    coverage: Object.fromEntries(venues.map((v) => [v, load.coverage[v]])),
  };
}

/** One asset or sector across every cohort: today's figures and each cohort's lean over time. */
export function cohortFocus(venues: readonly Venue[], f: CohortFilter, range: CohortRange): CohortFocusResponse | null {
  const s = reader();
  if (!s) return null;
  const load = loadCohorts(s);
  const wallets = walletsOf(load, venues);
  const stats = statsOf(load, venues, f);
  const total = { long: 0, short: 0, upnl: 0, holding: 0, inProfit: 0, inLoss: 0 };
  for (const st of stats) {
    if (COHORT_BY_ID[st.id].kind !== 'size') continue;
    total.long += st.long;
    total.short += st.short;
    total.upnl += st.upnl;
    total.holding += st.holding;
    total.inProfit += st.inProfit;
    total.inLoss += st.inLoss;
  }
  const hist = history(s, scopeKey(venues), Date.now() - RANGE_MS[range], f);
  return {
    venues: [...venues],
    filter: f,
    at: load.booksAt,
    range,
    total,
    cohorts: stats.map((st) => ({
      id: st.id, wallets: st.wallets, holding: st.holding, long: st.long, short: st.short, upnl: st.upnl, inProfit: st.inProfit, inLoss: st.inLoss,
    })),
    series: Object.fromEntries([...hist].map(([c, pts]) => [c, thin(pts, 400)])),
    assets: f.sector && !f.coin ? everyWallet(stats) : [],
    coverage: Object.fromEntries(venues.map((v) => [v, load.coverage[v]])),
  };
}

/** A cohort's wallets, sorted and paged; under a filter, only wallets holding what it keeps. */
export function cohortWallets(
  venues: readonly Venue[], cohort: CohortId, f: CohortFilter,
  o: { sort: WalletSort; dir: 'asc' | 'desc'; offset: number; limit: number; range?: CohortRange },
): CohortWalletsResponse | null {
  const s = reader();
  if (!s) return null;
  const load = loadCohorts(s);
  const range: CohortRange = o.range && COHORT_RANGES.includes(o.range) ? o.range : '30d';
  const filtered = !!(f.coin || f.sector);
  const rows: CohortWalletRow[] = [];
  for (const w of walletsOf(load, venues)) {
    if (!cohortsOf(w).includes(cohort)) continue;
    const r = walletRow(w, f, range);
    if (filtered && !(r.value && r.value > 0)) continue;
    r.label = shownLabel(r.address, r.label);
    rows.push(r);
  }
  // Sorting by win rate needs it for every row; otherwise only the page gets it.
  if (o.sort === 'winRate') {
    try { attachWinRates(s, rows, range); } catch { /* decoration */ }
  }
  const val = SORT_VALUE[o.sort];
  const sign = o.dir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    const x = val(a);
    const y = val(b);
    if (x === null && y === null) return (b.equity ?? 0) - (a.equity ?? 0);
    if (x === null) return 1;
    if (y === null) return -1;
    return (x - y) * sign;
  });
  const page = rows.slice(o.offset, o.offset + o.limit);
  if (o.sort !== 'winRate') {
    try { attachWinRates(s, page, range); } catch { /* decoration */ }
  }
  return { total: rows.length, range, rows: page };
}

/** The indexer's own status line (lanes, streams), for diagnostics. */
export function indexerStatus(): unknown {
  const s = reader();
  const raw = s?.getMeta('indexer_status');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * The leaderboard index on disk (SQLite, node:sqlite, WAL).
 *
 * One writer (the indexer, in-process in dev or `npm run indexer` in
 * production) and any number of readers (API processes) share one file. WAL
 * lets readers run while the writer commits, so a leaderboard request never
 * waits on the crawl. Everything the API needs is precomputed into `boards`;
 * a request is one indexed SELECT.
 *
 * ONLY THE WRITER CHANGES THE FILE. It sets the journal mode, applies the
 * schema, adds columns and migrates. A reader opens the file read-only
 * (`{ readOnly: true }`, indexer/reader.ts) and runs nothing that writes; a
 * file the writer has not brought to its schema yet reads as "no index yet"
 * (schemaReady).
 *
 * Tables:
 *   accounts      venue + address, SoDEX account id, label, account value
 *   fills         every indexed fill of every tracked trader (REST or stream)
 *   closes        closed positions (SoDEX win rate; HL derives it from fills)
 *   coverage      per trader and history kind: [from_t, to_t] held completely
 *   activity_day  per account and UTC day, from the public trade streams:
 *                 order count and volume for EVERY account that traded
 *   pnl_snap      window PnL / volume per account from the venue or computed
 *   cum_pnl_day   all-time PnL per account per day, for 90d / ytd over time
 *   trader_win    per venue and window: the ranking pools (top / worst few
 *                 hundred) plus every pool address's figures on the other
 *                 venues, so any set of venues can be netted per address
 *   boards        the finished top / worst hundreds
 *   board_meta    when each board was built and how complete it is
 *
 * The path is `VALUESCAN_INDEX_DB`, else next to the device key (outside the
 * synced project tree). Nothing here throws on a read; a missing or corrupt
 * file reads as "not indexed yet".
 *
 * RETENTION (2026-10-02). Raw `fills` and `closes` are kept for
 * `VALUESCAN_INDEX_RETAIN_DAYS` whole UTC days (default 100: the longest
 * rolling window, 90d, plus a margin). Older history lives only in `fill_day`:
 * one row per trader and UTC day with everything a window reads. The rule
 * (pruneStep, a few ms at a time):
 *   - a day older than the retention whose rows the trader's held range
 *     (`coverage`) says are COMPLETE is summed from its raw rows one last
 *     time, its day row is marked `frozen`, and only then its raw rows go, a
 *     slice at a time. A frozen day is final: nothing sums it again, and a row
 *     that arrives for it later is a re-read of a row already counted, so it
 *     is dropped;
 *   - a day the held range does not vouch for stays raw (a bounded leftover
 *     per trader: partial reach-back pages), so a later read can still finish it;
 *   - a wallet with no held range at all (stream prints of a wallet no read
 *     ever landed for) loses its old days outright, raw rows and day rows,
 *     and everything once it has been quiet for two weeks.
 * Windows that start inside the retention read their first, partial day from
 * the raw rows as before. `ytd` and `all` start on a day boundary, so they are
 * exact from the day rows alone. A window whose first day is frozen starts at
 * that day's 00:00 UTC (only possible when the retention is set below a
 * window's length). Held ranges are not touched, so a trader whose raw rows
 * were pruned is still "covered" for long windows.
 *
 * SPACE. A database created by this code uses `auto_vacuum = INCREMENTAL`:
 * freed pages go back to the OS in 1 MB slices (reclaimStep), never one
 * blocking VACUUM. A file created before that (auto_vacuum = 0) reuses its
 * freed pages - it stops growing but does not shrink - until the offline
 * `src/indexer/compact.ts` is run once with the indexer stopped.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deviceKeyPath } from '../deviceKey.js';
import { VENUES, type BoardWindow, type Venue } from '../valuedesk/types.js';
import type { BoardFilter, Side } from './windows.js';
import { closeRuns, type CloseFill } from '../valuedesk/winRate.js';
import { mayPrune } from '../retention.js';

export const SCHEMA_VERSION = 1;

export function defaultDbPath(): string {
  return process.env.VALUESCAN_INDEX_DB?.trim() || join(dirname(deviceKeyPath()), 'valuescan-index.db');
}

/** History kinds a coverage row can describe. HL has one fill history; SoDEX one per engine plus closes. */
export type HistoryKind = 'fills' | 'perps' | 'spot' | 'closes';

/** What a liquidation change log row keeps about its position besides side, level and size (null: not known, or a row before 2026-10-29). */
export interface LiqLogExtra {
  /** The venue's symbol ("BTC", "xyz:TSLA", "BTC-USD"). */
  sym?: string | null;
  /** Signed size in the coin (long > 0). */
  sz?: number | null;
  entry?: number | null;
  /** The mark price at the row's time. */
  mark?: number | null;
  /** Isolated (true) or cross (false). */
  iso?: boolean | null;
  /** The leverage the venue margins it at. */
  lev?: number | null;
  /** The account's perps equity, and the cross cash its liquidation prices are figured from. */
  eq?: number | null;
  cash?: number | null;
  /** When the account's book was last read from the venue (a print moves it in between). */
  readAt?: number | null;
}

/** One position as it stood at a time, with when its run began and what happened next (store.liqAt). */
export interface LiqAtRow {
  aid: number;
  address: string;
  venue: number;
  /** The row in force: its time, side (1 long, -1 short), level, USD at the level. */
  t: number;
  side: number;
  liq: number;
  usd: number;
  sym: string | null;
  sz: number | null;
  entry: number | null;
  mark: number | null;
  /** 1 isolated, 0 cross, null not known. */
  iso: number | null;
  lev: number | null;
  eq: number | null;
  cash: number | null;
  readAt: number | null;
  /** When this run of the position began (its first row after its last close). */
  since: number;
  /** Its next row after the time asked (usd 0: it closed), or null: unchanged since. */
  next: { t: number; side: number; liq: number; usd: number; mark: number | null } | null;
}

export interface FillRow {
  venue: Venue;
  address: string;
  /** Unique per venue and account: HL `tid`, SoDEX `${symbol}:${tradeID}`. */
  id: string;
  t: number;
  symbol: string;
  /** +1 bought, -1 sold (this account's side). */
  side: 1 | -1;
  px: number;
  sz: number;
  fee: number | null;
  closedPnl: number | null;
  oid: string | null;
  /** 0 = public stream (no order id / fee / pnl yet), 1 = REST. */
  src: 0 | 1;
}

export interface CloseRow {
  venue: Venue;
  address: string;
  id: string;
  /** When the position closed. */
  t: number;
  /** When it opened, if known. */
  openedT: number | null;
  symbol: string;
  pnl: number;
}

export interface Coverage {
  fromT: number;
  toT: number;
  /** Nothing older than fromT exists or is reachable (history start, or the venue's cap). */
  exhausted: boolean;
  /** The venue's cap was hit: counts older than fromT are a lower bound. */
  capped: boolean;
  restAt: number;
}

export interface BoardRow {
  rank: number;
  venue: Venue;
  address: string;
  label: string | null;
  accountId: number | null;
  pnl: number;
  volume: number | null;
  trades: number | null;
  tradesCapped: boolean;
  winRate: number | null;
  /** The win rate covers every close in the window (else an estimate from `winCloses`). */
  winExact?: boolean;
  winCloses?: number | null;
  /** An estimate's oldest held close. */
  winFrom?: number | null;
  /** Rank then minus rank now, against the board's snapshot about a day earlier (board_meta.rank_since). */
  rankChange?: number | null;
  accountValue: number | null;
  assets: string[];
}

/** Per venue, window and address: the figures every surface reads (screener, cohorts, Scan). */
export interface TraderStatsRow {
  venue: Venue;
  window: BoardWindow;
  address: string;
  trades: number | null;
  tradesExact: boolean;
  wins: number;
  closes: number;
  winExact: boolean;
  winFrom: number | null;
  at: number;
}

/** One address on one venue in one window, as the netted ranking needs it. */
export interface TraderWin {
  venue: Venue;
  address: string;
  /** In that venue's top or worst pool, or 'x' = only here as another venue's pool member. */
  pool: 'top' | 'worst' | 'x';
  pnl: number;
  volume: number | null;
  /** Trades in the window, as far as known. */
  trades: number | null;
  /** `trades` is the full count (the window is covered), not a lower bound. */
  exact: boolean;
  wins: number | null;
  closes: number | null;
  /** wins / closes cover every close in the window. */
  winExact?: boolean;
  accountValue: number | null;
  label: string | null;
  assets: string[];
}

export interface NetRow {
  address: string;
  venues: Venue[];
  pnl: number;
  volume: number | null;
  trades: number | null;
  exact: boolean;
  wins: number | null;
  closes: number | null;
  /** Every venue's wins / closes cover the whole window. */
  winExact: boolean;
  accountValue: number | null;
  label: string | null;
  assets: string[];
  /** The SoDEX account id, when SoDEX is one of the venues (its curve is read by id). */
  accountId?: number | null;
}

export interface BoardMeta {
  venue: Venue;
  window: BoardWindow;
  side: Side;
  filter: BoardFilter;
  updatedAt: number;
  sourceAt: number;
  complete: boolean;
  /** Candidates still waiting for a trade check. */
  pending: number;
  /** Candidates looked at to fill the board. */
  scanned: number;
  note: string | null;
  /** When the ranks `rankChange` compares against were taken (null = no snapshot old enough yet). */
  rankSince?: number | null;
}

/** A cohort member: all-time PnL (membership), equity, and its PnL per page range. */
export interface CohortMemberRow {
  address: string;
  pnl: number | null;
  equity: number | null;
  label: string | null;
  pnl1d?: number | null;
  pnl7d?: number | null;
  pnl30d?: number | null;
}

/** A cohort wallet's PnL read from the venue itself (store.putCohortPnl). */
export interface CohortPnlRow {
  address: string;
  pnl: number | null;
  pnl1d: number | null;
  pnl7d: number | null;
  pnl30d: number | null;
}

export interface WindowStats {
  trades: number;
  volume: number;
  assets: string[];
  wins: number;
  closes: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS accounts (
  venue TEXT NOT NULL, address TEXT NOT NULL, account_id INTEGER, label TEXT,
  account_value REAL, av_at INTEGER,
  PRIMARY KEY (venue, address)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS accounts_id ON accounts (venue, account_id);
CREATE TABLE IF NOT EXISTS fills (
  venue TEXT NOT NULL, address TEXT NOT NULL, id TEXT NOT NULL, t INTEGER NOT NULL,
  symbol TEXT NOT NULL, side INTEGER NOT NULL, px REAL NOT NULL, sz REAL NOT NULL,
  fee REAL, closed_pnl REAL, oid TEXT, src INTEGER NOT NULL,
  PRIMARY KEY (venue, address, id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS fills_t ON fills (venue, address, t);
CREATE TABLE IF NOT EXISTS fill_day (
  venue TEXT NOT NULL, address TEXT NOT NULL, day INTEGER NOT NULL,
  trades INTEGER NOT NULL, volume REAL NOT NULL, closes INTEGER NOT NULL, wins INTEGER NOT NULL, syms TEXT NOT NULL,
  PRIMARY KEY (venue, address, day)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS fill_agg (
  venue TEXT NOT NULL, address TEXT NOT NULL, built_at INTEGER NOT NULL,
  PRIMARY KEY (venue, address)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS closes (
  venue TEXT NOT NULL, address TEXT NOT NULL, id TEXT NOT NULL, t INTEGER NOT NULL,
  opened_t INTEGER, symbol TEXT NOT NULL, pnl REAL NOT NULL,
  PRIMARY KEY (venue, address, id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS closes_t ON closes (venue, address, t);
CREATE TABLE IF NOT EXISTS coverage (
  venue TEXT NOT NULL, address TEXT NOT NULL, kind TEXT NOT NULL,
  from_t INTEGER NOT NULL, to_t INTEGER NOT NULL, exhausted INTEGER NOT NULL,
  capped INTEGER NOT NULL, rest_at INTEGER NOT NULL,
  PRIMARY KEY (venue, address, kind)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS activity_hour (
  venue TEXT NOT NULL, acct TEXT NOT NULL, hour INTEGER NOT NULL,
  trades INTEGER NOT NULL, volume REAL NOT NULL,
  PRIMARY KEY (venue, hour, acct)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS activity_hour_acct ON activity_hour (venue, acct, hour);
CREATE TABLE IF NOT EXISTS activity_day (
  venue TEXT NOT NULL, acct TEXT NOT NULL, day INTEGER NOT NULL,
  trades INTEGER NOT NULL, volume REAL NOT NULL,
  PRIMARY KEY (venue, day, acct)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS activity_day_acct ON activity_day (venue, acct, day);
CREATE TABLE IF NOT EXISTS pnl_snap (
  venue TEXT NOT NULL, win TEXT NOT NULL, address TEXT NOT NULL,
  pnl REAL NOT NULL, volume REAL, snapshot INTEGER NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (venue, win, address)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS cum_pnl_day (
  venue TEXT NOT NULL, day INTEGER NOT NULL, address TEXT NOT NULL, pnl REAL NOT NULL,
  PRIMARY KEY (venue, day, address)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS trader_win (
  venue TEXT NOT NULL, win TEXT NOT NULL, address TEXT NOT NULL,
  pool TEXT NOT NULL, pnl REAL NOT NULL, volume REAL, trades INTEGER, exact INTEGER NOT NULL,
  wins INTEGER, closes INTEGER, account_value REAL, label TEXT, assets TEXT NOT NULL,
  PRIMARY KEY (venue, win, address)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS trader_win_addr ON trader_win (win, address);
CREATE TABLE IF NOT EXISTS boards (
  venue TEXT NOT NULL, win TEXT NOT NULL, side TEXT NOT NULL, filter TEXT NOT NULL,
  rank INTEGER NOT NULL, address TEXT NOT NULL, label TEXT, account_id INTEGER,
  pnl REAL NOT NULL, volume REAL, trades INTEGER, trades_capped INTEGER NOT NULL,
  win_rate REAL, account_value REAL, assets TEXT NOT NULL,
  PRIMARY KEY (venue, win, side, filter, rank)) WITHOUT ROWID;
DROP TABLE IF EXISTS cohort_pos;
CREATE TABLE IF NOT EXISTS cohort_member (
  venue TEXT NOT NULL, address TEXT NOT NULL, pnl REAL, equity REAL, label TEXT, at INTEGER NOT NULL,
  PRIMARY KEY (venue, address)) WITHOUT ROWID;
-- Members that left a venue's set (dropCohortMembers): kept, as they were when they left - nothing is
-- deleted without the owner's word (retention.ts).
CREATE TABLE IF NOT EXISTS cohort_member_gone (
  venue TEXT NOT NULL, address TEXT NOT NULL, pnl REAL, equity REAL, label TEXT, at INTEGER NOT NULL,
  pnl_1d REAL, pnl_7d REAL, pnl_30d REAL, gone_at INTEGER NOT NULL,
  PRIMARY KEY (venue, address)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS cohort_book (
  venue TEXT NOT NULL, address TEXT NOT NULL, equity REAL, positions TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (venue, address)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS cohort_mark (
  key TEXT PRIMARY KEY, px REAL NOT NULL, at INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS cohort_mix (
  scope TEXT NOT NULL, cohort TEXT NOT NULL, t INTEGER NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (scope, cohort, t)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS cohort_pnl (
  venue TEXT NOT NULL, address TEXT NOT NULL, pnl REAL, pnl_1d REAL, pnl_7d REAL, pnl_30d REAL, at INTEGER NOT NULL,
  PRIMARY KEY (venue, address)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS cohort_series (
  scope TEXT NOT NULL, cohort TEXT NOT NULL, t INTEGER NOT NULL, lng REAL NOT NULL, shrt REAL NOT NULL,
  wallets INTEGER NOT NULL, covered INTEGER NOT NULL,
  PRIMARY KEY (scope, cohort, t)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS cohort_hist (
  span INTEGER NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (span, kind, key)) WITHOUT ROWID;
-- Every position's liquidation level as a change log (cohortTracker.ts logLevels), for the
-- history's wallet filter: a row when a position opens, flips, closes (usd 0) or its level or size
-- moves past LIQ_LOG_MOVE / USD_LOG_MOVE, at the history's 15-minute steps. Addresses by id.
CREATE TABLE IF NOT EXISTS liq_addr (id INTEGER PRIMARY KEY, address TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS liq_log (
  aid INTEGER NOT NULL, coin TEXT NOT NULL, venue INTEGER NOT NULL, t INTEGER NOT NULL,
  side INTEGER NOT NULL, liq REAL NOT NULL, usd INTEGER NOT NULL,
  PRIMARY KEY (aid, coin, venue, t)) WITHOUT ROWID;
-- Who sat in one price cell at one time (liqAt): every row of a coin by level, then each
-- position's state at that time by its key.
CREATE INDEX IF NOT EXISTS liq_log_cell ON liq_log (coin, liq, t);
-- The last logged state of every open position: what the next step compares with, across a restart.
CREATE TABLE IF NOT EXISTS liq_cur (
  aid INTEGER NOT NULL, coin TEXT NOT NULL, venue INTEGER NOT NULL,
  side INTEGER NOT NULL, liq REAL NOT NULL, usd INTEGER NOT NULL, t INTEGER NOT NULL,
  PRIMARY KEY (aid, coin, venue)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS liq_hist (
  coin TEXT NOT NULL, t INTEGER NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (coin, t)) WITHOUT ROWID;
-- Each snapshot's fine layers (levels.ts FineSnap: a tenth and a hundredth of its step near the
-- price, exact from the live engine), deflated JSON: the historical view's $10 and $1 on BTC.
CREATE TABLE IF NOT EXISTS liq_hist_fine (
  coin TEXT NOT NULL, t INTEGER NOT NULL, data BLOB NOT NULL,
  PRIMARY KEY (coin, t)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS liq_now (
  coin TEXT PRIMARY KEY, at INTEGER NOT NULL, data TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS board_meta (
  venue TEXT NOT NULL, win TEXT NOT NULL, side TEXT NOT NULL, filter TEXT NOT NULL,
  updated_at INTEGER NOT NULL, source_at INTEGER NOT NULL, complete INTEGER NOT NULL,
  pending INTEGER NOT NULL, scanned INTEGER NOT NULL, note TEXT,
  PRIMARY KEY (venue, win, side, filter)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS board_rank (
  venue TEXT NOT NULL, win TEXT NOT NULL, side TEXT NOT NULL, filter TEXT NOT NULL, t INTEGER NOT NULL,
  address TEXT NOT NULL, rank INTEGER NOT NULL,
  PRIMARY KEY (venue, win, side, filter, t, address)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS trader_stats (
  venue TEXT NOT NULL, win TEXT NOT NULL, address TEXT NOT NULL,
  trades INTEGER, trades_exact INTEGER NOT NULL, wins INTEGER NOT NULL, closes INTEGER NOT NULL,
  win_exact INTEGER NOT NULL, win_from INTEGER, at INTEGER NOT NULL,
  PRIMARY KEY (venue, win, address)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS ext_index (
  venue TEXT NOT NULL, idx TEXT NOT NULL, address TEXT NOT NULL,
  PRIMARY KEY (venue, idx)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ext_index_addr ON ext_index (venue, address);
CREATE TABLE IF NOT EXISTS unranked (
  venue TEXT NOT NULL, win TEXT NOT NULL, address TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (venue, win, address)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS fill_prune (
  venue TEXT NOT NULL, address TEXT NOT NULL, lo INTEGER NOT NULL, hi INTEGER NOT NULL,
  PRIMARY KEY (venue, address)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS fill_dirty (
  venue TEXT NOT NULL, address TEXT NOT NULL, day INTEGER NOT NULL,
  PRIMARY KEY (venue, address, day)) WITHOUT ROWID;
`;

/** Columns added after a table first shipped: [table, column, type]. */
const ADDED_COLUMNS: ReadonlyArray<[string, string, string]> = [
  ['boards', 'win_exact', 'INTEGER'],
  ['boards', 'win_closes', 'INTEGER'],
  ['boards', 'win_from', 'INTEGER'],
  ['boards', 'rank_change', 'INTEGER'],
  ['board_meta', 'rank_since', 'INTEGER'],
  ['trader_win', 'win_exact', 'INTEGER'],
  ['cohort_member', 'pnl_1d', 'REAL'],
  ['cohort_member', 'pnl_7d', 'REAL'],
  ['cohort_member', 'pnl_30d', 'REAL'],
  // Hyperliquid perp equity of a unified / portfolio-margin account (its spot
  // stablecoins), and when a read last looked at the spot state (cohortSource.ts).
  ['cohort_book', 'collateral', 'REAL'],
  ['cohort_book', 'spot_at', 'INTEGER'],
  // The liquidation change log's position as it stood (cohortTracker.ts logLevels, from 2026-10-29):
  // the venue's symbol, signed size, entry, the mark then, isolated or cross with its leverage,
  // the account's perps equity and cross cash, and when its book was last read. Null before.
  ['liq_log', 'sym', 'TEXT'],
  ['liq_log', 'sz', 'REAL'],
  ['liq_log', 'entry', 'REAL'],
  ['liq_log', 'mark', 'REAL'],
  ['liq_log', 'iso', 'INTEGER'],
  ['liq_log', 'lev', 'REAL'],
  ['liq_log', 'eq', 'REAL'],
  ['liq_log', 'cash', 'REAL'],
  ['liq_log', 'read_at', 'INTEGER'],
  // The account's cross cash for its liquidation prices (valuedesk/liquidations/math.ts).
  ['cohort_book', 'cash', 'REAL'],
  // What a day row must carry once its raw rows are gone (retention): how many
  // fills it had, their realised PnL net of fees, the first one's time, the
  // newest position-open among its SoDEX closes - and whether it is final.
  ['fill_day', 'fills', 'INTEGER'],
  ['fill_day', 'net', 'REAL'],
  ['fill_day', 'first_t', 'INTEGER'],
  ['fill_day', 'open_max', 'INTEGER'],
  ['fill_day', 'frozen', 'INTEGER'],
  // 2 = every live day row of the trader carries `fills` and `net` (built by this code).
  ['fill_agg', 'def', 'INTEGER'],
  // 1 = rebuilt from the venues' funding history for hours the index did not record (cohortRebuild.ts).
  ['cohort_series', 'src', 'INTEGER NOT NULL DEFAULT 0'],
  ['cohort_mix', 'src', 'INTEGER NOT NULL DEFAULT 0'],
];

/** Every table the schema creates (what a reader checks for: schemaReady). */
const SCHEMA_TABLES: readonly string[] = [...SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]!);

/**
 * THE COHORT TABLES' WRITE SEQUENCE (2026-10-31). Every row put into cohort_member or cohort_book
 * carries `rev`, one number counted up over both tables (meta COHORT_REV_META), and every member
 * removed leaves a tombstone with the next number (cohort_tomb). So the API reads only what changed
 * since its last load (indexer/read.ts) instead of paging all ~1M rows out every minute: that load was
 * 56% of the API's thread on 2026-10-31 and held it at 96-133% of a core.
 *
 * Kept apart from SCHEMA / ADDED_COLUMNS on purpose: those gate schemaReady, and an API started
 * before the indexer has migrated would read "no index" until it had. A reader finds the sequence
 * by its epoch in meta instead (cohortRevState) and loads in full until it is there.
 *
 * ALTER TABLE ... ADD COLUMN with a constant default rewrites nothing (SQLite keeps the default in
 * the schema); the two indexes are one pass over each table at the first start.
 */
const COHORT_REV_META = 'cohort_rev';
/** A new number whenever the sequence starts over (a fresh file, a restored one): a reader then loads in full. */
const COHORT_REV_EPOCH_META = 'cohort_rev_epoch';
/** The newest tombstone pruned: a reader whose last load is older has missed removals and loads in full. */
const COHORT_TOMB_FLOOR_META = 'cohort_tomb_floor';
/** Tombstones are kept this long: the API loads every minute, so an hour is sixty loads of margin. */
export const COHORT_TOMB_KEEP_MS = 60 * 60_000;
const COHORT_REV_SCHEMA = `
CREATE TABLE IF NOT EXISTS cohort_tomb (
  venue TEXT NOT NULL, kind TEXT NOT NULL, address TEXT NOT NULL, rev INTEGER NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (venue, kind, address)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS cohort_tomb_rev ON cohort_tomb (venue, rev);
CREATE INDEX IF NOT EXISTS cohort_member_rev ON cohort_member (venue, rev);
CREATE INDEX IF NOT EXISTS cohort_book_rev ON cohort_book (venue, rev);
`;

/** Where the cohort tables' write sequence stands (cohortRevState). */
export interface CohortRevState {
  /** The last number handed out: every row and tombstone up to it is committed. */
  rev: number;
  /** Tombstones up to this number are pruned. */
  floor: number;
  epoch: string;
}

/** A tombstone: `kind` 'm' a member row removed, 'b' a book row (none are removed yet). */
export interface CohortTomb {
  kind: 'm' | 'b';
  address: string;
  rev: number;
}

/**
 * The close definition the day aggregates were built with (valuedesk/winRate.ts).
 *   1 (none recorded)  one close per order id
 *   2                  runs of reducing fills
 *   3                  as 2, and a REST fill with no realised PnL (Lighter sends
 *                      null, not 0, on an opening fill) ends a run
 *   4                  the same closes. Every trader is re-summed once, because the
 *                      stored day rows had drifted from their fills: a day's "sum me
 *                      again" mark lived in memory and died with every restart, and a
 *                      SoDEX build started at the first fill, not the first close.
 *                      Measured 2026-10-02: the rows held 1% (Arcus, Lighter) to 5%
 *                      (Hyperliquid) fewer trades than the fills, 10% fewer
 *                      Hyperliquid closes and 13% fewer SoDEX closes. Every row now
 *                      also carries `fills` / `net` (retention)
 */
export const CLOSES_DEF = '4';

const DAY = 86_400_000;
/** While a trader's aggregates build, trade counts stop here (the boards only test for > 1). */
const PARTIAL_CAP = 1_000;

/** The SQL twin of windows.ts `tradeKey`. */
const ORDER_KEY = `t || '|' || symbol || '|' || side`;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A wallet's book as the cohort tables hold it. */
export interface CohortBookRow {
  /** The read's perps account value (on Hyperliquid / trade.xyz: that dex's own margin book). */
  equity: number | null;
  positions: Array<BookPosition>;
  at: number;
  /** Hyperliquid: a unified / portfolio-margin account's stablecoin collateral (model.ts perpEquity); null = standard, or not looked at. */
  collateral: number | null;
  /** Hyperliquid: when the read looked at the spot state (null = it did not). */
  spotAt: number | null;
  /** The account's cross cash for its liquidation prices (liquidations/math.ts); null = not known. */
  cash: number | null;
}

/** A book's position; `iso` / `lev` / `fix` as liquidations/math.ts LiqPos (absent on a cross position). */
export interface BookPosition {
  symbol: string;
  szi: number;
  entry: number | null;
  iso?: number | null;
  lev?: number | null;
  fix?: number | null;
}

/** [symbol, szi, entry] and, when the position has any, {i, l, f} (iso, lev, fix; `i` present = isolated). */
function bookEntry(p: BookPosition): unknown[] {
  const e: unknown[] = [p.symbol, p.szi, p.entry];
  if (p.iso !== undefined || p.fix != null) {
    const x: Record<string, number | null> = {};
    if (p.iso !== undefined) { x.i = p.iso; x.l = p.lev ?? null; }
    if (p.fix != null) x.f = p.fix;
    e.push(x);
  }
  return e;
}

const memberRow = (r: Record<string, unknown>): CohortMemberRow => ({
  address: r.address as string,
  pnl: num(r.pnl), equity: num(r.equity), label: typeof r.label === 'string' ? r.label : null,
  pnl1d: num(r.pnl_1d), pnl7d: num(r.pnl_7d), pnl30d: num(r.pnl_30d),
});

function bookRow(r: Record<string, unknown>): CohortBookRow {
  let positions: CohortBookRow['positions'] = [];
  try {
    const x = JSON.parse(String(r.positions ?? '[]'));
    if (Array.isArray(x)) {
      positions = x.flatMap((e): BookPosition[] => {
        if (!(Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'number')) return [];
        const p: BookPosition = { symbol: e[0], szi: e[1], entry: typeof e[2] === 'number' ? e[2] : null };
        const x = e[3] as { i?: number | null; l?: number | null; f?: number | null } | undefined;
        if (x && typeof x === 'object') {
          if ('i' in x) { p.iso = typeof x.i === 'number' ? x.i : null; p.lev = typeof x.l === 'number' ? x.l : null; }
          if (typeof x.f === 'number') p.fix = x.f;
        }
        return [p];
      });
    }
  } catch { /* none */ }
  return { equity: num(r.equity), positions, at: Number(r.at) || 0, collateral: num(r.collateral), spotAt: num(r.spot_at), cash: num(r.cash) };
}

/**
 * One trader's UTC day. `fills` / `net` (realised PnL minus fees) / `firstT`
 * stand in for the raw rows once those are pruned; `openMax` is the newest
 * position-open among the day's SoDEX closes (closeEvidence).
 */
type DayAgg = {
  trades: number; volume: number; closes: number; wins: number; syms: Map<string, number>;
  fills: number; net: number; firstT: number | null; openMax: number | null;
};
/** A day being summed: distinct trades so far (plus the ones at `lastT`), volume, markets, REST fills for closes. */
type DayAcc = {
  trades: number; lastT: number; atT: Set<string>; volume: number; syms: Map<string, number>; rest: CloseFill[];
  fills: number; pnl: number; fee: number; firstT: number;
  /** The day's closes, once the scan has passed it (`rest` is emptied then). */
  runs?: { closes: number; wins: number };
};
type ScanRow = { t: number; symbol: string; side: number; v: number; closed_pnl: number | null; fee: number | null; src: number };
/**
 * A resumable scan of one trader's fills over [from, to), `cursor` = where it
 * goes on, `day` = the day it is in. `touched` = days that got rows while a
 * build was in flight: summed again once it has landed.
 */
type ScanJob = { venue: Venue; address: string; from: number; to: number; cursor: number; day: number; days: Map<number, DayAcc>; touched: Set<number>; seen: number; noKeep?: boolean };
/** Rows per scan step: a few ms of work. */
const SCAN_CHUNK = 1_000;
/** A dirty day larger than this is summed in the background instead of at once. */
const SYNC_DAY_ROWS = 3_000;
/** Kept day sums to go on from (liveDays): a trader-day each, today's and yesterday's. */
const LIVE_DAYS_MAX = 20_000;

/** Hyperliquid's HIP-3 dex "xyz": its fills and held ranges are mirrored under `tradexyz`. */
const XYZ = 'xyz:';

// --- retention ---------------------------------------------------------------------------------

/**
 * The earliest time a fill or close may carry: before any venue here existed.
 * 0, seconds read as milliseconds and the like fall below it (Arcus answered
 * `createdAt: 0` for 13 fills, 2026-10-02: they sat on 1 January 1970 and made
 * a trader's history span 20,728 days).
 */
export const MIN_ROW_T = Date.UTC(2020, 0, 1);
/** A row may be this far ahead of this machine's clock (microseconds read as milliseconds are millennia ahead). */
const MAX_AHEAD_MS = DAY;
/** `t` exclusive upper bound meaning "no upper bound". */
const END = Number.MAX_SAFE_INTEGER;

export const RETAIN_DAYS_DEFAULT = 100;
/** Below this the 7d window would lose raw rows of its first day. */
export const RETAIN_DAYS_MIN = 8;

/**
 * Whole UTC days of raw fills and closes kept (`VALUESCAN_INDEX_RETAIN_DAYS`).
 * 100 keeps every rolling window (the longest is 90d) exact to the
 * millisecond; `ytd` and `all` are exact at any value. Below 91 the 90d
 * window - below 31 the 30d one too - starts at 00:00 UTC of its first day.
 */
export function retainDays(): number {
  const n = Math.floor(Number(process.env.VALUESCAN_INDEX_RETAIN_DAYS));
  return Number.isFinite(n) && n > 0 ? Math.min(36_500, Math.max(RETAIN_DAYS_MIN, n)) : RETAIN_DAYS_DEFAULT;
}

/**
 * The days of a trader its held range says are complete, among those before
 * `keepDay`: [lo, hi), or null. A day is complete when the range starts at or
 * before its first millisecond (or nothing older exists: `exhausted`) and
 * ends after its last. `minT` = the trader's oldest raw row.
 */
export function settledDays(cov: { fromT: number; toT: number; exhausted: boolean }, minT: number, keepDay: number): { lo: number; hi: number } | null {
  const minDay = Math.floor(minT / DAY);
  const lo = cov.exhausted ? minDay : Math.max(minDay, Math.ceil(cov.fromT / DAY));
  const hi = Math.min(keepDay, Math.floor(cov.toT / DAY));
  return lo < hi ? { lo, hi } : null;
}

/** `fill_agg.def`: the trader's live day rows carry `fills` and `net`. */
const AGG_COLS = 2;
/** Days frozen per job: bounds what one job keeps in memory and writes in one transaction. */
const JOB_DAYS = 31;
/** Raw rows of a forgotten trader deleted at once; the rest go in slices (pruneStep). */
const FORGET_INLINE_ROWS = 2_000;
/** Stream rows of a wallet that was never indexed are dropped once its newest is this old. */
const UNINDEXED_KEEP_MS = 14 * DAY;
/** The whole table is looked through for old rows this often (and at every UTC day change). */
const SWEEP_EVERY_MS = 6 * 60 * 60_000;
/** Free pages kept for the next inserts before any are handed back to the OS (64 MB at 4 KiB). */
const FREE_RESERVE_PAGES = 16_384;
/** Pages handed back per reclaim step (1 MB). */
const RECLAIM_PAGES = 256;
/** The WAL file is cut back to this after a checkpoint (it had grown to 359 MB and stayed there). */
const WAL_LIMIT_BYTES = 64 * 1024 * 1024;

/** A settled stretch of one trader's old days: summed, frozen, then deleted. */
interface FreezeJob {
  venue: Venue; address: string;
  /** Days [lo, hi). */
  lo: number; hi: number;
  keepDay: number;
  scan: ScanJob;
  phase: 'scan' | 'delete';
  /** A row landed in [lo, hi) while it was being summed: the sum is void. */
  stale: boolean;
  tries: number;
  /** The trader holds settled days past `hi` (a job takes JOB_DAYS at most). */
  more: boolean;
}
/** Raw rows of a trader going without a day row kept: everything (`all`) or the days before `keepDay` (`old`). */
interface DropJob { venue: Venue; address: string; before: number; days: 'all' | 'old'; keepDay: number }
/** The walk over every wallet with raw rows. `again` = look at `address` once more, from `floorDay` on. */
interface Sweep { keepDay: number; vi: number; address: string; again: boolean; floorDay: number; wallets: number; startedAt: number }

/** What the retention has done (totals since the file was created) and where it stands. */
export interface RetentionStatus {
  retainDays: number;
  /** Raw rows of days before this UTC day are pruned once settled. */
  keepFromDay: number;
  /** Freed pages go back to the OS (a file created with auto_vacuum = INCREMENTAL); else they are only reused. */
  autoVacuum: boolean;
  sweeping: boolean;
  lastSweepAt: number;
  lastSweepMs: number;
  /** Work in flight: the stretch being frozen, wallets being dropped. */
  pending: { freezing: string | null; dropping: number };
  totals: {
    /** Days frozen, and the raw rows deleted behind them. */
    days: number; fills: number; closes: number;
    /** Rows dropped with no day row kept (never-indexed wallets, forgotten traders). */
    dropped: number;
    /** Rows refused on insert: a time before 2020 or more than a day ahead / a day already frozen. */
    badTime: number; late: number;
    /** Stored rows with a broken time: given their neighbour's, or deleted. */
    repaired: number; unrepairable: number;
    /** Pages handed back to the OS. */
    reclaimedPages: number;
  };
  lastBad: string | null;
}

export class IndexStore {
  readonly db: DatabaseSync;
  private stmts = new Map<string, StatementSync>();
  /** Bumped on every write that can change an address's stats or coverage (in-process cache key). */
  private versions = new Map<string, number>();
  /** `venue|address` -> its day aggregates exist (fill_agg). */
  private aggReady = new Map<string, boolean>();
  /** `venue|address|day` whose aggregate is behind its fills. */
  private dirtyDays = new Set<string>();
  /**
   * Traders whose aggregates are being built, a slice of days at a time
   * (buildAggregates): `next` is the start of the next slice, `end` where the
   * build stops (fills after it are marked dirty as they arrive).
   */
  private building = new Map<string, ScanJob>();
  /** Re-sums under a newer close definition: behind first builds, old rows serve meanwhile. */
  private rebuilding = new Map<string, ScanJob>();
  /** `venue|address|day`: dirty days too large to sum at once, going on in the background. */
  private dayJobs = new Map<string, ScanJob>();
  /**
   * `venue|address|day` -> the finished sum of today (or yesterday) as it was written, kept to go on
   * from (refreshKey): the next sum reads only the rows after the last one it ate (`seen`). Until
   * 2026-10-31 every refresh summed the whole day again: a market maker's day read in full every
   * few minutes, more of it as the day went on - 29% of the indexer's thread (profiled), its board
   * builds 8-27 min. A row at or before `seen` (markDay) drops it: that day is summed whole again.
   */
  private liveDays = new Map<string, ScanJob>();
  private readonly readOnly: boolean;
  /**
   * A dirty day is summed again at most this often. A market maker's "today"
   * gets fills every second and is tens of thousands of rows: summing it on
   * every read was most of the worker's time (profiled 2026-09-29).
   */
  private readonly aggRefreshMs: number;
  private refreshedAt = new Map<string, number>();

  // --- retention state (the writer's) ---
  /** Whole UTC days of raw rows kept. */
  readonly retainDays: number;
  /** `venue|address` -> the day after its newest frozen day (0 = none frozen): rows from there on need no lookup. */
  private frozenTo = new Map<string, number>();
  /** `venue|address` -> its live day rows carry `fills` / `net`. */
  private netReady = new Map<string, boolean>();
  /**
   * `venue|address` -> days [lo, hi) frozen whose raw rows are still being
   * deleted (also in `fill_prune`, so a restart finishes them). Readers of raw
   * rows leave those days out: their day rows already count them.
   */
  private pruning = new Map<string, { venue: Venue; address: string; lo: number; hi: number }>();
  private dropping = new Map<string, DropJob>();
  private job: FreezeJob | null = null;
  private sweep: Sweep | null = null;
  private sweepAt = 0;
  private sweepMs = 0;
  private sweepDay = -1;
  /** Rows per delete slice, tuned to a few ms (it starts small: the first pages are cold). */
  private slice = 100;
  /** Rows per background scan step, tuned likewise (step). Starts small: the first pages may be cold. */
  private chunk = 125;
  private autoVacuum = 0;
  private totals: RetentionStatus['totals'] = { days: 0, fills: 0, closes: 0, dropped: 0, badTime: 0, late: 0, repaired: 0, unrepairable: 0, reclaimedPages: 0 };
  private totalsSaved = '';
  private lastBad: string | null = null;

  version(venue: Venue, address: string): number {
    return this.versions.get(`${venue}|${address}`) ?? 0;
  }

  private bump(venue: Venue, address: string): void {
    const k = `${venue}|${address}`;
    this.versions.set(k, (this.versions.get(k) ?? 0) + 1);
  }

  /**
   * `readOnly`: a reader beside the writer - the API thread in dev, the API
   * process in production (indexer/reader.ts). It TOUCHES NOTHING: the file is
   * opened with SQLite's read-only flag, and nothing below creates a directory,
   * sets a journal mode, applies the schema, adds a column or migrates. Only the
   * writer does those. `busy_timeout` is a setting of this connection, not of
   * the file. A file the writer has not brought to this code's schema yet is
   * for the caller to refuse (schemaReady).
   */
  constructor(readonly path: string = defaultDbPath(), opts: { readOnly?: boolean; aggRefreshMs?: number; retainDays?: number } = {}) {
    if (path !== ':memory:' && !opts.readOnly) mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, opts.readOnly ? { readOnly: true } : {});
    this.readOnly = !!opts.readOnly;
    this.aggRefreshMs = opts.aggRefreshMs ?? 10 * 60_000;
    this.retainDays = opts.retainDays ?? retainDays();
    this.db.exec('PRAGMA busy_timeout = 5000');
    if (!opts.readOnly) {
      // Only takes effect on a file with no table yet: pages freed later can then be
      // handed back in slices (reclaimStep). An older file keeps reusing them instead.
      this.db.exec('PRAGMA auto_vacuum = INCREMENTAL');
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
      this.db.exec(`PRAGMA journal_size_limit = ${WAL_LIMIT_BYTES}`);
      this.db.exec(SCHEMA);
      this.addColumns();
      this.addCohortRevs();
      this.setMeta('schema', String(SCHEMA_VERSION));
      // 2026-09-28: Arcus fills were stored with the fee inside closedPnl. Re-read them.
      if (this.getMeta('arcus_gross_pnl') !== '1') {
        this.db.exec("DELETE FROM fills WHERE venue = 'arcus'; DELETE FROM coverage WHERE venue = 'arcus';");
        this.setMeta('arcus_gross_pnl', '1');
      }
    }
    try {
      this.autoVacuum = Number((this.db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum?: number } | undefined)?.auto_vacuum) || 0;
      // Deletions a stop interrupted: their days are frozen, the rest of their raw rows still has to go.
      for (const r of this.db.prepare('SELECT venue, address, lo, hi FROM fill_prune').all() as Array<{ venue: Venue; address: string; lo: number; hi: number }>) {
        this.pruning.set(`${r.venue}|${r.address}`, { venue: r.venue, address: r.address, lo: r.lo, hi: r.hi });
      }
      // Days whose row was behind its fills when the last process stopped.
      if (!this.readOnly) {
        for (const r of this.db.prepare('SELECT venue, address, day FROM fill_dirty').all() as Array<{ venue: string; address: string; day: number }>) {
          this.dirtyDays.add(`${r.venue}|${r.address}|${r.day}`);
        }
      }
      const saved = this.getMeta('retention_totals');
      if (saved) {
        this.totals = { ...this.totals, ...(JSON.parse(saved) as Partial<RetentionStatus['totals']>) };
        this.totalsSaved = JSON.stringify(this.totals);
      }
    } catch { /* a file from before the retention: nothing in flight */ }
  }

  close(): void {
    this.db.close();
  }

  /**
   * Whether the file holds every table and column this code reads. A reader
   * never adds them - the writer does, when it starts - so until then a reader
   * treats the file as "no index yet" instead of failing on a missing column
   * (or, as it once did, migrating the file itself).
   */
  schemaReady(): boolean {
    try {
      const have = new Set((this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name));
      for (const table of SCHEMA_TABLES) if (!have.has(table)) return false;
      const cols = new Map<string, Set<string>>();
      for (const [table, column] of ADDED_COLUMNS) {
        let names = cols.get(table);
        if (!names) {
          names = new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
          cols.set(table, names);
        }
        if (!names.has(column)) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Add the columns newer code reads (the writer only: see the constructor). */
  private addColumns(): void {
    for (const [table, column, type] of ADDED_COLUMNS) {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (cols.some((c) => c.name === column)) continue;
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      } catch (e) {
        if (!/duplicate column/i.test(String(e))) throw e;
      }
    }
  }

  /** The cohort tables' write sequence (COHORT_REV_SCHEMA; the writer only). */
  private addCohortRevs(): void {
    for (const table of ['cohort_member', 'cohort_book']) {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (cols.some((c) => c.name === 'rev')) continue;
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN rev INTEGER NOT NULL DEFAULT 0`);
      } catch (e) {
        if (!/duplicate column/i.test(String(e))) throw e;
      }
    }
    this.db.exec(COHORT_REV_SCHEMA);
    this.tx(() => {
      if (this.getMeta(COHORT_REV_EPOCH_META) && this.getMeta(COHORT_REV_META) !== null) return;
      // Starting over: from above anything a row already carries (a file restored with its revs).
      const top = this.db.prepare(`SELECT MAX(m) AS m FROM (SELECT MAX(rev) AS m FROM cohort_member UNION ALL SELECT MAX(rev) FROM cohort_book
        UNION ALL SELECT MAX(rev) FROM cohort_tomb)`).get() as { m?: number | null } | undefined;
      this.setMeta(COHORT_REV_META, String(Number(top?.m) || 0));
      this.setMeta(COHORT_REV_EPOCH_META, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
    });
  }

  /**
   * `n` numbers of the write sequence, the first returned; inside the caller's transaction. Read from
   * meta and written back each time rather than held in memory: a second writer on the file (a test's,
   * compact.ts) or a restored file would otherwise hand out numbers a reader has already passed. One
   * point read and one write per batch of rows.
   */
  private takeRevs(n: number): number {
    const last = Number(this.getMeta(COHORT_REV_META)) || 0;
    this.setMeta(COHORT_REV_META, String(last + n));
    return last + 1;
  }

  /**
   * Where the write sequence stands, for a reader keeping a load current (indexer/read.ts); null on a
   * file the writer has not given one yet (load in full). Rows and tombstones up to `rev` are committed.
   */
  cohortRevState(): CohortRevState | null {
    try {
      const epoch = this.getMeta(COHORT_REV_EPOCH_META);
      const rev = this.getMeta(COHORT_REV_META);
      if (!epoch || rev === null) return null;
      return { rev: Number(rev) || 0, floor: Number(this.getMeta(COHORT_TOMB_FLOOR_META)) || 0, epoch };
    } catch {
      return null;
    }
  }

  /** A venue's member rows written after `after` up to `upTo`, in write order, `limit` at a time. */
  cohortMembersSince(venue: Venue, after: number, upTo: number, limit: number): Array<{ row: CohortMemberRow; rev: number }> {
    return (this.q('SELECT address, pnl, equity, label, pnl_1d, pnl_7d, pnl_30d, rev FROM cohort_member WHERE venue = ? AND rev > ? AND rev <= ? ORDER BY rev LIMIT ?')
      .all(venue, after, upTo, limit) as Array<Record<string, unknown>>).map((r) => ({ row: memberRow(r), rev: r.rev as number }));
  }

  /** A venue's book rows written after `after` up to `upTo`, in write order, `limit` at a time. */
  cohortBooksSince(venue: Venue, after: number, upTo: number, limit: number): Array<{ address: string; row: CohortBookRow; rev: number }> {
    return (this.q('SELECT address, equity, positions, at, collateral, spot_at, cash, rev FROM cohort_book WHERE venue = ? AND rev > ? AND rev <= ? ORDER BY rev LIMIT ?')
      .all(venue, after, upTo, limit) as Array<Record<string, unknown>>).map((r) => ({ address: r.address as string, row: bookRow(r), rev: r.rev as number }));
  }

  /** A venue's tombstones after `after` up to `upTo`, in write order. */
  cohortTombsSince(venue: Venue, after: number, upTo: number): CohortTomb[] {
    return (this.q('SELECT kind, address, rev FROM cohort_tomb WHERE venue = ? AND rev > ? AND rev <= ? ORDER BY rev').all(venue, after, upTo) as Array<Record<string, unknown>>)
      .map((r) => ({ kind: r.kind === 'b' ? 'b' : 'm', address: r.address as string, rev: r.rev as number }));
  }

  /**
   * Tombstones older than COHORT_TOMB_KEEP_MS go (inside the caller's transaction). They are the
   * sequence's bookkeeping, not data: the member itself is kept in cohort_member_gone (retention.ts).
   */
  private pruneTombs(now: number): void {
    const r = this.q('SELECT MAX(rev) AS m FROM cohort_tomb WHERE at < ?').get(now - COHORT_TOMB_KEEP_MS) as { m?: number | null } | undefined;
    if (r?.m == null) return;
    this.q('DELETE FROM cohort_tomb WHERE rev <= ?').run(r.m);
    this.setMeta(COHORT_TOMB_FLOOR_META, String(Math.max(r.m, Number(this.getMeta(COHORT_TOMB_FLOOR_META)) || 0)));
  }

  /**
   * Re-sum the day aggregates built under an older close definition, trader
   * by trader in the background (buildAggregates). The old rows keep serving
   * until each trader's rebuild replaces them, so nothing goes blank. The
   * writer calls this once at start. Returns how many were queued.
   */
  migrateCloses(): number {
    const was = this.getMeta('closes_def');
    if (this.readOnly || was === CLOSES_DEF) return 0;
    // Traders built before the migration began; a restart part-way resumes with the rest.
    const sinceKey = `closes_def_since:${CLOSES_DEF}`;
    const since = Number(this.getMeta(sinceKey)) || Date.now();
    this.setMeta(sinceKey, String(since));
    // Every trader (definition 4). Queued a few at a time (feedMigration): each job costs
    // an index seek or two to set up, and there are tens of thousands of traders.
    const rows = this.q('SELECT venue, address FROM fill_agg WHERE built_at < ?').all(since) as Array<{ venue: Venue; address: string }>;
    // Taken from the end: SoDEX, Lighter and Arcus first (their trade ids run in time order, so a
    // trader's fills are read page after page: minutes for all of them), Hyperliquid and its xyz
    // mirror last (random ids: every fill is a seek while the file is not in memory - hours).
    const order: Record<string, number> = { hyperliquid: 0, tradexyz: 1, arcus: 2, lighter: 3, sodex: 4 };
    rows.sort((a, b) => (order[a.venue] ?? 2) - (order[b.venue] ?? 2));
    this.migrateList = rows;
    this.migrateWait = new Set(rows.map((r) => `${r.venue}|${r.address}`));
    this.migrating = true;
    if (!rows.length) this.finishMigration();
    return rows.length;
  }

  private migrating = false;
  /** Traders the migration has still to queue, and those it queued whose re-sum has not landed. */
  private migrateList: Array<{ venue: Venue; address: string }> = [];
  private migrateWait = new Set<string>();
  private migrateFlying = new Set<string>();

  private finishMigration(): void {
    this.migrating = false;
    this.setMeta('closes_def', CLOSES_DEF);
  }

  /** Keep a few of the migration's re-sums queued. */
  private feedMigration(): void {
    while (this.migrateList.length && this.rebuilding.size < 20) {
      const r = this.migrateList.pop()!;
      this.migrateOne(r.venue, r.address);
    }
  }

  /** Queue one trader's migration re-sum now, if it is still waiting for it. */
  private migrateOne(venue: Venue, address: string): void {
    const k = `${venue}|${address}`;
    if (!this.migrateWait.delete(k)) return;
    this.migrateFlying.add(k);
    this.queueAgg(venue, address, true);
  }

  /** Traders whose aggregates are building (first builds, and re-sums under a new definition). */
  get aggBacklog(): { first: number; rebuild: number; days: number } {
    return { first: this.building.size, rebuild: this.rebuilding.size + this.migrateWait.size, days: this.dayJobs.size };
  }

  private q(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  private depth = 0;

  /** Run `fn` in one transaction (all or nothing, one fsync). Nested calls join the outer one. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++;
      try {
        return fn();
      } finally {
        this.depth--;
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth = 0;
    }
  }

  // --- meta ------------------------------------------------------------------

  getMeta(key: string): string | null {
    const r = this.q('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined;
    return typeof r?.value === 'string' ? r.value : null;
  }

  setMeta(key: string, value: string): void {
    this.q('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // --- accounts --------------------------------------------------------------

  upsertAccount(venue: Venue, address: string, a: { accountId?: number | null; label?: string | null }): void {
    this.q(
      `INSERT INTO accounts (venue, address, account_id, label) VALUES (?, ?, ?, ?)
       ON CONFLICT (venue, address) DO UPDATE SET
         account_id = COALESCE(excluded.account_id, accounts.account_id),
         label = COALESCE(excluded.label, accounts.label)`,
    ).run(venue, address, a.accountId ?? null, a.label ?? null);
  }

  setAccountValue(venue: Venue, address: string, value: number | null, at: number): void {
    this.q(
      `INSERT INTO accounts (venue, address, account_value, av_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (venue, address) DO UPDATE SET account_value = excluded.account_value, av_at = excluded.av_at`,
    ).run(venue, address, value, at);
  }

  account(venue: Venue, address: string): { accountId: number | null; label: string | null; accountValue: number | null; avAt: number | null } | null {
    const r = this.q('SELECT account_id, label, account_value, av_at FROM accounts WHERE venue = ? AND address = ?').get(venue, address) as
      | Record<string, unknown>
      | undefined;
    if (!r) return null;
    return {
      accountId: num(r.account_id),
      label: typeof r.label === 'string' ? r.label : null,
      accountValue: num(r.account_value),
      avAt: num(r.av_at),
    };
  }

  /** Every known SoDEX account id to address. */
  accountIds(venue: Venue): Map<number, string> {
    const rows = this.q('SELECT account_id, address FROM accounts WHERE venue = ? AND account_id IS NOT NULL').all(venue) as Array<{
      account_id: number;
      address: string;
    }>;
    return new Map(rows.map((r) => [r.account_id, r.address]));
  }

  /** The wallet behind a venue's numeric account id, when the index has seen the pair (one index seek). */
  accountAddress(venue: Venue, accountId: number): string | null {
    const r = this.q('SELECT address FROM accounts INDEXED BY accounts_id WHERE venue = ? AND account_id = ? LIMIT 1').get(venue, accountId) as { address?: string } | undefined;
    return typeof r?.address === 'string' ? r.address : null;
  }

  // --- fills / closes / coverage ---------------------------------------------

  /**
   * Insert fills. A REST row replaces a stream row with the same id; a stream
   * row never downgrades a REST row. Hyperliquid fills on the HIP-3 dex "xyz"
   * (`xyz:*`) are also filed under `tradexyz`, which is ranked on its own.
   */
  putFills(input: readonly FillRow[]): void {
    if (!input.length) return;
    const maxT = Date.now() + MAX_AHEAD_MS;
    const rows: FillRow[] = [];
    const take = (f: FillRow): void => {
      // A time no venue can have produced (0, seconds, microseconds): never stored.
      if (!(f.t >= MIN_ROW_T && f.t <= maxT)) return this.noteBad(f.venue, f.address, f.id, f.t);
      // The day is frozen: its rows were complete when they were summed, so this is a re-read of one of them.
      if (this.frozenDay(f.venue, f.address, Math.floor(f.t / DAY))) {
        this.totals.late++;
        return;
      }
      rows.push(f);
    };
    for (const f of input) {
      take(f);
      if (f.venue === 'hyperliquid' && f.symbol.startsWith(XYZ)) take({ ...f, venue: 'tradexyz' });
    }
    if (!rows.length) return;
    if (this.dropping.size) for (const f of rows) this.keepWallet(f.venue, f.address, f.t);
    const ins = this.q(
      `INSERT INTO fills (venue, address, id, t, symbol, side, px, sz, fee, closed_pnl, oid, src)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (venue, address, id) DO UPDATE SET
         t = excluded.t, symbol = excluded.symbol, side = excluded.side, px = excluded.px, sz = excluded.sz,
         fee = excluded.fee, closed_pnl = excluded.closed_pnl, oid = excluded.oid, src = excluded.src
       WHERE excluded.src > fills.src OR (excluded.src = fills.src AND (
         excluded.t IS NOT fills.t OR excluded.symbol IS NOT fills.symbol OR excluded.side IS NOT fills.side OR
         excluded.px IS NOT fills.px OR excluded.sz IS NOT fills.sz OR excluded.fee IS NOT fills.fee OR
         excluded.closed_pnl IS NOT fills.closed_pnl OR excluded.oid IS NOT fills.oid))`,
    );
    // Only a row that is new or differs marks its day (and its trader's version): a re-read of rows
    // already held changed nothing, yet marked every day it touched dirty - and dropped the day sums
    // kept to go on from (liveDays), so a market maker's day was summed whole again on every read.
    const changed: FillRow[] = [];
    this.tx(() => {
      for (const f of rows) {
        if (Number(ins.run(f.venue, f.address, f.id, f.t, f.symbol, f.side, f.px, f.sz, f.fee, f.closedPnl, f.oid, f.src).changes) > 0) changed.push(f);
      }
      for (const a of new Set(changed.map((f) => `${f.venue}|${f.address}`))) {
        const [venue, address] = a.split('|') as [Venue, string];
        this.bump(venue, address);
      }
      // In the same transaction: a day that is now behind its fills is written down with them.
      for (const f of changed) this.markDay(f.venue, f.address, f.t);
    });
  }

  putCloses(input: readonly CloseRow[]): void {
    if (!input.length) return;
    const maxT = Date.now() + MAX_AHEAD_MS;
    const rows = input.filter((c) => {
      if (!(c.t >= MIN_ROW_T && c.t <= maxT)) {
        this.noteBad(c.venue, c.address, c.id, c.t);
        return false;
      }
      if (this.frozenDay(c.venue, c.address, Math.floor(c.t / DAY))) {
        this.totals.late++;
        return false;
      }
      return true;
    });
    if (!rows.length) return;
    if (this.dropping.size) for (const c of rows) this.keepWallet(c.venue, c.address, c.t);
    const ins = this.q(
      `INSERT INTO closes (venue, address, id, t, opened_t, symbol, pnl) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (venue, address, id) DO UPDATE SET t = excluded.t, opened_t = excluded.opened_t,
         symbol = excluded.symbol, pnl = excluded.pnl`,
    );
    this.tx(() => {
      for (const c of rows) ins.run(c.venue, c.address, c.id, c.t, c.openedT, c.symbol, c.pnl);
      for (const c of rows) this.bump(c.venue, c.address);
      for (const c of rows) this.markDay(c.venue, c.address, c.t);
    });
  }

  coverage(venue: Venue, address: string, kind: HistoryKind): Coverage | null {
    const r = this.q('SELECT from_t, to_t, exhausted, capped, rest_at FROM coverage WHERE venue = ? AND address = ? AND kind = ?').get(
      venue,
      address,
      kind,
    ) as Record<string, number> | undefined;
    if (!r) return null;
    return { fromT: r.from_t!, toT: r.to_t!, exhausted: r.exhausted === 1, capped: r.capped === 1, restAt: r.rest_at! };
  }

  /**
   * Record that [fromT, toT] is now held completely. Merged with what was held
   * if the two touch or overlap; otherwise the newer range wins (the gap is
   * refilled by the next backfill).
   */
  addCoverage(venue: Venue, address: string, kind: HistoryKind, span: { fromT: number; toT: number; exhausted?: boolean; capped?: boolean }, now: number): Coverage {
    // A Hyperliquid fill history is also the xyz dex's history over the same span.
    if (venue === 'hyperliquid' && kind === 'fills') this.addCoverage('tradexyz', address, kind, span, now);
    // A read landed for a wallet whose leftovers were being dropped: what is left stays.
    if (this.dropping.size) this.keepWallet(venue, address, 0);
    const prev = this.coverage(venue, address, kind);
    let next: Coverage;
    if (prev && span.fromT <= prev.toT && span.toT >= prev.fromT) {
      const older = span.fromT <= prev.fromT;
      next = {
        fromT: Math.min(prev.fromT, span.fromT),
        toT: Math.max(prev.toT, span.toT),
        exhausted: older ? !!span.exhausted : prev.exhausted,
        capped: older ? !!span.capped : prev.capped,
        restAt: now,
      };
    } else if (prev && span.toT < prev.fromT) {
      // An older piece that does not reach the held range: keep the held range.
      return prev;
    } else {
      next = { fromT: span.fromT, toT: span.toT, exhausted: !!span.exhausted, capped: !!span.capped, restAt: now };
    }
    this.q(
      `INSERT INTO coverage (venue, address, kind, from_t, to_t, exhausted, capped, rest_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (venue, address, kind) DO UPDATE SET from_t = excluded.from_t, to_t = excluded.to_t,
         exhausted = excluded.exhausted, capped = excluded.capped, rest_at = excluded.rest_at`,
    ).run(venue, address, kind, next.fromT, next.toT, next.exhausted ? 1 : 0, next.capped ? 1 : 0, next.restAt);
    this.bump(venue, address);
    return next;
  }

  /** Distinct orders since `fromT` (and optionally before `toT`). */
  orderCount(venue: Venue, address: string, fromT: number, toT = Number.MAX_SAFE_INTEGER): number {
    if (toT === Number.MAX_SAFE_INTEGER) {
      if (this.withAgg(venue, address)) {
        const { d0, whole } = this.firstDay(venue, address, fromT);
        const part = whole ? 0 : this.dayRows(venue, address, fromT, (d0 + 1) * DAY).get(d0)?.trades ?? 0;
        return part + this.tradesAfter(venue, address, whole ? d0 - 1 : d0);
      }
      if (!this.readOnly) return this.cappedTrades(venue, address, fromT, PARTIAL_CAP);
    }
    // The raw rows in range, plus the frozen days that lie wholly inside it.
    let n = 0;
    const count = this.q(`SELECT COUNT(DISTINCT ${ORDER_KEY}) AS n FROM fills WHERE venue = ? AND address = ? AND t >= ? AND t < ?`);
    for (const [a, b] of this.rawSpans(venue, address, fromT, toT === END ? END : toT + 1)) {
      n += (count.get(venue, address, a, b) as { n: number }).n;
    }
    const lastDay = toT === END ? END : Math.floor((toT + 1) / DAY) - 1;
    const frz = this.q('SELECT COALESCE(SUM(trades), 0) AS n FROM fill_day WHERE venue = ? AND address = ? AND day >= ? AND day <= ? AND frozen = 1')
      .get(venue, address, Math.floor(fromT / DAY), lastDay) as { n: number };
    return n + frz.n;
  }

  /**
   * What closed positions prove about trades since `fromT`: each close is a
   * trade, and a position opened AND closed in the window is at least two.
   * Closes of frozen days count from their day rows (`roundTrips` then counts
   * days with one, which is all the caller asks: more than none).
   */
  closeEvidence(venue: Venue, address: string, fromT: number): { closes: number; roundTrips: number } {
    let closes = 0;
    let roundTrips = 0;
    const raw = this.q(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN opened_t >= ? THEN 1 ELSE 0 END) AS rt FROM closes WHERE venue = ? AND address = ? AND t >= ? AND t < ?`,
    );
    for (const [a, b] of this.rawSpans(venue, address, fromT, END)) {
      const r = raw.get(fromT, venue, address, a, b) as { n: number; rt: number | null };
      closes += r.n;
      roundTrips += r.rt ?? 0;
    }
    // Only SoDEX keeps closed positions; elsewhere a day row's `closes` are runs of fills.
    if (venue === 'sodex' && this.frozenUpTo(venue, address) > Math.floor(fromT / DAY)) {
      const f = this.q(
        `SELECT COALESCE(SUM(closes), 0) AS n, COALESCE(SUM(CASE WHEN open_max >= ? THEN 1 ELSE 0 END), 0) AS rt
         FROM fill_day WHERE venue = ? AND address = ? AND day >= ? AND frozen = 1`,
      ).get(fromT, venue, address, Math.floor(fromT / DAY)) as { n: number; rt: number };
      closes += f.n;
      roundTrips += f.rt;
    }
    return { closes, roundTrips };
  }

  // --- retention: what readers need to know -----------------------------------------------------

  /** The day after the trader's newest frozen day (0 = none): a row or a window start from there on is never in a frozen day. */
  private frozenUpTo(venue: Venue, address: string): number {
    const k = `${venue}|${address}`;
    let d = this.frozenTo.get(k);
    if (d === undefined) {
      const r = this.q('SELECT MAX(day) AS d FROM fill_day WHERE venue = ? AND address = ? AND frozen = 1').get(venue, address) as { d: number | null } | undefined;
      d = r?.d == null ? 0 : r.d + 1;
      if (this.frozenTo.size > 50_000) this.frozenTo.clear();
      this.frozenTo.set(k, d);
    }
    return d;
  }

  /** The day's raw rows are pruned: its day row is final. */
  private frozenDay(venue: Venue, address: string, day: number): boolean {
    if (day >= this.frozenUpTo(venue, address)) return false;
    const r = this.q('SELECT frozen FROM fill_day WHERE venue = ? AND address = ? AND day = ?').get(venue, address, day) as { frozen: number | null } | undefined;
    return r?.frozen === 1;
  }

  /** Whether a day's raw rows have been pruned (its figures come from its day row). */
  dayFrozen(venue: Venue, address: string, day: number): boolean {
    return this.frozenDay(venue, address, day);
  }

  /**
   * A window's first day and how it is read: its raw rows from `fromT` on, or -
   * once they are pruned - its whole day row (the window then starts at that
   * day's 00:00 UTC; exact for `ytd` and `all`, which start there anyway).
   */
  private firstDay(venue: Venue, address: string, fromT: number): { d0: number; whole: boolean } {
    const d0 = Math.floor(fromT / DAY);
    return { d0, whole: this.frozenDay(venue, address, d0) };
  }

  private tradesAfter(venue: Venue, address: string, day: number): number {
    return (this.q('SELECT COALESCE(SUM(trades), 0) AS n FROM fill_day WHERE venue = ? AND address = ? AND day > ?').get(venue, address, day) as { n: number }).n;
  }

  /**
   * The stretches of [fromT, toT) whose raw rows count on their own: all of
   * it, minus days that are frozen while their raw rows are still being
   * deleted (those rows are already in their day rows).
   */
  private rawSpans(venue: Venue, address: string, fromT: number, toT: number): Array<[number, number]> {
    const p = this.pruning.size ? this.pruning.get(`${venue}|${address}`) : undefined;
    if (!p) return fromT < toT ? [[fromT, toT]] : [];
    const a = p.lo * DAY;
    const b = p.hi * DAY;
    const out: Array<[number, number]> = [];
    if (fromT < a) out.push([fromT, Math.min(a, toT)]);
    if (toT > b) out.push([Math.max(fromT, b), toT]);
    return out.filter(([x, y]) => x < y);
  }

  private noteBad(venue: Venue, address: string, id: string, t: number): void {
    this.totals.badTime++;
    this.lastBad = `${venue} ${address} ${id} t=${t}`;
  }

  /** Trades, volume, most-traded symbols and closes in [fromT, now]. */
  // --- day aggregates ------------------------------------------------------------
  //
  // A market maker's fills run to millions of rows, and a board rebuild used to
  // scan them per trader and window (seconds each, every pass). Per trader and
  // UTC day the index keeps what the boards read - distinct trades, volume,
  // closes and wins, volume per market - built once from the fills, then only
  // the days that get new fills are summed again (flushAggregates). A window is
  // its whole days from these rows plus one scan of the partial first day.

  private aggIsReady(venue: Venue, address: string): boolean {
    const k = `${venue}|${address}`;
    const hit = this.aggReady.get(k);
    if (hit !== undefined) return hit;
    const ready = !!this.q('SELECT 1 AS x FROM fill_agg WHERE venue = ? AND address = ?').get(venue, address);
    this.aggReady.set(k, ready);
    if (this.aggReady.size > 50_000) this.aggReady.clear();
    return ready;
  }

  private markDay(venue: Venue, address: string, t: number): void {
    if (this.readOnly) return;
    const d = Math.floor(t / DAY);
    const dk = `${venue}|${address}|${d}`;
    this.dayVersion.set(dk, (this.dayVersion.get(dk) ?? 0) + 1);
    if (this.dayVersion.size > 500_000) { this.dayVersion.clear(); this.partialMemo.clear(); }
    // A row at or before the last one a kept sum ate: going on from there would miss it.
    const live = this.liveDays.get(`${venue}|${address}|${d}`);
    if (live && t <= live.seen) this.liveDays.delete(`${venue}|${address}|${d}`);
    // Likewise a background sum of that day that has already passed it: written, but not kept.
    const bg = this.dayJobs.get(`${venue}|${address}|${d}`);
    if (bg && t <= bg.seen) bg.noKeep = true;
    // A row changed in a stretch being summed for freezing: that sum is void.
    const j = this.job;
    if (j && j.phase === 'scan' && d >= j.lo && d < j.hi && j.venue === venue && j.address === address) j.stale = true;
    // A frozen day is final: never summed again.
    if (this.frozenDay(venue, address, d)) return;
    // A build in flight sums this day from what it reads; whatever it had read by now, the
    // day is summed again once the build has landed (buildAggregates).
    const b = this.building.get(`${venue}|${address}`) ?? this.rebuilding.get(`${venue}|${address}`);
    if (b) b.touched.add(d);
    // Day rows exist: this one is behind its fills from now on.
    if (this.aggIsReady(venue, address)) this.dirty(venue, address, d);
  }

  /**
   * The day's row is behind its fills. Kept on disk too (`fill_dirty`), so a
   * restart does not forget it: the mark used to live in memory only, and
   * every restart left the rows of the last minutes' days short for good.
   */
  private dirty(venue: Venue, address: string, day: number): void {
    const k = `${venue}|${address}|${day}`;
    if (this.dirtyDays.has(k)) return;
    this.dirtyDays.add(k);
    this.q('INSERT OR IGNORE INTO fill_dirty (venue, address, day) VALUES (?, ?, ?)').run(venue, address, day);
  }

  /** The day's row is level with its fills again (unless a row arrived since it was summed). */
  private clean(venue: Venue, address: string, day: number): void {
    if (this.dirtyDays.has(`${venue}|${address}|${day}`)) return;
    this.q('DELETE FROM fill_dirty WHERE venue = ? AND address = ? AND day = ?').run(venue, address, day);
  }

  // --- the resumable day scan --------------------------------------------------------
  //
  // One pass over a trader's fills in time order, SCAN_CHUNK rows at a time,
  // summing per UTC day: distinct trades (block time, market, side), volume,
  // volume per market, and the REST fills the close definition needs. A job
  // can stop after any chunk and go on later, so a market maker's millions
  // of stream rows never hold the event loop: the old per-slice SQL
  // aggregates held it 2.6-7.4 s at a time (profiled 2026-09-29).

  private newJob(venue: Venue, address: string, from: number, to: number): ScanJob {
    return { venue, address, from, to, cursor: from, day: Number.NaN, days: new Map(), touched: new Set(), seen: Number.NEGATIVE_INFINITY };
  }

  private accOf(job: ScanJob, d: number): DayAcc {
    let a = job.days.get(d);
    if (!a) {
      job.days.set(d, (a = { trades: 0, lastT: Number.NaN, atT: new Set(), volume: 0, syms: new Map(), rest: [], fills: 0, pnl: 0, fee: 0, firstT: Number.NaN }));
    }
    return a;
  }

  /**
   * The scan has passed a day: its closes are counted and its fills let go.
   * (Held to the end of the job, a market maker's quarter of REST fills was
   * hundreds of MB.)
   */
  private seal(job: ScanJob): void {
    const a = job.days.get(job.day);
    if (!a || a.runs || job.venue === 'sodex') return;
    const c = closeRuns(a.rest);
    a.runs = { closes: c.closes, wins: c.wins };
    a.rest = [];
  }

  private eat(job: ScanJob, rows: ReadonlyArray<ScanRow>): void {
    for (const r of rows) {
      if (r.t > job.seen) job.seen = r.t;
      const day = Math.floor(r.t / DAY);
      // Rows come in time order: a new day means the one before is complete.
      if (day !== job.day) {
        this.seal(job);
        job.day = day;
      }
      const a = this.accOf(job, day);
      if (r.t !== a.lastT) {
        a.trades += a.atT.size;
        a.atT.clear();
        a.lastT = r.t;
      }
      a.atT.add(`${r.symbol}|${r.side}`);
      a.volume += r.v;
      a.syms.set(r.symbol, (a.syms.get(r.symbol) ?? 0) + r.v);
      // What stands in for the raw rows once they are pruned (realized, fillExtent).
      a.fills++;
      if (r.closed_pnl !== null) a.pnl += r.closed_pnl;
      if (r.fee !== null) a.fee += r.fee;
      if (!(a.firstT <= r.t)) a.firstT = r.t;
      // A REST fill with no realised PnL is an opening fill (0); a stream print's is unknown (skipped).
      if (r.closed_pnl !== null || r.src === 1) a.rest.push({ symbol: r.symbol, t: r.t, side: r.side, closedPnl: r.closed_pnl ?? 0 });
    }
  }

  /**
   * Scan up to `maxRows` more rows of a job. Returns true when the job has
   * reached its end. Rows of one timestamp are never split across chunks.
   */
  private scanStep(job: ScanJob, maxRows: number): boolean {
    if (job.cursor >= job.to) return true;
    const rows = this.q(
      `SELECT t, symbol, side, px * sz AS v, closed_pnl, fee, src FROM fills
       WHERE venue = ? AND address = ? AND t >= ? AND t < ? ORDER BY t LIMIT ?`,
    ).all(job.venue, job.address, job.cursor, job.to, maxRows + 1) as ScanRow[];
    if (rows.length <= maxRows) {
      this.eat(job, rows);
      job.cursor = job.to;
      return true;
    }
    const cut = rows[maxRows]!.t;
    if (rows[0]!.t === cut) {
      // One timestamp with more rows than a chunk: take all of it at once.
      this.eat(job, this.q(
        'SELECT t, symbol, side, px * sz AS v, closed_pnl, fee, src FROM fills WHERE venue = ? AND address = ? AND t = ?',
      ).all(job.venue, job.address, cut) as ScanRow[]);
      job.cursor = cut + 1;
    } else {
      this.eat(job, rows.filter((r) => r.t < cut));
      job.cursor = cut;
    }
    return job.cursor >= job.to;
  }

  /**
   * One scan step of background work (builds, re-sums, the retention), sized
   * to stay at a few ms whatever the disk does: a fill is found through the
   * time index and then fetched by its key, so on pages that are not in
   * memory every row is a seek: 1,000 Hyperliquid fills took 130-390 ms on
   * the live file (its trade ids are random, so a trader's fills of one day
   * are spread over all of its pages), 12 ms for Lighter's, whose ids run in
   * time order (measured 2026-10-02). Rows of one timestamp are never split.
   */
  private step(job: ScanJob): boolean {
    const t0 = Date.now();
    const done = this.scanStep(job, this.chunk);
    const ms = Date.now() - t0;
    if (ms > 20) this.chunk = Math.max(25, this.chunk >> 1);
    else if (ms < 5) this.chunk = Math.min(SCAN_CHUNK, this.chunk << 1);
    return done;
  }

  /** A finished job's day rows (SoDEX closes from the closes table, everyone else's by the close definition). */
  private finish(job: ScanJob): Map<number, DayAgg> {
    const out = new Map<number, DayAgg>();
    for (const [d, a] of job.days) {
      const c = job.venue === 'sodex' ? { closes: 0, wins: 0 } : a.runs ?? closeRuns(a.rest);
      out.set(d, {
        trades: a.trades + a.atT.size, volume: a.volume, closes: c.closes, wins: c.wins, syms: a.syms,
        fills: a.fills, net: a.pnl - a.fee, firstT: Number.isFinite(a.firstT) ? a.firstT : null, openMax: null,
      });
    }
    if (job.venue === 'sodex') {
      for (const r of this.q(
        `SELECT t / ${DAY} AS d, COUNT(*) AS n, SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS w, MAX(opened_t) AS om FROM closes
         WHERE venue = ? AND address = ? AND t >= ? AND t < ? GROUP BY d`,
      ).all(job.venue, job.address, job.from, job.to) as Array<{ d: number; n: number; w: number | null; om: number | null }>) {
        const x = out.get(r.d) ?? { trades: 0, volume: 0, closes: 0, wins: 0, syms: new Map<string, number>(), fills: 0, net: 0, firstT: null, openMax: null };
        x.closes = r.n;
        x.wins = r.w ?? 0;
        x.openMax = r.om;
        out.set(r.d, x);
      }
    }
    return out;
  }

  /** Per-day rows computed from the fills (and SoDEX closes) in [fromT, toT), in one go. */
  private dayRows(venue: Venue, address: string, fromT: number, toT: number): Map<number, DayAgg> {
    const job = this.newJob(venue, address, fromT, toT);
    while (!this.scanStep(job, SCAN_CHUNK)) { /* to the end */ }
    return this.finish(job);
  }

  /**
   * Closes and wins per UTC day in [fromT, toT), by the shared definition
   * (valuedesk/winRate.ts closeRuns): runs of reducing fills per market,
   * split at day boundaries so a day's figure never depends on another day.
   * Only fills with a known realised PnL (REST rows) take part.
   */
  private closesByDay(venue: Venue, address: string, fromT: number, toT: number): Array<{ d: number; n: number; w: number }> {
    const rows = this.q(
      `SELECT symbol, t, side, COALESCE(closed_pnl, 0) AS closed_pnl FROM fills
       WHERE venue = ? AND address = ? AND t >= ? AND t < ? AND (closed_pnl IS NOT NULL OR src = 1)`,
    ).all(venue, address, fromT, toT) as Array<{ symbol: string; t: number; side: number; closed_pnl: number }>;
    const byDay = new Map<number, Array<{ symbol: string; t: number; side: number; closedPnl: number }>>();
    for (const r of rows) {
      const d = Math.floor(r.t / DAY);
      const l = byDay.get(d);
      const f = { symbol: r.symbol, t: r.t, side: r.side, closedPnl: r.closed_pnl };
      if (l) l.push(f);
      else byDay.set(d, [f]);
    }
    const out: Array<{ d: number; n: number; w: number }> = [];
    for (const [d, list] of byDay) {
      const c = closeRuns(list);
      out.push({ d, n: c.closes, w: c.wins });
    }
    return out;
  }

  /** Write day rows. A frozen row is never replaced; `frozen` writes the rows as final. */
  private writeDays(venue: Venue, address: string, days: Map<number, DayAgg>, frozen = false): void {
    const ins = this.q(
      `INSERT INTO fill_day (venue, address, day, trades, volume, closes, wins, syms, fills, net, first_t, open_max, frozen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (venue, address, day) DO UPDATE SET trades = excluded.trades, volume = excluded.volume,
         closes = excluded.closes, wins = excluded.wins, syms = excluded.syms, fills = excluded.fills, net = excluded.net,
         first_t = excluded.first_t, open_max = excluded.open_max, frozen = excluded.frozen
       WHERE COALESCE(fill_day.frozen, 0) = 0`,
    );
    for (const [d, x] of days) {
      const top = [...x.syms].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([s, v]) => [s, Math.round(v)]);
      ins.run(venue, address, d, x.trades, x.volume, x.closes, x.wins, JSON.stringify(top), x.fills, x.net, x.firstT, x.openMax, frozen ? 1 : 0);
    }
  }

  /** Queue a trader's day aggregates to be built from its fills (buildAggregates). */
  private queueAgg(venue: Venue, address: string, rebuild = false): void {
    const k = `${venue}|${address}`;
    if (this.building.has(k) || (rebuild && this.rebuilding.has(k))) return;
    // A first build supersedes a queued re-sum.
    if (!rebuild) this.rebuilding.delete(k);
    let first = this.oldestRaw(venue, address);
    if (venue === 'sodex') {
      // SoDEX closes reach back before the first stream fill: the day rows start with the first of either.
      // (Starting at the first fill, a re-sum dropped every close before it.)
      const c = num((this.q('SELECT MIN(t) AS t FROM closes WHERE venue = ? AND address = ?').get(venue, address) as { t: number | null } | undefined)?.t);
      if (c !== null && (first === null || c < first)) first = c;
    }
    const now = Date.now();
    const start = first === null ? now : Math.floor(first / DAY) * DAY;
    (rebuild ? this.rebuilding : this.building).set(k, this.newJob(venue, address, start, (Math.floor(now / DAY) + 1) * DAY));
  }

  /**
   * Run queued aggregate work for up to `budgetMs`, a chunk of rows at a time:
   * first builds (a board is waiting), then dirty days too large to sum at
   * once, then re-sums under a newer close definition. Returns how many
   * traders are still building.
   *
   * `resumMs`: the share of that time re-sums may take. They are housekeeping
   * and read every fill a trader has - on pages that are not in memory, one
   * seek per row - so the caller keeps it small while its loop is behind.
   */
  buildAggregates(budgetMs = 40, resumMs = budgetMs): number {
    if (this.readOnly) return 0;
    const t0 = Date.now();
    const left = () => this.building.size + this.rebuilding.size + this.migrateWait.size;
    const over = () => Date.now() - t0 >= budgetMs;
    this.feedMigration();
    for (const map of [this.building, this.dayJobs, this.rebuilding]) {
      const until = map === this.rebuilding ? Math.min(t0 + budgetMs, Date.now() + resumMs) : t0 + budgetMs;
      const spent = (): boolean => Date.now() >= until;
      for (const [k, job] of map) {
        let done = false;
        while (!spent() && !(done = this.step(job))) { /* next chunk */ }
        if (!done) return left();
        const days = this.finish(job);
        if (map === this.dayJobs) {
          // One day of a heavy trader, summed in the background.
          this.tx(() => {
            this.q('DELETE FROM fill_day WHERE venue = ? AND address = ? AND day = ? AND COALESCE(frozen, 0) = 0').run(job.venue, job.address, Math.floor(job.from / DAY));
            this.writeDays(job.venue, job.address, days);
            this.clean(job.venue, job.address, Math.floor(job.from / DAY));
          });
          map.delete(k);
          this.keepLive(k, job);
          this.bump(job.venue, job.address);
          continue;
        }
        this.tx(() => {
          // Frozen days stay: their raw rows are gone, so they cannot be summed again.
          this.q('DELETE FROM fill_day WHERE venue = ? AND address = ? AND COALESCE(frozen, 0) = 0').run(job.venue, job.address);
          this.writeDays(job.venue, job.address, days);
          this.q('INSERT OR REPLACE INTO fill_agg (venue, address, built_at, def) VALUES (?, ?, ?, ?)').run(job.venue, job.address, Date.now(), AGG_COLS);
        });
        map.delete(k);
        this.aggReady.set(k, true);
        this.netReady.set(k, true);
        this.migrateFlying.delete(k);
        // Days that got rows while the build ran: what it wrote for them may predate those rows.
        for (const d of job.touched) this.dirty(job.venue, job.address, d);
        this.bump(job.venue, job.address);
        this.feedMigration();
        if (spent()) break;
      }
      if (over()) break;
    }
    if (this.migrating && !this.migrateList.length && !this.migrateWait.size && !this.migrateFlying.size) this.finishMigration();
    return left();
  }

  /** A dirty day may be summed again now (not within aggRefreshMs of its last sum). */
  private due(k: string, now: number): boolean {
    return now - (this.refreshedAt.get(k) ?? 0) >= this.aggRefreshMs;
  }

  /**
   * Sum one dirty day again. A small day is summed at once; a day with more
   * than SYNC_DAY_ROWS rows (a market maker's today) moves on in the
   * background (buildAggregates), keeping its last sum meanwhile.
   */
  private refreshKey(k: string, now: number): void {
    this.dirtyDays.delete(k);
    this.refreshedAt.set(k, now);
    if (this.refreshedAt.size > 100_000) this.refreshedAt.clear();
    if (this.dayJobs.has(k)) return;
    const [venue, address, day] = k.split('|') as [Venue, string, string];
    const d = Number(day);
    if (this.frozenDay(venue, address, d)) { this.liveDays.delete(k); return this.clean(venue, address, d); }
    const job = this.resumeLive(k) ?? this.newJob(venue, address, d * DAY, (d + 1) * DAY);
    const t0 = Date.now();
    while (!this.step(job)) {
      // Too many rows - or too slow a disk - to sum at once: it goes on in the background.
      // Its mark stays on disk until that sum has landed.
      if ((job.days.get(d)?.fills ?? 0) >= SYNC_DAY_ROWS || Date.now() - t0 > 30) {
        this.dayJobs.set(k, job);
        return;
      }
    }
    this.tx(() => {
      this.q('DELETE FROM fill_day WHERE venue = ? AND address = ? AND day = ? AND COALESCE(frozen, 0) = 0').run(venue, address, d);
      this.writeDays(venue, address, this.finish(job));
      this.clean(venue, address, d);
    });
    this.keepLive(k, job);
  }

  /** A kept sum of the day, set to go on after its last row (null: none - sum the day whole). */
  private resumeLive(k: string): ScanJob | null {
    const job = this.liveDays.get(k);
    if (!job || !Number.isFinite(job.seen)) return null;
    this.liveDays.delete(k);
    job.cursor = job.seen + 1;
    return job;
  }

  /** Keep a day's finished sum to go on from: today's and yesterday's only, LIVE_DAYS_MAX at most (the oldest go). */
  private keepLive(k: string, job: ScanJob): void {
    const d = Math.floor(job.from / DAY);
    if (job.noKeep || job.to - job.from !== DAY || d < Math.floor(Date.now() / DAY) - 1) return;
    this.liveDays.delete(k);
    this.liveDays.set(k, job);
    if (this.liveDays.size > LIVE_DAYS_MAX) this.liveDays.delete(this.liveDays.keys().next().value!);
  }

  /** Bring due dirty days up to date, for up to `budgetMs`. Returns how many stay dirty. */
  flushAggregates(budgetMs = 40): number {
    if (this.readOnly) return 0;
    const t0 = Date.now();
    for (const k of [...this.dirtyDays]) {
      if (Date.now() - t0 > budgetMs) break;
      if (this.due(k, t0)) this.refreshKey(k, t0);
    }
    return this.dirtyDays.size;
  }

  private refreshDirtyOf(venue: Venue, address: string): void {
    const prefix = `${venue}|${address}|`;
    const now = Date.now();
    for (const k of [...this.dirtyDays]) if (k.startsWith(prefix) && this.due(k, now)) this.refreshKey(k, now);
  }

  /** The aggregates are usable for this trader; if not, the writer queues their build. */
  private withAgg(venue: Venue, address: string, refresh = true): boolean {
    if (!this.aggIsReady(venue, address)) {
      if (!this.readOnly) this.queueAgg(venue, address);
      return false;
    }
    // Someone reads this trader now (a board, the stats sweep): its re-sum goes first.
    // Not the one-time re-sum of every trader, though: a board pass reads thousands of them,
    // and with all of those in the first-builds queue nothing else was summed (2026-10-02).
    // That one goes venue by venue in its own time (migrateCloses).
    const k = `${venue}|${address}`;
    const job = this.migrateFlying.has(k) ? undefined : this.rebuilding.get(k);
    if (job) {
      this.rebuilding.delete(k);
      this.building.set(k, job);
    }
    if (!this.readOnly && refresh) this.refreshDirtyOf(venue, address);
    return true;
  }

  /**
   * The partial first day of a window ([fromT, next UTC midnight)), scanned a
   * chunk at a time with `pause()` between chunks. A market maker's day is
   * 100k+ fills: scanned in one go it held the loop up to 3 s per call
   * (profiled 2026-09-30).
   */
  private async partialDayAsync(venue: Venue, address: string, fromT: number, pause: () => Promise<void>): Promise<DayAgg | undefined> {
    // Kept while THAT day's rows stand (dayVersion), not the trader's: an active trader's version moves
    // with every fill of today, and the old day was read again for every board candidate on every build -
    // 20% of the indexer's thread after the day sums were fixed (profiled 2026-10-31). The boards ask from
    // a start that holds for a quarter of an hour (engine.ts statsFrom), so this is read once per quarter.
    const d0 = Math.floor(fromT / DAY);
    const key = `${venue}|${address}|${fromT}|${this.dayVersion.get(`${venue}|${address}|${d0}`) ?? 0}`;
    if (this.partialMemo.has(key)) return this.partialMemo.get(key);
    const job = this.newJob(venue, address, fromT, (d0 + 1) * DAY);
    while (!this.step(job)) await pause();
    const out = this.finish(job).get(d0);
    if (this.partialMemo.size >= 50_000) this.partialMemo.clear();
    this.partialMemo.set(key, out);
    return out;
  }
  private partialMemo = new Map<string, DayAgg | undefined>();
  /** `venue|address|day` -> bumped whenever a row of that day changes (markDay): the partial sums' key. */
  private dayVersion = new Map<string, number>();

  /** windowStats without long stalls (the writer's board builds). Same figures. */
  async windowStatsAsync(venue: Venue, address: string, fromT: number, pause: () => Promise<void>): Promise<WindowStats> {
    // Dirty days are left to flushAggregates (a few minutes behind at most); summing them here stalled the build.
    if (!this.withAgg(venue, address, false)) return this.windowStats(venue, address, fromT);
    const { d0, whole } = this.firstDay(venue, address, fromT);
    if (whole) return this.sumWindow(venue, address, d0 - 1, undefined);
    const part = await this.partialDayAsync(venue, address, fromT, pause);
    return this.sumWindow(venue, address, d0, part);
  }

  /** orderCount since `fromT` without long stalls. Same figure. */
  async orderCountAsync(venue: Venue, address: string, fromT: number, pause: () => Promise<void>): Promise<number> {
    if (!this.withAgg(venue, address, false)) return this.orderCount(venue, address, fromT);
    const { d0, whole } = this.firstDay(venue, address, fromT);
    if (whole) return this.tradesAfter(venue, address, d0 - 1);
    const part = (await this.partialDayAsync(venue, address, fromT, pause))?.trades ?? 0;
    return part + this.tradesAfter(venue, address, d0);
  }

  /** At least `n` distinct trades since `fromT`? Stops reading at `n` (the boards' trade test). */
  hasTrades(venue: Venue, address: string, fromT: number, n: number): number {
    return this.cappedTrades(venue, address, fromT, n);
  }

  /**
   * Distinct trades since `fromT`, counted to at most `cap`: cheap on any
   * history (it stops reading at the cap), and enough for "more than one trade".
   * Pruned days count from their day rows.
   */
  private cappedTrades(venue: Venue, address: string, fromT: number, cap: number): number {
    let n = 0;
    const count = this.q(
      `SELECT COUNT(*) AS n FROM (SELECT DISTINCT t, symbol, side FROM fills WHERE venue = ? AND address = ? AND t >= ? AND t < ? LIMIT ?)`,
    );
    for (const [a, b] of this.rawSpans(venue, address, fromT, END)) {
      n += (count.get(venue, address, a, b, cap - n) as { n: number }).n;
      if (n >= cap) return cap;
    }
    const d0 = Math.floor(fromT / DAY);
    if (this.frozenUpTo(venue, address) > d0) {
      n += (this.q('SELECT COALESCE(SUM(trades), 0) AS n FROM fill_day WHERE venue = ? AND address = ? AND day >= ? AND frozen = 1')
        .get(venue, address, d0) as { n: number }).n;
    }
    return Math.min(n, cap);
  }

  windowStats(venue: Venue, address: string, fromT: number): WindowStats {
    if (this.withAgg(venue, address)) {
      const { d0, whole } = this.firstDay(venue, address, fromT);
      if (whole) return this.sumWindow(venue, address, d0 - 1, undefined);
      return this.sumWindow(venue, address, d0, this.dayRows(venue, address, fromT, (d0 + 1) * DAY).get(d0));
    }
    // The writer is building this trader's aggregates in the background: a capped
    // count now (the boards' trade test), the full figures once they are built.
    if (!this.readOnly) return { trades: this.cappedTrades(venue, address, fromT, PARTIAL_CAP), volume: 0, assets: [], wins: 0, closes: 0 };
    return this.windowStatsScan(venue, address, fromT);
  }

  /** A window's figures: its partial first day plus the whole days after it. */
  private sumWindow(venue: Venue, address: string, d0: number, part: DayAgg | undefined): WindowStats {
    {
      let trades = part?.trades ?? 0;
      let volume = part?.volume ?? 0;
      let closes = part?.closes ?? 0;
      let wins = part?.wins ?? 0;
      const syms = new Map(part?.syms ?? []);
      for (const r of this.q('SELECT trades, volume, closes, wins, syms FROM fill_day WHERE venue = ? AND address = ? AND day > ?')
        .all(venue, address, d0) as Array<{ trades: number; volume: number; closes: number; wins: number; syms: string }>) {
        trades += r.trades;
        volume += r.volume;
        closes += r.closes;
        wins += r.wins;
        try {
          for (const [s, v] of JSON.parse(r.syms) as Array<[string, number]>) syms.set(s, (syms.get(s) ?? 0) + v);
        } catch { /* skip */ }
      }
      const assets = [...syms].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s]) => s);
      return { trades, volume, assets, wins, closes };
    }
  }

  /** The aggregates are ready for this trader (tests and callers that must know). */
  aggregatesReady(venue: Venue, address: string): boolean {
    return this.aggIsReady(venue, address);
  }

  /**
   * The same figures from the fills themselves (a reader with no aggregates
   * yet). Days whose raw rows are pruned come from their day rows.
   */
  private windowStatsScan(venue: Venue, address: string, fromT: number): WindowStats {
    if (this.frozenUpTo(venue, address) > Math.floor(fromT / DAY)) return this.windowStatsMixed(venue, address, fromT);
    const base = this.q(
      `SELECT COUNT(DISTINCT ${ORDER_KEY}) AS n, COALESCE(SUM(px * sz), 0) AS vol FROM fills WHERE venue = ? AND address = ? AND t >= ?`,
    ).get(venue, address, fromT) as { n: number; vol: number };
    const assets = (this.q(
      `SELECT symbol, SUM(px * sz) AS v FROM fills WHERE venue = ? AND address = ? AND t >= ?
       GROUP BY symbol ORDER BY v DESC LIMIT 3`,
    ).all(venue, address, fromT) as Array<{ symbol: string }>).map((r) => r.symbol);
    const closes =
      venue !== 'sodex'
        ? // Runs of reducing fills (valuedesk/winRate.ts), per UTC day like the aggregates.
          this.closesByDay(venue, address, fromT, Number.MAX_SAFE_INTEGER).reduce((a, r) => ({ n: a.n + r.n, w: (a.w ?? 0) + r.w }), { n: 0, w: 0 as number | null })
        : (this.q(
            `SELECT COUNT(*) AS n, SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS w FROM closes WHERE venue = ? AND address = ? AND t >= ?`,
          ).get(venue, address, fromT) as { n: number; w: number | null });
    return { trades: base.n, volume: base.vol, assets, wins: closes.w ?? 0, closes: closes.n };
  }

  /** windowStatsScan for a trader with frozen days in the window: raw rows where they exist, day rows where they do not. */
  private windowStatsMixed(venue: Venue, address: string, fromT: number): WindowStats {
    let trades = 0;
    let volume = 0;
    let closes = 0;
    let wins = 0;
    const syms = new Map<string, number>();
    for (const r of this.q('SELECT trades, volume, closes, wins, syms FROM fill_day WHERE venue = ? AND address = ? AND day >= ? AND frozen = 1')
      .all(venue, address, Math.floor(fromT / DAY)) as Array<{ trades: number; volume: number; closes: number; wins: number; syms: string }>) {
      trades += r.trades;
      volume += r.volume;
      closes += r.closes;
      wins += r.wins;
      try {
        for (const [s, v] of JSON.parse(r.syms) as Array<[string, number]>) syms.set(s, (syms.get(s) ?? 0) + v);
      } catch { /* skip */ }
    }
    for (const [a, b] of this.rawSpans(venue, address, fromT, END)) {
      for (const [d, x] of this.dayRows(venue, address, a, b)) {
        // A frozen day's figures are its day row, whatever raw row is left of it.
        if (this.frozenDay(venue, address, d)) continue;
        trades += x.trades;
        volume += x.volume;
        closes += x.closes;
        wins += x.wins;
        for (const [s, v] of x.syms) syms.set(s, (syms.get(s) ?? 0) + v);
      }
    }
    const assets = [...syms].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([s]) => s);
    return { trades, volume, assets, wins, closes };
  }

  /** Replace a coverage row as given (used when a venue cap moves the start forward). */
  setCoverage(venue: Venue, address: string, kind: HistoryKind, c: Coverage): void {
    if (venue === 'hyperliquid' && kind === 'fills') this.setCoverage('tradexyz', address, kind, c);
    if (this.dropping.size) this.keepWallet(venue, address, 0);
    this.q(
      `INSERT INTO coverage (venue, address, kind, from_t, to_t, exhausted, capped, rest_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (venue, address, kind) DO UPDATE SET from_t = excluded.from_t, to_t = excluded.to_t,
         exhausted = excluded.exhausted, capped = excluded.capped, rest_at = excluded.rest_at`,
    ).run(venue, address, kind, c.fromT, c.toT, c.exhausted ? 1 : 0, c.capped ? 1 : 0, c.restAt);
    this.bump(venue, address);
  }

  private oldestRaw(venue: Venue, address: string): number | null {
    return num((this.q('SELECT MIN(t) AS t FROM fills WHERE venue = ? AND address = ?').get(venue, address) as { t: number | null } | undefined)?.t);
  }

  /**
   * Fill rows held for an address - its raw rows plus those pruned behind
   * frozen days - and the oldest one's time. Raw rows are counted up to `cap`
   * (the callers compare with 9,900 and 40,000; counting every row of a
   * market maker took seconds).
   */
  fillExtent(venue: Venue, address: string, cap = 50_000): { count: number; minT: number | null } {
    let count = 0;
    const some = this.q('SELECT COUNT(*) AS n FROM (SELECT 1 FROM fills WHERE venue = ? AND address = ? AND t >= ? AND t < ? LIMIT ?)');
    for (const [a, b] of this.rawSpans(venue, address, 0, END)) {
      if (count >= cap) break;
      count += (some.get(venue, address, a, b, cap - count) as { n: number }).n;
    }
    const first = this.oldestRaw(venue, address);
    if (this.frozenUpTo(venue, address) === 0) return { count, minT: first };
    const f = this.q('SELECT COALESCE(SUM(fills), 0) AS n, MIN(first_t) AS m FROM fill_day WHERE venue = ? AND address = ? AND frozen = 1')
      .get(venue, address) as { n: number; m: number | null };
    const m = num(f.m);
    return { count: Math.min(cap, count + f.n), minT: first === null ? m : m === null ? first : Math.min(first, m) };
  }

  /** The days in [fromT, toT] that can hold rows (from the trader's oldest raw row on) are summed again. */
  private markRange(venue: Venue, address: string, fromT: number, toT: number, first: number | null): void {
    if (first === null) return;
    const hi = Math.floor(Math.min(toT, Date.now()) / DAY);
    for (let d = Math.floor(Math.max(fromT, first) / DAY); d <= hi; d++) this.markDay(venue, address, d * DAY);
  }

  /**
   * Remove public-stream rows in [fromT, toT] once REST fills cover that range.
   * Hyperliquid's REST fills are aggregated per order and time, so their ids
   * differ from the stream's per-print ids: both copies would count.
   */
  dropStreamRows(venue: Venue, address: string, fromT: number, toT: number): void {
    for (const v of venue === 'hyperliquid' ? [venue, 'tradexyz' as Venue] : [venue]) {
      // Days before the trader's oldest row hold nothing to sum again (a range from 0 used to mark 20,000 of them).
      const first = this.oldestRaw(v, address);
      this.q('DELETE FROM fills WHERE venue = ? AND address = ? AND src = 0 AND t >= ? AND t <= ?').run(v, address, fromT, toT);
      this.markRange(v, address, fromT, toT, first);
    }
    this.bump(venue, address);
  }

  /**
   * dropStreamRows a slice at a time, `pause()` between slices. A market
   * maker's month of stream rows is 100k+ rows: one DELETE held the loop.
   */
  async dropStreamRowsAsync(venue: Venue, address: string, fromT: number, toT: number, pause: () => Promise<void>): Promise<void> {
    this.partialMemo.clear();
    const slice = this.q(
      `DELETE FROM fills WHERE (venue, address, id) IN (
         SELECT venue, address, id FROM fills WHERE venue = ? AND address = ? AND src = 0 AND t >= ? AND t <= ? LIMIT 2000)`,
    );
    for (const v of venue === 'hyperliquid' ? [venue, 'tradexyz' as Venue] : [venue]) {
      const first = this.oldestRaw(v, address);
      while (Number(slice.run(v, address, fromT, toT).changes) >= 2000) await pause();
      this.markRange(v, address, fromT, toT, first);
    }
    this.bump(venue, address);
  }

  /**
   * Realised PnL net of fees, traded volume and fill count since `fromT`: the
   * raw rows, plus the day rows of the days whose raw rows are pruned.
   */
  realized(venue: Venue, address: string, fromT: number): { pnl: number; volume: number; fills: number } {
    let pnl = 0;
    let volume = 0;
    let fills = 0;
    const raw = this.q(
      `SELECT COALESCE(SUM(closed_pnl), 0) - COALESCE(SUM(fee), 0) AS pnl, COALESCE(SUM(px * sz), 0) AS vol, COUNT(*) AS n
       FROM fills WHERE venue = ? AND address = ? AND t >= ? AND t < ?`,
    );
    for (const [a, b] of this.rawSpans(venue, address, fromT, END)) {
      const r = raw.get(venue, address, a, b) as { pnl: number; vol: number; n: number };
      pnl += r.pnl;
      volume += r.vol;
      fills += r.n;
    }
    const d0 = Math.floor(fromT / DAY);
    if (this.frozenUpTo(venue, address) > d0) {
      const f = this.q(
        `SELECT COALESCE(SUM(net), 0) AS pnl, COALESCE(SUM(volume), 0) AS vol, COALESCE(SUM(fills), 0) AS n
         FROM fill_day WHERE venue = ? AND address = ? AND day >= ? AND frozen = 1`,
      ).get(venue, address, d0) as { pnl: number; vol: number; n: number };
      pnl += f.pnl;
      volume += f.vol;
      fills += f.n;
    }
    return { pnl, volume, fills };
  }

  /** The trader's live day rows carry `fills` and `net` (they were built by this code). */
  private hasNet(venue: Venue, address: string): boolean {
    const k = `${venue}|${address}`;
    let v = this.netReady.get(k);
    if (v === undefined) {
      const r = this.q('SELECT def FROM fill_agg WHERE venue = ? AND address = ?').get(venue, address) as { def: number | null } | undefined;
      v = (r?.def ?? 0) >= AGG_COLS;
      if (this.netReady.size > 50_000) this.netReady.clear();
      this.netReady.set(k, v);
    }
    return v;
  }

  /**
   * realized() without a long stall: whole days from the day rows and one
   * chunked scan of the window's first day. (The raw sum reads every fill
   * since `fromT`: seconds for a market maker's quarter, in one go.) Day rows
   * are a few minutes behind the newest fills, as for windowStatsAsync.
   */
  async realizedAsync(venue: Venue, address: string, fromT: number, pause: () => Promise<void>): Promise<{ pnl: number; volume: number; fills: number }> {
    if (!this.withAgg(venue, address, false)) return this.realized(venue, address, fromT);
    if (!this.hasNet(venue, address)) {
      // Day rows from before they carried `net`: summed again in the background (unless the
      // one-time re-sum will get to this trader anyway); the raw rows answer meanwhile.
      const k = `${venue}|${address}`;
      if (!this.readOnly && !this.migrateWait.has(k) && !this.migrateFlying.has(k)) this.queueAgg(venue, address, true);
      return this.realized(venue, address, fromT);
    }
    const { d0, whole } = this.firstDay(venue, address, fromT);
    const part = whole ? undefined : await this.partialDayAsync(venue, address, fromT, pause);
    const r = this.q(
      'SELECT COALESCE(SUM(net), 0) AS pnl, COALESCE(SUM(volume), 0) AS vol, COALESCE(SUM(fills), 0) AS n FROM fill_day WHERE venue = ? AND address = ? AND day > ?',
    ).get(venue, address, whole ? d0 - 1 : d0) as { pnl: number; vol: number; n: number };
    return { pnl: (part?.net ?? 0) + r.pnl, volume: (part?.volume ?? 0) + r.vol, fills: (part?.fills ?? 0) + r.n };
  }

  /** Newest REST fill time (the incremental cursor). */
  newestFill(venue: Venue, address: string): number | null {
    const r = this.q('SELECT MAX(t) AS t FROM fills WHERE venue = ? AND address = ?').get(venue, address) as { t?: number | null };
    return num(r?.t);
  }

  /**
   * Drop the fills, closes and coverage of a trader no longer tracked. What
   * marks it as indexed goes at once; its raw rows go a slice at a time
   * (pruneStep) - a market maker's are millions, and one DELETE held the loop
   * for as long as it took.
   */
  forget(venue: Venue, address: string): void {
    this.tx(() => {
      this.q('DELETE FROM coverage WHERE venue = ? AND address = ?').run(venue, address);
      this.q('DELETE FROM fill_day WHERE venue = ? AND address = ?').run(venue, address);
      this.q('DELETE FROM fill_agg WHERE venue = ? AND address = ?').run(venue, address);
      this.q('DELETE FROM fill_prune WHERE venue = ? AND address = ?').run(venue, address);
      this.q('DELETE FROM fill_dirty WHERE venue = ? AND address = ?').run(venue, address);
    });
    this.resetWallet(venue, address);
    const job: DropJob = { venue, address, before: END, days: 'all', keepDay: 0 };
    if (!this.dropSlice(job, FORGET_INLINE_ROWS)) this.dropping.set(`${venue}|${address}`, job);
    this.bump(venue, address);
  }

  /** Forget what is cached or queued for a trader (its day rows are gone). */
  private resetWallet(venue: Venue, address: string): void {
    const k = `${venue}|${address}`;
    this.aggReady.set(k, false);
    this.netReady.delete(k);
    this.frozenTo.delete(k);
    this.pruning.delete(k);
    this.building.delete(k);
    this.rebuilding.delete(k);
    this.migrateWait.delete(k);
    this.migrateFlying.delete(k);
    const prefix = `${k}|`;
    for (const d of this.dayJobs.keys()) if (d.startsWith(prefix)) this.dayJobs.delete(d);
    for (const d of this.liveDays.keys()) if (d.startsWith(prefix)) this.liveDays.delete(d);
    for (const d of this.dirtyDays) if (d.startsWith(prefix)) this.dirtyDays.delete(d);
    if (this.job && this.job.venue === venue && this.job.address === address) this.job = null;
  }

  // --- retention: pruning ---------------------------------------------------------------------------

  /**
   * Run retention work for up to `budgetMs`, then return: finish deletions a
   * stop interrupted, drop what forget() queued, go on with the stretch being
   * frozen, and - once per UTC day and every few hours - walk every wallet
   * that holds raw rows, looking for days older than the retention. `now`
   * decides what is old. Each unit is a few ms (a scan chunk, a delete
   * slice), so the caller's loop is never held. `maxUnits` stops after that
   * many units whatever the time (tests step through a prune with it).
   */
  pruneStep(budgetMs: number, now: number = Date.now(), maxUnits = Number.POSITIVE_INFINITY): RetentionStatus {
    if (this.readOnly) return this.retention(now);
    const t0 = Date.now();
    let units = 0;
    const over = (): boolean => Date.now() - t0 >= budgetMs || units >= maxUnits;
    while (!over()) {
      units++;
      // One delete slice a step, however much time is left: a deleted fill dirties a page of its
      // own (Hyperliquid's ids are random), and a burst of them is a burst of disk writes.
      // 1. Days already frozen whose raw rows are not all gone (a stop came in between).
      const left = this.leftover();
      if (left) {
        this.deleteFrozen(left);
        break;
      }
      // 2. Wallets being dropped.
      const drop = this.dropping.values().next().value;
      if (drop) {
        const s0 = Date.now();
        const done = this.dropSlice(drop, this.slice);
        this.tune(Date.now() - s0, !done);
        if (done) this.dropDone(drop);
        break;
      }
      // 3. The stretch being frozen.
      if (this.job) {
        const deleting = this.job.phase === 'delete';
        this.stepJob(this.job, over);
        if (deleting) break;
        continue;
      }
      // 4. The sweep.
      if (!this.sweep) {
        if (Math.floor(now / DAY) === this.sweepDay && now - this.sweepAt < SWEEP_EVERY_MS) break;
        // Raw fills older than the retention go only with the owner's word (retention.ts); a wallet
        // dropped on request (2.) and a stretch already being frozen (3.) still finish.
        if (!mayPrune('fills')) break;
        this.sweep = { keepDay: Math.floor(now / DAY) - this.retainDays, vi: 0, address: '', again: false, floorDay: 0, wallets: 0, startedAt: Date.now() };
      }
      if (!this.sweepNext(now)) {
        this.sweepMs = Date.now() - this.sweep.startedAt;
        this.sweep = null;
        this.sweepAt = now;
        this.sweepDay = Math.floor(now / DAY);
        this.saveTotals();
      }
    }
    if (!this.job && !this.dropping.size && !this.pruning.size && !over()) this.reclaimStep();
    return this.retention(now);
  }

  /**
   * A whole sweep at once, start to finish. BLOCKING: for tools and tests,
   * never for the running indexer (it calls pruneStep on a timer).
   */
  pruneNow(now: number = Date.now()): RetentionStatus {
    // From the first wallet, whatever a sweep in progress had reached.
    this.sweep = null;
    this.sweepDay = -1;
    do this.pruneStep(1_000, now);
    while (this.sweep || this.job || this.dropping.size || this.pruning.size);
    this.saveTotals();
    return this.retention(now);
  }

  /** Where the retention stands. */
  retention(now: number = Date.now()): RetentionStatus {
    const j = this.job;
    return {
      retainDays: this.retainDays,
      keepFromDay: Math.floor(now / DAY) - this.retainDays,
      autoVacuum: this.autoVacuum === 2,
      sweeping: this.sweep !== null,
      lastSweepAt: this.sweepAt,
      lastSweepMs: this.sweepMs,
      pending: { freezing: j ? `${j.venue} ${j.address} days ${j.lo}-${j.hi} ${j.phase}` : null, dropping: this.dropping.size },
      totals: { ...this.totals },
      lastBad: this.lastBad,
    };
  }

  private saveTotals(): void {
    const s = JSON.stringify(this.totals);
    if (s === this.totalsSaved) return;
    this.totalsSaved = s;
    this.setMeta('retention_totals', s);
  }

  /** Keep a delete slice at a few ms: halve it after a slow one, grow it back after a quick one. */
  private tune(ms: number, full: boolean): void {
    if (!full) return;
    if (ms > 24) this.slice = Math.max(100, Math.floor(this.slice / 2));
    else if (ms < 6) this.slice = Math.min(500, this.slice * 2);
  }

  /** A frozen stretch whose raw rows are still there and that no job is deleting. */
  private leftover(): { venue: Venue; address: string; lo: number; hi: number } | null {
    if (!this.pruning.size) return null;
    const j = this.job;
    for (const p of this.pruning.values()) {
      if (j && j.phase === 'delete' && j.venue === p.venue && j.address === p.address) continue;
      return p;
    }
    return null;
  }

  /**
   * Delete one slice of the raw rows behind the frozen days in [lo, hi). True
   * when none is left (the marker goes then). Only rows of days that ARE
   * frozen go: a row that arrived since for a day of the stretch that had
   * none stays, and the next sweep freezes its day like any other.
   */
  private deleteFrozen(p: { venue: Venue; address: string; lo: number; hi: number }): boolean {
    const a = p.lo * DAY;
    const b = p.hi * DAY;
    const limit = this.slice;
    const t0 = Date.now();
    // Raw rows go: no partial day summed from them stands (partialDayAsync keys on row changes, not deletions).
    this.partialMemo.clear();
    const frozen = `EXISTS (SELECT 1 FROM fill_day d WHERE d.venue = r.venue AND d.address = r.address AND d.day = CAST(r.t / ${DAY} AS INTEGER) AND d.frozen = 1)`;
    const n = Number(this.q(
      `DELETE FROM fills WHERE (venue, address, id) IN (
         SELECT r.venue, r.address, r.id FROM fills r WHERE r.venue = ? AND r.address = ? AND r.t >= ? AND r.t < ? AND ${frozen} LIMIT ?)`,
    ).run(p.venue, p.address, a, b, limit).changes);
    this.totals.fills += n;
    let c = 0;
    if (n < limit) {
      c = Number(this.q(
        `DELETE FROM closes WHERE (venue, address, id) IN (
           SELECT r.venue, r.address, r.id FROM closes r WHERE r.venue = ? AND r.address = ? AND r.t >= ? AND r.t < ? AND ${frozen} LIMIT ?)`,
      ).run(p.venue, p.address, a, b, limit).changes);
      this.totals.closes += c;
    }
    const more = n >= limit || c >= limit;
    this.tune(Date.now() - t0, more);
    if (more) return false;
    this.q('DELETE FROM fill_prune WHERE venue = ? AND address = ?').run(p.venue, p.address);
    this.pruning.delete(`${p.venue}|${p.address}`);
    this.bump(p.venue, p.address);
    return true;
  }

  /** Delete up to `limit` of a drop job's raw rows. True when none is left. */
  private dropSlice(j: DropJob, limit: number): boolean {
    this.partialMemo.clear();
    const n = Number(this.q(
      `DELETE FROM fills WHERE (venue, address, id) IN (SELECT venue, address, id FROM fills WHERE venue = ? AND address = ? AND t < ? LIMIT ?)`,
    ).run(j.venue, j.address, j.before, limit).changes);
    this.totals.dropped += n;
    if (n >= limit) return false;
    const c = Number(this.q(
      `DELETE FROM closes WHERE (venue, address, id) IN (SELECT venue, address, id FROM closes WHERE venue = ? AND address = ? AND t < ? LIMIT ?)`,
    ).run(j.venue, j.address, j.before, limit).changes);
    this.totals.dropped += c;
    return c < limit;
  }

  /** A drop job has no raw row left: the day rows of what it dropped go too. */
  private dropDone(j: DropJob): void {
    const k = `${j.venue}|${j.address}`;
    this.dropping.delete(k);
    if (j.days === 'all') {
      this.tx(() => {
        this.q('DELETE FROM fill_day WHERE venue = ? AND address = ?').run(j.venue, j.address);
        this.q('DELETE FROM fill_agg WHERE venue = ? AND address = ?').run(j.venue, j.address);
        this.q('DELETE FROM fill_dirty WHERE venue = ? AND address = ?').run(j.venue, j.address);
      });
      this.resetWallet(j.venue, j.address);
    } else {
      this.tx(() => {
        this.q('DELETE FROM fill_day WHERE venue = ? AND address = ? AND day < ? AND COALESCE(frozen, 0) = 0').run(j.venue, j.address, j.keepDay);
        this.q('DELETE FROM fill_dirty WHERE venue = ? AND address = ? AND day < ?').run(j.venue, j.address, j.keepDay);
      });
      // A build in flight summed those days from rows that are gone now: it starts again.
      for (const [map, rebuild] of [[this.building, false], [this.rebuilding, true]] as const) {
        if (!map.has(k)) continue;
        map.delete(k);
        this.queueAgg(j.venue, j.address, rebuild);
      }
      const prefix = `${k}|`;
      const old = (d: string): boolean => d.startsWith(prefix) && Number(d.slice(prefix.length)) < j.keepDay;
      for (const d of this.dayJobs.keys()) if (old(d)) this.dayJobs.delete(d);
      for (const d of this.liveDays.keys()) if (old(d)) this.liveDays.delete(d);
      for (const d of this.dirtyDays) if (old(d)) this.dirtyDays.delete(d);
    }
    this.bump(j.venue, j.address);
  }

  /**
   * New data for a wallet whose leftovers are being dropped (it is wanted
   * again): what is left stays. `t` = the time of the row that arrived (0 = a
   * held range was written).
   */
  private keepWallet(venue: Venue, address: string, t: number): void {
    const k = `${venue}|${address}`;
    const j = this.dropping.get(k);
    if (!j || t >= j.before) return;
    this.dropping.delete(k);
    // Old days that lost some of their rows are summed again from what is left.
    if (j.days === 'old' && this.aggIsReady(venue, address)) this.queueAgg(venue, address, true);
  }

  private stepJob(j: FreezeJob, over: () => boolean): void {
    if (j.phase === 'delete') {
      if (!this.deleteFrozen(j)) return;
      this.job = null;
      // The wallet holds more settled days than one job takes: the sweep looks at it again, past these.
      if (this.sweep && j.more) {
        this.sweep.again = true;
        this.sweep.floorDay = j.hi;
      }
      return;
    }
    let done = false;
    while (!(done = this.step(j.scan)) && !over()) { /* next chunk */ }
    if (!done) return;
    if (j.stale) {
      // Rows changed under the sum (a read in progress): sum again, a few times at most, else the next sweep.
      if (++j.tries > 3) {
        this.job = null;
        return;
      }
      j.stale = false;
      j.scan = this.newJob(j.venue, j.address, j.lo * DAY, j.hi * DAY);
      return;
    }
    if (this.freeze(j)) j.phase = 'delete';
    else this.job = null;
  }

  /**
   * Write a summed stretch as final day rows and mark its raw rows for
   * deletion, in one transaction: from here on its days are read from their
   * day rows, whatever is left of the raw ones. False = the held range no
   * longer vouches for the stretch.
   */
  private freeze(j: FreezeJob): boolean {
    const cov = this.coverage(j.venue, j.address, j.venue === 'sodex' ? 'closes' : 'fills');
    const r = cov ? settledDays(cov, j.lo * DAY, j.keepDay) : null;
    if (!r || r.lo > j.lo || r.hi < j.hi) return false;
    const days = this.finish(j.scan);
    this.tx(() => {
      // Live day rows of the stretch are replaced by what its raw rows say now; a row frozen earlier stays.
      this.q('DELETE FROM fill_day WHERE venue = ? AND address = ? AND day >= ? AND day < ? AND COALESCE(frozen, 0) = 0').run(j.venue, j.address, j.lo, j.hi);
      this.writeDays(j.venue, j.address, days, true);
      this.q('INSERT OR REPLACE INTO fill_prune (venue, address, lo, hi) VALUES (?, ?, ?, ?)').run(j.venue, j.address, j.lo, j.hi);
      this.q('DELETE FROM fill_dirty WHERE venue = ? AND address = ? AND day >= ? AND day < ?').run(j.venue, j.address, j.lo, j.hi);
    });
    const k = `${j.venue}|${j.address}`;
    this.pruning.set(k, { venue: j.venue, address: j.address, lo: j.lo, hi: j.hi });
    this.frozenTo.delete(k);
    this.frozenTo.set(k, Math.max(this.frozenUpTo(j.venue, j.address), j.hi));
    const prefix = `${k}|`;
    for (let d = j.lo; d < j.hi; d++) {
      this.dirtyDays.delete(prefix + d);
      this.dayJobs.delete(prefix + d);
      this.liveDays.delete(prefix + d);
      this.refreshedAt.delete(prefix + d);
    }
    this.totals.days += days.size;
    this.bump(j.venue, j.address);
    return true;
  }

  /** Look at the sweep's next wallet. False when every venue is done. */
  private sweepNext(now: number): boolean {
    const s = this.sweep!;
    while (s.vi < VENUES.length) {
      const venue = VENUES[s.vi]!;
      if (!s.again) {
        const a = this.nextWallet(venue, s.address);
        if (a === null) {
          s.vi++;
          s.address = '';
          continue;
        }
        s.address = a;
        s.floorDay = 0;
        s.wallets++;
      }
      s.again = false;
      this.classify(venue, s.address, s.keepDay, now, s.floorDay);
      return true;
    }
    return false;
  }

  /** The next wallet after `after` that holds raw rows (fills, or SoDEX closes). Two index seeks. */
  private nextWallet(venue: Venue, after: string): string | null {
    const f = (this.q('SELECT address FROM fills WHERE venue = ? AND address > ? ORDER BY address LIMIT 1').get(venue, after) as { address: string } | undefined)?.address ?? null;
    const c = (this.q('SELECT address FROM closes WHERE venue = ? AND address > ? ORDER BY address LIMIT 1').get(venue, after) as { address: string } | undefined)?.address ?? null;
    return f === null ? c : c === null ? f : f < c ? f : c;
  }

  /**
   * One wallet's raw rows: fix broken times, then freeze the old days its
   * held range says are complete (a job), drop what nothing claims, or leave
   * it as it is.
   */
  private classify(venue: Venue, address: string, keepDay: number, now: number, floorDay = 0): void {
    const k = `${venue}|${address}`;
    if (this.dropping.has(k) || this.pruning.has(k)) return;
    const cut = keepDay * DAY;
    const one = (sql: string, ...p: Array<string | number>): number | null => num((this.q(sql).get(...p) as { t: number | null } | undefined)?.t);
    let minF = this.oldestRaw(venue, address);
    if (minF !== null && minF < MIN_ROW_T) {
      this.repairTimes(venue, address);
      minF = this.oldestRaw(venue, address);
    }
    const minC = one('SELECT MIN(t) AS t FROM closes WHERE venue = ? AND address = ?', venue, address);
    const minT = minF === null ? minC : minC === null ? minF : Math.min(minF, minC);
    if (minT === null) return;
    if (!this.q('SELECT 1 AS x FROM coverage WHERE venue = ? AND address = ? LIMIT 1').get(venue, address)) {
      // Never indexed: stream prints of a wallet no read landed for. Nothing vouches for
      // these rows, so none is frozen. All go once the wallet has been quiet for two weeks
      // (nothing tracks it any more), else the days older than the retention.
      const newest = Math.max(
        one('SELECT MAX(t) AS t FROM fills WHERE venue = ? AND address = ?', venue, address) ?? 0,
        one('SELECT MAX(t) AS t FROM closes WHERE venue = ? AND address = ?', venue, address) ?? 0,
      );
      if (newest < now - UNINDEXED_KEEP_MS) this.dropping.set(k, { venue, address, before: END, days: 'all', keepDay: 0 });
      else if (minT < cut) this.dropping.set(k, { venue, address, before: cut, days: 'old', keepDay });
      // No old raw row: no old day row either (a stop between the last slice and their removal leaves some).
      else this.q('DELETE FROM fill_day WHERE venue = ? AND address = ? AND day < ? AND COALESCE(frozen, 0) = 0').run(venue, address, keepDay);
      return;
    }
    if (minT >= cut) return;
    const cov = this.coverage(venue, address, venue === 'sodex' ? 'closes' : 'fills');
    const r = cov ? settledDays(cov, minT, keepDay) : null;
    if (!r) return;
    // The first raw row inside the settled stretch (days before it are frozen already, or empty).
    const from = Math.max(r.lo, floorDay) * DAY;
    const to = r.hi * DAY;
    if (from >= to) return;
    const f = one('SELECT MIN(t) AS t FROM fills WHERE venue = ? AND address = ? AND t >= ? AND t < ?', venue, address, from, to);
    const c = one('SELECT MIN(t) AS t FROM closes WHERE venue = ? AND address = ? AND t >= ? AND t < ?', venue, address, from, to);
    const first = f === null ? c : c === null ? f : Math.min(f, c);
    if (first === null) return;
    const lo = Math.floor(first / DAY);
    const hi = Math.min(r.hi, lo + JOB_DAYS);
    this.job = { venue, address, lo, hi, keepDay, scan: this.newJob(venue, address, lo * DAY, hi * DAY), phase: 'scan', stale: false, tries: 0, more: hi < r.hi };
  }

  /**
   * Stored fills with a time no venue can have produced (the insert guard
   * keeps new ones out). An Arcus fill takes the time of the nearest fill by
   * trade id in the same market: Arcus numbers trades in order, and answered
   * `createdAt: 0` for 13 fills of one burst whose neighbours are 265 ms
   * apart. Anything else cannot be placed and goes.
   */
  private repairTimes(venue: Venue, address: string): void {
    const bad = this.q('SELECT id, symbol FROM fills WHERE venue = ? AND address = ? AND t < ? LIMIT 2000').all(venue, address, MIN_ROW_T) as Array<{ id: string; symbol: string }>;
    if (!bad.length) return;
    const at = this.q('SELECT t, symbol FROM fills WHERE venue = ? AND address = ? AND id = ?');
    const moved: number[] = [];
    this.tx(() => {
      for (const b of bad) {
        let t: number | null = null;
        const n = Number(b.id);
        if (venue === 'arcus' && Number.isSafeInteger(n)) {
          for (let d = 1; d <= 100 && t === null; d++) {
            for (const id of [n - d, n + d]) {
              const r = at.get(venue, address, String(id)) as { t: number; symbol: string } | undefined;
              if (r && r.symbol === b.symbol && r.t >= MIN_ROW_T) {
                t = r.t;
                break;
              }
            }
          }
        }
        // A frozen day cannot take another row.
        if (t !== null && this.frozenDay(venue, address, Math.floor(t / DAY))) t = null;
        if (t === null) {
          this.q('DELETE FROM fills WHERE venue = ? AND address = ? AND id = ?').run(venue, address, b.id);
          this.totals.unrepairable++;
        } else {
          this.q('UPDATE fills SET t = ? WHERE venue = ? AND address = ? AND id = ?').run(t, venue, address, b.id);
          this.totals.repaired++;
          moved.push(t);
        }
      }
      // The day rows those times made (1 January 1970 and the like).
      this.q('DELETE FROM fill_day WHERE venue = ? AND address = ? AND day < ? AND COALESCE(frozen, 0) = 0').run(venue, address, Math.floor(MIN_ROW_T / DAY));
    });
    for (const t of moved) this.markDay(venue, address, t);
    this.bump(venue, address);
  }

  /**
   * Hand free pages back to the OS, 1 MB at a time, keeping a reserve for the
   * next inserts. Only a file created with auto_vacuum = INCREMENTAL can; any
   * other reuses its free pages and keeps its size (see compact.ts). Returns
   * the pages handed back.
   */
  reclaimStep(reservePages = FREE_RESERVE_PAGES, maxPages = RECLAIM_PAGES): number {
    if (this.readOnly || this.autoVacuum !== 2) return 0;
    const free = Number((this.q('PRAGMA freelist_count').get() as { freelist_count?: number } | undefined)?.freelist_count) || 0;
    const n = Math.min(maxPages, free - reservePages);
    if (n <= 0) return 0;
    this.db.exec(`PRAGMA incremental_vacuum(${n})`);
    this.totals.reclaimedPages += n;
    return n;
  }

  /** Addresses that have any coverage row (i.e. were indexed at some point). */
  indexedAddresses(venue: Venue): string[] {
    return (this.q('SELECT DISTINCT address FROM coverage WHERE venue = ?').all(venue) as Array<{ address: string }>).map((r) => r.address);
  }

  // --- activity (public streams, every account) --------------------------------

  /**
   * Add stream activity. Each row is one account in one hour; the hour rows
   * serve windows up to 35 days, the day rollup the longer ones.
   */
  addActivity(rows: ReadonlyArray<{ venue: Venue; acct: string; hour: number; trades: number; volume: number }>): void {
    if (!rows.length) return;
    const hour = this.q(
      `INSERT INTO activity_hour (venue, acct, hour, trades, volume) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (venue, hour, acct) DO UPDATE SET trades = trades + excluded.trades, volume = volume + excluded.volume`,
    );
    const day = this.q(
      `INSERT INTO activity_day (venue, acct, day, trades, volume) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (venue, day, acct) DO UPDATE SET trades = trades + excluded.trades, volume = volume + excluded.volume`,
    );
    this.tx(() => {
      for (const r of rows) {
        hour.run(r.venue, r.acct, r.hour, r.trades, r.volume);
        day.run(r.venue, r.acct, Math.floor(r.hour / 24), r.trades, r.volume);
      }
    });
  }

  /**
   * Stream trades of one account since `fromHour` (hour rows) or `fromDay` (day rows).
   *
   * Through the per-account index, by name. Left to itself SQLite reads the
   * primary key instead (venue, hour >= ?) and tests every row of EVERY
   * account in the window for the one asked about: 766k rows per call on
   * Hyperliquid, ~1 s each with the file out of memory against 3 ms this way
   * (measured 2026-10-02) - and a board walk asks for a candidate at a time,
   * without yielding. That was the multi-second stall in every Hyperliquid
   * board, and it grew with the table.
   */
  activityTrades(venue: Venue, acct: string, from: { hour: number } | { day: number }): number {
    const r = ('hour' in from
      ? this.q('SELECT COALESCE(SUM(trades), 0) AS n FROM activity_hour INDEXED BY activity_hour_acct WHERE venue = ? AND acct = ? AND hour >= ?').get(venue, acct, from.hour)
      : this.q('SELECT COALESCE(SUM(trades), 0) AS n FROM activity_day INDEXED BY activity_day_acct WHERE venue = ? AND acct = ? AND day >= ?').get(venue, acct, from.day)) as { n: number };
    return r.n;
  }

  /** Accounts with at least `minTrades` stream trades since the start, most volume first. */
  activeAccounts(
    venue: Venue,
    from: { hour: number } | { day: number },
    minTrades: number,
    limit: number,
  ): Array<{ acct: string; trades: number; volume: number }> {
    const sql = 'hour' in from
      ? `SELECT acct, SUM(trades) AS trades, SUM(volume) AS volume FROM activity_hour
         WHERE venue = ? AND hour >= ? GROUP BY acct HAVING SUM(trades) >= ? ORDER BY volume DESC LIMIT ?`
      : `SELECT acct, SUM(trades) AS trades, SUM(volume) AS volume FROM activity_day
         WHERE venue = ? AND day >= ? GROUP BY acct HAVING SUM(trades) >= ? ORDER BY volume DESC LIMIT ?`;
    const start = 'hour' in from ? from.hour : from.day;
    return (this.q(sql).all(venue, start, minTrades, limit) as Array<{ acct: string; trades: number; volume: number }>).map((r) => ({
      acct: String(r.acct),
      trades: Number(r.trades),
      volume: Number(r.volume),
    }));
  }

  /**
   * Drop at most `limit` rows of each kind (hour rows before `beforeHour`, day
   * rows and all-time snapshots before `beforeDay`). Returns how many went: the
   * caller repeats while it is not 0, a few ms at a time.
   */
  pruneActivityChunk(beforeHour: number, beforeDay: number, limit = 5_000, cum?: { beforeDay: number; yearStartDay: number }): number {
    if (this.readOnly) return 0;
    let n = 0;
    // Per venue: each table's key starts with it, so "older than" is a range of the key.
    // (Without it every call read the whole table to find nothing: seconds once they are large.)
    const hour = this.q('DELETE FROM activity_hour WHERE (venue, hour, acct) IN (SELECT venue, hour, acct FROM activity_hour WHERE venue = ? AND hour < ? LIMIT ?)');
    const day = this.q('DELETE FROM activity_day WHERE (venue, day, acct) IN (SELECT venue, day, acct FROM activity_day WHERE venue = ? AND day < ? LIMIT ?)');
    const snap = this.q('DELETE FROM cum_pnl_day WHERE (venue, day, address) IN (SELECT venue, day, address FROM cum_pnl_day WHERE venue = ? AND day > ? AND day < ? LIMIT ?)');
    for (const venue of VENUES) {
      n += Number(hour.run(venue, beforeHour, limit).changes);
      n += Number(day.run(venue, beforeDay, limit).changes);
      const before = cum?.beforeDay ?? beforeDay;
      // All-time snapshots are read at two points only: the 90d window's start, and the
      // newest one at or before 1 January (ytd). That one outlives the rest.
      const anchor = cum
        ? num((this.q('SELECT MAX(day) AS d FROM cum_pnl_day WHERE venue = ? AND day <= ?').get(venue, cum.yearStartDay) as { d: number | null } | undefined)?.d)
        : null;
      if (anchor === null || anchor >= before) n += Number(snap.run(venue, -1, before, limit).changes);
      else {
        n += Number(snap.run(venue, -1, anchor, limit).changes);
        n += Number(snap.run(venue, anchor, before, limit).changes);
      }
    }
    return n;
  }

  /** Drop hour rows before `beforeHour`, day rows and all-time snapshots before `beforeDay`. */
  pruneActivity(beforeHour: number, beforeDay: number): void {
    this.q('DELETE FROM activity_hour WHERE hour < ?').run(beforeHour);
    this.q('DELETE FROM activity_day WHERE day < ?').run(beforeDay);
    this.q('DELETE FROM cum_pnl_day WHERE day < ?').run(beforeDay);
  }

  // --- window PnL ---------------------------------------------------------------

  putPnl(venue: Venue, window: BoardWindow, rows: ReadonlyArray<{ address: string; pnl: number; volume: number | null }>, snapshot: number, now: number): void {
    if (!rows.length) return;
    const up = this.q(
      `INSERT INTO pnl_snap (venue, win, address, pnl, volume, snapshot, at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (venue, win, address) DO UPDATE SET pnl = excluded.pnl, volume = excluded.volume,
         snapshot = excluded.snapshot, at = excluded.at`,
    );
    this.tx(() => {
      for (const r of rows) up.run(venue, window, r.address, r.pnl, r.volume, snapshot, now);
    });
  }

  pnlOf(venue: Venue, window: BoardWindow, address: string): { pnl: number; volume: number | null; snapshot: number; at: number } | null {
    const r = this.q('SELECT pnl, volume, snapshot, at FROM pnl_snap WHERE venue = ? AND win = ? AND address = ?').get(venue, window, address) as
      | Record<string, number | null>
      | undefined;
    if (!r) return null;
    return { pnl: r.pnl as number, volume: num(r.volume), snapshot: r.snapshot as number, at: r.at as number };
  }

  /** Every account with a PnL for the window, sorted (asc for worst, desc for top). */
  pnlRanked(venue: Venue, window: BoardWindow, side: Side, minSnapshot: number, limit: number): Array<{ address: string; pnl: number; volume: number | null }> {
    const order = side === 'worst' ? 'ASC' : 'DESC';
    return this.q(
      `SELECT address, pnl, volume FROM pnl_snap WHERE venue = ? AND win = ? AND snapshot >= ? ORDER BY pnl ${order} LIMIT ?`,
    ).all(venue, window, minSnapshot, limit) as Array<{ address: string; pnl: number; volume: number | null }>;
  }

  putCumPnl(venue: Venue, day: number, rows: ReadonlyArray<{ address: string; pnl: number }>): void {
    if (!rows.length) return;
    const up = this.q(
      `INSERT INTO cum_pnl_day (venue, day, address, pnl) VALUES (?, ?, ?, ?)
       ON CONFLICT (venue, day, address) DO UPDATE SET pnl = excluded.pnl`,
    );
    this.tx(() => {
      for (const r of rows) up.run(venue, day, r.address, r.pnl);
    });
  }

  /** Earliest day with an all-time PnL snapshot. */
  cumPnlSince(venue: Venue): number | null {
    const r = this.q('SELECT MIN(day) AS d FROM cum_pnl_day WHERE venue = ?').get(venue) as { d?: number | null };
    return num(r?.d);
  }

  /** All-time PnL of every account on the latest snapshot day at or before `day`. */
  cumPnlAt(venue: Venue, day: number): Map<string, number> {
    const d = this.q('SELECT MAX(day) AS d FROM cum_pnl_day WHERE venue = ? AND day <= ?').get(venue, day) as { d?: number | null };
    if (d?.d == null) return new Map();
    const rows = this.q('SELECT address, pnl FROM cum_pnl_day WHERE venue = ? AND day = ?').all(venue, d.d) as Array<{ address: string; pnl: number }>;
    return new Map(rows.map((r) => [r.address, r.pnl]));
  }

  // --- netting ---------------------------------------------------------------------------

  /** Replace one venue's rows for a window. */
  writeTraderWin(venue: Venue, window: BoardWindow, rows: readonly TraderWin[]): void {
    this.tx(() => {
      this.q('DELETE FROM trader_win WHERE venue = ? AND win = ?').run(venue, window);
      const ins = this.q(
        `INSERT INTO trader_win (venue, win, address, pool, pnl, volume, trades, exact, wins, closes, account_value, label, assets, win_exact)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of rows) {
        ins.run(
          venue, window, r.address, r.pool, r.pnl, r.volume, r.trades, r.exact ? 1 : 0, r.wins, r.closes,
          r.accountValue, r.label, JSON.stringify(r.assets.slice(0, 3)), r.winExact ? 1 : 0,
        );
      }
    });
  }

  /**
   * Every address in a selected venue's `side` pool, with its figures summed
   * over the selected venues (an address has one row per venue it trades on).
   */
  netCandidates(venues: readonly Venue[], window: BoardWindow, side: Side): NetRow[] {
    if (!venues.length) return [];
    const inList = venues.map(() => '?').join(', ');
    const rows = this.db.prepare(
      `SELECT t.address, t.venue, t.pnl, t.volume, t.trades, t.exact, t.wins, t.closes, t.account_value, t.label, t.assets,
         t.win_exact, a.account_id
       FROM trader_win t
       LEFT JOIN accounts a ON a.venue = t.venue AND a.address = t.address
       WHERE t.win = ? AND t.venue IN (${inList}) AND t.address IN (
         SELECT address FROM trader_win WHERE win = ? AND venue IN (${inList}) AND pool = ?)`,
    ).all(window, ...venues, window, ...venues, side) as Array<Record<string, unknown>>;
    const by = new Map<string, NetRow>();
    const add = (a: number | null, b: unknown): number | null => (typeof b === 'number' ? (a ?? 0) + b : a);
    for (const r of rows) {
      const address = r.address as string;
      let assets: string[] = [];
      try {
        const x = JSON.parse(String(r.assets ?? '[]'));
        if (Array.isArray(x)) assets = x.filter((s): s is string => typeof s === 'string');
      } catch { /* none */ }
      const cur = by.get(address) ?? {
        address, venues: [], pnl: 0, volume: null, trades: null, exact: true, wins: null, closes: null, winExact: true,
        accountValue: null, label: null, assets: [],
      };
      cur.venues.push(r.venue as Venue);
      cur.pnl += r.pnl as number;
      cur.volume = add(cur.volume, r.volume);
      cur.trades = add(cur.trades, r.trades);
      cur.exact = cur.exact && r.exact === 1;
      cur.wins = add(cur.wins, r.wins);
      cur.closes = add(cur.closes, r.closes);
      // Exact only when every venue in the sum holds its whole window of closes.
      cur.winExact = cur.winExact && r.win_exact === 1 && typeof r.closes === 'number';
      cur.accountValue = add(cur.accountValue, r.account_value);
      cur.label = cur.label ?? (typeof r.label === 'string' ? r.label : null);
      cur.assets = [...new Set([...cur.assets, ...assets])];
      if (r.venue === 'sodex' && typeof r.account_id === 'number') cur.accountId = r.account_id;
      by.set(address, cur);
    }
    return [...by.values()];
  }

  // --- cohorts ------------------------------------------------------------------

  putCohortMembers(venue: Venue, rows: ReadonlyArray<CohortMemberRow>, at: number): void {
    if (!rows.length) return;
    this.tx(() => {
      const ins = this.q(
        'INSERT OR REPLACE INTO cohort_member (venue, address, pnl, equity, label, at, pnl_1d, pnl_7d, pnl_30d, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      let rev = this.takeRevs(rows.length);
      for (const r of rows) ins.run(venue, r.address, r.pnl, r.equity, r.label, at, r.pnl1d ?? null, r.pnl7d ?? null, r.pnl30d ?? null, rev++);
    });
  }

  /** Every address a venue's member table holds. */
  cohortMemberAddresses(venue: Venue): string[] {
    return (this.q('SELECT address FROM cohort_member WHERE venue = ?').all(venue) as Array<{ address: string }>).map((r) => r.address);
  }

  /** Members that left the set: the API thread would otherwise keep counting them (with no book, as "not covered"). */
  dropCohortMembers(venue: Venue, addresses: readonly string[], now = Date.now()): void {
    this.tx(() => {
      // Kept in cohort_member_gone as they were (retention.ts): out of the cohorts, not lost.
      const keep = this.q(`INSERT OR REPLACE INTO cohort_member_gone (venue, address, pnl, equity, label, at, pnl_1d, pnl_7d, pnl_30d, gone_at)
        SELECT venue, address, pnl, equity, label, at, pnl_1d, pnl_7d, pnl_30d, ? FROM cohort_member WHERE venue = ? AND address = ?`);
      const del = this.q('DELETE FROM cohort_member WHERE venue = ? AND address = ?');
      // A tombstone per row removed, so the API's load drops it too (COHORT_REV_SCHEMA).
      const tomb = this.q("INSERT OR REPLACE INTO cohort_tomb (venue, kind, address, rev, at) VALUES (?, 'm', ?, ?, ?)");
      const gone: string[] = [];
      for (const a of addresses) {
        keep.run(now, venue, a);
        if (Number(del.run(venue, a).changes)) gone.push(a);
      }
      let rev = gone.length ? this.takeRevs(gone.length) : 0;
      for (const a of gone) tomb.run(venue, a, rev++, now);
      this.pruneTombs(now);
    });
  }

  cohortMembers(venue: Venue): Map<string, CohortMemberRow> {
    const out = new Map<string, CohortMemberRow>();
    for (const r of this.q('SELECT address, pnl, equity, label, pnl_1d, pnl_7d, pnl_30d FROM cohort_member WHERE venue = ?').all(venue) as Array<Record<string, unknown>>) {
      out.set(r.address as string, memberRow(r));
    }
    return out;
  }

  /**
   * cohortMembers a page at a time, in the same (address) order: `limit` rows
   * after `after` ('' starts). For a reader that lets other work run between
   * pages (indexer/read.ts): one statement over a venue's 170k members holds
   * the thread for a second.
   */
  cohortMembersPage(venue: Venue, after: string, limit: number): CohortMemberRow[] {
    return (this.q('SELECT address, pnl, equity, label, pnl_1d, pnl_7d, pnl_30d FROM cohort_member WHERE venue = ? AND address > ? ORDER BY address LIMIT ?')
      .all(venue, after, limit) as Array<Record<string, unknown>>).map(memberRow);
  }

  /** Every PnL a venue's window list gave the index (address -> PnL). */
  pnlWindow(venue: Venue, window: BoardWindow, minAt = 0): Map<string, number> {
    const out = new Map<string, number>();
    for (const r of this.q('SELECT address, pnl FROM pnl_snap WHERE venue = ? AND win = ? AND at >= ?').all(venue, window, minAt) as Array<{ address: string; pnl: number }>) {
      out.set(r.address, r.pnl);
    }
    return out;
  }

  /** The largest books a cohort read found on a venue, largest first. */
  topCohortBooks(venue: Venue, limit: number): string[] {
    return (this.q('SELECT address FROM cohort_book WHERE venue = ? AND equity IS NOT NULL ORDER BY equity DESC LIMIT ?').all(venue, limit) as Array<{ address: string }>)
      .map((r) => r.address);
  }

  /** A cohort read's equity for one wallet (null if never read). */
  cohortEquity(venue: Venue, address: string): number | null {
    const r = this.q('SELECT equity FROM cohort_book WHERE venue = ? AND address = ?').get(venue, address) as { equity?: number | null } | undefined;
    return num(r?.equity);
  }

  putCohortBooks(rows: ReadonlyArray<{
    venue: Venue; address: string; equity: number | null; positions: ReadonlyArray<BookPosition>; at: number;
    collateral?: number | null; spotAt?: number | null; cash?: number | null;
  }>): void {
    this.tx(() => {
      const ins = this.q('INSERT OR REPLACE INTO cohort_book (venue, address, equity, positions, at, collateral, spot_at, cash, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      let rev = rows.length ? this.takeRevs(rows.length) : 0;
      for (const r of rows) {
        ins.run(r.venue, r.address, r.equity, JSON.stringify(r.positions.map(bookEntry)), r.at, r.collateral ?? null, r.spotAt ?? null, r.cash ?? null, rev++);
      }
    });
  }

  /** Every wallet's book on a venue: positions as the stream keeps them. */
  cohortBooks(venue: Venue): Map<string, CohortBookRow> {
    const out = new Map<string, CohortBookRow>();
    for (const r of this.q('SELECT address, equity, positions, at, collateral, spot_at, cash FROM cohort_book WHERE venue = ?').all(venue) as Array<Record<string, unknown>>) {
      out.set(r.address as string, bookRow(r));
    }
    return out;
  }

  /** One wallet's book on a venue (null if it was never read). */
  cohortBook(venue: Venue, address: string): CohortBookRow | null {
    const r = this.q('SELECT equity, positions, at, collateral, spot_at, cash FROM cohort_book WHERE venue = ? AND address = ?').get(venue, address) as Record<string, unknown> | undefined;
    return r ? bookRow(r) : null;
  }

  /** cohortBooks a page at a time, in the same (address) order (see cohortMembersPage). */
  cohortBooksPage(venue: Venue, after: string, limit: number): Array<[string, CohortBookRow]> {
    return (this.q('SELECT address, equity, positions, at, collateral, spot_at, cash FROM cohort_book WHERE venue = ? AND address > ? ORDER BY address LIMIT ?')
      .all(venue, after, limit) as Array<Record<string, unknown>>).map((r) => [r.address as string, bookRow(r)]);
  }

  putCohortMarks(rows: ReadonlyArray<[string, number]>, at: number): void {
    this.tx(() => {
      const ins = this.q('INSERT OR REPLACE INTO cohort_mark (key, px, at) VALUES (?, ?, ?)');
      for (const [k, px] of rows) ins.run(k, px, at);
    });
  }

  /** `venue|symbol` -> last price. */
  cohortMarks(): Map<string, number> {
    const out = new Map<string, number>();
    for (const r of this.q('SELECT key, px FROM cohort_mark').all() as Array<{ key: string; px: number }>) out.set(r.key, r.px);
    return out;
  }

  /** `rebuilt`: rebuilt for an hour the index did not record (cohortRebuild.ts), not recorded. */
  putCohortSeries(rows: ReadonlyArray<{ scope: string; cohort: string; t: number; long: number; short: number; rebuilt?: boolean }>): void {
    this.tx(() => {
      const ins = this.q('INSERT OR REPLACE INTO cohort_series (scope, cohort, t, lng, shrt, wallets, covered, src) VALUES (?, ?, ?, ?, ?, 0, 0, ?)');
      for (const r of rows) ins.run(r.scope, r.cohort, r.t, r.long, r.short, r.rebuilt ? 1 : 0);
    });
  }

  cohortSeries(scope: string, fromT: number, cohort?: string, toT = Number.MAX_SAFE_INTEGER): Array<{ cohort: string; t: number; long: number; short: number; rebuilt: boolean }> {
    const rows = (cohort
      ? this.q('SELECT cohort, t, lng, shrt, src FROM cohort_series WHERE scope = ? AND cohort = ? AND t >= ? AND t <= ? ORDER BY t').all(scope, cohort, fromT, toT)
      : this.q('SELECT cohort, t, lng, shrt, src FROM cohort_series WHERE scope = ? AND t >= ? AND t <= ? ORDER BY t').all(scope, fromT, toT)) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ cohort: String(r.cohort), t: Number(r.t), long: Number(r.lng), short: Number(r.shrt), rebuilt: Number(r.src) === 1 }));
  }

  /** When a scope's cohort was recorded (not rebuilt), from `fromT` on: the gaps between are what a rebuild fills. */
  cohortSeriesRecorded(scope: string, cohort: string, fromT: number): number[] {
    return (this.q('SELECT t FROM cohort_series WHERE scope = ? AND cohort = ? AND t >= ? AND src = 0 ORDER BY t').all(scope, cohort, fromT) as Array<{ t: number }>)
      .map((r) => Number(r.t));
  }

  cohortSeriesLastT(): number {
    const r = this.q('SELECT MAX(t) AS t FROM cohort_series').get() as { t: number | null } | undefined;
    return r?.t ?? 0;
  }

  pruneCohortSeries(beforeT: number): void {
    this.q('DELETE FROM cohort_series WHERE t < ?').run(beforeT);
  }

  putCohortMix(rows: ReadonlyArray<{ scope: string; cohort: string; t: number; data: string; rebuilt?: boolean }>): void {
    this.tx(() => {
      const ins = this.q('INSERT OR REPLACE INTO cohort_mix (scope, cohort, t, data, src) VALUES (?, ?, ?, ?, ?)');
      for (const r of rows) ins.run(r.scope, r.cohort, r.t, r.data, r.rebuilt ? 1 : 0);
    });
  }

  /** Hourly per-coin and per-sector [long, short] of a cohort. */
  cohortMix(scope: string, fromT: number, cohort?: string, toT = Number.MAX_SAFE_INTEGER): Array<{ cohort: string; t: number; c: Record<string, [number, number]>; s: Record<string, [number, number]>; rebuilt: boolean }> {
    const rows = (cohort
      ? this.q('SELECT cohort, t, data, src FROM cohort_mix WHERE scope = ? AND cohort = ? AND t >= ? AND t <= ? ORDER BY t').all(scope, cohort, fromT, toT)
      : this.q('SELECT cohort, t, data, src FROM cohort_mix WHERE scope = ? AND t >= ? AND t <= ? ORDER BY t').all(scope, fromT, toT)) as Array<Record<string, unknown>>;
    return rows.flatMap((r) => {
      try {
        const d = JSON.parse(String(r.data)) as { c?: Record<string, [number, number]>; s?: Record<string, [number, number]> };
        return [{ cohort: String(r.cohort), t: Number(r.t), c: d.c ?? {}, s: d.s ?? {}, rebuilt: Number(r.src) === 1 }];
      } catch {
        return [];
      }
    });
  }

  /**
   * A history rebuild's reads (cohortRebuild.ts), per span (its first missing
   * hour): `kind` 'w' = a wallet's positions hour by hour (key: address), 'px' =
   * a symbol's hourly prices (key: symbol). JSON as the rebuild writes it.
   */
  putCohortHist(span: number, kind: string, rows: ReadonlyArray<[string, string]>, at: number): void {
    this.tx(() => {
      const ins = this.q('INSERT OR REPLACE INTO cohort_hist (span, kind, key, data, at) VALUES (?, ?, ?, ?, ?)');
      for (const [key, data] of rows) ins.run(span, kind, key, data, at);
    });
  }

  cohortHist(span: number, kind: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const r of this.q('SELECT key, data FROM cohort_hist WHERE span = ? AND kind = ?').all(span, kind) as Array<{ key: string; data: string }>) out.set(r.key, r.data);
    return out;
  }

  /** The keys of a span's kind read so far. */
  cohortHistKeys(span: number, kind: string): Set<string> {
    return new Set((this.q('SELECT key FROM cohort_hist WHERE span = ? AND kind = ?').all(span, kind) as Array<{ key: string }>).map((r) => r.key));
  }

  /** Spans with reads kept. */
  cohortHistSpans(): number[] {
    return (this.q('SELECT DISTINCT span FROM cohort_hist').all() as Array<{ span: number }>).map((r) => Number(r.span));
  }

  dropCohortHist(span: number): void {
    this.q('DELETE FROM cohort_hist WHERE span = ?').run(span);
  }

  cohortMixLastT(): number {
    const r = this.q('SELECT MAX(t) AS t FROM cohort_mix').get() as { t: number | null } | undefined;
    return r?.t ?? 0;
  }

  pruneCohortMix(beforeT: number): void {
    this.q('DELETE FROM cohort_mix WHERE t < ?').run(beforeT);
  }

  // --- liquidation levels over time (cohortTracker.ts recordLiq) ---------------------------

  putLiqHist(t: number, rows: ReadonlyArray<[string, string]>): void {
    this.tx(() => {
      const ins = this.q('INSERT OR REPLACE INTO liq_hist (coin, t, data) VALUES (?, ?, ?)');
      for (const [coin, data] of rows) ins.run(coin, t, data);
    });
  }

  /** One coin's snapshots from `fromT`, oldest first (data as written). */
  liqHist(coin: string, fromT: number): Array<{ t: number; data: string }> {
    return this.q('SELECT t, data FROM liq_hist WHERE coin = ? AND t >= ? ORDER BY t').all(coin, fromT) as Array<{ t: number; data: string }>;
  }

  /** Fine layers of the snapshots at `t` (deflated JSON, levels.ts FineSnap). */
  putLiqHistFine(t: number, rows: ReadonlyArray<[string, Uint8Array]>): void {
    this.tx(() => {
      const ins = this.q('INSERT OR REPLACE INTO liq_hist_fine (coin, t, data) VALUES (?, ?, ?)');
      for (const [coin, data] of rows) ins.run(coin, t, data);
    });
  }

  /** One coin's fine layers from `fromT` to `toT`, oldest first (deflated as written). */
  liqHistFine(coin: string, fromT: number, toT: number): Array<{ t: number; data: Uint8Array }> {
    return this.q('SELECT t, data FROM liq_hist_fine WHERE coin = ? AND t >= ? AND t <= ? ORDER BY t').all(coin, fromT, toT) as Array<{ t: number; data: Uint8Array }>;
  }

  /** When a coin's fine layers begin (null: none yet). */
  liqHistFineFrom(coin: string): number | null {
    return (this.q('SELECT MIN(t) AS t FROM liq_hist_fine WHERE coin = ?').get(coin) as { t: number | null }).t;
  }

  /** Every coin's levels now (cohortTracker.ts recordLiq), replacing the last pass; coins not in it are dropped. */
  putLiqNow(at: number, rows: ReadonlyArray<[string, Uint8Array]>): void {
    this.tx(() => {
      const ins = this.q('INSERT OR REPLACE INTO liq_now (coin, at, data) VALUES (?, ?, ?)');
      for (const [coin, data] of rows) ins.run(coin, at, data);
      this.q('DELETE FROM liq_now WHERE at < ?').run(at);
    });
  }

  /** One coin's levels now (deflated JSON, liquidations/levels.ts LiqNow), or null. */
  liqNow(coin: string): { at: number; data: Uint8Array } | null {
    return (this.q('SELECT at, data FROM liq_now WHERE coin = ?').get(coin) as { at: number; data: Uint8Array } | undefined) ?? null;
  }

  /** The coins of the newest snapshot. */
  liqHistCoins(): string[] {
    return (this.q('SELECT coin FROM liq_hist WHERE t = (SELECT MAX(t) FROM liq_hist)').all() as Array<{ coin: string }>).map((r) => r.coin);
  }

  liqHistLastT(): number {
    const r = this.q('SELECT MAX(t) AS t FROM liq_hist').get() as { t: number | null } | undefined;
    return r?.t ?? 0;
  }

  /** Drop everything before `beforeT`, and between it and `thinBeforeT` all but the hourly snapshots (and their fine layers). */
  pruneLiqHist(beforeT: number, thinBeforeT: number, hourMs: number): void {
    this.q('DELETE FROM liq_hist WHERE t < ?').run(beforeT);
    this.q('DELETE FROM liq_hist WHERE t < ? AND t % ? != 0').run(thinBeforeT, hourMs);
    // The fine layers go with their snapshots.
    this.q('DELETE FROM liq_hist_fine WHERE t < ?').run(beforeT);
    this.q('DELETE FROM liq_hist_fine WHERE t < ? AND t % ? != 0').run(thinBeforeT, hourMs);
  }

  // --- the level change log (liq_addr, liq_log, liq_cur) ------------------------------------

  /** Every address the log knows, by id (the tracker holds them; a new one gets its id in putLiqLog). */
  liqAddrs(): Map<string, number> {
    const out = new Map<string, number>();
    for (const r of this.q('SELECT id, address FROM liq_addr').all() as Array<{ id: number; address: string }>) out.set(r.address, r.id);
    return out;
  }

  /** Ids of `addresses` the log knows (a reader: none are made). */
  liqAddrIds(addresses: readonly string[]): Map<string, number> {
    const out = new Map<string, number>();
    const q = this.q('SELECT id FROM liq_addr WHERE address = ?');
    for (const a of addresses) {
      const r = q.get(a) as { id?: number } | undefined;
      if (r?.id !== undefined) out.set(a, r.id);
    }
    return out;
  }

  /** The change log's first step (null: empty). A whole scan: once, at the writer's first step. */
  liqLogFrom(): number | null {
    return (this.q('SELECT MIN(t) AS t FROM liq_log').get() as { t: number | null }).t;
  }

  /** Every open position's last logged state. */
  liqCur(): Array<{ aid: number; coin: string; venue: number; side: number; liq: number; usd: number; t: number }> {
    return this.q('SELECT aid, coin, venue, side, liq, usd, t FROM liq_cur').all() as Array<{ aid: number; coin: string; venue: number; side: number; liq: number; usd: number; t: number }>;
  }

  /**
   * One step of the change log: new addresses get ids, a changed or new position a row (and its
   * current state), a closed one a row with usd 0 (and leaves the current state). One transaction.
   * Returns the ids given to `newAddrs`.
   */
  putLiqLog(
    t: number,
    newAddrs: readonly string[],
    changed: ReadonlyArray<{ aid: number | string; coin: string; venue: number; side: number; liq: number; usd: number } & LiqLogExtra>,
    closed: ReadonlyArray<{ aid: number; coin: string; venue: number; mark?: number | null }>,
  ): Map<string, number> {
    const ids = new Map<string, number>();
    this.tx(() => {
      const addr = this.q('INSERT INTO liq_addr (address) VALUES (?) ON CONFLICT (address) DO UPDATE SET address = excluded.address RETURNING id');
      for (const a of newAddrs) {
        const r = addr.get(a) as { id: number };
        ids.set(a, r.id);
      }
      const log = this.q(`INSERT OR REPLACE INTO liq_log (aid, coin, venue, t, side, liq, usd, sym, sz, entry, mark, iso, lev, eq, cash, read_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const cur = this.q('INSERT OR REPLACE INTO liq_cur (aid, coin, venue, side, liq, usd, t) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const n = (v: number | null | undefined) => (v === undefined || v === null || !Number.isFinite(v) ? null : v);
      for (const c of changed) {
        const aid = typeof c.aid === 'number' ? c.aid : ids.get(c.aid)!;
        log.run(aid, c.coin, c.venue, t, c.side, c.liq, c.usd, c.sym ?? null, n(c.sz), n(c.entry), n(c.mark),
          c.iso === undefined || c.iso === null ? null : c.iso ? 1 : 0, n(c.lev), n(c.eq), n(c.cash), n(c.readAt));
        cur.run(aid, c.coin, c.venue, c.side, c.liq, c.usd, t);
      }
      const del = this.q('DELETE FROM liq_cur WHERE aid = ? AND coin = ? AND venue = ?');
      for (const c of closed) {
        log.run(c.aid, c.coin, c.venue, t, 0, 0, 0, null, 0, null, n(c.mark), null, null, null, null, null);
        del.run(c.aid, c.coin, c.venue);
      }
    });
    return ids;
  }

  /**
   * The log of some addresses for a coin from `fromT` on, oldest first - with, for each of their
   * positions, the last row before `fromT` (its state when the range begins). Each row carries what
   * its leverage is read from (liqRead.ts logLev): size, mark, isolated or not, leverage, equity
   * (null in rows before 2026-10-29).
   */
  liqLog(aids: readonly number[], coin: string, fromT: number): Array<{ aid: number; venue: number; t: number; side: number; liq: number; usd: number; sz: number | null; mark: number | null; iso: number | null; lev: number | null; eq: number | null }> {
    type Row = { aid: number; venue: number; t: number; side: number; liq: number; usd: number; sz: number | null; mark: number | null; iso: number | null; lev: number | null; eq: number | null };
    const out: Row[] = [];
    const cols = 'aid, venue, t, side, liq, usd, sz, mark, iso, lev, eq';
    const before = this.q(`SELECT ${cols} FROM liq_log WHERE aid = ? AND coin = ? AND venue = ? AND t < ? ORDER BY t DESC LIMIT 1`);
    const venues = this.q('SELECT DISTINCT venue FROM liq_log WHERE aid = ? AND coin = ?');
    const after = this.q(`SELECT ${cols} FROM liq_log WHERE aid = ? AND coin = ? AND t >= ? ORDER BY t`);
    for (const aid of aids) {
      for (const v of venues.all(aid, coin) as Array<{ venue: number }>) {
        const r = before.get(aid, coin, v.venue, fromT) as Row | undefined;
        if (r && r.usd > 0) out.push(r);
      }
      out.push(...(after.all(aid, coin, fromT) as Row[]));
    }
    return out.sort((a, b) => a.t - b.t);
  }

  /**
   * Every position whose liquidation level stood in [lo, hi) at time `t` on `venues`, by its
   * row in force then: the positions with any row of that coin in the range up to `t` (the cell
   * index), then each one's last row up to `t` by its key - kept when it is open, in the range
   * and on that side. Each comes with when its current run began (the row after its last close)
   * and its next row after `t` (what happened next: a move, a close - null while unchanged).
   */
  liqAt(coin: string, venues: readonly number[], t: number, lo: number, hi: number, side: 1 | -1 | 0 = 0): LiqAtRow[] {
    const cand = this.q('SELECT DISTINCT aid, venue FROM liq_log WHERE coin = ? AND liq >= ? AND liq < ? AND t <= ?').all(coin, lo, hi, t) as Array<{ aid: number; venue: number }>;
    const at = this.q(`SELECT l.aid, a.address, l.venue, l.t, l.side, l.liq, l.usd, l.sym, l.sz, l.entry, l.mark, l.iso, l.lev, l.eq, l.cash, l.read_at
      FROM liq_log l JOIN liq_addr a ON a.id = l.aid WHERE l.aid = ? AND l.coin = ? AND l.venue = ? AND l.t <= ? ORDER BY l.t DESC LIMIT 1`);
    const lastClose = this.q('SELECT MAX(t) AS t FROM liq_log WHERE aid = ? AND coin = ? AND venue = ? AND t <= ? AND usd = 0');
    const since = this.q('SELECT MIN(t) AS t FROM liq_log WHERE aid = ? AND coin = ? AND venue = ? AND t > ? AND t <= ?');
    const next = this.q('SELECT t, side, liq, usd, mark FROM liq_log WHERE aid = ? AND coin = ? AND venue = ? AND t > ? ORDER BY t LIMIT 1');
    const want = new Set(venues);
    const out: LiqAtRow[] = [];
    for (const c of cand) {
      if (want.size && !want.has(c.venue)) continue;
      const r = at.get(c.aid, coin, c.venue, t) as (Omit<LiqAtRow, 'since' | 'next'> & { read_at: number | null }) | undefined;
      if (!r || r.usd <= 0 || r.liq < lo || r.liq >= hi || (side && r.side !== side)) continue;
      const closedAt = (lastClose.get(c.aid, coin, c.venue, t) as { t: number | null }).t ?? -1;
      const first = (since.get(c.aid, coin, c.venue, closedAt, t) as { t: number | null }).t;
      const nx = next.get(c.aid, coin, c.venue, t) as LiqAtRow['next'] | undefined;
      const { read_at, ...rest } = r;
      out.push({ ...rest, readAt: read_at, since: first ?? r.t, next: nx ?? null });
    }
    return out.sort((a, b) => b.usd - a.usd);
  }

  /**
   * Rows older than `beforeT` that a later row (still older than it) replaces: what the state at
   * `beforeT` needs stays - each position's last row before it - and closes older than it go.
   */
  pruneLiqLog(beforeT: number): void {
    this.q(`DELETE FROM liq_log WHERE t < ?1 AND EXISTS (
      SELECT 1 FROM liq_log b WHERE b.aid = liq_log.aid AND b.coin = liq_log.coin AND b.venue = liq_log.venue AND b.t > liq_log.t AND b.t < ?1)`).run(beforeT);
    this.q('DELETE FROM liq_log WHERE t < ? AND usd = 0').run(beforeT);
  }



  /**
   * PnL read for a cohort wallet the venue's own list does not rank (Hyperliquid:
   * its portfolio, for a holder missing from the leaderboard file) - all-time and
   * the 1d / 7d / 30d windows, and when it was read.
   */
  putCohortPnl(venue: Venue, rows: ReadonlyArray<CohortPnlRow>, at: number): void {
    this.tx(() => {
      const ins = this.q('INSERT OR REPLACE INTO cohort_pnl (venue, address, pnl, pnl_1d, pnl_7d, pnl_30d, at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const r of rows) ins.run(venue, r.address, r.pnl, r.pnl1d, r.pnl7d, r.pnl30d, at);
    });
  }

  cohortPnl(venue: Venue): Map<string, CohortPnlRow & { at: number }> {
    const out = new Map<string, CohortPnlRow & { at: number }>();
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    for (const r of this.q('SELECT address, pnl, pnl_1d, pnl_7d, pnl_30d, at FROM cohort_pnl WHERE venue = ?').all(venue) as Array<Record<string, unknown>>) {
      out.set(r.address as string, { address: r.address as string, pnl: n(r.pnl), pnl1d: n(r.pnl_1d), pnl7d: n(r.pnl_7d), pnl30d: n(r.pnl_30d), at: r.at as number });
    }
    return out;
  }

  /** All-time PnL of every wallet the venue's lists gave the index. */
  pnlAll(venue: Venue): Map<string, number> {
    const out = new Map<string, number>();
    for (const r of this.q("SELECT address, pnl FROM pnl_snap WHERE venue = ? AND win = 'all'").all(venue) as Array<{ address: string; pnl: number }>) out.set(r.address, r.pnl);
    return out;
  }

  accountValues(venue: Venue): Map<string, number> {
    const out = new Map<string, number>();
    for (const r of this.q('SELECT address, account_value FROM accounts WHERE venue = ? AND account_value IS NOT NULL').all(venue) as Array<{ address: string; account_value: number }>) {
      out.set(r.address, r.account_value);
    }
    return out;
  }

  // --- stream continuity --------------------------------------------------------------

  /**
   * The stream wrote every fill of every tracked wallet from `upSince` to
   * `now` (one socket, no reconnect in between). A held range that reaches
   * into that span therefore reaches `now`: its `to_t` moves up with it, so a
   * restart later only has to re-read the downtime, not everything since the
   * last REST read. `rest_at` (the last REST read) is left alone: realised
   * PnL and closes still come only from REST rows.
   */
  advanceCoverage(venue: Venue, kinds: readonly HistoryKind[], upSince: number, now: number, onlyIndexed = false): number {
    if (this.readOnly) return 0;
    let n = 0;
    // `onlyIndexed`: the venue's prints name sub-accounts; a wallet whose indices are unknown gets none.
    const sql = onlyIndexed
      ? 'UPDATE coverage SET to_t = ? WHERE venue = ? AND kind = ? AND to_t >= ? AND to_t < ? AND address IN (SELECT address FROM ext_index WHERE venue = coverage.venue)'
      : 'UPDATE coverage SET to_t = ? WHERE venue = ? AND kind = ? AND to_t >= ? AND to_t < ?';
    this.tx(() => {
      for (const kind of kinds) n += Number(this.q(sql).run(now, venue, kind, upSince, now).changes);
    });
    return n;
  }

  /** Held ranges of a venue that stop short of `before` (to be caught up after a stream gap), most recently read first. */
  staleCoverage(venue: Venue, kind: HistoryKind, before: number, limit: number): Array<{ address: string; toT: number }> {
    return (this.q('SELECT address, to_t FROM coverage WHERE venue = ? AND kind = ? AND to_t < ? ORDER BY rest_at DESC LIMIT ?')
      .all(venue, kind, before, limit) as Array<{ address: string; to_t: number }>).map((r) => ({ address: r.address, toT: r.to_t }));
  }

  // --- per-trader figures for every surface -------------------------------------------------

  putTraderStats(rows: readonly TraderStatsRow[]): void {
    if (!rows.length || this.readOnly) return;
    const ins = this.q(
      `INSERT OR REPLACE INTO trader_stats (venue, win, address, trades, trades_exact, wins, closes, win_exact, win_from, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.tx(() => {
      for (const r of rows) {
        ins.run(r.venue, r.window, r.address, r.trades, r.tradesExact ? 1 : 0, r.wins, r.closes, r.winExact ? 1 : 0, r.winFrom, r.at);
      }
    });
  }

  /** Stats of these addresses on one venue and window (missing = not indexed). */
  traderStats(venue: Venue, window: BoardWindow, addresses: readonly string[]): Map<string, TraderStatsRow> {
    const out = new Map<string, TraderStatsRow>();
    const get = this.q('SELECT trades, trades_exact, wins, closes, win_exact, win_from, at FROM trader_stats WHERE venue = ? AND win = ? AND address = ?');
    for (const address of new Set(addresses)) {
      const r = get.get(venue, window, address) as Record<string, unknown> | undefined;
      if (!r) continue;
      out.set(address, {
        venue, window, address,
        trades: num(r.trades), tradesExact: r.trades_exact === 1,
        wins: Number(r.wins) || 0, closes: Number(r.closes) || 0,
        winExact: r.win_exact === 1, winFrom: num(r.win_from), at: Number(r.at) || 0,
      });
    }
    return out;
  }

  pruneTraderStats(beforeAt: number): void {
    this.q('DELETE FROM trader_stats WHERE at < ?').run(beforeAt);
  }

  // --- board rank snapshots ---------------------------------------------------------------

  /** Keep a board's ranks as of `t` (one snapshot per hour; older than `keepFrom` go). */
  snapshotBoardRanks(key: { venue: Venue; window: BoardWindow; side: Side; filter: BoardFilter }, t: number, ranks: ReadonlyArray<{ address: string; rank: number }>, keepFrom: number): void {
    const { venue, window, side, filter } = key;
    this.tx(() => {
      this.q('DELETE FROM board_rank WHERE venue = ? AND win = ? AND side = ? AND filter = ? AND (t = ? OR t < ?)').run(venue, window, side, filter, t, keepFrom);
      const ins = this.q('INSERT OR REPLACE INTO board_rank (venue, win, side, filter, t, address, rank) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const r of ranks) ins.run(venue, window, side, filter, t, r.address, r.rank);
    });
  }

  /** The newest snapshot taken at or before `atOrBefore`, else null. */
  boardRanksAt(key: { venue: Venue; window: BoardWindow; side: Side; filter: BoardFilter }, atOrBefore: number): { t: number; ranks: Map<string, number> } | null {
    const { venue, window, side, filter } = key;
    const r = this.q('SELECT MAX(t) AS t FROM board_rank WHERE venue = ? AND win = ? AND side = ? AND filter = ? AND t <= ?')
      .get(venue, window, side, filter, atOrBefore) as { t: number | null } | undefined;
    if (r?.t == null) return null;
    const rows = this.q('SELECT address, rank FROM board_rank WHERE venue = ? AND win = ? AND side = ? AND filter = ? AND t = ?')
      .all(venue, window, side, filter, r.t) as Array<{ address: string; rank: number }>;
    return { t: r.t, ranks: new Map(rows.map((x) => [x.address, x.rank])) };
  }

  /** The oldest snapshot of a board, if any. */
  boardRanksFirst(key: { venue: Venue; window: BoardWindow; side: Side; filter: BoardFilter }): number | null {
    const { venue, window, side, filter } = key;
    const r = this.q('SELECT MIN(t) AS t FROM board_rank WHERE venue = ? AND win = ? AND side = ? AND filter = ?')
      .get(venue, window, side, filter) as { t: number | null } | undefined;
    return r?.t ?? null;
  }

  // --- wallets a venue's rank lookup does not know ----------------------------------------------

  /** SoDEX answered "not ranked" for this wallet and window at `at` (kept across restarts). */
  putUnranked(venue: Venue, window: BoardWindow, address: string, at: number): void {
    if (this.readOnly) return;
    this.q('INSERT OR REPLACE INTO unranked (venue, win, address, at) VALUES (?, ?, ?, ?)').run(venue, window, address, at);
  }

  /** Every "not ranked" answer since `sinceAt`, as `window|address` -> when. Older ones are dropped. */
  unrankedSince(venue: Venue, sinceAt: number): Map<string, number> {
    if (!this.readOnly) this.q('DELETE FROM unranked WHERE venue = ? AND at < ?').run(venue, sinceAt);
    const rows = this.q('SELECT win, address, at FROM unranked WHERE venue = ? AND at >= ?').all(venue, sinceAt) as Array<{ win: string; address: string; at: number }>;
    return new Map(rows.map((r) => [`${r.win}|${r.address}`, r.at]));
  }

  // --- sub-account indices (venues whose stream names accounts by index) ----------------------

  putExtIndex(venue: Venue, rows: ReadonlyArray<{ idx: string; address: string }>): void {
    if (!rows.length || this.readOnly) return;
    const ins = this.q('INSERT OR REPLACE INTO ext_index (venue, idx, address) VALUES (?, ?, ?)');
    this.tx(() => {
      for (const r of rows) ins.run(venue, r.idx, r.address);
    });
  }

  extIndex(venue: Venue): Map<string, string> {
    return new Map((this.q('SELECT idx, address FROM ext_index WHERE venue = ?').all(venue) as Array<{ idx: string; address: string }>).map((r) => [r.idx, r.address]));
  }

  // --- boards -------------------------------------------------------------------

  writeBoard(meta: BoardMeta, rows: readonly BoardRow[]): void {
    this.tx(() => {
      this.q('DELETE FROM boards WHERE venue = ? AND win = ? AND side = ? AND filter = ?').run(meta.venue, meta.window, meta.side, meta.filter);
      const ins = this.q(
        `INSERT INTO boards (venue, win, side, filter, rank, address, label, account_id, pnl, volume, trades,
           trades_capped, win_rate, account_value, assets, win_exact, win_closes, win_from, rank_change)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of rows) {
        ins.run(
          meta.venue, meta.window, meta.side, meta.filter, r.rank, r.address, r.label, r.accountId, r.pnl, r.volume, r.trades,
          r.tradesCapped ? 1 : 0, r.winRate, r.accountValue, JSON.stringify(r.assets),
          r.winExact == null ? null : r.winExact ? 1 : 0, r.winCloses ?? null, r.winFrom ?? null, r.rankChange ?? null,
        );
      }
      this.q(
        `INSERT INTO board_meta (venue, win, side, filter, updated_at, source_at, complete, pending, scanned, note, rank_since)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (venue, win, side, filter) DO UPDATE SET updated_at = excluded.updated_at,
           source_at = excluded.source_at, complete = excluded.complete, pending = excluded.pending,
           scanned = excluded.scanned, note = excluded.note, rank_since = excluded.rank_since`,
      ).run(
        meta.venue, meta.window, meta.side, meta.filter, meta.updatedAt, meta.sourceAt, meta.complete ? 1 : 0,
        meta.pending, meta.scanned, meta.note, meta.rankSince ?? null,
      );
    });
  }

  readBoard(venue: Venue, window: BoardWindow, side: Side, filter: BoardFilter): { meta: BoardMeta; rows: BoardRow[] } | null {
    const m = this.q('SELECT * FROM board_meta WHERE venue = ? AND win = ? AND side = ? AND filter = ?').get(venue, window, side, filter) as
      | Record<string, unknown>
      | undefined;
    if (!m) return null;
    const rows = (this.q(
      'SELECT * FROM boards WHERE venue = ? AND win = ? AND side = ? AND filter = ? ORDER BY rank',
    ).all(venue, window, side, filter) as Array<Record<string, unknown>>).map((r): BoardRow => {
      let assets: string[] = [];
      try {
        const a = JSON.parse(String(r.assets ?? '[]'));
        if (Array.isArray(a)) assets = a.filter((s): s is string => typeof s === 'string');
      } catch { /* a corrupt cell reads as no assets */ }
      return {
        rank: r.rank as number,
        venue,
        address: r.address as string,
        label: typeof r.label === 'string' ? r.label : null,
        accountId: num(r.account_id),
        pnl: r.pnl as number,
        volume: num(r.volume),
        trades: num(r.trades),
        tradesCapped: r.trades_capped === 1,
        winRate: num(r.win_rate),
        winExact: r.win_exact === 1,
        winCloses: num(r.win_closes),
        winFrom: num(r.win_from),
        rankChange: num(r.rank_change),
        accountValue: num(r.account_value),
        assets,
      };
    });
    return {
      meta: {
        venue,
        window,
        side,
        filter,
        updatedAt: m.updated_at as number,
        sourceAt: m.source_at as number,
        complete: m.complete === 1,
        pending: m.pending as number,
        scanned: m.scanned as number,
        note: typeof m.note === 'string' ? m.note : null,
        rankSince: num(m.rank_since),
      },
      rows,
    };
  }

  /** Board rows for an address across every board (a trader's standing). */
  boardsOf(venue: Venue, address: string): Array<{ window: BoardWindow; side: Side; filter: BoardFilter; rank: number }> {
    return this.q('SELECT win AS "window", side, filter, rank FROM boards WHERE venue = ? AND address = ?').all(venue, address) as Array<{
      window: BoardWindow;
      side: Side;
      filter: BoardFilter;
      rank: number;
    }>;
  }
}

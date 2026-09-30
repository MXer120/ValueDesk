/**
 * The leaderboard index on disk (SQLite, node:sqlite, WAL).
 *
 * One writer (the indexer, in-process in dev or `npm run indexer` in
 * production) and any number of readers (API processes) share one file. WAL
 * lets readers run while the writer commits, so a leaderboard request never
 * waits on the crawl. Everything the API needs is precomputed into `boards`;
 * a request is one indexed SELECT.
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
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deviceKeyPath } from '../deviceKey.js';
import type { BoardWindow, Venue } from '../valuescan/types.js';
import type { BoardFilter, Side } from './windows.js';
import { closeRuns, type CloseFill } from '../valuescan/winRate.js';

export const SCHEMA_VERSION = 1;

export function defaultDbPath(): string {
  return process.env.VALUESCAN_INDEX_DB?.trim() || join(dirname(deviceKeyPath()), 'valuescan-index.db');
}

/** History kinds a coverage row can describe. HL has one fill history; SoDEX one per engine plus closes. */
export type HistoryKind = 'fills' | 'perps' | 'spot' | 'closes';

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
CREATE TABLE IF NOT EXISTS cohort_book (
  venue TEXT NOT NULL, address TEXT NOT NULL, equity REAL, positions TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (venue, address)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS cohort_mark (
  key TEXT PRIMARY KEY, px REAL NOT NULL, at INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS cohort_mix (
  scope TEXT NOT NULL, cohort TEXT NOT NULL, t INTEGER NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (scope, cohort, t)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS cohort_series (
  scope TEXT NOT NULL, cohort TEXT NOT NULL, t INTEGER NOT NULL, lng REAL NOT NULL, shrt REAL NOT NULL,
  wallets INTEGER NOT NULL, covered INTEGER NOT NULL,
  PRIMARY KEY (scope, cohort, t)) WITHOUT ROWID;
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
];

/**
 * The close definition the day aggregates were built with (valuescan/winRate.ts).
 *   1 (none recorded)  one close per order id
 *   2                  runs of reducing fills
 *   3                  as 2, and a REST fill with no realised PnL (Lighter sends
 *                      null, not 0, on an opening fill) ends a run: only Lighter
 *                      is re-summed for it
 */
export const CLOSES_DEF = '3';

const DAY = 86_400_000;
/** While a trader's aggregates build, trade counts stop here (the boards only test for > 1). */
const PARTIAL_CAP = 1_000;

/** The SQL twin of windows.ts `tradeKey`. */
const ORDER_KEY = `t || '|' || symbol || '|' || side`;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

type DayAgg = { trades: number; volume: number; closes: number; wins: number; syms: Map<string, number> };
/** A day being summed: distinct trades so far (plus the ones at `lastT`), volume, markets, REST fills for closes. */
type DayAcc = { trades: number; lastT: number; atT: Set<string>; volume: number; syms: Map<string, number>; rest: CloseFill[] };
/** A resumable scan of one trader's fills over [from, to), `cursor` = where it goes on. */
type ScanJob = { venue: Venue; address: string; from: number; to: number; cursor: number; days: Map<number, DayAcc> };
/** Rows per scan step: a few ms of work. */
const SCAN_CHUNK = 1_000;
/** A dirty day larger than this is summed in the background instead of at once. */
const SYNC_DAY_ROWS = 3_000;

/** Hyperliquid's HIP-3 dex "xyz": its fills and held ranges are mirrored under `tradexyz`. */
const XYZ = 'xyz:';

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
  private readonly readOnly: boolean;
  /**
   * A dirty day is summed again at most this often. A market maker's "today"
   * gets fills every second and is tens of thousands of rows: summing it on
   * every read was most of the worker's time (profiled 2026-09-29).
   */
  private readonly aggRefreshMs: number;
  private refreshedAt = new Map<string, number>();

  version(venue: Venue, address: string): number {
    return this.versions.get(`${venue}|${address}`) ?? 0;
  }

  private bump(venue: Venue, address: string): void {
    const k = `${venue}|${address}`;
    this.versions.set(k, (this.versions.get(k) ?? 0) + 1);
  }

  constructor(readonly path: string = defaultDbPath(), opts: { readOnly?: boolean; aggRefreshMs?: number } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, opts.readOnly ? { readOnly: true } : {});
    this.readOnly = !!opts.readOnly;
    this.aggRefreshMs = opts.aggRefreshMs ?? 10 * 60_000;
    this.db.exec('PRAGMA busy_timeout = 5000');
    if (!opts.readOnly) {
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
      this.db.exec(SCHEMA);
      this.addColumns();
      this.setMeta('schema', String(SCHEMA_VERSION));
      // 2026-09-28: Arcus fills were stored with the fee inside closedPnl. Re-read them.
      if (this.getMeta('arcus_gross_pnl') !== '1') {
        this.db.exec("DELETE FROM fills WHERE venue = 'arcus'; DELETE FROM coverage WHERE venue = 'arcus';");
        this.setMeta('arcus_gross_pnl', '1');
      }
    }
  }

  close(): void {
    this.db.close();
  }

  /** Add the columns newer code reads (both threads open the file; either may get there first). */
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
    // From 2 only Lighter's sums change (its opening fills carry a null PnL).
    const venues = was === '2' ? "venue = 'lighter'" : "venue != 'sodex'";
    const rows = this.q(`SELECT venue, address FROM fill_agg WHERE ${venues} AND built_at < ?`).all(since) as Array<{ venue: Venue; address: string }>;
    for (const r of rows) this.queueAgg(r.venue, r.address, true);
    this.migrating = true;
    if (!rows.length) this.finishMigration();
    return rows.length;
  }

  private migrating = false;

  private finishMigration(): void {
    this.migrating = false;
    this.setMeta('closes_def', CLOSES_DEF);
  }

  /** Traders whose aggregates are building (first builds, and re-sums under a new definition). */
  get aggBacklog(): { first: number; rebuild: number; days: number } {
    return { first: this.building.size, rebuild: this.rebuilding.size, days: this.dayJobs.size };
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

  // --- fills / closes / coverage ---------------------------------------------

  /**
   * Insert fills. A REST row replaces a stream row with the same id; a stream
   * row never downgrades a REST row. Hyperliquid fills on the HIP-3 dex "xyz"
   * (`xyz:*`) are also filed under `tradexyz`, which is ranked on its own.
   */
  putFills(input: readonly FillRow[]): void {
    if (!input.length) return;
    const rows = [...input];
    for (const f of input) if (f.venue === 'hyperliquid' && f.symbol.startsWith(XYZ)) rows.push({ ...f, venue: 'tradexyz' });
    const ins = this.q(
      `INSERT INTO fills (venue, address, id, t, symbol, side, px, sz, fee, closed_pnl, oid, src)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (venue, address, id) DO UPDATE SET
         t = excluded.t, symbol = excluded.symbol, side = excluded.side, px = excluded.px, sz = excluded.sz,
         fee = excluded.fee, closed_pnl = excluded.closed_pnl, oid = excluded.oid, src = excluded.src
       WHERE excluded.src >= fills.src`,
    );
    this.tx(() => {
      for (const f of rows) {
        ins.run(f.venue, f.address, f.id, f.t, f.symbol, f.side, f.px, f.sz, f.fee, f.closedPnl, f.oid, f.src);
      }
      for (const a of new Set(rows.map((f) => `${f.venue}|${f.address}`))) {
        const [venue, address] = a.split('|') as [Venue, string];
        this.bump(venue, address);
      }
    });
    for (const f of rows) this.markDay(f.venue, f.address, f.t);
  }

  putCloses(rows: readonly CloseRow[]): void {
    if (!rows.length) return;
    const ins = this.q(
      `INSERT INTO closes (venue, address, id, t, opened_t, symbol, pnl) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (venue, address, id) DO UPDATE SET t = excluded.t, opened_t = excluded.opened_t,
         symbol = excluded.symbol, pnl = excluded.pnl`,
    );
    this.tx(() => {
      for (const c of rows) ins.run(c.venue, c.address, c.id, c.t, c.openedT, c.symbol, c.pnl);
      for (const c of rows) this.bump(c.venue, c.address);
    });
    for (const c of rows) this.markDay(c.venue, c.address, c.t);
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
        const d0 = Math.floor(fromT / DAY);
        const part = this.dayRows(venue, address, fromT, (d0 + 1) * DAY).get(d0)?.trades ?? 0;
        const rest = this.q('SELECT COALESCE(SUM(trades), 0) AS n FROM fill_day WHERE venue = ? AND address = ? AND day > ?')
          .get(venue, address, d0) as { n: number };
        return part + rest.n;
      }
      if (!this.readOnly) return this.cappedTrades(venue, address, fromT, PARTIAL_CAP);
    }
    const r = this.q(
      `SELECT COUNT(DISTINCT ${ORDER_KEY}) AS n FROM fills WHERE venue = ? AND address = ? AND t >= ? AND t <= ?`,
    ).get(venue, address, fromT, toT) as { n?: number } | undefined;
    return r?.n ?? 0;
  }

  /**
   * What closed positions prove about trades since `fromT`: each close is a
   * trade, and a position opened AND closed in the window is at least two.
   */
  closeEvidence(venue: Venue, address: string, fromT: number): { closes: number; roundTrips: number } {
    const r = this.q(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN opened_t >= ? THEN 1 ELSE 0 END) AS rt FROM closes WHERE venue = ? AND address = ? AND t >= ?`,
    ).get(fromT, venue, address, fromT) as { n: number; rt: number | null };
    return { closes: r.n, roundTrips: r.rt ?? 0 };
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
    const b = this.building.get(`${venue}|${address}`) ?? this.rebuilding.get(`${venue}|${address}`);
    // Inside a build: a day it has already passed is summed again when it is done.
    if (b) {
      if (t < b.cursor) this.dirtyDays.add(`${venue}|${address}|${Math.floor(t / DAY)}`);
      return;
    }
    if (!this.aggIsReady(venue, address)) return;
    this.dirtyDays.add(`${venue}|${address}|${Math.floor(t / DAY)}`);
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
    return { venue, address, from, to, cursor: from, days: new Map() };
  }

  private accOf(job: ScanJob, d: number): DayAcc {
    let a = job.days.get(d);
    if (!a) job.days.set(d, (a = { trades: 0, lastT: Number.NaN, atT: new Set(), volume: 0, syms: new Map(), rest: [] }));
    return a;
  }

  private eat(job: ScanJob, rows: ReadonlyArray<{ t: number; symbol: string; side: number; v: number; closed_pnl: number | null; src: number }>): void {
    for (const r of rows) {
      const a = this.accOf(job, Math.floor(r.t / DAY));
      if (r.t !== a.lastT) {
        a.trades += a.atT.size;
        a.atT.clear();
        a.lastT = r.t;
      }
      a.atT.add(`${r.symbol}|${r.side}`);
      a.volume += r.v;
      a.syms.set(r.symbol, (a.syms.get(r.symbol) ?? 0) + r.v);
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
      `SELECT t, symbol, side, px * sz AS v, closed_pnl, src FROM fills
       WHERE venue = ? AND address = ? AND t >= ? AND t < ? ORDER BY t LIMIT ?`,
    ).all(job.venue, job.address, job.cursor, job.to, maxRows + 1) as Array<{ t: number; symbol: string; side: number; v: number; closed_pnl: number | null; src: number }>;
    if (rows.length <= maxRows) {
      this.eat(job, rows);
      job.cursor = job.to;
      return true;
    }
    const cut = rows[maxRows]!.t;
    if (rows[0]!.t === cut) {
      // One timestamp with more rows than a chunk: take all of it at once.
      this.eat(job, this.q(
        'SELECT t, symbol, side, px * sz AS v, closed_pnl, src FROM fills WHERE venue = ? AND address = ? AND t = ?',
      ).all(job.venue, job.address, cut) as Array<{ t: number; symbol: string; side: number; v: number; closed_pnl: number | null; src: number }>);
      job.cursor = cut + 1;
    } else {
      this.eat(job, rows.filter((r) => r.t < cut));
      job.cursor = cut;
    }
    return job.cursor >= job.to;
  }

  /** A finished job's day rows (SoDEX closes from the closes table, everyone else's by the close definition). */
  private finish(job: ScanJob): Map<number, DayAgg> {
    const out = new Map<number, DayAgg>();
    for (const [d, a] of job.days) {
      const c = job.venue === 'sodex' ? { closes: 0, wins: 0 } : closeRuns(a.rest);
      out.set(d, { trades: a.trades + a.atT.size, volume: a.volume, closes: c.closes, wins: c.wins, syms: a.syms });
    }
    if (job.venue === 'sodex') {
      for (const r of this.q(
        `SELECT t / ${DAY} AS d, COUNT(*) AS n, SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS w FROM closes
         WHERE venue = ? AND address = ? AND t >= ? AND t < ? GROUP BY d`,
      ).all(job.venue, job.address, job.from, job.to) as Array<{ d: number; n: number; w: number | null }>) {
        const x = out.get(r.d) ?? { trades: 0, volume: 0, closes: 0, wins: 0, syms: new Map<string, number>() };
        x.closes = r.n;
        x.wins = r.w ?? 0;
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
   * (valuescan/winRate.ts closeRuns): runs of reducing fills per market,
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

  private writeDays(venue: Venue, address: string, days: Map<number, DayAgg>): void {
    const ins = this.q('INSERT OR REPLACE INTO fill_day (venue, address, day, trades, volume, closes, wins, syms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const [d, x] of days) {
      const top = [...x.syms].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([s, v]) => [s, Math.round(v)]);
      ins.run(venue, address, d, x.trades, x.volume, x.closes, x.wins, JSON.stringify(top));
    }
  }

  /** Queue a trader's day aggregates to be built from its fills (buildAggregates). */
  private queueAgg(venue: Venue, address: string, rebuild = false): void {
    const k = `${venue}|${address}`;
    if (this.building.has(k) || (rebuild && this.rebuilding.has(k))) return;
    // A first build supersedes a queued re-sum.
    if (!rebuild) this.rebuilding.delete(k);
    const r = this.q('SELECT MIN(t) AS t FROM fills WHERE venue = ? AND address = ?').get(venue, address) as { t: number | null } | undefined;
    const first = r?.t ?? null;
    const now = Date.now();
    const start = first === null ? now : Math.floor(first / DAY) * DAY;
    (rebuild ? this.rebuilding : this.building).set(k, this.newJob(venue, address, start, (Math.floor(now / DAY) + 1) * DAY));
  }

  /**
   * Run queued aggregate work for up to `budgetMs`, a chunk of rows at a time:
   * first builds (a board is waiting), then dirty days too large to sum at
   * once, then re-sums under a newer close definition. Returns how many
   * traders are still building.
   */
  buildAggregates(budgetMs = 40): number {
    if (this.readOnly) return 0;
    const t0 = Date.now();
    const left = () => this.building.size + this.rebuilding.size;
    const over = () => Date.now() - t0 >= budgetMs;
    for (const map of [this.building, this.dayJobs, this.rebuilding]) {
      for (const [k, job] of map) {
        let done = false;
        while (!over() && !(done = this.scanStep(job, SCAN_CHUNK))) { /* next chunk */ }
        if (!done) return left();
        const days = this.finish(job);
        if (map === this.dayJobs) {
          // One day of a heavy trader, summed in the background.
          this.tx(() => {
            this.q('DELETE FROM fill_day WHERE venue = ? AND address = ? AND day = ?').run(job.venue, job.address, Math.floor(job.from / DAY));
            this.writeDays(job.venue, job.address, days);
          });
          map.delete(k);
          this.bump(job.venue, job.address);
          continue;
        }
        this.tx(() => {
          this.q('DELETE FROM fill_day WHERE venue = ? AND address = ?').run(job.venue, job.address);
          this.writeDays(job.venue, job.address, days);
          this.q('INSERT OR REPLACE INTO fill_agg (venue, address, built_at) VALUES (?, ?, ?)').run(job.venue, job.address, Date.now());
        });
        map.delete(k);
        this.aggReady.set(k, true);
        this.bump(job.venue, job.address);
        if (over()) break;
      }
      if (over()) break;
    }
    if (this.migrating && !this.rebuilding.size) this.finishMigration();
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
    const job = this.newJob(venue, address, d * DAY, (d + 1) * DAY);
    let rows = 0;
    while (!this.scanStep(job, SCAN_CHUNK)) {
      rows += SCAN_CHUNK;
      if (rows >= SYNC_DAY_ROWS) {
        this.dayJobs.set(k, job);
        return;
      }
    }
    this.tx(() => {
      this.q('DELETE FROM fill_day WHERE venue = ? AND address = ? AND day = ?').run(venue, address, d);
      this.writeDays(venue, address, this.finish(job));
    });
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
    const k = `${venue}|${address}`;
    const job = this.rebuilding.get(k);
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
    const d0 = Math.floor(fromT / DAY);
    const job = this.newJob(venue, address, fromT, (d0 + 1) * DAY);
    while (!this.scanStep(job, SCAN_CHUNK)) await pause();
    return this.finish(job).get(d0);
  }

  /** windowStats without long stalls (the writer's board builds). Same figures. */
  async windowStatsAsync(venue: Venue, address: string, fromT: number, pause: () => Promise<void>): Promise<WindowStats> {
    // Dirty days are left to flushAggregates (a few minutes behind at most); summing them here stalled the build.
    if (!this.withAgg(venue, address, false)) return this.windowStats(venue, address, fromT);
    const d0 = Math.floor(fromT / DAY);
    const part = await this.partialDayAsync(venue, address, fromT, pause);
    return this.sumWindow(venue, address, d0, part);
  }

  /** orderCount since `fromT` without long stalls. Same figure. */
  async orderCountAsync(venue: Venue, address: string, fromT: number, pause: () => Promise<void>): Promise<number> {
    if (!this.withAgg(venue, address, false)) return this.orderCount(venue, address, fromT);
    const d0 = Math.floor(fromT / DAY);
    const part = (await this.partialDayAsync(venue, address, fromT, pause))?.trades ?? 0;
    const rest = this.q('SELECT COALESCE(SUM(trades), 0) AS n FROM fill_day WHERE venue = ? AND address = ? AND day > ?').get(venue, address, d0) as { n: number };
    return part + rest.n;
  }

  /** At least `n` distinct trades since `fromT`? Stops reading at `n` (the boards' trade test). */
  hasTrades(venue: Venue, address: string, fromT: number, n: number): number {
    return this.cappedTrades(venue, address, fromT, n);
  }

  /**
   * Distinct trades since `fromT`, counted to at most `cap`: cheap on any
   * history (it stops reading at the cap), and enough for "more than one trade".
   */
  private cappedTrades(venue: Venue, address: string, fromT: number, cap: number): number {
    const r = this.q(
      `SELECT COUNT(*) AS n FROM (SELECT DISTINCT t, symbol, side FROM fills WHERE venue = ? AND address = ? AND t >= ? LIMIT ?)`,
    ).get(venue, address, fromT, cap) as { n: number };
    return r.n;
  }

  windowStats(venue: Venue, address: string, fromT: number): WindowStats {
    if (this.withAgg(venue, address)) {
      const d0 = Math.floor(fromT / DAY);
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

  /** The same figures from the fills themselves (a reader with no aggregates yet). */
  private windowStatsScan(venue: Venue, address: string, fromT: number): WindowStats {
    const base = this.q(
      `SELECT COUNT(DISTINCT ${ORDER_KEY}) AS n, COALESCE(SUM(px * sz), 0) AS vol FROM fills WHERE venue = ? AND address = ? AND t >= ?`,
    ).get(venue, address, fromT) as { n: number; vol: number };
    const assets = (this.q(
      `SELECT symbol, SUM(px * sz) AS v FROM fills WHERE venue = ? AND address = ? AND t >= ?
       GROUP BY symbol ORDER BY v DESC LIMIT 3`,
    ).all(venue, address, fromT) as Array<{ symbol: string }>).map((r) => r.symbol);
    const closes =
      venue !== 'sodex'
        ? // Runs of reducing fills (valuescan/winRate.ts), per UTC day like the aggregates.
          this.closesByDay(venue, address, fromT, Number.MAX_SAFE_INTEGER).reduce((a, r) => ({ n: a.n + r.n, w: (a.w ?? 0) + r.w }), { n: 0, w: 0 as number | null })
        : (this.q(
            `SELECT COUNT(*) AS n, SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS w FROM closes WHERE venue = ? AND address = ? AND t >= ?`,
          ).get(venue, address, fromT) as { n: number; w: number | null });
    return { trades: base.n, volume: base.vol, assets, wins: closes.w ?? 0, closes: closes.n };
  }

  /** Replace a coverage row as given (used when a venue cap moves the start forward). */
  setCoverage(venue: Venue, address: string, kind: HistoryKind, c: Coverage): void {
    if (venue === 'hyperliquid' && kind === 'fills') this.setCoverage('tradexyz', address, kind, c);
    this.q(
      `INSERT INTO coverage (venue, address, kind, from_t, to_t, exhausted, capped, rest_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (venue, address, kind) DO UPDATE SET from_t = excluded.from_t, to_t = excluded.to_t,
         exhausted = excluded.exhausted, capped = excluded.capped, rest_at = excluded.rest_at`,
    ).run(venue, address, kind, c.fromT, c.toT, c.exhausted ? 1 : 0, c.capped ? 1 : 0, c.restAt);
    this.bump(venue, address);
  }

  /** Fill rows held for an address, and the oldest one's time. */
  fillExtent(venue: Venue, address: string): { count: number; minT: number | null } {
    const r = this.q('SELECT COUNT(*) AS n, MIN(t) AS m FROM fills WHERE venue = ? AND address = ?').get(venue, address) as { n: number; m: number | null };
    return { count: r.n, minT: num(r.m) };
  }

  /**
   * Remove public-stream rows in [fromT, toT] once REST fills cover that range.
   * Hyperliquid's REST fills are aggregated per order and time, so their ids
   * differ from the stream's per-print ids: both copies would count.
   */
  dropStreamRows(venue: Venue, address: string, fromT: number, toT: number): void {
    this.q('DELETE FROM fills WHERE venue = ? AND address = ? AND src = 0 AND t >= ? AND t <= ?').run(venue, address, fromT, toT);
    if (venue === 'hyperliquid') this.q('DELETE FROM fills WHERE venue = ? AND address = ? AND src = 0 AND t >= ? AND t <= ?').run('tradexyz', address, fromT, toT);
    this.bump(venue, address);
    for (let d = Math.floor(fromT / DAY); d <= Math.floor(Math.min(toT, Date.now()) / DAY); d++) {
      this.markDay(venue, address, d * DAY);
      if (venue === 'hyperliquid') this.markDay('tradexyz', address, d * DAY);
    }
  }

  /**
   * dropStreamRows a slice at a time, `pause()` between slices. A market
   * maker's month of stream rows is 100k+ rows: one DELETE held the loop.
   */
  async dropStreamRowsAsync(venue: Venue, address: string, fromT: number, toT: number, pause: () => Promise<void>): Promise<void> {
    const slice = this.q(
      `DELETE FROM fills WHERE (venue, address, id) IN (
         SELECT venue, address, id FROM fills WHERE venue = ? AND address = ? AND src = 0 AND t >= ? AND t <= ? LIMIT 2000)`,
    );
    for (const v of venue === 'hyperliquid' ? [venue, 'tradexyz' as Venue] : [venue]) {
      while (Number(slice.run(v, address, fromT, toT).changes) >= 2000) await pause();
    }
    this.bump(venue, address);
    for (let d = Math.floor(fromT / DAY); d <= Math.floor(Math.min(toT, Date.now()) / DAY); d++) {
      this.markDay(venue, address, d * DAY);
      if (venue === 'hyperliquid') this.markDay('tradexyz', address, d * DAY);
    }
  }

  /** Realised PnL net of fees, and traded volume, since `fromT`. */
  realized(venue: Venue, address: string, fromT: number): { pnl: number; volume: number; fills: number } {
    const r = this.q(
      `SELECT COALESCE(SUM(closed_pnl), 0) - COALESCE(SUM(fee), 0) AS pnl, COALESCE(SUM(px * sz), 0) AS vol, COUNT(*) AS n
       FROM fills WHERE venue = ? AND address = ? AND t >= ?`,
    ).get(venue, address, fromT) as { pnl: number; vol: number; n: number };
    return { pnl: r.pnl, volume: r.vol, fills: r.n };
  }

  /** Newest REST fill time (the incremental cursor). */
  newestFill(venue: Venue, address: string): number | null {
    const r = this.q('SELECT MAX(t) AS t FROM fills WHERE venue = ? AND address = ?').get(venue, address) as { t?: number | null };
    return num(r?.t);
  }

  /** Drop the fills, closes and coverage of traders no longer tracked. */
  forget(venue: Venue, address: string): void {
    this.tx(() => {
      this.q('DELETE FROM fills WHERE venue = ? AND address = ?').run(venue, address);
      this.q('DELETE FROM closes WHERE venue = ? AND address = ?').run(venue, address);
      this.q('DELETE FROM coverage WHERE venue = ? AND address = ?').run(venue, address);
      this.q('DELETE FROM fill_day WHERE venue = ? AND address = ?').run(venue, address);
      this.q('DELETE FROM fill_agg WHERE venue = ? AND address = ?').run(venue, address);
    });
    this.aggReady.set(`${venue}|${address}`, false);
    this.building.delete(`${venue}|${address}`);
    this.rebuilding.delete(`${venue}|${address}`);
    this.bump(venue, address);
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

  /** Stream trades of one account since `fromHour` (hour rows) or `fromDay` (day rows). */
  activityTrades(venue: Venue, acct: string, from: { hour: number } | { day: number }): number {
    const r = ('hour' in from
      ? this.q('SELECT COALESCE(SUM(trades), 0) AS n FROM activity_hour WHERE venue = ? AND acct = ? AND hour >= ?').get(venue, acct, from.hour)
      : this.q('SELECT COALESCE(SUM(trades), 0) AS n FROM activity_day WHERE venue = ? AND acct = ? AND day >= ?').get(venue, acct, from.day)) as { n: number };
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
  pruneActivityChunk(beforeHour: number, beforeDay: number, limit = 5_000): number {
    if (this.readOnly) return 0;
    let n = 0;
    n += Number(this.q('DELETE FROM activity_hour WHERE (venue, hour, acct) IN (SELECT venue, hour, acct FROM activity_hour WHERE hour < ? LIMIT ?)').run(beforeHour, limit).changes);
    n += Number(this.q('DELETE FROM activity_day WHERE (venue, day, acct) IN (SELECT venue, day, acct FROM activity_day WHERE day < ? LIMIT ?)').run(beforeDay, limit).changes);
    n += Number(this.q('DELETE FROM cum_pnl_day WHERE (venue, day, address) IN (SELECT venue, day, address FROM cum_pnl_day WHERE day < ? LIMIT ?)').run(beforeDay, limit).changes);
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
    this.tx(() => {
      const ins = this.q(
        'INSERT OR REPLACE INTO cohort_member (venue, address, pnl, equity, label, at, pnl_1d, pnl_7d, pnl_30d) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const r of rows) ins.run(venue, r.address, r.pnl, r.equity, r.label, at, r.pnl1d ?? null, r.pnl7d ?? null, r.pnl30d ?? null);
    });
  }

  cohortMembers(venue: Venue): Map<string, CohortMemberRow> {
    const out = new Map<string, CohortMemberRow>();
    for (const r of this.q('SELECT address, pnl, equity, label, pnl_1d, pnl_7d, pnl_30d FROM cohort_member WHERE venue = ?').all(venue) as Array<Record<string, unknown>>) {
      out.set(r.address as string, {
        address: r.address as string,
        pnl: num(r.pnl), equity: num(r.equity), label: typeof r.label === 'string' ? r.label : null,
        pnl1d: num(r.pnl_1d), pnl7d: num(r.pnl_7d), pnl30d: num(r.pnl_30d),
      });
    }
    return out;
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

  putCohortBooks(rows: ReadonlyArray<{ venue: Venue; address: string; equity: number | null; positions: ReadonlyArray<{ symbol: string; szi: number; entry: number | null }>; at: number }>): void {
    this.tx(() => {
      const ins = this.q('INSERT OR REPLACE INTO cohort_book (venue, address, equity, positions, at) VALUES (?, ?, ?, ?, ?)');
      for (const r of rows) ins.run(r.venue, r.address, r.equity, JSON.stringify(r.positions.map((p) => [p.symbol, p.szi, p.entry])), r.at);
    });
  }

  /** Every wallet's book on a venue: positions as the stream keeps them. */
  cohortBooks(venue: Venue): Map<string, { equity: number | null; positions: Array<{ symbol: string; szi: number; entry: number | null }>; at: number }> {
    const out = new Map<string, { equity: number | null; positions: Array<{ symbol: string; szi: number; entry: number | null }>; at: number }>();
    for (const r of this.q('SELECT address, equity, positions, at FROM cohort_book WHERE venue = ?').all(venue) as Array<Record<string, unknown>>) {
      let positions: Array<{ symbol: string; szi: number; entry: number | null }> = [];
      try {
        const x = JSON.parse(String(r.positions ?? '[]'));
        if (Array.isArray(x)) {
          positions = x.flatMap((e) => (Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'number'
            ? [{ symbol: e[0], szi: e[1], entry: typeof e[2] === 'number' ? e[2] : null }] : []));
        }
      } catch { /* none */ }
      out.set(r.address as string, { equity: num(r.equity), positions, at: Number(r.at) || 0 });
    }
    return out;
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

  putCohortSeries(rows: ReadonlyArray<{ scope: string; cohort: string; t: number; long: number; short: number }>): void {
    this.tx(() => {
      const ins = this.q('INSERT OR REPLACE INTO cohort_series (scope, cohort, t, lng, shrt, wallets, covered) VALUES (?, ?, ?, ?, ?, 0, 0)');
      for (const r of rows) ins.run(r.scope, r.cohort, r.t, r.long, r.short);
    });
  }

  cohortSeries(scope: string, fromT: number, cohort?: string): Array<{ cohort: string; t: number; long: number; short: number }> {
    const rows = (cohort
      ? this.q('SELECT cohort, t, lng, shrt FROM cohort_series WHERE scope = ? AND cohort = ? AND t >= ? ORDER BY t').all(scope, cohort, fromT)
      : this.q('SELECT cohort, t, lng, shrt FROM cohort_series WHERE scope = ? AND t >= ? ORDER BY t').all(scope, fromT)) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ cohort: String(r.cohort), t: Number(r.t), long: Number(r.lng), short: Number(r.shrt) }));
  }

  cohortSeriesLastT(): number {
    const r = this.q('SELECT MAX(t) AS t FROM cohort_series').get() as { t: number | null } | undefined;
    return r?.t ?? 0;
  }

  pruneCohortSeries(beforeT: number): void {
    this.q('DELETE FROM cohort_series WHERE t < ?').run(beforeT);
  }

  putCohortMix(rows: ReadonlyArray<{ scope: string; cohort: string; t: number; data: string }>): void {
    this.tx(() => {
      const ins = this.q('INSERT OR REPLACE INTO cohort_mix (scope, cohort, t, data) VALUES (?, ?, ?, ?)');
      for (const r of rows) ins.run(r.scope, r.cohort, r.t, r.data);
    });
  }

  /** Hourly per-coin and per-sector [long, short] of a cohort. */
  cohortMix(scope: string, fromT: number, cohort?: string): Array<{ cohort: string; t: number; c: Record<string, [number, number]>; s: Record<string, [number, number]> }> {
    const rows = (cohort
      ? this.q('SELECT cohort, t, data FROM cohort_mix WHERE scope = ? AND cohort = ? AND t >= ? ORDER BY t').all(scope, cohort, fromT)
      : this.q('SELECT cohort, t, data FROM cohort_mix WHERE scope = ? AND t >= ? ORDER BY t').all(scope, fromT)) as Array<Record<string, unknown>>;
    return rows.flatMap((r) => {
      try {
        const d = JSON.parse(String(r.data)) as { c?: Record<string, [number, number]>; s?: Record<string, [number, number]> };
        return [{ cohort: String(r.cohort), t: Number(r.t), c: d.c ?? {}, s: d.s ?? {} }];
      } catch {
        return [];
      }
    });
  }

  cohortMixLastT(): number {
    const r = this.q('SELECT MAX(t) AS t FROM cohort_mix').get() as { t: number | null } | undefined;
    return r?.t ?? 0;
  }

  pruneCohortMix(beforeT: number): void {
    this.q('DELETE FROM cohort_mix WHERE t < ?').run(beforeT);
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

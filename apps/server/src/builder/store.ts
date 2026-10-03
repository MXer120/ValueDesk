/**
 * What the verifier has counted, on disk (SQLite, node:sqlite, WAL):
 * `builder.db` in the data directory (docs/BUILDER-TIERS.md §6).
 *
 * Written by the process that serves the terms and runs the verifier - and by
 * nothing else, except `tools/builderTiers.ts forget`, which removes one
 * wallet in one short transaction while the server runs. So nothing about a
 * wallet is kept in memory between two steps: every step reads the wallet's
 * rows first and writes only if the wallet row it read is still the same one
 * (`created_at` is the row's generation). A forgotten wallet stays forgotten.
 *
 * node:sqlite is synchronous, so every statement here is one row or a short
 * indexed range. Nothing scans a table except `forget` and the row count at open.
 *
 * Tables (every wallet table is keyed by builder id first: pointing the
 * configuration at another builder starts a fresh ledger and loses nothing):
 *   wallets   one row per wallet the verifier took on - it approved our
 *             builder and a hint was left. Counted volume (micro-USD), flags,
 *             when it was last verified. A wallet that only ASKS for terms
 *             never gets a row, however often it asks.
 *   engines   per wallet and engine: how far its fills have been read.
 *   orders    orders whose fills matter: paid a builder fee (pending until the
 *             explorer has shown whose order it is, then counted or not), or
 *             paid none where one was owed (to look up who signed them).
 *   fills     the fills of the last minutes already added up, so the overlap
 *             that is read again is not counted twice.
 *   fees      the fee signed for a wallet, each time it changed - and, under
 *             the key "*", the default fee each time the file changed it.
 *   keys      the API keys our app registered for a wallet, as SoDEX listed them.
 *   evidence  for the operator: the order and the transaction behind a flag.
 *   floors    wallets that were forgotten: nothing before that moment counts again.
 *   days      counted volume per wallet, engine and UTC day - what a volume window (`volumeDays`) adds up.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Engine } from './config.js';
import { OrderState, addMicro, type FeeRow, type OrderRow, type OrderStateValue } from './counting.js';

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS wallets (
  builder INTEGER NOT NULL,
  address TEXT NOT NULL,
  account_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  floor INTEGER NOT NULL,
  perps_micro INTEGER NOT NULL DEFAULT 0,
  spot_micro INTEGER NOT NULL DEFAULT 0,
  verified_at INTEGER NOT NULL DEFAULT 0,
  idle_runs INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER NOT NULL DEFAULT 0,
  underpaid_n INTEGER NOT NULL DEFAULT 0,
  underpaid_at INTEGER NOT NULL DEFAULT 0,
  tampered_n INTEGER NOT NULL DEFAULT 0,
  tampered_at INTEGER NOT NULL DEFAULT 0,
  nobuilder_n INTEGER NOT NULL DEFAULT 0,
  nobuilder_at INTEGER NOT NULL DEFAULT 0,
  open_n INTEGER NOT NULL DEFAULT 0,
  looked_at INTEGER NOT NULL DEFAULT 0,
  misses INTEGER NOT NULL DEFAULT 0,
  found INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (builder, address)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS wallets_due ON wallets (builder, due_at) WHERE due_at > 0;
CREATE INDEX IF NOT EXISTS wallets_open ON wallets (builder, misses, looked_at) WHERE open_n > 0;
CREATE TABLE IF NOT EXISTS engines (
  builder INTEGER NOT NULL,
  address TEXT NOT NULL,
  engine TEXT NOT NULL,
  hi INTEGER NOT NULL DEFAULT 0,
  sw_from INTEGER NOT NULL DEFAULT 0,
  sw_end INTEGER NOT NULL DEFAULT 0,
  sw_top INTEGER NOT NULL DEFAULT 0,
  sw_pages INTEGER NOT NULL DEFAULT 0,
  swept_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (builder, address, engine)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS orders (
  builder INTEGER NOT NULL,
  address TEXT NOT NULL,
  engine TEXT NOT NULL,
  order_key TEXT NOT NULL,
  order_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  cl TEXT,
  t INTEGER NOT NULL,
  last_t INTEGER NOT NULL,
  state INTEGER NOT NULL,
  paid_micro INTEGER NOT NULL DEFAULT 0,
  rate INTEGER NOT NULL DEFAULT 0,
  counted_micro INTEGER NOT NULL DEFAULT 0,
  tries INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (builder, address, engine, order_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS orders_open ON orders (builder, address, last_t) WHERE state IN (${OrderState.pending}, ${OrderState.check});
CREATE INDEX IF NOT EXISTS orders_age ON orders (builder, address, last_t);
CREATE TABLE IF NOT EXISTS fills (
  builder INTEGER NOT NULL,
  address TEXT NOT NULL,
  engine TEXT NOT NULL,
  fill_key TEXT NOT NULL,
  t INTEGER NOT NULL,
  PRIMARY KEY (builder, address, engine, fill_key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS fees (
  builder INTEGER NOT NULL,
  address TEXT NOT NULL,
  at INTEGER NOT NULL,
  perps INTEGER NOT NULL,
  spot INTEGER NOT NULL,
  PRIMARY KEY (builder, address, at)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS keys (
  address TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (address, key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY,
  builder INTEGER NOT NULL,
  address TEXT NOT NULL,
  kind TEXT NOT NULL,
  engine TEXT NOT NULL,
  order_id TEXT NOT NULL,
  tx_hash TEXT,
  at INTEGER NOT NULL,
  signer TEXT,
  key_name TEXT,
  fee INTEGER,
  owed INTEGER
);
CREATE INDEX IF NOT EXISTS evidence_wallet ON evidence (builder, address, id);
CREATE TABLE IF NOT EXISTS floors (address TEXT PRIMARY KEY, at INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS days (
  builder INTEGER NOT NULL,
  address TEXT NOT NULL,
  engine TEXT NOT NULL,
  day INTEGER NOT NULL,
  micro INTEGER NOT NULL,
  PRIMARY KEY (builder, address, engine, day)
) WITHOUT ROWID;
`;

/** Day counts are kept this long: longer than any volume window a file may set (config MAX_VOLUME_DAYS). */
export const KEEP_DAYS = 120;

/** Tables holding rows of one wallet, for `forget` and the operator's report. */
const WALLET_TABLES = ['wallets', 'engines', 'orders', 'fills', 'fees', 'keys', 'evidence', 'days'] as const;
export type WalletTable = (typeof WALLET_TABLES)[number];
/** Those of them keyed by builder id, then address. `keys` is keyed by address alone. */
const BUILDER_TABLES = ['wallets', 'engines', 'orders', 'fills', 'fees', 'evidence', 'days'] as const;

/** Fee rows kept per wallet, the newest. */
export const MAX_FEE_ROWS = 64;
/** The place of a wallet address in `fees` under which the DEFAULT fee is kept over time. Never a wallet. */
export const DEFAULT_KEY = '*';
/** Keys remembered per wallet (a wallet lists a handful; ours are one or two at a time). */
export const MAX_KEY_ROWS = 64;
/** Evidence rows kept per wallet, newest. */
export const MAX_EVIDENCE_ROWS = 50;

export interface WalletRow {
  builder: number;
  address: string;
  accountId: number;
  /** When the row was made - and its generation: a wallet that was forgotten comes back with another. */
  createdAt: number;
  /** Fills before this are never read. */
  floor: number;
  perpsMicro: number;
  spotMicro: number;
  verifiedAt: number;
  /** Verifications in a row that found nothing new. */
  idleRuns: number;
  /** A hint is waiting: verify at this time (0 = none). */
  dueAt: number;
  underpaidN: number;
  underpaidAt: number;
  tamperedN: number;
  tamperedAt: number;
  noBuilderN: number;
  noBuilderAt: number;
  /** Orders the explorer still has to look at. */
  openN: number;
  lookedAt: number;
  /** Lookups in a row that found another builder's order. */
  misses: number;
}

export interface EngineRow {
  /** The time of the newest fill read so far (SoDEX's clock; 0 = nothing read yet). */
  hi: number;
  /** A sweep in progress reads the fills from here ... (0 = no sweep) */
  swFrom: number;
  /** ... and its next page ends here (0 = at the newest fill). */
  swEnd: number;
  /** The newest fill this sweep has seen. */
  swTop: number;
  swPages: number;
  /** When the last sweep was completed (this server's clock): a pass is done with an engine swept since its hint. */
  sweptAt: number;
}

export const NO_ENGINE: EngineRow = { hi: 0, swFrom: 0, swEnd: 0, swTop: 0, swPages: 0, sweptAt: 0 };

export interface Evidence {
  kind: 'underpaid' | 'tampered';
  engine: Engine;
  orderId: string;
  txHash: string | null;
  at: number;
  signer: string | null;
  keyName: string | null;
  fee: number | null;
  owed: number | null;
}

/** A change to a wallet's flags: how many more, and the latest order's time. */
export interface FlagDelta {
  n: number;
  at: number;
}

export interface FillsCommit {
  builder: number;
  address: string;
  /** The generation the step read. */
  gen: number;
  engine: Engine;
  addMicro: number;
  /** `addMicro` by UTC day (counting.ts dayOf). */
  byDay: ReadonlyMap<number, number>;
  rows: readonly OrderRow[];
  /** New rows among `rows` the explorer has to look at. */
  queued: number;
  noBuilder: FlagDelta;
  /** The step found something new: the pass it belongs to was not idle. */
  found: boolean;
  /** Fills added up in this step that the next sweep will read again. */
  fills: ReadonlyArray<{ key: string; t: number }>;
  state: EngineRow;
  /** Set when the sweep is complete: fills older than this are no longer needed for telling repeats. */
  pruneFillsBefore: number | null;
}

export interface LookupCommit {
  builder: number;
  address: string;
  gen: number;
  engine: Engine;
  row: OrderRow;
  /** The row left the explorer's list (it is decided, or given up). */
  closed: boolean;
  addMicro: number;
  /** `addMicro` by UTC day (counting.ts dayOf). */
  byDay: ReadonlyMap<number, number>;
  underpaid: FlagDelta;
  tampered: FlagDelta;
  /** Another builder's order: one more in a row. A counted order: back to zero. Null: unchanged. */
  misses: number | null;
  now: number;
  evidence: readonly Evidence[];
}

type Row = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const walletOf = (r: Row): WalletRow => ({
  builder: num(r.builder),
  address: str(r.address),
  accountId: num(r.account_id),
  createdAt: num(r.created_at),
  floor: num(r.floor),
  perpsMicro: num(r.perps_micro),
  spotMicro: num(r.spot_micro),
  verifiedAt: num(r.verified_at),
  idleRuns: num(r.idle_runs),
  dueAt: num(r.due_at),
  underpaidN: num(r.underpaid_n),
  underpaidAt: num(r.underpaid_at),
  tamperedN: num(r.tampered_n),
  tamperedAt: num(r.tampered_at),
  noBuilderN: num(r.nobuilder_n),
  noBuilderAt: num(r.nobuilder_at),
  openN: num(r.open_n),
  lookedAt: num(r.looked_at),
  misses: num(r.misses),
});

const orderOf = (r: Row): OrderRow => ({
  key: str(r.order_key),
  orderId: str(r.order_id),
  symbol: str(r.symbol),
  clOrdID: typeof r.cl === 'string' ? r.cl : null,
  t: num(r.t),
  lastT: num(r.last_t),
  state: num(r.state) as OrderStateValue,
  paidMicro: num(r.paid_micro),
  rate: num(r.rate),
  countedMicro: num(r.counted_micro),
  tries: num(r.tries),
  nextAt: num(r.next_at),
});

export class BuilderStore {
  readonly db: DatabaseSync;
  private stmts = new Map<string, StatementSync>();
  private depth = 0;

  constructor(readonly path: string, opts: { readOnly?: boolean; now?: number } = {}) {
    if (opts.readOnly) {
      // The operator looking at a ledger the server has open: nothing is created or changed.
      this.db = new DatabaseSync(path, { readOnly: true });
      this.db.exec('PRAGMA busy_timeout = 2000');
      return;
    }
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // Short: the only other writer is the tool's `forget`, one small transaction.
    this.db.exec('PRAGMA busy_timeout = 2000');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(SCHEMA);
    if (this.getMeta('schema') === null) this.setMeta('schema', String(SCHEMA_VERSION));
    // When this ledger began: no order from before it is ever called tampered.
    if (this.getMeta('since') === null) this.setMeta('since', String(opts.now ?? Date.now()));
  }

  close(): void {
    this.db.close();
  }

  private q(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  /** Run `fn` in one transaction (all or nothing). Nested calls join the outer one. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
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

  // --- meta ---------------------------------------------------------------------

  getMeta(key: string): string | null {
    const r = this.q('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined;
    return typeof r?.value === 'string' ? r.value : null;
  }

  setMeta(key: string, value: string): void {
    this.q('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** When this ledger began (ms). */
  since(): number {
    return Number(this.getMeta('since')) || 0;
  }

  // --- wallets --------------------------------------------------------------------

  wallet(builder: number, address: string): WalletRow | null {
    const r = this.q('SELECT * FROM wallets WHERE builder = ? AND address = ?').get(builder, address) as Row | undefined;
    return r ? walletOf(r) : null;
  }

  /** Counted volume of one wallet from UTC day `fromDay` on (counting.ts dayOf), per engine. */
  windowMicro(builder: number, address: string, fromDay: number): { perps: number; spot: number } {
    const rows = this.q('SELECT engine, sum(micro) AS m FROM days WHERE builder = ? AND address = ? AND day >= ? GROUP BY engine').all(builder, address, fromDay) as Row[];
    const out = { perps: 0, spot: 0 };
    for (const r of rows) {
      const m = Math.min(Number.MAX_SAFE_INTEGER, num(r.m));
      if (str(r.engine) === 'spot') out.spot = m;
      else out.perps = m;
    }
    return out;
  }

  /** Add one step's volume to its days, and let go of days no window reaches any more. Inside a transaction. */
  private addDays(builder: number, address: string, engine: Engine, byDay: ReadonlyMap<number, number>): void {
    if (!byDay.size) return;
    const add = this.q(
      `INSERT INTO days (builder, address, engine, day, micro) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (builder, address, engine, day) DO UPDATE SET micro = min(micro + excluded.micro, ${Number.MAX_SAFE_INTEGER})`,
    );
    let newest = 0;
    for (const [day, micro] of byDay) {
      if (!(micro > 0)) continue;
      add.run(builder, address, engine, day, micro);
      newest = Math.max(newest, day);
    }
    if (newest) this.q('DELETE FROM days WHERE builder = ? AND address = ? AND engine = ? AND day < ?').run(builder, address, engine, newest - KEEP_DAYS);
  }

  /** How many wallets the ledger holds (one count at open; kept current by the caller). */
  walletCount(): number {
    return num((this.q('SELECT count(*) AS n FROM wallets').get() as Row).n);
  }

  /** The moment a wallet was forgotten, if it was: nothing before it counts again. */
  floorOf(address: string): number {
    const r = this.q('SELECT at FROM floors WHERE address = ?').get(address) as Row | undefined;
    return r ? num(r.at) : 0;
  }

  /** Take a wallet on. Returns the row that exists afterwards. */
  createWallet(builder: number, address: string, accountId: number, now: number, floor: number): WalletRow {
    this.q('INSERT OR IGNORE INTO wallets (builder, address, account_id, created_at, floor) VALUES (?, ?, ?, ?, ?)').run(
      builder, address, accountId, now, Math.max(floor, this.floorOf(address)),
    );
    return this.wallet(builder, address)!;
  }

  /** Note that a hint waits for this wallet (or, with 0, that none does). False when the wallet is not that row any more. */
  setDue(builder: number, address: string, gen: number, dueAt: number): boolean {
    const r = this.q('UPDATE wallets SET due_at = ? WHERE builder = ? AND address = ? AND created_at = ?').run(dueAt, builder, address, gen);
    return Number(r.changes) > 0;
  }

  /** Wallets with a hint waiting - what a restart picks up again. */
  dueWallets(builder: number, limit: number): WalletRow[] {
    return (this.q('SELECT * FROM wallets WHERE builder = ? AND due_at > 0 ORDER BY due_at LIMIT ?').all(builder, limit) as Row[]).map(walletOf);
  }

  /** A verification pass is done: one more idle run unless one of its steps found something new. */
  completePass(builder: number, address: string, gen: number, now: number): boolean {
    const r = this.q(
      `UPDATE wallets SET verified_at = ?, idle_runs = CASE WHEN found THEN 0 ELSE min(idle_runs + 1, 30) END, found = 0, due_at = 0
       WHERE builder = ? AND address = ? AND created_at = ?`,
    ).run(now, builder, address, gen);
    return Number(r.changes) > 0;
  }

  // --- the fee signed, over time -------------------------------------------------------

  feeHistory(builder: number, address: string): FeeRow[] {
    return (this.q('SELECT at, perps, spot FROM fees WHERE builder = ? AND address = ? ORDER BY at').all(builder, address) as Row[]).map((r) => ({
      at: num(r.at), perps: num(r.perps), spot: num(r.spot),
    }));
  }

  /** The default fee over time (the first tier, each time it changed). */
  defaults(builder: number): FeeRow[] {
    return this.feeHistory(builder, DEFAULT_KEY);
  }

  /** Put the default fee on record if it is not what the last record says. */
  noteDefault(builder: number, fee: { perps: number; spot: number }, now: number): void {
    const last = this.lastFee(builder, DEFAULT_KEY);
    if (!last || last.perps !== fee.perps || last.spot !== fee.spot) this.recordFee(builder, DEFAULT_KEY, { at: now, perps: fee.perps, spot: fee.spot });
  }

  lastFee(builder: number, address: string): FeeRow | null {
    const r = this.q('SELECT at, perps, spot FROM fees WHERE builder = ? AND address = ? ORDER BY at DESC LIMIT 1').get(builder, address) as Row | undefined;
    return r ? { at: num(r.at), perps: num(r.perps), spot: num(r.spot) } : null;
  }

  /** Note a wallet's fee from `at` on. The oldest rows beyond MAX_FEE_ROWS go: only the recent past is ever asked about. */
  recordFee(builder: number, address: string, row: FeeRow): void {
    this.tx(() => {
      this.q('INSERT INTO fees (builder, address, at, perps, spot) VALUES (?, ?, ?, ?, ?) ON CONFLICT (builder, address, at) DO UPDATE SET perps = excluded.perps, spot = excluded.spot').run(
        builder, address, row.at, row.perps, row.spot,
      );
      this.q(
        `DELETE FROM fees WHERE builder = ? AND address = ? AND at < coalesce(
           (SELECT at FROM fees WHERE builder = ? AND address = ? ORDER BY at DESC LIMIT 1 OFFSET ?), -1)`,
      ).run(builder, address, builder, address, MAX_FEE_ROWS - 1);
    });
  }

  // --- fills and orders ---------------------------------------------------------------

  engine(builder: number, address: string, engine: Engine): EngineRow {
    const r = this.q('SELECT hi, sw_from, sw_end, sw_top, sw_pages, swept_at FROM engines WHERE builder = ? AND address = ? AND engine = ?').get(builder, address, engine) as Row | undefined;
    return r ? { hi: num(r.hi), swFrom: num(r.sw_from), swEnd: num(r.sw_end), swTop: num(r.sw_top), swPages: num(r.sw_pages), sweptAt: num(r.swept_at) } : { ...NO_ENGINE };
  }

  order(builder: number, address: string, engine: Engine, key: string): OrderRow | null {
    const r = this.q('SELECT * FROM orders WHERE builder = ? AND address = ? AND engine = ? AND order_key = ?').get(builder, address, engine, key) as Row | undefined;
    return r ? orderOf(r) : null;
  }

  /** Was this fill added up already? */
  fillSeen(builder: number, address: string, engine: Engine, key: string): boolean {
    return this.q('SELECT 1 AS x FROM fills WHERE builder = ? AND address = ? AND engine = ? AND fill_key = ?').get(builder, address, engine, key) !== undefined;
  }

  private putOrder(builder: number, address: string, engine: Engine, o: OrderRow): void {
    this.q(
      `INSERT INTO orders (builder, address, engine, order_key, order_id, symbol, cl, t, last_t, state, paid_micro, rate, counted_micro, tries, next_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (builder, address, engine, order_key) DO UPDATE SET
         t = excluded.t, last_t = excluded.last_t, state = excluded.state, paid_micro = excluded.paid_micro, rate = excluded.rate,
         counted_micro = excluded.counted_micro, tries = excluded.tries, next_at = excluded.next_at`,
    ).run(builder, address, engine, o.key, o.orderId, o.symbol, o.clOrdID, o.t, o.lastT, o.state, o.paidMicro, o.rate, o.countedMicro, o.tries, o.nextAt);
  }

  /**
   * Store what one page of fills came to. False - and nothing written - when
   * the wallet is not the row the step read (it was forgotten meanwhile).
   */
  commitFills(c: FillsCommit): boolean {
    return this.tx(() => {
      const w = this.wallet(c.builder, c.address);
      if (!w || w.createdAt !== c.gen) return false;
      const perps = c.engine === 'perps' ? addMicro(w.perpsMicro, c.addMicro) : w.perpsMicro;
      const spot = c.engine === 'spot' ? addMicro(w.spotMicro, c.addMicro) : w.spotMicro;
      this.q(
        `UPDATE wallets SET perps_micro = ?, spot_micro = ?, open_n = open_n + ?, nobuilder_n = nobuilder_n + ?, nobuilder_at = max(nobuilder_at, ?), found = max(found, ?)
         WHERE builder = ? AND address = ?`,
      ).run(perps, spot, c.queued, c.noBuilder.n, c.noBuilder.at, c.found ? 1 : 0, c.builder, c.address);
      for (const o of c.rows) this.putOrder(c.builder, c.address, c.engine, o);
      this.addDays(c.builder, c.address, c.engine, c.byDay);
      const put = this.q('INSERT OR IGNORE INTO fills (builder, address, engine, fill_key, t) VALUES (?, ?, ?, ?, ?)');
      for (const f of c.fills) put.run(c.builder, c.address, c.engine, f.key, f.t);
      this.q(
        `INSERT INTO engines (builder, address, engine, hi, sw_from, sw_end, sw_top, sw_pages, swept_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (builder, address, engine) DO UPDATE SET hi = excluded.hi, sw_from = excluded.sw_from, sw_end = excluded.sw_end, sw_top = excluded.sw_top,
           sw_pages = excluded.sw_pages, swept_at = excluded.swept_at`,
      ).run(c.builder, c.address, c.engine, c.state.hi, c.state.swFrom, c.state.swEnd, c.state.swTop, c.state.swPages, c.state.sweptAt);
      if (c.pruneFillsBefore !== null) {
        this.q('DELETE FROM fills WHERE builder = ? AND address = ? AND engine = ? AND t < ?').run(c.builder, c.address, c.engine, c.pruneFillsBefore);
      }
      return true;
    });
  }

  /**
   * The next order for the explorer: of the wallet that has waited longest
   * among those least likely to waste the lookup, its newest order that is due.
   * A wallet with nothing due is put at the back, so one call never loops.
   */
  nextLookup(builder: number, now: number): { wallet: WalletRow; engine: Engine; row: OrderRow } | null {
    const wallets = this.q('SELECT * FROM wallets WHERE builder = ? AND open_n > 0 ORDER BY misses, looked_at LIMIT 4').all(builder) as Row[];
    for (const raw of wallets) {
      const w = walletOf(raw);
      const r = this.q(
        `SELECT * FROM orders WHERE builder = ? AND address = ? AND state IN (${OrderState.pending}, ${OrderState.check}) AND next_at <= ?
         ORDER BY last_t DESC LIMIT 1`,
      ).get(builder, w.address, now) as Row | undefined;
      if (r) return { wallet: w, engine: str(r.engine) === 'spot' ? 'spot' : 'perps', row: orderOf(r) };
      const any = this.q(`SELECT 1 AS x FROM orders WHERE builder = ? AND address = ? AND state IN (${OrderState.pending}, ${OrderState.check}) LIMIT 1`).get(builder, w.address);
      // Nothing waits after all (rows were pruned or forgotten): the count was stale.
      this.q('UPDATE wallets SET looked_at = ?, open_n = CASE WHEN ? THEN open_n ELSE 0 END WHERE builder = ? AND address = ?').run(now, any ? 1 : 0, builder, w.address);
    }
    return null;
  }

  /** Is any order waiting for the explorer at all? */
  hasLookups(builder: number): boolean {
    return this.q('SELECT 1 AS x FROM wallets WHERE builder = ? AND open_n > 0 LIMIT 1').get(builder) !== undefined;
  }

  /** Store what a lookup came to. False when the wallet is not the row the lookup read. */
  commitLookup(c: LookupCommit): boolean {
    return this.tx(() => {
      const w = this.wallet(c.builder, c.address);
      if (!w || w.createdAt !== c.gen) return false;
      const perps = c.engine === 'perps' ? addMicro(w.perpsMicro, c.addMicro) : w.perpsMicro;
      const spot = c.engine === 'spot' ? addMicro(w.spotMicro, c.addMicro) : w.spotMicro;
      this.q(
        `UPDATE wallets SET perps_micro = ?, spot_micro = ?, open_n = max(open_n - ?, 0), looked_at = ?, misses = ?,
           underpaid_n = underpaid_n + ?, underpaid_at = max(underpaid_at, ?), tampered_n = tampered_n + ?, tampered_at = max(tampered_at, ?)
         WHERE builder = ? AND address = ?`,
      ).run(
        perps, spot, c.closed ? 1 : 0, c.now, c.misses === null ? w.misses : Math.min(c.misses, 9),
        c.underpaid.n, c.underpaid.at, c.tampered.n, c.tampered.at, c.builder, c.address,
      );
      this.putOrder(c.builder, c.address, c.engine, c.row);
      this.addDays(c.builder, c.address, c.engine, c.byDay);
      for (const e of c.evidence) {
        this.q('INSERT INTO evidence (builder, address, kind, engine, order_id, tx_hash, at, signer, key_name, fee, owed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
          c.builder, c.address, e.kind, e.engine, e.orderId, e.txHash, e.at, e.signer, e.keyName, e.fee, e.owed,
        );
      }
      if (c.evidence.length) {
        this.q(
          `DELETE FROM evidence WHERE builder = ? AND address = ? AND id < coalesce(
             (SELECT id FROM evidence WHERE builder = ? AND address = ? ORDER BY id DESC LIMIT 1 OFFSET ?), -1)`,
        ).run(c.builder, c.address, c.builder, c.address, MAX_EVIDENCE_ROWS - 1);
      }
      return true;
    });
  }

  /**
   * Drop a wallet's orders whose last fill is older than `before`. One still
   * waiting for the explorer goes too, and is taken off the wallet's count.
   */
  pruneOrders(builder: number, address: string, before: number): number {
    return this.tx(() => {
      const open = num((this.q(
        `SELECT count(*) AS n FROM orders WHERE builder = ? AND address = ? AND last_t < ? AND state IN (${OrderState.pending}, ${OrderState.check})`,
      ).get(builder, address, before) as Row).n);
      const r = this.q('DELETE FROM orders WHERE builder = ? AND address = ? AND last_t < ?').run(builder, address, before);
      if (open > 0) this.q('UPDATE wallets SET open_n = max(open_n - ?, 0) WHERE builder = ? AND address = ?').run(open, builder, address);
      return Number(r.changes);
    });
  }

  /** Keep at most `keep` of a wallet's orders, the newest; the rest go like pruned ones. */
  capOrders(builder: number, address: string, keep: number): number {
    const r = this.q('SELECT last_t FROM orders WHERE builder = ? AND address = ? ORDER BY last_t DESC LIMIT 1 OFFSET ?').get(builder, address, keep) as Row | undefined;
    return r ? this.pruneOrders(builder, address, num(r.last_t) + 1) : 0;
  }

  // --- the keys our app registered --------------------------------------------------------

  /** Note keys SoDEX lists for a wallet (name and address). A key seen again only moves its `last_seen`. */
  recordKeys(address: string, keys: ReadonlyArray<{ name: string; key: string }>, now: number): void {
    if (!keys.length) return;
    this.tx(() => {
      const put = this.q(
        `INSERT INTO keys (address, key, name, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (address, key) DO UPDATE SET last_seen = excluded.last_seen, name = excluded.name`,
      );
      for (const k of keys) put.run(address, k.key, k.name, now, now);
      this.q(
        `DELETE FROM keys WHERE address = ? AND last_seen < coalesce(
           (SELECT last_seen FROM keys WHERE address = ? ORDER BY last_seen DESC LIMIT 1 OFFSET ?), -1)`,
      ).run(address, address, MAX_KEY_ROWS - 1);
    });
  }

  /** Every key ever recorded for a wallet: address -> name. Keys rotate, so the old ones stay. */
  keysOf(address: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const r of this.q('SELECT key, name FROM keys WHERE address = ?').all(address) as Row[]) out.set(str(r.key), str(r.name));
    return out;
  }

  // --- the operator ---------------------------------------------------------------------

  evidenceOf(builder: number, address: string): Array<Evidence & { id: number }> {
    return (this.q('SELECT * FROM evidence WHERE builder = ? AND address = ? ORDER BY id DESC LIMIT ?').all(builder, address, MAX_EVIDENCE_ROWS) as Row[]).map((r) => ({
      id: num(r.id),
      kind: str(r.kind) === 'tampered' ? 'tampered' : 'underpaid',
      engine: str(r.engine) === 'spot' ? 'spot' : 'perps',
      orderId: str(r.order_id),
      txHash: typeof r.tx_hash === 'string' ? r.tx_hash : null,
      at: num(r.at),
      signer: typeof r.signer === 'string' ? r.signer : null,
      keyName: typeof r.key_name === 'string' ? r.key_name : null,
      fee: typeof r.fee === 'number' ? r.fee : null,
      owed: typeof r.owed === 'number' ? r.owed : null,
    }));
  }

  /** Every builder id the ledger has rows for (a fee can be on record for a wallet that was never verified). */
  private builders(): number[] {
    const ids = new Set<number>();
    for (const t of ['wallets', 'fees'] as const) {
      for (const r of this.db.prepare(`SELECT DISTINCT builder FROM ${t}`).all() as Row[]) ids.add(num(r.builder));
    }
    return [...ids];
  }

  /** How many rows each table holds for a wallet, over every builder id. */
  rowsOf(address: string): Record<WalletTable, number> {
    const out = Object.fromEntries(WALLET_TABLES.map((t) => [t, 0])) as Record<WalletTable, number>;
    for (const b of this.builders()) {
      for (const t of BUILDER_TABLES) out[t] += num((this.db.prepare(`SELECT count(*) AS n FROM ${t} WHERE builder = ? AND address = ?`).get(b, address) as Row).n);
    }
    out.keys = num((this.q('SELECT count(*) AS n FROM keys WHERE address = ?').get(address) as Row).n);
    return out;
  }

  /**
   * Remove everything stored about one wallet, under every builder id, in one
   * transaction - and leave the moment it happened, so its earlier orders are
   * not read and counted again when it comes back. Each delete goes by the
   * tables' keys (builder, then address), so no table is scanned while the
   * server waits for the write lock.
   */
  forget(address: string, now: number): Record<WalletTable, number> {
    // Read before the write lock is taken: this is the one place that looks at whole tables.
    const builders = this.builders();
    return this.tx(() => {
      const removed = Object.fromEntries(WALLET_TABLES.map((t) => [t, 0])) as Record<WalletTable, number>;
      for (const b of builders) {
        for (const t of BUILDER_TABLES) removed[t] += Number(this.db.prepare(`DELETE FROM ${t} WHERE builder = ? AND address = ?`).run(b, address).changes);
      }
      removed.keys = Number(this.q('DELETE FROM keys WHERE address = ?').run(address).changes);
      this.q('INSERT INTO floors (address, at) VALUES (?, ?) ON CONFLICT (address) DO UPDATE SET at = excluded.at').run(address, now);
      return removed;
    });
  }
}

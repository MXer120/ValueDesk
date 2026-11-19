/**
 * The trade flow on disk: its own SQLite file next to the index (`valuescan-flow.db`, or
 * VALUESCAN_FLOW_DB). Its own file because it is big and append-only: the index (31 GB on
 * 2026-11-01) is rebuilt, pruned and backed up on its own clock, and a print archive should not
 * ride along. The indexer process is the one writer; API processes open it read-only.
 *
 *   flow_market   venue + the venue's symbol -> an id, and the coin it trades (cohorts coinOf)
 *   flow_party    venue + the venue's own party key -> an id, and the wallet address once known
 *                 (SoDEX and Lighter prints name account ids; the address comes from the index)
 *   flow_chunk    one market's raw prints in one 5-minute slot (codec.ts encodeChunk)
 *   flow_hour     one market's per-wallet sums of one hour (codec.ts encodeSums)
 *   flow_day      the same per UTC day
 *   flow_tail     the prints of a chunk still forming that came after its last full write (same packing as a chunk,
 *                 replaced every ~0.5 s by the recorder's thread, gone with the next full write): the newest candle is
 *                 readable within a second without rewriting the whole chunk that often (flow/thread.ts)
 *   flow_sent     per chunk, the newest print number (of the indexer's run `session`) that its chunk + tail hold,
 *                 written in the same transaction: what the indexer still holds unconfirmed is told apart from what is
 *                 on disk, after a thread restart too (flow/thread.ts). Bookkeeping, not data: rows the indexer has
 *                 seen confirmed are dropped.
 *
 * NOTHING HERE IS DELETED FOR BEING OLD (owner 2026-10-28, retention.ts): there is no prune.
 * A chunk is rewritten while its slot fills (every FLUSH_MS) and once more for a print that comes
 * late; hours and days are written once their slot has passed and rebuilt only on purpose.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultDbPath } from '../indexer/store.js';
import type { Venue } from '../valuedesk/types.js';

export function defaultFlowPath(): string {
  return process.env.VALUESCAN_FLOW_DB?.trim() || join(dirname(defaultDbPath()), 'valuescan-flow.db');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS flow_market (
  id INTEGER PRIMARY KEY, venue TEXT NOT NULL, symbol TEXT NOT NULL, coin TEXT NOT NULL, first_t INTEGER NOT NULL,
  UNIQUE (venue, symbol));
CREATE INDEX IF NOT EXISTS flow_market_coin ON flow_market (coin);
CREATE TABLE IF NOT EXISTS flow_party (
  id INTEGER PRIMARY KEY, venue TEXT NOT NULL, key TEXT NOT NULL, address TEXT,
  UNIQUE (venue, key));
CREATE INDEX IF NOT EXISTS flow_party_addr ON flow_party (address);
CREATE TABLE IF NOT EXISTS flow_chunk (
  mid INTEGER NOT NULL, t INTEGER NOT NULL, n INTEGER NOT NULL, data BLOB NOT NULL,
  PRIMARY KEY (mid, t));
CREATE TABLE IF NOT EXISTS flow_hour (
  mid INTEGER NOT NULL, t INTEGER NOT NULL, wallets INTEGER NOT NULL, prints INTEGER NOT NULL, data BLOB NOT NULL,
  PRIMARY KEY (mid, t));
CREATE TABLE IF NOT EXISTS flow_day (
  mid INTEGER NOT NULL, t INTEGER NOT NULL, wallets INTEGER NOT NULL, prints INTEGER NOT NULL, data BLOB NOT NULL,
  PRIMARY KEY (mid, t));
CREATE TABLE IF NOT EXISTS flow_tail (
  mid INTEGER NOT NULL, t INTEGER NOT NULL, n INTEGER NOT NULL, data BLOB NOT NULL,
  PRIMARY KEY (mid, t));
CREATE TABLE IF NOT EXISTS flow_sent (
  mid INTEGER NOT NULL, t INTEGER NOT NULL, session TEXT NOT NULL, seq INTEGER NOT NULL,
  PRIMARY KEY (mid, t));
`;
const TABLES = ['meta', 'flow_market', 'flow_party', 'flow_chunk', 'flow_hour', 'flow_day'];

export interface FlowMarket {
  id: number;
  venue: Venue;
  symbol: string;
  coin: string;
  firstT: number;
}

export interface FlowParty {
  id: number;
  venue: Venue;
  key: string;
  address: string | null;
}

export type SumLevel = 'hour' | 'day';

export class FlowStore {
  readonly db: DatabaseSync;
  readonly readOnly: boolean;
  private st = new Map<string, StatementSync>();

  constructor(readonly path = defaultFlowPath(), opts: { readOnly?: boolean } = {}) {
    this.readOnly = !!opts.readOnly;
    if (!this.readOnly) mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, this.readOnly ? { readOnly: true } : {});
    if (!this.readOnly) {
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
      this.db.exec(SCHEMA);
    } else {
      this.db.exec('PRAGMA busy_timeout = 2000;');
    }
  }

  /** The writer has created every table (a reader may open the file first). */
  schemaReady(): boolean {
    const got = new Set((this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map((r) => r.name));
    return TABLES.every((t) => got.has(t));
  }

  private q(sql: string): StatementSync {
    let s = this.st.get(sql);
    if (!s) { s = this.db.prepare(sql); this.st.set(sql, s); }
    return s;
  }

  close(): void {
    this.db.close();
  }

  // --- meta ----------------------------------------------------------------------------------------

  getMeta(key: string): string | null {
    const r = this.q('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.q('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // --- markets and parties -------------------------------------------------------------------------

  markets(): FlowMarket[] {
    return (this.q('SELECT id, venue, symbol, coin, first_t AS firstT FROM flow_market').all() as unknown as FlowMarket[]);
  }

  marketsOfCoin(coin: string): FlowMarket[] {
    return (this.q('SELECT id, venue, symbol, coin, first_t AS firstT FROM flow_market WHERE coin = ?').all(coin) as unknown as FlowMarket[]);
  }

  /** The market's id, created on first sight. */
  marketId(venue: Venue, symbol: string, coin: string, t: number): number {
    const r = this.q('SELECT id FROM flow_market WHERE venue = ? AND symbol = ?').get(venue, symbol) as { id: number } | undefined;
    if (r) return r.id;
    const ins = this.q('INSERT INTO flow_market (venue, symbol, coin, first_t) VALUES (?, ?, ?, ?)').run(venue, symbol, coin, t);
    return Number(ins.lastInsertRowid);
  }

  /** Every party (the writer loads them once at start). */
  parties(): FlowParty[] {
    return this.q('SELECT id, venue, key, address FROM flow_party').all() as unknown as FlowParty[];
  }

  partyId(venue: Venue, key: string, address: string | null): number {
    const r = this.q('SELECT id FROM flow_party WHERE venue = ? AND key = ?').get(venue, key) as { id: number } | undefined;
    if (r) return r.id;
    const ins = this.q('INSERT INTO flow_party (venue, key, address) VALUES (?, ?, ?)').run(venue, key, address);
    return Number(ins.lastInsertRowid);
  }

  setPartyAddress(id: number, address: string): void {
    this.q('UPDATE flow_party SET address = ? WHERE id = ?').run(address, id);
  }

  partiesById(ids: readonly number[]): Map<number, FlowParty> {
    const out = new Map<number, FlowParty>();
    const s = this.q('SELECT id, venue, key, address FROM flow_party WHERE id = ?');
    for (const id of ids) {
      const r = s.get(id) as unknown as FlowParty | undefined;
      if (r) out.set(id, r);
    }
    return out;
  }

  /** Party ids of an address (any venue) or of a venue key (a SoDEX / Lighter account id). */
  partiesOf(addressOrKey: string): FlowParty[] {
    const a = addressOrKey.toLowerCase();
    // One indexed read per venue (UNIQUE (venue, key)) and one by address: `key = ?` alone has no index (venue leads),
    // so the old `address = ? OR key = ?` scanned all ~400k parties - 9-26 s on the API thread from a cold page cache
    // (server 1 stall profiles 2026-11-19, under /api/vs/bots/markets). Now ~20 ms.
    const byId = new Map<number, FlowParty>();
    const add = (rows: unknown) => { for (const r of rows as FlowParty[]) byId.set(r.id, r); };
    add(this.q('SELECT id, venue, key, address FROM flow_party WHERE address = ?').all(a));
    const keys = a === addressOrKey ? [a] : [a, addressOrKey];
    const byKey = this.q(`SELECT id, venue, key, address FROM flow_party WHERE venue = ? AND key IN (${keys.map(() => '?').join(', ')})`);
    for (const { venue } of this.q('SELECT DISTINCT venue FROM flow_market').all() as Array<{ venue: string }>) add(byKey.all(venue, ...keys));
    return [...byId.values()].sort((x, y) => x.id - y.id);
  }

  // --- chunks ----------------------------------------------------------------------------------------

  putChunk(mid: number, t: number, n: number, data: Uint8Array): void {
    this.q('INSERT INTO flow_chunk (mid, t, n, data) VALUES (?, ?, ?, ?) ON CONFLICT (mid, t) DO UPDATE SET n = excluded.n, data = excluded.data').run(mid, t, n, data);
  }

  chunk(mid: number, t: number): Uint8Array | null {
    const r = this.q('SELECT data FROM flow_chunk WHERE mid = ? AND t = ?').get(mid, t) as { data: Uint8Array } | undefined;
    return r?.data ?? null;
  }

  /** The chunks of a market with from <= t < to, oldest first. */
  chunks(mid: number, from: number, to: number): Array<{ t: number; n: number; data: Uint8Array }> {
    return this.q('SELECT t, n, data FROM flow_chunk WHERE mid = ? AND t >= ? AND t < ? ORDER BY t').all(mid, from, to) as unknown as Array<{ t: number; n: number; data: Uint8Array }>;
  }

  /** Prints per chunk of a market with from <= t < to, without their blobs. */
  chunkCounts(mid: number, from: number, to: number): Array<{ t: number; n: number }> {
    return this.q('SELECT t, n FROM flow_chunk WHERE mid = ? AND t >= ? AND t < ?').all(mid, from, to) as unknown as Array<{ t: number; n: number }>;
  }

  /** A file from before flow_tail (a reader opened ahead of the new writer) has none: nothing is forming there. */
  private hasTail: boolean | null = null;

  private tailsReadable(): boolean {
    if (this.hasTail === true) return true;
    this.hasTail = !!this.q(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'flow_tail'`).get();
    return this.hasTail;
  }

  /** The prints of chunks still forming written since their last full write (flow_tail), from <= t < to. */
  tails(mid: number, from: number, to: number): Array<{ t: number; n: number; data: Uint8Array }> {
    if (!this.tailsReadable()) return [];
    return this.q('SELECT t, n, data FROM flow_tail WHERE mid = ? AND t >= ? AND t < ? ORDER BY t').all(mid, from, to) as unknown as Array<{ t: number; n: number; data: Uint8Array }>;
  }

  tailCounts(mid: number, from: number, to: number): Array<{ t: number; n: number }> {
    if (!this.tailsReadable()) return [];
    return this.q('SELECT t, n FROM flow_tail WHERE mid = ? AND t >= ? AND t < ?').all(mid, from, to) as unknown as Array<{ t: number; n: number }>;
  }

  putTail(mid: number, t: number, n: number, data: Uint8Array): void {
    this.q('INSERT INTO flow_tail (mid, t, n, data) VALUES (?, ?, ?, ?) ON CONFLICT (mid, t) DO UPDATE SET n = excluded.n, data = excluded.data').run(mid, t, n, data);
  }

  dropTail(mid: number, t: number): void {
    this.q('DELETE FROM flow_tail WHERE mid = ? AND t = ?').run(mid, t);
  }

  allTails(): Array<{ mid: number; t: number; data: Uint8Array }> {
    return this.q('SELECT mid, t, data FROM flow_tail').all() as unknown as Array<{ mid: number; t: number; data: Uint8Array }>;
  }

  /**
   * A slot as one read (one statement, so one snapshot of a file the recorder's thread writes meanwhile): its chunk, its
   * tail, and the newest print number of `session` they hold (-1: none of that run).
   */
  slot(mid: number, t: number, session: string): { chunk: Uint8Array | null; tail: Uint8Array | null; seq: number } {
    const r = this.q(`SELECT c.data AS chunk, l.data AS tail, s.seq AS seq, s.session AS session
      FROM (SELECT ? AS mid, ? AS t) k
      LEFT JOIN flow_chunk c ON c.mid = k.mid AND c.t = k.t
      LEFT JOIN flow_tail l ON l.mid = k.mid AND l.t = k.t
      LEFT JOIN flow_sent s ON s.mid = k.mid AND s.t = k.t`).get(mid, t) as { chunk: Uint8Array | null; tail: Uint8Array | null; seq: number | null; session: string | null };
    return { chunk: r.chunk ?? null, tail: r.tail ?? null, seq: r.session === session && r.seq !== null ? r.seq : -1 };
  }

  putSent(mid: number, t: number, session: string, seq: number): void {
    this.q('INSERT INTO flow_sent (mid, t, session, seq) VALUES (?, ?, ?, ?) ON CONFLICT (mid, t) DO UPDATE SET session = excluded.session, seq = excluded.seq').run(mid, t, session, seq);
  }

  /** The newest print number of `session` the slot holds on disk (-1: none). */
  sent(mid: number, t: number, session: string): number {
    const r = this.q('SELECT session, seq FROM flow_sent WHERE mid = ? AND t = ?').get(mid, t) as { session: string; seq: number } | undefined;
    return r && r.session === session ? r.seq : -1;
  }

  /** Rows no longer needed: another run's, and this run's the indexer has seen confirmed (`through`). */
  dropSent(session: string, through: number): void {
    this.q('DELETE FROM flow_sent WHERE session <> ? OR seq <= ?').run(session, through);
  }

  /** The market's id, or undefined (a reader: nothing is created). */
  findMarket(venue: Venue, symbol: string): number | undefined {
    const r = this.q('SELECT id FROM flow_market WHERE venue = ? AND symbol = ?').get(venue, symbol) as { id: number } | undefined;
    return r?.id;
  }

  findParty(venue: Venue, key: string): number | undefined {
    const r = this.q('SELECT id FROM flow_party WHERE venue = ? AND key = ?').get(venue, key) as { id: number } | undefined;
    return r?.id;
  }

  /** Which markets have chunks in [from, to). */
  marketsWithChunks(from: number, to: number): number[] {
    // Per market through the (mid, t) key: `WHERE t` alone read the whole chunk index, 18-33 s on the API thread from a
    // cold page cache (server 1 stall profiles 2026-11-19, under /api/vs/bots/markets). Now ~20 ms.
    return (this.q('SELECT m.id AS mid FROM flow_market m WHERE EXISTS (SELECT 1 FROM flow_chunk c WHERE c.mid = m.id AND c.t >= ? AND c.t < ?) ORDER BY m.id').all(from, to) as Array<{ mid: number }>).map((r) => r.mid);
  }

  /** The oldest chunk of a market (how far back its flow goes). */
  firstChunk(mid: number): number | null {
    const r = this.q('SELECT MIN(t) AS t FROM flow_chunk WHERE mid = ?').get(mid) as { t: number | null } | undefined;
    return r?.t ?? null;
  }

  // --- sums ------------------------------------------------------------------------------------------

  private sumTable(level: SumLevel): string {
    return level === 'hour' ? 'flow_hour' : 'flow_day';
  }

  putSums(level: SumLevel, mid: number, t: number, wallets: number, prints: number, data: Uint8Array): void {
    this.q(`INSERT INTO ${this.sumTable(level)} (mid, t, wallets, prints, data) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (mid, t) DO UPDATE SET wallets = excluded.wallets, prints = excluded.prints, data = excluded.data`).run(mid, t, wallets, prints, data);
  }

  /** The sums rows of a market with from <= t < to: times only (what is there). */
  sumTimes(level: SumLevel, mid: number, from: number, to: number): number[] {
    return (this.q(`SELECT t FROM ${this.sumTable(level)} WHERE mid = ? AND t >= ? AND t < ?`).all(mid, from, to) as Array<{ t: number }>).map((r) => r.t);
  }

  sums(level: SumLevel, mid: number, t: number): Uint8Array | null {
    const r = this.q(`SELECT data FROM ${this.sumTable(level)} WHERE mid = ? AND t = ?`).get(mid, t) as { data: Uint8Array } | undefined;
    return r?.data ?? null;
  }

  /** A sums row's print count, without its blob: 0 when there is no row. */
  sumPrints(level: SumLevel, mid: number, t: number): number {
    const r = this.q(`SELECT prints FROM ${this.sumTable(level)} WHERE mid = ? AND t = ?`).get(mid, t) as { prints: number } | undefined;
    return r?.prints ?? 0;
  }

  /** Bytes per table (dbstat is not built into node:sqlite everywhere: page counts by table instead). */
  sizes(): Record<string, { rows: number; bytes: number }> {
    const out: Record<string, { rows: number; bytes: number }> = {};
    for (const t of ['flow_chunk', 'flow_hour', 'flow_day']) {
      const r = this.q(`SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(data)), 0) AS b FROM ${t}`).get() as { n: number; b: number };
      out[t] = { rows: r.n, bytes: r.b };
    }
    const p = this.q('SELECT COUNT(*) AS n FROM flow_party').get() as { n: number };
    out.flow_party = { rows: p.n, bytes: 0 };
    return out;
  }
}

/** The API side's read-only connection (like indexer/reader.ts): null until the writer made the file. */
let readerStore: FlowStore | null = null;
let triedAt = 0;
export function flowReader(): FlowStore | null {
  if (readerStore) return readerStore;
  if (Date.now() - triedAt < 10_000) return null;
  triedAt = Date.now();
  const path = defaultFlowPath();
  if (!existsSync(path)) return null;
  let s: FlowStore | null = null;
  try {
    s = new FlowStore(path, { readOnly: true });
    if (s.schemaReady()) readerStore = s;
  } catch {
    readerStore = null;
  }
  if (!readerStore) {
    try { s?.close(); } catch { /* never opened */ }
  }
  return readerStore;
}

/** Tests: forget the reader. */
export function closeFlowReader(): void {
  try { readerStore?.close(); } catch { /* closed */ }
  readerStore = null;
  triedAt = 0;
}

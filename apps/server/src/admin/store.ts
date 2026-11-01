/**
 * The admin suite's own record (routes/admin.ts): `admin.db` in the server's data
 * directory (SQLite, WAL), in the off-server backup with the other API state.
 *
 * Tables:
 *   sessions    one row per sign-in: the token's SHA-256 (never the token), the
 *               wallet, when it was made and ends (24 h, fixed), when it was
 *               signed out (null while open), the client's rate key and country.
 *   nonces      sign-in and action signatures already used, until they expire.
 *   audit       every sign-in (taken or refused), every write and sign-out, in
 *               order. Append-only and chained: each row holds the SHA-256 of the
 *               one before it and of itself, so a row changed or taken out later
 *               shows (verifyAudit). Never pruned.
 *   tickets     the status the owner gave a feedback chat (ops/feedbackThreads.ts
 *               keeps the chat itself): open, waiting, closed - and when, by whom.
 *   fee_orders  the builder ledger's counted orders, copied (admin/builderStats.ts):
 *               the ledger keeps at most 2,000 orders a wallet, this keeps them all,
 *               so the fees earned add up over any length of time.
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from '../builder/paths.js';

export const adminDbPath = (): string => process.env.VALUESCAN_ADMIN_DB?.trim() || join(dataDir(), 'admin.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ended_at INTEGER,
  client TEXT NOT NULL,
  country TEXT
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ok INTEGER NOT NULL,
  wallet TEXT,
  client TEXT,
  country TEXT,
  detail TEXT,
  prev TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_kind ON audit (kind, at);
CREATE TABLE IF NOT EXISTS tickets (
  thread_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fee_orders (
  builder INTEGER NOT NULL,
  address TEXT NOT NULL,
  engine TEXT NOT NULL,
  order_key TEXT NOT NULL,
  symbol TEXT NOT NULL,
  t INTEGER NOT NULL,
  last_t INTEGER NOT NULL,
  counted_micro INTEGER NOT NULL,
  rate INTEGER NOT NULL,
  PRIMARY KEY (builder, address, engine, order_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS fee_orders_t ON fee_orders (builder, last_t);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS beta_wallets (
  address TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  added_by TEXT NOT NULL
) WITHOUT ROWID;
`;

export const TICKET_STATUSES = ['open', 'waiting', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export interface SessionRow {
  wallet: string;
  createdAt: number;
  expiresAt: number;
  client: string;
  country: string | null;
}

export interface AuditRow {
  id: number;
  at: number;
  kind: string;
  ok: boolean;
  wallet: string | null;
  client: string | null;
  country: string | null;
  detail: Record<string, unknown> | null;
}

/** A wallet that may use beta.valuedesk.so (the Beta page of the admin suite; beta/gate.ts reads it). */
export interface BetaWallet {
  address: string;
  label: string;
  addedAt: number;
  addedBy: string;
}

export interface FeeOrder {
  builder: number;
  address: string;
  engine: string;
  orderKey: string;
  symbol: string;
  t: number;
  lastT: number;
  countedMicro: number;
  rate: number;
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
export const tokenHash = (token: string): string => sha256(`vd-admin:v1:${token}`);
const GENESIS = '0'.repeat(64);

/** The hash a row is chained with: everything it says, and the hash before it. */
const rowHash = (r: { at: number; kind: string; ok: boolean; wallet: string | null; client: string | null; country: string | null; detail: string | null }, prev: string): string =>
  sha256(JSON.stringify([prev, r.at, r.kind, r.ok ? 1 : 0, r.wallet, r.client, r.country, r.detail]));

export class AdminStore {
  private readonly db: DatabaseSync;

  constructor(path = adminDbPath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout = 2000');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // --- sessions -----------------------------------------------------------------------------

  openSession(token: string, s: SessionRow): void {
    this.db.prepare('INSERT INTO sessions (token_hash, wallet, created_at, expires_at, ended_at, client, country) VALUES (?, ?, ?, ?, NULL, ?, ?)').run(
      tokenHash(token), s.wallet, s.createdAt, s.expiresAt, s.client, s.country,
    );
  }

  /** The open session a token names, or null (unknown, signed out, expired). */
  session(token: string | null, now = Date.now()): SessionRow | null {
    if (!token) return null;
    const r = this.db.prepare('SELECT wallet, created_at, expires_at, client, country FROM sessions WHERE token_hash = ? AND ended_at IS NULL AND expires_at > ?').get(tokenHash(token), now) as
      | { wallet: string; created_at: number; expires_at: number; client: string; country: string | null }
      | undefined;
    return r ? { wallet: r.wallet, createdAt: Number(r.created_at), expiresAt: Number(r.expires_at), client: r.client, country: r.country } : null;
  }

  endSession(token: string, now = Date.now()): boolean {
    return Number(this.db.prepare('UPDATE sessions SET ended_at = ? WHERE token_hash = ? AND ended_at IS NULL').run(now, tokenHash(token)).changes) > 0;
  }

  /** Sign every open session out; how many there were. */
  endAllSessions(now = Date.now()): number {
    return Number(this.db.prepare('UPDATE sessions SET ended_at = ? WHERE ended_at IS NULL AND expires_at > ?').run(now, now).changes);
  }

  openSessions(now = Date.now()): Array<SessionRow & { current?: boolean; id: string }> {
    const rows = this.db.prepare('SELECT token_hash, wallet, created_at, expires_at, client, country FROM sessions WHERE ended_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 50').all(now) as Array<{
      token_hash: string; wallet: string; created_at: number; expires_at: number; client: string; country: string | null;
    }>;
    return rows.map((r) => ({ id: r.token_hash.slice(0, 8), wallet: r.wallet, createdAt: Number(r.created_at), expiresAt: Number(r.expires_at), client: r.client, country: r.country }));
  }

  // --- nonces ---------------------------------------------------------------------------------

  /** A signature's nonce, accepted once (until it expires). False: a replay. */
  useNonce(nonce: string, expiresAt: number, now = Date.now()): boolean {
    this.db.prepare('DELETE FROM nonces WHERE expires_at <= ?').run(now);
    return Number(this.db.prepare('INSERT OR IGNORE INTO nonces (nonce, expires_at) VALUES (?, ?)').run(nonce, expiresAt).changes) === 1;
  }

  // --- the audit log ----------------------------------------------------------------------------

  audit(e: { kind: string; ok: boolean; wallet?: string | null; client?: string | null; country?: string | null; detail?: Record<string, unknown> | null }, now = Date.now()): void {
    const row = { at: now, kind: e.kind, ok: e.ok, wallet: e.wallet ?? null, client: e.client ?? null, country: e.country ?? null, detail: e.detail ? JSON.stringify(e.detail) : null };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const last = this.db.prepare('SELECT hash FROM audit ORDER BY id DESC LIMIT 1').get() as { hash: string } | undefined;
      const prev = last?.hash ?? GENESIS;
      this.db.prepare('INSERT INTO audit (at, kind, ok, wallet, client, country, detail, prev, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        row.at, row.kind, row.ok ? 1 : 0, row.wallet, row.client, row.country, row.detail, prev, rowHash(row, prev),
      );
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** The newest rows first, `before` an id for the next page. */
  auditRows(o: { limit?: number; before?: number; kind?: string } = {}): AuditRow[] {
    const limit = Math.max(1, Math.min(500, o.limit ?? 100));
    const rows = this.db.prepare(
      `SELECT id, at, kind, ok, wallet, client, country, detail FROM audit WHERE id < ? AND (? IS NULL OR kind = ?) ORDER BY id DESC LIMIT ?`,
    ).all(o.before ?? Number.MAX_SAFE_INTEGER, o.kind ?? null, o.kind ?? null, limit) as Array<{
      id: number; at: number; kind: string; ok: number; wallet: string | null; client: string | null; country: string | null; detail: string | null;
    }>;
    return rows.map((r) => ({
      id: Number(r.id), at: Number(r.at), kind: r.kind, ok: Number(r.ok) === 1, wallet: r.wallet, client: r.client, country: r.country,
      detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : null,
    }));
  }

  /** How many `kind` rows that failed since `since` (the sign-in lock counts wrong passwords). */
  failures(kind: string, since: number): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM audit WHERE kind = ? AND ok = 0 AND at >= ?').get(kind, since) as { n: number }).n);
  }

  /** When the latest `kind` row that failed was written, or null. */
  lastFailure(kind: string): number | null {
    const r = this.db.prepare('SELECT MAX(at) AS at FROM audit WHERE kind = ? AND ok = 0').get(kind) as { at: number | null };
    return r.at === null ? null : Number(r.at);
  }

  /** Walk the whole chain: the first row that does not fit, or null when every row does. */
  verifyAudit(): { rows: number; brokenAt: number | null } {
    let prev = GENESIS;
    let n = 0;
    for (const r of this.db.prepare('SELECT id, at, kind, ok, wallet, client, country, detail, prev, hash FROM audit ORDER BY id').iterate() as Iterable<{
      id: number; at: number; kind: string; ok: number; wallet: string | null; client: string | null; country: string | null; detail: string | null; prev: string; hash: string;
    }>) {
      n += 1;
      const want = rowHash({ at: Number(r.at), kind: r.kind, ok: Number(r.ok) === 1, wallet: r.wallet, client: r.client, country: r.country, detail: r.detail }, prev);
      if (r.prev !== prev || r.hash !== want) return { rows: n, brokenAt: Number(r.id) };
      prev = r.hash;
    }
    return { rows: n, brokenAt: null };
  }

  // --- tickets ------------------------------------------------------------------------------------

  ticketStatuses(): Map<number, { status: TicketStatus; updatedAt: number }> {
    const rows = this.db.prepare('SELECT thread_id, status, updated_at FROM tickets').all() as Array<{ thread_id: number; status: TicketStatus; updated_at: number }>;
    return new Map(rows.map((r) => [Number(r.thread_id), { status: r.status, updatedAt: Number(r.updated_at) }]));
  }

  setTicketStatus(threadId: number, status: TicketStatus, by: string, now = Date.now()): void {
    this.db.prepare('INSERT INTO tickets (thread_id, status, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT (thread_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, updated_by = excluded.updated_by')
      .run(threadId, status, now, by);
  }

  // --- the fee ledger's copy --------------------------------------------------------------------

  putFeeOrders(rows: readonly FeeOrder[]): number {
    if (!rows.length) return 0;
    const put = this.db.prepare(
      `INSERT INTO fee_orders (builder, address, engine, order_key, symbol, t, last_t, counted_micro, rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (builder, address, engine, order_key) DO UPDATE SET last_t = excluded.last_t, counted_micro = excluded.counted_micro, rate = excluded.rate
       WHERE excluded.counted_micro >= fee_orders.counted_micro`,
    );
    let n = 0;
    this.db.exec('BEGIN');
    try {
      for (const o of rows) n += Number(put.run(o.builder, o.address, o.engine, o.orderKey, o.symbol, o.t, o.lastT, o.countedMicro, o.rate).changes);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return n;
  }

  /** The fees one builder earned per wallet (micro-USD): notional x rate / 100 000, per order. */
  feesByWallet(builder: number, from = 0): Map<string, { perps: number; spot: number; orders: number; lastAt: number }> {
    const rows = this.db.prepare(
      `SELECT address, engine, SUM(counted_micro * rate / 100000.0) AS fee, COUNT(*) AS n, MAX(last_t) AS last FROM fee_orders
       WHERE builder = ? AND last_t >= ? GROUP BY address, engine`,
    ).all(builder, from) as Array<{ address: string; engine: string; fee: number; n: number; last: number }>;
    const out = new Map<string, { perps: number; spot: number; orders: number; lastAt: number }>();
    for (const r of rows) {
      const w = out.get(r.address) ?? { perps: 0, spot: 0, orders: 0, lastAt: 0 };
      if (r.engine === 'perps') w.perps += Math.round(Number(r.fee));
      else w.spot += Math.round(Number(r.fee));
      w.orders += Number(r.n);
      w.lastAt = Math.max(w.lastAt, Number(r.last));
      out.set(r.address, w);
    }
    return out;
  }

  /** Fees per UTC day (micro-USD), by the day of each order's latest fill. */
  feesByDay(builder: number, fromDay: number): Array<{ day: number; perps: number; spot: number }> {
    const rows = this.db.prepare(
      `SELECT last_t / 86400000 AS day, engine, SUM(counted_micro * rate / 100000.0) AS fee FROM fee_orders
       WHERE builder = ? AND last_t >= ? GROUP BY day, engine ORDER BY day`,
    ).all(builder, fromDay * 86_400_000) as Array<{ day: number; engine: string; fee: number }>;
    const byDay = new Map<number, { day: number; perps: number; spot: number }>();
    for (const r of rows) {
      const d = byDay.get(Number(r.day)) ?? { day: Number(r.day), perps: 0, spot: 0 };
      d[r.engine === 'perps' ? 'perps' : 'spot'] += Math.round(Number(r.fee));
      byDay.set(d.day, d);
    }
    return [...byDay.values()];
  }

  // --- the beta list ---------------------------------------------------------------------------

  betaWallets(): BetaWallet[] {
    const rows = this.db.prepare('SELECT address, label, added_at, added_by FROM beta_wallets ORDER BY added_at DESC').all() as Array<{ address: string; label: string; added_at: number; added_by: string }>;
    return rows.map((r) => ({ address: r.address, label: r.label, addedAt: Number(r.added_at), addedBy: r.added_by }));
  }

  /** Add a wallet, or rename one already on the list; true when it was not on it. */
  addBetaWallet(address: string, label: string, by: string, now = Date.now()): boolean {
    const a = address.toLowerCase();
    const known = this.db.prepare('SELECT 1 FROM beta_wallets WHERE address = ?').get(a) !== undefined;
    if (known) this.db.prepare('UPDATE beta_wallets SET label = ? WHERE address = ?').run(label, a);
    else this.db.prepare('INSERT INTO beta_wallets (address, label, added_at, added_by) VALUES (?, ?, ?, ?)').run(a, label, now, by.toLowerCase());
    return !known;
  }

  removeBetaWallet(address: string): boolean {
    return Number(this.db.prepare('DELETE FROM beta_wallets WHERE address = ?').run(address.toLowerCase()).changes) > 0;
  }

  getMeta(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
  }
}

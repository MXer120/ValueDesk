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
-- Fee programs (owner 2026-11-08): a lower ValueDesk builder fee for one wallet on some products for a while (VIP
-- for 30 days, 0 for a launch week...). Never below 0; the lowest of the wallet's tier, its programs and VIP wins,
-- and when a program ends the wallet is back on its tier by itself (builder/programs.ts).
CREATE TABLE IF NOT EXISTS fee_programs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL,
  products TEXT NOT NULL,
  fee INTEGER NOT NULL,
  from_at INTEGER NOT NULL,
  until_at INTEGER,
  label TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  added_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS fee_programs_address ON fee_programs (address);
CREATE TABLE IF NOT EXISTS board_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  area TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  session TEXT NOT NULL DEFAULT '',
  ref TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  reviewed_by TEXT
);
CREATE TABLE IF NOT EXISTS board_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card INTEGER NOT NULL,
  at INTEGER NOT NULL,
  who TEXT NOT NULL,
  what TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS board_log_card ON board_log (card, id);
`;

/** The kanban board's columns, in order (pages/Board.tsx in the admin suite, tools/board.ts). */
export const BOARD_STATUSES = ['planned', 'working', 'done', 'reviewed'] as const;
export type BoardStatus = (typeof BOARD_STATUSES)[number];
export const BOARD_TITLE_MAX = 140;
export const BOARD_DETAIL_MAX = 4000;
export const BOARD_FIELD_MAX = 80;

export interface BoardCard {
  id: number;
  title: string;
  detail: string;
  area: string;
  status: BoardStatus;
  /** Which session works on it. */
  session: string;
  /** Its commit, version or PR. */
  ref: string;
  createdAt: number;
  updatedAt: number;
  reviewedAt: number | null;
  reviewedBy: string | null;
}

/**
 * Who changes a card. The owner signs on the page. A session names itself, and to move a card
 * into or out of "reviewed" it must quote the owner's own confirmation (owner 2026-11-05: "only I
 * or you after confirmation can mark them as reviewed"). Enforced here, for every way in.
 */
export type BoardActor = { owner: string } | { session: string; ownerSaid?: string };

export class BoardError extends Error {}

const boardWho = (a: BoardActor): string => ('owner' in a ? `owner ${a.owner.toLowerCase()}` : `session ${a.session}`);

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

/** The products a fee program can lower: the site's own futures and spot orders, copy trading and bots. */
export type FeeProduct = 'perps' | 'spot' | 'copy' | 'bots';
export const FEE_PRODUCTS: readonly FeeProduct[] = ['perps', 'spot', 'copy', 'bots'];

export interface FeeProgram {
  id: number;
  address: string;
  products: FeeProduct[];
  /** Tenths of a basis point (0 = no ValueDesk fee), or -1: VIP, the lowest tier of each product (builder/programs.ts). */
  fee: number;
  from: number;
  /** Null: until ended by hand. */
  until: number | null;
  label: string;
  addedAt: number;
  addedBy: string;
}

function programOf(r: Record<string, unknown>): FeeProgram {
  return {
    id: Number(r.id),
    address: String(r.address),
    products: String(r.products).split(',').filter((x): x is FeeProduct => (FEE_PRODUCTS as readonly string[]).includes(x)),
    fee: Number(r.fee),
    from: Number(r.from_at),
    until: r.until_at === null || r.until_at === undefined ? null : Number(r.until_at),
    label: String(r.label),
    addedAt: Number(r.added_at),
    addedBy: String(r.added_by),
  };
}

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

  // --- fee programs ----------------------------------------------------------------------------

  /** Every program, newest first (ended ones too, for the record). */
  feePrograms(): FeeProgram[] {
    const rows = this.db.prepare('SELECT * FROM fee_programs ORDER BY added_at DESC, id DESC LIMIT 2000').all() as Array<Record<string, unknown>>;
    return rows.map(programOf);
  }

  /** The programs of one wallet that are running at `now`. */
  activeFeePrograms(address: string, now = Date.now()): FeeProgram[] {
    const rows = this.db.prepare('SELECT * FROM fee_programs WHERE address = ? AND from_at <= ? AND (until_at IS NULL OR until_at > ?)').all(address.toLowerCase(), now, now) as Array<Record<string, unknown>>;
    return rows.map(programOf);
  }

  /** One program per wallet, the same for each; their ids. */
  addFeePrograms(p: { addresses: readonly string[]; products: readonly FeeProduct[]; fee: number; from: number; until: number | null; label: string; by: string }, now = Date.now()): number[] {
    const ins = this.db.prepare('INSERT INTO fee_programs (address, products, fee, from_at, until_at, label, added_at, added_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const ids: number[] = [];
    for (const a of p.addresses) ids.push(Number(ins.run(a.toLowerCase(), p.products.join(','), p.fee === -1 ? -1 : Math.max(0, Math.round(p.fee)), p.from, p.until, p.label, now, p.by.toLowerCase()).lastInsertRowid));
    return ids;
  }

  /** End a program now (kept on record, ended); false when there is no such running program. */
  endFeeProgram(id: number, now = Date.now()): boolean {
    return Number(this.db.prepare('UPDATE fee_programs SET until_at = ? WHERE id = ? AND (until_at IS NULL OR until_at > ?)').run(now, id, now).changes) > 0;
  }

  // --- the kanban board --------------------------------------------------------------------------

  boardCards(): BoardCard[] {
    const rows = this.db.prepare('SELECT * FROM board_cards ORDER BY updated_at DESC, id DESC').all() as Array<Record<string, string | number | null>>;
    return rows.map((r) => this.boardRow(r));
  }

  boardCard(id: number): BoardCard | null {
    const r = this.db.prepare('SELECT * FROM board_cards WHERE id = ?').get(id) as Record<string, string | number | null> | undefined;
    return r ? this.boardRow(r) : null;
  }

  private boardRow(r: Record<string, string | number | null>): BoardCard {
    return {
      id: Number(r.id), title: String(r.title), detail: String(r.detail), area: String(r.area), status: r.status as BoardStatus,
      session: String(r.session), ref: String(r.ref), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
      reviewedAt: r.reviewed_at === null ? null : Number(r.reviewed_at), reviewedBy: r.reviewed_by === null ? null : String(r.reviewed_by),
    };
  }

  boardLog(id: number): Array<{ at: number; who: string; what: string }> {
    const rows = this.db.prepare('SELECT at, who, what FROM board_log WHERE card = ? ORDER BY id').all(id) as Array<{ at: number; who: string; what: string }>;
    return rows.map((r) => ({ at: Number(r.at), who: r.who, what: r.what }));
  }

  addBoardCard(c: { title: string; detail?: string; area?: string; status?: BoardStatus; session?: string; ref?: string }, actor: BoardActor, now = Date.now()): BoardCard {
    const title = c.title.replace(/\s+/g, ' ').trim();
    const status = c.status ?? 'planned';
    if (!title || title.length > BOARD_TITLE_MAX) throw new BoardError(`the title must be 1 to ${BOARD_TITLE_MAX} characters`);
    if ((c.detail ?? '').length > BOARD_DETAIL_MAX) throw new BoardError(`the detail must be at most ${BOARD_DETAIL_MAX} characters`);
    if (status === 'reviewed') throw new BoardError('a new card cannot start as reviewed');
    const r = this.db.prepare('INSERT INTO board_cards (title, detail, area, status, session, ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(title, (c.detail ?? '').trim(), (c.area ?? '').trim().slice(0, BOARD_FIELD_MAX), status, (c.session ?? '').trim().slice(0, BOARD_FIELD_MAX), (c.ref ?? '').trim().slice(0, BOARD_FIELD_MAX), now, now);
    const id = Number(r.lastInsertRowid);
    this.db.prepare('INSERT INTO board_log (card, at, who, what) VALUES (?, ?, ?, ?)').run(id, now, boardWho(actor), `added as ${status}`);
    return this.boardCard(id)!;
  }

  /** Move a card. Into or out of "reviewed": the owner, or a session quoting the owner. Throws BoardError when refused. */
  moveBoardCard(id: number, to: BoardStatus, actor: BoardActor, o: { session?: string; ref?: string; note?: string } = {}, now = Date.now()): BoardCard {
    const card = this.boardCard(id);
    if (!card) throw new BoardError(`no card ${id}`);
    if (!BOARD_STATUSES.includes(to)) throw new BoardError(`no column ${String(to)}`);
    const said = 'session' in actor ? (actor.ownerSaid ?? '').trim() : '';
    if ((to === 'reviewed' || card.status === 'reviewed') && to !== card.status && 'session' in actor && !said) {
      throw new BoardError('only the owner marks a card reviewed: quote their confirmation with --owner-said');
    }
    const reviewed = to === 'reviewed' && card.status !== 'reviewed';
    const stays = to === 'reviewed' && card.status === 'reviewed';
    this.db.prepare('UPDATE board_cards SET status = ?, session = ?, ref = ?, updated_at = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?').run(
      to, (o.session ?? card.session).trim().slice(0, BOARD_FIELD_MAX), (o.ref ?? card.ref).trim().slice(0, BOARD_FIELD_MAX), now,
      reviewed ? now : stays ? card.reviewedAt : null,
      reviewed ? boardWho(actor) : stays ? card.reviewedBy : null,
      id,
    );
    const what = `${card.status} -> ${to}${said ? `; owner said: ${said.slice(0, 500)}` : ''}${o.note ? `; ${o.note.slice(0, 500)}` : ''}`;
    this.db.prepare('INSERT INTO board_log (card, at, who, what) VALUES (?, ?, ?, ?)').run(id, now, boardWho(actor), what);
    return this.boardCard(id)!;
  }

  /** Change a card's words; its column only moves through moveBoardCard. */
  editBoardCard(id: number, c: { title?: string; detail?: string; area?: string; session?: string; ref?: string }, actor: BoardActor, now = Date.now()): BoardCard {
    const card = this.boardCard(id);
    if (!card) throw new BoardError(`no card ${id}`);
    const title = (c.title ?? card.title).replace(/\s+/g, ' ').trim();
    if (!title || title.length > BOARD_TITLE_MAX) throw new BoardError(`the title must be 1 to ${BOARD_TITLE_MAX} characters`);
    if ((c.detail ?? '').length > BOARD_DETAIL_MAX) throw new BoardError(`the detail must be at most ${BOARD_DETAIL_MAX} characters`);
    this.db.prepare('UPDATE board_cards SET title = ?, detail = ?, area = ?, session = ?, ref = ?, updated_at = ? WHERE id = ?').run(
      title, (c.detail ?? card.detail).trim(), (c.area ?? card.area).trim().slice(0, BOARD_FIELD_MAX), (c.session ?? card.session).trim().slice(0, BOARD_FIELD_MAX), (c.ref ?? card.ref).trim().slice(0, BOARD_FIELD_MAX), now, id,
    );
    this.db.prepare('INSERT INTO board_log (card, at, who, what) VALUES (?, ?, ?, ?)').run(id, now, boardWho(actor), 'edited');
    return this.boardCard(id)!;
  }

  getMeta(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
  }
}

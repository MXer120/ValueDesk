/**
 * The executor's database (SQLite, node:sqlite, WAL): copies, their runtime
 * state and activity, followers' keys (encrypted), accepted terms, and every
 * signed request (the record of each follower's instructions).
 *
 * The consent log is append-only: nothing here updates or deletes a row of
 * it, so what a follower signed stays exactly as they signed it.
 *
 * THE AUDIT LOG (table `audit`) is the executor's own record of everything it
 * did, kept for good (no pruning): every request it answered (route, wallet,
 * result), every order, stop, cancel and leverage change it sent to SoDEX with
 * SoDEX's answer, the emergency brake switched on and off, and each start and
 * stop of the process. Append-only and hash-chained: each row's `hash` is
 * SHA-256 over the previous row's hash and this row, so a row changed or taken
 * out afterwards breaks the chain from there on (`verifyAudit`, tools/audit.ts).
 * Nothing secret is written: no key, no signature, no session token.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync as SqliteDb, StatementSync } from 'node:sqlite';

/**
 * node:sqlite, read when it is first needed rather than imported: on a Node.js
 * without it (before 22.13) an import fails before any of this code runs, with
 * a stack trace instead of a sentence.
 */
export function sqlite(): typeof import('node:sqlite') {
  let m: typeof import('node:sqlite') | undefined;
  try {
    m = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule?.('node:sqlite') as typeof import('node:sqlite') | undefined;
  } catch {
    m = undefined;
  }
  if (!m?.DatabaseSync) throw new Error(`The ValueDesk copier needs Node.js 22.13 or newer (this is ${process.version}). Get it from https://nodejs.org, then start it again.`);
  return m;
}
import type { LatencyRow, LatencyStore } from './latency.ts';
import type { ActivityEntry, AlgoEvent, AlgoRecord, AlgoStore, CopyStore, EngineNotice, SubState, Subscription, TermsRecord } from '../../../packages/copy-engine/src/index.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS subs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS subs_owner ON subs (owner);
CREATE TABLE IF NOT EXISTS states (sub_id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS activity (id TEXT PRIMARY KEY, sub_id TEXT NOT NULL, owner TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS activity_sub ON activity (sub_id, at);
CREATE INDEX IF NOT EXISTS activity_owner ON activity (owner, at);
CREATE TABLE IF NOT EXISTS keys (
  owner TEXT NOT NULL,
  slot TEXT NOT NULL,
  address TEXT NOT NULL,
  name TEXT NOT NULL,
  sealed TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  registered INTEGER NOT NULL DEFAULT 0,
  checked_at INTEGER,
  PRIMARY KEY (owner, slot)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS terms (owner TEXT PRIMARY KEY, json TEXT NOT NULL) WITHOUT ROWID;
-- A wallet whose bots moved to the VIP executor (the page then talks to that one).
CREATE TABLE IF NOT EXISTS moves (owner TEXT PRIMARY KEY, tier TEXT NOT NULL, at INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS consents (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  action TEXT NOT NULL,
  digest TEXT NOT NULL UNIQUE,
  signature TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  payload TEXT NOT NULL,
  nonce TEXT NOT NULL,
  at INTEGER NOT NULL,
  viewer_country TEXT
);
CREATE INDEX IF NOT EXISTS consents_owner ON consents (owner, at);
CREATE TABLE IF NOT EXISTS algos (id TEXT PRIMARY KEY, owner TEXT NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS algos_owner ON algos (owner);
CREATE TABLE IF NOT EXISTS algo_events (id TEXT PRIMARY KEY, algo_id TEXT NOT NULL, owner TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS algo_events_algo ON algo_events (algo_id, at);
-- What a follower should hear of (copy-engine notices.ts: a copy halted, an algo failed or stopped...),
-- read after signing in (GET /api/copy/v1/notices). Kept: nothing deletes them for being old.
CREATE TABLE IF NOT EXISTS notices (
  owner TEXT NOT NULL, id TEXT NOT NULL, source TEXT NOT NULL, ref TEXT NOT NULL, kind TEXT NOT NULL, grade TEXT NOT NULL,
  title TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL, paper INTEGER NOT NULL,
  PRIMARY KEY (owner, id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS notices_at ON notices (owner, at);
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  owner TEXT,
  ref TEXT,
  data TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_owner ON audit (owner, at);
CREATE INDEX IF NOT EXISTS audit_ref ON audit (ref);
CREATE INDEX IF NOT EXISTS audit_at ON audit (at);
-- Signed-write latency to SoDEX per region, 10-minute bucket and kind (latency.ts): a histogram "bin:count,...".
-- Read back for 48 h on start (GET /api/copy/v1/bots/latency); nothing deletes a row for being old.
CREATE TABLE IF NOT EXISTS write_latency (
  region TEXT NOT NULL, t INTEGER NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL, hist TEXT NOT NULL,
  PRIMARY KEY (region, t, kind)) WITHOUT ROWID;
`;

/** One row of the audit log. */
export interface AuditRow {
  seq: number;
  at: number;
  /** e.g. 'request', 'order', 'stop', 'cancel', 'leverage', 'brake', 'process'. */
  kind: string;
  /** The wallet it concerns, lower-case, or null. */
  owner: string | null;
  /** What it is about: a copy id, an algo id, a client order id, a route. */
  ref: string | null;
  /** The details, JSON. */
  data: string;
  hash: string;
}

const AUDIT_GENESIS = '0'.repeat(64);

function auditHash(prev: string, r: { at: number; kind: string; owner: string | null; ref: string | null; data: string }): string {
  return createHash('sha256').update(`${prev}\n${r.at}\n${r.kind}\n${r.owner ?? ''}\n${r.ref ?? ''}\n${r.data}`).digest('hex');
}

export interface KeyRow {
  owner: string;
  slot: 'active' | 'pending';
  address: string;
  name: string;
  sealed: string;
  createdAt: number;
  expiresAt: number | null;
  registered: boolean;
  checkedAt: number | null;
}

/** One wallet as the admin suite lists it (usersSummary): times in ms, countries two letters. */
export interface UserSummary {
  owner: string;
  firstAt: number | null;
  lastSignedAt: number | null;
  siteTermsAt: number | null;
  copyTermsAt: number | null;
  country: string | null;
  viewerCountry: string | null;
  copies: number;
  activeCopies: number;
  algos: number;
  liveAlgos: number;
  keys: number;
  lastActivityAt: number | null;
}

export interface ConsentRow {
  owner: string;
  action: string;
  digest: string;
  signature: string;
  chainId: number;
  payload: string;
  nonce: string;
  at: number;
  viewerCountry: string | null;
}

type Row = Record<string, unknown>;

/** Data folders held by this process: a second open of one in the same process is refused too. */
const held = new Set<string>();

/**
 * One executor per data folder. Two on the same folder would each run every
 * copy and algo - every order twice. The lock is a file with the holder's pid,
 * made exclusively; one left by a process that is gone (a crash, a power cut)
 * is taken over.
 */
function takeLock(path: string): string {
  if (held.has(path)) throw new Error(`This data folder is already in use by this executor (${dirname(path)}).`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, String(process.pid), { flag: 'wx' });
      held.add(path);
      return path;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number(readFileSync(path, 'utf8').trim());
      if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && alive(pid)) {
        throw new Error(`Another executor (process ${pid}) is already running on ${dirname(path)}. Stop it first: two would place every order twice.`);
      }
      rmSync(path, { force: true }); // left by a process that is gone
    }
  }
  throw new Error(`Could not lock ${dirname(path)}.`);
}

/**
 * The database and its -wal / -shm files, 0600: they hold the sealed keys (useless
 * without the kek, which is 0600 already), every follower's instructions and
 * activity. A copier started under a umask of 022 would otherwise leave them
 * readable to every account on the machine. (Not on every file system: Windows.)
 */
export function privateFiles(path: string): void {
  for (const p of [path, `${path}-wal`, `${path}-shm`, `${path}.lock`]) {
    try {
      if (existsSync(p) && (statSync(p).mode & 0o077) !== 0) chmodSync(p, 0o600);
    } catch {
      /* not on every file system */
    }
  }
}

function releaseLock(path: string): void {
  held.delete(path);
  try {
    if (readFileSync(path, 'utf8').trim() === String(process.pid)) rmSync(path, { force: true });
  } catch {
    /* already gone */
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class ExecutorDb implements CopyStore, AlgoStore, LatencyStore {
  readonly db: SqliteDb;
  private stmts = new Map<string, StatementSync>();

  private lockPath: string | null = null;

  constructor(readonly path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
      this.lockPath = takeLock(`${path}.lock`);
    }
    this.db = new (sqlite().DatabaseSync)(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(SCHEMA);
    if (path !== ':memory:') privateFiles(path);
  }

  close(): void {
    this.db.close();
    if (this.lockPath) releaseLock(this.lockPath);
    this.lockPath = null;
  }

  /* ----------------------------------------------------------- audit ----- */

  private auditLast: string | null = null;

  /**
   * Append to the audit log. Never throws: the record of an action must not
   * stop the action (a full disk is reported by the health check).
   */
  audit(kind: string, owner: string | null, ref: string | null, data: unknown, at = Date.now()): void {
    try {
      if (this.auditLast === null) this.auditLast = String((this.q('SELECT hash FROM audit ORDER BY seq DESC LIMIT 1').get() as Row | undefined)?.hash ?? AUDIT_GENESIS);
      const row = { at, kind, owner: owner ? owner.toLowerCase() : null, ref, data: JSON.stringify(data ?? null) };
      const hash = auditHash(this.auditLast, row);
      this.q('INSERT INTO audit (at, kind, owner, ref, data, hash) VALUES (?, ?, ?, ?, ?, ?)').run(row.at, row.kind, row.owner, row.ref, row.data, hash);
      this.auditLast = hash;
    } catch {
      this.auditLast = null; // read again from the table next time
    }
  }

  /** Audit rows, newest first, by wallet, by ref, or all; `before` is a seq. */
  auditRows(q: { owner?: string; ref?: string; kind?: string; from?: number; to?: number; before?: number; limit?: number } = {}): AuditRow[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (q.owner) (where.push('owner = ?'), args.push(q.owner.toLowerCase()));
    if (q.ref) (where.push('ref = ?'), args.push(q.ref));
    if (q.kind) (where.push('kind = ?'), args.push(q.kind));
    if (q.from !== undefined) (where.push('at >= ?'), args.push(q.from));
    if (q.to !== undefined) (where.push('at < ?'), args.push(q.to));
    if (q.before !== undefined) (where.push('seq < ?'), args.push(q.before));
    const limit = Math.max(1, Math.min(100_000, q.limit ?? 500));
    const sql = `SELECT seq, at, kind, owner, ref, data, hash FROM audit${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ${limit}`;
    return (this.db.prepare(sql).all(...args) as Row[]).map((r) => ({
      seq: Number(r.seq),
      at: Number(r.at),
      kind: String(r.kind),
      owner: r.owner === null ? null : String(r.owner),
      ref: r.ref === null ? null : String(r.ref),
      data: String(r.data),
      hash: String(r.hash),
    }));
  }

  /**
   * Walk the chain: the first row whose hash does not follow, or null when every row does.
   * `from` (a head this process verified before) walks only the rows after it - the hourly
   * check; `head` is where the walk ended, for the next one.
   */
  verifyAudit(from?: { seq: number; hash: string }): { rows: number; brokenAt: number | null; head: { seq: number; hash: string } | null } {
    let prev = from?.hash ?? AUDIT_GENESIS;
    let rows = 0;
    let last = from?.seq ?? 0;
    const it = (from ? this.db.prepare('SELECT seq, at, kind, owner, ref, data, hash FROM audit WHERE seq > ? ORDER BY seq').iterate(from.seq) : this.db.prepare('SELECT seq, at, kind, owner, ref, data, hash FROM audit ORDER BY seq').iterate()) as Iterable<Row>;
    for (const r of it) {
      rows++;
      const seq = Number(r.seq);
      // A deleted row leaves a gap in seq (AUTOINCREMENT never reuses one), and its successor's hash no longer follows.
      const want = auditHash(prev, { at: Number(r.at), kind: String(r.kind), owner: r.owner === null ? null : String(r.owner), ref: r.ref === null ? null : String(r.ref), data: String(r.data) });
      if (want !== String(r.hash) || (last && seq !== last + 1)) return { rows, brokenAt: seq, head: null };
      prev = String(r.hash);
      last = seq;
    }
    return { rows, brokenAt: null, head: last ? { seq: last, hash: prev } : (from ?? null) };
  }

  /** Throws when the database does not answer (the health check). */
  ping(): void {
    this.db.prepare('SELECT 1').get();
  }

  private q(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) this.stmts.set(sql, (s = this.db.prepare(sql)));
    return s;
  }

  /* ---------------------------------------------------- write latency ----- */

  /** A bucket's histograms, replacing what was there (the open bucket is written again as it grows). */
  saveLatency(rows: LatencyRow[]): void {
    const s = this.q('INSERT INTO write_latency (region, t, kind, n, hist) VALUES (?, ?, ?, ?, ?) ON CONFLICT (region, t, kind) DO UPDATE SET n = excluded.n, hist = excluded.hist');
    this.db.exec('BEGIN');
    try {
      for (const r of rows) s.run(r.region, r.t, r.kind, r.n, r.hist);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  loadLatency(since: number): LatencyRow[] {
    return (this.q('SELECT region, t, kind, n, hist FROM write_latency WHERE t >= ? ORDER BY t').all(since) as Row[]).map((r) => ({
      region: String(r.region),
      t: Number(r.t),
      kind: String(r.kind) as LatencyRow['kind'],
      n: Number(r.n),
      hist: String(r.hist),
    }));
  }

  /* ----------------------------------------------------------- meta ----- */

  meta(k: string): string | null {
    const r = this.q('SELECT v FROM meta WHERE k = ?').get(k) as Row | undefined;
    return r ? String(r.v) : null;
  }

  setMeta(k: string, v: string): void {
    this.q('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v').run(k, v);
  }

  /* ------------------------------------------------------ CopyStore ----- */

  async subscriptions(): Promise<Subscription[]> {
    return (this.q('SELECT json FROM subs').all() as Row[]).map((r) => JSON.parse(String(r.json)) as Subscription);
  }

  async subscription(id: string): Promise<Subscription | null> {
    const r = this.q('SELECT json FROM subs WHERE id = ?').get(id) as Row | undefined;
    return r ? (JSON.parse(String(r.json)) as Subscription) : null;
  }

  async saveSubscription(s: Subscription): Promise<void> {
    this.q('INSERT INTO subs (id, owner, json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at').run(
      s.id,
      s.owner,
      JSON.stringify(s),
      Date.now(),
    );
  }

  async state(subId: string): Promise<SubState | null> {
    const r = this.q('SELECT json FROM states WHERE sub_id = ?').get(subId) as Row | undefined;
    return r ? (JSON.parse(String(r.json)) as SubState) : null;
  }

  async saveState(s: SubState): Promise<void> {
    this.q('INSERT INTO states (sub_id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT (sub_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at').run(
      s.subId,
      JSON.stringify(s),
      Date.now(),
    );
  }

  async addActivity(e: ActivityEntry): Promise<void> {
    this.q('INSERT OR IGNORE INTO activity (id, sub_id, owner, at, json) VALUES (?, ?, ?, ?, ?)').run(e.id, e.subId, e.owner, e.at, JSON.stringify(e));
  }

  async activity(q: { subId?: string; owner?: string; limit?: number; before?: number }): Promise<ActivityEntry[]> {
    const limit = Math.max(1, Math.min(1000, q.limit ?? 200));
    const before = q.before ?? Number.MAX_SAFE_INTEGER;
    const rows = q.subId
      ? (this.q('SELECT json FROM activity WHERE sub_id = ? AND at < ? ORDER BY at DESC LIMIT ?').all(q.subId, before, limit) as Row[])
      : (this.q('SELECT json FROM activity WHERE owner = ? AND at < ? ORDER BY at DESC LIMIT ?').all(q.owner ?? '', before, limit) as Row[]);
    return rows.map((r) => JSON.parse(String(r.json)) as ActivityEntry);
  }

  /** Activity (copies' and algos') older than `days` goes; the books keep their totals. */
  pruneActivity(days: number, now = Date.now()): number {
    const r = this.q('DELETE FROM activity WHERE at < ?').run(now - days * 86_400_000);
    const e = this.q('DELETE FROM algo_events WHERE at < ?').run(now - days * 86_400_000);
    return Number(r.changes) + Number(e.changes);
  }

  /* ------------------------------------------------------ AlgoStore ----- */

  async algos(): Promise<AlgoRecord[]> {
    return (this.q('SELECT json FROM algos').all() as Row[]).map((r) => JSON.parse(String(r.json)) as AlgoRecord);
  }

  async saveAlgo(a: AlgoRecord): Promise<void> {
    this.q('INSERT INTO algos (id, owner, json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at').run(
      a.id,
      a.owner,
      JSON.stringify(a),
      Date.now(),
    );
  }

  async addAlgoEvent(e: AlgoEvent): Promise<void> {
    this.q('INSERT OR IGNORE INTO algo_events (id, algo_id, owner, at, json) VALUES (?, ?, ?, ?, ?)').run(e.id, e.algoId, e.owner, e.at, JSON.stringify(e));
  }

  async algoEvents(q: { algoId?: string; owner?: string; limit?: number; before?: number }): Promise<AlgoEvent[]> {
    const limit = Math.max(1, Math.min(1000, q.limit ?? 200));
    const before = q.before ?? Number.MAX_SAFE_INTEGER;
    const rows = q.algoId
      ? (this.q('SELECT json FROM algo_events WHERE algo_id = ? AND at < ? ORDER BY at DESC, id DESC LIMIT ?').all(q.algoId, before, limit) as Row[])
      : (this.q('SELECT json FROM algo_events WHERE owner = ? AND at < ? ORDER BY at DESC, id DESC LIMIT ?').all(q.owner ?? '', before, limit) as Row[]);
    return rows.map((r) => JSON.parse(String(r.json)) as AlgoEvent);
  }

  /* ----------------------------------------------------------- keys ----- */

  key(owner: string, slot: KeyRow['slot']): KeyRow | null {
    const r = this.q('SELECT * FROM keys WHERE owner = ? AND slot = ?').get(owner, slot) as Row | undefined;
    return r ? keyOf(r) : null;
  }

  putKey(k: KeyRow): void {
    this.q(
      `INSERT INTO keys (owner, slot, address, name, sealed, created_at, expires_at, registered, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (owner, slot) DO UPDATE SET address = excluded.address, name = excluded.name, sealed = excluded.sealed, created_at = excluded.created_at,
         expires_at = excluded.expires_at, registered = excluded.registered, checked_at = excluded.checked_at`,
    ).run(k.owner, k.slot, k.address, k.name, k.sealed, k.createdAt, k.expiresAt, k.registered ? 1 : 0, k.checkedAt);
  }

  markKey(owner: string, slot: KeyRow['slot'], registered: boolean, expiresAt: number | null, checkedAt: number): void {
    this.q('UPDATE keys SET registered = ?, expires_at = ?, checked_at = ? WHERE owner = ? AND slot = ?').run(registered ? 1 : 0, expiresAt, checkedAt, owner, slot);
  }

  /** The pending key becomes the active one (it was registered on SoDEX). */
  promoteKey(owner: string): void {
    this.db.exec('BEGIN');
    try {
      this.q("DELETE FROM keys WHERE owner = ? AND slot = 'active'").run(owner);
      this.q("UPDATE keys SET slot = 'active' WHERE owner = ? AND slot = 'pending'").run(owner);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  deleteKeys(owner: string): void {
    this.q('DELETE FROM keys WHERE owner = ?').run(owner);
  }

  /* ---------------------------------------------------------- terms ----- */

  terms(owner: string): TermsRecord | null {
    const r = this.q('SELECT json FROM terms WHERE owner = ?').get(owner) as Row | undefined;
    return r ? (JSON.parse(String(r.json)) as TermsRecord) : null;
  }

  setTerms(owner: string, t: TermsRecord): void {
    this.q('INSERT INTO terms (owner, json) VALUES (?, ?) ON CONFLICT (owner) DO UPDATE SET json = excluded.json').run(owner, JSON.stringify(t));
  }

  /* ---------------------------------------------------------- moves ----- */

  moved(owner: string): { tier: string; at: number } | null {
    const r = this.q('SELECT tier, at FROM moves WHERE owner = ?').get(owner) as Row | undefined;
    return r ? { tier: String(r.tier), at: Number(r.at) } : null;
  }

  setMoved(owner: string, tier: string | null): void {
    if (tier === null) this.q('DELETE FROM moves WHERE owner = ?').run(owner);
    else this.q('INSERT INTO moves (owner, tier, at) VALUES (?, ?, ?) ON CONFLICT (owner) DO UPDATE SET tier = excluded.tier, at = excluded.at').run(owner, tier, Date.now());
  }

  /** A wallet's signed record (its terms and every request it signed), for a VIP move. */
  ownerRecord(owner: string): { terms: unknown; consents: ConsentRow[] } {
    const rows = this.q('SELECT owner, action, digest, signature, chain_id, payload, nonce, at, viewer_country FROM consents WHERE owner = ? ORDER BY seq').all(owner) as Row[];
    return {
      terms: this.terms(owner),
      consents: rows.map((r) => ({ owner: String(r.owner), action: String(r.action), digest: String(r.digest), signature: String(r.signature), chainId: Number(r.chain_id), payload: String(r.payload), nonce: String(r.nonce), at: Number(r.at), viewerCountry: r.viewer_country === null ? null : String(r.viewer_country) })),
    };
  }

  /* ------------------------------------------------------- consents ----- */

  /** Record a signed request. False when this exact request was already used (a replay). */
  addConsent(c: ConsentRow): boolean {
    try {
      this.q('INSERT INTO consents (owner, action, digest, signature, chain_id, payload, nonce, at, viewer_country) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        c.owner,
        c.action,
        c.digest,
        c.signature,
        c.chainId,
        c.payload,
        c.nonce,
        c.at,
        c.viewerCountry,
      );
      return true;
    } catch (e) {
      if (/UNIQUE/i.test(String(e))) return false;
      throw e;
    }
  }

  /** A notice for its wallet, once (its id). Never throws: a notice must not stop what raised it. */
  addNotice(n: EngineNotice): void {
    try {
      this.q('INSERT OR IGNORE INTO notices (owner, id, source, ref, kind, grade, title, body, at, paper) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(n.owner, n.id, n.source, n.ref, n.kind, n.grade, n.title, n.body, n.at, n.paper ? 1 : 0);
    } catch {
      /* a full disk: the health check says so */
    }
  }

  /** A wallet's notices, newest first: up to `limit` (200 at most) before `before`, of `grades` (all when empty). */
  notices(owner: string, q: { before?: number; limit?: number; grades?: readonly string[] } = {}): EngineNotice[] {
    const grades = (q.grades ?? []).filter((g) => g === 'info' || g === 'warn' || g === 'error');
    const gradeSql = grades.length ? ` AND grade IN (${grades.map(() => '?').join(', ')})` : '';
    const limit = Math.max(1, Math.min(200, Math.floor(q.limit ?? 100)));
    return (this.db.prepare(`SELECT * FROM notices WHERE owner = ? AND at < ?${gradeSql} ORDER BY at DESC LIMIT ?`).all(owner, q.before ?? Number.MAX_SAFE_INTEGER, ...grades, limit) as Row[]).map((r) => ({
      id: String(r.id), owner: String(r.owner), source: String(r.source) as EngineNotice['source'], ref: String(r.ref), kind: String(r.kind) as EngineNotice['kind'],
      grade: String(r.grade) as EngineNotice['grade'], title: String(r.title), body: String(r.body), at: Number(r.at), paper: Number(r.paper) === 1,
    }));
  }

  /**
   * Every wallet this executor knows, one row each, for the owner's admin suite (server.ts
   * GET /internal/users, behind the internal token): when it first and last signed something,
   * its ValueDesk terms (site) and copy terms, the countries it declared and the edge saw, how
   * many copies and algos it has, whether a key is registered. Never a key, a signature or a payload.
   */
  usersSummary(): UserSummary[] {
    const rows = this.q(`
      WITH owners AS (
        SELECT owner FROM consents UNION SELECT owner FROM subs UNION SELECT owner FROM algos UNION SELECT owner FROM keys UNION SELECT owner FROM terms
      )
      SELECT o.owner AS owner,
        (SELECT MIN(at) FROM consents c WHERE c.owner = o.owner) AS first_at,
        (SELECT MAX(at) FROM consents c WHERE c.owner = o.owner) AS last_signed_at,
        (SELECT MAX(at) FROM consents c WHERE c.owner = o.owner AND c.action = 'accept-site-terms') AS site_terms_at,
        (SELECT MAX(at) FROM consents c WHERE c.owner = o.owner AND c.action = 'accept-terms') AS copy_terms_at,
        (SELECT json_extract(payload, '$.country') FROM consents c WHERE c.owner = o.owner AND c.action IN ('accept-site-terms', 'accept-terms') ORDER BY seq DESC LIMIT 1) AS country,
        (SELECT viewer_country FROM consents c WHERE c.owner = o.owner AND viewer_country IS NOT NULL ORDER BY seq DESC LIMIT 1) AS viewer_country,
        (SELECT COUNT(*) FROM subs s WHERE s.owner = o.owner) AS copies,
        (SELECT COUNT(*) FROM subs s WHERE s.owner = o.owner AND json_extract(s.json, '$.status') = 'active') AS active_copies,
        (SELECT COUNT(*) FROM algos a WHERE a.owner = o.owner) AS algos,
        (SELECT COUNT(*) FROM algos a WHERE a.owner = o.owner AND json_extract(a.json, '$.status') NOT IN ('done', 'cancelled', 'expired', 'failed')) AS live_algos,
        (SELECT COUNT(*) FROM keys k WHERE k.owner = o.owner AND k.registered = 1) AS keys,
        (SELECT MAX(at) FROM activity x WHERE x.owner = o.owner) AS last_activity_at
      FROM owners o`).all() as Row[];
    const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
    const s = (v: unknown): string | null => (typeof v === 'string' && /^[A-Za-z]{2}$/.test(v) ? v.toUpperCase() : null);
    return rows.map((r) => ({
      owner: String(r.owner).toLowerCase(),
      firstAt: n(r.first_at), lastSignedAt: n(r.last_signed_at), siteTermsAt: n(r.site_terms_at), copyTermsAt: n(r.copy_terms_at),
      country: s(r.country), viewerCountry: s(r.viewer_country),
      copies: Number(r.copies), activeCopies: Number(r.active_copies), algos: Number(r.algos), liveAlgos: Number(r.live_algos),
      keys: Number(r.keys), lastActivityAt: n(r.last_activity_at),
    }));
  }

  consents(owner: string, limit = 200): ConsentRow[] {
    return (this.q('SELECT * FROM consents WHERE owner = ? ORDER BY seq DESC LIMIT ?').all(owner, limit) as Row[]).map((r) => ({
      owner: String(r.owner),
      action: String(r.action),
      digest: String(r.digest),
      signature: String(r.signature),
      chainId: Number(r.chain_id),
      payload: String(r.payload),
      nonce: String(r.nonce),
      at: Number(r.at),
      viewerCountry: r.viewer_country === null ? null : String(r.viewer_country),
    }));
  }
}

function keyOf(r: Row): KeyRow {
  return {
    owner: String(r.owner),
    slot: r.slot === 'pending' ? 'pending' : 'active',
    address: String(r.address),
    name: String(r.name),
    sealed: String(r.sealed),
    createdAt: Number(r.created_at),
    expiresAt: r.expires_at === null || r.expires_at === undefined ? null : Number(r.expires_at),
    registered: Number(r.registered) === 1,
    checkedAt: r.checked_at === null || r.checked_at === undefined ? null : Number(r.checked_at),
  };
}

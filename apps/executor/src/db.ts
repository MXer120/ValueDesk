/**
 * The executor's database (SQLite, node:sqlite, WAL): copies, their runtime
 * state and activity, followers' keys (encrypted), accepted terms, and every
 * signed request (the record of each follower's instructions).
 *
 * The consent log is append-only: nothing here updates or deletes a row of
 * it, so what a follower signed stays exactly as they signed it.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import type { ActivityEntry, AlgoEvent, AlgoRecord, AlgoStore, CopyStore, SubState, Subscription, TermsRecord } from '../../../packages/copy-engine/src/index.ts';

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
`;

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

export class ExecutorDb implements CopyStore, AlgoStore {
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
  }

  close(): void {
    this.db.close();
    if (this.lockPath) releaseLock(this.lockPath);
    this.lockPath = null;
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

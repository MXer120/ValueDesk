/**
 * A wallet's inbox: the notices of its algos and copies run in a browser (copy-engine
 * notices.ts: failed, stopped, held, halted, a position closed outside the copier...), kept
 * here so they can be read on any device, for as long as the wallet is around, once its owner
 * has signed in (the feedback chat's wallet session, ops/feedbackAuth.ts). The hosted executor
 * keeps its own copies' and algos' notices (apps/executor db.ts) the same way.
 *
 * Written by the browser that ran it, which only ever sends its own signed-in wallet's notices;
 * read by that wallet only. Nothing is deleted for being old (retention.ts: the owner's word
 * first). One row per notice id: a repeat is the same notice.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from '../builder/paths.js';

export const inboxDbPath = (): string => process.env.VALUESCAN_INBOX_DB?.trim() || join(dataDir(), 'inbox.db');

export type InboxGrade = 'info' | 'warn' | 'error';
export type InboxSource = 'algo' | 'copy';

export interface InboxNotice {
  id: string;
  source: InboxSource;
  ref: string;
  kind: string;
  grade: InboxGrade;
  title: string;
  body: string;
  at: number;
  paper: boolean;
  /** When the server took it. */
  savedAt: number;
}

const GRADES: readonly InboxGrade[] = ['info', 'warn', 'error'];
const MAX_BATCH = 50;

/** One notice from a browser, checked field by field; null for one that is not. */
function parseOne(v: unknown, now: number): Omit<InboxNotice, 'savedAt'> | null {
  const n = v as Record<string, unknown> | null;
  if (!n || typeof n !== 'object') return null;
  const str = (x: unknown, max: number) => (typeof x === 'string' && x.length > 0 && x.length <= max ? x : null);
  const id = str(n.id, 200);
  const ref = str(n.ref, 120);
  const kind = str(n.kind, 24);
  const title = str(n.title, 200);
  const body = typeof n.body === 'string' && n.body.length <= 1_000 ? n.body : null;
  const at = Number(n.at);
  if (!id || !ref || !kind || !title || body === null) return null;
  if (n.source !== 'algo' && n.source !== 'copy') return null;
  if (!GRADES.includes(n.grade as InboxGrade)) return null;
  // A time a little ahead (a fast clock) is taken as now; one far off is not a notice of now.
  if (!Number.isFinite(at) || at < Date.UTC(2026, 0, 1) || at > now + 10 * 60_000) return null;
  return { id, source: n.source, ref, kind, grade: n.grade as InboxGrade, title, body, at: Math.min(at, now), paper: n.paper === true };
}

/** A browser's batch for `wallet`: the notices of that wallet only (their `owner`), at most MAX_BATCH. */
export function parseInboxBatch(body: unknown, wallet: string, now = Date.now()): { ok: true; notices: Array<Omit<InboxNotice, 'savedAt'>> } | { ok: false; error: string } {
  const list = (body as { notices?: unknown } | null)?.notices;
  if (!Array.isArray(list) || !list.length) return { ok: false, error: 'notices: a list of notices' };
  if (list.length > MAX_BATCH) return { ok: false, error: `notices: at most ${MAX_BATCH} at a time` };
  const out: Array<Omit<InboxNotice, 'savedAt'>> = [];
  for (const v of list) {
    const owner = (v as { owner?: unknown } | null)?.owner;
    if (typeof owner !== 'string' || owner.toLowerCase() !== wallet) continue;
    const n = parseOne(v, now);
    if (n) out.push(n);
  }
  return { ok: true, notices: out };
}

export class InboxStore {
  private readonly db: DatabaseSync;

  constructor(path = inboxDbPath()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS inbox (
      wallet TEXT NOT NULL, id TEXT NOT NULL, source TEXT NOT NULL, ref TEXT NOT NULL, kind TEXT NOT NULL,
      grade TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL, paper INTEGER NOT NULL,
      saved_at INTEGER NOT NULL, PRIMARY KEY (wallet, id)) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS inbox_at ON inbox (wallet, at);`);
  }

  /** Keeps what is new; returns how many were. */
  add(wallet: string, notices: ReadonlyArray<Omit<InboxNotice, 'savedAt'>>, now = Date.now()): number {
    const q = this.db.prepare(`INSERT OR IGNORE INTO inbox (wallet, id, source, ref, kind, grade, title, body, at, paper, saved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let n = 0;
    this.db.exec('BEGIN');
    try {
      for (const x of notices) n += Number(q.run(wallet, x.id, x.source, x.ref, x.kind, x.grade, x.title, x.body, x.at, x.paper ? 1 : 0, now).changes);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return n;
  }

  /** Newest first, `limit` (up to 200) before `before`, of `grades` (all when empty). */
  list(wallet: string, o: { before?: number; limit?: number; grades?: readonly InboxGrade[] } = {}): InboxNotice[] {
    const limit = Math.max(1, Math.min(200, Math.floor(o.limit ?? 100)));
    const grades = (o.grades ?? []).filter((g) => GRADES.includes(g));
    const gradeSql = grades.length ? ` AND grade IN (${grades.map(() => '?').join(', ')})` : '';
    const rows = this.db.prepare(`SELECT id, source, ref, kind, grade, title, body, at, paper, saved_at FROM inbox
      WHERE wallet = ? AND at < ?${gradeSql} ORDER BY at DESC LIMIT ?`)
      .all(wallet, o.before ?? Number.MAX_SAFE_INTEGER, ...grades, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id), source: r.source as InboxSource, ref: String(r.ref), kind: String(r.kind), grade: r.grade as InboxGrade,
      title: String(r.title), body: String(r.body), at: Number(r.at), paper: Number(r.paper) === 1, savedAt: Number(r.saved_at),
    }));
  }

  close(): void {
    this.db.close();
  }
}

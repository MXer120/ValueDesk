/**
 * Client error reports: what crashed in visitors' browsers, counted per kind of
 * error (POST /api/vs/client-errors, routes/reports.ts; the reporter is
 * apps/web/src/errorReport.ts).
 *
 * Kept in `client-errors.db` in the server's data directory (SQLite, node:sqlite,
 * WAL), one row per FINGERPRINT (ops/scrub.ts errorFingerprint): the scrubbed
 * message and frames as last seen, how often and since when, the last build,
 * page and browser family. Nothing about who sent it - no address, no wallet, no
 * session. At most MAX_ROWS rows: past that the one seen longest ago goes.
 *
 * A fingerprint seen for the first time is an alert to the owner (ops/telegram.ts),
 * at most ALERTS_PER_DAY a UTC day for all fingerprints together - a release that
 * breaks everything sends a handful, not thousands. Read them with
 * `tools/client-errors.ts`.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from '../builder/paths.js';
import {
  MAX_FRAMES, errorFingerprint, scrubFrame, scrubName, scrubRoute, scrubShort, scrubText,
} from './scrub.js';

export const KINDS = ['error', 'rejection', 'boundary'] as const;
export type ErrorKind = (typeof KINDS)[number];

/** One error as the reporter sends it, after validation. */
export interface ClientError {
  kind: ErrorKind;
  name: string;
  message: string;
  frames: string[];
  /** The error boundary that caught it (kind `boundary`): its name, e.g. "Portfolio". */
  boundary: string | null;
  /** How often this session saw it since the last batch, 1..MAX_COUNT. */
  count: number;
}

export interface ClientErrorBatch {
  build: string;
  route: string;
  browser: string;
  errors: ClientError[];
}

export const MAX_ERRORS_PER_BATCH = 10;
export const MAX_COUNT = 1000;
export const MAX_ROWS = 5000;
export const ALERTS_PER_DAY = 20;
/** The body a batch may have, in bytes (the route's bodyLimit). */
export const BATCH_BODY_LIMIT = 8 * 1024;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A batch as stored, or the reason it is refused. Every text field is scrubbed
 * again here (ops/scrub.ts): the server never relies on the reporter having done it.
 */
export function parseBatch(body: unknown): { ok: true; batch: ClientErrorBatch } | { ok: false; error: string } {
  let v = body;
  // sendBeacon sends text/plain (a JSON body would need a preflight); Fastify hands that over as a string.
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return { ok: false, error: 'the body is not JSON' };
    }
  }
  if (!isRecord(v)) return { ok: false, error: 'the body must be an object' };
  if (!Array.isArray(v.errors) || v.errors.length === 0) return { ok: false, error: 'errors must be a non-empty list' };
  if (v.errors.length > MAX_ERRORS_PER_BATCH) return { ok: false, error: `at most ${MAX_ERRORS_PER_BATCH} errors per batch` };
  const errors: ClientError[] = [];
  for (const e of v.errors) {
    if (!isRecord(e)) return { ok: false, error: 'each error must be an object' };
    if (!KINDS.includes(e.kind as ErrorKind)) return { ok: false, error: 'kind must be error, rejection or boundary' };
    const frames = Array.isArray(e.frames) ? e.frames.slice(0, MAX_FRAMES).map(scrubFrame).filter(Boolean) : [];
    const count = Number.isSafeInteger(e.count) ? Math.min(MAX_COUNT, Math.max(1, e.count as number)) : 1;
    errors.push({
      kind: e.kind as ErrorKind,
      name: scrubName(e.name),
      message: scrubText(e.message) || '(no message)',
      frames,
      boundary: e.kind === 'boundary' ? scrubShort(e.boundary) || null : null,
      count,
    });
  }
  return {
    ok: true,
    batch: { build: scrubShort(v.build) || 'unknown', route: scrubRoute(v.route), browser: scrubShort(v.browser) || 'other', errors },
  };
}

export interface ErrorRow {
  fp: string;
  kind: ErrorKind;
  name: string;
  message: string;
  frames: string[];
  boundary: string | null;
  firstAt: number;
  lastAt: number;
  count: number;
  reports: number;
  lastBuild: string;
  lastRoute: string;
  lastBrowser: string;
}

export const clientErrorsDbPath = (): string => process.env.VALUESCAN_CLIENT_ERRORS_DB?.trim() || join(dataDir(), 'client-errors.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS errors (
  fp TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  message TEXT NOT NULL,
  frames TEXT NOT NULL,
  boundary TEXT,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  count INTEGER NOT NULL,
  reports INTEGER NOT NULL,
  last_build TEXT NOT NULL,
  last_route TEXT NOT NULL,
  last_browser TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS errors_last ON errors (last_at);
CREATE TABLE IF NOT EXISTS alerts (day TEXT PRIMARY KEY, n INTEGER NOT NULL) WITHOUT ROWID;
`;

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export class ClientErrorStore {
  private readonly db: DatabaseSync;
  private readonly maxRows: number;

  constructor(path = clientErrorsDbPath(), o: { maxRows?: number; readOnly?: boolean } = {}) {
    this.maxRows = o.maxRows ?? MAX_ROWS;
    if (!o.readOnly) mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, o.readOnly ? { readOnly: true } : {});
    this.db.exec('PRAGMA busy_timeout = 2000');
    if (o.readOnly) return;
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(SCHEMA);
  }

  /** Count one batch. Returns the fingerprints seen here for the first time. */
  record(batch: ClientErrorBatch, now = Date.now()): Array<{ fp: string; error: ClientError }> {
    const fresh: Array<{ fp: string; error: ClientError }> = [];
    const get = this.db.prepare('SELECT 1 FROM errors WHERE fp = ?');
    const insert = this.db.prepare(
      `INSERT INTO errors (fp, kind, name, message, frames, boundary, first_at, last_at, count, reports, last_build, last_route, last_browser)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    );
    const update = this.db.prepare(
      `UPDATE errors SET message = ?, frames = ?, last_at = ?, count = MIN(count + ?, 1000000000), reports = reports + 1,
       last_build = ?, last_route = ?, last_browser = ? WHERE fp = ?`,
    );
    this.db.exec('BEGIN');
    try {
      for (const e of batch.errors) {
        const fp = errorFingerprint(e);
        const frames = JSON.stringify(e.frames);
        if (get.get(fp)) {
          update.run(e.message, frames, now, e.count, batch.build, batch.route, batch.browser, fp);
        } else {
          insert.run(fp, e.kind, e.name, e.message, frames, e.boundary, now, now, e.count, batch.build, batch.route, batch.browser);
          fresh.push({ fp, error: e });
        }
      }
      if (fresh.length) {
        // Bounded: the rows seen longest ago make room.
        const n = (this.db.prepare('SELECT COUNT(*) AS n FROM errors').get() as { n: number }).n;
        if (n > this.maxRows) {
          this.db.prepare('DELETE FROM errors WHERE fp IN (SELECT fp FROM errors ORDER BY last_at ASC LIMIT ?)').run(n - this.maxRows);
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return fresh;
  }

  /** One alert may be sent today (and is counted): false once ALERTS_PER_DAY were. */
  takeAlert(now = Date.now(), perDay = ALERTS_PER_DAY): boolean {
    const day = utcDay(now);
    const row = this.db.prepare('SELECT n FROM alerts WHERE day = ?').get(day) as { n: number } | undefined;
    if ((row?.n ?? 0) >= perDay) return false;
    this.db.prepare('INSERT INTO alerts (day, n) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET n = n + 1').run(day);
    this.db.prepare('DELETE FROM alerts WHERE day < ?').run(utcDay(now - 30 * 86_400_000));
    return true;
  }

  /** The most frequent errors last seen since `sinceMs`, most counted first. */
  top(o: { limit?: number; sinceMs?: number; order?: 'count' | 'recent' } = {}): ErrorRow[] {
    const order = o.order === 'recent' ? 'last_at DESC' : 'count DESC, last_at DESC';
    const rows = this.db
      .prepare(`SELECT * FROM errors WHERE last_at >= ? ORDER BY ${order} LIMIT ?`)
      .all(o.sinceMs ?? 0, Math.max(1, Math.min(1000, o.limit ?? 20))) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      fp: String(r.fp),
      kind: r.kind as ErrorKind,
      name: String(r.name),
      message: String(r.message),
      frames: JSON.parse(String(r.frames)) as string[],
      boundary: r.boundary === null ? null : String(r.boundary),
      firstAt: Number(r.first_at),
      lastAt: Number(r.last_at),
      count: Number(r.count),
      reports: Number(r.reports),
      lastBuild: String(r.last_build),
      lastRoute: String(r.last_route),
      lastBrowser: String(r.last_browser),
    }));
  }

  /** Forget one fingerprint (fixed), or every row: the CLI's `clear`. */
  clear(fp?: string): number {
    const r = fp ? this.db.prepare('DELETE FROM errors WHERE fp = ?').run(fp) : this.db.prepare('DELETE FROM errors').run();
    return Number(r.changes);
  }

  close(): void {
    this.db.close();
  }
}

/** The owner's message for a fingerprint seen for the first time. */
export function alertText(fp: string, e: ClientError, batch: ClientErrorBatch): string {
  return [
    `ValueDesk: new client error (${e.kind}${e.boundary ? ` in ${e.boundary}` : ''})`,
    '',
    `${e.name}: ${e.message}`,
    ...e.frames.slice(0, 4).map((f) => `  at ${f}`),
    '',
    `Page ${batch.route} · ${batch.browser} · build ${batch.build}`,
    `Fingerprint ${fp} - npx tsx tools/client-errors.ts show ${fp}`,
  ].join('\n');
}

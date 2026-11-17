/**
 * SoPoints week log (owner 2026-11-16: "ensure we log all weeks of user data with all the infos once they connect").
 * When a wallet signs in to its SoPoints, the page sends what SoDEX answered it - Season 1 and Layer 1 week lists with
 * every field, the summary and the squad bonus - and this keeps it, one row per wallet, season and week, newest answer
 * wins. It feeds the points formula fit (SoDEX publishes none). No token, signature or anything but SoDEX's own week
 * figures is sent or kept.
 *
 *   POST /api/vs/sopoints/log  {address, summary?, bonus?, summaryS1?, layer1?: [...], season1?: [...], ownVolume?: [...]}
 *
 * 2026-11-17 (owner: "ensure all the data we can track of users on sign that's relevant is tracked"): also Season 1's
 * summary, and the wallet's own volume per week from its trade history (`ownVolume`: SoDEX's Season 1 weeks 1-6 carry
 * no volume; the history does). The page re-sends whenever SoDEX's answer changed, so settled weeks replace live ones.
 *
 * The sender is not proven to own the address: the figures are SoDEX's, the page reads them with the wallet's own
 * token, and a forged post can only add rows marked with the address it names. Rows are capped per post and posts per
 * client, so the file stays small.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { dataDir } from '../builder/paths.js';
import { clientKey } from '../hosted.js';
import { KeyedLimiter, type Limit } from '../rateLimit.js';

export const sopointsDbPath = (): string => process.env.VALUESCAN_SOPOINTS_DB?.trim() || join(dataDir(), 'sopoints.db');
export const SOPOINTS_LOG_LIMIT: Limit = { max: 6, windowMs: 60_000 };
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAX_WEEKS = 60;
const MAX_ROW_BYTES = 4_096;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS weeks (
  address TEXT NOT NULL,
  season TEXT NOT NULL,
  week TEXT NOT NULL,
  start_s INTEGER,
  row TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (address, season, week)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS own_volume (
  address TEXT NOT NULL,
  season TEXT NOT NULL,
  week TEXT NOT NULL,
  volume REAL NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (address, season, week)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS wallets (
  address TEXT PRIMARY KEY,
  summary TEXT,
  bonus TEXT,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL
) WITHOUT ROWID;
`;

export class SopointsLog {
  private db: DatabaseSync;
  constructor(path = sopointsDbPath()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    const cols = this.db.prepare('PRAGMA table_info(wallets)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'summary_s1')) this.db.exec('ALTER TABLE wallets ADD COLUMN summary_s1 TEXT');
  }

  /** Keep one post. Returns the rows written. */
  put(address: string, body: { summary?: unknown; bonus?: unknown; summaryS1?: unknown; layer1?: unknown; season1?: unknown; ownVolume?: unknown }, now = Date.now()): number {
    const a = address.toLowerCase();
    const json = (v: unknown) => {
      const s = JSON.stringify(v ?? null);
      return s.length <= MAX_ROW_BYTES ? s : null;
    };
    const up = this.db.prepare(`INSERT INTO weeks (address, season, week, start_s, row, at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (address, season, week) DO UPDATE SET start_s = excluded.start_s, row = excluded.row, at = excluded.at`);
    let n = 0;
    this.db.exec('BEGIN');
    try {
      for (const [season, list] of [['layer1', body.layer1], ['season1', body.season1]] as const) {
        if (!Array.isArray(list)) continue;
        for (const r of list.slice(0, MAX_WEEKS)) {
          if (!r || typeof r !== 'object') continue;
          const rec = r as Record<string, unknown>;
          const week = String(rec.weekNo ?? rec.weekName ?? rec.weekLabel ?? '').slice(0, 40);
          const row = json(rec);
          if (!week || !row) continue;
          const start = Number(rec.weekStartTime);
          up.run(a, season, week, Number.isFinite(start) ? start : null, row, now);
          n++;
        }
      }
      if (Array.isArray(body.ownVolume)) {
        const ov = this.db.prepare(`INSERT INTO own_volume (address, season, week, volume, at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (address, season, week) DO UPDATE SET volume = excluded.volume, at = excluded.at`);
        for (const r of body.ownVolume.slice(0, MAX_WEEKS * 2)) {
          const rec = (r ?? {}) as { season?: unknown; week?: unknown; volume?: unknown };
          const season = rec.season === 'season1' || rec.season === 'layer1' ? rec.season : null;
          const week = Number(rec.week);
          const volume = Number(rec.volume);
          if (!season || !Number.isInteger(week) || week < 0 || week > 200 || !Number.isFinite(volume) || volume < 0 || volume > 1e12) continue;
          ov.run(a, season, String(week), volume, now);
          n++;
        }
      }
      this.db.prepare(`INSERT INTO wallets (address, summary, bonus, summary_s1, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (address) DO UPDATE SET summary = COALESCE(excluded.summary, summary), bonus = COALESCE(excluded.bonus, bonus), summary_s1 = COALESCE(excluded.summary_s1, summary_s1), last_at = excluded.last_at`)
        .run(a, body.summary === undefined ? null : json(body.summary), body.bonus === undefined ? null : json(body.bonus), body.summaryS1 === undefined ? null : json(body.summaryS1), now, now);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return n;
  }

  /** For the fit and for tests. */
  count(): { wallets: number; weeks: number; ownVolume: number } {
    const w = this.db.prepare('SELECT COUNT(*) AS n FROM wallets').get() as { n: number };
    const k = this.db.prepare('SELECT COUNT(*) AS n FROM weeks').get() as { n: number };
    const v = this.db.prepare('SELECT COUNT(*) AS n FROM own_volume').get() as { n: number };
    return { wallets: Number(w.n), weeks: Number(k.n), ownVolume: Number(v.n) };
  }
}

export function sopointsLogRoutes(o: { log?: SopointsLog; now?: () => number } = {}) {
  let log = o.log ?? null;
  const limiter = new KeyedLimiter();
  const now = o.now ?? Date.now;
  return async function routes(app: FastifyInstance): Promise<void> {
    app.post('/api/vs/sopoints/log', async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const wait = limiter.take(`sl|${clientKey(req.ip)}`, SOPOINTS_LOG_LIMIT, now());
      if (wait) return reply.header('Retry-After', String(wait)).code(429).send({ ok: false, error: `too many requests - wait ${wait}s` });
      const b = (req.body ?? {}) as { address?: unknown; summary?: unknown; bonus?: unknown; summaryS1?: unknown; layer1?: unknown; season1?: unknown; ownVolume?: unknown };
      if (typeof b.address !== 'string' || !ADDRESS.test(b.address)) return reply.code(400).send({ ok: false, error: 'address is required' });
      if (!Array.isArray(b.layer1) && !Array.isArray(b.season1) && !Array.isArray(b.ownVolume)) return reply.code(400).send({ ok: false, error: 'no weeks' });
      log ??= new SopointsLog();
      const rows = log.put(b.address, b, now());
      return reply.send({ ok: true, rows });
    });
  };
}

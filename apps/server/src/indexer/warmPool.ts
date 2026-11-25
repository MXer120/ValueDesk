/**
 * The pages a bulk write will touch, read from disk by many threads just before it (2026-11-25).
 *
 * SQLite reads a page at a time. On production's disk that is 270 reads a second (1.5 ms p50, 12 ms p95), and 16 reads at
 * once give 1,901, 64 give 4,664 (measured 2026-11-25 with O_DIRECT on the liquidation file). Every fill, activity and
 * liquidation row lands on two to four cold pages of files larger than memory, so the writer wrote 82 stream rows a second
 * while 240 came in: 9.9M rows waited in memory, a liquidation step took 14 min, and the process ended out of heap
 * (2026-11-24 17:00), those rows with it. Here the same key lookups run first, side by side, on read-only connections: the
 * pages are in the OS's cache when the one writing thread gets there. Nothing is decided from them and they hold no lock;
 * a lookup that fails or takes too long is only a page the writer reads itself.
 */
import { Worker } from 'node:worker_threads';

/** VALUESCAN_WARM_THREADS, 0 = off; off in the tests unless set. */
export const warmThreads = (): number => {
  const d = process.env.NODE_TEST_CONTEXT ? 0 : 16;
  const n = Number(process.env.VALUESCAN_WARM_THREADS ?? d);
  return Number.isFinite(n) ? Math.max(0, Math.min(64, Math.floor(n))) : d;
};
/** A warm-up never holds a write longer than this. */
export const WARM_MAX_MS = 20_000;
/** Keys per message: small, so the threads share the work evenly. */
const CHUNK = 64;

/** venue, address, id, t */
export type WarmFill = [string, string, string, number];
/** venue, acct, hour */
export type WarmActivity = [string, string, number];
/** aid, coin, venue, t, level */
export type WarmLiq = [number, string, number, number, number];
export type WarmKind = 'fills' | 'activity' | 'liq' | 'wallets';

const CODE = `
const { workerData, parentPort } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const open = (p) => { const d = new DatabaseSync(p, { readOnly: true }); d.exec('PRAGMA cache_size = -512'); d.exec('PRAGMA busy_timeout = 2000'); return d; };
let db = null, ldb = null;
const S = new Map();
const q = (d, sql) => { let s = S.get(sql); if (!s) S.set(sql, (s = d.prepare(sql))); return s; };
const RUN = {
  fills(k) {
    q(db, 'SELECT 1 FROM fills WHERE venue = ? AND address = ? AND id >= ? LIMIT 1').get(k[0], k[1], k[2]);
    q(db, 'SELECT 1 FROM fills INDEXED BY fills_t WHERE venue = ? AND address = ? AND t >= ? LIMIT 1').get(k[0], k[1], k[3]);
  },
  wallets(k) {
    q(db, 'SELECT to_t FROM coverage WHERE venue = ? AND address = ?').all(k[0], k[1]);
    q(db, 'SELECT built_at FROM fill_agg WHERE venue = ? AND address = ?').get(k[0], k[1]);
    q(db, 'SELECT MAX(day) FROM fill_day WHERE venue = ? AND address = ? AND frozen = 1').get(k[0], k[1]);
    q(db, 'SELECT 1 FROM fill_dirty WHERE venue = ? AND address = ? LIMIT 1').get(k[0], k[1]);
  },
  activity(k) {
    const d = Math.floor(k[2] / 24);
    q(db, 'SELECT trades FROM activity_hour WHERE venue = ? AND hour = ? AND acct = ?').get(k[0], k[2], k[1]);
    q(db, 'SELECT 1 FROM activity_hour INDEXED BY activity_hour_acct WHERE venue = ? AND acct = ? AND hour >= ? LIMIT 1').get(k[0], k[1], k[2]);
    q(db, 'SELECT trades FROM activity_day WHERE venue = ? AND day = ? AND acct = ?').get(k[0], d, k[1]);
    q(db, 'SELECT 1 FROM activity_day INDEXED BY activity_day_acct WHERE venue = ? AND acct = ? AND day >= ? LIMIT 1').get(k[0], k[1], d);
  },
  liq(k) {
    q(ldb, 'SELECT 1 FROM liq_log WHERE aid = ? AND coin = ? AND venue = ? AND t >= ? LIMIT 1').get(k[0], k[1], k[2], k[3]);
    q(ldb, 'SELECT 1 FROM liq_log INDEXED BY liq_log_cell WHERE coin = ? AND liq = ? AND t >= ? LIMIT 1').get(k[1], k[4], k[3]);
    q(ldb, 'SELECT 1 FROM liq_cur WHERE aid = ? AND coin = ? AND venue = ?').get(k[0], k[1], k[2]);
  },
};
parentPort.on('message', (m) => {
  let bad = 0;
  try {
    if (!db) { db = open(workerData.path); ldb = workerData.liqPath ? open(workerData.liqPath) : db; }
    const run = RUN[m.kind];
    for (const k of m.keys) { try { run(k); } catch (e) { bad++; } }
  } catch (e) { bad = m.keys.length; }
  parentPort.postMessage({ id: m.id, bad });
});
`;

type Job = { left: number; done: () => void };

export class WarmPool {
  private workers: Array<Worker | null> = [];
  private jobs = new Map<number, Job>();
  private nextId = 1;
  private at = 0;
  private stopped = false;
  readonly state = { threads: 0, keys: 0, bad: 0, waits: 0, lastMs: 0, maxMs: 0, timeouts: 0, deaths: 0 };

  constructor(private readonly path: string, private readonly liqPath: string | null, threads: number) {
    this.state.threads = threads;
    this.workers = Array.from({ length: threads }, () => null);
  }

  /** A pool that keeps dying turns itself off. */
  get on(): boolean {
    return !this.stopped && this.workers.length > 0 && this.state.deaths < 20;
  }

  /** Read these keys' pages. Resolves when they are read, or after WARM_MAX_MS; never rejects. */
  warm(kind: WarmKind, keys: ReadonlyArray<readonly unknown[]>): Promise<void> {
    if (!this.on || !keys.length) return Promise.resolve();
    const t0 = Date.now();
    const id = this.nextId++;
    return new Promise<void>((ok) => {
      const finish = (): void => {
        if (!this.jobs.delete(id)) return;
        clearTimeout(timer);
        this.state.lastMs = Date.now() - t0;
        this.state.maxMs = Math.max(this.state.maxMs, this.state.lastMs);
        ok();
      };
      const timer = setTimeout(() => { this.state.timeouts++; finish(); }, WARM_MAX_MS);
      this.state.waits++;
      this.state.keys += keys.length;
      this.jobs.set(id, { left: Math.ceil(keys.length / CHUNK), done: finish });
      for (let i = 0; i < keys.length; i += CHUNK) this.worker().postMessage({ id, kind, keys: keys.slice(i, i + CHUNK) });
    });
  }

  private worker(): Worker {
    const i = this.at;
    this.at = (this.at + 1) % this.workers.length;
    const have = this.workers[i];
    if (have) return have;
    const w = new Worker(CODE, { eval: true, execArgv: [], workerData: { path: this.path, liqPath: this.liqPath }, resourceLimits: { maxOldGenerationSizeMb: 128 } });
    w.unref();
    this.workers[i] = w;
    w.on('message', (m: { id: number; bad: number }) => {
      this.state.bad += m.bad;
      const j = this.jobs.get(m.id);
      if (j && --j.left <= 0) j.done();
    });
    w.on('error', () => {});
    w.on('exit', () => {
      if (this.workers[i] !== w) return;
      this.workers[i] = null;
      if (this.stopped) return;
      this.state.deaths++;
      for (const j of [...this.jobs.values()]) j.done();
    });
    return w;
  }

  stop(): void {
    this.stopped = true;
    for (const j of [...this.jobs.values()]) j.done();
    const ws = this.workers;
    this.workers = [];
    for (const w of ws) void w?.terminate();
  }
}

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
/** venue, address */
export type WarmBook = readonly [string, string];
/** venue, address, from t, to t */
export type WarmRange = [string, string, number, number];
export type WarmKind = 'fills' | 'activity' | 'liq' | 'wallets' | 'members' | 'books' | 'range';

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
  members(k) {
    const r = q(db, 'SELECT rev, at FROM cohort_member WHERE venue = ? AND address = ?').get(k[0], k[1]);
    if (r) q(db, 'SELECT 1 FROM cohort_member INDEXED BY cohort_member_rev WHERE venue = ? AND rev >= ? LIMIT 1').get(k[0], r.rev);
  },
  books(k) {
    const r = q(db, 'SELECT rev, at FROM cohort_book WHERE venue = ? AND address = ?').get(k[0], k[1]);
    if (r) q(db, 'SELECT 1 FROM cohort_book INDEXED BY cohort_book_rev WHERE venue = ? AND rev >= ? LIMIT 1').get(k[0], r.rev);
  },
  // The same read as store.dropStreamRowsAsync makes of a wallet's range, each row's src looked up in the table.
  range(k) {
    let t = k[2], id = '';
    for (let n = 0; n < 40; n++) {
      const rows = q(db, 'SELECT id, t, src FROM fills WHERE venue = ? AND address = ? AND (t, id) > (?, ?) AND t <= ? ORDER BY t, id LIMIT 1000').all(k[0], k[1], t, id, k[3]);
      if (rows.length < 1000) return;
      t = rows[999].t; id = rows[999].id;
    }
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
  parentPort.postMessage({ bad });
});
`;

type Job = { id: number; kind: WarmKind; chunks: Array<ReadonlyArray<readonly unknown[]>>; next: number; left: number; low: boolean; done: () => void };
type Slot = { w: Worker | null; job: Job | null };

/**
 * A thread takes a chunk when it is free, small jobs first (2026-11-25: handed out in turn, a liquidation step's 8,000 keys
 * stood before every wallet read's 50, up to WARM_MAX_MS each: 2 Hyperliquid reads in 10 min with 1,222 waiting). The big
 * ones (a liquidation step) have half of the threads at most, and what a timed-out job has left is not read.
 */
export class WarmPool {
  private slots: Slot[];
  private jobs: Job[] = [];
  private nextId = 1;
  private stopped = false;
  readonly state = { threads: 0, keys: 0, bad: 0, waits: 0, lastMs: 0, maxMs: 0, timeouts: 0, deaths: 0, queued: 0 };

  constructor(private readonly path: string, private readonly liqPath: string | null, threads: number) {
    this.state.threads = threads;
    this.slots = Array.from({ length: threads }, () => ({ w: null, job: null }));
  }

  /** A pool that keeps dying turns itself off. */
  get on(): boolean {
    return !this.stopped && this.slots.length > 0 && this.state.deaths < 20;
  }

  /** Read these keys' pages. Resolves when they are read, or after WARM_MAX_MS; never rejects. */
  warm(kind: WarmKind, keys: ReadonlyArray<readonly unknown[]>): Promise<void> {
    if (!this.on || !keys.length) return Promise.resolve();
    const t0 = Date.now();
    return new Promise<void>((ok) => {
      const chunks: Job['chunks'] = [];
      for (let i = 0; i < keys.length; i += CHUNK) chunks.push(keys.slice(i, i + CHUNK));
      const job: Job = {
        id: this.nextId++, kind, chunks, next: 0, left: chunks.length, low: kind === 'liq',
        done: () => {
          const i = this.jobs.indexOf(job);
          if (i < 0) return;
          this.jobs.splice(i, 1);
          clearTimeout(timer);
          this.state.queued = this.jobs.length;
          this.state.lastMs = Date.now() - t0;
          this.state.maxMs = Math.max(this.state.maxMs, this.state.lastMs);
          ok();
        },
      };
      const timer = setTimeout(() => { this.state.timeouts++; job.done(); }, WARM_MAX_MS);
      this.state.waits++;
      this.state.keys += keys.length;
      this.jobs.push(job);
      this.state.queued = this.jobs.length;
      this.pump();
    });
  }

  private pump(): void {
    if (!this.on) {
      for (const j of [...this.jobs]) j.done();
      return;
    }
    const lowMax = Math.max(1, this.slots.length >> 1);
    let low = this.slots.reduce((n, s) => n + (s.job?.low ? 1 : 0), 0);
    for (const s of this.slots) {
      if (s.job) continue;
      const open = (j: Job) => j.next < j.chunks.length;
      const job = this.jobs.find((j) => !j.low && open(j)) ?? (low < lowMax ? this.jobs.find((j) => j.low && open(j)) : undefined);
      if (!job) return;
      if (job.low) low++;
      s.job = job;
      this.worker(s).postMessage({ kind: job.kind, keys: job.chunks[job.next++]! });
    }
  }

  private worker(s: Slot): Worker {
    if (s.w) return s.w;
    const w = new Worker(CODE, { eval: true, execArgv: [], workerData: { path: this.path, liqPath: this.liqPath }, resourceLimits: { maxOldGenerationSizeMb: 128 } });
    w.unref();
    s.w = w;
    const answered = (): void => {
      const j = s.job;
      s.job = null;
      if (j && --j.left <= 0) j.done();
      this.pump();
    };
    w.on('message', (m: { bad: number }) => {
      this.state.bad += m.bad;
      answered();
    });
    w.on('error', () => {});
    w.on('exit', () => {
      if (s.w !== w) return;
      s.w = null;
      if (this.stopped) return;
      this.state.deaths++;
      answered();
    });
    return w;
  }

  stop(): void {
    this.stopped = true;
    for (const j of [...this.jobs]) j.done();
    const ws = this.slots.map((s) => s.w);
    this.slots = [];
    for (const w of ws) void w?.terminate();
  }
}

/**
 * The index's WAL checkpoint on a thread of its own.
 *
 * Left to itself SQLite checkpoints inside the COMMIT that crosses the limit, on the writer's thread, and the
 * fsync at its end does the disk writeback in that thread's time: on 2026-11-05 the indexer's thread was 54% in
 * the kernel and 15% blocked in fsync, and one flush held it up to 12 s. PASSIVE never blocks the writer or a
 * reader, and copying pages to the file changes no figure: only where the work is done.
 *
 * Now and then a full checkpoint, so the WAL can start over. It only does when every frame is in the file at the moment the
 * writer begins a write, and a PASSIVE run with the writer busy all the time ends with new frames behind it: on 2026-11-06
 * the WAL stood at 1.6 GB, and each frame extended the file at 250 us a write. A FULL run holds the write lock, so it follows
 * two PASSIVE runs and has little left to copy, and it gives up soon if a reader is in the way (the next round tries again).
 *
 * Should the thread die or hang, the writer goes back to checkpointing for itself, so the WAL can never grow
 * without bound for want of this thread; another is started a minute later.
 */
import { Worker } from 'node:worker_threads';

export const CHECKPOINT_EVERY_MS = 3_000;
const RESTART_AFTER_MS = 60_000;
/** No answer for this long: hung. Far past the slowest seen (2.9 s), and a stalled writer only costs a restart here. */
const HUNG_MS = 180_000;
/** Frames in the WAL (4 KiB each) that call for a full checkpoint: 264 MB, under the file's limit (store.ts WAL_LIMIT_BYTES). */
const RESTART_FRAMES = 64_000;
/** At most one this often: the writer waits for its length. */
const RESTART_GAP_MS = 30_000;
/** How long it may wait for the write lock and for readers, holding up the writer meanwhile. */
const RESTART_WAIT_MS = 250;

// Plain JavaScript in a string: the thread needs no TypeScript loader, in production or in a test.
const CODE = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(workerData.path);
db.exec('PRAGMA busy_timeout = 0');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA wal_autocheckpoint = 0');
const ask = db.prepare('PRAGMA wal_checkpoint(PASSIVE)');
const full = db.prepare('PRAGMA wal_checkpoint(FULL)');
let fullAt = 0;
parentPort.postMessage({ ready: true });
setInterval(() => {
  const t = Date.now();
  try {
    const r = ask.get();
    let fullMs, fullBusy;
    if (r.log >= workerData.restartFrames && Date.now() - fullAt >= workerData.restartGapMs) {
      ask.get();
      db.exec('PRAGMA busy_timeout = ' + workerData.restartWaitMs);
      const f0 = Date.now();
      try {
        fullBusy = full.get().busy;
      } finally {
        db.exec('PRAGMA busy_timeout = 0');
      }
      fullAt = Date.now();
      fullMs = fullAt - f0;
    }
    parentPort.postMessage({ ms: Date.now() - t, log: r.log, done: r.checkpointed, busy: r.busy, fullMs, fullBusy });
  } catch (e) {
    parentPort.postMessage({ ms: Date.now() - t, error: String(e && e.message || e) });
  }
}, workerData.everyMs);
`;

export interface CheckpointStatus {
  /** True: this thread does the checkpoints. False: the writer does them itself. */
  running: boolean;
  runs: number;
  lastMs: number;
  maxMs: number;
  /** Pages in the WAL at the last run, and how many of them were in the file after it. */
  log: number;
  done: number;
  errors: number;
  /** Full checkpoints: how many, those a reader or the writer kept from finishing, and the longest (the writer waits that long). */
  fulls: number;
  fullsBusy: number;
  fullMaxMs: number;
  restarts: number;
  lastError: string | null;
}

export class Checkpointer {
  private worker: Worker | null = null;
  private stopped = false;
  private lastAt = 0;
  private watch: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  readonly state: CheckpointStatus = { running: false, runs: 0, lastMs: 0, maxMs: 0, log: 0, done: 0, errors: 0, fulls: 0, fullsBusy: 0, fullMaxMs: 0, restarts: 0, lastError: null };

  /** `writerChecks(true)`: the writer checkpoints for itself; `false`: it leaves them to this thread. */
  constructor(
    private readonly path: string,
    private readonly writerChecks: (on: boolean) => void,
    private readonly o: { everyMs?: number; hungMs?: number; restartAfterMs?: number; restartFrames?: number; restartGapMs?: number } = {},
  ) {
    this.start();
    this.watch = setInterval(() => {
      if (this.worker && Date.now() - this.lastAt > (this.o.hungMs ?? HUNG_MS)) void this.worker.terminate();
    }, Math.min(30_000, this.o.hungMs ?? HUNG_MS));
    this.watch.unref();
  }

  private start(): void {
    if (this.stopped) return;
    const w = new Worker(CODE, { eval: true, execArgv: [], workerData: { path: this.path, everyMs: this.o.everyMs ?? CHECKPOINT_EVERY_MS, restartFrames: this.o.restartFrames ?? RESTART_FRAMES, restartGapMs: this.o.restartGapMs ?? RESTART_GAP_MS, restartWaitMs: RESTART_WAIT_MS } });
    w.unref();
    this.worker = w;
    this.lastAt = Date.now();
    w.on('message', (m: { ready?: boolean; ms?: number; log?: number; done?: number; error?: string; fullMs?: number; fullBusy?: number }) => {
      this.lastAt = Date.now();
      if (m.ready) {
        // Only now: until the thread has its connection open, the writer goes on doing them.
        this.writerChecks(false);
        this.state.running = true;
        return;
      }
      if (m.error) {
        this.state.errors++;
        this.state.lastError = m.error;
        return;
      }
      this.state.runs++;
      this.state.lastMs = m.ms ?? 0;
      this.state.maxMs = Math.max(this.state.maxMs, m.ms ?? 0);
      this.state.log = m.log ?? 0;
      this.state.done = m.done ?? 0;
      if (m.fullMs !== undefined) {
        this.state.fulls++;
        if (m.fullBusy) this.state.fullsBusy++;
        this.state.fullMaxMs = Math.max(this.state.fullMaxMs, m.fullMs);
      }
    });
    w.on('error', (e) => {
      this.state.lastError = String(e instanceof Error ? e.message : e);
    });
    w.on('exit', () => {
      this.worker = null;
      this.state.running = false;
      if (this.stopped) return;
      this.writerChecks(true);
      this.state.restarts++;
      console.warn(`[indexer] checkpoint thread ended (${this.state.lastError ?? 'no error'}): the writer checkpoints until it is back`);
      this.retry = setTimeout(() => this.start(), this.o.restartAfterMs ?? RESTART_AFTER_MS);
      this.retry.unref();
    });
  }

  /** For a test: the thread dies. */
  kill(): Promise<number> {
    return this.worker ? this.worker.terminate() : Promise.resolve(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.watch) clearInterval(this.watch);
    if (this.retry) clearTimeout(this.retry);
    void this.worker?.terminate();
    this.worker = null;
    this.state.running = false;
    // The store may stay open a moment longer: whatever it still writes, it checkpoints itself.
    this.writerChecks(true);
  }
}

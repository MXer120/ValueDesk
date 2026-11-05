/**
 * The index's WAL checkpoint on a thread of its own.
 *
 * Left to itself SQLite checkpoints inside the COMMIT that crosses the limit, on the writer's thread, and the
 * fsync at its end does the disk writeback in that thread's time: on 2026-11-05 the indexer's thread was 54% in
 * the kernel and 15% blocked in fsync, and one flush held it up to 12 s. PASSIVE never blocks the writer or a
 * reader, and copying pages to the file changes no figure: only where the work is done.
 *
 * Should the thread die or hang, the writer goes back to checkpointing for itself, so the WAL can never grow
 * without bound for want of this thread; another is started a minute later.
 */
import { Worker } from 'node:worker_threads';

export const CHECKPOINT_EVERY_MS = 3_000;
const RESTART_AFTER_MS = 60_000;
/** No answer for this long: hung. Far past the slowest seen (2.9 s), and a stalled writer only costs a restart here. */
const HUNG_MS = 180_000;

// Plain JavaScript in a string: the thread needs no TypeScript loader, in production or in a test.
const CODE = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(workerData.path);
db.exec('PRAGMA busy_timeout = 0');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA wal_autocheckpoint = 0');
const ask = db.prepare('PRAGMA wal_checkpoint(PASSIVE)');
parentPort.postMessage({ ready: true });
setInterval(() => {
  const t = Date.now();
  try {
    const r = ask.get();
    parentPort.postMessage({ ms: Date.now() - t, log: r.log, done: r.checkpointed, busy: r.busy });
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
  restarts: number;
  lastError: string | null;
}

export class Checkpointer {
  private worker: Worker | null = null;
  private stopped = false;
  private lastAt = 0;
  private watch: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  readonly state: CheckpointStatus = { running: false, runs: 0, lastMs: 0, maxMs: 0, log: 0, done: 0, errors: 0, restarts: 0, lastError: null };

  /** `writerChecks(true)`: the writer checkpoints for itself; `false`: it leaves them to this thread. */
  constructor(
    private readonly path: string,
    private readonly writerChecks: (on: boolean) => void,
    private readonly o: { everyMs?: number; hungMs?: number; restartAfterMs?: number } = {},
  ) {
    this.start();
    this.watch = setInterval(() => {
      if (this.worker && Date.now() - this.lastAt > (this.o.hungMs ?? HUNG_MS)) void this.worker.terminate();
    }, Math.min(30_000, this.o.hungMs ?? HUNG_MS));
    this.watch.unref();
  }

  private start(): void {
    if (this.stopped) return;
    const w = new Worker(CODE, { eval: true, execArgv: [], workerData: { path: this.path, everyMs: this.o.everyMs ?? CHECKPOINT_EVERY_MS } });
    w.unref();
    this.worker = w;
    this.lastAt = Date.now();
    w.on('message', (m: { ready?: boolean; ms?: number; log?: number; done?: number; error?: string }) => {
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

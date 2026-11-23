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
/** No answer for this long, and not inside a run: hung (the loop of the thread itself is stuck). */
const HUNG_MS = 180_000;
/**
 * Inside one run for this long: hung. A run is a single SQLite call that says nothing until it returns, and a slow disk
 * makes it long, not stuck: on 2026-11-23 runs took up to 195 s (checkpoint.maxMs), and HUNG_MS ended the thread twice
 * (00:27:59, 00:34:24). The work did not go away with it - the writer took it over inside its COMMITs, and the indexer's
 * thread stood 57 s (two commits of 32.4 s and 23.1 s). Ending a run only moves it onto a thread that matters more.
 */
const RUN_HUNG_MS = 30 * 60_000;
/** Frames in the WAL (4 KiB each) that call for a full checkpoint: 264 MB, under the file's limit (store.ts WAL_LIMIT_BYTES). */
const RESTART_FRAMES = 64_000;
/** At most one this often: the writer waits for its length. */
const RESTART_GAP_MS = 30_000;
/** How long it may wait for the write lock and for readers, holding up the writer meanwhile. */
const RESTART_WAIT_MS = 250;
/** Frames PASSIVE may leave behind for a FULL run to go ahead (2,000 x 4 KiB = 8 MB: well under a second of copying). */
const RESTART_MAX_BEHIND = 2_000;
/**
 * The PASSIVE run just before a FULL one took longer than this: no FULL run this round. The FULL run copies and syncs the
 * file like PASSIVE does, but holding the write lock, so a slow disk makes it hold the lock for as long: production
 * 2026-11-23, PASSIVE runs at 12.6 s, FULL runs up to 60.7 s (fullMaxMs), every write of the indexer waiting on it (lock
 * waits of 5-9.5 s in "slow write", the writer thread's maxLockMs 17 s).
 */
const RESTART_MAX_PASSIVE_MS = 1_000;
/**
 * A FULL run that a reader kept from finishing (busy: the WAL cannot start over) waits twice as long before the next, up to
 * this; one that finishes resets the wait. Production 2026-11-23: 104 of 150 FULL runs busy, each still holding the lock.
 */
const RESTART_GAP_MAX_MS = 5 * 60_000;

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
let gap = workerData.restartGapMs;
parentPort.postMessage({ ready: true });
setInterval(() => {
  const t = Date.now();
  // Said before the run, which says nothing until it returns: the main thread knows a long silence is a run, not a hang.
  parentPort.postMessage({ run: t });
  if (workerData.testRunHoldMs) { const end = Date.now() + workerData.testRunHoldMs; while (Date.now() < end) { /* a slow disk */ } }
  try {
    const r = ask.get();
    let fullMs, fullBusy;
    // A FULL run holds the write lock while it copies what PASSIVE left behind: with the writer thread busy that was up
    // to 34 s (fullMaxMs 34,341 on production 2026-11-09 13:56), every write of the indexer and the writer waiting on it.
    // So only when the PASSIVE run just before left at most restartMaxBehind frames: the lock is then held for well under
    // a second. Otherwise the next round tries again (the WAL file only grows past its limit meanwhile, nothing is held).
    const r2At = Date.now();
    const r2 = r.log >= workerData.restartFrames && r2At - fullAt >= gap ? ask.get() : null;
    const r2Ms = Date.now() - r2At;
    let fullSkipped = 0;
    if (r2 && r2.log - r2.checkpointed <= workerData.restartMaxBehind && r2Ms > workerData.restartMaxPassiveMs) fullSkipped = 1;
    else if (r2 && r2.log - r2.checkpointed <= workerData.restartMaxBehind) {
      db.exec('PRAGMA busy_timeout = ' + workerData.restartWaitMs);
      const f0 = Date.now();
      try {
        fullBusy = full.get().busy;
      } finally {
        db.exec('PRAGMA busy_timeout = 0');
      }
      fullAt = Date.now();
      fullMs = fullAt - f0;
      gap = fullBusy ? Math.min(gap * 2, workerData.restartGapMaxMs) : workerData.restartGapMs;
    }
    parentPort.postMessage({ ms: Date.now() - t, log: r.log, done: r.checkpointed, busy: r.busy, fullMs, fullBusy, fullSkipped, gap });
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
  /** FULL runs not made because the PASSIVE run before was slow (RESTART_MAX_PASSIVE_MS), and the wait between FULL runs now. */
  fullsSkippedSlow: number;
  fullGapMs: number;
  /** Since when the thread is inside a run (0: between runs). */
  runSince: number;
  restarts: number;
  lastError: string | null;
}

/**
 * Ended as hung: silent for `hungMs` between runs, or inside one run for `runHungMs` (a run says nothing until it returns,
 * and on a slow disk that is minutes: see RUN_HUNG_MS).
 */
export function isHung(runSince: number, lastAt: number, now: number, hungMs: number, runHungMs: number): boolean {
  return runSince > 0 ? now - runSince > runHungMs : now - lastAt > hungMs;
}

export class Checkpointer {
  private worker: Worker | null = null;
  private stopped = false;
  private lastAt = 0;
  private watch: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  readonly state: CheckpointStatus = { running: false, runs: 0, lastMs: 0, maxMs: 0, log: 0, done: 0, errors: 0, fulls: 0, fullsBusy: 0, fullMaxMs: 0, fullsSkippedSlow: 0, fullGapMs: 0, runSince: 0, restarts: 0, lastError: null };

  /** `writerChecks(true)`: the writer checkpoints for itself; `false`: it leaves them to this thread. */
  constructor(
    private readonly path: string,
    private readonly writerChecks: (on: boolean) => void,
    private readonly o: {
      everyMs?: number; hungMs?: number; runHungMs?: number; restartAfterMs?: number; restartFrames?: number; restartGapMs?: number;
      restartGapMaxMs?: number; restartMaxBehind?: number; restartMaxPassiveMs?: number; testRunHoldMs?: number;
    } = {},
  ) {
    this.start();
    this.watch = setInterval(() => {
      const now = Date.now();
      if (this.worker && isHung(this.state.runSince, this.lastAt, now, this.o.hungMs ?? HUNG_MS, this.o.runHungMs ?? RUN_HUNG_MS)) {
        this.state.lastError = this.state.runSince ? `one run for ${Math.round((now - this.state.runSince) / 1000)} s` : `no answer for ${Math.round((now - this.lastAt) / 1000)} s`;
        void this.worker.terminate();
      }
    }, Math.min(30_000, this.o.hungMs ?? HUNG_MS));
    this.watch.unref();
  }

  private start(): void {
    if (this.stopped) return;
    const w = new Worker(CODE, { eval: true, execArgv: [], workerData: { path: this.path, everyMs: this.o.everyMs ?? CHECKPOINT_EVERY_MS, restartFrames: this.o.restartFrames ?? RESTART_FRAMES, restartGapMs: this.o.restartGapMs ?? RESTART_GAP_MS, restartWaitMs: RESTART_WAIT_MS, restartMaxBehind: this.o.restartMaxBehind ?? RESTART_MAX_BEHIND, restartGapMaxMs: this.o.restartGapMaxMs ?? RESTART_GAP_MAX_MS, restartMaxPassiveMs: this.o.restartMaxPassiveMs ?? RESTART_MAX_PASSIVE_MS, testRunHoldMs: this.o.testRunHoldMs ?? 0 } });
    w.unref();
    this.worker = w;
    this.lastAt = Date.now();
    w.on('message', (m: { ready?: boolean; run?: number; ms?: number; log?: number; done?: number; error?: string; fullMs?: number; fullBusy?: number; fullSkipped?: number; gap?: number }) => {
      this.lastAt = Date.now();
      if (m.run !== undefined) {
        this.state.runSince = m.run;
        return;
      }
      this.state.runSince = 0;
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
      if (m.fullSkipped) this.state.fullsSkippedSlow++;
      if (m.gap !== undefined) this.state.fullGapMs = m.gap;
    });
    w.on('error', (e) => {
      this.state.lastError = String(e instanceof Error ? e.message : e);
    });
    w.on('exit', () => {
      this.worker = null;
      this.state.running = false;
      this.state.runSince = 0;
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

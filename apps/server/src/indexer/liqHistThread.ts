/**
 * The liquidation history answers on their own thread (2026-11-07 outage).
 *
 * /api/vs/liquidations/history and /at read and parse snapshots synchronously, in amounts that grow with the window:
 * BTC's 30 days are 1,156 snapshots and 64.6 MB of JSON, 3.4 s to read and 0.9 s to parse on server 1 with the file in
 * the page cache (measured 2026-11-07 15:5x), far longer from disk; the fine bands of one BTC day took 1.7 s to read. On
 * the API's one thread nothing else ran meanwhile: at 15:19:35-15:20:48 seventeen history requests came in (the web asks
 * the one-piece 30-day history when the tile index fails), one took 52.6 s, the log stopped for 27 s and 38 s, and every
 * health check timed out for three minutes.
 *
 * So these answers are built here, on a worker with its own read-only connection, and handed back as JSON text (no
 * structured clone of the points on the API's thread). Identical asks in flight share one build; at most MAX_QUEUE wait,
 * the rest are told "busy" at once; one that takes longer than JOB_MS is answered "busy" and the thread is started again
 * (a statement cannot be interrupted any other way). VALUESCAN_LIQ_THREAD=0, and the tests unless they ask for it, build
 * inline as before.
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import type { Venue } from '../valuedesk/types.js';
import type { FineAsk, FineDraw, LiqRange } from './liqRead.js';
import type { LevBand } from '../valuedesk/liquidations/math.js';

export type LiqJob =
  | { kind: 'history'; coin: string; venues: Venue[]; range: LiqRange; wallets: string[]; known: { points: Array<{ t: number; p: number; st: number }>; coins: string[] } | null }
  | { kind: 'fine'; coin: string; venues: Venue[]; t0: number; t1: number; ask: FineAsk; draw: FineDraw | null }
  | { kind: 'walletFine'; coin: string; venues: Venue[]; wallets: string[]; snaps: Array<{ t: number; p: number }>; ask: FineAsk; draw: FineDraw | null }
  | { kind: 'at'; coin: string; venues: Venue[]; t: number; from: number; to: number; side: 'long' | 'short' | 'both'; wallets: string[]; limit: number; lev: ReadonlySet<LevBand> | null };

/** Asks waiting or running at most; the next is answered busy. */
export const MAX_QUEUE = 24;
/** One ask longer than this: answered busy, and the thread restarted. */
export const JOB_MS = 25_000;

export class LiqBusy extends Error {
  constructor(msg = 'The liquidation history is busy - try again in a moment') { super(msg); }
}

/** The answer of one job, as JSON text; 'null' when there is no index. */
async function build(job: LiqJob): Promise<string> {
  const r = await import('./liqRead.js');
  switch (job.kind) {
    case 'history': return JSON.stringify(r.liqHistory(job.coin, job.venues, job.range, job.wallets, job.known));
    case 'fine': return JSON.stringify(r.liqHistoryFine(job.coin, job.venues, job.t0, job.t1, job.ask, job.draw));
    case 'walletFine': return JSON.stringify(r.walletHistoryFine(job.coin, job.venues, job.wallets, job.snaps, job.ask, job.draw));
    case 'at': return JSON.stringify(r.liqAt(job.coin, job.venues, job.t, job.from, job.to, job.side, job.wallets, job.limit, job.lev));
  }
}

// --- the worker --------------------------------------------------------------------------------

if (!isMainThread && (workerData as { liqHistThread?: boolean } | null)?.liqHistThread) {
  parentPort!.on('message', (m: { id: number; job: LiqJob }) => {
    build(m.job).then(
      (json) => parentPort!.postMessage({ id: m.id, json }),
      (e) => parentPort!.postMessage({ id: m.id, error: String((e as Error)?.message ?? e) }),
    );
  });
}

// --- the API side ------------------------------------------------------------------------------

interface Waiting { ok: (json: string) => void; no: (e: Error) => void }
let worker: Worker | null = null;
let nextId = 1;
const running = new Map<number, { key: string; started: number; timer: NodeJS.Timeout; waiting: Waiting[] }>();
const byKey = new Map<string, number>();
/** Jobs done, failed and refused, for the health answer. */
export const liqThreadStats = { done: 0, busy: 0, failed: 0, restarts: 0, longestMs: 0 };

function threadOn(): boolean {
  const v = process.env.VALUESCAN_LIQ_THREAD;
  if (v === '0') return false;
  if (v === '1') return true;
  return !process.env.NODE_TEST_CONTEXT;
}

function settle(id: number, f: (w: Waiting) => void): void {
  const r = running.get(id);
  if (!r) return;
  running.delete(id);
  byKey.delete(r.key);
  clearTimeout(r.timer);
  const ms = Date.now() - r.started;
  liqThreadStats.longestMs = Math.max(liqThreadStats.longestMs, ms);
  for (const w of r.waiting) f(w);
}

function thread(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL(import.meta.url), { workerData: { liqHistThread: true }, resourceLimits: { maxOldGenerationSizeMb: 1536 } });
  worker = w;
  w.unref();
  w.on('message', (m: { id: number; json?: string; error?: string }) => {
    if (m.error !== undefined) { liqThreadStats.failed++; settle(m.id, (x) => x.no(new Error(m.error))); return; }
    liqThreadStats.done++;
    settle(m.id, (x) => x.ok(m.json ?? 'null'));
  });
  const gone = () => {
    if (worker !== w) return;
    worker = null;
    for (const id of [...running.keys()]) settle(id, (x) => x.no(new LiqBusy()));
  };
  w.on('error', gone);
  w.on('exit', gone);
  return w;
}

/** The job's answer as JSON text ('null': no index yet). Throws LiqBusy when the thread is full or the job ran too long. */
export async function liqJob(job: LiqJob): Promise<string> {
  if (!threadOn()) return build(job);
  const key = JSON.stringify(job, (_k, v) => (v instanceof Set ? [...v].sort() : v));
  const same = byKey.get(key);
  if (same !== undefined) return new Promise((ok, no) => running.get(same)!.waiting.push({ ok, no }));
  if (running.size >= MAX_QUEUE) { liqThreadStats.busy++; throw new LiqBusy(); }
  const id = nextId++;
  const p = new Promise<string>((ok, no) => {
    const timer = setTimeout(() => {
      // A statement cannot be stopped from here: the thread goes, and every ask on it is answered busy.
      liqThreadStats.busy++;
      liqThreadStats.restarts++;
      const w = worker;
      worker = null;
      for (const rid of [...running.keys()]) settle(rid, (x) => x.no(new LiqBusy()));
      void w?.terminate();
    }, JOB_MS);
    timer.unref();
    running.set(id, { key, started: Date.now(), timer, waiting: [{ ok, no }] });
  });
  byKey.set(key, id);
  thread().postMessage({ id, job });
  return p;
}

/** The answer as the route sends it: `{"ok":true,...body}` (null: no index). */
export function okJson(json: string): string | null {
  if (json === 'null') return null;
  return json === '{}' ? '{"ok":true}' : `{"ok":true,${json.slice(1)}`;
}

/** Tests: stop the thread. */
export async function stopLiqThread(): Promise<void> {
  const w = worker;
  worker = null;
  for (const id of [...running.keys()]) settle(id, (x) => x.no(new LiqBusy()));
  await w?.terminate();
}

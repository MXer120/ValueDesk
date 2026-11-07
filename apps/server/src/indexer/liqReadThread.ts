/**
 * The heatmap tiles' reads of the snapshot table on their own thread (2026-11-07 17:19-17:42: API stalls of 5-28 s).
 *
 * liqTiles.ts lists a coin's snapshots (time and length) and reads the ones it parses. Each listed snapshot is one leaf
 * page of liq_hist (rows of ~75 KB, key coin + t), so a coin's 30 days are ~1,200 random page reads: 10-60 ms with the
 * file in the page cache, but 5-28 s on server 1 while the indexer writes and checkpoints (the API's own stall profiles,
 * 16:45 5 s and 17:19 28 s, all in liqHistMeta's statement). A statement cannot be sliced, so it ran on the API's one
 * thread in one piece and the health check timed out behind it.
 *
 * Here those statements run on a worker with its own read-only connection; the API thread only gets the answers (times
 * and lengths, or the snapshots' JSON text) and parses them in its slices. VALUESCAN_LIQ_THREAD=0, and the tests unless
 * they ask for it, read inline as before.
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import type { IndexStore } from './store.js';
import type { Venue } from '../valuedesk/types.js';

/** A snapshot's meta without its time and length (liqTiles.ts metaOfData). */
export type MetaWire = { p: number; st: number; sc: Float64Array };

export type LiqRead =
  | { op: 'list'; coin: string; from: number; to: number }
  | { op: 'coins' }
  | { op: 'snaps'; coin: string; ts: number[] }
  /** Only the metas, parsed where read: the snapshots' JSON never reaches the asking thread. */
  | { op: 'metas'; coin: string; venues: Venue[]; ts: number[] };

type Answer<R extends LiqRead> = R extends { op: 'list' } ? Array<{ t: number; n: number }>
  : R extends { op: 'coins' } ? string[]
  : R extends { op: 'metas' } ? Array<MetaWire | null>
  : Array<string | null>;

/** liqTiles.ts registers how a meta is worked out (no import cycle from here). */
let metaOf: ((data: string, venues: readonly Venue[]) => MetaWire | null) | null = null;
export function setMetaOf(f: (data: string, venues: readonly Venue[]) => MetaWire | null): void { metaOf = f; }

/** One read longer than this: refused, and the thread started again (a statement cannot be stopped any other way). */
export const READ_MS = 60_000;

/** octet_length reads the length from the record header, not the 75 KB of data (SQLite 3.43+); length() for an older one. */
let lengthFn: 'octet_length' | 'length' = 'octet_length';

/** The read, on whichever thread runs it. */
export function runRead(s: IndexStore, r: LiqRead): unknown {
  switch (r.op) {
    case 'list':
      try {
        return lengthFn === 'octet_length' ? s.liqHistMeta(r.coin, r.from, r.to) : s.liqHistMetaSlow(r.coin, r.from, r.to);
      } catch (e) {
        if (lengthFn === 'octet_length' && /octet_length/i.test(String((e as Error).message))) {
          lengthFn = 'length';
          return s.liqHistMetaSlow(r.coin, r.from, r.to);
        }
        throw e;
      }
    case 'coins': return s.liqHistCoins();
    case 'snaps': return r.ts.map((t) => s.liqHistAt(r.coin, t));
    case 'metas': {
      if (!metaOf) throw new Error('liqTiles.ts is not loaded');
      const f = metaOf;
      return r.ts.map((t) => { const d = s.liqHistAt(r.coin, t); return d === null ? null : f(d, r.venues); });
    }
  }
}

// --- the worker --------------------------------------------------------------------------------

if (!isMainThread && (workerData as { liqReadThread?: boolean } | null)?.liqReadThread) {
  const { reader } = await import('./reader.js');
  // liqTiles.ts registers metaOf in this thread. Loaded on the first ask, after this module is done: imported at the top
  // it is a cycle (it imports this file) that waits on itself.
  let tiles: Promise<unknown> | null = null;
  parentPort!.on('message', async (m: { id: number; read: LiqRead }) => {
    try {
      if (m.read.op === 'metas' && !metaOf) await (tiles ??= import('./liqTiles.js'));
      const s = reader();
      parentPort!.postMessage({ id: m.id, rows: s ? runRead(s, m.read) : null });
    } catch (e) {
      parentPort!.postMessage({ id: m.id, error: String((e as Error)?.message ?? e) });
    }
  });
}

// --- the API side ------------------------------------------------------------------------------

let worker: Worker | null = null;
let nextId = 1;
const waiting = new Map<number, { ok: (v: unknown) => void; no: (e: Error) => void; timer: NodeJS.Timeout }>();
/** Reads done and failed, and the longest, for the health answer. */
export const liqReadStats = { done: 0, failed: 0, restarts: 0, longestMs: 0 };

function threadOn(): boolean {
  const v = process.env.VALUESCAN_LIQ_THREAD;
  if (v === '0') return false;
  if (v === '1') return true;
  return !process.env.NODE_TEST_CONTEXT;
}

function failAll(why: string): void {
  for (const r of waiting.values()) { clearTimeout(r.timer); r.no(new Error(why)); }
  waiting.clear();
}

function thread(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL(import.meta.url), { workerData: { liqReadThread: true }, resourceLimits: { maxOldGenerationSizeMb: 512 } });
  worker = w;
  w.unref();
  w.on('message', (m: { id: number; rows?: unknown; error?: string }) => {
    const r = waiting.get(m.id);
    if (!r) return;
    waiting.delete(m.id);
    clearTimeout(r.timer);
    if (m.error !== undefined) { liqReadStats.failed++; r.no(new Error(m.error)); return; }
    liqReadStats.done++;
    r.ok(m.rows);
  });
  const gone = () => {
    if (worker !== w) return;
    worker = null;
    failAll('the snapshot reader stopped');
  };
  w.on('error', gone);
  w.on('exit', gone);
  return w;
}

/** A read of the snapshot table off this thread (null: no index file yet). */
export function liqRead<R extends LiqRead>(read: R, inline: () => IndexStore | null): Promise<Answer<R> | null> {
  if (!threadOn()) {
    const s = inline();
    return Promise.resolve(s ? (runRead(s, read) as Answer<R>) : null);
  }
  const id = nextId++;
  const started = Date.now();
  return new Promise((ok, no) => {
    const timer = setTimeout(() => {
      liqReadStats.restarts++;
      const w = worker;
      worker = null;
      failAll('the snapshot read took too long');
      void w?.terminate();
    }, READ_MS);
    timer.unref();
    waiting.set(id, {
      ok: (v) => { liqReadStats.longestMs = Math.max(liqReadStats.longestMs, Date.now() - started); ok(v as Answer<R> | null); },
      no, timer,
    });
    thread().postMessage({ id, read });
  });
}

/** Tests: stop the thread. */
export async function stopLiqReadThread(): Promise<void> {
  const w = worker;
  worker = null;
  failAll('stopped');
  await w?.terminate();
}

/** Tests: the octet_length fallback forgotten. */
export function resetLiqReadThread(): void {
  lengthFn = 'octet_length';
}

/**
 * The heatmap tiles' reads of the snapshot table on their own thread (2026-11-07 17:19-17:42: API stalls of 5-28 s).
 *
 * liqTiles.ts lists a coin's snapshots (time and length) and reads the ones it parses. Each listed snapshot is one leaf
 * page of liq_hist (rows of ~75 KB, key coin + t), so a coin's 30 days are ~1,200 random page reads: 10-60 ms with the
 * file in the page cache, but 5-28 s on server 1 while the indexer writes and checkpoints (the API's own stall profiles,
 * 16:45 5 s and 17:19 28 s, all in liqHistMeta's statement). A statement cannot be sliced, so it ran on the API's one
 * thread in one piece and the health check timed out behind it.
 *
 * Here those statements run on a worker with its own read-only connection; the API thread only gets the answers: times
 * and lengths, the snapshots' metas (parsed and scaled here), or a tile's band of rows (summed and cut here, the parsed
 * rows kept in this thread's LRU - liqTiles.ts tileRowsOf). A run of listed snapshots is one range scan (readSnaps).
 * VALUESCAN_LIQ_THREAD=0, and the tests unless they ask for it, read inline as before.
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import type { CohortBookRow, IndexStore, WalletFillRow } from './store.js';
import { heldSpan } from './heldSpan.js';
import type { Venue } from '../valuedesk/types.js';
import type { SnapRow } from '../valuedesk/liquidations/levels.js';

/**
 * A snapshot's meta without its time and length (liqTiles.ts metaOfData): its price, step, which venues hold rows in it
 * (`vm`, a bit per types.ts VENUES), and the scales of each venue set asked, in the order asked.
 */
export type MetaWire = { p: number; st: number; vm: number; sc: Float64Array[] };
/** One snapshot of a tile, cut where it was read (liqTiles.ts tileRowsOf): price, step and the rows in the band. */
export type TileRowsWire = { p: number; st: number; b: SnapRow[] };
/** What a tile asks of each snapshot: the rows of `venues` in band `band` of width `span`, `slim`: [bucket, long, short] only. */
export type TileRowsAsk = { op: 'tileRows'; coin: string; venues: Venue[]; ts: number[]; ns: number[]; span: number; band: number; slim: boolean; range: boolean };

export type LiqRead =
  /** `bg`: a whole listing nobody waits for, on the background lane. */
  | { op: 'list'; coin: string; from: number; to: number; bg?: boolean }
  | { op: 'coins' }
  | { op: 'snaps'; coin: string; ts: number[] }
  /**
   * Only the metas, parsed where read: the snapshots' JSON never reaches the asking thread. Each snapshot parsed once
   * for every venue set in `sets`. `range`: the times are a run of the listing, read in one range scan.
   */
  | { op: 'metas'; coin: string; sets: Venue[][]; ts: number[]; range?: boolean }
  /** A tile's rows, cut here (2026-11-17: a 4-day tile moved ~31 MB of JSON text to the API thread and parsed it there). */
  | TileRowsAsk
  // The copy page's fills (walletFills.ts, 2026-11-08: a busy wallet's rows not in the page cache held the API thread
  // 4-11 s, about 200 stalls an hour with the copy warmer on). They run on their own thread ('fills' lane), not behind
  // the heatmap's reads.
  | { op: 'fillRows'; venue: Venue; address: string; fromT: number; toT: number; limit: number; beforeId?: string }
  | { op: 'fillsNet'; venue: Venue; address: string; fromT: number; toT: number }
  // The copy cards' and fills' small lookups (2026-11-09: API stall profiles - copyCards readCards, walletFills and
  // /last-trades ran coverage, frozen-day, newest-row and book statements on the API thread; a cold page of each is a
  // disk read while the indexer writes). On the 'fills' lane too.
  | { op: 'heldSpan'; venue: Venue; address: string }
  | { op: 'newestRowT'; venue: Venue; addresses: string[] }
  | { op: 'cohortBooks'; venues: Venue[]; address: string }
  // The indexer's aggregate over a window of activity rows (2026-11-08: trade.xyz's all-time board and the cohort
  // members summed every account of the window on the indexer's thread, 33-74 s stalls). Its own lane ('scan').
  | { op: 'activeAccounts'; venue: Venue; from: { hour: number } | { day: number }; minTrades: number; limit: number };

type Answer<R extends LiqRead> = R extends { op: 'list' } ? Array<{ t: number; n: number }>
  : R extends { op: 'coins' } ? string[]
  : R extends { op: 'metas' } ? Array<MetaWire | null>
  : R extends { op: 'tileRows' } ? Array<TileRowsWire | null>
  : R extends { op: 'fillRows' } ? WalletFillRow[]
  : R extends { op: 'fillsNet' } ? Array<{ symbol: string; net: number }>
  : R extends { op: 'heldSpan' } ? { lo: number; hi: number } | null
  : R extends { op: 'newestRowT' } ? Array<number | null>
  : R extends { op: 'cohortBooks' } ? Array<CohortBookRow | null>
  : R extends { op: 'activeAccounts' } ? Array<{ acct: string; trades: number; volume: number }>
  : Array<string | null>;

/** Snapshots' data by time, read on whichever thread runs the read (null: gone). */
export type SnapReader = (ts: readonly number[], range: boolean) => Array<string | null>;
/** liqTiles.ts registers how a meta is worked out and how a tile is cut (no import cycle from here). */
let metaOf: ((data: string, sets: ReadonlyArray<readonly Venue[]>) => MetaWire | null) | null = null;
let tileRowsOf: ((r: TileRowsAsk, read: SnapReader) => Array<TileRowsWire | null>) | null = null;
export function setMetaOf(f: (data: string, sets: ReadonlyArray<readonly Venue[]>) => MetaWire | null): void { metaOf = f; }
export function setTileRowsOf(f: (r: TileRowsAsk, read: SnapReader) => Array<TileRowsWire | null>): void { tileRowsOf = f; }

/**
 * A coin's snapshots at `ts`: with `range` (the times are a run of the listing) one range scan from the first to the
 * last, the rows between not asked dropped; else one point lookup each.
 */
export function readSnaps(s: IndexStore, coin: string, ts: readonly number[], range: boolean): Array<string | null> {
  if (!range || ts.length < 2) return ts.map((t) => s.liqHistAt(coin, t));
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const t of ts) { if (t < lo) lo = t; if (t > hi) hi = t; }
  const by = new Map<number, string>();
  for (const r of s.liqHistRange(coin, lo, hi)) by.set(r.t, r.data);
  return ts.map((t) => by.get(t) ?? null);
}

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
      return readSnaps(s, r.coin, r.ts, r.range === true).map((d) => (d === null ? null : f(d, r.sets)));
    }
    case 'tileRows': {
      if (!tileRowsOf) throw new Error('liqTiles.ts is not loaded');
      return tileRowsOf(r, (ts, range) => readSnaps(s, r.coin, ts, range));
    }
    // Plain objects: node:sqlite rows have a null prototype, which posts fine but is spread to be safe.
    case 'fillRows': return s.walletFillRows(r.venue, r.address, r.fromT, r.toT, r.limit, r.beforeId).map((x) => ({ ...x }));
    case 'fillsNet': return s.fillsNetBySymbol(r.venue, r.address, r.fromT, r.toT).map((x) => ({ ...x }));
    case 'heldSpan': return heldSpan(s, r.venue, r.address);
    case 'newestRowT': return r.addresses.map((a) => s.newestRowT(r.venue, a));
    case 'cohortBooks': return r.venues.map((v) => s.cohortBook(v, r.address));
    case 'activeAccounts': return s.activeAccounts(r.venue, r.from, r.minTrades, r.limit);
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
      if ((m.read.op === 'metas' && !metaOf) || (m.read.op === 'tileRows' && !tileRowsOf)) await (tiles ??= import('./liqTiles.js'));
      const s = reader();
      parentPort!.postMessage({ id: m.id, rows: s ? runRead(s, m.read) : null });
    } catch (e) {
      parentPort!.postMessage({ id: m.id, error: String((e as Error)?.message ?? e) });
    }
  });
}

// --- the API side ------------------------------------------------------------------------------

/** Each lane has its own thread and connection: the copy fills never wait behind a heatmap read, nor it behind them. */
/* 'liq' answers what a view waits for (a listing's tail, a tile's rows); the metas - 30 days of snapshots of every coin,
   read ahead and walked for a cold index - are on 'meta': in one queue a tile waited behind them (production 2026-11-23:
   ETH's and SOL's index 'building, 0 of 0' for over a minute, the listing itself not reached). */
export type ReadLane = 'liq' | 'meta' | 'fills' | 'scan';
type Waiting = { ok: (v: unknown) => void; no: (e: Error) => void; timer: NodeJS.Timeout };
const lanes = new Map<ReadLane, { worker: Worker | null; waiting: Map<number, Waiting> }>();
let nextId = 1;
/** Reads done and failed, and the longest, for the health answer (both lanes). */
export const liqReadStats = { done: 0, failed: 0, restarts: 0, longestMs: 0 };

function laneOf(l: ReadLane) {
  let x = lanes.get(l);
  if (!x) { x = { worker: null, waiting: new Map() }; lanes.set(l, x); }
  return x;
}

function threadOn(): boolean {
  const v = process.env.VALUESCAN_LIQ_THREAD;
  if (v === '0') return false;
  if (v === '1') return true;
  return !process.env.NODE_TEST_CONTEXT;
}

function failAll(l: ReadLane, why: string): void {
  const x = laneOf(l);
  for (const r of x.waiting.values()) { clearTimeout(r.timer); r.no(new Error(why)); }
  x.waiting.clear();
}

function thread(l: ReadLane): Worker {
  const x = laneOf(l);
  if (x.worker) return x.worker;
  const w = new Worker(new URL(import.meta.url), { workerData: { liqReadThread: true, lane: l }, resourceLimits: { maxOldGenerationSizeMb: 512 } });
  x.worker = w;
  w.unref();
  w.on('message', (m: { id: number; rows?: unknown; error?: string }) => {
    const r = x.waiting.get(m.id);
    if (!r) return;
    x.waiting.delete(m.id);
    clearTimeout(r.timer);
    if (m.error !== undefined) { liqReadStats.failed++; r.no(new Error(m.error)); return; }
    liqReadStats.done++;
    r.ok(m.rows);
  });
  const gone = () => {
    if (x.worker !== w) return;
    x.worker = null;
    failAll(l, 'the index reader stopped');
  };
  w.on('error', gone);
  w.on('exit', gone);
  return w;
}

const FILLS_OPS = new Set<LiqRead['op']>(['fillRows', 'fillsNet', 'heldSpan', 'newestRowT', 'cohortBooks']);

/** A read of the index off this thread (null: no index file yet). Fills reads go on the 'fills' lane. */
export function liqRead<R extends LiqRead>(read: R, inline: () => IndexStore | null): Promise<Answer<R> | null> {
  if (!threadOn()) {
    const s = inline();
    return Promise.resolve(s ? (runRead(s, read) as Answer<R>) : null);
  }
  const l: ReadLane = FILLS_OPS.has(read.op) ? 'fills' : read.op === 'activeAccounts' ? 'scan' : read.op === 'metas' || (read.op === 'list' && read.bg) ? 'meta' : 'liq';
  const x = laneOf(l);
  const id = nextId++;
  const started = Date.now();
  return new Promise((ok, no) => {
    const timer = setTimeout(() => {
      liqReadStats.restarts++;
      const w = x.worker;
      x.worker = null;
      failAll(l, 'the index read took too long');
      void w?.terminate();
    }, READ_MS);
    timer.unref();
    x.waiting.set(id, {
      ok: (v) => { liqReadStats.longestMs = Math.max(liqReadStats.longestMs, Date.now() - started); ok(v as Answer<R> | null); },
      no, timer,
    });
    thread(l).postMessage({ id, read });
  });
}

/** Tests: stop the threads. */
export async function stopLiqReadThread(): Promise<void> {
  const ws: Worker[] = [];
  for (const [l, x] of lanes) {
    if (x.worker) ws.push(x.worker);
    x.worker = null;
    failAll(l, 'stopped');
  }
  await Promise.all(ws.map((w) => w.terminate()));
}

/** Tests: the octet_length fallback forgotten. */
export function resetLiqReadThread(): void {
  lengthFn = 'octet_length';
}

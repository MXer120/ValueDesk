/**
 * A window's first, partial day summed from the raw fills on reader threads (2026-11-10).
 *
 * Every night after 00:00 UTC each board window's first day moves to a day the index has not read from a start inside it
 * yet: the 1d window's is yesterday from (now - 24 h), nearly all of it, and the 7d / 30d / 90d windows' move to a new day
 * too. Every board candidate's first day was then read row by row on the indexer's thread, one wallet after another (a
 * row off the page cache is a disk read): the first build after midnight took 98 min on 2026-11-09 and 30+ min on
 * 2026-11-10, and no board was written for 33 min ("the leaderboards have not been rebuilt for over 15 minutes").
 *
 * Here those reads run on a few threads with read-only connections of their own (the API process reads the same file
 * the same way), side by side, off the indexer's thread. The same SQL and the same sums as IndexStore.partialDayAsync's
 * own loop (IndexStore.scanDayForThread runs that loop), so the figures are the same: tested against it. A finished
 * day's rows come back packed (HeldRows, transferred, not copied) for the held-rows cache, which the indexer keeps.
 *
 * A thread that fails or dies fails its reads; the caller then reads inline as before. One that dies within
 * DEATH_WINDOW_MS of the last death, three times running, turns the pool off for the life of the process.
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import type { Venue } from '../valuedesk/types.js';

/** One read: [fromT, end) of one wallet; `keep` = pack the rows for the held cache (a finished day). */
export type DayScanAsk = { id: number; venue: Venue; address: string; fromT: number; end: number; keep: boolean };
/** Packed rows as IndexStore holds them (store.ts HeldRows). */
export type HeldWire = { ver: number; from: number; n: number; t: Float64Array; v: Float64Array; pnl: Float64Array; fee: Float64Array; side: Int8Array; src: Int8Array; sym: Uint16Array; syms: string[] };
export type DayAggWire = {
  trades: number; volume: number; closes: number; wins: number; syms: Map<string, number>;
  fills: number; net: number; firstT: number | null; openMax: number | null;
};
export type DayScanResult = { agg: DayAggWire | undefined; held: HeldWire | null };
type Answer = { id: number; agg?: DayAggWire; held?: HeldWire | null; error?: string; ms: number };

/** Threads by default; VALUESCAN_DAYSCAN_THREADS, 0 = off (every read inline, as before). */
export const dayScanThreads = (): number => {
  const n = Number(process.env.VALUESCAN_DAYSCAN_THREADS ?? 3);
  return Number.isFinite(n) ? Math.max(0, Math.min(8, Math.floor(n))) : 3;
};
const DEATH_WINDOW_MS = 60_000;
const DEATHS_MAX = 3;

type Slot = { w: Worker; flying: Map<number, { resolve: (r: DayScanResult) => void; reject: (e: Error) => void }> };

export class DayScanPool {
  private slots: Array<Slot | null>;
  private nextId = 1;
  private deaths = 0;
  private lastDeath = 0;
  private stopped = false;
  /** Reads answered / failed, and the time the threads spent on them: the status. */
  done = 0;
  failed = 0;
  spentMs = 0;

  constructor(private readonly path: string, readonly threads: number) {
    this.slots = Array.from({ length: Math.max(1, threads) }, () => null);
  }

  get on(): boolean {
    return !this.stopped && this.deaths < DEATHS_MAX;
  }

  get flying(): number {
    let n = 0;
    for (const s of this.slots) n += s?.flying.size ?? 0;
    return n;
  }

  scan(ask: Omit<DayScanAsk, 'id'>): Promise<DayScanResult> {
    if (!this.on) return Promise.reject(new Error('day scan threads off'));
    // The least busy thread: a market maker's day on one does not hold up the reads queued behind it on another.
    let at = 0;
    for (let i = 1; i < this.slots.length; i++) if ((this.slots[i]?.flying.size ?? 0) < (this.slots[at]?.flying.size ?? 0)) at = i;
    const slot = this.slots[at] ?? this.spawn(at);
    const id = this.nextId++;
    return new Promise<DayScanResult>((resolve, reject) => {
      slot.flying.set(id, { resolve, reject });
      slot.w.postMessage({ ...ask, id } satisfies DayScanAsk);
    });
  }

  stop(): void {
    this.stopped = true;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!s) continue;
      this.slots[i] = null;
      for (const f of s.flying.values()) f.reject(new Error('day scan threads stopped'));
      s.flying.clear();
      void s.w.terminate();
    }
  }

  private spawn(i: number): Slot {
    const w = new Worker(new URL(import.meta.url), { workerData: { dayScanThread: true, path: this.path }, resourceLimits: { maxOldGenerationSizeMb: 1_536 } });
    w.unref();
    const slot: Slot = { w, flying: new Map() };
    this.slots[i] = slot;
    w.on('message', (m: Answer) => {
      const f = slot.flying.get(m.id);
      if (!f) return;
      slot.flying.delete(m.id);
      this.spentMs += m.ms;
      if (m.error !== undefined) {
        this.failed++;
        f.reject(new Error(m.error));
      } else {
        this.done++;
        f.resolve({ agg: m.agg, held: m.held ?? null });
      }
    });
    const gone = (why: string) => {
      if (this.slots[i] !== slot) return;
      this.slots[i] = null;
      for (const f of slot.flying.values()) { this.failed++; f.reject(new Error(why)); }
      slot.flying.clear();
      if (this.stopped) return;
      const now = Date.now();
      this.deaths = now - this.lastDeath <= DEATH_WINDOW_MS ? this.deaths + 1 : 1;
      this.lastDeath = now;
      console.warn(`[index] day scan thread ${i}: ${why}${this.on ? '' : ' - threads off, first days read inline'}`);
    };
    w.on('error', (e) => gone(`failed: ${String(e)}`));
    w.on('exit', (code) => gone(`exited (${code})`));
    return slot;
  }
}

if (!isMainThread && (workerData as { dayScanThread?: unknown } | null)?.dayScanThread) {
  // Not a top-level await: store.ts imports this file, and awaiting it here never settles (the thread exits 13).
  type Reader = { scanDayForThread: (venue: Venue, address: string, fromT: number, end: number, keep: boolean) => DayScanResult };
  let store: Reader | null = null;
  let broken: string | null = null;
  const waiting: DayScanAsk[] = [];
  const answer = (m: DayScanAsk) => {
    const t0 = Date.now();
    if (!store) {
      parentPort!.postMessage({ id: m.id, error: broken ?? 'no reader', ms: 0 } satisfies Answer);
      return;
    }
    try {
      const r = store.scanDayForThread(m.venue, m.address, m.fromT, m.end, m.keep);
      const h = r.held;
      const transfer = h ? [h.t.buffer, h.v.buffer, h.pnl.buffer, h.fee.buffer, h.side.buffer, h.src.buffer, h.sym.buffer] : [];
      parentPort!.postMessage({ id: m.id, agg: r.agg, held: h, ms: Date.now() - t0 } satisfies Answer, transfer as ArrayBuffer[]);
    } catch (e) {
      parentPort!.postMessage({ id: m.id, error: String(e), ms: Date.now() - t0 } satisfies Answer);
    }
  };
  parentPort!.on('message', (m: DayScanAsk) => (store || broken ? answer(m) : waiting.push(m)));
  void import('./store.js').then(
    ({ IndexStore }) => { store = new IndexStore((workerData as { path: string }).path, { readOnly: true }); },
    (e: unknown) => { broken = String(e); },
  ).catch((e: unknown) => { broken = String(e); }).finally(() => { for (const m of waiting.splice(0)) answer(m); });
}

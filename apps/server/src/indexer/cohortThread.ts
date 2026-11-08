/**
 * The cohorts and the wallet heatmap on their own thread (2026-11-08).
 *
 * The cohort load (read.ts: every tracked wallet's book, ~550k WalletVenue objects, netted lists and sums per scope) lived
 * on the API's one thread. Its upkeep held that thread (renet / netWallet: 4.9 s on production after v0.2.195) and its size
 * gave the garbage collector pauses of 8-11 s (11.3 s at 11:07 that day, 99% GC) - longer than the health check waits.
 *
 * Here read.ts and liqRead.ts run unchanged on a worker with their own read-only connection and heap: every cohort route,
 * and the heatmap answers that read the books (wallet filter, exact steps, the wallets in a bucket, a wallet's positions),
 * is one job that comes back as the finished JSON text. The API thread keeps:
 *   - the venues' markets (tiers, open interest, marks): it holds the venue clients and their budgets, so the worker asks
 *     it for them (setMarketsSource), never the venues;
 *   - the live heatmap (the indexer's feed), which needs only the load's internal open interest: the worker sends that
 *     small map whenever a new load is in use (setPushedInternal).
 * VALUESCAN_COHORT_THREAD=0, and the tests unless they ask for it, run the same jobs inline.
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import type { Venue } from '../valuedesk/types.js';
import type { VenueMarkets } from '../valuedesk/liquidations/rules.js';
import type { LevBand } from '../valuedesk/liquidations/math.js';
import type * as ReadMod from './read.js';
import type * as LiqMod from './liqRead.js';

type Filter = Parameters<typeof ReadMod.cohortsRead>[1];
type CohortId = Parameters<typeof ReadMod.cohortDetail>[1];
type Range = Parameters<typeof ReadMod.cohortDetail>[2];
type WalletOpts = Parameters<typeof ReadMod.cohortWallets>[3];
type FineAsk = Parameters<typeof LiqMod.liqHeatmapFine>[2];

export type CohortJob =
  | { op: 'cohorts'; venues: Venue[]; f: Filter }
  | { op: 'detail'; venues: Venue[]; cohort: CohortId; range: Range; f: Filter }
  | { op: 'map'; venues: Venue[]; cohort: CohortId | null }
  | { op: 'focus'; venues: Venue[]; f: Filter; range: Range }
  | { op: 'wallets'; venues: Venue[]; cohort: CohortId; f: Filter; o: WalletOpts }
  | { op: 'excluded' }
  | { op: 'liqOf'; coin: string; venues: Venue[]; wallets: string[] }
  | { op: 'liqFine'; coin: string; venues: Venue[]; ask: FineAsk; wallets: string[]; side: 'long' | 'short' | null; lev: LevBand[] | null }
  | { op: 'liqWallets'; coin: string; venues: Venue[]; side: 'long' | 'short'; from: number; to: number; limit: number; wallets: string[]; lev: LevBand[] | null }
  | { op: 'positions'; venues: Venue[]; wallets: string[] }
  | { op: 'warm'; venues: Venue[] };

const ok = (body: object | null): string | null => (body ? JSON.stringify({ ok: true, ...body }) : null);

/** A job, on whichever thread runs it: the route's whole JSON answer, or null when the index is not running yet. */
export async function runCohortJob(j: CohortJob): Promise<string | null> {
  const R = await import('./read.js');
  const L = await import('./liqRead.js');
  switch (j.op) {
    case 'cohorts':
      await R.cohortsPrepare(j.venues, [j.f, {}]);
      return ok(R.cohortsRead(j.venues, j.f));
    case 'detail':
      await R.cohortsPrepare(j.venues, [j.f]);
      return ok(R.cohortDetail(j.venues, j.cohort, j.range, j.f));
    case 'map':
      await R.cohortsPrepare(j.venues, [{}]);
      return ok(R.cohortMap(j.venues, j.cohort));
    case 'focus':
      await R.cohortsPrepare(j.venues, [j.f]);
      return ok(R.cohortFocus(j.venues, j.f, j.range));
    case 'wallets':
      await R.cohortsPrepare(j.venues, []);
      return ok(R.cohortWallets(j.venues, j.cohort, j.f, j.o));
    case 'excluded':
      await R.cohortsReady();
      return ok({ wallets: R.excludedNow() });
    case 'liqOf': {
      await R.cohortsReady();
      const body = await L.liqHeatmapOf(j.coin, j.venues, j.wallets);
      return body ? ok({ ...body, overOi: R.booksOverOi(j.venues, j.coin) }) : null;
    }
    case 'liqFine': {
      await R.cohortsReady();
      const body = await L.liqHeatmapFine(j.coin, j.venues, j.ask, { wallets: new Set(j.wallets), side: j.side, lev: j.lev ? new Set(j.lev) : null });
      return body ? ok({ ...body, overOi: R.booksOverOi(j.venues, j.coin) }) : null;
    }
    case 'liqWallets':
      await R.cohortsReady();
      return ok(await L.liqWallets(j.coin, j.venues, j.side, j.from, j.to, j.limit, j.wallets, j.lev ? new Set(j.lev) : null));
    case 'positions': {
      await R.cohortsReady();
      const body = await L.walletLiqs(j.wallets, j.venues);
      return body ? ok({ wallets: j.wallets, asOf: body.asOf, positions: body.positions }) : null;
    }
    case 'warm':
      await R.warmCohorts(j.venues);
      // Each venue alone too (the venue picker's pages), then kept summed ahead (read.ts KEEP_WARM_MS): a first visit
      // to one venue's cohorts waited 8.8-9.8 s for its netting (2026-11-08).
      if (j.venues.length > 1) for (const v of j.venues) await R.cohortsPrepare([v], [{}]);
      return 'null';
  }
}

// --- the worker ---------------------------------------------------------------------------------

// The markets go as they are: a structured clone keeps the tiers' `now` (an array's own named properties are copied).
type ToWorker = { id: number; job: CohortJob } | { id: number; markets: Map<Venue, VenueMarkets | null>; sodex: Map<string, number> | null };
type FromWorker = { id: number; json?: string | null; error?: string } | { ask: number; venues: Venue[] } | { internal: Map<string, number> };

if (!isMainThread && (workerData as { cohortThread?: boolean } | null)?.cohortThread) {
  const port = parentPort!;
  const asks = new Map<number, (v: { markets: Map<Venue, VenueMarkets | null>; sodex: Map<string, number> | null }) => void>();
  let nextAsk = 1;
  const L = await import('./liqRead.js');
  const R = await import('./read.js');
  L.setMarketsSource((venues) => new Promise((resolve) => {
    const id = nextAsk++;
    asks.set(id, resolve);
    port.postMessage({ ask: id, venues: [...venues] } satisfies FromWorker);
  }));
  port.on('message', (m: ToWorker) => {
    if ('markets' in m) {
      const r = asks.get(m.id);
      asks.delete(m.id);
      r?.({ markets: m.markets, sodex: m.sodex });
      return;
    }
    runCohortJob(m.job).then(
      (json) => port.postMessage({ id: m.id, json } satisfies FromWorker),
      (e) => port.postMessage({ id: m.id, error: String((e as Error)?.message ?? e) } satisfies FromWorker),
    );
  });
  // The load in use's internal open interest, to the API thread whenever a new load is in use.
  let sentAt = -1;
  setInterval(() => {
    const x = R.cohortInternal();
    if (!x || x.at === sentAt) return;
    sentAt = x.at;
    port.postMessage({ internal: new Map(x.internal) } satisfies FromWorker);
  }, 1_000).unref();
}

// --- the API side -------------------------------------------------------------------------------

/** One job longer than this: refused, and the thread started again (a first load after a start takes 15-30 s). */
export const JOB_MS = 120_000;

let worker: Worker | null = null;
let nextId = 1;
const waiting = new Map<number, { ok: (v: string | null) => void; no: (e: Error) => void; timer: NodeJS.Timeout }>();
export const cohortThreadStats = { done: 0, failed: 0, restarts: 0, longestMs: 0, asks: 0 };

export function cohortThreadOn(): boolean {
  const v = process.env.VALUESCAN_COHORT_THREAD;
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
  // Its own heap: the load and its netted lists (production ~0.6-1 GB), apart from the API thread's.
  const w = new Worker(new URL(import.meta.url), { workerData: { cohortThread: true }, resourceLimits: { maxOldGenerationSizeMb: 2_560 } });
  worker = w;
  w.unref();
  w.on('message', (m: FromWorker) => {
    if ('internal' in m) {
      void import('./read.js').then((R) => R.setPushedInternal(m.internal));
      return;
    }
    if ('ask' in m) {
      cohortThreadStats.asks++;
      void import('./liqRead.js').then(async (L) => {
        const markets = await L.marketsFor(m.venues).catch(() => new Map<Venue, VenueMarkets | null>());
        w.postMessage({ id: m.ask, markets, sodex: L.sodexInternalHeld() } satisfies ToWorker);
      });
      return;
    }
    const r = waiting.get(m.id);
    if (!r) return;
    waiting.delete(m.id);
    clearTimeout(r.timer);
    if (m.error !== undefined) { cohortThreadStats.failed++; r.no(new Error(m.error)); return; }
    cohortThreadStats.done++;
    r.ok(m.json ?? null);
  });
  const gone = () => {
    if (worker !== w) return;
    worker = null;
    failAll('the cohort thread stopped');
  };
  w.on('error', gone);
  w.on('exit', gone);
  return w;
}

/** A cohort job off this thread: the route's whole JSON answer, or null when the index is not running yet. */
export function cohortJob(job: CohortJob): Promise<string | null> {
  if (!cohortThreadOn()) return runCohortJob(job);
  const id = nextId++;
  const started = Date.now();
  return new Promise((ok, no) => {
    const timer = setTimeout(() => {
      cohortThreadStats.restarts++;
      const w = worker;
      worker = null;
      failAll('the cohort job took too long');
      void w?.terminate();
    }, JOB_MS);
    timer.unref();
    waiting.set(id, {
      ok: (v) => { cohortThreadStats.longestMs = Math.max(cohortThreadStats.longestMs, Date.now() - started); ok(v); },
      no, timer,
    });
    thread().postMessage({ id, job } satisfies ToWorker);
  });
}

/** Tests: stop the thread. */
export async function stopCohortThread(): Promise<void> {
  const w = worker;
  worker = null;
  failAll('stopped');
  await w?.terminate();
}


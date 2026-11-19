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
import { prepareJson, type Prepared } from '../perf.js';

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

/**
 * A job's answer and how long it stands: the same job gives the same text until `until` (ms) while the cohort answers are
 * read from `from` (read.ts answerWithin / answersIdentity). `until` 0: not to be kept (an answer that reads the file's
 * live rows - a cohort's wallets with their win rates - or the heatmap's).
 */
export interface JobAnswer { json: string | null; until: number; from: string | null }

/** The jobs whose answer is the load in use plus the kept reads beside it: the API thread keeps them (cohortAnswer). */
export const KEPT_OPS: ReadonlySet<CohortJob['op']> = new Set(['cohorts', 'detail', 'map', 'focus', 'excluded']);

/** A job, on whichever thread runs it, with how long its answer stands. */
export async function runCohortJobKept(j: CohortJob): Promise<JobAnswer> {
  const R = await import('./read.js');
  const L = await import('./liqRead.js');
  // Synchronous from here: the read and its JSON, nothing awaited in between.
  const within = (read: () => string | null): JobAnswer => {
    const a = R.answerWithin(read);
    return { json: a.value, until: a.value === null ? 0 : a.until, from: a.ident };
  };
  const once = (json: string | null): JobAnswer => ({ json, until: 0, from: null });
  switch (j.op) {
    case 'cohorts':
      await R.cohortsPrepare(j.venues, [j.f, {}]);
      return within(() => ok(R.cohortsRead(j.venues, j.f)));
    case 'detail':
      await R.cohortsPrepare(j.venues, [j.f]);
      return within(() => ok(R.cohortDetail(j.venues, j.cohort, j.range, j.f)));
    case 'map':
      await R.cohortsPrepare(j.venues, [{}]);
      return within(() => ok(R.cohortMap(j.venues, j.cohort)));
    case 'focus':
      await R.cohortsPrepare(j.venues, [j.f]);
      return within(() => ok(R.cohortFocus(j.venues, j.f, j.range)));
    case 'wallets':
      await R.cohortsPrepare(j.venues, []);
      return once(ok(R.cohortWallets(j.venues, j.cohort, j.f, j.o)));
    case 'excluded':
      await R.cohortsReady();
      return within(() => ok({ wallets: R.excludedNow() }));
    case 'liqOf': {
      await R.cohortsReady();
      const body = await L.liqHeatmapOf(j.coin, j.venues, j.wallets);
      return once(body ? ok({ ...body, overOi: R.booksOverOi(j.venues, j.coin) }) : null);
    }
    case 'liqFine': {
      await R.cohortsReady();
      const body = await L.liqHeatmapFine(j.coin, j.venues, j.ask, { wallets: new Set(j.wallets), side: j.side, lev: j.lev ? new Set(j.lev) : null });
      return once(body ? ok({ ...body, overOi: R.booksOverOi(j.venues, j.coin) }) : null);
    }
    case 'liqWallets':
      await R.cohortsReady();
      return once(ok(await L.liqWallets(j.coin, j.venues, j.side, j.from, j.to, j.limit, j.wallets, j.lev ? new Set(j.lev) : null)));
    case 'positions': {
      await R.cohortsReady();
      const body = await L.walletLiqs(j.wallets, j.venues);
      return once(body ? ok({ wallets: j.wallets, asOf: body.asOf, positions: body.positions }) : null);
    }
    case 'warm':
      await R.warmCohorts(j.venues);
      // Each venue alone too (the venue picker's pages), then kept summed ahead (read.ts KEEP_WARM_MS): a first visit
      // to one venue's cohorts waited 8.8-9.8 s for its netting (2026-11-08).
      if (j.venues.length > 1) for (const v of j.venues) await R.cohortsPrepare([v], [{}]);
      return once('null');
  }
}

/** A job, on whichever thread runs it: the route's whole JSON answer, or null when the index is not running yet. */
export async function runCohortJob(j: CohortJob): Promise<string | null> {
  return (await runCohortJobKept(j)).json;
}

// --- the worker ---------------------------------------------------------------------------------

// The markets go as they are: a structured clone keeps the tiers' `now` (an array's own named properties are copied).
type ToWorker = { id: number; job: CohortJob } | { id: number; markets: Map<Venue, VenueMarkets | null>; sodex: Map<string, number> | null };
type FromWorker =
  | { id: number; json?: string | null; until?: number; from?: string | null; error?: string }
  | { ask: number; venues: Venue[] }
  | { internal: Map<string, number>; at?: number }
  /** What the cohort answers are read from moved (a load swapped in, a kept read dropped): read.ts answersIdentity. */
  | { moved: string | null };

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
    runCohortJobKept(m.job).then(
      (a) => port.postMessage({ id: m.id, json: a.json, until: a.until, from: a.from } satisfies FromWorker),
      (e) => port.postMessage({ id: m.id, error: String((e as Error)?.message ?? e) } satisfies FromWorker),
    );
  });
  // The load in use's internal open interest, to the API thread whenever a new load is in use.
  let sentAt = -1;
  const sendInternal = (): void => {
    const x = R.cohortInternal();
    if (!x || x.at === sentAt) return;
    sentAt = x.at;
    port.postMessage({ internal: new Map(x.internal), at: x.at } satisfies FromWorker);
  };
  // At once (it was within a second): the API thread hands out a kept answer only while this says nothing moved, and
  // every answer read after the move is posted after this message.
  R.onAnswersMoved(() => {
    port.postMessage({ moved: R.answersIdentity() } satisfies FromWorker);
    sendInternal();
  });
  setInterval(sendInternal, 1_000).unref();
}

// --- the API side -------------------------------------------------------------------------------

/** One job longer than this: refused, and the thread started again (a first load after a start takes 15-30 s). */
export const JOB_MS = 120_000;

let worker: Worker | null = null;
/** When the load in use on the thread was built (its 'internal' message says so within a second of the swap). */
let loadAt: number | null = null;

/**
 * When the cohort load in use was built, or null before there is one: the live channel (routes/liveHub.ts) pushes the
 * cohort pages again when it moves (about once a minute, read.ts LOAD_TTL_MS) instead of every tab polling each minute.
 */
export async function cohortLoadAt(): Promise<number | null> {
  if (cohortThreadOn()) return loadAt;
  const R = await import('./read.js');
  return R.cohortInternal()?.at ?? null;
}
let nextId = 1;
const waiting = new Map<number, { ok: (v: JobAnswer) => void; no: (e: Error) => void; timer: NodeJS.Timeout }>();
export const cohortThreadStats = { done: 0, failed: 0, restarts: 0, longestMs: 0, asks: 0 };
/** Each thread started counts one: an answer kept from a thread that stopped is never handed out for the next one. */
let threadEpoch = 0;
/** What the thread said its cohort answers are read from, last (null: nothing yet, or a thread just started). */
let threadReadsFrom: string | null = null;

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
  threadEpoch++;
  threadReadsFrom = null;
  kept.clear();
  keptBytes = 0;
  w.unref();
  w.on('message', (m: FromWorker) => {
    if ('moved' in m) {
      if (worker === w) {
        threadReadsFrom = m.moved;
        refreshAhead();
      }
      return;
    }
    if ('internal' in m) {
      if (m.at !== undefined) loadAt = m.at;
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
    r.ok({ json: m.json ?? null, until: m.until ?? 0, from: m.from == null ? null : `${threadEpoch}|${m.from}` });
  });
  const gone = () => {
    if (worker !== w) return;
    worker = null;
    threadReadsFrom = null;
    kept.clear();
    keptBytes = 0;
    failAll('the cohort thread stopped');
  };
  w.on('error', gone);
  w.on('exit', gone);
  return w;
}

/** One job on the thread (or inline when the thread is off), with how long its answer stands. */
function runJob(job: CohortJob): Promise<JobAnswer> {
  if (!cohortThreadOn()) {
    return runCohortJobKept(job).then((a) => ({ ...a, from: a.from === null ? null : `inline|${a.from}` }));
  }
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

// --- the answers kept on the API thread ----------------------------------------------------------
//
// A cohort answer changes when the load does (about once a minute) or when one of the kept reads beside it moves on (the
// series a minute, the open interest check 30 s): read.ts says, with each answer, until when the same job gives the same
// text and what it was read from. Until then this thread hands the text out again without asking the thread - which also
// runs every heatmap viewer's book jobs, so a cohort read no longer queues behind them - and with it the body perf.ts
// sends (trimmed, its ETag; compressed once by perf.ts's cache). Byte for byte what the thread would answer: an answer is
// handed out only while the thread has said nothing moved (its `moved` message comes before any answer read after the
// move) and before its `until`.
//   - One build per job at a time: a request while one runs waits for it (and takes it if it arrived before its `until`).
//   - Ahead: an answer someone was handed from here is built again as soon as it lapses (a new load, its `until`), while it
//     was asked within REFRESH_ASKED_MS - the next poll's build, done before the poll. An answer nobody asked for again
//     is not, so this never builds more than the requests did.
//   - liveHub (routes/liveHub.ts) reads through here too: one build serves the socket and HTTP.

/** At most this many answers and this many bytes (text and body) are kept; the least recently used go first. */
export const KEPT_MAX = 64;
export const KEPT_MAX_BYTES = 24 * 1024 * 1024;
/** An answer lapsing is built again ahead only when someone asked for it this recently. */
export const REFRESH_ASKED_MS = 60_000;

interface Kept {
  key: string;
  job: CohortJob;
  json: string;
  from: string;
  until: number;
  /** Handed out from here since it was built (the build itself not counted). */
  hits: number;
  askedAt: number;
  body: Prepared | null;
  bytes: number;
}

const kept = new Map<string, Kept>();
let keptBytes = 0;
const building = new Map<string, { from: string | null; p: Promise<JobAnswer> }>();
export const cohortKeptStats = { hits: 0, misses: 0, joined: 0, ahead: 0, kept: 0, bytes: 0 };

/** read.ts once imported (the jobs inline: this thread's own load). */
let readMod: typeof ReadMod | null = null;

/** What the cohort answers are read from now, as this thread knows it. */
async function readsFromNow(): Promise<string | null> {
  if (cohortThreadOn()) return threadReadsFrom === null ? null : `${threadEpoch}|${threadReadsFrom}`;
  readMod ??= await import('./read.js');
  const now = readMod.answersIdentity();
  return now === null ? null : `inline|${now}`;
}

function drop(key: string): void {
  const e = kept.get(key);
  if (!e) return;
  kept.delete(key);
  keptBytes -= e.bytes;
}

function store(e: Kept): void {
  drop(e.key);
  if (e.bytes > KEPT_MAX_BYTES / 4) return;
  kept.set(e.key, e);
  keptBytes += e.bytes;
  while (kept.size > KEPT_MAX || keptBytes > KEPT_MAX_BYTES) drop(kept.keys().next().value!);
  armAhead();
}

/** The build of one job, shared by every request (and an ahead build) while it runs; the answer is kept when it may be. */
function build(key: string, job: CohortJob, from: string | null): Promise<JobAnswer> {
  const p = runJob(job).then(async (a) => {
    if (a.json !== null && a.from !== null && a.until > Date.now() && a.from === (await readsFromNow())) {
      const was = kept.get(key);
      store({ key, job, json: a.json, from: a.from, until: a.until, hits: 0, askedAt: was?.askedAt ?? Date.now(), body: null, bytes: a.json.length });
    }
    return a;
  });
  const entry = { from, p };
  building.set(key, entry);
  const done = () => { if (building.get(key) === entry) building.delete(key); };
  p.then(done, done);
  return p;
}

export interface CohortAnswer {
  json: string | null;
  /** hit: kept here; joined: another request's build; miss: built for this one; off: not a kept job. */
  memo: 'hit' | 'joined' | 'miss' | 'off';
  /** How long this request waited for the thread (0 on a hit). */
  threadMs: number;
  /** The body perf.ts sends for this answer (trimmed, its ETag), made once per kept answer. Absent: send `json`. */
  body?: () => Prepared;
}

/**
 * A cohort job's answer: kept here while it is what the thread would answer (above), else from the thread. The route's whole
 * JSON text, or null when the index is not running yet.
 */
export async function cohortAnswer(job: CohortJob): Promise<CohortAnswer> {
  if (!KEPT_OPS.has(job.op)) {
    const t0 = performance.now();
    const a = await runJob(job);
    return { json: a.json, memo: 'off', threadMs: performance.now() - t0 };
  }
  const key = JSON.stringify(job);
  const arrived = Date.now();
  const from = await readsFromNow();
  const e = kept.get(key);
  if (e && from !== null && e.from === from && arrived < e.until) {
    e.hits++;
    e.askedAt = arrived;
    // Most recently used last.
    kept.delete(key);
    kept.set(key, e);
    cohortKeptStats.hits++;
    return { json: e.json, memo: 'hit', threadMs: 0, body: () => bodyOf(e) };
  }
  if (e) e.askedAt = arrived;
  const t0 = performance.now();
  const running = building.get(key);
  if (running && running.from === from) {
    const a = await running.p;
    // Taken only when it stands for this request's arrival as well.
    if (a.json !== null && a.from !== null && a.from === from && arrived < a.until) {
      cohortKeptStats.joined++;
      return withBody(key, a, 'joined', performance.now() - t0);
    }
  }
  cohortKeptStats.misses++;
  const a = await build(key, job, from);
  return withBody(key, a, 'miss', performance.now() - t0);
}

function bodyOf(e: Kept): Prepared {
  if (!e.body) {
    e.body = prepareJson(e.json);
    // The body's bytes count against the bound as well.
    if (kept.get(e.key) === e) {
      keptBytes += e.body.buf.length;
      e.bytes += e.body.buf.length;
    }
  }
  return e.body;
}

function withBody(key: string, a: JobAnswer, memo: CohortAnswer['memo'], threadMs: number): CohortAnswer {
  const e = kept.get(key);
  if (e && e.json === a.json) {
    e.askedAt = Date.now();
    return { json: a.json, memo, threadMs, body: () => bodyOf(e) };
  }
  return { json: a.json, memo, threadMs };
}

/** A cohort job off this thread: the route's whole JSON answer, or null when the index is not running yet. */
export async function cohortJob(job: CohortJob): Promise<string | null> {
  return (await cohortAnswer(job)).json;
}

let aheadTimer: NodeJS.Timeout | null = null;

/** Build again, now, every kept answer that lapsed and was handed out from here within REFRESH_ASKED_MS. */
function refreshAhead(): void {
  void readsFromNow().then((from) => {
    const now = Date.now();
    for (const [key, e] of kept) {
      if (e.from === from && now < e.until) continue;
      if (e.hits === 0 || now - e.askedAt > REFRESH_ASKED_MS || building.has(key) || from === null) continue;
      e.hits = 0;
      cohortKeptStats.ahead++;
      build(key, e.job, from).catch(() => { /* the next request asks again */ });
    }
  });
}

/** The ahead builds for answers that reach their `until` (a new load says so itself): a look every second while any is kept. */
function armAhead(): void {
  if (aheadTimer) return;
  aheadTimer = setInterval(() => {
    if (!kept.size) return;
    refreshAhead();
  }, 1_000);
  aheadTimer.unref();
}

/** Counts for /api/vs/index/status: jobs waiting on the thread, answers kept. */
export function cohortThreadState(): Record<string, number> {
  cohortKeptStats.kept = kept.size;
  cohortKeptStats.bytes = keptBytes;
  return { ...cohortThreadStats, waiting: waiting.size, building: building.size, ...Object.fromEntries(Object.entries(cohortKeptStats).map(([k, v]) => [`kept_${k}`, v])) };
}

/** Tests: forget every kept answer. */
export function clearKeptAnswers(): void {
  kept.clear();
  keptBytes = 0;
  for (const k of Object.keys(cohortKeptStats) as Array<keyof typeof cohortKeptStats>) cohortKeptStats[k] = 0;
}

/** Tests: stop the thread. */
export async function stopCohortThread(): Promise<void> {
  const w = worker;
  worker = null;
  threadReadsFrom = null;
  kept.clear();
  keptBytes = 0;
  failAll('stopped');
  await w?.terminate();
}


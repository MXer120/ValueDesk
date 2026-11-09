/**
 * The live heatmap on its own thread (2026-11-09), or inline - one engine (liqLiveCore.ts LiveCore), two transports.
 *
 * The indexer (cohortTracker.ts) talks to a LiveLink: it touches accounts, sets marks and coin prices, beats once a
 * second and asks for the liquidation pass. Inline (VALUESCAN_LIQ_LIVE_THREAD=0, and the tests) that is today's engine
 * on the indexer's thread, reading the books in place. Threaded, the link mirrors the engine's inputs to a worker, one
 * message per event-loop turn at most (never a message per print): the accounts touched in the turn as they stand at
 * its end (numbers in one transferred Float64Array), the marks and coin prices that moved (the last per key), and the
 * coins and margin tiers when they change. The worker owns the engine and the feed's socket server and prices and
 * sends on its own beat: deltas go out as soon as a batch is priced, at most every FLUSH_MIN_MS (250 ms; the indexer's
 * beat was 1 s), and keep going while the indexer's thread is held. Back come the crossed books (read again first) and
 * the status.
 *
 * A worker that dies is started again (1 s, doubling to 30 s) and handed every input once more: the coins, tiers,
 * marks, coin prices and every book. The API's readers reconnect to the new feed server and get every coin whole.
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import type { Venue } from '../valuedesk/types.js';
import { marketsNow } from '../valuedesk/liquidations/rules.js';
import type { Tiers } from '../valuedesk/liquidations/math.js';
import type { LiqNow } from '../valuedesk/liquidations/levels.js';
import { LIQ_FEED_PORT } from './liqFeed.js';
import { AccountsEncoder, LiveCore, MirrorSource, type AccountsWire, type BookLike, type LiveSource, type LiveStatus, type StepAsk, type StepOut } from './liqLiveCore.js';

/** The worker sends what it priced at most this often (the indexer's beat sent once a second). */
export const FLUSH_MIN_MS = 250;
/**
 * It prices in pieces of this long, back to back while accounts wait, the indexer's messages read between them. A beat
 * of 200 ms every 250 ms (first version) left a fifth of the thread idle under a backlog: probe delays p99 0.9-2.3 s at
 * 300k books and 2,000 prints a second (tools/liqLiveBench.ts, 2026-11-09, a shared laptop).
 */
const WORK_CHUNK_MS = 50;
const THREAD_SLICE = 50_000;
/** Accounts per message at most: the start hands ~300k books over in pieces, the indexer's thread let go between them. */
const ACCOUNTS_PER_MSG = 10_000;
/** Crossed books held between messages at most (cohortTracker.ts CROSSED_MAX). */
const CROSSED_MAX = 50_000;
/** A liquidation pass or a question longer than this: given up (the next pass asks again). */
const CALL_MS = 10 * 60_000;
const VENUE_LIST: readonly Venue[] = ['sodex', 'hyperliquid', 'tradexyz', 'lighter', 'arcus'];

export type Totals = Map<string, Map<Venue, [number, number]>>;

export interface LiveLink {
  readonly threaded: boolean;
  touch(venue: Venue, address: string): void;
  /** A print's price: the mark set and the engine told (live.ts mark). */
  mark(venue: Venue, symbol: string, px: number): void;
  /** A mark set without telling the engine (a saved mark at the start, a read's mark). */
  price(key: string, px: number): void;
  coinPx(coin: string, px: number): void;
  /** After the start's touches: the feed opens (inline) or the thread starts and is handed every book. */
  start(): void;
  stop(): Promise<void>;
  /** The indexer's 1 s beat: inline the engine's beat; threaded the coins and tiers to the thread if they changed. */
  beat(slice: number, budgetMs: number): void;
  readonly ready: boolean;
  readonly pending: number;
  status(): LiveStatus & { thread?: { restarts: number; sent: number; queued: number } };
  readonly needsLevelInit: boolean;
  step(ask: StepAsk): Promise<StepOut>;
  commit(ids: ReadonlyMap<string, number>): void;
  totals(): Promise<Totals>;
  /** Tests and tools: every coin whole as the engine holds it, once everything handed in so far is priced. */
  drain(): Promise<Map<string, LiqNow>>;
  /** Tools: the heap the engine's thread uses (threaded only; null inline). */
  heapUsed(): Promise<number | null>;
}

export interface LinkDeps {
  /** Inline: the engine reads the indexer's books in place. */
  source: LiveSource;
  crossed: (venue: Venue, address: string, usd: number) => void;
  now: () => number;
  breathe: () => Promise<void>;
  /** Threaded: an account's book as it stands (undefined = gone, or left out of the heatmap). */
  book: (venue: Venue, address: string) => BookLike | undefined;
  /** Threaded, for a restarted thread: every book with positions (venue|address), every mark and coin price. */
  allKeys: () => Iterable<string>;
  allMarks: () => Iterable<[string, number]>;
  allCoinPx: () => Iterable<[string, number]>;
  /** The coins kept (SoDEX's list): the same Set until it changes. */
  wanted: () => ReadonlySet<string>;
  port?: number;
}

export function liqLiveThreadOn(): boolean {
  const v = process.env.VALUESCAN_LIQ_LIVE_THREAD;
  if (v === '0') return false;
  if (v === '1') return true;
  return !process.env.NODE_TEST_CONTEXT;
}

export function liveLink(d: LinkDeps, threaded = liqLiveThreadOn()): LiveLink {
  return threaded ? new ThreadLink(d) : new InlineLink(d);
}

// --- inline: today's engine on the indexer's thread ----------------------------------------------

class InlineLink implements LiveLink {
  readonly threaded = false;
  readonly core: LiveCore;

  constructor(private readonly d: LinkDeps) {
    this.core = new LiveCore(d.source, { crossed: d.crossed, port: d.port, now: d.now });
  }

  touch(venue: Venue, address: string): void { this.core.live.touch(venue, address); }
  mark(venue: Venue, symbol: string, px: number): void { this.core.live.mark(venue, symbol, px); }
  price(): void { /* the engine reads the indexer's marks in place */ }
  coinPx(): void { /* and its coin prices */ }
  start(): void { this.core.start(); }
  async stop(): Promise<void> { this.core.stop(); }
  beat(slice: number, budgetMs: number): void { this.core.tick(slice, budgetMs); }
  get ready(): boolean { return this.core.ready; }
  get pending(): number { return this.core.live.pending; }
  status() { return this.core.status(); }
  get needsLevelInit(): boolean { return this.core.needsLevelInit; }
  step(ask: StepAsk): Promise<StepOut> { return this.core.step(ask, this.d.breathe); }
  commit(ids: ReadonlyMap<string, number>): void { this.core.commit(ids); }
  async totals(): Promise<Totals> { return this.core.live.totals(); }
  async heapUsed(): Promise<number | null> { return null; }
  async drain(): Promise<Map<string, LiqNow>> {
    while (this.core.work(THREAD_SLICE, Number.POSITIVE_INFINITY) > 0) { /* everything waiting */ }
    this.core.send();
    return this.core.live.rows();
  }
}

// --- threaded: the indexer's side ----------------------------------------------------------------

/** Indexer -> thread. */
type ToThread =
  | { t: 'in'; acc?: AccountsWire; mk?: { k: string[]; px: Float64Array; e: Uint8Array }; cp?: { k: string[]; px: Float64Array }; tiers?: Array<[Venue, Map<string, Tiers>]>; wanted?: string[] }
  | { t: 'primed' }
  | { t: 'call'; id: number; op: 'step'; ask: StepAsk }
  | { t: 'call'; id: number; op: 'totals' | 'drain' | 'heap' }
  | { t: 'commit'; ids: Map<string, number> };

/** Thread -> indexer. */
type FromThread =
  | { t: 'status'; s: LiveStatus; crossed?: { k: string[]; usd: Float64Array } }
  | { t: 'reply'; id: number; value?: unknown; error?: string };

class ThreadLink implements LiveLink {
  readonly threaded = true;
  private w: Worker | null = null;
  private started = false;
  private stopping = false;
  private restarts = 0;
  private backoff = 1_000;
  private sent = 0;
  private acc = new Set<string>();
  private marks = new Map<string, { px: number; e: boolean }>();
  private cps = new Map<string, number>();
  private wantedSent: ReadonlySet<string> | null = null;
  private tiersSent = new Map<Venue, Map<string, Tiers>>();
  private tiersQ: Array<[Venue, Map<string, Tiers>]> = [];
  private wantedQ: string[] | null = null;
  private flushQueued = false;
  private primeOnDrain = false;
  private levelInit = false;
  private last: LiveStatus = { ready: false, pending: 0, ms: 0, readers: 0, error: null, levels: null };
  private nextId = 1;
  private calls = new Map<number, { ok: (v: unknown) => void; no: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly d: LinkDeps) {}

  touch(venue: Venue, address: string): void {
    this.acc.add(`${venue}|${address}`);
    this.schedule();
  }

  mark(venue: Venue, symbol: string, px: number): void {
    this.marks.set(`${venue}|${symbol}`, { px, e: true });
    this.schedule();
  }

  price(key: string, px: number): void {
    const was = this.marks.get(key);
    // A print's engine mark in the same turn stays one.
    this.marks.set(key, { px, e: was?.e ?? false });
    this.schedule();
  }

  coinPx(coin: string, px: number): void {
    this.cps.set(coin, px);
    this.schedule();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.spawn(false);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const w = this.w;
    this.w = null;
    this.failAll('the heatmap thread stopped');
    await w?.terminate();
  }

  beat(): void {
    const wanted = this.d.wanted();
    if (wanted !== this.wantedSent) { this.wantedSent = wanted; this.wantedQ = [...wanted]; this.schedule(); }
    for (const v of VENUE_LIST) {
      const tiers = marketsNow(v)?.tiers;
      if (!tiers || this.tiersSent.get(v) === tiers) continue;
      this.tiersSent.set(v, tiers);
      this.tiersQ.push([v, tiers]);
      this.schedule();
    }
  }

  get ready(): boolean { return this.last.ready && this.w !== null; }
  get pending(): number { return this.last.pending + this.acc.size; }

  status() {
    return { ...this.last, ready: this.ready, pending: this.pending, thread: { restarts: this.restarts, sent: this.sent, queued: this.acc.size } };
  }

  get needsLevelInit(): boolean { return !this.levelInit; }

  async step(ask: StepAsk): Promise<StepOut> {
    if (!this.ready) return { ready: false };
    const out = await this.call<StepOut>({ t: 'call', id: 0, op: 'step', ask });
    if (ask.init && out.ready) this.levelInit = true;
    return out;
  }

  commit(ids: ReadonlyMap<string, number>): void {
    this.w?.postMessage({ t: 'commit', ids: new Map(ids) } satisfies ToThread);
  }

  totals(): Promise<Totals> { return this.call<Totals>({ t: 'call', id: 0, op: 'totals' }); }
  heapUsed(): Promise<number | null> { return this.call<number>({ t: 'call', id: 0, op: 'heap' }); }

  async drain(): Promise<Map<string, LiqNow>> {
    this.flushAll();
    return this.call<Map<string, LiqNow>>({ t: 'call', id: 0, op: 'drain' });
  }

  private call<T>(m: Extract<ToThread, { t: 'call' }>): Promise<T> {
    const w = this.w;
    if (!w) return Promise.reject(new Error('the heatmap thread is not running'));
    const id = this.nextId++;
    return new Promise<T>((ok, no) => {
      const timer = setTimeout(() => { this.calls.delete(id); no(new Error(`the heatmap thread did not answer ${m.op} in ${CALL_MS / 1000} s`)); }, CALL_MS);
      timer.unref();
      this.calls.set(id, { ok: ok as (v: unknown) => void, no, timer });
      w.postMessage({ ...m, id });
    });
  }

  private failAll(why: string): void {
    for (const c of this.calls.values()) { clearTimeout(c.timer); c.no(new Error(why)); }
    this.calls.clear();
  }

  private spawn(resend: boolean): void {
    if (this.stopping) return;
    // Its own heap: a lean copy of the books (~300k accounts) and the engine's buckets.
    const w = new Worker(new URL(import.meta.url), { workerData: { liqLiveThread: true, port: this.d.port ?? LIQ_FEED_PORT }, resourceLimits: { maxOldGenerationSizeMb: 2_048 } });
    this.w = w;
    w.unref();
    w.on('message', (m: FromThread) => this.onMessage(m));
    const gone = (e?: unknown) => {
      if (this.w !== w) return;
      this.w = null;
      this.levelInit = false;
      this.last = { ...this.last, ready: false, error: e ? `heatmap thread: ${String((e as Error)?.message ?? e)}` : 'heatmap thread exited' };
      this.failAll('the heatmap thread stopped');
      if (this.stopping) return;
      this.restarts++;
      const t = setTimeout(() => this.spawn(true), this.backoff);
      t.unref();
      this.backoff = Math.min(30_000, this.backoff * 2);
    };
    w.on('error', gone);
    w.on('exit', () => gone());
    // A new thread knows nothing: the coins, tiers, every mark and coin price (a few thousand: cheap), and after a restart
    // every book again (at the first start the indexer touches them all itself).
    this.wantedSent = null;
    this.tiersSent.clear();
    for (const [k, px] of this.d.allMarks()) if (!this.marks.has(k)) this.marks.set(k, { px, e: false });
    for (const [c, px] of this.d.allCoinPx()) if (!this.cps.has(c)) this.cps.set(c, px);
    if (resend) for (const k of this.d.allKeys()) this.acc.add(k);
    // The books handed in so far (at the start: all of them) are what "ready" waits for.
    this.primeOnDrain = true;
    this.beat();
    this.schedule(true);
  }

  private onMessage(m: FromThread): void {
    if (m.t === 'status') {
      this.last = m.s;
      // A thread that got as far as ready is a healthy one: the next restart waits 1 s again.
      if (m.s.ready) this.backoff = 1_000;
      if (m.crossed) {
        for (let i = 0; i < m.crossed.k.length; i++) {
          const k = m.crossed.k[i]!;
          const j = k.indexOf('|');
          this.d.crossed(k.slice(0, j) as Venue, k.slice(j + 1), m.crossed.usd[i]!);
        }
      }
      return;
    }
    const c = this.calls.get(m.id);
    if (!c) return;
    this.calls.delete(m.id);
    clearTimeout(c.timer);
    if (m.error !== undefined) c.no(new Error(m.error));
    else c.ok(m.value);
  }

  /** One message at the end of this turn (setImmediate: after the turn's I/O callbacks, every print of it in). */
  private schedule(force = false): void {
    if (this.flushQueued || (!this.started && !force)) return;
    this.flushQueued = true;
    setImmediate(() => {
      this.flushQueued = false;
      this.flush();
    });
  }

  private flushAll(): void {
    while (this.w && (this.acc.size || this.marks.size || this.cps.size || this.tiersQ.length || this.wantedQ)) this.flush();
  }

  private flush(): void {
    const w = this.w;
    if (!w) return;
    const m: Extract<ToThread, { t: 'in' }> = { t: 'in' };
    const transfer: ArrayBuffer[] = [];
    if (this.tiersQ.length) { m.tiers = this.tiersQ; this.tiersQ = []; }
    if (this.wantedQ) { m.wanted = this.wantedQ; this.wantedQ = null; }
    if (this.cps.size) {
      const k = [...this.cps.keys()];
      const px = Float64Array.from(this.cps.values());
      this.cps.clear();
      m.cp = { k, px };
      transfer.push(px.buffer as ArrayBuffer);
    }
    if (this.marks.size) {
      const n = this.marks.size;
      const k = new Array<string>(n);
      const px = new Float64Array(n);
      const e = new Uint8Array(n);
      let i = 0;
      for (const [key, x] of this.marks) { k[i] = key; px[i] = x.px; e[i] = x.e ? 1 : 0; i++; }
      this.marks.clear();
      m.mk = { k, px, e };
      transfer.push(px.buffer as ArrayBuffer, e.buffer as ArrayBuffer);
    }
    if (this.acc.size) {
      const enc = new AccountsEncoder();
      for (const key of this.acc) {
        this.acc.delete(key);
        const j = key.indexOf('|');
        enc.add(key, this.d.book(key.slice(0, j) as Venue, key.slice(j + 1)));
        if (enc.size >= ACCOUNTS_PER_MSG) break;
      }
      m.acc = enc.take();
      transfer.push(m.acc.n.buffer as ArrayBuffer);
    }
    if (m.acc || m.mk || m.cp || m.tiers || m.wanted) {
      w.postMessage(m, transfer);
      this.sent++;
    }
    if (this.acc.size) { this.schedule(); return; }
    if (this.primeOnDrain) {
      this.primeOnDrain = false;
      w.postMessage({ t: 'primed' } satisfies ToThread);
    }
  }
}

// --- threaded: the worker ------------------------------------------------------------------------

if (!isMainThread && (workerData as { liqLiveThread?: boolean } | null)?.liqLiveThread) {
  const port = parentPort!;
  const { liqCoin } = await import('../valuedesk/liquidations/levels.js');
  const mirror = new MirrorSource(liqCoin);
  const crossed = new Map<string, number>();
  const core = new LiveCore(mirror, {
    crossed: (venue, address, usd) => {
      const k = `${venue}|${address}`;
      if (crossed.size < CROSSED_MAX || crossed.has(k)) crossed.set(k, Math.max(usd, crossed.get(k) ?? 0));
    },
    port: (workerData as { port: number }).port,
    primed: false,
  });
  core.start();
  let timer: NodeJS.Timeout | null = null;
  let queued = false;
  let flushAt = 0;
  let flushedAt = -1;
  let statusAt = 0;
  const report = (force = false) => {
    const now = Date.now();
    if (!force && !crossed.size && now - statusAt < 500) return;
    statusAt = now;
    let c: { k: string[]; usd: Float64Array } | undefined;
    if (crossed.size) {
      c = { k: [...crossed.keys()], usd: Float64Array.from(crossed.values()) };
      crossed.clear();
    }
    port.postMessage({ t: 'status', s: core.status(), ...(c ? { crossed: c } : {}) } satisfies FromThread, c ? [c.usd.buffer as ArrayBuffer] : []);
  };
  // Price a piece; send once FLUSH_MIN_MS passed since the last send (at once when the last piece of a batch is done,
  // if that long has passed; else at the earliest moment it may); go on at once while accounts wait.
  const loop = () => {
    queued = false;
    // Nothing is bucketed before SoDEX's list is known (the first seconds after a start).
    if (!mirror.wantedSet.size) { report(); return; }
    const t0 = Date.now();
    const left = core.work(THREAD_SLICE, WORK_CHUNK_MS);
    const since = Date.now() - flushAt;
    if (since >= FLUSH_MIN_MS) {
      core.send();
      flushAt = Date.now();
      flushedAt = core.live.processed;
    }
    core.ms = Date.now() - t0;
    report();
    if (left > 0) kick();
    else if (core.live.processed !== flushedAt && !timer) timer = setTimeout(() => { timer = null; kick(); }, FLUSH_MIN_MS - since);
  };
  const kick = () => {
    if (queued) return;
    queued = true;
    setImmediate(loop);
  };
  // A beat a second regardless: tick frames, the minute's whole coins, a new reader's coins, the fine layers following a quiet coin's price.
  setInterval(kick, 1_000);
  const breathe = () => new Promise<void>((r) => setImmediate(r));
  port.on('message', (m: ToThread) => {
    switch (m.t) {
      case 'in': {
        if (m.tiers) for (const [v, t] of m.tiers) mirror.tiers.set(v, t);
        if (m.wanted) mirror.wantedSet = new Set(m.wanted);
        if (m.cp) for (let i = 0; i < m.cp.k.length; i++) mirror.coinPx.set(m.cp.k[i]!, m.cp.px[i]!);
        if (m.mk) {
          for (let i = 0; i < m.mk.k.length; i++) {
            const k = m.mk.k[i]!;
            const px = m.mk.px[i]!;
            mirror.marks.set(k, px);
            if (m.mk.e[i]) { const j = k.indexOf('|'); core.live.mark(k.slice(0, j) as Venue, k.slice(j + 1), px); }
          }
        }
        if (m.acc) mirror.applyAccounts(m.acc, (key) => core.live.touchKey(key));
        kick();
        return;
      }
      case 'primed':
        core.primed = true;
        kick();
        return;
      case 'commit':
        core.commit(m.ids);
        return;
      case 'call': {
        const reply = (value: unknown, transfer: ArrayBuffer[] = []) => port.postMessage({ t: 'reply', id: m.id, value } satisfies FromThread, transfer);
        const fail = (e: unknown) => port.postMessage({ t: 'reply', id: m.id, error: String((e as Error)?.message ?? e) } satisfies FromThread);
        try {
          if (m.op === 'totals') reply(core.live.totals());
          else if (m.op === 'heap') {
            // Tools: the thread's heap in use, after a collection where the process allows one (--expose-gc).
            (globalThis as { gc?: () => void }).gc?.();
            reply(process.memoryUsage().heapUsed);
          }
          else if (m.op === 'drain') {
            while (core.work(THREAD_SLICE, Number.POSITIVE_INFINITY) > 0) { /* everything handed in so far */ }
            if (mirror.wantedSet.size) { core.send(); flushAt = Date.now(); flushedAt = core.live.processed; }
            // The status first: the indexer's side reads `ready` from it.
            report(true);
            reply(core.live.rows());
          } else if (m.op === 'step') {
            core.step(m.ask, breathe).then((out) => {
              const transfer: ArrayBuffer[] = [];
              for (const [, b] of out.now ?? []) transfer.push(b.buffer as ArrayBuffer);
              for (const f of out.step?.fine ?? []) transfer.push(f[3].buffer as ArrayBuffer);
              reply(out, transfer);
            }, fail);
          }
        } catch (e) {
          fail(e);
        }
        return;
      }
    }
  });
  report(true);
}

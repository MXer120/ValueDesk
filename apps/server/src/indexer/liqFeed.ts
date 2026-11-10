/**
 * The live liquidation levels from the indexer to the API, on a loopback socket.
 *
 * The indexer is a worker thread of the API in dev and its own service on the
 * instance (worker.ts); either way it owns the books and prices them
 * (valuedesk/liquidations/live.ts). Writing every change to the index file and
 * reading it back would put a write a second on a disk that is already the
 * bottleneck, so the changes travel here instead: newline-delimited JSON on
 * 127.0.0.1:VALUESCAN_LIQ_FEED_PORT (8796), one frame per coin and second.
 *
 *   indexer -> API   {t:"d", ...LiveDelta}     a coin's changed buckets (whole: all of them)
 *                    {t:"tick", at, ready}     after every flush; ready = every book priced into it once
 *
 * The API keeps every coin whole in memory from these (LiqFeedState) and streams
 * them on to the browsers (routes/valuedesk.ts /ws/liq). A new connection gets
 * every coin whole first. Loopback only: nothing else can connect.
 *
 * THE READER'S OWN THREAD (2026-11-09: release v0.2.200 rolled back by the API freeze gate). One line of this feed is a
 * coin whole: BTC with its $1 fine layer is ~250,000 rows, 20+ MB of JSON, and the engine sends every coin whole once a
 * minute and after every reconnect. Parsing such a line, building its rows and walking it for what differed held the
 * API thread in one piece however the lines were sliced (production stall profiles 2026-11-09: 7.7 s busy in one stall,
 * apply 52%; 12.4 s "by liq:feed"; 5.8 s of it garbage collection - every row of every coin a new array each minute).
 * So the socket, the parse and the diff run on a worker (FeedCore below), which posts each frame worked out as a
 * FrameOp: per venue only the rows to write or delete (packed in a Float64Array, moved not copied) and the indices to
 * announce. This thread keeps its copy (`coins`, which liqWs.ts and liqRead.ts read as before) by writing those rows
 * into the arrays it already holds, a few thousand rows per turn of the loop (FEED_SLICE_MS), and announces each frame
 * once it is all in. VALUESCAN_LIQ_FEED_THREAD=0, and the tests unless they ask for it, run the same core inline.
 */
import { mark } from './busy.js';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import type { Venue } from '../valuedesk/types.js';
import type { LiveDelta } from '../valuedesk/liquidations/live.js';
import type { LiqRow } from '../valuedesk/liquidations/levels.js';

export const LIQ_FEED_PORT = Number(process.env.VALUESCAN_LIQ_FEED_PORT) || 8796;
const HOST = '127.0.0.1';
/** A reader that falls this far behind is dropped (it reconnects and gets every coin whole). */
const MAX_BUFFERED = 32 * 1024 * 1024;
/** The API reads the feed in slices of this much work, giving its thread back between them. */
const FEED_SLICE_MS = 8;

// --- indexer side --------------------------------------------------------------------------

/** One try a second for this many seconds to bind the feed port (LiqFeedServer.start). */
const BIND_TRIES = 60;

export class LiqFeedServer {
  private server: net.Server | null = null;
  private clients = new Set<net.Socket>();
  lastError: string | null = null;

  /** `onReader`: a reader connected - the engine should send every coin whole next. */
  constructor(private readonly onReader: () => void, private readonly port = LIQ_FEED_PORT) {}

  /** Tries left to bind the port while another process still holds it (a handover: the outgoing one lets it go). */
  private tries = 0;
  private retry?: NodeJS.Timeout;

  start(): void {
    if (this.server) return;
    this.lastError = null;
    if (!this.tries) this.tries = BIND_TRIES;
    const srv = net.createServer((sock) => {
      sock.setNoDelay(true);
      this.clients.add(sock);
      sock.on('close', () => this.clients.delete(sock));
      sock.on('error', () => sock.destroy());
      sock.on('data', () => { /* readers send nothing */ });
      this.onReader();
    });
    srv.on('error', (e) => {
      // Another indexer holds the port: a handover's outgoing process for a moment more (handover.ts), so try again every
      // second for a minute; two dev servers on one machine: no live feed from this one after that. Or the heatmap thread
      // was just started again and the old one's socket is not closed yet (liqLiveCore.ts retries).
      this.lastError = String(e);
      if (this.server === srv) this.server = null;
      if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE' && --this.tries > 0) {
        this.retry = setTimeout(() => this.start(), 1_000);
        this.retry.unref?.();
      }
    });
    srv.on('listening', () => { this.lastError = null; this.tries = 0; });
    srv.listen(this.port, HOST);
    this.server = srv;
  }

  stop(): void {
    if (this.retry) clearTimeout(this.retry);
    this.tries = 0;
    for (const c of this.clients) c.destroy();
    this.clients.clear();
    this.server?.close();
    this.server = null;
  }

  get readers(): number {
    return this.clients.size;
  }

  /** Listening (or about to): false after the port was refused, until `start` is called again. */
  get listening(): boolean {
    return this.server !== null;
  }

  send(deltas: readonly LiveDelta[], tick: { at: number; ready: boolean }): void {
    if (!this.clients.size) return;
    let out = '';
    for (const d of deltas) out += `${JSON.stringify({ t: 'd', ...d })}\n`;
    out += `${JSON.stringify({ t: 'tick', ...tick })}\n`;
    for (const c of this.clients) {
      if (c.writableLength > MAX_BUFFERED) { c.destroy(); continue; }
      c.write(out);
    }
  }
}

// --- API side ------------------------------------------------------------------------------

export interface LiveVenue {
  /** bucket index -> the LiqRow without its index (levels.ts: [long USD, short USD, long n, short n, ...bands]). */
  b: Map<number, number[]>;
  /** The engine's coverage (live.ts Cov; an older indexer sends the first five). */
  c: number[];
  o: [number, number, number, number];
}

export interface LiveCoin {
  p: number;
  st: number;
  ep: number;
  at: number;
  v: Map<Venue, LiveVenue>;
  /** The fine layer (live.ts FineAgg): its step, range [lo, hi), epoch, and per venue its cells (rows without their index). */
  f?: { st: number; lo: number; hi: number; ep: number; v: Map<Venue, Map<number, number[]>> };
}

/** A coin changed: the venues and bucket indices that did; `whole`: laid out anew (the browsers get it whole). */
export interface CoinChange {
  coin: string;
  whole: boolean;
  venues: Map<Venue, number[]>;
  covered: Set<Venue>;
  /** The fine layer's changed cells; `whole`: laid out anew. */
  fine?: { whole: boolean; venues: Map<Venue, number[]> };
}

/**
 * One venue's part of a frame as worked out by FeedCore. `rows`: what to write, in frame order, packed as
 * [index, n, ...n values] (n = 0: delete the row); `idx`: the indices to announce (CoinChange.venues); `c`/`o`: the
 * venue's coverage and outside after the frame; `gone`: a whole frame without the venue (it is dropped).
 */
export interface VenueOp { venue: Venue; rows: Float64Array; idx: Float64Array; c: number[]; o: [number, number, number, number]; gone?: boolean }
/** The fine layer's part: `layout` set when it is laid out anew (held cells go); `refresh`: whole in the same layout (venues not in it go). */
export interface FineOp { whole: boolean; layout: { st: number; lo: number; hi: number; ep: number } | null; refresh: boolean; venues: Array<{ venue: Venue; rows: Float64Array; idx: Float64Array }> }
export interface FrameOp { k: 'd'; coin: string; p: number; st: number; ep: number; relayout: boolean; whole: boolean; venues: VenueOp[]; covered: Venue[]; f?: FineOp }
export type FeedOp = FrameOp | { k: 'tick'; at: number; ready: boolean };

/** Rows packed for posting: [index, n, ...values], n = 0 a delete. */
class Pack {
  private buf = new Float64Array(256);
  private n = 0;
  private room(k: number): void {
    if (this.n + k <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.n + k) size *= 2;
    const b = new Float64Array(size);
    b.set(this.buf.subarray(0, this.n));
    this.buf = b;
  }
  /** A LiqRow (index first). */
  row(r: readonly number[]): void {
    this.room(r.length + 1);
    this.buf[this.n++] = r[0]!;
    this.buf[this.n++] = r.length - 1;
    for (let k = 1; k < r.length; k++) this.buf[this.n++] = r[k]!;
  }
  del(i: number): void {
    this.room(2);
    this.buf[this.n++] = i;
    this.buf[this.n++] = 0;
  }
  take(): Float64Array {
    return this.buf.slice(0, this.n);
  }
}

const zeroRow = (r: readonly number[]) => !r[3] && !r[4];
/** A held row (no index) equal to a LiqRow's values. */
function sameRow(held: readonly number[], r: readonly number[]): boolean {
  if (held.length !== r.length - 1) return false;
  for (let k = 1; k < r.length; k++) if (held[k - 1] !== r[k]) return false;
  return true;
}
/** A LiqRow's values into the map: into the array already held when it has the length (no new array a minute per row). */
function writeRow(m: Map<number, number[]>, r: readonly number[], held: number[] | undefined): void {
  if (held && held.length === r.length - 1) { for (let k = 1; k < r.length; k++) held[k - 1] = r[k]!; return; }
  m.set(r[0]!, r.slice(1));
}
const newVenue = (): LiveVenue => ({ b: new Map(), c: [0, 0, 0, 0, 0, 0, 0, 0], o: [0, 0, 0, 0] });

/**
 * The feed's frames worked out against the coins as the last frames left them: the parse, the writes and the minute
 * refresh's diff (what the browsers are told of a whole frame in the same layout: only what differs). Runs on the
 * reader's thread; its FrameOps keep the API thread's copy (FeedMirror) equal to this one's.
 */
export class FeedCore {
  readonly coins = new Map<string, LiveCoin>();

  reset(): void {
    this.coins.clear();
  }

  /** One line of the feed (null: not a frame). */
  line(s: string): FeedOp | null {
    let f: { t?: string } & Record<string, unknown>;
    try { f = JSON.parse(s); } catch { return null; }
    if (f.t === 'd') return this.frame(f as unknown as LiveDelta);
    if (f.t === 'tick') return { k: 'tick', at: Number(f.at) || Date.now(), ready: !!f.ready };
    return null;
  }

  frame(d: LiveDelta): FrameOp {
    const old = this.coins.get(d.coin);
    // A new layout (or a coin not seen yet): what the browsers hold of it no longer fits.
    const relayout = !old || old.ep !== d.ep;
    // The engine's minute refresh (whole, same layout): the readers are told only what differs from before.
    const refresh = !!d.whole && !relayout;
    let c: LiveCoin;
    if (relayout) {
      c = { p: d.p, st: d.st, ep: d.ep, at: 0, v: new Map() };
      this.coins.set(d.coin, c);
    } else {
      c = old!;
      c.p = d.p;
      if (d.whole) c.st = d.st;
    }
    const venues: VenueOp[] = [];
    const covered: Venue[] = [];
    const inFrame = new Set<Venue>();
    for (const [venue, x] of Object.entries(d.v) as Array<[Venue, NonNullable<LiveDelta['v'][Venue]>]>) {
      inFrame.add(venue);
      const was = c.v.get(venue);
      // Written in place; a whole frame says every row, coverage and outside (what it leaves out is gone or zero).
      const v = was ?? newVenue();
      if (!was) c.v.set(venue, v);
      const pack = new Pack();
      let idx: Float64Array;
      if (refresh) {
        // Its rows in the frame's order, as a new map would hold them (the order the next refresh names gone rows in),
        // in the arrays already held.
        const next = new Map<number, number[]>();
        const diff = new Set<number>();
        for (const r of x.b) {
          const i = r[0];
          const held = v.b.get(i);
          if (zeroRow(r)) {
            diff.add(i);
            next.delete(i);
            if (held) { v.b.delete(i); pack.del(i); }
            continue;
          }
          if (held && sameRow(held, r)) { next.set(i, held); continue; }
          if (held && held.length === r.length - 1) { for (let k = 1; k < r.length; k++) held[k - 1] = r[k]!; next.set(i, held); }
          else next.set(i, r.slice(1));
          pack.row(r);
          diff.add(i);
        }
        for (const i of v.b.keys()) if (!next.has(i)) { pack.del(i); diff.add(i); }
        v.b = next;
        idx = Float64Array.from(diff);
        const cov = x.c ?? [0, 0, 0, 0, 0, 0, 0, 0];
        // Its coverage counts as moved only when it differs from what was held.
        if (x.c && !(was && was.c.every((y, k) => y === cov[k]))) covered.push(venue);
        v.c = cov;
        v.o = x.o ?? [0, 0, 0, 0];
      } else {
        idx = new Float64Array(x.b.length);
        for (let k = 0; k < x.b.length; k++) {
          const r = x.b[k]!;
          const i = r[0];
          idx[k] = i;
          if (zeroRow(r)) { v.b.delete(i); pack.del(i); } else { writeRow(v.b, r, v.b.get(i)); pack.row(r); }
        }
        if (x.c) { v.c = x.c; covered.push(venue); }
        if (x.o) v.o = x.o;
      }
      venues.push({ venue, rows: pack.take(), idx, c: v.c, o: v.o });
    }
    if (refresh) {
      for (const [venue, was] of c.v) {
        if (inFrame.has(venue)) continue;
        venues.push({ venue, gone: true, rows: new Float64Array(0), idx: Float64Array.from(was.b.keys()), c: was.c, o: was.o });
        covered.push(venue);
        c.v.delete(venue);
      }
    }
    const op: FrameOp = { k: 'd', coin: d.coin, p: d.p, st: d.st, ep: d.ep, relayout, whole: !!d.whole, venues, covered };
    if (d.f) op.f = this.fine(c, d.f);
    return op;
  }

  /** The fine layer's part of a frame: a new layout of it replaces what is held. */
  private fine(c: LiveCoin, f: NonNullable<LiveDelta['f']>): FineOp {
    const cur = c.f;
    const whole = f.whole || !cur || cur.ep !== f.ep;
    const same = !!cur && cur.ep === f.ep && cur.st === f.st && cur.lo === f.lo && cur.hi === f.hi;
    const layout = whole && !same ? { st: f.st, lo: f.lo, hi: f.hi, ep: f.ep } : null;
    if (layout) c.f = { ...layout, v: new Map() };
    const held = c.f!;
    const refresh = whole && !layout;
    const venues: FineOp['venues'] = [];
    const inFrame = new Set<Venue>();
    for (const [venue, rows] of Object.entries(f.v) as Array<[Venue, LiqRow[]]>) {
      inFrame.add(venue);
      let m = held.v.get(venue);
      if (!m) { m = new Map(); held.v.set(venue, m); }
      const pack = new Pack();
      const idx = new Float64Array(rows.length);
      const seen = refresh ? new Set<number>() : null;
      for (let k = 0; k < rows.length; k++) {
        const r = rows[k]!;
        const i = r[0];
        idx[k] = i;
        seen?.add(i);
        const was = m.get(i);
        if (zeroRow(r)) { if (was) { m.delete(i); pack.del(i); } continue; }
        if (refresh && was && sameRow(was, r)) continue;
        writeRow(m, r, was);
        pack.row(r);
      }
      if (seen) for (const i of m.keys()) if (!seen.has(i)) { m.delete(i); pack.del(i); }
      venues.push({ venue, rows: pack.take(), idx });
    }
    if (refresh) for (const venue of held.v.keys()) if (!inFrame.has(venue)) held.v.delete(venue);
    return { whole, layout, refresh, venues };
  }
}

/** The buffers a FeedOp carries (moved to the receiving thread, not copied). */
function buffersOf(op: FeedOp, out: ArrayBuffer[]): void {
  if (op.k !== 'd') return;
  for (const v of op.venues) out.push(v.rows.buffer as ArrayBuffer, v.idx.buffer as ArrayBuffer);
  for (const v of op.f?.venues ?? []) out.push(v.rows.buffer as ArrayBuffer, v.idx.buffer as ArrayBuffer);
}

/** Lines of a stream cut anywhere: a line that spans chunks is joined once, not re-cut with every chunk (a 20 MB line is ~300 of them). */
class Lines {
  private parts: string[] = [];
  push(chunk: string, out: string[]): void {
    let start = 0;
    let i: number;
    while ((i = chunk.indexOf('\n', start)) >= 0) {
      let line = chunk.slice(start, i);
      if (this.parts.length) { this.parts.push(line); line = this.parts.join(''); this.parts = []; }
      if (line) out.push(line);
      start = i + 1;
    }
    if (start < chunk.length) this.parts.push(start ? chunk.slice(start) : chunk);
  }
  clear(): void {
    this.parts = [];
  }
}

/** Rows written between two looks at the clock. */
const ROWS_PER_LOOK = 1_024;

/**
 * Every coin as the indexer streams it, kept whole in memory. Emits 'change'
 * (CoinChange) per coin frame and 'tick' after each flush.
 */
export class LiqFeedState extends EventEmitter {
  readonly coins = new Map<string, LiveCoin>();
  ready = false;
  connected = false;
  lastAt = 0;
  private sock: net.Socket | null = null;
  private worker: Worker | null = null;
  private lines = new Lines();
  /** The inline path's core (the thread runs its own). */
  private core = new FeedCore();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private backoff = 1_000;
  private readonly thread: boolean;

  constructor(private readonly port = LIQ_FEED_PORT, o: { thread?: boolean } = {}) {
    super();
    this.setMaxListeners(0);
    this.thread = o.thread ?? threadOn();
  }

  start(): void {
    this.stopped = false;
    if (this.sock || this.worker || this.timer) return;
    if (this.thread) this.spawn(); else this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.sock?.destroy();
    this.sock = null;
    const w = this.worker;
    this.worker = null;
    if (w) void w.terminate();
    this.connected = false;
  }

  /** Fresh enough to answer from: connected, every book priced in, a frame in the last 10 s. */
  get live(): boolean {
    return this.connected && this.ready && Date.now() - this.lastAt < 10_000;
  }

  /** What waits to be written into the copy (frames and ticks), for the health answer. */
  get backlog(): number {
    return this.queue.length - this.qi + (this.cur ? 1 : 0);
  }

  private opened(): void {
    this.connected = true;
    this.backoff = 1_000;
    this.coins.clear();
    this.ready = false;
  }

  /** The connection went: what it left unread belongs to the coins that are cleared on the next connect. */
  private closed(): void {
    this.connected = false;
    this.ready = false;
    this.lines.clear();
    this.queue = [];
    this.qi = 0;
    this.cur = null;
  }

  private retryLater(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => { this.timer = null; if (this.thread) this.spawn(); else this.connect(); }, this.backoff);
    this.timer.unref?.();
    this.backoff = Math.min(30_000, this.backoff * 2);
  }

  private connect(): void {
    const sock = net.connect(this.port, HOST);
    this.sock = sock;
    sock.setEncoding('utf8');
    sock.on('connect', () => { this.core.reset(); this.opened(); });
    sock.on('data', (chunk: string) => this.data(chunk));
    sock.on('error', () => sock.destroy());
    sock.on('close', () => {
      if (this.sock !== sock) return;
      this.sock = null;
      this.closed();
      this.retryLater();
    });
  }

  /** The feed's own thread: it connects, reads and works the frames out; this one writes what it posts. */
  private spawn(): void {
    const w = new Worker(new URL(import.meta.url), { workerData: { liqFeedThread: true, port: this.port } });
    this.worker = w;
    w.unref();
    w.on('message', (m: { k: 'conn' } | { k: 'close' } | { k: 'ops'; ops: FeedOp[] }) => {
      if (this.worker !== w) return;
      if (m.k === 'conn') this.opened();
      else if (m.k === 'close') this.closed();
      else { for (const op of m.ops) this.queue.push(op); this.drain(); }
    });
    const gone = () => {
      if (this.worker !== w) return;
      this.worker = null;
      this.closed();
      this.retryLater();
    };
    w.on('error', gone);
    w.on('exit', gone);
  }

  /**
   * Frames as they arrive on this thread (the inline path; exported for tests). Worked off in FEED_SLICE_MS slices with
   * the socket paused between them (2026-11-08: after any hold of the API thread the indexer's backlog came in as
   * megabytes at once, and this read all of it in one piece, cutting the buffer again for every line - 6.4 s).
   */
  data(chunk: string): void {
    mark('liq:feed');
    const ls: string[] = [];
    this.lines.push(chunk, ls);
    for (const l of ls) this.queue.push(l);
    this.drain();
  }

  /** Lines (inline) or worked-out frames (from the thread), in order. */
  private queue: Array<string | FeedOp> = [];
  private qi = 0;
  /** The frame being written, a slice at a time. */
  private cur: Generator<void, void, void> | null = null;
  private draining = false;
  private paused = false;

  private drain(): void {
    if (this.draining) return;
    const t0 = performance.now();
    for (;;) {
      if (!this.cur) {
        if (this.qi >= this.queue.length) break;
        const item = this.queue[this.qi++]!;
        const op = typeof item === 'string' ? this.core.line(item) : item;
        if (op?.k === 'd') this.cur = this.write(op);
        else if (op?.k === 'tick') {
          this.ready = op.ready;
          this.lastAt = Date.now();
          this.emit('tick', op.at);
        }
      }
      while (this.cur && performance.now() - t0 < FEED_SLICE_MS) if (this.cur.next().done) this.cur = null;
      if ((this.cur || this.qi < this.queue.length) && performance.now() - t0 >= FEED_SLICE_MS) {
        if (this.qi > 4_096) { this.queue = this.queue.slice(this.qi); this.qi = 0; }
        this.draining = true;
        this.pause(true);
        setImmediate(() => {
          this.draining = false;
          mark('liq:feed');
          this.drain();
        });
        return;
      }
    }
    this.queue = [];
    this.qi = 0;
    this.pause(false);
  }

  /** The socket (inline) or the thread's socket held while a backlog is worked off here. */
  private pause(on: boolean): void {
    if (this.sock) {
      if (on) this.sock.pause(); else if (this.sock.isPaused()) this.sock.resume();
      return;
    }
    // The thread: only once a real backlog builds (it keeps reading and working out frames meanwhile).
    if (on && !this.paused && this.queue.length - this.qi > 64) { this.paused = true; this.worker?.postMessage({ k: 'pause' }); }
    else if (!on && this.paused) { this.paused = false; this.worker?.postMessage({ k: 'resume' }); }
  }

  /**
   * One frame into the copy, ROWS_PER_LOOK rows per step. A coin or fine layer laid out anew is built beside the one held
   * and put in place at the end; the rest is written in place (a read between two steps sees some rows of this frame and
   * the rest of the last, each a state the feed was in; the browsers hear of every changed row with the frame's change).
   */
  private *write(op: FrameOp): Generator<void, void, void> {
    const old = this.coins.get(op.coin);
    const fresh = op.relayout || !old;
    const c: LiveCoin = fresh ? { p: op.p, st: op.st, ep: op.ep, at: 0, v: new Map() } : old!;
    const venues = new Map<Venue, number[]>();
    let n = 0;
    for (const x of op.venues) {
      venues.set(x.venue, Array.from(x.idx));
      if (x.gone) { c.v.delete(x.venue); continue; }
      let v = c.v.get(x.venue);
      if (!v) { v = newVenue(); c.v.set(x.venue, v); }
      for (let p = 0; p < x.rows.length;) {
        p = writePacked(v.b, x.rows, p);
        if (++n % ROWS_PER_LOOK === 0) yield;
      }
      v.c = x.c;
      v.o = x.o;
    }
    let fine: CoinChange['fine'];
    if (op.f) {
      const target = op.f.layout ? { ...op.f.layout, v: new Map<Venue, Map<number, number[]>>() } : c.f;
      if (target) {
        if (op.f.refresh) for (const venue of target.v.keys()) if (!op.f.venues.some((x) => x.venue === venue)) target.v.delete(venue);
        const fv = new Map<Venue, number[]>();
        for (const x of op.f.venues) {
          fv.set(x.venue, Array.from(x.idx));
          let m = target.v.get(x.venue);
          if (!m) { m = new Map(); target.v.set(x.venue, m); }
          for (let p = 0; p < x.rows.length;) {
            p = writePacked(m, x.rows, p);
            if (++n % ROWS_PER_LOOK === 0) yield;
          }
        }
        if (op.f.layout) c.f = target;
        fine = { whole: op.f.whole, venues: fv };
      }
    }
    c.p = op.p;
    if (fresh || op.whole) c.st = op.st;
    c.at = Date.now();
    if (fresh) this.coins.set(op.coin, c);
    this.emit('change', { coin: op.coin, whole: op.relayout, venues, covered: new Set(op.covered), ...(fine ? { fine } : {}) } satisfies CoinChange);
  }
}

/** One packed row (Pack) into a map; returns where the next starts. */
function writePacked(m: Map<number, number[]>, rows: Float64Array, p: number): number {
  const i = rows[p]!;
  const n = rows[p + 1]!;
  p += 2;
  if (n === 0) { m.delete(i); return p; }
  const held = m.get(i);
  if (held && held.length === n) { for (let k = 0; k < n; k++) held[k] = rows[p + k]!; }
  else { const a: number[] = new Array(n); for (let k = 0; k < n; k++) a[k] = rows[p + k]!; m.set(i, a); }
  return p + n;
}

function threadOn(): boolean {
  const v = process.env.VALUESCAN_LIQ_FEED_THREAD;
  if (v === '0') return false;
  if (v === '1') return true;
  return !process.env.NODE_TEST_CONTEXT;
}

// --- the feed's thread ---------------------------------------------------------------------

if (!isMainThread && (workerData as { liqFeedThread?: boolean } | null)?.liqFeedThread) {
  const port = (workerData as { port: number }).port;
  const core = new FeedCore();
  const lines = new Lines();
  let sock: net.Socket | null = null;
  let backoff = 1_000;
  const connect = () => {
    const s = net.connect(port, HOST);
    sock = s;
    s.setEncoding('utf8');
    s.on('connect', () => {
      backoff = 1_000;
      core.reset();
      lines.clear();
      parentPort!.postMessage({ k: 'conn' });
    });
    s.on('data', (chunk: string) => {
      const ls: string[] = [];
      lines.push(chunk, ls);
      const ops: FeedOp[] = [];
      const moved: ArrayBuffer[] = [];
      for (const l of ls) {
        const op = core.line(l);
        if (!op) continue;
        ops.push(op);
        buffersOf(op, moved);
      }
      if (ops.length) parentPort!.postMessage({ k: 'ops', ops }, moved);
    });
    s.on('error', () => s.destroy());
    s.on('close', () => {
      if (sock !== s) return;
      sock = null;
      lines.clear();
      parentPort!.postMessage({ k: 'close' });
      setTimeout(connect, backoff);
      backoff = Math.min(30_000, backoff * 2);
    });
  };
  parentPort!.on('message', (m: { k: 'pause' | 'resume' }) => {
    if (m.k === 'pause') sock?.pause();
    else if (sock?.isPaused()) sock.resume();
  });
  connect();
}

/** The API's one reader of the indexer's feed (started on first use). */
let state: LiqFeedState | null = null;
export function liqFeed(): LiqFeedState {
  if (!state) {
    state = new LiqFeedState();
    if (process.env.VALUESCAN_LIQ_FEED !== '0') state.start();
  }
  return state;
}

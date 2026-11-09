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
 */
import { mark } from './busy.js';
import net from 'node:net';
import { EventEmitter } from 'node:events';
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

export class LiqFeedServer {
  private server: net.Server | null = null;
  private clients = new Set<net.Socket>();
  lastError: string | null = null;

  /** `onReader`: a reader connected - the engine should send every coin whole next. */
  constructor(private readonly onReader: () => void, private readonly port = LIQ_FEED_PORT) {}

  start(): void {
    if (this.server) return;
    this.lastError = null;
    const srv = net.createServer((sock) => {
      sock.setNoDelay(true);
      this.clients.add(sock);
      sock.on('close', () => this.clients.delete(sock));
      sock.on('error', () => sock.destroy());
      sock.on('data', () => { /* readers send nothing */ });
      this.onReader();
    });
    srv.on('error', (e) => {
      // Another indexer holds the port (two dev servers on one machine): no live feed from this one.
      // Or the heatmap thread was just started again and the old one's socket is not closed yet (liqLiveCore.ts retries).
      this.lastError = String(e);
      if (this.server === srv) this.server = null;
    });
    srv.listen(this.port, HOST);
    this.server = srv;
  }

  stop(): void {
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
 * Every coin as the indexer streams it, kept whole in memory. Emits 'change'
 * (CoinChange) per coin frame and 'tick' after each flush.
 */
export class LiqFeedState extends EventEmitter {
  readonly coins = new Map<string, LiveCoin>();
  ready = false;
  connected = false;
  lastAt = 0;
  private sock: net.Socket | null = null;
  private buf = '';
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private backoff = 1_000;

  constructor(private readonly port = LIQ_FEED_PORT) {
    super();
    this.setMaxListeners(0);
  }

  start(): void {
    this.stopped = false;
    if (!this.sock && !this.timer) this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.sock?.destroy();
    this.sock = null;
  }

  /** Fresh enough to answer from: connected, every book priced in, a frame in the last 10 s. */
  get live(): boolean {
    return this.connected && this.ready && Date.now() - this.lastAt < 10_000;
  }

  private connect(): void {
    this.timer = null;
    const sock = net.connect(this.port, HOST);
    this.sock = sock;
    sock.setEncoding('utf8');
    sock.on('connect', () => {
      this.connected = true;
      this.backoff = 1_000;
      this.coins.clear();
      this.ready = false;
    });
    sock.on('data', (chunk: string) => this.data(chunk));
    const retry = () => {
      if (this.sock !== sock) return;
      this.sock = null;
      this.connected = false;
      this.ready = false;
      this.buf = '';
      // What the old socket left unread belongs to the coins that are cleared on the next connect.
      this.queue = [];
      this.qi = 0;
      if (this.stopped) return;
      this.timer = setTimeout(() => this.connect(), this.backoff);
      this.timer.unref?.();
      this.backoff = Math.min(30_000, this.backoff * 2);
    };
    sock.on('error', () => sock.destroy());
    sock.on('close', retry);
  }

  /**
   * Frames as they arrive (exported for tests). Worked off in FEED_SLICE_MS slices with the socket paused between them
   * (2026-11-08: after any hold of the API thread the indexer's backlog came in as megabytes at once, and this read all
   * of it in one piece, cutting the buffer again for every line - 6.4 s, and the next hold right behind the last).
   */
  data(chunk: string): void {
    mark('liq:feed');
    const s = this.buf + chunk;
    let start = 0;
    let i: number;
    while ((i = s.indexOf('\n', start)) >= 0) {
      if (i > start) this.queue.push(s.slice(start, i));
      start = i + 1;
    }
    this.buf = start ? s.slice(start) : s;
    this.drain();
  }

  private queue: string[] = [];
  private qi = 0;
  private draining = false;

  private drain(): void {
    if (this.draining) return;
    const t0 = performance.now();
    while (this.qi < this.queue.length) {
      const line = this.queue[this.qi++]!;
      let f: { t?: string } & Record<string, unknown>;
      try { f = JSON.parse(line); } catch { continue; }
      if (f.t === 'd') this.apply(f as unknown as LiveDelta);
      else if (f.t === 'tick') {
        this.ready = !!f.ready;
        this.lastAt = Date.now();
        this.emit('tick', Number(f.at) || Date.now());
      }
      if (this.qi < this.queue.length && performance.now() - t0 >= FEED_SLICE_MS) {
        this.draining = true;
        this.sock?.pause();
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
    if (this.sock?.isPaused()) this.sock.resume();
  }

  private apply(d: LiveDelta): void {
    const old = this.coins.get(d.coin);
    // A new layout (or a coin not seen yet): what the browsers hold of it no longer fits.
    const relayout = !old || old.ep !== d.ep;
    const c: LiveCoin = relayout || d.whole ? { p: d.p, st: d.st, ep: d.ep, at: Date.now(), v: d.whole || relayout ? new Map() : old!.v, ...(old?.f && !relayout ? { f: old.f } : {}) } : old!;
    c.p = d.p;
    c.at = Date.now();
    this.coins.set(d.coin, c);
    const venues = new Map<Venue, number[]>();
    const covered = new Set<Venue>();
    for (const [venue, x] of Object.entries(d.v) as Array<[Venue, NonNullable<LiveDelta['v'][Venue]>]>) {
      let v = c.v.get(venue);
      if (!v) { v = { b: new Map(), c: [0, 0, 0, 0, 0, 0, 0, 0], o: [0, 0, 0, 0] }; c.v.set(venue, v); }
      const idx: number[] = [];
      for (const r of x.b) {
        const i = r[0];
        if (!r[3] && !r[4]) v.b.delete(i);
        else v.b.set(i, r.slice(1));
        idx.push(i);
      }
      if (x.c) { v.c = x.c; covered.add(venue); }
      if (x.o) v.o = x.o;
      venues.set(venue, idx);
    }
    // The engine's minute refresh (whole, same layout): tell the readers only what differs from before.
    if (d.whole && !relayout) {
      for (const [venue, idx] of venues) {
        const was = old!.v.get(venue);
        const now = c.v.get(venue)!;
        const diff = new Set<number>();
        for (const i of idx) { const p = was?.b.get(i); const q = now.b.get(i); if (!p || !q || p.length !== q.length || p.some((y, k) => y !== q[k])) diff.add(i); }
        for (const i of was?.b.keys() ?? []) if (!now.b.has(i)) diff.add(i);
        venues.set(venue, [...diff]);
        if (was && was.c.every((y, k) => y === now.c[k])) covered.delete(venue);
      }
      for (const [venue, was] of old!.v) {
        if (c.v.has(venue)) continue;
        venues.set(venue, [...was.b.keys()]);
        covered.add(venue);
      }
    }
    const fine = d.f ? this.applyFine(c, d.f) : undefined;
    this.emit('change', { coin: d.coin, whole: relayout, venues, covered, ...(fine ? { fine } : {}) } satisfies CoinChange);
  }

  /** The fine layer's part of a frame: a new layout of it replaces what is held. */
  private applyFine(c: LiveCoin, f: NonNullable<LiveDelta['f']>): NonNullable<CoinChange['fine']> {
    const whole = f.whole || !c.f || c.f.ep !== f.ep;
    if (whole) c.f = { st: f.st, lo: f.lo, hi: f.hi, ep: f.ep, v: new Map() };
    const held = c.f!;
    const venues = new Map<Venue, number[]>();
    for (const [venue, rows] of Object.entries(f.v) as Array<[Venue, LiqRow[]]>) {
      let m = held.v.get(venue);
      if (!m) { m = new Map(); held.v.set(venue, m); }
      const idx: number[] = [];
      for (const r of rows) {
        if (!r[3] && !r[4]) m.delete(r[0]);
        else m.set(r[0], r.slice(1));
        idx.push(r[0]);
      }
      venues.set(venue, idx);
    }
    return { whole, venues };
  }
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

/**
 * A VENUE'S OWN RECENT TRADES, COMPARED WITH WHAT IS HELD. Whatever loses a print (a frozen socket, a restart, a reconnect),
 * this adds it back while the venue still serves it. What differs per venue is a source (sodexCatchup.ts, arcusCatchup.ts):
 * how a market's rows are read, and whether older ones can be asked for.
 *
 * It adds only what is missing: what counts as held is the venue's `add`, through the stream's own Dedup and the who-traded
 * chunks. Activity and who traded take every print together, so what the chunk holds they hold. One market is read per tick.
 *
 * Two kinds of venue. One that serves only its newest rows (SoDEX) is read at half its reach. One that serves any time
 * (`windows`, Arcus) is read from where the last read got to, pages back as far as it takes, and remembers that across restarts.
 *
 * The reads run on a worker thread of their own. On the indexer's thread a read takes several turns of a loop that can
 * lag 14 s: measured 2026-11-06 12:12-12:22 UTC, 5 reads done and 23 timed out at 15 s, so BTC's 11 minutes passed unread.
 */
import { Worker } from 'node:worker_threads';
import { NET } from '../config.js';
import type { Print, SodexWsTrade } from './streams.js';

export const CATCHUP_LIMIT = 500;
const MIN_EVERY_MS = 3 * 60_000;
const MAX_EVERY_MS = 30 * 60_000;
const SYMBOLS_EVERY_MS = 60 * 60_000;
/** A read that failed is tried again soon: what it was after may be leaving the venue's reach. */
const RETRY_MS = 30_000;
const LIMITED_MS = 5 * 60_000;
/** Newer rows are the stream's to deliver: they are looked at on the next read. */
const STREAM_FIRST_MS = 20_000;
/** A windowed read starts this far before the last one's end: a row can reach the venue's list a little late. */
const OVERLAP_MS = 2 * 60_000;

type Engine = 'perps' | 'spot';
interface SodexRow extends SodexWsTrade { t?: number; T?: number }

export type ReadTrades = (engine: Engine, symbol: string) => Promise<{ rows: SodexRow[]; limited?: boolean }>;

const READER_CODE = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', async ({ id, url, field }) => {
  try {
    const sentAt = Date.now();
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const gotAt = Date.now();
    if (!res.ok) { parentPort.postMessage({ id, status: res.status, sentAt, gotAt }); return; }
    const j = await res.json();
    parentPort.postMessage({ id, status: res.status, data: j[field], sentAt, gotAt });
  } catch (e) {
    const why = e && e.cause && (e.cause.code || e.cause.message);
    parentPort.postMessage({ id, error: String(e && e.message || e) + (why ? ': ' + why : '') });
  }
});
`;
/** How long the indexer's thread waits for an answer: the worker's own 15 s, plus what this thread may lag. */
const ANSWER_MS = 90_000;

/** A read's answer: `sentAt` and `gotAt` are the reader thread's own clock, so this thread's lag is not in them. */
export interface RestAnswer { status: number; data?: unknown; sentAt?: number; gotAt?: number }

/** GET on the reader's thread; its JSON's `field` (SoDEX wraps everything in `data`) comes back here. */
export class RestReader {
  private worker: Worker | null = null;
  private seq = 0;
  private waiting = new Map<number, { ok: (v: RestAnswer) => void; no: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly base = NET.restBase) {}

  private thread(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(READER_CODE, { eval: true, execArgv: [] });
    w.unref();
    w.on('message', (m: { id: number; status?: number; data?: unknown; error?: string; sentAt?: number; gotAt?: number }) => {
      const r = this.waiting.get(m.id);
      if (!r) return;
      this.waiting.delete(m.id);
      clearTimeout(r.timer);
      if (m.error) r.no(new Error(m.error));
      else r.ok({ status: m.status ?? 0, data: m.data, sentAt: m.sentAt, gotAt: m.gotAt });
    });
    const gone = (why: string) => {
      if (this.worker === w) this.worker = null;
      for (const r of this.waiting.values()) { clearTimeout(r.timer); r.no(new Error(why)); }
      this.waiting.clear();
    };
    w.on('error', (e) => gone(String(e)));
    w.on('exit', () => gone('reader stopped'));
    this.worker = w;
    return w;
  }

  get(path: string, field = 'data'): Promise<RestAnswer> {
    return new Promise((ok, no) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this.waiting.delete(id); no(new Error('no answer from the reader')); }, ANSWER_MS);
      timer.unref?.();
      this.waiting.set(id, { ok, no, timer });
      this.thread().postMessage({ id, url: `${this.base}${path}`, field });
    });
  }

  stop(): void {
    void this.worker?.terminate();
    this.worker = null;
  }

  readTrades: ReadTrades = async (engine, symbol) => {
    const { status, data } = await this.get(`/api/v1/${engine}/markets/${encodeURIComponent(symbol)}/trades?limit=${CATCHUP_LIMIT}`);
    if (status === 429) return { rows: [], limited: true };
    if (status !== 200) throw new Error(`HTTP ${status}`);
    return { rows: Array.isArray(data) ? (data as SodexRow[]) : [] };
  };

  /** 5-minute candles, newest first as SoDEX sends them (flow/ledger.ts). */
  klines = async (engine: Engine, symbol: string, q: { limit: number; startTime?: number; endTime?: number }): Promise<{ rows: Array<{ t: number; n?: unknown; v?: unknown; q?: unknown }>; limited?: boolean }> => {
    const when = `${q.startTime !== undefined ? `&startTime=${q.startTime}` : ''}${q.endTime !== undefined ? `&endTime=${q.endTime}` : ''}`;
    const { status, data } = await this.get(`/api/v1/${engine}/markets/${encodeURIComponent(symbol)}/klines?interval=5m&limit=${q.limit}${when}`);
    if (status === 429) return { rows: [], limited: true };
    if (status !== 200) throw new Error(`HTTP ${status}`);
    return { rows: Array.isArray(data) ? (data as Array<{ t: number }>) : [] };
  };

  symbols = async (engine: Engine): Promise<string[]> => {
    const { status, data } = await this.get(`/api/v1/${engine}/markets/symbols`);
    if (status !== 200) throw new Error(`HTTP ${status}`);
    const list = Array.isArray(data) ? data : ((data as { symbols?: unknown[] } | undefined)?.symbols ?? []);
    return (list as Array<{ symbol?: string; name?: string }>).flatMap((m) => {
      const n = m.symbol ?? m.name;
      return typeof n === 'string' && n ? [n] : [];
    });
  };
}

/** What differs per venue. Times in ms. */
export interface CatchupSource<R> {
  /** For the log, and as the venue calls itself. */
  name: string;
  title: string;
  /** Rows a read can answer: this many back means there may be more. */
  limit: number;
  tickMs: number;
  /** Every market's key. */
  markets(): Promise<string[]>;
  /** The market's newest rows, within [from, to] where the venue serves windows. */
  read(key: string, w: { from?: number; to?: number }): Promise<{ rows: R[]; limited?: boolean }>;
  at(r: R): number | undefined;
  /** An id that runs without a hole per market, where the venue has one: rows sort by it and what fell out of reach is counted. */
  seq?(r: R): number | undefined;
  label?(key: string): string;
  /** The venue answers any time window: read from where the last read got to, nothing goes out of reach. */
  windows?: {
    /** A market first seen starts this far back. */
    firstBackMs: number;
    /** How far each market has been read, kept across restarts. */
    load(): Record<string, number>;
    save(through: Record<string, number>): void;
  };
}

interface Market {
  key: string;
  nextAt: number;
  newest?: number;
  /** Windows: everything before this was read. */
  through?: number;
  /** Windows: the page being walked back from, and the newest row of the walk's first page. */
  walkTo?: number;
  walkTop?: number;
}

/** A stream break the catch-up is asked to answer for: the prints of [from, to]. */
interface Watch { from: number; to: number; deadline: number; left: Set<string> | null; failed: boolean }
export type WatchState = 'covered' | 'lost' | 'waiting';
/** How long a break waits for its answer: a full round of the markets takes about 5 minutes. */
export const WATCH_MS = 15 * 60_000;

export class TradeCatchup<R> {
  private markets = new Map<string, Market>();
  private watches = new Map<string, Watch>();
  private timer?: NodeJS.Timeout;
  private busy = false;
  private limitedUntil = 0;
  private symbolsAt = -Infinity;
  private stats = { reads: 0, added: 0, beyondReach: 0, errors: 0, lastAddedAt: 0, lastError: null as string | null };
  private saved: Record<string, number> | null = null;

  constructor(
    private readonly src: CatchupSource<R>,
    private readonly add: (rows: R[]) => Print[],
    private readonly log: (line: string) => void,
    protected readonly now: () => number = Date.now,
  ) {}

  start(): void {
    this.timer = setInterval(() => { void this.tick(); }, this.src.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  status(): { markets: number; reads: number; added: number; beyondReach: number; errors: number; lastAddedAt: number; lastError: string | null } {
    return { markets: this.markets.size, ...this.stats };
  }

  /**
   * Whether every print of [from, to] is held: every market read after `to` with a reach back to `from`. A market read after
   * the break that cannot show back to `from` has lost that part: 'lost', and the break stands. The first ask starts the
   * watch. `to` is when the stream was back, so what came after it is the stream's own.
   */
  watch(from: number, to: number): WatchState {
    const key = `${from}|${to}`;
    let w = this.watches.get(key);
    if (!w) this.watches.set(key, (w = { from, to, deadline: this.now() + WATCH_MS, left: null, failed: false }));
    if (!w.left && this.markets.size) w.left = new Set(this.markets.keys());
    if (w.failed) return 'lost';
    if (w.left && !w.left.size) return 'covered';
    return this.now() > w.deadline ? 'lost' : 'waiting';
  }

  forget(from: number, to: number): void {
    this.watches.delete(`${from}|${to}`);
  }

  private noteReach(key: string, readAt: number, oldest: number): void {
    for (const w of this.watches.values()) {
      if (!w.left && this.markets.size) w.left = new Set(this.markets.keys());
      // Rows newer than STREAM_FIRST_MS are not added by this read, so a read this close to `to` proves nothing yet.
      if (!w.left?.has(key) || readAt - STREAM_FIRST_MS < w.to) continue;
      if (oldest <= w.from) w.left.delete(key);
      else w.failed = true;
    }
  }

  /** One step. Public for tests. */
  async tick(): Promise<void> {
    const now = this.now();
    if (this.busy || now < this.limitedUntil) return;
    this.busy = true;
    try {
      if (now - this.symbolsAt >= SYMBOLS_EVERY_MS) await this.refreshMarkets(now);
      let due: Market | null = null;
      for (const m of this.markets.values()) if (m.nextAt <= now && (!due || m.nextAt < due.nextAt)) due = m;
      if (due) await this.readOne(due);
    } catch (e) {
      this.stats.errors++;
      this.stats.lastError = String((e as Error)?.message ?? e).slice(0, 160);
    } finally {
      this.busy = false;
    }
  }

  private async refreshMarkets(now: number): Promise<void> {
    this.symbolsAt = now;
    const win = this.src.windows;
    if (win && !this.saved) this.saved = win.load();
    for (const key of await this.src.markets()) {
      if (this.markets.has(key)) continue;
      this.markets.set(key, { key, nextAt: now, ...(win ? { through: this.saved?.[key] ?? now - win.firstBackMs } : {}) });
    }
  }

  private async readOne(m: Market): Promise<void> {
    const src = this.src;
    const now = this.now();
    // Whatever happens, this market waits its turn: one that fails does not hold up the others.
    m.nextAt = now + RETRY_MS;
    const windows = !!src.windows;
    const from = windows ? m.through! - OVERLAP_MS : undefined;
    const { rows, limited } = await src.read(m.key, { ...(from !== undefined ? { from } : {}), ...(m.walkTo !== undefined ? { to: m.walkTo } : {}) });
    if (limited) {
      this.limitedUntil = now + LIMITED_MS;
      this.stats.lastError = `${src.title} said 429`;
      return;
    }
    this.stats.reads++;
    const order = src.seq ?? src.at;
    const sorted = rows.filter((r) => typeof src.at(r) === 'number' && typeof order(r) === 'number').sort((a, b) => order(a)! - order(b)!);
    m.nextAt = now + MIN_EVERY_MS;
    const label = src.label?.(m.key) ?? m.key;
    if (!sorted.length) {
      this.noteReach(m.key, now, -Infinity);
      if (windows) this.walked(m, now, m.walkTop);
      m.nextAt = now + MAX_EVERY_MS;
      return;
    }
    const oldest = sorted[0]!;
    const newest = sorted[sorted.length - 1]!;
    if (src.seq) {
      // Ids run without a hole per market, so what fell out of reach since the last read can be counted.
      const a = src.seq(oldest)!;
      if (m.newest !== undefined && a > m.newest + 1) {
        this.stats.beyondReach += a - m.newest - 1;
        this.log(`${src.name} catch-up: ${label}: ${a - m.newest - 1} trades went out of ${src.title}'s reach before they were read`);
      }
      m.newest = src.seq(newest)!;
    }
    const added = this.add(sorted.filter((r) => now - src.at(r)! >= STREAM_FIRST_MS));
    if (added.length) {
      this.stats.added += added.length;
      this.stats.lastAddedAt = now;
      this.log(`${src.name} catch-up: ${label}: added ${added.length} of ${sorted.length} (the oldest ${Math.round((now - added[0]!.t) / 60_000)} min old)`);
    }
    const full = sorted.length >= src.limit;
    const oldestAt = src.at(oldest)!;
    const newestAt = src.at(newest)!;
    // Fewer rows than the limit: the venue showed all it has. `add` throws if it could not tell what is held, so this is not reached then.
    this.noteReach(m.key, now, full ? oldestAt : -Infinity);
    if (windows) {
      if (full && oldestAt > from!) {
        // More to read before this page: the next turn walks back from its oldest row. A millisecond holding a whole page ends the walk.
        if (m.walkTo === undefined || oldestAt < m.walkTo) {
          m.walkTop ??= newestAt;
          m.walkTo = oldestAt;
          m.nextAt = now;
          return;
        }
        this.log(`${src.name} catch-up: ${label}: a full page within one millisecond at ${oldestAt}, not read past it`);
      }
      const walkedBack = m.walkTop !== undefined;
      this.walked(m, now, m.walkTop ?? newestAt);
      if (walkedBack) return;
      // Whatever came since the last read tells how fast this market fills a page: half of that, as on a venue with a reach.
      const spanMs = now - from!;
      m.nextAt = now + Math.max(MIN_EVERY_MS, Math.min(MAX_EVERY_MS, (src.limit / sorted.length) * spanMs / 2));
      return;
    }
    const reach = full ? newestAt - oldestAt : Infinity;
    m.nextAt = now + Math.max(MIN_EVERY_MS, Math.min(MAX_EVERY_MS, reach / 2));
  }

  /** A walk is done: everything up to its newest row is read, short of what is still the stream's. */
  private walked(m: Market, now: number, top: number | undefined): void {
    m.walkTo = undefined;
    m.walkTop = undefined;
    if (top === undefined) return;
    const through = Math.min(top, now - STREAM_FIRST_MS);
    if (through <= m.through!) return;
    m.through = through;
    const all: Record<string, number> = {};
    for (const x of this.markets.values()) if (x.through !== undefined) all[x.key] = x.through;
    this.src.windows!.save(all);
  }
}

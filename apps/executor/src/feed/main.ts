/**
 * valuescan-feed: the box's ONE holder of the Binance sockets. It writes every SoDEX perp's Binance USD-M best bid /
 * ask into the shared ring (ring.ts) for every process on the box that quotes off Binance - the executor's
 * Binance-led maker (algo/bots.ts, kind 'mm' with ref 'binance'), the beta executor, a test tool.
 *
 * Its own process on purpose (the trading box's lesson, FEED_SHM.md: "make the shared feed not depending on <the
 * bot> being online"): the executor's restarts never take the feed down, and a reader whose producer is down for
 * longer than 2 s opens its own socket until it is back (reference.ts).
 *
 * Holds no key and places nothing. Public market data only: GET fapi.binance.com/fapi/v1/exchangeInfo, the SoDEX
 * gateway's perps symbol list, and wss://fstream.binance.com bookTicker streams (two raced copies).
 *
 *   FEED_PATH     the ring (default /run/valuescan-feed/binance-l1; the unit's RuntimeDirectory)
 *   FEED_COPIES   raced sockets per group of symbols (default 2)
 *   FEED_SYMBOLS  comma-separated SoDEX markets to carry (default: every SoDEX perp Binance lists)
 *   FEED_ON_DEMAND=1  carry only the markets the box's readers want (demand.ts; the VIP box): no sockets and no
 *                 traffic while none does, a market's sockets within about a second of a reader wanting it
 *   FEED_WANT_DIR the want directory (default <FEED_PATH>.want)
 *
 * Every market: the universe is read once at start; a market listed later is carried after the next restart (a new
 * file). On demand: the lists are read again every hour, and at most once a minute for a wanted market they lack.
 *
 * ON DEMAND (owner 2026-11-13: the VIP box's feed read 155-245 GB a day, billed as AWS regional transfer, with no bot
 * there quoting off Binance - "make sure the VIP feed self starts fast if a bot is starting"). The wanted set is read
 * on every change of the want directory (a reader writes its file the moment a bot starts) and every second. A change
 * builds the new set's sockets BESIDE the running ones, waits until they are up (at most UP_WAIT_MS), then writes a
 * new ring (each market's newest quote carried into its latest table) and renames it into place - readers follow a
 * new file by themselves - and only then closes the old sockets: a reader of the markets already carried sees no gap.
 * A market leaves LINGER_MS after its last want; the last one leaving removes the ring file (a reader then opens its
 * own socket at once, as for any missing feed).
 */
import { chmodSync, mkdirSync, rmSync, watch, type FSWatcher } from 'node:fs';
import { dirname } from 'node:path';
import { GATEWAY_ORIGIN } from '../../../../packages/sodex-core/src/index.ts';
import type { Logger, WebSocketFactory } from '../../../../packages/copy-engine/src/io.ts';
import { BinanceBooks, binancePerps, plainSockets, type BookTick } from './binance.ts';
import { carryNow, pidAlive, readDemand, wantDirOf } from './demand.ts';
import { DEFAULT_FEED_PATH, RingWriter, type RingSymbol } from './ring.ts';
/** Feed ids are positions in this table (the ring's feed names). */
export const FEEDS = ['binance_fut'] as const;

const log: Logger = (() => {
  const out = (level: string) => (msg: string, data?: Record<string, unknown>) =>
    (level === 'warn' || level === 'error' ? process.stderr : process.stdout).write(JSON.stringify({ t: new Date().toISOString(), level, msg, ...(data ?? {}) }) + '\n');
  return { debug: () => {}, info: out('info'), warn: out('warn'), error: out('error') };
})();

/** SoDEX market -> Binance symbol, for the markets both list: ETH-USD -> ETHUSDT. */
export function universe(sodex: readonly string[], binance: ReadonlyMap<string, string>, only: readonly string[] | null): RingSymbol[] {
  const out: RingSymbol[] = [];
  for (const market of sodex) {
    if (only && !only.includes(market)) continue;
    const m = /^([A-Z0-9]+)-USD$/.exec(market);
    const venue = m ? binance.get(m[1]!) : undefined;
    if (venue) out.push({ market, venue });
  }
  return out.sort((a, b) => a.market.localeCompare(b.market));
}

async function sodexPerps(): Promise<string[]> {
  const r = await fetch(`${GATEWAY_ORIGIN.mainnet}/api/v1/perps/markets/symbols`);
  if (!r.ok) throw new Error(`SoDEX symbols: HTTP ${r.status}`);
  const j = (await r.json()) as { data?: Array<{ symbol?: string; name?: string; status?: string }> };
  return (j.data ?? []).map((s) => s.symbol ?? s.name ?? '').filter((s) => s.endsWith('-USD'));
}

/** A rebuild waits this long for its new sockets before it swaps anyway (the heartbeat waits for them regardless). */
export const UP_WAIT_MS = 5_000;
/** The SoDEX and Binance market lists, read again this often in on-demand mode... */
export const LISTS_MAX_AGE_MS = 60 * 60_000;
/** ...and at most this often for a wanted market they lack (or after a failed read). */
export const LISTS_RETRY_MS = 60_000;

export interface OnDemandOptions {
  path: string;
  wantDir: string;
  copies: number;
  /** FEED_SYMBOLS: never more than these. */
  only: readonly string[] | null;
  factory: WebSocketFactory;
  lists: () => Promise<{ sodex: string[]; binance: Map<string, string> }>;
  log: Logger;
  now?: () => number;
  alive?: (pid: number) => boolean;
  upWaitMs?: number;
}

const waitFor = async (ok: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  return true;
};

/** The feed in on-demand mode (see the head comment). */
export class OnDemandFeed {
  private books: BinanceBooks | null = null;
  private ring: RingWriter | null = null;
  private ids = new Map<string, number>();
  /** The markets carried now, joined (the key a new want set is compared with). */
  carried = '';
  private readonly lastWant = new Map<string, number>();
  /** Each Binance symbol's newest tick from either set of sockets (carried into a new ring). */
  private readonly lastTick = new Map<string, BookTick>();
  private lists: { sodex: string[]; binance: Map<string, string> } | null = null;
  private listsAt = 0;
  private listsTriedAt = -Infinity;
  private busy: Promise<void> | null = null;
  private again = false;
  private watcher: FSWatcher | null = null;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private soonTimer: ReturnType<typeof setTimeout> | null = null;
  readonly stats = { written: 0, same: 0, rebuilds: 0, readers: 0 };

  constructor(private readonly o: OnDemandOptions) {}

  private now(): number {
    return this.o.now ? this.o.now() : Date.now();
  }

  /** The want directory (mode 1777), its watch, the 1 s re-read, the heartbeat and the stats line. */
  start(): void {
    mkdirSync(this.o.wantDir, { recursive: true });
    chmodSync(this.o.wantDir, 0o1777);
    try {
      this.watcher = watch(this.o.wantDir, () => this.soon());
    } catch (e) {
      this.o.log.warn('feed: the want directory cannot be watched - read every second only', { error: String(e) });
    }
    this.timers.push(setInterval(() => void this.evaluate(), 1_000));
    // The heartbeat only while every carried market's stream is connected (the same rule as in every-market mode).
    this.timers.push(setInterval(() => {
      if (this.ring && this.books?.allUp) this.ring.beat();
    }, 100));
    this.timers.push(setInterval(() => {
      const b = this.books;
      this.o.log.info('feed', { mode: 'on-demand', markets: this.carried || '-', readers: this.stats.readers, written: this.stats.written, sizeOnly: this.stats.same, raced: b?.dropped ?? 0, won: b?.won ?? [], up: b?.up ?? false, head: Number(this.ring?.published ?? 0n) });
      this.stats.written = this.stats.same = 0;
    }, 60_000));
    void this.evaluate();
  }

  stop(): void {
    this.watcher?.close();
    for (const t of this.timers) clearInterval(t);
    if (this.soonTimer) clearTimeout(this.soonTimer);
    this.timers = [];
    this.books?.stop();
    this.ring?.close();
    this.books = null;
    this.ring = null;
  }

  private soon(): void {
    if (this.soonTimer) return;
    this.soonTimer = setTimeout(() => {
      this.soonTimer = null;
      void this.evaluate();
    }, 20);
  }

  /** Read the wants and carry what they add up to. One at a time: a call during a rebuild runs once more after it. */
  evaluate(): Promise<void> {
    if (this.busy) {
      this.again = true;
      return this.busy;
    }
    this.busy = (async () => {
      do {
        this.again = false;
        try {
          await this.step();
        } catch (e) {
          this.o.log.error('feed: on-demand step failed', { error: String(e) });
        }
      } while (this.again);
    })().finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  private async step(): Promise<void> {
    const now = this.now();
    const d = readDemand(this.o.wantDir, now, this.o.alive ?? pidAlive);
    this.stats.readers = d.readers;
    const want = carryNow(d.markets, this.lastWant, now).filter((m) => !this.o.only || this.o.only.includes(m));
    const symbols = await this.universeOf(want, now);
    const key = symbols.map((s) => s.market).join(',');
    if (key !== this.carried) await this.rebuild(symbols, key);
  }

  private async universeOf(want: string[], now: number): Promise<RingSymbol[]> {
    if (!want.length) return [];
    let symbols = this.lists ? universe(this.lists.sodex, this.lists.binance, want) : [];
    const old = !this.lists || now - this.listsAt >= LISTS_MAX_AGE_MS;
    const lacking = symbols.length < want.length;
    if ((old || lacking) && now - this.listsTriedAt >= LISTS_RETRY_MS) {
      this.listsTriedAt = now;
      try {
        this.lists = await this.o.lists();
        this.listsAt = now;
        symbols = universe(this.lists.sodex, this.lists.binance, want);
      } catch (e) {
        this.o.log.warn('feed: the market lists could not be read', { error: String(e) });
      }
    }
    return symbols;
  }

  private async rebuild(symbols: RingSymbol[], key: string): Promise<void> {
    this.stats.rebuilds++;
    if (!symbols.length) {
      this.books?.stop();
      this.ring?.close();
      this.books = null;
      this.ring = null;
      this.ids = new Map();
      this.lastTick.clear();
      this.carried = '';
      rmSync(this.o.path, { force: true });
      this.o.log.info('feed idle: no reader wants a market - no sockets', {});
      return;
    }
    const t0 = Date.now();
    const next: BinanceBooks = new BinanceBooks({
      factory: this.o.factory,
      symbols: symbols.map((s) => s.venue),
      copies: this.o.copies,
      log: this.o.log,
      onTick: (t) => this.tick(next, t),
    });
    next.start();
    const up = await waitFor(() => next.allUp, this.o.upWaitMs ?? UP_WAIT_MS);
    const ring = new RingWriter(this.o.path, FEEDS, symbols);
    const ids = new Map(symbols.map((s, i) => [s.venue, i]));
    // Each market's newest quote into the new file's latest table: a still market has its price there at once.
    for (const [venue, id] of ids) {
      const t = this.lastTick.get(venue);
      if (t) ring.publish(0, id, t.bid, t.ask, t.bidSz, t.askSz, t.eventMs, t.update, t.rxNs);
    }
    const oldBooks = this.books;
    const oldRing = this.ring;
    this.books = next;
    this.ring = ring;
    this.ids = ids;
    this.carried = key;
    oldBooks?.stop();
    oldRing?.close();
    for (const venue of [...this.lastTick.keys()]) if (!ids.has(venue)) this.lastTick.delete(venue);
    if (up) ring.beat();
    this.o.log.info('feed carries', { markets: key, copies: this.o.copies, ms: Date.now() - t0, up });
  }

  /** A tick from either set of sockets: kept as the newest; into the ring only from the set the ring is for. */
  private tick(from: BinanceBooks, t: BookTick): void {
    const last = this.lastTick.get(t.symbol);
    if (!last || t.update > last.update) this.lastTick.set(t.symbol, t);
    if (from !== this.books || !this.ring) return;
    const id = this.ids.get(t.symbol);
    if (id === undefined) return;
    if (this.ring.publish(0, id, t.bid, t.ask, t.bidSz, t.askSz, t.eventMs, t.update, t.rxNs)) this.stats.written++;
    else this.stats.same++;
  }
}

async function main(): Promise<void> {
  const path = process.env.FEED_PATH || DEFAULT_FEED_PATH;
  const copies = Math.max(1, Math.min(4, Number(process.env.FEED_COPIES) || 2));
  const only = process.env.FEED_SYMBOLS ? process.env.FEED_SYMBOLS.split(',').map((s) => s.trim()).filter(Boolean) : null;
  if (process.env.FEED_ON_DEMAND === '1') {
    mkdirSync(dirname(path), { recursive: true });
    const wantDir = process.env.FEED_WANT_DIR || wantDirOf(path);
    const feed = new OnDemandFeed({
      path,
      wantDir,
      copies,
      only,
      factory: plainSockets,
      lists: async () => {
        const [sodex, binance] = await Promise.all([sodexPerps(), binancePerps((u) => fetch(u))]);
        return { sodex, binance };
      },
      log,
    });
    feed.start();
    log.info('feed up (on demand)', { path, wantDir, copies, only: only?.join(',') ?? 'any' });
    const stop = () => {
      feed.stop();
      process.exit(0);
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    return;
  }
  const [sodex, binance] = await Promise.all([sodexPerps(), binancePerps((u) => fetch(u))]);
  const symbols = universe(sodex, binance, only);
  if (!symbols.length) throw new Error('no market both SoDEX and Binance list');
  mkdirSync(dirname(path), { recursive: true });
  const ring = new RingWriter(path, FEEDS, symbols);
  const ids = new Map(symbols.map((s, i) => [s.venue, i]));
  let written = 0;
  let same = 0;
  const books = new BinanceBooks({
    factory: plainSockets,
    symbols: symbols.map((s) => s.venue),
    copies,
    log,
    onTick: (t) => {
      const id = ids.get(t.symbol);
      if (id === undefined) return;
      if (ring.publish(0, id, t.bid, t.ask, t.bidSz, t.askSz, t.eventMs, t.update, t.rxNs)) written++;
      else same++;
    },
  });
  books.start();
  // The heartbeat only while every symbol's stream is connected (Katana's rule, owner 2026-11-09): a reader then takes
  // a symbol without a tick for a still market, and a silent heartbeat for a feed it cannot trust.
  const beat = setInterval(() => { if (books.allUp) ring.beat(); }, 100);
  const stats = setInterval(() => {
    log.info('feed', { symbols: symbols.length, written, sizeOnly: same, raced: books.dropped, won: books.won, up: books.up, head: Number(ring.published) });
    written = same = 0;
  }, 60_000);
  log.info('feed up', { path, symbols: symbols.length, copies, markets: symbols.map((s) => s.market).join(',') });
  const stop = () => {
    clearInterval(beat);
    clearInterval(stats);
    books.stop();
    ring.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

// Run as the unit's entry (src/feed/main.ts, or a bundle named feed-main.mjs); imported (tests) it only exports.
if (/feed[\/-]main\.[cm]?[jt]s$/.test(process.argv[1] ?? '')) {
  main().catch((e) => {
    log.error('feed failed to start', { error: String(e) });
    process.exit(1);
  });
}

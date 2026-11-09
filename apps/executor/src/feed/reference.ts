/**
 * The executor's Binance reference (the engine's ReferenceSource, copy-engine algo/reference.ts) for the Binance-led
 * maker: the box's shared feed (ring.ts, written by valuescan-feed), read every POLL_MS - and, while that feed is
 * missing or silent, the executor's own Binance sockets for the markets it watches, until the feed is back.
 *
 * The trading box's rules for a reader of its feed (FEED_SHM.md), kept:
 *   - keep your own connection as the fallback: a producer silent for FALLBACK_AFTER_MS -> own sockets up;
 *     back for RETURN_AFTER_MS -> they close and the ring takes over again;
 *   - a restarted producer writes a NEW file: the path is looked at again every second and opened anew;
 *   - a market the feed does not carry is served by the own sockets only.
 *
 * A STILL market (owner 2026-11-09, MCD): Binance pushes a book tick only when the book changes, so a quiet market -
 * a stock perpetual outside US hours - sends nothing for many seconds while its price is perfectly good, and the
 * engine's 2 s freshness rule (REF_MAX_AGE_MS) held the bot "waiting for the Binance price" for as long as it stayed
 * still. Now a watched market silent for CONFIRM_AFTER_MS is confirmed by one REST read of Binance's book
 * (fapi bookTicker, weight 2), at most CONFIRM_MAX markets a round, every CONFIRM_EVERY_MS: the answer is the book as
 * it stands, so it counts as fresh when it arrives. No answer (Binance down, blocked): nothing is refreshed and the
 * bot holds as before - a dead feed still never quotes.
 */
import { existsSync } from 'node:fs';
import type { Logger, WebSocketFactory } from '../../../../packages/copy-engine/src/io.ts';
import type { RefQuote, ReferenceSource } from '../../../../packages/copy-engine/src/algo/reference.ts';
import { BinanceBooks } from './binance.ts';
import { RingReader, monoNs } from './ring.ts';

export const POLL_MS = 2;
export const FALLBACK_AFTER_MS = 500;
export const RETURN_AFTER_MS = 3_000;
/**
 * Confirm a market silent this long, looking every CONFIRM_EVERY_MS: a still book is confirmed every ~0.6-0.85 s, well
 * inside the engine's 2 s limit (at 1.2 s / 1 s the confirm often came after 2 s: MCD held 312 times an hour, 2026-11-09).
 * One request per market at a time; weight 2 each, so a still market costs ~170 of Binance's 2400 a minute.
 */
export const CONFIRM_AFTER_MS = 600;
/** A market's last price is kept as a still market's after this long without a tick, while its source is connected. */
export const STILL_AFTER_MS = 400;
/** The ring's heartbeat counts as fresh this long (it beats every 100 ms while every stream is up). */
export const STILL_BEAT_MS = 500;
export const CONFIRM_EVERY_MS = 250;
export const CONFIRM_MAX = 6;
export const BINANCE_FAPI = 'https://fapi.binance.com';
type FetchFn = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export interface BinanceReferenceOptions {
  /** The shared ring (feed/main.ts DEFAULT_FEED_PATH). */
  path: string;
  factory: WebSocketFactory;
  log: Logger;
  /** false: no timers (tests call poll). */
  autoPoll?: boolean;
  /** For the REST confirm of a still market (absent: no confirm). */
  fetch?: FetchFn;
}

/** SoDEX market -> Binance USD-M symbol, for the own sockets: ETH-USD -> ETHUSDT. */
export const binanceSymbolOf = (market: string): string | null => {
  const m = /^([A-Z0-9]+)-USD$/.exec(market);
  return m ? `${m[1]}USDT` : null;
};

export class BinanceReference implements ReferenceSource {
  private reader: RingReader | null = null;
  private watched = new Set<string>();
  private quotes = new Map<string, RefQuote>();
  private listeners: Array<(market: string) => void> = [];
  private own: BinanceBooks | null = null;
  private ownFor = '';
  /** The own sockets serve every watched market (the ring is down), not only the ones it lacks. */
  private ownAll = false;
  /** Since when the ring has been alive again (for the return), or null while it is not. */
  private aliveSince: number | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;
  private checker: ReturnType<typeof setInterval> | null = null;
  private confirmer: ReturnType<typeof setInterval> | null = null;
  /** Markets with a confirm on the way (one at a time each). */
  private confirming = new Set<string>();
  /** For the status line: ticks from the ring and from the own sockets. */
  readonly stats = { ring: 0, own: 0, lost: 0, confirmed: 0 };

  constructor(private readonly o: BinanceReferenceOptions) {}

  watch(markets: readonly string[]): void {
    const next = new Set(markets);
    if (next.size === this.watched.size && [...next].every((m) => this.watched.has(m))) return;
    this.watched = next;
    if (next.size && this.o.autoPoll !== false) this.startTimers();
    this.check();
  }

  quote(market: string): RefQuote | null {
    return this.quotes.get(market) ?? null;
  }

  onQuote(cb: (market: string) => void): void {
    this.listeners.push(cb);
  }

  stop(): void {
    if (this.poller) clearInterval(this.poller);
    if (this.checker) clearInterval(this.checker);
    if (this.confirmer) clearInterval(this.confirmer);
    this.poller = this.checker = this.confirmer = null;
    this.own?.stop();
    this.own = null;
    this.reader?.close();
    this.reader = null;
  }

  /** Whether the ring serves the watched markets now (false: the own sockets do, or nothing yet). */
  get onRing(): boolean {
    return this.reader !== null && !this.ownAll;
  }

  private startTimers(): void {
    if (this.poller) return;
    this.poller = setInterval(() => this.poll(), POLL_MS);
    this.checker = setInterval(() => this.check(), 250);
    this.poller.unref?.();
    this.checker.unref?.();
    if (this.o.fetch) {
      this.confirmer = setInterval(() => void this.confirmStill(), CONFIRM_EVERY_MS);
      this.confirmer.unref?.();
    }
  }

  /**
   * Watched markets silent for CONFIRM_AFTER_MS: Binance's book read once by REST, the oldest first, CONFIRM_MAX at
   * most a round (a still market, not a dead feed: see the head comment). One round at a time.
   */
  async confirmStill(now = Date.now()): Promise<number> {
    const f = this.o.fetch;
    if (!f || !this.watched.size) return 0;
    const still = [...this.watched]
      .filter((m) => !this.confirming.has(m))
      .map((m) => ({ m, at: this.quotes.get(m)?.at ?? 0 }))
      .filter((x) => now - x.at >= CONFIRM_AFTER_MS)
      .sort((a, b) => a.at - b.at)
      .slice(0, Math.max(0, CONFIRM_MAX - this.confirming.size));
    if (!still.length) return 0;
    let n = 0;
    await Promise.all(still.map(async ({ m }) => {
        const sym = binanceSymbolOf(m);
        if (!sym) return;
        this.confirming.add(m);
        try {
          const r = await f(`${BINANCE_FAPI}/fapi/v1/ticker/bookTicker?symbol=${sym}`, { signal: AbortSignal.timeout(1_500) });
          if (!r.ok) return;
          const j = (await r.json()) as { bidPrice?: unknown; askPrice?: unknown } | null;
          const bid = Number(j?.bidPrice);
          const ask = Number(j?.askPrice);
          if (!(bid > 0) || !(ask > 0) || ask < bid) return;
          // The same book as last seen: a still market, confirmed now (not a stale feed).
          const prev = this.quotes.get(m);
          const still = !!prev && prev.bid === bid && prev.ask === ask;
          this.set(m, { bid, ask, at: Date.now(), still, ...(still ? { stillSince: prev!.stillSince ?? prev!.at } : {}) });
          this.stats.confirmed++;
          n++;
        } catch {
          /* no answer: the market stays as it was (stale, so the bot holds) */
        } finally {
          this.confirming.delete(m);
        }
      }));
    return n;
  }

  /**
   * A still market, kept as a price (owner 2026-11-09: "STILL getting held waiting for the Binance price - fix this once
   * and for all"; Katana's feed rule): while the source of a market is provably connected - the shared ring's heartbeat
   * is fresh (the producer beats only while every stream is up), or our own socket for it is up - a market that sent
   * no tick did not move. Its last price is confirmed now (`still`, from `stillSince`). Called on every check (250 ms).
   */
  private keepStill(nowMs: number): void {
    const ringLive = !!this.reader && !this.ownAll && this.reader.alive(STILL_BEAT_MS);
    for (const m of this.watched) {
      const q = this.quotes.get(m);
      if (!q || nowMs - q.at < STILL_AFTER_MS) continue;
      const sym = binanceSymbolOf(m);
      const viaRing = ringLive && !!this.reader?.bySymbol.has(m) && !(this.own && this.ownFor.split(',').includes(m));
      const viaOwn = !!this.own && !!sym && this.own.upFor(sym) && this.ownFor.split(',').includes(m);
      if (!viaRing && !viaOwn) continue;
      this.quotes.set(m, { bid: q.bid, ask: q.ask, at: nowMs, still: true, stillSince: q.stillSince ?? q.at });
    }
  }

  /** Every tick the ring has for a watched market, into the quotes (and the listeners). */
  poll(): void {
    const r = this.reader;
    if (!r || !this.watched.size) return;
    let ticks;
    try {
      ticks = r.drain();
    } catch (e) {
      this.o.log.warn('reference: ring read failed', { error: String(e) });
      return;
    }
    if (!ticks.length || this.ownAll) {
      this.stats.lost = Number(r.lost);
      return;
    }
    const nowMs = Date.now();
    const nowNs = monoNs();
    for (const t of ticks) {
      const market = r.symbols[t.symbol]?.market;
      if (!market || t.feed !== 0 || !this.watched.has(market)) continue;
      // The tick's age at the producer's receipt, in wall-clock ms.
      const at = nowMs - Number((nowNs - t.rxNs) / 1_000_000n);
      this.set(market, { bid: t.bid, ask: t.ask, at });
      this.stats.ring++;
    }
  }

  /** The ring's state, every 250 ms: open it, follow a restart, fall back and return. */
  check(): void {
    if (!this.watched.size) {
      if (this.own) this.closeOwn();
      return;
    }
    if (!this.reader && existsSync(this.o.path)) {
      try {
        this.reader = new RingReader(this.o.path);
        this.seed();
        this.o.log.info('reference: on the shared feed', { path: this.o.path, symbols: this.reader.symbols.length });
      } catch (e) {
        this.o.log.warn('reference: shared feed unreadable', { path: this.o.path, error: String(e) });
        this.reader = null;
      }
    } else if (this.reader) {
      try {
        if (this.reader.reopenIfReplaced()) {
          this.seed();
          this.o.log.info('reference: the shared feed restarted', { symbols: this.reader.symbols.length });
        }
      } catch (e) {
        this.o.log.warn('reference: shared feed reopen failed', { error: String(e) });
      }
    }
    this.keepStill(Date.now());
    const alive = this.reader?.alive(FALLBACK_AFTER_MS) ?? false;
    const missing = [...this.watched].filter((m) => !this.reader?.bySymbol.has(m));
    const now = Date.now();
    if (alive) this.aliveSince ??= now;
    else this.aliveSince = null;
    if (!alive || missing.length) {
      // Own sockets: every watched market while the ring is down, only the ones it lacks while it is up.
      this.openOwn(alive ? missing : [...this.watched], !alive);
    } else if (this.own && this.aliveSince !== null && now - this.aliveSince >= RETURN_AFTER_MS) {
      this.closeOwn();
      this.seed();
      this.o.log.info('reference: back on the shared feed');
    }
  }

  /** Every watched market's latest quote from the ring's latest table (on open: no wait for a tick). */
  private seed(): void {
    const r = this.reader;
    if (!r) return;
    const nowMs = Date.now();
    const nowNs = monoNs();
    for (const market of this.watched) {
      const i = r.bySymbol.get(market);
      if (i === undefined) continue;
      const t = r.latest(0, i);
      if (t) this.set(market, { bid: t.bid, ask: t.ask, at: nowMs - Number((nowNs - t.rxNs) / 1_000_000n) });
    }
  }

  private openOwn(markets: readonly string[], all: boolean): void {
    const key = [...markets].sort().join(',');
    this.ownAll = all;
    if (this.own && this.ownFor === key) return;
    this.own?.stop();
    const bySymbol = new Map<string, string>();
    for (const m of markets) {
      const s = binanceSymbolOf(m);
      if (s) bySymbol.set(s, m);
    }
    if (!bySymbol.size) {
      this.own = null;
      this.ownFor = '';
      return;
    }
    this.o.log.warn('reference: own Binance sockets', { markets: key, ring: this.reader ? 'silent or lacking these' : 'missing' });
    this.ownFor = key;
    this.own = new BinanceBooks({
      factory: this.o.factory,
      symbols: [...bySymbol.keys()],
      copies: 1,
      log: this.o.log,
      onTick: (t) => {
        const market = bySymbol.get(t.symbol);
        if (!market) return;
        this.set(market, { bid: t.bid, ask: t.ask, at: Date.now() });
        this.stats.own++;
      },
    });
    this.own.start();
  }

  private closeOwn(): void {
    this.own?.stop();
    this.own = null;
    this.ownFor = '';
    this.ownAll = false;
  }

  private set(market: string, q: RefQuote): void {
    const prev = this.quotes.get(market);
    // Older than what is there is dropped - except over a still market's confirmation (stamped "now" by keepStill or a
    // REST read): a real tick received after the last real one always counts, so no move is ever lost.
    if (prev && prev.at > q.at && !(prev.still && q.at >= (prev.stillSince ?? 0))) return;
    this.quotes.set(market, q);
    for (const cb of this.listeners) cb(market);
  }
}

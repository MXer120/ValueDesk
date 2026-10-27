/**
 * Every coin's liquidation levels, kept current as the books move - the live
 * heatmap's engine (indexer thread / process; cohortTracker.ts feeds it).
 *
 * Each account's positions are priced (math.ts accountLiqs) and added into its
 * coins' buckets; what an account added is remembered, so when the account
 * changes it is taken back out and the new figures go in. An account changes
 *
 *   - when a print moves its book or a read replaces it (`touch`), and
 *   - when the price of ANOTHER of its cross positions moves (`mark`): a cross
 *     position's liquidation price depends on the others' prices, never on its
 *     own market's - so an account holding one position (most of them) is
 *     never re-priced by a price move, and one holding several only when a
 *     price moved by a bucket's width (0.02%) since it was last priced.
 *
 * `flush` (every second) prices the accounts that changed and returns, per coin,
 * the buckets and coverage that changed since the last flush: what the API
 * streams to the browsers. A coin is laid out around its price when first seen
 * (NOW_STEP buckets from NOW_LO to NOW_HI of it); once the price leaves half to
 * twice that, it is laid out again around the new price (a new `ep`och) and sent
 * whole.
 *
 * Whether a level is already past (a long priced above the price, a short below)
 * is left to the reader, at the price of the moment: it moves with every tick.
 */
import type { Venue } from '../types.js';
import { accountLiqs, niceStep, type LiqPos, type Tiers } from './math.js';
import { NOW_HI, NOW_LO, NOW_STEP, liqCoin, type LiqNow } from './levels.js';

/** An account as the engine reads it: its cross cash (null = not priced yet) and positions. */
export interface LiveAccount {
  cash: number | null;
  /** Whether the book carries liquidation data at all (cohortTracker.ts liqKnown): if not, it only counts as held. */
  priced: boolean;
  positions: ReadonlyArray<LiqPos>;
}

/** What one position added: coin, epoch, venue, long, size, then where (bucket index, or -1 outside, -2 not priced) and USD. */
type Entry = { coin: string; ep: number; long: boolean; a: number; at: number; usd: number };

interface VenueAgg {
  /** bucket index -> [long USD, short USD, long n, short n]. */
  b: Map<number, [number, number, number, number]>;
  /** [long size, short size, long size priced, short size priced, positions]. */
  c: [number, number, number, number, number];
  /** Outside the buckets: [long USD, short USD, long n, short n]. */
  o: [number, number, number, number];
}

interface CoinAgg {
  p0: number;
  st: number;
  lo: number;
  hi: number;
  ep: number;
  v: Map<Venue, VenueAgg>;
  /** Changed since the last flush: venue -> bucket indices; venues whose coverage moved. */
  dirtyB: Map<Venue, Set<number>>;
  dirtyC: Set<Venue>;
  /** Sent whole at the next flush (new, or laid out again). */
  whole: boolean;
  /** What was last sent per venue: bucket values, and the coverage (to skip what has not really moved). */
  sent: Map<Venue, { b: Map<number, [number, number, number, number]>; c: string }>;
}

/** One coin's change for the stream: buckets as [index, long USD, short USD, long n, short n] (all zero = gone). */
export interface LiveDelta {
  coin: string;
  /** The coin's price now, the bucket width, the layout's epoch. */
  p: number;
  st: number;
  ep: number;
  /** True: every bucket of the coin is here (a new layout); false: only the changed ones. */
  whole: boolean;
  v: Partial<Record<Venue, { b: Array<[number, number, number, number, number]>; c?: [number, number, number, number, number]; o?: [number, number, number, number] }>>;
}

const MOVE = NOW_STEP;
const round = (x: number) => Math.round(x);

export class LiqLive {
  private coins = new Map<string, CoinAgg>();
  /** venue|address -> what it added. */
  private added = new Map<string, Entry[]>();
  /** venue|symbol -> accounts holding it among several cross positions (re-priced when ANOTHER price moves). */
  private multi = new Map<string, Set<string>>();
  /** coin -> accounts holding it (laid out again with the coin). */
  private holders = new Map<string, Set<string>>();
  /** Symbols per account in `multi`, to take it out again. */
  private multiOf = new Map<string, string[]>();
  private dirty = new Set<string>();
  /** venue|symbol -> the price the accounts holding it were last re-priced at. */
  private pricedAt = new Map<string, number>();
  private epoch = 0;

  constructor(private readonly o: {
    /** The account now (undefined = gone). */
    account: (venue: Venue, address: string) => LiveAccount | undefined;
    priceOf: (venue: Venue, symbol: string) => number | null;
    tiersOf: (venue: Venue, symbol: string) => Tiers | null;
    /** A coin's reference price (Hyperliquid's first). */
    priceOfCoin: (coin: string) => number | null;
    /** The coins kept (the ones SoDEX lists); others are priced as part of an account's margin, never bucketed. */
    wanted?: (coin: string) => boolean;
  }) {}

  /** The account changed (a print, a read): re-priced at the next flush. */
  touch(venue: Venue, address: string): void {
    this.dirty.add(`${venue}|${address}`);
  }

  /** A price: accounts whose other positions depend on it are re-priced once it moved a bucket's width. */
  mark(venue: Venue, symbol: string, px: number): void {
    const k = `${venue}|${symbol}`;
    const set = this.multi.get(k);
    if (!set?.size) return;
    const was = this.pricedAt.get(k);
    if (was !== undefined && Math.abs(px - was) <= MOVE * was) return;
    this.pricedAt.set(k, px);
    for (const a of set) this.dirty.add(a);
  }

  get pending(): number {
    return this.dirty.size;
  }

  /**
   * Price up to `max` changed accounts, and for no longer than `budgetMs`; returns how many are
   * left (oldest first next time). The budget keeps the indexer's one thread for the rest: with
   * ~300k books (2026-10-27) the 5,000 a second took over a third of it and starved the reads.
   */
  work(max = 5_000, budgetMs = Number.POSITIVE_INFINITY): number {
    let n = 0;
    const until = Date.now() + budgetMs;
    for (const key of this.dirty) {
      this.dirty.delete(key);
      this.reprice(key);
      if (++n >= max || ((n & 63) === 0 && Date.now() >= until)) break;
    }
    return this.dirty.size;
  }

  /** The changes since the last flush, per coin (and the coins' prices now). */
  flush(): LiveDelta[] {
    const out: LiveDelta[] = [];
    for (const [coin, c] of this.coins) {
      if (!c.whole && !c.dirtyB.size && !c.dirtyC.size) continue;
      const p = this.o.priceOfCoin(coin) ?? c.p0;
      const d: LiveDelta = { coin, p, st: c.st, ep: c.ep, whole: c.whole, v: {} };
      const venues = c.whole ? [...c.v.keys()] : [...new Set([...c.dirtyB.keys(), ...c.dirtyC])];
      for (const venue of venues) {
        const x = c.v.get(venue);
        if (!x) continue;
        let sent = c.sent.get(venue);
        if (!sent || c.whole) { sent = { b: new Map(), c: '' }; c.sent.set(venue, sent); }
        const idx = c.whole ? [...x.b.keys()] : [...(c.dirtyB.get(venue) ?? [])];
        const b: Array<[number, number, number, number, number]> = [];
        for (const i of idx.sort((m, n) => m - n)) {
          const y = x.b.get(i);
          const was = sent.b.get(i);
          // A bucket whose USD moved less than SEND_MOVE is not sent, whatever its position count did:
          // most changes are a small trade moving a liquidation price within its bucket or into the
          // next (measured on BTC: ~130 buckets a second otherwise). The drift from what was sent stays
          // under SEND_MOVE, the counts (tooltip only) catch up, and the minute's full refresh is exact.
          if (!c.whole && y && was && near(y[0], was[0]) && near(y[1], was[1])) continue;
          if (!y && !was && !c.whole) continue;
          if (y) { sent.b.set(i, [y[0], y[1], y[2], y[3]]); b.push([i, round(y[0]), round(y[1]), y[2], y[3]]); }
          else { sent.b.delete(i); b.push([i, 0, 0, 0, 0]); }
        }
        const e: NonNullable<LiveDelta['v'][Venue]> = { b };
        const cov: [number, number, number, number, number] = [sig(x.c[0]), sig(x.c[1]), sig(x.c[2]), sig(x.c[3]), x.c[4]];
        const ck = cov.join(',');
        if (c.whole || (c.dirtyC.has(venue) && ck !== sent.c)) {
          e.c = cov;
          e.o = [round(x.o[0]), round(x.o[1]), x.o[2], x.o[3]];
          sent.c = ck;
        }
        if (!b.length && !e.c) continue;
        d.v[venue] = e;
      }
      c.dirtyB.clear();
      c.dirtyC.clear();
      const whole = c.whole;
      c.whole = false;
      if (whole || Object.keys(d.v).length) out.push(d);
      // Laid out again around the price once it left half to twice the layout's.
      if (p > 0 && (p < c.p0 * 0.5 || p > c.p0 * 2)) this.relayout(coin);
    }
    return out;
  }

  /** Every coin whole, as liq_now rows (the HTTP fallback and the history snapshots). */
  rows(): Map<string, LiqNow> {
    const out = new Map<string, LiqNow>();
    for (const [coin, c] of this.coins) {
      const v: LiqNow['v'] = {};
      for (const [venue, x] of c.v) {
        if (x.c[4] <= 0) continue; // a venue whose last position here closed
        v[venue] = {
          b: [...x.b].sort((m, n) => m[0] - n[0]).map(([i, y]) => [i, round(y[0]), round(y[1]), y[2], y[3]]),
          c: [sig(x.c[0]), sig(x.c[1]), sig(x.c[2]), sig(x.c[3]), x.c[4], 0],
          o: [round(x.o[0]), round(x.o[1]), x.o[2], x.o[3]],
        };
      }
      out.set(coin, { p: this.o.priceOfCoin(coin) ?? c.p0, st: c.st, v });
    }
    return out;
  }

  /** Coins by the open notional held, largest first. */
  ranked(): string[] {
    const usd = new Map<string, number>();
    for (const [coin, c] of this.coins) {
      let n = 0;
      for (const x of c.v.values()) n += (x.c[0] + x.c[1]) * c.p0;
      usd.set(coin, n);
    }
    return [...usd].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  }

  /** Every coin's layout, as a whole, at the next flush (a new reader). */
  resendAll(): void {
    for (const c of this.coins.values()) c.whole = true;
  }

  private coin(coin: string): CoinAgg | null {
    let c = this.coins.get(coin);
    if (c) return c;
    const p = this.o.priceOfCoin(coin);
    if (!p || !(p > 0)) return null;
    c = { p0: p, st: niceStep(p * NOW_STEP), lo: p * NOW_LO, hi: p * NOW_HI, ep: ++this.epoch, v: new Map(), dirtyB: new Map(), dirtyC: new Set(), whole: true, sent: new Map() };
    this.coins.set(coin, c);
    return c;
  }

  /** A new layout around the price now: every holder is priced into it again. */
  private relayout(coin: string): void {
    this.coins.delete(coin);
    for (const a of this.holders.get(coin) ?? []) this.dirty.add(a);
  }

  private apply(venue: Venue, e: Entry, sign: 1 | -1): void {
    const c = this.coins.get(e.coin);
    if (!c || c.ep !== e.ep) return; // laid out again since: nothing of it is in the new layout
    let x = c.v.get(venue);
    if (!x) { x = { b: new Map(), c: [0, 0, 0, 0, 0], o: [0, 0, 0, 0] }; c.v.set(venue, x); }
    const L = e.long;
    x.c[L ? 0 : 1] += sign * e.a;
    x.c[4] += sign;
    c.dirtyC.add(venue);
    if (e.at === -2) return;
    x.c[L ? 2 : 3] += sign * e.a;
    if (e.at === -1) {
      x.o[L ? 0 : 1] += sign * e.usd;
      x.o[L ? 2 : 3] += sign;
      return;
    }
    let b = x.b.get(e.at);
    if (!b) { b = [0, 0, 0, 0]; x.b.set(e.at, b); }
    b[L ? 0 : 1] += sign * e.usd;
    b[L ? 2 : 3] += sign;
    if (b[2] <= 0 && b[3] <= 0) x.b.delete(e.at);
    let s = c.dirtyB.get(venue);
    if (!s) { s = new Set(); c.dirtyB.set(venue, s); }
    s.add(e.at);
  }

  private reprice(key: string): void {
    const i = key.indexOf('|');
    const venue = key.slice(0, i) as Venue;
    const address = key.slice(i + 1);
    for (const e of this.added.get(key) ?? []) this.apply(venue, e, -1);
    this.added.delete(key);
    for (const s of this.multiOf.get(key) ?? []) this.multi.get(s)?.delete(key);
    this.multiOf.delete(key);
    const acct = this.o.account(venue, address);
    const ps = acct?.positions.filter((p) => p.szi) ?? [];
    if (!acct || !ps.length) {
      for (const set of this.holders.values()) set.delete(key);
      return;
    }
    const liq = acct.priced ? accountLiqs(acct.cash, ps, (s) => this.o.priceOf(venue, s), (s) => this.o.tiersOf(venue, s)) : ps.map(() => null);
    const entries: Entry[] = [];
    ps.forEach((p, j) => {
      const coinName = liqCoin(p.symbol);
      if (this.o.wanted && !this.o.wanted(coinName)) return;
      const c = this.coin(coinName);
      if (!c) return;
      let h = this.holders.get(coinName);
      if (!h) { h = new Set(); this.holders.set(coinName, h); }
      h.add(key);
      const l = liq[j] ?? null;
      const a = Math.abs(p.szi);
      const at = l === null || !(l > 0) ? -2 : l < c.lo || l >= c.hi ? -1 : Math.floor(l / c.st);
      const e: Entry = { coin: coinName, ep: c.ep, long: p.szi > 0, a, at, usd: l ? a * l : 0 };
      this.apply(venue, e, 1);
      entries.push(e);
    });
    this.added.set(key, entries);
    // Re-priced when another of its cross positions' prices moves.
    const cross = acct.priced ? ps.filter((p) => p.iso === undefined && p.fix == null) : [];
    if (cross.length >= 2) {
      const syms = cross.map((p) => `${venue}|${p.symbol}`);
      for (const s of syms) {
        let set = this.multi.get(s);
        if (!set) { set = new Set(); this.multi.set(s, set); }
        set.add(key);
      }
      this.multiOf.set(key, syms);
    }
  }
}

const sig = (x: number) => +x.toPrecision(6);
/** A bucket is sent again once its USD moved this much (1%, or its positions changed). */
const SEND_MOVE = 0.01;
const near = (a: number, b: number) => Math.abs(a - b) <= SEND_MOVE * Math.max(Math.abs(a), Math.abs(b), 1);

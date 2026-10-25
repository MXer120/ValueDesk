/**
 * Liquidation levels of one coin: every tracked position's liquidation price
 * (math.ts accountLiqs over the books), summed into price buckets.
 *
 * Long positions liquidate below the price, shorts above. A level's notional is
 * the size at its liquidation price (Hyperdash's "361.68 SKHX @ 654.15 = $236.6K").
 * The indexer writes every coin's buckets a minute apart (LevelsBuilder -> liq_now)
 * and every 15 minutes a snapshot for the historical view (liq_hist); the API
 * serves those rows, and reads the books itself only for a bucket's wallets
 * (coinLevels, from the cohort load).
 */
import type { Venue } from '../types.js';
import { coinOf } from '../cohorts/model.js';

/**
 * Markets that are the same thing under another name across venues, at the same
 * price (checked 2026-10-25): Hyperliquid's and Arcus's k-prefixed thousand-unit
 * memecoins, and the index and gold perps SoDEX lists under its own names.
 */
const ALIAS: Readonly<Record<string, string>> = {
  KPEPE: '1000PEPE', KSHIB: '1000SHIB', KBONK: '1000BONK', KFLOKI: '1000FLOKI',
  XYZ100: 'USTECH100', US100: 'USTECH100',
  SP500: 'US500',
  GOLD: 'XAUT', XAU: 'XAUT',
};

/** The coin a market's liquidations count under (cohorts/model.ts coinOf, then the aliases). */
export function liqCoin(symbol: string): string {
  const c = coinOf(symbol);
  return ALIAS[c] ?? c;
}
import { accountLiqs, niceStep, type LiqPos, type Tiers } from './math.js';

/** One position with its liquidation price (null = none, or not known). */
export interface LevelPos {
  venue: Venue;
  address: string;
  symbol: string;
  szi: number;
  liq: number | null;
}

export interface AccountIn {
  cash?: number | null;
  positions: readonly LiqPos[] | null;
}

/**
 * The positions in `coin` of one venue's accounts, with their liquidation prices.
 * The account's other coins count (cross margin), so every position of an
 * account holding the coin is priced.
 */
export function* coinLevels(
  venue: Venue,
  accounts: Iterable<[string, AccountIn]>,
  coin: string,
  priceOf: (symbol: string) => number | null,
  tiersFor: (symbol: string) => Tiers | null,
): Generator<LevelPos> {
  for (const [address, a] of accounts) {
    const ps = a.positions;
    if (!ps?.length || !ps.some((p) => liqCoin(p.symbol) === coin)) continue;
    const liq = accountLiqs(a.cash ?? null, ps, priceOf, tiersFor);
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i]!;
      if (liqCoin(p.symbol) === coin && p.szi) yield { venue, address, symbol: p.symbol, szi: p.szi, liq: liq[i] ?? null };
    }
  }
}

/** Every position of a venue's accounts with its liquidation price, one call each (the snapshots: no list is kept). */
export function eachLevel(
  venue: Venue,
  accounts: Iterable<[string, AccountIn]>,
  priceOf: (symbol: string) => number | null,
  tiersFor: (symbol: string) => Tiers | null,
  on: (coin: string, szi: number, liq: number | null, px: number | null) => void,
): void {
  for (const [, a] of accounts) {
    const ps = a.positions;
    if (!ps?.length) continue;
    const liq = accountLiqs(a.cash ?? null, ps, priceOf, tiersFor);
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i]!;
      if (p.szi) on(liqCoin(p.symbol), p.szi, liq[i] ?? null, priceOf(p.symbol));
    }
  }
}

/** One bucket: [low price, long USD, short USD, long size, short size, long positions, short positions]. */
export type Bucket = [number, number, number, number, number, number, number];

/**
 * Sum levels into buckets of `step` from `lo` to `hi`; what lies outside is
 * counted apart. Index i covers [i·step, (i+1)·step).
 */
export function bucketize(levels: Iterable<LevelPos>, step: number, lo: number, hi: number): {
  buckets: Bucket[];
  outside: { long: number; short: number; longN: number; shortN: number };
} {
  const by = new Map<number, Bucket>();
  const outside = { long: 0, short: 0, longN: 0, shortN: 0 };
  for (const l of levels) {
    if (l.liq === null || !(l.liq > 0)) continue;
    const usd = Math.abs(l.szi) * l.liq;
    const long = l.szi > 0;
    if (l.liq < lo || l.liq >= hi) {
      if (long) { outside.long += usd; outside.longN++; } else { outside.short += usd; outside.shortN++; }
      continue;
    }
    const i = Math.floor(l.liq / step);
    let b = by.get(i);
    if (!b) { b = [i * step, 0, 0, 0, 0, 0, 0]; by.set(i, b); }
    if (long) { b[1] += usd; b[3] += l.szi; b[5]++; } else { b[2] += usd; b[4] -= l.szi; b[6]++; }
  }
  return { buckets: [...by.values()].sort((a, b) => a[0] - b[0]), outside };
}

// --- snapshots (liq_hist) -----------------------------------------------------------------

/** A snapshot's bucket width, as a share of the price then. */
export const HIST_STEP = 0.0025;
/** A snapshot keeps levels within this share of the price either side. */
export const HIST_SPAN = 0.4;

/** One coin's snapshot: price, step, and per venue [bucket index, long USD, short USD]. */
export interface LiqSnap {
  p: number;
  st: number;
  v: Partial<Record<Venue, Array<[number, number, number]>>>;
}


// --- every coin, every minute (liq_now) ----------------------------------------------------

/**
 * The indexer's buckets: this share of the price (BTC at $80K: $20). The web
 * groups them by what is on screen - finer zoomed in or on a short timeframe,
 * coarser zoomed out - so they are kept as fine as a screen ever needs.
 */
export const NOW_STEP = 0.0002;
/** Levels between these shares of the price are bucketed; the rest is counted as outside. */
export const NOW_LO = 0.2;
export const NOW_HI = 3;

/** One coin's levels on one venue: buckets, what the books hold, what lies outside. */
export interface LiqNowVenue {
  /** [bucket index, long USD, short USD, long n, short n] (sizes are USD / price within the 0.02% bucket). */
  b: Array<[number, number, number, number, number]>;
  /**
   * [long size, short size, long size priced, short size priced, positions, past]:
   * `past` is the size whose liquidation price the price has already crossed (a long
   * priced above it, a short below) - being liquidated, or a book a print has not
   * reached yet. It is counted here and left out of the buckets.
   */
  c: [number, number, number, number, number, number];
  /** Outside the buckets: [long USD, short USD, long n, short n]. */
  o: [number, number, number, number];
}

/** One coin's levels on every venue, as the indexer writes them a minute apart (liq_now). */
export interface LiqNow {
  /** The coin's price and the bucket width. */
  p: number;
  st: number;
  v: Partial<Record<Venue, LiqNowVenue>>;
}

const sig = (x: number) => +x.toPrecision(6);

/**
 * Every coin's levels in one pass over the books (eachLevel feeds `add`):
 * buckets only, so memory stays bounded however many positions pass, and the
 * snapshots for the historical view come out of the same rows.
 */
export class LevelsBuilder {
  private coins = new Map<string, {
    p: number; st: number; lo: number; hi: number; usd: number;
    v: Map<Venue, { b: Map<number, number[]>; c: number[]; o: number[] }>;
  } | null>();

  constructor(private readonly priceOfCoin: (coin: string) => number | null) {}

  /** One position: `px` is its own venue's price now (whether the price has crossed its liquidation). */
  add(venue: Venue, coin: string, szi: number, liq: number | null, px: number | null): void {
    let c = this.coins.get(coin);
    if (c === undefined) {
      const p = this.priceOfCoin(coin);
      c = p && p > 0 ? { p, st: niceStep(p * NOW_STEP), lo: p * NOW_LO, hi: p * NOW_HI, usd: 0, v: new Map() } : null;
      this.coins.set(coin, c);
    }
    if (!c) return;
    const a = Math.abs(szi);
    c.usd += a * c.p;
    let v = c.v.get(venue);
    if (!v) { v = { b: new Map(), c: [0, 0, 0, 0, 0, 0], o: [0, 0, 0, 0] }; c.v.set(venue, v); }
    const long = szi > 0;
    v.c[long ? 0 : 1]! += a;
    v.c[4]!++;
    if (liq === null || !(liq > 0)) return;
    v.c[long ? 2 : 3]! += a;
    if (px !== null && (long ? liq >= px : liq <= px)) { v.c[5]! += a; return; }
    if (liq < c.lo || liq >= c.hi) {
      v.o[long ? 0 : 1]! += a * liq;
      v.o[long ? 2 : 3]!++;
      return;
    }
    const i = Math.floor(liq / c.st);
    let b = v.b.get(i);
    if (!b) { b = [0, 0, 0, 0]; v.b.set(i, b); }
    if (long) { b[0]! += a * liq; b[2]!++; } else { b[1]! += a * liq; b[3]!++; }
  }

  /** Every coin with a price, as written to liq_now. */
  rows(): Map<string, LiqNow> {
    const out = new Map<string, LiqNow>();
    for (const [coin, c] of this.coins) {
      if (!c) continue;
      const v: LiqNow['v'] = {};
      for (const [venue, x] of c.v) {
        v[venue] = {
          b: [...x.b].sort((a, b) => a[0] - b[0]).map(([i, b]) => [i, Math.round(b[0]!), Math.round(b[1]!), b[2]!, b[3]!]),
          c: [sig(x.c[0]!), sig(x.c[1]!), sig(x.c[2]!), sig(x.c[3]!), x.c[4]!, sig(x.c[5]!)],
          o: [Math.round(x.o[0]!), Math.round(x.o[1]!), x.o[2]!, x.o[3]!],
        };
      }
      out.set(coin, { p: c.p, st: c.st, v });
    }
    return out;
  }

  /** Coins by the open notional tracked, largest first. */
  ranked(): string[] {
    return [...this.coins].flatMap(([coin, c]) => (c ? [[coin, c.usd] as const] : [])).sort((a, b) => b[1] - a[1]).map(([coin]) => coin);
  }
}

/** A snapshot for the historical view from a coin's minute row: HIST_STEP buckets within HIST_SPAN of the price. */
export function snapOfNow(row: LiqNow): LiqSnap {
  const st = niceStep(row.p * HIST_STEP);
  const lo = row.p * (1 - HIST_SPAN);
  const hi = row.p * (1 + HIST_SPAN);
  const v: LiqSnap['v'] = {};
  for (const [venue, x] of Object.entries(row.v) as Array<[Venue, LiqNowVenue]>) {
    const m = new Map<number, [number, number]>();
    for (const [i, l, s] of x.b) {
      const px = (i + 0.5) * row.st;
      if (px < lo || px >= hi) continue;
      const j = Math.floor(px / st);
      const b = m.get(j) ?? [0, 0];
      b[0] += l;
      b[1] += s;
      m.set(j, b);
    }
    if (m.size) v[venue] = [...m].sort((a, b) => a[0] - b[0]).map(([j, [l, s]]) => [j, l, s]);
  }
  return { p: row.p, st, v };
}

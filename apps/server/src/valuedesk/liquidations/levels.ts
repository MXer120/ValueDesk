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
import { LEV_BANDS, accountLevs, accountLiqs, levBand, niceStep, type LevBand, type LiqPos, type Tiers } from './math.js';

/** One position with its liquidation price (null = none, or not known). */
export interface LevelPos {
  venue: Venue;
  address: string;
  symbol: string;
  szi: number;
  liq: number | null;
  /** `liq` null because no liquidation price exists (the venue says so, or the account carries it to zero), not because it is not known. */
  none?: boolean;
  /** The leverage it runs at (math.ts accountLevs; null = not known, Infinity = no margin left). */
  lev?: number | null;
}

export interface AccountIn {
  cash?: number | null;
  /** The read's account value: the cross equity where the cash is not known (math.ts accountLevs). */
  equity?: number | null;
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
    const none: boolean[] = [];
    const liq = accountLiqs(a.cash ?? null, ps, priceOf, tiersFor, none);
    const lev = accountLevs(a.cash ?? null, a.equity, ps, priceOf);
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i]!;
      if (liqCoin(p.symbol) === coin && p.szi) yield { venue, address, symbol: p.symbol, szi: p.szi, liq: liq[i] ?? null, ...(none[i] ? { none: true } : {}), lev: lev[i] ?? null };
    }
  }
}

/** Every position of a venue's accounts with its liquidation price, one call each (the snapshots: no list is kept). */
export function eachLevel(
  venue: Venue,
  accounts: Iterable<[string, AccountIn]>,
  priceOf: (symbol: string) => number | null,
  tiersFor: (symbol: string) => Tiers | null,
  on: (coin: string, szi: number, liq: number | null, px: number | null, lev: number | null) => void,
): void {
  for (const [, a] of accounts) {
    const ps = a.positions;
    if (!ps?.length) continue;
    const liq = accountLiqs(a.cash ?? null, ps, priceOf, tiersFor);
    const lev = accountLevs(a.cash ?? null, a.equity, ps, priceOf);
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i]!;
      if (p.szi) on(liqCoin(p.symbol), p.szi, liq[i] ?? null, priceOf(p.symbol), lev[i] ?? null);
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

// --- rows with leverage bands --------------------------------------------------------------

/**
 * A bucket row as liq_now, the feed, the stream and the API carry it: [bucket index, long USD,
 * short USD, long n, short n] and, from 2026-10-31, the USD in each leverage band (math.ts
 * levBand): long low, mid, high, then short low, mid, high. Trailing zeros are left off
 * (trimRow), so a row with no leverage known is the old five. What a side's bands leave of it
 * is of unknown leverage: a row from an older indexer, or a position whose margin is not
 * known. That keeps every sum exact over rows of any length (addRow: a missing field is 0),
 * and a reader that takes the first five reads them as before.
 */
export type LiqRow = [number, number, number, number, number, ...number[]];
/** Where a band's USD sits in a LiqRow. */
export const rowBand = (long: boolean, band: LevBand): number => (long ? 5 : 8) + band;
/**
 * A snapshot row (liq_hist, the history API): [bucket index, long USD, short USD], then the
 * bands as in LiqRow (long low, mid, high, short low, mid, high), trailing zeros left off.
 */
export type SnapRow = [number, number, number, ...number[]];
export const snapBand = (long: boolean, band: LevBand): number => (long ? 3 : 6) + band;

/** Add `y` into `x` from field 1 on (the index stays); fields past either's end count as 0. */
export function addRow(x: number[], y: ArrayLike<number>): void {
  for (let k = 1; k < y.length; k++) x[k] = (x[k] ?? 0) + (y[k] ?? 0);
}

/** A row with its trailing zeros left off, never shorter than `min` (5: LiqRow, 3: SnapRow). */
export function trimRow<T extends number[]>(r: T, min = 5): T {
  let n = r.length;
  while (n > min && !r[n - 1]) n--;
  return (n === r.length ? r : r.slice(0, n)) as T;
}

// --- snapshots (liq_hist) -----------------------------------------------------------------

/** Levels between these shares of the price are kept (NOW_LO / NOW_HI, declared before the snapshots use them). */
const NOW_LO_SHARE = 0.2;
const NOW_HI_SHARE = 3;

/**
 * A snapshot's bucket width, as a share of the price then: BTC near $80K in $100 rows. 0.0025
 * ($200) until 2026-10-31 (owner: "instead 200usd ranges on btc 100 per default"); older
 * snapshots keep their own `st` and the web draws each at its own. Cost, measured on the 101
 * coins of the laptop index's newest snapshot re-bucketed both ways: 864 KB -> 1,077 KB a
 * snapshot (1.25x; BTC 1.47x), about +20 MB of row text a day at 96 snapshots - most far
 * levels are one position a row at either width. Finer than this comes from the books on
 * demand (liqRead.ts liqHeatmapFine), never from history.
 */
export const HIST_STEP = 0.00125;
/**
 * A snapshot keeps the levels the minute rows keep: NOW_LO to NOW_HI times the price. Until
 * 2026-10-31 only 0.6x-1.4x, so Historical zoomed out ran out of levels where Live still had them
 * (owner: "as far as one zoomed out it just ended"). Far levels are few: the rows stay sparse.
 */
export const HIST_LO = NOW_LO_SHARE;
export const HIST_HI = NOW_HI_SHARE;

/** One coin's snapshot: price, step, and per venue its rows (SnapRow: [bucket index, long USD, short USD, ...bands from 2026-10-31]). */
export interface LiqSnap {
  p: number;
  st: number;
  v: Partial<Record<Venue, SnapRow[]>>;
}



// --- every coin, every minute (liq_now) ----------------------------------------------------

/**
 * The indexer's buckets: this share of the price (BTC at $80K: $20). The web
 * groups them by what is on screen - finer zoomed in or on a short timeframe,
 * coarser zoomed out - so they are kept as fine as a screen ever needs.
 */
export const NOW_STEP = 0.0002;
/**
 * The fine route and stream (liqRead.ts liqHeatmapFine, routes/liqWs.ts): buckets in one
 * window at most. The step picked holds however far the view is zoomed out (owner 2026-11-01:
 * "the selected granularity ... sometimes still switching to $100"): an answer costs one pass
 * over the coin's positions and carries only buckets with levels, whatever the window's width;
 * this only bounds a window asked - BTC at $1 from 0 to $1M.
 */
export const FINE_MAX_BUCKETS = 1_000_000;
/** Levels between these shares of the price are bucketed; the rest is counted as outside. */
export const NOW_LO = NOW_LO_SHARE;
export const NOW_HI = NOW_HI_SHARE;

/** One coin's levels on one venue: buckets, what the books hold, what lies outside. */
export interface LiqNowVenue {
  /** LiqRow: [bucket index, long USD, short USD, long n, short n, ...USD per leverage band] (sizes are USD / price within the 0.02% bucket). */
  b: LiqRow[];
  /**
   * [long size, short size, long size priced, short size priced, positions, past, long none, short none]:
   * `past` is the size whose liquidation price the price has already crossed (a long
   * priced above it, a short below) - being liquidated, or a book a print has not
   * reached yet. It is counted here and left out of the buckets (the live engine
   * writes 0 and leaves it to the reader: liqRead.ts heatOf). `none`: size for which
   * no liquidation price exists (rows before 2026-10-30 end at `past`).
   */
  c: [number, number, number, number, number, number, number, number];
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

  /** One position: `px` is its own venue's price now (whether the price has crossed its liquidation); `lev` its leverage (null: not known). */
  add(venue: Venue, coin: string, szi: number, liq: number | null, px: number | null, lev: number | null = null): void {
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
    if (!b) { b = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; v.b.set(i, b); }
    if (long) { b[0]! += a * liq; b[2]!++; } else { b[1]! += a * liq; b[3]!++; }
    // The row's fields less its index: a band at rowBand - 1.
    const band = levBand(lev);
    if (band !== null) b[rowBand(long, band) - 1]! += a * liq;
  }

  /** Every coin with a price, as written to liq_now. */
  rows(): Map<string, LiqNow> {
    const out = new Map<string, LiqNow>();
    for (const [coin, c] of this.coins) {
      if (!c) continue;
      const v: LiqNow['v'] = {};
      for (const [venue, x] of c.v) {
        v[venue] = {
          b: [...x.b].sort((a, b) => a[0] - b[0]).map(([i, b]) => trimRow<LiqRow>([i, Math.round(b[0]!), Math.round(b[1]!), b[2]!, b[3]!, ...b.slice(4).map(Math.round)])),
          c: [sig(x.c[0]!), sig(x.c[1]!), sig(x.c[2]!), sig(x.c[3]!), x.c[4]!, sig(x.c[5]!), 0, 0],
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

/** A snapshot for the historical view from a coin's minute row: HIST_STEP buckets (`share` of the price) from HIST_LO to HIST_HI times the price. */
export function snapOfNow(row: LiqNow, share = HIST_STEP): LiqSnap {
  const st = niceStep(row.p * share);
  const lo = row.p * HIST_LO;
  const hi = row.p * HIST_HI;
  const v: LiqSnap['v'] = {};
  for (const [venue, x] of Object.entries(row.v) as Array<[Venue, LiqNowVenue]>) {
    const m = new Map<number, number[]>();
    for (const r of x.b) {
      const i = r[0];
      const px = (i + 0.5) * row.st;
      if (px < lo || px >= hi) continue;
      // Past levels (the price has crossed them) are not kept: a long priced above the price, a short below.
      const keepL = i * row.st < row.p;
      const keepS = (i + 1) * row.st > row.p;
      const l = keepL ? r[1] : 0;
      const s = keepS ? r[2] : 0;
      if (!l && !s) continue;
      const j = Math.floor(px / st);
      let b = m.get(j);
      if (!b) { b = [j, 0, 0, 0, 0, 0, 0, 0, 0]; m.set(j, b); }
      b[1]! += l;
      b[2]! += s;
      for (const band of LEV_BANDS) {
        if (keepL) b[snapBand(true, band)]! += r[rowBand(true, band)] ?? 0;
        if (keepS) b[snapBand(false, band)]! += r[rowBand(false, band)] ?? 0;
      }
    }
    if (m.size) v[venue] = [...m.values()].sort((a, b) => a[0]! - b[0]!).map((b) => trimRow(b as SnapRow, 3));
  }
  return { p: row.p, st, v };
}

// --- the history's fine layers (liq_hist_fine) ----------------------------------------------

/**
 * Finer than a snapshot's step (owner 2026-11-01: "historical view supports $10 & $1 resolution",
 * then "want full min tick stored for full range"): with each snapshot, its levels at a tenth of
 * its step and at the coin's SoDEX tick (the finest the view offers, web liqSteps.ts stepLadder),
 * over the snapshot's whole range (NOW_LO-NOW_HI of the price). Kept per price band
 * (fineBands, liq_hist_fine_band) so a window reads only its bands.
 *
 * Exact: the live engine's level of every position as its account was last priced (live.ts),
 * not its 0.02% bucket. The change log (liq_log) cannot stand in: it writes a level again only
 * once it moved 0.05% (BTC ~$39), and replaying it for a $1 window read 0.6-18 s of rows on
 * production (2026-11-01, BTC: 400-590k rows a day). Measured on production the same evening
 * over the 101 coins' open positions: the tenth 855 KB and the hundredth 1,002 KB a step deflated
 * (the earlier +-12.5% / +-2.5% layers: 268 KB), about 180 MB a day at a snapshot every 15 min.
 */
export function fineHistSteps(st: number, tick: number): number[] {
  if (!(st > 0)) return [];
  const t = tick > 0 && Number.isFinite(tick) ? tidy(Math.min(tick, st)) : tidy(st / 100);
  const out: number[] = [];
  const tenth = tidy(st / 10);
  if (tenth > t * (1 + 1e-9)) out.push(tenth);
  if (t < st * (1 - 1e-9)) out.push(t);
  return out;
}

/** One fine layer of a snapshot: its step, the price range it covers, and per venue its rows (SnapRow). */
export interface FineLayer {
  st: number;
  lo: number;
  hi: number;
  v: Partial<Record<Venue, SnapRow[]>>;
}
/** A snapshot's fine layers, finest last (liq_hist_fine, deflated JSON). */
export interface FineSnap {
  p: number;
  L: FineLayer[];
}

/** A position as the fine layers read it (live.ts LivePosition): band -1 is not known. */
export interface FinePos { venue: Venue; long: boolean; liq: number; usd: number; band: number }

const tidy = (x: number) => +x.toPrecision(12);

/**
 * A coin's fine layers at price `p` with snapshot step `st` (snapOfNow's) and SoDEX tick `tick`
 * (fineHistSteps), over NOW_LO-NOW_HI of the price: levels the price has crossed are left out, as
 * in the snapshot. Null when no position lies in any layer.
 */
export function fineSnapOf(p: number, st: number, positions: Iterable<FinePos>, tick = 0): FineSnap | null {
  if (!(p > 0) || !(st > 0)) return null;
  const layers = fineHistSteps(st, tick).map((s) => ({ st: s, i0: Math.floor((p * NOW_LO) / s), i1: Math.ceil((p * NOW_HI) / s), m: new Map<Venue, Map<number, number[]>>() }));
  let any = false;
  for (const x of positions) {
    if (!(x.liq > 0) || !(x.usd > 0)) continue;
    if (x.long ? x.liq >= p : x.liq <= p) continue;
    for (const L of layers) {
      const i = Math.floor(x.liq / L.st);
      if (i < L.i0 || i >= L.i1) continue;
      let v = L.m.get(x.venue);
      if (!v) { v = new Map(); L.m.set(x.venue, v); }
      let b = v.get(i);
      if (!b) { b = [i, 0, 0, 0, 0, 0, 0, 0, 0]; v.set(i, b); }
      b[x.long ? 1 : 2]! += x.usd;
      if (x.band >= 0 && x.band <= 2) b[snapBand(x.long, x.band as LevBand)]! += x.usd;
      any = true;
    }
  }
  if (!any) return null;
  return {
    p,
    L: layers.map((L) => {
      const v: FineLayer['v'] = {};
      for (const [venue, m] of L.m) v[venue] = [...m.values()].sort((a, b) => a[0]! - b[0]!).map((b) => trimRow(b.map(Math.round) as SnapRow, 3));
      return { st: L.st, lo: tidy(L.i0 * L.st), hi: tidy(L.i1 * L.st), v };
    }),
  };
}

/** The width of a fine band: the largest 1, 2 or 5 x 10^n at most FINE_BAND_SHARE of the price (BTC near $78K: $20,000). */
export const FINE_BAND_SHARE = 0.32;
export function fineBandWidth(p: number): number {
  if (!(p > 0) || !Number.isFinite(p)) return 0;
  const raw = p * FINE_BAND_SHARE;
  const base = 10 ** Math.floor(Math.log10(raw));
  const f = raw / base;
  return tidy((f >= 5 ? 5 : f >= 2 ? 2 : 1) * base);
}

/**
 * A snapshot's fine layers cut into bands of width `w` (rows by their low edge), every band the
 * layers reach - an empty one too, so the bands read for a window cover it without a gap - each
 * with its layers clipped to it: put back together by mergeFine.
 */
export function fineBands(f: FineSnap, w: number): Array<{ lo: number; hi: number; f: FineSnap }> {
  if (!(w > 0) || !f.L.length) return [];
  const lo0 = Math.min(...f.L.map((L) => L.lo));
  const hi0 = Math.max(...f.L.map((L) => L.hi));
  const out: Array<{ lo: number; hi: number; f: FineSnap }> = [];
  for (let k = Math.floor(lo0 / w + 1e-9); k * w < hi0 - 1e-9 * w; k++) {
    const blo = k * w;
    const bhi = (k + 1) * w;
    const L = f.L.map((x): FineLayer => {
      const v: FineLayer['v'] = {};
      for (const [venue, rows] of Object.entries(x.v) as Array<[Venue, SnapRow[]]>) {
        const inBand = rows.filter((r) => Math.floor((r[0] * x.st) / w + 1e-9) === k);
        if (inBand.length) v[venue] = inBand;
      }
      return { st: x.st, lo: tidy(Math.max(x.lo, blo)), hi: tidy(Math.min(x.hi, bhi)), v };
    }).filter((x) => x.hi > x.lo);
    if (L.length) out.push({ lo: tidy(Math.max(lo0, blo)), hi: tidy(Math.min(hi0, bhi)), f: { p: f.p, L } });
  }
  return out;
}

/** Bands of one snapshot (fineBands, any order) put back together: per step, the rows joined and the range from the lowest to the highest. */
export function mergeFine(parts: readonly FineSnap[]): FineSnap | null {
  if (!parts.length) return null;
  if (parts.length === 1) return parts[0]!;
  const by = new Map<number, FineLayer>();
  for (const part of parts) {
    for (const x of part.L) {
      const L = by.get(x.st);
      if (!L) { by.set(x.st, { st: x.st, lo: x.lo, hi: x.hi, v: Object.fromEntries(Object.entries(x.v).map(([k, r]) => [k, [...r!]])) }); continue; }
      L.lo = Math.min(L.lo, x.lo);
      L.hi = Math.max(L.hi, x.hi);
      for (const [venue, rows] of Object.entries(x.v) as Array<[Venue, SnapRow[]]>) (L.v[venue] ??= []).push(...rows);
    }
  }
  const L = [...by.values()].sort((a, b) => b.st - a.st);
  for (const x of L) for (const rows of Object.values(x.v)) rows!.sort((a, b) => a[0] - b[0]);
  return { p: parts[0]!.p, L };
}

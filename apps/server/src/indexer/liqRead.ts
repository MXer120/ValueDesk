/**
 * The liquidation heatmap's reads (API thread): one coin's levels across the
 * chosen venues, the wallets in a price range, and the levels over time.
 *
 * The positions are the cohort books (cohortTracker.ts), as the cohort load
 * holds them (read.ts cohortBooksNow), and their liquidation prices come from
 * liquidations/math.ts at the last prices. Coverage is said, not assumed: per
 * venue, the size the books hold against the venue's own open interest, how
 * much of it has a known liquidation price, and how the math has matched the
 * venue's figures at reads and re-reads (the tracker's DriftStats).
 */
import type { Venue } from '../valuescan/types.js';
import { coinOf, type WalletVenue } from '../valuescan/cohorts/model.js';
import { RESOLUTION, emptyDrift, niceStep, type DriftStats, type Resolution, type Tiers } from '../valuescan/liquidations/math.js';
import { bucketize, coinLevels, type Bucket, type LevelPos, type LiqSnap } from '../valuescan/liquidations/levels.js';
import { venueMarkets, type VenueMarkets } from '../valuescan/liquidations/rules.js';
import { shownLabel } from '../valuescan/labels.js';
import { cohortBooksNow } from './read.js';
import { reader } from './reader.js';
import { LIQ_ACC_META } from './cohortTracker.js';

/** Levels kept between these shares of the price (the rest is counted as outside). */
const LO = 0.2;
const HI = 3;
const PRICE_ORDER: readonly Venue[] = ['hyperliquid', 'tradexyz', 'lighter', 'sodex', 'arcus'];

export interface VenueCoverage {
  /** Open interest the venue reports for the coin, in coins (one side), and in USD at its price. */
  oi: number | null;
  oiUsd: number | null;
  /** Size the books hold, long and short, in coins. */
  long: number;
  short: number;
  /** Of that, the size with a known liquidation price. */
  longKnown: number;
  shortKnown: number;
  positions: number;
  wallets: number;
  price: number | null;
  /** The math against the venue's figures (null when the venue publishes none: Arcus). */
  accuracy: (DriftStats & { window: 'today' | 'yesterday' }) | null;
  /** The venue publishes no liquidation price: the figures are computed from its margin rules. */
  computed: boolean;
  /** No market list (margin rules) could be read: levels unknown. */
  noRules?: boolean;
}

export interface LiqHeatmap {
  coin: string;
  venues: Venue[];
  resolution: Resolution;
  /** When the books were last written, and when the load was read. */
  at: number;
  price: number | null;
  step: number;
  /** [low price, long USD, short USD, long size, short size, long n, short n]. */
  buckets: Bucket[];
  outside: { long: number; short: number; longN: number; shortN: number };
  coverage: Partial<Record<Venue, VenueCoverage>>;
}

export interface LiqWallet {
  venue: Venue;
  address: string;
  label: string | null;
  szi: number;
  liq: number;
  usd: number;
  /** Liquidation price against the price now (-0.31 = 31% below). */
  dist: number | null;
}

export interface LiqWallets {
  coin: string;
  side: 'long' | 'short';
  from: number;
  to: number;
  price: number | null;
  total: number;
  count: number;
  wallets: LiqWallet[];
}

export interface LiqHistory {
  coin: string;
  venues: Venue[];
  /** Snapshots: time, price, step, [bucket index, long USD, short USD] summed over the venues. */
  points: Array<{ t: number; p: number; st: number; b: Array<[number, number, number]> }>;
  /** Coins with snapshots (the most open notional tracked). */
  coins: string[];
}

type Load = NonNullable<ReturnType<typeof cohortBooksNow>>;

/** Per load: coin -> venue -> the wallets holding it (built once a minute, on the first ask). */
let index: { at: number; by: Map<string, Map<Venue, Array<[string, WalletVenue]>>> } | null = null;

function coinIndex(load: Load): Map<string, Map<Venue, Array<[string, WalletVenue]>>> {
  if (index?.at === load.at) return index.by;
  const by = new Map<string, Map<Venue, Array<[string, WalletVenue]>>>();
  for (const [venue, wallets] of load.per) {
    for (const [address, w] of wallets) {
      if (!w.positions?.length) continue;
      const seen = new Set<string>();
      for (const p of w.positions) {
        const c = coinOf(p.symbol);
        if (seen.has(c)) continue;
        seen.add(c);
        let v = by.get(c);
        if (!v) { v = new Map(); by.set(c, v); }
        let l = v.get(venue);
        if (!l) { l = []; v.set(venue, l); }
        l.push([address, w]);
      }
    }
  }
  index = { at: load.at, by };
  return by;
}

function accuracyOf(): Partial<Record<Venue, { cur: DriftStats; prev: DriftStats | null }>> {
  try {
    return JSON.parse(reader()?.getMeta(LIQ_ACC_META) ?? '{}');
  } catch {
    return {};
  }
}

/** The figures to show: today's once it has a few hundred comparisons, else yesterday's whole day. */
function shownAccuracy(a: { cur: DriftStats; prev: DriftStats | null } | undefined): (DriftStats & { window: 'today' | 'yesterday' }) | null {
  if (!a?.cur) return null;
  const enough = (d: DriftStats) => d.checked + d.n >= 300;
  if (!enough(a.cur) && a.prev && a.prev.checked + a.prev.n > a.cur.checked + a.cur.n) return { ...emptyDrift(0), ...a.prev, window: 'yesterday' };
  return { ...emptyDrift(0), ...a.cur, window: 'today' };
}

/** The venue's markets of a coin: its symbols, with open interest and price. */
function marketsOfCoin(m: VenueMarkets | null, coin: string): Array<{ symbol: string; oi: number; px: number | null }> {
  if (!m) return [];
  const out: Array<{ symbol: string; oi: number; px: number | null }> = [];
  for (const [symbol, x] of m.oi) if (coinOf(symbol) === coin) out.push({ symbol, ...x });
  return out;
}

interface Gathered {
  load: Load;
  price: number | null;
  levels: LevelPos[];
  coverage: Partial<Record<Venue, VenueCoverage>>;
  labels: Map<string, string | null>;
}

async function gather(coin: string, venues: readonly Venue[]): Promise<Gathered | null> {
  const load = cohortBooksNow();
  if (!load) return null;
  const idx = coinIndex(load).get(coin);
  const markets = new Map(await Promise.all(venues.map(async (v) => [v, await venueMarkets(v, { oi: true }).catch(() => null)] as const)));
  const acc = accuracyOf();
  const levels: LevelPos[] = [];
  const coverage: Partial<Record<Venue, VenueCoverage>> = {};
  const labels = new Map<string, string | null>();
  const prices = new Map<Venue, number>();
  for (const venue of venues) {
    const m = markets.get(venue) ?? null;
    const mk = marketsOfCoin(m, coin);
    const priceOf = (s: string) => load.marks.get(`${venue}|${s}`) ?? m?.oi.get(s)?.px ?? null;
    const tiersFor = (s: string): Tiers | null => m?.tiers.get(s) ?? null;
    const wallets = idx?.get(venue) ?? [];
    const cov: VenueCoverage = {
      oi: mk.length ? mk.reduce((a, x) => a + x.oi, 0) : null, oiUsd: null,
      long: 0, short: 0, longKnown: 0, shortKnown: 0, positions: 0, wallets: wallets.length,
      price: null, accuracy: shownAccuracy(acc[venue]), computed: venue === 'arcus', ...(m ? {} : { noRules: true }),
    };
    const main = mk.slice().sort((a, b) => b.oi - a.oi)[0];
    cov.price = main ? priceOf(main.symbol) : null;
    if (cov.price !== null) prices.set(venue, cov.price);
    if (cov.oi !== null && cov.price !== null) cov.oiUsd = cov.oi * cov.price;
    for (const l of coinLevels(venue, wallets, coin, priceOf, tiersFor)) {
      cov.positions++;
      const a = Math.abs(l.szi);
      if (l.szi > 0) { cov.long += a; if (l.liq !== null) cov.longKnown += a; } else { cov.short += a; if (l.liq !== null) cov.shortKnown += a; }
      levels.push(l);
    }
    for (const [address, w] of wallets) if (w.label) labels.set(`${venue}|${address}`, w.label);
    coverage[venue] = cov;
  }
  const ref = PRICE_ORDER.find((v) => prices.has(v));
  return { load, price: ref ? prices.get(ref)! : null, levels, coverage, labels };
}

const isRes = (r: unknown): r is Resolution => r === 'fine' || r === 'medium' || r === 'coarse';

export async function liqHeatmap(coin: string, venues: readonly Venue[], res: unknown): Promise<LiqHeatmap | null> {
  const g = await gather(coin, venues);
  if (!g) return null;
  const resolution: Resolution = isRes(res) ? res : 'fine';
  const price = g.price;
  const step = price ? niceStep(price * RESOLUTION[resolution]) : 1;
  const { buckets, outside } = price ? bucketize(g.levels, step, price * LO, price * HI) : { buckets: [], outside: { long: 0, short: 0, longN: 0, shortN: 0 } };
  return { coin, venues: [...venues], resolution, at: g.load.booksAt, price, step, buckets: buckets.map(roundBucket), outside, coverage: g.coverage };
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const roundBucket = (b: Bucket): Bucket => [b[0], Math.round(b[1]), Math.round(b[2]), b[3], b[4], b[5], b[6]];

/** The wallets whose `side` liquidates in [from, to), largest first. */
export async function liqWallets(coin: string, venues: readonly Venue[], side: 'long' | 'short', from: number, to: number, limit = 25): Promise<LiqWallets | null> {
  const g = await gather(coin, venues);
  if (!g) return null;
  const hits = g.levels.filter((l) => l.liq !== null && l.liq >= from && l.liq < to && (side === 'long' ? l.szi > 0 : l.szi < 0));
  const rows = hits.map((l): LiqWallet => {
    const usd = Math.abs(l.szi) * l.liq!;
    return {
      venue: l.venue, address: l.address, label: shownLabel(l.address, g.labels.get(`${l.venue}|${l.address}`) ?? null),
      szi: l.szi, liq: l.liq!, usd: r2(usd), dist: g.price ? l.liq! / g.price - 1 : null,
    };
  }).sort((a, b) => b.usd - a.usd);
  return { coin, side, from, to, price: g.price, total: r2(rows.reduce((a, x) => a + x.usd, 0)), count: rows.length, wallets: rows.slice(0, limit) };
}

const RANGE_MS = { '1d': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 } as const;
export type LiqRange = keyof typeof RANGE_MS;
export const isLiqRange = (r: unknown): r is LiqRange => typeof r === 'string' && r in RANGE_MS;

export function liqHistory(coin: string, venues: readonly Venue[], range: LiqRange): LiqHistory | null {
  const s = reader();
  if (!s) return null;
  const points: LiqHistory['points'] = [];
  let coins: string[] = [];
  try {
    for (const r of s.liqHist(coin, Date.now() - RANGE_MS[range])) {
      let snap: LiqSnap;
      try { snap = JSON.parse(r.data) as LiqSnap; } catch { continue; }
      const sum = new Map<number, [number, number]>();
      for (const v of venues) {
        for (const [i, l, sh] of snap.v[v] ?? []) {
          const b = sum.get(i) ?? [0, 0];
          b[0] += l;
          b[1] += sh;
          sum.set(i, b);
        }
      }
      points.push({ t: r.t, p: snap.p, st: snap.st, b: [...sum].sort((a, b) => a[0] - b[0]).map(([i, [l, sh]]) => [i, l, sh]) });
    }
    coins = s.liqHistCoins();
  } catch { /* the table arrives with the indexer's first start */ }
  return { coin, venues: [...venues], points, coins };
}

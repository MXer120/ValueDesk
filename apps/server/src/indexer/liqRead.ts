/**
 * The liquidation heatmap's reads (API thread): one coin's levels across the
 * chosen venues, the wallets in a price range, and the levels over time.
 *
 * THE HEATMAP IS A ROW READ. The indexer prices every position of every coin a
 * minute apart and writes each coin's buckets (cohortTracker.ts recordLiq ->
 * liq_now); a request reads one row, sums the venues asked for, and leaves the
 * route edge-cacheable (perf.ts), so a thousand viewers of BTC cost one read a
 * minute. Only a bucket's wallets (a click) walk the books, from the cohort load
 * (read.ts cohortBooksNow), where the positions carry their addresses.
 * Coverage is said, not assumed: per
 * venue, the size the books hold against the venue's own open interest, how
 * much of it has a known liquidation price, and how the math has matched the
 * venue's figures at reads and re-reads (the tracker's DriftStats).
 */
import type { Venue } from '../valuedesk/types.js';
import type { WalletVenue } from '../valuedesk/cohorts/model.js';
import { emptyDrift, type DriftStats, type Tiers } from '../valuedesk/liquidations/math.js';
import { coinLevels, liqCoin, type LevelPos, type LiqNow, type LiqSnap } from '../valuedesk/liquidations/levels.js';
import { inflateRawSync } from 'node:zlib';
import { venueMarkets, type VenueMarkets } from '../valuedesk/liquidations/rules.js';
import { shownLabel } from '../valuedesk/labels.js';
import { cohortBooksNow } from './read.js';
import { reader } from './reader.js';
import { liqFeed } from './liqFeed.js';
import { LIQ_ACC_META } from './cohortTracker.js';

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
  /** Size whose liquidation price the price has already crossed (being liquidated, or a book a print has not reached): not in the buckets. */
  past: number;
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
  /** When the indexer priced the books. */
  at: number;
  price: number | null;
  /** The bucket width; the web groups buckets by what is on screen. */
  step: number;
  /** [bucket index (low price = index x step), long USD, short USD, long n, short n]. */
  buckets: Array<[number, number, number, number, number]>;
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
        const c = liqCoin(p.symbol);
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
  for (const [symbol, x] of m.oi) if (liqCoin(symbol) === coin) out.push({ symbol, ...x });
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
      long: 0, short: 0, longKnown: 0, shortKnown: 0, positions: 0, past: 0,
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

/** Parsed liq_now rows, kept until the indexer writes the next (it does a minute apart). */
const nowCache = new Map<string, { at: number; read: number; row: LiqNow | null }>();
const NOW_REREAD_MS = 10_000;

function nowRow(coin: string): { at: number; row: LiqNow | null } | null {
  const s = reader();
  if (!s) return null;
  const hit = nowCache.get(coin);
  if (hit && Date.now() - hit.read < NOW_REREAD_MS) return hit;
  let got: { at: number; data: Uint8Array } | null = null;
  try { got = s.liqNow(coin); } catch { /* the table arrives with the indexer's first start */ }
  let row: LiqNow | null = null;
  if (got) {
    if (hit && hit.at === got.at) row = hit.row;
    else try { row = JSON.parse(inflateRawSync(got.data).toString('utf8')) as LiqNow; } catch { row = null; }
  }
  const out = { at: got?.at ?? 0, read: Date.now(), row };
  if (nowCache.size > 2_000) nowCache.clear();
  nowCache.set(coin, out);
  return out;
}

/** One coin's levels on one venue, from the live feed or a minute row. */
interface VenueSrc {
  b: Iterable<[number, number, number, number, number]>;
  c: ArrayLike<number>;
  o: ArrayLike<number>;
}

/** The heatmap over the venues asked for, from one source's per-venue levels. */
export function heatOf(
  coin: string, venues: readonly Venue[],
  src: { at: number; p: number | null; st: number; v: (venue: Venue) => VenueSrc | undefined },
  markets: ReadonlyMap<Venue, VenueMarkets | null>,
): LiqHeatmap {
  const acc = accuracyOf();
  const sum = new Map<number, [number, number, number, number, number]>();
  const outside = { long: 0, short: 0, longN: 0, shortN: 0 };
  const coverage: Partial<Record<Venue, VenueCoverage>> = {};
  for (const venue of venues) {
    const m = markets.get(venue) ?? null;
    const mk = marketsOfCoin(m, coin);
    const x = src.v(venue);
    const main = mk.slice().sort((p, q) => q.oi - p.oi)[0];
    const price = main?.px ?? null;
    const oi = mk.length ? mk.reduce((n, y) => n + y.oi, 0) : null;
    coverage[venue] = {
      oi, oiUsd: oi !== null && price !== null ? oi * price : null,
      long: x?.c[0] ?? 0, short: x?.c[1] ?? 0, longKnown: x?.c[2] ?? 0, shortKnown: x?.c[3] ?? 0, positions: x?.c[4] ?? 0, past: x?.c[5] ?? 0,
      price, accuracy: shownAccuracy(acc[venue]), computed: venue === 'arcus', ...(m ? {} : { noRules: true }),
    };
    if (!x) continue;
    for (const [i, l, sh, ln, sn] of x.b) {
      const e = sum.get(i);
      if (e) { e[1] += l; e[2] += sh; e[3] += ln; e[4] += sn; } else sum.set(i, [i, l, sh, ln, sn]);
    }
    outside.long += x.o[0]!; outside.short += x.o[1]!; outside.longN += x.o[2]!; outside.shortN += x.o[3]!;
  }
  return {
    coin, venues: [...venues], at: src.at, price: src.p, step: src.st,
    buckets: [...sum.values()].sort((p, q) => p[0] - q[0]), outside, coverage,
  };
}

/** A coin's live levels as heatOf reads them (null when the feed does not hold the coin). */
export function liveSrc(coin: string): Parameters<typeof heatOf>[2] | null {
  const feed = liqFeed();
  const c = feed.live ? feed.coins.get(coin) : undefined;
  if (!c) return null;
  return {
    at: c.at, p: c.p, st: c.st,
    v: (venue) => {
      const x = c.v.get(venue);
      return x && { b: [...x.b].map(([i, y]): [number, number, number, number, number] => [i, y[0], y[1], y[2], y[3]]), c: x.c, o: x.o };
    },
  };
}

/** The venues' market lists, read where stale (open interest a minute old at most). */
export async function marketsFor(venues: readonly Venue[]): Promise<Map<Venue, VenueMarkets | null>> {
  return new Map(await Promise.all(venues.map(async (v) => [v, await venueMarkets(v, { oi: true }).catch(() => null)] as const)));
}

/**
 * A coin's liquidation levels over the venues asked for: from the live feed (the
 * indexer's engine, a second old) when the API has it, else from the minute row.
 */
export async function liqHeatmap(coin: string, venues: readonly Venue[]): Promise<LiqHeatmap | null> {
  const markets = await marketsFor(venues);
  const live = liveSrc(coin);
  if (live) return heatOf(coin, venues, live, markets);
  const got = nowRow(coin);
  if (!got) return null;
  const row = got.row;
  return heatOf(coin, venues, { at: got.at, p: row?.p ?? null, st: row?.st ?? 1, v: (venue) => row?.v[venue] }, markets);
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** The wallets whose `side` liquidates in [from, to), largest first. */
export async function liqWallets(coin: string, venues: readonly Venue[], side: 'long' | 'short', from: number, to: number, limit = 25): Promise<LiqWallets | null> {
  const g = await gather(coin, venues);
  if (!g) return null;
  const p = g.price;
  // As the buckets: a long priced above the price (a short below) is past, not a level.
  const hits = g.levels.filter((l) => l.liq !== null && l.liq >= from && l.liq < to && (side === 'long' ? l.szi > 0 && !(p && l.liq >= p) : l.szi < 0 && !(p && l.liq <= p)));
  const rows = hits.map((l): LiqWallet => {
    const usd = Math.abs(l.szi) * l.liq!;
    return {
      venue: l.venue, address: l.address, label: shownLabel(l.address, g.labels.get(`${l.venue}|${l.address}`) ?? null),
      szi: l.szi, liq: l.liq!, usd: r2(usd), dist: g.price ? l.liq! / g.price - 1 : null,
    };
  }).sort((a, b) => b.usd - a.usd);
  return { coin, side, from, to, price: g.price, total: r2(rows.reduce((a, x) => a + x.usd, 0)), count: rows.length, wallets: rows.slice(0, limit) };
}

const RANGE_MS = { '1d': 86_400_000, '2d': 2 * 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 } as const;
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
        for (const [i, l0, sh0] of snap.v[v] ?? []) {
          // A level the price had crossed when the snapshot was taken (a long priced above it, a
          // short below) is past, not a level: snapshots before 2026-10-28 kept them, and drew
          // longs above the price line and shorts below it.
          const l = i * snap.st >= snap.p ? 0 : l0;
          const sh = (i + 1) * snap.st <= snap.p ? 0 : sh0;
          if (!l && !sh) continue;
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

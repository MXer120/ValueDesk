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
import { VENUES, type Venue } from '../valuedesk/types.js';
import type { WalletVenue } from '../valuedesk/cohorts/model.js';
import { emptyDrift, niceStep, type DriftStats, type Tiers } from '../valuedesk/liquidations/math.js';
import { NOW_HI, NOW_LO, NOW_STEP, coinLevels, liqCoin, type LevelPos, type LiqNow, type LiqSnap } from '../valuedesk/liquidations/levels.js';
import { inflateRawSync } from 'node:zlib';
import { marketsNow, venueMarkets, type VenueMarkets } from '../valuedesk/liquidations/rules.js';
import { shownLabel } from '../valuedesk/labels.js';
import { cohortBooksNow } from './read.js';
import { reader } from './reader.js';
import type { LiqAtRow } from './store.js';
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
  /**
   * Of that, the size for which no liquidation price exists (the venue says so, or the account
   * carries the position to zero: most low-leverage longs) - known, just never liquidated. The
   * rest without a price is not known yet. Absent from an indexer before 2026-10-30.
   */
  longNone?: number;
  shortNone?: number;
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
  /** The wallet filter only: when the cohort load its positions come from was built (ms). */
  asOf?: number;
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
  /** When the cohort load these positions come from was built (ms). */
  asOf: number;
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
  // usd01 (by USD within 0.1%) only where the day kept it from its start.
  const of = (d: DriftStats, window: 'today' | 'yesterday') => {
    const out: DriftStats & { window: 'today' | 'yesterday' } = { ...emptyDrift(0), ...d, window };
    if (d.usd01 === undefined) delete out.usd01;
    return out;
  };
  if (!enough(a.cur) && a.prev && a.prev.checked + a.prev.n > a.cur.checked + a.cur.n) return of(a.prev, 'yesterday');
  return of(a.cur, 'today');
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
  const markets = await marketsFor(venues);
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
      long: 0, short: 0, longKnown: 0, shortKnown: 0, longNone: 0, shortNone: 0, positions: 0, past: 0,
      price: null, accuracy: shownAccuracy(acc[venue]), computed: venue === 'arcus', ...(m ? {} : { noRules: true }),
    };
    const main = mk.slice().sort((a, b) => b.oi - a.oi)[0];
    cov.price = main ? priceOf(main.symbol) : null;
    if (cov.price !== null) prices.set(venue, cov.price);
    if (cov.oi !== null && cov.price !== null) cov.oiUsd = cov.oi * cov.price;
    for (const l of coinLevels(venue, wallets, coin, priceOf, tiersFor)) {
      cov.positions++;
      const a = Math.abs(l.szi);
      if (l.szi > 0) { cov.long += a; if (l.liq !== null) cov.longKnown += a; else if (l.none) cov.longNone! += a; } else { cov.short += a; if (l.liq !== null) cov.shortKnown += a; else if (l.none) cov.shortNone! += a; }
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
  /** Coverage as live.ts Cov / levels.ts LiqNowVenue.c (older sources: shorter, the rest read as 0). */
  c: ArrayLike<number | undefined>;
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
      long: x?.c[0] ?? 0, short: x?.c[1] ?? 0, longKnown: x?.c[2] ?? 0, shortKnown: x?.c[3] ?? 0, longNone: x?.c[6] ?? 0, shortNone: x?.c[7] ?? 0, positions: x?.c[4] ?? 0, past: x?.c[5] ?? 0,
      price, accuracy: shownAccuracy(acc[venue]), computed: venue === 'arcus', ...(m ? {} : { noRules: true }),
    };
    if (!x) continue;
    // The live engine leaves past to the reader (live.ts): its coverage carries no past figure
    // (the feed has none, its liq_now rows write 0) and its buckets keep the levels the price
    // has crossed. Those are counted here at the price answered with, by the same test the web
    // uses to leave them out of the bars (size = USD over the 0.02% bucket's middle).
    const p = src.p !== null && src.p > 0 ? src.p : null;
    let past = 0;
    for (const [i, l, sh, ln, sn] of x.b) {
      const e = sum.get(i);
      if (e) { e[1] += l; e[2] += sh; e[3] += ln; e[4] += sn; } else sum.set(i, [i, l, sh, ln, sn]);
      if (p === null) continue;
      if (l > 0 && i * src.st >= p) past += l / ((i + 0.5) * src.st);
      if (sh > 0 && (i + 1) * src.st <= p) past += sh / ((i + 0.5) * src.st);
    }
    if (past > 0) coverage[venue]!.past = +((x.c[5] ?? 0) + past).toPrecision(6);
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

/**
 * The venues' market lists: what is cached answers at once and a stale one is read again behind
 * it (open interest a minute old at most, for the next request). Only a venue never read yet is
 * waited for, and not past MARKETS_WAIT_MS. Awaiting every refresh held the heatmap 40-90 s
 * (2026-10-28) whenever the API's shared Lighter / Arcus pacers or Hyperliquid budget were busy:
 * the edge gave up at 30 s and the map showed nothing.
 */
export async function marketsFor(venues: readonly Venue[]): Promise<Map<Venue, VenueMarkets | null>> {
  return new Map(await Promise.all(venues.map(async (v) => {
    const fresh = venueMarkets(v, { oi: true }).catch(() => null);
    const now = marketsNow(v);
    if (now) return [v, now] as const;
    const late = new Promise<null>((r) => setTimeout(() => r(null), MARKETS_WAIT_MS).unref?.());
    return [v, await Promise.race([fresh, late])] as const;
  })));
}

/** How long a heatmap waits for a venue's first market list before answering without its open interest. */
const MARKETS_WAIT_MS = 3_000;

/**
 * A coin's liquidation levels over the venues asked for: from the live feed (the
 * indexer's engine, a second old) when the API has it, else from the minute row.
 */
/**
 * The heatmap of some wallets only (the wallet filter, live and chart views): their positions
 * from the cohort load (a minute old at most), priced as the details panel prices them, in the
 * live feed's 0.02% buckets around the price. Coverage is theirs: what they hold against the
 * venue's open interest.
 */
export async function liqHeatmapOf(coin: string, venues: readonly Venue[], wallets: readonly string[]): Promise<LiqHeatmap | null> {
  const g = await gather(coin, venues);
  if (!g) return null;
  const only = new Set(wallets);
  const p = g.price;
  const st = p ? niceStep(p * NOW_STEP) : 1;
  const sum = new Map<number, [number, number, number, number, number]>();
  const outside = { long: 0, short: 0, longN: 0, shortN: 0 };
  const coverage: Partial<Record<Venue, VenueCoverage>> = {};
  for (const v of venues) {
    const c = g.coverage[v];
    if (c) coverage[v] = { ...c, long: 0, short: 0, longKnown: 0, shortKnown: 0, longNone: 0, shortNone: 0, positions: 0, past: 0 };
  }
  for (const l of g.levels) {
    if (!only.has(l.address)) continue;
    const c = coverage[l.venue];
    const a = Math.abs(l.szi);
    const long = l.szi > 0;
    if (c) {
      c.positions++;
      if (long) { c.long += a; if (l.liq !== null) c.longKnown += a; else if (l.none) c.longNone! += a; } else { c.short += a; if (l.liq !== null) c.shortKnown += a; else if (l.none) c.shortNone! += a; }
    }
    if (l.liq === null || !p) continue;
    if (long ? l.liq >= p : l.liq <= p) { if (c) c.past += a; continue; }
    const usd = a * l.liq;
    if (l.liq < p * NOW_LO || l.liq >= p * NOW_HI) {
      if (long) { outside.long += usd; outside.longN++; } else { outside.short += usd; outside.shortN++; }
      continue;
    }
    const i = Math.floor(l.liq / st);
    const b = sum.get(i) ?? [i, 0, 0, 0, 0];
    if (long) { b[1] += usd; b[3]++; } else { b[2] += usd; b[4]++; }
    sum.set(i, b);
  }
  return {
    coin, venues: [...venues], at: g.load.at, price: p, step: st,
    buckets: [...sum.values()].sort((x, y) => x[0] - y[0]), outside, coverage, asOf: g.load.at,
  };
}

/** A wallet's open positions, every coin, with their liquidation prices (the wallet filter's list). */
export interface WalletLiq {
  venue: Venue;
  address: string;
  label: string | null;
  coin: string;
  symbol: string;
  szi: number;
  liq: number | null;
  /** USD at the liquidation price (null without one), and the distance from the price. */
  usd: number | null;
  price: number | null;
  dist: number | null;
}

/** Every position of `wallets` on `venues`, largest first. */
export async function walletLiqs(wallets: readonly string[], venues: readonly Venue[]): Promise<{ asOf: number; positions: WalletLiq[] } | null> {
  const load = cohortBooksNow();
  if (!load) return null;
  const markets = await marketsFor(venues);
  const out: WalletLiq[] = [];
  for (const venue of venues) {
    const per = load.per.get(venue);
    if (!per) continue;
    const m = markets.get(venue) ?? null;
    const priceOf = (s: string) => load.marks.get(`${venue}|${s}`) ?? m?.oi.get(s)?.px ?? null;
    const tiersFor = (s: string): Tiers | null => m?.tiers.get(s) ?? null;
    for (const address of wallets) {
      const w = per.get(address);
      if (!w?.positions?.length) continue;
      const coins = new Set(w.positions.map((x) => liqCoin(x.symbol)));
      for (const coin of coins) {
        for (const l of coinLevels(venue, [[address, w]], coin, priceOf, tiersFor)) {
          const px = priceOf(l.symbol);
          out.push({
            venue, address, label: shownLabel(address, w.label ?? null), coin, symbol: l.symbol, szi: l.szi, liq: l.liq,
            usd: l.liq !== null ? r2(Math.abs(l.szi) * l.liq) : null, price: px, dist: l.liq !== null && px ? l.liq / px - 1 : null,
          });
        }
      }
    }
  }
  return { asOf: load.at, positions: out.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0)) };
}

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
export async function liqWallets(coin: string, venues: readonly Venue[], side: 'long' | 'short', from: number, to: number, limit = 25, wallets: readonly string[] = []): Promise<LiqWallets | null> {
  const g = await gather(coin, venues);
  if (!g) return null;
  const p = g.price;
  // As the buckets: a long priced above the price (a short below) is past, not a level.
  const only = wallets.length ? new Set(wallets) : null;
  const hits = g.levels.filter((l) => (!only || only.has(l.address)) && l.liq !== null && l.liq >= from && l.liq < to && (side === 'long' ? l.szi > 0 && !(p && l.liq >= p) : l.szi < 0 && !(p && l.liq <= p)));
  const rows = hits.map((l): LiqWallet => {
    const usd = Math.abs(l.szi) * l.liq!;
    return {
      venue: l.venue, address: l.address, label: shownLabel(l.address, g.labels.get(`${l.venue}|${l.address}`) ?? null),
      szi: l.szi, liq: l.liq!, usd: r2(usd), dist: g.price ? l.liq! / g.price - 1 : null,
    };
  }).sort((a, b) => b.usd - a.usd);
  return { coin, side, from, to, price: g.price, total: r2(rows.reduce((a, x) => a + x.usd, 0)), count: rows.length, wallets: rows.slice(0, limit), asOf: g.load.at };
}

/** One position as it stood at a past time (liqAt). */
export interface LiqAtPosition {
  venue: Venue;
  address: string;
  label: string | null;
  side: 'long' | 'short';
  liq: number;
  /** USD at the level, as the history sums it. */
  usd: number;
  /** The level against the price then (-0.031: 3.1% below). */
  dist: number | null;
  /** The change log's row in force then, and what it kept (null: not known, or a row before 2026-10-29). */
  t: number;
  sym: string | null;
  sz: number | null;
  entry: number | null;
  mark: number | null;
  iso: boolean | null;
  lev: number | null;
  eq: number | null;
  cash: number | null;
  readAt: number | null;
  /** When this run of the position began. */
  since: number;
  /**
   * What happened next: its next row - a move of level or size, a flip, a close (with the
   * price then and whether that was within 1% of its level) - or null while unchanged.
   */
  next: { t: number; kind: 'changed' | 'flipped' | 'closed'; liq: number | null; usd: number; mark: number | null; nearLevel: boolean | null } | null;
}

export interface LiqAt {
  coin: string;
  venues: Venue[];
  /** The time asked, and the history's snapshot in force then: its time and price (null: none). */
  t: number;
  snapT: number | null;
  price: number | null;
  from: number;
  to: number;
  side: 'long' | 'short' | 'both';
  long: { usd: number; count: number };
  short: { usd: number; count: number };
  count: number;
  /** The largest `limit`. */
  positions: LiqAtPosition[];
  /** The change log's first step: before it no position can be told (null: no log yet). */
  logFrom: number | null;
}

/**
 * Who sat in the price cell [from, to) of `coin` at time `t`: each position by the change log's
 * row in force then (store.liqAt) - side, level, size, entry, mark, margin, account - with when
 * its run began and what it did next. As the history's cells: a long whose level the price then
 * had crossed (a short below it) is past, not counted.
 */
export function liqAt(coin: string, venues: readonly Venue[], t: number, from: number, to: number, side: 'long' | 'short' | 'both', wallets: readonly string[] = [], limit = 100): LiqAt | null {
  const s = reader();
  if (!s) return null;
  let snap: { t: number; p: number } | null = null;
  try {
    for (const r of s.liqHist(coin, t - 3 * 3_600_000)) {
      if (r.t > t) break;
      try { snap = { t: r.t, p: (JSON.parse(r.data) as LiqSnap).p }; } catch { /* a bad row: the one before stands */ }
    }
  } catch { /* the tables arrive with the indexer's first start */ }
  const price = snap?.p ?? null;
  let rows: LiqAtRow[] = [];
  try {
    rows = s.liqAt(coin, venues.map((v) => VENUES.indexOf(v)), t, from, to, side === 'long' ? 1 : side === 'short' ? -1 : 0);
  } catch { /* as above */ }
  const only = wallets.length ? new Set(wallets.map((w) => w.toLowerCase())) : null;
  const out: LiqAtPosition[] = [];
  const long = { usd: 0, count: 0 };
  const short = { usd: 0, count: 0 };
  for (const r of rows) {
    if (only && !only.has(r.address.toLowerCase())) continue;
    if (price !== null && (r.side > 0 ? r.liq >= price : r.liq <= price)) continue;
    const venue = VENUES[r.venue]!;
    const sideName = r.side > 0 ? 'long' : 'short';
    const agg = r.side > 0 ? long : short;
    agg.usd += r.usd;
    agg.count++;
    const nx = r.next;
    out.push({
      venue, address: r.address, label: shownLabel(r.address, null), side: sideName, liq: r.liq, usd: r.usd,
      dist: price ? r.liq / price - 1 : null,
      t: r.t, sym: r.sym, sz: r.sz, entry: r.entry, mark: r.mark, iso: r.iso === null ? null : r.iso === 1, lev: r.lev, eq: r.eq, cash: r.cash, readAt: r.readAt,
      since: r.since,
      next: nx ? {
        t: nx.t, kind: nx.usd === 0 ? 'closed' : nx.side !== r.side ? 'flipped' : 'changed', liq: nx.usd === 0 ? null : nx.liq, usd: nx.usd, mark: nx.mark,
        nearLevel: nx.usd === 0 && nx.mark !== null ? Math.abs(nx.mark / r.liq - 1) <= 0.01 : null,
      } : null,
    });
  }
  out.sort((a, b) => b.usd - a.usd);
  const from0 = s.getMeta('liq_log_from');
  return {
    coin, venues: [...venues], t, snapT: snap?.t ?? null, price, from, to, side,
    long: { usd: r2(long.usd), count: long.count }, short: { usd: r2(short.usd), count: short.count }, count: out.length,
    positions: out.slice(0, limit), logFrom: from0 ? Number(from0) : null,
  };
}

const RANGE_MS = { '1d': 86_400_000, '2d': 2 * 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 } as const;
export type LiqRange = keyof typeof RANGE_MS;
export const isLiqRange = (r: unknown): r is LiqRange => typeof r === 'string' && r in RANGE_MS;

export function liqHistory(coin: string, venues: readonly Venue[], range: LiqRange, wallets: readonly string[] = []): LiqHistory | null {
  const s = reader();
  if (!s) return null;
  const points: LiqHistory['points'] = [];
  let coins: string[] = [];
  // Some wallets only: their positions rebuilt from the change log (liq_log) at each step the
  // history kept (liq_hist: the time, the price, the bucket width), summed into that step's
  // buckets - every position, whatever its size, from the step it was first logged.
  if (wallets.length) {
    const vs = new Set(venues.map((v) => VENUES.indexOf(v)));
    try {
      const from = Date.now() - RANGE_MS[range];
      const ids = [...s.liqAddrIds(wallets).values()];
      const log = ids.length ? s.liqLog(ids, coin, from) : [];
      const state = new Map<string, { side: number; liq: number; usd: number }>();
      let k = 0;
      for (const r of s.liqHist(coin, from)) {
        while (k < log.length && log[k]!.t <= r.t) {
          const e = log[k++]!;
          const key = `${e.aid}|${e.venue}`;
          if (e.usd > 0) state.set(key, { side: e.side, liq: e.liq, usd: e.usd });
          else state.delete(key);
        }
        if (!state.size) continue;
        let snap: LiqSnap;
        try { snap = JSON.parse(r.data) as LiqSnap; } catch { continue; }
        const sum = new Map<number, [number, number]>();
        for (const [key, x] of state) {
          if (!vs.has(Number(key.slice(key.indexOf('|') + 1)))) continue;
          // A level the price had crossed is past, as in the snapshot's own buckets.
          if (x.side > 0 ? x.liq >= snap.p : x.liq <= snap.p) continue;
          const i = Math.floor(x.liq / snap.st);
          const b = sum.get(i) ?? [0, 0];
          if (x.side > 0) b[0] += x.usd; else b[1] += x.usd;
          sum.set(i, b);
        }
        if (sum.size) points.push({ t: r.t, p: snap.p, st: snap.st, b: [...sum].sort((x, y) => x[0] - y[0]).map(([i, [l, sh]]) => [i, l, sh]) });
      }
      coins = s.liqHistCoins();
    } catch { /* the tables arrive with the indexer's first start */ }
    return { coin, venues: [...venues], points, coins };
  }
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

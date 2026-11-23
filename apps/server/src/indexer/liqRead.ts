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
 *
 * LEVERAGE (2026-10-31). Every row carries its USD per leverage band after the counts
 * (levels.ts LiqRow / SnapRow; math.ts levBand, accountLevs); a row from an older indexer
 * has none, and what the bands leave of a side reads as unknown leverage. Every sum here
 * adds rows field by field (addRow), so old and new rows mix exactly. The wallet lists take
 * `lev=` (levFilterOf): only positions of those bands - unknown ones only with every band.
 */
import { VENUES, type Venue } from '../valuedesk/types.js';
import type { WalletVenue } from '../valuedesk/cohorts/model.js';
import { LEV_BANDS, emptyDrift, levBand, niceStep, type DriftStats, type LevBand, type Tiers } from '../valuedesk/liquidations/math.js';
import { FINE_MAX_BUCKETS, NOW_HI, NOW_LO, NOW_STEP, addRow, mergeFine, coinLevels, liqCoin, rowBand, snapBand, trimRow, type FineSnap, type LevelPos, type LiqNow, type LiqRow, type LiqSnap, type SnapRow } from '../valuedesk/liquidations/levels.js';
import { inflateRawSync } from 'node:zlib';
import { marketsNow, venueMarkets, type VenueMarkets } from '../valuedesk/liquidations/rules.js';
import { shownLabel } from '../valuedesk/labels.js';
import { cohortBooksNow, internalOiNow } from './read.js';
import { sodexInternalNow } from '../valuedesk/sodex/oiExcluded.js';
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

import type { BooksOverOi } from '../valuedesk/cohorts/model.js';

export interface LiqHeatmap {
  coin: string;
  venues: Venue[];
  /** The coin's books over its open interest (read.ts booksOverOi): the levels hold size that does not exist. */
  overOi?: BooksOverOi[];
  /** When the indexer priced the books. */
  at: number;
  price: number | null;
  /** The bucket width; the web groups buckets by what is on screen. */
  step: number;
  /**
   * [bucket index (low price = index x step), long USD, short USD, long n, short n] and, from
   * 2026-10-31, USD per leverage band: long low, mid, high, short low, mid, high (levels.ts
   * LiqRow; trailing zeros left off, what the bands leave of a side is unknown leverage).
   */
  buckets: LiqRow[];
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
  /** The leverage it runs at (math.ts accountLevs; null = not known; 1000 = no margin left). Absent before 2026-10-31. */
  lev?: number | null;
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
  /**
   * Snapshots: time, price, step, rows summed over the venues - [bucket index, long USD, short USD]
   * and, from 2026-10-31, USD per leverage band (levels.ts SnapRow: long low, mid, high, short low,
   * mid, high; trailing zeros left off).
   */
  points: Array<{ t: number; p: number; st: number; b: SnapRow[] }>;
  /** Coins with snapshots (the most open notional tracked). */
  coins: string[];
}

type Load = NonNullable<ReturnType<typeof cohortBooksNow>>;

/**
 * The `lev=` of the wallet lists: a comma list of low, mid, high. Null (every position, unknown
 * leverage too) when absent, empty or naming all three: a filter shows only what it names.
 */
export function levFilterOf(q: unknown): ReadonlySet<LevBand> | null {
  if (typeof q !== 'string' || !q.trim()) return null;
  const names = ['low', 'mid', 'high'] as const;
  const set = new Set<LevBand>();
  for (const w of q.split(',')) { const i = names.indexOf(w.trim().toLowerCase() as typeof names[number]); if (i >= 0) set.add(i as LevBand); }
  return set.size === 0 || set.size === 3 ? null : set;
}
const inFilter = (f: ReadonlySet<LevBand> | null, lev: number | null | undefined) => {
  if (!f) return true;
  const b = levBand(lev);
  return b !== null && f.has(b);
};

/**
 * A change log row's leverage, as far as the log can tell (math.ts accountLevs is the live
 * figure): isolated, the leverage it is margined at (the log keeps no isolated margin); cross,
 * its own notional at the mark over the account's equity - the log holds no other position of
 * the account, so an account of several cross positions reads lower here than on the live map.
 * Null: not known (rows before 2026-10-29 keep none of it).
 */
export function logLev(r: { iso: number | boolean | null; lev: number | null; sz: number | null; mark: number | null; eq: number | null }): number | null {
  if (r.iso === null || r.iso === undefined) return null;
  if (r.iso === true || r.iso === 1) return r.lev && r.lev > 0 ? r.lev : null;
  if (r.sz === null || r.mark === null || !(r.mark > 0) || r.eq === null) return null;
  return r.eq > 0 ? (Math.abs(r.sz) * r.mark) / r.eq : Infinity;
}

/** A leverage for JSON: Infinity (no margin left) as 1000, else one decimal. */
const levOut = (x: number | null | undefined): number | null => (x == null ? null : Number.isFinite(x) ? Math.round(x * 10) / 10 : 1000);

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
      oi: mk.length ? Math.max(0, mk.reduce((a, x) => a + x.oi, 0) - internalOiOf(venue, coin)) : null, oiUsd: null,
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
  b: Iterable<LiqRow>;
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
  const sum = new Map<number, LiqRow>();
  const outside = { long: 0, short: 0, longN: 0, shortN: 0 };
  const coverage: Partial<Record<Venue, VenueCoverage>> = {};
  for (const venue of venues) {
    const m = markets.get(venue) ?? null;
    const mk = marketsOfCoin(m, coin);
    const x = src.v(venue);
    const main = mk.slice().sort((p, q) => q.oi - p.oi)[0];
    const price = main?.px ?? null;
    // The venue's own accounts' share is not the traders' (internalWallets.ts): the books leave them out, so does the OI.
    const oi = mk.length ? Math.max(0, mk.reduce((n, y) => n + y.oi, 0) - internalOiOf(venue, coin)) : null;
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
    for (const r of x.b) {
      const [i, l, sh] = r;
      // Field by field, bands and all: a venue's row without bands adds its USD as unknown leverage.
      const e = sum.get(i);
      if (e) addRow(e, r); else sum.set(i, r.slice() as LiqRow);
      if (p === null) continue;
      if (l > 0 && i * src.st >= p) past += l / ((i + 0.5) * src.st);
      if (sh > 0 && (i + 1) * src.st <= p) past += sh / ((i + 0.5) * src.st);
    }
    if (past > 0) coverage[venue]!.past = +((x.c[5] ?? 0) + past).toPrecision(6);
    outside.long += x.o[0]!; outside.short += x.o[1]!; outside.longN += x.o[2]!; outside.shortN += x.o[3]!;
  }
  return {
    coin, venues: [...venues], at: src.at, price: src.p, step: src.st,
    buckets: [...sum.values()].sort((p, q) => p[0] - q[0]).map((r) => trimRow(r)), outside, coverage,
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
      return x && { b: [...x.b].map(([i, y]) => [i, ...y] as LiqRow), c: x.c, o: x.o };
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
/** SoDEX's internal pair as SoDEX says it holds now (oiExcluded.ts), when it answered in the last minute. */
let sodexInternal: { at: number; byCoin: Map<string, number> } | null = null;
const SODEX_INTERNAL_FRESH_MS = 60_000;
function internalOiOf(venue: Venue, coin: string): number {
  if (venue === 'sodex' && sodexInternal && Date.now() - sodexInternal.at < SODEX_INTERNAL_FRESH_MS) return sodexInternal.byCoin.get(coin) ?? 0;
  return internalOiNow(venue, coin);
}

/**
 * On the cohort thread (cohortThread.ts) the venues' markets come from the API thread, which holds the venue clients and
 * their budgets; the SoDEX internal pair comes with them.
 */
let marketsSource: ((venues: readonly Venue[]) => Promise<{ markets: Map<Venue, VenueMarkets | null>; sodex: Map<string, number> | null }>) | null = null;
export function setMarketsSource(f: typeof marketsSource): void { marketsSource = f; }
/** The SoDEX internal pair as the API thread last read it (null: none yet), for the cohort thread's asks. */
export function sodexInternalHeld(): Map<string, number> | null {
  return sodexInternal && Date.now() - sodexInternal.at < SODEX_INTERNAL_FRESH_MS ? sodexInternal.byCoin : null;
}

export async function marketsFor(venues: readonly Venue[]): Promise<Map<Venue, VenueMarkets | null>> {
  if (marketsSource) {
    const got = await marketsSource(venues);
    if (got.sodex) sodexInternal = { at: Date.now(), byCoin: got.sodex };
    return got.markets;
  }
  if (venues.includes('sodex')) {
    // At most one read in 15 s however many ask, and a page never waits for it: the next one has it.
    void sodexInternalNow().then((byCoin) => { if (byCoin) sodexInternal = { at: Date.now(), byCoin }; });
  }
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
  const g = await gatherNow(coin, venues);
  if (!g) return null;
  const p = g.price;
  return heatOfLevels(coin, venues, g, p ? niceStep(p * NOW_STEP) : 1, p ? p * NOW_LO : 0, p ? p * NOW_HI : 0, { wallets: new Set(wallets) });
}

/**
 * EXACT STEPS (owner 2026-10-31: "via settings down to $1 (min tick on sodex) if the user wants?
 * and of course for all coins"). The live engine keeps a position's bucket, not its price, at
 * 0.02% of the price - BTC $20 - so a finer step cannot come out of its rows. The cohort load
 * keeps the books with every position (a minute old at most), and gather prices them exactly;
 * a step finer than the engine's is bucketed from those, for the price window on screen only
 * (FINE_MAX_BUCKETS at most; only those with levels are sent). One pass over the coin's positions,
 * on levels kept per load (gatherNow), and edge-cached like the heatmap (perf.ts).
 */
export interface FineAsk {
  step: number;
  from: number;
  to: number;
}

/** `step=` with `from=` / `to=`: null when no step is asked, a message when the ask is wrong (a 400). */
export function fineAskOf(q: { step?: unknown; from?: unknown; to?: unknown }): FineAsk | null | string {
  if (q.step === undefined || q.step === '') return null;
  const step = Number(q.step);
  const from = Number(q.from);
  const to = Number(q.to);
  if (!(step > 0) || !Number.isFinite(step)) return 'step= must be a price step above 0';
  if (!(from >= 0) || !Number.isFinite(to) || !(to > from)) return 'from= and to= must be a price range with step=';
  // The window's buckets, not the ones with levels: what one answer may cost is known before it is read.
  if (Math.ceil((to - from) / step - 1e-9) > FINE_MAX_BUCKETS) return `at most ${FINE_MAX_BUCKETS} buckets of step= in from= to to=`;
  return { step, from, to };
}

/** Which positions a heatmap counts: some wallets only, one side, some leverage bands (levFilterOf). Absent: every one. */
export interface LevelFilter {
  wallets?: ReadonlySet<string> | null;
  side?: 'long' | 'short' | null;
  lev?: ReadonlySet<LevBand> | null;
}

/** Per venue, what the books hold of the positions the wallet filter keeps (VenueCoverage's counts). */
type Counts = Pick<VenueCoverage, 'long' | 'short' | 'longKnown' | 'shortKnown' | 'positions' | 'past'> & { longNone: number; shortNone: number };

/**
 * Levels into `step` buckets over [from, to), as the engine sums them (LiqRow: USD, counts, USD
 * per leverage band): a long priced at or above the price (a short at or below) is past, counted
 * per venue and left out; a level outside the window is counted in `outside`. The counts are of
 * every position the wallet filter keeps; the side and leverage filters choose what is bucketed.
 */
export function levelRows(levels: Iterable<LevelPos>, price: number | null, step: number, from: number, to: number, f: LevelFilter = {}): {
  buckets: LiqRow[];
  outside: LiqHeatmap['outside'];
  counts: Map<Venue, Counts>;
} {
  const p = price !== null && price > 0 ? price : null;
  const sum = new Map<number, LiqRow>();
  const outside = { long: 0, short: 0, longN: 0, shortN: 0 };
  const counts = new Map<Venue, Counts>();
  const only = f.wallets?.size ? f.wallets : null;
  for (const l of levels) {
    if (only && !only.has(l.address)) continue;
    let c = counts.get(l.venue);
    if (!c) { c = { long: 0, short: 0, longKnown: 0, shortKnown: 0, longNone: 0, shortNone: 0, positions: 0, past: 0 }; counts.set(l.venue, c); }
    const a = Math.abs(l.szi);
    const long = l.szi > 0;
    c.positions++;
    if (long) { c.long += a; if (l.liq !== null) c.longKnown += a; else if (l.none) c.longNone += a; } else { c.short += a; if (l.liq !== null) c.shortKnown += a; else if (l.none) c.shortNone += a; }
    if (l.liq === null || !p) continue;
    if (long ? l.liq >= p : l.liq <= p) { c.past += a; continue; }
    if (f.side && f.side !== (long ? 'long' : 'short')) continue;
    if (!inFilter(f.lev ?? null, l.lev)) continue;
    const usd = a * l.liq;
    if (l.liq < from || l.liq >= to) {
      if (long) { outside.long += usd; outside.longN++; } else { outside.short += usd; outside.shortN++; }
      continue;
    }
    const i = Math.floor(l.liq / step);
    const b = sum.get(i) ?? [i, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    if (long) { b[1] += usd; b[3]++; } else { b[2] += usd; b[4]++; }
    const band = levBand(l.lev);
    if (band !== null) b[rowBand(long, band)]! += usd;
    sum.set(i, b);
  }
  return { buckets: [...sum.values()].sort((x, y) => x[0] - y[0]).map((r) => trimRow(r)), outside, counts };
}

/** A heatmap from gathered levels: levelRows, with each venue's coverage counted over the positions kept. */
function heatOfLevels(coin: string, venues: readonly Venue[], g: Gathered, step: number, from: number, to: number, f: LevelFilter): LiqHeatmap {
  const r = levelRows(g.levels, g.price, step, from, to, f);
  const coverage: Partial<Record<Venue, VenueCoverage>> = {};
  const zero: Counts = { long: 0, short: 0, longKnown: 0, shortKnown: 0, longNone: 0, shortNone: 0, positions: 0, past: 0 };
  for (const v of venues) {
    const c = g.coverage[v];
    if (c) coverage[v] = { ...c, ...(r.counts.get(v) ?? zero) };
  }
  // Whole dollars, as the engine's rows: BTC at $1 over $4,000 is ~1,900 rows, and 15 digits of each USD were 40% of the answer.
  const buckets = r.buckets.map((b) => b.map((x, k) => (k === 0 || k === 3 || k === 4 ? x : Math.round(x))) as LiqRow);
  return { coin, venues: [...venues], at: g.load.at, price: g.price, step, buckets, outside: r.outside, coverage, asOf: g.load.at };
}

/** A coin's levels at `ask.step` over [ask.from, ask.to), exact from the books (the fine route); `f` as levelRows. */
export async function liqHeatmapFine(coin: string, venues: readonly Venue[], ask: FineAsk, f: LevelFilter = {}): Promise<(LiqHeatmap & FineAsk) | null> {
  const g = await gatherNow(coin, venues);
  if (!g) return null;
  return { ...heatOfLevels(coin, venues, g, ask.step, ask.from, ask.to, f), ...ask };
}

/**
 * gather, kept per coin and venues for as long as the cohort load it read stands (a minute):
 * pricing every account of BTC is the cost of a fine answer, bucketing it again is not. The
 * levels are only read after.
 */
const gathered = new Map<string, { at: number; read: number; g: Promise<Gathered | null> }>();
const GATHER_KEEP_MS = 60_000;

async function gatherNow(coin: string, venues: readonly Venue[]): Promise<Gathered | null> {
  const load = cohortBooksNow();
  if (!load) return null;
  const key = `${coin}|${venues.join(',')}`;
  const hit = gathered.get(key);
  if (hit && hit.at === load.at && Date.now() - hit.read < GATHER_KEEP_MS) return hit.g;
  const g = gather(coin, venues).catch(() => null);
  if (gathered.size >= 64) gathered.clear();
  gathered.set(key, { at: load.at, read: Date.now(), g });
  return g;
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

/** The wallets whose `side` liquidates in [from, to), largest first; `lev`: only those leverage bands (levFilterOf). */
export async function liqWallets(coin: string, venues: readonly Venue[], side: 'long' | 'short', from: number, to: number, limit = 25, wallets: readonly string[] = [], lev: ReadonlySet<LevBand> | null = null): Promise<LiqWallets | null> {
  const g = await gather(coin, venues);
  if (!g) return null;
  const p = g.price;
  // As the buckets: a long priced above the price (a short below) is past, not a level.
  const only = wallets.length ? new Set(wallets) : null;
  const hits = g.levels.filter((l) => (!only || only.has(l.address)) && inFilter(lev, l.lev) && l.liq !== null && l.liq >= from && l.liq < to && (side === 'long' ? l.szi > 0 && !(p && l.liq >= p) : l.szi < 0 && !(p && l.liq <= p)));
  const rows = hits.map((l): LiqWallet => {
    const usd = Math.abs(l.szi) * l.liq!;
    return {
      venue: l.venue, address: l.address, label: shownLabel(l.address, g.labels.get(`${l.venue}|${l.address}`) ?? null),
      szi: l.szi, liq: l.liq!, usd: r2(usd), dist: g.price ? l.liq! / g.price - 1 : null, lev: levOut(l.lev),
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
  /** The leverage its band is read from (logLev; 1000 = no margin left). Absent before 2026-10-31. */
  levRun?: number | null;
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
export function liqAt(coin: string, venues: readonly Venue[], t: number, from: number, to: number, side: 'long' | 'short' | 'both', wallets: readonly string[] = [], limit = 100, lev: ReadonlySet<LevBand> | null = null): LiqAt | null {
  const s = reader();
  if (!s) return null;
  let snap: { t: number; p: number } | null = null;
  try {
    // The newest in force then (a bad row: the one before it), reading only it: every row from three
    // hours before `t` up to now was read to find it - over a second for an older cell of BTC.
    let upTo = t;
    while (!snap) {
      const r = s.liqHistLast(coin, t - 3 * 3_600_000, upTo);
      if (!r) break;
      try { snap = { t: r.t, p: (JSON.parse(r.data) as LiqSnap).p }; } catch { upTo = r.t - 1; }
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
    const run = logLev(r);
    if (!inFilter(lev, run)) continue;
    const venue = VENUES[r.venue]!;
    const sideName = r.side > 0 ? 'long' : 'short';
    const agg = r.side > 0 ? long : short;
    agg.usd += r.usd;
    agg.count++;
    const nx = r.next;
    out.push({
      venue, address: r.address, label: shownLabel(r.address, null), side: sideName, liq: r.liq, usd: r.usd,
      dist: price ? r.liq / price - 1 : null,
      t: r.t, levRun: levOut(run), sym: r.sym, sz: r.sz, entry: r.entry, mark: r.mark, iso: r.iso === null ? null : r.iso === 1, lev: r.lev, eq: r.eq, cash: r.cash, readAt: r.readAt,
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

export function liqHistory(coin: string, venues: readonly Venue[], range: LiqRange, wallets: readonly string[] = [], known: { points: ReadonlyArray<{ t: number; p: number; st: number }>; coins: string[] } | null = null): LiqHistory | null {
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
      const state = new Map<string, { side: number; liq: number; usd: number; band: LevBand | null }>();
      let k = 0;
      // Each step's time, price and width: `known` (the tile index holds them), else its snapshot read.
      const steps = known ? known.points.filter((q) => q.t >= from) : s.liqHist(coin, from).flatMap((r) => {
        try { const q = JSON.parse(r.data) as LiqSnap; return [{ t: r.t, p: q.p, st: q.st }]; } catch { return []; }
      });
      for (const r of steps) {
        while (k < log.length && log[k]!.t <= r.t) {
          const e = log[k++]!;
          const key = `${e.aid}|${e.venue}`;
          if (e.usd > 0) state.set(key, { side: e.side, liq: e.liq, usd: e.usd, band: levBand(logLev(e)) });
          else state.delete(key);
        }
        if (!state.size) continue;
        const snap = r;
        const sum = new Map<number, SnapRow>();
        for (const [key, x] of state) {
          if (!vs.has(Number(key.slice(key.indexOf('|') + 1)))) continue;
          // A level the price had crossed is past, as in the snapshot's own buckets.
          if (x.side > 0 ? x.liq >= snap.p : x.liq <= snap.p) continue;
          const i = Math.floor(x.liq / snap.st);
          const b = sum.get(i) ?? [i, 0, 0, 0, 0, 0, 0, 0, 0];
          if (x.side > 0) b[1] += x.usd; else b[2] += x.usd;
          if (x.band !== null) b[snapBand(x.side > 0, x.band)]! += x.usd;
          sum.set(i, b);
        }
        if (sum.size) points.push({ t: r.t, p: snap.p, st: snap.st, b: [...sum.values()].sort((x, y) => x[0] - y[0]).map((b) => trimRow(b, 3)) });
      }
      coins = known ? known.coins : s.liqHistCoins();
    } catch { /* the tables arrive with the indexer's first start */ }
    return { coin, venues: [...venues], points, coins };
  }
  try {
    for (const r of s.liqHist(coin, Date.now() - RANGE_MS[range])) {
      let snap: LiqSnap;
      try { snap = JSON.parse(r.data) as LiqSnap; } catch { continue; }
      const sum = new Map<number, SnapRow>();
      for (const v of venues) {
        for (const r of snap.v[v] ?? []) {
          const i = r[0];
          // A level the price had crossed when the snapshot was taken (a long priced above it, a
          // short below) is past, not a level: snapshots before 2026-10-28 kept them, and drew
          // longs above the price line and shorts below it.
          const keepL = i * snap.st < snap.p;
          const keepS = (i + 1) * snap.st > snap.p;
          const l = keepL ? r[1] : 0;
          const sh = keepS ? r[2] : 0;
          if (!l && !sh) continue;
          const b = sum.get(i) ?? [i, 0, 0, 0, 0, 0, 0, 0, 0];
          b[1] += l;
          b[2] += sh;
          // Bands (snapshots from 2026-10-31; before, none: the side's USD is unknown leverage).
          for (const band of LEV_BANDS) {
            if (keepL) b[snapBand(true, band)]! += r[snapBand(true, band)] ?? 0;
            if (keepS) b[snapBand(false, band)]! += r[snapBand(false, band)] ?? 0;
          }
          sum.set(i, b);
        }
      }
      points.push({ t: r.t, p: snap.p, st: snap.st, b: [...sum.values()].sort((a, b) => a[0] - b[0]).map((b) => trimRow(b, 3)) });
    }
    coins = s.liqHistCoins();
  } catch { /* the table arrives with the indexer's first start */ }
  return { coin, venues: [...venues], points, coins };
}

/**
 * Some wallets' levels at a fine step (the historical view's wallet filter at $10 and $1, owner
 * 2026-11-02: "The fine steps need to be EXACTLY like $100 just finer steps. No feature missing"):
 * rebuilt from the change log at each snapshot `snaps` lists, as liqHistory rebuilds them at the
 * snapshot's own step - the same positions, so a $100 cell is the sum of its $1 ones - over
 * [ask.from, ask.to), cut to what the view draws (FineDraw). Every snapshot asked is answered,
 * empty or not (none before the log began, as at $100).
 */
export function walletHistoryFine(coin: string, venues: readonly Venue[], wallets: readonly string[], snaps: ReadonlyArray<{ t: number; p: number }>, ask: FineAsk, draw: FineDraw | null = null): LiqHistoryFine | null {
  const s = reader();
  if (!s) return null;
  const step = ask.step;
  const eps = 1e-9;
  const lo = +(Math.ceil(ask.from / step - eps) * step).toPrecision(12);
  const hi = +(Math.floor(ask.to / step + eps) * step).toPrecision(12);
  const points: LiqHistFinePoint[] = [];
  if (!snaps.length || !(hi > lo)) return { coin, venues: [...venues], ...ask, points, since: null, cut: null };
  // One per bar (FineDraw every): the newest of each, the one the chart draws.
  const barOf = (t: number) => (draw && draw.every > 0 ? Math.floor((t - draw.off) / draw.every) : t);
  const drawn = new Set<number>();
  for (let k = 0; k < snaps.length; k++) if (k === snaps.length - 1 || barOf(snaps[k + 1]!.t) !== barOf(snaps[k]!.t)) drawn.add(snaps[k]!.t);
  const vs = new Set(venues.map((v) => VENUES.indexOf(v)));
  try {
    const ids = [...s.liqAddrIds(wallets).values()];
    const log = ids.length ? s.liqLog(ids, coin, snaps[0]!.t) : [];
    const state = new Map<string, { side: number; liq: number; usd: number; band: LevBand | null }>();
    let k = 0;
    for (const snap of snaps) {
      while (k < log.length && log[k]!.t <= snap.t) {
        const e = log[k++]!;
        const key = `${e.aid}|${e.venue}`;
        if (e.usd > 0) state.set(key, { side: e.side, liq: e.liq, usd: e.usd, band: levBand(logLev(e)) });
        else state.delete(key);
      }
      if (!drawn.has(snap.t)) continue;
      const sum = new Map<number, SnapRow>();
      for (const [key, x] of state) {
        if (!vs.has(Number(key.slice(key.indexOf('|') + 1)))) continue;
        // A level the price had crossed is past, as at the snapshot's own step.
        if (x.side > 0 ? x.liq >= snap.p : x.liq <= snap.p) continue;
        if (x.liq < lo || x.liq >= hi) continue;
        const i = Math.floor(x.liq / step);
        const b = sum.get(i) ?? [i, 0, 0, 0, 0, 0, 0, 0, 0];
        if (x.side > 0) b[1] += x.usd; else b[2] += x.usd;
        if (x.band !== null) b[snapBand(x.side > 0, x.band)]! += x.usd;
        sum.set(i, b);
      }
      const rows = [...sum.values()].sort((a, b) => a[0] - b[0]).map((b) => trimRow(b, 3));
      points.push({ t: snap.t, st: step, lo, hi, b: draw && draw.pool > 0 ? poolRows(rows, step, draw) : rows });
    }
  } catch { /* the tables arrive with the indexer's first start */ }
  return { coin, venues: [...venues], ...ask, points, since: null, cut: null };
}

/** One snapshot's levels at the fine step asked, over [lo, hi): the part of its price range the fine layers hold. */
export interface LiqHistFinePoint { t: number; st: number; lo: number; hi: number; b: SnapRow[] }

export interface LiqHistoryFine extends FineAsk {
  coin: string;
  venues: Venue[];
  /** The snapshots in [t0, t1] with fine layers, oldest first. */
  points: LiqHistFinePoint[];
  /** When the coin's fine layers begin (null: none yet): older snapshots have their own step only. */
  since: number | null;
  /** Rows reached FINE_HIST_MAX_ROWS: only the snapshots from this time on are here (null: all). */
  cut: number | null;
}

/** Rows one fine history answer carries at most (~25 bytes each): newer snapshots first, the rest left to their own step. */
export const FINE_HIST_MAX_ROWS = 80_000;
/**
 * A tile's rows at most (FineDraw: the view's tiles, one snapshot a bar and pooled to its pixels,
 * hold a few thousand; this only stops an ask nobody draws).
 */
export const FINE_TILE_MAX_ROWS = 400_000;

/**
 * How the historical view's fine tiles are cut to what it draws (web liqmap/histFine.ts), so every
 * column on screen has its step without reading cells no pixel shows:
 *   every, off  one snapshot per bar of `every` ms, the bars starting at `off` modulo it: the
 *               newest in each, the one the chart draws for that bar (web liqHeatIndicator.ts
 *               snapshotFor). 0: every snapshot.
 *   pool        the cells in groups of this price width (a whole number of steps, at most a pixel
 *               of the view), the strongest of each kept as it is - by the side and leverage
 *               bands the view counts (web cellOf): the view draws the strongest cell of a pixel,
 *               so what it draws is what every cell would draw. 0: every cell.
 */
export interface FineDraw {
  every: number;
  off: number;
  pool: number;
  side: 'long' | 'short' | 'both';
  lev: ReadonlySet<LevBand> | null;
}

/** `every=` `off=` `pool=` `side=` `lev=` (FineDraw): null when none is asked, a message when wrong. */
export function fineDrawOf(q: { every?: unknown; off?: unknown; pool?: unknown; side?: unknown; lev?: unknown }, step: number): FineDraw | null | string {
  if ((q.every === undefined || q.every === '') && (q.pool === undefined || q.pool === '')) return null;
  const every = q.every === undefined || q.every === '' ? 0 : Number(q.every);
  const off = q.off === undefined || q.off === '' ? 0 : Number(q.off);
  const pool = q.pool === undefined || q.pool === '' ? 0 : Number(q.pool);
  if (!(every >= 0) || !Number.isFinite(every)) return 'every= must be a bar length in ms';
  if (!Number.isFinite(off)) return 'off= must be a time in ms';
  if (!(pool >= 0) || !Number.isFinite(pool)) return 'pool= must be a price width';
  const k = pool / step;
  if (pool > 0 && (k < 1 || Math.abs(k - Math.round(k)) > 1e-6 * k)) return 'pool= must be a whole number of step=';
  const side = q.side === 'long' || q.side === 'short' ? q.side : 'both';
  return { every, off: every > 0 ? ((off % every) + every) % every : 0, pool, side, lev: levFilterOf(q.lev) };
}

/** A row's notional as the view counts it under a side and leverage filter (web liqHeatIndicator.ts cellOf). */
export function shownValue(r: SnapRow, side: FineDraw['side'], lev: ReadonlySet<LevBand> | null): number {
  const all = !lev || LEV_BANDS.every((b) => lev.has(b));
  let v = 0;
  for (const long of [true, false]) {
    if (side === (long ? 'short' : 'long')) continue;
    const total = r[long ? 1 : 2] ?? 0;
    if (!(total > 0)) continue;
    if (all) { v += total; continue; }
    for (const b of LEV_BANDS) if (lev!.has(b)) v += r[snapBand(long, b)] ?? 0;
  }
  return v;
}

/** Rows (ascending, at `step`) pooled into groups of `pool`: the strongest of each, as it is. */
export function poolRows(rows: readonly SnapRow[], step: number, d: Pick<FineDraw, 'pool' | 'side' | 'lev'>): SnapRow[] {
  const k = Math.round(d.pool / step);
  if (!(k > 1)) return [...rows];
  const out: SnapRow[] = [];
  let g = Number.NaN;
  let best = -1;
  for (const r of rows) {
    const gi = Math.floor(r[0] / k);
    const v = shownValue(r, d.side, d.lev);
    if (gi !== g) { g = gi; best = v; out.push(r); }
    else if (v > best) { best = v; out[out.length - 1] = r; }
  }
  return out;
}

/**
 * A snapshot's fine rows at `ask.step` over the window asked, from the layer that serves it: the
 * coarsest whose step divides the one asked (summed up to it), else the finest finer than it.
 * Null when no layer is fine enough, or none reaches the window.
 */
export function fineRowsOf(f: FineSnap, venues: readonly Venue[], ask: FineAsk): { lo: number; hi: number; b: SnapRow[] } | null {
  const eps = 1e-9;
  const fit = f.L.filter((L) => L.st <= ask.step * (1 + eps));
  if (!fit.length) return null;
  const L = fit.find((x) => { const k = ask.step / x.st; return Math.abs(k - Math.round(k)) < 1e-6 * k; }) ?? fit.at(-1)!;
  const step = ask.step;
  const lo = Math.ceil(Math.max(ask.from, L.lo) / step - eps) * step;
  const hi = Math.floor(Math.min(ask.to, L.hi) / step + eps) * step;
  if (!(hi > lo)) return null;
  const sum = new Map<number, SnapRow>();
  for (const v of venues) {
    for (const r of L.v[v] ?? []) {
      const px = r[0] * L.st;
      if (px < lo - eps * step || px >= hi - eps * step) continue;
      const i = Math.floor(px / step + eps);
      const b = sum.get(i) ?? [i, 0, 0];
      addRow(b, r);
      sum.set(i, b);
    }
  }
  return { lo: +lo.toPrecision(12), hi: +hi.toPrecision(12), b: [...sum.values()].sort((x, y) => x[0] - y[0]).map((b) => trimRow(b, 3)) };
}

/**
 * `coin`'s levels at a step finer than its snapshots keep (the historical view at $10 and $1 on
 * BTC, down to the coin's tick), for the window on screen: the snapshots from `t0` to `t1`, each
 * over the part of [ask.from, ask.to) its fine layers hold - the bands of liq_hist_fine_band
 * (levels.ts fineBands: the whole range since 2026-11-01 evening), before them the day of
 * liq_hist_fine (near the price). Newest first up to FINE_HIST_MAX_ROWS rows; the view draws the
 * rest at their own step. Every wallet only: the layers keep no addresses.
 */
export function liqHistoryFine(coin: string, venues: readonly Venue[], t0: number, t1: number, ask: FineAsk, draw: FineDraw | null = null): LiqHistoryFine | null {
  const s = reader();
  if (!s) return null;
  const points: LiqHistFinePoint[] = [];
  let since: number | null = null;
  let cut: number | null = null;
  let n = 0;
  const max = draw ? FINE_TILE_MAX_ROWS : FINE_HIST_MAX_ROWS;
  /** The bar of a snapshot (FineDraw every): the newest of each is the one drawn, met first. */
  let lastBar = Number.NaN;
  const barOf = (t: number) => (draw && draw.every > 0 ? Math.floor((t - draw.off) / draw.every) : t);
  /** Adds one snapshot's rows, newest first; false once the rows would pass the cap. */
  const add = (t: number, f: FineSnap): boolean => {
    const bar = barOf(t);
    if (bar === lastBar) return true;
    // The bar's newest only, fine or not: an older one in it is not the one drawn.
    lastBar = bar;
    const x = fineRowsOf(f, venues, ask);
    if (!x) return true;
    const b = draw && draw.pool > 0 ? poolRows(x.b, ask.step, draw) : x.b;
    if (n + b.length > max) { cut = points.at(-1)?.t ?? t; return false; }
    n += b.length;
    points.push({ t, st: ask.step, lo: x.lo, hi: x.hi, b });
    return true;
  };
  const parse = (data: Uint8Array): FineSnap | null => { try { return JSON.parse(inflateRawSync(data).toString('utf8')) as FineSnap; } catch { return null; } };
  try {
    const bandFrom = s.liqHistFineBandFrom(coin);
    const oldFrom = s.liqHistFineFrom(coin);
    since = bandFrom === null ? oldFrom : oldFrom === null ? bandFrom : Math.min(bandFrom, oldFrom);
    let going = true;
    if (bandFrom !== null) {
      // The bands overlapping the window, newest snapshot first: each snapshot's put back together.
      // Only the snapshots drawn are read: one whose bar is already drawn adds nothing (add), and its data is a disk read
      // (production 2026-11-23: a 6 h tile 8-10 s cold; a 1 h chart read four snapshots for each it drew).
      const rows = s.liqHistFineBandKeys(coin, t0, t1, ask.from, ask.to);
      for (let k = 0; k < rows.length && going;) {
        const t = rows[k]!.t;
        if (barOf(t) === lastBar) { k++; continue; }
        const parts: FineSnap[] = [];
        for (; k < rows.length && rows[k]!.t === t; k++) {
          const data = s.liqHistFineBandAt(coin, t, rows[k]!.lo);
          const f = data && parse(data);
          if (f) parts.push(f);
        }
        const f = mergeFine(parts);
        if (f) going = add(t, f);
      }
    }
    // Before the bands: the earlier layers near the price.
    if (going && oldFrom !== null && (bandFrom === null || oldFrom < bandFrom)) {
      const rows = s.liqHistFine(coin, t0, Math.min(t1, bandFrom === null ? t1 : bandFrom - 1));
      for (let k = rows.length - 1; k >= 0 && going; k--) {
        const f = parse(rows[k]!.data);
        if (f) going = add(rows[k]!.t, f);
      }
    }
  } catch { /* the tables arrive with the indexer's first start after 2026-11-01 */ }
  points.reverse();
  return { coin, venues: [...venues], ...ask, points, since, cut };
}

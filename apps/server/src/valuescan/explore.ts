/**
 * Explore page segments, built from the venue providers' leaderboards.
 *
 * WHAT THIS FILE DOES. It asks every provider for a handful of leaderboard
 * slices (30D PnL, 30D ROI, 7D PnL, all-time PnL, account value, 7D volume, 1D
 * volume), merges the rows of one venue into one record per trader, and cuts
 * six segments out of that pool. It never fetches anything itself: every
 * upstream call, cache and rate budget belongs to the provider it asks.
 *
 * ONE VENUE FAILING NEVER BLANKS THE OTHER. Venues are settled independently
 * (and so is every slice inside a venue - SoDEX's official leaderboard only
 * sorts by PnL and volume, so its provider may refuse `roi` or `accountValue`
 * while still answering the rest). A venue counts as live when at least one of
 * its slices answered, and `kpis.venues` lists exactly the live ones, which is
 * how the page knows to say "SoDEX is not available" instead of showing a
 * shorter list as if it were the whole answer. Only when NO venue answers does
 * this throw, and then with NotAvailable if every refusal was a NotAvailable, so
 * the route can tell "not built yet" from "upstream is down".
 *
 * RATE BUDGET. The first slice of a venue is asked ALONE, and only then the
 * other six. Seven concurrent calls into a provider whose cache is cold would be
 * seven cold fetches of the same upstream document (the Hyperliquid leaderboard
 * is one large file); after the first call that provider serves the rest from
 * its cache. SoDEX's slices are separate upstream queries, but every one of them
 * goes through the provider's own data limiter (4 in flight, 80ms apart), so
 * asking for them together adds no burst upstream - it only stops a cold build
 * from waiting for SoDEX's two chart-ranked pools one after the other (measured:
 * 46s cold with three at a time). Venues run in parallel. A slice that runs past
 * its timeout is left out of THIS build only: the provider finishes it into its
 * own cache and the next rebuild picks it up.
 *
 * CACHE. One result, fresh for 60s and shared by every caller, with in-flight
 * de-duping so a burst of page loads costs one build. From 60s to 5 min the
 * last answer is served immediately while one rebuild runs behind it. A failed
 * build is remembered for 15s so a venue that is down is not re-asked on every
 * request, and it never replaces a good answer that is still within 5 min.
 *
 * SEGMENT ROWS. Each segment keeps the top SEGMENT_ROWS_PER_VENUE of EACH venue,
 * merged and sorted by the segment's own score. The page can then filter to one
 * venue and still show a full list, and the top rows of the unfiltered list are
 * exactly the global top (the union of per-venue tops contains it).
 */
import {
  NotAvailable,
  type ExploreResponse,
  type ExploreSegment,
  type LeaderboardPage,
  type LeaderboardQuery,
  type TraderRow,
  type Venue,
  type VenueProvider,
  type Window,
} from './types.js';

/* ---------------------------------------------------------------------------
 * Tunables. Exported so the thresholds the page describes and the tests that
 * pin them read the same numbers.
 * ------------------------------------------------------------------------ */

export const EXPLORE_TTL_MS = 60_000;
/** Past the TTL an answer is served while it is rebuilt, up to this age. */
export const EXPLORE_STALE_MAX_MS = 5 * 60_000;
export const EXPLORE_FAIL_TTL_MS = 15_000;
/** Per slice. A provider that hangs must not hang the whole page. */
export const EXPLORE_SLICE_TIMEOUT_MS = 20_000;
/**
 * After the first slice, this many slices of one venue are asked at once - all
 * of them today, because both providers pace their own upstream calls. It stays
 * a knob for a provider that does not.
 */
export const EXPLORE_SLICE_CONCURRENCY = 6;
export const SEGMENT_ROWS_PER_VENUE = 10;

/** Top ROI: smallest account (or implied capital) that may rank. */
export const MIN_ROI_CAPITAL_USD = 10_000;
/** Rising: smallest 7D PnL that counts as a move rather than noise. */
export const RISING_MIN_PNL_USD = 1_000;
/** Rising: 7D PnL must be at least this share of all-time PnL. */
export const RISING_MIN_SHARE = 0.5;

/**
 * The slices asked of every venue, in the order they are asked. The first is
 * the one most likely to be served (every venue ranks by 30D PnL), so it is the
 * one that warms the provider's cache.
 */
export const EXPLORE_SLICES: readonly LeaderboardQuery[] = [
  { window: '30d', sort: 'pnl', limit: 100, offset: 0 },
  { window: '7d', sort: 'pnl', limit: 100, offset: 0 },
  { window: 'all', sort: 'pnl', limit: 100, offset: 0 },
  { window: '30d', sort: 'roi', limit: 100, offset: 0 },
  { window: '30d', sort: 'accountValue', limit: 50, offset: 0 },
  { window: '7d', sort: 'volume', limit: 50, offset: 0 },
  { window: '1d', sort: 'volume', limit: 100, offset: 0 },
];

/* ---------------------------------------------------------------------------
 * Segments.
 * ------------------------------------------------------------------------ */

export type SegmentId = 'top-pnl' | 'top-roi' | 'consistent' | 'whales' | 'rising' | 'most-active';

export const SEGMENT_IDS: readonly SegmentId[] = [
  'top-pnl', 'top-roi', 'consistent', 'whales', 'rising', 'most-active',
];

interface SegmentDef {
  id: SegmentId;
  title: string;
  subtitle: string;
  /** null = the row does not qualify. Higher ranks first. */
  score: (r: TraderRow) => number | null;
}

const val = (v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

const pnlOf = (r: TraderRow, w: Window) => val(r.pnl[w]);
const roiOf = (r: TraderRow, w: Window) => val(r.roi[w]);
const volOf = (r: TraderRow, w: Window) => val(r.volume[w]);

/**
 * The capital a 30D ROI was earned on, i.e. the ROI's own denominator.
 *
 * NOT simply today's account value. Measured on Hyperliquid's leaderboard: an
 * account worth $4.48M today shows a 30D ROI of 4,487,527% because it started
 * the window with about $100 and was funded afterwards - its account value
 * passes any size floor while the ROI is meaningless. So when the venue gives
 * both ROI and PnL, the capital is the one they imply (ROI = PnL / capital),
 * and today's account value must clear the floor as well. Account value alone
 * is the fallback when the pair cannot be divided.
 */
export function roiCapital(r: TraderRow): number | null {
  const av = val(r.accountValue);
  const pnl = pnlOf(r, '30d');
  const roi = roiOf(r, '30d');
  const implied = pnl !== null && roi !== null && pnl > 0 && roi > 0 ? pnl / roi : null;
  if (implied !== null && av !== null) return Math.min(implied, av);
  return implied ?? av;
}

export const SEGMENTS: readonly SegmentDef[] = [
  {
    id: 'top-pnl',
    title: 'Top PnL 30D',
    subtitle: 'Ranked by 30D PnL',
    score: (r) => {
      const p = pnlOf(r, '30d');
      return p !== null && p > 0 ? p : null;
    },
  },
  {
    id: 'top-roi',
    title: 'Top ROI 30D',
    subtitle: 'Capital from $10K, ranked by 30D ROI',
    score: (r) => {
      const roi = roiOf(r, '30d');
      const cap = roiCapital(r);
      return roi !== null && roi > 0 && cap !== null && cap >= MIN_ROI_CAPITAL_USD ? roi : null;
    },
  },
  {
    id: 'consistent',
    title: 'Consistent',
    subtitle: 'Profitable over 7D, 30D and all time',
    score: (r) => {
      const d7 = pnlOf(r, '7d');
      const d30 = pnlOf(r, '30d');
      const all = pnlOf(r, 'all');
      return d7 !== null && d30 !== null && all !== null && d7 > 0 && d30 > 0 && all > 0 ? d30 : null;
    },
  },
  {
    id: 'whales',
    title: 'Whales',
    subtitle: 'Largest account value',
    score: (r) => {
      const av = val(r.accountValue);
      return av !== null && av > 0 ? av : null;
    },
  },
  {
    id: 'rising',
    title: 'Rising',
    subtitle: '7D PnL is at least half of all-time PnL',
    score: (r) => {
      const d7 = pnlOf(r, '7d');
      const all = pnlOf(r, 'all');
      // The share is only meaningful against a positive all-time record. That
      // also drops rows whose windows contradict each other - Hyperliquid's
      // leaderboard has accounts at +$246M over 7D and -$500 all-time, which
      // "up this week while under water" would rank first.
      if (d7 === null || all === null || d7 < RISING_MIN_PNL_USD || all <= 0) return null;
      return d7 >= RISING_MIN_SHARE * all ? d7 : null;
    },
  },
  {
    id: 'most-active',
    title: 'Most active',
    subtitle: 'Ranked by 7D volume',
    score: (r) => {
      const v = volOf(r, '7d');
      return v !== null && v > 0 ? v : null;
    },
  },
];

/* ---------------------------------------------------------------------------
 * Merging rows of one trader that arrived in several slices.
 * ------------------------------------------------------------------------ */

const keyOf = (r: TraderRow) => `${r.venue}:${r.address.toLowerCase()}`;

function mergeWindows<T>(
  a: Partial<Record<Window, T | null>>,
  b: Partial<Record<Window, T | null>>,
): Partial<Record<Window, T | null>> {
  const out: Partial<Record<Window, T | null>> = { ...a };
  for (const [w, v] of Object.entries(b) as Array<[Window, T | null | undefined]>) {
    if (v !== null && v !== undefined && (out[w] === null || out[w] === undefined)) out[w] = v;
  }
  return out;
}

const first = <T>(a: T | null | undefined, b: T | null | undefined): T | null =>
  a !== null && a !== undefined ? a : b ?? null;

/**
 * One record per trader. Every field keeps the first non-null value it was
 * given; per-window maps are merged window by window. `rank` and `rankChange`
 * are dropped - they belong to the slice a row came from, not to the trader.
 */
export function mergeRows(rows: readonly TraderRow[]): TraderRow[] {
  const byKey = new Map<string, TraderRow>();
  for (const r of rows) {
    if (!r || typeof r.address !== 'string' || !r.address) continue;
    const k = keyOf(r);
    const prev = byKey.get(k);
    if (!prev) {
      const { rank: _rank, rankChange: _rc, ...rest } = r;
      byKey.set(k, {
        ...rest,
        address: r.address.toLowerCase(),
        pnl: { ...r.pnl },
        roi: { ...r.roi },
        volume: { ...r.volume },
      });
      continue;
    }
    const tags = [...new Set([...(prev.tags ?? []), ...(r.tags ?? [])])];
    byKey.set(k, {
      ...prev,
      label: first(prev.label, r.label),
      accountId: first(prev.accountId, r.accountId),
      accountValue: first(prev.accountValue, r.accountValue),
      pnl: mergeWindows(prev.pnl, r.pnl),
      roi: mergeWindows(prev.roi, r.roi),
      volume: mergeWindows(prev.volume, r.volume),
      winRate: first(prev.winRate, r.winRate),
      trades: first(prev.trades, r.trades),
      maxDrawdown: first(prev.maxDrawdown, r.maxDrawdown),
      sharpe: first(prev.sharpe, r.sharpe),
      lastActive: Math.max(prev.lastActive ?? 0, r.lastActive ?? 0) || null,
      spark: (r.spark?.length ?? 0) > (prev.spark?.length ?? 0) ? r.spark : prev.spark,
      tags: tags.length ? tags : prev.tags,
    });
  }
  return [...byKey.values()];
}

/* ---------------------------------------------------------------------------
 * Cutting segments.
 * ------------------------------------------------------------------------ */

/**
 * Top `perVenue` of each venue by the segment's score, merged into one list
 * sorted by that score. `rank` is the position in the merged list.
 */
export function cutSegment(def: SegmentDef, rows: readonly TraderRow[], perVenue = SEGMENT_ROWS_PER_VENUE): ExploreSegment {
  const scored = rows
    .map((r) => ({ r, s: def.score(r) }))
    .filter((x): x is { r: TraderRow; s: number } => x.s !== null && Number.isFinite(x.s))
    .sort((a, b) => b.s - a.s || a.r.address.localeCompare(b.r.address));

  const taken = new Map<Venue, number>();
  const kept: TraderRow[] = [];
  for (const { r } of scored) {
    const n = taken.get(r.venue) ?? 0;
    if (n >= perVenue) continue;
    taken.set(r.venue, n + 1);
    kept.push({ ...r, rank: kept.length + 1 });
  }
  return { id: def.id, title: def.title, subtitle: def.subtitle, rows: kept };
}

export function buildSegments(rows: readonly TraderRow[], perVenue = SEGMENT_ROWS_PER_VENUE): ExploreSegment[] {
  const pool = mergeRows(rows);
  return SEGMENTS.map((def) => cutSegment(def, pool, perVenue));
}

/* ---------------------------------------------------------------------------
 * Asking the venues.
 * ------------------------------------------------------------------------ */

interface VenueHarvest {
  venue: Venue;
  pages: LeaderboardPage[];
  errors: unknown[];
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

async function harvest(p: VenueProvider): Promise<VenueHarvest> {
  // Indexed by slice, so the merge below sees the pages in slice order however
  // the requests happened to finish - "first non-null wins" must mean the same
  // thing on every build.
  const pages: Array<LeaderboardPage | undefined> = [];
  const errors: unknown[] = [];

  const ask = async (i: number): Promise<boolean> => {
    const q = EXPLORE_SLICES[i]!;
    try {
      const page = await withTimeout(
        Promise.resolve().then(() => p.leaderboard(q)),
        EXPLORE_SLICE_TIMEOUT_MS,
        `${p.venue} leaderboard ${q.sort}/${q.window}`,
      );
      if (page && Array.isArray(page.rows)) pages[i] = page;
      return true;
    } catch (e) {
      errors.push(e);
      return false;
    }
  };

  // The first slice alone: it warms the provider's cache for the rest. And
  // "not built yet" there means the venue has no leaderboard at all - asking it
  // six more times would only collect six more copies of the same refusal.
  if (!(await ask(0)) && errors[0] instanceof NotAvailable) {
    return { venue: p.venue, pages: [], errors };
  }

  let next = 1;
  const worker = async () => {
    while (next < EXPLORE_SLICES.length) await ask(next++);
  };
  await Promise.all(
    Array.from({ length: Math.min(EXPLORE_SLICE_CONCURRENCY, EXPLORE_SLICES.length - 1) }, worker),
  );
  return { venue: p.venue, pages: pages.filter((x): x is LeaderboardPage => !!x), errors };
}

/** Pure assembly from what the venues answered. Exported for tests. */
export function assemble(harvests: readonly VenueHarvest[], now = Date.now()): ExploreResponse {
  const live = harvests.filter((h) => h.pages.length > 0);
  if (!live.length) {
    const errors = harvests.flatMap((h) => h.errors);
    const msg = errors.map((e) => (e instanceof Error ? e.message : String(e))).join('; ')
      || 'no venue answered';
    if (errors.every((e) => e instanceof NotAvailable)) throw new NotAvailable(`explore: ${msg}`);
    throw new Error(`explore: ${msg}`);
  }

  const rows = live.flatMap((h) => h.pages.flatMap((p) => p.rows.map((r) => ({ ...r, venue: h.venue }))));
  const pool = mergeRows(rows);

  // A venue's slices can disagree on `total` (SoDEX counts ranked accounts per
  // window), so each venue contributes its largest, i.e. everyone it tracks.
  const tracked = live.reduce(
    (sum, h) => sum + Math.max(0, ...h.pages.map((p) => (Number.isFinite(p.total) ? p.total : 0))),
    0,
  );

  // Summed over the traders we actually hold, so it is the top traders' 24h
  // volume, not the venue's. null when no row carries a 1D volume at all.
  let volume24h: number | null = null;
  for (const r of pool) {
    const v = volOf(r, '1d');
    if (v !== null) volume24h = (volume24h ?? 0) + v;
  }

  // The OLDEST snapshot among the answers - a page is only as fresh as its
  // stalest input (SoDEX's leaderboard is an hourly snapshot).
  const stamps = live.flatMap((h) => h.pages.map((p) => p.updatedAt)).filter((t) => Number.isFinite(t) && t > 0);
  const updatedAt = stamps.length ? Math.min(now, ...stamps) : now;

  return {
    kpis: { tracked, volume24h, venues: live.map((h) => h.venue) },
    segments: SEGMENTS.map((def) => cutSegment(def, pool)),
    updatedAt,
  };
}

/* ---------------------------------------------------------------------------
 * Cache.
 * ------------------------------------------------------------------------ */

interface CacheEntry {
  key: string;
  /** Last good answer and when it was built. */
  value?: ExploreResponse;
  at: number;
  /** Last failed build and when it failed. */
  error?: unknown;
  errorAt?: number;
}

let cached: CacheEntry | null = null;
let pending: { key: string; promise: Promise<ExploreResponse> } | null = null;

/** Tests only. */
export function resetExploreCache(): void {
  cached = null;
  pending = null;
}

function rebuild(key: string, providers: readonly VenueProvider[]): Promise<ExploreResponse> {
  if (pending && pending.key === key) return pending.promise;
  const promise = (async () => {
    const harvests = await Promise.all(providers.map((p) => harvest(p)));
    try {
      const value = assemble(harvests);
      cached = { key, value, at: Date.now() };
      return value;
    } catch (e) {
      // A failed rebuild does not throw away a good answer that is still within
      // its stale window; it only records when to try again.
      const keep = cached?.key === key ? cached : null;
      cached = { key, value: keep?.value, at: keep?.at ?? 0, error: e, errorAt: Date.now() };
      throw e;
    }
  })();
  pending = { key, promise };
  promise.then(
    () => { if (pending?.promise === promise) pending = null; },
    () => { if (pending?.promise === promise) pending = null; },
  );
  return promise;
}

/**
 * Fresh for EXPLORE_TTL_MS. After that, and up to EXPLORE_STALE_MAX_MS, the
 * last answer is served at once while a rebuild runs behind it - a rebuild
 * waits on every venue's slowest slice (SoDEX's pool rankings take seconds),
 * and no caller should wait for that just because a minute passed.
 */
export async function buildExplore(providers: readonly VenueProvider[]): Promise<ExploreResponse> {
  const key = providers.map((p) => p.venue).join(',');
  const now = Date.now();
  const c = cached && cached.key === key ? cached : null;
  const recentlyFailed = c?.errorAt !== undefined && now - c.errorAt < EXPLORE_FAIL_TTL_MS;

  if (c?.value) {
    const age = now - c.at;
    if (age < EXPLORE_TTL_MS) return c.value;
    if (age < EXPLORE_STALE_MAX_MS) {
      if (!recentlyFailed) rebuild(key, providers).catch(() => { /* recorded in the cache */ });
      return c.value;
    }
  }
  if (recentlyFailed) throw c!.error;
  return rebuild(key, providers);
}

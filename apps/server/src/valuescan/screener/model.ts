/**
 * Trader screener: the pure half. Strategy classification, activity buckets,
 * the query parser, filters, presets and the sort. Nothing here does I/O, so
 * every rule the palette's Screener shows is pinned by a unit test
 * (test/valuescan-screener.test.ts), and the web app can import these types
 * through the `@sign` alias without pulling in a provider.
 *
 * `null` MEANS UNKNOWN, NEVER ZERO. The venues' leaderboards carry PnL, ROI,
 * volume and account value; win rate, trade count, last fill, drawdown and
 * open positions only arrive once the background enricher (enrich.ts) has read
 * that trader's profile. A filter on an unknown value EXCLUDES the row (the
 * screener cannot vouch for it), and a sort puts unknowns last in both
 * directions, so "sort by win rate" never ranks a trader nobody measured.
 */
import { labelMatches, shownLabel } from '../labels.js';
import { MIN_ROI_CAPITAL_USD, RISING_MIN_PNL_USD, RISING_MIN_SHARE, roiCapital } from '../explore.js';
import type { TraderProfile, TraderRow, Venue, Window } from '../types.js';
import { WINDOWS } from '../types.js';

/* ---------------------------------------------------------------------------
 * Vocabulary.
 * ------------------------------------------------------------------------ */

/** How a trader trades: one per trader, or null when nothing says. */
export type Style = 'scalper' | 'intraday' | 'swing' | 'position';
/** What else is true of them: any number per trader. */
export type Trait = 'whale' | 'high-leverage' | 'vault';
export type Strategy = Style | Trait;

export const STYLES: readonly Style[] = ['scalper', 'intraday', 'swing', 'position'];
export const TRAITS: readonly Trait[] = ['whale', 'high-leverage', 'vault'];
export const STRATEGIES: readonly Strategy[] = [...STYLES, ...TRAITS];

export const STRATEGY_LABEL: Record<Strategy, string> = {
  scalper: 'Scalper',
  intraday: 'Intraday',
  swing: 'Swing',
  position: 'Position',
  'high-leverage': 'High leverage',
  whale: 'Whale',
  vault: 'Vault',
};

export type PresetId = 'all' | 'consistent' | 'high-winrate' | 'whales' | 'low-drawdown' | 'rising' | 'most-active';
export const PRESET_IDS: readonly PresetId[] = [
  'all', 'consistent', 'high-winrate', 'whales', 'low-drawdown', 'rising', 'most-active',
];

export type ScreenerSort = 'pnl' | 'roi' | 'volume' | 'winRate' | 'accountValue' | 'lastActive';
export const SCREENER_SORTS: readonly ScreenerSort[] = ['pnl', 'roi', 'volume', 'winRate', 'accountValue', 'lastActive'];

/** The "Last active" filter's choices. */
export type ActiveSpan = '1h' | '24h' | '7d' | '30d';
export const ACTIVE_SPANS: readonly ActiveSpan[] = ['1h', '24h', '7d', '30d'];

/** The tightest leaderboard window a trader is known to have traded in. */
export type ActiveBucket = '1d' | '7d' | '30d';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const SPAN_MS: Record<ActiveSpan, number> = { '1h': HOUR, '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY };
const BUCKET_MS: Record<ActiveBucket, number> = { '1d': DAY, '7d': 7 * DAY, '30d': 30 * DAY };

/* ---------------------------------------------------------------------------
 * Enrichment: what one trader() read adds to a leaderboard row.
 * ------------------------------------------------------------------------ */

export interface Enrichment {
  /** When the profile was read (ms). */
  at: number;
  /** The venue answered "no such trader". Everything else is null then. */
  missing: boolean;
  /** From the profile's sample (valuescan/winRate.ts): exact only when the sample is the whole history. */
  winRate: number | null;
  winRateExact?: boolean;
  winRateCloses?: number | null;
  winRateFrom?: number | null;
  trades: number | null;
  lastActive: number | null;
  maxDrawdown: number | null;
  accountValue: number | null;
  /** Open positions right now. */
  positions: number | null;
  /** Highest leverage among the open positions. */
  maxLeverage: number | null;
  openNotional: number | null;
  tags: string[];
}

const fin = (v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

export function enrichmentFromProfile(p: TraderProfile | null, at: number): Enrichment {
  if (!p) {
    return {
      at, missing: true, winRate: null, trades: null, lastActive: null, maxDrawdown: null,
      accountValue: null, positions: null, maxLeverage: null, openNotional: null, tags: [],
    };
  }
  const s = p.summary;
  const levs = p.positions.map((x) => fin(x.leverage)).filter((x): x is number => x !== null);
  return {
    at,
    missing: false,
    winRate: fin(s.winRate),
    winRateExact: s.winRateExact ?? false,
    winRateCloses: fin(s.winRateCloses),
    winRateFrom: fin(s.winRateFrom),
    trades: fin(s.trades),
    lastActive: fin(s.lastActive),
    maxDrawdown: fin(s.maxDrawdown),
    accountValue: fin(s.accountValue),
    positions: p.positions.length,
    maxLeverage: levs.length ? Math.max(...levs) : null,
    openNotional: p.positions.reduce((t, x) => t + (fin(x.notional) ?? 0), 0),
    tags: Array.isArray(s.tags) ? s.tags.filter((t) => typeof t === 'string') : [],
  };
}

/* ---------------------------------------------------------------------------
 * The row the screener answers with.
 * ------------------------------------------------------------------------ */

export interface ScreenerRow extends TraderRow {
  strategy: Style | null;
  traits: Trait[];
  positions: number | null;
  maxLeverage: number | null;
  activeWithin: ActiveBucket | null;
  /** The same address also appears in this pool on these other venues. */
  alsoOn: Venue[];
  /** When the background enricher last read this trader, null = not yet. */
  enrichedAt: number | null;
}

/* ---------------------------------------------------------------------------
 * Strategy classification.
 *
 * STYLE, first rule that applies:
 *  1. The venue MEASURED it. SoDEX tags a trader scalper / intraday / swing
 *     from the median hold time of their last 200 closed positions (at least
 *     20 of them; < 15 min scalper, >= 24 h swing, between intraday). That is
 *     the only direct evidence of holding time any venue gives, so it wins.
 *  2. Turnover = 30D volume / account value, when the account holds at least
 *     MIN_TURNOVER_ACCOUNT_USD (below that the ratio is noise). How many times
 *     a month someone trades their whole account is what separates the styles
 *     when hold times are not published (Hyperliquid):
 *        >= 1000x  scalper   (e.g. 10x leverage, ~20 round trips a day)
 *        >=  150x  intraday  (e.g. 5x, a few round trips a day)
 *        >=   15x  swing     (e.g. 3x, a round trip every few days)
 *        <    15x  position  (holds for weeks)
 *     No 30D volume at all is `position` if they hold something open right
 *     now (a holder who has not traded), else no style (a dormant account).
 *  3. Otherwise null - shown as a dash, never guessed.
 *
 * TRAITS, all that apply:
 *  - whale:          the venue says so, or account value >= WHALE_USD;
 *  - high-leverage:  the venue says so, or an open position at >= 20x;
 *  - vault:          the venue says most of the account sits in a vault.
 * ------------------------------------------------------------------------ */

export const WHALE_USD = 1_000_000;
export const HIGH_LEVERAGE = 20;
export const MIN_TURNOVER_ACCOUNT_USD = 1_000;
export const TURNOVER_SCALPER = 1000;
export const TURNOVER_INTRADAY = 150;
export const TURNOVER_SWING = 15;

export interface ClassifyInput {
  tags?: string[] | null;
  accountValue: number | null;
  volume: Partial<Record<Window, number | null>>;
  positions?: number | null;
  maxLeverage?: number | null;
}

export function classify(r: ClassifyInput): { strategy: Style | null; traits: Trait[] } {
  const tags = new Set(r.tags ?? []);
  let strategy: Style | null = STYLES.find((s) => tags.has(s)) ?? null;

  if (!strategy) {
    const av = fin(r.accountValue);
    const vol = fin(r.volume['30d']);
    if (av !== null && av >= MIN_TURNOVER_ACCOUNT_USD && vol !== null) {
      if (vol > 0) {
        const turnover = vol / av;
        strategy =
          turnover >= TURNOVER_SCALPER ? 'scalper'
          : turnover >= TURNOVER_INTRADAY ? 'intraday'
          : turnover >= TURNOVER_SWING ? 'swing'
          : 'position';
      } else if ((r.positions ?? 0) > 0) {
        strategy = 'position';
      }
    }
  }

  const traits: Trait[] = [];
  if (tags.has('whale') || (fin(r.accountValue) ?? 0) >= WHALE_USD) traits.push('whale');
  if (tags.has('high-leverage') || (fin(r.maxLeverage) ?? 0) >= HIGH_LEVERAGE) traits.push('high-leverage');
  if (tags.has('vault')) traits.push('vault');
  return { strategy, traits };
}

/* ---------------------------------------------------------------------------
 * Activity.
 * ------------------------------------------------------------------------ */

/**
 * The tightest window the trader is KNOWN to have traded in. Volume in a
 * leaderboard window is proof of a fill inside it (HL and SoDEX both publish
 * rolling windows as of their hourly snapshot); an exact last fill from the
 * enricher is proof too. Whichever is tighter wins. null = no evidence.
 */
export function activeBucket(
  r: { volume: Partial<Record<Window, number | null>>; lastActive?: number | null },
  now: number,
): ActiveBucket | null {
  let best: ActiveBucket | null = null;
  const tighter = (b: ActiveBucket) => {
    if (!best || BUCKET_MS[b] < BUCKET_MS[best]) best = b;
  };
  for (const b of ['1d', '7d', '30d'] as const) {
    const v = fin(r.volume[b]);
    if (v !== null && v > 0) {
      tighter(b);
      break;
    }
  }
  const la = fin(r.lastActive);
  if (la !== null) {
    const age = now - la;
    if (age <= DAY) tighter('1d');
    else if (age <= 7 * DAY) tighter('7d');
    else if (age <= 30 * DAY) tighter('30d');
  }
  return best;
}

/**
 * DORMANT = known NOT to have traded in 30 days: the venue reports exactly zero
 * 30D volume, nothing tighter says otherwise, no fill in 30 days and nothing
 * open. There is nothing to copy from such an account, however large its PnL
 * (Hyperliquid's 30D PnL top is led by $1B accounts with zero volume; SoDEX's
 * by vault depositors), so the screener hides them unless `dormant=1`.
 * Unknown volume is NOT dormant - unknown never counts as zero.
 */
export function isDormant(r: ScreenerRow): boolean {
  return fin(r.volume['30d']) === 0 && r.activeWithin === null && !((r.positions ?? 0) > 0);
}

/** Last active within `span`? Exact timestamps decide; a bucket only when it fits inside the span. */
export function activeWithinSpan(r: ScreenerRow, span: ActiveSpan, now: number): boolean {
  const la = fin(r.lastActive);
  if (la !== null && now - la <= SPAN_MS[span]) return true;
  const b = r.activeWithin;
  return b !== null && BUCKET_MS[b] <= SPAN_MS[span];
}

/**
 * Sort key for "last active": the exact last fill when known, else the
 * earliest moment the bucket allows (a row known to have traded within 24h
 * ranks above an exact fill 2 days ago - correctly, it is the more recent).
 */
export function recencyKey(r: ScreenerRow, now: number): number | null {
  const la = fin(r.lastActive);
  const floor = r.activeWithin ? now - BUCKET_MS[r.activeWithin] : null;
  if (la !== null && floor !== null) return Math.max(la, floor);
  return la ?? floor;
}

/* ---------------------------------------------------------------------------
 * Building rows.
 * ------------------------------------------------------------------------ */

/** Row fields win over the enrichment (the leaderboard is the fresher figure); lastActive takes the later. */
export function toScreenerRow(r: TraderRow, e: Enrichment | undefined, alsoOn: Venue[], now: number): ScreenerRow {
  const live = e && !e.missing ? e : undefined;
  const pick = <T>(a: T | null | undefined, b: T | null | undefined): T | null =>
    a !== null && a !== undefined ? a : b ?? null;
  const tags = [...new Set([...(r.tags ?? []), ...(live?.tags ?? [])])];
  const lastActive = Math.max(fin(r.lastActive) ?? 0, live?.lastActive ?? 0) || null;
  const accountValue = pick(fin(r.accountValue), live?.accountValue);
  // The win rate travels with its provenance: the row's own (the index, over the
  // window) first, else the enricher's sample - never a bare number.
  const own = fin(r.winRate) !== null;
  const wr = own
    ? { winRate: fin(r.winRate), winRateExact: r.winRateExact ?? false, winRateCloses: fin(r.winRateCloses), winRateFrom: fin(r.winRateFrom) }
    : { winRate: live?.winRate ?? null, winRateExact: live?.winRateExact ?? false, winRateCloses: live?.winRateCloses ?? null, winRateFrom: live?.winRateFrom ?? null };
  const base = {
    venue: r.venue,
    address: r.address,
    label: shownLabel(r.address, r.label),
    accountId: r.accountId ?? null,
    accountValue,
    pnl: { ...r.pnl },
    roi: { ...r.roi },
    volume: { ...r.volume },
    ...wr,
    trades: pick(fin(r.trades), live?.trades),
    maxDrawdown: pick(fin(r.maxDrawdown), live?.maxDrawdown),
    lastActive,
    tags,
    rankChange: r.rankChange ?? null,
  };
  const positions = live?.positions ?? null;
  const maxLeverage = live?.maxLeverage ?? null;
  const { strategy, traits } = classify({ tags, accountValue, volume: base.volume, positions, maxLeverage });
  return {
    ...base,
    strategy,
    traits,
    positions,
    maxLeverage,
    activeWithin: activeBucket(base, now),
    alsoOn,
    enrichedAt: e ? e.at : null,
  };
}

/* ---------------------------------------------------------------------------
 * The query.
 * ------------------------------------------------------------------------ */

export interface ScreenerQuery {
  view: 'traders' | 'assets';
  preset: PresetId;
  /** Address prefix (with or without 0x) or label substring, lower-case. */
  q: string | null;
  /** Fraction 0..1. */
  minWinRate: number | null;
  volWindow: Window;
  minVolume: number | null;
  minAccountValue: number | null;
  /** Window of the PnL / ROI sort, filter and column. */
  window: Window;
  /** Fraction, 0.1 = +10%. */
  minRoi: number | null;
  strategies: Strategy[];
  active: ActiveSpan | null;
  /** Include accounts known not to have traded in 30 days (see isDormant). */
  dormant: boolean;
  sort: ScreenerSort;
  dir: 'asc' | 'desc';
  limit: number;
  offset: number;
}

const numParam = (v: string | undefined): number | null => {
  if (v === undefined || v.trim() === '' || v === 'any') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const oneOf = <T extends string>(v: string | undefined, list: readonly T[]): T | null =>
  v !== undefined && (list as readonly string[]).includes(v) ? (v as T) : null;

function intParam(v: string | undefined, dflt: number, min: number, max: number): number {
  const n = v === undefined || v === '' ? dflt : Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

export const SCREENER_MAX_LIMIT = 500;

/** Parse the route's query. Unknown or malformed values fall back to "no filter", never to a 400. */
export function parseScreenerQuery(q: Record<string, string | undefined>): ScreenerQuery {
  const preset = oneOf(q.preset, PRESET_IDS) ?? 'all';
  const def = PRESETS[preset];
  const winPct = numParam(q.minWinRate);
  const roiPct = numParam(q.minRoi);
  const text = (q.q ?? '').trim().toLowerCase();
  return {
    view: q.view === 'assets' ? 'assets' : 'traders',
    preset,
    q: text ? text : null,
    minWinRate: winPct === null ? null : Math.min(100, Math.max(0, winPct)) / 100,
    volWindow: oneOf(q.volWindow, WINDOWS) ?? '1d',
    minVolume: numParam(q.minVolume),
    minAccountValue: numParam(q.minAccountValue),
    window: oneOf(q.window, WINDOWS) ?? def.window ?? '30d',
    minRoi: roiPct === null ? null : roiPct / 100,
    strategies: (q.strategy ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is Strategy => (STRATEGIES as readonly string[]).includes(s)),
    active: oneOf(q.active, ACTIVE_SPANS),
    dormant: q.dormant === '1' || q.dormant === 'true',
    sort: oneOf(q.sort, SCREENER_SORTS) ?? def.sort,
    dir: q.dir === 'asc' ? 'asc' : 'desc',
    limit: intParam(q.limit, 100, 1, SCREENER_MAX_LIMIT),
    offset: intParam(q.offset, 0, 0, 1_000_000),
  };
}

/* ---------------------------------------------------------------------------
 * Presets. Each is a condition plus the sort it opens with; an explicit
 * `sort` / `window` in the query overrides the preset's.
 * ------------------------------------------------------------------------ */

export const HIGH_WINRATE = 0.6;
/** Fewer closed trades than this and a win rate is an anecdote. */
export const HIGH_WINRATE_MIN_TRADES = 10;
export const LOW_DRAWDOWN = 0.15;

interface PresetDef {
  label: string;
  sort: ScreenerSort;
  window?: Window;
  test: (r: ScreenerRow) => boolean;
}

const val = fin;

export const PRESETS: Record<PresetId, PresetDef> = {
  all: { label: 'All', sort: 'pnl', test: () => true },
  consistent: {
    label: 'Consistent winners',
    sort: 'pnl',
    // Profitable over 7D, 30D and all time - the Explore page's "Consistent".
    test: (r) => (val(r.pnl['7d']) ?? 0) > 0 && (val(r.pnl['30d']) ?? 0) > 0 && (val(r.pnl.all) ?? 0) > 0,
  },
  'high-winrate': {
    label: 'High win rate',
    sort: 'winRate',
    test: (r) =>
      r.winRate !== null && r.winRate !== undefined && r.winRate >= HIGH_WINRATE
      && (r.trades === null || r.trades === undefined || r.trades >= HIGH_WINRATE_MIN_TRADES),
  },
  whales: {
    label: 'Whales',
    sort: 'accountValue',
    test: (r) => (val(r.accountValue) ?? 0) >= WHALE_USD || r.traits.includes('whale'),
  },
  'low-drawdown': {
    label: 'Low drawdown',
    sort: 'pnl',
    test: (r) =>
      r.maxDrawdown !== null && r.maxDrawdown !== undefined && r.maxDrawdown <= LOW_DRAWDOWN
      && (val(r.pnl['30d']) ?? 0) > 0,
  },
  rising: {
    label: 'Rising stars',
    sort: 'pnl',
    window: '7d',
    // Same rule as Explore's "Rising": 7D PnL is at least half of a positive all-time PnL.
    test: (r) => {
      const d7 = val(r.pnl['7d']);
      const all = val(r.pnl.all);
      return d7 !== null && all !== null && d7 >= RISING_MIN_PNL_USD && all > 0 && d7 >= RISING_MIN_SHARE * all;
    },
  },
  'most-active': {
    label: 'Most active',
    sort: 'volume',
    test: (r) => r.activeWithin === '1d' || (val(r.volume['7d']) ?? 0) > 0,
  },
};

/* ---------------------------------------------------------------------------
 * Filtering and sorting.
 * ------------------------------------------------------------------------ */

export function matchesText(r: { address: string; label?: string | null; accountId?: number | null }, text: string): boolean {
  const s = text.trim().toLowerCase();
  if (!s) return true;
  const bare = s.startsWith('0x') ? s.slice(2) : s;
  if (bare && /^[0-9a-f]+$/.test(bare) && r.address.toLowerCase().slice(2).startsWith(bare)) return true;
  if (/^\d+$/.test(s) && r.accountId !== null && r.accountId !== undefined && String(r.accountId) === s) return true;
  return labelMatches(r.address, r.label, s);
}

export function passes(r: ScreenerRow, q: ScreenerQuery, now: number): boolean {
  if (!q.dormant && isDormant(r)) return false;
  if (!PRESETS[q.preset].test(r)) return false;
  if (q.q && !matchesText(r, q.q)) return false;
  if (q.minWinRate !== null && !(r.winRate !== null && r.winRate !== undefined && r.winRate >= q.minWinRate)) return false;
  if (q.minVolume !== null && !((val(r.volume[q.volWindow]) ?? Number.NEGATIVE_INFINITY) >= q.minVolume)) return false;
  if (q.minAccountValue !== null && !((val(r.accountValue) ?? Number.NEGATIVE_INFINITY) >= q.minAccountValue)) return false;
  if (q.minRoi !== null && !((val(r.roi[q.window]) ?? Number.NEGATIVE_INFINITY) >= q.minRoi)) return false;
  if (q.strategies.length && !q.strategies.some((s) => r.strategy === s || r.traits.includes(s as Trait))) return false;
  if (q.active && !activeWithinSpan(r, q.active, now)) return false;
  return true;
}

/**
 * The value a row sorts by, or null (sorted last in both directions).
 * ROI on an account whose ROI rests on less than MIN_ROI_CAPITAL_USD is null
 * here - Explore's rule: a $100 start funded to $4M afterwards shows
 * +4,487,527% and is useless for choosing whom to copy. The row still shows.
 */
export function sortValue(r: ScreenerRow, q: Pick<ScreenerQuery, 'sort' | 'window' | 'volWindow'>, now: number): number | null {
  switch (q.sort) {
    case 'pnl': return val(r.pnl[q.window]);
    case 'roi': {
      const roi = val(r.roi[q.window]);
      if (roi === null) return null;
      const cap = q.window === '30d' ? roiCapital(r) : val(r.accountValue);
      return cap !== null && cap >= MIN_ROI_CAPITAL_USD ? roi : null;
    }
    case 'volume': return val(r.volume[q.volWindow]);
    case 'winRate': return val(r.winRate);
    case 'accountValue': return val(r.accountValue);
    case 'lastActive': return recencyKey(r, now);
  }
}

export function sortRows(rows: ScreenerRow[], q: Pick<ScreenerQuery, 'sort' | 'dir' | 'window' | 'volWindow'>, now: number): ScreenerRow[] {
  const sign = q.dir === 'asc' ? 1 : -1;
  const keyed = rows.map((r) => ({ r, v: sortValue(r, q, now) }));
  keyed.sort((a, b) => {
    if (a.v === null || b.v === null) {
      if (a.v === b.v) return a.r.address.localeCompare(b.r.address) || a.r.venue.localeCompare(b.r.venue);
      return a.v === null ? 1 : -1;
    }
    return (a.v - b.v) * sign || a.r.address.localeCompare(b.r.address) || a.r.venue.localeCompare(b.r.venue);
  });
  return keyed.map((k) => k.r);
}

/* ---------------------------------------------------------------------------
 * view=assets: one Hyperliquid market (built in assets.ts).
 * ------------------------------------------------------------------------ */

/** Hyperliquid market for the palette's Assets tab; see assets.ts. */
export interface HlAsset {
  venue: 'hyperliquid';
  /** HL coin name: "BTC", or "xyz:GOLD" on a HIP-3 dex. */
  symbol: string;
  /** "" for the default dex. */
  dex: string;
  price: number | null;
  /** Percent, 1.5 = +1.5%, against HL's prevDayPx. */
  changePct: number | null;
  /** 24h notional volume, USD. */
  volume24h: number | null;
  /** Open interest in USD at the mark price. */
  openInterestUsd: number | null;
  /** Hourly funding rate as HL publishes it (fraction). */
  funding: number | null;
  maxLeverage: number | null;
}

/* ---------------------------------------------------------------------------
 * The response.
 * ------------------------------------------------------------------------ */

export interface ScreenerResponse {
  rows: ScreenerRow[];
  /** Rows matching every filter, before paging. */
  total: number;
  /** Traders in the pool for the requested venues, before filters. */
  poolSize: number;
  /** Pool rows hidden as dormant (0 when `dormant=1`). */
  dormant: number;
  /** Pool rows the enricher has read. */
  enrichedCount: number;
  /** Oldest snapshot among the venues that answered. */
  updatedAt: number;
  /** Venues that answered. */
  venues: Venue[];
  /** Venues that were asked and failed. */
  partial?: Venue[];
  preset: PresetId;
  sort: ScreenerSort;
  dir: 'asc' | 'desc';
  window: Window;
  volWindow: Window;
}

/** Filter, sort and page an already-built pool. */
export function screen(
  rows: readonly ScreenerRow[],
  q: ScreenerQuery,
  now: number,
): { rows: ScreenerRow[]; total: number } {
  const hit = sortRows(rows.filter((r) => passes(r, q, now)), q, now);
  return { rows: hit.slice(q.offset, q.offset + q.limit), total: hit.length };
}

/**
 * The leaderboard page's view state, and the few pure helpers its table needs.
 *
 * THE URL IS THE VIEW. `?venues=&side=&mode=&window=&sort=&q=&page=&rows=`
 * round-trips through `parseView` / `writeView`, so "Hyperliquid, inverse,
 * 7D, page 3" is a link you can paste. The older `?venue=` still reads. Only NON-DEFAULT values are written: the bare
 * `/leaderboard` a nav click produces stays bare, and a shared link says only
 * what differs from it.
 *
 * Kept free of React and of runtime imports so it can be tested with
 * `npx tsx --test` without a DOM.
 */
import type { BoardWindow, LeaderboardSort, TraderRow, Venue, Window } from '../../vsApi';
import { formatNumber } from '../../intlCache';
import { localize } from '../../numStyle';

/** Every venue the leaderboard can show, in display order. */
export const LB_VENUES: readonly Venue[] = ['sodex', 'hyperliquid', 'tradexyz', 'lighter', 'arcus'];
/** The leaderboard or its inverse (worst first). */
export type LbSide = 'top' | 'worst';
/** With several venues: one row per address summed over them, or each venue's rows side by side. */
export type LbMode = 'net' | 'single';
/** 24h, 7d, 30d and all time come from the venues. 90d and YTD are ranked by the server index. */
export const LB_WINDOWS: readonly BoardWindow[] = ['1d', '7d', '30d', '90d', 'ytd', 'all'];
export const LB_SORTS: readonly LeaderboardSort[] = ['pnl', 'roi', 'volume', 'accountValue'];

/** Same wording as the Stats leaderboard's window control ("All time", not "All"). */
export const WINDOW_LABEL: Record<BoardWindow, string> = {
  '1d': '24h',
  '7d': '7d',
  '30d': '30d',
  '90d': '90d',
  ytd: 'YTD',
  all: 'All time',
};

export const SORT_LABEL: Record<LeaderboardSort, string> = {
  pnl: 'PnL',
  roi: 'ROI',
  volume: 'Volume',
  accountValue: 'Account value',
};

/** Rows per page. The route accepts 1..500; three steps is all a picker needs. */
export const PAGE_SIZES = [25, 50, 100] as const;

export interface LbView {
  /** Selected venues, never empty, in LB_VENUES order. */
  venues: Venue[];
  side: LbSide;
  mode: LbMode;
  window: BoardWindow;
  sort: LeaderboardSort;
  /** Trimmed search text; '' = no filter. */
  q: string;
  /** 1-based. */
  page: number;
  rows: number;
}

/**
 * 30D by PnL across every venue: the question someone choosing a trader to
 * copy asks first. Matches the route's own defaults (window=30d, sort=pnl).
 */
export const DEFAULT_VIEW: LbView = {
  venues: [...LB_VENUES],
  side: 'top',
  mode: 'net',
  window: '30d',
  sort: 'pnl',
  q: '',
  page: 1,
  rows: 50,
};

/** Upper bound on a search string carried in a URL. Addresses are 42. */
const MAX_Q = 64;
const MAX_PAGE = 1_000_000;

/** A venue list from `venues=a,b` (or the older `venue=a|all`), canonical order, never empty. */
function venuesOf(p: URLSearchParams, defaults: Venue[]): Venue[] {
  const raw = p.get('venues') ?? p.get('venue');
  if (raw === null) return defaults;
  if (raw.toLowerCase() === 'all') return [...LB_VENUES];
  const want = new Set(raw.toLowerCase().split(',').map((s) => s.trim()));
  const list = LB_VENUES.filter((v) => want.has(v));
  return list.length ? list : defaults;
}

const sameVenues = (a: readonly Venue[], b: readonly Venue[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

const oneOf = <T extends string>(list: readonly T[], v: string | null): T | undefined =>
  v !== null && (list as readonly string[]).includes(v.toLowerCase()) ? (v.toLowerCase() as T) : undefined;

/**
 * Read a view from `location.search`. Anything missing or invalid falls back
 * to `defaults`, so a hand-edited or stale link degrades to a sane page rather
 * than to an error. `accountValue` is the one mixed-case value and is matched
 * case-insensitively like the rest.
 */
export function parseView(search: string, defaults: LbView = DEFAULT_VIEW): LbView {
  const p = new URLSearchParams(search);
  const sortRaw = p.get('sort');
  const sort = LB_SORTS.find((s) => s.toLowerCase() === sortRaw?.toLowerCase());
  const pageN = Number.parseInt(p.get('page') ?? '', 10);
  const rowsN = Number.parseInt(p.get('rows') ?? '', 10);
  return {
    venues: venuesOf(p, defaults.venues),
    side: p.get('side')?.toLowerCase() === 'worst' ? 'worst' : p.get('side')?.toLowerCase() === 'top' ? 'top' : defaults.side,
    mode: p.get('mode')?.toLowerCase() === 'single' ? 'single' : p.get('mode')?.toLowerCase() === 'net' ? 'net' : defaults.mode,
    window: oneOf(LB_WINDOWS, p.get('window')) ?? defaults.window,
    sort: sort ?? defaults.sort,
    q: (p.get('q') ?? defaults.q).trim().slice(0, MAX_Q),
    page: Number.isFinite(pageN) && pageN >= 1 ? Math.min(pageN, MAX_PAGE) : defaults.page,
    rows: (PAGE_SIZES as readonly number[]).includes(rowsN) ? rowsN : defaults.rows,
  };
}

const KEYS = ['venue', 'venues', 'side', 'mode', 'window', 'sort', 'q', 'page', 'rows'] as const;

/**
 * Write a view into an existing query string and return the new one
 * (with its leading `?`, or '' when nothing is left).
 *
 * Parameters this page does not own are kept as they are. Defaults are left
 * out, and `rows` is compared against the viewer's own stored page size
 * (`defaults.rows`), because that is what a link without it will open with.
 */
export function writeView(search: string, v: LbView, defaults: LbView = DEFAULT_VIEW): string {
  const p = new URLSearchParams(search);
  for (const k of KEYS) p.delete(k);
  if (!sameVenues(v.venues, defaults.venues)) p.set('venues', v.venues.join(','));
  if (v.side !== defaults.side) p.set('side', v.side);
  if (v.mode !== defaults.mode) p.set('mode', v.mode);
  if (v.window !== defaults.window) p.set('window', v.window);
  if (v.sort !== defaults.sort) p.set('sort', v.sort);
  if (v.q) p.set('q', v.q);
  if (v.page > 1) p.set('page', String(v.page));
  if (v.rows !== defaults.rows) p.set('rows', String(v.rows));
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Last page for a total, never below 1 (an empty ranking still has page 1). */
export const lastPageOf = (total: number | undefined, rows: number): number =>
  total && total > 0 && rows > 0 ? Math.max(1, Math.ceil(total / rows)) : 1;

/** A number the venue actually reported, or null. `undefined`, NaN and Infinity are "not reported". */
export const reported = (v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** The figure a row is ranked by, for the current window. */
export function metricOf(row: TraderRow, sort: LeaderboardSort, window: Window): number | null {
  switch (sort) {
    case 'accountValue':
      return reported(row.accountValue);
    case 'pnl':
      return reported(row.pnl[window]);
    case 'roi':
      return reported(row.roi[window]);
    case 'volume':
      return reported(row.volume[window]);
  }
}

/** U+2212, the same minus format.ts uses, so signed columns stay one stripe. */
const MINUS = '−';
const DASH = '—';

/**
 * ROI as a signed percentage. The contract carries a FRACTION (0.12 = +12%).
 *
 * Explicit `+` and a real minus sign, unlike `fmtPct` - in a column where
 * direction matters the sign is the non-colour carrier, and the hyphen that
 * `toFixed` produces is half the width of a `+`. Zero gets no sign.
 */
export function fmtRoi(v: number | null | undefined, dp = 2): string {
  const n = reported(v);
  if (n === null) return DASH;
  const pct = n * 100;
  const en = formatNumber(Math.abs(pct), 'en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const body = localize(en);
  if (Number(en.replace(/,/g, '')) === 0) return body + '%';
  return `${pct > 0 ? '+' : MINUS}${body}%`;
}

/**
 * Rank movement since the previous snapshot. Positive `rankChange` means the
 * trader moved UP. 0 and "not reported" both render nothing: a flat marker on
 * every row is noise, and an unknown change must not read as "no change".
 */
export function rankMove(rc: number | null | undefined): { dir: 'up' | 'down'; n: number } | null {
  const n = reported(rc);
  if (n === null || n === 0) return null;
  return { dir: n > 0 ? 'up' : 'down', n: Math.abs(Math.round(n)) };
}

/**
 * The rank marker's tooltip and label: "Since <local time>" of the snapshot
 * compared against (`index.rankSince`); without one, just the direction.
 */
export function rankMoveText(
  m: { dir: 'up' | 'down'; n: number },
  since: number | null | undefined,
  fmt: (ms: number) => string = (ms) => new Date(ms).toLocaleString(),
): { title: string; label: string } {
  const at = reported(since);
  const when = at !== null && at > 0 ? `Since ${fmt(at)}` : null;
  const moved = `${m.dir === 'up' ? 'Up' : 'Down'} ${m.n} ${m.n === 1 ? 'place' : 'places'}`;
  return { title: when ?? moved, label: when ? `${moved}, ${when.toLowerCase()}` : moved };
}

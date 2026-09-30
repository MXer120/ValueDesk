/**
 * Pure logic for the search / Cmd+K palette: formatting, the identicon, address
 * parsing, the screener query each tab sends, the Assets rows, and the small
 * localStorage lists (recent searches, recently viewed, watchlist).
 *
 * No React and no fetch here, so all of it runs under
 *   npx tsx --test src/components/palette/model.test.ts
 *
 * Screener types come from the server through the `@sign` alias (types only:
 * nothing of the server is bundled).
 */
import type {
  ActiveSpan,
  HlAsset,
  PresetId,
  ScreenerRow,
  ScreenerSort,
  Strategy,
} from '@sign/valuescan/screener/model.js';
import { sizeCohort, type CohortId, type CohortMarket, type MapSector } from '@sign/valuescan/cohorts/model.js';
import type { Positioning, TraderRow, Venue, Window } from '../../vsApi';
import { DASH, MINUS } from '../../format';
import { formatNumber } from '../../intlCache';

export type { ActiveSpan, HlAsset, PresetId, ScreenerRow, ScreenerSort, Strategy };

/* ---------------------------------------------------------------------------
 * Tabs.
 * ------------------------------------------------------------------------ */

export type PaletteTab = 'home' | 'traders' | 'screener' | 'assets';
export const PALETTE_TABS: readonly PaletteTab[] = ['home', 'traders', 'screener', 'assets'];
export const TAB_LABEL: Record<PaletteTab, string> = {
  home: 'Home',
  traders: 'Traders',
  screener: 'Screener',
  assets: 'Assets',
};

/** Next / previous tab, wrapping. */
export function cycleTab(t: PaletteTab, dir: 1 | -1): PaletteTab {
  const i = PALETTE_TABS.indexOf(t);
  return PALETTE_TABS[(i + dir + PALETTE_TABS.length) % PALETTE_TABS.length]!;
}

/* ---------------------------------------------------------------------------
 * Numbers.
 * ------------------------------------------------------------------------ */

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** $860k, $1.2M, $13.6M, $4.9B, $950, $0. */
export function fmtUsdCompact(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  const a = Math.abs(v);
  const sign = v < 0 ? MINUS : '';
  const body =
    a >= 1e9 ? `${trim(a / 1e9, a >= 1e11 ? 0 : 1)}B`
    : a >= 1e6 ? `${trim(a / 1e6, a >= 1e8 ? 0 : 1)}M`
    : a >= 1e3 ? `${trim(a / 1e3, a >= 1e5 ? 0 : 1)}k`
    : `${Math.round(a)}`;
  return `${sign}$${body}`;
}

/** Signed: +$80.9k / −$1.2M / $0. */
export function fmtUsdSigned(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  if (v === 0) return '$0';
  return v > 0 ? `+${fmtUsdCompact(v)}` : fmtUsdCompact(v);
}

function trim(n: number, dp: number): string {
  return n.toFixed(dp).replace(/\.0+$/, '');
}

/** Fraction -> signed percent: 0.0816 -> +8.16%. Very large ROIs lose their decimals. */
export function fmtFracPct(v: number | null | undefined, dp = 2): string {
  if (!isNum(v)) return DASH;
  const p = v * 100;
  const d = Math.abs(p) >= 1000 ? 0 : Math.abs(p) >= 100 ? 1 : dp;
  const body = formatNumber(Math.abs(p), 'en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  return `${p > 0 ? '+' : p < 0 ? MINUS : ''}${body}%`;
}

/** Win rate fraction -> "64%". */
export function fmtWinRate(v: number | null | undefined): string {
  return isNum(v) ? `${Math.round(v * 100)}%` : DASH;
}

/** Percent number (already x100) -> "+1.52%". */
export function fmtChangePct(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  return `${v > 0 ? '+' : v < 0 ? MINUS : ''}${Math.abs(v).toFixed(2)}%`;
}

/** A price with sensible precision for its size. */
export function fmtPriceAuto(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  const a = Math.abs(v);
  const dp = a >= 1000 ? 1 : a >= 100 ? 2 : a >= 1 ? 3 : a >= 0.01 ? 5 : 7;
  return formatNumber(v, 'en-US', { minimumFractionDigits: a >= 1000 ? 0 : Math.min(dp, 2), maximumFractionDigits: dp });
}

export const signOf = (v: number | null | undefined): 'pos' | 'neg' | '' =>
  isNum(v) ? (v > 0 ? 'pos' : v < 0 ? 'neg' : '') : '';

/* ---------------------------------------------------------------------------
 * Time.
 * ------------------------------------------------------------------------ */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "now", "5m ago", "3h ago", "2d ago", then a date. */
export function fmtAgo(ms: number | null | undefined, now: number): string {
  if (!isNum(ms) || ms <= 0) return DASH;
  const d = Math.max(0, now - ms);
  if (d < MIN) return 'now';
  if (d < HOUR) return `${Math.floor(d / MIN)}m ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h ago`;
  if (d < 30 * DAY) return `${Math.floor(d / DAY)}d ago`;
  return new Date(ms).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
}

const BUCKET_LABEL: Record<'1d' | '7d' | '30d', string> = { '1d': '< 24h', '7d': '< 7d', '30d': '< 30d' };
const BUCKET_SPAN: Record<'1d' | '7d' | '30d', number> = { '1d': DAY, '7d': 7 * DAY, '30d': 30 * DAY };

/**
 * The Last active cell: the exact last fill when known, else the tightest
 * window with volume. When both are known the MORE RECENT one wins - the same
 * rule as the server's recencyKey, so the cell and "sort by last active" agree:
 * a sampled fill from 3 weeks ago next to volume in the last 24h shows "< 24h".
 */
export function lastActiveLabel(r: Pick<ScreenerRow, 'lastActive' | 'activeWithin'> | TraderRow, now: number): string {
  const la = (r as ScreenerRow).lastActive;
  const b = (r as Partial<ScreenerRow>).activeWithin ?? null;
  if (isNum(la) && la > 0) {
    if (b && now - la > BUCKET_SPAN[b]) return BUCKET_LABEL[b];
    return fmtAgo(la, now);
  }
  return b ? BUCKET_LABEL[b] : DASH;
}

/* ---------------------------------------------------------------------------
 * Addresses.
 * ------------------------------------------------------------------------ */

const FULL = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/;

/** The first full 0x address anywhere in the text (a pasted explorer URL works too), lower-case. */
export function extractAddress(text: string): string | null {
  const m = FULL.exec(text);
  return m ? m[0].toLowerCase() : null;
}

/** "0x1234" style prefix, at least 4 hex digits: worth an address-prefix search. */
export const isAddressPrefix = (text: string): boolean => /^0x[0-9a-fA-F]{4,39}$/.test(text.trim());

export const shortAddress = (a: string): string => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

/* ---------------------------------------------------------------------------
 * Identicon: a 5x5 mirrored grid and a hue, both from the address bytes, so the
 * same wallet always gets the same face.
 * ------------------------------------------------------------------------ */

/** FNV-1a over the lower-cased address. */
function hash32(s: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface IdenticonSpec {
  hue: number;
  /** 25 cells, row-major, mirrored left/right. */
  cells: boolean[];
}

export function identicon(address: string): IdenticonSpec {
  const a = address.toLowerCase();
  const h1 = hash32(a);
  const h2 = hash32(a, 0x9e3779b9);
  const cells: boolean[] = [];
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 5; x++) {
      const col = x < 3 ? x : 4 - x; // mirror
      const bit = y * 3 + col; // 15 bits
      cells.push(((h2 >>> bit) & 1) === 1);
    }
  }
  // Never an empty face.
  if (!cells.some(Boolean)) cells[12] = true;
  return { hue: h1 % 360, cells };
}

/** A market's letter avatar hue, from the coin name. */
export const coinHue = (coin: string): number => hash32(coin.toUpperCase()) % 360;

/* ---------------------------------------------------------------------------
 * Filters -> screener query.
 * ------------------------------------------------------------------------ */

export interface VenueToggles {
  sodex: boolean;
  hyperliquid: boolean;
}

export const venueParam = (v: VenueToggles): Venue | 'all' =>
  v.sodex && v.hyperliquid ? 'all' : v.sodex ? 'sodex' : 'hyperliquid';

/** SoDEX rows first (the venue Valuescan trades on), each group keeping its order. */
export function sodexFirst<T extends { venue: Venue }>(rows: readonly T[]): T[] {
  return [...rows.filter((r) => r.venue === 'sodex'), ...rows.filter((r) => r.venue !== 'sodex')];
}

/**
 * Alternate the venues, SoDEX first, each keeping its own order, up to `n`
 * rows. A both-venue "top by PnL" list is otherwise all Hyperliquid: its top
 * accounts are two orders of magnitude larger than SoDEX's.
 */
export function interleaveVenues<T extends { venue: Venue }>(rows: readonly T[], n: number): T[] {
  // One list per venue, in the palette's venue order (SoDEX first), each in its own order.
  const order = [...PALETTE_VENUES, ...new Set(rows.map((r) => r.venue).filter((v) => !PALETTE_VENUES.includes(v)))];
  const lists = order.map((v) => rows.filter((r) => r.venue === v)).filter((l) => l.length);
  const out: T[] = [];
  for (let i = 0; out.length < n && lists.some((l) => i < l.length); i++) {
    for (const l of lists) if (i < l.length && out.length < n) out.push(l[i]!);
  }
  return out;
}

/** Flip one venue, never leaving both off. */
export function toggleVenue(v: VenueToggles, which: Venue): VenueToggles {
  if (which !== 'sodex' && which !== 'hyperliquid') return v;
  const next = { ...v, [which]: !v[which] };
  return next.sodex || next.hyperliquid ? next : v;
}

/** Filters on the Home and Traders tabs (the 3.png chip row). */
export interface ListFilters {
  /** Percent. */
  minWinRate: number | null;
  volWindow: Window;
  minVolume: number | null;
  strategy: Strategy | null;
  active: ActiveSpan | null;
}

export const DEFAULT_LIST_FILTERS: ListFilters = {
  minWinRate: null,
  volWindow: '1d',
  minVolume: null,
  strategy: null,
  active: null,
};

/** Filters on the Screener tab (the 4.png dropdown row). */
export interface ScreenerFilters {
  preset: PresetId;
  minWinRate: number | null;
  volWindow: Window;
  minVolume: number | null;
  minAccountValue: number | null;
  /** Percent over `window`. */
  minRoi: number | null;
  window: Window;
  /** null = the preset's own sort. */
  sort: ScreenerSort | null;
  dir: 'asc' | 'desc';
}

export const DEFAULT_SCREENER_FILTERS: ScreenerFilters = {
  preset: 'all',
  minWinRate: null,
  volWindow: '1d',
  minVolume: null,
  minAccountValue: null,
  minRoi: null,
  window: '30d',
  sort: null,
  dir: 'desc',
};

/** The sort each preset opens with - mirrors PRESETS in the server's screener/model.ts. */
export const PRESET_SORT: Record<PresetId, { sort: ScreenerSort; window?: Window }> = {
  all: { sort: 'pnl' },
  consistent: { sort: 'pnl' },
  'high-winrate': { sort: 'winRate' },
  whales: { sort: 'accountValue' },
  'low-drawdown': { sort: 'pnl' },
  rising: { sort: 'pnl', window: '7d' },
  'most-active': { sort: 'volume' },
};

type Params = Record<string, string>;

const put = (p: Params, k: string, v: string | number | null | undefined) => {
  if (v !== null && v !== undefined && v !== '') p[k] = String(v);
};

export function listQuery(
  f: ListFilters,
  venues: VenueToggles,
  o: { q?: string; sort?: ScreenerSort; window?: Window; limit?: number; offset?: number } = {},
): Params {
  const p: Params = {};
  put(p, 'venue', venueParam(venues));
  put(p, 'q', o.q?.trim());
  put(p, 'minWinRate', f.minWinRate);
  put(p, 'volWindow', f.volWindow !== '1d' || f.minVolume !== null ? f.volWindow : null);
  put(p, 'minVolume', f.minVolume);
  put(p, 'strategy', f.strategy);
  put(p, 'active', f.active);
  put(p, 'sort', o.sort);
  put(p, 'window', o.window);
  put(p, 'limit', o.limit);
  put(p, 'offset', o.offset || null);
  return p;
}

export function screenerQuery(f: ScreenerFilters, venues: VenueToggles, o: { q?: string; limit?: number; offset?: number } = {}): Params {
  const p: Params = {};
  put(p, 'venue', venueParam(venues));
  put(p, 'q', o.q?.trim());
  put(p, 'preset', f.preset !== 'all' ? f.preset : null);
  put(p, 'minWinRate', f.minWinRate);
  put(p, 'volWindow', f.volWindow);
  put(p, 'minVolume', f.minVolume);
  put(p, 'minAccountValue', f.minAccountValue);
  put(p, 'minRoi', f.minRoi);
  put(p, 'window', f.sort !== null || f.window !== '30d' ? f.window : null);
  put(p, 'sort', f.sort);
  put(p, 'dir', f.dir !== 'desc' ? f.dir : null);
  put(p, 'limit', o.limit);
  put(p, 'offset', o.offset || null);
  return p;
}

export const toSearch = (p: Params): string => {
  const s = new URLSearchParams(Object.entries(p).sort(([a], [b]) => a.localeCompare(b))).toString();
  return s ? `?${s}` : '';
};

/** The sort the screener is using: the explicit one, else the preset's. */
export function effectiveSort(f: ScreenerFilters): { sort: ScreenerSort; window: Window } {
  const d = PRESET_SORT[f.preset];
  return { sort: f.sort ?? d.sort, window: f.sort === null && d.window ? d.window : f.window };
}

/* ---------------------------------------------------------------------------
 * Assets: SoDEX markets + Hyperliquid markets + top-trader positioning.
 * ------------------------------------------------------------------------ */

export interface AssetRow {
  key: string;
  venue: Venue;
  /** SoDEX engine; null for Hyperliquid. */
  engine: 'spot' | 'perps' | null;
  /** SoDEX symbol name ("BTC-USD") or HL coin ("BTC", "xyz:GOLD"). */
  symbol: string;
  display: string;
  base: string;
  /** The venue's own spelling of the base coin (SoDEX "vQQQ"), for its icon; `base` is upper-cased for matching. */
  coin?: string;
  kind: 'perp' | 'spot';
  maxLeverage: number | null;
  price: number | null;
  changePct: number | null;
  volume24h: number | null;
  /** Share of the tracked top traders' notional that is long, 0..1, null = no data. */
  longShare: number | null;
  netUsd: number | null;
  traders: number | null;
  tickSize?: string;
}

/** Base coin of a positioning / market symbol: "BTC-USD" -> BTC, "xyz:GOLD" -> GOLD, "SOL_USDC" -> SOL. */
export function baseOf(symbol: string): string {
  const s = symbol.includes(':') ? symbol.split(':')[1]! : symbol;
  return s.split(/[-_/]/)[0]!.toUpperCase();
}

/** Net positioning per (venue, base coin), summed. */
export function positioningIndex(rows: readonly Positioning[]): Map<string, { long: number; short: number; traders: number }> {
  const m = new Map<string, { long: number; short: number; traders: number }>();
  for (const r of rows) {
    const k = `${r.venue}:${r.symbol.includes(':') ? r.symbol.toUpperCase() : baseOf(r.symbol)}`;
    const cur = m.get(k) ?? { long: 0, short: 0, traders: 0 };
    cur.long += isNum(r.longUsd) ? r.longUsd : 0;
    cur.short += isNum(r.shortUsd) ? r.shortUsd : 0;
    cur.traders += (isNum(r.longTraders) ? r.longTraders : 0) + (isNum(r.shortTraders) ? r.shortTraders : 0);
    m.set(k, cur);
  }
  return m;
}

export function withPositioning(a: AssetRow, idx: Map<string, { long: number; short: number; traders: number }>): AssetRow {
  if (a.kind !== 'perp') return a;
  const k = `${a.venue}:${a.symbol.includes(':') ? a.symbol.toUpperCase() : a.base}`;
  const p = idx.get(k);
  if (!p || p.long + p.short <= 0) return a;
  return { ...a, longShare: p.long / (p.long + p.short), netUsd: p.long - p.short, traders: p.traders };
}

export function hlAssetRow(h: HlAsset): AssetRow {
  const display = h.symbol.includes(':') ? h.symbol.split(':')[1]! : h.symbol;
  return {
    key: `hyperliquid:${h.symbol}`,
    venue: 'hyperliquid',
    engine: null,
    symbol: h.symbol,
    display,
    base: baseOf(h.symbol),
    kind: 'perp',
    maxLeverage: h.maxLeverage,
    price: h.price,
    changePct: h.changePct,
    volume24h: h.volume24h,
    longShare: null,
    netUsd: null,
    traders: null,
  };
}

export type AssetCategory = 'all' | 'favorites' | 'perps' | 'spot' | 'stocks' | 'commodities';
export type AssetSort = 'volume' | 'change' | 'price' | 'positioning';

/** Same client-kept class lists as SymbolSearch.tsx (the API carries no asset class). */
const COMMODITY = new Set(['XAUT', 'SILVER', 'COPPER', 'CL', 'LIT', 'GOLD', 'PAXG', 'OIL', 'NATGAS', 'PLATINUM', 'PALLADIUM']);
const INDEX = new Set(['US500', 'USTECH100', 'XYZ100', 'SPX', 'NDX']);
const STOCK = new Set([
  'AAPL', 'AMD', 'AMZN', 'COIN', 'CRCL', 'EWY', 'GOOGL', 'HOOD', 'INTC', 'META', 'MRVL', 'MSFT',
  'MSTR', 'MU', 'NVDA', 'ORCL', 'PLTR', 'SAMSUNG', 'SNDK', 'SPCX', 'TSLA', 'TSM', 'UNITREE', 'ZHIPU', 'NFLX', 'BABA',
]);

export function assetClassOf(base: string): 'stocks' | 'commodities' | 'crypto' {
  const b = base.toUpperCase();
  if (COMMODITY.has(b)) return 'commodities';
  if (STOCK.has(b) || INDEX.has(b)) return 'stocks';
  return 'crypto';
}

export function filterAssets(
  rows: readonly AssetRow[],
  o: { category: AssetCategory; venues: VenueToggles; q: string; favorites: readonly string[] },
): AssetRow[] {
  const q = o.q.trim().toUpperCase();
  return rows.filter((r) => {
    if (!o.venues[r.venue as keyof VenueToggles]) return false;
    if (o.category === 'favorites' && !o.favorites.includes(r.key)) return false;
    if (o.category === 'perps' && r.kind !== 'perp') return false;
    if (o.category === 'spot' && r.kind !== 'spot') return false;
    if (o.category === 'stocks' && assetClassOf(r.base) !== 'stocks') return false;
    if (o.category === 'commodities' && assetClassOf(r.base) !== 'commodities') return false;
    if (q && !r.display.toUpperCase().includes(q) && !r.base.includes(q) && !r.symbol.toUpperCase().includes(q)) return false;
    return true;
  });
}

export function sortAssets(rows: readonly AssetRow[], sort: AssetSort, dir: 'asc' | 'desc'): AssetRow[] {
  const key = (r: AssetRow): number | null =>
    sort === 'volume' ? r.volume24h
    : sort === 'change' ? r.changePct
    : sort === 'price' ? r.price
    : r.longShare === null ? null : r.longShare - 0.5;
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (x === null || !Number.isFinite(x) || y === null || !Number.isFinite(y)) {
      const xn = x === null || !Number.isFinite(x);
      const yn = y === null || !Number.isFinite(y);
      if (xn && yn) return a.key.localeCompare(b.key);
      return xn ? 1 : -1;
    }
    return (x - y) * sign || a.key.localeCompare(b.key);
  });
}

/* ---------------------------------------------------------------------------
 * Local lists. Every read and write is guarded: private mode, a full quota or
 * blocked storage must never break the palette - it just forgets.
 * ------------------------------------------------------------------------ */

export const LS_RECENT_SEARCHES = 'vs.palette.recentSearches';
export const LS_RECENT_TRADERS = 'vs.palette.recentTraders';
export const LS_WATCHLIST = 'vs.palette.watchlist';

/**
 * A remembered trader (watchlist, recently viewed): venue, address and time.
 * No name is stored or shown.
 */
export interface TraderRef {
  venue: Venue;
  address: string;
  at: number;
}

export function readList<T>(key: string, storage: Pick<Storage, 'getItem'> | null = safeStorage()): T[] {
  try {
    const raw = storage?.getItem(key);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

export function writeList<T>(key: string, list: readonly T[], storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(key, JSON.stringify(list));
  } catch {
    /* quota / private mode: non-fatal */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Put `item` first, drop older copies (same key), cap the length. */
export function pushFront<T>(list: readonly T[], item: T, keyOf: (t: T) => string, max: number): T[] {
  const k = keyOf(item);
  return [item, ...list.filter((x) => keyOf(x) !== k)].slice(0, max);
}

export const traderKey = (t: { venue: Venue; address: string }): string => `${t.venue}:${t.address.toLowerCase()}`;

/** A valid-looking TraderRef from storage (anything else is dropped). */
export function isTraderRef(v: unknown): v is TraderRef {
  const t = v as TraderRef;
  return !!t && PALETTE_VENUES.includes(t.venue) && typeof t.address === 'string' && /^0x[0-9a-f]{40}$/i.test(t.address);
}

/** A stored list read back: valid entries only, and only venue, address and time - an old `label` is dropped. */
export function readTraderRefs(list: readonly unknown[]): TraderRef[] {
  return list.filter(isTraderRef).map((t) => ({ venue: t.venue, address: t.address.toLowerCase(), at: typeof t.at === 'number' ? t.at : 0 }));
}

/* ---------------------------------------------------------------------------
 * The visible box (phones: on-screen keyboard, page wider than the screen).
 * ------------------------------------------------------------------------ */

export interface ViewportBox {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Where a full-screen sheet has to sit so the user can see all of it, or null
 * when the layout viewport (what `position: fixed; inset: 0` fills) already IS
 * what is visible. `vv` is window.visualViewport; `layout` is the measured
 * size of a `position: fixed; inset: 0` box - like the visual viewport it
 * excludes scrollbars, so on a desktop the two always agree. Pinch-zoom also
 * shrinks the visual viewport; the sheet must not chase that, so any scale
 * other than 1 is null.
 */
export function visibleViewportBox(
  vv: { scale: number; offsetTop: number; offsetLeft: number; width: number; height: number },
  layout: { width: number; height: number },
): ViewportBox | null {
  if (Math.abs(vv.scale - 1) > 0.01) return null;
  const differs =
    vv.offsetTop >= 1 || vv.offsetLeft >= 1 || layout.height - vv.height >= 1 || layout.width - vv.width >= 1;
  if (!differs) return null;
  return {
    top: Math.round(vv.offsetTop),
    left: Math.round(vv.offsetLeft),
    width: Math.round(vv.width),
    height: Math.round(vv.height),
  };
}

/* ---------------------------------------------------------------------------
 * Home's market map: every asset the tracked wallets hold, as one treemap.
 * ------------------------------------------------------------------------ */

/**
 * The map's sectors flattened into one list of assets for a single treemap
 * (at the palette's size a sector frame would leave no room for the tiles).
 * A coin listed under two sectors is merged into one tile; assets nobody holds
 * are dropped (a zero-area tile cannot be laid out); biggest gross exposure
 * (long + short) first, which is the order squarify expects.
 */
export function flattenMapAssets(sectors: readonly Pick<MapSector, 'assets'>[]): CohortMarket[] {
  const by = new Map<string, CohortMarket>();
  for (const s of sectors) {
    for (const m of s.assets) {
      if (!(m.long >= 0) || !(m.short >= 0)) continue;
      const cur = by.get(m.coin);
      if (cur) {
        by.set(m.coin, { ...cur, long: cur.long + m.long, short: cur.short + m.short, upnl: cur.upnl + m.upnl, holders: cur.holders + m.holders });
      } else {
        by.set(m.coin, { ...m });
      }
    }
  }
  return [...by.values()]
    .filter((m) => m.long + m.short > 0)
    .sort((a, b) => b.long + b.short - (a.long + a.short) || a.coin.localeCompare(b.coin));
}

/** Long / short notional over the whole map, and the share that is long (null when nothing is held). */
export function mapTotals(assets: readonly Pick<CohortMarket, 'long' | 'short'>[]): { long: number; short: number; longShare: number | null } {
  let long = 0;
  let short = 0;
  for (const a of assets) {
    long += a.long;
    short += a.short;
  }
  const gross = long + short;
  return { long, short, longShare: gross > 0 ? long / gross : null };
}

/* ---------------------------------------------------------------------------
 * Links into Explore's cohort pages (Cohorts.tsx reads these parameters).
 * ------------------------------------------------------------------------ */

export const COHORTS_PATH = '/explore?view=cohorts';
export const MARKET_MAP_PATH = '/explore?view=cohorts&section=map';

/** The market map's page for one asset: `/explore?view=cohorts&section=map&focus=coin:BTC`. */
export function cohortAssetPath(coin: string): string {
  const c = coin.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c ? `${MARKET_MAP_PATH}&focus=coin:${c}` : MARKET_MAP_PATH;
}

/** A trader's account-size cohort (Apex, Whale, ...), from account value; null when unknown or empty. */
export function traderSizeCohort(accountValue: number | null | undefined): CohortId | null {
  return isNum(accountValue) ? sizeCohort(accountValue) : null;
}

/* ---------------------------------------------------------------------------
 * Traders on every venue Scan reads.
 *
 * SoDEX and Hyperliquid come from the server's screener pool (win rate,
 * strategy, positions, last active). trade.xyz, Lighter and Arcus come from
 * their leaderboards (vsApi.leaderboard, as the leaderboard page reads them):
 * PnL, volume, account value and win rate (an estimate counts as a value).
 * A filter on a figure a leaderboard row does not carry (strategy, last
 * active, a preset) HIDES that venue's rows and says so; it is never guessed.
 * ------------------------------------------------------------------------ */

/** The venues the palette offers, in chip order. */
export const PALETTE_VENUES: readonly Venue[] = ['sodex', 'hyperliquid', 'tradexyz', 'lighter', 'arcus'];
/** The venues in the screener pool. */
export const POOL_VENUES: readonly Venue[] = ['sodex', 'hyperliquid'];

/** Flip one venue in a selection, never leaving it empty; always in PALETTE_VENUES order. */
export function toggleVenueIn(list: readonly Venue[], v: Venue): Venue[] {
  const on = list.includes(v);
  if (on && list.length === 1) return [...list];
  return PALETTE_VENUES.filter((x) => (x === v ? !on : list.includes(x)));
}

/** A stored selection made valid: known venues only, in order, never empty. */
export function normaliseVenues(list: unknown): Venue[] {
  const known = Array.isArray(list) ? PALETTE_VENUES.filter((v) => list.includes(v)) : [];
  return known.length ? known : [...PALETTE_VENUES];
}

/** The pool part of a selection as the screener's toggles, or null when no pool venue is chosen. */
export function poolToggles(list: readonly Venue[]): VenueToggles | null {
  const t = { sodex: list.includes('sodex'), hyperliquid: list.includes('hyperliquid') };
  return t.sodex || t.hyperliquid ? t : null;
}

/** The chosen venues read from their leaderboards (outside the pool). */
export const boardVenues = (list: readonly Venue[]): Venue[] => list.filter((v) => !POOL_VENUES.includes(v));

export type HiddenBy = 'strategy' | 'last active' | 'preset' | null;

/** A win rate as a percent, estimates included (they are values); null when none is published. */
const winPct = (r: { winRate?: number | null }): number | null => (isNum(r.winRate) ? r.winRate * 100 : null);

const fig = (v: number | null | undefined): number | null => (isNum(v) ? v : null);

/** A leaderboard venue's rows under the list filters (Traders, Home). */
export function boardListRows<T extends TraderRow>(rows: readonly T[], f: ListFilters): { rows: T[]; hiddenBy: HiddenBy } {
  if (f.strategy !== null) return { rows: [], hiddenBy: 'strategy' };
  if (f.active !== null) return { rows: [], hiddenBy: 'last active' };
  return {
    rows: rows.filter((r) =>
      (f.minVolume === null || (fig(r.volume?.[f.volWindow]) ?? -Infinity) >= f.minVolume)
      && (f.minWinRate === null || (winPct(r) ?? -Infinity) >= f.minWinRate)),
    hiddenBy: null,
  };
}

/** A leaderboard venue's rows under the Screener's filters and sort. */
export function boardScreenerRows<T extends TraderRow>(rows: readonly T[], f: ScreenerFilters): { rows: T[]; hiddenBy: HiddenBy } {
  if (f.preset !== 'all') return { rows: [], hiddenBy: 'preset' };
  const { sort, window } = effectiveSort(f);
  const kept = rows.filter((r) => {
    if (f.minVolume !== null && !((fig(r.volume?.[f.volWindow]) ?? -Infinity) >= f.minVolume)) return false;
    if (f.minAccountValue !== null && !((fig(r.accountValue) ?? -Infinity) >= f.minAccountValue)) return false;
    if (f.minRoi !== null && !(((fig(r.roi?.[window]) ?? -Infinity) * 100) >= f.minRoi)) return false;
    if (f.minWinRate !== null && !((winPct(r) ?? -Infinity) >= f.minWinRate)) return false;
    return true;
  });
  const key = (r: T): number | null =>
    sort === 'pnl' ? fig(r.pnl?.[window])
    : sort === 'roi' ? fig(r.roi?.[window])
    : sort === 'volume' ? fig(r.volume?.[f.volWindow])
    : sort === 'accountValue' ? fig(r.accountValue)
    : sort === 'winRate' ? winPct(r)
    : null;
  if (sort === 'lastActive') return { rows: kept, hiddenBy: null };
  const sign = f.dir === 'asc' ? 1 : -1;
  const sorted = kept
    .map((r, i) => ({ r, i, k: key(r) }))
    .sort((a, b) => (a.k === null || b.k === null ? (a.k === null ? 1 : 0) - (b.k === null ? 1 : 0) || a.i - b.i : (a.k - b.k) * sign || a.i - b.i))
    .map((x) => x.r);
  return { rows: sorted, hiddenBy: null };
}

/**
 * The pool's list (already ranked by PnL over `window`, a page at a time) with
 * the leaderboard venues' rows merged in by the same PnL. While the pool has
 * more pages, a board row only joins above the pool's last loaded row, so a
 * later page can never have to slot in above it.
 */
export function mergeByPnl<T extends TraderRow>(pool: readonly T[], boards: readonly T[], window: Window, poolComplete: boolean): T[] {
  const pnl = (r: T) => fig(r.pnl?.[window]);
  const floor = poolComplete || !pool.length ? -Infinity : pool.reduce((m, r) => Math.min(m, pnl(r) ?? Infinity), Infinity);
  const joined = boards.filter((r) => (pnl(r) ?? -Infinity) >= floor || (poolComplete && pnl(r) === null));
  return [...pool, ...joined]
    .map((r, i) => ({ r, i, k: pnl(r) }))
    .sort((a, b) => (a.k === null || b.k === null ? (a.k === null ? 1 : 0) - (b.k === null ? 1 : 0) || a.i - b.i : b.k - a.k || a.i - b.i))
    .map((x) => x.r);
}

/** "trade.xyz, Lighter and Arcus" */
export function venueList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Whether a figure prints as missing (so it is drawn in --dim, not --text). */
export const isMissing = (text: string): boolean => text === DASH || text === '—';

/* ---------------------------------------------------------------------------
 * Filter fields: typed amounts ("250k", "1.5m") and the win-rate tint.
 * ------------------------------------------------------------------------ */

/** Keeps what an amount field accepts: digits, one dot, one k / m / b suffix. */
export function amountInput(raw: string): string {
  const s = raw.toLowerCase().replace(/[$,\s]/g, '');
  const m = /^(\d*)(\.?\d*)([kmb]?)/.exec(s);
  if (!m) return '';
  const [, int = '', frac = '', unit = ''] = m;
  return `${int.slice(0, 12)}${frac.slice(0, 4)}${int || frac ? unit : ''}`;
}

/** "250k" -> 250000, "1.5m" -> 1500000, "" -> null. */
export function parseAmount(text: string): number | null {
  const m = /^(\d*\.?\d*)([kmb]?)$/.exec(text.trim().toLowerCase());
  if (!m || !m[1] || m[1] === '.') return null;
  const n = Number(m[1]) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : m[2] === 'b' ? 1e9 : 1);
  return Number.isFinite(n) ? n : null;
}

/** An amount as the field shows it at rest: 250000 -> "250k", 1500000 -> "1.5m". */
export function fmtAmountInput(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '';
  const unit = n >= 1e9 ? ['b', 1e9] as const : n >= 1e6 ? ['m', 1e6] as const : n >= 1e3 ? ['k', 1e3] as const : ['', 1] as const;
  return `${trimNum(n / unit[1])}${unit[0]}`;
}
const trimNum = (x: number): string => String(Math.round(x * 100) / 100);

/**
 * The tint a win rate earns: toward --neg below 50%, toward --pos above, none
 * at an even 50. `strength` (0..1) grows with the distance from 50.
 */
export function winRateTint(pct: number): { side: 'pos' | 'neg' | null; strength: number } {
  if (!Number.isFinite(pct) || Math.abs(pct - 50) < 1) return { side: null, strength: 0 };
  return { side: pct > 50 ? 'pos' : 'neg', strength: Math.min(1, Math.abs(pct - 50) / 30) };
}

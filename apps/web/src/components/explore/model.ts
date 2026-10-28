/**
 * Explore's pure half: formatting, per-segment columns, venue filtering and the
 * positioning roll-up. No React, no fetch - everything here is a function of
 * its arguments, so the page component only wires data to markup.
 */
import { DASH, MINUS } from '../../format';
import { formatTime } from '../../intlCache';
import { fmtNum } from '../../numStyle';
import type { Positioning, TraderRow, Venue, WhaleTrade } from '../../vsApi';

export type VenueFilter = Venue | 'all';

/** Badge text. The full name travels in the badge's title. */
export const VENUE_SHORT: Record<Venue, string> = { sodex: 'SoDEX', hyperliquid: 'HL', tradexyz: 'XYZ', lighter: 'Lighter', arcus: 'Arcus' };

/* ---------------------------------------------------------------------------
 * Numbers.
 *
 * Signed figures use U+2212 for minus and an explicit `+` for gains, so a
 * right-aligned column of mixed signs lines up on the sign as well as on the
 * digits (see MINUS in format.ts). Compact figures are for scanning a ranking;
 * every cell that uses one carries the exact value in its title.
 * ------------------------------------------------------------------------ */

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

export function fmtUsdShort(v: number | null | undefined, signed = false): string {
  if (!finite(v)) return DASH;
  const abs = Math.abs(v);
  const sign = v < 0 && abs >= 0.5 ? MINUS : signed && v >= 0.5 ? '+' : '';
  const body = abs < 10_000
    ? fmtNum(abs, { maximumFractionDigits: 0 })
    : fmtNum(abs, { notation: 'compact', maximumFractionDigits: abs < 1e6 ? 1 : 2 });
  return `${sign}$${body}`;
}

/** Exact dollars, for titles. */
export function fmtUsdExact(v: number | null | undefined): string | undefined {
  if (!finite(v)) return undefined;
  const sign = v < 0 ? MINUS : '';
  return `${sign}$${fmtNum(Math.abs(v), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** ROI arrives as a fraction (0.12 = +12%). Always signed. */
export function fmtRoi(v: number | null | undefined): string {
  if (!finite(v)) return DASH;
  const pct = v * 100;
  const abs = Math.abs(pct);
  const sign = pct < 0 && abs >= 0.05 ? MINUS : pct >= 0.05 ? '+' : '';
  const dp = abs >= 100 ? 0 : 1;
  return `${sign}${fmtNum(abs, { minimumFractionDigits: dp, maximumFractionDigits: dp })}%`;
}

export function fmtCount(v: number | null | undefined): string {
  return finite(v) ? fmtNum(v, { maximumFractionDigits: 0 }) : DASH;
}

/** A trade price with no tick size to hand: six significant figures. */
export function fmtPx(v: number | null | undefined): string {
  return finite(v) ? fmtNum(v, { maximumSignificantDigits: 6 }) : DASH;
}

/** 24-hour clock, fixed width - a tape column must not change width per row. */
export function fmtClock(ms: number | null | undefined): string {
  if (!finite(ms) || ms <= 0) return DASH;
  return formatTime(ms, 'en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

/** `pos` / `neg` / '' like signClass() in format.ts, and `muted` for a missing figure. */
export const toneOf = (v: number | null | undefined): string =>
  finite(v) ? (v > 0 ? 'pos' : v < 0 ? 'neg' : '') : 'muted';

/* ---------------------------------------------------------------------------
 * Segment columns.
 *
 * Every segment table is Trader + three figures + actions. WHICH three depends
 * on the segment: the column it is ranked by comes first, then the two that put
 * it in context. The window is always in the column head, because "PnL" alone
 * on a page with four windows is a number with no meaning.
 * ------------------------------------------------------------------------ */

export type SegmentId = 'top-pnl' | 'top-roi' | 'consistent' | 'whales' | 'rising' | 'most-active';

export const SEGMENT_IDS: readonly SegmentId[] = [
  'top-pnl', 'top-roi', 'consistent', 'whales', 'rising', 'most-active',
];

/** Used until the server's own title arrives, and if it never does. */
export const SEGMENT_FALLBACK: Record<SegmentId, { title: string; subtitle: string }> = {
  'top-pnl': { title: 'Top PnL 30D', subtitle: 'Ranked by 30D PnL' },
  'top-roi': { title: 'Top ROI 30D', subtitle: 'Capital from $10K, ranked by 30D ROI' },
  consistent: { title: 'Consistent', subtitle: 'Profitable over 7D, 30D and all time' },
  whales: { title: 'Whales', subtitle: 'Largest account value' },
  rising: { title: 'Rising', subtitle: '7D PnL is at least half of all-time PnL' },
  'most-active': { title: 'Most active', subtitle: 'Ranked by 7D volume' },
};

export interface Column {
  key: string;
  head: string;
  value: (r: TraderRow) => number | null;
  kind: 'pnl' | 'roi' | 'usd';
}

const n = (v: number | null | undefined): number | null => (finite(v) ? v : null);

const C = {
  pnl30: { key: 'pnl30', head: 'PnL 30D', kind: 'pnl', value: (r) => n(r.pnl['30d']) },
  pnl7: { key: 'pnl7', head: 'PnL 7D', kind: 'pnl', value: (r) => n(r.pnl['7d']) },
  pnlAll: { key: 'pnlAll', head: 'PnL all', kind: 'pnl', value: (r) => n(r.pnl.all) },
  roi30: { key: 'roi30', head: 'ROI 30D', kind: 'roi', value: (r) => n(r.roi['30d']) },
  value: { key: 'value', head: 'Value', kind: 'usd', value: (r) => n(r.accountValue) },
  vol7: { key: 'vol7', head: 'Vol 7D', kind: 'usd', value: (r) => n(r.volume['7d']) },
} satisfies Record<string, Column>;

export const SEGMENT_COLUMNS: Record<SegmentId, readonly Column[]> = {
  'top-pnl': [C.pnl30, C.roi30, C.value],
  'top-roi': [C.roi30, C.pnl30, C.value],
  consistent: [C.pnl7, C.pnl30, C.pnlAll],
  whales: [C.value, C.pnl30, C.roi30],
  rising: [C.pnl7, C.pnlAll, C.value],
  'most-active': [C.vol7, C.pnl7, C.value],
};

export function fmtCell(col: Column, r: TraderRow): { text: string; tone: string; title?: string } {
  const v = col.value(r);
  if (v === null) return { text: DASH, tone: 'muted' };
  if (col.kind === 'roi') return { text: fmtRoi(v), tone: toneOf(v) };
  if (col.kind === 'pnl') return { text: fmtUsdShort(v, true), tone: toneOf(v), title: fmtUsdExact(v) };
  return { text: fmtUsdShort(v), tone: '', title: fmtUsdExact(v) };
}

/** The server keeps the top N of EACH venue, already in rank order. */
export function rowsFor(rows: readonly TraderRow[], venue: VenueFilter, limit: number): TraderRow[] {
  return (venue === 'all' ? rows : rows.filter((r) => r.venue === venue)).slice(0, limit);
}

/* ---------------------------------------------------------------------------
 * Markets.
 * ------------------------------------------------------------------------ */

/**
 * One market key across venues. SoDEX names perps `BTC-USD`; Hyperliquid names
 * them `BTC`, and prefixes its 1000x contracts with `k` (`kPEPE`) where SoDEX
 * writes `1000PEPE`. Builder-deployed markets (`xyz:TSLA`) are different
 * contracts and keep their prefix, so they never merge with a venue's own.
 */
export function marketKey(symbol: string): string {
  const s = symbol.trim();
  if (s.includes(':')) return s.toUpperCase();
  const base = s.split(/[-_/]/)[0] ?? s;
  const k = /^k[A-Z0-9]/.test(base) ? `1000${base.slice(1)}` : base;
  return k.toUpperCase();
}

/**
 * The SoDEX perps market to open for a symbol from any venue, or null when
 * SoDEX does not list it. `perps` maps an upper-cased base coin to the SoDEX
 * market name (`BTC` -> `BTC-USD`).
 */
export function sodexMarketFor(symbol: string, perps: ReadonlyMap<string, string>): string | null {
  return perps.get(marketKey(symbol)) ?? null;
}

export interface MarketPositioning {
  /** The shared market key (`BTC`, `1000PEPE`, `XYZ:GOLD`). */
  key: string;
  /** What the table prints: the key, except a builder market keeps its own casing (`xyz:GOLD`). */
  label: string;
  venues: Venue[];
  /** One symbol per contributing venue, for opening the market. */
  symbols: string[];
  longUsd: number;
  shortUsd: number;
  longTraders: number;
  shortTraders: number;
}

/** Sum rows per market (across venues when both report it), largest first. */
export function rollUpPositioning(rows: readonly Positioning[], limit = 20): MarketPositioning[] {
  const byKey = new Map<string, MarketPositioning>();
  for (const r of rows) {
    if (!r || typeof r.symbol !== 'string') continue;
    const key = marketKey(r.symbol);
    const m = byKey.get(key) ?? {
      key,
      label: r.symbol.includes(':') ? r.symbol.trim() : key,
      venues: [], symbols: [], longUsd: 0, shortUsd: 0, longTraders: 0, shortTraders: 0,
    };
    if (!m.venues.includes(r.venue)) m.venues.push(r.venue);
    if (!m.symbols.includes(r.symbol)) m.symbols.push(r.symbol);
    m.longUsd += finite(r.longUsd) ? Math.max(0, r.longUsd) : 0;
    m.shortUsd += finite(r.shortUsd) ? Math.max(0, r.shortUsd) : 0;
    m.longTraders += finite(r.longTraders) ? r.longTraders : 0;
    m.shortTraders += finite(r.shortTraders) ? r.shortTraders : 0;
    byKey.set(key, m);
  }
  return [...byKey.values()]
    .filter((m) => m.longUsd + m.shortUsd > 0)
    .sort((a, b) => b.longUsd + b.shortUsd - (a.longUsd + a.shortUsd) || a.key.localeCompare(b.key))
    .slice(0, limit);
}

/** Long share of gross, 0..1; 0.5 when there is nothing on either side. */
export const longShare = (m: Pick<MarketPositioning, 'longUsd' | 'shortUsd'>): number =>
  m.longUsd + m.shortUsd > 0 ? m.longUsd / (m.longUsd + m.shortUsd) : 0.5;

/* ---------------------------------------------------------------------------
 * Tape.
 * ------------------------------------------------------------------------ */

/**
 * Stable React keys for a list of prints. The contract carries no trade id, so
 * the key is the print's own content; two identical prints in the same
 * millisecond get a counter rather than a shared key. Not the list index: every
 * poll prepends, and index keys would remount every row on every poll.
 */
export function tradeKeys(trades: readonly WhaleTrade[]): string[] {
  const seen = new Map<string, number>();
  return trades.map((t) => {
    const base = `${t.venue}:${t.time}:${t.symbol}:${t.side}:${t.px}:${t.sz}`;
    const k = seen.get(base) ?? 0;
    seen.set(base, k + 1);
    return k ? `${base}#${k}` : base;
  });
}

export const WHALE_MIN_OPTIONS = [
  { v: 50_000, label: '$50K' },
  { v: 100_000, label: '$100K' },
  { v: 500_000, label: '$500K' },
  { v: 1_000_000, label: '$1M' },
] as const;

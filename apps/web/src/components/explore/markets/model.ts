/**
 * Explore -> Markets, the pure half: every perp market the page knows (the
 * Hyperliquid screener's default dex and trade.xyz, and SoDEX's own book)
 * folded into one row per market, and the readings the page draws from them -
 * the pulse strip, the sentence over it, the rail's lists, the sectors and the
 * table's filters. No React, no fetch.
 */
import { sectorOf, SECTORS, type Sector } from '@sign/valuedesk/cohorts/model.js';
import type { Venue } from '../../../vsApi';
import { marketKey } from '../model';

/** One market across the venues that list it. */
export interface MarketRow {
  /** Shared key: `BTC`, `1000PEPE`, `XYZ:TSLA`. */
  key: string;
  /** What the page prints: `BTC`, `kPEPE`, `TSLA`. */
  name: string;
  /** The coin the price chart asks Hyperliquid for (`BTC`, `KPEPE`, `TSLA`); null when only SoDEX lists it. */
  chartCoin: string | null;
  /** The SoDEX perp to open on Trade (`BTC-USD`), null when SoDEX does not list it. */
  sodex: string | null;
  sector: Sector;
  /** trade.xyz and SoDEX's stock and index perps. */
  tradfi: boolean;
  venues: Venue[];
  price: number;
  /** 24h change in percent (1.2 = +1.2%). */
  changePct: number | null;
  /** 24h notional volume, summed over venues. */
  volume: number;
  /** Open interest in dollars, summed over venues. */
  oi: number;
  /** Hourly funding rate (the deepest venue's). */
  funding: number | null;
  maxLeverage: number | null;
  /** The tracked wallets' long and short value in this market, when the cohort map has it. */
  long: number | null;
  short: number | null;
  holders: number | null;
}

/** A Hyperliquid screener asset (`/api/vs/screener?view=assets`). */
export interface HlAsset {
  symbol: string;
  dex?: string;
  price?: number;
  changePct?: number;
  volume24h?: number;
  openInterestUsd?: number;
  funding?: number;
  maxLeverage?: number;
}

export interface SodexTickerLike {
  symbol: string;
  lastPx?: string;
  markPrice?: string;
  changePct?: number;
  quoteVolume?: string;
  openInterest?: string;
  fundingRate?: string;
}

export interface SodexSymbolLike {
  name: string;
  status?: string;
  maxLeverage?: number;
  fundingInterval?: number;
}

/** The cohort map's assets (`/api/vs/cohorts/map`): what the tracked wallets hold of a coin. */
export interface HeldAsset {
  coin: string;
  long: number;
  short: number;
  holders: number;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};
const TRADFI: ReadonlySet<Sector> = new Set(['equities', 'indices', 'commodities', 'fx']);

/** `BTC-USD` -> `BTC`; `kPEPE` stays (the page prints it as the venue does). */
const baseOf = (symbol: string) => (symbol.split(/[-_/]/)[0] ?? symbol).trim();

/**
 * One row per market. Hyperliquid's screener comes first (it is the deepest
 * book for most coins); a SoDEX market joins the row with its key, and a SoDEX
 * stock or index perp that trade.xyz also lists joins trade.xyz's row (the same
 * underlying, so one line in the table). What only SoDEX lists gets a row of its own.
 */
export function buildMarkets(
  hl: readonly HlAsset[] | null | undefined,
  tickers: readonly SodexTickerLike[] | null | undefined,
  symbols: readonly SodexSymbolLike[] | null | undefined,
  held?: readonly HeldAsset[] | null,
): MarketRow[] {
  const rows = new Map<string, MarketRow>();
  for (const a of hl ?? []) {
    if (!a || typeof a.symbol !== 'string' || !finite(a.price) || a.price <= 0) continue;
    const xyz = a.dex === 'xyz' || a.symbol.includes(':');
    const name = xyz ? a.symbol.slice(a.symbol.indexOf(':') + 1) : a.symbol;
    const key = marketKey(a.symbol);
    if (rows.has(key)) continue;
    // Hyperliquid's 1000x units (`kPEPE`) are the coin's sector.
    const sector = sectorOf((/^k[A-Z]/.test(name) ? name.slice(1) : name).toUpperCase(), xyz);
    rows.set(key, {
      key,
      name,
      chartCoin: name.toUpperCase(),
      sodex: null,
      sector,
      tradfi: xyz || TRADFI.has(sector),
      venues: [xyz ? 'tradexyz' : 'hyperliquid'],
      price: a.price,
      changePct: finite(a.changePct) ? a.changePct : null,
      volume: finite(a.volume24h) ? Math.max(0, a.volume24h) : 0,
      oi: finite(a.openInterestUsd) ? Math.max(0, a.openInterestUsd) : 0,
      funding: finite(a.funding) ? a.funding : null,
      maxLeverage: finite(a.maxLeverage) ? a.maxLeverage : null,
      long: null,
      short: null,
      holders: null,
    });
  }

  const listed = new Map((symbols ?? []).map((s) => [s.name, s]));
  for (const t of tickers ?? []) {
    if (!t || typeof t.symbol !== 'string') continue;
    const sym = listed.get(t.symbol);
    if (listed.size && (!sym || (sym.status && sym.status !== 'TRADING'))) continue;
    const px = num(t.markPrice) ?? num(t.lastPx);
    if (px === null || px <= 0) continue;
    const base = baseOf(t.symbol);
    const key = marketKey(t.symbol);
    const row = rows.get(key) ?? rows.get(`XYZ:${base.toUpperCase()}`);
    const vol = Math.max(0, num(t.quoteVolume) ?? 0);
    const oi = Math.max(0, (num(t.openInterest) ?? 0) * px);
    if (row) {
      row.sodex = t.symbol;
      row.venues.push('sodex');
      row.volume += vol;
      row.oi += oi;
      continue;
    }
    const sector = sectorOf(base.toUpperCase());
    rows.set(key, {
      key,
      name: base,
      chartCoin: null,
      sodex: t.symbol,
      sector,
      tradfi: TRADFI.has(sector),
      venues: ['sodex'],
      price: px,
      changePct: finite(t.changePct) ? t.changePct : null,
      volume: vol,
      oi,
      // SoDEX states the rate per its own interval; the page reads every rate per hour.
      funding: (() => {
        const rate = num(t.fundingRate);
        const sec = sym?.fundingInterval;
        return rate === null ? null : finite(sec) && sec > 0 ? (rate * 3600) / sec : rate;
      })(),
      maxLeverage: sym?.maxLeverage ?? null,
      long: null,
      short: null,
      holders: null,
    });
  }

  if (held?.length) {
    const byCoin = new Map<string, HeldAsset>();
    for (const h of held) if (h && typeof h.coin === 'string') byCoin.set(h.coin.toUpperCase(), h);
    for (const r of rows.values()) {
      const h = byCoin.get(r.name.toUpperCase()) ?? byCoin.get(r.key);
      if (!h) continue;
      r.long = finite(h.long) ? h.long : null;
      r.short = finite(h.short) ? h.short : null;
      r.holders = finite(h.holders) ? h.holders : null;
    }
  }
  return [...rows.values()].sort((a, b) => b.volume - a.volume || a.key.localeCompare(b.key));
}

/** Funding over a year at this hourly rate, in percent. */
export const fundingApr = (hourly: number | null): number | null => (hourly === null ? null : hourly * 24 * 365 * 100);

/** The tracked wallets' long share of what they hold here (0..1), null when nothing is held. */
export function heldLong(r: Pick<MarketRow, 'long' | 'short'>): number | null {
  const l = r.long ?? 0;
  const s = r.short ?? 0;
  return l + s > 0 ? l / (l + s) : null;
}

/* ---------------------------------------------------------------------------
 * The pulse: the whole board in five figures and one sentence.
 * ------------------------------------------------------------------------ */

export interface Pulse {
  markets: number;
  volume: number;
  oi: number;
  up: number;
  down: number;
  /** Volume-weighted 24h change of every market with one, in percent. */
  avgChange: number | null;
  /** Volume-weighted hourly funding. */
  avgFunding: number | null;
}

export function pulseOf(rows: readonly MarketRow[]): Pulse {
  let volume = 0, oi = 0, up = 0, down = 0, wc = 0, w = 0, wf = 0, wfw = 0;
  for (const r of rows) {
    volume += r.volume;
    oi += r.oi;
    if (r.changePct !== null) {
      if (r.changePct > 0) up++;
      else if (r.changePct < 0) down++;
      wc += r.changePct * r.volume;
      w += r.volume;
    }
    if (r.funding !== null) { wf += r.funding * r.volume; wfw += r.volume; }
  }
  return { markets: rows.length, volume, oi, up, down, avgChange: w > 0 ? wc / w : null, avgFunding: wfw > 0 ? wf / wfw : null };
}

const pct = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(Math.abs(v) >= 10 ? 1 : 2)}%`;

/**
 * One sentence on the day, written from the figures: where the board leans,
 * the biggest market's move, and the biggest mover among the liquid ones.
 * Null when there is nothing to say yet.
 */
export function headline(rows: readonly MarketRow[], liquid = 10_000_000): string | null {
  const p = pulseOf(rows);
  if (!p.markets || p.up + p.down === 0) return null;
  const share = p.up / (p.up + p.down);
  const tone = share >= 0.62 ? 'Risk-on' : share <= 0.38 ? 'Risk-off' : 'Mixed';
  const parts = [`${tone}: ${Math.round(share * 100)}% of ${p.markets.toLocaleString('en-US')} markets are up over 24h`];
  const lead = rows.find((r) => r.changePct !== null);
  if (lead) parts.push(`${lead.name} ${pct(lead.changePct!)}`);
  const mover = rows
    .filter((r) => r.changePct !== null && r.volume >= liquid && r !== lead)
    .sort((a, b) => Math.abs(b.changePct!) - Math.abs(a.changePct!))[0];
  if (mover) parts.push(`${mover.name} moves most among liquid markets (${pct(mover.changePct!)})`);
  return `${parts.join('; ')}.`;
}

/* ---------------------------------------------------------------------------
 * The rail's lists and the table's views.
 * ------------------------------------------------------------------------ */

export type RailList = 'watch' | 'hot' | 'gainers' | 'losers' | 'funding';
export const RAIL_LISTS: ReadonlyArray<{ id: RailList; label: string }> = [
  { id: 'watch', label: 'Watchlist' },
  { id: 'hot', label: 'Hot' },
  { id: 'gainers', label: 'Gainers' },
  { id: 'losers', label: 'Losers' },
  { id: 'funding', label: 'Funding' },
];

/** A move on a market nobody trades is noise: the movers lists start at this much volume. */
export const MOVER_MIN_VOLUME = 1_000_000;

export function railRows(rows: readonly MarketRow[], list: RailList, watch: readonly string[], limit = 12): MarketRow[] {
  const has = (r: MarketRow) => r.changePct !== null;
  switch (list) {
    case 'watch': {
      const by = new Map(rows.map((r) => [r.key, r]));
      return watch.map((k) => by.get(k)).filter((r): r is MarketRow => !!r).slice(0, limit);
    }
    case 'hot': return rows.slice(0, limit);
    case 'gainers': return rows.filter((r) => has(r) && r.changePct! > 0 && r.volume >= MOVER_MIN_VOLUME).sort((a, b) => b.changePct! - a.changePct!).slice(0, limit);
    case 'losers': return rows.filter((r) => has(r) && r.changePct! < 0 && r.volume >= MOVER_MIN_VOLUME).sort((a, b) => a.changePct! - b.changePct!).slice(0, limit);
    case 'funding': return rows.filter((r) => r.funding !== null && r.volume >= MOVER_MIN_VOLUME).sort((a, b) => Math.abs(b.funding!) - Math.abs(a.funding!)).slice(0, limit);
  }
}

export type MarketKind = 'all' | 'crypto' | 'tradfi';
export const MARKET_KINDS: ReadonlyArray<{ id: MarketKind; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'crypto', label: 'Crypto' },
  { id: 'tradfi', label: 'Stocks & macro' },
];

/** The platforms the page reads markets from, for its platform filter. */
export const MARKET_VENUES: readonly Venue[] = ['sodex', 'hyperliquid', 'tradexyz'];

export type MarketSort = 'volume' | 'change' | 'oi' | 'funding' | 'price' | 'held' | 'name';

/** `venues`: a market listed on any of them stays (all of them, or none given: no filter). */
export function filterMarkets(rows: readonly MarketRow[], o: { kind: MarketKind; sector?: Sector | null; q?: string; venues?: readonly Venue[] }): MarketRow[] {
  const q = (o.q ?? '').trim().toUpperCase();
  const venues = o.venues && o.venues.length < MARKET_VENUES.length ? new Set(o.venues) : null;
  return rows.filter((r) => {
    if (o.kind === 'crypto' && r.tradfi) return false;
    if (o.kind === 'tradfi' && !r.tradfi) return false;
    if (venues && !r.venues.some((v) => venues.has(v))) return false;
    if (o.sector && r.sector !== o.sector) return false;
    return !q || r.name.toUpperCase().includes(q) || r.key.includes(q);
  });
}

export function sortMarkets(rows: readonly MarketRow[], sort: MarketSort, dir: 'asc' | 'desc'): MarketRow[] {
  const val = (r: MarketRow): number | string | null => {
    switch (sort) {
      case 'volume': return r.volume;
      case 'change': return r.changePct;
      case 'oi': return r.oi;
      case 'funding': return r.funding;
      case 'price': return r.price;
      case 'held': return (r.long ?? 0) + (r.short ?? 0) || null;
      case 'name': return r.name.toUpperCase();
    }
  };
  const k = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = val(a), vb = val(b);
    // A missing figure sorts last both ways.
    if (va === null || vb === null) return va === vb ? 0 : va === null ? 1 : -1;
    if (typeof va === 'string' || typeof vb === 'string') return String(va).localeCompare(String(vb)) * k;
    return (va - vb) * k || b.volume - a.volume;
  });
}

/* ---------------------------------------------------------------------------
 * Sectors.
 * ------------------------------------------------------------------------ */

export interface SectorStat {
  id: Sector;
  label: string;
  markets: number;
  volume: number;
  /** Volume-weighted 24h change, in percent. */
  change: number | null;
  up: number;
  down: number;
  /** The sector's biggest markets, for its strip of chips. */
  top: MarketRow[];
}

/** Every sector with a market, the busiest first; "Other" last. */
export function sectorStats(rows: readonly MarketRow[], top = 4): SectorStat[] {
  const out: SectorStat[] = [];
  for (const s of SECTORS) {
    const in_ = rows.filter((r) => r.sector === s.id);
    if (!in_.length) continue;
    let w = 0, wc = 0, up = 0, down = 0, volume = 0;
    for (const r of in_) {
      volume += r.volume;
      if (r.changePct === null) continue;
      wc += r.changePct * r.volume;
      w += r.volume;
      if (r.changePct > 0) up++;
      else if (r.changePct < 0) down++;
    }
    out.push({ id: s.id, label: s.label, markets: in_.length, volume, change: w > 0 ? wc / w : null, up, down, top: in_.slice(0, top) });
  }
  return out.sort((a, b) => (a.id === 'other' ? 1 : 0) - (b.id === 'other' ? 1 : 0) || b.volume - a.volume);
}

/** The heatmap's tile colour: green or red by the move, stronger to +-`full` percent. */
export function heatTone(changePct: number | null, full = 6): string {
  if (changePct === null) return 'var(--tint-strong)';
  const strength = Math.min(1, Math.abs(changePct) / full);
  const mix = Math.round(10 + strength * 52);
  return `color-mix(in srgb, ${changePct >= 0 ? 'var(--pos)' : 'var(--neg)'} ${mix}%, var(--bg-panel))`;
}

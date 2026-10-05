/**
 * Funding-arbitrage pairs across the books we can actually read.
 *
 * SoDEX publishes a funding rate per its own interval, a next-funding time,
 * a mark and a bid/ask. Hyperliquid publishes an hourly rate, a mark, 24h
 * volume and open interest (default dex and the xyz dex) and settles on the
 * hour. A pair is one coin on two different venues. The long leg is the lower
 * rate and the short leg is the higher one, so the spread is what that
 * position collects. Rates are scaled to 8 hours before they are compared,
 * because the venues do not share a clock.
 *
 * Nothing here is a settled 24h, 7d or 30d funding total. Neither feed
 * publishes that for a market. The APR is the live spread, annualised.
 */
import { marketKey } from './model';

const HOUR = 3600;
const EIGHT_H = 8 * HOUR;
const YEAR = 365 * 24 * HOUR;

export type ArbVenue = 'sodex' | 'hyperliquid';
export type PriceBasis = 'book' | 'mark' | 'none';
export type ArbSort = 'apr' | 'spread' | 'price' | 'volume';

export interface FundLeg {
  venue: ArbVenue;
  symbol: string;
  /** Shared market key (`BTC`, `1000PEPE`, `XYZ:TSLA`). */
  coin: string;
  /** Fraction of notional per `intervalSec`. Positive: longs pay shorts. */
  rate: number;
  intervalSec: number;
  /** SoDEX publishes this. Hyperliquid does not; the hour boundary is applied at render. */
  nextFundingMs: number | null;
  mark: number | null;
  bid: number | null;
  ask: number | null;
  volumeUsd: number | null;
  oiUsd: number | null;
  /** Percent, 1.5 = +1.5%. */
  changePct: number | null;
  maxLev: number | null;
}

export interface FundPair {
  coin: string;
  label: string;
  long: FundLeg;
  short: FundLeg;
  /** Fraction of notional collected per 8 hours by long `long` and short `short`. */
  spread8h: number;
  /** That spread, annualised, in percent. */
  apr: number;
  /** (short sell − long buy) / long buy. Positive means the short leg is priced higher. */
  priceSpread: number | null;
  priceBasis: PriceBasis;
}

export interface SodexSymbol {
  name: string;
  status?: string;
  fundingInterval?: number;
  maxLeverage?: number;
}

export interface SodexTicker {
  symbol: string;
  fundingRate?: string;
  nextFundingTime?: number;
  markPrice?: string;
  lastPx?: string;
  bidPx?: string;
  askPx?: string;
  quoteVolume?: string;
  openInterest?: string;
  changePct?: number;
}

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

function numOf(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

function pos(v: unknown): number | null {
  const n = numOf(v);
  return n !== null && n > 0 ? n : null;
}

/** Unix seconds and unix milliseconds both arrive as numbers. */
export function asMs(t: number | null | undefined): number | null {
  if (!finite(t) || t <= 0) return null;
  return t < 1e12 ? t * 1000 : t;
}

/** The next Hyperliquid settlement. The venue pays funding every hour, on the hour. */
export function nextUtcHour(now: number): number {
  const d = new Date(now);
  d.setUTCMinutes(0, 0, 0);
  return d.getTime() + HOUR * 1000;
}

/** The venue's rate restated as a fraction per 8 hours. */
export function per8h(rate: number, intervalSec: number): number | null {
  if (!Number.isFinite(rate) || !(intervalSec > 0)) return null;
  return rate * (EIGHT_H / intervalSec);
}

export function aprPct(spread8h: number): number {
  return spread8h * (YEAR / EIGHT_H) * 100;
}

function priceOf(long: FundLeg, short: FundLeg): { priceSpread: number | null; priceBasis: PriceBasis } {
  if (long.ask !== null && short.bid !== null) {
    return { priceSpread: (short.bid - long.ask) / long.ask, priceBasis: 'book' };
  }
  if (long.mark !== null && short.mark !== null) {
    return { priceSpread: (short.mark - long.mark) / long.mark, priceBasis: 'mark' };
  }
  return { priceSpread: null, priceBasis: 'none' };
}

function labelOf(coin: string, legs: readonly FundLeg[]): string {
  const plain = legs.find((l) => !l.symbol.includes(':'));
  const symbol = plain?.symbol ?? legs[0]?.symbol ?? coin;
  const head = symbol.split(/[-_/]/)[0] ?? symbol;
  return head || coin;
}

/** Best direction for one coin: long the lower 8h rate, short the higher. */
export function bestPair(legs: readonly FundLeg[]): FundPair | null {
  let best: FundPair | null = null;
  for (let i = 0; i < legs.length; i++) {
    for (let j = 0; j < legs.length; j++) {
      if (i === j) continue;
      const long = legs[i]!;
      const short = legs[j]!;
      if (long.venue === short.venue) continue;
      const hi = per8h(short.rate, short.intervalSec);
      const lo = per8h(long.rate, long.intervalSec);
      if (hi === null || lo === null) continue;
      const spread8h = hi - lo;
      const price = priceOf(long, short);
      const pair: FundPair = {
        coin: long.coin,
        label: labelOf(long.coin, legs),
        long,
        short,
        spread8h,
        apr: aprPct(spread8h),
        priceSpread: price.priceSpread,
        priceBasis: price.priceBasis,
      };
      if (!best || pair.apr > best.apr || (pair.apr === best.apr && pair.label < best.label)) best = pair;
    }
  }
  return best;
}

export function sodexLegs(symbols: readonly SodexSymbol[], tickers: readonly SodexTicker[]): FundLeg[] {
  const byName = new Map(tickers.map((t) => [t.symbol, t]));
  const out: FundLeg[] = [];
  for (const s of symbols) {
    if (s.status && s.status !== 'TRADING') continue;
    if (!(s.fundingInterval && s.fundingInterval > 0)) continue;
    const t = byName.get(s.name);
    if (!t || t.fundingRate === undefined) continue;
    const rate = Number(t.fundingRate);
    if (!Number.isFinite(rate)) continue;
    const mark = pos(t.markPrice) ?? pos(t.lastPx);
    const oi = pos(t.openInterest);
    out.push({
      venue: 'sodex',
      symbol: s.name,
      coin: marketKey(s.name),
      rate,
      intervalSec: s.fundingInterval,
      nextFundingMs: asMs(t.nextFundingTime),
      mark,
      bid: pos(t.bidPx),
      ask: pos(t.askPx),
      volumeUsd: (() => {
        const n = numOf(t.quoteVolume);
        return n !== null && n >= 0 ? n : null;
      })(),
      oiUsd: oi !== null && mark !== null ? oi * mark : null,
      changePct: finite(t.changePct) ? t.changePct : null,
      maxLev: finite(s.maxLeverage) ? s.maxLeverage : null,
    });
  }
  return out;
}

/** `raw` is the `assets` array from `GET /api/vs/screener?view=assets`. */
export function hlLegs(raw: unknown): FundLeg[] {
  if (!Array.isArray(raw)) return [];
  const out: FundLeg[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const o = row as Record<string, unknown>;
    const symbol = typeof o.symbol === 'string' ? o.symbol : '';
    const rate = numOf(o.funding);
    if (!symbol || rate === null) continue;
    const mark = pos(o.price);
    out.push({
      venue: 'hyperliquid',
      symbol,
      coin: marketKey(symbol),
      rate,
      intervalSec: HOUR,
      nextFundingMs: null,
      mark,
      bid: null,
      ask: null,
      volumeUsd: numOf(o.volume24h),
      oiUsd: numOf(o.openInterestUsd),
      changePct: numOf(o.changePct),
      maxLev: numOf(o.maxLeverage),
    });
  }
  return out;
}

export function buildPairs(legs: readonly FundLeg[]): FundPair[] {
  const groups = new Map<string, FundLeg[]>();
  for (const leg of legs) {
    if (!leg.coin) continue;
    const list = groups.get(leg.coin);
    if (list) list.push(leg);
    else groups.set(leg.coin, [leg]);
  }
  const out: FundPair[] = [];
  for (const list of groups.values()) {
    const pair = bestPair(list);
    if (pair) out.push(pair);
  }
  return sortPairs(out, 'apr');
}

function sortKey(p: FundPair, sort: ArbSort): number {
  if (sort === 'price') return p.priceSpread ?? Number.NEGATIVE_INFINITY;
  if (sort === 'volume') {
    const vols = [p.long.volumeUsd, p.short.volumeUsd].filter(finite);
    return vols.length ? Math.min(...vols) : Number.NEGATIVE_INFINITY;
  }
  return sort === 'spread' ? p.spread8h : p.apr;
}

export function sortPairs(rows: readonly FundPair[], sort: ArbSort): FundPair[] {
  return [...rows].sort((a, b) => sortKey(b, sort) - sortKey(a, sort) || a.label.localeCompare(b.label));
}

export function filterPairs(rows: readonly FundPair[], o: { q?: string; minVol?: number }): FundPair[] {
  const q = (o.q ?? '').trim().toUpperCase();
  const min = o.minVol ?? 0;
  return rows.filter((p) => {
    if (q && !p.label.toUpperCase().includes(q) && !p.coin.includes(q)) return false;
    if (min > 0) {
      const thin = Math.min(p.long.volumeUsd ?? 0, p.short.volumeUsd ?? 0);
      if (!(thin >= min)) return false;
    }
    return true;
  });
}

export function fmtInterval(sec: number): string {
  if (!(sec > 0)) return '—';
  if (sec % HOUR === 0) return `${sec / HOUR}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

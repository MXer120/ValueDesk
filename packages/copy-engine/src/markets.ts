/**
 * SoDEX perps markets: their rules, their mark prices, and which SoDEX market
 * a leader's market maps to.
 *
 * MAPPING. A SoDEX leader trades SoDEX markets: same name. A Hyperliquid
 * leader trades Hyperliquid coins: 'BTC' -> 'BTC-USD'; a builder-deployed
 * market 'xyz:TSLA' -> 'TSLA-USD'; a thousand-unit coin 'kPEPE' ->
 * '1000PEPE-USD' or 'KPEPE-USD' where SoDEX lists one. A coin SoDEX does not
 * list is not copied. Because the two venues' units can differ, the planner
 * sizes copies by NOTIONAL and converts at the SoDEX price, never by units.
 *
 * PRICES. Copied orders are IOC limits at the SoDEX mark moved by the
 * follower's slippage cap, snapped INWARD to the tick (a buy rounds down, a
 * sell up, so the cap is never exceeded) and kept inside SoDEX's limit band
 * (buyLimitUpRatio / sellLimitDownRatio around the mark).
 */
import { canonicalDecimal, decimalCompare, numberToPlainString, roundToStep } from '../../sodex-core/src/index.ts';
import type { LeaderVenue, MarketInfo } from './types.ts';

const num = (v: unknown, fallback = NaN): number => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : fallback;
};
const str = (v: unknown, fallback: string): string => (typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback);

/** `GET /api/v1/perps/markets/symbols` rows -> rules. Rows that cannot be traded safely are dropped. */
export function parseMarkets(rows: unknown): MarketInfo[] {
  if (!Array.isArray(rows)) return [];
  const out: MarketInfo[] = [];
  for (const r of rows as Array<Record<string, unknown>>) {
    const id = num(r.id);
    const name = str(r.name, '');
    const step = str(r.stepSize, '');
    const tick = str(r.tickSize, '');
    if (!Number.isSafeInteger(id) || !name || !step || !tick || num(step) <= 0 || num(tick) <= 0) continue;
    out.push({
      id,
      name,
      base: str(r.baseCoin, name.replace(/-USD$/, '')).toUpperCase(),
      tickSize: canonicalDecimal(tick),
      stepSize: canonicalDecimal(step),
      minQuantity: canonicalDecimal(str(r.minQuantity, step)),
      maxQuantity: canonicalDecimal(str(r.maxQuantity, '0')),
      marketMaxQuantity: typeof r.marketMaxQuantity === 'string' ? canonicalDecimal(r.marketMaxQuantity) : null,
      minNotional: num(r.minNotional, 10),
      maxNotional: num(r.maxNotional) > 0 ? num(r.maxNotional) : null,
      maxLeverage: Math.max(1, Math.floor(num(r.maxLeverage, 1))),
      buyLimitUpRatio: num(r.buyLimitUpRatio, 0.05),
      sellLimitDownRatio: num(r.sellLimitDownRatio, 0.05),
      takerFee: num(r.takerFee, 0.0004),
      ...(Number.isFinite(num(r.makerFee)) ? { makerFee: num(r.makerFee) } : {}),
      status: str(r.status, 'TRADING'),
    });
  }
  return out;
}

/** The markets and their latest mark prices. One per copier, refreshed on a timer. */
export class MarketBook {
  private byName = new Map<string, MarketInfo>();
  private marks = new Map<string, { price: number; at: number }>();
  loadedAt = 0;

  load(markets: readonly MarketInfo[], now = Date.now()): void {
    this.byName = new Map(markets.map((m) => [m.name.toUpperCase(), m]));
    this.loadedAt = now;
  }

  get size(): number {
    return this.byName.size;
  }

  all(): MarketInfo[] {
    return [...this.byName.values()];
  }

  get(name: string): MarketInfo | null {
    return this.byName.get(name.toUpperCase()) ?? null;
  }

  setMark(symbol: string, price: number, at = Date.now()): void {
    if (Number.isFinite(price) && price > 0) this.marks.set(symbol.toUpperCase(), { price, at });
  }

  /** The mark, if seen within `maxAgeMs`. */
  mark(symbol: string, maxAgeMs = 60_000, now = Date.now()): number | null {
    const m = this.marks.get(symbol.toUpperCase());
    return m && now - m.at <= maxAgeMs ? m.price : null;
  }

  /** The SoDEX market a leader's market maps to, or null when SoDEX lists none. */
  sodexMarketFor(venue: LeaderVenue, leaderSymbol: string): MarketInfo | null {
    for (const name of candidateNames(venue, leaderSymbol)) {
      const hit = this.get(name);
      if (hit) return hit;
    }
    return null;
  }
}

/** Upper-case coin of a leader market, for the allow and deny lists: 'BTC-USD' / 'BTC' / 'xyz:TSLA' -> 'BTC' / 'TSLA'. */
export function coinOf(venue: LeaderVenue, leaderSymbol: string): string {
  const s = leaderSymbol.trim();
  if (venue === 'sodex') return s.replace(/-USD$/i, '').toUpperCase();
  const bare = s.includes(':') ? s.slice(s.indexOf(':') + 1) : s;
  return bare.replace(/^k(?=[A-Z])/, '').toUpperCase();
}

/** Whether a leader market is spot (never copied). */
export function isSpotSymbol(venue: LeaderVenue, leaderSymbol: string): boolean {
  if (venue === 'sodex') return leaderSymbol.includes('_') || /^v[A-Z]/.test(leaderSymbol);
  return leaderSymbol.startsWith('@') || leaderSymbol.includes('/');
}

function candidateNames(venue: LeaderVenue, leaderSymbol: string): string[] {
  const s = leaderSymbol.trim();
  if (venue === 'sodex') return [s];
  const bare = s.includes(':') ? s.slice(s.indexOf(':') + 1) : s;
  const k = /^k([A-Z0-9]+)$/.exec(bare);
  if (k) return [`1000${k[1]}-USD`, `K${k[1]}-USD`, `${bare.toUpperCase()}-USD`];
  return [`${bare.toUpperCase()}-USD`];
}

/* -------------------------------------------------------------- decimals ----- */

/**
 * A float as a decimal string at 12 significant digits, so binary noise
 * (80,000 x 1.005 = 80,399.99999999999) cannot push a value under a grid line
 * it sits on.
 */
const toDec = (n: number): string => canonicalDecimal(numberToPlainString(Number(n.toPrecision(12))));

function addStep(value: string, step: string): string {
  // value and step are canonical non-negative decimals on the same grid.
  const scale = Math.max((value.split('.')[1] ?? '').length, (step.split('.')[1] ?? '').length);
  const scaled = (v: string) => {
    const [i = '0', f = ''] = v.split('.');
    return BigInt(i + f.padEnd(scale, '0'));
  };
  const sum = (scaled(value) + scaled(step)).toString().padStart(scale + 1, '0');
  return canonicalDecimal(scale === 0 ? sum : `${sum.slice(0, -scale)}.${sum.slice(-scale)}`);
}

/** |size| floored to the market's step, as a canonical decimal ('0' when below one step). */
export function floorQuantity(size: number, m: Pick<MarketInfo, 'stepSize'>): string {
  const a = Math.abs(size);
  if (!(a > 0) || !Number.isFinite(a)) return '0';
  return roundToStep(toDec(a), m.stepSize, 'floor');
}

/** Whether a quantity string is at least one step and the market minimum. */
export function quantityOk(q: string, m: Pick<MarketInfo, 'minQuantity'>): boolean {
  return q !== '0' && decimalCompare(q, m.minQuantity) >= 0;
}

/**
 * The IOC limit price for `side`: `ref` moved against the follower by
 * `slippageBps`, snapped inward to the tick, and kept inside SoDEX's band
 * around `mark` (with a 0.1% margin for the mark moving in flight).
 */
export function limitPrice(side: 'buy' | 'sell', ref: number, slippageBps: number, m: MarketInfo, mark: number | null): string {
  const slip = slippageBps / 10_000;
  let p = side === 'buy' ? ref * (1 + slip) : ref * (1 - slip);
  const anchor = mark ?? ref;
  if (side === 'buy') p = Math.min(p, anchor * (1 + m.buyLimitUpRatio * 0.98));
  else p = Math.max(p, anchor * (1 - m.sellLimitDownRatio * 0.98));
  if (!(p > 0)) p = Number(m.tickSize);
  const floored = roundToStep(toDec(p), m.tickSize, 'floor');
  if (side === 'buy') return floored === '0' ? m.tickSize : floored;
  return decimalCompare(floored, toDec(p)) < 0 ? addStep(floored, m.tickSize) : floored;
}

/** A price snapped to the nearest tick (for trigger prices). */
export const snapPrice = (p: number, m: Pick<MarketInfo, 'tickSize'>): string => {
  const s = roundToStep(toDec(Math.max(p, 0)), m.tickSize, 'nearest');
  return s === '0' ? m.tickSize : s;
};

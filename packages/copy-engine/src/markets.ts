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
 * SAME ASSET. A ticker is not an asset: trade.xyz's QNT is not SoDEX's QNT-USD,
 * and a HIP-3 index quoted at a tenth of SoDEX's is another contract. A
 * Hyperliquid market is copied onto the SoDEX market of its name only while
 * the two venues price one coin alike (`sameAsset`); otherwise nothing new is
 * opened there ('different-asset'), and a position already copied still
 * follows the leader's reductions and closes.
 *
 * PRICES. Copied orders are IOC limits at the SoDEX mark moved by the
 * follower's slippage cap, snapped INWARD to the tick (a buy rounds down, a
 * sell up, so the cap is never exceeded) and kept inside SoDEX's limit band
 * (buyLimitUpRatio / sellLimitDownRatio around the mark).
 */
import { canonicalDecimal, decimalCompare, numberToPlainString, roundToStep } from '../../sodex-core/src/index.ts';
import type { AssetVerdict, LeaderVenue, MarketInfo } from './types.ts';

const num = (v: unknown, fallback = NaN): number => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : fallback;
};
const str = (v: unknown, fallback: string): string => (typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback);

/** `marginTiers` rows with a positive notional and leverage, by rising notional ({} when there are none). */
export function tiersOf(v: unknown): { marginTiers?: Array<{ maxNotionalValue: number; maxLeverage: number }> } {
  if (!Array.isArray(v)) return {};
  const tiers = (v as Array<Record<string, unknown>>)
    .map((t) => ({ maxNotionalValue: num(t?.maxNotionalValue), maxLeverage: num(t?.maxLeverage) }))
    .filter((t) => t.maxNotionalValue > 0 && t.maxLeverage > 0)
    .sort((a, b) => a.maxNotionalValue - b.maxNotionalValue);
  return tiers.length ? { marginTiers: tiers } : {};
}

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
      ...(num(r.initLeverage) > 0 ? { initLeverage: Math.floor(num(r.initLeverage)) } : {}),
      ...tiersOf(r.marginTiers),
      openInterestCap: num(r.openInterestCap) > 0 ? num(r.openInterestCap) : null,
      openInterestCapUSD: num(r.openInterestCapUSD) > 0 ? num(r.openInterestCapUSD) : null,
      buyLimitUpRatio: num(r.buyLimitUpRatio, 0.05),
      sellLimitDownRatio: num(r.sellLimitDownRatio, 0.05),
      takerFee: num(r.takerFee, 0.0004),
      ...(Number.isFinite(num(r.makerFee)) ? { makerFee: num(r.makerFee) } : {}),
      status: str(r.status, 'TRADING'),
    });
  }
  return out;
}

/**
 * When a Hyperliquid market and the SoDEX market of its name are the same asset, by
 * how far their prices for one coin are apart. Measured 2026-10-29 13:07 UTC on every
 * tradable Hyperliquid perp (main dex and all ten HIP-3 dexes) that maps to a SoDEX
 * market, Hyperliquid's mark against SoDEX's: 98 of 100 pairs within 0.56% (main dex:
 * 50 pairs, at most 0.20%; trade.xyz: 40 of 41 within 0.56%; kPEPE, kBONK and kSHIB
 * against 1000PEPE/1000BONK/1000SHIB-USD within 0.07%), and the two collisions far
 * apart - xyz:QNT (a different asset) 80.5% below QNT-USD, mkts:US500 (an index at a
 * tenth of the scale) 90.0% below US500-USD. 5% is nine times the widest gap between
 * the same assets, for a weekend or a fast market where the two venues' marks lag one
 * another, and sixteen times under the nearest collision. (Delisted Hyperliquid markets,
 * whose stale books were up to 90% off, are left out of the count: nothing trades there.)
 */
export const ASSET_DIFFERENT_ABOVE = 0.05;
/**
 * ... and once apart, the same again only within this: a market at the line does not
 * flip at every look (in between, the last verdict stands).
 */
export const ASSET_SAME_BELOW = 0.03;
/** A price older than this is not compared: a stale price is no evidence either way. */
export const ASSET_PRICE_MAX_AGE_MS = 90_000;

/** How many coins one contract of a Hyperliquid market is: 1000 for kPEPE (and a HIP-3 1000PEPE), else 1. */
function hlUnits(coin: string): number {
  const bare = coin.includes(':') ? coin.slice(coin.indexOf(':') + 1) : coin;
  return /^k[A-Z0-9]/.test(bare) || /^1000[A-Z]/.test(bare) ? 1000 : 1;
}

/** ... and of the SoDEX market it maps to: 1000PEPE-USD, or KPEPE-USD for a k-coin (KAS-USD is Kaspa). */
function sodexUnits(name: string, coin: string): number {
  const kCoin = /^k[A-Z0-9]/.test(coin.includes(':') ? coin.slice(coin.indexOf(':') + 1) : coin);
  return /^1000[A-Z]/.test(name) || (kCoin && /^K[A-Z0-9]/.test(name)) ? 1000 : 1;
}

/** The markets and their latest mark prices. One per copier, refreshed on a timer. */
export class MarketBook {
  private byName = new Map<string, MarketInfo>();
  private marks = new Map<string, { price: number; at: number }>();
  /** Hyperliquid coin -> its latest price seen (per contract, as Hyperliquid quotes it). */
  private leaderPx = new Map<string, { price: number; at: number }>();
  /** Hyperliquid coin -> the last same-asset verdict. */
  private assets = new Map<string, AssetVerdict>();
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

  /**
   * A price Hyperliquid gave for one of its markets: a leader's fill, or the mark in a
   * position read. An older price never replaces a newer one.
   */
  observeLeaderPrice(venue: LeaderVenue, leaderSymbol: string, price: number, at = Date.now()): void {
    if (venue !== 'hyperliquid' || !Number.isFinite(price) || !(price > 0)) return;
    const prev = this.leaderPx.get(leaderSymbol);
    if (prev && prev.at > at) return;
    this.leaderPx.set(leaderSymbol, { price, at });
  }

  /**
   * Whether a Hyperliquid market is the same asset as the SoDEX market it maps to: the
   * price of one coin on each (a 1000-coin contract counted per coin) within
   * ASSET_DIFFERENT_ABOVE, and once apart within ASSET_SAME_BELOW again. Compared only on
   * prices seen within ASSET_PRICE_MAX_AGE_MS: without them the last verdict stands, and
   * there is none (null) until both venues have priced it fresh. Null too for a SoDEX
   * leader (its markets are SoDEX's own) and a market SoDEX does not list.
   */
  sameAsset(venue: LeaderVenue, leaderSymbol: string, now = Date.now()): AssetVerdict | null {
    if (venue !== 'hyperliquid') return null;
    const m = this.sodexMarketFor(venue, leaderSymbol);
    if (!m) return null;
    const prior = this.assets.get(leaderSymbol);
    const last = prior && prior.market === m.name ? prior : null;
    const fresh = (x: { at: number } | undefined): x is { price: number; at: number } => !!x && Math.abs(now - x.at) <= ASSET_PRICE_MAX_AGE_MS;
    const hl = this.leaderPx.get(leaderSymbol);
    const sx = this.marks.get(m.name.toUpperCase());
    if (!fresh(hl) || !fresh(sx)) return last;
    const leaderPrice = hl.price / hlUnits(leaderSymbol);
    const sodexPrice = sx.price / sodexUnits(m.name, leaderSymbol);
    const deviation = leaderPrice / sodexPrice - 1;
    const off = Math.abs(deviation);
    const same = off > ASSET_DIFFERENT_ABOVE ? false : off < ASSET_SAME_BELOW ? true : (last?.same ?? true);
    const v: AssetVerdict = { same, market: m.name, leaderPrice, sodexPrice, deviation, at: Math.min(hl.at, sx.at) };
    this.assets.set(leaderSymbol, v);
    return v;
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

/** The Hyperliquid dex of a coin: 'xyz:TSLA' -> 'xyz' (a HIP-3 dex), 'BTC' -> '' (the main dex). */
export function hlDexOf(coin: string): string {
  const i = coin.indexOf(':');
  return i > 0 ? coin.slice(0, i) : '';
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

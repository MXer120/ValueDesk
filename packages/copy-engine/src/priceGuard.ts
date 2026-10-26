/**
 * Manipulation protection: one REFERENCE price for a coin from several venues,
 * and the two checks an order can make against it.
 *
 *   referencePrice   SoDEX, Hyperliquid, Aster and Binance quotes, each with a
 *                    weight (0 = not used), combined as a weighted mean or a
 *                    weighted median; stale quotes and quotes too far from the
 *                    others are dropped first, and too few left means no price.
 *   triggerHit       a trigger (stop, take-profit, conditional) fires on the
 *                    reference, not on one venue's print: a wick on SoDEX alone
 *                    does not fire a stop that also listens to Binance and
 *                    Hyperliquid.
 *   marketOrderAllowed  the optional toggle: a market (IOC) order is sent only
 *                    while the venue's price is within the slippage range of the
 *                    reference - buying into a squeeze or selling into a flush
 *                    that the other venues do not see is refused.
 *
 * NOT WIRED IN. Nothing calls this yet - not the copy planner, the guards, the
 * order ticket or the algo orders. It is here so those can use it: build the
 * quotes with `fetchQuotes`, then ask `referencePrice` and the two checks. In a
 * browser, Aster and Binance also need their hosts in the CSP's connect-src
 * (fapi.asterdex.com, fapi.binance.com) before `fetchQuotes` can reach them.
 *
 * Prices are per ONE unit of the coin everywhere: a venue that lists a 1000x
 * contract (Binance 1000PEPEUSDT, Hyperliquid kPEPE) is scaled on the way in.
 */
import { abortController, timers, type FetchLike } from './io.ts';
import { HyperliquidClient, type SodexClient } from './sodex.ts';

/** binance: USD-M futures (mark); binanceSpot: spot (the book's mid). */
export type PriceSourceId = 'sodex' | 'hyperliquid' | 'aster' | 'binance' | 'binanceSpot';
export const PRICE_SOURCES: readonly PriceSourceId[] = ['sodex', 'hyperliquid', 'aster', 'binance', 'binanceSpot'];

/** One venue's price for the coin, per one unit, and when the venue stamped it (ms). */
export interface SourceQuote {
  source: PriceSourceId;
  price: number;
  at: number;
}

export interface ReferenceConfig {
  /** Weight per source; a missing source or 0 is not used. Weights need not sum to 1. */
  weights: Partial<Record<PriceSourceId, number>>;
  /** 'mean': weighted average. 'median': weighted median (one outlier cannot move it). */
  method: 'mean' | 'median';
  /** A quote older than this is dropped. */
  maxAgeMs: number;
  /** Drop a quote further than this from the median of the fresh quotes (bps). null: keep all. */
  maxDeviationBps: number | null;
  /** Fewer usable sources than this: no reference at all. */
  minSources: number;
}

/** A sensible default: all four venues, Binance and Hyperliquid weighted highest, median, 10 s, 1%. */
export const DEFAULT_REFERENCE: ReferenceConfig = {
  weights: { binance: 0.35, hyperliquid: 0.3, aster: 0.15, sodex: 0.2 },
  method: 'median',
  maxAgeMs: 10_000,
  maxDeviationBps: 100,
  minSources: 2,
};

/** Only SoDEX itself: what every check does today. */
export const SODEX_ONLY: ReferenceConfig = { weights: { sodex: 1 }, method: 'mean', maxAgeMs: 10_000, maxDeviationBps: null, minSources: 1 };

export type DropReason = 'unweighted' | 'invalid' | 'stale' | 'outlier' | 'missing';

export interface Reference {
  price: number;
  /** The sources the price is made of, with the weight each carried. */
  used: Array<{ source: PriceSourceId; price: number; weight: number }>;
  dropped: Array<{ source: PriceSourceId; reason: DropReason }>;
  /** Highest minus lowest used price, over the reference (bps): how much the venues disagree. */
  spreadBps: number;
  /** The oldest used quote's time. */
  at: number;
}

const bpsOf = (a: number, b: number): number => ((a - b) / b) * 10_000;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function weightedMedian(items: Array<{ price: number; weight: number }>): number {
  const s = [...items].sort((a, b) => a.price - b.price);
  const half = s.reduce((t, x) => t + x.weight, 0) / 2;
  let acc = 0;
  for (let i = 0; i < s.length; i++) {
    acc += s[i]!.weight;
    // Exactly half the weight below: the midpoint of this price and the next.
    if (Math.abs(acc - half) < 1e-12 && i + 1 < s.length) return (s[i]!.price + s[i + 1]!.price) / 2;
    if (acc > half) return s[i]!.price;
  }
  return s[s.length - 1]!.price;
}

/** The reference price, or null when too few sources are usable. Pure. */
export function referencePrice(quotes: readonly SourceQuote[], cfg: ReferenceConfig, now: number): Reference | null {
  const dropped: Reference['dropped'] = [];
  const fresh: Array<{ source: PriceSourceId; price: number; weight: number; at: number }> = [];
  const seen = new Set<PriceSourceId>();
  for (const q of quotes) {
    if (seen.has(q.source)) continue; // one quote per source: the first given
    seen.add(q.source);
    const weight = cfg.weights[q.source] ?? 0;
    if (!(weight > 0)) { dropped.push({ source: q.source, reason: 'unweighted' }); continue; }
    if (!Number.isFinite(q.price) || !(q.price > 0)) { dropped.push({ source: q.source, reason: 'invalid' }); continue; }
    if (!(now - q.at <= cfg.maxAgeMs)) { dropped.push({ source: q.source, reason: 'stale' }); continue; }
    fresh.push({ source: q.source, price: q.price, weight, at: q.at });
  }
  for (const s of PRICE_SOURCES) {
    if ((cfg.weights[s] ?? 0) > 0 && !seen.has(s)) dropped.push({ source: s, reason: 'missing' });
  }

  let used = fresh;
  if (cfg.maxDeviationBps !== null && fresh.length >= 3) {
    // Outliers against the plain median of the fresh quotes: needs three to know which one is off.
    const mid = median(fresh.map((f) => f.price));
    used = fresh.filter((f) => {
      const off = Math.abs(bpsOf(f.price, mid)) > cfg.maxDeviationBps!;
      if (off) dropped.push({ source: f.source, reason: 'outlier' });
      return !off;
    });
  }
  if (used.length < Math.max(1, cfg.minSources)) return null;

  const total = used.reduce((t, u) => t + u.weight, 0);
  const price = cfg.method === 'median' ? weightedMedian(used) : used.reduce((t, u) => t + u.price * u.weight, 0) / total;
  const prices = used.map((u) => u.price);
  return {
    price,
    used: used.map(({ source, price: p, weight }) => ({ source, price: p, weight })),
    dropped,
    spreadBps: ((Math.max(...prices) - Math.min(...prices)) / price) * 10_000,
    at: Math.min(...used.map((u) => u.at)),
  };
}

/* ------------------------------------------------------------- checks ----- */

export interface PriceTrigger {
  /** 'above': fires at or above `level` (a take-profit on a long, a stop on a short); 'below' the other way. */
  when: 'above' | 'below';
  level: number;
}

/** Whether the trigger fires on this reference. No reference: never (a trigger does not fire blind). */
export function triggerHit(t: PriceTrigger, ref: Reference | null): boolean {
  if (!ref) return false;
  return t.when === 'above' ? ref.price >= t.level : ref.price <= t.level;
}

export interface MarketGuard {
  /** The toggle. Off: every market order is allowed (today's behaviour). */
  enabled: boolean;
  /** How far the venue may be from the reference, against you, bps. */
  slippageBps: number;
  /** Also refuse when the venue is that far in your FAVOUR (a price that good is suspect too). */
  symmetric?: boolean;
}

export interface GuardVerdict {
  ok: boolean;
  /** The venue's price against the reference, bps (+ = venue above). null without a reference. */
  deviationBps: number | null;
  reason: 'off' | 'within' | 'no-reference' | 'venue-above-reference' | 'venue-below-reference';
}

/**
 * May a market order go now? A buy is refused while the venue trades more than
 * `slippageBps` ABOVE the reference, a sell while it trades that far BELOW it -
 * the side a squeeze or a flush on one venue would fill you at. Without a
 * reference the guard refuses (it cannot tell), unless it is off.
 */
export function marketOrderAllowed(side: 'buy' | 'sell', venuePrice: number, ref: Reference | null, g: MarketGuard): GuardVerdict {
  if (!g.enabled) return { ok: true, deviationBps: ref ? bpsOf(venuePrice, ref.price) : null, reason: 'off' };
  if (!ref || !Number.isFinite(venuePrice) || !(venuePrice > 0)) return { ok: false, deviationBps: null, reason: 'no-reference' };
  const dev = bpsOf(venuePrice, ref.price);
  const against = side === 'buy' ? dev : -dev;
  if (against > g.slippageBps) return { ok: false, deviationBps: dev, reason: dev > 0 ? 'venue-above-reference' : 'venue-below-reference' };
  if (g.symmetric && -against > g.slippageBps) return { ok: false, deviationBps: dev, reason: dev > 0 ? 'venue-above-reference' : 'venue-below-reference' };
  return { ok: true, deviationBps: dev, reason: 'within' };
}

/* ------------------------------------------------------------- quotes ----- */

/** How a coin is named on a venue, and how many coins one unit of that market is (1000 for 1000PEPEUSDT). */
export interface VenueSymbol {
  symbol: string;
  unitsPerContract: number;
}

/** Venue spellings that are not the default pattern. Extend per coin as markets are added. */
export const SYMBOL_OVERRIDES: Partial<Record<PriceSourceId, Record<string, VenueSymbol>>> = {
  binance: {
    PEPE: { symbol: '1000PEPEUSDT', unitsPerContract: 1000 },
    SHIB: { symbol: '1000SHIBUSDT', unitsPerContract: 1000 },
    BONK: { symbol: '1000BONKUSDT', unitsPerContract: 1000 },
    FLOKI: { symbol: '1000FLOKIUSDT', unitsPerContract: 1000 },
  },
  aster: {
    PEPE: { symbol: '1000PEPEUSDT', unitsPerContract: 1000 },
    SHIB: { symbol: '1000SHIBUSDT', unitsPerContract: 1000 },
    BONK: { symbol: '1000BONKUSDT', unitsPerContract: 1000 },
  },
  hyperliquid: {
    PEPE: { symbol: 'kPEPE', unitsPerContract: 1000 },
    SHIB: { symbol: 'kSHIB', unitsPerContract: 1000 },
    BONK: { symbol: 'kBONK', unitsPerContract: 1000 },
    FLOKI: { symbol: 'kFLOKI', unitsPerContract: 1000 },
  },
};

/** `coin` (upper-case base, 'BTC') on a venue. */
export function venueSymbol(source: PriceSourceId, coin: string, overrides = SYMBOL_OVERRIDES): VenueSymbol {
  const c = coin.toUpperCase();
  const o = overrides[source]?.[c];
  if (o) return o;
  switch (source) {
    case 'sodex': return { symbol: `${c}-USD`, unitsPerContract: 1 };
    case 'hyperliquid': return { symbol: c, unitsPerContract: 1 };
    case 'aster':
    case 'binance':
    case 'binanceSpot': return { symbol: `${c}USDT`, unitsPerContract: 1 };
  }
}

export const BINANCE_FUTURES = 'https://fapi.binance.com';
export const BINANCE_SPOT = 'https://api.binance.com';
/** Aster's futures API speaks Binance's: the same paths and fields. */
export const ASTER_FUTURES = 'https://fapi.asterdex.com';

/** A GET that gives up after `timeoutMs`: a slow venue must not hold the others' price. */
async function getJson<T>(fetch: FetchLike, url: string, timeoutMs = QUOTE_TIMEOUT_MS): Promise<T> {
  const ctl = abortController();
  const timer = timers.after(timeoutMs, () => ctl.abort());
  try {
    const res = await fetch(url, { method: 'GET', signal: ctl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
    return JSON.parse(text) as T;
  } finally {
    timers.cancel(timer);
  }
}

/** How long one venue's quote may take. */
export const QUOTE_TIMEOUT_MS = 5_000;

/** `p`, or null once `ms` have passed (the venue counts as missing). */
function within<T>(p: Promise<T | null>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = timers.after(ms, () => resolve(null));
    p.then((v) => { timers.cancel(timer); resolve(v); }, () => { timers.cancel(timer); resolve(null); });
  });
}

/** Binance-style USD-M mark price (Binance, Aster): one symbol, per one coin. */
export async function binanceStyleMark(fetch: FetchLike, base: string, source: 'binance' | 'aster', coin: string, now: number): Promise<SourceQuote | null> {
  const vs = venueSymbol(source, coin);
  const r = await getJson<{ symbol?: string; markPrice?: string; time?: number }>(fetch, `${base}/fapi/v1/premiumIndex?symbol=${encodeURIComponent(vs.symbol)}`);
  const px = Number(r?.markPrice);
  if (!Number.isFinite(px) || !(px > 0)) return null;
  return { source, price: px / vs.unitsPerContract, at: typeof r.time === 'number' && r.time > 0 ? r.time : now };
}

/** Binance spot: the mid of the best bid and ask (bookTicker), per one coin. */
export async function binanceSpotMid(fetch: FetchLike, coin: string, now: number, base = BINANCE_SPOT): Promise<SourceQuote | null> {
  const vs = venueSymbol('binanceSpot', coin);
  const r = await getJson<{ bidPrice?: string; askPrice?: string }>(fetch, `${base}/api/v3/ticker/bookTicker?symbol=${encodeURIComponent(vs.symbol)}`);
  const bid = Number(r?.bidPrice);
  const ask = Number(r?.askPrice);
  if (!(bid > 0) || !(ask > 0) || ask < bid) return null;
  return { source: 'binanceSpot', price: (bid + ask) / 2 / vs.unitsPerContract, at: now };
}

/** Hyperliquid's mark for a coin (metaAndAssetCtxs: the universe and its contexts, index-aligned). */
export async function hyperliquidMark(hl: HyperliquidClient, coin: string, now: number): Promise<SourceQuote | null> {
  const vs = venueSymbol('hyperliquid', coin);
  const [meta, ctxs] = await hl.post<[{ universe?: Array<{ name?: string }> }, Array<{ markPx?: string }>]>({ type: 'metaAndAssetCtxs' });
  const i = (meta?.universe ?? []).findIndex((u) => u.name === vs.symbol);
  const px = i >= 0 ? Number(ctxs?.[i]?.markPx) : NaN;
  if (!Number.isFinite(px) || !(px > 0)) return null;
  return { source: 'hyperliquid', price: px / vs.unitsPerContract, at: now };
}

/** SoDEX's mark for a coin (the mark-price list). */
export async function sodexMark(sodex: Pick<SodexClient, 'markPrices'>, coin: string, now: number): Promise<SourceQuote | null> {
  const vs = venueSymbol('sodex', coin);
  const row = (await sodex.markPrices()).find((r) => r.symbol === vs.symbol);
  if (!row) return null;
  return { source: 'sodex', price: row.price / vs.unitsPerContract, at: now };
}

export interface QuoteDeps {
  fetch: FetchLike;
  sodex?: Pick<SodexClient, 'markPrices'>;
  hyperliquid?: HyperliquidClient;
  now?: () => number;
  /** Per venue; a venue slower than this is left out. Default QUOTE_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * The quotes of every weighted source, read in parallel. A source that fails or
 * does not list the coin is simply absent: `referencePrice` records it as missing.
 */
export async function fetchQuotes(coin: string, cfg: Pick<ReferenceConfig, 'weights'>, deps: QuoteDeps): Promise<SourceQuote[]> {
  const now = deps.now ?? Date.now;
  const want = PRICE_SOURCES.filter((s) => (cfg.weights[s] ?? 0) > 0);
  const hl = deps.hyperliquid ?? new HyperliquidClient(deps.fetch);
  const read = (s: PriceSourceId): Promise<SourceQuote | null> => {
    switch (s) {
      case 'binance': return binanceStyleMark(deps.fetch, BINANCE_FUTURES, 'binance', coin, now());
      case 'binanceSpot': return binanceSpotMid(deps.fetch, coin, now());
      case 'aster': return binanceStyleMark(deps.fetch, ASTER_FUTURES, 'aster', coin, now());
      case 'hyperliquid': return hyperliquidMark(hl, coin, now());
      case 'sodex': return deps.sodex ? sodexMark(deps.sodex, coin, now()) : Promise.resolve(null);
    }
  };
  const ms = deps.timeoutMs ?? QUOTE_TIMEOUT_MS;
  const got = await Promise.all(want.map((s) => within(read(s), ms)));
  return got.filter((x): x is SourceQuote => x !== null);
}

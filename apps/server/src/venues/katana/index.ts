/**
 * Katana perps as a Venue. READ-ONLY MARKET DATA.
 *
 * TRADING IS OUT OF SCOPE AND MUST STAY OUT OF SCOPE HERE. Placing an order on
 * Katana requires an API key, an HMAC over the request, AND a separate EIP-712
 * wallet signature; the delegated-key path that would avoid the third of those is
 * contested in Katana's own documentation. Shipping a write path we could not
 * verify end to end against a venue that settles real money is not a trade worth
 * making, so this adapter exposes reads only.
 *
 * WHAT IS NOT IMPLEMENTED, said plainly rather than left to be discovered:
 *
 *  - No WebSocket streaming. Katana's public WS is real and one connection can
 *    cover the whole venue (subscribe takes a top-level `markets` array), but its
 *    l2orderbook channel is DIFF-ONLY: it sends no snapshot on subscribe. A
 *    correct L2 book therefore needs a REST snapshot seed, sequence-gap detection
 *    and a resync path. That is a book-maintenance component, not a transport
 *    tweak, and a half-built one drifts out of sync silently - the ladder keeps
 *    rendering, just wrong. Until it is built properly, `orderbook()` returns an
 *    honest REST snapshot and the caller polls.
 *  - No funding-rate history. /v1/fundingRatesSamples does not exist; the example
 *    in Katana's own docs 404s (verified). /v1/fundingRates does exist but has no
 *    SoDEX counterpart in this interface, so it is not part of the abstraction.
 */
import {
  UnsupportedIntervalError,
  clampLimit,
  decStr,
  numOrNull,
  sortCandlesOldestFirst,
  sortTradesNewestFirst,
  type Venue,
  type VenueCandle,
  type VenueOrderbook,
  type VenueSymbol,
  type VenueTicker,
  type VenueTrade,
} from '../types.js';
import {
  KATANA_INFO,
  KATANA_INTERVALS,
  KATANA_MAX_BOOK_DEPTH,
  KATANA_MAX_ROWS,
  KATANA_VENUE_ID,
  bookLimitForDepth,
  isKatanaInterval,
  katana,
} from './rest.js';

// --- wire shapes -------------------------------------------------------------
// Field names and types taken from live responses, not from documentation.

export interface KatanaMarket {
  market: string;
  type: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  stepSize: string;
  tickSize: string;
  minimumPositionSize?: string;
  indexPrice?: string;
}

export interface KatanaTicker {
  market: string;
  time?: number;
  open?: string;
  high?: string;
  low?: string;
  close?: string;
  baseVolume?: string;
  quoteVolume?: string;
  percentChange?: string;
  trades?: number;
  bid?: string;
  ask?: string;
  markPrice?: string;
  indexPrice?: string;
}

/** Book levels arrive as positional tuples: [price, size, orderCount]. */
export type KatanaBookLevel = [string, string, number?];

export interface KatanaBook {
  sequence?: number;
  bids?: KatanaBookLevel[];
  asks?: KatanaBookLevel[];
  lastPrice?: string;
  markPrice?: string;
  indexPrice?: string;
}

export interface KatanaTrade {
  fillId: string;
  price: string;
  quantity: string;
  quoteQuantity?: string;
  time: number;
  /** The RESTING side, not the aggressor. See `normaliseKatanaTrade`. */
  makerSide: string;
  sequence?: number;
}

export interface KatanaCandle {
  start: number;
  open: string;
  high: string;
  low: string;
  close: string;
  baseVolume?: string;
  quoteVolume?: string;
  trades?: number;
}

// --- pure normalisers --------------------------------------------------------

export function normaliseKatanaMarket(m: KatanaMarket): VenueSymbol {
  return {
    symbol: m.market,
    displayName: m.market,
    base: m.baseAsset,
    quote: m.quoteAsset,
    status: m.status,
    tickSize: m.tickSize,
    stepSize: m.stepSize,
    // Katana calls it a position size, but it is the same quantity floor the
    // Venue interface means by minQuantity.
    minQuantity: decStr(m.minimumPositionSize),
  };
}

export function normaliseKatanaTicker(t: KatanaTicker): VenueTicker {
  return {
    symbol: t.market,
    // `close` is the last traded price; Katana has no separate `last` field.
    last: decStr(t.close),
    bid: decStr(t.bid),
    ask: decStr(t.ask),
    open24h: decStr(t.open),
    high24h: decStr(t.high),
    low24h: decStr(t.low),
    baseVolume24h: decStr(t.baseVolume),
    quoteVolume24h: decStr(t.quoteVolume),
    // Already percent units - verified: open 97.65 -> close 108.36 is published
    // as "10.96774100", which is the percentage, not the fraction. No scaling.
    changePct24h: numOrNull(t.percentChange),
    markPrice: decStr(t.markPrice),
    indexPrice: decStr(t.indexPrice),
  };
}

/**
 * Invert Katana's maker side to get the aggressor.
 *
 * `makerSide` names the account that was RESTING on the book. The account that
 * crossed the spread is on the other side of that print, so takerSide is its
 * opposite. Anything unrecognised is treated as a sell, and deliberately so: it
 * keeps the return type total, and a mislabelled print is bounded to one row,
 * whereas throwing here would blank an entire tape over one bad field.
 */
export function takerSideFromMaker(makerSide: unknown): 'buy' | 'sell' {
  return String(makerSide).toLowerCase() === 'buy' ? 'sell' : 'buy';
}

export function normaliseKatanaTrade(t: KatanaTrade): VenueTrade {
  return {
    id: t.fillId,
    price: t.price,
    size: t.quantity,
    takerSide: takerSideFromMaker(t.makerSide),
    timestamp: t.time,
    sequence: numOrNull(t.sequence),
  };
}

export function normaliseKatanaCandle(c: KatanaCandle): VenueCandle {
  return {
    start: c.start,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    baseVolume: decStr(c.baseVolume),
    quoteVolume: decStr(c.quoteVolume),
    trades: numOrNull(c.trades),
  };
}

const level = ([price, size]: KatanaBookLevel) => ({ price, size });

/**
 * Normalise a book snapshot and trim it to the requested per-side depth.
 *
 * The trim is not redundant with the request. Katana's `limit` counts both sides
 * together and it splits them evenly, so an odd or widened request comes back
 * with a different per-side count than the caller asked for - and a 1-level
 * request had to be widened to 2 because Katana rejects limit<2 outright.
 * Slicing here makes the returned depth match the requested depth exactly.
 *
 * The venue's own ordering is trusted (bids descending, asks ascending, as
 * observed) but not assumed: both sides are sorted, because a book rendered in
 * the wrong order puts the worst price at the top of the ladder.
 */
export function normaliseKatanaBook(symbol: string, b: KatanaBook, depth: number): VenueOrderbook {
  const perSide = Math.max(1, Math.trunc(depth) || 1);
  const bids = (b.bids ?? []).map(level).sort((x, y) => Number(y.price) - Number(x.price));
  const asks = (b.asks ?? []).map(level).sort((x, y) => Number(x.price) - Number(y.price));
  return {
    symbol,
    bids: bids.slice(0, perSide),
    asks: asks.slice(0, perSide),
    sequence: numOrNull(b.sequence),
    // Katana does not stamp the snapshot; `sequence` is the only revision marker.
    // Substituting our receive time would be inventing a venue timestamp.
    timestamp: null,
  };
}

/**
 * Canonical market id.
 *
 * All nine live markets are uppercase ("BTC-USD"), and Katana matches exactly, so
 * uppercasing here means a lowercase URL works instead of 404ing.
 */
export const canonicalMarket = (symbol: string): string => symbol.trim().toUpperCase();

function requireInterval(interval: string): string {
  if (!isKatanaInterval(interval)) {
    throw new UnsupportedIntervalError(KATANA_VENUE_ID, interval, KATANA_INTERVALS);
  }
  return interval;
}

// --- venue -------------------------------------------------------------------

export const katanaVenue: Venue = {
  info: KATANA_INFO,

  async symbols(): Promise<VenueSymbol[]> {
    const raw = await katana.get<KatanaMarket[]>('/v1/markets');
    return (Array.isArray(raw) ? raw : []).map(normaliseKatanaMarket);
  },

  async tickers(): Promise<VenueTicker[]> {
    const raw = await katana.get<KatanaTicker[]>('/v1/tickers');
    return (Array.isArray(raw) ? raw : []).map(normaliseKatanaTicker);
  },

  async orderbook(symbol: string, depth: number): Promise<VenueOrderbook> {
    const market = canonicalMarket(symbol);
    const perSide = clampLimit(depth, 20, 1, KATANA_MAX_BOOK_DEPTH);
    // level=2 is required for a real ladder: the default (level=1) returns only
    // top-of-book, which would look like a one-deep market rather than an error.
    const q = new URLSearchParams({
      market,
      level: '2',
      limit: String(bookLimitForDepth(perSide)),
    });
    const raw = await katana.get<KatanaBook>(`/v1/orderbook?${q}`);
    return normaliseKatanaBook(market, raw, perSide);
  },

  async trades(symbol: string, limit: number): Promise<VenueTrade[]> {
    const market = canonicalMarket(symbol);
    const n = clampLimit(limit, 50, 1, KATANA_MAX_ROWS);
    const q = new URLSearchParams({ market, limit: String(n) });
    const raw = await katana.get<KatanaTrade[]>(`/v1/trades?${q}`);
    return sortTradesNewestFirst((Array.isArray(raw) ? raw : []).map(normaliseKatanaTrade));
  },

  async candles(symbol: string, interval: string, limit: number): Promise<VenueCandle[]> {
    const market = canonicalMarket(symbol);
    const iv = requireInterval(interval);
    const n = clampLimit(limit, 300, 1, KATANA_MAX_ROWS);
    const q = new URLSearchParams({ market, interval: iv, limit: String(n) });
    const raw = await katana.get<KatanaCandle[]>(`/v1/candles?${q}`);
    return sortCandlesOldestFirst((Array.isArray(raw) ? raw : []).map(normaliseKatanaCandle));
  },
};

export { KATANA_INTERVALS, KATANA_VENUE_ID, bookLimitForDepth, isKatanaInterval };

/**
 * SoDEX as a Venue.
 *
 * This is an ADAPTER, not a second client. Every call goes through the existing
 * `SodexClient` and `sodex/symbols.ts`, so the weight budget, the response cache,
 * the retry policy and the symbol resolver stay in one place. Duplicating any of
 * that here would give SoDEX two independent views of a budget the gateway
 * enforces per IP - and the first symptom would be 429s that neither copy could
 * explain.
 *
 * SoDEX has two engines with disjoint symbol universes, so it registers as TWO
 * venues rather than one with a mode flag. A venue is a market universe; folding
 * spot and perps together would mean every method needed an engine argument the
 * Katana implementation has no use for.
 *
 * Read-only, like the rest of this directory. The signed write path already
 * exists in routes/trade.ts and is not reachable from here.
 */
import { enginePath, type Engine } from '../config.js';
import { sodex } from '../sodex/rest.js';
import { resolve, symbols as sodexSymbols, type Symbol as SodexSymbol } from '../sodex/symbols.js';
import {
  UnsupportedIntervalError,
  clampLimit,
  decStr,
  numOrNull,
  sortCandlesOldestFirst,
  sortTradesNewestFirst,
  type Venue,
  type VenueCandle,
  type VenueInfo,
  type VenueOrderbook,
  type VenueSymbol,
  type VenueTicker,
  type VenueTrade,
} from './types.js';

/**
 * Intervals the SoDEX gateway accepts. Copied from the set routes/market.ts
 * already validates against, so the two cannot drift into disagreeing about what
 * the same backend supports.
 *
 * Note this set is NOT Katana's - it is larger and cased differently ('1D' here
 * versus '1d' there). That is precisely why `VenueInfo.intervals` exists instead
 * of a shared constant: pretending the two venues have one interval vocabulary
 * would mean one of them silently 400s.
 */
export const SODEX_INTERVALS = [
  '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1D', '3D', '1W', '1M',
] as const;

/** Documented maxima, matching the caps routes/market.ts already applies. */
const MAX_BOOK_DEPTH = 500;
const MAX_TRADES = 500;
const MAX_KLINES = 1000;

// --- wire shapes -------------------------------------------------------------
// Taken from live mainnet responses.

interface SodexTicker {
  symbol: string;
  lastPx?: string;
  openPx?: string;
  highPx?: string;
  lowPx?: string;
  volume?: string;
  quoteVolume?: string;
  changePct?: number | string;
  bidPx?: string;
  askPx?: string;
  markPrice?: string;
  indexPrice?: string;
}

interface SodexBook {
  blockTime?: number;
  updateID?: number;
  bids?: Array<[string, string]>;
  asks?: Array<[string, string]>;
}

interface SodexPublicTrade {
  /** Trade id, monotonic. */
  t: number;
  /** Timestamp, ms. */
  T: number;
  /** Aggressor side. */
  S: string;
  p: string;
  q: string;
}

interface SodexKline {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v?: string;
  q?: string;
  n?: number;
}

// --- pure normalisers --------------------------------------------------------

export function normaliseSodexSymbol(s: SodexSymbol): VenueSymbol {
  return {
    // `name` is the id the gateway's own market-data paths take; displayName is
    // for humans and the two are not always equal (e.g. "vBTC_vUSDC" on spot).
    symbol: s.name,
    displayName: s.displayName || s.name,
    base: s.baseCoin,
    quote: s.quoteCoin,
    status: s.status,
    tickSize: s.tickSize,
    stepSize: s.stepSize,
    minQuantity: decStr(s.minQuantity),
  };
}

export function normaliseSodexTicker(t: SodexTicker): VenueTicker {
  return {
    symbol: t.symbol,
    last: decStr(t.lastPx),
    bid: decStr(t.bidPx),
    ask: decStr(t.askPx),
    open24h: decStr(t.openPx),
    high24h: decStr(t.highPx),
    low24h: decStr(t.lowPx),
    baseVolume24h: decStr(t.volume),
    quoteVolume24h: decStr(t.quoteVolume),
    // Already percent units - verified: open 140.19 -> last 140.27 is published
    // as changePct 0.0570, i.e. 0.057%, not 5.7%. No scaling.
    changePct24h: numOrNull(t.changePct),
    // Absent on spot, where the concepts do not exist. decStr yields null, which
    // the UI must render as blank rather than as a zero mark price.
    markPrice: decStr(t.markPrice),
    indexPrice: decStr(t.indexPrice),
  };
}

/**
 * `S` is the AGGRESSOR side on SoDEX, so it maps straight across with no
 * inversion - the opposite of Katana, which publishes the maker. The two
 * adapters differing here is the point of normalising to `takerSide` at all.
 */
export function normaliseSodexTrade(t: SodexPublicTrade): VenueTrade {
  return {
    id: String(t.t),
    price: t.p,
    size: t.q,
    takerSide: String(t.S).toUpperCase() === 'BUY' ? 'buy' : 'sell',
    timestamp: t.T,
    sequence: numOrNull(t.t),
  };
}

export function normaliseSodexKline(k: SodexKline): VenueCandle {
  return {
    start: k.t,
    open: k.o,
    high: k.h,
    low: k.l,
    close: k.c,
    baseVolume: decStr(k.v),
    quoteVolume: decStr(k.q),
    trades: numOrNull(k.n),
  };
}

export function normaliseSodexBook(symbol: string, b: SodexBook, depth: number): VenueOrderbook {
  const perSide = Math.max(1, Math.trunc(depth) || 1);
  const level = ([price, size]: [string, string]) => ({ price, size });
  const bids = (b.bids ?? []).map(level).sort((x, y) => Number(y.price) - Number(x.price));
  const asks = (b.asks ?? []).map(level).sort((x, y) => Number(x.price) - Number(y.price));
  return {
    symbol,
    bids: bids.slice(0, perSide),
    asks: asks.slice(0, perSide),
    // `updateID` is the gateway's book revision; blockTime is when the block that
    // produced it was sealed. Unlike Katana, SoDEX does stamp its snapshots.
    sequence: numOrNull(b.updateID),
    timestamp: numOrNull(b.blockTime),
  };
}

// --- venue -------------------------------------------------------------------

function makeSodexVenue(engine: Engine): Venue {
  const id = `sodex-${engine}`;
  const info: VenueInfo = {
    id,
    label: engine === 'spot' ? 'SoDEX Spot' : 'SoDEX Perps',
    kind: engine,
    intervals: SODEX_INTERVALS,
    maxBookDepth: MAX_BOOK_DEPTH,
    maxRows: MAX_KLINES,
  };

  /**
   * Resolve a caller's reference to the gateway's canonical symbol name.
   *
   * Uses the shared resolver, so a display name, an internal name or a numeric
   * symbolID all work, and an unknown one raises SymbolNotFoundError - which the
   * app's error handler already turns into a 404 rather than a 500.
   */
  const canonical = async (ref: string): Promise<string> => (await resolve(engine, ref)).name;

  return {
    info,

    async symbols(): Promise<VenueSymbol[]> {
      return (await sodexSymbols(engine)).map(normaliseSodexSymbol);
    },

    async tickers(): Promise<VenueTicker[]> {
      const raw = await sodex.get<SodexTicker[]>(`${enginePath(engine)}/markets/tickers`);
      return (Array.isArray(raw) ? raw : []).map(normaliseSodexTicker);
    },

    async orderbook(symbol: string, depth: number): Promise<VenueOrderbook> {
      const name = await canonical(symbol);
      const perSide = clampLimit(depth, 20, 1, MAX_BOOK_DEPTH);
      // SoDEX's `limit` is already per-side - verified: limit=3 returns 3 bids
      // and 3 asks. No doubling, unlike Katana. Depth >100 is billed at double
      // weight, which is why the weight is passed explicitly.
      const raw = await sodex.get<SodexBook>(
        `${enginePath(engine)}/markets/${name}/orderbook?limit=${perSide}`,
        perSide > 100 ? 10 : 5,
      );
      return normaliseSodexBook(name, raw, perSide);
    },

    async trades(symbol: string, limit: number): Promise<VenueTrade[]> {
      const name = await canonical(symbol);
      const n = clampLimit(limit, 50, 1, MAX_TRADES);
      const raw = await sodex.get<SodexPublicTrade[]>(
        `${enginePath(engine)}/markets/${name}/trades?limit=${n}`,
      );
      return sortTradesNewestFirst((Array.isArray(raw) ? raw : []).map(normaliseSodexTrade));
    },

    async candles(symbol: string, interval: string, limit: number): Promise<VenueCandle[]> {
      if (!(SODEX_INTERVALS as readonly string[]).includes(interval)) {
        throw new UnsupportedIntervalError(id, interval, SODEX_INTERVALS);
      }
      const name = await canonical(symbol);
      const n = clampLimit(limit, 300, 1, MAX_KLINES);
      const q = new URLSearchParams({ interval, limit: String(n) });
      const raw = await sodex.get<SodexKline[]>(
        `${enginePath(engine)}/markets/${name}/klines?${q}`,
      );
      // SoDEX returns klines NEWEST first; Katana returns them oldest first. The
      // shared sort is what makes both safe to chart without the caller knowing.
      return sortCandlesOldestFirst((Array.isArray(raw) ? raw : []).map(normaliseSodexKline));
    },
  };
}

export const sodexPerpsVenue = makeSodexVenue('perps');
export const sodexSpotVenue = makeSodexVenue('spot');

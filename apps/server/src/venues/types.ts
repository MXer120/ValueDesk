/**
 * The venue abstraction: the read-only market-data surface that every supported
 * exchange can actually satisfy.
 *
 * SCOPE IS DELIBERATELY NARROW. This interface has five methods because five is
 * what SoDEX and Katana genuinely have in common. Trading, positions, balances
 * and funding history are NOT here: SoDEX reaches them through a signed EIP-712
 * session that Katana has no equivalent for, and Katana's own write path needs an
 * API key plus HMAC plus a separate EIP-712 wallet signature. Modelling a
 * "placeOrder" that only one implementation can honour would turn a compile-time
 * guarantee into a runtime surprise on a screen that signs real mainnet orders.
 *
 * NORMALISATION RULES, and why each one exists:
 *
 *  - Prices and sizes stay STRINGS, exactly as the venue published them. Both
 *    venues send decimal strings; parsing them to float here would bake a
 *    rounding error into every downstream consumer for no gain.
 *  - A field the venue does not publish is `null`, never 0, never ''. A zero
 *    mark price is a lie a trader can act on; a null is a blank cell.
 *  - Ordering is fixed by this layer (see each type) because the two venues
 *    disagree, and a caller that renders whatever arrives would draw one venue's
 *    chart backwards.
 *  - Trade side is normalised to the AGGRESSOR. SoDEX publishes the aggressor
 *    directly; Katana publishes the maker. See `VenueTrade.takerSide`.
 */

/** A market-data failure that is the caller's fault, carrying an HTTP status. */
export class VenueRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly venue: string,
  ) {
    super(message);
    this.name = 'VenueRequestError';
  }
}

/**
 * An interval the venue does not offer.
 *
 * Separate from the generic error because the useful part of the response is the
 * list of intervals that WOULD have worked - a caller can only correct itself if
 * it is told the alternatives.
 */
export class UnsupportedIntervalError extends VenueRequestError {
  constructor(
    venue: string,
    readonly interval: string,
    readonly supported: readonly string[],
  ) {
    super(`unsupported interval "${interval}" for ${venue}`, 400, venue);
    this.name = 'UnsupportedIntervalError';
  }
}

export interface VenueInfo {
  /** Stable slug used in URLs. Lowercase, no spaces. */
  id: string;
  label: string;
  /** Which product this venue's symbol universe contains. */
  kind: 'spot' | 'perps';
  /** Candle intervals this venue accepts. The two venues do NOT share a set. */
  intervals: readonly string[];
  /**
   * Maximum orderbook levels PER SIDE this venue will return. The wire protocols
   * disagree about what "limit" counts (see the Katana adapter), so the
   * abstraction always speaks in levels-per-side and each adapter converts.
   */
  maxBookDepth: number;
  /** Maximum rows for trades/candles. */
  maxRows: number;
}

export interface VenueSymbol {
  /** The identifier every other method on this venue accepts. */
  symbol: string;
  displayName: string;
  base: string;
  quote: string;
  status: string;
  /** Minimum price increment, decimal string. */
  tickSize: string;
  /** Minimum quantity increment, decimal string. */
  stepSize: string;
  /** Smallest tradable quantity, or null if the venue does not publish one. */
  minQuantity: string | null;
}

export interface VenueTicker {
  symbol: string;
  last: string | null;
  bid: string | null;
  ask: string | null;
  open24h: string | null;
  high24h: string | null;
  low24h: string | null;
  baseVolume24h: string | null;
  quoteVolume24h: string | null;
  /**
   * 24h change in PERCENT units (2.5 means +2.5%), not a fraction.
   *
   * Verified against both venues rather than assumed: SoDEX publishes
   * changePct=0.0570 for open 140.19 -> last 140.27, and Katana publishes
   * percentChange="10.9677" for open 97.65 -> close 108.36. Both are percent.
   *
   * A number, not a string, because both venues already spent the precision -
   * SoDEX sends it as a JSON number. Display only; never do money arithmetic
   * with it.
   */
  changePct24h: number | null;
  /** Perps only. Null on a spot venue, which does not have the concept. */
  markPrice: string | null;
  indexPrice: string | null;
}

export interface VenueBookLevel {
  price: string;
  size: string;
}

export interface VenueOrderbook {
  symbol: string;
  /** Best first: descending price. */
  bids: VenueBookLevel[];
  /** Best first: ascending price. */
  asks: VenueBookLevel[];
  /**
   * Venue-assigned book revision, or null if the venue does not publish one.
   * Exposed so a caller can tell two snapshots apart; this layer does not
   * maintain an incrementally-updated book (see the Katana adapter's note on L2).
   */
  sequence: number | null;
  /** Venue timestamp in ms, or null if the venue does not stamp the snapshot. */
  timestamp: number | null;
}

export interface VenueTrade {
  id: string;
  price: string;
  size: string;
  /**
   * Side of the AGGRESSOR - the account that crossed the spread.
   *
   * This is the field the two venues disagree about and the reason the
   * normalisation is not a rename. SoDEX publishes `S` as the aggressor side, so
   * it maps straight across. Katana publishes `makerSide`, the RESTING side, so
   * its value must be INVERTED. Copying Katana's field through unchanged would
   * paint every print the wrong colour and invert the buy/sell pressure read off
   * the tape.
   */
  takerSide: 'buy' | 'sell';
  timestamp: number;
  /** Monotonic venue sequence where published; used as the sort tiebreak. */
  sequence: number | null;
}

export interface VenueCandle {
  /** Bucket open time, ms. */
  start: number;
  open: string;
  high: string;
  low: string;
  close: string;
  baseVolume: string | null;
  quoteVolume: string | null;
  trades: number | null;
}

export interface Venue {
  readonly info: VenueInfo;
  symbols(): Promise<VenueSymbol[]>;
  tickers(): Promise<VenueTicker[]>;
  /** `depth` is levels PER SIDE. Sorted best-first. */
  orderbook(symbol: string, depth: number): Promise<VenueOrderbook>;
  /** Newest first - the tape convention, and what a "recent trades" panel wants. */
  trades(symbol: string, limit: number): Promise<VenueTrade[]>;
  /** Oldest first - the chart convention, so a series can be drawn left to right. */
  candles(symbol: string, interval: string, limit: number): Promise<VenueCandle[]>;
}

// --- shared helpers ----------------------------------------------------------

/**
 * Coerce a venue field to a decimal string, or null when absent.
 *
 * The null branch is the whole point: a missing mark price must reach the UI as
 * "nothing to show", not as "0". Numbers are stringified rather than rejected
 * because SoDEX sends some fields as JSON numbers and others as strings.
 */
export function decStr(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() === '' ? null : v;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  return null;
}

/** Same contract as `decStr` for counts: null rather than a fabricated 0. */
export function numOrNull(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Clamp a caller-supplied row count into the venue's accepted range.
 *
 * Non-numeric input falls back to `fallback` rather than throwing: a bad `limit`
 * on a query string should not deny the trader their data, and the venue would
 * only reject it for us one round trip later.
 */
export function clampLimit(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Sort trades newest-first, sequence breaking ties.
 *
 * Applied to both venues instead of trusting either one's document order: SoDEX
 * returns descending and Katana ascending today, and a silent change to either
 * would otherwise flip a tape upside down with no error anywhere.
 */
export function sortTradesNewestFirst(trades: VenueTrade[]): VenueTrade[] {
  return trades.sort((a, b) => b.timestamp - a.timestamp || (b.sequence ?? 0) - (a.sequence ?? 0));
}

/** Sort candles oldest-first, for the same reason as `sortTradesNewestFirst`. */
export function sortCandlesOldestFirst(candles: VenueCandle[]): VenueCandle[] {
  return candles.sort((a, b) => a.start - b.start);
}

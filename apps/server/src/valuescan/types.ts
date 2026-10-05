/**
 * The Valuescan multi-venue contract.
 *
 * One shape for "a trader" regardless of where they trade, so the Explore,
 * Leaderboard, Scan and Copy pages never branch on venue. Each venue implements
 * `VenueProvider` in its own folder (valuescan/sodex, valuescan/hyperliquid);
 * routes/valuescan.ts dispatches to them and merges for `venue=all`.
 *
 * The web app imports these types through the `@sign` alias (vite.config.ts
 * maps it to apps/server/src), so the browser and the server cannot drift.
 *
 * Numbers are plain JS numbers (USD unless the field says otherwise). This is
 * display and ranking data, never signed, so decimal strings would only add
 * parsing at every call site. `null` means "the venue does not provide this".
 * It never means zero.
 */

/**
 * Every venue the leaderboard and Scan know. `tradexyz` is Hyperliquid's
 * HIP-3 dex "xyz" (markets `xyz:*`), ranked on its own.
 */
export type Venue = 'sodex' | 'hyperliquid' | 'tradexyz' | 'lighter' | 'arcus';
export const VENUES: readonly Venue[] = ['sodex', 'hyperliquid', 'tradexyz', 'lighter', 'arcus'];
/** The venues with the full provider surface (explore, screener, whales, positioning, copy). */
export type CoreVenue = 'sodex' | 'hyperliquid';
export const CORE_VENUES: readonly CoreVenue[] = ['sodex', 'hyperliquid'];
export const isCoreVenue = (v: Venue): v is CoreVenue => v === 'sodex' || v === 'hyperliquid';

export type Window = '1d' | '7d' | '30d' | 'all';
export const WINDOWS: readonly Window[] = ['1d', '7d', '30d', 'all'];

/**
 * Windows the leaderboard page can show. `90d` and `ytd` are not published by
 * either venue; the server index computes them from portfolio charts.
 */
export type BoardWindow = Window | '90d' | 'ytd';
export const BOARD_WINDOWS: readonly BoardWindow[] = ['1d', '7d', '30d', '90d', 'ytd', 'all'];

export type LeaderboardSort = 'pnl' | 'roi' | 'volume' | 'accountValue';

/** One trader as a row: the unit of Leaderboard, Explore and search results. */
export interface TraderRow {
  venue: Venue;
  /** 0x EVM address, lower-case. */
  address: string;
  /** Display name if the venue publishes one (e.g. a Hyperliquid display name). */
  label?: string | null;
  /** A netted row: every venue whose figures were summed into it. */
  venues?: Venue[];
  /** SoDEX numeric account id, when known. */
  accountId?: number | null;
  accountValue: number | null;
  pnl: Partial<Record<BoardWindow, number | null>>;
  /** Fraction, 0.12 = +12%. */
  roi: Partial<Record<Window, number | null>>;
  volume: Partial<Record<BoardWindow, number | null>>;
  /**
   * Fraction 0..1: winning closes / closes with a non-zero result (see
   * valuescan/winRate.ts for what one close is). Null below WIN_RATE_MIN_CLOSES
   * held closes unless the figure covers the whole window.
   */
  winRate?: number | null;
  /** True: every close in the window is held. False: an estimate from the closes held (`winRateCloses`). */
  winRateExact?: boolean;
  /** How many closes the win rate is computed from. */
  winRateCloses?: number | null;
  /** An estimate's oldest held close (ms). Null when exact or unknown. */
  winRateFrom?: number | null;
  /** Closing trades in the index sample. `tradesCapped` means the sample hit the venue's page cap. */
  trades?: number | null;
  tradesCapped?: boolean;
  /** Largest open positions, venue symbol spelling. Filled by the live trader index. */
  assets?: string[];
  /** Fraction 0..1, positive number = size of the worst peak-to-trough. */
  maxDrawdown?: number | null;
  sharpe?: number | null;
  /** ms epoch of the last known fill. */
  lastActive?: number | null;
  /** Cumulative PnL samples, oldest to newest, for a sparkline. */
  spark?: number[];
  /** Free-form style tags ('whale', 'scalper', 'swing', 'high-leverage', ...). */
  tags?: string[];
  rank?: number;
  /**
   * Positive = moved up since the previous snapshot. On index boards the
   * snapshot is the board about 24 h earlier (`index.rankSince`); null when
   * the trader was not on it then.
   */
  rankChange?: number | null;
}

export interface LeaderboardQuery {
  window: Window;
  sort: LeaderboardSort;
  limit: number;
  offset: number;
  /** Case-insensitive address prefix or label substring. */
  q?: string;
  /**
   * `worst` selects the lowest PnL hundred. It does not change which
   * column the caller later sorts. Default is the highest PnL.
   */
  side?: 'top' | 'worst';
}

export interface LeaderboardPage {
  rows: TraderRow[];
  total: number;
  updatedAt: number;
  /** Where the numbers came from, shown in the UI ("sodex.com leaderboard", "Hyperliquid stats"). */
  source: string;
}

export interface LeaderboardResponse extends LeaderboardPage {
  venue: Venue | 'all';
  window: BoardWindow;
  sort: LeaderboardSort;
}

/** One SoSoValue story, already reduced to what Explore renders. No HTML. */
export interface NewsItem {
  id: string;
  title: string;
  href: string;
  /** Publish time, milliseconds. 0 when the feed omitted it. */
  time: number;
  author: string | null;
  /** Matched coin symbols, at most three. */
  symbols: string[];
}

export interface VsPosition {
  symbol: string;
  side: 'long' | 'short';
  /** Absolute size in base units. */
  size: number;
  notional: number;
  entryPx: number | null;
  markPx: number | null;
  liqPx: number | null;
  uPnl: number | null;
  leverage: number | null;
  marginMode?: 'cross' | 'isolated' | null;
}

export interface VsFill {
  /** Venue-unique fill id (trade id / tid). */
  id: string;
  time: number;
  symbol: string;
  side: 'buy' | 'sell';
  px: number;
  sz: number;
  notional: number;
  fee: number | null;
  /** Realised PnL booked by this fill, when the venue reports it. */
  closedPnl: number | null;
  /** Venue's own direction label if any ('Open Long', 'Close Short', ...). */
  dir?: string | null;
  /** The order this fill belongs to, when the venue says. */
  oid?: string | null;
}

/** One order, open or historical. */
export interface VsOrder {
  id: string;
  /** Placed (open orders) or last status change (history), ms. */
  time: number;
  symbol: string;
  side: 'buy' | 'sell';
  /** limit, market, stop market, take profit, ... as the venue names it, lower-case. */
  type: string;
  price: number | null;
  trigger: number | null;
  size: number;
  filled: number | null;
  /** open, filled, canceled, rejected, triggered, ... lower-case. */
  status: string;
  reduceOnly: boolean;
  tif?: string | null;
}

/** One funding payment. Positive = received. */
export interface VsFunding {
  time: number;
  symbol: string;
  amount: number;
  rate: number | null;
  /** Signed position size the payment was on. */
  size: number | null;
}

export interface VsBalance {
  coin: string;
  total: number;
  /** Not locked in orders / margin, when the venue says. */
  available: number | null;
  /** USD value, when the venue says (stablecoins count 1:1). */
  usd: number | null;
}

export interface EquityPoint {
  t: number;
  accountValue: number | null;
  /** Cumulative PnL at t, relative to the start of the window. */
  pnl: number | null;
}

export interface TraderProfile {
  summary: TraderRow;
  positions: VsPosition[];
  equity: Partial<Record<Window, EquityPoint[]>>;
  openOrders?: number | null;
  updatedAt: number;
  source: string;
  /**
   * The venue's own portfolio analytics for this account cannot be used
   * (SoDEX: sodex/mappers.ts chartSuspect). Then the account value is the
   * live one, the curves carry no account-value series, and the analytics'
   * PnL is left out (null) rather than shown.
   */
  analyticsSuspect?: 'no-deposits-recorded' | 'live-mismatch' | 'single-jump' | null;
}

export interface WhaleTrade {
  venue: Venue;
  time: number;
  symbol: string;
  side: 'buy' | 'sell';
  px: number;
  sz: number;
  notional: number;
  /** Taker address when known (SoDEX resolves it from the account id). */
  address: string | null;
  accountId?: number | null;
}

/** Net positioning of the tracked top traders in one market. */
export interface Positioning {
  venue: Venue;
  symbol: string;
  longUsd: number;
  shortUsd: number;
  longTraders: number;
  shortTraders: number;
}

export interface ExploreSegment {
  id: string;
  title: string;
  subtitle: string;
  rows: TraderRow[];
}

export interface ExploreResponse {
  kpis: { tracked: number; volume24h: number | null; venues: Venue[] };
  segments: ExploreSegment[];
  updatedAt: number;
}

/** Everything a venue must answer. Throwing is fine; routes turn it into {ok:false}. */
export interface VenueProvider {
  venue: Venue;
  leaderboard(q: LeaderboardQuery): Promise<LeaderboardPage>;
  /** null = no such trader / no activity on this venue. */
  trader(address: string): Promise<TraderProfile | null>;
  fills(address: string, o: { from?: number; to?: number; limit?: number }): Promise<VsFill[]>;
  /** Most recent large trades, newest first. */
  whales(minUsd: number, limit: number): Promise<WhaleTrade[]>;
  positioning(symbol?: string): Promise<Positioning[]>;
}

/** Thrown by a provider for a feature the venue cannot serve yet. Maps to HTTP 200 {ok:false, code:'not_available'}. */
export class NotAvailable extends Error {
  readonly code = 'not_available';
}

/**
 * Raw Hyperliquid payload shapes.
 *
 * Field names verified against live responses on 2026-09-25 (see
 * docs/research/02-hyperliquid.md section 1). Every number HL sends as JSON is
 * a decimal STRING ("59712661.85"), except timestamps, ids and leverage values.
 * Nothing here is ever sent back to HL: these are read-only payloads.
 */

export type Dec = string;

/** HL's own window names, in the leaderboard and in `portfolio`. */
export type HlWindowName = 'day' | 'week' | 'month' | 'allTime';

// --- stats-data.hyperliquid.xyz/Mainnet/leaderboard ---------------------------

export interface HlLeaderboardPerf {
  pnl: Dec;
  /** Fraction: "0.0124" = +1.24%. */
  roi: Dec;
  vlm: Dec;
}

export interface HlLeaderboardRowRaw {
  ethAddress: string;
  accountValue: Dec;
  windowPerformances: Array<[string, HlLeaderboardPerf]>;
  prize?: number;
  displayName: string | null;
}

export interface HlLeaderboardRaw {
  leaderboardRows: HlLeaderboardRowRaw[];
}

// --- POST /info {type:"clearinghouseState", user, dex?} ------------------------

export interface HlMarginSummary {
  accountValue: Dec;
  totalNtlPos: Dec;
  totalRawUsd: Dec;
  totalMarginUsed: Dec;
}

export interface HlPositionRaw {
  /** "BTC" on the default dex, "xyz:XYZ100" on a HIP-3 dex. */
  coin: string;
  /** Signed size: positive = long. */
  szi: Dec;
  leverage: { type: 'cross' | 'isolated'; value: number; rawUsd?: Dec };
  entryPx: Dec | null;
  /** |szi| x mark price. */
  positionValue: Dec;
  unrealizedPnl: Dec;
  returnOnEquity?: Dec;
  liquidationPx: Dec | null;
  marginUsed: Dec;
  maxLeverage?: number;
  cumFunding?: { allTime: Dec; sinceOpen: Dec; sinceChange: Dec };
}

export interface HlClearinghouseState {
  marginSummary: HlMarginSummary;
  crossMarginSummary?: HlMarginSummary;
  crossMaintenanceMarginUsed?: Dec;
  withdrawable?: Dec;
  assetPositions: Array<{ type: string; position: HlPositionRaw }>;
  time?: number;
}

// --- POST /info {type:"portfolio", user} ---------------------------------------

export interface HlPortfolioWindow {
  accountValueHistory: Array<[number, Dec]>;
  /** Cumulative PnL since the window start (first point is 0). */
  pnlHistory: Array<[number, Dec]>;
  vlm: Dec;
}

/** 8 entries: day, week, month, allTime and the perp-only perpDay..perpAllTime. */
export type HlPortfolio = Array<[string, HlPortfolioWindow]>;

// --- POST /info {type:"userFills" | "userFillsByTime"} -------------------------

export interface HlFillRaw {
  coin: string;
  px: Dec;
  sz: Dec;
  /** The USER's side: B = bought, A = sold. */
  side: 'B' | 'A';
  time: number;
  startPosition?: Dec;
  /** "Open Long", "Close Short", "Long > Short", "Buy", "Sell", ... */
  dir?: string;
  closedPnl?: Dec;
  hash?: string;
  oid?: number;
  /** true = this user was the taker. */
  crossed?: boolean;
  /** Total fee paid, builder fee INCLUDED (verified: 7.5 bps = 3.6 exchange + 3.9 builder). */
  fee?: Dec;
  builderFee?: Dec;
  tid: number;
  cloid?: string | null;
  /** Usually "USDC". Spot buys pay the fee in the base token. */
  feeToken?: string;
  twapId?: number | null;
  liquidation?: unknown;
}

// --- wss://api.hyperliquid.xyz/ws  channel "trades" ------------------------------

export interface HlWsTrade {
  coin: string;
  /** The TAKER's side: B = taker bought (users[0]), A = taker sold (users[1]). */
  side: 'B' | 'A';
  px: Dec;
  sz: Dec;
  time: number;
  hash: string;
  tid: number;
  /** [buyer, seller]. */
  users: [string, string];
}

// --- POST /info {type:"metaAndAssetCtxs", dex?} ----------------------------------

export interface HlUniverseEntry {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  isDelisted?: boolean;
}

export interface HlAssetCtx {
  dayNtlVlm: Dec;
  markPx: Dec;
  midPx?: Dec | null;
  openInterest?: Dec;
  funding?: Dec;
  prevDayPx?: Dec;
}

export type HlMetaAndAssetCtxs = [{ universe: HlUniverseEntry[] }, HlAssetCtx[]];

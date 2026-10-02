/**
 * SoDEX REST v1 response shapes (the `data` of `{code: 0, data, timestamp}`).
 *
 * Sources, in order of trust:
 *   [live]   read from mainnet-gw on 2026-09-25 (public GETs, no auth)
 *   [ot]     Opentrade's verified shape knowledge (server/src/sodex/*, web/src/api.ts)
 *   [schema] the published REST schema (sodex.com/documentation/.../rest-v1/schema)
 * Where they disagree the live shape wins and the field carries a note.
 *
 * Conventions:
 *   - Decimals are STRINGS (`Dec`). Never parse them into floats on a path that
 *     signs or re-sends them; see decimal.ts.
 *   - Enums in RESPONSES are STRINGS ('BUY', 'CROSS', 'EVM'), while REQUESTS
 *     use the integers in actions.ts. Unions keep `string` open-ended so a new
 *     value from the venue does not become a type error.
 *   - Timestamps are milliseconds. `blockTime`/`blockHeight` are CLOB appchain
 *     values (~75 ms blocks), not ValueChain EVM ones.
 *   - Missing means missing: optional fields are genuinely absent on some rows.
 */

/** A decimal STRING in canonical form ("0.406", never "4.06e-1"). */
export type Dec = string;

export type SideStr = 'BUY' | 'SELL';
export type OrderTypeStr = 'LIMIT' | 'MARKET' | (string & {});
export type TimeInForceStr = 'GTC' | 'IOC' | 'GTX' | 'FOK' | (string & {});
export type OrderStatusStr =
  | 'NEW'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'TRIGGERED'
  | (string & {});
export type MarginModeStr = 'CROSS' | 'ISOLATED' | (string & {});
/** Live positions are always 'BOTH' (one-way); history and fundings report 'LONG'/'SHORT'. [live] */
export type PositionSideStr = 'BOTH' | 'LONG' | 'SHORT' | (string & {});
export type StopTypeStr = 'STOP_LOSS' | 'TAKE_PROFIT' | (string & {});
export type TriggerTypeStr = 'MARK_PRICE' | 'LAST_PRICE' | 'INDEX_PRICE' | (string & {});

/** The raw envelope. `code === 0` is the ONLY success signal (see envelope.ts). */
export interface ApiEnvelope<T> {
  code: number;
  data: T;
  timestamp: number;
  error?: string;
  message?: string;
}

/** `{blockTime, blockHeight, <list>}` wrapper used by balances/orders/positions/twaps. [live] */
export interface BlockStamped {
  blockTime: number;
  blockHeight: number;
}

// ---------------------------------------------------------------------------
// Markets
// ---------------------------------------------------------------------------

export interface MarginTier {
  maxNotionalValue: Dec;
  maintenanceMarginRate: Dec;
  maxLeverage: number;
  /** Continuity constant keeping the maintenance-margin curve unbroken across tiers. [ot] */
  maintenanceDeduction: Dec;
}

interface SymbolCommon {
  id: number;
  /** Internal name used in paths and WS: 'BTC-USD' (perps), 'vBTC_vUSDC' (spot). */
  name: string;
  /** Human name: 'BTC-USD', 'BTC/USDC'. */
  displayName: string;
  quoteCoinID: number;
  quoteCoin?: string;
  quoteCoinPrecision?: number;
  pricePrecision: number;
  tickSize: Dec;
  /** "0" is the venue's "no minimum" sentinel. [ot] */
  minPrice: Dec;
  /** "0" is the venue's "no maximum" sentinel. [ot] */
  maxPrice: Dec;
  quantityPrecision: number;
  stepSize: Dec;
  minQuantity: Dec;
  maxQuantity: Dec;
  marketMinQuantity: Dec;
  marketMaxQuantity: Dec;
  /** 10 USD perps / 5 USD spot at the time of writing. Reduce-only orders skip it. */
  minNotional: Dec;
  maxNotional: Dec;
  /** Limit price band as a ratio of mark: price <= mark * (1 + buyLimitUpRatio). */
  buyLimitUpRatio?: Dec;
  sellLimitDownRatio?: Dec;
  /** Market-order bound as a ratio of index. */
  marketDeviationRatio?: Dec;
  makerFee: Dec;
  takerFee: Dec;
  status: 'TRADING' | 'HALT' | (string & {});
}

/** GET /api/v1/spot/markets/symbols -> SpotSymbol[] (bare array). [schema][ot] */
export interface SpotSymbol extends SymbolCommon {
  baseCoinID: number;
  baseCoin?: string;
  baseCoinPrecision?: number;
}

/** GET /api/v1/perps/markets/symbols -> PerpsSymbol[] (bare array; 98 on 2026-09-25). [schema][ot] */
export interface PerpsSymbol extends SymbolCommon {
  baseCoin: string;
  maxLeverage: number;
  initLeverage: number;
  marginTiers: MarginTier[];
  /** Seconds; a multiple of 3600. */
  fundingInterval: number;
  interestRate?: Dec;
  maxFundingRate?: Dec;
  minFundingRate?: Dec;
  /** Open-interest cap in base coin / in quote. */
  openInterestCap?: Dec;
  openInterestCapUSD?: Dec;
}

export interface SpotCoin {
  id: number;
  name: string;
  precision: number;
}

export interface PerpsCoin extends SpotCoin {
  marginRatio: Dec;
  price?: Dec;
}

export interface Ticker {
  symbol: string;
  lastPx: Dec;
  lastSz?: Dec;
  openPx: Dec;
  highPx: Dec;
  lowPx: Dec;
  vwap?: Dec;
  change?: Dec;
  /** PERCENT (7.41 = +7.41 %), not a fraction. [ot] */
  changePct?: number;
  /** Base volume, 24 h. */
  volume: Dec;
  /** Quote (USD) volume, 24 h - sort by this, not `volume`. [ot] */
  quoteVolume: Dec;
  bidPx: Dec;
  bidSz: Dec;
  askPx: Dec;
  askSz: Dec;
  openTime: number;
  closeTime: number;
  // perps only
  fundingRate?: Dec;
  nextFundingTime?: number;
  indexPrice?: Dec;
  markPrice?: Dec;
  /** BASE units - multiply by mark for notional. [ot] */
  openInterest?: Dec;
}

export interface MiniTicker {
  symbol: string;
  lastPx: Dec;
  openPx: Dec;
  highPx: Dec;
  lowPx: Dec;
  volume: Dec;
  quoteVolume: Dec;
  openTime: number;
  closeTime: number;
}

/** GET /api/v1/perps/markets/mark-prices */
export interface MarkPriceTicker {
  symbol: string;
  fundingRate: Dec;
  nextFundingTime: number;
  indexPrice: Dec;
  markPrice: Dec;
  openInterest: Dec;
}

export interface BookTicker {
  symbol: string;
  bidPx: Dec;
  bidSz: Dec;
  askPx: Dec;
  askSz: Dec;
}

/** GET /api/v1/{engine}/markets/{symbol}/orderbook */
export interface OrderBook extends BlockStamped {
  updateID: number;
  /** [price, quantity] */
  bids: Array<[Dec, Dec]>;
  asks: Array<[Dec, Dec]>;
}

/** GET /api/v1/{engine}/markets/{symbol}/klines */
export interface Kline {
  t: number;
  o: Dec;
  h: Dec;
  l: Dec;
  c: Dec;
  v: Dec;
  q: Dec;
  n?: number;
}

/**
 * GET /api/v1/{engine}/markets/{symbol}/trades. REST prints carry NO `bi`/`si`
 * (buyer/seller account ids) - only WebSocket `trade` pushes do. [live][ot]
 */
export interface PublicTrade {
  t: number;
  T: number;
  s: string;
  /** Aggressor (taker) side. */
  S: SideStr;
  p: Dec;
  q: Dec;
  bi?: number;
  si?: number;
}

// ---------------------------------------------------------------------------
// Accounts (any address is readable without auth)
// ---------------------------------------------------------------------------

export interface SpotBalance {
  id: number;
  coin: string;
  /** Includes locked. */
  total: Dec;
  locked: Dec;
}

export interface PerpsBalance {
  id: number;
  coin: string;
  /** Wallet balance. */
  total: Dec;
  collateral: Dec;
  marginRatio: Dec;
  price?: Dec;
}

export interface SpotBalances extends BlockStamped {
  balances: SpotBalance[];
}
export interface PerpsBalances extends BlockStamped {
  balances: PerpsBalance[];
}

/** Echoed on orders: the builder attached at placement. */
export interface OrderBuilder {
  builderID: number;
  feeRate: number;
}

/** Open / historical order row. `data` of /orders is wrapped, /orders/history is a bare array. [live] */
export interface OrderRow {
  orderID: number;
  clOrdID?: string;
  symbol: string;
  side: SideStr;
  type: OrderTypeStr;
  timeInForce?: TimeInForceStr;
  price?: Dec;
  origQty?: Dec;
  funds?: Dec;
  executedQty: Dec;
  executedValue: Dec;
  marginFrozen?: Dec;
  builder?: OrderBuilder;
  status: OrderStatusStr;
  createdAt?: number;
  updatedAt?: number;
  // perps only
  positionSide?: PositionSideStr;
  reduceOnly?: boolean;
  stopPrice?: Dec;
  stopType?: StopTypeStr;
  triggerType?: TriggerTypeStr;
  positionID?: number;
  primaryOrderID?: number;
  attachedOrderIDs?: number[];
}

export interface OpenOrders extends BlockStamped {
  orders: OrderRow[];
}

/**
 * GET /api/v1/perps/accounts/{addr}/positions (wrapped) and .../positions/history
 * (bare array, closed positions with realizedPnL - the best PnL source).
 */
export interface PositionRow {
  id: number;
  symbol: string;
  marginMode: MarginModeStr;
  /** [live] The wire field is `positionSide`; the published schema calls it `side`. */
  positionSide: PositionSideStr;
  /** @deprecated schema name; not observed live. */
  side?: PositionSideStr;
  /** Signed base size: "-2.5" is short; "0" is closed. */
  size: Dec;
  initialMargin: Dec;
  avgEntryPrice: Dec;
  cumOpenCost: Dec;
  cumTradingFee: Dec;
  cumClosedSize: Dec;
  avgClosePrice: Dec;
  maxSize: Dec;
  /** Includes trading fees and liquidation loss. */
  realizedPnL: Dec;
  leverage: number;
  active: boolean;
  isTakenOver: boolean;
  takeOverPrice: Dec;
  createdAt: number;
  updatedAt: number;
}

export interface OpenPositions extends BlockStamped {
  positions: PositionRow[];
}

/** GET /api/v1/perps/accounts/{addr}/fundings (the documented `funding-history` 404s). [ot][live] */
export interface FundingRow {
  symbol: string;
  positionID: number;
  positionSide: PositionSideStr;
  /** Positive = paid, negative = received. */
  fundingFee: Dec;
  feeCoin: string;
  timestamp: number;
}

/** GET /api/v1/{engine}/accounts/{addr}/trades - fills (bare array). `tradeID` is NOT unique per account. [ot] */
export interface UserTradeRow {
  symbol: string;
  tradeID: number;
  orderID: number;
  clOrdID?: string;
  side: SideStr;
  price: Dec;
  quantity: Dec;
  /**
   * EVERYTHING the fill was charged, in `feeCoin` - the venue's commission AND
   * the builder fee, when there is one. [live 2026-10-02: a spot sell with a
   * 10 bp builder fee reports 13.5 bp maker / 16.5 bp taker here.]
   */
  fee?: Dec;
  /**
   * The builder's share of `fee` (already inside it - never add the two).
   * Present only on fills that were charged one: spot sells and, per the docs,
   * both sides on perps. Absent on spot buys even when the order named a
   * builder. [live 2026-10-02] Split a row with `fillFeeParts` (builders.ts).
   */
  builderFee?: Dec;
  feeCoin?: string;
  isMaker?: boolean;
  time: number;
}

/** GET /api/v1/{engine}/accounts/{addr}/fee-rate */
export interface FeeRate {
  makerFeeRate: Dec;
  takerFeeRate: Dec;
  feeTier: number;
  stakingTier: number;
  makerRebateTier: number;
}

/** A TWAP order (REST). */
export interface TwapOrder {
  userID: number;
  accountID: number;
  symbol: string;
  symbolID: number;
  orderID: number;
  quantity: Dec;
  side: SideStr;
  minutes: number;
  randomize: boolean;
  reduceOnly: boolean;
  executedQty: Dec;
  executedValue: Dec;
  createdAt: number;
  nextActiveAt: number;
  active: boolean;
}

export interface AccountTwapOrders extends BlockStamped {
  twaps: TwapOrder[];
}

// --- frontend state (compact keys) ------------------------------------------

/** Compact balance inside perps /state `B[]`. [live] */
export interface StatePerpsBalance {
  i: number;
  a: string;
  wb: Dec;
  co: Dec;
  mr: Dec;
  px: Dec;
  iw?: Dec | null;
  aw?: Dec;
  at?: Dec;
  wm?: Dec;
  am?: Dec;
}

/** Compact spot balance inside spot /state `B[]`. */
export interface StateSpotBalance {
  i: number;
  a: string;
  t: Dec;
  l: Dec;
}

/** Compact position inside perps /state `P[]`. `ur` = unrealised PnL, `lp` = liquidation price. [live] */
export interface StatePosition {
  i: number;
  s: string;
  m: MarginModeStr;
  ps: PositionSideStr;
  sz: Dec;
  ep: Dec;
  co: Dec;
  cf: Dec;
  cc: Dec;
  cp: Dec;
  ms: Dec;
  cr: Dec;
  ur?: Dec;
  l: number;
  lp?: Dec;
  iw?: Dec | null;
  ct?: number;
  ut?: number;
}

/** Compact order inside /state `O[]` (latest 100 open orders). [live] */
export interface StateOrder {
  s: string;
  c: string;
  i: number;
  S: SideStr;
  o: OrderTypeStr;
  f: TimeInForceStr;
  p: Dec;
  q: Dec;
  F?: Dec | null;
  X: OrderStatusStr;
  z: Dec;
  v: Dec;
  M: Dec;
  b?: { i: number; f: number };
  ct?: number;
  ut?: number;
  // perps
  ps?: PositionSideStr;
  R?: boolean;
  sp?: Dec | null;
  st?: StopTypeStr | null;
  tt?: TriggerTypeStr | null;
  pid?: number | null;
  poid?: number | null;
  aoids?: number[] | null;
}

/**
 * GET /api/v1/perps/accounts/{addr}/state. `aid === 0` means SoDEX has never
 * seen a deposit from this wallet (no account). [live][ot]
 */
export interface PerpsAccountState {
  user: string;
  aid: number;
  uid: number;
  /** Cross account value (equity), USD. */
  av: Dec;
  /** Maintenance margin and its ratio. [live] (not in the WS schema) */
  mm?: Dec;
  mmr?: Dec;
  /** Available margin: cross / isolated / for transfer. */
  am: Dec;
  ami?: Dec;
  amw?: Dec;
  /** Frozen margin: isolated position / cross position / isolated open orders / cross open orders. */
  im?: Dec;
  cm?: Dec;
  oim?: Dec;
  ocm?: Dec;
  B: StatePerpsBalance[];
  P: StatePosition[];
  O: StateOrder[];
  TO?: unknown[];
  S?: Array<{ s: string; l: number; m: MarginModeStr }>;
}

/** GET /api/v1/spot/accounts/{addr}/state */
export interface SpotAccountState {
  user: string;
  aid: number;
  uid: number;
  B: StateSpotBalance[];
  O: StateOrder[];
  TO?: unknown[];
}

// ---------------------------------------------------------------------------
// User (cross-engine) endpoints
// ---------------------------------------------------------------------------

/**
 * One API key row. [live] `type` is the STRING 'EVM' in responses (requests
 * send the integer 1). `permissions` is ABSENT on ordinary keys - which means
 * EVERY permission is enabled (a set bit DISABLES; see permissions.ts).
 * `expiresAt` is MILLISECONDS; 0 = never (the `default` row is the master
 * wallet itself). Key NAMES are public.
 */
export interface ApiKeyRow {
  name: string;
  type: 'EVM' | (string & {});
  publicKey: string;
  expiresAt: number;
  permissions?: number;
}

/** GET /api/v1/user/{addr}/api-keys?accountID=&name= -> both engines. [live] */
export interface AccountApiKeys {
  spot: ApiKeyRow[];
  perps: ApiKeyRow[];
}

/** GET /api/v1/{engine}/accounts/{addr}/api-keys -> ApiKeyRow[] (bare array). [live] */
export type EngineApiKeys = ApiKeyRow[];

/**
 * GET /api/v1/user/{addr}/builders [live]. One approval appears once per engine,
 * and the two rows can differ: an approval of 500 reads spot 500, perps 200 (the
 * perps cap). Read one builder's rates with `approvedBuilderRates` (builders.ts).
 */
export interface BuilderApproval {
  userID: number;
  builderID: number;
  /** The approved ceiling on this engine, tenths of a basis point. */
  feeRate: number;
}
export interface BuilderApprovals {
  spot: BuilderApproval[];
  perps: BuilderApproval[];
}

/** GET /api/v1/user/{addr}/subaccounts [live] */
export interface UserSubaccounts {
  userID: number;
  /** Use as the trading/builder-approval accountID; also THE builder id when this account is a builder. */
  primaryAccountID: number;
  subaccounts: Array<{ id: number; evmAddress: string }>;
}

/** GET /api/v1/user/{addr}/ratelimit */
export interface UserRateLimit {
  userID: number;
  cumulativeTxNum: number;
  cumulativeCancelNum: number;
  cumulativeVolume: Dec;
  transactionQuota: number;
  transactionQuotaUsed: number;
  transactionQuotaRemaining: number;
  transactionQuotaOverridden: boolean;
  cancelQuota: number;
  cancelQuotaUsed: number;
  cancelQuotaRemaining: number;
}

/** GET /api/v1/user/{addr}/status [research 01] */
export type UserStatus = 'Active' | 'UserNotFound' | (string & {});

// ---------------------------------------------------------------------------
// Signed-write responses
// ---------------------------------------------------------------------------

/** One entry of newOrder / batchNewOrder `data`. Top-level code 0 does NOT mean every order succeeded. */
export interface PlaceOrderResult {
  code: number;
  clOrdID: string;
  orderID?: number;
  error?: string;
}

/** One entry of a cancel response. */
export interface CancelOrderResult {
  code?: number;
  orderID?: number;
  clOrdID?: string;
  status?: string;
  error?: string;
}

/** perps modify: `{code, error?}` inside `data`. */
export interface ModifyOrderResult {
  code: number;
  error?: string;
}

/** transferAsset: echoes the request `id`. */
export interface TransferResult {
  id: number;
}

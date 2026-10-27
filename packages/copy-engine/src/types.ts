/**
 * The copy engine's shared shapes.
 *
 * A LEADER is any public address on a leader venue (SoDEX or Hyperliquid). A
 * FOLLOWER is the master wallet that owns the SoDEX account being traded. A
 * SUBSCRIPTION is one follower copying one leader under the follower's own
 * rules (`CopySettings`). Copied orders are always placed on SoDEX perps, in
 * the follower's own account, signed by a key the follower registered there.
 *
 * Money is USD as a plain number, ratios are fractions (0.2 = 20%), times are
 * milliseconds, sizes are base units signed by side (+ long, - short). Sizes
 * and prices that are SIGNED for SoDEX are canonical decimal strings.
 */

/** Where a leader trades. Copies always execute on SoDEX perps. */
export type LeaderVenue = 'sodex' | 'hyperliquid';

/**
 * Where the copier runs.
 *   browser  this browser tab, with a key kept in this browser only;
 *   hosted   ValueDesk's executor (Tokyo), with a key it generated and the follower registered;
 *   self     an executor the follower runs (own computer or server), with its own key.
 */
export type CopyMode = 'browser' | 'hosted' | 'self';

export type SizingMode = 'proportional' | 'fixedRatio' | 'fixedNotional';

/** `confirm`: every copied order waits for the follower's yes (browser copier only). */
export type ApprovalMode = 'auto' | 'confirm';

export type MarginChoice = 'isolated' | 'cross';

export interface LeaderRef {
  venue: LeaderVenue;
  /** Lower-case 0x address. */
  address: string;
}

/** The follower's copy rules. Every field is chosen by the follower; nothing is chosen for them. */
/**
 * copy     take the trader's side;
 * counter  take the OTHER side: their long is your short, their close is your close,
 *          sized and capped by the same rules. The follower wins when the trader loses.
 */
export type CopyDirection = 'copy' | 'counter';

export interface CopySettings {
  leader: LeaderRef;
  direction: CopyDirection;
  /**
   * proportional   the leader's position as a share of their equity, applied to `allocationUsd`;
   * fixedRatio     `ratio` x the leader's position (by notional);
   * fixedNotional  `fixedNotionalUsd` per copied open; scale-outs follow the leader's fraction.
   */
  sizingMode: SizingMode;
  /** Capital set aside for this leader, USD. The copy's equity starts here. */
  allocationUsd: number;
  /** fixedRatio: 0.1 = 10% of the leader's notional. */
  ratio: number;
  /** fixedNotional: USD per copied open. */
  fixedNotionalUsd: number;
  /** Cap on gross copied exposure / copy equity, and the leverage set on each copied SoDEX position. */
  maxLeverage: number;
  /** Cap per copied position, USD notional. */
  maxPositionUsd: number;
  /** Close a copied position at this loss, fraction of its margin (0.5 = -50%). null = off. */
  stopLossPct: number | null;
  /** Close a copied position at this gain, fraction of its margin. null = off. */
  takeProfitPct: number | null;
  /** Stop the copy when its equity falls this far below its peak (0.3 = 30%). null = off. */
  drawdownStopPct: number | null;
  /** Only these coins (upper-case, 'BTC'); empty = every coin. */
  assetAllow: string[];
  /** Never these coins. */
  assetDeny: string[];
  /** Join the leader's positions that are already open when copying starts. */
  copyExisting: boolean;
  /** Worst price accepted per copied order, basis points from the reference price. */
  slippageBps: number;
  /** Margin mode for copied positions. */
  marginMode: MarginChoice;
  approval: ApprovalMode;
  /** Paper copy: everything runs, nothing is sent to SoDEX. */
  paper: boolean;
}

/**
 * active   copying;
 * paused   by the follower: nothing new is copied, positions stay;
 * stopped  by the follower (final): nothing is copied any more;
 * halted   by a rule (the drawdown stop): nothing new is copied until the follower resumes it;
 * blocked  by a precondition (no builder approval, region, key missing or expired, "ask me
 *          each time" where the copier cannot ask): nothing new is copied, and the copy
 *          resumes by itself once the precondition holds again.
 * A halted or blocked copy still follows the leader's reductions and closes (reduce-only) and
 * keeps its stop-loss / take-profit, so it never holds a position the leader has left.
 */
export type SubscriptionStatus = 'active' | 'paused' | 'stopped' | 'halted' | 'blocked';

/** What a signed request proves: who asked, what for, when. Kept as consent evidence. */
export interface ConsentRecord {
  action: string;
  /** keccak256 digest of the EIP-712 typed data the wallet signed (0x hex). */
  digest: string;
  signature: string;
  /** The wallet's chain when it signed (the EIP-712 domain). */
  chainId: number;
  /** The exact payload JSON the wallet displayed and signed. */
  payload: string;
  at: number;
}

export interface Subscription {
  id: string;
  /** Follower master wallet, lower-case. */
  owner: string;
  /** The follower's SoDEX primary account id. */
  accountId: number;
  mode: CopyMode;
  settings: CopySettings;
  status: SubscriptionStatus;
  statusReason: string | null;
  createdAt: number;
  updatedAt: number;
  /** Leader positions opened after this moment are copied (unless `copyExisting`). */
  startedAt: number;
  /** ISO 3166-1 alpha-2 the follower declared, upper-case. */
  country: string | null;
  /** The country of the IP address the request came from, where a server saw it. */
  observedCountry: string | null;
  /** The copy-trading terms version the follower accepted. */
  termsVersion: string;
  /** The signed request that created or last changed this subscription. */
  consent: ConsentRecord | null;
}

/** A copied position the copier owns on the follower's account (SoDEX symbol, signed size). */
export interface OwnedPosition {
  size: number;
  /** Average entry, USD. */
  entry: number;
  /** When the copier first opened it. */
  openedAt: number;
}

/** Why a market is not being followed until the leader goes flat on it. */
export type DetachReason = 'pre-existing' | 'stop-loss' | 'take-profit' | 'own-position';

/** The durable runtime state of one subscription. */
export interface SubState {
  subId: string;
  /** Leader positions, leader-venue symbol -> signed base size. */
  leaderPos: Record<string, number>;
  /** Leader account value, USD, when known. */
  leaderEquity: number | null;
  leaderEquityAt: number | null;
  /** Copy-owned follower positions, SoDEX symbol -> position. */
  owned: Record<string, OwnedPosition>;
  /** Leader-venue symbol -> why it is detached. */
  detached: Record<string, DetachReason>;
  /** Protective SoDEX stop orders the copier placed: SoDEX symbol -> their client ids and the size they cover. */
  stops: Record<string, { sl: string | null; tp: string | null; size: number; at: number }>;
  /** Realised PnL of copied positions, USD (gross, fees apart). */
  realizedPnl: number;
  /** Trading + builder fees paid on copied orders, USD (estimated at the order price). */
  fees: number;
  /**
   * Leader-venue symbol -> the copy's size per unit of the leader's position (absolute),
   * set when the copy is sized against the leader (open, increase, flip) and kept through
   * decreases, so a scale-out or an add too small to trade is caught up by the next one.
   * Absent in states saved before it existed: it is then taken from the copy's size.
   */
  ratios?: Record<string, number>;
  /** Highest copy equity seen (for the drawdown stop). */
  peakEquity: number;
  /** Event ids already handled, newest last (bounded). */
  seen: string[];
  lastEventAt: number | null;
  lastReconcileAt: number | null;
  /** Orders placed / skipped since the start. */
  orders: number;
  skips: number;
}

/** One change of a leader position, from a stream or a reconciliation. */
export interface LeaderEvent {
  leader: LeaderRef;
  /** The leader venue's market name: 'BTC' on Hyperliquid, 'BTC-USD' on SoDEX. */
  symbol: string;
  /** Signed position before; null = not known by the source (the shadow is used). */
  before: number | null;
  /** Signed position after. */
  after: number;
  /** Price of the fill (leader venue), or the mark for a reconciliation. */
  price: number;
  time: number;
  /** Unique per leader and source: dedupes stream snapshots and reconnects. */
  id: string;
  source: 'stream' | 'reconcile';
}

export type OrderLeg =
  | 'open'
  | 'increase'
  | 'decrease'
  | 'close'
  | 'flip-close'
  | 'flip-open'
  | 'reconcile'
  | 'stop-loss'
  | 'take-profit'
  | 'drawdown-stop'
  | 'stop-all';

/** One order the planner wants placed on the follower's SoDEX account. */
export interface Intent {
  /** SoDEX perps symbol, e.g. 'BTC-USD'. */
  symbol: string;
  side: 'buy' | 'sell';
  /** Canonical decimal, snapped to the market's step. */
  quantity: string;
  /** IOC limit price: the reference price moved by the slippage cap, snapped to the tick. */
  limitPrice: string;
  reduceOnly: boolean;
  leg: OrderLeg;
  /** quantity x reference price. */
  notionalUsd: number;
  /** Which cap made it smaller than the sizing rule alone, if any. */
  clampedBy: 'max-position' | 'max-leverage' | 'region-leverage' | null;
  /** Deterministic client order id (idempotency): `^[0-9a-zA-Z_-]{1,36}$`. */
  clOrdID: string;
}

/** Stable ids for why a leader change produced no order. */
export const SKIP_REASONS = {
  'spot-not-copied': 'Spot trades are not copied (perps only)',
  'not-on-sodex': 'This market is not listed on SoDEX perps',
  'market-halted': 'SoDEX is not trading this market right now',
  'asset-not-allowed': 'Not on your list of coins to copy',
  'asset-denied': 'On your list of coins never to copy',
  'pre-existing-position': 'The leader already held this position when you started copying',
  'after-stop-loss': 'Your stop-loss closed this copy; it resumes when the leader is flat',
  'after-take-profit': 'Your take-profit closed this copy; it resumes when the leader is flat',
  'own-position': 'You hold your own position in this market, so it is left alone',
  'owned-by-other-copy': 'Another of your copies holds this market',
  'no-leader-equity': "The leader's account value is not known, so proportional sizing cannot be applied",
  'at-target': 'Your copy already matches the leader here',
  'no-follower-position': 'Nothing to reduce: your copy holds no position here',
  'max-position': 'Your max position per trade is reached',
  'max-leverage': 'Your leverage cap is reached',
  'region-leverage': 'The leverage cap for your region is reached',
  'min-notional': 'Below the SoDEX minimum order value',
  'lot-size': 'Below the smallest order size on this market',
  'no-price': 'No price for this market yet',
  'halted': 'This copy is halted',
  'blocked': 'This copy is blocked; it only reduces positions until that is solved',
  'free-margin': 'Not enough free margin in your SoDEX account',
  'bad-leader-size': "The trader's position could not be read (not a number), so nothing was changed",
  'paused': 'This copy is paused',
  'duplicate': 'Already handled',
  'declined': 'You declined this trade',
  'confirm-timeout': 'Not confirmed in time',
} as const;

export type SkipReason = keyof typeof SKIP_REASONS;

/** One line of a copy's activity: an order, a skip, a status change or an error. */
export interface ActivityEntry {
  id: string;
  subId: string;
  owner: string;
  at: number;
  /** order: sent (limit price); fill: what SoDEX filled (actual price); skip; status; error. */
  kind: 'order' | 'fill' | 'skip' | 'status' | 'error';
  /** A SkipReason, an OrderLeg, a status, or an error class. */
  reason: string;
  /** Human-readable detail. */
  detail: string | null;
  symbol: string | null;
  side: 'buy' | 'sell' | null;
  size: number | null;
  price: number | null;
  notionalUsd: number | null;
  reduceOnly: boolean | null;
  clOrdID: string | null;
  /** SoDEX order id once known. */
  orderId: string | null;
  /** Builder fee charged on this order, tenths of a bp (0 = none). */
  builderFee: number | null;
  /** The leader change this answers. */
  leader: { symbol: string; before: number; after: number; price: number; time: number } | null;
  paper: boolean;
}

/** SoDEX perps market rules the planner needs. */
export interface MarketInfo {
  id: number;
  /** 'BTC-USD' */
  name: string;
  /** 'BTC' */
  base: string;
  tickSize: string;
  stepSize: string;
  minQuantity: string;
  maxQuantity: string;
  marketMaxQuantity: string | null;
  minNotional: number;
  maxNotional: number | null;
  maxLeverage: number;
  /** A limit buy may be at most mark x (1 + this); a limit sell at least mark x (1 - sellLimitDownRatio). */
  buyLimitUpRatio: number;
  sellLimitDownRatio: number;
  /** Base-tier taker fee, fraction (copied IOCs are taker orders). */
  takerFee: number;
  /** Base-tier maker fee, fraction (algo orders that rest), when SoDEX lists one. */
  makerFee?: number;
  status: string;
}

/** The follower's account on SoDEX, as the copier last read it. */
export interface FollowerSnapshot {
  accountId: number;
  /** Cross account value, USD. */
  equity: number;
  /** Margin available for new positions, USD. */
  available: number;
  /** Whether SoDEX's answer carried `available` (false: it is unknown, not 0, and nothing is gated on it). */
  marginKnown?: boolean;
  /** SoDEX symbol -> signed size (every position, copied or not). */
  positions: Record<string, { size: number; entry: number; leverage: number; marginMode: MarginChoice }>;
  at: number;
}

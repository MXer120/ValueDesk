/**
 * Algo orders: one instruction the engine works into many child orders over
 * time, in the trader's own SoDEX perps account, signed by a key they
 * registered there - in this browser, on ValueDesk's executor or on one they
 * run themselves (the same three modes as copy trading, one engine).
 *
 *   twap         an even schedule: N slices over a duration, with an urgency curve and jitter
 *   vwap         a schedule weighted by the market's own volume at those hours of past days
 *   pov          a share of the volume the market actually prints, while it prints it
 *   iceberg      one small visible clip at a time, refilled as it fills
 *   chase        one post-only order that follows the best price until it fills
 *   scale        a ladder of resting orders between two prices, sized by a curve
 *   dca          a fixed amount every interval, with a price band and dip boost
 *   swarm        many small takers in waves instead of one big one, the book refilling between waves
 *   conditional  when market conditions hold (price, cross, move, funding, OI, spread, volume, ratio, time), act
 *   trailing     a stop that follows the price at a distance and takes when it turns
 *
 * Every child order is an ordinary SoDEX order (IOC to take, GTX to rest,
 * GTC for a ladder) carrying the ValueDesk builder fee, so it shows in the
 * account's open orders and fills like any other order and can be cancelled
 * there too.
 *
 * Money is USD as a plain number, times are milliseconds, sizes are base
 * units (positive; the side says which way). Quantities a trader TYPED are
 * canonical decimal strings, as signed; working figures are numbers.
 */
import type { ConsentRecord, CopyMode } from '../types.ts';

export type AlgoKind = 'twap' | 'vwap' | 'pov' | 'iceberg' | 'chase' | 'scale' | 'dca' | 'swarm' | 'conditional' | 'trailing';

export const ALGO_KINDS: readonly AlgoKind[] = ['twap', 'vwap', 'pov', 'iceberg', 'chase', 'scale', 'dca', 'swarm', 'conditional', 'trailing'];

export type Side = 'buy' | 'sell';

/**
 * How a child order is worked.
 *   taker   IOC at the touch, never worse than `slippageBps` past it (and the algo's limit price);
 *   maker   post-only (GTX) at the touch, re-priced as the touch moves: never pays the spread;
 *   hybrid  rests first, and whatever of the slice is still open after `makerShare` of it crosses.
 */
export type ExecStyle = 'taker' | 'maker' | 'hybrid';

export interface ExecSpec {
  style: ExecStyle;
  /** Taker legs: the worst price per child, basis points past the touch. */
  slippageBps: number;
  /** Maker legs: ticks behind the best price (0 = join it; -1 = one tick inside the spread where there is room). */
  offsetTicks: number;
  /** Maker legs: re-price once the best price is this many ticks away from the order. */
  chaseTicks: number;
  /** Hybrid: the share of each slice spent resting before the rest crosses (0.1..0.95). */
  makerShare: number;
}

/**
 * What an algo does when the price leaves a band:
 *   hold  no new child until the price is back inside (resting children are pulled);
 *   stop  end the algo where it stands;
 *   rush  take everything that is left now (within the limit price).
 */
export type BoundAction = 'hold' | 'stop' | 'rush';

export interface PriceBound {
  price: number;
  then: BoundAction;
}

/** Fields every algo has. */
export interface AlgoBase {
  kind: AlgoKind;
  /** SoDEX perps market, e.g. 'BTC-USD'. */
  symbol: string;
  side: Side;
  reduceOnly: boolean;
  /** Never buy above / sell below this price (USD): no child is ever sent past it. null = no limit. */
  limitPrice: number | null;
  /** Reactions on the mark leaving a band (above `upper`, below `lower`). Either may be null. */
  upper: PriceBound | null;
  lower: PriceBound | null;
  /** Start working only once the mark reaches this price (from wherever it is when the algo is placed). null = at once. */
  triggerPrice: number | null;
  /** Start at this time. null = at once. */
  startAt: number | null;
  /** Hold (no new child) while the spread is wider than this, bps. null = never hold. */
  maxSpreadBps: number | null;
  /** Leverage set on the market before the first opening child. null = as it is. */
  leverage: number | null;
  marginMode: 'cross' | 'isolated' | null;
  /** Run against the live market and send nothing: fills are simulated from the book and the tape. */
  paper: boolean;
  /** A name the trader gave it. */
  label: string | null;
}

export interface TwapSpec extends AlgoBase {
  kind: 'twap';
  quantity: string;
  durationMs: number;
  slices: number;
  /** -1..1: 0 even; above 0 more early (front-loaded), below 0 more late. */
  urgency: number;
  /** Each slice's size moves up to this share either way (0..0.5); the total does not change. */
  sizeJitter: number;
  /** Each slice's time moves up to this share of the interval either way (0..0.5). */
  timeJitter: number;
  exec: ExecSpec;
  /** What is left when the time is up: take it (within the limit price) or leave it. */
  finish: 'take' | 'leave';
  /** A child takes at most this share of the volume printed in the last interval (0.01..1). null = off. */
  maxParticipation: number | null;
}

export interface VwapSpec extends AlgoBase {
  kind: 'vwap';
  quantity: string;
  durationMs: number;
  slices: number;
  /** Days of history the volume profile is taken from (1..56): the median of each time slot, weekdays and weekends apart. */
  lookbackDays: number;
  /** Re-weight as it runs: faster while the market trades more than the profile expected, slower while it trades less. */
  adaptive: boolean;
  sizeJitter: number;
  exec: ExecSpec;
  finish: 'take' | 'leave';
  maxParticipation: number | null;
}

export interface PovSpec extends AlgoBase {
  kind: 'pov';
  quantity: string;
  /** Target share of the market's volume (0.01..0.5): what this algo fills / what everyone else trades. */
  rate: number;
  /** Largest single child, base units. null = no cap. */
  maxChildQty: string | null;
  /** Stop at this time. null = run until done. */
  endAt: number | null;
  exec: ExecSpec;
  finish: 'take' | 'leave';
}

export interface IcebergSpec extends AlgoBase {
  kind: 'iceberg';
  quantity: string;
  /** The size shown at once. */
  displayQty: string;
  /** Each clip moves up to this share either way (0..0.5), so the clips do not repeat. */
  displayJitter: number;
  /** A fixed price for every clip. null = pegged to the best price. */
  price: number | null;
  /** Pegged: ticks behind the best price (negative improves). */
  pegOffsetTicks: number;
  /** Pegged: re-price once the best price is this many ticks away. */
  chaseTicks: number;
  postOnly: boolean;
  /** Wait between one clip filling and the next one showing. */
  refillMs: number;
  /** The wait moves up to this share either way (0..1). */
  refillJitter: number;
}

export interface ChaseSpec extends AlgoBase {
  kind: 'chase';
  quantity: string;
  offsetTicks: number;
  /** Rest this far behind the best price instead, bps (stalking). null = `offsetTicks`. */
  offsetBps: number | null;
  chaseTicks: number;
  /** Chase at most this far from the price it started at, bps. null = only the limit price bounds it. */
  maxChaseBps: number | null;
  /** Give up after this long. null = never. */
  timeoutMs: number | null;
  /** When the cap or the time is reached: take the rest, cancel it, or leave it resting at its last price. */
  onEnd: 'take' | 'cancel' | 'rest';
  /** At least this long between two re-prices. */
  minRepriceMs: number;
}

export type ScaleDistribution = 'flat' | 'linear' | 'exponential' | 'bell';

export interface ScaleSpec extends AlgoBase {
  kind: 'scale';
  quantity: string;
  /** The first order's price (nearest the market, usually). */
  from: number;
  /** The last order's price. */
  to: number;
  orders: number;
  distribution: ScaleDistribution;
  /** linear / exponential: the last order's size over the first's (0.1..10). */
  skew: number;
  /** Price steps: even, even in percent, denser near the first price, or denser near the last. */
  spacing: 'linear' | 'geometric' | 'front' | 'back';
  sizeJitter: number;
  postOnly: boolean;
}

export interface DcaSpec extends AlgoBase {
  kind: 'dca';
  /** USD per order. */
  perOrderUsd: number;
  orders: number;
  intervalMs: number;
  /** Outside the limit price: skip that order, or wait (and catch up once the price is back). */
  outOfBand: 'skip' | 'wait';
  /** Buy more when the price is this far below the average entry so far (sell: above), 0.01..0.9. null = off. */
  dipPct: number | null;
  /** ...this many times the amount (1..5). */
  dipMultiplier: number;
  /** Never spend more than this in total, USD. null = orders x amount (boosts included). */
  maxTotalUsd: number | null;
  exec: ExecSpec;
}

/**
 * Many small takers instead of one big one: the size is cut into clips, sent
 * in waves of `inFlight` at the touch (each never worse than `slippageBps`),
 * with `waveMs` between waves so the book can refill. A clip SoDEX rejects is
 * sent again up to `retries` times.
 */
export interface SwarmSpec extends AlgoBase {
  kind: 'swarm';
  quantity: string;
  /** Clips in all (2..200). */
  clips: number;
  /** Clips per wave (1..20). */
  inFlight: number;
  /** Pause between waves (0..60 s). */
  waveMs: number;
  /** Each clip's size moves up to this share either way (0..0.9). */
  sizeJitter: number;
  slippageBps: number;
  retries: number;
}

export type PriceSource = 'mark' | 'last' | 'mid' | 'index';

export type Condition =
  | { type: 'price'; symbol: string; source: PriceSource; op: 'above' | 'below'; value: number }
  /** Crosses the level: it must be seen on the other side first, then reach it. */
  | { type: 'cross'; symbol: string; source: PriceSource; dir: 'up' | 'down'; value: number }
  /** Moves this far within the window (up to an hour), percent as a fraction. */
  | { type: 'move'; symbol: string; source: PriceSource; dir: 'up' | 'down' | 'either'; pct: number; windowMs: number }
  /** The current funding rate (a fraction per funding period, as SoDEX publishes it). */
  | { type: 'funding'; symbol: string; op: 'above' | 'below'; value: number }
  /** Open interest changes this far within the window. */
  | { type: 'oi'; symbol: string; dir: 'up' | 'down' | 'either'; pct: number; windowMs: number }
  | { type: 'spread'; symbol: string; op: 'above' | 'below'; bps: number }
  /** USD traded on the market within the window. */
  | { type: 'volume'; symbol: string; windowMs: number; aboveUsd: number }
  /** One market's price over another's (mark / mark), e.g. ETH-USD / BTC-USD. */
  | { type: 'ratio'; symbol: string; other: string; op: 'above' | 'below'; value: number }
  | { type: 'time'; at: number };

export type ConditionType = Condition['type'];

export type ConditionalAction =
  | { type: 'market'; quantity: string; slippageBps: number }
  | { type: 'limit'; quantity: string; price: number; postOnly: boolean }
  /** Close this share (0.01..1) of the position on the algo's market, reduce-only. */
  | { type: 'close'; share: number; slippageBps: number }
  /** Start another algo (it names its own market and side). */
  | { type: 'algo'; algo: Exclude<AlgoSpec, ConditionalSpec> };

export interface ConditionalSpec extends AlgoBase {
  kind: 'conditional';
  match: 'all' | 'any';
  conditions: Condition[];
  /** The conditions must hold this long before it acts (no firing on a wick). */
  holdMs: number;
  expiresAt: number | null;
  then: ConditionalAction;
}

export interface TrailingSpec extends AlgoBase {
  kind: 'trailing';
  /** null = the whole position on this market when it fires (reduce-only). */
  quantity: string | null;
  /** The distance, a fraction of the price (0.001..0.5)... */
  trailPct: number | null;
  /** ...or in USD. Exactly one of the two. */
  trailAbs: number | null;
  /** Start trailing only once the price reaches this (sell: at or above; buy: at or below). null = at once. */
  activationPrice: number | null;
  source: 'mark' | 'last';
  /** How it exits once it fires: one taker order, or a chase (post-only, re-priced; takes after `chaseMs`). */
  exit: 'market' | 'chase';
  chaseMs: number;
  slippageBps: number;
}

export type AlgoSpec =
  | TwapSpec
  | VwapSpec
  | PovSpec
  | IcebergSpec
  | ChaseSpec
  | ScaleSpec
  | DcaSpec
  | SwarmSpec
  | ConditionalSpec
  | TrailingSpec;

/**
 * scheduled  waiting for its start time;
 * running    working;
 * waiting    running, but held by one of its own rules (spread, limit price, band): `statusReason` says which;
 * paused     by the trader: no new child; resting children are cancelled;
 * done       filled (or, for a conditional, it acted);
 * cancelled  by the trader;
 * expired    its time ran out with something left (and it was set to leave it), or a conditional's window passed;
 * failed     it cannot go on (the market went away, SoDEX refused it repeatedly): `statusReason` says why.
 */
export type AlgoStatus = 'scheduled' | 'running' | 'waiting' | 'paused' | 'done' | 'cancelled' | 'expired' | 'failed';

export const FINAL_STATUSES: ReadonlySet<AlgoStatus> = new Set(['done', 'cancelled', 'expired', 'failed']);

export type ChildTif = 'ioc' | 'gtx' | 'gtc';

/** One child order the algo sent. */
export interface ChildOrder {
  clOrdID: string;
  orderId: string | null;
  side: Side;
  /** The limit price sent. */
  price: number;
  quantity: number;
  tif: ChildTif;
  reduceOnly: boolean;
  filled: number;
  /** Sum of fill qty x price. */
  value: number;
  /**
   * sending  signed, no answer yet;
   * open     SoDEX has it (resting, or an IOC not yet reported);
   * done     filled, cancelled, rejected or expired: `filled` is final;
   * unknown  the request got no answer: it may or may not exist (never re-sent; reconciled from SoDEX).
   */
  state: 'sending' | 'open' | 'done' | 'unknown';
  placedAt: number;
  updatedAt: number;
  /** A cancel was sent for it. */
  cancelling: boolean;
  /** 'slice 3/40', 'clip 2', 'level 5', 'finish', 'trigger'... */
  tag: string;
}

/** An algo: what the trader asked for, and where it stands. One JSON document. */
export interface AlgoRecord {
  id: string;
  /** Master wallet, lower-case. */
  owner: string;
  /** The owner's SoDEX primary account id. */
  accountId: number;
  mode: CopyMode;
  spec: AlgoSpec;
  status: AlgoStatus;
  statusReason: string | null;
  createdAt: number;
  updatedAt: number;
  /** When it began working (null while scheduled). */
  startedAt: number | null;
  endedAt: number | null;
  /** The conditional that started it. */
  parentId: string | null;
  /** The signed request that created it (executors). */
  consent: ConsentRecord | null;
  /** Seed of its random choices (sizes, times, prices): a schedule can be re-derived after a restart. */
  seed: number;

  /** Base units filled, and their value (USD). */
  filled: number;
  filledValue: number;
  /** Of `filled`, what rested on the book (maker) rather than took. */
  makerQty: number;
  /** Trading + builder fees, USD (estimated at the fill price). */
  fees: number;
  /** The mid when it started: the arrival price it is measured against. */
  arrival: number | null;
  /** What everyone else traded on the market while it ran (base units, USD): POV's yardstick and the market VWAP. */
  marketQty: number;
  marketValue: number;
  /** Open children, and the last few done ones. */
  children: ChildOrder[];
  childCount: number;
  rejects: number;
  /** Kind-specific working state (schedules, peaks, holds, counters). */
  k: Record<string, unknown>;
}

export type AlgoEventKind = 'status' | 'order' | 'fill' | 'cancel' | 'skip' | 'error' | 'info';

/** One line of an algo's log. */
export interface AlgoEvent {
  id: string;
  algoId: string;
  owner: string;
  at: number;
  kind: AlgoEventKind;
  text: string;
  clOrdID: string | null;
  side: Side | null;
  price: number | null;
  qty: number | null;
  paper: boolean;
}

/** What a trader sees of one algo. */
export interface AlgoView {
  algo: AlgoRecord;
  /** Total to fill (base units); null for an algo sized in USD (dca) or by the position (trailing / close). */
  target: number | null;
  /** 0..1 (dca: orders done / orders). */
  progress: number;
  avgPrice: number | null;
  /** Average fill vs the arrival price, bps; positive = better for the trader. */
  vsArrivalBps: number | null;
  /** Average fill vs the market's VWAP over the same window, bps; positive = better. */
  vsMarketVwapBps: number | null;
  marketVwap: number | null;
  /** When the next child is due (schedules), or null. */
  nextAt: number | null;
  /** When it should be finished, or null. */
  endsAt: number | null;
  /** What is working right now, in words. */
  working: string | null;
  /** The level it acts at (trailing: the stop; conditional: null). */
  triggerPrice: number | null;
  /** For a conditional: how far each condition is from holding, in words. */
  conditions: Array<{ text: string; ok: boolean }> | null;
}

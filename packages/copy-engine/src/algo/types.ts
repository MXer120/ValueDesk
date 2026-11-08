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
 *   conditional  when market, position or time conditions hold, act (and bracket what it opened)
 *   trailing     a stop that follows the price at a distance and takes when it turns
 *   basket       one parent spread over several markets (each leg a swarm or a TWAP of its own)
 *   bracket      an entry (market or limit) with a take-profit and a stop-loss, one cancelling the other
 *   sweep        fill fast: IOC limits for the rest, round after round, at a band around an outside reference (Binance)
 *
 * Every child order is an ordinary SoDEX order (IOC to take, GTX to rest,
 * GTC for a ladder) carrying the ValueDesk builder fee, so it shows in the
 * account's open orders and fills like any other order and can be cancelled
 * there too. Exits (take-profit / stop-loss after an entry) are SoDEX's own
 * position stops - reduce-only market orders triggered on the mark, held by
 * SoDEX - so they protect the position even while no runner is up; the
 * runner cancels the other one when one of them fills (OCO).
 *
 * WHAT SODEX DOES NATIVELY, AND WHAT IS USED. SoDEX has stop orders (TP/SL on
 * the mark) - used for every exit - and a TWAP endpoint, which is NOT used:
 * its request has no builder field, so in a build that requires the builder
 * fee the app's fee guard refuses it. Everything else here has no native
 * SoDEX form and is worked by this engine.
 *
 * Money is USD as a plain number, times are milliseconds, sizes are base
 * units (positive; the side says which way). Quantities a trader TYPED are
 * canonical decimal strings, as signed; working figures are numbers.
 */
import type { ConsentRecord, CopyMode } from '../types.ts';
import type { OracleVenue } from '../oracle.ts';

export type AlgoKind = 'twap' | 'vwap' | 'pov' | 'iceberg' | 'chase' | 'scale' | 'dca' | 'swarm' | 'conditional' | 'trailing' | 'basket' | 'bracket' | 'sweep' | 'mm' | 'grid';

export const ALGO_KINDS: readonly AlgoKind[] = ['twap', 'vwap', 'pov', 'iceberg', 'chase', 'scale', 'dca', 'swarm', 'conditional', 'trailing', 'basket', 'bracket', 'sweep', 'mm', 'grid'];

/** The kinds that only ever run as bots (the Bots page): open-ended, two-sided, resting only. */
export const BOT_KINDS: readonly AlgoKind[] = ['mm', 'grid'];

export type Side = 'buy' | 'sell';

/**
 * How a child order is worked.
 *   taker   IOC at the touch, never worse than `slippageBps` past it (and the algo's limit price);
 *   maker   post-only (GTX) at the touch, re-priced as the touch moves: never pays the spread;
 *   hybrid  rests first, and whatever of the slice is still open after `makerShare` of it crosses.
 */
export type ExecStyle = 'taker' | 'maker' | 'hybrid';

/**
 * What a taker leg's max slippage is measured from: SoDEX's best price on the
 * far side (the default, and every spec from before 2026-10-26), its mid, its
 * mark or index, or the shared oracle's mid or fair price (all venues).
 */
export type SlipFrom = 'touch' | 'mid' | 'mark' | 'index' | 'oracleMid' | 'oracleFair';
export const SLIP_FROM: readonly SlipFrom[] = ['touch', 'mid', 'mark', 'index', 'oracleMid', 'oracleFair'];
export const SLIP_FROM_NAMES: Readonly<Record<SlipFrom, string>> = {
  touch: 'Best price',
  mid: 'SoDEX mid',
  mark: 'SoDEX mark',
  index: 'SoDEX index',
  oracleMid: 'Oracle mid',
  oracleFair: 'Oracle fair price',
};

export interface ExecSpec {
  style: ExecStyle;
  /** Taker legs: the worst price per child, basis points past `slipFrom`. */
  slippageBps: number;
  /** What the slippage is measured from; absent: the touch. */
  slipFrom?: SlipFrom;
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

/**
 * The bracket an entry is followed by: a take-profit and/or a stop-loss on
 * what it filled, at a price or a distance from the average fill (a fraction:
 * 0.02 = 2%). They are SoDEX position stops (reduce-only, mark trigger) sized
 * to the filled amount and resized as it grows; when one of them fills, the
 * other is cancelled.
 */
export interface Exits {
  tpPrice: number | null;
  slPrice: number | null;
  tpPct: number | null;
  slPct: number | null;
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
  /** Take-profit / stop-loss after what it fills (opening algos only). null = none. */
  exits: Exits | null;
  /**
   * Started from the Bots page (bots.ts): it keeps a bot book (volume, fees, PnL over time) and carries the
   * bot builder fee instead of the copy ladder. Always true for the bot kinds (mm, grid); a DCA may be a bot.
   * Absent: false (every spec from before 2026-11-02).
   */
  bot?: boolean;
}

export interface TwapSpec extends AlgoBase {
  kind: 'twap';
  /** Ignored when `closeShare` is set (then '0'). */
  quantity: string;
  /**
   * Time-sliced close: work this share (0.01..1) of the position on the market
   * when it starts, on the side that reduces it, reduce-only. null = `quantity`.
   */
  closeShare: number | null;
  /** No child below this size (what is due waits until it reaches it, except at the end). null = SoDEX's minimum. */
  minSliceQty: string | null;
  /** No child above this size. null = no cap. */
  maxSliceQty: string | null;
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
  /**
   * Target share of the market's TOTAL volume (0.01..0.5), its own fills included:
   * what this algo fills / everything the market prints while it runs. 0.1 = one
   * print in ten is its own. Measured live, print by print, from the start.
   */
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
  /** linear / exponential: the last order's size over the first's (0.001..1000; a DCA ladder's size multiplier per step is this to the power 1/(orders-1)). */
  skew: number;
  /** Price steps: even, even in percent, denser near the first price, or denser near the last. */
  spacing: 'linear' | 'geometric' | 'front' | 'back';
  sizeJitter: number;
  postOnly: boolean;
  /**
   * Explicit levels (a DCA ladder): each price, first to last, in place of
   * from/to/orders/spacing (which still describe it: from = the first, to =
   * the last, orders = how many). Absent or null: the even ladder.
   */
  prices?: number[] | null;
  /** With `prices`: each level's relative size (base units). Absent: the size curve. */
  weights?: number[] | null;
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
  /**
   * The trader's own position on a market, as SoDEX reports it (read every few seconds):
   * long / short / flat; its size above or below `value` (base units, either side);
   * its unrealised PnL above or below `value` (USD, at the mark).
   */
  | { type: 'position'; symbol: string; op: 'long' | 'short' | 'flat' | 'sizeAbove' | 'sizeBelow' | 'pnlAbove' | 'pnlBelow'; value: number }
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

/** One market of a basket: its side and how much of it, in USD (turned into a size at the mark when it starts). */
export interface BasketLeg {
  symbol: string;
  side: Side;
  usd: number;
}

/**
 * One parent order spread over several markets: each leg runs as an algo of
 * its own (a swarm of takers, or a TWAP over the duration), started together,
 * paused, resumed and cancelled together. The base `symbol` and `side` are the
 * first leg's.
 */
export interface BasketSpec extends AlgoBase {
  kind: 'basket';
  legs: BasketLeg[];
  style: 'swarm' | 'twap';
  /** twap: over how long, and in how many slices each. */
  durationMs: number;
  slices: number;
  /** swarm: clips per leg, per wave, and the pause between waves. */
  clips: number;
  inFlight: number;
  waveMs: number;
  slippageBps: number;
}

/** An entry with its exits (`exits` is required): at market (a taker with a slippage cap) or as a resting limit. */
export interface BracketSpec extends AlgoBase {
  kind: 'bracket';
  quantity: string;
  entry: 'market' | 'limit';
  /** limit: the entry price. */
  price: number | null;
  slippageBps: number;
}

/**
 * Fill fast (sweep.ts): each round one IOC limit for everything still open,
 * at the reference plus `slippageBps` for a buy, minus for a sell. Paused
 * while no reference is fresh.
 *
 * The reference (oracle.ts): 'oracleMid' the median of the chosen venues'
 * mids, 'oracleFair' the median of their fair prices (mark, else mid) - both
 * fall back to SoDEX's mark while no venue is fresh; 'mark' / 'index' SoDEX's
 * own mark or index price.
 */
export type SweepReferenceKind = 'oracleMid' | 'oracleFair' | 'mark' | 'index';

export interface SweepSpec extends AlgoBase {
  kind: 'sweep';
  quantity: string;
  /** Absent (a spec from before 2026-10-26): 'oracleMid'. */
  reference?: SweepReferenceKind;
  /** The oracle's venues (oracle.ts ORACLE_VENUES). Absent or empty: all. */
  venues?: OracleVenue[];
  /** How far from the reference it may fill, bps. */
  slippageBps: number;
  /** Wait between rounds, ms. */
  roundMs: number;
  /** Give up after this long. null = never. */
  timeoutMs: number | null;
}

/**
 * What a bot does when it stops - the trader's stop, its volume target, its loss limit, its end time:
 *   close  pull its quotes, then close what it holds (post-only at the touch first, a capped taker after a minute);
 *   keep   pull its quotes and leave the position as it is.
 * The kill switch (cancel-all) never trades: it pulls and leaves.
 */
export type BotStop = 'close' | 'keep';

/** Limits every bot kind has. */
export interface BotLimits {
  /** Stop once it traded this much (USD, both sides). null = until stopped. */
  volumeTargetUsd: number | null;
  /** Stop once its net PnL (at the mark, after all fees) is this far below 0, USD. null = no loss limit. */
  maxLossUsd: number | null;
  /** Stop at this time. null = until stopped. */
  endAt: number | null;
  onStop: BotStop;
}

/**
 * Volume maker: one post-only bid and one post-only ask at the touch, re-priced as it moves, so every fill is
 * a maker fill (SoDEX's maker fee, never the spread). It holds what it filled within an inventory cap either
 * way; while it holds, the side that would add more steps back from the touch (skew), so the side that unwinds
 * fills first. At the cap it quotes only the unwinding side. Delta-neutral by construction: it never aims for
 * a position, only for turnover.
 */
export interface MmSpec extends AlgoBase, BotLimits {
  kind: 'mm';
  /** Each quote, USD. */
  orderUsd: number;
  /** The most it holds either way, USD at the mark. */
  maxInventoryUsd: number;
  /** Ticks behind the best price (0 = join it; -1 = one tick inside where the spread has room). */
  offsetTicks: number;
  /** Re-price once the best price is this many ticks away from the quote. */
  chaseTicks: number;
  /** At least this long between two re-prices of one side. */
  minRepriceMs: number;
  /** At a full inventory, the side that adds steps back this many ticks (in proportion below it). */
  skewTicks: number;
  /**
   * Each quote rests at least this far from the mid, bp (0 = at the touch). A round trip then earns at least twice
   * it: at 1.3 bp (1.2 bp maker + 0.1 bp bot fee) every round trip pays its own fees. Fewer fills, lower cost.
   * Absent (a spec from before it): 0.
   */
  edgeBps?: number;
  /**
   * The queue guard, a fraction (0-0.5; absent or 0: off). The side that would add to what it holds is not quoted -
   * and is pulled where it rests - while the size resting at its own best price is less than this share of both
   * best prices together: a thin queue is about to be traded through, and the fill it gives is the price running
   * against it (adverse selection). The side that unwinds is always quoted.
   */
  queueGuard?: number;
  /**
   * The ladder (1-5; absent or 1: one quote a side, re-priced as the touch moves). Above 1, a quote the touch moved
   * away from stays where it is - keeping its place in the queue - up to this many ticks back, and a new one joins
   * the touch: when the price comes back the old one is near the front, and a fill there is the bounce, not the
   * sweep that reaches the back of a queue. The inventory cap still holds what all of them could fill.
   */
  levels?: number;
  /**
   * The move guard, ticks (0 or absent: off): while the mid moved at least this far over the last 2 seconds, the
   * side it moves toward is not quoted where it would add (a rising price lifts the asks) - pulled where it rests.
   */
  moveGuard?: number;
  /**
   * Quote off Binance (the Binance-led maker; absent: off SoDEX's own book). The fair price is Binance USD-M's mid
   * times the basis - SoDEX's mid over Binance's, averaged over half a minute - read from the box's shared feed
   * (apps/executor/src/feed). Binance moves first: a quote the fair price came too close to is pulled the moment the
   * tick arrives, not at the next step. Hosted only (the browser has no feed): elsewhere it holds.
   */
  ref?: 'binance';
  /**
   * With `ref`: where the side that adds rests, bp from the fair price (0: SoDEX's best price, as without ref).
   * Above 0 it rests at fair -/+ this - inside the spread where it has room, behind the touch where the fair price
   * says the touch is too close - and the side that unwinds at a quarter of it.
   */
  refBps?: number;
  /** With `ref`: a quote of the adding side within this many bp of the fair price (or through it) is pulled (default 0). */
  pullBps?: number;
  /**
   * With `ref`: a NEW quote of the adding side goes out only this many bp from the fair price (0: pullBps decides).
   * An order takes about 350 ms to reach SoDEX's book, so one sent right at the line is past it on arrival: on the
   * live hours of 2026-11-04 over 90% of fills came with the fair price already past the quote, taken by the big maker.
   * Pickier to send than to keep: what rests stays until pullBps.
   */
  placeBps?: number;
  /** With `ref`: no new quote on the adding side while the reference moved this many bp at it over calmMs (0: off). */
  calmBps?: number;
  /** The window of calmBps, ms (default 500). */
  calmMs?: number;
  /**
   * With `ref`: no new quote on the adding side unless the reference's path (every move, up or down) over stillMs is under
   * this many bp (0: off). The makers that SoDEX's flow fills rather than its sniper rest only in a still market.
   */
  stillBps?: number;
  /** The window of stillBps, ms (default 60,000). */
  stillMs?: number;
  /** With `ref`: after this account takes on the market, the adding side is pulled and not quoted for pauseMs. */
  pauseAfter?: number;
  /** With `ref`: the quotes rest at the touch, with no limit at the fair price and no pull on it; the reference only feeds stillBps. */
  noFair?: boolean;
  pauseMs?: number;
  /** With `ref`: a resting quote is cancelled this long after it went out, wherever the price is (0: off). */
  restMs?: number;
  /**
   * The patient-taker gate (absent: off; with or without `ref`). The patient taker (bots.ts PATIENT_TAKER_ACCOUNT,
   * SoDEX account 1002) is the taker whose fills cost a maker little. While what it took on this market over the last
   * windowMs is under minUsd the gate is closed: 'pause' pulls the quotes and holds, 'shrink' quotes orderUsd x shrink
   * (never under SoDEX's minimum). For the first windowMs it watches a market the gate stays open.
   */
  flowGate?: FlowGate;
  /** Quiet windows (absent: none; at most 6; with or without `ref`): inside one the quotes are pulled and it holds. */
  quiet?: QuietWindow[];
  /** true: the windows are the hours it trades in, and outside all of them it holds (absent: it pauses inside them). */
  quietOnly?: boolean;
  /** The news gate (absent: off): held from beforeMin before to afterMin after each timed US release of its level. */
  news?: NewsGate;
}

/** MmSpec.news. */
export interface NewsGate {
  beforeMin: number;
  afterMin: number;
  /** 'high': CPI, jobs, FOMC, GDP, PCE; 'medium' adds PPI, JOLTS, ISM, retail sales and the like. */
  level: 'high' | 'medium';
}

/** A dated release the host knows of (the economic calendar), for MmSpec.news. */
export interface NewsEvent {
  time: number;
  short: string;
  importance: 'high' | 'medium' | 'low';
  /** Only the date is known: the gate skips it. */
  allDay?: boolean;
}

/** MmSpec.flowGate. */
export interface FlowGate {
  /** USD the patient taker took here over windowMs under which the gate is closed (1,000..100,000,000). */
  minUsd: number;
  /** The window, ms (60,000..3,600,000; default 600,000). */
  windowMs: number;
  /** Closed: pull and hold, or quote smaller. */
  action: 'pause' | 'shrink';
  /** 'shrink': the share of orderUsd quoted while closed (0.1..1; default 0.5). Kept with 'pause' too. */
  shrink: number;
}

/** MmSpec.quiet: from 'HH:MM' to 'HH:MM' (24 h, crossing midnight when from > to) in a zone's local time. */
export interface QuietWindow {
  from: string;
  to: string;
  /** UTC, or the local time (DST included) of America/New_York or Europe/London. */
  zone: 'utc' | 'new_york' | 'london';
  /**
   * Every day, Monday to Friday in that zone, or 'trading': the exchange's trading days there (NYSE for New York, the
   * London Stock Exchange for London, Monday to Friday for UTC), holidays skipped. A window past midnight goes by the
   * day it began.
   */
  days: 'all' | 'weekdays' | 'trading';
}

/**
 * Grid: post-only orders on levels between two prices - buys below the price, sells above. When a buy fills,
 * a sell goes up one level above it; when a sell fills, a buy one level below. Every round trip earns one
 * level's step, less two maker fees. Out of the range everything rests on one side and it waits (or stops).
 */
export interface GridSpec extends AlgoBase, BotLimits {
  kind: 'grid';
  /** The lowest and the highest level. */
  low: number;
  high: number;
  /** Levels (3..60), both ends included. */
  levels: number;
  /** Each level's order, USD. */
  orderUsd: number;
  /** Even steps in price, or in percent. */
  spacing: 'linear' | 'geometric';
  /** The mark out of the range: keep the orders and wait, or stop. */
  outOfRange: 'wait' | 'stop';
}

export type AlgoSpec =
  | MmSpec
  | GridSpec
  | SweepSpec
  | TwapSpec
  | VwapSpec
  | PovSpec
  | IcebergSpec
  | ChaseSpec
  | ScaleSpec
  | DcaSpec
  | SwarmSpec
  | ConditionalSpec
  | TrailingSpec
  | BasketSpec
  | BracketSpec;

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
  /** An exit: a SoDEX position stop (reduce-only market order) that fires when the mark reaches `price`. */
  exit?: 'tp' | 'sl';
  /**
   * An `unknown` child SoDEX's reads list nowhere - not in the open orders, not in the order
   * history (runtime.ts settleUnlisted): `at` the first such read; `cancelAt` when SoDEX took a
   * cancel by its client id (from then on it can neither rest nor fill); `fill` what SoDEX's
   * trades showed it filled, and `agree` how many trades reads in a row after the wait showed that.
   * Gone once any read or update lists it.
   */
  unlisted?: { at: number; cancelAt?: number; fill?: number; agree?: number };
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
  /** The exits (take-profit / stop-loss) it keeps on SoDEX for what it filled, live and done. */
  exitOrders?: ChildOrder[];
  /** The country the trader declared and the one their request came from (executors): the region rules that apply. */
  country?: string | null;
  observedCountry?: string | null;
  /** Kind-specific working state (schedules, peaks, holds, counters). */
  k: Record<string, unknown>;
  /** A bot's book (spec.bot): what it bought and sold, its fees and its PnL over time. */
  book?: BotBook;
}

/**
 * A bot's own trading, from its own fills only (a position the trader holds outside it is not in here).
 * Net PnL at a price P = sellValue - buyValue + (buyQty - sellQty) x P - tradeFees - builderFees.
 */
export interface BotBook {
  buyQty: number;
  buyValue: number;
  sellQty: number;
  sellValue: number;
  /** USD that rested (maker) and that took (taker). */
  makerValue: number;
  takerValue: number;
  /** SoDEX's trading fee and the ValueDesk builder fee, USD (estimated at the market's rates and the bot fee). */
  tradeFees: number;
  builderFees: number;
  fills: number;
  /**
   * What it took over from the bot it replaced (a restart that keeps the position, runtime NewAlgo.takeOver): that
   * bot's holding, signed, and its value at the price of the hand-over. Counted in what it holds and in its PnL (from
   * the hand-over price, so it starts at zero), never in its volume.
   */
  carryQty?: number;
  carryValue?: number;
  /** [time, volume so far, net PnL at the mark then, fees so far] - one point every few minutes, thinned as it grows. */
  series: Array<[number, number, number, number]>;
  /**
   * Who took its quotes, USD (owner 2026-11-08: the bot page shows the bot's own split, not the market's): the
   * uninformed taker (account 1002), the informed one (23342), everyone else. From the trade stream, where a print
   * names both accounts; a practice fill counts the print it filled against.
   */
  takers?: { t1002: number; t23342: number; other: number };
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
  /** The order's kind (post-only, IOC...) for an order, cancel or fill line; absent on older lines. */
  tif?: ChildTif;
  /** A fill: whether it rested (maker) or took. */
  maker?: boolean;
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
  /** Its exits on SoDEX (live ones, and any that filled). */
  exits: Array<{ kind: 'tp' | 'sl'; price: number; quantity: number; filled: number; live: boolean }> | null;
  /** A basket's legs. */
  legs: Array<{ id: string; symbol: string; side: Side; status: AlgoStatus; filledValue: number; avgPrice: number | null }> | null;
  /** A bot's figures, at the mark now (spec.bot). */
  bot?: BotView | null;
}

export interface BotView {
  /** USD traded, both sides. */
  volume: number;
  /** What it holds from its own fills (base units, signed) and its value at the mark. */
  inventory: number;
  inventoryUsd: number;
  /** Before fees: what its trading made or lost at the mark. */
  grossPnl: number;
  /** After every fee. */
  netPnl: number;
  tradeFees: number;
  builderFees: number;
  /** Share of the volume that rested (0..1). */
  makerShare: number;
  /** What a million dollars of volume cost it: fees less what its trading made (USD per 1M; negative = it earned). */
  costPerMillion: number | null;
  fills: number;
  mark: number | null;
  /** Its quotes or levels on SoDEX now. */
  orders: Array<{ side: Side; price: number; quantity: number; tag: string }>;
  /** Stopping: closing what it holds. */
  closing: boolean;
  /** Who took its quotes, USD (BotBook.takers); absent until a fill is seen on the trade stream. */
  takers?: { t1002: number; t23342: number; other: number };
}

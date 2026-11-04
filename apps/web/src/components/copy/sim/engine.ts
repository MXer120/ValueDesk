/**
 * COPY-TRADING SIMULATION ENGINE (reference logic for the future live executor).
 *
 * Pure and deterministic: no clock, no randomness, no I/O. The same fills,
 * config and options always produce the same result, regardless of the order
 * the fills are passed in (they are sorted into one total order first).
 *
 * The engine replays a leader's fills chronologically, reconstructs the
 * leader's signed position per market, and simulates a follower under a
 * CopyConfig:
 *   - opens / increases move the follower TOWARDS a target (C.3), so an
 *     increase that was too small to trade is picked up by the next one (the
 *     "residual" of C.2);
 *   - decreases reduce the follower by the SAME FRACTION the leader reduced;
 *   - closes close the whole follower position;
 *   - flips close (reduce-only) and then open the new side as a fresh open.
 * See README.md next to this file for the full algorithm and its assumptions.
 *
 * Ported from the rejected web draft (archive/web-draft/src/pages/copy/sim).
 * The follower algorithm is unchanged. What changed (ENGINE_VERSION 2):
 *  - the types are the ValueDesk contract's (fills arrive through adapt.ts),
 *    and the demo flag is gone because this app has no demo data;
 *  - new option `builderFeeOnReduce` (the planned pricing charges opens only);
 *  - the leader curve scales each PnL step by the leader's equity AT THAT TIME,
 *    so deposits and withdrawals no longer read as gains or losses;
 *  - leader equity below $1 is ignored (venues report new accounts as dust).
 */
import type { CopyConfig, EquityPoint, SimFill, SimulatedFill, TraderRef, Venue } from './types';

type Fill = SimFill;

/** Bump when the algorithm changes in a way that changes results. */
export const ENGINE_VERSION = 2;

/* ------------------------------------------------------------------ public types */

/** Why a leader fill was not copied. Stable ids; UI labels are in SKIP_REASONS. */
export const SKIP_REASONS = {
  duplicate: 'Duplicate fill (same id seen twice)',
  'invalid-fill': 'Fill has no usable price, size or side',
  'asset-not-allowed': 'Coin is not on your allow list',
  'asset-denied': 'Coin is on your deny list',
  'pre-existing-position': 'Leader position was opened before the copy started',
  'after-stop-loss': 'Your copy hit its stop loss; waiting for the leader to close',
  'after-take-profit': 'Your copy took profit; waiting for the leader to close',
  halted: 'Copying was halted (drawdown stop or liquidation)',
  'no-leader-equity': 'Leader equity unknown, so proportional size cannot be computed',
  'no-equity': 'No follower equity left',
  'at-target': 'Your position is already at or above the target size',
  'no-follower-position': 'Nothing to reduce: the matching open was not copied',
  'max-position': 'Per-position cap reached',
  'max-leverage': 'Leverage cap reached',
  'min-notional': 'Below the venue minimum order value',
  'lot-size': 'Rounds to zero at the venue lot size',
} as const;
export type SkipReason = keyof typeof SKIP_REASONS;

/** What a log entry did. 'skip' entries have skippedReason set. */
export type SimAction =
  | 'open'
  | 'increase'
  | 'decrease'
  | 'close'
  | 'flip'
  | 'join'
  | 'skip'
  | 'stop-loss'
  | 'take-profit'
  | 'drawdown-stop'
  | 'liquidation';

export type ClampReason = 'max-position' | 'max-leverage';
export type HaltReason = 'drawdownStop' | 'liquidation';
export type LeaderEquitySource = 'series' | 'option' | 'estimated';

/**
 * Engine options. Everything is optional; defaults are listed per field and in
 * README.md.
 */
export interface SimOptions {
  leader?: TraderRef;
  /** Starting follower equity. Default: config.allocationUsd. */
  startEquity?: number;
  /** Leader equity used for proportional sizing when no series is given. */
  leaderEquity?: number;
  /** Taker fee as a fraction (0.00045 = 4.5 bp). Default: the venue's base tier. */
  feeRate?: number;
  /** Builder fee in tenths of a bp (50 = 5 bp), added on top of the taker fee. */
  builderFeeTenthsBps?: number;
  /**
   * Charge the builder fee on reduce-only legs (decreases, closes, stops) too.
   * Default true. The planned launch pricing (research 06) charges opens and
   * increases only, which is `false`.
   */
  builderFeeOnReduce?: boolean;
  /**
   * Copy start (ms). Fills before it are a WARM-UP: they only reconstruct the
   * leader's positions (so "opened before the start" is known exactly) and are
   * not copied or counted. Default: the first fill's time.
   */
  startAt?: number;
  /**
   * Leader equity over time, for proportional sizing (step function: the last
   * point at or before each fill). Points need `accountValue`; PnL-only points
   * are used when `leaderEquity` (taken as the equity at the LAST point) anchors them.
   */
  leaderEquitySeries?: EquityPoint[];
  /** Minimum order notional, USD: one number or per venue. Default 10 (SoDEX spot 5). */
  minNotionalUsd?: number | Partial<Record<Venue, number>>;
  /** Lot (step) size in base units, keyed by symbol or coin. Default: a price-based heuristic. */
  lotSize?: Record<string, number>;
  /** USD per copied open in fixedNotional mode. Default: config.maxPositionUsd. */
  fixedNotionalUsd?: number;
  /** Leverage that defines a copied position's margin for stop loss / take profit. Default: config.maxLeverage. */
  positionLeverage?: number;
  /** Maintenance margin as a fraction of notional (account liquidation backstop). Default 0.025. */
  maintenanceMarginRate?: number;
  /** Slippage paid on every follower order, bps. Default: config.slippageBps (worst case). */
  slippageBps?: number;
  /** Merge consecutive fills of one order (same time, market, side, order id). Default true. */
  mergeOrderFills?: boolean;
  /** Max points per returned curve (extremes are kept). Default 2000. */
  maxCurvePoints?: number;
}

/** One entry of the per-trade log. Extends the shared SimulatedFill. */
export interface SimTrade extends SimulatedFill {
  /** Position in the log (0-based). */
  seq: number;
  time: number;
  venue: Venue;
  symbol: string;
  coin: string;
  action: SimAction;
  /** Index in the INPUT fills array of the (first) leader fill behind this entry. */
  leaderIndex: number;
  /** Leader fills merged into this entry (1 unless several fills of one order were merged). */
  leaderFillCount: number;
  /** Leader position (signed base units) before / after the fill; null for unusable fills. */
  leaderPositionBefore: number | null;
  leaderPositionAfter: number | null;
  /** Follower position (signed base units) after this entry; null for unusable fills. */
  followerPositionAfter: number | null;
  /** Builder-fee part of `fee`. */
  builderFee: number;
  /** Set when the copy was executed but made smaller by a cap. */
  clampedBy: ClampReason | null;
  /** Extra context, e.g. "open leg skipped: min-notional" on a flip. */
  note: string | null;
  /** Follower equity (mark-to-market) after this entry. */
  equityAfter: number;
}

export interface SimOpenPosition {
  venue: Venue;
  symbol: string;
  coin: string;
  /** Signed base units. */
  size: number;
  entryPrice: number;
  markPrice: number;
  notionalUsd: number;
  unrealizedPnl: number;
}

/** The engine's result. */
export interface SimResult {
  leader: TraderRef | null;
  config: CopyConfig;
  /** First and last in-window time replayed (ms). */
  from: number;
  to: number;
  startEquity: number;
  endEquity: number;
  pnl: number;
  /** Fraction. */
  roi: number;
  /** Positive fraction. */
  maxDrawdown: number;
  copiedFills: number;
  skippedFills: number;
  skippedByReason: Record<string, number>;
  feesUsd: number;
  slippageUsd: number;
  equityCurve: EquityPoint[];
  /** Which guard ended the run early, if any ('drawdownStop' also covers liquidation, see haltReason). */
  stoppedBy: 'drawdownStop' | 'stopLoss' | 'takeProfit' | null;
  stoppedAt: number | null;
  fills: SimTrade[];
  /** Leader's replayed PnL normalised to the follower's start equity (same timestamps as equityCurve). */
  leaderCurve: EquityPoint[];
  leaderRoi: number;
  leaderMaxDrawdown: number;
  /** Where the leader equity used for sizing / normalising came from. */
  leaderEquitySource: LeaderEquitySource;
  /** Leader equity at the start, the base of leaderCurve. */
  leaderEquityBase: number;
  /** Builder-fee part of feesUsd. */
  builderFeesUsd: number;
  realizedPnl: number;
  unrealizedPnl: number;
  /** Follower traded notional, USD. */
  volumeUsd: number;
  /** Leader fills copied at a reduced size because of a cap. */
  clampedFills: number;
  clampedByReason: Record<string, number>;
  riskEvents: { stopLoss: number; takeProfit: number; drawdownStop: number; liquidation: number };
  /** Why copying halted (stoppedBy is 'drawdownStop' for both, as the shared type has no 'liquidation'). */
  haltReason: HaltReason | null;
  openPositions: SimOpenPosition[];
  /** Fills before startAt, used only to reconstruct the leader's positions. */
  warmupFills: number;
  /** Data caveats to show near the result. */
  notes: string[];
  engineVersion: number;
}

/* --------------------------------------------------------------- defaults */

const DEFAULT_MIN_NOTIONAL = 10;
const SODEX_SPOT_MIN_NOTIONAL = 5;
const DEFAULT_MMR = 0.025;
const DEFAULT_MAX_CURVE_POINTS = 2000;
/**
 * Leader equity below this is not an equity. Venues report a brand-new or
 * emptied account as dust (Hyperliquid's portfolio series says 0.000001), and
 * dividing by that sizes a copy - and scales the leader curve - by a factor of
 * a billion. Such points are skipped, as if the venue had not reported them.
 */
const MIN_LEADER_EQUITY = 1;
const LOT_EPS = 1e-9;

/** Tier-0 taker fees (research 06): HL perps 4.5 bp / spot 7 bp; SoDEX perps 4.0 bp / spot 6.5 bp. */
const DEFAULT_TAKER: Record<Venue, { perp: number; spot: number }> = {
  hyperliquid: { perp: 0.00045, spot: 0.0007 },
  sodex: { perp: 0.0004, spot: 0.00065 },
  tradexyz: { perp: 0.00045, spot: 0.0007 },
  lighter: { perp: 0, spot: 0 },
  arcus: { perp: 0.0004, spot: 0.0004 },
};

/** Spot market heuristic: HL spot is '@123' or 'PURR/USDC'; SoDEX spot is 'vBTC_vUSDC'. */
export function isSpotSymbol(venue: Venue, symbol: string): boolean {
  if (venue === 'hyperliquid') return symbol.startsWith('@') || symbol.includes('/');
  return symbol.includes('_');
}

/** Default lot: the power of ten that is worth $0.10-$1 at `price` (close to HL szDecimals). */
export function defaultLotSize(price: number): number {
  if (!(price > 0) || !Number.isFinite(price)) return 1e-8;
  const exp = Math.floor(Math.log10(1 / price));
  return Math.pow(10, Math.max(-8, Math.min(8, exp)));
}

/* ---------------------------------------------------------------- internals */

interface Ev {
  fill: Fill;
  index: number;
  count: number;
  time: number;
  price: number;
  /** Signed base size (+buy / -sell). */
  signed: number;
  startPosition: number | null;
  /** Unusable fills are logged as skipped and never touch state. */
  bad: 'duplicate' | 'invalid-fill' | null;
}

type Detach = 'pre-existing' | 'stop-loss' | 'take-profit';

interface Mkt {
  venue: Venue;
  symbol: string;
  coin: string;
  lot: number;
  minNotional: number;
  takerRate: number;
  mark: number;
  /** Leader signed position and cached lPos*mark. */
  lPos: number;
  lVal: number;
  /** Saw an in-window fill on this market yet. */
  lSeen: boolean;
  /** Follower signed position in integer lots, average entry, cached value. */
  fLots: number;
  fEntry: number;
  fVal: number;
  detached: Detach | null;
  /** Asset filter verdict (null = copyable). */
  filtered: SkipReason | null;
}

interface Acc {
  size: number;
  qty: number;
  pxQty: number;
  notional: number;
  fee: number;
  builder: number;
  slip: number;
  realized: number;
}

const newAcc = (): Acc => ({ size: 0, qty: 0, pxQty: 0, notional: 0, fee: 0, builder: 0, slip: 0, realized: 0 });

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const sgn = (x: number): number => (x > 0 ? 1 : x < 0 ? -1 : 0);
const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b), 1e-6);
const inc = (rec: Record<string, number>, k: string, n: number): void => {
  rec[k] = (rec[k] ?? 0) + n;
};

/** Numeric-aware, locale-independent id comparison ('9' < '10'); null first. */
function cmpId(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn && a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}
const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function validFill(f: Fill): boolean {
  return (
    !!f &&
    fin(f.time) &&
    fin(f.price) &&
    f.price > 0 &&
    fin(f.size) &&
    f.size > 0 &&
    (f.side === 'buy' || f.side === 'sell') &&
    typeof f.symbol === 'string'
  );
}

/**
 * Sort into one total order (time, symbol, order id, fill id, input index),
 * flag duplicates / unusable fills, and merge consecutive fills of one order.
 */
export function prepareEvents(fills: Fill[], merge: boolean): Ev[] {
  const n = fills.length;
  const idx = new Array<number>(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  const t = (f: Fill | undefined): number => (f && fin(f.time) ? f.time : Number.NEGATIVE_INFINITY);
  idx.sort((a, b) => {
    const fa = fills[a]!;
    const fb = fills[b]!;
    const dt = t(fa) - t(fb);
    if (dt !== 0 && !Number.isNaN(dt)) return dt;
    return (
      cmpStr(String(fa?.symbol ?? ''), String(fb?.symbol ?? '')) ||
      cmpId(fa?.orderId ?? null, fb?.orderId ?? null) ||
      cmpId(fa?.id ?? null, fb?.id ?? null) ||
      a - b
    );
  });

  const seen = new Set<string>();
  const out: Ev[] = [];
  let group: Ev | null = null;
  const flush = (): void => {
    if (!group) return;
    if (group.count > 1) {
      const first = group.fill;
      const size = Math.abs(group.signed);
      group.fill = {
        ...first,
        id: `${first.id}+${group.count - 1}`,
        size,
        price: group.price,
        notionalUsd: group.price * size,
        fee: group.fill.fee,
      };
    }
    out.push(group);
    group = null;
  };

  for (let k = 0; k < n; k++) {
    const i = idx[k]!;
    const f = fills[i]!;
    let bad: Ev['bad'] = null;
    if (!validFill(f)) bad = 'invalid-fill';
    else {
      const key = `${f.venue}:${f.id}`;
      if (seen.has(key)) bad = 'duplicate';
      else seen.add(key);
    }
    if (bad) {
      flush();
      out.push({
        fill: f,
        index: i,
        count: 1,
        time: f && fin(f.time) ? f.time : Number.NEGATIVE_INFINITY,
        price: f && fin(f.price) ? f.price : 0,
        signed: 0,
        startPosition: null,
        bad,
      });
      continue;
    }
    const signed = f.side === 'buy' ? f.size : -f.size;
    const g = group as Ev | null;
    if (
      merge &&
      g &&
      g.fill.orderId !== null &&
      g.fill.orderId === f.orderId &&
      g.fill.venue === f.venue &&
      g.fill.symbol === f.symbol &&
      g.fill.side === f.side &&
      g.time === f.time
    ) {
      const absBefore = Math.abs(g.signed);
      const absAfter = absBefore + f.size;
      g.price = (g.price * absBefore + f.price * f.size) / absAfter;
      g.signed += signed;
      g.count++;
      // Fee / realised PnL of a merged group: summed when every part reports one.
      const fee = g.fill.fee !== null && f.fee !== null && g.fill.feeAsset === f.feeAsset ? g.fill.fee + f.fee : null;
      const realizedPnl = g.fill.realizedPnl !== null && f.realizedPnl !== null ? g.fill.realizedPnl + f.realizedPnl : null;
      g.fill = { ...g.fill, fee, realizedPnl };
      continue;
    }
    flush();
    group = {
      fill: f,
      index: i,
      count: 1,
      time: f.time,
      price: f.price,
      signed,
      startPosition: fin(f.startPosition) ? f.startPosition : null,
      bad: null,
    };
  }
  flush();
  return out;
}

interface LeaderEquity {
  source: LeaderEquitySource;
  /** Equity at t; queries must be non-decreasing in t. */
  at(t: number): number | null;
}

function leaderEquityFrom(opts: SimOptions, estimate: () => number): LeaderEquity {
  const anchor = fin(opts.leaderEquity) && opts.leaderEquity >= MIN_LEADER_EQUITY ? opts.leaderEquity : null;
  const pts = (opts.leaderEquitySeries ?? []).filter((p) => p && fin(p.t)).slice().sort((a, b) => a.t - b.t);
  const ts: number[] = [];
  const vs: number[] = [];
  if (pts.length) {
    const lastPnl = [...pts].reverse().find((p) => fin(p.pnl))?.pnl ?? null;
    for (const p of pts) {
      let v: number | null = null;
      if (fin(p.accountValue) && p.accountValue >= MIN_LEADER_EQUITY) v = p.accountValue;
      else if (anchor !== null && fin(p.pnl) && lastPnl !== null) v = anchor - (lastPnl - p.pnl);
      if (v !== null && v >= MIN_LEADER_EQUITY) {
        ts.push(p.t);
        vs.push(v);
      }
    }
  }
  if (ts.length) {
    let j = 0;
    return {
      source: 'series',
      at(t) {
        while (j + 1 < ts.length && ts[j + 1]! <= t) j++;
        return vs[j]!;
      },
    };
  }
  if (anchor !== null) return { source: 'option', at: () => anchor };
  let est: number | null = null;
  return {
    source: 'estimated',
    at() {
      if (est === null) est = estimate();
      return est > 0 ? est : null;
    },
  };
}

/** Peak gross notional of the leader inside the window (the 1x-leverage equity estimate). */
function estimateLeaderEquity(events: Ev[], startAt: number): number {
  const pos = new Map<string, number>();
  const val = new Map<string, number>();
  let gross = 0;
  let peak = 0;
  for (const ev of events) {
    if (ev.bad) continue;
    const key = `${ev.fill.venue}:${ev.fill.symbol}`;
    let p = pos.get(key) ?? 0;
    if (ev.startPosition !== null && !near(ev.startPosition, p)) p = ev.startPosition;
    p += ev.signed;
    if (Math.abs(p) <= 1e-9 * Math.abs(ev.signed)) p = 0;
    pos.set(key, p);
    const v = Math.abs(p * ev.price);
    gross += v - (val.get(key) ?? 0);
    val.set(key, v);
    if (ev.time >= startAt && gross > peak) peak = gross;
  }
  return peak;
}

/** Indices to keep so a curve has at most `max` points, keeping each bucket's extremes. */
export function downsampleIndices(ts: number[], a: number[], b: number[], max: number): number[] {
  const n = ts.length;
  let keep: number[];
  if (n <= max) {
    keep = new Array<number>(n);
    for (let i = 0; i < n; i++) keep[i] = i;
  } else {
    keep = [0];
    const buckets = Math.max(1, Math.floor((max - 2) / 5));
    const size = (n - 1) / buckets;
    for (let k = 0; k < buckets; k++) {
      const lo = 1 + Math.floor(k * size);
      const hi = k === buckets - 1 ? n : 1 + Math.floor((k + 1) * size);
      if (hi <= lo) continue;
      let aMin = lo;
      let aMax = lo;
      let bMin = lo;
      let bMax = lo;
      for (let i = lo + 1; i < hi; i++) {
        if (a[i]! < a[aMin]!) aMin = i;
        if (a[i]! > a[aMax]!) aMax = i;
        if (b[i]! < b[bMin]!) bMin = i;
        if (b[i]! > b[bMax]!) bMax = i;
      }
      const set = [...new Set([aMin, aMax, bMin, bMax, hi - 1])].sort((x, y) => x - y);
      for (const i of set) if (i > keep[keep.length - 1]!) keep.push(i);
    }
  }
  // One point per timestamp (charts need strictly increasing time): keep the last.
  const out: number[] = [];
  for (const i of keep) {
    if (out.length && ts[out[out.length - 1]!] === ts[i]) out[out.length - 1] = i;
    else out.push(i);
  }
  return out;
}

/* ------------------------------------------------------------------ engine */

/**
 * Simulate `config` copying the leader who produced `fills`.
 * Fills may be in any order and may include other venues' fills (each market
 * is tracked separately by venue + symbol).
 */
export function runCopySimulation(fills: Fill[], config: CopyConfig, opts: SimOptions = {}): SimResult {
  /* ---- config, sanitised (never trust UI input to be finite) ---- */
  const mode = config.sizingMode;
  // A counter-trade decides on the leader's position mirrored; the leader's own books stay real.
  const mirror = config.direction === 'counter' ? -1 : 1;
  const ratio = fin(config.ratio) && config.ratio > 0 ? config.ratio : 0;
  const mult = fin(config.multiplier) && config.multiplier > 0 ? config.multiplier : 1;
  const maxLev = fin(config.maxLeverage) && config.maxLeverage > 0 ? config.maxLeverage : 0;
  const maxPosUsd = fin(config.maxPositionUsd) && config.maxPositionUsd > 0 ? config.maxPositionUsd : 0;
  const slPct = fin(config.stopLossPct) && config.stopLossPct > 0 ? config.stopLossPct : null;
  const tpPct = fin(config.takeProfitPct) && config.takeProfitPct > 0 ? config.takeProfitPct : null;
  const ddPct = fin(config.drawdownStopPct) && config.drawdownStopPct > 0 ? config.drawdownStopPct : null;
  const allow = new Set((config.assetAllow ?? []).map((c) => c.trim().toUpperCase()).filter(Boolean));
  const deny = new Set((config.assetDeny ?? []).map((c) => c.trim().toUpperCase()).filter(Boolean));
  const slipBps = fin(opts.slippageBps) ? opts.slippageBps : fin(config.slippageBps) ? config.slippageBps : 0;
  const slip = Math.max(0, slipBps) / 10_000;
  const builderRate = fin(opts.builderFeeTenthsBps) ? Math.max(0, opts.builderFeeTenthsBps) / 100_000 : 0;
  const builderOnReduce = opts.builderFeeOnReduce !== false;
  const posLev = fin(opts.positionLeverage) && opts.positionLeverage > 0 ? opts.positionLeverage : Math.max(1, maxLev);
  const mmr = fin(opts.maintenanceMarginRate) && opts.maintenanceMarginRate >= 0 ? opts.maintenanceMarginRate : DEFAULT_MMR;
  const fixedUsd = fin(opts.fixedNotionalUsd) && opts.fixedNotionalUsd > 0 ? opts.fixedNotionalUsd : maxPosUsd;
  const maxCurve = fin(opts.maxCurvePoints) && opts.maxCurvePoints >= 8 ? Math.floor(opts.maxCurvePoints) : DEFAULT_MAX_CURVE_POINTS;
  const startEquity = fin(opts.startEquity) ? Math.max(0, opts.startEquity) : fin(config.allocationUsd) ? Math.max(0, config.allocationUsd) : 0;

  const events = prepareEvents(fills, opts.mergeOrderFills !== false);
  const firstValid = events.find((e) => !e.bad && fin(e.time));
  const startAt = fin(opts.startAt) ? opts.startAt : (firstValid?.time ?? Number.NEGATIVE_INFINITY);
  const leaderEq = leaderEquityFrom(opts, () => estimateLeaderEquity(events, startAt));

  const minNotionalFor = (venue: Venue, symbol: string): number => {
    const o = opts.minNotionalUsd;
    if (fin(o)) return Math.max(0, o);
    const v = o && typeof o === 'object' ? o[venue] : undefined;
    if (fin(v)) return Math.max(0, v);
    return venue === 'sodex' && isSpotSymbol(venue, symbol) ? SODEX_SPOT_MIN_NOTIONAL : DEFAULT_MIN_NOTIONAL;
  };
  const takerFor = (venue: Venue, symbol: string): number => {
    if (fin(opts.feeRate)) return Math.max(0, opts.feeRate);
    const d = DEFAULT_TAKER[venue] ?? DEFAULT_TAKER.hyperliquid;
    return isSpotSymbol(venue, symbol) ? d.spot : d.perp;
  };

  /* ---- state ---- */
  const markets = new Map<string, Mkt>();
  let cash = startEquity;
  let fSum = 0;
  let fGross = 0;
  let openCount = 0;
  let lCash = 0;
  let lSum = 0;
  let baseline = 0;
  let leaderBase = 0;
  let started = false;
  let halted = false;
  let haltReason: HaltReason | null = null;
  let stoppedAt: number | null = null;
  let peak = startEquity;
  let maxDd = 0;
  let lPeak = 0;
  let lMaxDd = 0;

  let copied = 0;
  let skipped = 0;
  let clampedFills = 0;
  let warmup = 0;
  let duplicates = 0;
  let invalid = 0;
  let missingStart = 0;
  let inWindowValid = 0;
  const skippedBy: Record<string, number> = {};
  const clampedBy: Record<string, number> = {};
  const risk = { stopLoss: 0, takeProfit: 0, drawdownStop: 0, liquidation: 0 };
  let feesUsd = 0;
  let builderUsd = 0;
  let slipUsd = 0;
  let realizedUsd = 0;
  let volumeUsd = 0;
  let liquidationShortfall = 0;

  const log: SimTrade[] = [];
  const cT: number[] = [];
  const cF: number[] = [];
  const cL: number[] = [];
  let from = fin(opts.startAt) ? opts.startAt : (firstValid?.time ?? 0);
  let to = from;

  const equity = (): number => cash + fSum;
  /*
   * The leader's replayed PnL, scaled to the follower's start equity.
   *
   * Each PnL increment is scaled by the leader's equity AT THAT TIME, not at the
   * start: `startEquity x dPnL / leaderEquity(t)`. With one constant leader
   * equity (the `option` and `estimated` sources) that sums to exactly
   * `startEquity x (1 + PnL / leaderEquity)`. With a series it neutralises
   * deposits and withdrawals: a leader who starts with $5k, deposits $15k and
   * then loses $10k lost half of what they had, not twice their starting stake -
   * which the start-equity version reported as a wipe-out.
   */
  let lAcc = 0;
  let lPrevPnl = 0;
  let lPrevEq = 0;
  const leaderNorm = (t: number): number => {
    if (!(leaderBase > 0)) return startEquity;
    const pnl = lCash + lSum - baseline;
    const base = lPrevEq > 0 ? lPrevEq : leaderBase;
    lAcc += (startEquity * (pnl - lPrevPnl)) / base;
    lPrevPnl = pnl;
    const now = leaderEq.at(t);
    lPrevEq = now !== null && now > 0 ? now : base;
    return Math.max(0, startEquity + lAcc);
  };
  const observe = (e: number): void => {
    if (e > peak) peak = e;
    if (peak > 0) {
      const dd = (peak - e) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  };
  const record = (t: number): void => {
    const e = equity();
    observe(e);
    const l = leaderNorm(t);
    if (l > lPeak) lPeak = l;
    if (lPeak > 0 && (lPeak - l) / lPeak > lMaxDd) lMaxDd = (lPeak - l) / lPeak;
    cT.push(t);
    cF.push(e);
    cL.push(l);
  };

  const getMkt = (f: Fill): Mkt => {
    const key = `${f.venue}:${f.symbol}`;
    let m = markets.get(key);
    if (!m) {
      const coin = String(f.coin ?? f.symbol).toUpperCase();
      const lotOverride = opts.lotSize?.[f.symbol] ?? opts.lotSize?.[coin] ?? opts.lotSize?.[f.coin];
      m = {
        venue: f.venue,
        symbol: f.symbol,
        coin,
        lot: fin(lotOverride) && lotOverride > 0 ? lotOverride : defaultLotSize(f.price),
        minNotional: minNotionalFor(f.venue, f.symbol),
        takerRate: takerFor(f.venue, f.symbol),
        mark: Number.NaN,
        lPos: 0,
        lVal: 0,
        lSeen: false,
        fLots: 0,
        fEntry: 0,
        fVal: 0,
        detached: null,
        filtered: allow.size > 0 && !allow.has(coin) ? 'asset-not-allowed' : deny.has(coin) ? 'asset-denied' : null,
      };
      markets.set(key, m);
    }
    return m;
  };

  const setFVal = (m: Mkt): void => {
    const v = m.fLots === 0 ? 0 : m.fLots * m.lot * m.mark;
    fSum += v - m.fVal;
    fGross += Math.abs(v) - Math.abs(m.fVal);
    m.fVal = v;
  };
  const setLVal = (m: Mkt): void => {
    const v = m.lPos === 0 ? 0 : m.lPos * m.mark;
    lSum += v - m.lVal;
    m.lVal = v;
  };

  /** Execute a follower order of `dLots` lots at reference price `ref` (slippage applied adversely). */
  const exec = (m: Mkt, dLots: number, ref: number, acc: Acc): void => {
    if (dLots === 0) return;
    const dir = dLots > 0 ? 1 : -1;
    const qty = dLots * m.lot;
    const absQty = Math.abs(qty);
    const px = ref * (1 + dir * slip);
    const notional = absQty * px;
    const taker = notional * m.takerRate;
    const before = m.fLots;
    // One exec is either a pure reduce or a pure grow: flips close first, then open.
    const reducing = before !== 0 && sgn(before) !== dir;
    const builder = reducing && !builderOnReduce ? 0 : notional * builderRate;
    const slipCost = absQty * ref * slip;
    const after = before + dLots;
    let realized = 0;
    if (before !== 0 && sgn(before) !== dir) {
      const closing = Math.min(Math.abs(dLots), Math.abs(before)) * m.lot;
      realized = closing * (px - m.fEntry) * sgn(before);
    }
    if (after === 0) m.fEntry = 0;
    else if (before === 0 || sgn(after) !== sgn(before)) m.fEntry = px;
    else if (Math.abs(after) > Math.abs(before))
      m.fEntry = (Math.abs(before) * m.fEntry + Math.abs(dLots) * px) / Math.abs(after);
    cash -= qty * px + taker + builder;
    if (before === 0 && after !== 0) openCount++;
    if (before !== 0 && after === 0) openCount--;
    m.fLots = after;
    setFVal(m);
    if (openCount === 0) {
      fSum = 0;
      fGross = 0;
    }
    feesUsd += taker + builder;
    builderUsd += builder;
    slipUsd += slipCost;
    realizedUsd += realized;
    volumeUsd += notional;
    acc.size += qty;
    acc.qty += absQty;
    acc.pxQty += absQty * px;
    acc.notional += notional;
    acc.fee += taker + builder;
    acc.builder += builder;
    acc.slip += slipCost;
    acc.realized += realized;
  };

  const pushEntry = (
    ev: Ev,
    m: Mkt | null,
    action: SimAction,
    acc: Acc | null,
    extra: {
      reason?: SkipReason | null;
      clamp?: ClampReason | null;
      note?: string | null;
      lBefore?: number | null;
      lAfter?: number | null;
    } = {},
  ): void => {
    log.push({
      leaderFill: ev.fill,
      size: acc ? acc.size : 0,
      price: acc && acc.qty > 0 ? acc.pxQty / acc.qty : ev.price,
      notionalUsd: acc ? acc.notional : 0,
      fee: acc ? acc.fee : 0,
      slippageCost: acc ? acc.slip : 0,
      realizedPnl: acc ? acc.realized : 0,
      skippedReason: extra.reason ?? null,
      seq: log.length,
      time: ev.time,
      venue: ev.fill?.venue,
      symbol: ev.fill?.symbol,
      coin: m ? m.coin : String(ev.fill?.coin ?? ''),
      action,
      leaderIndex: ev.index,
      leaderFillCount: ev.count,
      leaderPositionBefore: extra.lBefore ?? null,
      leaderPositionAfter: extra.lAfter ?? null,
      followerPositionAfter: m ? m.fLots * m.lot : null,
      builderFee: acc ? acc.builder : 0,
      clampedBy: extra.clamp ?? null,
      note: extra.note ?? null,
      equityAfter: equity(),
    });
  };

  const skip = (ev: Ev, m: Mkt | null, reason: SkipReason, lBefore: number | null, lAfter: number | null): void => {
    skipped += ev.count;
    inc(skippedBy, reason, ev.count);
    pushEntry(ev, m, 'skip', null, { reason, lBefore, lAfter });
  };

  /** Engine-initiated full close (stop loss, take profit, drawdown stop, liquidation). */
  const forceClose = (m: Mkt, ref: number, action: SimAction, ev: Ev, lBefore: number, lAfter: number): void => {
    const acc = newAcc();
    exec(m, -m.fLots, ref, acc);
    pushEntry(ev, m, action, acc, { lBefore, lAfter });
  };

  const closeAll = (action: SimAction, ev: Ev, lBefore: number, lAfter: number): void => {
    for (const m of markets.values()) if (m.fLots !== 0) forceClose(m, m.mark, action, ev, lBefore, lAfter);
    fSum = 0;
    fGross = 0;
    openCount = 0;
  };

  /** Stop loss / take profit on the market whose mark just moved. */
  const positionGuards = (m: Mkt, ev: Ev, lBefore: number, lAfter: number): void => {
    if (m.fLots === 0) return;
    const s = sgn(m.fLots);
    const p = m.mark;
    if (slPct !== null) {
      const trig = m.fEntry * (1 - (s * slPct) / posLev);
      if (trig > 0 && (s > 0 ? p <= trig : p >= trig)) {
        forceClose(m, trig, 'stop-loss', ev, lBefore, lAfter);
        m.detached = 'stop-loss';
        risk.stopLoss++;
        return;
      }
    }
    if (tpPct !== null) {
      const trig = m.fEntry * (1 + (s * tpPct) / posLev);
      if (trig > 0 && (s > 0 ? p >= trig : p <= trig)) {
        forceClose(m, trig, 'take-profit', ev, lBefore, lAfter);
        m.detached = 'take-profit';
        risk.takeProfit++;
      }
    }
  };

  /** Drawdown stop, then the account liquidation backstop. */
  const accountGuards = (ev: Ev, lBefore: number, lAfter: number): void => {
    const e = equity();
    observe(e);
    if (ddPct !== null && peak > 0 && (peak - e) / peak >= ddPct) {
      closeAll('drawdown-stop', ev, lBefore, lAfter);
      halted = true;
      haltReason = 'drawdownStop';
      stoppedAt = ev.time;
      risk.drawdownStop++;
      return;
    }
    if (openCount > 0 && e <= fGross * mmr) {
      closeAll('liquidation', ev, lBefore, lAfter);
      if (equity() < 0) {
        // A follower cannot lose more than the copy account: the venue's
        // insurance fund / ADL absorbs the rest.
        liquidationShortfall += -equity();
        cash -= equity();
      }
      halted = true;
      haltReason = 'liquidation';
      stoppedAt = ev.time;
      risk.liquidation++;
    }
  };

  /** Size of a fresh follower position mirroring leader position `L` (signed base units). */
  const openTarget = (m: Mkt, L: number, t: number): number | SkipReason => {
    if (mode === 'fixedNotional') return (mult * sgn(L) * fixedUsd) / m.mark;
    if (mode === 'fixedRatio') return mult * ratio * L;
    // proportional (default for unknown modes)
    const eL = leaderEq.at(t);
    if (eL === null || !(eL > 0)) return 'no-leader-equity';
    const eF = equity();
    if (!(eF > 0)) return 'no-equity';
    return (mult * L * eF) / eL;
  };

  /** Grow the follower towards |D| (same side as D; follower is flat or on D's side). */
  const grow = (m: Mkt, D: number, acc: Acc): { skip: SkipReason } | { clamp: ClampReason | null } => {
    const p = m.mark;
    const cur = Math.abs(m.fLots) * m.lot;
    let want = Math.abs(D) - cur;
    if (!(want > 0)) return { skip: 'at-target' };
    let clamp: ClampReason | null = null;
    const roomPos = maxPosUsd / p - cur;
    if (want > roomPos) {
      want = roomPos;
      clamp = 'max-position';
    }
    const e = equity();
    if (!(e > 0)) return { skip: 'no-equity' };
    const roomLev = (maxLev * e - fGross) / p;
    if (want > roomLev) {
      want = roomLev;
      clamp = 'max-leverage';
    }
    if (!(want > 0)) return { skip: clamp ?? 'at-target' };
    const lots = Math.floor(want / m.lot + LOT_EPS);
    if (lots <= 0 || lots * m.lot * p < m.minNotional) return { skip: clamp ?? 'min-notional' };
    exec(m, sgn(D) * lots, p, acc);
    return { clamp };
  };

  const followerAction = (before: number, after: number, kind: SimAction): SimAction => {
    if (kind === 'join' && after !== 0) return 'join';
    if (before === 0) return 'open';
    if (after === 0) return 'close';
    if (sgn(before) !== sgn(after)) return 'flip';
    return Math.abs(after) > Math.abs(before) ? 'increase' : 'decrease';
  };

  /* ---- replay ---- */
  for (const ev of events) {
    if (!started && !ev.bad && ev.time >= startAt) {
      started = true;
      from = fin(opts.startAt) ? opts.startAt : ev.time;
      baseline = lCash + lSum;
      const base = leaderEq.at(from);
      leaderBase = base !== null && base > 0 ? base : 0;
      record(from);
    }

    if (ev.bad) {
      // Logged as skipped wherever they fall (never warm-up), state untouched.
      if (ev.bad === 'duplicate') duplicates += ev.count;
      else invalid += ev.count;
      skip(ev, null, ev.bad, null, null);
      continue;
    }

    const m = getMkt(ev.fill);
    // 1. Mark to market at this fill's price.
    if (m.mark !== ev.price) {
      m.mark = ev.price;
      setLVal(m);
      setFVal(m);
    }
    // 2. Leader position: trust the venue's position-before when it has one.
    let lBefore = m.lPos;
    if (ev.startPosition !== null && !near(ev.startPosition, lBefore)) {
      lCash -= (ev.startPosition - lBefore) * ev.price;
      m.lPos = ev.startPosition;
      setLVal(m);
      lBefore = ev.startPosition;
    }
    let lAfter = lBefore + ev.signed;
    if (Math.abs(lAfter) <= 1e-9 * Math.max(Math.abs(lBefore), Math.abs(ev.signed))) lAfter = 0;
    const f = ev.fill;
    const leaderFee =
      f.fee !== null && fin(f.fee) && (f.feeAsset === null || /^v?USD/i.test(f.feeAsset))
        ? f.fee
        : Math.abs(ev.signed) * ev.price * m.takerRate;
    lCash -= ev.signed * ev.price + leaderFee;
    m.lPos = lAfter;
    setLVal(m);

    if (!started) {
      warmup += ev.count;
      continue;
    }
    inWindowValid += ev.count;
    if (ev.startPosition === null) missingStart += ev.count;
    if (ev.time > to) to = ev.time;
    const firstSight = !m.lSeen;
    m.lSeen = true;

    if (halted) {
      skip(ev, m, 'halted', lBefore, lAfter);
      record(ev.time);
      continue;
    }

    // 3. Guards react to the new mark before anything is copied.
    positionGuards(m, ev, lBefore, lAfter);
    accountGuards(ev, lBefore, lAfter);
    if (halted) {
      skip(ev, m, 'halted', lBefore, lAfter);
      record(ev.time);
      continue;
    }

    // 4. Positions that predate the copy.
    let join = false;
    if (firstSight && lBefore !== 0) {
      if (config.copyExisting) join = true;
      else m.detached = 'pre-existing';
    }

    // 5. Asset filters.
    if (m.filtered) {
      skip(ev, m, m.filtered, lBefore, lAfter);
      record(ev.time);
      continue;
    }

    // 6. Detached markets wait until the leader is flat (or flips to a fresh position).
    //    From here on the copy reads cB / cA: the leader's position, mirrored for a counter-trade.
    const cB = mirror * lBefore;
    const cA = mirror * lAfter;
    let kind: SimAction;
    if (m.detached) {
      const reason: SkipReason =
        m.detached === 'pre-existing' ? 'pre-existing-position' : m.detached === 'stop-loss' ? 'after-stop-loss' : 'after-take-profit';
      const flips = cA !== 0 && sgn(cA) !== sgn(cB);
      if (cA === 0 || flips) m.detached = null;
      if (!flips) {
        skip(ev, m, reason, lBefore, lAfter);
        record(ev.time);
        continue;
      }
      kind = 'open';
    } else if (join) kind = cA === 0 ? 'close' : 'join';
    else if (cB === 0) kind = 'open';
    else if (cA === 0) kind = 'close';
    else if (sgn(cA) !== sgn(cB)) kind = 'flip';
    else kind = Math.abs(cA) > Math.abs(cB) ? 'increase' : 'decrease';

    // 7. Desired follower position D (signed base units).
    const F = m.fLots * m.lot;
    let D: number;
    let note: string | null = null;
    if (kind === 'close' || kind === 'decrease') {
      if (F === 0) {
        skip(ev, m, 'no-follower-position', lBefore, lAfter);
        record(ev.time);
        continue;
      }
      D = kind === 'close' || sgn(F) !== sgn(cB) ? 0 : (F * Math.abs(cA)) / Math.abs(cB);
    } else {
      const target =
        kind === 'increase' && mode === 'fixedNotional' && F !== 0 && sgn(F) === sgn(cA)
          ? (F * Math.abs(cA)) / Math.abs(cB)
          : openTarget(m, cA, ev.time);
      if (typeof target === 'string') {
        if (F !== 0 && sgn(F) !== sgn(cA)) {
          D = 0; // still close the old side of a flip
          note = `open leg skipped: ${target}`;
        } else {
          skip(ev, m, target, lBefore, lAfter);
          record(ev.time);
          continue;
        }
      } else D = target;
    }

    // 8. Execute: reduce-only legs first, then grow under caps.
    const acc = newAcc();
    const before = F;
    let clamp: ClampReason | null = null;
    let reason: SkipReason | null = null;
    if (kind === 'close' || kind === 'decrease') {
      if (D === 0) exec(m, -m.fLots, m.mark, acc);
      else {
        const lots = Math.floor((Math.abs(F) - Math.abs(D)) / m.lot + LOT_EPS);
        if (lots <= 0) reason = 'lot-size';
        else exec(m, -sgn(F) * lots, m.mark, acc);
      }
    } else {
      if (F !== 0 && (D === 0 || sgn(F) !== sgn(D))) exec(m, -m.fLots, m.mark, acc);
      if (D !== 0 && Number.isFinite(D)) {
        const r = grow(m, D, acc);
        if ('skip' in r) {
          if (acc.qty > 0) note = `open leg skipped: ${r.skip}`;
          else reason = r.skip;
        } else clamp = r.clamp;
      } else if (acc.qty === 0) reason = 'min-notional'; // a zero target: nothing to trade
    }

    if (acc.qty === 0) {
      skip(ev, m, reason ?? 'at-target', lBefore, lAfter);
    } else {
      copied += ev.count;
      if (clamp) {
        clampedFills += ev.count;
        inc(clampedBy, clamp, ev.count);
      }
      const after = m.fLots * m.lot;
      pushEntry(ev, m, followerAction(before, after, kind), acc, { clamp, note, lBefore, lAfter });
    }
    record(ev.time);
  }

  if (!started) {
    // Nothing reached the window: a flat, empty run.
    from = fin(opts.startAt) ? opts.startAt : from;
    to = from;
  }

  /* ---- result ---- */
  const endEquity = equity();
  const pnl = endEquity - startEquity;
  const keep = downsampleIndices(cT, cF, cL, maxCurve);
  const equityCurve: EquityPoint[] = keep.map((i) => ({ t: cT[i]!, accountValue: cF[i]!, pnl: cF[i]! - startEquity }));
  const leaderCurve: EquityPoint[] = keep.map((i) => ({ t: cT[i]!, accountValue: cL[i]!, pnl: cL[i]! - startEquity }));
  const lastLeader = cL.length ? cL[cL.length - 1]! : startEquity;

  const openPositions: SimOpenPosition[] = [];
  let unrealized = 0;
  for (const m of markets.values()) {
    if (m.fLots === 0) continue;
    const size = m.fLots * m.lot;
    const upnl = size * (m.mark - m.fEntry);
    unrealized += upnl;
    openPositions.push({
      venue: m.venue,
      symbol: m.symbol,
      coin: m.coin,
      size,
      entryPrice: m.fEntry,
      markPrice: m.mark,
      notionalUsd: Math.abs(size * m.mark),
      unrealizedPnl: upnl,
    });
  }

  const notes: string[] = [];
  if (mode === 'proportional' && leaderEq.source === 'estimated')
    notes.push(
      "Leader equity was not provided, so proportional sizing assumed the leader's peak exposure equalled their equity (1x). Supply leader equity for accurate sizes.",
    );
  if (missingStart > 0)
    notes.push(
      `${missingStart} of ${inWindowValid} fills carry no position-before, so the leader's positions were rebuilt from fills alone; positions opened before the first fill are invisible.`,
    );
  if (duplicates > 0) notes.push(`${duplicates} duplicate fills were ignored.`);
  if (invalid > 0) notes.push(`${invalid} fills had no usable price, size or side and were ignored.`);
  if (haltReason === 'liquidation')
    notes.push(
      `The copy account was liquidated (maintenance margin ${(mmr * 100).toFixed(2)}% of notional)${
        liquidationShortfall > 0 ? '; losses beyond the account were absorbed by the venue' : ''
      }.`,
    );

  return {
    leader: opts.leader ?? null,
    config,
    from,
    to,
    startEquity,
    endEquity,
    pnl,
    roi: startEquity > 0 ? pnl / startEquity : 0,
    maxDrawdown: maxDd,
    copiedFills: copied,
    skippedFills: skipped,
    skippedByReason: skippedBy,
    feesUsd,
    slippageUsd: slipUsd,
    equityCurve,
    fills: log,
    stoppedBy: haltReason ? 'drawdownStop' : null,
    stoppedAt,
    leaderCurve,
    leaderRoi: startEquity > 0 ? lastLeader / startEquity - 1 : 0,
    leaderMaxDrawdown: lMaxDd,
    leaderEquitySource: leaderEq.source,
    leaderEquityBase: leaderBase,
    builderFeesUsd: builderUsd,
    realizedPnl: realizedUsd,
    unrealizedPnl: unrealized,
    volumeUsd,
    clampedFills,
    clampedByReason: clampedBy,
    riskEvents: risk,
    haltReason,
    openPositions,
    warmupFills: warmup,
    notes,
    engineVersion: ENGINE_VERSION,
  };
}

/** Type guard: does a value carry this engine's result fields? */
export function isSimResult(r: unknown): r is SimResult {
  return !!r && typeof (r as Partial<SimResult>).engineVersion === 'number' && Array.isArray((r as Partial<SimResult>).leaderCurve);
}

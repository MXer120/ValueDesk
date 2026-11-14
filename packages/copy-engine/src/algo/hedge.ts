/**
 * The hedge bot's arithmetic (owner 2026-11-14: "a hedging bot for OI on perps. Needs to manage margining,
 * liquidations .. even at max leverage. Needs to work on perps hedged with spot or 2 sodex accounts").
 *
 * Two shapes:
 *   pair  one perp leg in each of two SoDEX accounts (two wallets), equal size, opposite sides. Every price move makes
 *         one account richer and the other poorer, and SoDEX cannot move margin between two wallets (TransferAsset has
 *         no route between accounts: docs.sodex.com, Trading API, "Internal transfer between perps chains is not
 *         supported yet"). So the poorer leg is kept away from its liquidation by making BOTH legs smaller, and both
 *         grow back when there is room again.
 *   spot  a perp short in one account, hedged by the same coin held in that account's futures balance, where SoDEX
 *         counts it as margin at its collateral ratio (BTC 90%: docs.sodex.com, Multi-Asset Margin). A rise costs the
 *         short what it adds to the coin, so the account barely moves and its liquidation is far away. The short is
 *         kept equal to the coin.
 *
 * SoDEX's liquidation (docs.sodex.com, Margining / Margin Tiers): a cross account is liquidated when its equity falls
 * below the maintenance margin, notional x maintenance rate (half the initial rate at the tier's max leverage) minus
 * the tier's deduction. With one position of q at price P in an account of equity E and maintenance rate m:
 *   long  liquidation at P' = (qP - E) / (q(1 - m)),  distance d = (E/(qP) - m) / (1 - m)
 *   short liquidation at P' = (E + qP) / (q(1 + m)),  distance d = (E/(qP) - m) / (1 + m)
 * so the most it may hold with the liquidation at least d away is q = E / (P (m + d(1 -/+ m))).
 *
 * Every function here is pure: the runtime reads the accounts and sends what `hedgePlan` returns.
 */
import type { Side } from './types.ts';

/** One leg's account as SoDEX reports it. */
export interface HedgeLeg {
  /** Signed position on the hedged market (+ long). */
  qty: number;
  /** The account's equity (cross account value, collateral at its ratio), USD. */
  equity: number;
  /** The account's maintenance margin for everything it holds, USD (null: not reported; then only this leg counts). */
  maintenance: number | null;
  /** SoDEX's liquidation price for this position (null or 0: none reported). */
  liq: number | null;
}

export interface HedgeCfg {
  /** The size each leg works towards, base units (the OI it aims for per leg). */
  targetQty: number;
  /** Never let a leg's liquidation come closer than this share of the price (0.03 = 3%). Below it both legs shrink. */
  minLiq: number;
  /** Grow back only while every leg would keep its liquidation at least this far (> minLiq: the gap stops flapping). */
  growLiq: number;
  /** Each growth step, base units (per leg). */
  sliceQty: number;
  /** A difference between the legs smaller than this is not traded (SoDEX's minimum order, base units). */
  tolQty: number;
  /** The market's maintenance rate (first tier) as a fraction (BTC 40x: 0.0125). */
  mmr: number;
}

/** One order the plan wants: a taker (IOC) on one leg. */
export interface HedgeMove {
  leg: 0 | 1;
  side: Side;
  qty: number;
  /** Shrinks the leg's position only. */
  reduceOnly: boolean;
  why: 'trim' | 'balance' | 'grow' | 'close';
}

/** The hedge's direction per leg: leg 0 takes `side`, leg 1 the other. +1 long, -1 short. */
export function legSigns(side: Side): [1 | -1, 1 | -1] {
  return side === 'buy' ? [1, -1] : [-1, 1];
}

/** How far the liquidation is, as a share of the price (Infinity: none; null: unknown). Prefers SoDEX's own price. */
export function liqDistance(leg: HedgeLeg, mark: number, mmr: number): number | null {
  if (!(mark > 0) || leg.qty === 0) return Infinity;
  if (leg.liq !== null && leg.liq > 0) {
    const d = leg.qty > 0 ? (mark - leg.liq) / mark : (leg.liq - mark) / mark;
    return Math.max(0, d);
  }
  if (leg.liq === 0) return Infinity;
  const e = equityFor(leg, mark, mmr);
  const n = Math.abs(leg.qty) * mark;
  if (!(n > 0)) return Infinity;
  const d = (e / n - mmr) / (leg.qty > 0 ? 1 - mmr : 1 + mmr);
  return Number.isFinite(d) ? Math.max(0, d) : null;
}

/**
 * The equity that backs this leg: the account's, less the maintenance the rest of the account needs (another position
 * in the same account eats margin the hedge cannot count on).
 */
export function equityFor(leg: HedgeLeg, mark: number, mmr: number): number {
  const own = Math.abs(leg.qty) * mark * mmr;
  const other = leg.maintenance !== null ? Math.max(0, leg.maintenance - own) : 0;
  return Math.max(0, leg.equity - other);
}

/** The most this account may hold on `sign`'s side with its liquidation at least `d` away, base units. */
export function maxQtyAt(equity: number, mark: number, mmr: number, d: number, sign: 1 | -1): number {
  if (!(equity > 0) || !(mark > 0)) return 0;
  const k = mmr + d * (sign > 0 ? 1 - mmr : 1 + mmr);
  return k > 0 ? equity / (mark * k) : 0;
}

/**
 * The orders that keep a pair hedged and alive, for one step. In order of urgency:
 *   1. trim     a leg's liquidation is closer than minLiq (or a leg holds more than the target): both legs shrink to
 *               where every liquidation is half-way between minLiq and growLiq;
 *   2. balance  the legs differ by more than tolQty (one filled more, or SoDEX liquidated part of one): the smaller one
 *               is brought up to the bigger where it has the room, else the bigger one down to the smaller;
 *   3. grow     both legs are equal and below what the accounts allow at growLiq: one slice more on each.
 * A leg on the wrong side (a position that is not the hedge's) is never traded: `wrong` says so and nothing is planned.
 */
export function hedgePlan(legs: readonly [HedgeLeg, HedgeLeg], mark: number, side: Side, cfg: HedgeCfg): { moves: HedgeMove[]; wrong: 0 | 1 | null; room: number } {
  const signs = legSigns(side);
  const held = legs.map((l, i) => l.qty * signs[i]!) as [number, number];
  const wrongLeg = held[0] < -cfg.tolQty ? 0 : held[1] < -cfg.tolQty ? 1 : null;
  if (wrongLeg !== null) return { moves: [], wrong: wrongLeg, room: 0 };
  const q = held.map((h) => Math.max(0, h)) as [number, number];
  const cap = (d: number, i: 0 | 1) => maxQtyAt(equityFor(legs[i], mark, cfg.mmr), mark, cfg.mmr, d, signs[i]);
  const mid = (cfg.minLiq + cfg.growLiq) / 2;
  const keep = Math.min(cfg.targetQty, cap(cfg.minLiq, 0), cap(cfg.minLiq, 1));
  const trimTo = Math.min(cfg.targetQty, cap(mid, 0), cap(mid, 1));
  const growTo = Math.min(cfg.targetQty, cap(cfg.growLiq, 0), cap(cfg.growLiq, 1));
  const toward = (i: 0 | 1, sign: 1 | -1): Side => (signs[i] * sign > 0 ? 'buy' : 'sell');
  const moves: HedgeMove[] = [];

  // 1. Too close to a liquidation, or more than asked for.
  const near = ([0, 1] as const).some((i) => {
    const d = liqDistance(legs[i], mark, cfg.mmr);
    return d !== null && q[i] > cfg.tolQty && d < cfg.minLiq;
  });
  if (near || Math.max(q[0], q[1]) > keep + cfg.tolQty) {
    const to = Math.max(0, Math.min(trimTo, q[0], q[1]));
    for (const i of [0, 1] as const) {
      const cut = q[i] - to;
      if (cut > cfg.tolQty) moves.push({ leg: i, side: toward(i, -1), qty: cut, reduceOnly: true, why: 'trim' });
    }
    return { moves, wrong: null, room: to };
  }

  // 2. Unequal legs.
  if (Math.abs(q[0] - q[1]) > cfg.tolQty) {
    const small: 0 | 1 = q[0] < q[1] ? 0 : 1;
    const big: 0 | 1 = small === 0 ? 1 : 0;
    const up = Math.min(q[big], cap(mid, small), cfg.targetQty);
    if (up - q[small] > cfg.tolQty) moves.push({ leg: small, side: toward(small, 1), qty: up - q[small], reduceOnly: false, why: 'balance' });
    const level = Math.max(q[small], up);
    if (q[big] - level > cfg.tolQty) moves.push({ leg: big, side: toward(big, -1), qty: q[big] - level, reduceOnly: true, why: 'balance' });
    return { moves, wrong: null, room: growTo };
  }

  // 3. Room to grow.
  const now = Math.min(q[0], q[1]);
  const more = Math.min(cfg.sliceQty, growTo - now);
  if (more > cfg.tolQty) {
    for (const i of [0, 1] as const) moves.push({ leg: i, side: toward(i, 1), qty: more, reduceOnly: false, why: 'grow' });
  }
  return { moves, wrong: null, room: growTo };
}

/** Closing a pair: both legs down by one slice at a time, the bigger first to even out. */
export function hedgeClose(legs: readonly [HedgeLeg, HedgeLeg], side: Side, sliceQty: number, tolQty: number): HedgeMove[] {
  const signs = legSigns(side);
  const q = legs.map((l, i) => Math.max(0, l.qty * signs[i]!)) as [number, number];
  const moves: HedgeMove[] = [];
  const low = Math.max(0, Math.min(q[0], q[1]) - sliceQty);
  for (const i of [0, 1] as const) {
    const cut = q[i] - low;
    if (cut > tolQty || (q[i] > 0 && low === 0)) moves.push({ leg: i, side: signs[i] > 0 ? 'sell' : 'buy', qty: cut, reduceOnly: true, why: 'close' });
  }
  return moves;
}

/**
 * The spot shape: the short's target is the coin the futures account holds (capped by the target size), and it may
 * never be short more than that coin. Returns the order that brings the short there, or null.
 */
export function spotHedgeMove(short: number, coinHeld: number, cfg: Pick<HedgeCfg, 'targetQty' | 'sliceQty' | 'tolQty'>, leg: HedgeLeg, mark: number, mmr: number, minLiq: number): HedgeMove | null {
  const held = Math.max(0, -short);
  const want = Math.max(0, Math.min(cfg.targetQty, coinHeld));
  const d = liqDistance(leg, mark, mmr);
  if (held > want + cfg.tolQty) return { leg: 0, side: 'buy', qty: held - want, reduceOnly: true, why: held > coinHeld + cfg.tolQty ? 'balance' : 'trim' };
  if (d !== null && held > cfg.tolQty && d < minLiq) return { leg: 0, side: 'buy', qty: Math.min(held, cfg.sliceQty), reduceOnly: true, why: 'trim' };
  const more = Math.min(cfg.sliceQty, want - held);
  if (more > cfg.tolQty) return { leg: 0, side: 'sell', qty: more, reduceOnly: false, why: held > 0 ? 'grow' : 'grow' };
  return null;
}

/** The maintenance rate of a market's first tier, from SoDEX's tiers or its max leverage (half the initial rate). */
export function firstMmr(tiers: ReadonlyArray<{ maintenanceMarginRate?: number | string }> | null | undefined, maxLeverage: number | null): number {
  const t = tiers?.[0]?.maintenanceMarginRate;
  const n = Number(t);
  if (Number.isFinite(n) && n > 0) return n;
  return maxLeverage && maxLeverage > 0 ? 1 / maxLeverage / 2 : 0.025;
}

/**
 * Pre-trade risk math: liquidation price, and whether a stop-loss can actually
 * protect the position.
 *
 * WHY THIS IS AN ESTIMATE, AND WHY THAT IS STATED IN THE UI
 * --------------------------------------------------------
 * The exchange liquidates against the full account state at the moment of the
 * liquidation check: every open position's margin, accrued funding, unrealised
 * PnL on other symbols, and the mark price its own oracle publishes. A client
 * cannot reproduce that exactly. What we can do faithfully is compute the
 * standard tiered-margin liquidation price for THIS position in isolation,
 * which is the number that matters when sizing a trade and placing a stop.
 *
 * Every value produced here is therefore labelled `estimated` and must be
 * surfaced as such. It is a guardrail, not an oracle - it is meant to catch the
 * unambiguous mistakes (a stop placed past liquidation, a stop so close to
 * liquidation that ordinary wick noise closes the position at the exchange's
 * price instead of yours), not to promise an exact trigger point.
 *
 * MAINTENANCE MARGIN MODEL
 * ------------------------
 * The gateway publishes `marginTiers` per symbol, e.g. for BTC-USD:
 *   [ { maxNotionalValue: "4000000",   maintenanceMarginRate: "0.0125", maintenanceDeduction: "0"     },
 *     { maxNotionalValue: "100000000", maintenanceMarginRate: "0.02",   maintenanceDeduction: "30000" } ]
 *
 * Maintenance margin is piecewise-linear in notional:
 *   MM(notional) = notional * mmr(tier) - deduction(tier)
 *
 * `maintenanceDeduction` exists purely to keep MM continuous where tiers meet.
 * Verified against the real published numbers at the 4,000,000 boundary:
 *   tier 1: 4_000_000 * 0.0125 - 0      = 50_000
 *   tier 2: 4_000_000 * 0.02    - 30_000 = 50_000   (continuous)
 * `assertTierContinuity` below re-checks this against whatever the gateway
 * actually returns, so a future schedule change is caught rather than silently
 * producing wrong liquidation prices.
 *
 * LIQUIDATION PRICE DERIVATION
 * ----------------------------
 * Liquidation is the price at which equity backing the position falls to the
 * maintenance requirement:
 *
 *   margin + unrealisedPnL = MM(notional)
 *
 * LONG, with unrealisedPnL = (P - entry) * qty:
 *   margin + (P - entry)*qty = P*qty*mmr - deduction
 *   margin - entry*qty + deduction = P*qty*mmr - P*qty
 *   margin - entry*qty + deduction = P*qty*(mmr - 1)
 *   => P = (entry*qty - margin - deduction) / (qty * (1 - mmr))
 *
 * SHORT, with unrealisedPnL = (entry - P) * qty:
 *   margin + (entry - P)*qty = P*qty*mmr - deduction
 *   margin + entry*qty + deduction = P*qty*mmr + P*qty
 *   margin + entry*qty + deduction = P*qty*(1 + mmr)
 *   => P = (entry*qty + margin + deduction) / (qty * (1 + mmr))
 *
 * Tier selection uses the position's entry notional, which is the convention
 * used by tiered-margin venues generally. It is an approximation at the margins
 * (notional at liquidation differs from notional at entry); it does not change
 * the tier except for positions sitting almost exactly on a boundary.
 */
import type { MarginTier, Symbol } from './api';
import { num } from './format';

export type Side = 'buy' | 'sell';
export type MarginMode = 'cross' | 'isolated';

/**
 * "Close" is a fraction of the cushion between entry and liquidation, not of
 * the price. A fixed percent of price is a few dollars on one market and the
 * entire position on another, and it ignores leverage: at 50x the room down
 * to liquidation is already small, so the same raw gap that is noise at 3x
 * is most of the protection. What is left is `gap / |entry - liq|`. Under
 * this share of that cushion, a normal wick can reach the exchange first.
 * 6% (owner, 2026-10-26: 20% flagged a BTC stop $250 off liquidation at 40x,
 * where the whole cushion is ~$1,600): about $100 there, ~$1,500 at 3x.
 */
export const STOP_CUSHION_WARN = 0.06;

export interface LiquidationInput {
  entryPrice: number;
  quantity: number;
  side: Side;
  leverage: number;
  sym?: Symbol;
  marginMode?: MarginMode;
  /**
   * Free collateral beyond this position's own initial margin. Under cross
   * margin the rest of the account absorbs losses first, pushing liquidation
   * further away. Omit (or 0) for isolated.
   */
  extraCollateral?: number;
  /**
   * An isolated position's margin as SoDEX holds it (the positions endpoint's
   * `initialMargin`, the state's `iw`): what was added or removed included, and
   * what fees and funding took. Given, it is the margin - and the price is
   * SoDEX's own `lp` (checked against 32 isolated positions, 2026-10-31: equal
   * in all 32; from entry, size and leverage alone 3 of them were 1-3 bp off).
   */
  isolatedMargin?: number;
}

/** Resolve the tier whose band contains `notional`; falls back to the last tier. */
export function tierFor(tiers: MarginTier[] | undefined, notional: number): MarginTier | null {
  if (!tiers?.length) return null;
  for (const t of tiers) {
    if (notional <= num(t.maxNotionalValue)) return t;
  }
  return tiers[tiers.length - 1] ?? null;
}

/** Maintenance margin required for a given notional under the published schedule. */
export function maintenanceMargin(tiers: MarginTier[] | undefined, notional: number): number | null {
  const tier = tierFor(tiers, notional);
  if (!tier) return null;
  return Math.max(0, notional * num(tier.maintenanceMarginRate) - num(tier.maintenanceDeduction));
}

/**
 * Dev-time guard: the deduction constants must make MM continuous across tier
 * boundaries. If the gateway ever publishes a schedule where they do not, our
 * liquidation prices would be quietly wrong, so surface it loudly instead.
 * Returns the boundaries that failed, empty when the schedule is sane.
 */
export function assertTierContinuity(tiers: MarginTier[] | undefined, tolerance = 1e-6): string[] {
  if (!tiers || tiers.length < 2) return [];
  const bad: string[] = [];
  for (let i = 0; i < tiers.length - 1; i++) {
    const boundary = num(tiers[i]!.maxNotionalValue);
    if (!Number.isFinite(boundary) || boundary <= 0) continue;
    const below = boundary * num(tiers[i]!.maintenanceMarginRate) - num(tiers[i]!.maintenanceDeduction);
    const above = boundary * num(tiers[i + 1]!.maintenanceMarginRate) - num(tiers[i + 1]!.maintenanceDeduction);
    if (Math.abs(below - above) > Math.max(tolerance, Math.abs(below) * 1e-9)) {
      bad.push(`notional ${boundary}: ${below} vs ${above}`);
    }
  }
  return bad;
}

export interface LiquidationEstimate {
  /** Null when the inputs or the symbol's margin schedule are insufficient. */
  price: number | null;
  /** Distance from entry as a fraction (0.08 = 8% away). */
  distancePct: number | null;
  maintenanceMarginRate: number | null;
  initialMargin: number | null;
  /** Always true - retained so call sites cannot forget this is not authoritative. */
  estimated: true;
}

export function estimateLiquidationPrice(input: LiquidationInput): LiquidationEstimate {
  const { entryPrice, quantity, side, leverage, sym, extraCollateral = 0, isolatedMargin } = input;
  const empty: LiquidationEstimate = {
    price: null, distancePct: null, maintenanceMarginRate: null, initialMargin: null, estimated: true,
  };

  if (!(entryPrice > 0) || !(quantity > 0) || !(leverage > 0)) return empty;

  const notional = entryPrice * quantity;
  const tier = tierFor(sym?.marginTiers, notional);
  // Without a published schedule we decline rather than guess a rate - a made-up
  // maintenance rate would produce a confident-looking but fictional price.
  if (!tier) return empty;

  const mmr = num(tier.maintenanceMarginRate);
  const deduction = num(tier.maintenanceDeduction);
  const initialMargin = notional / leverage;
  const margin = isolatedMargin !== undefined && isolatedMargin > 0 ? isolatedMargin : initialMargin + Math.max(0, extraCollateral);

  const price =
    side === 'buy'
      ? (entryPrice * quantity - margin - deduction) / (quantity * (1 - mmr))
      : (entryPrice * quantity + margin + deduction) / (quantity * (1 + mmr));

  // A long liquidating at or below zero means the position cannot be liquidated
  // by price alone at this leverage; report null rather than a nonsense number.
  if (!Number.isFinite(price) || price <= 0) {
    return { ...empty, maintenanceMarginRate: mmr, initialMargin };
  }

  return {
    price,
    distancePct: Math.abs(price - entryPrice) / entryPrice,
    maintenanceMarginRate: mmr,
    initialMargin,
    estimated: true,
  };
}

/**
 * An OPEN position's liquidation price: SoDEX's own where its account state has one, else the estimate.
 *
 * The perps state (`/accounts/<address>/state`, and its stream) lists each position in `P` with `lp`, SoDEX's
 * liquidation price. Checked 2026-11-26 on a cross account with 15 positions (0x1978…fe04): solving SoDEX's cross
 * rule (account value = maintenance margin, one position's price moving) from that account's own `av` and the
 * published tiers lands 0.1-1.4 % from `lp` on all 6 shorts (AAPL: lp 1,034.68, solved 1,029.02), and every long
 * there has `lp` 0 (the account covers it at any price). Isolated: `lp` equals the estimate from the position's own
 * margin (32 of 32, 2026-10-31). The estimate alone cannot see a cross account's other collateral: for that AAPL
 * short (10x, entry 331.56) it said 346.91, below the mark of 355 - a price already passed.
 *
 *   `venueLp` undefined: the state was not read, or does not list this position yet -> the estimate, marked so.
 *   `venueLp` > 0: SoDEX's price.
 *   `venueLp` 0: SoDEX gives this position no liquidation price -> none.
 */
export interface PositionLiquidation {
  price: number | null;
  source: 'venue' | 'estimate' | 'none';
}

export function positionLiquidation(venueLp: number | undefined, estimate: () => number | null): PositionLiquidation {
  if (venueLp === undefined || !Number.isFinite(venueLp) || venueLp < 0) return { price: estimate(), source: 'estimate' };
  if (venueLp === 0) return { price: null, source: 'none' };
  return { price: venueLp, source: 'venue' };
}

/** `lp` of every position in a perps state payload (`{state: {P}}` as api.state returns it), by position id. */
export function venueLiqById(statePayload: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const P = (statePayload as { state?: { P?: unknown } } | null | undefined)?.state?.P;
  for (const p of Array.isArray(P) ? (P as Array<Record<string, unknown>>) : []) {
    const id = p?.i ?? p?.id;
    const lp = typeof p?.lp === 'number' ? p.lp : typeof p?.lp === 'string' && p.lp.trim() !== '' ? Number(p.lp) : NaN;
    if ((typeof id === 'number' || typeof id === 'string') && Number.isFinite(lp)) out.set(String(id), lp);
  }
  return out;
}

export type StopVerdict = 'ok' | 'beyond-liquidation' | 'at-liquidation' | 'near-liquidation' | 'wrong-side';

export interface StopCheck {
  verdict: StopVerdict;
  liquidationPrice: number | null;
  /** Gap between stop and liquidation, as a fraction of entry price. */
  gapPct: number | null;
  message: string | null;
  severity: 'error' | 'warn' | null;
}

/**
 * Decide whether a stop-loss actually protects the position.
 *
 * Three genuine failure modes, in severity order:
 *  - `wrong-side`:          the stop is on the profitable side of entry, so it is
 *                           not a stop at all and would fire immediately.
 *  - `beyond-liquidation`:  price reaches liquidation before the stop, so the
 *                           exchange closes the position first and the stop never
 *                           protects anything.
 *  - `at-liquidation`:      the stop and the estimate are the same price. The
 *                           exchange can liquidate on the same print. A stop even a
 *                           tick on the safe side is not this (owner, 2026-10-26).
 *  - `near-liquidation`:    the stop is on the safe side, but less than
 *                           STOP_CUSHION_WARN of the entry-to-liquidation room
 *                           is left. That fraction scales with leverage; a raw
 *                           price gap or a percent of the coin price does not.
 */
export function checkStopAgainstLiquidation(
  stopPrice: number,
  input: LiquidationInput,
): StopCheck {
  const liq = estimateLiquidationPrice(input);
  const none: StopCheck = { verdict: 'ok', liquidationPrice: liq.price, gapPct: null, message: null, severity: null };

  if (!(stopPrice > 0) || liq.price === null) return none;
  const { entryPrice, side } = input;
  const isLong = side === 'buy';

  // A stop must sit on the losing side of entry.
  if ((isLong && stopPrice >= entryPrice) || (!isLong && stopPrice <= entryPrice)) {
    return {
      verdict: 'wrong-side',
      liquidationPrice: liq.price,
      gapPct: null,
      severity: 'error',
      message: isLong
        ? 'Stop loss is at or above entry — it would trigger immediately.'
        : 'Stop loss is at or below entry — it would trigger immediately.',
    };
  }

  // The same price, not "within a tick": a long stop $1 over the estimate is on the safe side.
  const samePrice = Math.abs(stopPrice - liq.price) <= entryPrice * 1e-9;
  const gap = Math.abs(stopPrice - liq.price);
  const room = Math.abs(entryPrice - liq.price);
  const gapPct = room > 0 ? gap / entryPrice : null;
  const cushionLeft = room > 0 ? gap / room : null;

  // On the liquidation price itself, before the "past it" case. A long stop
  // one tick under the estimate is already beyond; equal is this one.
  if (samePrice) {
    return {
      verdict: 'at-liquidation',
      liquidationPrice: liq.price,
      gapPct,
      severity: 'warn',
      message: 'Stop loss is on the estimated liquidation price — the exchange can liquidate on the same print the stop would use.',
    };
  }

  // Beyond liquidation: long stop below liq, short stop above liq.
  const beyond = isLong ? stopPrice < liq.price : stopPrice > liq.price;
  if (beyond) {
    return {
      verdict: 'beyond-liquidation',
      liquidationPrice: liq.price,
      gapPct,
      severity: 'warn',
      message: 'Stop loss is past estimated liquidation — the exchange closes the position before this stop can.',
    };
  }

  if (cushionLeft !== null && cushionLeft < STOP_CUSHION_WARN) {
    const left = Math.max(0, Math.round(cushionLeft * 100));
    return {
      verdict: 'near-liquidation',
      liquidationPrice: liq.price,
      gapPct,
      severity: 'warn',
      message: `Stop loss is close to estimated liquidation — ${left}% of the room between entry and liquidation is left, so a normal wick can reach the exchange first.`,
    };
  }

  return { ...none, gapPct };
}

/** PnL if price reaches `target` from `entryPrice`, ignoring fees and funding. */
export function pnlAt(entryPrice: number, target: number, quantity: number, side: Side): number {
  if (!(entryPrice > 0) || !(quantity > 0) || !(target > 0)) return 0;
  return side === 'buy' ? (target - entryPrice) * quantity : (entryPrice - target) * quantity;
}

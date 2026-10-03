/**
 * The Valuescan builder fee, as numbers and decisions - pure, no network, no
 * wallet (builderApproval.ts talks to SoDEX; session.ts runs the flow).
 *
 * A "builder" is a SoDEX trading account that receives a fee on the fills of
 * orders that name it. The user approves a MAXIMUM for that account once, with
 * their wallet; each order then carries `{id, fee}` and SoDEX charges `fee` on
 * its fills, on top of its own commission. docs/BUILDER-CODES.md has the whole
 * picture; the spec is
 * https://sodex.com/documentation/for-developers/developers/trading/builder-codes-in-trading
 *
 * THE ONE RULE EVERYTHING HERE SERVES: an order names the builder only where
 * SoDEX itself reports an approval that covers the fee. An order naming an
 * unapproved builder is rejected, and a fee nobody approved must never be asked
 * for - so the approval SoDEX lists, per engine, is the only source of truth,
 * and the cost the UI shows is derived from the same decision the order uses.
 *
 * WHICH FEE. The build's fee per engine is the DEFAULT and the highest. A
 * wallet may owe less (a volume tier, docs/BUILDER-TIERS.md): the callers pass
 * the fee owed now (terms.ts `feeNow`), and nothing here ever goes above the
 * default. Whether an order may leave WITHOUT the builder is not decided here
 * but at the gate every signed action passes (feeGuard.ts).
 */
import {
  attachableBuilderFee,
  builderFeeCharged,
  builderRatePercent,
  builderRateToFraction,
  type BuilderEngineRates,
  type BuilderParams,
  type Engine,
} from '@sodex-core';
import type { BuilderConfig } from './config';

const ENGINES: readonly Engine[] = ['spot', 'perps'];

/**
 * What this browser knows SoDEX has approved for the Valuescan builder, kept
 * with the trading key (vault.ts). The approval belongs to the ACCOUNT, not the
 * key: it survives key rotation, and it is re-read whenever a key is restored.
 */
export interface BuilderApproval {
  /** The builder account the approval is for. */
  id: number;
  /** The highest rate approved on any engine, tenths of a bp (what the key view shows). */
  maxFeeRate: number;
  /** The rate SoDEX reports approved per engine, tenths of a bp. Absent = not approved (or not confirmed) there. */
  engines: { spot?: number; perps?: number };
}

/** The configured builder, if it charges anything at all. */
export const activeBuilder = (b: BuilderConfig | null | undefined): BuilderConfig | null =>
  b && (b.fee.perps > 0 || b.fee.spot > 0) ? b : null;

/** The engines an order would carry the fee on (those with a non-zero fee). */
export const enginesCharged = (b: BuilderConfig): Engine[] => ENGINES.filter((e) => b.fee[e] > 0);

/** Per engine: is nothing needed, or does what SoDEX reports cover the configured fee? */
export function ratesCover(b: BuilderConfig, rates: BuilderEngineRates): Record<Engine, boolean> {
  const one = (e: Engine) => b.fee[e] === 0 || attachableBuilderFee(e, b.fee[e], rates[e]) !== null;
  return { spot: one('spot'), perps: one('perps') };
}

/** Every engine that charges is covered: nothing to ask the user for. */
export const fullyApproved = (b: BuilderConfig, rates: BuilderEngineRates): boolean => {
  const c = ratesCover(b, rates);
  return c.spot && c.perps;
};

/** At least one engine that charges is covered. */
export const partlyApproved = (b: BuilderConfig, rates: BuilderEngineRates): boolean => {
  const c = ratesCover(b, rates);
  return enginesCharged(b).some((e) => c[e]);
};

/** What SoDEX reports, in the shape that is stored; null when the builder is approved nowhere. */
export function approvalFromRates(builderId: number, rates: BuilderEngineRates): BuilderApproval | null {
  const engines: BuilderApproval['engines'] = {};
  for (const e of ENGINES) {
    const r = rates[e];
    if (typeof r === 'number' && r > 0) engines[e] = r;
  }
  const all = Object.values(engines);
  return all.length ? { id: builderId, maxFeeRate: Math.max(...all), engines } : null;
}

export const ratesOf = (a: BuilderApproval | null | undefined): BuilderEngineRates => ({
  spot: a?.engines?.spot ?? null,
  perps: a?.engines?.perps ?? null,
});

export const sameApproval = (a: BuilderApproval | null | undefined, b: BuilderApproval | null | undefined): boolean =>
  (a?.id ?? null) === (b?.id ?? null) &&
  (a?.engines?.spot ?? null) === (b?.engines?.spot ?? null) &&
  (a?.engines?.perps ?? null) === (b?.engines?.perps ?? null);

/**
 * The `{id, fee}` an order on `engine` carries, or undefined. Only for the
 * configured builder, only where SoDEX reports an approval covering the fee,
 * only within the engine's own cap. A stored approval for another builder id
 * (the build changed its builder) attaches nothing.
 */
export function orderBuilder(
  b: BuilderConfig | null | undefined,
  approval: BuilderApproval | null | undefined,
  engine: Engine,
  /** The fee the wallet owes now on `engine` (terms.ts `feeNow`). Default, and upper limit: the build's fee. */
  fee?: number,
): BuilderParams | undefined {
  const cfg = activeBuilder(b);
  if (!cfg || !approval || approval.id !== cfg.id) return undefined;
  const owed = owedFee(cfg, engine, fee);
  if (owed === null) return undefined;
  const approved = approval.engines?.[engine];
  // A wallet whose terms say 0 still names the builder, where SoDEX lists it at all (its orders stay ours).
  if (owed === 0) return typeof approved === 'number' && Number.isInteger(approved) && approved > 0 ? { id: cfg.id, fee: 0 } : undefined;
  const attach = attachableBuilderFee(engine, owed, approved);
  return attach === null ? undefined : { id: cfg.id, fee: attach };
}

/**
 * The fee an order on `engine` is to carry: `fee` when it is a whole number
 * from 0 to the build's default, the default otherwise - anything unusable
 * falls to the HIGHEST fee, never to a lower one. null: the build does not
 * charge on this engine at all.
 */
export function owedFee(cfg: BuilderConfig, engine: Engine, fee?: number): number | null {
  const dflt = cfg.fee[engine];
  if (!(dflt > 0)) return null;
  return typeof fee === 'number' && Number.isInteger(fee) && fee >= 0 && fee <= dflt ? fee : dflt;
}

// --- what the user is told ------------------------------------------------------

export interface BuilderTerms {
  /** Who receives the fee. */
  builderId: number;
  /** Fee per perps fill (both sides), tenths of a bp; 0 = none. */
  perps: number;
  /** Fee per spot SELL fill, tenths of a bp; 0 = none. Spot buys are never charged. */
  spot: number;
  /** The ceiling the wallet is asked to approve, tenths of a bp. */
  maxFeeRate: number;
  /** Trading through Valuescan requires the approval. */
  required: boolean;
  /** Engines on which SoDEX already lists a covering approval (a partial one). */
  alreadyApproved: Engine[];
  /**
   * What the approval is asked for. 'enable': as a step of enabling trading
   * (in an optional build, declining still enables it). 'approve': on its own,
   * from the key options - trading is not touched, and the only other answer
   * is to leave things as they are.
   */
  purpose: 'enable' | 'approve';
}

export function builderTerms(
  b: BuilderConfig,
  rates: BuilderEngineRates = { spot: null, perps: null },
  purpose: BuilderTerms['purpose'] = 'enable',
): BuilderTerms {
  const c = ratesCover(b, rates);
  return {
    builderId: b.id,
    perps: b.fee.perps,
    spot: b.fee.spot,
    maxFeeRate: b.maxFeeRate,
    required: b.required,
    alreadyApproved: enginesCharged(b).filter((e) => c[e]),
    purpose,
  };
}

/** A rate for people: 50 -> "0.05%". */
export const fmtBuilderRate = (rate: number): string => `${builderRatePercent(rate)}%`;

// --- what an order placed now would be charged -----------------------------------

export interface BuilderFeeQuote {
  builderId: number;
  /** Tenths of a bp. */
  rate: number;
  /** As a fraction of the fill's notional (0.0005) - the unit the venue's own fee rates use. */
  fraction: number;
  /**
   * Whether SoDEX charges it on this side: both sides on perps, SELLS only on
   * spot. A spot buy names the builder and is charged nothing.
   */
  charged: boolean;
  /**
   * 'attached': approved on this engine - orders carry it now.
   * 'required': not approved yet (or trading is off) in a build that requires
   *             it - every order that goes out from here will carry it.
   */
  status: 'attached' | 'required';
  /** The build's default fee - present only when `rate` is below it (a volume tier applies to this wallet). */
  fullRate?: number;
  /**
   * The next tier the server names, when it is lower: from `atUsd` of volume
   * traded here the fee is `rate`. For the screen only - it is not signed and
   * decides nothing.
   */
  next?: { atUsd: number; rate: number; volumeUsd: number | null };
}

/**
 * The builder fee an order on `engine` would carry, or null when none would.
 * Shown cost == charged cost: this uses the same `orderBuilder` decision the
 * signed order does. With no builder configured it is always null, so no fee
 * line exists anywhere in the UI.
 */
export function quoteBuilderFee(i: {
  builder: BuilderConfig | null | undefined;
  approval: BuilderApproval | null | undefined;
  engine: Engine;
  side: 'buy' | 'sell';
  /** The fee the wallet owes now on this engine (terms.ts `feeNow`); the build's default when omitted. */
  fee?: number;
  /** The next tier, as the terms name it (display only). */
  next?: { atUsd: number; rate: number; volumeUsd: number | null } | null;
}): BuilderFeeQuote | null {
  const cfg = activeBuilder(i.builder);
  if (!cfg) return null;
  const owed = owedFee(cfg, i.engine, i.fee);
  if (owed === null) return null;
  const attached = orderBuilder(cfg, i.approval, i.engine, owed);
  if (!attached && !cfg.required) return null;
  const rate = attached?.fee ?? owed;
  return {
    builderId: cfg.id,
    rate,
    fraction: builderRateToFraction(rate),
    charged: builderFeeCharged(i.engine, i.side),
    status: attached ? 'attached' : 'required',
    ...(rate < cfg.fee[i.engine] ? { fullRate: cfg.fee[i.engine] } : {}),
    ...(i.next && Number.isInteger(i.next.rate) && i.next.rate >= 0 && i.next.rate < rate ? { next: i.next } : {}),
  };
}

/** The builder fee on `notional` (quote units), 0 where SoDEX charges none. */
export const builderFeeOn = (notional: number, q: BuilderFeeQuote | null | undefined): number =>
  q && q.charged && Number.isFinite(notional) && notional > 0 ? notional * q.fraction : 0;

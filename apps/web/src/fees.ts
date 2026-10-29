/**
 * SoDEX fee ladder: the published tables, and pure arithmetic over them.
 *
 * SOURCE
 * ------
 * https://sodex.com/documentation/trading-mechanics/trading-fees
 * Retrieved 2026-08-26. Every number below is transcribed from that page; none
 * are interpolated. Where the page is silent (see MAKER REBATE) this module
 * declines to compute rather than inventing a denominator.
 *
 * THE WINDOW IS 14 DAYS, NOT 30
 * -----------------------------
 * The published wording is "Rolling 14D volume: We look at your last 14 days of
 * trading activity (rolling window)", and the tables are headed "14D Volume".
 * This is called out loudly because it is the single easiest thing to get wrong
 * here: a 30-day volume number fed into this ladder lands the user roughly two
 * tiers too high and produces a confidently wrong fee estimate. Every parameter
 * in this file is therefore named `...14d` so a mismatched input is visible at
 * the call site instead of silently mis-tiering someone.
 *
 * The tier is a single account-wide tier: "Your fee tier is based on combined
 * perps and spot volume", and one tier "applies across all assets and markets".
 * So the perps and spot columns below are two views of the SAME tier index, not
 * two independent ladders to be resolved separately.
 *
 * RATES ARE DECIMAL FRACTIONS
 * ---------------------------
 * Stored the way the gateway reports them (0.0004 == 0.040%), so a value from
 * `/fee-rate` and a value from this table can be compared directly without a
 * unit conversion sitting between them. `fmtRate` handles display.
 *
 * CROSS-CHECKED AGAINST THE LIVE VENUE
 * ------------------------------------
 * GET /api/acct/perps/fee-rate returns for an untiered account:
 *   { makerFeeRate: "0.00012", takerFeeRate: "0.0004",
 *     feeTier: 0, stakingTier: 0, makerRebateTier: 0 }
 * and the spot engine returns 0.00035 / 0.00065. Both match tier 0 of the
 * tables below exactly, which is an independent confirmation of the transcription.
 *
 * NOTHING HERE IS AUTHORITATIVE
 * -----------------------------
 * The venue's own `/fee-rate` response is the truth about what a given account
 * is charged. This table exists to (a) draw the ladder, and (b) answer the
 * counterfactual "what would a different staking tier have cost". Where the two
 * disagree, the venue wins and the disagreement gets surfaced - see
 * `reconcile()`. A computed number must never overwrite a reported one.
 */

import { fmtFixed, fmtNum, fmtPlain } from './numStyle';
/** Length of the rolling volume window the tiers are measured over. Published as 14D. */
export const VOLUME_WINDOW_DAYS = 14;

export const FEE_DOC_URL = 'https://docs.sodex.com/documentation/trading-mechanics/trading-fees';
export const FEE_DOC_RETRIEVED = '2026-08-26';

export type FeeEngine = 'spot' | 'perps';

export interface FeeTierRow {
  /** Index as the venue reports it in `feeRate.feeTier`. */
  tier: number;
  /**
   * Inclusive lower bound of the band, in USD of 14-day volume.
   *
   * The published table reads "<= $5,000,000" for tier 0 and "> $5,000,000" for
   * tier 1, so the boundary value itself belongs to the LOWER tier. Storing the
   * lower bound and comparing with a strict `>` reproduces that exactly:
   * volume of exactly $5,000,000 stays in tier 0.
   */
  minVolume: number;
  perpsMaker: number;
  perpsTaker: number;
  spotMaker: number;
  spotTaker: number;
}

/** Volume tiers, verbatim from the published table. */
export const FEE_TIERS: readonly FeeTierRow[] = [
  { tier: 0, minVolume: 0,             perpsMaker: 0.00012, perpsTaker: 0.00040, spotMaker: 0.00035, spotTaker: 0.00065 },
  { tier: 1, minVolume: 5_000_000,     perpsMaker: 0.00010, perpsTaker: 0.00036, spotMaker: 0.00025, spotTaker: 0.00055 },
  { tier: 2, minVolume: 25_000_000,    perpsMaker: 0.00006, perpsTaker: 0.00032, spotMaker: 0.00015, spotTaker: 0.00045 },
  { tier: 3, minVolume: 100_000_000,   perpsMaker: 0.00002, perpsTaker: 0.00028, spotMaker: 0.00005, spotTaker: 0.00035 },
  { tier: 4, minVolume: 500_000_000,   perpsMaker: 0,       perpsTaker: 0.00026, spotMaker: 0,       spotTaker: 0.00030 },
  { tier: 5, minVolume: 2_000_000_000, perpsMaker: 0,       perpsTaker: 0.00024, spotMaker: 0,       spotTaker: 0.00025 },
  { tier: 6, minVolume: 7_000_000_000, perpsMaker: 0,       perpsTaker: 0.00022, spotMaker: 0,       spotTaker: 0.00020 },
];

export interface StakingTierRow {
  /** Index as the venue reports it in `feeRate.stakingTier`. */
  tier: number;
  /** Minimum SOSO staked to reach this tier. Inclusive ("≥ 30 SOSO"). */
  soso: number;
  /** Fraction of the base fee waived. 0.05 == 5% off. */
  discount: number;
}

/** SOSO staking discount tiers, verbatim from the published table. */
export const STAKING_TIERS: readonly StakingTierRow[] = [
  { tier: 0, soso: 0,         discount: 0.00 },
  { tier: 1, soso: 30,        discount: 0.05 },
  { tier: 2, soso: 300,       discount: 0.10 },
  { tier: 3, soso: 3_000,     discount: 0.15 },
  { tier: 4, soso: 30_000,    discount: 0.20 },
  { tier: 5, soso: 300_000,   discount: 0.30 },
  { tier: 6, soso: 1_500_000, discount: 0.40 },
];

export interface MakerRebateRow {
  tier: number;
  /** Minimum 14-day maker volume SHARE, as a fraction (0.005 == 0.50%). */
  minShare: number;
  /** Published as a negative fee, i.e. paid to the maker. */
  rebate: number;
}

/**
 * Maker rebate tiers, verbatim from the published table.
 *
 * DELIBERATELY NOT WIRED TO A CALCULATION. The page gives the thresholds as
 * "14D maker volume share" but never states the denominator - share of the
 * user's own volume, of the symbol's, or of the whole venue's. Without that we
 * cannot compute which tier an account is in, and guessing would put a fake
 * number on a trading screen. The venue reports the resolved tier index in
 * `feeRate.makerRebateTier`; that index is the only thing worth rendering, and
 * this table is here purely to name the rebate that goes with it.
 */
export const MAKER_REBATE_TIERS: readonly MakerRebateRow[] = [
  { tier: 1, minShare: 0.0050, rebate: -0.00001 },
  { tier: 2, minShare: 0.0150, rebate: -0.00002 },
  { tier: 3, minShare: 0.0300, rebate: -0.00003 },
];

// --- lookups -----------------------------------------------------------------

/**
 * Volume tier for a 14-day USD volume.
 *
 * Walks downward so the highest band whose lower bound is strictly exceeded
 * wins, which matches the published "> $X" boundary convention. Non-finite or
 * negative input falls back to tier 0 rather than throwing: this feeds a display
 * path, and the caller may legitimately have no volume figure yet.
 */
export function tierForVolume(volume14d: number): FeeTierRow {
  const base = FEE_TIERS[0]!;
  if (!Number.isFinite(volume14d) || volume14d <= 0) return base;
  for (let i = FEE_TIERS.length - 1; i >= 0; i--) {
    const row = FEE_TIERS[i]!;
    if (volume14d > row.minVolume) return row;
  }
  return base;
}

/** Staking tier for a SOSO balance. Thresholds are inclusive ("≥ 30 SOSO"). */
export function discountForStake(soso: number): StakingTierRow {
  const base = STAKING_TIERS[0]!;
  if (!Number.isFinite(soso) || soso <= 0) return base;
  for (let i = STAKING_TIERS.length - 1; i >= 0; i--) {
    const row = STAKING_TIERS[i]!;
    if (soso >= row.soso) return row;
  }
  return base;
}

/** Row for a tier index, or null when the index is outside the published table. */
export const feeTierAt = (tier: number): FeeTierRow | null =>
  FEE_TIERS.find((t) => t.tier === tier) ?? null;

export const stakingTierAt = (tier: number): StakingTierRow | null =>
  STAKING_TIERS.find((t) => t.tier === tier) ?? null;

export const makerRebateAt = (tier: number): MakerRebateRow | null =>
  MAKER_REBATE_TIERS.find((t) => t.tier === tier) ?? null;

// --- composition -------------------------------------------------------------

export interface EffectiveFees {
  maker: number;
  taker: number;
  /** The undiscounted rates, kept so the UI can show what the discount acted on. */
  baseMaker: number;
  baseTaker: number;
  discount: number;
}

/**
 * Compose a volume tier with a staking tier.
 *
 *   effective = base * (1 - discount)
 *
 * That is the formula the documentation states outright ("Effective fee = Base
 * fee × (1 - Staking discount)"). It is applied to maker and taker alike; at
 * tiers 4-6 the maker base is already 0, so the discount is a no-op there
 * rather than producing a rebate.
 *
 * Returns null for an unknown tier index instead of clamping to the nearest
 * known one - if the venue ever adds a tier 7, a blank is the honest output and
 * a silently clamped tier 6 is not.
 */
export function effectiveFees(
  volumeTier: number,
  stakeTier: number,
  engine: FeeEngine = 'perps',
): EffectiveFees | null {
  const vol = feeTierAt(volumeTier);
  const stake = stakingTierAt(stakeTier);
  if (!vol || !stake) return null;

  const baseMaker = engine === 'perps' ? vol.perpsMaker : vol.spotMaker;
  const baseTaker = engine === 'perps' ? vol.perpsTaker : vol.spotTaker;
  const keep = 1 - stake.discount;

  return {
    maker: baseMaker * keep,
    taker: baseTaker * keep,
    baseMaker,
    baseTaker,
    discount: stake.discount,
  };
}

// --- counterfactual: what another staking tier would have cost ---------------

export interface StakingSavingsRow {
  stakingTier: number;
  discount: number;
  /** Total SOSO the tier requires. */
  sosoRequired: number;
  /** SOSO beyond what the current tier already requires. 0 at or below current. */
  additionalSoso: number;
  isCurrent: boolean;
  /** What the SAME trades would have cost at this tier, in USD. */
  feesAtTier: number;
  /** feesPaid - feesAtTier. Positive means this tier would have been cheaper. */
  savedInWindow: number;
}

/**
 * For each staking tier, what the fees already paid would have come to instead.
 *
 * WHY THIS NEEDS NO MAKER/TAKER SPLIT
 * -----------------------------------
 * The discount is a single multiplier applied to every fee line, so the whole
 * bill scales by it regardless of how the volume split between maker and taker
 * or across engines:
 *
 *   feesAtTier(T) = feesPaid * (1 - d_T) / (1 - d_current)
 *
 * That is exact arithmetic on the user's own bill, not a model of it. It is the
 * reason this function takes fees actually paid rather than volume: deriving a
 * fee bill from volume alone would require inventing a maker/taker ratio, and
 * an invented ratio on a trading screen is worse than no number.
 *
 * KNOWN LIMIT: if any of `feesPaidInWindow` came from maker REBATES (negative
 * fee lines, tiers above), the proportional scaling is approximate - the
 * documentation does not say whether the staking discount applies to rebates,
 * and we do not assume. Callers should treat the result as approximate when
 * `makerRebateTier > 0`; `stakingSavings` flags nothing itself because it
 * cannot see that field.
 *
 * Returns null when there is no usable fee figure, so the UI renders nothing
 * rather than a zero that reads as "you saved nothing".
 */
export function stakingSavings(
  feesPaidInWindow: number,
  currentStakingTier: number,
): StakingSavingsRow[] | null {
  const current = stakingTierAt(currentStakingTier);
  if (!current) return null;
  if (!Number.isFinite(feesPaidInWindow) || feesPaidInWindow <= 0) return null;

  const keepNow = 1 - current.discount;
  // Guard against a future 100%-discount tier turning this into a divide-by-zero.
  if (keepNow <= 0) return null;

  return STAKING_TIERS.map((t) => {
    const feesAtTier = (feesPaidInWindow * (1 - t.discount)) / keepNow;
    return {
      stakingTier: t.tier,
      discount: t.discount,
      sosoRequired: t.soso,
      additionalSoso: Math.max(0, t.soso - current.soso),
      isCurrent: t.tier === current.tier,
      feesAtTier,
      savedInWindow: feesPaidInWindow - feesAtTier,
    };
  });
}

/** The next staking tier up, or null when already at the top of the table. */
export const nextStakingTier = (currentTier: number): StakingTierRow | null =>
  STAKING_TIERS.find((t) => t.tier === currentTier + 1) ?? null;

/**
 * Below this, the savings arithmetic is not worth putting on screen.
 *
 * Purely a display threshold to keep the panel from making a fuss over cents -
 * it is not a judgement about whether staking is worthwhile, which depends on
 * the cost and risk of acquiring and locking the token and is outside anything
 * this module can see.
 */
export const SAVINGS_DISPLAY_FLOOR_USD = 1;

// --- reconciliation against the venue ----------------------------------------

/** The venue's own view, as returned by GET /api/acct/:engine/fee-rate. */
export interface VenueFeeRate {
  makerFeeRate: string;
  takerFeeRate: string;
  feeTier: number;
  stakingTier: number;
  makerRebateTier: number;
}

export interface Mismatch {
  field: string;
  venue: number;
  computed: number;
}

export interface Reconciliation {
  /** Rates as the venue reports them. Always authoritative. */
  venueMaker: number;
  venueTaker: number;
  /** What this table says those tiers should produce; null for an unknown tier. */
  computed: EffectiveFees | null;
  /** Non-empty means the table below is out of date - show the venue's number. */
  mismatches: Mismatch[];
  /**
   * Set when a supplied 14-day volume resolves to a different tier than the one
   * the venue reports. Usually means the volume figure covers a different window
   * (a 30-day total is the classic offender) rather than a bad table.
   */
  volumeTierDisagrees: { fromVolume: number; fromVenue: number } | null;
}

/** Floats from two sources never land bit-identical; compare with a tolerance. */
const near = (a: number, b: number): boolean =>
  Math.abs(a - b) <= Math.max(1e-12, Math.abs(b) * 1e-9);

/**
 * Compare the venue's reported rates against what the published ladder implies.
 *
 * This is the strongest available check on the composition formula because it
 * needs no input from us at all: the venue supplies both tier indices AND the
 * resulting rates, so `base(feeTier) * (1 - discount(stakingTier))` either
 * reproduces them or it does not.
 *
 * `volume14d` is optional and only used to cross-check the tier index.
 */
export function reconcile(
  venue: VenueFeeRate,
  engine: FeeEngine = 'perps',
  volume14d?: number,
): Reconciliation {
  const venueMaker = Number.parseFloat(venue.makerFeeRate);
  const venueTaker = Number.parseFloat(venue.takerFeeRate);
  const computed = effectiveFees(venue.feeTier, venue.stakingTier, engine);

  const mismatches: Mismatch[] = [];
  if (computed) {
    if (Number.isFinite(venueMaker) && !near(computed.maker, venueMaker)) {
      mismatches.push({ field: 'maker', venue: venueMaker, computed: computed.maker });
    }
    if (Number.isFinite(venueTaker) && !near(computed.taker, venueTaker)) {
      mismatches.push({ field: 'taker', venue: venueTaker, computed: computed.taker });
    }
  }

  let volumeTierDisagrees: Reconciliation['volumeTierDisagrees'] = null;
  if (volume14d !== undefined && Number.isFinite(volume14d) && volume14d > 0) {
    const fromVolume = tierForVolume(volume14d).tier;
    if (fromVolume !== venue.feeTier) {
      volumeTierDisagrees = { fromVolume, fromVenue: venue.feeTier };
    }
  }

  return { venueMaker, venueTaker, computed, mismatches, volumeTierDisagrees };
}

// --- display -----------------------------------------------------------------

/**
 * A decimal fee rate as a percentage string, e.g. 0.0004 -> "0.040%".
 *
 * Three decimals because the whole ladder lives between 0.012% and 0.065% and
 * the tier steps are 0.004% apart - two decimals would render three different
 * tiers identically.
 */
export function fmtRate(rate: number | null | undefined, dp = 3): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return '-';
  return `${fmtFixed(rate * 100, dp)}%`;
}

/** Compact volume threshold for the ladder, e.g. 5_000_000 -> "$5M". */
export function fmtThreshold(usd: number): string {
  if (!Number.isFinite(usd)) return '-';
  if (usd >= 1_000_000_000) return `$${fmtPlain(usd / 1_000_000_000)}B`;
  if (usd >= 1_000_000) return `$${fmtPlain(usd / 1_000_000)}M`;
  return `$${fmtNum(usd)}`;
}

const usdComma = (n: number): string => `$${fmtNum(Math.round(n))}`;

/**
 * Volume band as the venue ticket prints it, full dollars.
 * The boundary belongs to the lower tier: tier 0 is "≤ $5,000,000".
 */
export function feeVolumeLabel(index: number): string {
  const row = FEE_TIERS[index];
  if (!row) return '-';
  if (index === 0) {
    const next = FEE_TIERS[1];
    return next ? `≤ ${usdComma(next.minVolume)}` : usdComma(row.minVolume);
  }
  return `> ${usdComma(row.minVolume)}`;
}

/** SOSO amounts, which span 30 to 1,500,000 and read better grouped. */
export const fmtSoso = (n: number): string =>
  Number.isFinite(n) ? fmtNum(n) : '-';

/** Venue rate plus the ValueDesk builder fraction. Both are fractions of notional. */
export function withBuilder(venueRate: number, builderFraction: number): number {
  const add = Number.isFinite(builderFraction) ? builderFraction : 0;
  return venueRate + add;
}

/**
 * One engine's `/fee-rate`, with tier fields that were absent left absent.
 *
 * A missing `makerRebateTier` is not tier 0. Tier 0 is a real report (no rebate,
 * base volume tier, no stake). Coercing a hole to 0 would mark the wrong row.
 */
export interface VenueFeeRead {
  taker: number;
  maker: number;
  feeTier: number | null;
  stakingTier: number | null;
  makerRebateTier: number | null;
}

function wholeTier(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim());
    return Number.isInteger(n) && n >= 0 ? n : null;
  }
  return null;
}

function finiteRate(v: unknown): number | null {
  const n = typeof v === 'number'
    ? v
    : typeof v === 'string' && v.trim() !== ''
      ? Number(v.trim())
      : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Accept the gateway body (`{ engine, feeRate }`), an already-unwrapped rate,
 * or anything else (null). Rates are required. Tier indices are not.
 */
export function readVenueFee(body: unknown): VenueFeeRead | null {
  if (!body || typeof body !== 'object') return null;
  let node = body as Record<string, unknown>;
  const inner = node.feeRate;
  if (inner && typeof inner === 'object') node = inner as Record<string, unknown>;
  const taker = finiteRate(node.takerFeeRate);
  const maker = finiteRate(node.makerFeeRate);
  if (taker === null || maker === null) return null;
  return {
    taker,
    maker,
    feeTier: wholeTier(node.feeTier),
    stakingTier: wholeTier(node.stakingTier),
    makerRebateTier: wholeTier(node.makerRebateTier),
  };
}

export interface TierMark {
  /** Row to mark when the engines agree, or only one of them reported a row. */
  highlight: number | null;
  /** Both engines reported a tier and the two indices differ. Mark no row. */
  split: boolean;
}

/**
 * Staking row for the account, from the two engines' own indices.
 *
 * SoDEX's trade ticket takes Math.max of the two. That hides a disagreement.
 * Here a shared index is the row, a single report is the row, and two different
 * reports mark nothing — the screen names both numbers instead.
 */
export function stakingMark(spot: number | null, perps: number | null): TierMark {
  const reported = (n: number | null): number | null =>
    n !== null && Number.isInteger(n) && n >= 0 ? n : null;
  const a = reported(spot);
  const b = reported(perps);
  if (a !== null && b !== null && a !== b) return { highlight: null, split: true };
  const tier = a ?? b;
  if (tier === null || tier > STAKING_TIERS.length - 1) return { highlight: null, split: false };
  return { highlight: tier, split: false };
}

export interface LadderRows {
  /** Entry engine's row, when that index is in the table. */
  highlight: number | null;
  /** The other engine's row, when it is in the table and is a different row. */
  also: number | null;
}

function rowIn(n: number | null, min: number, max: number): number | null {
  return n !== null && Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/** Volume-tier rows. Tier 0 is a real row. An index past the table is not. */
export function feeTierRows(entry: number | null, other: number | null): LadderRows {
  const last = FEE_TIERS.length - 1;
  const e = rowIn(entry, 0, last);
  const o = rowIn(other, 0, last);
  return { highlight: e, also: o !== null && o !== e ? o : null };
}

/**
 * Maker-rebate rows. Tier 0 means the venue reported "no rebate", which is not
 * a row of the rebate table. Tiers 1–3 are the rows.
 */
export function rebateRows(entry: number | null, other: number | null): LadderRows {
  const last = MAKER_REBATE_TIERS.length;
  const e = rowIn(entry, 1, last);
  const o = rowIn(other, 1, last);
  return { highlight: e, also: o !== null && o !== e ? o : null };
}

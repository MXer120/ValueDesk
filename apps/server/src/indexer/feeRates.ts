/**
 * What a fill costs the account that made it: the venue's fee at that account's own tier.
 *
 * A book's cash moves by every fill between reads (cohortTracker.ts applyFill), and a fee left
 * out shows in its liquidation price: a Hyperliquid round trip at the base taker rate is 0.09%
 * of the notional, the whole 0.1% the heatmap is held to. Each venue says it differently
 * (checked against each venue's own fills, 2026-10-28):
 *
 *   Hyperliquid  `userFees`: the account's taker (userCrossRate) and maker (userAddRate) rate
 *                and spot's; a positive fee is cut by `activeReferralDiscount` (4.5 bp at 4%
 *                is the 4.32 bp seen on fills), a maker rebate is not.
 *   trade.xyz    the same account's rates, times each market's own scale: a positive fee by
 *                (1 + deployerFeeScale), and by 0.1 in growth mode; a rebate by 0.1 in growth
 *                mode only (0.864 bp taker / -0.03 bp maker seen on xyz:TSLA, 3.0 bp maker on a
 *                market out of growth mode).
 *   SoDEX        GET /perps/accounts/{a}/fee-rate (weight 2): makerFeeRate / takerFeeRate.
 *   Lighter      every trade carries the fee each side paid (lighterPrint): nothing to ask.
 *   Arcus        no rate endpoint: the account's own last fills, by role (fee / notional).
 *
 * Asking costs weight, so only an account that has traded enough since it was last asked is
 * asked (ASK_MIN_USD), and its answer stands for a day (the tiers follow 14-day volume). Until
 * then the venue's base tier stands: what most accounts pay.
 */
import type { Venue } from '../valuedesk/types.js';
import { hlInfo } from '../valuedesk/hyperliquid/index.js';
import { gwGet } from '../valuedesk/sodex/gateway.js';
import { arcusFills } from '../valuedesk/extra/arcus.js';
import type { Pacer } from '../valuedesk/extra/http.js';

export interface FeeRates {
  /** Perps taker / maker, as shares of the notional (a maker rebate is negative). */
  taker: number;
  maker: number;
  /** Hyperliquid spot taker / maker (only a seller pays in USDC). */
  spotTaker?: number;
  spotMaker?: number;
  /** Cut off every positive fee (Hyperliquid's referral discount). */
  referral?: number;
  /** When it was asked (0 = the base tier). */
  at: number;
}

/** The base tier: what an account pays until it is asked. */
export const BASE_FEES: Record<Venue, FeeRates> = {
  hyperliquid: { taker: 4.5e-4, maker: 1.5e-4, spotTaker: 7e-4, spotMaker: 4e-4, at: 0 },
  // An xyz account is a Hyperliquid account: its rates are those (the market scale is added per fill).
  tradexyz: { taker: 4.5e-4, maker: 1.5e-4, at: 0 },
  sodex: { taker: 4e-4, maker: 1.2e-4, at: 0 },
  // Lighter's trades carry the fee paid; this stands only for a trade that does not.
  lighter: { taker: 0, maker: 0, at: 0 },
  // The highest rates seen on Arcus fills (2026-10-28): taker 4.27 bp, maker 1.5 bp.
  arcus: { taker: 4.27e-4, maker: 1.5e-4, at: 0 },
};

/** Traded (USD) since the last ask before an account is asked again; and how long an answer stands. */
export const ASK_MIN_USD: Partial<Record<Venue, number>> = { hyperliquid: 100_000, sodex: 10_000, arcus: 20_000 };
export const FEES_TTL_MS = 24 * 60 * 60_000;

/** A HIP-3 market's fee terms (metaAndAssetCtxs): deployerFeeScale and whether it is in growth mode. */
export interface MarketScale {
  scale: number;
  growth: boolean;
}

/**
 * One side's fee rate on one fill: the account's (or the base) rate for its role, with a
 * HIP-3 market's scale and the referral discount where they apply.
 */
export function fillRate(r: FeeRates, taker: boolean, market?: MarketScale | null): number {
  let rate = taker ? r.taker : r.maker;
  if (rate > 0) {
    if (market) rate *= (1 + market.scale) * (market.growth ? 0.1 : 1);
    rate *= 1 - (r.referral ?? 0);
  } else if (market?.growth) {
    rate *= 0.1;
  }
  return rate;
}

/** The fee a Hyperliquid spot sale pays in USDC (a buyer pays in the coin it receives). */
export function spotSellRate(r: FeeRates, taker: boolean): number {
  const rate = (taker ? r.spotTaker : r.spotMaker) ?? (taker ? BASE_FEES.hyperliquid.spotTaker! : BASE_FEES.hyperliquid.spotMaker!);
  return rate > 0 ? rate * (1 - (r.referral ?? 0)) : rate;
}

const dec = (v: unknown): number | null => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Hyperliquid's `userFees` (weight 20). Null when it does not answer with rates. */
export async function hlFees(address: string, now: number): Promise<FeeRates | null> {
  const f = await hlInfo.post<Record<string, unknown> | null>({ type: 'userFees', user: address }, { ttlMs: 0 });
  const taker = dec(f?.userCrossRate);
  const maker = dec(f?.userAddRate);
  if (taker === null || maker === null) return null;
  return {
    taker, maker, spotTaker: dec(f?.userSpotCrossRate) ?? undefined, spotMaker: dec(f?.userSpotAddRate) ?? undefined,
    referral: dec(f?.activeReferralDiscount) ?? 0, at: now,
  };
}
export const HL_FEES_COST = 20;

/** SoDEX's perps fee-rate for an account (weight 2). */
export async function sodexFees(address: string, now: number): Promise<FeeRates | null> {
  const r = await gwGet<{ makerFeeRate?: string; takerFeeRate?: string } | null>(`/api/v1/perps/accounts/${address}/fee-rate`, 2);
  const taker = dec(r?.takerFeeRate);
  const maker = dec(r?.makerFeeRate);
  return taker === null || maker === null ? null : { taker, maker, at: now };
}
export const SODEX_FEES_COST = 2;

/**
 * An Arcus account's rates from its last fills: the median fee / notional per role. A role it
 * has not traded keeps the base rate. Null when it has no fills to learn from.
 */
export async function arcusFees(address: string, now: number, pacer: Pacer): Promise<FeeRates | null> {
  const fills = await arcusFills(address, { limit: 100 }, pacer);
  const by: Record<'TAKER' | 'MAKER', number[]> = { TAKER: [], MAKER: [] };
  for (const f of fills) {
    const ntl = f.price * f.size;
    if (f.role && f.fee !== null && ntl > 0) by[f.role].push(f.fee / ntl);
  }
  const med = (a: number[]) => (a.length ? a.sort((x, y) => x - y)[a.length >> 1]! : null);
  const taker = med(by.TAKER);
  const maker = med(by.MAKER);
  if (taker === null && maker === null) return null;
  return { taker: taker ?? BASE_FEES.arcus.taker, maker: maker ?? BASE_FEES.arcus.maker, at: now };
}
export const ARCUS_FEES_COST = 20;

/** Each HIP-3 xyz market's fee terms (one metaAndAssetCtxs read, kept an hour by the caller). */
export async function xyzScales(): Promise<Map<string, MarketScale>> {
  const raw = await hlInfo.post<[{ universe?: Array<{ name?: string; deployerFeeScale?: string; growthMode?: string }> }, unknown] | null>(
    { type: 'metaAndAssetCtxs', dex: 'xyz' }, { ttlMs: 60 * 60_000 },
  );
  const out = new Map<string, MarketScale>();
  for (const u of raw?.[0]?.universe ?? []) {
    if (!u.name) continue;
    out.set(u.name, { scale: dec(u.deployerFeeScale) ?? 0, growth: u.growthMode === 'enabled' });
  }
  return out;
}

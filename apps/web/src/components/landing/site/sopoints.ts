/**
 * The SoPoints estimate the landing pages show (owner 2026-11-23: "a calculator with SoPoints, estimated from volume
 * done or USD allocated").
 *
 * The SAME fitted model as the SoPoints page (apps/web/src/points.ts SOPOINTS_MODEL, fitted 2026-11-20 from 290
 * settled wallet-weeks of 29 wallets, Layer 1 weeks 1-10). It is copied here because that file's model is not on this
 * branch yet; when both are merged, import it from points.ts and delete this copy.
 *
 * MEASURED, NOT PUBLISHED: SoDEX publishes no formula. own = C_week x score^0.70, score = futures + 3 spot + 10 x average
 * open position + 13.5 x Wealth + 3.4 x SLP Vault. C_week depends on everyone else's activity that week: the season so
 * far ran from 31 to 55 points per $10k of futures (rateLow..rateHigh), which is the band every estimate shows.
 * Referral points and the squad boost come on top and are not part of this estimate.
 */
export const SOPOINTS_MODEL = {
  exponent: 0.7,
  weights: { spot: 3, oi: 10 },
  ratePer10k: 37.5,
  rateLow: 31,
  rateHigh: 55,
  fittedOn: '290 settled wallet-weeks',
  fittedAt: '2026-11-20',
} as const;

export const scoreOf = (p: { futures: number; spot?: number; oi?: number }): number =>
  p.futures + SOPOINTS_MODEL.weights.spot * (p.spot ?? 0) + SOPOINTS_MODEL.weights.oi * (p.oi ?? 0);

const cFor = (ratePer10k: number): number => ratePer10k / 10_000 ** SOPOINTS_MODEL.exponent;

export const ownPoints = (score: number, ratePer10k: number = SOPOINTS_MODEL.ratePer10k): number =>
  score > 0 ? cFor(ratePer10k) * score ** SOPOINTS_MODEL.exponent : 0;

export interface PointsBand { score: number; mid: number; low: number; high: number }

export function estimate(p: { futures: number; spot?: number; oi?: number }): PointsBand {
  const score = scoreOf(p);
  return { score, mid: ownPoints(score), low: ownPoints(score, SOPOINTS_MODEL.rateLow), high: ownPoints(score, SOPOINTS_MODEL.rateHigh) };
}

/**
 * A market's score, 0-100, from what $1M of the bot is estimated to do there all-in (bp of volume, positive = cost)
 * (owner 2026-11-10: "add a 0-100 score"). Two straight pieces through three fixed points:
 *   100  earns $300 or more per $1M (-3 bp or better)
 *    50  pays only the fees (the maker keeps exactly what it gives away: cost = fee)
 *     0  costs the fees plus $230 or more per $1M (fee + 2.3 bp: where the worst live markets of 2026-11-09 sat)
 * Null without an estimate.
 */
export const SCORE_TOP_BP = -3;
export const SCORE_FLOOR_OVER_FEE_BP = 2.3;

export function marketScore(bp: number | null, feeBps: number): number | null {
  if (bp === null || !Number.isFinite(bp)) return null;
  if (bp <= SCORE_TOP_BP) return 100;
  if (bp <= feeBps) return Math.round(100 - (50 * (bp - SCORE_TOP_BP)) / (feeBps - SCORE_TOP_BP));
  return Math.max(0, Math.round(50 - (50 * (bp - feeBps)) / SCORE_FLOOR_OVER_FEE_BP));
}

/** What a score means, in words (tooltips, the method note). */
export const SCORE_WORDS = 'Score 0-100 from the estimated cost per $1M: 100 earns $300 or more, 50 pays only the fees, 0 costs $230 or more on top of the fees.';

/** The score's colour: red at 0, amber at 50, green at 100, solid (an overlap never shows through). */
export function scoreColour(s: number | null): string {
  if (s === null) return 'rgb(var(--ink) / 0.05)';
  const hue = s >= 50 ? `color-mix(in srgb, var(--pos) ${Math.round((s - 50) * 2)}%, var(--warn))` : `color-mix(in srgb, var(--neg) ${Math.round((50 - s) * 2)}%, var(--warn))`;
  return `color-mix(in srgb, ${hue} 62%, var(--tf-raised))`;
}

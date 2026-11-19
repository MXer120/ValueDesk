/**
 * Signed figures for the trader cards and the copy setup: a leaf module, so a card (Explore, Copy's grid) can
 * print "+12.34%" without loading setup.ts - which brings the copy engine (@copy-engine) and, through it, the
 * copier's runtime into the page's first render. setup.ts re-exports both.
 */
import { DASH, MINUS, fmtUsd } from '../../format';
import { fmtFixed, localize } from '../../numStyle';

/** Fraction -> signed percent with a true minus sign: 0.1234 -> "+12.34%". */
export function fmtSignedPct(frac: number | null | undefined, dp = 2): string {
  if (frac === null || frac === undefined || !Number.isFinite(frac)) return DASH;
  const v = frac * 100;
  const en = Math.abs(v).toFixed(dp);
  if (Number(en) === 0) return `${fmtFixed(0, dp)}%`;
  return `${v > 0 ? '+' : MINUS}${localize(en)}%`;
}

/** USD with an explicit + on gains; fmtUsd already signs losses with a minus sign. */
export function fmtSignedUsd(v: number | null | undefined, dp = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return `${v > 0 ? '+' : ''}${fmtUsd(v, dp)}`;
}

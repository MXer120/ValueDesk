/**
 * ValueDesk builder ladder, transcribed from docs/BUILDER-TIERS.md
 * ("The live schedule", owner, 2026-10-04).
 *
 * Rates are tenths of a basis point, the unit SoDEX signs: 15 = 1.5 bp = 0.015%.
 * Volume is counted perps + spot over 14 days. The boundary belongs to the
 * higher tier (min is inclusive), so $1,000,000 is the second row.
 *
 * The fee on an order is whatever `feeNow` signed, which can differ from this
 * table when the build default and the live file disagree. `builderTierIndex`
 * marks a row only when that signed fee is the row's rate.
 */
import { fmtThreshold } from './fees';

export interface BuilderTier {
  minVolumeUsd: number;
  perps: number;
  spot: number;
}

export const BUILDER_LADDER: readonly BuilderTier[] = [
  { minVolumeUsd: 0, perps: 15, spot: 15 },
  { minVolumeUsd: 1_000_000, perps: 12, spot: 12 },
  { minVolumeUsd: 5_000_000, perps: 10, spot: 10 },
  { minVolumeUsd: 25_000_000, perps: 8, spot: 8 },
  { minVolumeUsd: 100_000_000, perps: 5, spot: 5 },
];

/** Band label. The first row is everything under the next milestone. */
export function builderVolumeLabel(index: number): string {
  const row = BUILDER_LADDER[index];
  if (!row) return '-';
  const next = BUILDER_LADDER[index + 1];
  if (index === 0 && next) return `< ${fmtThreshold(next.minVolumeUsd)}`;
  return `≥ ${fmtThreshold(row.minVolumeUsd)}`;
}

/**
 * Which published row a signed fee sits on.
 *
 * `reported` (the terms' display tier) wins only when that row's rate for this
 * engine equals the signed fee. Otherwise a row is marked only when exactly
 * one row has that rate. No match marks nothing.
 */
export function builderTierIndex(
  feeTenths: number,
  engine: 'spot' | 'perps',
  reported: number | null,
): number | null {
  if (reported !== null && BUILDER_LADDER[reported]?.[engine] === feeTenths) return reported;
  const hits = BUILDER_LADDER
    .map((row, i) => (row[engine] === feeTenths ? i : -1))
    .filter((i) => i >= 0);
  return hits.length === 1 ? hits[0]! : null;
}

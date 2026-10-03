/**
 * Honest copy for a cohort the chosen venues leave empty.
 *
 * Small venues truly have no $1M+ wallet (SoDEX's best all-time PnL is in the
 * hundreds of thousands), so an empty card is a fact about the venue, not a
 * loading state. The cohorts stay absolute - the same thresholds on every
 * venue - and the card says so in words instead of drawing an empty chart.
 * A cohort is its wallets holding positions, so the copy says "holds a
 * position": such a wallet may exist and be flat right now.
 *
 * Pure: the cohort's own range text (COHORT_BY_ID) and the venue names in.
 */
import type { CohortDef, CohortId } from '@sign/valuescan/cohorts/model.js';

/** "SoDEX", "SoDEX or Arcus", "SoDEX, Lighter or Arcus". */
export function venueList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

const LOSS: ReadonlySet<CohortId> = new Set(['unprofitable', 'very-unprofitable', 'rekt']);

/** The cohort's range without its unit or signs: "+$100K to +$1M PnL" -> "$100K to $1M". */
const amountOf = (def: CohortDef): string =>
  def.range.replace(/\s+(PnL|equity)$/i, '').replace(/[+\-−](?=\$)/g, '').trim();

/** "No SoDEX wallet that made $1M+ all-time holds a position" / "No SoDEX wallet with $5M+ perp equity holds a position". */
export function emptyCohortText(def: CohortDef, venueNames: readonly string[]): string {
  const who = `No ${venueList(venueNames)} wallet`.replace(/\s+/g, ' ');
  const amount = amountOf(def);
  if (def.kind === 'size') return `${who} with ${amount} perp equity holds a position`;
  return `${who} that ${LOSS.has(def.id) ? 'lost' : 'made'} ${amount} all-time holds a position`;
}

/** One line for the page: "No wallet holds a position in: Extremely Profitable, Rekt." Null when none is empty. */
export function emptyCohortsLine(empty: readonly CohortDef[]): string | null {
  if (!empty.length) return null;
  return `On the chosen venues no wallet holds a position in: ${empty.map((d) => d.name).join(', ')}.`;
}

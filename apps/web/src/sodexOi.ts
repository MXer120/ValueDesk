/**
 * SoDEX's open interest as our pages show it: without SoDEX's internal pair (owner, 2026-11-06: "dont
 * display the pair only the others"; server valuedesk/sodex/oiExcluded.ts). Display and sorting only:
 * order logic and venue limits keep SoDEX's raw figure, since SoDEX's cap applies to its own number
 * (components/algo/draft.ts, AlgoTicket.tsx).
 */
export interface SodexOiExcluded {
  /** Symbol (`BTC-USD`) -> coins to take off. A market the pair does not hold is absent. */
  sizes: Readonly<Record<string, number>>;
  /** When SoDEX was read (ms). */
  at: number;
}

/**
 * The open interest to show for a SoDEX market, in the venue's unit (coins), never below 0. Null when
 * it cannot be told, and the caller shows its dash: no venue figure, or `excluded` unavailable, when
 * the venue's figure would be the inflated one.
 */
export function displayedOi(symbol: string, venueOi: string | number | null | undefined, excluded: SodexOiExcluded | null | undefined): number | null {
  if (!excluded) return null;
  const oi = typeof venueOi === 'number' ? venueOi : typeof venueOi === 'string' && venueOi.trim() !== '' ? Number(venueOi) : Number.NaN;
  const size = excluded.sizes[symbol] ?? 0;
  if (!Number.isFinite(oi) || typeof size !== 'number' || !Number.isFinite(size)) return null;
  return Math.max(0, oi - size);
}

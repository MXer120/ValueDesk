/**
 * Wallets left out of the cohorts AND the liquidation heatmap (owner, 2026-10-31), and listed as such
 * on the "Excluded wallets" page (EXCLUDED_WALLETS, /api/vs/excluded), so nothing is left out unsaid.
 *
 *   internal  a venue's own accounts. SoDEX: a mirrored pair - one 908.65525 BTC long against an ETH
 *             short, the other the exact reverse (~$76M ETH each), 25x cross, opened in the same millisecond (2026-05-15) with
 *             consecutive position ids, ~$10.8M equity each. One book hedged across two accounts:
 *             ~$141M of SoDEX's ~$141M of BTC levels, a solid band on the map.
 *   hedged    desks that only hedge what they hold elsewhere: their perp shorts are no view on the
 *             market. Hyperliquid: Abraxas Capital (Hedged) #1 and #2 (Hyperdash's names), short-only
 *             across 25-30 coins at 3-5x, ~$1.05B between them - Apex and Extremely profitable read
 *             39% / 33% long with them, 48% / 43% without, as Hyperdash shows those cohorts. Left out
 *             of the cohorts first; of the heatmap too on the owner's word the same day.
 *
 * Addresses lower case. The indexer keeps reading them (nothing else changes): they are only not
 * counted - no cohort member, no book in a cohort load, no level on the map - and what they hold is
 * taken off the venue's open interest the map's coverage is measured against (read.ts internalOiNow).
 */
import type { Venue } from './types.js';

export type ExcludedKind = 'internal' | 'hedged';

export interface ExcludedWallet {
  venue: Venue;
  address: string;
  kind: ExcludedKind;
  /** A name a person recognises (the venue's, Hyperdash's), or null. */
  label: string | null;
  /** Why, in a sentence, for the page. */
  why: string;
  /** When it was left out (YYYY-MM-DD). */
  since: string;
}

export const EXCLUDED_WALLETS: readonly ExcludedWallet[] = [
  {
    venue: 'sodex', address: '0xfd09e83f250b11a9f0efd0daa605e890daf67412', kind: 'internal', label: 'SoDEX internal pair (short)', since: '2026-10-31',
    why: 'BTC short 908.65525 against an ETH long (~$76M), the exact mirror of its twin account opened in the same millisecond: the two cancel out - one book, not a trade.',
  },
  {
    venue: 'sodex', address: '0x296b81e89f8661ab9af6548628ea629b0f2c049f', kind: 'internal', label: 'SoDEX internal pair (long)', since: '2026-10-31',
    why: 'BTC long 908.65525 against an ETH short (~$76M), the exact mirror of its twin account opened in the same millisecond: the two cancel out - one book, not a trade.',
  },
  {
    venue: 'hyperliquid', address: '0xb83de012dba672c76a7dbbbf3e459cb59d7d6e36', kind: 'hedged', label: 'Abraxas Capital (Hedged) #1', since: '2026-10-31',
    why: 'Short-only across ~30 coins at 3-5x: a hedge of holdings elsewhere, no view on the market.',
  },
  {
    venue: 'hyperliquid', address: '0x5b5d51203a0f9079f8aeb098a6523a13f298c060', kind: 'hedged', label: 'Abraxas Capital (Hedged) #2', since: '2026-10-31',
    why: 'Short-only across ~25 coins at 3-5x: a hedge of holdings elsewhere, no view on the market.',
  },
];

const byVenue = new Map<Venue, Set<string>>();
for (const w of EXCLUDED_WALLETS) {
  let s = byVenue.get(w.venue);
  if (!s) { s = new Set(); byVenue.set(w.venue, s); }
  s.add(w.address);
}

/** The excluded addresses of a venue (lower case). */
export const excludedOf = (venue: Venue): ReadonlySet<string> => byVenue.get(venue) ?? new Set();

/** Left out of the cohorts and the heatmap on this venue. */
export function isExcluded(venue: Venue, address: string): boolean {
  return byVenue.get(venue)?.has(address.toLowerCase()) ?? false;
}

/** Left out on any of the venues asked (a netted wallet spans several). */
export function outOfCohorts(venues: readonly Venue[], address: string): boolean {
  return venues.some((v) => isExcluded(v, address));
}

/** By kind, as the tests and the page read them. */
const ofKind = (k: ExcludedKind): Partial<Record<Venue, ReadonlySet<string>>> => {
  const out: Partial<Record<Venue, Set<string>>> = {};
  for (const w of EXCLUDED_WALLETS) if (w.kind === k) (out[w.venue] ??= new Set()).add(w.address);
  return out;
};
export const INTERNAL_WALLETS = ofKind('internal');
export const HEDGED_WALLETS = ofKind('hedged');

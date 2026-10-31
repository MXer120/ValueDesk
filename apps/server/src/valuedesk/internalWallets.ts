/**
 * Venue-internal accounts left out of the cohorts and the liquidation heatmap (owner, 2026-10-31).
 *
 * SoDEX: a mirrored pair - one 908.65525 BTC long, the other 908.65525 BTC short, both 25x cross,
 * opened in the same millisecond (2026-05-15) with consecutive position ids, ~$10.8M equity each.
 * One book, hedged across two accounts: neither side is a trader's bet, yet together they were
 * ~$141M of SoDEX's ~$141M of BTC liquidation levels and drew a solid band on the map.
 *
 * Addresses lower case. The indexer keeps reading them (nothing else changes); they are only
 * not counted: no cohort member, no book in a cohort load, no level on the map.
 */
import type { Venue } from './types.js';

export const INTERNAL_WALLETS: Partial<Record<Venue, ReadonlySet<string>>> = {
  sodex: new Set([
    '0xfd09e83f250b11a9f0efd0daa605e890daf67412',
    '0x296b81e89f8661ab9af6548628ea629b0f2c049f',
  ]),
};

export function isInternal(venue: Venue, address: string): boolean {
  return INTERNAL_WALLETS[venue]?.has(address.toLowerCase()) ?? false;
}

/**
 * Hedged desks: real traders' accounts that only hedge what they hold elsewhere, left out of the
 * cohorts (owner, 2026-10-31) - their perp shorts are no view on the market, and the cohorts are the
 * crowd's positioning. They stay on the liquidation heatmap: a hedge is liquidated like any account.
 *
 * Hyperliquid: Abraxas Capital (Hedged) #1 and #2 (Hyperdash's names), short-only across 25-30
 * coins at 3-5x, ~$1.05B between them on 2026-10-31 - Apex and Extremely profitable read 39% / 33%
 * long with them, 48% / 43% without, as Hyperdash shows those cohorts (it counts them as members
 * but leaves them out of the positioning).
 */
export const HEDGED_WALLETS: Partial<Record<Venue, ReadonlySet<string>>> = {
  hyperliquid: new Set([
    '0xb83de012dba672c76a7dbbbf3e459cb59d7d6e36',
    '0x5b5d51203a0f9079f8aeb098a6523a13f298c060',
  ]),
};

/** Not in the cohorts: a venue's own account, or a hedged desk, on any of the venues asked. */
export function outOfCohorts(venues: readonly Venue[], address: string): boolean {
  const a = address.toLowerCase();
  return venues.some((v) => (INTERNAL_WALLETS[v]?.has(a) ?? false) || (HEDGED_WALLETS[v]?.has(a) ?? false));
}

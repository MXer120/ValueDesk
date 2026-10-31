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

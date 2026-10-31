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
 *   mirror    accounts that hold the exact opposite of a twin (to within 1.5%): together they hold
 *             nothing. Arcus: 17 pairs (SPY / QQQ, some BTC / ETH legs), ~$21.6M a side, ~18% of
 *             Arcus's open interest - one twin "profitable", the other "unprofitable", tilting both
 *             cohorts (found by the audit of 2026-10-31; the 11 looser matches, 3-6% apart, stay in).
 *
 * Addresses lower case. The indexer keeps reading them (nothing else changes): they are only not
 * counted - no cohort member, no book in a cohort load, no level on the map - and what they hold is
 * taken off the venue's open interest the map's coverage is measured against (read.ts internalOiNow).
 */
import type { Venue } from './types.js';

export type ExcludedKind = 'internal' | 'hedged' | 'mirror';

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
  // The same desks on trade.xyz (Hyperliquid's HIP-3 dex: the same addresses, GOLD / SILVER shorts): exclusion is per venue.
  {
    venue: 'tradexyz', address: '0xb83de012dba672c76a7dbbbf3e459cb59d7d6e36', kind: 'hedged', label: 'Abraxas Capital (Hedged) #1', since: '2026-10-31',
    why: 'Its trade.xyz shorts (gold, silver) are the same hedging desk: no view on the market.',
  },
  {
    venue: 'tradexyz', address: '0x5b5d51203a0f9079f8aeb098a6523a13f298c060', kind: 'hedged', label: 'Abraxas Capital (Hedged) #2', since: '2026-10-31',
    why: 'Its trade.xyz shorts (gold, silver) are the same hedging desk: no view on the market.',
  },
  { venue: 'arcus', address: '0x22d136b14e1990e75c8b2a568c0e23de8d65de29', kind: 'mirror', label: 'Arcus mirrored pair', since: '2026-10-31', why: 'Holds the exact opposite of 0x533f…896e (~$3.22M a side): together the two hold nothing.' },
  { venue: 'arcus', address: '0x533f9ef05bd2bd1afa2c26a07e4ec85a598b896e', kind: 'mirror', label: 'Arcus mirrored pair', since: '2026-10-31', why: 'Holds the exact opposite of 0x22d1…de29 (~$3.22M a side): together the two hold nothing.' },
  { venue: 'arcus', address: '0x03d0413f1bba1be09701cd95f150b8853f358600', kind: 'mirror', label: 'Arcus mirrored pair', since: '2026-10-31', why: 'Holds the exact opposite of 0x6e86…12ac (~$3.14M a side): together the two hold nothing.' },
  { venue: 'arcus', address: '0x6e86aca5bbbed045bf6c3a6e14967e43e34212ac', kind: 'mirror', label: 'Arcus mirrored pair', since: '2026-10-31', why: 'Holds the exact opposite of 0x03d0…8600 (~$3.14M a side): together the two hold nothing.' },
  { venue: 'arcus', address: '0x37e231f138ffcbc5a267c173fc1dab2d8d4779bb', kind: 'mirror', label: 'Arcus mirrored pair', since: '2026-10-31', why: 'Holds the exact opposite of 0x2a30…16c7 (~$2.35M a side): together the two hold nothing.' },
  { venue: 'arcus', address: '0x2a305e0aeccb1a83cfe74872febba7cb842616c7', kind: 'mirror', label: 'Arcus mirrored pair', since: '2026-10-31', why: 'Holds the exact opposite of 0x37e2…79bb (~$2.35M a side): together the two hold nothing.' },
  { venue: 'arcus', address: '0x64987169e4ca6b9a833ab6325f251cf75f862532', kind: 'mirror', label: 'Arcus mirrored pair', since: '2026-10-31', why: 'Holds the exact opposite of 0x590e…f56b (~$1.5M a side): together the two hold nothing.' },
  { venue: 'arcus', address: '0x590e9c550e59774412eabb991ec013669af8f56b', kind: 'mirror', label: 'Arcus mirrored pair', since: '2026-10-31', why: 'Holds the exact opposite of 0x6498…2532 (~$1.5M a side): together the two hold nothing.' },
  { venue: 'arcus', address: '0xb41f42f94fe818024c80ff2c3f6b613805e806e6', kind: 'mirror', label: 'Arcus mirrored pair', since: '2026-10-31', why: 'Holds the exact opposite of 0x4613…4218 (~$1.39M a side): together the two hold nothing.' },
  { venue: 'arcus', address: '0x461385e082ea8784380769bdbdf5ad84da714218', kind: 'mirror', label: 'Arcus mirrored pair', since: '2026-10-31', why: 'Holds the exact opposite of 0xb41f…06e6 (~$1.39M a side): together the two hold nothing.' },
  { venue: 'arcus', address: '0xd2f8fba96b45d9ff2e2ec816f4b0cfb002d478ac', kind: 'mirror', label: 'Arcus mirrored pair', since: '2026-10-31', why: 'Holds the exact opposite of 0x1304…8804 (~$1.29M a side): together the two hold nothing.' },
  { venue: 'arcus', address: '0x13049940163d35ed4ea694b2147cecac155b8804', kind: 'mirror', label: 'Arcus mirrored pair', since: '2026-10-31', why: 'Holds the exact opposite of 0xd2f8…78ac (~$1.29M a side): together the two hold nothing.' },
  { venue: 'arcus', address: '0xb11bce73e65f1a833b8b2b18db07da61d18386e7', kind: 'mirror', label: 'Arcus mirrored pair', since: '2026-10-31', why: 'Holds the exact opposite of 0x70e4…b1a8 (~$1.14M a side): together the two hold nothing.' },
  { venue: 'arcus', address: '0x70e4b60a7f08bd745353d834cc8993b345efb1a8', kind: 'mirror', label: 'Arcus mirrored pair', since: '2026-10-31', why: 'Holds the exact opposite of 0xb11b…86e7 (~$1.14M a side): together the two hold nothing.' },
  { venue: 'arcus', address: '0x1119c4ce8f56d96a51b5a38260fede037c7126f5', kind: 'mirror', label: 'Arcus mirrored pair', since: '2026-10-31', why: 'Holds the exact opposite of 0x42dd…41a8 (~$1.16M a side): together the two hold nothing.' },
  { venue: 'arcus', address: '0x42dd6252b9be3dad03220e8f730c300564d741a8', kind: 'mirror', label: 'Arcus mirrored pair', since: '2026-10-31', why: 'Holds the exact opposite of 0x1119…26f5 (~$1.16M a side): together the two hold nothing.' },
  { venue: 'arcus', address: '0xd9ad74f0102dc4d87ad091482eea7412bee017a1', kind: 'mirror', label: 'Arcus mirrored pair', since: '2026-10-31', why: 'Holds the exact opposite of 0xd98d…46e0 (~$1.09M a side): together the two hold nothing.' },
  { venue: 'arcus', address: '0xd98dd8aab4b19bd59ac743222fa5cbf0f9ec46e0', kind: 'mirror', label: 'Arcus mirrored pair', since: '2026-10-31', why: 'Holds the exact opposite of 0xd9ad…17a1 (~$1.09M a side): together the two hold nothing.' },
  { venue: 'arcus', address: '0x92a118a8e6ba9045192cad095bea956230dd3212', kind: 'mirror', label: 'Arcus mirrored pair', since: '2026-10-31', why: 'Holds the exact opposite of 0x1782…e8a1 (~$1.02M a side): together the two hold nothing.' },
  { venue: 'arcus', address: '0x17826e6fbdff13b2ab252d7d9ce27c90b918e8a1', kind: 'mirror', label: 'Arcus mirrored pair', since: '2026-10-31', why: 'Holds the exact opposite of 0x92a1…3212 (~$1.02M a side): together the two hold nothing.' },
  { venue: 'arcus', address: '0xbd8a4f1170abd4fcb3422d60ea1d005eb2bddcf1', kind: 'mirror', label: 'Arcus mirrored pair', since: '2026-10-31', why: 'Holds the exact opposite of 0x52a4…ebed (~$1.01M a side): together the two hold nothing.' },
  { venue: 'arcus', address: '0x52a435666e5090a837a4fc9fb784b922a1e8ebed', kind: 'mirror', label: 'Arcus mirrored pair', since: '2026-10-31', why: 'Holds the exact opposite of 0xbd8a…dcf1 (~$1.01M a side): together the two hold nothing.' },
  { venue: 'arcus', address: '0x54495c3bc5a8edc4ba8dcf9124a114997a8b633c', kind: 'mirror', label: 'Arcus mirrored pair', since: '2026-10-31', why: 'Holds the exact opposite of 0x1ce0…cbb5 (~$0.69M a side): together the two hold nothing.' },
  { venue: 'arcus', address: '0x1ce04ca03aacf0bf189fdb79f249e5d2434bcbb5', kind: 'mirror', label: 'Arcus mirrored pair', since: '2026-10-31', why: 'Holds the exact opposite of 0x5449…633c (~$0.69M a side): together the two hold nothing.' },
  { venue: 'arcus', address: '0x34531f66064c9a521f2de161c6be087242fec3b9', kind: 'mirror', label: 'Arcus mirrored pair', since: '2026-10-31', why: 'Holds the exact opposite of 0xb3b8…7f83 (~$0.67M a side): together the two hold nothing.' },
  { venue: 'arcus', address: '0xb3b8a9635311763a1eeabef025cc8dd266417f83', kind: 'mirror', label: 'Arcus mirrored pair', since: '2026-10-31', why: 'Holds the exact opposite of 0x3453…c3b9 (~$0.67M a side): together the two hold nothing.' },
  { venue: 'arcus', address: '0xf823309064b512b843c441389209aa03812f45c7', kind: 'mirror', label: 'Arcus mirrored pair', since: '2026-10-31', why: 'Holds the exact opposite of 0xa45e…a61a (~$0.62M a side): together the two hold nothing.' },
  { venue: 'arcus', address: '0xa45ed6971f6e009740736acf0fcdc603983ba61a', kind: 'mirror', label: 'Arcus mirrored pair', since: '2026-10-31', why: 'Holds the exact opposite of 0xf823…45c7 (~$0.62M a side): together the two hold nothing.' },
  { venue: 'arcus', address: '0x5e816f72995a1f2b116e8e4bf3d0d9a3fb2b95ac', kind: 'mirror', label: 'Arcus mirrored pair', since: '2026-10-31', why: 'Holds the exact opposite of 0x3efd…2660 (~$0.5M a side): together the two hold nothing.' },
  { venue: 'arcus', address: '0x3efd5cdb46c700481f40058341aa220ac2552660', kind: 'mirror', label: 'Arcus mirrored pair', since: '2026-10-31', why: 'Holds the exact opposite of 0x5e81…95ac (~$0.5M a side): together the two hold nothing.' },
  { venue: 'arcus', address: '0x671552297f88b735ad204ca9773790aa30c6307d', kind: 'mirror', label: 'Arcus mirrored pair', since: '2026-10-31', why: 'Holds the exact opposite of 0xf58d…61a0 (~$0.44M a side): together the two hold nothing.' },
  { venue: 'arcus', address: '0xf58d3b225ae7e8cf60d7f46eb2b76916a81261a0', kind: 'mirror', label: 'Arcus mirrored pair', since: '2026-10-31', why: 'Holds the exact opposite of 0x6715…307d (~$0.44M a side): together the two hold nothing.' },
  { venue: 'arcus', address: '0x5da0dff3d9679b2d0da5b2478edc51d333a45dcf', kind: 'mirror', label: 'Arcus mirrored pair', since: '2026-10-31', why: 'Holds the exact opposite of 0xeee1…c711 (~$0.37M a side): together the two hold nothing.' },
  { venue: 'arcus', address: '0xeee1d7fc84aca8c00d1d9c2fb58862c6f85fc711', kind: 'mirror', label: 'Arcus mirrored pair', since: '2026-10-31', why: 'Holds the exact opposite of 0x5da0…5dcf (~$0.37M a side): together the two hold nothing.' },
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

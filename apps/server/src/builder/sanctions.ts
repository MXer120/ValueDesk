/**
 * Sanctions screening of wallet addresses, the API's copy:
 * packages/copy-engine/src/sanctions.ts explains it (the list, its source, how
 * it is refreshed). Everything below the marker is that file's, character for
 * character, and sanctionsList.ts here is the engine's (test/sanctions.test.ts
 * checks both); the API does not import the package, so its release neither
 * ships nor restarts on it. Used where the API signs something a wallet trades
 * on: the builder fee terms (routes/builder.ts).
 */
import { SANCTIONED_ADDRESSES } from './sanctionsList.js';

export { SANCTIONS_LIST_META } from './sanctionsList.js';

// ---- shared with apps/server/src/builder/sanctions.ts below this line ----

const LISTED: ReadonlySet<string> = new Set(SANCTIONED_ADDRESSES.map((a) => a.toLowerCase()));
/** Tests only: addresses listed on top (a test cannot sign for a listed wallet). Never fewer than the list. */
const EXTRA = new Set<string>();

/** Whether `address` (any case, 0x and 40 hex) is on the sanctions list. Anything that is not an address: false. */
export function isSanctionedAddress(address: unknown): boolean {
  if (typeof address !== 'string') return false;
  const a = address.trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(a) && (LISTED.has(a) || EXTRA.has(a));
}

/** For tests: treat these addresses as listed too (until _resetSanctionsForTests). */
export function _sanctionForTests(...addresses: string[]): void {
  for (const a of addresses) EXTRA.add(a.toLowerCase());
}

/** For tests: only the list again. */
export function _resetSanctionsForTests(): void {
  EXTRA.clear();
}

/** The position in `addresses` of the first listed one, or null. */
export function sanctionedOf(addresses: ReadonlyArray<string | null | undefined>): number | null {
  const i = addresses.findIndex((a) => isSanctionedAddress(a));
  return i < 0 ? null : i;
}

/** The reason shown for a listed wallet. */
export const SANCTIONED_WALLET_REASON =
  'This wallet address is on a sanctions list, so ValueDesk cannot be used with it. If you believe this is a mistake, contact us at the address in the Impressum.';

/** The reason shown for a copy of a listed trader. */
export const SANCTIONED_LEADER_REASON =
  'This trader\'s wallet address is on a sanctions list, so it cannot be copied through ValueDesk.';

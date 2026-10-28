/**
 * Legal text the app shows outside the legal pages, so it may hold no
 * placeholder. The owner did not want a risk line in every panel (2026-10-24):
 * the risks are accepted in the terms popup (LegalGate.tsx), linked in the
 * footer, and copy trading signs its own; what is left here is the consent
 * text a player needs before it may load.
 */

import { closeOnlyPlaceName, type SiteAccess } from './jurisdictions.mjs';

/**
 * The one-line strip at the very top of the app (LegalGate.tsx RegionBanner),
 * on every page, not dismissible, wherever ValueDesk is restricted for the
 * visitor: close-only (by the country seen or the one a wallet signed for), or
 * the country could not be told (nothing opens then, legal/geo.ts). null: no
 * strip. A blocked place never mounts the app (SiteGate shows its own notice).
 */
export function regionBannerText(access: SiteAccess, located: boolean): string | null {
  if (access.level === 'blocked') return access.reason;
  if (access.level === 'close-only') {
    const place = closeOnlyPlaceName(access.country) ?? access.place ?? 'your region';
    return `ValueDesk is close-only in ${place}: you can close positions, cancel orders and withdraw, but not open new positions.`;
  }
  if (!located) return 'ValueDesk could not tell your country from your connection, so it is close-only for now: you can close positions, cancel orders and withdraw.';
  return null;
}

/** The Live Feed's consent card, before a platform's player may load (legal/embeds.ts). */
export const EMBED_NOTICE = (platform: string, operator: string): string =>
  `This stream plays in ${platform}'s own player. Loading it sends your IP address and this page's address to ${operator}, which may store cookies on your device and use them under its own privacy policy, including for advertising and with transfers to the United States.`;

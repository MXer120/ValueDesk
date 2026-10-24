/**
 * Legal text the app shows outside the legal pages, so it may hold no
 * placeholder. The owner did not want a risk line in every panel (2026-10-24):
 * the risks are accepted in the terms popup (LegalGate.tsx), linked in the
 * footer, and copy trading signs its own; what is left here is the consent
 * text a player needs before it may load.
 */

/** The Live Feed's consent card, before a platform's player may load (legal/embeds.ts). */
export const EMBED_NOTICE = (platform: string, operator: string): string =>
  `This stream plays in ${platform}'s own player. Loading it sends your IP address and this page's address to ${operator}, which may store cookies on your device and use them under its own privacy policy, including for advertising and with transfers to the United States.`;

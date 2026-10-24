/**
 * The short legal notices the app shows where they matter - one line each, in
 * the panel's own muted type (LegalNote, LegalGate.tsx), never a banner. Shown
 * outside the legal pages, so they may hold no placeholder (docs.test.ts).
 * What each refers to is set out in full in the linked page.
 */
import type { LegalPage } from '../router';

export interface LegalNotice {
  text: string;
  /** The page that says it in full, and the link's words. */
  page: LegalPage;
  label: string;
}

export const NOTICES = {
  /** The order ticket, under the read-out. */
  trade: { text: 'High risk: with leverage you can lose your whole margin within minutes. Not advice.', page: 'risk', label: 'Risk disclosure' },
  /** The order ticket while an algo is chosen. */
  algo: { text: 'Algo orders act on their own and can fill late, partly, at worse prices or not at all. Not advice.', page: 'risk', label: 'Risks' },
  /** The News widget, at its foot. */
  news: { text: 'Third-party news from SoSoValue and its sources, shown as received: not checked or endorsed by ValueDesk, and not advice.', page: 'terms', label: 'Terms' },
  /** Leaderboards, Explore, the screener, Scan. */
  data: { text: 'Computed from public venue data, which can be delayed, incomplete or wrong. Rankings are not recommendations, and past results do not predict future ones.', page: 'risk', label: 'Risks' },
  /** Copy trading: the trader lists and cards. */
  copy: { text: 'Copying can lose you your whole allocation and more. No trader here is recommended, and past results do not predict future ones.', page: 'copy-terms', label: 'Copy terms' },
} as const satisfies Record<string, LegalNotice>;

export type NoticeId = keyof typeof NOTICES;

/** The Live Feed's consent card, before a platform's player may load (legal/embeds.ts). */
export const EMBED_NOTICE = (platform: string, operator: string): string =>
  `This stream plays in ${platform}'s own player. Loading it sends your IP address and this page's address to ${operator}, which may store cookies on your device and use them under its own privacy policy, including for advertising and with transfers to the United States.`;

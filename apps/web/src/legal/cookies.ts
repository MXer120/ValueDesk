/**
 * Cookies and storage - the notice § 25 TDDDG and Art. 13 GDPR ask for, in
 * one place. DRAFT for the owner (the date; see model.ts).
 *
 * The facts, as of 2026-10-24 (privacy.ts section 6 says the same in short):
 *   - no document.cookie anywhere in the app, no analytics, no advertising;
 *   - every entry the app writes to localStorage / sessionStorage / IndexedDB
 *     has a name that starts with "vs", "vd" or "valuescan" (a grep over
 *     apps/web/src); the trading key vault, the browser copier and the browser
 *     algos are the three IndexedDB databases (trading/vault.ts,
 *     copy/browserStore.ts, algo/algoStore.ts);
 *   - Reown / WalletConnect keeps its pairing in this browser's storage once a
 *     wallet is connected through it (walletconnect.ts);
 *   - the Live Feed's players (YouTube, Twitch, Kick, Vimeo) load only after the
 *     visitor allows them ("Accept all" in the terms popup, LegalGate.tsx, or one
 *     platform in the widget: legal/embeds.ts, LiveFeed.tsx), and can be
 *     turned off again on this page (LegalView renders the switches under the
 *     "Third-party players" section).
 */
import type { LegalDoc } from './model';

/** The section LegalView puts the player switches under. */
export const EMBED_SECTION_TITLE = '3. Third-party players in the Live Feed';

export const COOKIES: LegalDoc = {
  page: 'cookies',
  title: 'Cookies and storage',
  lang: 'en',
  updated: '[[OWNER: date, e.g. 1 November 2026]]',
  intro: [
    { p: 'In short: ValueDesk sets no cookies of its own and uses no analytics, advertising or tracking. It keeps what its functions need in your browser\'s own storage, on your device. Third-party video players load only after you allow them. Details on all personal data: [Privacy policy](/privacy).' },
  ],
  sections: [
    {
      title: '1. No cookies, no tracking',
      blocks: [
        {
          ul: [
            'ValueDesk itself sets no cookies - neither on this site nor through its servers.',
            'There is no analytics, no advertising, no tracking pixel, no fingerprinting and no social media plugin, and no data is sold or shared for advertising.',
            'ValueDesk\'s servers do not recognise you from one visit to the next: there are no accounts and no identifiers we hand out.',
          ],
        },
      ],
    },
    {
      title: '2. Storage in your browser that the site needs',
      blocks: [
        { p: 'So that the functions you use keep working between visits, ValueDesk stores the following in your browser (local storage, session storage and IndexedDB). It stays on your device; ValueDesk\'s servers never read it. Every entry\'s name starts with "vs", "vd" or "valuescan".' },
        {
          ul: [
            '**Your choices:** layouts, dashboards, chart settings and drawings, the selected market, filters, the privacy mode, the Live Feed channel and the players you allowed (section 3), notices you have seen.',
            '**Your acceptance of the terms:** the version and fingerprint of the terms you accepted and when, and - once your wallet has signed them - that signature with the country of residence you declared ([Terms of use](/terms), section 2).',
            '**Lists you keep:** watchlist, recent searches and traders, names you gave addresses, a log of your own transfers.',
            '**Copies of public data, for speed:** the trading history of wallets you looked at and statistics built from it.',
            '**Your wallet connection:** the connected address and, if you connect through WalletConnect, its session (kept by Reown\'s software in this browser).',
            '**Trading, algo orders and copy trading in this browser:** the trading key and the copy key, each encrypted with a key your browser generates and cannot export, valid for at most seven days; your algo orders and copy rules, their state and their activity log.',
            '**For the current tab only:** a deposit or withdrawal in progress, diagnostic settings, a session with ValueDesk\'s copy executor.',
          ],
        },
        { p: 'Legal basis: § 25(2) no. 2 TDDDG - this storage is strictly necessary to provide the functions you ask for, so it needs no consent - and, for any personal data in it, Art. 6(1)(b) and (f) GDPR.' },
      ],
    },
    {
      title: '3. Third-party players in the Live Feed',
      blocks: [
        { p: 'The Live Feed widget plays live streams and videos in the platform\'s own player: YouTube (Google Ireland Ltd., Gordon House, Barrow Street, Dublin 4, Ireland), Twitch (Twitch Interactive, Inc.), Kick and Vimeo. A player is loaded only after you allow it: all four at once with "Accept all" in the terms window (next to "Only necessary", which loads none and changes nothing else), or one platform at a time in the widget. Nothing is allowed in advance, and the terms do not depend on this choice. When it loads, the platform receives your IP address, the page it is embedded in and the technical details of your browser, and it may store cookies or similar information on your device and use them under its own privacy policy - including, for some of them, to recognise you and for advertising, and with transfers to the United States.' },
        { p: 'Legal basis: your consent (§ 25(1) TDDDG, Art. 6(1)(a) GDPR). You can withdraw it at any time, with effect for the future, with the switches below: the player is then no longer loaded until you allow it again. What a platform has already stored can be deleted in your browser\'s settings; what it does with your data is explained in its own privacy policy.' },
      ],
    },
    {
      title: '4. Other services your browser connects to',
      blocks: [
        { p: 'Market data, your account and your orders come straight from SoDEX, Hyperliquid, Lighter, Arcus and public blockchain nodes; your wallet connects through its extension or Reown / WalletConnect. These connections set no cookies on this site, but each service receives your IP address. Which services, and why: [Privacy policy](/privacy), section 5.' },
      ],
    },
    {
      title: '5. Deleting it',
      blocks: [
        { p: 'You can delete everything ValueDesk keeps in your browser at any time by clearing this site\'s data in your browser\'s settings. Settings, lists and keys are then gone from this device; your funds are not affected, because they stay in your wallet and your SoDEX account. Signing out removes the trading key at once.' },
      ],
    },
  ],
};

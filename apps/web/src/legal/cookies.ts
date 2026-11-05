/**
 * Cookies and storage - the notice § 25 TDDDG and Art. 13 GDPR ask for, in
 * one place. DRAFT for the owner (the date; see model.ts).
 *
 * The facts, as of 2026-10-24 (privacy.ts section 6 says the same in short):
 *   - no document.cookie anywhere in the app, no advertising, no third-party
 *     analytics; ValueDesk's own usage analytics only with consent (section 5,
 *     legal/analyticsConsent.ts, analytics/usage.ts - owner, 2026-10-31);
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
/** The section LegalView puts the Reown switch under (reownConsent.ts). */
export const REOWN_SECTION_TITLE = '4. Usage reports to Reown when you connect a wallet';
/** The section LegalView puts the analytics switch under (analyticsConsent.ts). */
export const ANALYTICS_SECTION_TITLE = '5. ValueDesk\'s own usage analytics, with your consent';

export const COOKIES: LegalDoc = {
  page: 'cookies',
  title: 'Cookies and storage',
  lang: 'en',
  updated: '[[OWNER: date, e.g. 1 November 2026]]',
  intro: [
    { p: 'In short: ValueDesk sets no cookies of its own, uses no advertising and no third-party tracking. It keeps what its functions need in your browser\'s own storage, on your device. ValueDesk\'s own usage analytics - kept on its own server, shared with no one - third-party video players, and the usage reports Reown\'s wallet software sends when you connect a wallet, only run after you allow them. Details on all personal data: [Privacy policy](/privacy).' },
  ],
  sections: [
    {
      title: '1. No cookies of our own, no third-party tracking',
      blocks: [
        {
          ul: [
            'ValueDesk itself sets no cookies - neither on this site nor through its servers.',
            'There is no advertising, no tracking pixel, no fingerprinting, no social media plugin and no analytics service of a third party, and no data is sold or shared for advertising. ValueDesk measures how its site is used only if you allow it, on its own server (section 5). The one third-party usage report - Reown\'s, when you connect a wallet - is sent only with your consent (section 4).',
            'Without your consent to analytics, ValueDesk\'s servers do not recognise you from one visit to the next: there are no accounts. The only identifiers they hand out are the sign-in tokens your wallet\'s signature obtains for the copy executor and the feedback chat, each of which your browser sends only to the service it belongs to (section 2). With it, a random visitor number in your browser tells a returning visitor (section 5).',
          ],
        },
      ],
    },
    {
      title: '2. Storage in your browser that the site needs',
      blocks: [
        { p: 'So that the functions you use keep working between visits, ValueDesk stores the following in your browser (local storage, session storage and IndexedDB). It stays on your device; ValueDesk\'s servers read only the sign-in tokens above. Most of ValueDesk\'s own entries are named "vs…", "vd…" or "valuescan…" (a few older ones "ot…", "opentrade…" or "scan-aliases"); once you connect a wallet, Reown\'s software adds its own, named "@appkit…" and "wc@2…".' },
        {
          ul: [
            '**Your choices:** layouts, dashboards, chart settings and drawings, the selected market, filters, the privacy mode, the Live Feed channel and the players you allowed (section 3), notices you have seen.',
            '**Your acceptance of the terms:** the version and fingerprint of the terms you accepted and when, and - once your wallet has signed them - that signature with the country of residence you declared ([Terms of use](/terms), section 2).',
            '**Lists you keep:** watchlist, recent searches and traders, names you gave addresses, a log of your own transfers.',
            '**Copies of public data, for speed:** the trading history of wallets you looked at and statistics built from it.',
            '**Your wallet connection:** the connected address and, if you connect through WalletConnect, its session (kept by Reown\'s software in this browser).',
            '**Trading, algo orders and copy trading in this browser:** the trading key and the copy key, each encrypted with a key your browser generates and cannot export, valid for at most seven days; your algo orders and copy rules, their state and their activity log.',
            '**For the current tab only:** a deposit or withdrawal in progress, diagnostic settings, a session with ValueDesk\'s copy executor.',
            '**Your consent choices:** whether you allowed ValueDesk\'s usage analytics, Reown\'s usage reports and each video player, and when. With analytics allowed, also its visitor and visit numbers (section 5) - those need your consent and are deleted when you withdraw it.',
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
      title: '4. Usage reports to Reown when you connect a wallet',
      blocks: [
        { p: 'Wallets connect through Reown\'s software (Reown AppKit and WalletConnect, Reown, Inc., USA). It reports to Reown (pulse.walletconnect.org) that it has started and that a wallet has connected - with the wallet\'s address and network, the address of the page you are on, your IP address and technical details of your browser - and sends Reown error reports with the page address. Reown uses them to count and improve the use of its wallet connection, under its own [privacy policy](https://reown.com/privacy-policy); data goes to the United States on the basis of standard contractual clauses.' },
        { p: 'These reports are sent only if you allow them - with "Accept all" in the terms window, or with the switch below - and are blocked in your browser otherwise; connecting a wallet works either way. Legal basis: your consent (§ 25(1) TDDDG, Art. 6(1)(a) GDPR), which you can withdraw at any time with effect for the future.' },
      ],
    },
    {
      title: ANALYTICS_SECTION_TITLE,
      blocks: [
        { p: 'If you allow it - with "Accept all" in the terms window, with "Allow" when the site asks you once (if you accepted the terms before it measured anything), or with the switch below - ValueDesk measures how its site is used, to learn which features help you and where people get stuck. It runs on ValueDesk\'s own server only (Contabo, France, reached through ValueDesk\'s function at Vercel); no analytics company, advertising network or other third party receives it. What is recorded:' },
        {
          ul: [
            'the pages you open - the page\'s path only, with wallet addresses and other identifiers in it replaced, and no search terms - and how long each page is visible;',
            'which features you use, by name - for example "placed an order", "started an algo order", "opened deposit" - with a few words of detail such as the venue or the kind of algo, never amounts, prices, wallet addresses or anything you type;',
            'where a visit came from: the domain of the site that linked to ValueDesk, the campaign tags of the link (utm_source, utm_medium, utm_campaign) and the first page you opened;',
            'your country and region, as Vercel determines them from your IP address for the regional rules ([Privacy policy](/privacy), section 3); your IP address itself is not stored for analytics;',
            'the type of device (desktop, tablet, phone), the screen size, the browser and operating system with their main version, the language, the time zone and the colour theme;',
            'how fast pages load and respond, as your browser measures it;',
            'the address of a wallet you connect, so that how you use ValueDesk can be seen beside the trading volume and builder fees ValueDesk counts for that wallet anyway ([Privacy policy](/privacy), section 7);',
            'a random visitor number kept in your browser (local storage, "vd.an.v1", replaced by a new one after 13 months) to tell new from returning visitors, and a random number for the current visit (session storage, "vd.an.visit"), which ends with the tab or after 30 minutes without use.',
          ],
        },
        { p: 'Not recorded: your IP address, cookies, what you type, the contents of forms, mouse movements, recordings of your screen, and anything about other websites. Only the operator of ValueDesk can see the data. It is kept [[OWNER: how long analytics data is kept, e.g. 25 months - nothing is deleted automatically until this is set]].' },
        { p: 'Legal basis: your consent (§ 25(1) TDDDG for the visitor number in your browser and for reading the details above, Art. 6(1)(a) GDPR for the processing). Without it nothing is measured, and the site works the same. You can withdraw it at any time with the switch below, with effect for the future: nothing more is sent, and the visitor number is deleted from your browser. Details: [Privacy policy](/privacy), section 12.' },
      ],
    },
    {
      title: '6. Other services your browser connects to',
      blocks: [
        { p: 'Market data, your account and your orders come straight from SoDEX, Hyperliquid, Lighter, Arcus and public blockchain nodes; your wallet connects through its extension or Reown / WalletConnect. These connections set no cookies on this site, but each service receives your IP address. Which services, and why: [Privacy policy](/privacy), section 8.' },
      ],
    },
    {
      title: '7. Deleting it',
      blocks: [
        { p: 'You can delete everything ValueDesk keeps in your browser at any time by clearing this site\'s data in your browser\'s settings. Settings, lists and keys are then gone from this device; your funds are not affected, because they stay in your wallet and your SoDEX account. Signing out removes the trading key at once.' },
      ],
    },
  ],
};

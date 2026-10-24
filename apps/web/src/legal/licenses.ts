/**
 * Licences and notices (/licenses): what the software, data and logos the site
 * uses ask to be said, in one place the footer links.
 *
 *   - the open-source packages in the build, in full: the build writes
 *     /third-party-licenses.txt from what is actually bundled
 *     (tools/licenses.mjs), so this page never lists packages by hand;
 *   - Reown's licence (AppKit, WalletConnect) asks for its notice in "the about
 *     section of the website": section 1, word for word;
 *   - the fonts' SIL Open Font License, the copier's MIT licence;
 *   - where data, news and streams come from, and the trademark notice.
 *
 * The audit behind it: docs/legal/TECH-AUDIT.md. Not hashed into the terms'
 * fingerprint: changing it asks nobody to accept anything again.
 */
import type { LegalDoc } from './model';

export const LICENSES: LegalDoc = {
  page: 'licenses',
  title: 'Licences and notices',
  lang: 'en',
  updated: '[[OWNER: date, e.g. 1 November 2026]]',
  intro: [
    { p: 'ValueDesk is built on open-source software and shows data, news and logos from others. This page says under which licences, and gives the notices they ask for.' },
  ],
  sections: [
    {
      title: '1. Open-source software',
      blocks: [
        { p: 'The web app contains open-source packages, each used under its own licence. The complete list, with every package\'s licence and copyright notice, is generated with each build: [third-party-licenses.txt](/third-party-licenses.txt).' },
        {
          ul: [
            '**Reown AppKit and WalletConnect** (wallet connection), under the Reown Community License and the WalletConnect Community License. Portions © 2025 Reown, Inc. All Rights Reserved. The licences\' full text is in the file above.',
            '**Fonts:** Asap, IBM Plex Sans and Space Grotesk, under the SIL Open Font License 1.1, served from this site.',
            '**Charts:** KLineChart, under the Apache License 2.0.',
            '**Everything else** - React, ethers, viem, the noble cryptography libraries and the rest - under the MIT, Apache 2.0, BSD or ISC licences; see the file.',
          ],
        },
        { p: 'The self-hosted copier (/copier/valuedesk-copier.mjs) is published under the MIT licence; the licences of the packages it contains are reproduced at the end of the file.' },
      ],
    },
    {
      title: '2. Data, news and streams',
      blocks: [
        {
          ul: [
            '**Market and account data:** SoDEX (the exchange ValueDesk trades on), and for trader data Hyperliquid, Lighter and Arcus, read from their public interfaces.',
            '**News:** SoSoValue, through its API; each story names and links its source.',
            '**Live streams:** the platforms\' own players (YouTube, Twitch, Kick, Vimeo), loaded only with your consent ([Cookies](/cookies), section 3).',
          ],
        },
        { p: 'This content belongs to its providers and is shown as received ([Terms of use](/terms)).' },
      ],
    },
    {
      title: '3. Trademarks and logos',
      blocks: [
        { p: 'Names, logos and other marks of cryptoassets, exchanges, networks, wallets, companies and platforms belong to their owners. ValueDesk uses them only to identify the asset, venue or service. This does not mean that the owner endorses, sponsors or is connected with ValueDesk, and it is not a recommendation. Rights holders who object can reach us through the contact details in the [Impressum](/impressum); we will remove the mark promptly.' },
        { p: 'The coin, token, network and venue icons are served from this site. They come from SoDEX and SoSoValue, Hyperliquid, TradingView, CoinGecko, DefiLlama, Google\'s favicon service and the projects\' and companies\' own websites; wallet icons are shown by Reown\'s wallet list. Where an icon is missing, ValueDesk draws a letter instead.' },
      ],
    },
  ],
};

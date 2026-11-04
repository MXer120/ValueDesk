/**
 * Licences and notices (/licenses): what the software, data and logos the site
 * uses ask to be said, in one place the footer links.
 *
 *   - the open-source packages in the build, in full: the build writes
 *     /third-party-licenses.txt from what is actually bundled
 *     (tools/licenses.mjs), so this page never lists packages by hand;
 *   - Reown's licence (AppKit, WalletConnect) asks for its notice in "the about
 *     section of the website": section 1, word for word;
 *   - the fonts' SIL Open Font License, the copier's MIT licence, the speech
 *     model's MIT licence (served next to the model);
 *   - where data, news and streams come from, the notices BLS and BEA ask for,
 *     and the trademark notice with where the icons come from.
 *
 * Not hashed into the terms' fingerprint: changing it asks nobody
 * to accept anything again.
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
            '**Speech recognition** (the Fed live transcript, run in your browser): the Moonshine tiny model, © 2025 Useful Sensors, Inc. (dba Moonshine AI), under the [MIT licence](https://github.com/moonshine-ai/moonshine/blob/main/LICENSE); served from this site, with the licence text beside the model files (/models/onnx-community/moonshine-tiny-ONNX/LICENSE.txt).',
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
            '**Reference prices** for the order tools: one combined price worked out by ValueDesk from the public order books of the exchanges you choose (Binance, Bybit, OKX, Bitget, Coinbase, Kraken, Gate, MEXC, KuCoin, HTX, Deribit, Hyperliquid). No exchange\'s own quotes are passed on.',
            '**News:** SoSoValue, through its API, and the White House (its news and presidential actions); each story names and links its source.',
            '**Economic calendar and figures:** the Federal Reserve Board, the U.S. Bureau of Labor Statistics (BLS), the Bureau of Economic Analysis (BEA), the Census Bureau and the Department of Labor, from their own websites and interfaces; each figure names its agency. BLS.gov cannot vouch for the data or analyses derived from these data after the data have been retrieved from BLS.gov. This product uses the Bureau of Economic Analysis (BEA) Data API but is not endorsed or certified by BEA.',
            '**ETF flows:** SoSoValue.',
            '**Fed live:** the Federal Reserve Board\'s own broadcast (source: Federal Reserve Board), loaded from its video host only with your consent ([Cookies](/cookies)).',
            '**Live streams:** the platforms\' own players (YouTube, Twitch, Kick, Vimeo), loaded only with your consent ([Cookies](/cookies), section 3).',
          ],
        },
        { p: 'This content belongs to its providers and is shown as received ([Terms of use](/terms)). Works of the U.S. government are in the public domain; their agencies do not endorse ValueDesk.' },
      ],
    },
    {
      title: '3. Trademarks and logos',
      blocks: [
        { p: 'Names, logos and other marks of cryptoassets, exchanges, networks, wallets, companies and platforms belong to their owners. ValueDesk uses them only to identify the asset, venue or service. This does not mean that the owner endorses, sponsors or is connected with ValueDesk, and it is not a recommendation. Rights holders who object can reach us through the contact details in the [Impressum](/impressum); we will remove the mark promptly.' },
        { p: 'The coin, token, network, venue and news-source icons are served from this site, unaltered. They come from SoDEX and SoSoValue (with their permission), from Hyperliquid\'s icon set, from the companies\', fund issuers\', projects\', agencies\' and platforms\' own websites (the icon each publishes for its site) or, where a site does not serve it, their own GitHub organisation\'s picture; a few are from the spothq cryptocurrency-icons set (CC0 1.0, public domain dedication) and from Trust Wallet\'s assets repository ([MIT licence](https://github.com/trustwallet/assets/blob/master/LICENSE), © 2019-2023 Trust Wallet). The icons of US federal agencies (the Federal Reserve Board, the SEC, the Department of Labor) only say which agency published a story or a figure; they do not mean that the agency endorses ValueDesk. Wallet icons are shown by Reown\'s wallet list. Where an asset has no icon of its own, ValueDesk shows the mark of the venue it trades on; a contact you saved for a bare address gets a pattern drawn from the address.' },
      ],
    },
  ],
};

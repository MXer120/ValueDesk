/**
 * Privacy policy - DRAFT for the owner to complete (see model.ts for the markers).
 *
 * Built from what the app and the deployment actually do, checked against the
 * code on 2026-10-03 and again on 2026-10-24:
 *   - delivery: Vercel's edge and /api function (deploy/vercel) in front of one
 *     instance in Tokyo (deploy/server) - the CloudFront + WAF design of
 *     deploy/aws is not what serves the site; the API logs the path without the
 *     query and the client address (apps/server/src/index.ts, hosted
 *     serializer), journald keeps 14 days (deploy/server/journald/valuescan.conf);
 *   - the index API (apps/server/src/hosted.ts HOSTED_ROUTES) - some requests
 *     carry a wallet address or search text in the query (leaderboard `q`,
 *     `lbrow?address=`, `builder/terms?address=`, `feed/account?id=`);
 *   - builder fee tiers: per-wallet ledger on the server (docs/BUILDER-TIERS.md
 *     §4-5, apps/server/src/builder/);
 *   - browser-direct hosts: the CSP connect-src in apps/web/index.html;
 *   - Reown / WalletConnect only once a wallet is connected or a session is
 *     restored (walletconnect.ts initWallet), its telemetry dropped;
 *   - no cookies (no document.cookie anywhere), no analytics; storage keys in
 *     localStorage / sessionStorage / IndexedDB as listed below;
 *   - the index holds public trading data of wallets (docs/INDEXER.md);
 *   - since 2026-10-23 the site is delivered by Vercel (deploy/vercel: the edge,
 *     the /api function in hnd1), not CloudFront; the function logs errors with
 *     the path and reason only (api-proxy.cjs) and answers /api/edge/geo itself,
 *     storing nothing; sanctioned places get 451 at the edge (section 3);
 *   - accepting the terms (section 5): legal/acceptance.ts - the first-visit
 *     record stays in the browser, the wallet's signature goes to the executor's
 *     consent log ('accept-site-terms') with the edge's country;
 *   - wallet screening (section 6): legal/screening.ts, an eth_call to the
 *     Chainalysis sanctions oracle through ethereum-rpc.publicnode.com;
 *   - News: the server asks SoSoValue (valuescan/sosovalue), the browser never
 *     does; the Live Feed's players need the visitor's consent (legal/embeds.ts);
 *   - copy trading, as of 2026-10-23 (section 11): the hosted executor's
 *     database (apps/executor/src/db.ts - copies, their state and activity,
 *     sealed keys, accepted terms, the append-only log of signed requests with
 *     the viewer's country); keys sealed with AES-256-GCM under a separate key
 *     file (secrets.ts); the viewer's address used only by the in-memory rate
 *     limiter, the country read from the edge's header (server.ts); activity
 *     older than EXECUTOR_ACTIVITY_DAYS (default 365) deleted (main.ts); the
 *     copy fee tier read from the builder ledger (service.ts volumeOf). The
 *     browser copier keeps its data in IndexedDB (packages/copy-engine/src/
 *     store.ts). Hosting: Vercel (site and /api, Tokyo hnd1) and AWS
 *     ap-northeast-1 (Tokyo).
 * If any of that changes, this text changes with it.
 */
import type { LegalDoc } from './model';

export const PRIVACY: LegalDoc = {
  page: 'privacy',
  title: 'Privacy policy',
  lang: 'en',
  updated: '[[OWNER: date, e.g. 1 November 2026]]',
  intro: [
    { p: 'This policy explains which personal data ValueDesk processes, why, and what your rights are. In short: ValueDesk has no user accounts, sets no cookies and uses no analytics or advertising. It never holds your funds or your wallet\'s keys; only if you use hosted copy trading does its server keep a SoDEX API key for you (section 11). Most of what you see is loaded by your own browser directly from the exchanges and blockchains, not through ValueDesk.' },
  ],
  sections: [
    {
      title: '1. Controller',
      blocks: [
        { p: 'The controller responsible for the processing described here is the provider named in the [Impressum](/impressum). You can reach us for any privacy question at [[OWNER: e-mail address for privacy requests]].' },
        { p: '[[OWNER: if a data protection officer is designated (§ 38 BDSG, Art. 37 GDPR), name and contact details here; otherwise delete this paragraph]]' },
      ],
    },
    {
      title: '2. Visiting the website',
      blocks: [
        { p: 'ValueDesk is delivered by Vercel Inc. (440 N Barranca Ave #4133, Covina, CA 91723, USA): its edge network serves the site from locations close to you, and a Vercel function in Tokyo (region hnd1) forwards requests for ValueDesk\'s own data service to ValueDesk\'s server at Amazon Web Services in Tokyo (region ap-northeast-1). Vercel and AWS process this data on our behalf under their data processing addenda (Art. 28 GDPR). [[OWNER: confirm that Vercel\'s Data Processing Addendum applies to the Vercel team, and the AWS contracting entity of the account and its Data Processing Addendum]]' },
        { p: 'When you open the site, your browser sends your IP address, the address of the page or file requested, and the usual technical information of an HTTP request (for example the browser type and language). This is processed:' },
        {
          ul: [
            'by Vercel, to deliver the site and to protect it against attacks. [[OWNER: what Vercel logs for this project and for how long - its request logs and its firewall - as shown in the project\'s settings]];',
            'by Vercel, to tell which country and region your IP address belongs to (section 3);',
            'by ValueDesk\'s function at Vercel, which passes your IP address to ValueDesk\'s server - so that the server can limit the number of requests per visitor - and logs errors with the path and the reason only, never the address;',
            'by ValueDesk\'s server, for requests to its data service. Its log records the IP address and the path requested, without the query string, and is deleted automatically after 14 days.',
          ],
        },
        { p: 'Legal basis: Art. 6(1)(f) GDPR - our legitimate interest in delivering the site and keeping it secure and available. Vercel\'s edge can serve you from outside the EU, and Vercel and AWS are US companies; Japan, where the function and the server are, has an adequacy decision of the European Commission (Implementing Decision (EU) 2019/419). [[OWNER: confirm the safeguards for the US - Vercel\'s and AWS\'s participation in the EU-U.S. Data Privacy Framework and the EU Standard Contractual Clauses in their data processing addenda]]' },
      ],
    },
    {
      title: '3. Where you are: the regional rules',
      blocks: [
        { p: 'ValueDesk is not available in some countries and regions, and in others it is close-only ([Terms of use](/terms), section 3). To apply these rules, Vercel derives from your IP address the country and the region it belongs to, and:' },
        {
          ul: [
            'refuses every request from a sanctioned country or region before it reaches the site (only the legal pages stay reachable);',
            'answers the app\'s question where you are (/api/edge/geo) with that country and region only. The answer is not stored, not logged and kept only in your open tab;',
            'passes the country - not the address - to ValueDesk\'s executor with requests about copy trading and the terms (sections 5 and 11).',
          ],
        },
        { p: 'Legal basis: Art. 6(1)(c) GDPR - compliance with the sanctions law that binds us (in particular Council Regulations (EU) No 833/2014, 765/2006, 692/2014 and 2022/263) - and Art. 6(1)(f) GDPR - our legitimate interest in offering ValueDesk only where we may. [[OWNER: legal bases to be confirmed by counsel]]' },
      ],
    },
    {
      title: '4. ValueDesk\'s data service',
      blocks: [
        { p: 'Leaderboards, cohorts, the screener, Explore, the News widget and parts of the search come from ValueDesk\'s own server. Some of these requests carry what you entered or opened: a wallet address or search text you typed into the search, the address whose rank Scan shows on Hyperliquid, a SoDEX account number from a link, or the coins and words you filter the News by. They are used only to answer the request; the query part is not written to the server log (section 2).' },
        { p: 'News comes from SoSoValue (SoSoValue\'s news API): ValueDesk\'s server asks SoSoValue for the stories you filter by - the type, the coins and any search words - in its own name. SoSoValue does not receive your IP address. For the Live Feed\'s channels, ValueDesk\'s server finds the stream on air from the channel\'s public YouTube page; that lookup carries nothing about you.' },
        { p: 'Legal basis: Art. 6(1)(f) GDPR - answering the request you made.' },
      ],
    },
    {
      title: '5. Accepting the terms',
      blocks: [
        { p: 'When you accept the [Terms of use](/terms) and the [Risk disclosure](/risk) on your first visit, your browser keeps the version, its fingerprint, the time and the statements you ticked. This record stays in your browser and is not sent to ValueDesk.' },
        { p: 'Before your wallet trades, it signs the terms. ValueDesk\'s executor then keeps, as our record of who accepted which version: your wallet address, the signed message (the terms\' version and fingerprint, the country of residence you declared, the statements), the signature, the time, and the country of your IP address as Vercel reports it (not the IP address itself). It is kept in the executor\'s append-only log of signed requests (section 11), together with the same record in your browser.' },
        { p: 'Purposes and legal bases: entering into the agreement with you (Art. 6(1)(b) GDPR); proving what you accepted and applying the regional rules to your declared country, to establish, exercise or defend legal claims and to comply with sanctions law (Art. 6(1)(f) and (c) GDPR). Retention: [[OWNER: how long acceptance records are kept, e.g. until the end of the N-th year after your last use of ValueDesk (limitation periods)]]. We may refuse to erase them while we need them for legal claims (Art. 17(3)(e) GDPR).' },
      ],
    },
    {
      title: '6. Sanctions screening of wallet addresses',
      blocks: [
        { p: 'When you connect a wallet, the app checks whether its address is on a sanctions list. It asks the Chainalysis sanctions oracle - a public smart contract on the Ethereum blockchain that reflects the addresses on OFAC\'s sanctions list - through the public Ethereum node ethereum-rpc.publicnode.com (section 8), which therefore receives the address and your IP address. The answer is kept in your open tab only and is not sent to ValueDesk. If the address is listed, ValueDesk cannot be used with it.' },
        { p: 'Legal basis: Art. 6(1)(c) and (f) GDPR - complying with sanctions law and not offering ValueDesk to sanctioned persons.' },
      ],
    },
    {
      title: '7. Builder fee and volume tiers',
      blocks: [
        { p: 'This section applies while ValueDesk charges a builder fee with volume tiers (see the [Terms](/terms)).' },
        { p: 'When you enable trading, and from then on every few minutes while it is enabled and shortly after your orders fill, the app sends the address of your connected wallet to ValueDesk\'s data service to learn which fee applies to you. ValueDesk\'s server then reads that wallet\'s trades from SoDEX and the signed requests of the orders behind them from SoDEX\'s public explorer - data that is public on SoDEX - and keeps, for that wallet:' },
        {
          ul: [
            'the trading volume counted towards the fee tiers, and the orders counted;',
            'the fees signed for the wallet over time;',
            'flags for orders that did not carry the fee owed, with the order, the transaction and the signing key as evidence;',
            'the addresses of the trading keys the app registered for the wallet.',
          ],
        },
        { p: 'Purpose: working out the fee you owe and the discount you have earned, and enforcing the fee you agreed to. Legal basis: Art. 6(1)(b) GDPR (the fee terms you accepted by approving the fee) and Art. 6(1)(f) GDPR (preventing the fee from being circumvented). This data is kept [[OWNER: retention period for the fee ledger, e.g. for as long as the volume tiers apply, at most N years]]. We delete a wallet\'s entries on request (section 13).' },
      ],
    },
    {
      title: '8. Direct connections from your browser',
      blocks: [
        { p: 'ValueDesk runs in your browser, and your browser connects to the following services directly - ValueDesk does not see this traffic. Each service receives your IP address and the technical information of the request, and whatever the request is about: market data, the wallet addresses you connect or look at, and - when you trade - the orders and transfers you sign. They are operated by third parties under their own terms and privacy policies.' },
        {
          ul: [
            '**SoDEX** (mainnet-gw.sodex.dev, mainnet-data.sodex.dev, alpha-biz.sodex.dev, and the testnet hosts testnet-gw.sodex.dev and testnet-data.sodex.dev): market data, your account, orders, deposits, transfers and withdrawals - and, when you copy trades in browser mode, the leader\'s trades and your copied orders.',
            '**Hyperliquid** (api.hyperliquid.xyz, also for trade.xyz), **Lighter** (mainnet.zklighter.elliot.ai) and **Arcus** (api.arcus.xyz): trader data for Scan and the search, and the trades of a Hyperliquid leader you copy in browser mode.',
            '**ValueChain** (rpc.valuechain.xyz and the explorer main-scan.valuechain.xyz) and public RPC endpoints of Arbitrum (arb1.arbitrum.io), Base (mainnet.base.org), Ethereum (ethereum-rpc.publicnode.com), BNB Chain (bsc-dataseed.bnbchain.org) and Polygon (polygon-bor-rpc.publicnode.com, and polygon.drpc.org or 1rpc.io when it does not answer): read-only - the balances of your connected wallet and the status of your deposits and withdrawals.',
            '**Reown / WalletConnect** (relay.walletconnect.org, api.web3modal.org, verify.walletconnect.org): only once you connect a wallet, or a connection from an earlier visit is restored - to pair your wallet, list wallets and show your wallet that this site is genuine. The app blocks Reown\'s own usage statistics. A browser extension wallet connects inside your browser.',
            '**Video players** - YouTube (www.youtube.com), Twitch (player.twitch.tv), Kick (player.kick.com) and Vimeo (player.vimeo.com): only once you have allowed that platform in the Live Feed widget, and only while the widget is on screen, playing the channel you pick (the news channels it offers are YouTube live streams) or a link you paste. The player is the platform\'s own, embedded in the page; it receives your IP address and the page it is embedded in, and the platform may set its own cookies and use them under its own privacy policy, including for advertising and with transfers to the United States. Details and the switches to withdraw your consent: [Cookies and storage](/cookies), section 3.',
          ],
        },
        { p: 'Legal basis: Art. 6(1)(b) GDPR where you use a function that needs the connection (connecting a wallet, trading, moving funds), Art. 6(1)(a) GDPR and § 25(1) TDDDG - your consent - for the video players, otherwise Art. 6(1)(f) GDPR - showing the market and trader data you open. What you sign is public: orders, deposits, withdrawals and approvals are recorded by the exchange and on public blockchains, and cannot be deleted by anyone.' },
      ],
    },
    {
      title: '9. Storage in your browser',
      blocks: [
        { p: 'ValueDesk uses no cookies. It keeps the following in your browser\'s own storage (local storage, session storage and IndexedDB) so that the functions you use keep working between visits. It stays on your device and is never sent to ValueDesk:' },
        {
          ul: [
            'settings and layouts: the selected market, dashboards, chart layouts and drawings, filters, the privacy mode, the Live Feed channel, the video platforms you allowed, and notices you have seen;',
            'your acceptance of the terms: the version, its fingerprint, the time and your statements, and your wallet\'s signature of them (section 5);',
            'lists you keep: your watchlist, recent searches and recently viewed traders, names you gave addresses, and a log of your own transfers;',
            'copies of public data for speed: the trading history of up to six wallets you looked at, statistics built from it, and the paths of recent requests;',
            'the connected wallet\'s address and, if you use WalletConnect, its session;',
            'the trading key - see the [Terms](/terms): encrypted with a key that your browser generates and that cannot be read out of it, and valid for at most seven days. You can choose not to keep it at all; signing out removes it;',
            'copy trading in browser mode: your copy rules, the copy key (encrypted, valid for at most seven days), the state of each copy and its activity log (section 11);',
            'for the current tab only: a deposit or withdrawal in progress, and diagnostic settings.',
          ],
        },
        { p: 'Legal basis: § 25(2) no. 2 TDDDG - storage that is strictly necessary for the functions you ask for - and Art. 6(1)(f) GDPR. You can delete all of it at any time by clearing this site\'s data in your browser. Every entry is listed in [Cookies and storage](/cookies).' },
      ],
    },
    {
      title: '10. Public trading data of wallets',
      blocks: [
        { p: 'ValueDesk\'s index is built from what SoDEX, Hyperliquid (including trade.xyz), Lighter and Arcus publish about trading on them: wallet addresses with their positions, trades, volumes and profit and loss, and statistics we derive from that (rankings, win rates, cohorts). A wallet address can relate to a person. Where a venue publishes a display name for a wallet, ValueDesk does not show it or make it searchable.' },
        { p: 'Purpose: market analysis - showing how traders and groups of traders behave. Legal basis: Art. 6(1)(f) GDPR. The data comes from the venues\' public interfaces and is kept [[OWNER: retention period for the index]]; backups are deleted after 14 days. If you object to the processing of a wallet that belongs to you (section 13), [[OWNER: what happens, e.g. the wallet is removed from the index and not added again]].' },
      ],
    },
    {
      title: '11. Copy trading',
      blocks: [
        { p: 'This section applies when you copy trades (see the [Copy trading terms](/copy-terms)). What is processed, and by whom, depends on where the copier runs.' },
        { p: '**In every mode**, your acceptance of the Copy trading terms - the message you signed, with the terms\' version and fingerprint, the country you declared, your statements and your wallet address - is sent to the ValueDesk executor and kept there with the country of your IP address and the time (see hosted mode below for how it is processed). To apply the regional rules, your browser also asks the executor which country your IP address belongs to; nothing is stored for that request.' },
        { p: '**Browser mode.** The copier runs in your browser tab. Your copy rules, the copy key (encrypted, valid for at most seven days), the state of each copy and its activity log are kept in your browser\'s IndexedDB (section 9) and are not sent to ValueDesk. Your browser reads the leader\'s trades from SoDEX or Hyperliquid and sends the copied orders to SoDEX directly (section 8).' },
        { p: '**Self-hosted mode.** The executor runs on your own computer or server and keeps its data there. Apart from the acceptance of the terms (above), ValueDesk receives no key, no orders and none of its data; the ValueDesk page you control it with talks to your executor directly from your browser.' },
        { p: '**Hosted mode.** When you use the ValueDesk executor, its server processes, for your wallet:' },
        {
          ul: [
            'your wallet address, which identifies you to the executor, and your SoDEX account number;',
            'your copy rules - the leader\'s address and venue and every setting - and the status of each copy;',
            'every request you signed (the action, the readable text you signed, the signature and the time), with the country of the IP address it came from: the record of your instructions;',
            'the copy trading terms you accepted: their version and fingerprint, the country you declared, the country of your IP address and the time;',
            'the SoDEX API key it generated for you, encrypted (AES-256-GCM) with a key kept separately on the server, with its address, name, lifetime and whether it is registered;',
            'the activity of your copies - orders sent, fills, skipped trades with their reasons, status changes, errors and fees - and each copy\'s positions and results as the copier keeps them;',
            'your account\'s positions and balance, which it reads from SoDEX, and the volume ValueDesk\'s fee ledger counts for your wallet (section 7), to set your copy fee.',
          ],
        },
        { p: 'Your requests reach the executor through Vercel\'s edge and the site\'s /api function, which runs in Tokyo (Vercel region hnd1). Vercel passes on your IP address and the country it derives from it. The executor uses the IP address only in memory, to limit the number of requests per client, and does not store it; it stores the country with your accepted terms and with each signed request. [[OWNER: whether Vercel\'s logs or the web server in front of the executor (Caddy) record the IP address of these requests, and for how long - say so here, or confirm that they do not]]' },
        { p: 'Purposes and legal bases: carrying out the copies you instruct - the key, the orders, the stop orders and the copy fee (Art. 6(1)(b) GDPR); applying the regional rules of the Copy trading terms and keeping evidence of what you instructed and what was done, to answer your questions and to establish or defend legal claims (Art. 6(1)(f) GDPR - our legitimate interest in a reliable record and in offering copy trading only where we do); and protecting the executor against misuse (Art. 6(1)(f) GDPR). [[OWNER: legal bases to be confirmed by counsel - in particular whether Art. 6(1)(c) GDPR applies to the records and the country check, e.g. under licensing, record-keeping or sanctions rules]] Without your signature, your country and your SoDEX account number, hosted copy trading cannot be offered to you.' },
        { p: 'Recipients: Vercel Inc. (the edge and the /api function) and Amazon Web Services (the executor\'s server in the AWS region ap-northeast-1, Tokyo) process this data on our behalf (Art. 28 GDPR). [[OWNER: confirm that Vercel\'s Data Processing Addendum applies, and the AWS contracting entity and Data Processing Addendum for this server]] SoDEX receives the orders the executor places in your account; the executor reads public data about the leader from SoDEX or Hyperliquid. SoDEX records copied orders like any other order, and the name of the key you register on SoDEX is publicly visible.' },
        { p: 'Transfer to a third country: the executor\'s server and the /api function are in Japan. The European Commission has decided that Japan ensures an adequate level of protection for personal data (Art. 45 GDPR, Implementing Decision (EU) 2019/419). Vercel and AWS are US companies: [[OWNER: confirm the safeguards for any access from the US, e.g. their participation in the EU-U.S. Data Privacy Framework and the EU Standard Contractual Clauses in their data processing addenda]].' },
        { p: 'Retention:' },
        {
          ul: [
            'copy rules and the state of a copy: while the copy exists, and [[OWNER: how long after a copy is stopped]];',
            'the activity log: [[OWNER: retention period - the executor deletes entries older than 365 days by default (EXECUTOR_ACTIVITY_DAYS)]];',
            'the signed requests and the accepted terms: [[OWNER: retention period, e.g. until the end of the N-th year after your last copy ended (limitation periods) - the executor never deletes them on its own]];',
            'the encrypted key: until you delete it with a signed request [[OWNER: and whether an expired or revoked key is deleted automatically, and when]].',
          ],
        },
        { p: 'You can read your own signed requests and copy activity through the executor after signing in with your wallet. We may refuse to erase the signed requests for as long as we need them to establish, exercise or defend legal claims (Art. 17(3)(e) GDPR).' },
      ],
    },
    {
      title: '12. What ValueDesk does not do',
      blocks: [
        {
          ul: [
            'no cookies of its own, no analytics, no advertising, no tracking pixels, no social media plugins - and no third-party video player before you allow it;',
            'no fonts or images from third parties - both are served by ValueDesk itself;',
            'no user accounts, no names, no e-mail addresses collected in the app;',
            'no access to your wallet\'s keys, and no orders through ValueDesk\'s servers - except the copies the hosted executor places with the key you registered for it (section 11);',
            'no sale of personal data.',
          ],
        },
      ],
    },
    {
      title: '13. Your rights',
      blocks: [
        { p: 'You have the right to access your data (Art. 15 GDPR), to rectification (Art. 16), to erasure (Art. 17), to restriction of processing (Art. 18), to data portability (Art. 20) and to object to processing based on our legitimate interests (Art. 21). Write to the address in section 1. Because ValueDesk knows wallets only by their address, we may ask you to show that a wallet is yours - for example by signing a short message with it - before we act on a request about it. Data that exists only in your browser (section 9) is in your hands alone.' },
        { p: 'You may also lodge a complaint with a data protection supervisory authority, in particular in the member state where you live or where the alleged infringement took place. The authority responsible for us is [[OWNER: the competent supervisory authority, e.g. the data protection authority of your federal state, with address]].' },
      ],
    },
    {
      title: '14. Changes',
      blocks: [
        { p: 'We update this policy when the site or the law changes. The current version is always on this page.' },
      ],
    },
    {
      title: 'Kurzfassung auf Deutsch',
      lang: 'de',
      blocks: [
        { p: 'Verantwortlich ist der im [Impressum](/impressum) genannte Anbieter. ValueDesk setzt keine Cookies, nutzt keine Analyse- oder Werbedienste und verwahrt weder Guthaben noch die Schlüssel Ihrer Wallet. Beim Aufruf verarbeiten Vercel (Auslieferung, Funktion in Tokio) und Amazon Web Services (ein Server in Tokio) Ihre IP-Adresse und die angefragte Adresse; das Protokoll des Servers enthält IP-Adresse und Pfad ohne Suchparameter und wird nach 14 Tagen gelöscht. Aus der IP-Adresse wird das Land (und die Region) bestimmt, um die regionalen Regeln anzuwenden: Aus sanktionierten Ländern und Regionen ist die Seite nicht erreichbar, aus den USA ist nur das Schließen von Positionen möglich; gespeichert wird dabei nichts. Ihre Annahme der Nutzungsbedingungen bleibt in Ihrem Browser; die Signatur Ihrer Wallet vor dem Handel speichert der ValueDesk-Executor als Nachweis, mit dem angegebenen und dem aus der IP-Adresse abgeleiteten Land. Beim Verbinden einer Wallet wird ihre Adresse über einen öffentlichen Ethereum-Knoten gegen das Sanktions-Orakel von Chainalysis geprüft. Ihr Browser verbindet sich für Markt- und Kontodaten und für den Handel direkt mit SoDEX, Hyperliquid, Lighter, Arcus, ValueChain, öffentlichen Blockchain-Knoten und - nach dem Verbinden einer Wallet - mit Reown/WalletConnect. Videoplayer von YouTube, Twitch, Kick und Vimeo werden erst nach Ihrer Einwilligung geladen, die Sie unter „Cookies“ widerrufen können. Nachrichten bezieht der ValueDesk-Server von SoSoValue, ohne Ihre IP-Adresse weiterzugeben. Einstellungen, Listen und der verschlüsselte Handelsschlüssel liegen nur in Ihrem Browser. Bei aktivem Builder-Fee speichert der Server zu Ihrer Wallet-Adresse das gezählte Handelsvolumen und die Gebührenhistorie. Beim Copy-Trading im Browser bleiben Kopierregeln, Schlüssel und Protokoll in Ihrem Browser, beim selbst betriebenen Executor auf Ihrem Rechner. Beim gehosteten ValueDesk-Executor (Server bei AWS in Tokio, Zugang über Vercel, ebenfalls Tokio) werden Wallet-Adresse, SoDEX-Kontonummer, Kopierregeln, Ihre signierten Anweisungen, das angegebene und das aus der IP-Adresse abgeleitete Land, der verschlüsselte API-Schlüssel und das Aktivitätsprotokoll verarbeitet; die IP-Adresse selbst speichert der Executor nicht. Für Japan besteht ein Angemessenheitsbeschluss der EU-Kommission. Öffentliche Handelsdaten von Wallets werden für Marktanalysen ausgewertet. Sie haben die Rechte aus Art. 15 bis 21 DSGVO und ein Beschwerderecht bei einer Aufsichtsbehörde. Maßgeblich ist die englische Fassung oben.' },
      ],
    },
  ],
};

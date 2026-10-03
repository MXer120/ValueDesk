/**
 * Privacy policy - DRAFT for the owner to complete (see model.ts for the markers).
 *
 * Built from what the app and the deployment actually do, checked against the
 * code on 2026-10-03:
 *   - delivery: CloudFront + AWS WAF + one instance (deploy/aws, deploy/server);
 *     the API logs the path without the query and the client address
 *     (apps/server/src/index.ts, hosted serializer), journald keeps 14 days
 *     (deploy/server/journald/valuescan.conf); CloudFront has no access log;
 *     WAF keeps sampled requests (AWS: up to 3 hours);
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
 *   - the index holds public trading data of wallets (docs/INDEXER.md).
 * If any of that changes, this text changes with it.
 */
import type { LegalDoc } from './model';

export const PRIVACY: LegalDoc = {
  page: 'privacy',
  title: 'Privacy policy',
  lang: 'en',
  updated: '[[OWNER: date, e.g. 1 November 2026]]',
  intro: [
    { p: 'This policy explains which personal data Valuescan processes, why, and what your rights are. In short: Valuescan has no user accounts, sets no cookies and uses no analytics or advertising. It never holds your funds or your keys. Most of what you see is loaded by your own browser directly from the exchanges and blockchains, not through Valuescan.' },
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
        { p: 'Valuescan is delivered by Amazon Web Services (AWS): the Amazon CloudFront content delivery network with the AWS WAF firewall in front of it, and one server for Valuescan\'s own data service in the AWS region [[OWNER: AWS region of the server, e.g. eu-central-1 (Frankfurt)]]. AWS processes this data on our behalf under its data processing addendum (Art. 28 GDPR). [[OWNER: confirm the AWS contracting entity of the account and that the AWS Data Processing Addendum applies to it. If the site is served through another edge instead of CloudFront (for example Vercel), this section has to name that provider, where it processes data and what it logs]]' },
        { p: 'When you open the site, your browser sends your IP address, the address of the page or file requested, and the usual technical information of an HTTP request (for example the browser type and language). This is processed:' },
        {
          ul: [
            'by CloudFront, to deliver the site. CloudFront keeps no access log in this setup;',
            'by the WAF, to block attacks and excessive requests. It limits the number of requests one IP address may make, and shows a sample of recent requests (IP address, country, path and headers) to the operator for up to three hours;',
            'by Valuescan\'s server, for requests to its data service. Its log records the IP address and the path requested, without the query string, and is deleted automatically after 14 days.',
          ],
        },
        { p: 'Legal basis: Art. 6(1)(f) GDPR - our legitimate interest in delivering the site and keeping it secure and available. CloudFront serves the site from locations close to you, which can be outside the EU; AWS participates in the EU-U.S. Data Privacy Framework, and its data processing addendum includes the EU Standard Contractual Clauses.' },
      ],
    },
    {
      title: '3. Valuescan\'s data service',
      blocks: [
        { p: 'Leaderboards, cohorts, the screener, Explore and parts of the search come from Valuescan\'s own index. Some of these requests carry what you entered or opened: a wallet address or search text you typed into the search, the address whose rank Scan shows on Hyperliquid, or a SoDEX account number from a link. They are used only to answer the request; the query part is not written to the server log (section 2).' },
        { p: 'Legal basis: Art. 6(1)(f) GDPR - answering the request you made.' },
      ],
    },
    {
      title: '4. Builder fee and volume tiers',
      blocks: [
        { p: 'This section applies while Valuescan charges a builder fee with volume tiers (see the [Terms](/terms)).' },
        { p: 'When you enable trading, and from then on every few minutes while it is enabled and shortly after your orders fill, the app sends the address of your connected wallet to Valuescan\'s data service to learn which fee applies to you. Valuescan\'s server then reads that wallet\'s trades from SoDEX and the signed requests of the orders behind them from SoDEX\'s public explorer - data that is public on SoDEX - and keeps, for that wallet:' },
        {
          ul: [
            'the trading volume counted towards the fee tiers, and the orders counted;',
            'the fees signed for the wallet over time;',
            'flags for orders that did not carry the fee owed, with the order, the transaction and the signing key as evidence;',
            'the addresses of the trading keys the app registered for the wallet.',
          ],
        },
        { p: 'Purpose: working out the fee you owe and the discount you have earned, and enforcing the fee you agreed to. Legal basis: Art. 6(1)(b) GDPR (the fee terms you accepted by approving the fee) and Art. 6(1)(f) GDPR (preventing the fee from being circumvented). This data is kept [[OWNER: retention period for the fee ledger, e.g. for as long as the volume tiers apply, at most N years]]. We delete a wallet\'s entries on request (section 9).' },
      ],
    },
    {
      title: '5. Direct connections from your browser',
      blocks: [
        { p: 'Valuescan runs in your browser, and your browser connects to the following services directly - Valuescan does not see this traffic. Each service receives your IP address and the technical information of the request, and whatever the request is about: market data, the wallet addresses you connect or look at, and - when you trade - the orders and transfers you sign. They are operated by third parties under their own terms and privacy policies.' },
        {
          ul: [
            '**SoDEX** (mainnet-gw.sodex.dev, mainnet-data.sodex.dev, alpha-biz.sodex.dev, and the testnet hosts testnet-gw.sodex.dev and testnet-data.sodex.dev): market data, your account, orders, deposits, transfers and withdrawals.',
            '**Hyperliquid** (api.hyperliquid.xyz, also for trade.xyz), **Lighter** (mainnet.zklighter.elliot.ai) and **Arcus** (api.arcus.xyz): trader data for Scan and the search.',
            '**ValueChain** (rpc.valuechain.xyz and the explorer main-scan.valuechain.xyz) and public RPC endpoints of Arbitrum (arb1.arbitrum.io), Base (mainnet.base.org), Ethereum (ethereum-rpc.publicnode.com), BNB Chain (bsc-dataseed.bnbchain.org) and Polygon (polygon-bor-rpc.publicnode.com): read-only - the balances of your connected wallet and the status of your deposits and withdrawals.',
            '**Reown / WalletConnect** (relay.walletconnect.org, api.web3modal.org, verify.walletconnect.org): only once you connect a wallet, or a connection from an earlier visit is restored - to pair your wallet, list wallets and show your wallet that this site is genuine. The app blocks Reown\'s own usage statistics. A browser extension wallet connects inside your browser.',
          ],
        },
        { p: 'Legal basis: Art. 6(1)(b) GDPR where you use a function that needs the connection (connecting a wallet, trading, moving funds), otherwise Art. 6(1)(f) GDPR - showing the market and trader data you open. What you sign is public: orders, deposits, withdrawals and approvals are recorded by the exchange and on public blockchains, and cannot be deleted by anyone.' },
      ],
    },
    {
      title: '6. Storage in your browser',
      blocks: [
        { p: 'Valuescan uses no cookies. It keeps the following in your browser\'s own storage (local storage, session storage and IndexedDB) so that the functions you use keep working between visits. It stays on your device and is never sent to Valuescan:' },
        {
          ul: [
            'settings and layouts: the selected market, dashboards, chart layouts and drawings, filters, the privacy mode and notices you have seen;',
            'lists you keep: your watchlist, recent searches and recently viewed traders, names you gave addresses, and a log of your own transfers;',
            'copies of public data for speed: the trading history of up to six wallets you looked at, statistics built from it, and the paths of recent requests;',
            'the connected wallet\'s address and, if you use WalletConnect, its session;',
            'the trading key - see the [Terms](/terms): encrypted with a key that your browser generates and that cannot be read out of it, and valid for at most seven days. You can choose not to keep it at all; signing out removes it;',
            'for the current tab only: a deposit or withdrawal in progress, and diagnostic settings.',
          ],
        },
        { p: 'Legal basis: § 25(2) no. 2 TDDDG - storage that is strictly necessary for the functions you ask for - and Art. 6(1)(f) GDPR. You can delete all of it at any time by clearing this site\'s data in your browser.' },
      ],
    },
    {
      title: '7. Public trading data of wallets',
      blocks: [
        { p: 'Valuescan\'s index is built from what SoDEX, Hyperliquid (including trade.xyz), Lighter and Arcus publish about trading on them: wallet addresses with their positions, trades, volumes and profit and loss, and statistics we derive from that (rankings, win rates, cohorts). A wallet address can relate to a person. Where a venue publishes a display name for a wallet, Valuescan does not show it or make it searchable.' },
        { p: 'Purpose: market analysis - showing how traders and groups of traders behave. Legal basis: Art. 6(1)(f) GDPR. The data comes from the venues\' public interfaces and is kept [[OWNER: retention period for the index]]; backups are deleted after 14 days. If you object to the processing of a wallet that belongs to you (section 9), [[OWNER: what happens, e.g. the wallet is removed from the index and not added again]].' },
      ],
    },
    {
      title: '8. What Valuescan does not do',
      blocks: [
        {
          ul: [
            'no cookies, no analytics, no advertising, no tracking pixels, no social media plugins;',
            'no fonts or images from third parties - both are served by Valuescan itself;',
            'no user accounts, no names, no e-mail addresses collected in the app;',
            'no access to your funds or your wallet\'s keys, and no orders through Valuescan\'s servers;',
            'no sale of personal data.',
          ],
        },
      ],
    },
    {
      title: '9. Your rights',
      blocks: [
        { p: 'You have the right to access your data (Art. 15 GDPR), to rectification (Art. 16), to erasure (Art. 17), to restriction of processing (Art. 18), to data portability (Art. 20) and to object to processing based on our legitimate interests (Art. 21). Write to the address in section 1. Because Valuescan knows wallets only by their address, we may ask you to show that a wallet is yours - for example by signing a short message with it - before we act on a request about it. Data that exists only in your browser (section 6) is in your hands alone.' },
        { p: 'You may also lodge a complaint with a data protection supervisory authority, in particular in the member state where you live or where the alleged infringement took place. The authority responsible for us is [[OWNER: the competent supervisory authority, e.g. the data protection authority of your federal state, with address]].' },
      ],
    },
    {
      title: '10. Changes',
      blocks: [
        { p: 'We update this policy when the site or the law changes. The current version is always on this page.' },
      ],
    },
    {
      title: 'Kurzfassung auf Deutsch',
      lang: 'de',
      blocks: [
        { p: 'Verantwortlich ist der im [Impressum](/impressum) genannte Anbieter. Valuescan setzt keine Cookies, nutzt keine Analyse- oder Werbedienste und verwahrt weder Guthaben noch Schlüssel. Beim Aufruf verarbeiten Amazon Web Services (CloudFront, WAF, ein Server) Ihre IP-Adresse und die angefragte Adresse; das Protokoll des Servers enthält IP-Adresse und Pfad ohne Suchparameter und wird nach 14 Tagen gelöscht. Ihr Browser verbindet sich für Markt- und Kontodaten und für den Handel direkt mit SoDEX, Hyperliquid, Lighter, Arcus, ValueChain, öffentlichen Blockchain-Knoten und - nach dem Verbinden einer Wallet - mit Reown/WalletConnect. Einstellungen, Listen und der verschlüsselte Handelsschlüssel liegen nur in Ihrem Browser. Bei aktivem Builder-Fee speichert der Server zu Ihrer Wallet-Adresse das gezählte Handelsvolumen und die Gebührenhistorie. Öffentliche Handelsdaten von Wallets werden für Marktanalysen ausgewertet. Sie haben die Rechte aus Art. 15 bis 21 DSGVO und ein Beschwerderecht bei einer Aufsichtsbehörde. Maßgeblich ist die englische Fassung oben.' },
      ],
    },
  ],
};

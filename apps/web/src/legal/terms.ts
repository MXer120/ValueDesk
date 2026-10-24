/**
 * Terms of use - DRAFT for the owner to complete (see model.ts for the
 * markers). Written for German law and consumers in the EU: the liability
 * clause follows what §§ 307, 309 Nr. 7 BGB allow, the indemnity is limited to
 * breaches the user is responsible for, changes need the user's active
 * acceptance (no consent fiction - BGH XI ZR 26/20), and nothing here takes away
 * a consumer's mandatory protection (Art. 6 Rome I). There is deliberately no
 * arbitration clause and no class-action waiver for consumers: neither would
 * hold against an EU consumer (§ 1031 Abs. 5 ZPO; the Representative Actions
 * Directive), and an invalid clause is an unfair term in itself. Whether
 * disputes with merchants go to arbitration is the owner's decision (section 22,
 * docs/legal/OWNER-DECISIONS.md).
 *
 * ACCEPTED, NOT JUST SHOWN. Every visitor accepts these terms with the risk
 * disclosure (risk.ts) on the first visit, and every wallet signs them before it
 * trades (legal/acceptance.ts): ANY CHANGE TO THIS TEXT RAISES
 * SITE_TERMS_VERSION and pins the new fingerprint (acceptance.test.ts fails
 * until it does). Section 3 names the places of legal/jurisdictions.mjs;
 * docs.test.ts checks every one is named.
 *
 * The facts it states are the app's, as of 2026-10-24:
 *   - non-custodial: the trading key lives in the browser only (trading/vault.ts),
 *     orders and transfers go from the browser to SoDEX (docs/ARCH-traffic.md);
 *   - the builder fee, its disclosure, approval, revocation and tiers:
 *     docs/BUILDER-CODES.md §2.3-2.7 and docs/BUILDER-TIERS.md;
 *   - a changed order may be cancelled and placed again (BUILDER-CODES §2.2);
 *   - copy trading has terms of its own (copyTerms.ts, /copy-terms) and its own
 *     fee ladder (packages/copy-engine/src/policy.ts). It is the one case where
 *     orders do not go from the browser: the hosted executor (apps/executor)
 *     places copied orders - and hosted algo orders - from ValueDesk's server
 *     with a SoDEX key the user registered for it, an ordinary key, which can
 *     also move funds between the user's own accounts and wallet;
 *   - algo orders (docs/ALGO-ORDERS.md): in the browser with the trading key and
 *     the trading fee, or on an executor with the copy key, the copy terms and the
 *     copy fee ladder;
 *   - the regional rules: the edge (deploy/vercel/package.mjs) and the app
 *     (legal/geo.ts, trading/legalGate.ts), by Vercel's country header and the
 *     declared country of residence; close-only keeps closing, cancelling and
 *     withdrawing possible;
 *   - News from SoSoValue through ValueDesk's server (/api/vs/news); the Live
 *     Feed's players load only after consent (legal/embeds.ts).
 */
import type { LegalDoc } from './model';

export const TERMS: LegalDoc = {
  page: 'terms',
  title: 'Terms of use',
  lang: 'en',
  updated: '[[OWNER: date, e.g. 1 November 2026]]',
  intro: [
    { p: 'These terms apply to your use of ValueDesk at valuedeskapp.vercel.app (and any other address it is offered at), provided by the operator named in the [Impressum](/impressum) ("we", "us"). Together with the [Risk disclosure](/risk) they are the agreement between you and us; copy trading adds the [Copy trading terms](/copy-terms). Please read them, and the risk disclosure in particular, before you use ValueDesk.' },
    { p: '**ValueDesk is a tool. You make every decision, you keep your funds, and you carry the risk of every trade. Trading perpetual futures and crypto-assets can lose you all the money you put in.**' },
  ],
  sections: [
    {
      title: '1. What ValueDesk is',
      blocks: [
        { p: 'ValueDesk is an analytics site for public trading data from SoDEX, Hyperliquid (including trade.xyz), Lighter and Arcus - leaderboards, cohorts of traders, wallet scans, a screener - with market news and live streams from third parties, and an interface through which you can trade on the SoDEX exchange yourself: by hand, with algo orders (section 7) or by copying the trades of public addresses (section 8).' },
        { p: 'ValueDesk is not an exchange, a broker, an investment firm, a bank, a payment service or a custodian. It is not a party to your trades and does not decide anything for you: every order, deposit, transfer and withdrawal is made by you and signed with your own wallet or with a key your wallet authorised. Algo orders and copies place orders automatically, according to rules you set and sign. [[OWNER: the regulatory status of the operator - any licence held or applied for, or a statement agreed with counsel - or delete this sentence]]' },
      ],
    },
    {
      title: '2. Accepting these terms, and new versions',
      blocks: [
        {
          ul: [
            '**When you first open ValueDesk** you confirm, by ticking each statement, that you accept these terms and the risk disclosure and that you meet the conditions in section 3. Your browser keeps the version you accepted and when.',
            '**With your wallet.** If a wallet is connected, it signs the same terms in the same step - their version and a fingerprint (hash) of their text, your country of residence and the statements, word for word. A wallet that connects later is asked to sign them, and no wallet opens a position through ValueDesk before it has signed. The signature is free: it is a message, not a transaction, and moves no funds. It is our record of who accepted which version; we keep it as set out in the [Privacy policy](/privacy).',
            '**New versions.** We may change these terms for the future, for example when features, fees or the law change. Every version has its own number, shown when you accept it. A new version applies to you only once you accept it: the site asks you to on your next visit, and new positions can be opened through ValueDesk only once your wallet has signed it. Until then you can still close positions, cancel orders and withdraw. If you do not accept a new version, stop using ValueDesk.',
            'These terms are in English. A translation, where we offer one, is for convenience; the English version prevails, unless mandatory law where you live says otherwise.',
          ],
        },
      ],
    },
    {
      title: '3. Who may use ValueDesk, and from where',
      blocks: [
        { p: 'You may use ValueDesk only if all of the following are true, and only for as long as they stay true:' },
        {
          ul: [
            'you are at least 18 years old (or older, if the law where you live sets a higher age) and able to enter into binding contracts;',
            'you use ValueDesk for yourself, with your own wallet and your own SoDEX account, not on behalf of anyone else;',
            'you are not named on, or owned or controlled by anyone named on, a sanctions list - in particular those of the United Nations, the European Union, Germany, the United Kingdom and the United States (including OFAC\'s Specially Designated Nationals list) - and you do not act for such a person;',
            'you neither live in nor use ValueDesk from Cuba, Iran, North Korea, Syria, Russia, Belarus or Myanmar, or the regions of Crimea, Sevastopol, Donetsk or Luhansk: **ValueDesk is not available there at all**;',
            'to open or increase positions through ValueDesk - by hand, with algo orders or by copying - you neither live in nor trade from the United States or its territories (Puerto Rico, the US Virgin Islands, Guam, American Samoa, the Northern Mariana Islands and the US Minor Outlying Islands). From there, ValueDesk is **close-only**: you can view data, close positions, cancel orders and withdraw, but not open new positions. Copy trading has its own, stricter conditions ([Copy trading terms](/copy-terms), section 5);',
            'using ValueDesk, perpetual futures, algo orders and copy trading is lawful for you where you live and where you are. [[OWNER: any further countries to exclude or to make close-only (e.g. Canada / Ontario, the United Kingdom), as decided - see docs/legal/OWNER-DECISIONS.md - or delete this marker]]',
          ],
        },
        { p: '**Do not hide where you are.** Do not use a VPN, a proxy or any other means to get around these restrictions, and declare your country of residence truthfully. We apply the restrictions by the country your connection comes from, as our hosting provider reports it, and by the country you declare; where they differ, the stricter applies. Neither check proves where you are, and meeting the conditions above remains your responsibility.' },
        { p: 'We may screen wallet addresses against public sanctions data, and refuse or end your use of ValueDesk, or limit it to closing positions, where we have reason to believe that a condition above is not met or where the law or an authority requires it. A restriction does not affect your funds: they stay in your wallet and your SoDEX account, which you can always manage on SoDEX directly.' },
      ],
    },
    {
      title: '4. ValueDesk never holds your funds or your wallet\'s keys',
      blocks: [
        {
          ul: [
            'Your funds stay in your wallet and in your own account on SoDEX. ValueDesk cannot freeze, recover or return them, and cannot send them to anyone else.',
            'Your wallet\'s private keys and recovery phrase never reach ValueDesk. Never enter them anywhere on this site - we will never ask for them.',
            'To trade without a wallet prompt for every order, you can enable trading: your browser creates a trading key and your wallet registers it with SoDEX. The key is kept only in your browser, encrypted; it can place and cancel orders but, according to SoDEX, cannot send funds to anyone but you; it expires after at most seven days, and you can turn it off or sign out at any time. Anyone who controls your device while the key is valid can trade with it - protect your device.',
            'Orders, transfers and withdrawals go from your browser directly to SoDEX. ValueDesk\'s servers never receive, sign or forward them, and cannot cancel or reverse a transaction once it has been sent. The one exception is ValueDesk\'s hosted executor (sections 7 and 8): there, ValueDesk\'s server signs and sends the copied orders and algo orders with the key you registered for it.',
          ],
        },
      ],
    },
    {
      title: '5. The exchange and other services',
      blocks: [
        { p: 'Your account, your orders and their execution, margin, liquidations, funding, fees, deposits and withdrawals are governed by the terms of SoDEX, which you accept with SoDEX, not with us. Moving funds can also involve the ValueChain network and other blockchains, and connecting your wallet can involve Reown / WalletConnect. Market and trader data comes from the venues named in section 1. We do not control these services, their availability, their prices or the correctness of what they publish, and we are not responsible for them.' },
        { p: 'ValueDesk shows SoDEX\'s answers as it receives them. An order is only placed, changed or cancelled once SoDEX has accepted it. Changing a resting order can be carried out as a cancellation followed by a new order (so that the new order carries the builder fee, section 6); the app says so when it happens, and the new order can fill at a different time or not at all.' },
      ],
    },
    {
      title: '6. ValueDesk builder fee',
      blocks: [
        { p: 'ValueDesk may charge a fee on orders placed through it, as a SoDEX "builder fee". Where it does:' },
        {
          ul: [
            'before you trade, the app shows the rates and the maximum you are asked to approve, and your wallet signs that approval for ValueDesk\'s SoDEX builder account. Without the approval you cannot trade through ValueDesk; you can always trade on SoDEX directly;',
            'SoDEX charges the fee on each fill of an order placed through ValueDesk, on top of SoDEX\'s own trading fee, for makers and takers alike: on perpetuals on buys and sells, on spot on sells only - spot buys carry no builder fee;',
            'the rate that applies to an order is shown in the order ticket before you place it. It can never exceed the maximum you approved without a new signature from your wallet;',
            'a lower rate may apply once your wallet has traded a certain volume through ValueDesk. The tiers are shown in the app and may change for future orders; a lower rate applies only once our server has confirmed it for your wallet;',
            'you can revoke the approval at any time in the app: press "ValueDesk fee" in the order ticket, then "Revoke builder approval". Trading through ValueDesk then stops until you approve again;',
            'the fee is charged by SoDEX and paid to us by SoDEX. Fees already charged on fills are not refunded.',
          ],
        },
        { p: 'Copied orders, and algo orders on an executor, carry the copy fee instead (section 8). ValueDesk charges nothing else.' },
      ],
    },
    {
      title: '7. Algo orders',
      blocks: [
        { p: 'Algo orders - TWAP, VWAP, POV, iceberg, chase, scale, DCA, swarm, conditional and trailing orders, brackets and baskets - split an order into many child orders and place, change and cancel them over time, according to the parameters you set and confirm.' },
        {
          ul: [
            '**In your browser**, an algo runs while the tab is open and uses your trading key; each child order is an order placed through ValueDesk, with the builder fee of section 6. Closing the tab, losing the connection or the key expiring stops it.',
            '**On ValueDesk\'s hosted executor or your own**, an algo runs around the clock with the key you registered for copy trading. The [Copy trading terms](/copy-terms) then apply to it as they do to copies - the key, your signed instructions, the records, the copy fee, the regional rules and the risks - and you start, pause and cancel it by signing with your wallet.',
            'ValueDesk carries out the parameters as you set them. It does not promise that an algo fills, at which price or how fast, that its schedule is kept to the second, or that its exits protect a position: take-profit and stop-loss exits are SoDEX position stops that the algo resizes as it fills.',
            'Previews and paper algos are simulations: they send nothing to SoDEX and carry no fee, and real orders can behave differently.',
            'When an algo stops or is cancelled, positions it opened stay open and child orders already on SoDEX stay there until they fill or you cancel them.',
          ],
        },
        { p: 'SoDEX\'s own TWAP order is not offered: it cannot carry the builder fee. The risks of algo orders: [Risk disclosure](/risk), section 8.' },
      ],
    },
    {
      title: '8. Copy trading',
      blocks: [
        { p: 'ValueDesk lets you copy the trades of public addresses on SoDEX and Hyperliquid into your own SoDEX account, under rules you set yourself: in your browser, on ValueDesk\'s hosted executor, or on an executor you run yourself. Copy trading is governed by the [Copy trading terms and risk disclosure](/copy-terms), which you accept by signing them with your wallet before your first copy. They add to these terms and prevail for copy trading. They set out the copy fee, the regional limits (including a leverage limit of 2x in the European Economic Area), what the key used for copying can do and the risks of copying; paper copies send nothing to SoDEX and carry no fee.' },
      ],
    },
    {
      title: '9. No advice, no fiduciary duty',
      blocks: [
        {
          ul: [
            'Nothing on ValueDesk is investment, financial, legal or tax advice, or a recommendation or solicitation to buy, sell or hold anything, to use any leverage, strategy or algo, or to follow or copy any trader.',
            'Leaderboards, rankings, cohorts, statistics, simulations, previews and estimates describe what happened in public data, or what a model expects; they do not say what will happen. They are the same for every visitor and are not chosen for you.',
            'We do not check whether ValueDesk, a product, a leverage or a strategy is suitable or appropriate for you, your knowledge, your finances or your goals.',
            'We do not manage your money and owe you no fiduciary duty or duty to act in your interest. Within the limits of these terms we act in our own interest - for example, we earn the builder fee on orders placed through ValueDesk.',
            'Decide for yourself, and get independent advice where you need it.',
          ],
        },
      ],
    },
    {
      title: '10. Data, news and third-party content',
      blocks: [
        {
          ul: [
            '**Our data.** We compute leaderboards, statistics, scans and the screener from what the venues in section 1 publish. We take care, but we do not guarantee that they are complete, current or correct; they can be delayed, attributed to the wrong wallet or wrong, and they can change when the venues correct their data.',
            '**News.** The News widget shows articles and posts from SoSoValue and the outlets it collects, as received, with the source named. We do not write, edit, check or endorse them, and we do not adopt them as our own. The coins shown with a story can be assigned automatically and wrongly.',
            '**Live streams and videos.** The Live Feed plays channels and links you choose in the platform\'s own player (YouTube, Twitch, Kick, Vimeo), once you allow that platform. What is broadcast is the broadcaster\'s responsibility, and the platform\'s own terms and privacy policy apply to its player.',
            '**Links** to other sites are offered for convenience. We are not responsible for their content.',
            'If you come across unlawful content through ValueDesk, tell us at the address in the [Impressum](/impressum): we will remove or block access to it once we know of it, where it is in our control.',
          ],
        },
      ],
    },
    {
      title: '11. Risks',
      blocks: [
        { p: '**Trading crypto-assets, and perpetual futures in particular, carries a high risk of losing money quickly. Only trade with money you can afford to lose completely.** With leverage, a small price move can liquidate your position and lose you all the margin you posted, in minutes. Prices move fast and orders can fill at worse prices, partly or not at all; stop orders are triggered by the mark price and do not guarantee a maximum loss. Exchanges, blockchains, wallets and this site can fail, be attacked or contain errors, and a blockchain transaction cannot be undone. No deposit guarantee or investor compensation scheme protects your funds. Past performance of any trader, cohort or simulation shown here is no indication of future results.' },
        { p: 'The [Risk disclosure](/risk) sets out these and further risks in detail. It is part of these terms. By using ValueDesk you confirm that you have read it, that you understand the risks, and that you accept them as your own.' },
      ],
    },
    {
      title: '12. Your responsibilities',
      blocks: [
        {
          ul: [
            '**Security.** Keep your wallet, its recovery phrase and your device safe, check the address of the site before you connect or sign, and read what your wallet asks you to sign. We treat a request signed by your wallet, or sent with a key your wallet authorised, as yours.',
            '**Monitoring.** Watch your positions, orders, algos and copies, and keep enough margin in your SoDEX account.',
            '**The law and taxes.** Comply with the law that applies to you, including tax law: declaring and paying taxes on your trades is up to you.',
            '**True statements.** What you declare - your age, your country of residence, that you are not subject to sanctions - must be true, and you must tell us by accepting the terms again if it changes.',
          ],
        },
      ],
    },
    {
      title: '13. What you may not do',
      blocks: [
        {
          ul: [
            'get around the regional restrictions of section 3, the sanctions or our screening, for example with a VPN or a proxy, or use ValueDesk for or on behalf of a person who may not use it;',
            'use ValueDesk for anything unlawful - in particular money laundering, terrorist financing, fraud, market manipulation, wash trading, spoofing or insider dealing - or to infringe the rights of others;',
            'attack, overload or probe the site, its servers or the executor, introduce malware, or get around its rate limits, firewall or security;',
            'read the site\'s data automatically on a scale beyond normal personal use, or copy, resell or republish our data, without our written consent;',
            'modify the app to get around the builder fee while presenting your orders as placed through ValueDesk, or copy addresses you control to inflate volume or reach a lower fee;',
            'pretend to be ValueDesk, copy its name or appearance for another site or app, or contact users in our name.',
          ],
        },
        { p: 'We may block access, end trading through ValueDesk for a wallet, and report to the competent authorities where these rules are broken or where the law requires it.' },
      ],
    },
    {
      title: '14. Our rights in ValueDesk',
      blocks: [
        { p: 'The site, its software, design, texts, logos, the name ValueDesk and the data compilations we create are protected by copyright, database and trademark rights. We grant you a personal, non-exclusive, non-transferable and revocable right to use ValueDesk in your browser for its purpose, in line with these terms. Software we publish under an open-source licence - such as the ValueDesk copier (MIT licence) - is governed by that licence. Trademarks and logos of exchanges, coins and other third parties belong to their owners and are shown to identify them, not as an endorsement. If you send us suggestions or feedback, we may use them freely.' },
      ],
    },
    {
      title: '15. Availability, beta features and changes',
      blocks: [
        { p: 'ValueDesk is provided as it is, free of charge apart from the fees in sections 6 and 8. We aim to keep it available and correct, but we do not promise that it is always available, complete, current or free of errors. Features marked as beta, new or experimental are especially likely to change or to contain errors. We may change, pause or end features - including turning trading, algo orders or copy trading through ValueDesk off - for everyone, for a region or for a wallet, at any time and, where a legal, security or technical reason requires it, without notice; for copy trading, section 14 of the [Copy trading terms](/copy-terms) applies. Your funds stay on SoDEX in every case, and you can always manage them on SoDEX directly.' },
      ],
    },
    {
      title: '16. Liability',
      blocks: [
        { p: 'We are liable without limitation for damage caused intentionally or by gross negligence, for injury to life, body or health, under the German Product Liability Act, and where we have given a guarantee. For slight negligence we are liable only for the breach of an obligation that is essential to the proper performance of these terms and on which you may regularly rely, and then only for the damage typical and foreseeable when the obligation was breached. Otherwise our liability is excluded.' },
        { p: 'Unless one of the cases in the first sentence applies, we are in particular not liable for trading losses, for decisions you base on data, news, streams or estimates shown here, for the trades of a trader you copy, for orders placed with a key or wallet you did not keep safe, or for the acts and failures of SoDEX, the other venues, SoSoValue, the video platforms, blockchains, wallet providers and hosting providers. These limits also apply to the personal liability of our employees, representatives and agents.' },
      ],
    },
    {
      title: '17. Indemnity',
      blocks: [
        { p: 'If a third party - including an authority - makes a claim against us because you culpably broke these terms or the law when using ValueDesk, you indemnify us against that claim and against the reasonable costs of our legal defence. This does not apply where you are not responsible for the breach, and it does not limit any right you have against us.' },
      ],
    },
    {
      title: '18. Ending the use of ValueDesk',
      blocks: [
        { p: 'You can stop using ValueDesk at any time, without notice and at no cost: turn trading off, stop your algos and copies, and revoke the builder approval and any keys on SoDEX. We may end the use of ValueDesk for you with reasonable notice in the app, and without notice for good cause - in particular if you break section 3 or 13, if the law or an authority requires it, or to protect you, other users or our systems. Sections 9, 10, 16, 17 and 22 continue to apply after the end.' },
      ],
    },
    {
      title: '19. Privacy',
      blocks: [
        { p: 'How we process personal data is set out in the [Privacy policy](/privacy), and what is stored in your browser in [Cookies and storage](/cookies).' },
      ],
    },
    {
      title: '20. Contact and notices',
      blocks: [
        { p: 'You reach us at the addresses in the [Impressum](/impressum). We tell you about changes in the app and on this site. We never ask for your recovery phrase or private key, never offer support by direct message, and never ask you to sign something you did not start yourself in the app: such a request is not from us.' },
      ],
    },
    {
      title: '21. Transfer of this agreement',
      blocks: [
        { p: 'We may transfer this agreement to another company that takes over the operation of ValueDesk. We will tell you beforehand, in the app; you may then stop using ValueDesk at any time (section 18).' },
      ],
    },
    {
      title: '22. Law, place of jurisdiction and disputes',
      blocks: [
        { p: 'These terms are governed by the law of the Federal Republic of Germany, excluding the UN Convention on Contracts for the International Sale of Goods. If you are a consumer, the mandatory consumer protection of the country where you habitually reside still applies, and you can bring proceedings in the courts of that country. If you are a merchant, a legal person under public law or a special fund under public law, the place of jurisdiction is [[OWNER: the city of the provider\'s registered office]]. [[OWNER: whether disputes with merchants go to arbitration instead - e.g. under the DIS Arbitration Rules, seat Frankfurt am Main, in English - or stay with the courts; consumers always keep their courts (docs/legal/OWNER-DECISIONS.md)]]' },
        { p: 'Whether we take part in dispute resolution before a consumer arbitration board is stated in the [Impressum](/impressum).' },
      ],
    },
    {
      title: '23. Final provisions',
      blocks: [
        {
          ul: [
            'If a provision of these terms is invalid, the rest remain in force; the statutory rules take the invalid provision\'s place.',
            'If we do not enforce a right at once, we have not waived it.',
            'Individual agreements with you prevail over these terms. Apart from them, these terms, the risk disclosure and, for copy trading, the copy trading terms are the whole agreement about ValueDesk.',
            'We are not responsible for failures caused by events beyond our reasonable control, such as an outage of an exchange, a blockchain or a hosting provider, an attack, or an order of an authority.',
          ],
        },
        { p: 'Questions: see the [Impressum](/impressum).' },
      ],
    },
  ],
};

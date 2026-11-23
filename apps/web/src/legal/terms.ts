/**
 * Terms of use - DRAFT for the owner to complete (see model.ts for the
 * markers). Written for German law and consumers in the EU: the liability
 * clause follows what §§ 307, 309 Nr. 7 BGB allow, the indemnity is limited to
 * breaches the user is responsible for, changes to the user's disadvantage need
 * their active agreement (no consent fiction - BGH XI ZR 26/20; section 2 says which
 * changes do not, owner 2026-11-23: users sign once), and nothing here takes away
 * a consumer's mandatory protection (Art. 6 Rome I). There is deliberately no
 * arbitration clause and no class-action waiver for consumers: neither would
 * hold against an EU consumer (§ 1031 Abs. 5 ZPO; the Representative Actions
 * Directive), and an invalid clause is an unfair term in itself. Whether
 * disputes with merchants go to arbitration is the owner's decision (section 22).
 *
 * ACCEPTED, NOT JUST SHOWN. Every visitor accepts these terms with the risk
 * disclosure (risk.ts) on the first visit, and every wallet signs them before it
 * trades (legal/acceptance.ts): ANY CHANGE TO THIS TEXT RAISES
 * SITE_TERMS_VERSION and pins the new fingerprint (acceptance.test.ts fails
 * until it does). Nobody signs again for it: a change section 2 does not allow
 * without the user's agreement must not be written for wallets that signed before. Section 3 names the places of legal/jurisdictions.mjs;
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
 *     country the wallet signed for (the one the edge saw - never picked by the
 *     visitor, owner 2026-10-28; unknown: nothing opens); close-only keeps closing, cancelling and
 *     withdrawing possible;
 *   - News from SoSoValue through ValueDesk's server (/api/vs/news); the Live
 *     Feed's players load only after consent (legal/embeds.ts);
 *   - (2026-10-28) the operator's emergency brake (deploy/release/brake.sh,
 *     apps/executor/src/brake.ts, trading/config.ts): it stops orders from the
 *     site, copy orders and live algos (held, not cancelled); stops resting on
 *     SoDEX stay; on the site, while `trading` is braked, nothing that opens or
 *     increases a position is signed - cancels, reduce-only orders, closes,
 *     transfers and withdrawals still are (trading/actions.ts signAndSend,
 *     config.ts closesAllowed); the incident runbook (docs/INCIDENT-RUNBOOK.md): a
 *     compromised server means followers' sealed keys are treated as exposed and
 *     followers revoke them on SoDEX.
 *
 * LIABILITY (section 16, 2026-10-28). Built so that each sentence survives
 * §§ 307-309 BGB on its own and in the reading least favourable to us (the
 * test in an action by a consumer association): the unlimited cases name
 * everything § 309 Nr. 7 and § 444 BGB and the ProdHaftG keep; the cardinal
 * obligations are described, not just named (BGH VIII ZR 121/04: the bare
 * word is intransparent); the "not responsible for" paragraph describes what
 * is not our performance at all and says expressly that it does not cut the
 * liability above - so that it cannot be read as excluding cardinal duties.
 * A money cap and a shorter limitation period are for merchants only: against
 * a consumer a cap below the typical damage is void (§ 307 BGB), and a
 * shortened limitation is a limitation of liability under § 309 Nr. 7 BGB.
 */
import type { LegalDoc } from './model';

export const TERMS: LegalDoc = {
  page: 'terms',
  title: 'Terms of use',
  lang: 'en',
  updated: '23 November 2026',
  intro: [
    { p: 'These terms apply to your use of ValueDesk at www.valuedesk.so (and any other address it is offered at), provided by the operator named in the [Impressum](/impressum) ("we", "us"). Together with the [Risk disclosure](/risk) they are the agreement between you and us; copy trading, bots and algo orders on our executor add the [Copy trading and bot terms](/copy-terms), which you accept with them. Please read them, and the risk disclosure in particular, before you use ValueDesk.' },
    { p: '**ValueDesk is a tool. You make every decision, you keep your funds, and you carry the risk of every trade. Trading perpetual futures and crypto-assets can lose you all the money you put in.**' },
  ],
  sections: [
    {
      title: '1. What ValueDesk is',
      blocks: [
        { p: 'ValueDesk is an analytics site for public trading data from SoDEX, Hyperliquid (including trade.xyz), Lighter and Arcus - leaderboards, cohorts of traders, wallet scans, a screener - with market news and live streams from third parties, and an interface through which you can trade on the SoDEX exchange yourself: by hand, with algo orders and bots (section 7) or by copying the trades of public addresses (section 8), and through which you can move and swap your own funds. Functions, venues, markets, networks, wallets and providers named in these terms are those of the day this version was written; these terms apply in the same way to those added later.' },
        { p: 'ValueDesk is not an exchange, a broker, an investment firm, a bank, a payment service or a custodian. It is not a party to your trades and does not decide anything for you: every order, deposit, transfer and withdrawal is made by you and signed with your own wallet or with a key your wallet authorised. Algo orders, bots and copies place orders automatically, according to rules you set and sign.' },
      ],
    },
    {
      title: '2. Accepting these terms, and new versions',
      blocks: [
        {
          ul: [
            '**Before you use a function that needs them** - enabling trading, an order that opens or increases a position, a deposit, copy trading, a bot or an algo order - ValueDesk shows these terms in a window. It also shows it on your first visit, where you may close it and only look around. With one tick you confirm the statements shown there: that you accept these terms, the risk disclosure and the copy trading and bot terms, and that you meet the conditions in section 3. Nothing that needs these terms happens before you accept them. Your browser keeps the version you accepted and when.',
            '**With your wallet.** If a wallet is connected, it signs the same terms, with the copy trading and bot terms, in the same step - their version and a fingerprint (hash) of their text, the country your connection comes from and the statements, word for word. A wallet that connects later is asked to sign them, and no wallet opens a position through ValueDesk before it has signed. The signature is free: it is a message, not a transaction, and moves no funds. It is our record of who accepted which version; we keep it as set out in the [Privacy policy](/privacy).',
            '**You accept once.** Your acceptance does not expire, and your wallet\'s signature counts on every device. It covers ValueDesk as it is and as it develops: the functions there are, and those we add. What applies to a particular order, copy, algo order, bot, swap or other action - its fee, its limits, its conditions, how long a key lasts - is shown in the app before you start it, and by starting it you agree to what is shown for it.',
            '**What we may change without asking you again.** For the future we may, as far as it is reasonable for you: add, change or end functions, markets, venues, servers, networks, providers and safeguards (section 15); lower fees, and change volume steps, programmes and limits, a higher or new fee applying only to what you start after it was shown to you and never above the maximum your wallet approved; tighten security; add or remove places, and adapt who may use ValueDesk, where the law, sanctions, an authority, SoDEX or a provider requires it (section 3); adapt these terms to changes of the law, of court decisions or of SoDEX\'s rules; and correct, clarify or rearrange their wording. None of this may shift the balance of this agreement to your disadvantage, reduce our liability (section 16) or touch what already happened. Every version has its own number and date on this page, and we tell you in the app of a material change. If you do not agree, stop using ValueDesk (section 18).',
            '**What needs your agreement.** Any other change - one that takes away rights you have under these terms, adds to your obligations to your disadvantage or reduces our liability - applies to you only once you agree to it in the app. Until then the version you accepted goes on applying to you in that point. Your silence, or just using the site, is never taken as agreement. Closing positions, cancelling orders, stopping copies and bots and withdrawing never depend on it.',
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
            'to open or increase positions through ValueDesk - by hand, with algo orders or by copying - you neither live in nor trade from the United States or its territories (Puerto Rico, the US Virgin Islands, Guam, American Samoa, the Northern Mariana Islands and the US Minor Outlying Islands), the United Kingdom (England, Scotland, Wales and Northern Ireland; not the Channel Islands, the Isle of Man or the British Overseas Territories) or Canada. From there, ValueDesk is **close-only**: you can view data, close positions, cancel orders and withdraw, but not open new positions. Copy trading has its own, stricter conditions ([Copy trading terms](/copy-terms), section 5);',
            'using ValueDesk, perpetual futures, algo orders and copy trading is lawful for you where you live and where you are.',
          ],
        },
        { p: '**Your country is taken from your connection.** We apply these restrictions by the country your connection comes from, as our hosting provider reports it; you cannot choose or change it. Your wallet signs the terms for that country, and with the statements you confirm that you do not live in a place where ValueDesk is restricted either. If you later connect from a stricter place, the stricter rule applies. If the country cannot be determined, you cannot open or increase positions through ValueDesk until it can; closing positions, cancelling orders and withdrawing stay possible. The places named above are those of the day this version was written: where the law, sanctions, an authority or SoDEX requires it, a place can be added or removed, and what the app shows for the place you are in applies.' },
        { p: '**Do not hide where you are.** Do not use a VPN, a proxy or any other means to get around these restrictions or to make your connection appear to come from another country. A VPN can hide where you are, so the country we see does not prove where you are or where you live: meeting the conditions above remains your responsibility.' },
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
            'To trade without a wallet prompt for every order, you can enable trading: your browser creates a trading key and your wallet registers it with SoDEX. The key is kept only in your browser, encrypted; it can place and cancel orders but, according to SoDEX, cannot send funds to anyone but you; it expires after the time shown when you enable trading, and you can turn it off or sign out at any time. Anyone who controls your device while the key is valid can trade with it - protect your device.',
            'Orders, transfers, swaps and withdrawals go from your browser or your wallet directly to SoDEX, or to the network or service you chose. ValueDesk\'s servers never receive, sign or forward them, and cannot cancel or reverse a transaction once it has been sent. The one exception is ValueDesk\'s hosted executor (sections 7 and 8): there, ValueDesk\'s server signs and sends the copied orders and algo orders with the key you registered for it.',
          ],
        },
      ],
    },
    {
      title: '5. The exchange and other services',
      blocks: [
        { p: 'Your account, your orders and their execution, margin, liquidations, funding, fees, deposits and withdrawals are governed by the terms of SoDEX, which you accept with SoDEX, not with us. Moving or swapping funds can also involve the ValueChain network, other blockchains, bridges and exchanges, with their own fees, rates and risks, and connecting your wallet can involve Reown / WalletConnect. Market and trader data comes from the venues named in section 1. We do not control these services, their availability, their prices or the correctness of what they publish, and we are not responsible for them. They do not act on our behalf: you use SoDEX, your wallet and the networks under your own agreements with them, and we do not owe you their performance.' },
        { p: 'SoDEX and the other services can limit how many requests they accept (rate limits), reject or delay orders, change their interfaces, or be under maintenance, attacked or down. ValueDesk then cannot place, change or cancel orders, and algo orders and copies can be delayed, skipped or stopped. Oracle and mark prices, liquidations, auto-deleveraging and the settlement of markets are decided by SoDEX under its rules.' },
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
            'SoDEX charges the fee on each fill of an order placed through ValueDesk, on top of SoDEX\'s own trading fee, for makers and takers alike, as SoDEX allows for the market (at the time of this version: on perpetuals on buys and sells, on spot on sells only);',
            'the rate that applies to an order is shown in the order ticket before you place it. It can never exceed the maximum you approved without a new signature from your wallet;',
            'a lower rate may apply once your wallet has traded a certain volume through ValueDesk. The tiers are shown in the app and may change for future orders; a lower rate applies only once our server has confirmed it for your wallet;',
            "**Referrals and fee credits.** You may join ValueDesk through another wallet's referral link, once and before you trade through ValueDesk, by signing with your wallet. A wallet that joined may pay a lower ValueDesk builder fee, or none, on part of its volume, and the wallets that referred it may receive fee credits: a share of the ValueDesk builder fees it pays. We may also give fee credits for other reasons, for example to VIP wallets. Who qualifies, the amounts, the shares, the limits and the fee that applies while credits are used are shown on the Referrals page; they may change for future fees without changing these terms. Fee credits are not money: they cannot be paid out, transferred or exchanged, and they only pay your own ValueDesk builder fee. SoDEX's own fees and SoDEX's own referral programme are not affected. Referring yourself or wallets you control, or any other way of obtaining credits or a lower fee than through genuine referrals, is not allowed; we may then withhold or remove credits and end a lower fee. We may change or end the programme for future fees; credits already given remain usable;",
            'you can revoke the approval at any time in the app: press "ValueDesk fee" in the order ticket, then "Revoke builder approval". Trading through ValueDesk then stops until you approve again;',
            'the fee is charged by SoDEX and paid to us by SoDEX. Fees already charged on fills are not refunded.',
          ],
        },
        { p: 'Copied orders, bots and algo orders on an executor carry the copy or bot fee instead (section 8). Other functions may carry a ValueDesk fee as well, for example a swap: its amount or rate is shown before you confirm, and the rules above apply to it. A ValueDesk fee that was not shown to you before is not owed.' },
      ],
    },
    {
      title: '7. Algo orders, bots and other automated trading',
      blocks: [
        { p: 'Automated tools - algo orders (for example TWAP, iceberg or trailing orders), bots (for example market making, grids or hedges, on perpetuals or spot) and others we may add - place, change and cancel orders over time, according to the parameters you set and confirm. For bots the [Copy trading and bot terms](/copy-terms) apply as well.' },
        {
          ul: [
            '**In your browser**, an algo runs while the tab is open and uses your trading key; each child order is an order placed through ValueDesk, with the builder fee of section 6. Closing the tab, losing the connection or the key expiring stops it.',
            '**On ValueDesk\'s hosted executor or your own**, an algo runs around the clock with the key you registered for copy trading. The [Copy trading terms](/copy-terms) then apply to it as they do to copies - the key, your signed instructions, the records, the copy fee, the regional rules and the risks - and you start, pause and cancel it by signing with your wallet.',
            'ValueDesk carries out the parameters as you set them. It does not promise that an algo fills, at which price or how fast, that its schedule is kept to the second, or that its exits protect a position: take-profit and stop-loss exits are SoDEX position stops that the algo resizes as it fills.',
            'Previews and paper algos are simulations: they send nothing to SoDEX and carry no fee, and real orders can behave differently.',
            'When an algo stops or is cancelled, positions it opened stay open and child orders already on SoDEX stay there until they fill or you cancel them.',
          ],
        },
        { p: 'The risks of automated trading: [Risk disclosure](/risk), section 8.' },
      ],
    },
    {
      title: '8. Copy trading and bots',
      blocks: [
        { p: 'ValueDesk lets you copy the trades of public addresses (at present on SoDEX and Hyperliquid) into your own SoDEX account, under rules you set yourself: in your browser or on ValueDesk\'s hosted executor, and run bots there. Both are governed by the [Copy trading and bot terms](/copy-terms), which you accept together with these terms. They add to these terms and prevail for copies and bots. They set out the copy and bot fees, the regional limits, what the key used for copying can do and the risks of copying; paper copies send nothing to SoDEX and carry no fee.' },
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
            '**Market data, calendar and odds.** The economic calendar, release figures, rate-decision odds where shown, ETF flows, automatic transcripts of live events, the liquidation heatmap and similar figures come from third parties or are estimated by us from their data. They can be late, incomplete, mistranscribed or wrong, and an estimate is not a measurement. Check what matters to you at the source.',
            '**Live streams and videos.** The Live Feed plays channels and links you choose in the platform\'s own player (YouTube, Twitch, Kick, Vimeo), once you allow that platform. What is broadcast is the broadcaster\'s responsibility, and the platform\'s own terms and privacy policy apply to its player. ValueDesk uses YouTube API Services to find a channel\'s live stream; by watching YouTube content in ValueDesk you agree to be bound by the [YouTube Terms of Service](https://www.youtube.com/t/terms).',
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
            '**Security.** Keep your wallet, its recovery phrase and your device safe, check the address of the site before you connect or sign, and read what your wallet asks you to sign: what your wallet shows is what you sign, whatever a web page says. We treat a request signed by your wallet, or sent with a key your wallet authorised, as yours. Losses from a wallet, device, browser extension or key that someone else gained control of - for example through phishing, a fake site or malware - are not caused by us, unless we are at fault for them.',
            '**If something looks wrong.** If you notice an order, a fill, a copy or an algo you did not expect, or suspect that your wallet or a key is compromised: stop your algos and copies, revoke the key on SoDEX, and tell us at once at the address in the [Impressum](/impressum). Errors can then be stopped before they cause more damage.',
            '**Limit what is at stake.** Keep in your SoDEX account only what you are prepared to have traded by the keys you registered, and choose short key lifetimes. Know how to manage your positions on SoDEX directly, for the times ValueDesk is unavailable or paused (section 15).',
            '**Your records.** Keep the records you may need. What ValueDesk keeps in your browser - settings, layouts, the trading key, browser copies and algos - is lost when the browser\'s data is cleared; we keep no backup of it.',
            '**Monitoring.** Watch your positions, orders, algos and copies, and keep enough margin in your SoDEX account.',
            '**The law and taxes.** Comply with the law that applies to you, including tax law: declaring and paying taxes on your trades is up to you.',
            '**True statements.** What you confirm - your age, that you do not live in a restricted place, that you are not subject to sanctions - must be true. If it stops being true, stop opening positions through ValueDesk.',
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
        { p: 'The site, its software, design, texts and the data compilations we create are protected by copyright and database rights. We grant you a personal, non-exclusive, non-transferable and revocable right to use ValueDesk in your browser for its purpose, in line with these terms. Software we publish under an open-source licence - such as the ValueDesk copier (MIT licence) - is governed by that licence. Names, logos and other marks of cryptoassets, exchanges, networks, wallets and other third parties belong to their owners and are used only to identify them; this does not mean that their owners endorse ValueDesk or are connected with it ([Licences and notices](/licenses)). If you send us suggestions or feedback, we may use them freely.' },
      ],
    },
    {
      title: '15. Availability, security incidents, new features and changes',
      blocks: [
        { p: 'ValueDesk is provided as it is, free of charge apart from the fees in sections 6 and 8. We aim to keep it available and correct, but we do not promise that it is always available, complete, current or free of errors, and we promise no minimum availability or response time. Features marked as beta, new or experimental are especially likely to change or to contain errors. Copy trading, algo orders and the hosted executor are new and under active development. We may change, pause or end features - including turning trading, algo orders or copy trading through ValueDesk off - for everyone, for a region or for a wallet, at any time and, where a legal, security or technical reason requires it, without notice; for copy trading, section 14 of the [Copy trading terms](/copy-terms) applies. Your funds stay on SoDEX in every case, and you can always manage them on SoDEX directly.' },
        { p: '**Security.** We protect ValueDesk with measures appropriate to the risk - among them keys stored only encrypted, instructions that are valid only when signed by your wallet, an append-only record of what the executor does, monitoring and an emergency brake. No system is completely secure. Despite these measures, an attacker could break into our servers, our hosting providers, our domain or a software component we use, alter what the site shows or asks you to sign, or obtain keys stored on the hosted executor. Read what your wallet shows before you sign (section 12).' },
        {
          ul: [
            '**The emergency brake.** If we suspect an attack, an error that sends wrong orders, or a fault at SoDEX, we may at once and without notice pause trading through ValueDesk, copies and algo orders - for everyone, a region or a wallet - for as long as it takes to investigate and fix it. While trading is paused, no order that opens or increases a position can be placed through ValueDesk; closing positions, cancelling orders and withdrawing stay possible; algo orders are held, not cancelled; stop orders already on SoDEX stay there. You can manage your positions on SoDEX directly at any time. Pausing for these reasons, and lifting the pause once it is safe, is not a breach of these terms.',
            '**What else we may do.** Stop the hosted executor, delete keys stored on it, refuse requests, and require you to register a new key.',
            '**Telling you.** We tell the users affected in the app and on this site, without undue delay, what happened as far as we know it and what they should do - for example revoke a key on SoDEX - and we notify the data protection authority and you where the law requires it (Art. 33 and 34 GDPR). We cannot revoke a key on SoDEX for you: only your wallet can.',
          ],
        },
      ],
    },
    {
      title: '16. Liability',
      blocks: [
        { p: 'We are liable without limitation for damage we cause intentionally or by gross negligence, for injury to life, body or health, for a defect we fraudulently concealed, where we have given a guarantee, under the German Product Liability Act, and wherever else the law does not allow liability to be limited.' },
        { p: 'For slight negligence we are liable only if we breach an essential obligation - an obligation whose fulfilment makes the proper performance of these terms possible in the first place and on whose fulfilment you may regularly rely, for example that orders placed through ValueDesk are the orders you set and signed. Our liability is then limited to the damage that is typical for this kind of agreement and that was foreseeable when you accepted these terms. Otherwise our liability for slight negligence is excluded.' },
        { p: 'Providers we engage to run ValueDesk - for example our hosting providers (Vercel, Contabo) and the messaging service we use (Telegram) - act on our behalf: for their faults we are liable as for our own, within the rules above. An attack on us or on them makes us liable only where we are at fault, for example because we did not take the security measures that could reasonably be expected.' },
        { p: 'We are not responsible for what is not our performance and not in our control: the movements of the markets and the results of trades you decide on; the trades of a trader you copy; decisions you base on data, news, odds, streams or estimates of third parties; the acts and failures of SoDEX, the other venues, SoSoValue and the other data sources, the video platforms, blockchains and wallet providers, which do not act on our behalf (section 5); and the use of your wallet, device or a key by someone who gained control of it, unless we are at fault for that. This paragraph does not limit our liability under the first three paragraphs for our own breaches, including errors of our software.' },
        { p: 'Where you contributed to a damage - for example by not acting on an incident notice of ours, by not reporting an error you noticed, or by not keeping your wallet or keys safe (section 12) - your claim is reduced accordingly (§ 254 of the German Civil Code). Where data is lost, our liability is limited to what restoring it would have cost if you had kept the copies that can reasonably be expected of you.' },
        { p: 'If you are not a consumer, the following also applies, except in the cases of the first paragraph: we are not liable for slight negligence for lost profit and indirect damage; and claims for damages against us become time-barred one year after the statutory limitation period begins.' },
        { p: 'These limits also apply to the personal liability of our employees, representatives and agents.' },
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
        { p: 'These terms are governed by the law of the Federal Republic of Germany, excluding the UN Convention on Contracts for the International Sale of Goods. If you are a consumer, the mandatory consumer protection of the country where you habitually reside still applies, and you can bring proceedings in the courts of that country. If you are a merchant, a legal person under public law or a special fund under public law, the place of jurisdiction is the seat or, without one, the residence of the operator named in the [Impressum](/impressum).' },
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
            'Individual agreements with you prevail over these terms. Apart from them, these terms, the risk disclosure and, for copy trading, the copy trading and bot terms are the whole agreement about ValueDesk.',
            'We are not responsible for failures caused by events beyond our reasonable control that we could not have prevented with reasonable care - such as natural disasters, war, terrorism, pandemics, strikes, power and network failures, an outage of or attack on an exchange, a blockchain, a hosting or internet provider, or an order of an authority. For as long as such an event lasts, we are released from the obligations it prevents us from fulfilling.',
          ],
        },
        { p: 'Questions: see the [Impressum](/impressum).' },
      ],
    },
  ],
};

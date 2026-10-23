/**
 * Terms of use, with the risk notice - DRAFT for the owner to complete (see
 * model.ts for the markers). Written for German law and consumers in the EU:
 * the liability clause follows what §§ 307, 309 Nr. 7 BGB allow, and nothing
 * here takes away a consumer's mandatory protection (Art. 6 Rome I).
 *
 * The facts it states are the app's, as of 2026-10-23:
 *   - non-custodial: the trading key lives in the browser only (trading/vault.ts),
 *     orders and transfers go from the browser to SoDEX (docs/ARCH-traffic.md);
 *   - the builder fee, its disclosure, approval, revocation and tiers:
 *     docs/BUILDER-CODES.md §2.3-2.7 and docs/BUILDER-TIERS.md;
 *   - a changed order may be cancelled and placed again (BUILDER-CODES §2.2);
 *   - copy trading has terms of its own (copyTerms.ts, /copy-terms) and its own
 *     fee ladder (packages/copy-engine/src/policy.ts). It is the one case where
 *     orders do not go from the browser: the hosted executor (apps/executor)
 *     places copied orders from ValueDesk's server with a SoDEX key the
 *     follower registered for it - an ordinary key, which can also move funds
 *     between the follower's own accounts and wallet (copyTerms.ts, section 2).
 */
import type { LegalDoc } from './model';

export const TERMS: LegalDoc = {
  page: 'terms',
  title: 'Terms of use',
  lang: 'en',
  updated: '[[OWNER: date, e.g. 1 November 2026]]',
  intro: [
    { p: 'These terms apply to your use of ValueDesk at [[OWNER: the site\'s domain]], provided by the operator named in the [Impressum](/impressum) ("we"). By using ValueDesk you accept them. Please read the risk notice in section 7 before you trade.' },
  ],
  sections: [
    {
      title: '1. What ValueDesk is',
      blocks: [
        { p: 'ValueDesk is a free analytics site for public trading data from SoDEX, Hyperliquid (including trade.xyz), Lighter and Arcus - leaderboards, cohorts of traders, wallet scans - and an interface through which you can trade on the SoDEX exchange yourself.' },
        { p: 'ValueDesk is not an exchange, a broker, an investment firm or a custodian. It is not a party to your trades and does not decide anything for you: every order, deposit, transfer and withdrawal is made by you and signed with your own wallet or with a key your wallet authorised. Copy trading (section 5) places orders automatically, according to rules you set and sign.' },
      ],
    },
    {
      title: '2. ValueDesk never holds your funds or your wallet\'s keys',
      blocks: [
        {
          ul: [
            'Your funds stay in your wallet and in your own account on SoDEX. ValueDesk cannot freeze, recover or return them, and cannot send them to anyone else.',
            'Your wallet\'s private keys and recovery phrase never reach ValueDesk. Never enter them anywhere on this site - we will never ask for them.',
            'To trade without a wallet prompt for every order, you can enable trading: your browser creates a trading key and your wallet registers it with SoDEX. The key is kept only in your browser, encrypted; it can place and cancel orders but, according to SoDEX, cannot send funds to anyone but you; it expires after at most seven days, and you can turn it off or sign out at any time. Anyone who controls your device while the key is valid can trade with it - protect your device.',
            'Orders, transfers and withdrawals go from your browser directly to SoDEX. ValueDesk\'s servers never receive, sign or forward them, and cannot cancel or reverse a transaction once it has been sent. The one exception is copy trading with the hosted ValueDesk executor (section 5): there, ValueDesk\'s server signs and sends the copied orders with the key you registered for it.',
          ],
        },
      ],
    },
    {
      title: '3. The exchange and other services',
      blocks: [
        { p: 'Your account, your orders and their execution, margin, liquidations, funding, fees, deposits and withdrawals are governed by the terms of SoDEX, which you accept with SoDEX, not with us. Moving funds can also involve the ValueChain network and other blockchains. Market and trader data comes from the venues named in section 1. We do not control these services, their availability, their prices or the correctness of what they publish, and we are not responsible for them.' },
        { p: 'ValueDesk shows SoDEX\'s answers as it receives them. An order is only placed, changed or cancelled once SoDEX has accepted it. Changing a resting order can be carried out as a cancellation followed by a new order (so that the new order carries the builder fee, section 4); the app says so when it happens, and the new order can fill at a different time or not at all.' },
      ],
    },
    {
      title: '4. ValueDesk builder fee',
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
        { p: 'Copied orders carry a builder fee of their own (section 5). ValueDesk charges nothing else.' },
      ],
    },
    {
      title: '5. Copy trading',
      blocks: [
        { p: 'ValueDesk lets you copy the trades of public addresses on SoDEX and Hyperliquid into your own SoDEX account, under rules you set yourself: in your browser, on ValueDesk\'s hosted executor, or on an executor you run yourself. Copy trading is governed by the [Copy trading terms and risk disclosure](/copy-terms), which you accept by signing them with your wallet before your first copy. They add to these terms and prevail for copy trading. They set out the copy fee, the regional limits, what the key used for copying can do and the risks of copying; paper copies send nothing to SoDEX and carry no fee.' },
      ],
    },
    {
      title: '6. No advice',
      blocks: [
        { p: 'Nothing on ValueDesk is investment, financial, legal or tax advice, or a recommendation to buy, sell or hold anything or to follow any trader. Leaderboards, rankings, cohorts, statistics and simulations describe what happened in public data; they do not say what will happen. Decide for yourself, and get independent advice where you need it.' },
      ],
    },
    {
      title: '7. Risk notice',
      blocks: [
        { p: '**Trading crypto-assets, and perpetual futures in particular, carries a high risk of losing money quickly. Only trade with money you can afford to lose completely.**' },
        {
          ul: [
            '**Perpetual futures are complex derivatives.** With leverage, a small price move causes a large gain or loss. Your position can be liquidated automatically and you can lose all the margin you posted, in minutes.',
            '**Funding and fees** are paid continuously or per trade and reduce your result, also when the price does not move.',
            '**Prices move fast and can gap.** Orders can fill at a worse price than shown (slippage), partly, or not at all; stop orders are triggered by the mark price and are not guaranteed to fill at their trigger.',
            '**Crypto-assets are volatile and can lose all their value.** Stablecoins and wrapped tokens (such as vUSDC) depend on their issuers and can lose their peg.',
            '**Technical risks:** exchanges, smart contracts, bridges, blockchains, wallets and this site can fail, be attacked, pause trading or withdrawals, or contain errors. Data can be delayed, incomplete or wrong. A blockchain transaction cannot be undone, and funds sent to a wrong address are lost.',
            '**Exchange risk:** SoDEX is a third-party exchange. Its insolvency, a hack, an outage or a change of its rules can cause you losses that nobody makes good.',
            '**Legal and tax risk:** trading derivatives or crypto-assets may be restricted or forbidden where you live, and gains may be taxable. You are responsible for complying with the law that applies to you.',
            '**Past performance** of any trader, cohort or simulation shown here is no indication of future results.',
          ],
        },
      ],
    },
    {
      title: '8. Who may use ValueDesk',
      blocks: [
        { p: 'You must be at least 18 years old and able to enter into binding contracts. You may not use ValueDesk to trade if the law where you live or are located forbids it, if you are subject to sanctions, or from [[OWNER: the excluded countries, matching GEO_RESTRICTION_COUNTRIES and SoDEX\'s own restricted jurisdictions]]. You may not hide your location to get around such a restriction.' },
      ],
    },
    {
      title: '9. Fair use',
      blocks: [
        {
          ul: [
            'do not attack, overload or probe the site or its servers, and do not get around its rate limits or firewall;',
            'do not read the site\'s data automatically on a scale beyond normal personal use without our written consent;',
            'do not modify the app to get around the builder fee while presenting your orders as placed through ValueDesk;',
            'do not use ValueDesk for anything unlawful, including market manipulation.',
          ],
        },
        { p: 'We may block access that breaks these rules.' },
      ],
    },
    {
      title: '10. Availability and changes',
      blocks: [
        { p: 'ValueDesk is provided as it is, free of charge apart from the builder fees in sections 4 and 5. We aim to keep it available but do not promise that it is always available, complete or free of errors. We may change, pause or end features - including turning trading through ValueDesk off - at any time; for copy trading, section 14 of the [Copy trading terms](/copy-terms) applies. Your funds stay on SoDEX in every case, and you can always manage them on SoDEX directly.' },
      ],
    },
    {
      title: '11. Liability',
      blocks: [
        { p: 'We are liable without limitation for damage caused intentionally or by gross negligence, for injury to life, body or health, under the German Product Liability Act, and where we have given a guarantee. For slight negligence we are liable only for the breach of an obligation that is essential to the proper performance of these terms and on which you may regularly rely, and then only for the damage typical and foreseeable when the obligation was breached. Otherwise our liability is excluded. In particular we are not liable for trading losses, for decisions you base on data shown here, or for the acts and failures of SoDEX, the other venues, blockchains and wallet providers, unless one of the cases in the first sentence applies.' },
      ],
    },
    {
      title: '12. Changes to these terms',
      blocks: [
        { p: 'We may change these terms for the future, for example when features or the law change. The version on this page at the time you use ValueDesk applies; we point out significant changes in the app.' },
      ],
    },
    {
      title: '13. Law and place of jurisdiction',
      blocks: [
        { p: 'These terms are governed by the law of the Federal Republic of Germany, excluding the UN Convention on Contracts for the International Sale of Goods. If you are a consumer, the mandatory consumer protection of the country where you habitually reside still applies. If you are a merchant, a legal person under public law or a special fund under public law, the place of jurisdiction is [[OWNER: the city of the provider\'s registered office]].' },
        { p: 'If a provision of these terms is invalid, the rest remain in force. Questions: see the [Impressum](/impressum).' },
      ],
    },
  ],
};

/**
 * Risk disclosure - DRAFT for the owner to complete (see model.ts for the
 * markers). Part of what every visitor and every trading wallet accepts
 * (legal/acceptance.ts: SITE_TERMS_VERSION covers terms.ts and this text), so
 * any change here raises SITE_TERMS_VERSION and pins the new fingerprint.
 *
 * It says more than the risk notice in the Terms of use (section 9 there) and
 * covers every product of the app: perpetual futures and spot on SoDEX, the
 * builder fee, algo orders (packages/copy-engine/src/algo, docs/ALGO-ORDERS.md),
 * copy trading (in short - the full text is copyTerms.ts section 7), the data
 * and the third-party content (leaderboards, scans, News, Live Feed).
 *
 * FACTS, NOT PROMISES. It never says that a risk is small, that a product is
 * suitable, or what SoDEX's rules are beyond what SoDEX publishes: where the
 * exchange decides, the text says so. As of 2026-10-24:
 *   - the liquidation price in the ticket is a client-side estimate (risk.ts at
 *     the app's root, "est." in the ticket);
 *   - stop orders trigger on SoDEX's mark price (OrderEntry, copyTerms.ts);
 *   - a changed order may be cancelled and placed again (BUILDER-CODES §2.2);
 *   - the trading key lives in the browser, at most seven days (trading/vault.ts);
 *   - algo orders run in the tab, or on an executor around the clock; their
 *     exits are SoDEX position stops resized as the algo fills (ALGO-ORDERS.md).
 */
import type { LegalDoc } from './model';

export const RISK: LegalDoc = {
  page: 'risk',
  title: 'Risk disclosure',
  lang: 'en',
  updated: '[[OWNER: date, e.g. 1 November 2026]]',
  intro: [
    { p: '**Trading crypto-assets and perpetual futures is high-risk and not suitable for most people. You can lose all the money you put in, quickly. Only trade with money you can afford to lose completely, and never with borrowed money.**' },
    { p: 'This disclosure describes the main risks of using ValueDesk at valuedeskapp.vercel.app: trading on the SoDEX exchange through it, algo orders, copy trading, and the data and third-party content it shows. It is part of the [Terms of use](/terms), which you accept before you use ValueDesk. It cannot name every risk, and the risks can change. It is not advice: nothing here, and nothing on ValueDesk, says that any product, trade or strategy is suitable for you.' },
  ],
  sections: [
    {
      title: '1. Perpetual futures and leverage',
      blocks: [
        { p: 'Perpetual futures ("perps") are complex derivatives without an expiry date. Their price follows the underlying crypto-asset through funding payments, not through delivery of the asset.' },
        {
          ul: [
            '**Leverage multiplies losses.** With 10x leverage, a price move of 10% against you loses your whole margin. The higher the leverage, the smaller the move that does it.',
            '**Liquidation.** When your margin falls below what SoDEX requires to keep a position open (the maintenance margin, which rises with the position\'s size), SoDEX closes it automatically, in whole or in part, and you lose the margin posted for it. Liquidation can happen within minutes or seconds, also at night, and SoDEX may charge a liquidation fee.',
            '**The liquidation price shown is an estimate.** ValueDesk computes it in your browser from the margin tiers SoDEX publishes, for the one position in the ticket. SoDEX liquidates against your whole account at its own mark price, so the real level can differ.',
            '**Cross and isolated margin.** With cross margin, all positions share your account\'s margin: a loss on one can liquidate the others and use up your whole perps account. With isolated margin, each position can lose all the margin assigned to it.',
            '**The exchange\'s own measures.** Under its rules, SoDEX may reduce or close positions - including profitable ones, for example by auto-deleveraging - change margin requirements and leverage limits, halt or delist a market, or settle it at a price it sets. ValueDesk has no influence on this.',
            '**Leverage limits for retail clients.** Authorities such as ESMA limit leverage for retail clients on some leveraged crypto products (for CFDs on crypto-assets: 2x). Such limits exist because of these risks; that a higher leverage can be chosen here does not mean it is suitable or allowed for you.',
          ],
        },
      ],
    },
    {
      title: '2. Prices, the mark price and order execution',
      blocks: [
        {
          ul: [
            '**Prices move fast and can gap.** In a fast market, prices can jump past your order, your stop or your liquidation level without trading in between.',
            '**Slippage.** A market order fills at the prices available in the order book, which can be worse than the price shown when you sent it. The slippage estimate and the maximum you set are not guarantees.',
            '**Partial fills and no fills.** An order can fill in part or not at all. Immediate-or-cancel orders cancel what does not fill at once.',
            '**Stop-loss and take-profit orders** are triggered by SoDEX\'s mark price, not the last trade, and then fill as market orders - possibly far from their trigger. They do not guarantee a maximum loss.',
            '**The mark price and oracles.** SoDEX derives its mark price from sources it chooses. A faulty, delayed or manipulated price source can trigger liquidations and stops that the market price alone would not.',
            '**Changing an order.** A change of a resting order may be made as a cancellation followed by a new order. The new order loses its place in the queue and can fill at another time, at another price, or not at all; between the two steps the order is not in the book.',
            '**Reduce-only and close orders** close only what is open when they reach SoDEX; a position that changed in the meantime can leave them partly or entirely unfilled.',
          ],
        },
      ],
    },
    {
      title: '3. Costs',
      blocks: [
        {
          ul: [
            '**Funding.** Holders of perps positions pay or receive funding at intervals SoDEX sets. Funding can be large in volatile markets and is paid even when the price does not move.',
            '**Trading fees.** SoDEX charges its own fees on every fill. ValueDesk charges a builder fee on orders placed through it, on top (Terms of use, section 6), and copied orders carry the copy fee. Frequent trading multiplies these costs, which can outweigh small gains.',
            '**Network fees.** Deposits from other blockchains and some withdrawals cost network fees (gas), which change with demand and are not refunded when a transaction fails.',
          ],
        },
      ],
    },
    {
      title: '4. Crypto-assets, stablecoins and tokens',
      blocks: [
        {
          ul: [
            '**Volatility.** Crypto-assets can lose most or all of their value, quickly and permanently. They are not legal tender, are not backed by a state, and are not covered by any deposit guarantee or investor compensation scheme.',
            '**Stablecoins and wrapped tokens** - such as USDC and the vUSDC that SoDEX credits - depend on their issuers, their reserves and the bridges and contracts that hold them. They can lose their peg, be frozen by their issuer or become impossible to redeem.',
            '**Thin markets.** Small tokens and new listings can be illiquid and easy to manipulate. Prices on SoDEX can differ from those on other venues.',
          ],
        },
      ],
    },
    {
      title: '5. The exchange: SoDEX',
      blocks: [
        { p: 'Every trade you place through ValueDesk is executed on SoDEX, a third-party exchange. ValueDesk is not SoDEX, does not operate, audit or supervise it, and makes no statement about its licences, its solvency or its security. Your account, your funds there and your trades are governed by SoDEX\'s own terms.' },
        {
          ul: [
            'SoDEX can be hacked, become insolvent, suffer outages, pause trading, deposits or withdrawals, change its fees and rules, or close. Losses from any of these may never be made good.',
            'SoDEX\'s data - prices, balances, positions, order status - can be delayed, incomplete or wrong, and ValueDesk shows it as it receives it.',
            'An order is placed, changed or cancelled only once SoDEX has accepted it. A confirmation in ValueDesk that is not followed by SoDEX\'s acceptance means nothing was done.',
          ],
        },
      ],
    },
    {
      title: '6. Blockchains, bridges and wallets',
      blocks: [
        {
          ul: [
            '**Irreversible transactions.** A blockchain transaction cannot be undone. Funds sent to a wrong address, on a wrong network, or as a wrong token are usually lost for good.',
            '**Smart contracts and bridges** - those of SoDEX and ValueChain, of the networks deposits come from, and of token issuers - can contain errors or be attacked, and funds in them can be lost or frozen.',
            '**Networks** can be congested, halted or reorganised, which delays or changes transactions and can make deposits and withdrawals take much longer than shown.',
            '**Your wallet** - its software, its extension, WalletConnect - can fail, be compromised or show you a misleading request. Whoever controls your wallet or its recovery phrase controls your funds.',
          ],
        },
      ],
    },
    {
      title: '7. Keys, devices and fraud',
      blocks: [
        {
          ul: [
            '**The trading key.** When you enable trading, your browser keeps a trading key that SoDEX accepts for orders, for at most seven days. Anyone who controls your device while it is valid can trade with it. Turn trading off, or sign out, on a device others use.',
            '**Phishing and fake sites.** Criminals copy trading sites and send fake messages, apps and support contacts. Check the address of the site before you connect a wallet or sign anything. ValueDesk will never ask for your recovery phrase or private key, and never contacts you first to ask you to sign something.',
            '**Read what you sign.** Your wallet shows every message and transaction before it is signed. A signature you did not understand can cost you your funds.',
          ],
        },
      ],
    },
    {
      title: '8. Algo orders',
      blocks: [
        { p: 'Algo orders (TWAP, VWAP, POV, iceberg, chase, scale, DCA, swarm, conditional and trailing orders, brackets and baskets) place and manage many child orders for you over time, according to the rules you set. They are tools, not strategies, and they do not reduce the risks above.' },
        {
          ul: [
            '**They act on their own.** Once started, an algo places orders without asking you before each one - in your browser while the tab is open, or on an executor around the clock.',
            '**The market moves while they run.** The average price an algo achieves can be far worse than the price when it started. Limits, randomised timing and slice sizes reduce some risks and create others: the full size may never be reached, or be reached at a bad moment.',
            '**When an algo stops, what it did stays.** If the tab is closed, the connection drops, the trading key expires or an executor stops, the algo stops: positions it opened stay open, and child orders already on SoDEX stay there until they fill or are cancelled.',
            '**Exits** (take-profit and stop-loss) are SoDEX position stops that the algo resizes as it fills. Between two fills, a position can be larger than its stops cover, and stops fill as market orders.',
            '**Previews and paper runs** are simulations from the market data at that moment. Real orders fill differently, later, partly or not at all, and carry fees.',
            '**Every child order is an order**, with its own fees, slippage and builder fee.',
          ],
        },
      ],
    },
    {
      title: '9. Copy trading',
      blocks: [
        { p: 'Copying another address\'s trades adds risks of its own: the trader you copy does not know you and owes you nothing, past results do not predict future ones, your results will differ from theirs, copies run automatically and can stop at any time while positions stay open, and the key used for copying can trade your account. These risks are set out in full in section 7 of the [Copy trading terms and risk disclosure](/copy-terms), which you accept separately before your first copy.' },
      ],
    },
    {
      title: '10. Data, rankings and third-party content',
      blocks: [
        {
          ul: [
            '**Public data can be wrong.** Leaderboards, rankings, cohorts, win rates, profit and loss, wallet scans and the screener are computed by ValueDesk from data that SoDEX, Hyperliquid (including trade.xyz), Lighter and Arcus publish. It can be incomplete, delayed, attributed to the wrong wallet or wrong, and our calculations can contain errors.',
            '**Rankings show winners.** A ranking shows the traders who did well in a period; the many who lost are easy to overlook. A good record can be luck, leverage, a short period or a strategy that stops working. Past performance is not a reliable indicator of future results.',
            '**News.** The News widget shows articles and posts from SoSoValue and the outlets it collects, as they are received. ValueDesk does not write, check, select for accuracy or endorse them. News can be false, outdated, incomplete or written to move prices; the coins shown with a story can be assigned automatically and wrongly.',
            '**Live streams.** The Live Feed plays third-party channels in their own players. What is said there is the broadcaster\'s, not ValueDesk\'s, and it is not advice.',
            '**Never trade on a headline, a ranking or a stream alone.** None of it is a recommendation, and none of it was prepared with your situation in mind.',
          ],
        },
      ],
    },
    {
      title: '11. The software',
      blocks: [
        {
          ul: [
            '**Errors and outages.** ValueDesk is software under active development. It can contain errors - an order of the wrong size, a wrong figure, a missed update - and it can be unavailable, slow or show stale data. Figures marked "est." are estimates.',
            '**Your connection and device** can drop, lag or fail, also in the middle of placing or closing an order.',
            '**Changes.** We change, pause or end features, sometimes at short notice. Your funds stay in your own wallet and SoDEX account in every case, and you can always manage them on SoDEX directly.',
          ],
        },
      ],
    },
    {
      title: '12. Law, regulation and tax',
      blocks: [
        {
          ul: [
            '**Restrictions.** Trading derivatives or crypto-assets, using a non-custodial front-end, copy trading and algo trading may be restricted or forbidden where you live or where you are. You are responsible for complying with the law that applies to you.',
            '**The law is changing.** Regulation of crypto-assets and of decentralised trading (in the EU, for example, the Markets in Crypto-Assets Regulation and the supervisors\' view of perpetual futures) is evolving. New rules or the action of an authority can force ValueDesk, SoDEX or other services to restrict or end what they offer, at short notice.',
            '**No protection schemes.** No deposit guarantee scheme, investor compensation scheme or similar protection covers your funds on SoDEX or in your wallet.',
            '**Tax.** Gains, funding and fees can have tax consequences. ValueDesk issues no tax statements; declaring and paying taxes is up to you.',
          ],
        },
      ],
    },
    {
      title: '13. What ValueDesk does not do for you',
      blocks: [
        {
          ul: [
            'ValueDesk gives no investment, financial, legal or tax advice and makes no recommendation, and it does not check whether trading, a product, a leverage or a strategy is suitable or appropriate for you.',
            'ValueDesk owes you no fiduciary duty: it does not manage your money and does not act in your interest when you decide.',
            'ValueDesk does not hold your funds, is not your counterparty, and cannot reverse, cancel or recover a transaction once it has been sent.',
            'ValueDesk offers no negative balance protection, no insurance and no compensation for losses.',
          ],
        },
        { p: 'If you do not understand a product or a risk described here, do not trade it. Get independent advice where you need it.' },
      ],
    },
  ],
};

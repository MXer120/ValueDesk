/**
 * Copy trading terms and risk disclosure - DRAFT for the owner to complete (see
 * model.ts for the markers). Written like terms.ts: for German law and
 * consumers in the EU, the liability clause follows what §§ 307, 309 Nr. 7 BGB
 * allow, and nothing here takes away a consumer's mandatory protection
 * (Art. 6 Rome I).
 *
 * EVERY FOLLOWER SIGNS THESE TERMS. The signed 'accept-terms' request
 * (packages/copy-engine/src/api.ts, AcceptTermsPayload) carries
 * COPY_TERMS_VERSION, a keccak256 of the text the follower saw, the declared
 * country and the four statements of COPY_STATEMENTS below, and the executor
 * starts no copy under another version (apps/executor/src/service.ts). So any
 * change to the text below raises COPY_TERMS_VERSION in
 * packages/copy-engine/src/policy.ts, and every follower signs again.
 *
 * FACTS, NOT LEGAL CONCLUSIONS. This text never says that a licence is not needed, that the service is not
 * portfolio management or that it is not regulated; the licence status is a
 * placeholder in section 1.
 *
 * The facts it states, as of 2026-10-23:
 *   - leaders, followers, the three modes, the copy rules, copies as IOC limit
 *     orders on SoDEX perps only, SoDEX position stops on the mark price, the
 *     drawdown stop, skips: packages/copy-engine/src/types.ts, orders.ts,
 *     planner.ts, runtime.ts;
 *   - regions, the 2x EEA cap (per position and gross), the stricter-country
 *     rule, the copy fee ladder: packages/copy-engine/src/policy.ts - docs.test.ts
 *     checks the ladder, the cap and the excluded countries against it;
 *   - signed instructions (EIP-712) and the append-only consent log:
 *     packages/copy-engine/src/api.ts, apps/executor/src/db.ts;
 *   - the hosted key: generated and sealed (AES-256-GCM) on the executor,
 *     lifetime chosen by the follower up to 180 days (apps/executor/src/
 *     config.ts, secrets.ts); the browser key: at most seven days, in the
 *     browser only; an ordinary SoDEX key - the only kind that can trade - can
 *     also move funds between the owner's own accounts and wallet
 *     (packages/sodex-core/README.md, "Security notes");
 *   - a self-hosted executor reads no fee ledger, so it charges the ladder's
 *     default (apps/executor/src/service.ts volumeOf).
 *
 * COPY_RISK_SUMMARY, COPY_STATEMENTS and HOSTED_KEY_NOTICE are shown in the
 * app itself, outside the legal pages, so they may hold no placeholder
 * (docs.test.ts).
 */
import { COPY_TERMS_VERSION } from '../../../../packages/copy-engine/src/policy.ts';
import type { LegalDoc } from './model';

export const COPY_TERMS: LegalDoc = {
  page: 'copy-terms',
  title: 'Copy trading terms and risk disclosure',
  lang: 'en',
  updated: '[[OWNER: date, e.g. 1 November 2026]]',
  intro: [
    { p: `Version ${COPY_TERMS_VERSION}. These terms apply when you copy trades with ValueDesk at www.valuedesk.so (and any other address it is offered at), provided by the operator named in the [Impressum](/impressum) ("we"). They add to the [Terms of use](/terms); for copy trading, these terms prevail where the two differ. You accept them by signing them with your wallet before your first copy.` },
    { p: '**Copy trading can lose you money fast: your whole allocation and, with leverage, more than that. Read the risk disclosure in section 7 before you copy.**' },
  ],
  sections: [
    {
      title: '1. What copy trading on ValueDesk is',
      blocks: [
        { p: 'Copy trading lets you choose a public trader address on SoDEX or Hyperliquid (the "leader") and have its trades copied into your own SoDEX account, under rules you set yourself (section 3). You are the "follower".' },
        {
          ul: [
            'Copies are placed only on SoDEX perpetual futures, in your own SoDEX account, as immediate-or-cancel limit orders (section 3). Spot trades are not copied, and neither are markets that SoDEX does not list.',
            'A leader is any public address. Leaders have not agreed to be copied, are not affiliated with ValueDesk, are not paid by ValueDesk or by you, and cannot stop being copied. They do not know you and owe you nothing. ValueDesk does not select, vet or monitor them.',
            'ValueDesk never holds your funds. They stay in your wallet and in your own SoDEX account. Copies are placed with a SoDEX API key that you register yourself with your wallet (section 2).',
            'ValueDesk charges a builder fee on every copied order (section 6).',
            '**Algo orders.** The executor you copy with, and its key, also carry out the algo orders you start there yourself (TWAP, VWAP, POV, DCA, iceberg, chase, scale, conditional, trailing stop, bracket, basket and Fill fast). These terms apply to them as they do to copies; what is different for them is in section 3.',
          ],
        },
        { p: '[[OWNER: licence status of the copy trading service, in particular of the hosted executor - or the licensed partner that provides it and its supervisory authority - or delete this paragraph]]' },
      ],
    },
    {
      title: '2. Where the copier runs: three modes',
      blocks: [
        { p: 'You choose where the copier runs. The mode decides who holds the key, who places the orders, and whether copying goes on while you are away.' },
        {
          ul: [
            '**Browser.** The copier runs in your open browser tab. Your browser generates a dedicated SoDEX API key and keeps it encrypted in this browser only; your wallet registers it on SoDEX with one signature, for at most seven days. Copying stops when the tab is closed, and nothing is copied while the computer sleeps or the connection is down. Stop-loss and take-profit orders the copier has already placed on SoDEX stay there. In this mode you can choose to approve each copied trade before it is sent.',
            '**Hosted (the ValueDesk executor).** ValueDesk\'s server in Tokyo, Japan (hosted by Contabo) generates a SoDEX API key for you and stores it encrypted on that server. You register the key on SoDEX with your wallet, for the number of days you choose (at most 180), and you can revoke it at any time. From then on the executor places your copies around the clock, according to your rules, **without asking you before each trade**.',
            '**Self-hosted.** You run the open-source ValueDesk executor (MIT licence) on your own computer or server. The key is generated and stored there; ValueDesk receives no key and no orders. Running, updating and securing it is up to you, and copying stops whenever it is not running.',
          ],
        },
        { p: '**What the key can do.** SoDEX offers no API key that can trade but cannot move funds. According to SoDEX\'s documentation, the key used for copying - in every mode - can place and cancel orders and change leverage and margin, and it can also move funds between your own SoDEX spot account, your perps account and your own wallet. According to SoDEX, it cannot send funds to anyone else. Whoever holds the key can trade your account (section 7).' },
        { p: '**A key you made yourself.** With the hosted or a self-hosted executor you can instead make the API key yourself on sodex.com and give it to the executor. Its private key is encrypted in your browser so that only that executor can read it. The executor uses it only when SoDEX lists it on your own account under the name you give, valid for at most 180 days. Everything in these terms about the copy key applies to such a key too; keeping any other copy of it safe is up to you.' },
        { p: 'We update the copier we provide - the hosted executor and the browser copier - from time to time, and an update can change how your rules are carried out. [[OWNER: how followers learn of updates, e.g. the version shown in the app and published release notes]] With a self-hosted executor you decide which version you run.' },
      ],
    },
    {
      title: '3. Your copy rules, and how copies are placed',
      blocks: [
        { p: 'You set every rule of a copy yourself; nothing is chosen for you:' },
        {
          ul: [
            '**direction**: copy (take the leader\'s side) or counter-trade (take the opposite side: when the leader opens or adds to a long, your copy opens or adds to a short of the size your sizing rule gives, and the other way round; when the leader reduces, closes or flips, your copy reduces by the same fraction, closes or flips the other way). The direction is set when a copy starts and cannot be changed while it runs;',
            '**allocation**: the amount in USD you set aside for this leader. It is a figure the copier sizes by, not a separate account: copies use the margin in your SoDEX perps account, and a loss is not limited to the allocation;',
            '**sizing**: proportional (the leader\'s position as a share of the leader\'s account value, applied to your allocation), fixed ratio (a fixed fraction of the leader\'s position) or fixed amount (a fixed USD amount per copied opening; when the leader reduces, the copy reduces by the same fraction);',
            '**limits**: maximum leverage (for each copied position and for the copy\'s total exposure), maximum size per position, stop-loss and take-profit (as a share of each copied position\'s margin), and a drawdown stop for the whole copy;',
            '**markets**: coins to copy only, and coins never to copy;',
            '**existing positions**: whether to join the positions the leader already holds when you start - at the price then, not at the leader\'s entry;',
            '**execution**: the worst price you accept per order (slippage cap), isolated or cross margin, and - in browser mode only - whether each trade waits for your approval;',
            '**paper mode**: everything runs, but nothing is sent to SoDEX and no fee is charged.',
          ],
        },
        { p: 'How copies are placed:' },
        {
          ul: [
            'When the leader opens, adds to, reduces or closes a position, the copier works out the order your rules call for and sends it to SoDEX as an immediate-or-cancel limit order: it fills at once what it can, at a price no worse than your slippage cap from SoDEX\'s mark price, and the rest is cancelled. It never rests on the order book.',
            'Your caps, the regional limit (section 5), SoDEX\'s minimum order sizes and its market rules can make a copy smaller than your sizing rule, or cause it to be skipped. The copy\'s activity log records skipped trades with their reason; routine ones - such as a leader\'s spot trade, or a change your copy already matches - are left out.',
            'If you set a stop-loss or take-profit, the copier also places a stop order on SoDEX for each copied position: a reduce-only market order triggered by SoDEX\'s mark price. It stays on SoDEX after the copier stops, until it triggers or you cancel it.',
            'The drawdown stop closes all positions of a copy and halts it when the copy\'s equity has fallen by the share you set below its peak. It works only while the copier runs.',
            'The copier leaves positions you opened yourself alone. It does not copy into a market where you hold your own position, or where another of your copies holds one.',
            'With approval of each trade (browser mode), a trade you do not confirm in time is skipped, never sent.',
          ],
        },
        { p: '**Algo orders.** An algo order is not a copy: it is an order you set up and start yourself, and the executor works it for you as you set it.' },
        {
          ul: [
            'You set every part of it: the market, side and size, its kind and settings (for example duration and slices, price levels, conditions, a trailing distance), its limits, and any take-profit and stop-loss. The order panel shows what it will do, every order it will send and its fees before you start it, and you start it with a signed instruction.',
            'Unlike copies, an algo order can rest orders on SoDEX\'s order book (limit and post-only orders) and send market orders within the slippage you set. Resting orders can fill at any time while they are there, including after you stopped watching.',
            'You can pause, change or cancel it at any time. A cancel pulls its resting orders; what has filled stays filled, and positions stay open. Its take-profit and stop-loss are stop orders on SoDEX and stay there until they trigger or you cancel them, also after the algo order itself has ended.',
            'A practice run works against the live market but sends nothing to SoDEX and costs no fee. Real algo orders are available only where ValueDesk has switched them on for the executor you use.',
          ],
        },
      ],
    },
    {
      title: '4. Your instructions and signatures',
      blocks: [
        { p: 'Every instruction you give is a message your wallet signs (EIP-712): accepting these terms, creating a key, starting a copy, changing, pausing, resuming or stopping it, stopping all copies, and deleting a key. Your wallet shows what you sign - the action and, as readable text, the leader and every rule. Check it before you sign.' },
        {
          ul: [
            'A signed instruction is valid only for the executor it names and only for a short time, and it cannot be used twice.',
            'We treat an instruction signed by your wallet as yours. Anyone who controls your wallet can give instructions in your name - protect it.',
            'When you accept these terms, you sign their version, a fingerprint (hash) of their text, the country you live in and the four statements shown before you sign. This is the record of what you agreed to (section 11).',
            'ValueDesk acts only on signed instructions. We take no instructions by e-mail, chat or in any other way, and we will never ask for your wallet\'s recovery phrase or for a copy key.',
            'The executor carries out an instruction once it has received and checked it. An order sent before that can still fill.',
          ],
        },
      ],
    },
    {
      title: '5. Who may copy, and regional limits',
      blocks: [
        { p: 'You may copy only if:' },
        {
          ul: [
            'you are at least 18 years old and able to enter into binding contracts;',
            'you are not a US person, and you neither live in nor connect from the United States or its territories (Puerto Rico, the US Virgin Islands, Guam, American Samoa, the Northern Mariana Islands and the US Minor Outlying Islands). "US person" means [[OWNER: the definition of US person, e.g. a natural person resident in the United States or its territories, or an entity organised or located there - and whether US citizens living elsewhere are excluded too]];',
            'you neither live in nor connect from the United Kingdom (England, Scotland, Wales and Northern Ireland; not the Channel Islands, the Isle of Man or the British Overseas Territories) or Canada;',
            'you neither live in nor connect from Cuba, Iran, North Korea, Syria, Russia, Belarus or Myanmar, and you are not subject to sanctions. Your wallet and the trader you copy must not be on a sanctions list: the executor checks both addresses against the public sanctions data it holds (the crypto addresses on OFAC\'s Specially Designated Nationals list, as mirrored by the Chainalysis sanctions oracle), refuses to start or change a copy for a listed wallet and holds copies that are running;',
            'copy trading, perpetual futures and the use of a copy service are lawful for you where you live and where you are.',
          ],
        },
        { p: '**Which country counts.** You declare your country of residence when you accept these terms. With the hosted executor, the country of the IP address your requests come from is checked as well; where the two differ, the stricter rule applies and the difference is recorded. Declare your country truthfully, accept the terms again with your new country if you move, and do not hide where you are - for example with a VPN - to get around these rules. Neither check proves where you are; your declaration is your responsibility.' },
        { p: '**In the EEA: at most 2x leverage.** If the country that counts is in the European Economic Area (the 27 EU member states, Iceland, Liechtenstein and Norway, including EU territories with a country code of their own: Réunion, Guadeloupe, Martinique, French Guiana, Mayotte, Saint-Martin and Åland), every copy is limited to 2x leverage: no copied position is set above 2x, and the copy\'s total exposure (the value of its open positions) cannot exceed twice its equity. This reflects the leverage limit ESMA set for retail clients on leveraged crypto products. Copies of a leader who uses more leverage are then smaller than your sizing rule would make them, or skipped, and your results differ more from the leader\'s. The limit is not an assessment that 2x leverage is suitable for you.' },
        { p: 'If the country that counts is excluded, you cannot start or keep a copy: nothing more is copied, and copied positions stay open in your SoDEX account for you to manage. We may refuse or end copy trading for you where we have reason to believe these conditions are not met.' },
      ],
    },
    {
      title: '6. Fees',
      blocks: [
        { p: 'ValueDesk charges a builder fee on every copied order: openings, additions, reductions and closes, and the stop-loss and take-profit orders the copier places. The rate follows your verified trading volume through ValueDesk over the last 14 days, as ValueDesk\'s fee ledger counts it (the same count as for the fee tiers in section 4 of the [Terms of use](/terms)):' },
        {
          ul: [
            'under $100,000: 0.025% (2.5 basis points) of the order\'s value;',
            'from $100,000: 0.02%;',
            'from $500,000: 0.015%;',
            'from $2,000,000: 0.012%;',
            'from $10,000,000: 0.01%.',
          ],
        },
        {
          ul: [
            'SoDEX charges the fee on each fill and credits it to ValueDesk\'s SoDEX builder account. Before your first copy you approve ValueDesk\'s builder fee on SoDEX with your wallet, up to a ceiling of 0.025%; an approval you already gave for trading through ValueDesk covers copies if its ceiling is at least 0.025%. A copied order is never charged more than the ceiling you approved.',
            'You can revoke the approval on SoDEX at any time. No copy is placed without it: your copies are blocked until you approve again, and then resume by themselves.',
            'SoDEX\'s own trading fees and funding apply on top. Fees already charged are not refunded. Paper copies carry no fee.',
            'Because the fee is charged on every copied order, ValueDesk earns more when the leader you copy trades more often and when your copies are larger. ValueDesk\'s leaderboards and statistics do not rank traders by what copying them would earn ValueDesk.',
            'The same fee, at the same rate, applies to every order an algo order sends on the hosted or a self-hosted executor: its slices, levels and other orders, and its take-profit and stop-loss orders.',
            'The fee applies in every mode. In browser mode your copies pay the rate for the volume ValueDesk\'s fee ledger last reported for your wallet; a self-hosted executor cannot read that ledger and therefore charges the rate for volumes under $100,000. The builder a self-hosted executor attaches is one of its settings.',
          ],
        },
        { p: 'Orders you place by hand keep the builder fee in section 4 of the [Terms of use](/terms).' },
      ],
    },
    {
      title: '7. Risk disclosure',
      blocks: [
        { p: '**Copying trades in perpetual futures carries a high risk of losing money quickly. You can lose your whole allocation, and with leverage or cross margin more than that. Only copy with money you can afford to lose completely.**' },
        {
          ul: [
            '**Total loss.** The allocation is not a limit: copies use the margin in your SoDEX perps account. With cross margin a losing copy can use up your whole account; with isolated margin each position can be liquidated down to nothing. ValueDesk offers no negative balance protection.',
            '**Leverage and liquidation.** Perpetual futures are complex derivatives. With leverage, a small price move causes a large loss. Positions can be liquidated automatically within minutes, and SoDEX may reduce or close positions under its own rules.',
            '**Past performance is no guide to the future.** A leader\'s past results, rankings and statistics do not predict future results. They come from public data that can be incomplete, delayed or wrong, and a good record can be luck, a short period or a strategy that fails when markets change. Rankings show the traders who did well; the many who did not are easy to overlook.',
            '**The leader.** The leader has not agreed to be copied, does not know you and owes you nothing. A leader can change style, raise leverage, trade larger or smaller, stop trading, be liquidated, or trade against the traders who copy them - for example by opening a position in a thin market and selling into the copies that follow. What you see may be only part of the leader\'s activity: a position copied from one address can be a hedge of positions held elsewhere.',
            '**Your copy is not the leader\'s trade.** Copies are placed after the leader\'s trade, at SoDEX\'s prices and with SoDEX\'s fees, funding and liquidity - which differ from Hyperliquid\'s when the leader trades there. Copies can be smaller than your rule, rounded, partly filled or skipped: because of your caps and slippage cap, the regional limit, SoDEX\'s minimum sizes, a market SoDEX does not list, or because the leader\'s account value is not known. Existing positions you join start at the price then. Your result can differ widely from the leader\'s, in either direction.',
            '**Slippage and many followers.** In a fast market the price can move beyond your slippage cap before your order arrives, and the copy is then not filled. Many followers can copy the same leader: their orders reach SoDEX one after another, in random order, at the same limit price, so later orders can fill worse or not at all, and together they can move the price against you.',
            '**Delays and missed trades.** The data streams of SoDEX and Hyperliquid can lag or drop. A missed trade is caught up at the next check of the leader\'s positions, which can take a minute or more and happens at a different price. Outages of SoDEX, Hyperliquid, ValueDesk, its hosting providers or your connection can delay or stop copies.',
            '**When copying stops, positions stay open.** If the tab is closed, the executor stops, the key expires or is revoked, or a copy is paused, blocked or stopped without closing, your copied positions stay open and are no longer adjusted when the leader closes. The drawdown stop and the copier\'s other checks no longer run; only the stop orders already on SoDEX remain.',
            '**Automatic execution.** With the hosted or a self-hosted executor, copies are placed around the clock - at night and while you are away - without asking you before each trade. A rule is carried out as you set it, mistakes included.',
            '**Stops are not guarantees.** Stop-loss and take-profit orders are triggered by SoDEX\'s mark price and fill as market orders, possibly far from the trigger in a fast market. The drawdown stop works only while the copier runs and relies on the copier\'s own estimate of the copy\'s equity.',
            '**The key.** Whoever obtains your copy key can trade your account until it expires or is revoked - for example at bad prices in thin markets - and, according to SoDEX, move funds between your own SoDEX accounts and your wallet. In browser mode the key is on your device; in hosted mode it is stored encrypted on ValueDesk\'s server, which can be attacked like any server; with a self-hosted executor it is on your machine.',
            '**Software errors.** The copier and the executor are software and can contain errors - for example an order of the wrong size or direction, or a copy that is not placed. We test them but cannot rule errors out. An update can change how your rules are carried out.',
            '**The exchange.** SoDEX is a third-party exchange. Its insolvency, a hack, an outage, a halted market or a change of its rules can cause you losses that nobody makes good. Leader data from Hyperliquid can be wrong or unavailable.',
            '**Fees.** The builder fee is charged on every copied order, including reductions, closes and stop orders, on top of SoDEX\'s fees and funding. A leader who trades often causes many copied orders, and the fees can outweigh small gains.',
            '**Counter-trading.** A counter-trade takes the side opposite the leader on every position. It gains when the leader\'s positions lose and loses when they gain, by roughly as much, plus fees and funding on both legs of every change. A leader with a good record is therefore a risk to a counter-trade, not a safeguard, and a losing past record does not mean the leader will keep losing. A position that is a hedge for the leader (see "The leader" above) is an unhedged position for you. Your loss is not limited by the leader\'s: a leader can win many times in a row, and your caps and stops apply as for any copy.',
            '**Algo orders.** An algo order carries out exactly the settings you gave it, mistakes included, around the clock and without asking you before each order. Its resting orders can fill in a sudden move; a schedule can buy or sell into a falling or rising market; a conditional or trailing stop can fire on a brief spike. Its plan and fee estimate are estimates at the moment you start it, not a promise of prices or fills.',
            '**Paper copies** and practice runs are simulations. Real copies and orders can fill differently, later or not at all, and they carry fees.',
            '**Legal and tax risk.** Copy trading and perpetual futures may be restricted or forbidden where you live. The law on copy trading is changing, and the service may have to be limited or ended at short notice (section 14). Gains may be taxable.',
          ],
        },
      ],
    },
    {
      title: '8. What ValueDesk does not do',
      blocks: [
        {
          ul: [
            '**No advice.** Nothing on ValueDesk is investment, financial, legal or tax advice, or a recommendation to copy any trader or to use any rule. Leaderboards, rankings, cohorts and trader statistics are the same for every visitor and are ranked by objective metrics computed from public data; they describe what happened, not what will happen. ValueDesk does not suggest traders to you personally.',
            '**No assessment of you.** ValueDesk does not check whether copy trading, a leader or your rules are suitable or appropriate for you, your knowledge, your finances or your goals.',
            '**No vetting of leaders.** ValueDesk does not select, verify, vet, monitor or limit the traders you can copy, and knows nothing about them beyond their public trading data.',
            '**No custody.** ValueDesk does not hold, pool or invest your funds and is not the counterparty of your trades, which are executed on SoDEX. Your funds stay in your own SoDEX account, and according to SoDEX a copy key cannot send them to anyone but you.',
            '**No guarantee.** ValueDesk does not guarantee any result, that a trade is copied, at what price or how fast, or that the copier, the executor or SoDEX is available.',
            '**No protection against losses.** ValueDesk offers no negative balance protection, no insurance and no compensation for losses. Whether a loss can exceed your account balance is governed by SoDEX\'s terms.',
            '**No decisions for you.** ValueDesk does not choose leaders or rules for you and does not change your rules; only you can, by a signed instruction. The copier carries out your rules within the limits in sections 3 and 5.',
          ],
        },
      ],
    },
    {
      title: '9. Your responsibilities',
      blocks: [
        {
          ul: [
            '**Lawful use.** Check that copy trading, perpetual futures and this service are lawful for you, and keep to the conditions in section 5.',
            '**Taxes.** Gains from copied trades may be taxable. Declaring and paying taxes is up to you; ValueDesk issues no tax statements.',
            '**Security.** Protect your wallet, its recovery phrase and your device. In browser mode the copy key is on your device, with a self-hosted executor on your machine - securing them is up to you. If you suspect that a key or your wallet is compromised, stop all copies and revoke the key on SoDEX at once.',
            '**Monitoring.** Check your copies, their activity log and your SoDEX account regularly - in hosted mode especially, because copies run while you are away. Keep enough margin in your account: when margin runs short, copies are skipped and positions can be liquidated.',
            '**Read what you sign** (section 4), and choose rules you understand. Paper mode lets you see how a rule behaves without sending orders.',
            '**Hands off copied markets.** Do not trade by hand in a market a copy holds: the copier works from what it finds on SoDEX, and the result can differ from the leader\'s and from what you intended.',
            '**No misuse.** Do not copy addresses you control to create volume or to reach a lower fee, do not use copy trading for wash trades or market manipulation, and do not attack the executor or try to get around its limits or the regional rules.',
          ],
        },
      ],
    },
    {
      title: '10. Stopping copies',
      blocks: [
        {
          ul: [
            '**Pause** a copy: nothing new is copied, and its positions stay open. **Resume** it to continue.',
            '**Stop** a copy: this is final. You choose whether its copied positions are closed or left open.',
            '**Stop all** (the kill switch) stops every copy at once and, if you choose, closes all copied positions. Closing orders are immediate-or-cancel orders like any copy and can fill partly or not at all in a fast or thin market; check your SoDEX account afterwards.',
            '**Drawdown stop**: closes a copy\'s positions and halts it when the drawdown you set is reached (section 3).',
            '**Revoke the key on SoDEX** - the hard stop. Once SoDEX has processed the revocation, no order can be placed with the key, whatever happens at ValueDesk. Stop orders the copier already placed stay on SoDEX until they trigger or you cancel them, and open positions stay open. [[OWNER: where the follower revokes the key - the control in the app and/or the place on SoDEX]]',
            'In browser mode, closing the tab stops copying. A hosted key can also be deleted from ValueDesk\'s server by a signed instruction; revoke it on SoDEX as well.',
            'A copy that is blocked - for a missing or expired key, a missing builder approval or the regional rule - resumes by itself once the condition is met again. To end a copy for good, stop it.',
            'A pause or stop takes effect when the executor has processed it; an order sent before then can still fill.',
          ],
        },
      ],
    },
    {
      title: '11. Records',
      blocks: [
        {
          ul: [
            '**Hosted.** The ValueDesk executor keeps every instruction you signed, exactly as you signed it (nothing in that log is changed or deleted); the terms you accepted, with their version and fingerprint, the country you declared, the country of your IP address and the time; your copy rules and the state of each copy; and an activity log of the orders sent, fills, skipped trades with their reasons, status changes and errors. You can read your own signed instructions and activity log through the executor after signing in with your wallet.',
            '**Your acceptance of these terms, in every mode.** The message you signed to accept them - their version and fingerprint, the country you declared, the four statements and your wallet address - is sent to the ValueDesk executor and kept there with the country of your IP address and the time, as ValueDesk\'s record of who accepted which terms. With a self-hosted executor the same signed message is kept there too.',
            '**Browser and self-hosted.** Everything else - your copy rules, your other instructions and the activity of your copies - stays in your browser or on your executor; ValueDesk does not receive it. Keep it if you may need it.',
            'SoDEX records every order and fill in your account; its records show what was executed and at which price.',
            'How long records are kept, and your rights over them: [Privacy policy](/privacy), section 8.',
          ],
        },
      ],
    },
    {
      title: '12. Liability',
      blocks: [
        { p: 'We are liable without limitation for damage caused intentionally or by gross negligence, for injury to life, body or health, under the German Product Liability Act, and where we have given a guarantee. For slight negligence we are liable only for the breach of an obligation that is essential to the proper performance of these terms and on which you may regularly rely, and then only for the damage typical and foreseeable when the obligation was breached. Otherwise our liability is excluded.' },
        { p: 'Unless one of the cases in the first two sentences applies, we are in particular not liable for losses that result from the trades of the leader you chose or from the rules you set, from market movements, from the acts and failures of SoDEX, Hyperliquid, blockchains, wallet providers and hosting providers, or from a wallet, key or device you did not keep safe. These limits also apply to the personal liability of our employees, representatives and agents.' },
      ],
    },
    {
      title: '13. Changes to these terms',
      blocks: [
        { p: `We may change these terms for the future, for example when the service, the fees or the law change. Every version has its own number (this one: ${COPY_TERMS_VERSION}). A new version applies to you only once you accept it by signing it with your wallet; until then you cannot start a new copy. [[OWNER: what happens to running copies, and to changes of them, until a follower accepts a new version - e.g. they continue under the accepted version for N days and are then paused]] If you do not accept a new version, you can stop copying at any time, and we may end hosted copy trading for you as set out in section 14.` },
      ],
    },
    {
      title: '14. Ending copy trading',
      blocks: [
        {
          ul: [
            'You can stop copying at any time, without notice and at no cost: stop all copies, revoke the key on SoDEX, and revoke the builder approval if you no longer want it.',
            'We may end copy trading, or one of its modes, for you or for everyone with [[OWNER: notice period, e.g. 14 days]] notice in the app, and without notice for good cause - in particular if the law or an authority requires it, if you break section 5 or 9, or to protect your account or our systems from an attack. We may also stop accepting new copies while running copies continue.',
            'When copying ends, nothing more is copied. Your copied positions stay open in your SoDEX account, and stop orders already on SoDEX stay there; managing them is up to you. A key you registered stays valid on SoDEX until it expires or you revoke it - revoke it.',
            'Records are kept as set out in section 11 and the [Privacy policy](/privacy).',
          ],
        },
      ],
    },
    {
      title: '15. Right of withdrawal',
      blocks: [
        { p: '[[OWNER: whether consumers have a right of withdrawal for the copy service (distance contract, §§ 312g, 355, 356 BGB, including the rules for financial services) - ask counsel. If they have, insert the withdrawal instructions here and, where required, the online withdrawal function; otherwise delete this section]]' },
      ],
    },
    {
      title: '16. Law and place of jurisdiction',
      blocks: [
        { p: 'These terms are governed by [[OWNER: the governing law, e.g. the law of the Federal Republic of Germany, excluding the UN Convention on Contracts for the International Sale of Goods, as in the Terms of use]]. If you are a consumer, the mandatory consumer protection of the country where you habitually reside still applies. If you are a merchant, a legal person under public law or a special fund under public law, the place of jurisdiction is [[OWNER: the city of the provider\'s registered office]].' },
        { p: 'If a provision of these terms is invalid, the rest remain in force. Questions: see the [Impressum](/impressum).' },
      ],
    },
  ],
};

/** The most important risks, for the copy setup sheet: each one sentence, each standing on its own. */
export const COPY_RISK_SUMMARY: string[] = [
  'You can lose your whole allocation quickly, and with leverage or cross margin more than that - up to everything in your SoDEX perps account.',
  'A trader\'s past results do not predict future results, and nothing on ValueDesk is a recommendation to copy anyone.',
  'The trader you copy has not agreed to be copied, owes you nothing, and can change style, raise leverage, be liquidated or trade against the traders who copy them at any time.',
  'A counter-trade takes the opposite side of the trader: it loses whenever they win, and their good record is then your risk.',
  'Your results will differ from the trader\'s, because copies are placed later, at SoDEX\'s prices, fees and funding, and can be smaller, partly filled or skipped.',
  'In hosted mode, ValueDesk\'s server places your copies around the clock according to your rules, without asking you before each trade.',
  'Outages, delays and software errors can cause missed, late or wrong copies, and your copied positions stay open whenever copying stops.',
  'Anyone who obtains your copy key can trade your SoDEX account and move funds between your own SoDEX accounts and wallet until the key expires or you revoke it on SoDEX.',
  'Every copied order costs a builder fee of up to 0.025% on top of SoDEX\'s fees and funding, which reduces your result even on trades that break even.',
];

/** The statements of AcceptTermsPayload (packages/copy-engine/src/api.ts) a follower ticks before signing. */
export type CopyStatementId = 'adult' | 'notUsPerson' | 'ownDecision' | 'risksUnderstood';

/** The four checkboxes before the follower signs the terms, in the order shown. */
export const COPY_STATEMENTS: Array<{ id: CopyStatementId; label: string }> = [
  { id: 'adult', label: 'I am at least 18 years old and able to enter into binding contracts.' },
  { id: 'notUsPerson', label: 'I am not a US person, I do not live in or connect from the United States or its territories, the United Kingdom or Canada, or from Cuba, Iran, North Korea, Syria, Russia, Belarus or Myanmar, and the country of residence I declared is true.' },
  { id: 'ownDecision', label: 'I chose the trader and every copy rule myself. Nobody, including ValueDesk, recommended them to me.' },
  { id: 'risksUnderstood', label: 'I have read the copy trading terms and risk disclosure, and I understand that I can lose my whole allocation, and with leverage more than that.' },
];

/** Shown before the hosted executor creates the follower's key. */
export const HOSTED_KEY_NOTICE: string =
  'ValueDesk\'s executor will now create a SoDEX API key for you, and you register it on SoDEX with your wallet for the number of days you choose (at most 180). '
  + 'The key is stored encrypted on ValueDesk\'s server in Tokyo, Japan (hosted by Contabo). '
  + 'While it is valid, the executor uses it to place your copies around the clock, according to your copy rules and without asking you before each trade. '
  + 'SoDEX has no key that can trade but cannot move funds: according to SoDEX, this key can also move funds between your own SoDEX spot account, perps account and your own wallet, though not to anyone else. '
  + 'You can stop your copies in the app at any time. To cut the executor off completely, revoke the key on SoDEX with your wallet; once SoDEX has processed that, no order can be placed with it.';

/**
 * The copy trading terms of 2026-11-10 (the EEA 2x leverage cap removed), as followers saw and signed them (keccak256 of canonicalJSON = the signed termsHash).
 * FROZEN: never edit a published version - a change is a new file and a new COPY_TERMS_VERSION (terms/index.ts).
 */
import type { TermsDoc } from './doc.ts';

export const COPY_TERMS_2026_11_10: TermsDoc = {
  page: 'copy-terms',
  title: 'Copy trading terms and risk disclosure',
  lang: 'en',
  updated: '[[OWNER: date, e.g. 1 November 2026]]',
  intro: [
    { p: `Version 2026-11-10. These terms apply when you copy trades with ValueDesk at www.valuedesk.so (and any other address it is offered at), provided by the operator named in the [Impressum](/impressum) ("we"). They add to the [Terms of use](/terms); for copy trading, these terms prevail where the two differ. You accept them by signing them with your wallet before your first copy.` },
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
            '**Bots.** The same executor and key also run the bots you start (automated trading strategies such as market making or grids, section 3A). These terms apply to them as they do to copies; what is different for bots is in section 3A.',
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
        { p: '**If the hosted executor is attacked.** The hosted keys are stored encrypted, and the executor acts only on instructions your wallet signed. But the key that decrypts them is on the same server, so someone who takes control of that server could use the keys stored there until they expire or are revoked. If we suspect that, we stop the executor and the copies and algo orders on it (section 10), tell the followers affected in the app and on our site without undue delay, and ask them to revoke their key on SoDEX - which only your wallet can do. Choose a short key lifetime and keep in your perps account only what you are prepared to have traded by the copier: that limits what a stolen key can do.' },
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
        { p: '**Bots.** A bot (the volume maker, the grid and the DCA bot on the Bots page) is an automated trading strategy you choose, configure and start yourself on the ValueDesk executor. It is an algo order that runs until you stop it or it reaches a limit you set, and everything above about algo orders applies to it.' },
        {
          ul: [
            'A bot keeps orders resting on SoDEX\'s order book in your account around the clock - buys and sells - and builds and unwinds positions as they fill, without asking you before each order. It aims at trading volume at a low cost, not at a profit: it can lose money, through price moves against what it holds, through fees, and through a market that moves faster than it can follow.',
            'Its limits - an inventory cap, a loss limit, a volume target, an end time - are checked by the executor as it runs. They are not stop orders on SoDEX: in a fast market, during an outage or while the emergency brake is on, a bot can lose more than its loss limit before it stops.',
            'When a bot stops it pulls its resting orders and, if you chose so, closes what it holds: resting at the best price first, then at the market within a price limit. A stop by the kill switch (stop all) pulls the orders and closes nothing.',
            '**No wash trading.** A bot must not be used to trade with yourself or with accounts you control, or to create the appearance of trading activity. You may run one bot per market per account. ValueDesk\'s executor never lets one user\'s bot fill against another user\'s bot: its orders rest (post-only) and its closing orders are priced so they do not reach another bot\'s order.',
            'Real bots are available only where ValueDesk has switched them on for you (for now: the beta channel at beta.valuedesk.so, for wallets on its list). Practice bots run against the live market and send nothing.',
          ],
        },
      ],
    },
    {
      title: '3A. Bots',
      blocks: [
        { p: 'A bot is an automated trading strategy - for example making markets (quoting to buy and to sell close to the price) or a grid - that ValueDesk\'s servers run around the clock in your own SoDEX account, with your trading key and the settings you choose: its market, its sizes, the most it may hold, its leverage, its loss limit, its run time and its safeguards. You can change its settings, pause it and stop it at any time; most changes apply to the running bot at once.' },
        {
          ul: [
            '**What a bot does on its own.** To keep within your settings and to protect your account, a bot may at any time and without asking you: pull, re-price, shrink or not place its orders; wait while the market is too fast, too thin or not trading, or while SoDEX refuses orders; set the leverage you chose on its market; and close what it holds when it reaches your loss limit, run time or volume target, or when you stop it with a close. As a last resort - when SoDEX keeps refusing its orders for reasons the bot cannot handle - it closes what it holds and stops, even if it was set to keep its position. A close can be a market order with slippage.',
            '**Its own position only.** A bot starts only on a market where you hold no position and run no other bot, copy or algo order, and it manages only what it bought and sold itself. If its position is closed or reduced outside it (by you, by a stop or by a liquidation), the bot records that at the price then and goes on from what is left.',
            '**Orders.** Unless you choose otherwise in its settings, a bot\'s quotes are post-only (they only rest in the order book and pay the maker fee); with another choice they can fill at once and pay the taker fee. Its sizes are never below SoDEX\'s minimum order.',
            '**Leverage and margin.** You choose the leverage, or let the app choose the lowest that fits your free margin; it can be up to the maximum SoDEX allows on the market. The margin a bot "sets aside" is an estimate for planning: SoDEX holds the margin, and a bot\'s position shares your account\'s margin with everything else in it.',
            '**Servers.** Bots may run on different ValueDesk servers (for example VIP servers for wallets that qualify) and may be moved between them with their settings, positions and history - when you ask, and automatically when you no longer qualify (at most once a day). A move pauses the bots for a few seconds; nothing is closed by it.',
            '**Availability.** Real bots may be offered to some wallets only (for example a beta list). We may limit how many bots run, refuse to start one, or hold bots when our servers or SoDEX are under strain or under attack (the emergency brake, section 10).',
            '**Estimates and practice.** Costs per $1M, estimates, rankings and past results shown for bots and markets come from past data and are not a promise. Practice bots are simulations against the live market; real bots can fill differently, later or not at all.',
          ],
        },
      ],
    },
    {
      title: '4. Your instructions and signatures',
      blocks: [
        { p: 'Every instruction you give is a message your wallet signs (EIP-712) - accepting these terms, creating a key, starting a copy, a bot or an algo order, changing, pausing, resuming or stopping it, stopping all of them, moving bots between our servers, and deleting a key - or a message signed by a session key your wallet approved (below). Your wallet shows what you sign - the action and, as readable text, its settings. Check it before you sign.' },
        { p: '**Session keys.** So that you do not have to sign every everyday instruction with your wallet, your browser can create a session key and your wallet can approve it, with one signature, for a limited time (at most 24 hours, for one executor). Until it expires the session key signs your everyday instructions in your name - signing in, starting, changing, pausing, resuming and stopping copies, bots and algo orders, and moving bots between our servers. It can never accept terms, create or delete a trading key, approve another session key, or move funds. The browser keeps it so that it can be used but not read out. You can revoke all of your session keys at any time with one wallet signature (in the bot setup); instructions signed with a revoked or expired session key are refused. Anyone who can use your browser while a session key is valid can give such instructions in your name - protect your device as you protect your wallet. The time limit, the instructions a session key may sign and the way it is kept may be tightened at any time; they are never widened without a new version of these terms.' },
        {
          ul: [
            'A signed instruction is valid only for the executor it names and only for a short time, and it cannot be used twice.',
            'We treat an instruction signed by your wallet, or by a session key it approved, as yours. Anyone who controls your wallet can give instructions in your name - protect it.',
            'When you accept these terms, you sign their version, a fingerprint (hash) of their text, the country your connection comes from and the four statements shown before you sign. This is the record of what you agreed to (section 11).',
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
        { p: '**Which country counts.** The country is taken from your connection, as our hosting provider reports it; you cannot choose it. You sign these terms for that country, and with the statements you confirm that you do not live in an excluded place either. With the hosted executor, the country your requests come from is checked again when you start, change or resume a copy; where it differs from the one you signed for, the stricter rule applies and the difference is recorded. If the country cannot be determined, you cannot accept these terms or start a copy. Do not hide where you are - for example with a VPN or a proxy - to get around these rules: the country we see does not prove where you are or where you live, and meeting the conditions above is your responsibility.' },
        { p: '**No regional leverage limit.** Wherever you are allowed to use ValueDesk, copies, algo orders and bots use the leverage your rules or settings allow, up to the maximum SoDEX allows on the market. Authorities such as ESMA limit leverage for retail clients on some leveraged crypto products (for CFDs on crypto-assets: 2x); ValueDesk applies no such limit for you, and that a higher leverage can be chosen does not mean it is suitable or allowed for you. Choosing it is your decision (section 3A).' },
        { p: 'If the country that counts is excluded, you cannot start or keep a copy: nothing more is copied, and copied positions stay open in your SoDEX account for you to manage. We may refuse or end copy trading for you where we have reason to believe these conditions are not met.' },
      ],
    },
    {
      title: '6. Fees',
      blocks: [
        { p: 'ValueDesk charges a builder fee on every copied order: openings, additions, reductions and closes, and the stop-loss and take-profit orders the copier places. The rate follows your verified trading volume through ValueDesk over the last 14 days, as ValueDesk\'s fee ledger counts it (the same count as for the fee tiers in section 6 of the [Terms of use](/terms)):' },
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
            'A bot\'s orders carry ValueDesk\'s bot fee instead, and nothing else: at most 0.005% (0.5 bp) of their value, lower with your verified 14-day volume or with VIP status, at the rate shown in the fee schedule in the app (on the trade page) when the order is placed. A bot order never carries the copy fee or the fee for orders you place by hand as well. Your approval of a higher ceiling covers it.',
            '**Rates may only fall without your signature.** The rates in this section, and the bot fee of at most 0.005%, are the highest that apply. We may lower them, add volume steps, or offer lower rates for a time (for example VIP status or a programme) at any time; the fee schedule in the app shows the rates in force. A rate above those stated here applies only after you accept a new version of these terms, and never above the ceiling you approved on SoDEX.',
            'The fee applies in every mode. In browser mode your copies pay the rate for the volume ValueDesk\'s fee ledger last reported for your wallet; a self-hosted executor cannot read that ledger and therefore charges the rate for volumes under $100,000. The builder a self-hosted executor attaches is one of its settings.',
          ],
        },
        { p: 'Orders you place by hand keep the builder fee in section 6 of the [Terms of use](/terms).' },
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
            '**Software errors.** Copy trading, algo orders and the executor are new software under active development and can contain errors - for example an order of the wrong size or direction, an order sent twice, a copy that is not placed, a stop that is not placed or not resized, or an order sent after you paused or stopped. We test them but cannot rule errors out. An update can change how your rules are carried out.',
            '**Rate limits and the exchange\'s interface.** SoDEX limits how many requests it accepts and can reject or delay orders or change its interface. Copies, algo orders, stops and closing orders can then fail or arrive late, also in a fast market.',
            '**The emergency brake.** If we suspect an attack, an error or a fault at SoDEX, we may pause all copies and algo orders at once and without notice (section 10). Nothing new is copied while it lasts, and positions stay open.',
            '**The exchange.** SoDEX is a third-party exchange. Its insolvency, a hack, an outage, a halted market or a change of its rules can cause you losses that nobody makes good. Leader data from Hyperliquid can be wrong or unavailable.',
            '**Fees.** The builder fee is charged on every copied order, including reductions, closes and stop orders, on top of SoDEX\'s fees and funding. A leader who trades often causes many copied orders, and the fees can outweigh small gains.',
            '**Counter-trading.** A counter-trade takes the side opposite the leader on every position. It gains when the leader\'s positions lose and loses when they gain, by roughly as much, plus fees and funding on both legs of every change. A leader with a good record is therefore a risk to a counter-trade, not a safeguard, and a losing past record does not mean the leader will keep losing. A position that is a hedge for the leader (see "The leader" above) is an unhedged position for you. Your loss is not limited by the leader\'s: a leader can win many times in a row, and your caps and stops apply as for any copy.',
            '**Algo orders.** An algo order carries out exactly the settings you gave it, mistakes included, around the clock and without asking you before each order. Its resting orders can fill in a sudden move; a schedule can buy or sell into a falling or rising market; a conditional or trailing stop can fire on a brief spike. Its plan and fee estimate are estimates at the moment you start it, not a promise of prices or fills.',
            '**Bots.** A bot trades continuously and can lose money even when it trades as designed: what it holds moves with the market, its fees add up over its volume, and the cost per $1M shown in the app is a figure from past fills, not a promise. Its loss limit is checked while it runs and can be overrun in a fast market.',
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
            '**No protection against losses.** ValueDesk offers no negative balance protection, no insurance and no compensation scheme for trading losses; what we are liable for is set out in section 12. Whether a loss can exceed your account balance is governed by SoDEX\'s terms.',
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
            '**Report errors at once.** If a copy or an algo order does something you did not expect, pause or stop it, check your SoDEX account and tell us at once at the address in the [Impressum](/impressum). If we tell you of an incident, follow what we ask you to do, such as revoking your key.',
            '**Limit what is at stake.** Keep in your SoDEX perps account only what you are prepared to have traded by the copier, choose a key lifetime no longer than you need, and know how to manage your positions on SoDEX directly.',
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
            '**The emergency brake.** If we suspect an attack, an error that sends wrong orders, or a fault at SoDEX, we may at once and without notice pause copies and algo orders on the executor we run - for everyone, a region or a wallet - and stop the executor. While the brake is on, no copied order is sent, algo orders are held (not cancelled), and no new copy or algo order can be started or resumed; stop orders already on SoDEX stay, and you can still pause, stop, stop and close, cancel and delete your key. Copies go on from the leader\'s next trade once we lift it, so trades the leader made in between may not be copied, or be caught up later at other prices. Using the brake for these reasons is not a breach of these terms.',
          ],
        },
      ],
    },
    {
      title: '11. Records',
      blocks: [
        {
          ul: [
            '**Hosted.** The ValueDesk executor keeps every instruction you signed, exactly as you signed it (nothing in that log is changed or deleted); the terms you accepted, with their version and fingerprint, the country you signed them for, the country of your IP address and the time; your copy rules and the state of each copy; and an activity log of the orders sent, fills, skipped trades with their reasons, status changes and errors. You can read your own signed instructions and activity log through the executor after signing in with your wallet.',
            '**Your acceptance of these terms, in every mode.** The message you signed to accept them - their version and fingerprint, the country you signed them for, the four statements and your wallet address - is sent to the ValueDesk executor and kept there with the country of your IP address and the time, as ValueDesk\'s record of who accepted which terms. With a self-hosted executor the same signed message is kept there too.',
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
        { p: 'We are liable without limitation for damage we cause intentionally or by gross negligence, for injury to life, body or health, for a defect we fraudulently concealed, where we have given a guarantee, under the German Product Liability Act, and wherever else the law does not allow liability to be limited.' },
        { p: 'For slight negligence we are liable only if we breach an essential obligation - an obligation whose fulfilment makes the proper performance of these terms possible in the first place and on whose fulfilment you may regularly rely, in particular that the copier and the executor place only the orders that your signed rules and instructions call for. Our liability is then limited to the damage that is typical for this kind of agreement and that was foreseeable when you accepted these terms. Otherwise our liability for slight negligence is excluded.' },
        { p: 'Providers we engage to run the copier - for example our hosting providers (Contabo, Vercel) and the messaging service we use (Telegram) - act on our behalf: for their faults we are liable as for our own, within the rules above. An attack on us or on them makes us liable only where we are at fault, for example because we did not take the security measures that could reasonably be expected.' },
        { p: 'We are not responsible for what is not our performance and not in our control: the trades of the leader you chose and the results of the rules you set, as long as the copier carried them out; market movements; the acts and failures of SoDEX, Hyperliquid, blockchains and wallet providers, which do not act on our behalf; a self-hosted executor you run, as far as its operation, updates and security are concerned; and the use of your wallet, device or a key by someone who gained control of it, unless we are at fault for that. This paragraph does not limit our liability under the first three paragraphs for our own breaches, including errors of the copier and the executor.' },
        { p: 'Where you contributed to a damage - for example by not acting on an incident notice of ours, by not reporting an error you noticed, or by not keeping your wallet or keys safe (section 9) - your claim is reduced accordingly (§ 254 of the German Civil Code). The rules for merchants in section 16 of the [Terms of use](/terms) apply to copy trading too. These limits also apply to the personal liability of our employees, representatives and agents.' },
      ],
    },
    {
      title: '13. Changes to these terms',
      blocks: [
        { p: '**What does not need a new version.** We improve the service all the time. Within these terms - without a new version and without your signature - we may: lower fees or add lower rates (section 6); add strategies, markets, features, safeguards, servers or settings; change how the software carries out your settings, including the safety measures in section 3A, as long as it does not trade beyond the limits you set; tighten security measures (for example session keys, section 4); correct mistakes in wording; and adapt these terms to changes of SoDEX\'s rules or of the law that do not reduce your rights. We tell you of material changes in the app.' },
        { p: `We may change these terms for the future, for example when the service, the fees or the law change. Every version has its own number (this one: 2026-11-10). A new version that adds to your obligations, raises a fee above what these terms allow, or reduces your rights applies to you only once you accept it by signing it with your wallet; until then you cannot start a new copy or bot. [[OWNER: what happens to running copies, and to changes of them, until a follower accepts a new version - e.g. they continue under the accepted version for N days and are then paused]] If you do not accept a new version, you can stop copying at any time, and we may end hosted copy trading for you as set out in section 14.` },
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
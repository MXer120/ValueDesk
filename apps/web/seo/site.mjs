/**
 * WHAT SEARCH ENGINES AND LLMS READ ABOUT VALUEDESK (2026-11-14): one place for every page's title, description,
 * link card and the plain text a crawler without JavaScript sees. tools/seo.mjs writes it into the build.
 *
 * Every sentence is a fact the app or its terms state - no superlatives, no promised returns (marketing/BRAND.md).
 * Fees come from the code: FEES below is checked against packages/copy-engine/src/policy.ts and
 * deploy/vercel/production.settings by seo.test.ts, so a fee change fails the tests until this text follows.
 */

export const ORIGIN = 'https://www.valuedesk.so';
export const NAME = 'ValueDesk';

/** Tenths of a basis point, as the code keeps them (10 = 1 bp = 0.01%). */
export const FEES = {
  trade: 15, // production.settings VITE_BUILDER_FEE_PERPS / _SPOT
  copy: [
    { fromUsd: 0, fee: 25 },
    { fromUsd: 100_000, fee: 20 },
    { fromUsd: 500_000, fee: 15 },
    { fromUsd: 2_000_000, fee: 12 },
    { fromUsd: 10_000_000, fee: 10 },
  ],
  bot: [
    { fromUsd: 0, fee: 4 },
    { fromUsd: 100_000, fee: 3 },
    { fromUsd: 1_000_000, fee: 2 },
  ],
  windowDays: 14,
};

const bp = (tenths) => `${(tenths / 10).toLocaleString('en-US', { maximumFractionDigits: 1 })} bp`;
const usd = (n) => (n >= 1e6 ? `$${n / 1e6}M` : `$${n / 1e3}k`);
const ladder = (steps) => steps.map((s, i) => (i === 0 ? bp(s.fee) : `${bp(s.fee)} from ${usd(s.fromUsd)}`)).join(', ');

export const VENUES_DATA = ['SoDEX', 'Hyperliquid', 'trade.xyz', 'Lighter', 'Arcus'];
export const ALGOS = ['TWAP', 'VWAP', 'POV', 'Iceberg', 'Chase', 'Scale', 'DCA', 'Swarm', 'Conditional', 'Trailing stop', 'Basket', 'Bracket', 'Sweep'];

export const SUMMARY = `${NAME} is a trading desk for perpetual futures on SoDEX: chart, order book, liquidation heatmap, trade flow, ` +
  `news and macro calendar on one screen, with non-custodial trading, copy trading, ${ALGOS.length} algorithmic order types and ` +
  `market-making and grid bots. Its analytics read ${VENUES_DATA.join(', ')}.`;

/** The questions a person asks a search engine or a chat about a tool like this, answered from the code and terms. */
export const FAQ = [
  ['What is ValueDesk?', SUMMARY],
  ['Is ValueDesk non-custodial?', 'Yes. Orders go to your own SoDEX account, signed by a trading key you approve from your wallet. ValueDesk never holds your funds.'],
  ['Which exchanges does ValueDesk support?', `Trading runs on SoDEX, perps and spot. Analytics such as the leaderboard, wallet scans and the liquidation heatmap read ${VENUES_DATA.join(', ')}.`],
  ['What does ValueDesk cost?', `No subscription. A builder fee is added to orders placed through ValueDesk: ${bp(FEES.trade)} on manual trades, ` +
    `${ladder(FEES.copy)} on copy trades and algo orders run by ValueDesk, and ${ladder(FEES.bot)} on bots, by ${FEES.windowDays}-day volume. SoDEX charges its own trading fee on top.`],
  ['Can I copy trade on SoDEX?', 'Yes. Pick a SoDEX or Hyperliquid trader and ValueDesk mirrors each of their trades into your SoDEX account, in your browser, on ValueDesk\'s executor or on your own server.'],
  ['Does ValueDesk have trading bots?', 'Yes: a volume market maker, a Binance-led market maker and a grid bot. They run around the clock in your own SoDEX account, and each can run as practice first with no real orders.'],
  ['What is a liquidation heatmap?', 'A chart layer that shows the price levels where open leveraged positions would be liquidated, estimated from positions on the venues ValueDesk reads. Bright levels hold more.'],
];

/**
 * The app's pages. `path` is the route, `og` a file in public/og, `text` the paragraphs a crawler reads before the
 * app starts (React replaces them on mount). Legal pages keep the default head.
 */
export const PAGES = [
  {
    path: '/',
    title: 'ValueDesk - the SoDEX trading desk: liquidations, copy trading, bots',
    description: 'Trade SoDEX perps on one desk: liquidation heatmap, order book, trade flow, copy trading, algo orders and market-making bots. Non-custodial.',
    og: 'home',
    h1: 'The market, on one desk.',
    text: [SUMMARY, 'Connect a wallet to trade from your own SoDEX account. Everything else - charts, liquidation levels, leaderboards, wallet scans, news - works without one.'],
    faq: true,
  },
  {
    path: '/trade',
    title: 'Trade SoDEX perps with a liquidation heatmap and algo orders - ValueDesk',
    description: `Non-custodial SoDEX trading: chart with liquidation heatmap, order book, trade flow, TP/SL and ${ALGOS.length} algo orders (${ALGOS.slice(0, 5).join(', ')} and more).`,
    og: 'trade',
    h1: 'Trade SoDEX on one desk',
    text: [
      'Perps and spot on SoDEX from your own account: market, limit and stop orders with take-profit and stop-loss, a live order book and a chart with the liquidation heatmap.',
      `Work large orders with ${ALGOS.length} algorithmic order types: ${ALGOS.join(', ')}. Each shows a live preview before it starts.`,
      'Beside the chart: the trade flow of each candle (which wallets traded it), news, the macro calendar, FOMC odds and ETF flows.',
    ],
  },
  {
    path: '/copy',
    title: 'Copy trading on SoDEX - copy Hyperliquid and SoDEX traders - ValueDesk',
    description: `Copy any SoDEX or Hyperliquid trader into your own SoDEX account, trade for trade. Fee ${ladder(FEES.copy)} by ${FEES.windowDays}-day volume.`,
    og: 'copy',
    h1: 'Copy a trader, trade for trade',
    text: [
      'Pick a trader from the SoDEX or Hyperliquid leaderboard and ValueDesk mirrors their trades into your own SoDEX account, sized by a multiplier you set, with your own leverage limit.',
      'Run the copy in your browser, on ValueDesk\'s executor around the clock, or on your own server. Stop it at any time; your positions stay yours.',
      `Copy fee: ${ladder(FEES.copy)}, by your ${FEES.windowDays}-day copy volume.`,
    ],
  },
  {
    path: '/bots',
    title: 'Market-making and grid bots for SoDEX - ValueDesk Bots',
    description: `Run a volume maker, a Binance-led maker or a grid bot in your own SoDEX account, 24/7. See the cost per $1M traded first. Fee ${ladder(FEES.bot)}.`,
    og: 'bots',
    h1: 'Bots that rest on the book',
    text: [
      'Three strategies, each built for volume at the lowest cost: a volume maker that quotes both sides at the best price, a maker priced off Binance futures, and a grid that buys low and sells high inside a range.',
      'Every order rests on the book, so a bot pays the maker fee, never the spread. Each setup shows what $1M of volume cost in tested runs before you start it, and can run as practice first.',
      `Bot fee: ${ladder(FEES.bot)}, by ${FEES.windowDays}-day volume.`,
    ],
  },
  {
    path: '/bots/explore',
    title: 'SoDEX market conditions for market makers - ValueDesk Bots',
    description: 'Which SoDEX markets suit a market-making bot right now: flow, volatility and the cost per $1M traded, market by market.',
    og: 'bots',
    h1: 'Where a bot does well right now',
    text: ['Every SoDEX perp market with the conditions a resting bot cares about: uninformed flow, volatility and the cost per $1M of volume in tested runs.'],
  },
  {
    path: '/leaderboard',
    title: 'SoDEX and Hyperliquid trader leaderboard - ValueDesk',
    description: 'Top traders on SoDEX and Hyperliquid by PnL over 1 day, 7 days, 30 days, 90 days, the year and all time. Open any wallet, or copy it.',
    og: 'home',
    h1: 'Trader leaderboard',
    text: ['The top traders on SoDEX and Hyperliquid by profit and loss, for 1 day, 7, 30 and 90 days, the year to date and all time - with volume and account value. Open a wallet to see its trades, or copy it.'],
  },
  {
    path: '/explore',
    title: 'Crypto perps screener and wallet cohorts - ValueDesk Explore',
    description: `Screen perps markets and follow wallet cohorts - what whales, top traders and new wallets hold - across ${VENUES_DATA.slice(0, 2).join(' and ')}.`,
    og: 'markets',
    h1: 'Explore markets and wallet cohorts',
    text: ['A screener of perps markets and wallet cohorts: what groups of wallets - by size and by profit - are long or short, market by market.'],
  },
  {
    path: '/portfolio',
    title: 'Your SoDEX portfolio - ValueDesk',
    description: 'Positions, orders, history and PnL of your SoDEX account in one place.',
    og: 'home',
    h1: 'Portfolio',
    text: ['Connect a wallet to see your SoDEX positions, open orders, trade history and profit and loss over time.'],
  },
  {
    path: '/status',
    title: 'ValueDesk status',
    description: 'Live status and uptime of ValueDesk\'s services: data, API, executor and the exchanges it reads.',
    og: 'home',
    h1: 'Status',
    text: ['Live status and uptime of each ValueDesk service, with past incidents and maintenance.'],
  },
];

/** The market pages (static, built from seo/markets.json). */
export const marketPath = (base) => `/markets/${base.toLowerCase()}`;

/**
 * Guides (2026-11-14): plain pages that answer what people search for and ask chats - each tied to the page that
 * does it. Facts from the app and its terms only; `steps` become a HowTo in JSON-LD.
 */
export const GUIDES = [
  {
    slug: 'liquidation-heatmap',
    title: 'How to read a liquidation heatmap (BTC, ETH and SoDEX perps)',
    description: 'What a liquidation heatmap shows, how the levels are estimated, and how traders use them - with a live heatmap for every SoDEX market on ValueDesk.',
    h1: 'How to read a liquidation heatmap',
    cta: ['/trade', 'Open the heatmap'],
    text: [
      'A leveraged position is closed by the exchange when the price reaches its liquidation price. A liquidation heatmap puts those prices on the chart: each band is a price level, and the brighter it is, the more open positions would be liquidated there.',
      `ValueDesk estimates the levels from the open positions it reads on ${VENUES_DATA.join(', ')}, and draws them over the price chart, live and back in time, so you can see how levels formed before a move.`,
      'Large clusters can act like magnets and like walls: when the price reaches one, forced closes add to the move; once it is cleared, the level disappears. A heatmap shows where that pressure sits, not where the price will go.',
    ],
    steps: ['Open the Trade page and pick a market.', 'Turn on the liquidation heatmap on the chart.', 'Read the bright bands above and below the price: those are the levels where the most positions would be closed.', 'Switch to the historical view to see how the levels formed before a move.'],
  },
  {
    slug: 'copy-trading-sodex',
    title: 'How to copy trade on SoDEX (and copy Hyperliquid traders) - ValueDesk',
    description: 'Step by step: pick a SoDEX or Hyperliquid trader, set your size and leverage, and copy every trade into your own SoDEX account. Fees and where the copy runs.',
    h1: 'How to copy trade on SoDEX',
    cta: ['/copy', 'Start copying'],
    text: [
      'Copy trading on ValueDesk mirrors a trader\'s positions into your own SoDEX account: when they open, add, reduce or close, your copy does the same, scaled by a multiplier you set.',
      'You can copy traders on SoDEX and on Hyperliquid. ValueDesk never holds your funds: orders are placed in your account by a trading key you approve, and you can stop a copy at any time.',
      `The copy fee is ${ladder(FEES.copy)}, by your ${FEES.windowDays}-day copy volume, on top of SoDEX's own trading fee.`,
    ],
    steps: ['Connect your wallet and accept the terms.', 'Enable trading: approve a trading key for your SoDEX account.', 'Pick a trader on the Copy page or the leaderboard.', 'Set the size multiplier and the most leverage your copy may use.', 'Choose where the copy runs: your browser, ValueDesk\'s executor, or your own server.', 'Approve the copy fee once in your wallet and start the copy.'],
  },
  {
    slug: 'sodex-builder-fee',
    title: 'SoDEX builder fees explained: what ValueDesk charges',
    description: 'What a builder fee on SoDEX is, how you approve it, and the exact fees ValueDesk adds to trades, copies, algo orders and bots.',
    h1: 'SoDEX builder fees, explained',
    cta: ['/trade', 'Open the desk'],
    text: [
      'An app that sends orders to SoDEX for you can add a small builder fee to each order. You approve the highest fee an app may charge once, from your wallet; SoDEX then adds the app\'s fee to the orders it places, and never more than you approved.',
      `ValueDesk has no subscription. Its builder fee is ${FEES.trade / 10} bp on manual trades, ${ladder(FEES.copy)} on copy trades and algo orders run by ValueDesk, and ${ladder(FEES.bot)} on bots, by ${FEES.windowDays}-day volume. SoDEX charges its own maker and taker fee on top.`,
      'One basis point (bp) is 0.01%: on $10,000 of volume, 1 bp is $1.',
    ],
  },
  {
    slug: 'twap-vwap-iceberg',
    title: 'TWAP, VWAP, Iceberg and other algo orders on SoDEX',
    description: `What TWAP, VWAP, POV, Iceberg, Scale, Trailing stop, Bracket and the rest of the ${ALGOS.length} algo orders do, and when to use each - on SoDEX with ValueDesk.`,
    h1: 'Algo orders: TWAP, VWAP, Iceberg and more',
    cta: ['/trade', 'Place an algo order'],
    text: [
      'TWAP splits an order into equal pieces over a set time. VWAP sizes the pieces by how much the market usually trades at each moment. POV keeps your order a set share of what trades.',
      'Iceberg shows only a small part of a large order on the book at a time. Chase keeps a limit order at the best price as the price moves. Scale spreads limit orders over a price range.',
      'Trailing stop follows the price and closes when it turns by a set amount. Bracket opens a position with its take-profit and stop-loss. Basket trades 2 to 10 markets at once, each long or short. Conditional waits for conditions such as a price, a move, funding or a time, then acts. DCA spends a set dollar amount on a schedule. Swarm works an order in clips and waves with a slippage cap.',
      `ValueDesk has ${ALGOS.length} of them: ${ALGOS.join(', ')}. Each shows a live preview of its orders before it starts.`,
    ],
  },
  {
    slug: 'market-making-bot',
    title: 'How a market-making bot works on SoDEX - cost per $1M explained',
    description: 'How a market-making or grid bot earns the spread, what it costs per $1M of volume, and how to run one in your own SoDEX account with ValueDesk.',
    h1: 'How a market-making bot works',
    cta: ['/bots', 'See the bots'],
    text: [
      'A market maker keeps a buy order just below the price and a sell order just above it. When both fill, it has bought low and sold high by the spread. Because its orders rest on the book, it pays the lower maker fee instead of crossing the spread.',
      'The cost of a bot is best read per $1M of volume: trading fees plus what price moves cost while it held inventory, minus the spread it earned. ValueDesk shows this figure from tested runs before you start a bot.',
      'A grid bot places buy orders below the price and sell orders above it at fixed steps; each filled buy puts a sell one step higher. It does well when the price moves sideways in a range.',
      `ValueDesk's bots run around the clock in your own SoDEX account and can run as practice first, with no real orders. Bot fee: ${ladder(FEES.bot)}, by ${FEES.windowDays}-day volume.`,
    ],
  },
];

export const guidePath = (slug) => `/learn/${slug}`;

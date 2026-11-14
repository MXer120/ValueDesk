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

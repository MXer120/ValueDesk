/**
 * Hyperliquid venue provider. Contract: ../types.ts VenueProvider.
 *
 * READ-ONLY: public stats-data downloads, POST /info queries and the public
 * WS `trades` channel. Nothing here signs, places orders or registers keys.
 *
 *   leaderboard  leaderboard.ts   stats-data leaderboard file, 60 s conditional re-check, rank change vs previous file
 *   trader       trader.ts        clearinghouseState + portfolio + 2,000-fill sample (+ leaderboard row)
 *   fills        trader.ts        userFills / userFillsByTime paging, newest first, max 10,000 (HL's reach)
 *   whales       whales.ts        WS trades for the top 20 coins, taker orders >= $10k, ring buffer
 *   positioning  positioning.ts   clearinghouseState of the top 100 accounts, cached 3 min
 *
 * Every /info request goes through one HlInfoClient (info.ts): a shared
 * weight budget (default 1,000 of HL's 1,200 per minute per IP), timeouts,
 * 429 backoff and in-flight dedup. Nothing starts at import time: the
 * leaderboard downloads on first use, the WS opens on the first whales() call.
 */
import type { VenueProvider } from '../types.js';
import { HlInfoClient } from './info.js';
import { HlLeaderboardStore, queryLeaderboard } from './leaderboard.js';
import { HlPositioning } from './positioning.js';
import { hlFills, hlTrader } from './trader.js';
import { HlTradeFeed } from './whales.js';

export const hlInfo = new HlInfoClient();
export const hlLeaderboard = new HlLeaderboardStore();
const feed = new HlTradeFeed(hlInfo);
const positioning = new HlPositioning(hlInfo, hlLeaderboard);

export const hyperliquidProvider: VenueProvider = {
  venue: 'hyperliquid',

  async leaderboard(q) {
    const cur = await hlLeaderboard.snapshot();
    return queryLeaderboard(cur, hlLeaderboard.previous(), q);
  },

  trader: (address) => hlTrader(address, { info: hlInfo, leaderboard: hlLeaderboard }),

  fills: (address, o) => hlFills(hlInfo, address, o),

  whales: (minUsd, limit) => feed.recent(minUsd, limit),

  positioning: (symbol) => positioning.get(symbol),
};

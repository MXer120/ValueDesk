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
 *   positioning  positioning.ts   the index's books of the 30-day boards' wallets (indexer/held.ts);
 *                                 a clearinghouseState sweep only in dev, while the index has none
 *
 * Every /info request goes through one HlInfoClient (info.ts): a shared
 * weight budget (default 1,000 of HL's 1,200 per minute per IP; 200 in a
 * process that only serves the API), timeouts, 429 backoff and in-flight
 * dedup. Nothing starts at import time: the leaderboard downloads on first
 * use, the WS opens on the first whales() call.
 *
 * WHAT A PUBLIC SERVER SPENDS HERE, whatever the number of visitors:
 *   positioning  nothing - a read of the index file;
 *   whales       one socket with 20 subscriptions, and the coin ranking: two
 *                metaAndAssetCtxs (40 weight) when the feed starts and once
 *                an hour while it runs (whales.ts).
 */
import { boardHoldings } from '../../indexer/held.js';
import { apiOnly } from '../env.js';
import { shownLabel } from '../labels.js';
import type { TraderRow, VenueProvider } from '../types.js';
import { hlInfo } from './client.js';
import { HlLeaderboardStore, queryLeaderboard } from './leaderboard.js';
import { HlPositioning } from './positioning.js';
import { hlFills, hlTrader } from './trader.js';
import { HlTradeFeed } from './whales.js';

export { hlInfo };
export const hlLeaderboard = new HlLeaderboardStore();
const feed = new HlTradeFeed(hlInfo);
const positioning = new HlPositioning(hlInfo, hlLeaderboard, Date.now, {
  // The xyz dex is a venue of its own in the index; a wallet's account here is both books.
  holdings: () => boardHoldings('hyperliquid', ['hyperliquid', 'tradexyz']),
  only: () => apiOnly(),
});

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

/**
 * One address's row on the Hyperliquid leaderboard, as a profile shows it (rank
 * by 30-day PnL, rank change against the previous file), or null when it is not
 * listed. For an index route: the browser reads each user's Hyperliquid account
 * directly and only needs this row from us (the file behind it is 39 MB).
 */
export async function hlLeaderboardRow(address: string): Promise<TraderRow | null> {
  const snap = hlLeaderboard.peek() ?? (await hlLeaderboard.snapshot().catch(() => null));
  const row = snap?.rowFor(address.toLowerCase(), 'pnl', '30d', hlLeaderboard.previous()) ?? null;
  return row ? { ...row, label: shownLabel(row.address, row.label) } : null;
}

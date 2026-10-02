/**
 * SoDEX venue provider for Valuescan. Contract: ../types.ts VenueProvider.
 *
 *   leaderboard  SoDEX's official leaderboard (mainnet-data), 60 s cache;
 *                ROI / account value from each account's portfolio chart  -> leaderboard.ts
 *   trader       live account state + portfolio chart + closed positions    -> trader.ts
 *   fills        perps + spot fills, history.ts pager, bounded             -> trader.ts
 *   whales       gateway WS `trade` firehose, taker ids resolved to wallets -> whales.ts
 *   positioning  the index's books of the 30-day boards' wallets; a crawl
 *                of their account states only in dev, while the index
 *                has none                                                 -> positioning.ts
 *
 * Read-only by construction: public GETs, the gateway's public account reads,
 * one public WebSocket and SoDEX's public id->address lookup. Nothing here
 * signs, orders or registers anything. Gateway reads go through the shared
 * `sodex` client, so they count against the same 1200/min budget as the UI.
 *
 * WHAT A PUBLIC SERVER SPENDS ON WHALES AND POSITIONING, whatever the number
 * of visitors: positioning nothing (a read of the index file); whales one
 * socket, the symbol list once per half hour, and at most one id lookup per
 * 2 s for takers the index does not know (whales.ts, resolver.ts).
 */
import type { VenueProvider } from '../types.js';
import { leaderboard } from './leaderboard.js';
import { positioning } from './positioning.js';
import { fills, trader } from './trader.js';
import { whales } from './whales.js';

export const sodexProvider: VenueProvider = {
  venue: 'sodex',
  leaderboard,
  trader,
  fills,
  whales,
  positioning,
};

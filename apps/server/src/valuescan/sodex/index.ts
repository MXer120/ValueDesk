/**
 * SoDEX venue provider for Valuescan. Contract: ../types.ts VenueProvider.
 *
 *   leaderboard  SoDEX's official leaderboard (mainnet-data), 60 s cache;
 *                ROI / account value from each account's portfolio chart  -> leaderboard.ts
 *   trader       live account state + portfolio chart + closed positions    -> trader.ts
 *   fills        perps + spot fills, history.ts pager, bounded             -> trader.ts
 *   whales       gateway WS `trade` firehose, taker ids resolved to wallets -> whales.ts
 *   positioning  perps positions of the top-100 30-day PnL wallets          -> positioning.ts
 *
 * Read-only by construction: public GETs, the gateway's public account reads,
 * one public WebSocket and SoDEX's public id->address lookup. Nothing here
 * signs, orders or registers anything. Gateway reads go through the shared
 * `sodex` client, so they count against the same 1200/min budget as the UI.
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

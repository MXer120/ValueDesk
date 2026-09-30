/**
 * One SoDEX wallet as a TraderProfile, and its fills - the server's binding.
 *
 * The assembly itself (sources, windows, the suspect-analytics rule, the
 * backward fill walk) is traderCore.ts, shared with the browser. Here it runs
 * on the server's shared gateway and data-host clients, remembers each chart
 * for the leaderboard rows and each id/wallet pair for the resolver, and
 * caches whole answers briefly.
 */
import { lbRank, portfolioChart } from './data.js';
import { rememberChart } from './enrich.js';
import { closedPositions, markPrices, perpsState, spotState, spotTickers, tradesPage } from './gateway.js';
import { seedAddress } from './resolver.js';
import { MAX_FILLS, PROFILE_SOURCE, buildSodexProfile, fillLimit, sodexFills, type SodexTraderIo } from './traderCore.js';
import { TtlCache, coolingDown } from './util.js';
import type { TraderProfile, VsFill } from '../types.js';

export { MAX_FILLS, PROFILE_SOURCE };

const io: SodexTraderIo = {
  perpsState,
  spotState,
  markPrices,
  spotTickers,
  closedPositions,
  tradesPage,
  portfolioChart: (accountId, window) => portfolioChart(accountId, window),
  lbRank: (window, sortBy, address) => lbRank(window, sortBy, address),
  coolingDown,
  rememberChart,
  seedAddress,
};

const profiles = new TtlCache(500);
const fillCache = new TtlCache(500);

const PROFILE_TTL = 30_000;
const FILLS_TTL = 20_000;

export function trader(address: string): Promise<TraderProfile | null> {
  const a = address.toLowerCase();
  return profiles.wrap(a, PROFILE_TTL, () => buildSodexProfile(io, a));
}

export function fills(address: string, o: { from?: number; to?: number; limit?: number }): Promise<VsFill[]> {
  const a = address.toLowerCase();
  const limit = fillLimit(o.limit);
  const key = `${a}|${o.from ?? ''}|${o.to ?? ''}|${limit}`;
  return fillCache.wrap(key, FILLS_TTL, () => sodexFills(io, a, o, limit));
}

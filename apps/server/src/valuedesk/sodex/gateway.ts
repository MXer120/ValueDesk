/**
 * Account and market reads against the SoDEX trading gateway, through the
 * server's shared `sodex` client (sodex/rest.ts). That client owns the
 * per-minute weight budget the running UI also draws on (the limit SoDEX
 * reports: 6000 on 2026-10-31), the retry policy and the error-envelope rule,
 * so nothing here talks to the gateway directly.
 *
 * What this layer adds: short caches so a profile, the positioning crawl and a
 * leaderboard click on the same wallet share one read, and the shared cooldown
 * on a 429/1015 so background work backs off. The paths, weights and caches
 * themselves are gatewayCore.ts, which the browser binds to its own client.
 */
import { sodex } from '../../sodex/rest.js';
import { CLOSED_LIMIT, gatewayReads } from './gatewayCore.js';
import { isRateLimit, noteRateLimited } from './util.js';

export { CLOSED_LIMIT };

export async function gwGet<T>(path: string, weight?: number): Promise<T> {
  try {
    return await sodex.get<T>(path, weight);
  } catch (e) {
    if (isRateLimit(e)) noteRateLimited();
    throw e;
  }
}

const reads = gatewayReads(gwGet);

/** Weight 5. `aid: 0` means the wallet has no SoDEX account. */
export const perpsState = reads.perpsState;
/** Weight 5. */
export const spotState = reads.spotState;
/** Weight 2 (and rest.ts caches it for 1 s as well). */
export const markPrices = reads.markPrices;
/** Weight 2. Only used to price spot balances. */
export const spotTickers = reads.spotTickers;
/**
 * The most recent closed perps positions. 200 rows = weight 30: enough for a
 * win rate and a holding-time profile without walking the whole history.
 */
export const closedPositions = reads.closedPositions;
/** One page of fills. Weight 20 + limit/20, billed up front like history.ts does. */
export const tradesPage = reads.tradesPage;

/** Weight this process has spent on the gateway in the last minute (shared with the UI). */
export const gatewayWeightSpent = (): number => sodex.weightSpent();
/** A gateway read made on another thread counts against the same budget. */
export const chargeGatewayWeight = (w: number): void => sodex.chargeWeight(w);
/** The gateway's weight a minute for this IP, as it last reported it: the thresholds above are shares of it. */
export const gatewayWeightLimit = (): number => sodex.weightLimit();

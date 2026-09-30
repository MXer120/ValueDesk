/**
 * Account and market reads against the SoDEX trading gateway, through the
 * server's shared `sodex` client (sodex/rest.ts). That client owns the
 * 1200-weight/minute budget the running UI also draws on, the retry policy and
 * the error-envelope rule, so nothing here talks to the gateway directly.
 *
 * What this layer adds: short caches so a profile, the positioning crawl and a
 * leaderboard click on the same wallet share one read, and the shared cooldown
 * on a 429/1015 so background work backs off.
 */
import { enginePath } from '../../config.js';
import { sodex, unwrapList, weightFor } from '../../sodex/rest.js';
import type { ClosedPosition, MarkPrice, PerpsState, RawTrade, SpotState, SpotTicker } from './mappers.js';
import { TtlCache, isRateLimit, noteRateLimited } from './util.js';

const cache = new TtlCache(2_000);

export async function gwGet<T>(path: string, weight?: number): Promise<T> {
  try {
    return await sodex.get<T>(path, weight);
  } catch (e) {
    if (isRateLimit(e)) noteRateLimited();
    throw e;
  }
}

/** Weight 5. `aid: 0` means the wallet has no SoDEX account. */
export const perpsState = (address: string): Promise<PerpsState> =>
  cache.wrap(`ps:${address}`, 10_000, () => gwGet<PerpsState>(`${enginePath('perps')}/accounts/${address}/state`));

/** Weight 5. */
export const spotState = (address: string): Promise<SpotState> =>
  cache.wrap(`ss:${address}`, 10_000, () => gwGet<SpotState>(`${enginePath('spot')}/accounts/${address}/state`));

/** Weight 2 (and rest.ts caches it for 1 s as well). */
export const markPrices = (): Promise<MarkPrice[]> =>
  cache.wrap('marks', 5_000, async () =>
    unwrapList<MarkPrice>(await gwGet<unknown>(`${enginePath('perps')}/markets/mark-prices`), 'markPrices'),
  );

/** Weight 2. Only used to price spot balances. */
export const spotTickers = (): Promise<SpotTicker[]> =>
  cache.wrap('spot-tickers', 15_000, async () =>
    unwrapList<SpotTicker>(await gwGet<unknown>(`${enginePath('spot')}/markets/tickers`), 'tickers'),
  );

/**
 * The most recent closed perps positions. 200 rows = weight 30: enough for a
 * win rate and a holding-time profile without walking the whole history.
 */
export const CLOSED_LIMIT = 200;
export const closedPositions = (address: string): Promise<ClosedPosition[]> =>
  cache.wrap(`closed:${address}`, 60_000, async () => {
    const path = `${enginePath('perps')}/accounts/${address}/positions/history?limit=${CLOSED_LIMIT}`;
    return unwrapList<ClosedPosition>(await gwGet<unknown>(path, weightFor(path, CLOSED_LIMIT)), 'positions');
  });

/** One page of fills. Weight 20 + limit/20, billed up front like history.ts does. */
export async function tradesPage(
  engine: 'perps' | 'spot',
  address: string,
  q: { limit: number; startTime?: number; endTime?: number },
): Promise<RawTrade[]> {
  const p = new URLSearchParams();
  if (q.startTime !== undefined) p.set('startTime', String(q.startTime));
  if (q.endTime !== undefined) p.set('endTime', String(q.endTime));
  p.set('limit', String(q.limit));
  const path = `${enginePath(engine)}/accounts/${address}/trades?${p}`;
  return unwrapList<RawTrade>(await gwGet<unknown>(path, weightFor(path, q.limit)), 'trades');
}

/** Weight this process has spent on the gateway in the last minute (shared with the UI). */
export const gatewayWeightSpent = (): number => sodex.weightSpent();

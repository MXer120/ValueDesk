/**
 * The SoDEX gateway reads a trader profile is built from - paths, weights and
 * short caches - with the transport injected.
 *
 * The server binds these to its shared `sodex` client (gateway.ts); the
 * browser binds them to its own per-user-IP gateway client
 * (apps/web/src/exchange/sodex). Same paths, same weights, same caches.
 */
import { unwrapList, weightFor } from '../../sodex/restCore.js';
import type { ClosedPosition, MarkPrice, PerpsState, RawTrade, SpotState, SpotTicker } from './mappers.js';
import { TtlCache } from './util.js';

/** One gateway GET: path relative to the gateway origin, weight when it is not the path's default. */
export type GatewayGet = <T>(path: string, weight?: number) => Promise<T>;

/**
 * The most recent closed perps positions. 200 rows = weight 30: enough for a
 * win rate and a holding-time profile without walking the whole history.
 */
export const CLOSED_LIMIT = 200;

export interface GatewayReads {
  /** Weight 5. `aid: 0` means the wallet has no SoDEX account. */
  perpsState(address: string): Promise<PerpsState>;
  /** Weight 5. */
  spotState(address: string): Promise<SpotState>;
  /** Weight 2 (and the transport caches it for 1 s as well). */
  markPrices(): Promise<MarkPrice[]>;
  /** Weight 2. Only used to price spot balances. */
  spotTickers(): Promise<SpotTicker[]>;
  closedPositions(address: string): Promise<ClosedPosition[]>;
  /** One page of fills. Weight 20 + limit/20, billed up front like history.ts does. */
  tradesPage(engine: 'perps' | 'spot', address: string, q: { limit: number; startTime?: number; endTime?: number }): Promise<RawTrade[]>;
}

export function gatewayReads(get: GatewayGet, cache = new TtlCache(2_000)): GatewayReads {
  return {
    perpsState: (address) =>
      cache.wrap(`ps:${address}`, 10_000, () => get<PerpsState>(`/api/v1/perps/accounts/${address}/state`)),

    spotState: (address) =>
      cache.wrap(`ss:${address}`, 10_000, () => get<SpotState>(`/api/v1/spot/accounts/${address}/state`)),

    markPrices: () =>
      cache.wrap('marks', 5_000, async () =>
        unwrapList<MarkPrice>(await get<unknown>('/api/v1/perps/markets/mark-prices'), 'markPrices'),
      ),

    spotTickers: () =>
      cache.wrap('spot-tickers', 15_000, async () =>
        unwrapList<SpotTicker>(await get<unknown>('/api/v1/spot/markets/tickers'), 'tickers'),
      ),

    closedPositions: (address) =>
      cache.wrap(`closed:${address}`, 60_000, async () => {
        const path = `/api/v1/perps/accounts/${address}/positions/history?limit=${CLOSED_LIMIT}`;
        return unwrapList<ClosedPosition>(await get<unknown>(path, weightFor(path, CLOSED_LIMIT)), 'positions');
      }),

    async tradesPage(engine, address, q) {
      const p = new URLSearchParams();
      if (q.startTime !== undefined) p.set('startTime', String(q.startTime));
      if (q.endTime !== undefined) p.set('endTime', String(q.endTime));
      p.set('limit', String(q.limit));
      const path = `/api/v1/${engine}/accounts/${address}/trades?${p}`;
      return unwrapList<RawTrade>(await get<unknown>(path, weightFor(path, q.limit)), 'trades');
    },
  };
}

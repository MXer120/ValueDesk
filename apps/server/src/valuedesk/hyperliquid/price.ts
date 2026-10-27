/**
 * A coin's price over a range for the cohort asset page: Hyperliquid candles
 * (its default dex, then its "k" 1000x unit, then the trade.xyz dex), with the
 * /info client injected.
 *
 * The same series /api/vs/price answered (routes/valuedesk.ts); the browser now
 * reads it with its own client, from the user's own IP.
 */
import { NotAvailable } from '../types.js';
import type { InfoLike } from './info.js';

export type PriceRange = '1d' | '7d' | '30d';

export interface PriceSeries {
  coin: string;
  market: string;
  source: string;
  range: PriceRange;
  interval: string;
  /** [t, close]. */
  points: Array<[number, number]>;
  /** [t, open, high, low, close]. */
  candles: Array<[number, number, number, number, number]>;
}

/** Throws NotAvailable for a bad coin name or when no dex has history for it. */
export async function hlPriceSeries(info: InfoLike, coinIn: string, rangeIn: string | undefined): Promise<PriceSeries> {
  const coin = (coinIn ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,20}$/.test(coin)) throw new NotAvailable('Name a coin');
  const range: PriceRange = rangeIn === '1d' || rangeIn === '30d' ? rangeIn : '7d';
  const span = { '1d': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 }[range];
  const interval = { '1d': '15m', '7d': '1h', '30d': '4h' }[range];
  const end = Date.now();
  const names = [coin, ...(coin.startsWith('K') && coin.length > 3 ? [`k${coin.slice(1)}`] : []), `xyz:${coin}`];
  for (const name of names) {
    const rows = await info
      .post<Array<{ t?: number; o?: string; h?: string; l?: string; c?: string }> | null>(
        { type: 'candleSnapshot', req: { coin: name, interval, startTime: end - span, endTime: end } },
        { ttlMs: 60_000 },
      )
      .catch(() => null);
    // [t, open, high, low, close]; `points` (t, close) stays for older clients.
    const candles = (rows ?? []).flatMap((r) => {
      const o = Number(r.o), h = Number(r.h), l = Number(r.l), c = Number(r.c);
      return typeof r.t === 'number' && o > 0 && h > 0 && l > 0 && c > 0 ? [[r.t, o, h, l, c] as [number, number, number, number, number]] : [];
    });
    const points = candles.map(([t, , , , c]) => [t, c] as [number, number]);
    if (points.length > 1) return { coin, market: name, source: 'Hyperliquid', range, interval, points, candles };
  }
  throw new NotAvailable(`No price history for ${coin}`);
}

/**
 * Mark and index candles - sodex.com's own stats page series ("Perp price
 * data": `GET mainnet-data.sodex.dev/api/v1/dashboard/perps/klines`,
 * price_type=mark|index). The trading gateway's /klines are the LATEST traded
 * price; these are the other two prices a perps position is measured by.
 *
 * Answered in the gateway's kline shape (newest first, decimal strings), so the
 * chart treats every source alike. Only 5m and up exist upstream. The request
 * and the mapping are priceKlinesCore.ts (the browser reads the same host);
 * this is the server's binding.
 */
import { NET } from '../config.js';
import { PRICE_KLINE_INTERVALS, priceKlinesReader } from './priceKlinesCore.js';

export { PRICE_KLINE_INTERVALS };

const DATA_BASE = process.env.SODEX_DATA_API?.trim() || NET.restBase.replace('-gw.', '-data.');

export const priceKlines = priceKlinesReader(DATA_BASE, async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
});

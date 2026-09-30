/**
 * Mark and index candles - sodex.com's own stats page series ("Perp price
 * data": `GET mainnet-data.sodex.dev/api/v1/dashboard/perps/klines`,
 * price_type=mark|index). The trading gateway's /klines are the LATEST traded
 * price; these are the other two prices a perps position is measured by.
 *
 * Answered in the gateway's kline shape (newest first, decimal strings), so the
 * chart treats every source alike. Only 5m and up exist upstream.
 */
import { NET } from '../config.js';

const DATA_BASE = process.env.SODEX_DATA_API?.trim() || NET.restBase.replace('-gw.', '-data.');

/** Chart interval -> the data API's interval (none below 5m). */
export const PRICE_KLINE_INTERVALS: Record<string, string> = {
  '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '2h': '2h', '4h': '4h', '6h': '6h', '12h': '12h',
  '1D': '1d', '1d': '1d', '1W': '1w', '1w': '1w', '1M': '1M',
};
const IV_MS: Record<string, number> = {
  '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000,
  '6h': 21_600_000, '12h': 43_200_000, '1d': 86_400_000, '1w': 604_800_000, '1M': 2_592_000_000,
};

const cache = new Map<string, { at: number; value: Promise<unknown[]> }>();

export async function priceKlines(o: {
  symbol: string;
  source: 'mark' | 'index';
  interval: string;
  limit: number;
  startTime?: number;
  endTime?: number;
}): Promise<unknown[]> {
  const iv = PRICE_KLINE_INTERVALS[o.interval];
  if (!iv) throw Object.assign(new Error(`${o.source} candles start at 5m`), { statusCode: 400 });
  const end = o.endTime ?? Date.now();
  const start = o.startTime ?? end - o.limit * (IV_MS[iv] ?? 300_000);
  const qs = new URLSearchParams({
    symbol: o.symbol, price_type: o.source, interval: iv,
    start_ts: String(start), end_ts: String(end), limit: String(o.limit),
  });
  // The right edge moves every few seconds; history does not.
  const key = o.endTime === undefined ? `${o.symbol}|${o.source}|${iv}|${o.limit}|live` : qs.toString();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (o.endTime === undefined ? 5_000 : 300_000)) return hit.value;
  const value = (async () => {
    const res = await fetch(`${DATA_BASE}/api/v1/dashboard/perps/klines?${qs}`, { signal: AbortSignal.timeout(15_000) });
    const body = (await res.json().catch(() => null)) as { code?: number; message?: string; data?: { candles?: Array<Record<string, unknown>> } } | null;
    if (!res.ok || !body || body.code !== 0) throw new Error(body?.message || `SoDEX price data answered HTTP ${res.status}`);
    const rows = (body.data?.candles ?? [])
      .filter((c) => typeof c.t === 'number')
      .map((c) => ({ t: c.t, o: String(c.o), h: String(c.h), l: String(c.l), c: String(c.c), v: '0', q: '0' }));
    rows.sort((a, b) => (b.t as number) - (a.t as number));
    return rows.slice(0, o.limit);
  })();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  if (cache.size > 300) for (const [k, v] of cache) if (Date.now() - v.at > 300_000) cache.delete(k);
  return value;
}

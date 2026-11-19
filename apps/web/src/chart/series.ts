/**
 * What names a trade-chart series, and how much of it the chart seeds itself with. Its own small
 * module: the reads made before the chart asks (earlyBars.ts, seriesPrefetch.ts) and the series
 * cache share these with Chart.tsx, and an identical request is one request (the gateway's
 * RequestGate), so they must ask exactly what the chart will.
 */

/** How much history a series is seeded with. */
export const KLINE_LIMIT = 500;

/** Which series a load or a live candle belongs to: engine, the chart's ticker (`BTC-USD`, `BTC-USD@mark`), interval. */
export const seriesKey = (engine: string, ticker: string, interval: string): string => `${engine}|${ticker}|${interval}`;

/** The key's parts back; null for a key this module did not make. */
export function parseSeriesKey(key: string): { engine: string; ticker: string; interval: string } | null {
  const [engine, ticker, interval, ...rest] = key.split('|');
  return engine && ticker && interval && rest.length === 0 ? { engine, ticker, interval } : null;
}

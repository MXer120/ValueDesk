/**
 * What a press reads ahead of its click (press.ts): exactly the read the chart's switch will make,
 * so the gateway's RequestGate makes the two one request - the click's own read joins this one in
 * flight or takes its answer (kept 2 s) - and nothing else changes.
 *
 * That is the whole first load (series.ts KLINE_LIMIT), or - for a series the chart has kept
 * (seriesCache.ts) - only the right-edge read its restore makes. Mark and index candles come from
 * another host with no shared read, so they are not read ahead (the click would read them twice).
 */
import type { Engine } from '../api';
import { intervalMs } from './feedHealth';
import { fetchKlineRows } from './klines';
import { KLINE_LIMIT, seriesKey } from './series';
import { restorePlan, seriesCache } from './seriesCache';

/** The read a switch to this series will make, or null when nothing can be read ahead. */
export function prefetchQuery(engine: Engine, ticker: string, interval: string, now: number): { engine: Engine; symbol: string; interval: string; limit: number } | null {
  if (!ticker || ticker.includes('@')) return null;
  const ms = intervalMs(interval);
  if (!ms) return null;
  const kept = seriesCache.peek(seriesKey(engine, ticker, interval));
  const plan = kept ? restorePlan(kept, now, ms) : null;
  return { engine, symbol: ticker, interval, limit: plan ? plan.limit : KLINE_LIMIT };
}

/** Start the read a switch to this series will make (nothing for mark / index candles). */
export function prefetchSeries(engine: Engine, ticker: string, interval: string): void {
  const q = prefetchQuery(engine, ticker, interval, Date.now());
  if (q) fetchKlineRows(q).catch(() => undefined);
}

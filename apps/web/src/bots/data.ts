/**
 * The Bots section's two reads beyond the wallet's own bots (docs/BOTS-UI.md):
 *
 *   useBotMarkets   GET /api/vs/bots/markets: what a new market maker pays on every market, estimated from the
 *                   market's own trades (who took, what small makers kept), refreshed every 5 minutes
 *   useBotLatency   GET /api/copy/v1/bots/latency: the executor's write latency to SoDEX, p50 / p95 / p99 per
 *                   10 minutes over a day, per region, refreshed every minute
 *
 * Both are public (no wallet). The last answer stays on screen while the next one is out.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { pollEvery } from '../exchange/visibility';

export interface BotMarket {
  symbol: string;
  base: string;
  tick: number;
  tickBps: number;
  price: number;
  volumeUsdH: number;
  spreadBps: number;
  volBpsH: number;
  takers: { t1002: number; t23342: number; other: number };
  smallMakers: { count: number; volumeUsdH: number; fills: number; markout30Bps: number; on1002Bps: number | null; on23342Bps: number | null };
  estCostBps: number;
  estCostLowBps: number;
  estCostHighBps: number;
  gateCostBps: number | null;
  capacityUsdH: number;
  confidence: 'high' | 'medium' | 'low';
  weekdayCostBps: number | null;
  weekendCostBps: number | null;
  hourly: Array<{ h: number; costBps: number | null; volumeUsdH: number }>;
}

export interface BotMarketsResponse {
  at: number;
  window: '24h' | '7d';
  fee: { makerBps: number; builderBps: number };
  markets: BotMarket[];
}

export interface LatencyBucket { t: number; n: number; p50: number | null; p95: number | null; p99: number | null }
export interface LatencyRegion {
  id: string;
  label: string;
  where: string;
  buckets: LatencyBucket[];
  now: { p50: number | null; p95: number | null; p99: number | null; n: number };
  kinds: { place: { p50: number | null; n: number }; cancel: { p50: number | null; n: number } };
}
export interface BotLatencyResponse { at: number; bucketMs: number; regions: LatencyRegion[] }

interface Read<T> { data: T | null; error: string | null; loading: boolean; refresh: () => void }

function usePolled<T>(url: string | null, everyMs: number, check: (x: unknown) => x is T): Read<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!url);
  const alive = useRef(true);
  const read = useCallback(async () => {
    if (!url) return;
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(r.status === 404 ? 'not available yet' : `HTTP ${r.status}`);
      const body: unknown = await r.json();
      if (!check(body)) throw new Error('an answer this page cannot read');
      if (alive.current) {
        setData(body);
        setError(null);
      }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [url, check]);
  useEffect(() => {
    alive.current = true;
    if (!url) return;
    setLoading(true);
    void read();
    const stop = pollEvery(everyMs, () => void read());
    return () => {
      alive.current = false;
      stop();
    };
  }, [url, everyMs, read]);
  return { data, error, loading, refresh: () => void read() };
}

const isMarkets = (x: unknown): x is BotMarketsResponse => !!x && typeof x === 'object' && Array.isArray((x as BotMarketsResponse).markets) && typeof (x as BotMarketsResponse).fee === 'object';
const isLatency = (x: unknown): x is BotLatencyResponse => !!x && typeof x === 'object' && Array.isArray((x as BotLatencyResponse).regions);

export const useBotMarkets = (window: '24h' | '7d' = '24h', enabled = true): Read<BotMarketsResponse> =>
  usePolled(enabled ? `/api/vs/bots/markets?window=${window}` : null, 5 * 60_000, isMarkets);

export const useBotLatency = (hours = 24, enabled = true): Read<BotLatencyResponse> =>
  usePolled(enabled ? `/api/copy/v1/bots/latency?hours=${hours}` : null, 60_000, isLatency);

/** A cost in bp, per $1M: 1.30 bp is $130. */
export const bpToPerMillion = (bp: number): number => bp * 100;

/** What a market maker would cost on one market at this volume per hour, per day (USD), all-in. */
export const costPerDay = (bp: number, volumeUsdH: number): number => (bp / 10_000) * volumeUsdH * 24;

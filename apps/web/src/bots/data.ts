/**
 * The Bots section's two reads beyond the wallet's own bots (docs/BOTS-UI.md):
 *
 *   useBotMarkets   GET /api/vs/bots/markets: what a new market maker pays on every market, estimated from the
 *                   market's own trades (who took, what small makers kept), refreshed every 5 minutes
 *   useBotLatency   GET /api/copy/v1/bots/latency: how long this wallet's own bots' orders and cancels take to
 *                   reach SoDEX's answer, p50 / p95 / p99 per 10 minutes, per region, refreshed every minute.
 *                   It needs the wallet's executor session: nobody reads another wallet's figures.
 *
 * Markets are public (no wallet). The last answer stays on screen while the next one is out.
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
  /** 'binance': R10 quotes off Binance there; null: no Binance market, the plain maker runs; absent: not known. */
  lead?: 'binance' | null;
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

function usePolled<T>(url: string | null, everyMs: number, check: (x: unknown) => x is T, token: string | null = null): Read<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!url);
  const alive = useRef(true);
  const read = useCallback(async () => {
    if (!url) return;
    try {
      const r = await fetch(url, { headers: token ? { Accept: 'application/json', Authorization: `Bearer ${token}` } : { Accept: 'application/json' } });
      if (!r.ok) throw new Error(r.status === 404 ? 'not available yet' : r.status === 401 ? 'sign in again' : `HTTP ${r.status}`);
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
  }, [url, check, token]);
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

/** This wallet's own bots' latency, or one bot's (`bot`); nothing is read without its session (token null). */
export const useBotLatency = (hours: number, token: string | null, bot?: string): Read<BotLatencyResponse> =>
  usePolled(token ? `/api/copy/v1/bots/latency?hours=${hours}${bot ? `&bot=${encodeURIComponent(bot)}` : ''}` : null, 60_000, isLatency, token);

/** A cost in bp, per $1M: 1.30 bp is $130. */
export const bpToPerMillion = (bp: number): number => bp * 100;

/** What a market maker would cost on one market at this volume per hour, per day (USD), all-in. */
export const costPerDay = (bp: number, volumeUsdH: number): number => (bp / 10_000) * volumeUsdH * 24;

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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useTickers } from '../hooks';
import { pollEvery } from '../exchange/visibility';
import { revalidating, serverGetJson } from '../serverFetch';
import { vsPaths } from '../vsPaths';

export interface BotMarket {
  /** Hours of the window the trade recorder holds for this market (absent from servers before 2026-11-09). */
  heldH?: number;
  symbol: string;
  base: string;
  tick: number;
  tickBps: number;
  price: number;
  volumeUsdH: number;
  spreadBps: number;
  volBpsH: number;
  /** Who took, by dollars, over all the market's prints (since 2026-11-12; older servers: over small makers' fills). */
  takers: { t1002: number; t23342: number; other: number };
  /** 1002's taker dollars per hour over the whole market. */
  t1002UsdH?: number;
  /** The split over small makers' fills only (null: none). */
  takersSmall?: { t1002: number; t23342: number; other: number } | null;
  smallMakers: { count: number; volumeUsdH: number; fills: number; markout30Bps: number; on1002Bps: number | null; on23342Bps: number | null };
  estCostBps: number;
  estCostLowBps: number;
  estCostHighBps: number;
  gateCostBps: number | null;
  /** Share of small makers' volume the market gate keeps (server since 2026-11-08; absent before). */
  gateShare?: number | null;
  /** The flow gate's reading per threshold (1002's USD over 10 min): cost while it held, and the volume share. */
  flowGate?: Array<{ minUsd: number; costBps: number | null; share: number }>;
  /** The spread limit's reading per limit (bp). */
  spreadGate?: Array<{ maxBps: number; costBps: number | null; share: number }>;
  /** Where spreadBps comes from: SoDEX's sampled book, or the prints (a thin market's prints read about 0). */
  spreadFrom?: 'book' | 'prints';
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
  window: BotWindow;
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

/**
 * A public index read (no session) goes through serverFetch.ts like every other: shared with an identical one in flight,
 * started ahead of the page as a first read (the build's defaults for /bots), and its polls ask the server.
 */
async function getJson(url: string, token: string | null): Promise<{ status: number; ok: boolean; body: unknown }> {
  if (!token && url.startsWith('/api/vs/')) return serverGetJson(url);
  const r = await fetch(url, { headers: token ? { Accept: 'application/json', Authorization: `Bearer ${token}` } : { Accept: 'application/json' } });
  return { status: r.status, ok: r.ok, body: r.ok ? ((await r.json()) as unknown) : null };
}

function usePolled<T>(url: string | null, everyMs: number, check: (x: unknown) => x is T, token: string | null = null): Read<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!url);
  const alive = useRef(true);
  const read = useCallback(async () => {
    if (!url) return;
    try {
      const r = await getJson(url, token);
      if (!r.ok) throw new Error(r.status === 404 ? 'not available yet' : r.status === 401 ? 'sign in again' : `HTTP ${r.status}`);
      const body = r.body;
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
    // A poll asks the server for its current answer (a 304 when unchanged), not the copy the HTTP cache holds.
    const stop = pollEvery(everyMs, () => void revalidating(read));
    return () => {
      alive.current = false;
      stop();
    };
  }, [url, everyMs, read]);
  return { data, error, loading, refresh: () => void read() };
}

const isMarkets = (x: unknown): x is BotMarketsResponse => !!x && typeof x === 'object' && Array.isArray((x as BotMarketsResponse).markets) && typeof (x as BotMarketsResponse).fee === 'object';
const isLatency = (x: unknown): x is BotLatencyResponse => !!x && typeof x === 'object' && Array.isArray((x as BotLatencyResponse).regions);

/**
 * One bucket of the regime board (server flow/botMarkets.ts RegimeHour): volumeUsd null = not recorded whole; volBps is
 * the volatility in bp per hour, whatever the bucket's length.
 */
export interface RegimeHour {
  t: number; volumeUsd: number | null; t1002Usd: number; t23342Usd: number; volBps: number;
  /** The other takers classed informed / uninformed by what they cost the makers they fill (servers from 2026-11-10 on). */
  tInfUsd?: number; tUniUsd?: number;
}
export interface BotRegimeResponse {
  at: number; symbol: string; markets: string[]; hours: RegimeHour[];
  /** From servers of 2026-11-10 on; older ones answer 7 days by the hour. */
  window?: BotWindow; stepMs?: number; typicalVolBps?: number | null;
  /** How many other taker accounts are classed informed / uninformed now (servers from 2026-11-10 on). */
  classes?: { informed: number; uninformed: number; minFills: number; markoutS: number };
}
const isRegime = (x: unknown): x is BotRegimeResponse => !!x && typeof x === 'object' && Array.isArray((x as BotRegimeResponse).hours) && Array.isArray((x as BotRegimeResponse).markets);
/** The regime board (Explore): who takes and how volatile, bucket by bucket over the window, one market or 'ALL'. */
export const useBotRegime = (symbol: string, window: BotWindow = '7d'): Read<BotRegimeResponse> =>
  usePolled(vsPaths.botRegime(symbol, window), 60_000, isRegime);

/** The estimate's windows (server flow/botMarkets.ts; 1h and 6h from 2026-11-09). */
export type BotWindow = '1h' | '6h' | '24h' | '7d';
const rawBotMarkets = (window: BotWindow, enabled: boolean): Read<BotMarketsResponse> =>
  usePolled(enabled ? vsPaths.botMarkets(window) : null, 5 * 60_000, isMarkets);

/**
 * The markets' activity (volume per hour) from SoDEX's own figures (owner 2026-11-08: "activity per h needs to be
 * actually accurate... and update live"): our trade recorder can miss prints on a market (SOL read about a fifth of
 * SoDEX's 24 h volume), so the per-hour volume is SoDEX's - 24h: its live 24-hour quote volume (tickers, every 30 s)
 * / 24; 7d: the sum of its last 168 hourly candles / 168 (fetched four at a time, kept 15 minutes). The other figures
 * (who takes, spread, moves, cost) stay the server's, refreshed every 5 minutes.
 */
export function useBotMarkets(window: BotWindow = '24h', enabled = true): Read<BotMarketsResponse> {
  const r = rawBotMarkets(window, enabled);
  const tick = useTickers('perps', { enabled: enabled && window === '24h', pollMs: 30_000 });
  // The busiest first: the rows a page shows first get SoDEX's 7-day figure first.
  const symbols = useMemo(() => [...(r.data?.markets ?? [])].sort((x, y) => y.volumeUsdH - x.volumeUsdH).map((m) => m.symbol), [r.data]);
  const week = useVolume7d(enabled && window === '7d' ? symbols : []);
  return useMemo(() => {
    if (!r.data) return r;
    const t = (tick.data as { tickers?: Array<{ symbol?: string; quoteVolume?: string | number }> } | null)?.tickers;
    const day = new Map<string, number>();
    if (Array.isArray(t)) for (const x of t) { const q = Number(x.quoteVolume); if (x.symbol && Number.isFinite(q)) day.set(x.symbol, q / 24); }
    // SoDEX's own figure exists for 24 h and 7 d; 1 h and 6 h keep the server's (from the recorded prints).
    const of = (m: BotMarket): number | undefined => (window === '24h' ? day.get(m.symbol) : window === '7d' ? week.get(m.symbol) : undefined);
    if (!day.size && !week.size) return r;
    return { ...r, data: { ...r.data, markets: r.data.markets.map((m) => { const v = of(m); return v === undefined ? m : { ...m, volumeUsdH: v }; }) } };
  }, [r, tick.data, week, window]);
}

const WEEK_TTL = 15 * 60_000;
const weekCache = new Map<string, { at: number; usdH: number }>();
const weekPending = new Set<string>();

/** SoDEX's 7-day volume per hour for these markets: the last 168 hourly candles' quote volume, four reads at a time. */
function useVolume7d(symbols: readonly string[]): Map<string, number> {
  const [, bump] = useState(0);
  const key = symbols.join(',');
  useEffect(() => {
    if (!symbols.length) return;
    let live = true;
    const due = symbols.filter((s) => { const c = weekCache.get(s); return (!c || Date.now() - c.at > WEEK_TTL) && !weekPending.has(s); });
    let i = 0;
    const next = async (): Promise<void> => {
      while (live && i < due.length) {
        const s = due[i++]!;
        weekPending.add(s);
        try {
          const r = await api.klines('perps', s, '1h', 168);
          const rows = (r as { klines?: Array<{ q?: string | number }> }).klines ?? [];
          const sum = rows.reduce((t, k) => t + (Number(k.q) || 0), 0);
          if (rows.length) weekCache.set(s, { at: Date.now(), usdH: sum / rows.length });
        } catch { /* left as the server's */ }
        weekPending.delete(s);
        if (live && i % 4 === 0) bump((n) => n + 1);
      }
      if (live) bump((n) => n + 1);
    };
    void Promise.all([next(), next(), next(), next()]);
    const t = window.setInterval(() => bump((n) => n + 1), WEEK_TTL);
    return () => { live = false; window.clearInterval(t); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const out = new Map<string, number>();
  for (const s of symbols) { const c = weekCache.get(s); if (c) out.set(s, c.usdH); }
  return out;
}

/** This wallet's own bots' latency, or one bot's (`bot`); nothing is read without its session (token null). */
export const useBotLatency = (hours: number, token: string | null, bot?: string, base = '/api/copy/v1'): Read<BotLatencyResponse> =>
  // Every 5 s while the page shows it (owner 2026-11-09: the latency and the "no orders" stretches did not move): the
  // open 10-minute bucket and the last minute's figure change with every write. `base`: the executor the wallet's bots
  // run on (VIP after a move: the standard executor has none of their orders - owner 2026-11-09, no data while they ran).
  usePolled(token ? `${base}/bots/latency?hours=${hours}${bot ? `&bot=${encodeURIComponent(bot)}` : ''}` : null, 5_000, isLatency, token);

/** A cost in bp, per $1M: 1.30 bp is $130. */
export const bpToPerMillion = (bp: number): number => bp * 100;

/** What a market maker would cost on one market at this volume per hour, per day (USD), all-in. */
export const costPerDay = (bp: number, volumeUsdH: number): number => (bp / 10_000) * volumeUsdH * 24;

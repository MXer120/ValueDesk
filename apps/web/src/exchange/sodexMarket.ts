/**
 * SoDEX public market data, read straight from the gateway - in exactly the
 * shapes the ValueDesk server's /api/md/* routes answered, so every panel reads
 * the same fields it always did.
 */
import { unwrapList } from '@sign/sodex/restCore.js';
import { findSymbol, isSymbolId } from '@sign/sodex/symbolRef.js';
import type { Engine, Kline, OrderBook, PublicTrade, Symbol, Ticker } from '../api';
import { priceKlines } from './sodexData';
import { gwGet } from './sodexGateway';

/** A request the server would have refused with 4xx: bad input, unknown market. */
export class MarketRequestError extends Error {
  override name = 'MarketRequestError';
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const KLINE_INTERVALS = new Set([
  '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1D', '3D', '1W', '1M',
]);

const ep = (e: Engine): string => `/api/v1/${e}`;

/** The engine's market list (the gateway's own, cached a minute like the server did). */
export const symbolList = (e: Engine): Promise<Symbol[]> => gwGet<Symbol[]>(`${ep(e)}/markets/symbols`);

/** Resolve a market by name, display name or id, as the server's `resolve` did. */
export async function resolveSymbol(e: Engine, ref: string): Promise<Symbol> {
  const list = await symbolList(e);
  const hit = findSymbol(Array.isArray(list) ? list : [], ref);
  if (hit) return hit;
  throw new MarketRequestError(isSymbolId(ref) ? `unknown ${e} symbolID ${Number(ref)}` : `unknown ${e} symbol ${ref}`, 404);
}

/** A market name that can go into a gateway path as it is (no '/', '?', '%' or spaces). */
const PATH_SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

/**
 * Resolve a market and read something for it - without waiting for the market
 * list when `ref` is already a market's name, which is the usual case: the read
 * and the list go out together, and the list only confirms the market exists
 * (as the server's route did before answering). An id or a display name waits
 * for the list and reads by the canonical name, as before.
 */
async function withMarket<T>(e: Engine, ref: string, load: (name: string) => Promise<T>): Promise<{ sym: Symbol; data: T }> {
  const early = !isSymbolId(ref) && PATH_SAFE_NAME.test(ref)
    ? load(ref).then((data) => ({ ok: true as const, data }), (error: unknown) => ({ ok: false as const, error }))
    : null;
  const sym = await resolveSymbol(e, ref);
  if (early && sym.name === ref) {
    const r = await early;
    if (r.ok) return { sym, data: r.data };
    throw r.error;
  }
  return { sym, data: await load(sym.name) };
}

/**
 * SoDEX's 24h ticker stops at a market's last trade: it does not roll off. Measured 2026-11-06: 7 of 41 spot tickers
 * closed over 24 h ago, vADA 605 h, and went on showing $727 of volume and a 2.45% move for a day with no trade.
 * Past 24 h the window is empty: nothing traded and the price did not move.
 */
export function freshTicker<T extends Ticker & { closeTime?: number }>(t: T, now = Date.now()): T {
  if (typeof t.closeTime !== 'number' || now - t.closeTime <= 86_400_000) return t;
  return { ...t, volume: '0', quoteVolume: '0', change: '0', changePct: 0, openPx: t.lastPx, highPx: t.lastPx, lowPx: t.lastPx };
}

export const market = {
  symbols: async (e: Engine) => ({ engine: e, symbols: await symbolList(e) }),

  coins: async () => ({ coins: await gwGet<Array<{ id: number; name: string; precision: number }>>(`${ep('spot')}/markets/coins`) }),

  tickers: async (e: Engine) => {
    const raw = await gwGet<Ticker[]>(`${ep(e)}/markets/tickers`);
    return { engine: e, tickers: Array.isArray(raw) ? raw.map((t) => freshTicker(t)) : raw };
  },

  bookTickers: async (e: Engine) => ({ engine: e, bookTickers: await gwGet<unknown>(`${ep(e)}/markets/bookTickers`) }),

  markPrices: async () => ({ markPrices: await gwGet<any[]>(`${ep('perps')}/markets/mark-prices`) }),

  async orderbook(e: Engine, symbol: string, limitIn = 20) {
    if (!symbol) throw new MarketRequestError('symbol is required', 400);
    // Depth >100 costs double weight; cap at the documented maximum.
    const limit = Math.min(500, Math.max(1, Math.trunc(limitIn) || 20));
    const { sym, data: book } = await withMarket(e, symbol, (name) =>
      gwGet<OrderBook>(`${ep(e)}/markets/${name}/orderbook?limit=${limit}`, { weight: limit > 100 ? 10 : 5 }));
    return { engine: e, symbol: sym.name, book };
  },

  async klines(
    e: Engine,
    symbol: string,
    interval: string,
    limitIn = 300,
    o: { startTime?: number; endTime?: number; source?: 'mark' | 'index' } = {},
  ) {
    if (!symbol) throw new MarketRequestError('symbol is required', 400);
    if (!KLINE_INTERVALS.has(interval)) throw new MarketRequestError(`unsupported interval ${interval}`, 400);
    const limit = Math.min(1000, Math.trunc(limitIn) || 300);
    // Mark / index candles (sodex.com's stats series) - the gateway's own are the latest traded price.
    const source = o.source;
    if ((source === 'mark' || source === 'index') && e === 'perps') {
      const { sym, data } = await withMarket(e, symbol, (name) =>
        priceKlines({ symbol: name, source, interval, limit, startTime: o.startTime, endTime: o.endTime }));
      return { engine: e, symbol: sym.name, interval, source, klines: data as Kline[] };
    }
    const params = new URLSearchParams({ interval, limit: String(limit) });
    if (o.startTime !== undefined) params.set('startTime', String(o.startTime));
    if (o.endTime !== undefined) params.set('endTime', String(o.endTime));
    // Out of the gateway's last-good copies: nothing falls back to an old candle page (the chart
    // keeps the series it has seen itself, chart/seriesCache.ts), and every history page has its
    // own endTime URL, so they piled up there - up to 2,000 parsed pages of 500-1,000 rows.
    const { sym, data: klines } = await withMarket(e, symbol, (name) =>
      gwGet<Kline[]>(`${ep(e)}/markets/${name}/klines?${params}`, { keepLastGood: false }));
    return { engine: e, symbol: sym.name, interval, klines };
  },

  async trades(e: Engine, symbol: string, limitIn = 50) {
    if (!symbol) throw new MarketRequestError('symbol is required', 400);
    const limit = Math.min(500, Math.max(1, Math.trunc(limitIn) || 50));
    const { sym, data: trades } = await withMarket(e, symbol, (name) => gwGet<PublicTrade[]>(`${ep(e)}/markets/${name}/trades?limit=${limit}`));
    return { engine: e, symbol: sym.name, trades: unwrapList<PublicTrade>(trades, 'trades') };
  },
};

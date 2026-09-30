/** Public market data. Proxied so the browser gets no CORS problem and the
 *  weight budget is enforced once for all tabs. */
import type { FastifyInstance } from 'fastify';
import { sodex } from '../sodex/rest.js';
import { coins, resolve, symbols } from '../sodex/symbols.js';
import { enginePath, type Engine } from '../config.js';
import { priceKlines } from '../sodex/priceKlines.js';

const asEngine = (v: unknown): Engine => (v === 'spot' ? 'spot' : 'perps');

const KLINE_INTERVALS = new Set([
  '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1D', '3D', '1W', '1M',
]);

export async function marketRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/md/:engine/symbols', async (req) => {
    const engine = asEngine((req.params as any).engine);
    return { engine, symbols: await symbols(engine) };
  });

  app.get('/api/md/spot/coins', async () => ({ coins: await coins() }));

  app.get('/api/md/:engine/tickers', async (req) => {
    const engine = asEngine((req.params as any).engine);
    return { engine, tickers: await sodex.get(`${enginePath(engine)}/markets/tickers`) };
  });

  app.get('/api/md/:engine/bookTickers', async (req) => {
    const engine = asEngine((req.params as any).engine);
    return { engine, bookTickers: await sodex.get(`${enginePath(engine)}/markets/bookTickers`) };
  });

  app.get('/api/md/perps/mark-prices', async () => ({
    markPrices: await sodex.get(`${enginePath('perps')}/markets/mark-prices`),
  }));

  app.get('/api/md/:engine/orderbook', async (req, reply) => {
    const engine = asEngine((req.params as any).engine);
    const q = req.query as { symbol?: string; limit?: string };
    if (!q.symbol) return reply.code(400).send({ error: 'symbol is required' });
    const sym = await resolve(engine, q.symbol);
    // Depth >100 costs double weight; cap at the documented maximum.
    const limit = Math.min(500, Math.max(1, Number.parseInt(q.limit ?? '20', 10) || 20));
    const book = await sodex.get(
      `${enginePath(engine)}/markets/${sym.name}/orderbook?limit=${limit}`,
      limit > 100 ? 10 : 5,
    );
    return { engine, symbol: sym.name, book };
  });

  app.get('/api/md/:engine/klines', async (req, reply) => {
    const engine = asEngine((req.params as any).engine);
    const q = req.query as Record<string, string | undefined>;
    if (!q.symbol) return reply.code(400).send({ error: 'symbol is required' });
    const interval = q.interval ?? '1m';
    if (!KLINE_INTERVALS.has(interval)) {
      return reply.code(400).send({ error: `unsupported interval ${interval}`, supported: [...KLINE_INTERVALS] });
    }
    const sym = await resolve(engine, q.symbol);
    // Mark / index candles (sodex.com's stats series) - the gateway's own are the latest traded price.
    if ((q.source === 'mark' || q.source === 'index') && engine === 'perps') {
      const limit = Math.min(1000, Number.parseInt(q.limit ?? '300', 10) || 300);
      const klines = await priceKlines({
        symbol: sym.name,
        source: q.source,
        interval,
        limit,
        startTime: q.startTime ? Number(q.startTime) : undefined,
        endTime: q.endTime ? Number(q.endTime) : undefined,
      });
      return { engine, symbol: sym.name, interval, source: q.source, klines };
    }
    const params = new URLSearchParams({
      interval,
      limit: String(Math.min(1000, Number.parseInt(q.limit ?? '300', 10) || 300)),
    });
    if (q.startTime) params.set('startTime', q.startTime);
    if (q.endTime) params.set('endTime', q.endTime);
    const klines = await sodex.get(`${enginePath(engine)}/markets/${sym.name}/klines?${params}`);
    return { engine, symbol: sym.name, interval, klines };
  });

  app.get('/api/md/:engine/trades', async (req, reply) => {
    const engine = asEngine((req.params as any).engine);
    const q = req.query as { symbol?: string; limit?: string };
    if (!q.symbol) return reply.code(400).send({ error: 'symbol is required' });
    const sym = await resolve(engine, q.symbol);
    const limit = Math.min(500, Math.max(1, Number.parseInt(q.limit ?? '50', 10) || 50));
    const trades = await sodex.get(`${enginePath(engine)}/markets/${sym.name}/trades?limit=${limit}`);
    return { engine, symbol: sym.name, trades };
  });
}

/**
 * Account reads. These need only a wallet address - no signature - so they work
 * the moment a wallet connects, before any API key exists.
 */
import type { FastifyInstance } from 'fastify';
import { sodex, unwrapList, weightFor } from '../sodex/rest.js';
import { lastGood, rememberGood } from '../sodex/lastGood.js';
import { enginePath, type Engine } from '../config.js';

const asEngine = (v: unknown): Engine => (v === 'spot' ? 'spot' : 'perps');

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Upstream's maximum page size for every history-style read. Bigger pages are
 * strictly cheaper per record - upstream weight grows at limit/20 while the rows
 * returned grow at limit - so clamping below what the gateway accepts only burns
 * budget on extra round trips. Shared by all three history routes so they cannot
 * drift apart.
 */
const HISTORY_LIMIT_MAX = 1000;

function requireAddress(q: { address?: string }): string {
  if (!q.address || !ADDRESS_RE.test(q.address)) {
    throw Object.assign(new Error('a valid 0x wallet address is required'), { statusCode: 400 });
  }
  return q.address;
}

/**
 * Build the documented history filter query string.
 *
 * Hands back the clamped page size as well as the query string, because history
 * reads are weighted `20 + limit/20` upstream and SodexClient.request() calls
 * weightFor() with only a path - it has no way to recover the limit once it is
 * baked into a query string, so it would price every page as if limit were 0.
 * The caller is the last place that still knows the number.
 *
 * The default stays 100: raising the ceiling is free, but fetching 1000 rows a
 * panel never renders is the same wasted weight in the other direction.
 */
function historyQuery(q: Record<string, string | undefined>): { qs: string; limit: number } {
  const p = new URLSearchParams();
  if (q.symbol) p.set('symbol', q.symbol);
  if (q.startTime) p.set('startTime', q.startTime);
  if (q.endTime) p.set('endTime', q.endTime);
  const limit = Math.min(HISTORY_LIMIT_MAX, Number.parseInt(q.limit ?? '100', 10) || 100);
  p.set('limit', String(limit));
  return { qs: p.toString(), limit };
}

/**
 * History pages are read by every open tab of the same account (the trade
 * page's tabs and the portfolio's), usually for the same newest page. A few
 * seconds of sharing turns N identical reads into one against SoDEX's budget.
 */
const HISTORY_TTL_MS = 5_000;
const historyCache = new Map<string, { at: number; value: Promise<unknown> }>();
function cachedHistory(path: string, weight: number): Promise<unknown> {
  const hit = historyCache.get(path);
  if (hit && Date.now() - hit.at < HISTORY_TTL_MS) return hit.value;
  const value = sodex.get(path, weight);
  historyCache.set(path, { at: Date.now(), value });
  value.then((v) => rememberGood(path, v)).catch(() => historyCache.delete(path));
  if (historyCache.size > 500) for (const [k, v] of historyCache) if (Date.now() - v.at > HISTORY_TTL_MS) historyCache.delete(k);
  return value;
}

/**
 * A history page, or - when SoDEX refuses (rate limit) or fails - the last good
 * answer for exactly this page, with `staleAt` set to when it was read. History
 * only grows at the top, so an hour-old page is still right in everything it
 * shows; "couldn't load" is only for a page never read before.
 */
async function historyPage(path: string, weight: number): Promise<{ data: unknown; staleAt: number | null }> {
  try {
    return { data: await cachedHistory(path, weight), staleAt: null };
  } catch (e) {
    const kept = lastGood(path);
    if (kept) return { data: kept.value, staleAt: kept.at };
    throw e;
  }
}

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Account discovery. `aid === 0` means this wallet has no SoDEX account yet -
   * the signal the UI uses to show the "deposit to create your account" step.
   */
  app.get('/api/acct/:engine/state', async (req) => {
    const engine = asEngine((req.params as any).engine);
    const address = requireAddress(req.query as any);
    const state = await sodex.get<any>(`${enginePath(engine)}/accounts/${address}/state`);
    return {
      engine,
      address,
      accountId: state?.aid ?? 0,
      userId: state?.uid ?? 0,
      exists: (state?.aid ?? 0) !== 0,
      state,
    };
  });

  app.get('/api/acct/:engine/balances', async (req) => {
    const engine = asEngine((req.params as any).engine);
    const address = requireAddress(req.query as any);
    const data = await sodex.get(`${enginePath(engine)}/accounts/${address}/balances`);
    return { engine, balances: unwrapList(data, 'balances') };
  });

  app.get('/api/acct/:engine/orders', async (req) => {
    const engine = asEngine((req.params as any).engine);
    const address = requireAddress(req.query as any);
    const { symbol } = req.query as { symbol?: string };
    const qs = symbol ? `?symbol=${encodeURIComponent(symbol)}` : '';
    const data = await sodex.get(`${enginePath(engine)}/accounts/${address}/orders${qs}`);
    return { engine, orders: unwrapList(data, 'orders') };
  });

  app.get('/api/acct/perps/positions', async (req) => {
    const address = requireAddress(req.query as any);
    const data = await sodex.get(`${enginePath('perps')}/accounts/${address}/positions`);
    return { positions: unwrapList(data, 'positions') };
  });

  app.get('/api/acct/:engine/orders/history', async (req) => {
    const engine = asEngine((req.params as any).engine);
    const address = requireAddress(req.query as any);
    const { qs, limit } = historyQuery(req.query as any);
    const path = `${enginePath(engine)}/accounts/${address}/orders/history?${qs}`;
    const { data, staleAt } = await historyPage(path, weightFor(path, limit));
    return { engine, orders: unwrapList(data, 'orders'), staleAt };
  });

  app.get('/api/acct/:engine/trades', async (req) => {
    const engine = asEngine((req.params as any).engine);
    const address = requireAddress(req.query as any);
    const { qs, limit } = historyQuery(req.query as any);
    const path = `${enginePath(engine)}/accounts/${address}/trades?${qs}`;
    const { data, staleAt } = await historyPage(path, weightFor(path, limit));
    return { engine, trades: unwrapList(data, 'trades'), staleAt };
  });

  app.get('/api/acct/perps/funding-history', async (req) => {
    const address = requireAddress(req.query as any);
    const { qs, limit } = historyQuery(req.query as any);
    // NOT `/funding-history` as the published reference says - that path 404s.
    // Verified against testnet: the funding payment log lives at `/fundings`.
    const path = `${enginePath('perps')}/accounts/${address}/fundings?${qs}`;
    // weightFor() now matches `/fundings` directly, so the real path prices
    // itself (limit 500 -> 45, limit 1000 -> 70) and no spelling workaround is
    // needed. The explicit limit is still required: request() would otherwise
    // call weightFor(path) with no limit and bill a full page at the floor.
    const { data, staleAt } = await historyPage(path, weightFor(path, limit));
    return { funding: unwrapList(data, 'fundings'), staleAt };
  });

  /** Closed and partly closed perps positions, newest first (sodex.com's Position History). */
  app.get('/api/acct/perps/positions/history', async (req) => {
    const address = requireAddress(req.query as any);
    const { qs, limit } = historyQuery(req.query as any);
    const path = `${enginePath('perps')}/accounts/${address}/positions/history?${qs}`;
    const { data, staleAt } = await historyPage(path, weightFor(path, limit));
    return { positions: unwrapList(data, 'positions'), staleAt };
  });

  app.get('/api/acct/:engine/fee-rate', async (req) => {
    const engine = asEngine((req.params as any).engine);
    const address = requireAddress(req.query as any);
    // No explicit weight: weightFor() already prices `/fee-rate` at 2.
    return { engine, feeRate: await sodex.get(`${enginePath(engine)}/accounts/${address}/fee-rate`) };
  });

  app.get('/api/acct/:engine/api-keys', async (req) => {
    const engine = asEngine((req.params as any).engine);
    const address = requireAddress(req.query as any);
    return { engine, apiKeys: await sodex.get(`${enginePath(engine)}/accounts/${address}/api-keys`) };
  });
}

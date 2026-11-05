/**
 * SoDEX's Blind Box programme, the public half: its rules and the opens feed. And Wealth's maintenance flag,
 * which has the same problem: wealth.sodex.dev sends no CORS headers to other sites, and the gateway has no
 * such path (a 404).
 *
 *   GET /api/vs/sodex/lottery/meta
 *   GET /api/vs/sodex/lottery/feed?limit=N   (N clamped to 1..50, default 20)
 *   GET /api/vs/sodex/wealth/maintenance     ({status:'NORMAL'|'MAINTENANCE', message, updatedAt})
 *
 * WHY THESE GO THROUGH US. mainnet-lottery.sodex.dev sends no CORS headers, so a browser cannot read
 * it, however public the answer is. This is a plain server fetch of two unauthenticated reads: no
 * Origin header is set, nothing is forged and nobody's token passes here. The signed-in part of the
 * programme (web/src/blindBox.ts) never touches this file; it talks to SoDEX from the browser.
 *
 * ONE UPSTREAM READ, HOWEVER MANY VISITORS. Each answer is cached briefly and concurrent misses share
 * one fetch. The feed is always read at SoDEX's largest page and cut here, both because SoDEX answers
 * `limit=3` with far more than three rows and because a limit per caller would be a cache key per
 * caller. When SoDEX fails, the last good answer is served for a while, marked `stale`.
 */
import type { FastifyInstance } from 'fastify';

const DEFAULT_API = 'https://mainnet-lottery.sodex.dev/api/v1/lottery';
const WEALTH_MAINTENANCE_URL = 'https://wealth.sodex.dev/api/v1/wealth/maintenance';
const MAINTENANCE_TTL_MS = 30_000;
const TIMEOUT_MS = 8_000;
const META_TTL_MS = 60_000;
const FEED_TTL_MS = 10_000;
/** How long an old answer may stand in for a failing upstream. */
const STALE_MS = 10 * 60_000;

export const FEED_LIMIT_MAX = 50;
const FEED_LIMIT_DEFAULT = 20;

/** Any request's `limit`, as a number in range. Never an error: the page asked for a list. */
export function feedLimit(raw: unknown): number {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return FEED_LIMIT_DEFAULT;
  return Math.min(FEED_LIMIT_MAX, Math.max(1, n));
}

interface Entry { at: number; data: unknown; pending: Promise<unknown> | null }

class UpstreamError extends Error {}

/** The envelope's `data`, or a throw: `code` 0 is success, whatever the HTTP status said. */
async function read(url: string): Promise<unknown> {
  const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new UpstreamError(`SoDEX answered ${r.status}`);
  const j = (await r.json()) as { code?: number; msg?: string; data?: unknown };
  if (j?.code !== 0 || j.data === undefined || j.data === null) throw new UpstreamError(j?.msg || `SoDEX code ${j?.code}`);
  return j.data;
}

export async function sodexLotteryRoutes(app: FastifyInstance): Promise<void> {
  const base = (process.env.SODEX_LOTTERY_API?.trim() || DEFAULT_API).replace(/\/+$/, '');
  const cache = new Map<string, Entry>();

  /** Fresh from the cache, or one shared upstream read, or the last good answer. */
  const cached = async (path: string, ttl: number): Promise<{ data: unknown; stale: boolean }> => {
    const e = cache.get(path) ?? { at: 0, data: null, pending: null };
    cache.set(path, e);
    if (e.data !== null && Date.now() - e.at < ttl) return { data: e.data, stale: false };
    e.pending ??= read(path.startsWith('https:') ? path : base + path).then(
      (data) => { e.data = data; e.at = Date.now(); e.pending = null; return data; },
      (err: unknown) => { e.pending = null; throw err; },
    );
    try {
      return { data: await e.pending, stale: false };
    } catch (err) {
      if (e.data !== null && Date.now() - e.at < STALE_MS) return { data: e.data, stale: true };
      throw err;
    }
  };

  const failed = (err: unknown): { error: string; source: 'sodex' } => ({
    error: err instanceof Error && err.name === 'TimeoutError' ? 'SoDEX did not answer in time' : err instanceof UpstreamError ? err.message : 'SoDEX could not be read',
    source: 'sodex',
  });

  app.get('/api/vs/sodex/lottery/meta', async (_req, reply) => {
    try {
      const { data, stale } = await cached('/meta', META_TTL_MS);
      reply.header('cache-control', 'public, max-age=60');
      return stale ? { ...(data as object), stale: true } : data;
    } catch (err) {
      return reply.code(502).send(failed(err));
    }
  });

  app.get('/api/vs/sodex/wealth/maintenance', async (_req, reply) => {
    try {
      const { data, stale } = await cached(WEALTH_MAINTENANCE_URL, MAINTENANCE_TTL_MS);
      /* A flag this old says nothing about now: the page treats a failed read as unknown. */
      if (stale) return reply.code(502).send({ error: 'SoDEX could not be read', source: 'sodex' });
      const d = data as { status?: unknown; message?: unknown; updatedAt?: unknown };
      reply.header('cache-control', 'public, max-age=30');
      return { status: d.status ?? null, message: d.message ?? null, updatedAt: d.updatedAt ?? null };
    } catch (err) {
      return reply.code(502).send(failed(err));
    }
  });

  app.get('/api/vs/sodex/lottery/feed', async (req, reply) => {
    const limit = feedLimit((req.query as { limit?: string }).limit);
    try {
      const { data, stale } = await cached(`/feed?limit=${FEED_LIMIT_MAX}`, FEED_TTL_MS);
      const d = data as { minLevel?: unknown; items?: unknown };
      reply.header('cache-control', 'public, max-age=10');
      return {
        minLevel: d.minLevel ?? null,
        items: Array.isArray(d.items) ? d.items.slice(0, limit) : [],
        ...(stale ? { stale: true } : {}),
      };
    } catch (err) {
      return reply.code(502).send(failed(err));
    }
  });
}

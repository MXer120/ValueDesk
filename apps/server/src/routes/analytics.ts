/**
 * POST /api/vs/a - a batch of the app's own analytics events (ops/analytics.ts,
 * ops/analyticsModel.ts), sent by a browser whose visitor allowed analytics.
 *
 * Like the feedback routes (routes/reports.ts): the site's exact Origin and the
 * `write` class at the gate (hosted.ts), tighter limits of its own here, a small
 * body, application/json or text/plain (sendBeacon on page hide can only send the
 * latter without a preflight). The answer is 204 and says nothing.
 *
 * The country and region are Vercel's (deploy/vercel/api-proxy.cjs X-Viewer-Country
 * and X-Viewer-Region, set for this path only): believed only in hosted mode, where
 * nothing reaches this server around the proxy (the origin secret) and the proxy
 * never passes a client's own copy of those headers on.
 */
import type { FastifyInstance } from 'fastify';
import { clientKey } from '../hosted.js';
import { KeyedLimiter, type Limit } from '../rateLimit.js';
import { AnalyticsStore, parseAnalytics } from '../ops/analytics.js';
import { ANALYTICS_BODY_LIMIT } from '../ops/analyticsModel.js';

const MINUTE = 60_000;
export const ANALYTICS_LIMITS: { client: Limit; global: Limit } = {
  client: { max: 60, windowMs: MINUTE },
  global: { max: 20_000, windowMs: MINUTE },
};

export interface AnalyticsRouteOptions {
  store?: AnalyticsStore;
  limiter?: KeyedLimiter;
  /** Whether X-Viewer-Country / X-Viewer-Region are the edge's (hosted mode). */
  trustGeo?: boolean;
  now?: () => number;
}

const geoHeader = (v: unknown, re: RegExp): string | null => {
  const s = String(Array.isArray(v) ? v[0] : v ?? '').trim().toUpperCase();
  return re.test(s) ? s : null;
};

let shared: AnalyticsStore | null = null;
/** The running server's analytics store, opened on first use (routes/admin.ts reads the same one). */
export const analyticsStore = (): AnalyticsStore => (shared ??= new AnalyticsStore());

export async function analyticsRoutes(app: FastifyInstance, opts: AnalyticsRouteOptions = {}) {
  const limiter = opts.limiter ?? new KeyedLimiter(20_000);
  const now = opts.now ?? Date.now;
  const store = (): AnalyticsStore => opts.store ?? analyticsStore();

  app.post('/api/vs/a', { bodyLimit: ANALYTICS_BODY_LIMIT }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const t = now();
    const wait = limiter.take(`a|${clientKey(req.ip)}`, ANALYTICS_LIMITS.client, t) ?? limiter.take('a|*', ANALYTICS_LIMITS.global, t);
    if (wait !== null) {
      reply.header('Retry-After', String(wait));
      return reply.code(429).send({ ok: false, error: `too many requests - wait ${wait}s` });
    }
    let body: unknown = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        return reply.code(400).send({ ok: false, error: 'not JSON' });
      }
    }
    const parsed = parseAnalytics(body, t);
    if (!parsed.ok) return reply.code(400).send({ ok: false, error: parsed.error });
    const geo = opts.trustGeo
      ? { country: geoHeader(req.headers['x-viewer-country'], /^[A-Z]{2}$/), region: geoHeader(req.headers['x-viewer-region'], /^[A-Z0-9]{1,3}$/) }
      : { country: null, region: null };
    store().add(parsed.batch, geo, t);
    return reply.code(204).send();
  });
}

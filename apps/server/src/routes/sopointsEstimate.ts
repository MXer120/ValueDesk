/**
 * The SoPoints estimate (valuedesk/sodex/sopointsModel.ts): the page sends the weeks it wants priced and, signed in, the
 * wallet's scored weeks as SoDEX answered them; this answers each week's own points in a typical, a busy and a quiet
 * week, made the wallet's own by its past weeks. The model stays on this server (owner 2026-11-27: "our formula cant
 * be in the frontend code, it needs to be hidden"); its numbers come from a private file, and without it this is a 503.
 *
 *   POST /api/vs/sopoints/estimate  {plans: [{futures, spot, oi, wealth, vault, boostedShare, coef}], weeks?: [...]}
 *
 * Nothing is kept: no address is sent or needed. A slider drag asks often, so the limit per client is generous but
 * bounded.
 */
import type { FastifyInstance } from 'fastify';
import { clientKey } from '../hosted.js';
import { KeyedLimiter, type Limit } from '../rateLimit.js';
import { answer, loadParams, type ModelParams } from '../valuedesk/sodex/sopointsModel.js';

export const SOPOINTS_ESTIMATE_LIMIT: Limit = { max: 120, windowMs: 60_000 };

export function sopointsEstimateRoutes(o: { params?: () => ModelParams | null; now?: () => number } = {}) {
  const params = o.params ?? (() => loadParams());
  const limiter = new KeyedLimiter();
  const now = o.now ?? Date.now;
  return async function routes(app: FastifyInstance): Promise<void> {
    app.post('/api/vs/sopoints/estimate', { bodyLimit: 32_768 }, async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const wait = limiter.take(`se|${clientKey(req.ip)}`, SOPOINTS_ESTIMATE_LIMIT, now());
      if (wait) return reply.header('Retry-After', String(wait)).code(429).send({ ok: false, error: `too many requests - wait ${wait}s` });
      const m = params();
      if (!m) return reply.code(503).send({ ok: false, error: 'estimate not available' });
      const a = answer(m, req.body);
      if (!a) return reply.code(400).send({ ok: false, error: 'plans (up to 16) and weeks (up to 40) are expected' });
      return reply.send({ ok: true, ...a });
    });
  };
}

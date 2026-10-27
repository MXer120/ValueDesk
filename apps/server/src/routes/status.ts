/**
 * GET /api/vs/status - the public status page's data (ops/status.ts): each
 * service's last probe and its 90 days of uptime, as ops/statusModel.ts types it.
 *
 * Public and the same for everyone: no input, nothing about a visitor. Built at
 * most every CACHE_MS from status.db and kept in memory between, and the edge may
 * share an answer as long (perf.ts CACHE_POLICIES) - so a crowd watching the page
 * during an outage costs this server one small read every 30 seconds.
 *
 * A server that does not probe (local dev without VALUESCAN_STATUS_PROBE=1)
 * answers from whatever status.db holds - usually nothing: every day no data.
 */
import type { FastifyInstance } from 'fastify';
import { StatusStore } from '../ops/status.js';
import type { StatusReport } from '../ops/statusModel.js';

export const STATUS_CACHE_MS = 30_000;

export interface StatusRouteOptions {
  /** The record to answer from (tests, or the running prober's); default one opened on first use. */
  store?: StatusStore;
  now?: () => number;
}

export async function statusRoutes(app: FastifyInstance, opts: StatusRouteOptions = {}) {
  const now = opts.now ?? Date.now;
  let store = opts.store ?? null;
  let cached: { at: number; body: StatusReport } | null = null;

  app.get('/api/vs/status', async (req, reply) => {
    const t = now();
    if (!cached || t - cached.at >= STATUS_CACHE_MS) {
      try {
        store ??= new StatusStore();
        cached = { at: t, body: store.report(t) };
      } catch (e) {
        req.log.error({ err: e instanceof Error ? e.message : String(e) }, 'status: the record could not be read');
        return reply.code(503).send({ ok: false, error: 'status is not available right now' });
      }
    }
    return cached.body;
  });
}

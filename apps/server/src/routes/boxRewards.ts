/**
 * GET /api/vs/sodex/lottery/rewards: what SoDEX Blind Boxes paid per tier, from the chain (valuedesk/boxRewards.ts).
 * Public, the same for everyone, refreshed every ten minutes here and cached by browsers for five.
 */
import type { FastifyInstance } from 'fastify';
import { boxRewards, type RewardsDoc } from '../valuedesk/boxRewards.js';

export function boxRewardsRoutes(o: { file?: string | null; read?: () => Promise<RewardsDoc | null> } = {}) {
  const read = o.read ?? (() => boxRewards(o.file ?? null));
  return async function routes(app: FastifyInstance): Promise<void> {
    app.get('/api/vs/sodex/lottery/rewards', async (_req, reply) => {
      const d = await read();
      if (!d) return reply.header('Cache-Control', 'no-store').code(503).send({ ok: false, error: 'box rewards not available yet' });
      return reply.header('Cache-Control', 'public, max-age=300').send(d);
    });
  };
}

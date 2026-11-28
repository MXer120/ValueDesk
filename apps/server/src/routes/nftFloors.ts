/**
 * GET /api/vs/nft/floors: ValueChain NFT floor prices, per collection and rarity tier, from valuemint.store
 * (valuedesk/nftFloors.ts). Public, the same for everyone, cached here for ten minutes and by browsers for five.
 */
import type { FastifyInstance } from 'fastify';
import { nftFloors, type FloorsDoc } from '../valuedesk/nftFloors.js';

export function nftFloorsRoutes(o: { read?: () => Promise<FloorsDoc | null> } = {}) {
  const read = o.read ?? nftFloors;
  return async function routes(app: FastifyInstance): Promise<void> {
    app.get('/api/vs/nft/floors', async (_req, reply) => {
      const d = await read();
      if (!d) return reply.header('Cache-Control', 'no-store').code(503).send({ ok: false, error: 'floors not available' });
      return reply.header('Cache-Control', 'public, max-age=300').send(d);
    });
  };
}

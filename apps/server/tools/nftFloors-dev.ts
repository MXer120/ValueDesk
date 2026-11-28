/**
 * Dev only: GET /api/vs/nft/floors (src/routes/nftFloors.ts) in-process for the web dev server, so localhost has
 * ValueChain NFT floors before the route is released. apps/web/vite.config.ts devNftFloors loads this with
 * ssrLoadModule. Never in a build.
 */
import Fastify from 'fastify';
import { nftFloorsRoutes } from '../src/routes/nftFloors.js';

const app = Fastify();
const ready = app.register(nftFloorsRoutes()).then(() => app.ready());

export async function handle(url: string): Promise<{ status: number; body: string; cache: string }> {
  await ready;
  const r = await app.inject({ method: 'GET', url });
  return { status: r.statusCode, body: r.body, cache: String(r.headers['cache-control'] ?? 'no-store') };
}

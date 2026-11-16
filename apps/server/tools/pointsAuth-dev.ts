/**
 * Dev only: the SoPoints sign-in relay (src/routes/pointsAuth.ts) in-process for the web dev server, so localhost on
 * production's data can sign in before the relay is released (owner 2026-11-16: "method not allowed" on localhost).
 * apps/web/vite.config.ts devSodexAuth loads this with ssrLoadModule and hands it the two POSTs. Never in a build.
 */
import Fastify from 'fastify';
import { pointsAuthRoutes } from '../src/routes/pointsAuth.js';

const app = Fastify();
const ready = app.register(pointsAuthRoutes()).then(() => app.ready());

export async function handle(url: string, body: string, ip: string): Promise<{ status: number; body: string }> {
  await ready;
  const r = await app.inject({ method: 'POST', url, payload: body || '{}', headers: { 'content-type': 'application/json' }, remoteAddress: ip });
  return { status: r.statusCode, body: r.body };
}

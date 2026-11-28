/**
 * Dev only: the SSI quote relay (src/routes/ssiQuote.ts) in-process for the web dev server, so localhost on production's
 * data can buy ANT Believers Index before the route is released. apps/web/vite.config.ts devSsiQuote loads this with
 * ssrLoadModule and hands it the POST. Never in a build.
 */
import Fastify from 'fastify';
import { ssiQuoteRoutes } from '../src/routes/ssiQuote.js';

const app = Fastify();
const ready = app.register(ssiQuoteRoutes()).then(() => app.ready());

export async function handle(url: string, body: string, ip: string): Promise<{ status: number; body: string }> {
  await ready;
  const r = await app.inject({ method: 'POST', url, payload: body || '{}', headers: { 'content-type': 'application/json' }, remoteAddress: ip });
  return { status: r.statusCode, body: r.body };
}

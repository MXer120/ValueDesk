/**
 * Dev only: the Wealth page's newer API routes in-process for the web dev server, so localhost on production's data
 * (VALUETRADE_DEV_API=prod) has them before they are released:
 *
 *   GET  /api/vs/wealth/info               the fund info relay (src/routes/wealthInfo.ts), live from SoDEX
 *   GET  /api/vs/indexes, /api/vs/indexes/:id, /api/vs/indexes/image/:hash, POST .../publish, .../unpublish
 *        published indexes
 *        (src/routes/vdIndexes.ts) on a laptop database of their own: VALUESCAN_INDEXES_DB, or indexes-dev.db in the
 *        system temp folder. Nothing a laptop publishes reaches production.
 *
 * apps/web/vite.config.ts devWealthRoutes loads this with ssrLoadModule and hands it the request. Never in a build.
 */
import Fastify from 'fastify';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IndexStore } from '../src/indexes/store.js';
import { vdIndexRoutes } from '../src/routes/vdIndexes.js';
import { wealthInfoRoutes } from '../src/routes/wealthInfo.js';

const app = Fastify();
const store = new IndexStore(process.env.VALUESCAN_INDEXES_DB?.trim() || join(tmpdir(), 'valuedesk-indexes-dev.db'));
const ready = app.register(wealthInfoRoutes())
  .then(() => app.register(vdIndexRoutes, { store }))
  .then(() => app.ready());

export const DEV_PATHS = /^\/api\/vs\/(wealth\/(info|history|listing)|indexes)(\/|\?|$)/;

/** The answer's headers the page needs: an index's picture is bytes with its own type and safety headers. */
const PASSED = ['cache-control', 'retry-after', 'content-type', 'x-content-type-options', 'content-security-policy', 'content-disposition'];

/** `body`: text for JSON, the bytes for a picture (the dev server's res.end takes either). */
export async function handle(method: string, url: string, body: string, ip: string): Promise<{ status: number; body: string | Buffer; headers: Record<string, string> }> {
  await ready;
  const r = await app.inject({
    method: method === 'POST' ? 'POST' : 'GET',
    url,
    ...(method === 'POST' ? { payload: body || '{}', headers: { 'content-type': 'application/json' } } : {}),
    remoteAddress: ip,
  });
  const headers: Record<string, string> = {};
  for (const k of PASSED) { const v = r.headers[k]; if (typeof v === 'string') headers[k] = v; }
  return { status: r.statusCode, body: /^image\//.test(headers['content-type'] ?? '') ? r.rawPayload : r.body, headers };
}

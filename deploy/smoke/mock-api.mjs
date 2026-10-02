// A STAND-IN for the hosted index API, for testing the smoke harness itself
// (smoke.mjs --api=mock). It is NOT the product and proves nothing about it.
//
// It enforces what the real gate enforces (apps/server/src/hosted.ts) - the
// origin secret on every route but /api/health, the route allow-list read from
// that file, GETs only, no repeated query parameters - and answers each allowed
// route the way a hosted server answers when its index file does not exist yet:
// HTTP 200 with {ok:false, code:'not_available'} (the web shows that per section).
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The allow-list, straight from the server's source: [{ method, url }]. */
export function hostedRoutes(repo = REPO) {
  const src = readFileSync(join(repo, 'apps', 'server', 'src', 'hosted.ts'), 'utf8');
  const block = /export const HOSTED_ROUTES[^=]*=\s*\[([\s\S]*?)\n\];/.exec(src);
  if (!block) throw new Error('could not read HOSTED_ROUTES from apps/server/src/hosted.ts');
  const routes = [...block[1].matchAll(/method:\s*'(\w+)',\s*url:\s*'([^']+)'/g)].map((m) => ({ method: m[1], url: m[2] }));
  if (!routes.length) throw new Error('HOSTED_ROUTES is empty');
  return routes;
}

/** A route pattern ('/api/external/announcements/:id') as a matcher of pathnames. */
export const routeRegExp = (pattern) => new RegExp('^' + pattern.split('/').map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/') + '/?$');

/** The allow-list entry a request falls under, or null. */
export function matchRoute(routes, method, pathname) {
  const m = method === 'HEAD' ? 'GET' : method;
  return routes.find((r) => r.method === m && routeRegExp(r.url).test(pathname)) ?? null;
}

const API_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

function answer(pattern, url) {
  const now = Date.now();
  switch (pattern) {
    case '/api/health':
      return { ok: true, network: 'mainnet', chainId: 286623, mainnetWritesAllowed: true };
    case '/api/external/maintenance/status':
      return { reachable: true, maintenance: false, reason: null, status: 'NORMAL', recent503: null, maintenanceDuration: null };
    case '/api/external/announcements':
      return { ok: true, list: [], total: 0 };
    case '/api/vs/leaderboard':
      return {
        ok: true, venue: url.searchParams.get('venue') ?? 'all', window: url.searchParams.get('window') ?? '30d', sort: 'pnl',
        rows: [], total: 0, updatedAt: now, source: 'ValueScan index is starting. The board fills as traders are read.',
        index: { complete: false, pending: 0, updatedAt: 0 },
      };
    case '/api/vs/lbrow':
      return { ok: true, row: null };
    default:
      return { ok: false, code: 'not_available', error: 'The index is not running yet' };
  }
}

/**
 * @param {{ port: number, secret: string, host?: string }} o
 * @returns {Promise<{ url: string, requests: Array<object>, close(): Promise<void> }>}
 */
export function startMockApi({ port, secret, host = '127.0.0.1' }) {
  const routes = hostedRoutes();
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (status, body) => {
      requests.push({ method: req.method, path: req.url, status });
      res.writeHead(status, API_HEADERS);
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
    };
    const route = matchRoute(routes, req.method ?? 'GET', url.pathname);
    if (secret && route?.url !== '/api/health' && req.headers['x-origin-verify'] !== secret) return send(403, { error: 'forbidden', source: 'server' });
    if (!route) return send(404, { error: 'not found', source: 'server' });
    const keys = [...url.searchParams.keys()];
    const repeated = keys.find((k, i) => keys.indexOf(k) !== i);
    if (repeated) return send(400, { error: `query parameter "${repeated}" is repeated`, source: 'validation' });
    return send(200, answer(route.url, url));
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => ok({
      url: `http://${host}:${port}`,
      requests,
      close: () => new Promise((done) => {
        server.closeAllConnections?.();
        server.close(() => done());
      }),
    }));
  });
}

/**
 * Hosted mode (VALUESCAN_HOSTED=1): the public, read-only index API.
 *
 * Covers the route allow-list, the custodial 410 (including the
 * percent-encoding bypass it used to have), CORS and the site-origin rule,
 * per-client rate limits and how the client address is derived behind a proxy,
 * the origin secret, and the configuration parsing that feeds all of it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';

import {
  DEFAULT_LIMITS,
  HOSTED_ROUTES,
  ORIGIN_SECRET_HEADER,
  clientKey,
  fastifyTrustProxy,
  hostedConfigFromEnv,
  hostedRoute,
  installHostedGate,
  installServerSigningGate,
  isServerSigningRequest,
  limitsFor,
  parseTrustProxy,
  siteOriginsFrom,
  type HostedConfig,
  type HostedLimits,
  type HostedRoute,
} from '../src/hosted.js';

const SITE = 'https://app.valuescan.example';
const SRC = fileURLToPath(new URL('../src/', import.meta.url));
/**
 * No state-changing route is listed today (the SoPoints relay is unused). The
 * gate's rules for one - exact site Origin, `auth` caps - are tested with this.
 */
const AUTH_ROUTE: HostedRoute = { method: 'POST', url: '/api/points/auth/nonce', cls: 'auth' };

// --- configuration ---------------------------------------------------------------

test('hosted config: off unless VALUESCAN_HOSTED=1, and then no other variable is read', () => {
  const off = hostedConfigFromEnv({ VALUESCAN_TRUST_PROXY: 'true', VALUESCAN_ORIGIN_SECRET: 'short', VALUESCAN_RATE_READ_PER_MIN: 'lots' });
  assert.equal(off.enabled, false);
  assert.equal(off.trustProxy, false);
  assert.equal(off.originSecret, null);
  assert.deepEqual(off.limits, DEFAULT_LIMITS);
  assert.equal(hostedConfigFromEnv({ VALUESCAN_HOSTED: 'true' }).enabled, false, 'only "1" switches it on');
});

test('hosted config: defaults, overrides, and malformed values stop the boot', () => {
  const on = hostedConfigFromEnv({ VALUESCAN_HOSTED: '1' });
  assert.equal(on.enabled, true);
  assert.equal(on.trustProxy, false);
  assert.deepEqual(on.limits, DEFAULT_LIMITS);

  const tuned = hostedConfigFromEnv({
    VALUESCAN_HOSTED: '1',
    VALUESCAN_TRUST_PROXY: 'loopback, 10.0.0.0/8',
    VALUESCAN_ORIGIN_SECRET: 'x'.repeat(40),
    VALUESCAN_RATE_READ_PER_MIN: '900',
    VALUESCAN_RATE_UPSTREAM_PER_MIN: '60',
    VALUESCAN_RATE_AUTH_PER_MIN: '5',
    VALUESCAN_RATE_AUTH_GLOBAL_PER_MIN: '50',
  });
  assert.deepEqual(tuned.trustProxy, ['loopback', '10.0.0.0/8']);
  assert.equal(tuned.originSecret, 'x'.repeat(40));
  assert.deepEqual(
    Object.fromEntries(Object.entries(tuned.limits).map(([k, l]) => [k, l.max])),
    { read: 900, upstream: 60, auth: 5, authGlobal: 50 },
  );

  for (const bad of [
    { VALUESCAN_RATE_READ_PER_MIN: '0' },
    { VALUESCAN_RATE_UPSTREAM_PER_MIN: '-5' },
    { VALUESCAN_RATE_AUTH_PER_MIN: '1e3' },
    { VALUESCAN_ORIGIN_SECRET: 'too-short' },
    { VALUESCAN_TRUST_PROXY: 'true' },
  ]) {
    assert.throws(() => hostedConfigFromEnv({ VALUESCAN_HOSTED: '1', ...bad }), Error, JSON.stringify(bad));
  }
});

test('trust proxy: never "everyone"; a hop count or the proxy addresses', () => {
  for (const off of [undefined, '', '0', 'false', 'off', 'none']) assert.equal(parseTrustProxy(off), false, String(off));
  for (const everyone of ['true', '*', 'all', 'TRUE', 'yes', 'on']) {
    assert.throws(() => parseTrustProxy(everyone), /forge/, everyone);
  }
  assert.equal(parseTrustProxy('1'), 1);
  assert.equal(parseTrustProxy('2'), 2);
  assert.throws(() => parseTrustProxy('10'), /1\.\.9/);
  assert.deepEqual(parseTrustProxy('127.0.0.1'), ['127.0.0.1']);
  assert.deepEqual(parseTrustProxy('loopback,172.31.0.0/16, ::1, fd00::/8'), ['loopback', '172.31.0.0/16', '::1', 'fd00::/8']);
  for (const bad of ['proxy.internal', '10.0.0.0/33', '1.2.3', 'fd00::/129', 'loopback,evil']) {
    assert.throws(() => parseTrustProxy(bad), /VALUESCAN_TRUST_PROXY/, bad);
  }
  assert.equal(fastifyTrustProxy(false), false);
  assert.equal(fastifyTrustProxy(['loopback', '10.0.0.0/8']), 'loopback,10.0.0.0/8');
  const hops = fastifyTrustProxy(2) as (a: string, i: number) => boolean;
  assert.deepEqual([0, 1, 2, 3].map((i) => hops('x', i)), [true, true, false, false]);
});

test('site origins: normalised to exact origins, anything else refused', () => {
  assert.deepEqual(siteOriginsFrom(['https://App.Valuescan.Example', 'https://x.example:8443/']), ['https://app.valuescan.example', 'https://x.example:8443']);
  for (const bad of ['app.valuescan.example', 'https://app.example/path', 'javascript:alert(1)', 'https://u:p@app.example', 'https://app.example/?a=1']) {
    assert.throws(() => siteOriginsFrom([bad]), /origin/, bad);
  }
});

// --- client identity -----------------------------------------------------------------

test('client key: IPv4 as is, IPv4-mapped as IPv4, IPv6 grouped by /64', () => {
  assert.equal(clientKey('203.0.113.9'), '203.0.113.9');
  assert.equal(clientKey('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(clientKey('2001:db8:1:2::1'), '2001:db8:1:2::/64');
  assert.equal(clientKey('2001:db8:1:2:ffff:ffff:ffff:ffff'), '2001:db8:1:2::/64');
  assert.equal(clientKey('2001:0db8:0001:0002:0000:0000:0000:0001'), '2001:db8:1:2::/64');
  assert.notEqual(clientKey('2001:db8:1:3::1'), clientKey('2001:db8:1:2::1'));
  assert.equal(clientKey('::1'), '0:0:0:0::/64');
  assert.equal(clientKey('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.equal(clientKey('64:ff9b::192.0.2.33'), '64:ff9b:0:0::/64');
  assert.equal(clientKey(undefined), 'unknown');
});

// --- the allow-list itself -----------------------------------------------------------

/** Every `app.<method>('<pattern>'` registered in the server's route files. */
function registeredRoutes(): Set<string> {
  const files = [join(SRC, 'index.ts'), ...readdirSync(join(SRC, 'routes')).map((f) => join(SRC, 'routes', f))];
  const out = new Set<string>();
  for (const f of files) {
    for (const m of readFileSync(f, 'utf8').matchAll(/app\.(get|post|delete|put|patch)\(\s*'([^']+)'/g)) {
      out.add(`${m[1]!.toUpperCase()} ${m[2]}`);
    }
  }
  return out;
}

test('the allow-list names only routes that exist, each once', () => {
  const registered = registeredRoutes();
  const seen = new Set<string>();
  for (const r of HOSTED_ROUTES) {
    const k = `${r.method} ${r.url}`;
    assert.ok(registered.has(k), `${k} is on the hosted list but no route file registers it`);
    assert.ok(!seen.has(k), `${k} is listed twice`);
    seen.add(k);
  }
});

test('the allow-list is exactly docs/ARCH-traffic.md section 5', () => {
  assert.deepEqual(
    HOSTED_ROUTES.map((r) => `${r.method} ${r.url} ${r.cls}`).sort(),
    [
      'GET /api/external/announcements read',
      'GET /api/external/announcements/:id upstream',
      'GET /api/external/maintenance/status read',
      'GET /api/feed/account upstream',
      'GET /api/health read',
      'GET /api/vs/cohorts read',
      'GET /api/vs/cohorts/detail read',
      'GET /api/vs/cohorts/focus read',
      'GET /api/vs/cohorts/map read',
      'GET /api/vs/cohorts/wallets read',
      'GET /api/vs/explore read',
      'GET /api/vs/lbrow read',
      'GET /api/vs/leaderboard read',
      'GET /api/vs/positioning read',
      'GET /api/vs/screener read',
      'GET /api/vs/whales read',
    ],
  );
  // Nothing is left marked provisional: the list is final.
  for (const r of HOSTED_ROUTES) assert.deepEqual(Object.keys(r).filter((k) => !['method', 'url', 'cls', 'upstreamWhen'].includes(k)), [], r.url);
});

test('the allow-list holds no custodial, per-user, diagnostic or websocket route', () => {
  const forbidden = [
    /^\/api\/session/, /^\/api\/wallet\//, /^\/api\/trade\//, /^\/api\/money\//,
    /^\/api\/acct\//, /^\/api\/md\//, /^\/api\/scan/, /^\/api\/stats\//, /^\/api\/onboarding/,
    /^\/api\/mirror\//, /^\/api\/deposit\//, /^\/api\/prefs/, /^\/api\/points\//,
    /^\/api\/vs\/(trader|fills|account|price)$/, /^\/api\/external\/leaderboard/, /^\/api\/external\/resolve-account/,
    /^\/api\/vs\/index\/status/, /^\/ws$/,
  ];
  for (const r of HOSTED_ROUTES) {
    for (const re of forbidden) assert.ok(!re.test(r.url), `${r.method} ${r.url} must not be public`);
    assert.equal(r.method, 'GET', `${r.method} ${r.url}: hosted mode is read-only`);
  }
  // HEAD follows GET; nothing else is implied.
  assert.ok(hostedRoute('HEAD', '/api/vs/leaderboard'));
  assert.equal(hostedRoute('POST', '/api/vs/leaderboard'), null);
  assert.equal(hostedRoute('GET', undefined), null);
});

test('rate classes: search and per-id lookups cost more, an auth route is capped overall', () => {
  const lb = hostedRoute('GET', '/api/vs/leaderboard')!;
  assert.deepEqual(limitsFor(lb, {}, DEFAULT_LIMITS, 'c').map((l) => l.key), ['read|c']);
  assert.deepEqual(limitsFor(lb, { q: '  ' }, DEFAULT_LIMITS, 'c').map((l) => l.key), ['read|c']);
  assert.deepEqual(limitsFor(lb, { q: '0xabc' }, DEFAULT_LIMITS, 'c').map((l) => l.key), ['read|c', 'upstream|c']);
  assert.deepEqual(limitsFor(hostedRoute('GET', '/api/feed/account')!, {}, DEFAULT_LIMITS, 'c').map((l) => l.key), ['read|c', 'upstream|c']);
  // One leaderboard row is a lookup in memory, whatever the address.
  assert.deepEqual(limitsFor(hostedRoute('GET', '/api/vs/lbrow')!, { address: '0x' + '1'.repeat(40) }, DEFAULT_LIMITS, 'c').map((l) => l.key), ['read|c']);
  assert.deepEqual(limitsFor(AUTH_ROUTE, {}, DEFAULT_LIMITS, 'c').map((l) => l.key), ['auth|c', 'auth|*']);
  assert.equal(hostedRoute('POST', '/api/points/auth/nonce'), null, 'the unused SoPoints relay is not public');
});

// --- the custodial 410 ---------------------------------------------------------------

test('custodial paths are recognised by raw path and by the route the router matched', () => {
  assert.equal(isServerSigningRequest('/api/session/import', '/api/session/import'), true);
  // The bypass: the router decodes %73 to "s" and runs the import handler,
  // while the raw URL matches no custodial pattern.
  assert.equal(isServerSigningRequest('/api/%73ession/import', '/api/session/import'), true);
  assert.equal(isServerSigningRequest('/api/%74rade/perps/order', '/api/trade/:engine/order'), true);
  assert.equal(isServerSigningRequest('/api/money/withdraw?x=1', undefined), true);
  assert.equal(isServerSigningRequest('/api/money/overview', '/api/money/overview'), false);
  assert.equal(isServerSigningRequest('/api/wallet/account', '/api/wallet/account'), false);
});

// --- the gate, end to end ------------------------------------------------------------------

async function hostedApp(o: { limits?: Partial<HostedLimits>; trustProxy?: HostedConfig['trustProxy']; originSecret?: string; extra?: HostedRoute[] } = {}) {
  const cfg: HostedConfig = {
    enabled: true,
    trustProxy: o.trustProxy ?? false,
    originSecret: o.originSecret ?? null,
    limits: { ...DEFAULT_LIMITS, ...o.limits },
  };
  const routes = [...HOSTED_ROUTES, ...(o.extra ?? [])];
  const app = Fastify({ trustProxy: fastifyTrustProxy(cfg.trustProxy) });
  await app.register(cors, { origin: [SITE], methods: ['GET', 'POST', 'OPTIONS'] });
  installServerSigningGate(app);
  for (const r of routes) {
    app.route({ method: r.method, url: r.url, handler: async (req) => ({ ok: true, route: req.routeOptions.url, ip: req.ip }) });
  }
  // Registered anyway: the LIST decides, not what happens to be registered.
  app.get('/api/acct/:engine/state', async () => ({ leaked: true }));
  app.get('/api/vs/index/status', async () => ({ leaked: true }));
  // Dropped from the list with the browser-direct move (ARCH-traffic §5); the server still registers them.
  for (const url of ['/api/vs/trader', '/api/vs/fills', '/api/vs/account', '/api/vs/price', '/api/external/leaderboard', '/api/external/leaderboard/rank', '/api/external/resolve-account', '/api/deposit/chain']) {
    app.get(url, async () => ({ leaked: true }));
  }
  app.post('/api/session/import', async () => ({ leaked: true }));
  app.post('/api/trade/:engine/order', async () => ({ leaked: true }));
  app.post('/api/scan/track', async () => ({ leaked: true }));
  // Installed AFTER the routes, exactly as index.ts does.
  installHostedGate(app, { cfg, site: [SITE], routes });
  await app.ready();
  return app;
}

test('gate: listed routes answer, everything else is a 404 - including registered ones', async () => {
  const app = await hostedApp();
  assert.equal((await app.inject({ method: 'GET', url: '/api/vs/leaderboard?window=7d' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'HEAD', url: '/api/vs/cohorts' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/external/announcements/42' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: `/api/vs/lbrow?venue=hyperliquid&address=0x${'1'.repeat(40)}` })).statusCode, 200);
  const addr = '0x' + '1'.repeat(40);
  for (const url of [
    `/api/acct/perps/state?address=${addr}`, '/api/vs/index/status', '/nope', '/', '/ws',
    `/api/vs/trader?venue=sodex&address=${addr}`, `/api/vs/fills?venue=sodex&address=${addr}`, `/api/vs/account?venue=sodex&address=${addr}&kind=open`,
    '/api/vs/price?coin=BTC', '/api/external/leaderboard', `/api/external/leaderboard/rank?wallet_address=${addr}`,
    '/api/external/resolve-account?id=1', '/api/deposit/chain',
  ]) {
    const r = await app.inject({ method: 'GET', url });
    assert.equal(r.statusCode, 404, url);
    assert.deepEqual(r.json(), { error: 'not found', source: 'server' }, url);
  }
  const track = await app.inject({ method: 'POST', url: '/api/scan/track', headers: { origin: SITE }, payload: {} });
  assert.equal(track.statusCode, 404);
  await app.close();
});

test('gate: custodial paths answer 410, percent-encoded or not', async () => {
  const app = await hostedApp();
  for (const url of ['/api/session/import', '/api/%73ession/import', '/api/trade/perps/order', '/api/%74rade/perps/order']) {
    const r = await app.inject({ method: 'POST', url, headers: { origin: SITE }, payload: {} });
    assert.equal(r.statusCode, 410, url);
    assert.ok(!r.body.includes('leaked'), url);
  }
  await app.close();
});

test('gate: repeated query parameters are refused', async () => {
  const app = await hostedApp();
  const r = await app.inject({ method: 'GET', url: '/api/vs/leaderboard?venue=sodex&venue=hyperliquid' });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /venue/);
  await app.close();
});

test('gate: the unlisted SoPoints relay is a 404, even from the site', async () => {
  const app = await hostedApp();
  for (const url of ['/api/points/auth/nonce', '/api/points/auth/verify']) {
    const r = await app.inject({ method: 'POST', url, headers: { origin: SITE }, payload: {} });
    assert.equal(r.statusCode, 404, url);
  }
  await app.close();
});

test('gate: a state-changing route, if ever listed, needs the site Origin, exactly', async () => {
  const app = await hostedApp({ extra: [AUTH_ROUTE] });
  const post = (headers: Record<string, string>) =>
    app.inject({ method: 'POST', url: AUTH_ROUTE.url, headers, payload: { address: '0x' + '2'.repeat(40) } });
  assert.equal((await post({})).statusCode, 403, 'no Origin');
  assert.equal((await post({ origin: 'https://evil.example' })).statusCode, 403, 'foreign Origin');
  assert.equal((await post({ origin: 'http://localhost:5180' })).statusCode, 403, 'no loopback in hosted mode');
  assert.equal((await post({ origin: 'null' })).statusCode, 403, 'opaque Origin');
  assert.equal((await post({ origin: SITE })).statusCode, 200);
  await app.close();
});

test('gate: CORS answers the site origin only', async () => {
  const app = await hostedApp({ extra: [AUTH_ROUTE] });
  const pre = await app.inject({
    method: 'OPTIONS', url: AUTH_ROUTE.url,
    headers: { origin: SITE, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
  });
  assert.equal(pre.statusCode, 204);
  assert.equal(pre.headers['access-control-allow-origin'], SITE);
  const evilPre = await app.inject({
    method: 'OPTIONS', url: AUTH_ROUTE.url,
    headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
  });
  assert.equal(evilPre.headers['access-control-allow-origin'], undefined);
  const get = await app.inject({ method: 'GET', url: '/api/vs/explore', headers: { origin: SITE } });
  assert.equal(get.headers['access-control-allow-origin'], SITE);
  const evil = await app.inject({ method: 'GET', url: '/api/vs/explore', headers: { origin: 'https://evil.example' } });
  assert.equal(evil.headers['access-control-allow-origin'], undefined);
  const local = await app.inject({ method: 'GET', url: '/api/vs/explore', headers: { origin: 'http://127.0.0.1:5180' } });
  assert.equal(local.headers['access-control-allow-origin'], undefined, 'no loopback in hosted mode');
  await app.close();
});

test('gate: per-client read limit, with Retry-After; another client is unaffected', async () => {
  const app = await hostedApp({ limits: { read: { max: 3, windowMs: 60_000 } } });
  const hit = (remoteAddress: string) => app.inject({ method: 'GET', url: '/api/vs/explore', remoteAddress });
  for (let i = 0; i < 3; i++) assert.equal((await hit('198.51.100.1')).statusCode, 200, `request ${i}`);
  const over = await hit('198.51.100.1');
  assert.equal(over.statusCode, 429);
  assert.ok(Number(over.headers['retry-after']) >= 1);
  assert.equal((await hit('198.51.100.2')).statusCode, 200);
  // One IPv6 /64 is one client.
  for (let i = 0; i < 3; i++) assert.equal((await hit(`2001:db8:1:2::${i + 1}`)).statusCode, 200);
  assert.equal((await hit('2001:db8:1:2::abcd')).statusCode, 429);
  assert.equal((await hit('2001:db8:1:3::1')).statusCode, 200);
  await app.close();
});

test('gate: upstream-costly reads have their own, tighter budget', async () => {
  const app = await hostedApp({ limits: { upstream: { max: 2, windowMs: 60_000 } } });
  const get = (url: string) => app.inject({ method: 'GET', url, remoteAddress: '198.51.100.9' });
  assert.equal((await get('/api/feed/account?id=12345')).statusCode, 200);
  assert.equal((await get('/api/vs/leaderboard?q=0xabc')).statusCode, 200, 'a search counts as upstream');
  assert.equal((await get('/api/external/announcements/7')).statusCode, 429);
  assert.equal((await get('/api/vs/leaderboard?window=30d')).statusCode, 200, 'plain index reads are not held back');
  assert.equal((await get(`/api/vs/lbrow?venue=hyperliquid&address=0x${'3'.repeat(40)}`)).statusCode, 200, 'a leaderboard row is a plain index read');
  await app.close();
});

test('gate: an auth route is capped per client and overall', async () => {
  const app = await hostedApp({ extra: [AUTH_ROUTE], limits: { auth: { max: 2, windowMs: 60_000 }, authGlobal: { max: 3, windowMs: 60_000 } } });
  const post = (remoteAddress: string) =>
    app.inject({ method: 'POST', url: AUTH_ROUTE.url, remoteAddress, headers: { origin: SITE }, payload: {} });
  assert.equal((await post('198.51.100.20')).statusCode, 200);
  assert.equal((await post('198.51.100.20')).statusCode, 200);
  assert.equal((await post('198.51.100.20')).statusCode, 429, 'per client');
  assert.equal((await post('198.51.100.21')).statusCode, 200);
  assert.equal((await post('198.51.100.22')).statusCode, 429, 'overall');
  await app.close();
});

test('proxy: X-Forwarded-For is believed from the configured proxy only', async () => {
  const app = await hostedApp({ trustProxy: ['127.0.0.1'], limits: { read: { max: 1, windowMs: 60_000 } } });
  const via = (remoteAddress: string, xff: string) =>
    app.inject({ method: 'GET', url: '/api/vs/explore', remoteAddress, headers: { 'x-forwarded-for': xff } });
  const a = await via('127.0.0.1', '203.0.113.7');
  assert.equal(a.json().ip, '203.0.113.7', 'from the proxy: the forwarded client');
  assert.equal((await via('127.0.0.1', '203.0.113.8')).statusCode, 200, 'a second client behind the proxy has its own budget');
  assert.equal((await via('127.0.0.1', '203.0.113.7')).statusCode, 429);
  const direct = await via('198.51.100.50', '203.0.113.99');
  assert.equal(direct.json().ip, '198.51.100.50', 'from anyone else: the forged header is ignored');
  // A forger cannot escape its own budget by rotating the header.
  assert.equal((await via('198.51.100.50', '203.0.113.100')).statusCode, 429);
  await app.close();
});

test('proxy: a hop count takes the address the last proxy saw', async () => {
  const app = await hostedApp({ trustProxy: 1 });
  const r = await app.inject({
    method: 'GET', url: '/api/vs/explore', remoteAddress: '130.176.1.1',
    headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.33' },
  });
  // CloudFront appends the viewer it saw; whatever the viewer put in front is not believed.
  assert.equal(r.json().ip, '203.0.113.33');
  await app.close();
});

test('origin secret: every route but /api/health needs it', async () => {
  const secret = 's'.repeat(48);
  const app = await hostedApp({ originSecret: secret });
  assert.equal((await app.inject({ method: 'GET', url: '/api/vs/explore' })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/api/vs/explore', headers: { [ORIGIN_SECRET_HEADER]: 'nope' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/api/vs/explore', headers: { [ORIGIN_SECRET_HEADER]: secret } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).statusCode, 200);
  await app.close();
});

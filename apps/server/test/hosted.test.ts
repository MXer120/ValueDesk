/**
 * Hosted mode (VALUESCAN_HOSTED=1): the public, read-only index API.
 *
 * Covers the route allow-list, the custodial 410 (including the
 * percent-encoding bypass it used to have), CORS and the site-origin rule,
 * per-client rate limits and how the client address is derived behind a proxy,
 * the origin secret (one value, or two while it is rotated), the indexer
 * health a caller on the instance may read (and nobody else), and the
 * configuration parsing that feeds all of it.
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
  MAX_ORIGIN_SECRETS,
  ON_INSTANCE_ROUTES,
  ORIGIN_SECRET_HEADER,
  clientKey,
  fastifyTrustProxy,
  gatesFor,
  hostedConfigFromEnv,
  hostedRoute,
  indexerHealth,
  installHostedGate,
  installServerSigningGate,
  isLoopbackAddress,
  isLoopbackHost,
  isOnInstanceRequest,
  isServerSigningRequest,
  limitsFor,
  originSecretAccepted,
  originSecretDigests,
  parseOriginSecrets,
  parseTrustProxy,
  siteOriginsFrom,
  type HostedConfig,
  type HostedLimits,
  type HostedRoute,
} from '../src/hosted.js';

const SITE = 'https://app.valuedesk.example';
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
  assert.deepEqual(off.originSecrets, []);
  assert.deepEqual(off.limits, DEFAULT_LIMITS);
  assert.equal(hostedConfigFromEnv({ VALUESCAN_HOSTED: 'true' }).enabled, false, 'only "1" switches it on');
});

test('hosted config: defaults, overrides, and malformed values stop the boot', () => {
  const on = hostedConfigFromEnv({ VALUESCAN_HOSTED: '1' });
  assert.equal(on.enabled, true);
  assert.equal(on.trustProxy, false);
  assert.deepEqual(on.originSecrets, [], 'no secret configured: not enforced');
  assert.deepEqual(on.limits, DEFAULT_LIMITS);

  const tuned = hostedConfigFromEnv({
    VALUESCAN_HOSTED: '1',
    VALUESCAN_TRUST_PROXY: 'loopback, 10.0.0.0/8',
    VALUESCAN_ORIGIN_SECRET: 'x'.repeat(40),
    VALUESCAN_RATE_READ_PER_MIN: '900',
    VALUESCAN_RATE_UPSTREAM_PER_MIN: '60',
    VALUESCAN_RATE_AUTH_PER_MIN: '5',
    VALUESCAN_RATE_AUTH_GLOBAL_PER_MIN: '50',
    VALUESCAN_RATE_WRITE_PER_MIN: '30',
  });
  assert.deepEqual(tuned.trustProxy, ['loopback', '10.0.0.0/8']);
  assert.deepEqual(tuned.originSecrets, ['x'.repeat(40)]);
  assert.deepEqual(
    Object.fromEntries(Object.entries(tuned.limits).map(([k, l]) => [k, l.max])),
    { read: 900, upstream: 60, auth: 5, authGlobal: 50, write: 30 },
  );

  for (const bad of [
    { VALUESCAN_RATE_READ_PER_MIN: '0' },
    { VALUESCAN_RATE_UPSTREAM_PER_MIN: '-5' },
    { VALUESCAN_RATE_AUTH_PER_MIN: '1e3' },
    { VALUESCAN_RATE_WRITE_PER_MIN: '0' },
    { VALUESCAN_ORIGIN_SECRET: 'too-short' },
    { VALUESCAN_TRUST_PROXY: 'true' },
  ]) {
    assert.throws(() => hostedConfigFromEnv({ VALUESCAN_HOSTED: '1', ...bad }), Error, JSON.stringify(bad));
  }
});

test('origin secret config: one value, or the current and the next while it is rotated', () => {
  const cur = 'c'.repeat(40);
  const next = 'n'.repeat(64);
  assert.deepEqual(parseOriginSecrets(undefined), []);
  assert.deepEqual(parseOriginSecrets('   '), []);
  assert.deepEqual(parseOriginSecrets(cur), [cur]);
  assert.deepEqual(parseOriginSecrets(`${cur},${next}`), [cur, next]);
  assert.deepEqual(parseOriginSecrets(`  ${cur} , ${next}  `), [cur, next], 'spaces around the comma are not part of a value');
  assert.deepEqual(parseOriginSecrets(`${cur},${cur}`), [cur], 'the same value twice is one value');
  assert.deepEqual(hostedConfigFromEnv({ VALUESCAN_HOSTED: '1', VALUESCAN_ORIGIN_SECRET: `${cur},${next}` }).originSecrets, [cur, next]);

  const distinct = (n: number) => Array.from({ length: n }, (_, i) => String(i).repeat(32)).join(',');
  assert.equal(parseOriginSecrets(distinct(MAX_ORIGIN_SECRETS)).length, MAX_ORIGIN_SECRETS);

  // A typo never weakens the gate: each of these stops the boot instead.
  for (const bad of [
    ',', // would otherwise read as "no secret": everything open
    `${cur},`,
    `,${cur}`,
    `${cur},,${next}`,
    'short',
    `${cur},short`,
    `${cur},${'n'.repeat(31)}`,
    `${'a'.repeat(20)} ${'a'.repeat(20)}`, // a space inside a value
    `${cur}\t${next}`,
    'é'.repeat(40), // could not travel in a header
    distinct(MAX_ORIGIN_SECRETS + 1), // old values are removed, not collected
  ]) {
    assert.throws(() => parseOriginSecrets(bad), /VALUESCAN_ORIGIN_SECRET/, JSON.stringify(bad));
  }
  // The message reaches the log: it never quotes a value.
  try {
    parseOriginSecrets(`${cur},not-long-enough-0123456789`);
    assert.fail('a short value must be refused');
  } catch (e) {
    const msg = (e as Error).message;
    assert.ok(!msg.includes(cur) && !msg.includes('not-long-enough'), msg);
  }
});

test('origin secret compare: every accepted value is checked, and only an exact value passes', () => {
  const cur = 'c'.repeat(40);
  const next = 'n'.repeat(64);
  const both = originSecretDigests([cur, next]);
  assert.equal(originSecretAccepted(cur, both), true);
  assert.equal(originSecretAccepted(next, both), true, 'the last entry counts like the first');
  assert.equal(originSecretAccepted(next, originSecretDigests([next, cur])), true);
  for (const wrong of [undefined, null, '', 'nope', cur.slice(1), `${cur}x`, cur.toUpperCase(), `${cur},${next}`, `${cur}, ${next}`, [cur], 42]) {
    assert.equal(originSecretAccepted(wrong, both), false, JSON.stringify(wrong));
  }
  // No accepted value: nothing passes (the gate does not ask then; this is the floor).
  assert.equal(originSecretAccepted(cur, originSecretDigests([])), false);
  assert.equal(originSecretAccepted('', originSecretDigests([])), false);
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
  assert.deepEqual(siteOriginsFrom(['https://App.ValueDesk.Example', 'https://x.example:8443/']), ['https://app.valuedesk.example', 'https://x.example:8443']);
  for (const bad of ['app.valuedesk.example', 'https://app.example/path', 'javascript:alert(1)', 'https://u:p@app.example', 'https://app.example/?a=1']) {
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
  for (const r of [...HOSTED_ROUTES, ...ON_INSTANCE_ROUTES]) {
    const k = `${r.method} ${r.url}`;
    assert.ok(registered.has(k), `${k} is on a hosted list but no route file registers it`);
    assert.ok(!seen.has(k), `${k} is listed twice`);
    seen.add(k);
  }
});

test('the on-instance list is the indexer health and nothing else, and is not public', () => {
  assert.deepEqual(ON_INSTANCE_ROUTES.map((r) => `${r.method} ${r.url} ${r.cls}`), ['GET /api/vs/index/health read']);
  for (const r of ON_INSTANCE_ROUTES) {
    assert.equal(hostedRoute(r.method, r.url), null, `${r.url} must not be on the public list`);
    assert.ok(hostedRoute(r.method, r.url, ON_INSTANCE_ROUTES));
  }
  // The route hands out the projection, never the indexer's status itself.
  const src = readFileSync(join(SRC, 'routes', 'valuedesk.ts'), 'utf8');
  const handlers = [...src.matchAll(/app\.get\(\s*'\/api\/vs\/index\/health'\s*,([^\n]*)/g)].map((m) => m[1]!.trim());
  assert.deepEqual(handlers, ['async () => ({ ok: true, status: indexerHealth(indexerStatusJudged()) }));']);
});

test('the allow-list is exactly docs/ARCH-traffic.md section 5', () => {
  assert.deepEqual(
    HOSTED_ROUTES.map((r) => `${r.method} ${r.url} ${r.cls}`).sort(),
    [
      'GET /api/beta/me read',
      'GET /api/external/announcements read',
      'GET /api/external/announcements/:id upstream',
      'GET /api/external/maintenance/status read',
      'GET /api/feed/account upstream',
      'GET /api/health read',
      'GET /api/vs/activity/coverage read',
      'GET /api/vs/beta/listed read',
      'GET /api/vs/builder/beta read',
      'GET /api/vs/builder/terms read',
      'GET /api/vs/builder/volume read',
      'GET /api/vs/calendar read',
      'GET /api/vs/calendar/results read',
      'GET /api/vs/cohorts read',
      'GET /api/vs/cohorts/detail read',
      'GET /api/vs/cohorts/focus read',
      'GET /api/vs/cohorts/map read',
      'GET /api/vs/cohorts/wallets read',
      'GET /api/vs/etf/flows read',
      'GET /api/vs/excluded read',
      'GET /api/vs/explore read',
      'GET /api/vs/fed/live read',
      'GET /api/vs/fedwatch read',
      'GET /api/vs/fedwatch/history read',
      'GET /api/vs/feedback/image read',
      'GET /api/vs/flow read',
      'GET /api/vs/flow/wallet read',
      'GET /api/vs/indicator read',
      'GET /api/vs/indicators read',
      'GET /api/vs/last-trades read',
      'GET /api/vs/lbrow read',
      'GET /api/vs/leaderboard read',
      'GET /api/vs/liquidations read',
      'GET /api/vs/liquidations/at read',
      'GET /api/vs/liquidations/history read',
      'GET /api/vs/liquidations/positions read',
      'GET /api/vs/liquidations/tiles read',
      'GET /api/vs/liquidations/wallets read',
      'GET /api/vs/live upstream',
      'GET /api/vs/logo upstream',
      'GET /api/vs/news read',
      'GET /api/vs/news/sources read',
      'GET /api/vs/oracle upstream',
      'GET /api/vs/positioning read',
      'GET /api/vs/profile read',
      'GET /api/vs/screener read',
      'GET /api/vs/sodex/lottery/feed read',
      'GET /api/vs/sodex/lottery/meta read',
      'GET /api/vs/sodex/oi-excluded read',
      'GET /api/vs/sodex/wealth/maintenance read',
      'GET /api/vs/status read',
      'GET /api/vs/status/feed read',
      'GET /api/vs/username/check read',
    'GET /api/vs/wallet-history read',
      'GET /api/vs/wallet/fills read',
      'GET /api/vs/whales read',
      'GET /ws/liq read',
      'POST /api/admin/analytics admin',
      'POST /api/admin/audit admin',
      'POST /api/admin/beta admin',
      'POST /api/admin/beta/add admin',
      'POST /api/admin/beta/remove admin',
      'POST /api/admin/board admin',
      'POST /api/admin/board/add admin',
      'POST /api/admin/board/move admin',
      'POST /api/admin/builder admin',
      'POST /api/admin/me admin',
      'POST /api/admin/page-error admin',
      'POST /api/admin/session admin',
      'POST /api/admin/sessions/revoke admin',
      'POST /api/admin/signout admin',
      'POST /api/admin/status admin',
      'POST /api/admin/ticket admin',
      'POST /api/admin/ticket/image admin',
      'POST /api/admin/ticket/reply admin',
      'POST /api/admin/ticket/status admin',
      'POST /api/admin/tickets admin',
      'POST /api/admin/users admin',
      'POST /api/beta/session auth',
      'POST /api/vs/a write',
      'POST /api/vs/client-errors write',
      'POST /api/vs/feedback write',
      'POST /api/vs/feedback/poll write',
      'POST /api/vs/feedback/session auth',
      'POST /api/vs/feedback/thread write',
      'POST /api/vs/feedback/unread write',
      'POST /api/vs/feedback/upload write',
      'POST /api/vs/inbox/add write',
      'POST /api/vs/inbox/list write',
      'POST /api/vs/username write',
      'POST /api/vs/username/change write',
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
    /^\/api\/vs\/index\//, /^\/ws$/,
  ];
  for (const r of HOSTED_ROUTES) {
    for (const re of forbidden) assert.ok(!re.test(r.url), `${r.method} ${r.url} must not be public`);
    // The index is read-only; the one thing a visitor sends is feedback and error reports to the owner (routes/reports.ts),
    // and a signed-in wallet keeps its own algos' and copies' notices in its inbox (ops/inbox.ts).
    if (r.url === '/api/vs/feedback/image') assert.ok(r.method === 'GET' && r.cls === 'read', r.url);
    else if (r.url === '/api/vs/feedback/session') assert.ok(r.method === 'POST' && r.cls === 'auth', r.url);
    else if (r.url.startsWith('/api/vs/feedback') || r.url.startsWith('/api/vs/inbox/') || r.url === '/api/vs/client-errors' || r.url === '/api/vs/a' || r.url === '/api/vs/username' || r.url === '/api/vs/username/change') assert.ok(r.method === 'POST' && r.cls === 'write', r.url);
    // The owner's admin suite (routes/admin.ts): POST only, its own class (the suite's Origin, its own limits).
    else if (r.url.startsWith('/api/admin/')) assert.ok(r.method === 'POST' && r.cls === 'admin', r.url);
    // The beta channel's sign-in (routes/beta.ts, beta API only): a wallet's free signature, cls auth.
    else if (r.url === '/api/beta/session') assert.ok(r.method === 'POST' && r.cls === 'auth', r.url);
    else assert.equal(r.method, 'GET', `${r.method} ${r.url}: hosted mode is read-only`);
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
  assert.deepEqual(limitsFor(AUTH_ROUTE, {}, DEFAULT_LIMITS, 'c').map((l) => l.key), ['auth|c', 'auth|*|/api/points/auth/nonce']);
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

/**
 * What the indexer publishes (indexer/engine.ts status(), plus `at` and `pid`
 * from its worker), with the kind of content that must never leave a hosted
 * server: wallet addresses, error text, a path, a pid.
 */
const WALLET = '0x' + '1'.repeat(40);
const INDEXER_STATUS = {
  streams: { sodex: 1_790_000_000_000, hyperliquid: 1_790_000_000_001, tradexyz: null, lighter: null, arcus: 1_790_000_000_003 },
  sockets: { sodex: 1_790_000_000_000, hyperliquid: 1_790_000_000_001, tradexyz: 1_790_000_000_002, lighter: null, arcus: 1_790_000_000_003 },
  gaps: { sodex: [{ from: 1, to: 2, broke: true }] },
  aggregates: 12,
  retention: { file: '/var/lib/valuescan/index/valuescan-index.db' },
  lanes: {
    hl: {
      queued: 3, done: 1200, failed: 2, spent: 4400, lastError: `HTTP 429 reading fills of ${WALLET}`,
      current: { key: `h:perps:${WALLET}`, forMs: 812 }, byKind: { fills: 3 }, visible: { fills: 1 }, backoffMs: 1500.4,
    },
    sgw: { queued: 0, done: 10, failed: 0, spent: 20, lastError: null, current: null, byKind: {}, visible: {}, backoffMs: 0 },
    strades: { queued: 41, done: 7, failed: 1, spent: 8, lastError: 'error code: 1015', current: null, byKind: {}, visible: {}, backoffMs: 30_000 },
    sdata: { queued: 0, done: 0, failed: 0, spent: 0, lastError: null, current: null, byKind: {}, visible: {}, backoffMs: 0 },
  },
  venues: { lighter: { walk: WALLET, lastError: 'socket hang up' } },
  tracked: { hyperliquid: 5000, sodex: 800 },
  lastBuildAt: 1_790_000_000_500,
  lastBuildMs: 431.7,
  lastError: 'flush: database is locked (/var/lib/valuescan/index/valuescan-index.db)',
  loopLagMs: { lastMinute: 12.6, sinceStart: 340, spikes: [{ late: 340, at: 1, by: `rebuild after ${WALLET}` }] },
  hlBudget: 870,
  cohorts: {
    lastError: `cohort flush: ${WALLET}`,
    liq: {
      boost: false, live: { ready: true, pending: 12, ms: 40, error: `liq feed: ${WALLET}` }, nowAt: 1_790_000_000_900, since: 1_789_999_000_000,
      // The open interest check (checkOi): per venue the worst ratio, with coins and sizes that stay inside.
      oi: { at: 1, queued: 3, venues: { lighter: { worst: 2.0544, over: 3, coins: [{ coin: 'SOL', ratio: 2.0544, long: 177_098, short: 326_713, oi: 159_030 }] }, hyperliquid: { worst: 1.0062, over: 0, coins: [] } } },
    },
  },
  at: 1_790_000_001_000,
  pid: 4242,
};

async function hostedApp(o: { limits?: Partial<HostedLimits>; trustProxy?: HostedConfig['trustProxy']; originSecrets?: string[]; extra?: HostedRoute[] } = {}) {
  const cfg: HostedConfig = {
    enabled: true,
    trustProxy: o.trustProxy ?? false,
    originSecrets: o.originSecrets ?? [],
    limits: { ...DEFAULT_LIMITS, ...o.limits },
  };
  const routes = [...HOSTED_ROUTES, ...(o.extra ?? [])];
  const app = Fastify({ trustProxy: fastifyTrustProxy(cfg.trustProxy) });
  await app.register(cors, { origin: [SITE], methods: ['GET', 'POST', 'OPTIONS'] });
  installServerSigningGate(app);
  for (const r of routes) {
    app.route({ method: r.method, url: r.url, handler: async (req) => ({ ok: true, route: req.routeOptions.url, ip: req.ip }) });
  }
  // As routes/valuedesk.ts registers it: the projection of the indexer's status.
  app.get('/api/vs/index/health', async () => ({ ok: true, status: indexerHealth(INDEXER_STATUS) }));
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
  const app = await hostedApp({ originSecrets: [secret] });
  assert.equal((await app.inject({ method: 'GET', url: '/api/vs/explore' })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/api/vs/explore', headers: { [ORIGIN_SECRET_HEADER]: 'nope' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/api/vs/explore', headers: { [ORIGIN_SECRET_HEADER]: secret } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).statusCode, 200);
  // A path that does not exist says nothing either way without the secret.
  assert.equal((await app.inject({ method: 'GET', url: '/nope' })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/nope', headers: { [ORIGIN_SECRET_HEADER]: secret } })).statusCode, 404);
  await app.close();
});

test('origin secret rotation: the server accepts the current and the next value, so no step answers 403', async () => {
  const cur = 'c'.repeat(48);
  const next = 'n'.repeat(64);
  /** What an edge sending `sent` gets while the server is configured with `accepted`. */
  const status = async (accepted: string[], sent: string | undefined) => {
    const app = await hostedApp({ originSecrets: accepted });
    const r = await app.inject({
      method: 'GET', url: '/api/vs/explore', remoteAddress: '130.176.1.1',
      headers: sent === undefined ? {} : { [ORIGIN_SECRET_HEADER]: sent },
    });
    await app.close();
    return r.statusCode;
  };
  // Before: one value.
  assert.equal(await status([cur], cur), 200);
  assert.equal(await status([cur], next), 403);
  // 1. The server learns the next value. The edge still sends the current one.
  assert.equal(await status([cur, next], cur), 200);
  // 2. The edge switches, location by location: both values arrive for a while.
  assert.equal(await status([cur, next], next), 200);
  assert.equal(await status([next, cur], next), 200, 'the order of the list does not matter');
  // 3. The old value is removed: it is dead from then on.
  assert.equal(await status([next], next), 200);
  assert.equal(await status([next], cur), 403);
  // Throughout: exactly one value, never the list, never nothing.
  for (const sent of [undefined, '', `${cur},${next}`, `${cur}, ${next}`, cur.slice(1), `${next}x`]) {
    assert.equal(await status([cur, next], sent), 403, JSON.stringify(sent));
  }
});

// --- a caller on this instance -------------------------------------------------------------

test('on-instance: a loopback peer, a loopback Host, and nothing a proxy adds', () => {
  for (const a of ['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1', '0:0:0:0:0:0:0:1']) assert.equal(isLoopbackAddress(a), true, a);
  for (const a of [undefined, '', '10.0.0.1', '203.0.113.7', '128.0.0.1', '1270.0.0.1', '::', '::2', '::ffff:10.0.0.1', 'localhost', '127.0.0.1.evil.example']) {
    assert.equal(isLoopbackAddress(a), false, String(a));
  }
  for (const h of ['127.0.0.1', '127.0.0.1:8797', 'localhost', 'LOCALHOST:8797', '[::1]', '[::1]:8797']) assert.equal(isLoopbackHost(h), true, h);
  for (const h of [undefined, '', 'origin.valuedesk.example', 'origin.valuedesk.example:443', '127.0.0.1.evil.example', 'localhost.evil.example', 'localhost.', '10.0.0.5:8797', '[::2]', '127.0.0.1:8797/x', 'a b', ['127.0.0.1']]) {
    assert.equal(isLoopbackHost(h), false, JSON.stringify(h));
  }

  const local = { host: '127.0.0.1:8797', accept: 'application/json', 'user-agent': 'curl/8' };
  assert.equal(isOnInstanceRequest('127.0.0.1', local), true);
  assert.equal(isOnInstanceRequest('::1', { host: 'localhost:8797' }), true);
  // Not from this machine.
  assert.equal(isOnInstanceRequest('203.0.113.7', local), false);
  assert.equal(isOnInstanceRequest(undefined, local), false);
  // From the proxy on this machine: every marker counts by itself.
  for (const marker of [
    { 'x-forwarded-for': '203.0.113.7' }, { 'x-forwarded-proto': 'https' }, { 'x-forwarded-host': 'x' }, { 'x-forwarded-anything': '1' },
    { forwarded: 'for=203.0.113.7' }, { via: '2.0 abc.cloudfront.net (CloudFront)' }, { 'x-real-ip': '203.0.113.7' },
    { 'x-amz-cf-id': 'abc' }, { 'cloudfront-viewer-address': '203.0.113.7:4711' }, { 'true-client-ip': '203.0.113.7' }, { 'cdn-loop': 'x' },
    { 'X-Forwarded-For': '203.0.113.7' },
  ]) {
    assert.equal(isOnInstanceRequest('127.0.0.1', { ...local, ...marker }), false, JSON.stringify(marker));
  }
  // An empty marker is still a marker.
  assert.equal(isOnInstanceRequest('127.0.0.1', { ...local, 'x-forwarded-for': '' }), false);
  // The public name, or no Host at all.
  assert.equal(isOnInstanceRequest('127.0.0.1', { host: 'origin.valuedesk.example' }), false);
  assert.equal(isOnInstanceRequest('127.0.0.1', {}), false);
});

test('index health: answered to a caller on the instance, a 404 for everyone else', async () => {
  // Production: Caddy on loopback, CloudFront in front of it (VALUESCAN_TRUST_PROXY=2).
  const app = await hostedApp({ trustProxy: 2 });
  const get = (o: { remoteAddress?: string; headers?: Record<string, string>; method?: 'GET' | 'HEAD' | 'POST' } = {}) =>
    app.inject({ method: o.method ?? 'GET', url: '/api/vs/index/health', remoteAddress: o.remoteAddress, headers: o.headers ?? { host: '127.0.0.1:8797' } });

  // The health check, or an operator's curl, on the box.
  const local = await get();
  assert.equal(local.statusCode, 200);
  assert.equal(local.json().ok, true);
  assert.deepEqual(Object.keys(local.json().status).sort(), ['at', 'errorSinceStart', 'lanes', 'lastBuildAt', 'lastBuildMs', 'liq', 'loopLagMs', 'streams']);
  assert.equal((await get({ method: 'HEAD' })).statusCode, 200);
  assert.equal((await get({ headers: { host: 'localhost:8797' } })).statusCode, 200);

  // What Caddy forwards from CloudFront: the same loopback peer, but marked and under the public name.
  const proxied: Record<string, string> = {
    host: 'origin.valuedesk.example', 'x-forwarded-for': '203.0.113.7, 130.176.1.1', 'x-forwarded-proto': 'https',
    'x-forwarded-host': 'origin.valuedesk.example', via: '2.0 abc.cloudfront.net (CloudFront)', 'x-amz-cf-id': 'abc',
  };
  const notLocal: Array<Record<string, string>> = [
    proxied,
    { host: '127.0.0.1:8797', 'x-forwarded-for': '203.0.113.7' }, // one marker is enough, whatever the Host claims
    { host: '127.0.0.1:8797', via: '1.1 Caddy' },
    { host: 'origin.valuedesk.example' }, // no marker, but not a loopback name
  ];
  for (const headers of notLocal) {
    const r = await get({ headers });
    assert.equal(r.statusCode, 404, JSON.stringify(headers));
    assert.deepEqual(r.json(), { error: 'not found', source: 'server' }, 'the same answer as a path that does not exist');
  }
  // Not from this machine - and the forwarded address does not make it so: with two
  // trusted hops req.ip would be the 127.0.0.1 the caller wrote, the socket is not.
  assert.equal((await get({ remoteAddress: '203.0.113.7' })).statusCode, 404);
  assert.equal((await get({ remoteAddress: '203.0.113.7', headers: { host: '127.0.0.1:8797', 'x-forwarded-for': '127.0.0.1' } })).statusCode, 404);
  // Read-only, like everything else.
  assert.equal((await get({ method: 'POST' })).statusCode, 404);
  // The full diagnostics stay a 404 for every caller, on the instance too.
  const full = await app.inject({ method: 'GET', url: '/api/vs/index/status', headers: { host: '127.0.0.1:8797' } });
  assert.equal(full.statusCode, 404);
  assert.ok(!full.body.includes('leaked'));
  await app.close();
});

test('index health: needs no origin secret on the instance, and the secret does not open it from outside', async () => {
  const secret = 's'.repeat(48);
  const app = await hostedApp({ trustProxy: 2, originSecrets: [secret] });
  const local = { host: '127.0.0.1:8797' };
  const proxied = { host: 'origin.valuedesk.example', 'x-forwarded-for': '203.0.113.7, 130.176.1.1', via: '2.0 abc.cloudfront.net (CloudFront)' };
  const get = (url: string, headers: Record<string, string>) => app.inject({ method: 'GET', url, headers });

  // A monitor on the box is not handed the credential that gets past the edge.
  assert.equal((await get('/api/vs/index/health', local)).statusCode, 200);
  assert.equal((await get('/api/vs/index/health', { ...local, [ORIGIN_SECRET_HEADER]: secret })).statusCode, 200);
  // Through the proxy: refused without the secret, not found with it - what any unknown path gets.
  assert.equal((await get('/api/vs/index/health', proxied)).statusCode, 403);
  assert.equal((await get('/api/vs/index/health', { ...proxied, [ORIGIN_SECRET_HEADER]: secret })).statusCode, 404);
  // Being on the instance opens nothing else: public routes still need the secret there,
  assert.equal((await get('/api/vs/explore', local)).statusCode, 403);
  assert.equal((await get('/api/vs/explore', { ...local, [ORIGIN_SECRET_HEADER]: secret })).statusCode, 200);
  // and the full diagnostics answer what operations' lock-down check expects: 404 with the secret (403 without).
  assert.equal((await get('/api/vs/index/status', { ...local, [ORIGIN_SECRET_HEADER]: secret })).statusCode, 404);
  assert.equal((await get('/api/vs/index/status', local)).statusCode, 403);
  await app.close();
});

test('index health: counted against the read limit like any request', async () => {
  const app = await hostedApp({ limits: { read: { max: 2, windowMs: 60_000 } } });
  const get = () => app.inject({ method: 'GET', url: '/api/vs/index/health', headers: { host: '127.0.0.1:8797' } });
  assert.equal((await get()).statusCode, 200);
  assert.equal((await get()).statusCode, 200);
  const over = await get();
  assert.equal(over.statusCode, 429);
  assert.ok(Number(over.headers['retry-after']) >= 1);
  await app.close();
});

/** Every key and every leaf of a value, for "nothing but numbers and booleans". */
function leaves(v: unknown, path = ''): Array<{ path: string; value: unknown }> {
  if (v !== null && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => leaves(x, path ? `${path}.${k}` : k));
  return [{ path, value: v }];
}

test('index health: numbers and booleans picked by name - no address, error text, path or pid', () => {
  const h = indexerHealth(INDEXER_STATUS);
  assert.deepEqual(h, {
    at: 1_790_000_001_000,
    streams: { sodex: true, hyperliquid: true, tradexyz: true, lighter: false, arcus: true },
    loopLagMs: { lastMinute: 13, sinceStart: 340 },
    lanes: {
      hl: { queued: 3, done: 1200, failed: 2, backoffMs: 1500 },
      sgw: { queued: 0, done: 10, failed: 0, backoffMs: 0 },
      strades: { queued: 41, done: 7, failed: 1, backoffMs: 30_000 },
      sdata: { queued: 0, done: 0, failed: 0, backoffMs: 0 },
    },
    lastBuildAt: 1_790_000_000_500,
    lastBuildMs: 432,
    errorSinceStart: true,
    liq: { ready: true, pending: 12, nowAt: 1_790_000_000_900, since: 1_789_999_000_000, oiPct: { lighter: 205, hyperliquid: 101 } },
  });
  const sent = JSON.stringify(h);
  for (const secret of ['0x', WALLET, '4242', 'pid', 'valuescan-index', '/var/lib', '429', '1015', 'locked', 'hang up', 'rebuild', 'spent', 'hlBudget', '870', 'tracked', '5000']) {
    assert.ok(!sent.includes(secret), `"${secret}" must not be in the health body`);
  }

  // An older indexer published `streams` only; no error yet; nothing built yet.
  const early = indexerHealth({ streams: { sodex: 5, lighter: null }, lanes: {}, lastBuildAt: 0, lastBuildMs: 0, lastError: null, at: 7 });
  assert.deepEqual(early, {
    at: 7, streams: { sodex: true, lighter: false }, loopLagMs: { lastMinute: null, sinceStart: null }, lanes: {},
    lastBuildAt: null, lastBuildMs: 0, errorSinceStart: false, liq: null,
  });

  // No status to read.
  for (const none of [null, undefined, '', 'x', 0, 42, true, [], [INDEXER_STATUS]]) assert.equal(indexerHealth(none), null, JSON.stringify(none));
});

test('index health: whatever the status holds, only a name, a number or a boolean gets out', () => {
  const hostile = {
    at: '2026-10-02T00:00:00Z',
    pid: 4242,
    sockets: {
      sodex: `up since ${WALLET}`, // truthy text: reported as "up", the text is not
      [WALLET]: 1, // a key that is an address
      ['a'.repeat(40)]: 1, // 40 hex-looking characters without the 0x
      '../../etc/passwd': 1,
      'C:\\Users\\someone': 1,
      Hyperliquid: 1, // not a name as the indexer writes one
      __proto__x: 1,
      lighter: { nested: WALLET },
      arcus: 0,
    },
    lanes: {
      hl: { queued: WALLET, done: { n: 1 }, failed: [2], backoffMs: Number.NaN, lastError: WALLET, current: { key: WALLET } },
      sgw: 'not an object',
      [WALLET]: { queued: 1, done: 1, failed: 1, backoffMs: 1 },
      strades: { queued: -4, done: 1e12, failed: 2.6, backoffMs: Number.POSITIVE_INFINITY },
    },
    loopLagMs: { lastMinute: WALLET, sinceStart: -5, spikes: [{ by: WALLET }] },
    lastBuildAt: WALLET,
    lastBuildMs: { ms: 1 },
    lastError: { message: WALLET },
    cohorts: { liq: { live: { ready: 'yes', pending: WALLET }, nowAt: WALLET, since: -5 } },
  };
  const h = indexerHealth(hostile)!;
  assert.deepEqual(h, {
    at: null,
    streams: { sodex: true, lighter: true, arcus: false },
    loopLagMs: { lastMinute: null, sinceStart: 0 },
    lanes: {
      hl: { queued: null, done: null, failed: null, backoffMs: null },
      sgw: { queued: null, done: null, failed: null, backoffMs: null },
      strades: { queued: 0, done: 1e12, failed: 3, backoffMs: null },
    },
    lastBuildAt: null,
    lastBuildMs: null,
    errorSinceStart: true,
    liq: { ready: false, pending: null, nowAt: null, since: null },
  });
  for (const { path, value } of leaves(h)) {
    assert.ok(value === null || typeof value === 'number' || typeof value === 'boolean', `${path} is ${typeof value}`);
    for (const key of path.split('.')) assert.match(key, /^[a-zA-Z][a-zA-Z0-9_]{0,23}$/, path);
  }
  assert.ok(!JSON.stringify(h).includes('0x'));

  // A status that grew a thousand "venues" and "lanes" does not grow the answer.
  const many = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`v${i}`, 1]));
  const capped = indexerHealth({ sockets: many, lanes: Object.fromEntries(Object.keys(many).map((k) => [k, { queued: 1 }])) })!;
  assert.equal(Object.keys(capped.streams).length, 16);
  assert.equal(Object.keys(capped.lanes).length, 16);
});

test('gate: what a visitor sends needs the site Origin and is counted as a write', async () => {
  const app = await hostedApp({ limits: { write: { max: 2, windowMs: 60_000 } } });
  const post = (headers: Record<string, string>) => app.inject({ method: 'POST', url: '/api/vs/feedback', headers, payload: {} });
  assert.equal((await post({})).statusCode, 403, 'no Origin');
  assert.equal((await post({ origin: 'https://evil.example' })).statusCode, 403);
  assert.equal((await post({ origin: SITE })).statusCode, 200);
  assert.equal((await post({ origin: SITE })).statusCode, 200);
  assert.equal((await post({ origin: SITE })).statusCode, 429, 'the write budget is per client');
  assert.equal((await app.inject({ method: 'GET', url: '/api/vs/leaderboard' })).statusCode, 200, 'reading is not a write');
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/vs/feedback' })).statusCode, 404);
});

test('gates: a hosted server never also runs the loopback gate, beta or not (dev.valuedesk.so "origin not allowed", 2026-11-02)', () => {
  assert.deepEqual(gatesFor({ hosted: true, beta: false }), { hosted: true, beta: false, loopback: false });
  assert.deepEqual(gatesFor({ hosted: true, beta: true }), { hosted: true, beta: true, loopback: false });
  assert.deepEqual(gatesFor({ hosted: false, beta: false }), { hosted: false, beta: false, loopback: true });
  assert.deepEqual(gatesFor({ hosted: false, beta: true }), { hosted: false, beta: true, loopback: false });
  // index.ts installs each gate only on its own flag: no if/else chain a new gate can split (d7f9ac9 did).
  const src = readFileSync(join(SRC, 'index.ts'), 'utf8');
  assert.match(src, /if \(GATES\.hosted\) installHostedGate\(/);
  assert.match(src, /if \(GATES\.loopback\) app\.addHook\('onRequest'/);
  assert.doesNotMatch(src, /\n\s*else app\.addHook\('onRequest'/, 'the loopback gate hangs off an else');
});

test("gates: on a hosted server the admin suite's origin passes an admin POST and the site's does not", async () => {
  const app = Fastify();
  const cfg = { enabled: true, trustProxy: false as const, originSecrets: [] as string[], limits: DEFAULT_LIMITS };
  installHostedGate(app, { cfg, site: ['https://valuedesk.so'], admin: ['https://dev.valuedesk.so'] });
  app.post('/api/admin/session', async () => ({ ok: true }));
  await app.ready();
  const post = (origin: string) => app.inject({ method: 'POST', url: '/api/admin/session', payload: '{}', headers: { 'content-type': 'application/json', origin } });
  assert.equal((await post('https://dev.valuedesk.so')).statusCode, 200);
  assert.equal((await post('https://valuedesk.so')).statusCode, 403);
  await app.close();
});

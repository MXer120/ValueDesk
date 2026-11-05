// node --test deploy/vercel/vercel.test.mjs
//
// The Vercel deployment: its routes give every path the headers of
// deploy/smoke/prod-headers.mjs (the table deploy/aws/edge.yaml is validated
// against), and the /api function forwards as the edge must. Everything on loopback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { ADMIN_CSP, adminHeadersFor, headersFor, rewrite } from '../smoke/prod-headers.mjs';
import { LEGAL_PATHS, SANCTIONED_CODES, SANCTIONED_REGIONS, edgeBlockList } from '../../apps/web/src/legal/jurisdictions.mjs';
import {
  ADMIN_HOST, FUNCTION_PATH, GEO_API_HEADERS, GEO_PAGE_HEADERS, HEADER_CLASSES, checkDist, config, functionConfig, geoRoutes, packageSite, routes,
} from './package.mjs';

const require = createRequire(import.meta.url);
const proxy = require('./api-proxy.cjs');

// --- the routes ---------------------------------------------------------------------------

/** A `has` value (Build Output API MatchableValue, as these routes use it: eq or inc). */
function matches(value, want) {
  if (value === undefined) return false;
  if (want === undefined) return true;
  if (typeof want === 'string') return new RegExp(want).test(value);
  if (want.eq !== undefined) return value === String(want.eq);
  if (want.inc) return want.inc.includes(value);
  throw new Error(`a has value this simulation does not know: ${JSON.stringify(want)}`);
}

/**
 * Vercel's routing for these routes, as far as they use it: in order, a match with
 * `continue` adds its headers and goes on, a match without it ends the phase with its
 * `dest` (and its `status`); then the filesystem; then the routes after `handle:
 * filesystem`. A route with `has` matches only when every condition holds for the
 * request's headers (lower-case names, as Vercel's edge sets them).
 */
function route(path, staticFiles, requestHeaders = {}) {
  const headers = {};
  const matchedHeaderRoutes = [];
  let phase = 'start';
  let dest = null;
  for (const r of routes()) {
    if (r.handle) {
      if (r.handle === 'filesystem') {
        if (dest) break;
        if (staticFiles.has(path)) return { headers, matchedHeaderRoutes, served: path };
        if (path.endsWith('/') && staticFiles.has(`${path}index.html`)) return { headers, matchedHeaderRoutes, served: `${path}index.html` };
        // Seen live (2026-10-03): Vercel also serves a directory's index.html for the
        // path WITHOUT the slash (/scan -> scan/index.html), with no redirect.
        if (!path.endsWith('/') && staticFiles.has(`${path}/index.html`)) return { headers, matchedHeaderRoutes, served: `${path}/index.html` };
        phase = 'miss';
      }
      continue;
    }
    const re = new RegExp(r.src, r.caseSensitive ? '' : 'i');
    if (!re.test(path)) continue;
    // `host` is the domain asked for (Vercel matches it on the Host header).
    const holds = (h) => (h.type === 'host' ? requestHeaders.host === h.value : h.type === 'header' && matches(requestHeaders[h.key], h.value));
    if (r.has && !r.has.every(holds)) continue;
    if (r.missing && r.missing.some(holds)) continue;
    if (r.continue) {
      if (phase !== 'start') continue;
      Object.assign(headers, r.headers);
      matchedHeaderRoutes.push(r.src);
      continue;
    }
    dest = r.dest;
    if (r.headers) Object.assign(headers, r.headers);
    const status = r.status;
    if (phase === 'start') {
      if (dest === FUNCTION_PATH) return { headers, matchedHeaderRoutes, fn: true };
      return { headers, matchedHeaderRoutes, served: dest, status };
    }
    return { headers, matchedHeaderRoutes, served: dest, status };
  }
  return { headers, matchedHeaderRoutes, served: dest, notFound: !dest };
}

const STATIC = new Set(['/index.html', '/favicon.svg', '/favicon.ico', '/robots.txt', '/third-party-licenses.txt','/assets/index-abc.js', '/assets/index-abc.css',
  '/assets/sw-worker-1.js', '/logos/btc.svg', '/addrbook/a.png', '/scan/index.html', '/scan/legacy.js']);

const PATHS = [
  '/', '/trade', '/explore', '/scan', '/scan/', '/scan/x', '/scan/index.html', '/scan/legacy.js', '/index.html',
  '/favicon.svg', '/robots.txt', '/assets/index-abc.js', '/assets/index-abc.css', '/assets/sw-worker-1.js',
  '/assets/missing.js', '/assets/', '/assets/noext', '/logos/btc.svg', '/logos/', '/logos/x', '/logos/x.html',
  '/addrbook/a.png', '/a.b/c', '/deep/path/route', '/deep/file.txt', '/page.html', '/apix', '/api', '/LOGOS/btc.svg',
  '/Assets/x.js', '/scanner', '/scan.html', '/favicon.ico', '/impressum', '/privacy', '/third-party-licenses.txt',
];

test('every path gets exactly the headers of prod-headers.mjs, from exactly one route', () => {
  for (const path of PATHS) {
    const r = route(path, STATIC);
    assert.equal(r.matchedHeaderRoutes.length, 1, `${path}: ${r.matchedHeaderRoutes.length} header routes matched (${r.matchedHeaderRoutes.join(' | ')})`);
    assert.deepEqual(r.headers, headersFor(path), path);
  }
});

test('/api/* goes to the function and nowhere else, without the site headers', () => {
  for (const path of ['/api/health', '/api/vs/leaderboard', '/api/vs/cohorts/map', '/api/__vs_proxy', '/api/x.js', '/api/copy/v1/session', '/api/copy/v1/copies/abc/activity']) {
    const r = route(path, STATIC);
    assert.equal(r.fn, true, path);
    assert.deepEqual(r.headers, {}, `${path}: the API keeps its own headers`);
  }
  assert.notEqual(route('/api', STATIC).fn, true, '/api without a slash is an app route, as on CloudFront');
});

test('app routes get the shell, /scan/ the legacy page, files themselves, a missing file a 404', () => {
  for (const path of PATHS) {
    const r = route(path, STATIC);
    if (r.fn) continue;
    const want = rewrite(path);
    if (STATIC.has(path)) assert.equal(r.served, path, path);
    else if (want !== path) assert.equal(r.served, want, `${path} -> ${want}`);
    else assert.ok(r.notFound, `${path}: a missing file must not be answered with the shell (got ${r.served})`);
  }
});

// --- the sanctioned places (apps/web/src/legal/jurisdictions.mjs) --------------------------------

const FROM = (country, region) => ({ 'x-vercel-ip-country': country, ...(region ? { 'x-vercel-ip-country-region': region } : {}) });
const LEGAL = LEGAL_PATHS.map((p) => `/${p}`);
const GEO_STATIC = new Set([...STATIC, '/restricted.html', '/restricted.json']);

test('a visitor from a sanctioned country gets 451 for every page and API path, never cached', () => {
  for (const code of SANCTIONED_CODES) {
    for (const path of PATHS.filter((p) => !LEGAL.includes(p) && !p.startsWith('/assets/') && !/^\/favicon\.|^\/robots\.txt$|^\/third-party-licenses\.txt$/.test(p))) {
      const r = route(path, GEO_STATIC, FROM(code));
      assert.equal(r.status, 451, `${code} ${path}`);
      assert.equal(r.served, '/restricted.html', `${code} ${path}`);
      assert.deepEqual(r.headers, GEO_PAGE_HEADERS, `${code} ${path}: the site's security headers, no-store, from the geo route alone`);
      assert.equal(r.headers['Cache-Control'], 'no-store');
    }
    for (const path of ['/api/vs/leaderboard', '/api/copy/v1/session', '/api/health', '/api/__vs_proxy']) {
      const r = route(path, GEO_STATIC, FROM(code));
      assert.equal(r.status, 451, `${code} ${path}`);
      assert.equal(r.served, '/restricted.json', `${code} ${path}: the function is never reached`);
      assert.deepEqual(r.headers, GEO_API_HEADERS);
    }
  }
});

test('from a sanctioned place, the legal pages, the files they load and the geo answer stay reachable', () => {
  for (const path of [...LEGAL, '/assets/index-abc.js', '/assets/index-abc.css', '/favicon.svg', '/favicon.ico', '/robots.txt', '/third-party-licenses.txt', '/restricted.html']) {
    const r = route(path, GEO_STATIC, FROM('IR'));
    assert.equal(r.status, undefined, path);
    assert.deepEqual(r.headers, headersFor(path), `${path}: its normal headers`);
  }
  assert.equal(route('/impressum', GEO_STATIC, FROM('KP')).served, '/index.html', 'the legal pages are app routes: the shell');
  assert.equal(route('/api/edge/geo', GEO_STATIC, FROM('CU')).fn, true, 'the function answers where the visitor is');
  // Exact paths only: a page under a legal path, or a near-miss, is blocked.
  for (const path of ['/impressum/x', '/termsx', '/Impressum', '/api/edge/geox', '/api/edge/geo/']) {
    assert.equal(route(path, GEO_STATIC, FROM('RU')).status, 451, path);
  }
});

test('the sanctioned regions of Ukraine are blocked by region; the rest of Ukraine is not', () => {
  for (const { region } of SANCTIONED_REGIONS) {
    assert.equal(route('/trade', GEO_STATIC, FROM('UA', region)).status, 451, `UA-${region}`);
    assert.equal(route('/api/vs/leaderboard', GEO_STATIC, FROM('UA', region)).served, '/restricted.json', `UA-${region}`);
  }
  for (const [c, r] of [['UA', '30'], ['UA', '46'], ['UA', undefined], ['RO', '43'], ['DE', 'BY']]) {
    const res = route('/trade', GEO_STATIC, FROM(c, r));
    assert.equal(res.status, undefined, `${c}-${r}`);
    assert.equal(res.served, '/index.html');
  }
});

test('everyone else, and a request without a country, is served as before', () => {
  for (const headers of [{}, FROM('DE'), FROM('US'), FROM('SG'), FROM('XX'), FROM('ir')]) {
    for (const path of PATHS) {
      const r = route(path, GEO_STATIC, headers);
      assert.equal(r.status, undefined, `${JSON.stringify(headers)} ${path}`);
      if (!r.fn) assert.deepEqual(r.headers, headersFor(path), path);
    }
  }
});

test('the geo routes come first and carry the lists of jurisdictions.mjs', () => {
  const all = routes();
  const geo = geoRoutes();
  assert.deepEqual(all.slice(0, geo.length), geo);
  assert.equal(geo.length, 4, 'pages and API, for the countries and for the regions of one country');
  const block = edgeBlockList();
  assert.deepEqual(geo[0].has[0].value.inc, block.countries);
  assert.ok(geo.every((r) => r.status === 451 && r.caseSensitive && !r.continue));
  assert.deepEqual(geoRoutes({ countries: [], regions: [] }), [], 'empty lists: no route');
  assert.equal(JSON.parse(functionConfig('https://1-2-3-4.sslip.io').environment.VALUESCAN_GEO_BLOCK).countries.length, SANCTIONED_CODES.length);
});

test('the header classes are what their sample paths say', () => {
  for (const [src, sample] of HEADER_CLASSES) assert.ok(new RegExp(src).test(sample), `${sample} is not matched by its own class ${src}`);
  const cfg = config();
  assert.equal(cfg.version, 3);
  assert.equal(cfg.routes.filter((r) => r.handle === 'filesystem').length, 1);
  assert.ok(cfg.routes.every((r) => r.handle || r.caseSensitive === true), 'every route matches case-sensitively, like CloudFront path patterns');
});

// --- packaging ------------------------------------------------------------------------------

function fakeDist() {
  const d = mkdtempSync(join(tmpdir(), 'vs-dist-'));
  mkdirSync(join(d, 'assets'));
  mkdirSync(join(d, 'scan'));
  writeFileSync(join(d, 'index.html'), '<!doctype html><script type="module" src="/assets/index-abc.js"></script>');
  writeFileSync(join(d, 'assets', 'index-abc.js'), 'console.log(1)');
  writeFileSync(join(d, 'scan', 'index.html'), '<!doctype html>');
  writeFileSync(join(d, 'robots.txt'), 'User-agent: *');
  return d;
}

test('packaging writes the Build Output API layout and keeps the project link', () => {
  const dist = fakeDist();
  const out = mkdtempSync(join(tmpdir(), 'vs-out-'));
  try {
    mkdirSync(join(out, '.vercel'), { recursive: true });
    writeFileSync(join(out, '.vercel', 'project.json'), '{"projectId":"prj_test","orgId":"team_test"}');
    const r = packageSite({ dist, origin: 'https://1-2-3-4.sslip.io', out });
    assert.equal(r.files, 4);
    const output = join(out, '.vercel', 'output');
    assert.ok(existsSync(join(output, 'static', 'assets', 'index-abc.js')));
    assert.deepEqual(JSON.parse(readFileSync(join(output, 'config.json'), 'utf8')), config());
    const fn = join(output, 'functions', 'api', '__vs_proxy.func');
    const vc = JSON.parse(readFileSync(join(fn, '.vc-config.json'), 'utf8'));
    assert.deepEqual(vc, functionConfig('https://1-2-3-4.sslip.io'));
    assert.deepEqual(vc.regions, ['fra1'], 'Frankfurt, next to server 1 in France');
    assert.equal(readFileSync(join(fn, 'index.js'), 'utf8'), readFileSync(new URL('./api-proxy.cjs', import.meta.url), 'utf8'));
    assert.match(readFileSync(join(out, '.vercel', 'project.json'), 'utf8'), /prj_test/, 'the project link survives');
    // No secret is ever part of the deployment's files.
    assert.doesNotMatch(readFileSync(join(fn, '.vc-config.json'), 'utf8'), /SECRET/);
  } finally {
    rmSync(dist, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('a build with a file Vercel could type wrongly, or a bad origin, is refused', () => {
  const dist = fakeDist();
  const out = mkdtempSync(join(tmpdir(), 'vs-out-'));
  try {
    writeFileSync(join(dist, 'assets', 'odd.xyz'), 'x');
    writeFileSync(join(dist, 'LICENSE'), 'x');
    const problems = checkDist(dist);
    assert.equal(problems.length, 2, problems.join(' | '));
    assert.throws(() => packageSite({ dist, origin: 'https://1-2-3-4.sslip.io', out }), /cannot be deployed/);
    rmSync(join(dist, 'assets', 'odd.xyz'));
    rmSync(join(dist, 'LICENSE'));
    for (const bad of ['http://1-2-3-4.sslip.io', 'https://1-2-3-4.sslip.io/', 'https://x.example/api', '1-2-3-4.sslip.io']) {
      assert.throws(() => packageSite({ dist, origin: bad, out }), /--origin must be/, bad);
    }
  } finally {
    rmSync(dist, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

// --- the function -------------------------------------------------------------------------------

const SECRET = 's'.repeat(48);

function listen(handler) {
  return new Promise((ok) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => ok({ port: s.address().port, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) }));
  });
}

/** The function behind a local server, with the environment it runs with on Vercel. */
async function withProxy(env, fn) {
  const saved = { url: process.env.VALUESCAN_ORIGIN_URL, secret: process.env.VALUESCAN_ORIGIN_SECRET, geo: process.env.VALUESCAN_GEO_BLOCK };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  const front = await listen((req, res) => { proxy(req, res); });
  try {
    await fn(front.port, errors);
  } finally {
    console.error = realError;
    await front.close();
    for (const [k, v] of [['VALUESCAN_ORIGIN_URL', saved.url], ['VALUESCAN_ORIGIN_SECRET', saved.secret], ['VALUESCAN_GEO_BLOCK', saved.geo]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function request(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((ok, fail) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', fail);
    req.end(body);
  });
}

test('the function forwards path, query and the secret, the viewer address, and nothing personal', async () => {
  const seen = [];
  const body = gzipSync(Buffer.from(JSON.stringify({ ok: true, rows: [1, 2, 3] })));
  const origin = await listen((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.writeHead(200, {
      'content-type': 'application/json', 'content-encoding': 'gzip', etag: 'W/"abc"', vary: 'Accept-Encoding, Origin',
      'cache-control': 'public, max-age=10, stale-while-revalidate=20', 'set-cookie': 'a=b', server: 'x',
    });
    res.end(body);
  });
  try {
    await withProxy({ VALUESCAN_ORIGIN_URL: `http://127.0.0.1:${origin.port}`, VALUESCAN_ORIGIN_SECRET: SECRET }, async (port) => {
      const r = await request(port, '/api/vs/leaderboard?venue=hyperliquid&window=1d&q=0xabc', {
        headers: {
          'accept-encoding': 'gzip', 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1, 10.0.0.1',
          cookie: 'session=1', authorization: 'Bearer x', 'user-agent': 'Browser/1', 'if-none-match': 'W/"old"', origin: 'https://valuedeskapp.vercel.app',
        },
      });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, body, 'the compressed body is passed through byte for byte');
      assert.equal(r.headers['content-encoding'], 'gzip');
      assert.equal(r.headers.etag, 'W/"abc"');
      assert.equal(r.headers['cache-control'], 'public, max-age=10, stale-while-revalidate=20', 'the browser keeps the API\'s own policy');
      assert.equal(r.headers['vercel-cdn-cache-control'], 'max-age=10, stale-while-revalidate=20', 'the edge may keep a board as CloudFront would');
      assert.equal(r.headers['set-cookie'], undefined);
      const h = seen[0].headers;
      assert.equal(seen[0].url, '/api/vs/leaderboard?venue=hyperliquid&window=1d&q=0xabc');
      assert.equal(h['x-origin-verify'], SECRET);
      assert.equal(h['x-forwarded-for'], '203.0.113.7', 'the address Vercel reports, never the client\'s own X-Forwarded-For');
      assert.equal(h['if-none-match'], 'W/"old"');
      assert.equal(h.origin, 'https://valuedeskapp.vercel.app');
      for (const name of ['cookie', 'authorization', 'user-agent', 'x-real-ip']) assert.equal(h[name], undefined, `${name} must not reach the origin`);
    });
  } finally {
    await origin.close();
  }
});

test('the copy executor: POST under /api/copy/ only, body and token through, the country from Vercel, never cached', async () => {
  const seen = [];
  const origin = await listen((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      // A misbehaving origin: a cacheable answer with CDN headers. The edge must keep none of it.
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=30',
        'cdn-cache-control': 'max-age=60', 'vercel-cdn-cache-control': 'max-age=60', 'set-cookie': 'a=b',
      });
      res.end('{"ok":true}');
    });
  });
  try {
    await withProxy({ VALUESCAN_ORIGIN_URL: `http://127.0.0.1:${origin.port}`, VALUESCAN_ORIGIN_SECRET: SECRET }, async (port) => {
      const signed = JSON.stringify({ request: { action: 'session', payload: 'x'.repeat(2000) } });
      const r = await request(port, '/api/copy/v1/session', {
        method: 'POST', body: signed,
        headers: {
          'content-type': 'application/json', authorization: 'Bearer 0xabc.123.sig', 'x-real-ip': '203.0.113.9',
          'x-vercel-ip-country': 'de', 'x-viewer-country': 'US', 'x-pairing-code': '123456', cookie: 'c=1',
          origin: 'https://valuedeskapp.vercel.app',
        },
      });
      assert.equal(r.status, 200, r.body.toString());
      assert.equal(r.headers['cache-control'], 'no-store', 'one follower\'s answer: never kept, not even by the browser');
      for (const name of ['cdn-cache-control', 'vercel-cdn-cache-control', 'set-cookie']) assert.equal(r.headers[name], undefined, name);
      const s = seen.at(-1);
      assert.equal(s.method, 'POST');
      assert.equal(s.body, signed, 'the body is passed through as it came');
      assert.equal(s.headers['content-length'], String(Buffer.byteLength(signed)));
      assert.equal(s.headers['content-type'], 'application/json');
      assert.equal(s.headers.authorization, 'Bearer 0xabc.123.sig');
      assert.equal(s.headers['x-origin-verify'], SECRET);
      assert.equal(s.headers['x-forwarded-for'], '203.0.113.9');
      assert.equal(s.headers['x-viewer-country'], 'DE', 'Vercel\'s country, never the client\'s own header');
      for (const name of ['x-pairing-code', 'cookie', 'x-vercel-ip-country']) assert.equal(s.headers[name], undefined, `${name} must not reach the origin`);

      // A GET with a read token (GET /api/copy/v1/me) - and a client that names its own country with no Vercel one.
      const me = await request(port, '/api/copy/v1/me', { headers: { authorization: 'Bearer t', 'x-viewer-country': 'US' } });
      assert.equal(me.status, 200);
      assert.equal(me.headers['cache-control'], 'no-store');
      assert.equal(seen.at(-1).headers.authorization, 'Bearer t');
      assert.equal(seen.at(-1).headers['x-viewer-country'], undefined, 'no country from Vercel: none at all');

      // Outside /api/copy/ nothing of it: no POST, no token, no country.
      const before = seen.length;
      const post = await request(port, '/api/vs/leaderboard', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
      assert.equal(post.status, 405);
      assert.equal(post.headers.allow, 'GET, HEAD, OPTIONS');
      assert.equal(seen.length, before, 'a POST outside /api/copy/ never reaches the origin');
      const board = await request(port, '/api/vs/leaderboard', { headers: { authorization: 'Bearer t', 'x-vercel-ip-country': 'DE', 'content-type': 'text/plain' } });
      assert.equal(board.status, 200);
      assert.equal(board.headers['vercel-cdn-cache-control'], 'max-age=30', 'the index keeps its edge cache');
      for (const name of ['authorization', 'x-viewer-country', 'content-type']) assert.equal(seen.at(-1).headers[name], undefined, `${name} only under /api/copy/`);

      // Other writes stay refused under /api/copy/ too; the Allow header names POST there.
      for (const method of ['PUT', 'DELETE', 'PATCH']) {
        const w = await request(port, '/api/copy/v1/copies', { method, body: '{}' });
        assert.equal(w.status, 405, method);
        assert.equal(w.headers.allow, 'GET, HEAD, OPTIONS, POST');
      }
      assert.equal(seen.length, before + 1, 'only the board GET reached the origin');
    });
  } finally {
    await origin.close();
  }
});

test('the copy executor: a body over 64 KB is refused at the edge, and a path that could mean another path is a 404', async () => {
  let hits = 0;
  const origin = await listen((req, res) => { hits++; req.resume(); req.on('end', () => { res.writeHead(200); res.end('{}'); }); });
  try {
    await withProxy({ VALUESCAN_ORIGIN_URL: `http://127.0.0.1:${origin.port}`, VALUESCAN_ORIGIN_SECRET: SECRET }, async (port) => {
      const big = await request(port, '/api/copy/v1/copies', { method: 'POST', body: 'x'.repeat(proxy.BODY_LIMIT + 1), headers: { 'content-type': 'application/json' } });
      assert.equal(big.status, 413);
      const chunked = await new Promise((ok, fail) => {
        // No Content-Length: the limit holds on what arrives.
        const req = http.request({ host: '127.0.0.1', port, path: '/api/copy/v1/copies', method: 'POST', agent: false, headers: { 'transfer-encoding': 'chunked' } }, (res) => { res.resume(); res.on('end', () => ok(res.statusCode)); });
        req.on('error', fail);
        for (let i = 0; i < 70; i++) req.write('y'.repeat(1024));
        req.end();
      });
      assert.equal(chunked, 413);
      const exact = await request(port, '/api/copy/v1/copies', { method: 'POST', body: 'z'.repeat(proxy.BODY_LIMIT) });
      assert.equal(exact.status, 200, 'exactly the limit passes');
      for (const p of ['/api/copy/../vs/leaderboard', '/api/copy/v1/%2e%2e/x', '/api/copy%2fv1/session', '/api//copy/v1/info', '/api/copy/./v1/info', '/api/copy/v1/%00']) {
        const r = await request(port, p, { method: 'POST', body: '{}' });
        assert.equal(r.status, 404, p);
      }
    });
    assert.equal(hits, 1, 'only the request at the limit reached the origin');
  } finally {
    await origin.close();
  }
  assert.equal(proxy.oddPath('/api/vs/leaderboard'), false);
  assert.equal(proxy.oddPath('/api/vs/'), false, 'a trailing slash is not odd');
  assert.equal(proxy.viewerCountry({ 'x-vercel-ip-country': 'jp' }), 'JP');
  assert.equal(proxy.viewerCountry({ 'x-vercel-ip-country': 'XYZ' }), null);
  assert.equal(proxy.viewerCountry({}), null);
});

test('the edge keeps a slow path longer: a site icon a day, the calendar 10 min, the heatmap history 5 min - never longer than the origin says', () => {
  const e = proxy.edgeCacheControl;
  assert.equal(e('GET', 200, 'public, max-age=604800, stale-while-revalidate=2592000', '/api/vs/logo'), 'max-age=86400, stale-while-revalidate=86400');
  assert.equal(e('GET', 200, 'public, max-age=600, stale-while-revalidate=1800', '/api/vs/calendar'), 'max-age=600, stale-while-revalidate=600');
  assert.equal(e('GET', 200, 'public, max-age=300, stale-while-revalidate=300', '/api/vs/liquidations/history'), 'max-age=300, stale-while-revalidate=300');
  assert.equal(e('GET', 200, 'public, max-age=86400, stale-while-revalidate=86400', '/api/vs/liquidations/tiles'), 'max-age=86400, stale-while-revalidate=86400', 'a final tile: a day');
  assert.equal(e('GET', 200, 'public, max-age=60, stale-while-revalidate=120', '/api/vs/liquidations/tiles'), 'max-age=60, stale-while-revalidate=120', 'the index and a slot still filling: a minute');
  assert.equal(e('GET', 200, 'public, max-age=30', '/api/vs/logo'), 'max-age=30', 'the origin still decides below the cap');
  assert.equal(e('GET', 404, 'public, max-age=86400', '/api/vs/logo'), null, 'a missing icon is not kept at the edge');
  assert.equal(e('GET', 200, 'public, max-age=600', '/api/vs/calendar/results'), 'max-age=60', 'exact paths only');
});

test('the edge cache follows the API: public max-age only, at most 60 s, never an error or a live answer', () => {
  const e = proxy.edgeCacheControl;
  assert.equal(e('GET', 200, 'public, max-age=10, stale-while-revalidate=20'), 'max-age=10, stale-while-revalidate=20');
  assert.equal(e('GET', 200, 'public, max-age=300'), 'max-age=60');
  assert.equal(e('GET', 200, 'public, max-age=30, stale-while-revalidate=600'), 'max-age=30, stale-while-revalidate=60');
  assert.equal(e('HEAD', 200, 'public, max-age=10'), 'max-age=10');
  assert.equal(e('GET', 200, 'public, no-cache'), null, 'the whale tape and positioning are revalidated every time');
  assert.equal(e('GET', 200, 'no-store'), null);
  assert.equal(e('GET', 200, 'private, max-age=10'), null);
  assert.equal(e('GET', 200, 'max-age=10'), null, 'not public: not shared');
  assert.equal(e('GET', 404, 'public, max-age=10'), null);
  assert.equal(e('GET', 304, 'public, max-age=10'), null);
  assert.equal(e('OPTIONS', 200, 'public, max-age=10'), null);
  assert.equal(e('GET', 200, undefined), null);
  assert.equal(e('GET', 200, 'public, max-age=10', '/api/vs/leaderboard'), 'max-age=10');
  assert.equal(e('GET', 200, 'public, max-age=10', '/api/copy/v1/info'), null, 'the copy executor is never cached at the edge');
});

test('/api/edge/geo is answered by the function itself: the country and region Vercel saw, never cached, also without an origin', async () => {
  const seen = [];
  const origin = await listen((req, res) => { seen.push(req.url); res.end('{}'); });
  try {
    for (const env of [
      { VALUESCAN_ORIGIN_URL: `http://127.0.0.1:${origin.port}`, VALUESCAN_ORIGIN_SECRET: SECRET },
      { VALUESCAN_ORIGIN_URL: undefined, VALUESCAN_ORIGIN_SECRET: undefined },
    ]) {
      await withProxy(env, async (port) => {
        let r = await request(port, '/api/edge/geo', { headers: { 'x-vercel-ip-country': 'de', 'x-vercel-ip-country-region': 'BY' } });
        assert.equal(r.status, 200);
        assert.deepEqual(JSON.parse(r.body.toString()), { country: 'DE', region: 'BY' });
        assert.equal(r.headers['cache-control'], 'no-store');
        r = await request(port, '/api/edge/geo?x=1');
        assert.deepEqual(JSON.parse(r.body.toString()), { country: null, region: null }, 'unknown: nulls, not a guess');
        r = await request(port, '/api/edge/geo', { headers: { 'x-vercel-ip-country': 'Germany', 'x-vercel-ip-country-region': 'not a region' } });
        assert.deepEqual(JSON.parse(r.body.toString()), { country: null, region: null });
        r = await request(port, '/api/edge/geo', { method: 'POST', body: '{}' });
        assert.equal(r.status, 405);
      });
    }
    assert.deepEqual(seen, [], 'the origin never sees these requests');
  } finally {
    await origin.close();
  }
});

test('the function refuses a sanctioned country or region itself (451), the second check behind the routes', async () => {
  const seen = [];
  const origin = await listen((req, res) => { seen.push(req.url); res.end('{}'); });
  try {
    const env = { VALUESCAN_ORIGIN_URL: `http://127.0.0.1:${origin.port}`, VALUESCAN_ORIGIN_SECRET: SECRET, VALUESCAN_GEO_BLOCK: functionConfig('https://x.example').environment.VALUESCAN_GEO_BLOCK };
    await withProxy(env, async (port) => {
      for (const h of [FROM('IR'), FROM('KP'), FROM('UA', '43'), FROM('UA', '09')]) {
        for (const [path, method] of [['/api/vs/leaderboard', 'GET'], ['/api/copy/v1/session', 'POST']]) {
          const r = await request(port, path, { method, headers: h, body: method === 'POST' ? '{}' : undefined });
          assert.equal(r.status, 451, `${JSON.stringify(h)} ${method} ${path}`);
          assert.equal(JSON.parse(r.body.toString()).code, 'region');
          assert.equal(r.headers['cache-control'], 'no-store');
        }
      }
      // Where they are can still be read, and everyone else is forwarded.
      assert.equal((await request(port, '/api/edge/geo', { headers: FROM('IR') })).status, 200);
      assert.equal((await request(port, '/api/vs/leaderboard', { headers: FROM('UA', '30') })).status, 200);
      assert.equal((await request(port, '/api/vs/leaderboard', { headers: FROM('US') })).status, 200, 'close-only is the app\'s rule, not the edge\'s');
    });
    assert.deepEqual(seen, ['/api/vs/leaderboard', '/api/vs/leaderboard']);
    const logged = [];
    const realError = console.error;
    console.error = (...a) => logged.push(a.join(' '));
    try {
      assert.deepEqual(proxy.geoBlockFrom({ VALUESCAN_GEO_BLOCK: 'not json' }), { countries: [], regions: [] });
    } finally {
      console.error = realError;
    }
    assert.match(logged.join('\n'), /not JSON; no place is refused here/, 'a broken setting is said, not silent');
    assert.deepEqual(proxy.geoBlockFrom({}), { countries: [], regions: [] });
    assert.deepEqual(proxy.geoBlockFrom({ VALUESCAN_GEO_BLOCK: '{"countries":["IR","x"],"regions":[{"country":"UA","region":"43"},{"country":"U","region":"1"}]}' }),
      { countries: ['IR'], regions: [{ country: 'UA', region: '43' }] });
    assert.equal(proxy.geoBlocked({ countries: ['IR'], regions: [] }, null, null), false);
  } finally {
    await origin.close();
  }
});

test('the viewer address is taken only from what Vercel sets, and must be an address', () => {
  const v = proxy.viewerAddress;
  assert.equal(v({ 'x-real-ip': '203.0.113.7' }), '203.0.113.7');
  assert.equal(v({ 'x-vercel-forwarded-for': '2001:db8::1, 10.0.0.1' }), '2001:db8::1');
  assert.equal(v({ 'x-real-ip': 'not-an-address', 'x-forwarded-for': '198.51.100.2' }), '198.51.100.2');
  assert.equal(v({}), null);
});

test('knowledge folders: POST and the wallet token under /api/folders only, a file up to 4.25 MB, never cached', async () => {
  const seen = [];
  const origin = await listen((req, res) => {
    let size = 0;
    req.on('data', (c) => { size += c.length; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, size });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=30', 'cdn-cache-control': 'max-age=60' });
      res.end('{"ok":true}');
    });
  });
  try {
    await withProxy({ VALUESCAN_ORIGIN_URL: `http://127.0.0.1:${origin.port}`, VALUESCAN_ORIGIN_SECRET: SECRET }, async (port) => {
      const item = JSON.stringify({ folderId: 'f', kind: 'note', title: 't', data: { blocks: [] }, pad: 'x'.repeat(300 * 1024) });
      const r = await request(port, '/api/folders/item/create', {
        method: 'POST', body: item,
        headers: { 'content-type': 'application/json', authorization: 'Bearer 0xabc.1.0.mac', origin: 'https://valuedeskapp.vercel.app', 'x-vercel-ip-country': 'DE' },
      });
      assert.equal(r.status, 200, r.body.toString());
      assert.equal(r.headers['cache-control'], 'no-store', "one wallet's answer: never kept");
      assert.equal(r.headers['cdn-cache-control'], undefined);
      const s = seen.at(-1);
      assert.equal(s.headers.authorization, 'Bearer 0xabc.1.0.mac');
      assert.equal(s.headers['content-type'], 'application/json');
      assert.equal(s.headers['x-viewer-country'], undefined, 'the country is for the copy executor only');
      assert.equal(s.size, Buffer.byteLength(item), 'an item over 64 KB passes');

      const list = await request(port, '/api/folders', { headers: { authorization: 'Bearer t' } });
      assert.equal(list.headers['cache-control'], 'no-store');
      assert.equal(list.headers['vercel-cdn-cache-control'], undefined, 'a wallet\'s list is never kept at the edge');
      assert.equal(seen.at(-1).headers.authorization, 'Bearer t');

      const file = Buffer.alloc(4 * 1024 * 1024, 1);
      const up = await request(port, '/api/folders/upload/put?id=u', { method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream', authorization: 'Bearer t' } });
      assert.equal(up.status, 200);
      assert.equal(seen.at(-1).size, file.length, 'a 4 MB file reaches the origin whole');
      const before = seen.length;
      const huge = await request(port, '/api/folders/upload/put?id=u', { method: 'POST', body: Buffer.alloc(proxy.bodyLimitFor('/api/folders/upload/put') + 1), headers: { 'content-type': 'application/octet-stream' } });
      assert.equal(huge.status, 413);
      const bigItem = await request(port, '/api/folders/item/create', { method: 'POST', body: 'x'.repeat(1792 * 1024 + 1) });
      assert.equal(bigItem.status, 413, 'an item is held to 1.75 MB');
      assert.equal(seen.length, before, 'neither reached the origin');
      assert.equal(proxy.bodyLimitFor('/api/copy/v1/copies'), proxy.BODY_LIMIT, 'the executor keeps its 64 KB');
      assert.equal(proxy.isFoldersPath('/api/foldersx'), false);
    });
  } finally {
    await origin.close();
  }
});

test('feedback and error reports: POST and the thread token pass, a screenshot up to 2 MiB, nothing else grows, never cached', async () => {
  const seen = [];
  const origin = await listen((req, res) => {
    let size = 0;
    req.on('data', (c) => { size += c.length; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, size });
      res.writeHead(200, { 'content-type': 'image/png', 'content-disposition': 'inline', 'cache-control': 'public, max-age=30' });
      res.end('png');
    });
  });
  try {
    await withProxy({ VALUESCAN_ORIGIN_URL: `http://127.0.0.1:${origin.port}`, VALUESCAN_ORIGIN_SECRET: SECRET }, async (port) => {
      const msg = await request(port, '/api/vs/feedback', { method: 'POST', body: '{"text":"hi"}', headers: { 'content-type': 'application/json', authorization: 'Bearer thread' } });
      assert.equal(msg.status, 200);
      assert.equal(msg.headers['cache-control'], 'no-store');
      assert.equal(seen.at(-1).headers.authorization, 'Bearer thread');
      const shot = Buffer.alloc(2 * 1024 * 1024, 1);
      assert.equal((await request(port, '/api/vs/feedback/upload', { method: 'POST', body: shot, headers: { 'content-type': 'application/json' } })).status, 200);
      assert.equal(seen.at(-1).size, shot.length, 'a 2 MiB screenshot reaches the origin whole');
      const img = await request(port, '/api/vs/feedback/image?id=x', { headers: { authorization: 'Bearer thread' } });
      assert.equal(img.headers['content-type'], 'image/png');
      assert.equal(img.headers['content-disposition'], 'inline');
      assert.equal(img.headers['cache-control'], 'no-store', 'a visitor\'s screenshot is never kept');
      const before = seen.length;
      assert.equal((await request(port, '/api/vs/feedback/upload', { method: 'POST', body: Buffer.alloc(proxy.bodyLimitFor('/api/vs/feedback/upload') + 1) })).status, 413);
      assert.equal((await request(port, '/api/vs/client-errors', { method: 'POST', body: 'x'.repeat(16 * 1024 + 1), headers: { 'content-type': 'text/plain' } })).status, 413);
      assert.equal(seen.length, before, 'neither reached the origin');
      assert.equal(proxy.isReportsPath('/api/vs/feedbackx'), false);
      // A signed-in wallet's inbox passes like the chat; a batch of notices may be up to 64 KiB.
      assert.equal(proxy.isReportsPath('/api/vs/inbox/add'), true);
      assert.equal(proxy.isReportsPath('/api/vs/inboxx'), false);
      assert.equal(proxy.isReportsPath('/api/vs/username'), true);
      assert.equal(proxy.isReportsPath('/api/vs/username/check'), false);
      assert.equal(proxy.bodyLimitFor('/api/vs/inbox/add'), 64 * 1024);
      assert.equal((await request(port, '/api/vs/leaderboard', { method: 'POST', body: '{}' })).status, 405, 'other index paths stay GET only');
    });
  } finally {
    await origin.close();
  }
});

test('writes, a missing secret, the function\'s own path and a stopped instance never reach (or hang on) the origin', async () => {
  let hits = 0;
  const origin = await listen((_req, res) => { hits++; res.writeHead(200); res.end('{}'); });
  try {
    await withProxy({ VALUESCAN_ORIGIN_URL: `http://127.0.0.1:${origin.port}`, VALUESCAN_ORIGIN_SECRET: SECRET }, async (port) => {
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        const r = await request(port, '/api/health', { method });
        assert.equal(r.status, 405, method);
        assert.equal(r.headers.allow, 'GET, HEAD, OPTIONS');
      }
      assert.equal((await request(port, '/api/__vs_proxy')).status, 404);
      const head = await request(port, '/api/health', { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(head.body.length, 0);
    });
    assert.equal(hits, 1, 'only the HEAD reached the origin');
    await withProxy({ VALUESCAN_ORIGIN_URL: `http://127.0.0.1:${origin.port}`, VALUESCAN_ORIGIN_SECRET: undefined }, async (port, errors) => {
      const r = await request(port, '/api/health');
      assert.equal(r.status, 503, 'a deployment without the secret (a preview) does not reach the origin');
      assert.match(errors.join('\n'), /not configured/);
    });
    assert.equal(hits, 1);
  } finally {
    await origin.close();
  }
  // A stopped instance: nothing listens. 502 at once (connection refused), and the log
  // line names neither the secret nor the query.
  const gone = await listen(() => {});
  const port = gone.port;
  await gone.close();
  await withProxy({ VALUESCAN_ORIGIN_URL: `http://127.0.0.1:${port}`, VALUESCAN_ORIGIN_SECRET: SECRET }, async (p, errors) => {
    const t0 = Date.now();
    const r = await request(p, '/api/vs/leaderboard?q=0xwallet');
    assert.equal(r.status, 502);
    assert.ok(Date.now() - t0 < 11_000);
    assert.equal(r.headers['cache-control'], 'no-store');
    const log = errors.join('\n');
    assert.match(log, /\/api\/vs\/leaderboard/);
    assert.doesNotMatch(log, /0xwallet/);
    assert.ok(!log.includes(SECRET));
  });
});

test('the origin setting must be https (http only to loopback) and an origin only', () => {
  const o = proxy.originFrom;
  assert.ok(o({ VALUESCAN_ORIGIN_URL: 'https://1-2-3-4.sslip.io' }).url);
  assert.ok(o({ VALUESCAN_ORIGIN_URL: 'http://127.0.0.1:8080' }).url);
  assert.match(o({ VALUESCAN_ORIGIN_URL: 'http://1-2-3-4.sslip.io' }).error, /https/);
  assert.match(o({ VALUESCAN_ORIGIN_URL: 'https://x.example/api' }).error, /nothing after the host/);
  assert.match(o({}).error, /not set/);
});

// --- the admin suite's host (dev.valuedesk.so) -------------------------------------------------------

const DEV_HOST = { host: ADMIN_HOST };
const ADMIN_STATIC = new Set([...STATIC, '/admin.html', '/assets/admin-abc.js', '/assets/admin-abc.css']);

test('the admin host: its page for every app route, its own headers from one route, nothing else of the site', () => {
  for (const path of ['/', '/tickets', '/users/0xabc', '/status']) {
    const r = route(path, ADMIN_STATIC, DEV_HOST);
    assert.equal(r.served, '/admin.html', path);
    assert.equal(r.matchedHeaderRoutes.length, 1, `${path}: ${r.matchedHeaderRoutes.join(' | ')}`);
    assert.deepEqual(r.headers, adminHeadersFor(path), path);
    assert.equal(r.headers['Cache-Control'], 'no-store');
    assert.equal(r.headers['X-Robots-Tag'], 'noindex, nofollow');
  }
  const asset = route('/assets/admin-abc.js', ADMIN_STATIC, DEV_HOST);
  assert.equal(asset.served, '/assets/admin-abc.js');
  assert.equal(asset.matchedHeaderRoutes.length, 1);
  assert.equal(asset.headers['Cache-Control'], 'public, max-age=31536000, immutable');
  assert.equal(asset.headers['Content-Security-Policy'], ADMIN_CSP);
  assert.equal(route('/admin.html', ADMIN_STATIC, DEV_HOST).served, '/admin.html');
  for (const path of ['/index.html', '/scan/index.html', '/robots.txt', '/logos/btc.svg', '/third-party-licenses.txt']) {
    assert.equal(route(path, ADMIN_STATIC, DEV_HOST).status, 404, `${path}: no file of the site on the admin host`);
  }
  assert.equal(route('/api/admin/me', ADMIN_STATIC, DEV_HOST).fn, true);
  // Its policy lets the page reach its own API and a wallet - nothing else.
  assert.match(ADMIN_CSP, /connect-src 'self' wss:\/\/relay\.walletconnect\.org https:\/\/api\.web3modal\.org;/);
  assert.match(ADMIN_CSP, /script-src 'self';/);
});

test('every other host: the admin page is a 404, and the site is served as before', () => {
  for (const host of [undefined, 'www.valuedesk.so', 'valuedeskapp.vercel.app']) {
    const h = host ? { host } : {};
    assert.equal(route('/admin.html', ADMIN_STATIC, h).status, 404, `${host}: /admin.html`);
    assert.equal(route('/tickets', ADMIN_STATIC, h).served, '/index.html');
    assert.deepEqual(route('/trade', ADMIN_STATIC, h).headers, headersFor('/trade'));
  }
});

test('the function: /api/admin/* only through the admin host, POST and the session through, the country added, never cached', async () => {
  const seen = [];
  const origin = await listen((req, res) => {
    let size = 0;
    req.on('data', (c) => { size += c.length; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, size });
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=30' });
      res.end('{}');
    });
  });
  try {
    await withProxy({ VALUESCAN_ORIGIN_URL: `http://127.0.0.1:${origin.port}`, VALUESCAN_ORIGIN_SECRET: SECRET }, async (port) => {
      const dev = { host: ADMIN_HOST, 'content-type': 'application/json', authorization: 'Bearer vda_x', origin: `https://${ADMIN_HOST}`, 'x-vercel-ip-country': 'DE' };
      const ok = await request(port, '/api/admin/me', { method: 'POST', body: '{}', headers: dev });
      assert.equal(ok.status, 200);
      assert.equal(ok.headers['cache-control'], 'no-store');
      const h = seen.at(-1).headers;
      assert.equal(h.authorization, 'Bearer vda_x');
      assert.equal(h.origin, `https://${ADMIN_HOST}`);
      assert.equal(h['x-viewer-country'], 'DE');
      const before = seen.length;
      assert.equal((await request(port, '/api/admin/me', { method: 'POST', body: '{}', headers: { ...dev, host: 'www.valuedesk.so' } })).status, 404, 'not through the site');
      assert.equal((await request(port, '/api/vs/leaderboard', { headers: { host: ADMIN_HOST } })).status, 404, 'the admin host reaches nothing else');
      assert.equal((await request(port, '/api/admin/ticket/reply', { method: 'POST', body: 'x'.repeat(32 * 1024 + 1), headers: dev })).status, 413);
      assert.equal(seen.length, before, 'none reached the origin');
    });
  } finally {
    await origin.close();
  }
});

test('the beta deployment: its function is told the channel, the main site never', () => {
  assert.equal(functionConfig('https://api.valuedesk.so', 'beta').environment.VALUESCAN_CHANNEL, 'beta');
  assert.equal(functionConfig('https://api.valuedesk.so').environment.VALUESCAN_CHANNEL, undefined);
});

test('the beta site: every request to the beta API with its cookie as x-vs-beta, POST passes, nothing cached; the main site has no beta paths', async () => {
  const seen = [];
  const origin = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers });
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=30' });
      res.end('{}');
    });
  });
  const token = `0x${'a'.repeat(40)}.1800000000000.${'b'.repeat(43)}`;
  try {
    await withProxy({ VALUESCAN_ORIGIN_URL: `http://127.0.0.1:${origin.port}`, VALUESCAN_ORIGIN_SECRET: SECRET, VALUESCAN_CHANNEL: 'beta' }, async (port) => {
      const site = { host: 'beta.valuedesk.so', cookie: `vs_consent=1; vs_beta=${token}; other=x` };
      const read = await request(port, '/api/vs/explore', { headers: site });
      assert.equal(read.status, 200);
      assert.equal(read.headers['cache-control'], 'no-store');
      assert.equal(read.headers['vercel-cdn-cache-control'], undefined, 'never kept by the CDN');
      let h = seen.at(-1).headers;
      assert.equal(h['x-vs-channel'], 'beta');
      assert.equal(h['x-vs-beta'], token);
      assert.equal(h.cookie, undefined, 'the cookie itself never goes on');
      const signIn = await request(port, '/api/beta/session', { method: 'POST', body: '{}', headers: { host: 'beta.valuedesk.so', 'content-type': 'application/json', origin: 'https://beta.valuedesk.so' } });
      assert.equal(signIn.status, 200);
      h = seen.at(-1).headers;
      assert.equal(seen.at(-1).method, 'POST');
      assert.equal(h['x-vs-beta'], undefined, 'no cookie, no token');
      // A cookie that is not a token shape is not passed.
      await request(port, '/api/vs/explore', { headers: { cookie: 'vs_beta=nope' } });
      assert.equal(seen.at(-1).headers['x-vs-beta'], undefined);
    });
    await withProxy({ VALUESCAN_ORIGIN_URL: `http://127.0.0.1:${origin.port}`, VALUESCAN_ORIGIN_SECRET: SECRET, VALUESCAN_CHANNEL: undefined }, async (port) => {
      const before = seen.length;
      assert.equal((await request(port, '/api/beta/me', { headers: { cookie: `vs_beta=${token}` } })).status, 404);
      await request(port, '/api/vs/explore', { headers: { cookie: `vs_beta=${token}` } });
      assert.equal(seen.length, before + 1);
      assert.equal(seen.at(-1).headers['x-vs-channel'], undefined);
      assert.equal(seen.at(-1).headers['x-vs-beta'], undefined, 'the main site never sends a beta token');
    });
  } finally {
    delete process.env.VALUESCAN_CHANNEL;
    await origin.close();
  }
});

test('the function: the own analytics of the app is a POST with the country and region, never cached', async () => {
  const seen = [];
  const origin = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push({ method: req.method, headers: req.headers });
      res.writeHead(204);
      res.end();
    });
  });
  try {
    await withProxy({ VALUESCAN_ORIGIN_URL: `http://127.0.0.1:${origin.port}`, VALUESCAN_ORIGIN_SECRET: SECRET }, async (port) => {
      const r = await request(port, '/api/vs/a', { method: 'POST', body: '{}', headers: { 'content-type': 'text/plain', 'x-vercel-ip-country': 'DE', 'x-vercel-ip-country-region': 'RP', 'x-viewer-country': 'US' } });
      assert.equal(r.status, 204);
      assert.equal(seen[0].headers['x-viewer-country'], 'DE', "Vercel's, never the client's own");
      assert.equal(seen[0].headers['x-viewer-region'], 'RP');
      assert.equal(seen[0].headers['user-agent'], undefined);
      assert.equal(proxy.bodyLimitFor('/api/vs/a'), 16 * 1024);
    });
  } finally {
    await origin.close();
  }
});

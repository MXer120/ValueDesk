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
import { headersFor, rewrite } from '../smoke/prod-headers.mjs';
import { FUNCTION_PATH, HEADER_CLASSES, checkDist, config, functionConfig, packageSite, routes } from './package.mjs';

const require = createRequire(import.meta.url);
const proxy = require('./api-proxy.cjs');

// --- the routes ---------------------------------------------------------------------------

/**
 * Vercel's routing for these routes, as far as they use it: in order, a match with
 * `continue` adds its headers and goes on, a match without it ends the phase with its
 * `dest`; then the filesystem; then the routes after `handle: filesystem`.
 */
function route(path, staticFiles) {
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
    if (r.continue) {
      if (phase !== 'start') continue;
      Object.assign(headers, r.headers);
      matchedHeaderRoutes.push(r.src);
      continue;
    }
    dest = r.dest;
    if (phase === 'start') {
      if (dest === FUNCTION_PATH) return { headers, matchedHeaderRoutes, fn: true };
      return { headers, matchedHeaderRoutes, served: dest };
    }
    return { headers, matchedHeaderRoutes, served: dest };
  }
  return { headers, matchedHeaderRoutes, served: dest, notFound: !dest };
}

const STATIC = new Set(['/index.html', '/favicon.svg', '/favicon.ico', '/robots.txt', '/assets/index-abc.js', '/assets/index-abc.css',
  '/assets/sw-worker-1.js', '/logos/btc.svg', '/addrbook/a.png', '/scan/index.html', '/scan/legacy.js']);

const PATHS = [
  '/', '/trade', '/explore', '/scan', '/scan/', '/scan/x', '/scan/index.html', '/scan/legacy.js', '/index.html',
  '/favicon.svg', '/robots.txt', '/assets/index-abc.js', '/assets/index-abc.css', '/assets/sw-worker-1.js',
  '/assets/missing.js', '/assets/', '/assets/noext', '/logos/btc.svg', '/logos/', '/logos/x', '/logos/x.html',
  '/addrbook/a.png', '/a.b/c', '/deep/path/route', '/deep/file.txt', '/page.html', '/apix', '/api', '/LOGOS/btc.svg',
  '/Assets/x.js', '/scanner', '/scan.html', '/favicon.ico', '/impressum', '/privacy',
];

test('every path gets exactly the headers of prod-headers.mjs, from exactly one route', () => {
  for (const path of PATHS) {
    const r = route(path, STATIC);
    assert.equal(r.matchedHeaderRoutes.length, 1, `${path}: ${r.matchedHeaderRoutes.length} header routes matched (${r.matchedHeaderRoutes.join(' | ')})`);
    assert.deepEqual(r.headers, headersFor(path), path);
  }
});

test('/api/* goes to the function and nowhere else, without the site headers', () => {
  for (const path of ['/api/health', '/api/vs/leaderboard', '/api/vs/cohorts/map', '/api/__vs_proxy', '/api/x.js']) {
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
    assert.deepEqual(vc.regions, ['fra1']);
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
  const saved = { url: process.env.VALUESCAN_ORIGIN_URL, secret: process.env.VALUESCAN_ORIGIN_SECRET };
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
    for (const [k, v] of [['VALUESCAN_ORIGIN_URL', saved.url], ['VALUESCAN_ORIGIN_SECRET', saved.secret]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function request(port, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((ok, fail) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', fail);
    req.end();
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
});

test('the viewer address is taken only from what Vercel sets, and must be an address', () => {
  const v = proxy.viewerAddress;
  assert.equal(v({ 'x-real-ip': '203.0.113.7' }), '203.0.113.7');
  assert.equal(v({ 'x-vercel-forwarded-for': '2001:db8::1, 10.0.0.1' }), '2001:db8::1');
  assert.equal(v({ 'x-real-ip': 'not-an-address', 'x-forwarded-for': '198.51.100.2' }), '198.51.100.2');
  assert.equal(v({}), null);
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

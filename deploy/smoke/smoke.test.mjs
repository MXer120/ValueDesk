// node --test deploy/smoke/smoke.test.mjs
//
// The pieces of the smoke test that decide what "production" means locally:
// the header table, the edge stand-in, the API stand-in and the egress guard.
// No connection leaves the machine: servers listen on loopback for the length of
// one test, and the only non-loopback names used are under the reserved .invalid,
// which the guard refuses before any lookup (the origin probe's test asks the
// resolver for one such name, to see that a name that does not resolve is caught).
//
// Ports are assigned by the operating system. On a machine where only some ports
// are yours, keep the listeners inside a range and run the files one at a time:
//   TEST_PORT_RANGE=4281-4288 node --test --test-concurrency=1 "deploy/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CSP, HEADERS, SCAN_SCRIPT_HASH, cacheControlFor, headersFor, policyFor, rewrite, sourceAllows } from './prod-headers.mjs';
import { checkDeployedHeaders, checkHttpsRedirect, probeOrigin } from './deployed.mjs';
import { hostedRoutes, matchRoute, routeRegExp, startMockApi } from './mock-api.mjs';
import { CONTENT_TYPES, startStaticServer } from './static-server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// Made up for each run: no value that looks like a secret is written into the repository.
const SECRET = randomBytes(24).toString('hex');

function site() {
  const dir = mkdtempSync(join(tmpdir(), 'vs-smoke-site-'));
  mkdirSync(join(dir, 'assets'));
  mkdirSync(join(dir, 'logos'));
  mkdirSync(join(dir, 'scan'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>shell</title>');
  writeFileSync(join(dir, 'assets', 'index-abc.js'), 'export {}');
  writeFileSync(join(dir, 'assets', 'worker-def.js'), 'onconnect = () => {}');
  writeFileSync(join(dir, 'logos', 'BTC.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(dir, 'scan', 'index.html'), '<!doctype html><title>moved</title>');
  writeFileSync(join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  return dir;
}

const RANGE = /^(\d+)-(\d+)$/.exec(process.env.TEST_PORT_RANGE ?? '');
const candidates = RANGE ? Array.from({ length: Number(RANGE[2]) - Number(RANGE[1]) + 1 }, (_, i) => Number(RANGE[1]) + i) : [0];

/** A loopback server on a free candidate port. In a range the ports are taken in turn, so one is not reused at once. */
let turn = 0;
async function listen(handler) {
  for (let i = 0; i < candidates.length; i++) {
    const port = candidates[(turn + i) % candidates.length];
    const s = http.createServer(handler);
    const bound = await new Promise((ok) => {
      s.once('error', () => ok(false));
      s.listen(port, '127.0.0.1', () => ok(true));
    });
    if (bound) {
      turn = (turn + i + 1) % candidates.length;
      return { port: s.address().port, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) };
    }
  }
  throw new Error(`no free port in TEST_PORT_RANGE=${process.env.TEST_PORT_RANGE}`);
}
/** A port nothing listens on right now. Ask for it AFTER the servers of a test are up. */
const freePort = async () => { const s = await listen(() => {}); const { port } = s; await s.close(); return port; };

test('the header table: one policy per path class, as the edge behaviours are', () => {
  assert.equal(policyFor('/'), 'site');
  assert.equal(policyFor('/trade'), 'site');
  assert.equal(policyFor('/assets/worker-abc.js'), 'site');
  assert.equal(policyFor('/scan'), 'site', '/scan is an app route');
  assert.equal(policyFor('/scan/'), 'scan');
  assert.equal(policyFor('/scan/index.html'), 'scan');
  assert.equal(policyFor('/logos/BTC.svg'), 'images');
  assert.equal(policyFor('/addrbook/p/x.png'), 'images');
  assert.ok(CSP.scan.includes(SCAN_SCRIPT_HASH) && !CSP.site.includes('sha256-'));
  assert.equal(CSP.scan.replace(` ${SCAN_SCRIPT_HASH}`, ''), CSP.site, 'the scan policy is the site policy plus one hash');
  for (const p of [CSP.site, CSP.scan, CSP.images]) {
    assert.ok(p.length <= 1783, 'fits a CloudFront response headers policy');
    assert.ok(!/\s{2}|\n/.test(p), 'one line, single spaces');
  }
  assert.match(CSP.site, /frame-ancestors 'none'/);
  assert.ok(!/connect-src[^;]*\s(wss?:|https?:|\*)(\s|;)/.test(CSP.site), 'no scheme-wide wildcard in connect-src');
  const connect = CSP.site.split(';').map((d) => d.trim()).find((d) => d.startsWith('connect-src')).split(/\s+/).slice(1);
  for (const s of ['wss://api.hyperliquid.xyz', 'http://127.0.0.1:*', 'http://localhost:*']) assert.ok(connect.includes(s), `connect-src has ${s}`);
  assert.deepEqual(connect.filter((s) => s.startsWith('http://')), ['http://127.0.0.1:*', 'http://localhost:*'], 'plain http for loopback only');
  assert.equal(headersFor('/trade')['Content-Security-Policy'], CSP.site);
  assert.equal(headersFor('/trade')['X-Frame-Options'], 'DENY');
  assert.equal(HEADERS['Cross-Origin-Embedder-Policy'], undefined, 'COEP would break the wallet images');
});

test('what connect-src allows, as the smoke checks read it: exact origins, and loopback on any port', () => {
  const connect = CSP.site.split(';').map((d) => d.trim()).find((d) => d.startsWith('connect-src')).split(/\s+/).slice(1);
  assert.ok(sourceAllows(connect, 'https://api.hyperliquid.xyz'));
  assert.ok(sourceAllows(connect, 'wss://api.hyperliquid.xyz'));
  assert.ok(sourceAllows(new Set(connect), 'http://127.0.0.1:8799'), 'a self-hosted executor on its default port');
  assert.ok(sourceAllows(connect, 'http://localhost:9000'));
  assert.ok(sourceAllows(connect, 'http://127.0.0.1'), 'a port wildcard covers the default port');
  for (const no of ['http://192.168.1.10:8799', 'http://127.0.0.2:8799', 'http://[::1]:8799',
    'http://localhost.evil.example:8799', 'https://api.hyperliquid.xyz.evil.example', 'not a url']) {
    assert.equal(sourceAllows(connect, no), false, no);
  }
});

test('the SPA rewrite and Cache-Control match the CloudFront function and the publish script', () => {
  assert.equal(rewrite('/'), '/index.html');
  assert.equal(rewrite('/trade'), '/index.html');
  assert.equal(rewrite('/scan'), '/index.html');
  assert.equal(rewrite('/portfolio/'), '/index.html');
  assert.equal(rewrite('/scan/'), '/scan/index.html');
  assert.equal(rewrite('/assets/index-abc.js'), '/assets/index-abc.js');
  assert.equal(rewrite('/favicon.svg'), '/favicon.svg');
  assert.equal(cacheControlFor('/assets/index-abc.js'), 'public, max-age=31536000, immutable');
  assert.equal(cacheControlFor('/index.html'), 'no-cache');
  assert.equal(cacheControlFor('/scan/index.html'), 'no-cache');
  assert.match(cacheControlFor('/logos/BTC.svg'), /max-age=86400/);
  assert.equal(headersFor('/explore')['Cache-Control'], 'no-cache', 'an app route is the shell');
});

test('the edge stand-in serves the site as production does', async () => {
  const dir = site();
  const s = await startStaticServer({ dist: dir, port: await freePort() });
  try {
    const shell = await fetch(`${s.url}/explore?view=cohorts`);
    assert.equal(shell.status, 200);
    assert.equal(shell.headers.get('content-type'), CONTENT_TYPES.html);
    assert.equal(shell.headers.get('content-security-policy'), CSP.site);
    assert.equal(shell.headers.get('cache-control'), 'no-cache');
    assert.equal(shell.headers.get('strict-transport-security'), 'max-age=63072000; includeSubDomains');
    assert.equal(shell.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await shell.text(), /shell/);

    const worker = await fetch(`${s.url}/assets/worker-def.js`);
    assert.equal(worker.headers.get('content-security-policy'), CSP.site, 'the worker script carries the policy it will run under');
    assert.equal(worker.headers.get('content-type'), CONTENT_TYPES.js);
    assert.equal(worker.headers.get('cache-control'), 'public, max-age=31536000, immutable');

    const legacy = await fetch(`${s.url}/scan/`);
    assert.match(await legacy.text(), /moved/);
    assert.equal(legacy.headers.get('content-security-policy'), CSP.scan);
    assert.equal((await fetch(`${s.url}/logos/BTC.svg`)).headers.get('content-security-policy'), CSP.images);

    // A missing file is a 403 from the private bucket, never the shell.
    const missing = await fetch(`${s.url}/assets/gone-123.js`);
    assert.equal(missing.status, 403);
    assert.doesNotMatch(await missing.text(), /shell/);
    // Nothing outside the build directory.
    assert.notEqual((await fetch(`${s.url}/..%2f..%2fpackage.json`)).status, 200);
    assert.equal((await fetch(`${s.url}/trade`, { method: 'POST' })).status, 403);
    // No API configured: a stopped instance.
    assert.equal((await fetch(`${s.url}/api/health`)).status, 503);
  } finally {
    await s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the edge stand-in forwards /api like CloudFront: secret, viewer address, GETs only, errors untouched', async () => {
  const dir = site();
  const got = [];
  const origin = await listen((req, res) => {
    got.push({ method: req.method, url: req.url, secret: req.headers['x-origin-verify'], xff: req.headers['x-forwarded-for'] });
    if (req.url.startsWith('/api/missing')) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":"not found"}'); }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=10', server: 'nope' });
    res.end('{"ok":true}');
  });
  const s = await startStaticServer({ dist: dir, port: await freePort(), api: { target: `http://127.0.0.1:${origin.port}`, secret: SECRET } });
  try {
    const ok = await fetch(`${s.url}/api/vs/leaderboard?venue=sodex&q=0xabc`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true });
    assert.equal(ok.headers.get('cache-control'), 'public, max-age=10', "the origin's Cache-Control is honoured");
    assert.equal(ok.headers.get('strict-transport-security'), 'max-age=63072000; includeSubDomains');
    assert.equal(ok.headers.get('server'), null);
    assert.equal(ok.headers.get('content-security-policy'), null, 'the site policy is not put on API responses');
    assert.equal(got[0].secret, SECRET);
    assert.equal(got[0].url, '/api/vs/leaderboard?venue=sodex&q=0xabc', 'the query string is forwarded');
    assert.match(got[0].xff, /^203\.0\.113\.9, (127\.0\.0\.1|::1)$/, 'the viewer address is appended, as CloudFront does');

    const gone = await fetch(`${s.url}/api/missing`);
    assert.equal(gone.status, 404, "the API's own 404 reaches the browser - it is not rewritten to the shell");
    assert.deepEqual(await gone.json(), { error: 'not found' });

    const post = await fetch(`${s.url}/api/session/import`, { method: 'POST', body: '{}' });
    assert.equal(post.status, 403);
    assert.equal(got.filter((g) => g.method === 'POST').length, 0, 'a POST never reaches the origin');
    assert.ok(s.requests.some((r) => r.kind === 'api' && r.status === 404));
  } finally {
    await s.close();
    await origin.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the allow-list is read from the server source and matched like the gate', () => {
  const routes = hostedRoutes();
  assert.equal(routes.length, 96, 'apps/server/src/hosted.ts HOSTED_ROUTES: 96 routes (usernames 3; 37 of the index with the excluded wallets, who traded a candle and a wallet\'s fills in it, the live liquidation socket, the positions of a wallet, one history cell at a time and the history in tiles among them, 18 of the knowledge folders, the builder volume and its beta list, the status page and its feed, 8 of feedback with the wallet sign-in and the unread dot, 2 of the inbox of a signed-in wallet, client errors, the own analytics of the app, 18 of the admin suite on dev.valuedesk.so with its beta list, 2 of the beta channel sign-in)');
  assert.ok(matchRoute(routes, 'GET', '/api/vs/live'), 'the Live Feed finds the stream a channel has on air');
  // The index is GET only; a POST only ever changes a wallet's own knowledge folders or inbox, or sends
  // feedback, an error report or the app's own analytics - or is the owner's admin suite (every route of it a POST).
  // One path is not under /api/: the live heatmap's WebSocket, which the browser opens straight to the instance (no edge).
  const postable = (u) => u.startsWith('/api/folders/') || u === '/api/vs/feedback' || u.startsWith('/api/vs/feedback/') || u.startsWith('/api/vs/inbox/') || u === '/api/vs/client-errors'
    || u === '/api/vs/a' || u === '/api/vs/username' || u.startsWith('/api/admin/') || u === '/api/beta/session';
  assert.ok(routes.every((r) => (r.url.startsWith('/api/') || r.url === '/ws/liq') && (r.method === 'GET' || postable(r.url))));
  assert.ok(matchRoute(routes, 'POST', '/api/vs/feedback/upload'), 'a screenshot is uploaded');
  assert.ok(matchRoute(routes, 'GET', '/api/vs/status'), 'the status page');
  assert.ok(matchRoute(routes, 'GET', '/ws/liq'), 'the live liquidation heatmap');
  assert.ok(matchRoute(routes, 'POST', '/api/folders/item/create'), 'a folder item is saved');
  assert.ok(matchRoute(routes, 'GET', '/api/folders/file/url'), 'an upload is read back');
  assert.ok(matchRoute(routes, 'GET', '/api/vs/leaderboard'));
  assert.ok(matchRoute(routes, 'HEAD', '/api/health'));
  assert.ok(matchRoute(routes, 'GET', '/api/external/announcements/42'));
  assert.equal(matchRoute(routes, 'GET', '/api/external/announcements/42/extra'), null);
  assert.equal(matchRoute(routes, 'POST', '/api/vs/leaderboard'), null);
  for (const blocked of ['/api/vs/trader', '/api/vs/fills', '/api/vs/account', '/api/vs/price', '/api/md/perps/symbols', '/api/acct/perps/state',
    '/api/stats/all-time', '/api/session', '/api/vs/index/status', '/ws', '/api/external/leaderboard', '/api/deposit/chain']) {
    assert.equal(matchRoute(routes, 'GET', blocked), null, `${blocked} is not served in hosted mode`);
  }
  assert.ok(routeRegExp('/api/x/:id').test('/api/x/7') && !routeRegExp('/api/x/:id').test('/api/x/'));
});

test('the API stand-in gates like the hosted server', async () => {
  const api = await startMockApi({ port: await freePort(), secret: SECRET });
  try {
    const h = { 'x-origin-verify': SECRET };
    assert.equal((await fetch(`${api.url}/api/health`)).status, 200, 'health needs no secret');
    assert.equal((await fetch(`${api.url}/api/vs/explore`)).status, 403);
    assert.equal((await fetch(`${api.url}/api/vs/explore`, { headers: { 'x-origin-verify': 'wrong' } })).status, 403);
    const explore = await fetch(`${api.url}/api/vs/explore`, { headers: h });
    assert.equal(explore.status, 200);
    assert.equal((await explore.json()).code, 'not_available');
    assert.equal((await fetch(`${api.url}/api/vs/trader?venue=sodex`, { headers: h })).status, 404);
    assert.equal((await fetch(`${api.url}/api/vs/leaderboard?venue=a&venue=b`, { headers: h })).status, 400);
    assert.equal((await fetch(`${api.url}/api/vs/leaderboard`, { method: 'POST', headers: h })).status, 404);
  } finally {
    await api.close();
  }
});

test('the egress guard refuses every connection that is not to this machine, and allows loopback', async () => {
  const local = await listen((_req, res) => res.end('local'));
  const dir = mkdtempSync(join(tmpdir(), 'vs-smoke-guard-'));
  const logFile = join(dir, 'refused.txt');
  const script = join(dir, 'probe.mjs');
  // Names under .invalid can never resolve - and with the guard they are never even looked up.
  // Every way the server reaches out: fetch, raw sockets, TLS, the http(s) agents
  // (they pass `path: null` - once mistaken for a pipe and let through), HTTP/2,
  // the built-in WebSocket and the `ws` package the trade streams use.
  writeFileSync(script, `
    import net from 'node:net';
    import tls from 'node:tls';
    import http from 'node:http';
    import https from 'node:https';
    import http2 from 'node:http2';
    import { createRequire } from 'node:module';
    const out = {};
    const settle = (p) => Promise.race([
      p.then(() => 'CONNECTED', (e) => String(e?.cause?.message ?? e?.message ?? e)),
      new Promise((r) => setTimeout(() => r('HUNG'), 8000)),
    ]);
    out.fetchHttps = await settle(fetch('https://exchange.invalid/info'));
    out.fetchHttp = await settle(fetch('http://exchange.invalid:8080/'));
    out.fetchIp = await settle(fetch('http://192.0.2.1:81/'));
    out.net = await settle(new Promise((res, rej) => { const s = net.connect(443, 'stream.invalid'); s.once('connect', res); s.once('error', rej); }));
    out.netNullPath = await settle(new Promise((res, rej) => { const s = net.connect({ port: 443, host: 'opts.invalid', path: null }); s.once('connect', res); s.once('error', rej); }));
    out.tls = await settle(new Promise((res, rej) => { const s = tls.connect({ host: 'tls.invalid', port: 443 }); s.once('secureConnect', res); s.once('error', rej); }));
    out.httpsAgent = await settle(new Promise((res, rej) => { https.get('https://agent.invalid/x', res).once('error', rej); }));
    out.httpAgent = await settle(new Promise((res, rej) => { http.get('http://agent.invalid/x', res).once('error', rej); }));
    out.http2 = await settle(new Promise((res, rej) => { const c = http2.connect('https://h2.invalid'); c.once('connect', res); c.once('error', rej); }));
    out.websocket = await settle(new Promise((res, rej) => { const w = new WebSocket('wss://ws.invalid/ws'); w.onopen = res; w.onerror = () => rej(new Error('websocket error')); }));
    try {
      const { WebSocket: Ws } = createRequire(${JSON.stringify(pathToFileURL(join(HERE, '..', '..', 'apps', 'server', 'package.json')).href)})('ws');
      out.wsPackage = await settle(new Promise((res, rej) => { const w = new Ws('wss://wspkg.invalid/ws'); w.once('open', res); w.once('error', rej); }));
    } catch (e) {
      out.wsPackage = 'not installed';
    }
    out.loopback = await settle(fetch('http://127.0.0.1:${local.port}/').then((r) => r.text()).then((t) => { if (t !== 'local') throw new Error('wrong body'); }));
    out.refused = [...globalThis.__smokeNetGuard.refused].sort();
    console.log(JSON.stringify(out));
    process.exit(0);
  `);
  try {
    // Asynchronously: the loopback server the probe calls lives in THIS process.
    const r = await new Promise((done) => {
      const child = spawn(process.execPath, ['--import', pathToFileURL(join(HERE, 'net-guard.mjs')).href, script], {
        env: { ...process.env, SMOKE_NET_GUARD_LOG: logFile }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      const timer = setTimeout(() => child.kill(), 120_000);
      child.once('exit', (status) => { clearTimeout(timer); done({ status, stdout, stderr }); });
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').at(-1));
    for (const k of ['fetchHttps', 'fetchHttp', 'fetchIp', 'net', 'netNullPath', 'tls', 'httpsAgent', 'httpAgent', 'http2']) {
      assert.match(out[k], /smoke net-guard: outbound connection to .* refused/, `${k}: ${out[k]}`);
    }
    assert.equal(out.websocket, 'websocket error');
    if (out.wsPackage !== 'not installed') assert.match(out.wsPackage, /smoke net-guard: outbound connection to wspkg\.invalid:443 refused/);
    assert.equal(out.loopback, 'CONNECTED', 'loopback still works');
    const expected = ['192.0.2.1:81', 'agent.invalid:443', 'agent.invalid:80', 'exchange.invalid:443', 'exchange.invalid:8080', 'h2.invalid:443',
      'opts.invalid:443', 'stream.invalid:443', 'tls.invalid:443', 'ws.invalid:443', ...(out.wsPackage === 'not installed' ? [] : ['wspkg.invalid:443'])].sort();
    assert.deepEqual(out.refused, expected);
    assert.deepEqual(readFileSync(logFile, 'utf8').trim().split('\n').sort(), expected, 'what was refused is written down for the report');
  } finally {
    await local.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a deployed site: the header check passes on the stand-in and names every difference elsewhere', async () => {
  const dir = site();
  const edge = await startStaticServer({ dist: dir, port: await freePort() });
  // A host that serves the bytes and nothing of the policy: what a mis-attached behaviour looks like.
  const bare = await listen((req, res) => {
    res.writeHead(200, { 'content-type': req.url.endsWith('.js') ? 'text/plain' : 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    res.end('x');
  });
  try {
    const paths = ['/', '/trade', '/scan/', '/favicon.svg', '/assets/index-abc.js', '/assets/worker-def.js', '/logos/BTC.svg', '/trade'];
    const good = await checkDeployedHeaders(edge.url, paths);
    assert.equal(good.length, paths.length - 1, 'a path is asked once');
    assert.deepEqual(good.flatMap((r) => r.problems.map((p) => `${r.path}: ${p}`)), []);

    // The fixture has no robots.txt: a file that is not published is a 403 from the bucket.
    const missing = await checkDeployedHeaders(edge.url, ['/robots.txt']);
    assert.equal(missing[0].status, 403);
    assert.equal(missing[0].problems[0], 'answered 403');

    const bad = await checkDeployedHeaders(`http://127.0.0.1:${bare.port}`, ['/', '/assets/index-abc.js', '/logos/BTC.svg']);
    for (const h of ['Content-Security-Policy', 'Strict-Transport-Security', 'X-Frame-Options', 'X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy', 'Cross-Origin-Opener-Policy', 'Cross-Origin-Resource-Policy']) {
      assert.ok(bad[0].problems.includes(`${h} is missing`), `${h}: ${bad[0].problems.join(' | ')}`);
    }
    assert.ok(!bad[0].problems.some((p) => p.startsWith('Cache-Control')), 'no-cache is right for the shell');
    assert.ok(bad[1].problems.some((p) => p === 'Cache-Control is "no-cache", expected "public, max-age=31536000, immutable"'), bad[1].problems.join(' | '));
    assert.ok(bad[1].problems.some((p) => p.startsWith('a script served as "text/plain"')));
    assert.ok(bad[2].problems.some((p) => p.startsWith('Cache-Control is "no-cache", expected "public, max-age=86400')));

    const down = await checkDeployedHeaders(`http://127.0.0.1:${await freePort()}`, ['/']);
    assert.equal(down[0].status, null);
    assert.match(down[0].problems[0], /^no answer: /);
  } finally {
    await edge.close();
    await bare.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a deployed site: http only ever redirects to https', async () => {
  assert.equal((await checkHttpsRedirect('http://127.0.0.1:4280')).ok, true, 'a site without TLS (the local stand-in) is not judged');
  // The check asks http://<host of the site>/trade: the same port, here, plays port 80.
  const redirects = await listen((req, res) => { res.writeHead(301, { location: `https://${req.headers.host}${req.url}` }); res.end(); });
  const serves = await listen((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html>'); });
  const elsewhere = await listen((_req, res) => { res.writeHead(302, { location: 'https://somewhere.invalid/' }); res.end(); });
  try {
    const good = await checkHttpsRedirect(`https://127.0.0.1:${redirects.port}`);
    assert.equal(good.ok, true, good.note);
    assert.match(good.note, /^http answers 301 -> https:\/\/127\.0\.0\.1:\d+\/trade$/);
    const bad = await checkHttpsRedirect(`https://127.0.0.1:${serves.port}`);
    assert.equal(bad.ok, false);
    assert.match(bad.note, /answered 200, expected a redirect to https/);
    assert.equal((await checkHttpsRedirect(`https://127.0.0.1:${elsewhere.port}`)).ok, false, 'a redirect to another host is not it');
    const closed = await checkHttpsRedirect(`https://127.0.0.1:${await freePort()}`);
    assert.equal(closed.ok, true, 'no listener on http is as good as a redirect');
    assert.match(closed.note, /^http does not answer/);
  } finally {
    await redirects.close();
    await serves.close();
    await elsewhere.close();
  }
});

test('a deployed site: the origin must be closed to everyone but the edge', async () => {
  const apiLike = await listen((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  const caddy80 = await listen((req, res) => { res.writeHead(308, { location: `https://origin.invalid${req.url}` }); res.end(); });
  const closed = await freePort();
  try {
    // A correct origin from outside: nothing on 443, nothing on the API port, port 80 redirects.
    const good = await probeOrigin('127.0.0.1', { tlsPort: closed, apiPort: closed, executorPort: closed, httpPort: caddy80.port, timeoutMs: 1500 });
    assert.deepEqual(good.problems, []);
    assert.match(good.checks.tls, /^closed \(/);
    assert.match(good.checks.api, /^closed \(/);
    assert.match(good.checks.executor, /^closed \(/);
    assert.equal(good.checks.http, 'answers 308 -> https://origin.invalid/api/health');

    // Port 80 closed as well is fine.
    const dark = await probeOrigin('127.0.0.1', { tlsPort: closed, apiPort: closed, executorPort: closed, httpPort: closed, timeoutMs: 1500 });
    assert.deepEqual(dark.problems, []);
    assert.match(dark.checks.http, /^closed \(/);

    // An origin open to the world: each of the four is named.
    const open = await probeOrigin('127.0.0.1', { tlsPort: apiLike.port, apiPort: apiLike.port, executorPort: apiLike.port, httpPort: apiLike.port, timeoutMs: 1500 });
    assert.equal(open.checks.tls, 'open');
    assert.equal(open.problems.length, 4, open.problems.join(' | '));
    assert.match(open.problems[0], /security group is not limited to CloudFront/);
    assert.match(open.problems[1], /the API must listen on loopback only/);
    assert.match(open.problems[2], /the copy executor must listen on loopback only/);
    assert.match(open.problems[3], /served in clear text/);

    // Behind Vercel 443 is open on purpose: the gate is what is judged.
    const edgeValue = 'e'.repeat(40);
    const gated = await listen((req, res) => {
      const ok = req.headers['x-origin-verify'] === edgeValue;
      res.writeHead(ok ? 200 : 403, { 'content-type': 'application/json' });
      res.end(ok ? '{"ok":true}' : '{"error":"forbidden"}');
    });
    try {
      // A closed port taken while `gated` listens: the one taken above was free then and could be the very port
      // `gated` was given (GitHub CI, v0.2.125: 37373 was both, and "closed" answered).
      const shut = await freePort();
      const v = await probeOrigin('127.0.0.1', { edge: 'vercel', tlsPort: gated.port, apiPort: shut, executorPort: shut, httpPort: caddy80.port, timeoutMs: 1500, tlsScheme: 'http' });
      assert.deepEqual(v.problems, []);
      assert.equal(v.checks.tls, 'open');
      assert.equal(v.checks.gateHealth, 'answers 403 without the secret');
      assert.equal(v.checks.gateIndex, 'answers 403 without the secret');
      assert.equal(v.checks.gateCopy, 'answers 403 without the secret');
      // ... and an origin that serves without the secret is named, once per route asked.
      const ungated = await probeOrigin('127.0.0.1', { edge: 'vercel', tlsPort: apiLike.port, apiPort: shut, executorPort: shut, httpPort: shut, timeoutMs: 1500, tlsScheme: 'http' });
      assert.equal(ungated.problems.length, 3, ungated.problems.join(' | '));
      assert.match(ungated.problems[0], /Caddy gate \(X-Origin-Verify\) is not in effect/);
      assert.match(ungated.problems[2], /\/api\/copy\/v1\/health answers 200 without the origin secret/);
    } finally {
      await gated.close();
    }

    // A name that does not resolve is a mistake in the command, never a pass.
    const typo = await probeOrigin('origin.invalid', { timeoutMs: 1500 });
    assert.equal(typo.problems.length, 1);
    assert.match(typo.problems[0], /origin\.invalid does not resolve/);
    assert.equal(typo.checks.tls, 'not asked');
  } finally {
    await apiLike.close();
    await caddy80.close();
  }
});

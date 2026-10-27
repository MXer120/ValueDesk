/**
 * Local mode's Host check (audit S-12, DNS rebinding): src/localHost.ts.
 *
 * A page whose hostname was re-pointed at 127.0.0.1 is same-origin with this
 * server, so CORS never applies - but its Host header is still its own name.
 * Covers the header rule, the gate on a real Fastify app (every method, a
 * CORS preflight, an unknown path), a real listening server (a WebSocket
 * upgrade goes through the same hook; a missing Host; the socket is closed),
 * the log throttle, hosted mode being left alone, and index.ts installing the
 * gate first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';

import { DEFAULT_LIMITS, HOSTED_ROUTES, installHostedGate, isLoopbackHost, type HostedConfig } from '../src/hosted.js';
import { LOCAL_HOST_REFUSED_STATUS, installLocalHostGate, isLocalHostHeader } from '../src/localHost.js';

const INDEX_SRC = fileURLToPath(new URL('../src/index.ts', import.meta.url));

// --- the header rule -----------------------------------------------------------------

test('local host: the three loopback names, any case, any port', () => {
  for (const h of [
    '127.0.0.1:8797', 'localhost:8797', 'LOCALHOST:8797', 'Localhost:5180', '[::1]:8797',
    // What a dev proxy that keeps the browser's Host forwards (Vite's /ws entry): another port.
    'localhost:5180', '127.0.0.1:5180', '[::1]:5180',
    // No port, and the ends of the port range.
    '127.0.0.1', 'localhost', '[::1]', '127.0.0.1:1', 'localhost:65535',
  ]) {
    assert.equal(isLocalHostHeader(h), true, h);
  }
});

test('local host: anything else is refused - a rebinding page always has its own name', () => {
  const refused: unknown[] = [
    // No Host at all, or not a string.
    undefined, null, '', ['localhost:8797'], 8797, {},
    // The attacker's name, however it is dressed up.
    'evil.example:8797', 'evil.example', 'attacker.test:80',
    '127.0.0.1.evil.example:8797', '127.0.0.1.evil.example', 'localhost.evil.example', 'localhost.evil.example:8797',
    'evil-localhost:8797', 'notlocalhost', 'xlocalhost:8797', 'localhost.', 'localhost.:8797', 'app.localhost:5180',
    // Userinfo, paths, fragments, lists, whitespace: not a bare authority.
    'localhost@evil.example', 'localhost:8797@evil.example', 'evil.example#localhost', 'localhost:8797/x',
    'localhost,evil.example', 'localhost:8797, evil.example', ' localhost:8797', 'localhost :8797', 'localhost:8797\n', 'localhost\u0000',
    // Ports that are not ports.
    '127.0.0.1:0', '127.0.0.1:65536', '127.0.0.1:999999', '127.0.0.1:', '127.0.0.1:80a', 'localhost:-1',
    'localhost:\u0661\u0662\u0663', '127.0.0.1:\uff18\uff17\uff19\uff17',
    // Case folding must not widen it (U+017F folds to "s" under /iu).
    'localho\u017ft:8797',
    // Other spellings of the same machine, and other machines: not needed, so not allowed.
    '127.0.0.2:8797', '127.1', '0.0.0.0:8797', '2130706433', '0x7f.0.0.1', '10.0.0.5:8797', '192.168.1.2:5180',
    '::1', '::1:8797', '[::2]', '[::1]x', '[0:0:0:0:0:0:0:1]:8797', '[::ffff:127.0.0.1]:8797',
  ];
  for (const h of refused) assert.equal(isLocalHostHeader(h), false, JSON.stringify(h));
});

test('local host: separate from hosted mode\'s isLoopbackHost, which keeps its wider rule', () => {
  // The on-instance check hosted mode uses must not change: it still takes all of 127.0.0.0/8.
  assert.equal(isLoopbackHost('127.0.0.2:8797'), true);
  assert.equal(isLocalHostHeader('127.0.0.2:8797'), false);
});

// --- the gate on an app ----------------------------------------------------------------

const ROUTE_HITS: string[] = [];

/** As index.ts has it: the gate first, then CORS for the loopback dev origins, then the routes. */
async function localApp(hosted = false, logger?: { stream: Writable }): Promise<FastifyInstance> {
  const app = Fastify(logger ? { logger: { level: 'warn', stream: logger.stream } } : {});
  installLocalHostGate(app, hosted);
  await app.register(cors, {
    origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/],
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  });
  app.get('/api/health', async () => { ROUTE_HITS.push('GET /api/health'); return { ok: true, tokenFile: 'C:/secret/token' }; });
  app.get('/api/vs/leaderboard', async () => { ROUTE_HITS.push('GET /api/vs/leaderboard'); return { rows: ['0x' + '1'.repeat(40)] }; });
  app.post('/api/trade/perps/order', async () => { ROUTE_HITS.push('POST /api/trade/perps/order'); return { sent: true }; });
  app.delete('/api/scan/track', async () => { ROUTE_HITS.push('DELETE /api/scan/track'); return { removed: true }; });
  await app.ready();
  ROUTE_HITS.length = 0;
  return app;
}

test('local gate: a loopback Host passes, whatever the port', async () => {
  const app = await localApp();
  try {
    for (const host of ['127.0.0.1:8797', 'localhost:8797', 'LOCALHOST:8797', '[::1]:8797', 'localhost:5180', '127.0.0.1:5180', 'localhost']) {
      const r = await app.inject({ method: 'GET', url: '/api/health', headers: { host } });
      assert.equal(r.statusCode, 200, host);
      assert.equal(r.json().ok, true, host);
    }
    // inject's own default Host (localhost:80) is a local one too.
    assert.equal((await app.inject({ method: 'GET', url: '/api/vs/leaderboard' })).statusCode, 200);
    // And the gate does not touch what the router says about a path that is not there.
    assert.equal((await app.inject({ method: 'GET', url: '/nope', headers: { host: 'localhost:8797' } })).statusCode, 404);
  } finally {
    await app.close();
  }
});

test('local gate: a foreign Host is a 421 in the usual error shape, and no route runs', async () => {
  const app = await localApp();
  try {
    for (const host of ['evil.example:8797', 'evil.example', '127.0.0.1.evil.example:8797', 'localhost.evil.example', 'localhost@evil.example', '0.0.0.0:8797', '127.0.0.2:8797']) {
      const r = await app.inject({ method: 'GET', url: '/api/health', headers: { host } });
      assert.equal(r.statusCode, LOCAL_HOST_REFUSED_STATUS, host);
      assert.equal(r.statusCode, 421);
      const body = r.json();
      assert.equal(body.error, 'host not allowed');
      assert.equal(body.source, 'server');
      assert.equal(typeof body.hint, 'string');
      // Nothing of the route, and the attacker's header is not echoed back.
      assert.ok(!r.body.includes('tokenFile') && !r.body.includes('secret'), host);
      assert.ok(!r.body.includes(host), host);
      // The connection is not kept alive for it.
      assert.equal(r.headers.connection, 'close', host);
    }
    assert.deepEqual(ROUTE_HITS, []);
  } finally {
    await app.close();
  }
});

test('local gate: the S-12 page - its own Host, same Origin after the rebind, a forged forward header', async () => {
  const app = await localApp();
  try {
    const rebound = {
      host: 'rebind.evil.example:8797',
      origin: 'http://rebind.evil.example:8797',
      referer: 'http://rebind.evil.example:8797/page',
    };
    for (const headers of [
      rebound,
      { ...rebound, 'x-forwarded-host': 'localhost:8797' },
      { ...rebound, forwarded: 'host=localhost:8797' },
      { ...rebound, 'sec-fetch-site': 'same-origin' },
    ]) {
      for (const url of ['/api/health', '/api/vs/leaderboard?window=7d']) {
        const r = await app.inject({ method: 'GET', url, headers });
        assert.equal(r.statusCode, 421, `${url} ${JSON.stringify(headers)}`);
        assert.ok(!r.body.includes('0x1111'), url);
      }
    }
    assert.deepEqual(ROUTE_HITS, []);
  } finally {
    await app.close();
  }
});

test('local gate: every method, a CORS preflight and an unknown path are refused for a foreign Host', async () => {
  const app = await localApp();
  try {
    const methods = ['GET', 'HEAD', 'POST', 'DELETE', 'OPTIONS'] as const;
    for (const method of methods) {
      for (const url of ['/api/health', '/api/trade/perps/order', '/api/scan/track', '/nope']) {
        const r = await app.inject({ method, url, headers: { host: 'evil.example:8797' } });
        assert.equal(r.statusCode, 421, `${method} ${url}`);
      }
    }
    // A preflight that would otherwise be answered for a loopback dev origin.
    const pre = await app.inject({
      method: 'OPTIONS',
      url: '/api/trade/perps/order',
      headers: { host: 'evil.example:8797', origin: 'http://localhost:5180', 'access-control-request-method': 'POST' },
    });
    assert.equal(pre.statusCode, 421);
    assert.equal(pre.headers['access-control-allow-origin'], undefined);
    // The same preflight with a local Host still gets its CORS answer.
    const ok = await app.inject({
      method: 'OPTIONS',
      url: '/api/trade/perps/order',
      headers: { host: 'localhost:8797', origin: 'http://localhost:5180', 'access-control-request-method': 'POST' },
    });
    assert.equal(ok.statusCode, 204);
    assert.equal(ok.headers['access-control-allow-origin'], 'http://localhost:5180');
    assert.deepEqual(ROUTE_HITS, []);
  } finally {
    await app.close();
  }
});

test('local gate: a refusal is logged once per interval, with a bounded copy of the Host', async () => {
  const lines: string[] = [];
  const stream = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } });
  const app = await localApp(false, { stream });
  try {
    for (let i = 0; i < 25; i++) await app.inject({ method: 'GET', url: '/api/health', headers: { host: i === 0 ? `${'a'.repeat(500)}.example` : 'evil.example:8797' } });
    await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'localhost:8797' } });
    const warns = lines.map((l) => JSON.parse(l) as { host: string | null; msg: string; suppressed: number });
    assert.equal(warns.length, 1, 'one line however many requests');
    assert.equal(warns[0]!.host!.length, 100);
    assert.match(warns[0]!.msg, /Host is not localhost/);
    assert.equal(warns[0]!.suppressed, 0);
  } finally {
    await app.close();
  }
});

// --- hosted mode is left alone ------------------------------------------------------------------

test('hosted: the local gate does nothing, the public Host reaches the hosted gate as before', async () => {
  const SITE = 'https://app.valuedesk.example';
  const cfg: HostedConfig = { enabled: true, trustProxy: false, originSecrets: [], limits: DEFAULT_LIMITS };
  const app = Fastify();
  installLocalHostGate(app, true);
  for (const r of HOSTED_ROUTES) app.route({ method: r.method, url: r.url, handler: async () => ({ ok: true }) });
  app.get('/api/vs/index/status', async () => ({ leaked: true }));
  installHostedGate(app, { cfg, site: [SITE] });
  await app.ready();
  try {
    for (const host of ['api.valuedesk.example', 'origin.valuedesk.example:443', 'evil.example:8797', 'localhost:8797']) {
      const listed = await app.inject({ method: 'GET', url: '/api/vs/leaderboard?window=7d', headers: { host } });
      assert.equal(listed.statusCode, 200, host);
      // The hosted gate's own answers, not the local gate's.
      const unlisted = await app.inject({ method: 'GET', url: '/api/vs/index/status', headers: { host } });
      assert.equal(unlisted.statusCode, 404, host);
      assert.deepEqual(unlisted.json(), { error: 'not found', source: 'server' }, host);
    }
  } finally {
    await app.close();
  }
});

test('index.ts installs the gate once, with HOSTED, before CORS and every route', () => {
  const src = readFileSync(INDEX_SRC, 'utf8');
  const calls = [...src.matchAll(/installLocalHostGate\(/g)];
  assert.equal(calls.length, 1, 'one call');
  const call = src.indexOf('installLocalHostGate(app, HOSTED);');
  assert.ok(call > 0, 'called with HOSTED, so hosted mode is a no-op');
  assert.ok(call < src.indexOf('await app.register(cors'), 'before CORS');
  assert.ok(call < src.indexOf('await app.register(marketRoutes)'), 'before the routes');
  assert.match(src, /import \{ installLocalHostGate \} from '\.\/localHost\.js';/);
});

// --- a real listening server ----------------------------------------------------------------------

async function listening(): Promise<{ app: FastifyInstance; port: number; sockets: Set<Socket> }> {
  const app = Fastify();
  // As index.ts has it: the gate first, the WebSocket plugin after it.
  installLocalHostGate(app, false);
  await app.register(websocket);
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/ws', { websocket: true }, (socket) => { socket.send('welcome'); });
  const sockets = new Set<Socket>();
  app.server.on('connection', (s: Socket) => { sockets.add(s); s.once('close', () => sockets.delete(s)); });
  await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, port: (app.server.address() as AddressInfo).port, sockets };
}

/** app.close() must finish: a refused upgrade that left its socket open would hold it up for good. */
async function shutDown(app: FastifyInstance, sockets: Set<Socket>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const hung = new Promise<'hung'>((resolve) => { timer = setTimeout(() => resolve('hung'), 3000); });
  const result = await Promise.race([app.close().then(() => 'closed' as const), hung]);
  clearTimeout(timer);
  if (result === 'hung') for (const s of sockets) s.destroy(); // let the test process end
  assert.equal(result, 'closed', 'app.close() hung - a socket is still open');
  // A socket's 'close' event can trail the server's by a moment.
  for (let i = 0; i < 20 && sockets.size; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(sockets.size, 0, 'no connection is left behind');
}

function httpGet(port: number, path: string, host: string): Promise<{ status: number; body: string; connection: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers: { Host: host }, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, connection: res.headers.connection }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Write raw bytes, read until the server closes the socket (or `ms` passes). */
function rawExchange(port: number, request: string, ms = 3000): Promise<{ text: string; closed: boolean }> {
  return new Promise((resolve) => {
    const sock = connect(port, '127.0.0.1');
    let text = '';
    let done = false;
    const finish = (closed: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve({ text, closed });
    };
    const timer = setTimeout(() => finish(false), ms);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(request));
    sock.on('data', (d: string) => { text += d; });
    sock.on('close', () => finish(true));
    sock.on('error', () => finish(true));
  });
}

const UPGRADE = (host: string | null) =>
  `GET /ws HTTP/1.1\r\n${host === null ? '' : `Host: ${host}\r\n`}Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`;

test('real server: HTTP by Host over a socket, a missing Host included', async () => {
  const { app, port, sockets } = await listening();
  try {
    const ok = await httpGet(port, '/api/health', `127.0.0.1:${port}`);
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), { ok: true });
    // A Host with the browser's dev-server port, as a proxy that keeps it forwards.
    assert.equal((await httpGet(port, '/api/health', 'localhost:5180')).status, 200);

    const bad = await httpGet(port, '/api/health', `evil.example:${port}`);
    assert.equal(bad.status, 421);
    assert.equal(bad.connection, 'close');
    assert.equal(JSON.parse(bad.body).error, 'host not allowed');
    assert.equal((await httpGet(port, '/api/health', `127.0.0.1.evil.example:${port}`)).status, 421);

    // HTTP/1.0 may leave Host out (HTTP/1.1 without one never reaches Fastify: Node answers 400).
    const none = await rawExchange(port, 'GET /api/health HTTP/1.0\r\n\r\n');
    assert.match(none.text, /^HTTP\/1\.1 421 /);
    assert.ok(none.closed, 'the socket is closed after it');
    assert.ok(!none.text.includes('"ok":true'));
  } finally {
    await shutDown(app, sockets);
  }
});

test('real server: a WebSocket upgrade goes through the same Host check', async () => {
  const { app, port, sockets } = await listening();
  const url = `ws://127.0.0.1:${port}/ws`;
  const open = (headers?: Record<string, string>) => new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(url, headers ? { headers } : undefined);
    ws.once('message', (m) => { ws.close(); resolve(String(m)); });
    ws.once('unexpected-response', (_req, res) => { ws.terminate(); reject(new Error(`status ${res.statusCode}`)); });
    ws.once('error', reject);
  });
  try {
    // The client's own Host (127.0.0.1:<port>) and the Host the Vite dev proxy forwards on /ws.
    assert.equal(await open(), 'welcome');
    assert.equal(await open({ Host: 'localhost:5180' }), 'welcome');
    assert.equal(await open({ Host: '127.0.0.1:5180' }), 'welcome');
    // The rebinding page's own name: refused at the handshake.
    await assert.rejects(open({ Host: `evil.example:${port}` }), /status 421/);
    await assert.rejects(open({ Host: `127.0.0.1.evil.example:${port}` }), /status 421/);

    // And the refused handshake does not leave a socket behind.
    const refused = await rawExchange(port, UPGRADE(`evil.example:${port}`));
    assert.match(refused.text, /^HTTP\/1\.1 421 /);
    assert.ok(!/101 Switching/.test(refused.text));
    assert.ok(refused.closed, 'the socket is closed after the 421');
    const none = await rawExchange(port, UPGRADE(null).replace('HTTP/1.1', 'HTTP/1.0'));
    assert.match(none.text, /^HTTP\/1\.[01] 421 /);
  } finally {
    await shutDown(app, sockets);
  }
});

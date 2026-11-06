/**
 * The Blind Box public reads (routes/sodexLottery.ts). Upstream is stubbed: nothing leaves the machine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { DEFAULT_LIMITS, HOSTED_ROUTES, installHostedGate, type HostedConfig } from '../src/hosted.js';
import { FEED_LIMIT_MAX, feedLimit, sodexLotteryRoutes } from '../src/routes/sodexLottery.js';

interface Call { url: string; init: RequestInit | undefined }

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: 'open', tsMs: i, wallet: '0x06bd....22d6', level: 'Common', tokenId: i, rewardUsd: '1.00' }));

function stub(answer: (url: string) => Response | Promise<Response>): { calls: Call[]; restore: () => void } {
  const real = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return answer(String(input));
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, msg: 'success', data }), { status: 200 });

async function appWith(): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify();
  await app.register(sodexLotteryRoutes);
  return app;
}

test('feedLimit: clamped to 1..50, a default for anything else', () => {
  assert.equal(feedLimit('3'), 3);
  assert.equal(feedLimit('0'), 1);
  assert.equal(feedLimit('-4'), 1);
  assert.equal(feedLimit('5000'), FEED_LIMIT_MAX);
  assert.equal(feedLimit(undefined), 20);
  assert.equal(feedLimit('abc'), 20);
});

test('feed: cut to the limit here (SoDEX ignores small ones), one upstream read for many callers', async () => {
  const s = stub(() => ok({ minLevel: 'Common', items: rows(80) }));
  const app = await appWith();
  try {
    for (const [q, n] of [['limit=3', 3], ['limit=50', 50], ['limit=999', 50], ['limit=0', 1], ['', 20]] as const) {
      const r = await app.inject({ method: 'GET', url: `/api/vs/sodex/lottery/feed?${q}` });
      assert.equal(r.statusCode, 200, q);
      assert.equal(r.json().items.length, n, q);
      assert.equal(r.json().minLevel, 'Common');
    }
    assert.equal(s.calls.length, 1);
    assert.match(s.calls[0]!.url, /\/feed\?limit=50$/);
  } finally {
    s.restore();
    await app.close();
  }
});

test('reads are plain: no Origin, no token, only an Accept, and only the two public paths', async () => {
  const s = stub(() => ok({ rules: {} }));
  const app = await appWith();
  try {
    await app.inject({ method: 'GET', url: '/api/vs/sodex/lottery/meta', headers: { origin: 'https://sodex.com', authorization: 'Bearer x' } });
    const c = s.calls[0]!;
    assert.match(c.url, /^https:\/\/mainnet-lottery\.sodex\.dev\/api\/v1\/lottery\/meta$/);
    const headers = new Headers(c.init?.headers);
    assert.equal(headers.get('origin'), null);
    assert.equal(headers.get('authorization'), null);
    assert.equal(headers.get('accept'), 'application/json');
    assert.ok(c.init?.signal, 'every read has a timeout');
    assert.equal((await app.inject({ method: 'GET', url: '/api/vs/sodex/lottery/boxes' })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: '/api/vs/sodex/lottery/box/open', payload: {} })).statusCode, 404);
  } finally {
    s.restore();
    await app.close();
  }
});

test('a failing upstream is a 502 with no invented data', async () => {
  const s = stub(() => new Response('nope', { status: 500 }));
  const app = await appWith();
  try {
    const r = await app.inject({ method: 'GET', url: '/api/vs/sodex/lottery/meta' });
    assert.equal(r.statusCode, 502);
    assert.equal(r.json().source, 'sodex');
    assert.equal(r.json().rules, undefined);
  } finally {
    s.restore();
    await app.close();
  }
});

test('an envelope with a non-zero code is a failure, whatever the HTTP status', async () => {
  const s = stub(() => new Response(JSON.stringify({ code: -1, msg: 'down' }), { status: 200 }));
  const app = await appWith();
  try {
    const r = await app.inject({ method: 'GET', url: '/api/vs/sodex/lottery/feed?limit=5' });
    assert.equal(r.statusCode, 502);
    assert.equal(r.json().error, 'down');
  } finally {
    s.restore();
    await app.close();
  }
});

test('wealth maintenance: the flag only, from wealth.sodex.dev; a failure is a 502', async () => {
  const s = stub(() => ok({ status: 'MAINTENANCE', message: 'soon', updatedAt: 'x', extra: 1 }));
  const app = await appWith();
  try {
    const r = await app.inject({ method: 'GET', url: '/api/vs/sodex/wealth/maintenance' });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { status: 'MAINTENANCE', message: 'soon', updatedAt: 'x' });
    assert.equal(s.calls[0]!.url, 'https://wealth.sodex.dev/api/v1/wealth/maintenance');
    assert.equal(new Headers(s.calls[0]!.init?.headers).get('origin'), null);
  } finally {
    s.restore();
    await app.close();
  }
  const s2 = stub(() => new Response('nope', { status: 500 }));
  const app2 = await appWith();
  try {
    assert.equal((await app2.inject({ method: 'GET', url: '/api/vs/sodex/wealth/maintenance' })).statusCode, 502);
  } finally {
    s2.restore();
    await app2.close();
  }
});

test('hosted gate: the routes answer in hosted mode, as `read`', async () => {
  const s = stub(() => ok({ minLevel: 'Common', items: rows(2), rules: {} }));
  const cfg: HostedConfig = { enabled: true, trustProxy: false, originSecrets: [], limits: { ...DEFAULT_LIMITS } };
  const app = Fastify();
  await app.register(sodexLotteryRoutes);
  app.get('/api/vs/sodex/lottery/other', async () => ({ leaked: true }));
  installHostedGate(app, { cfg, site: ['https://app.valuedesk.example'] });
  await app.ready();
  try {
    for (const url of ['/api/vs/sodex/lottery/meta', '/api/vs/sodex/lottery/feed?limit=2', '/api/vs/sodex/wealth/maintenance']) {
      assert.equal((await app.inject({ method: 'GET', url })).statusCode, 200, url);
    }
    assert.equal((await app.inject({ method: 'GET', url: '/api/vs/sodex/lottery/other' })).statusCode, 404);
    for (const url of ['/api/vs/sodex/lottery/meta', '/api/vs/sodex/lottery/feed', '/api/vs/sodex/wealth/maintenance']) {
      assert.equal(HOSTED_ROUTES.find((r) => r.url === url)?.cls, 'read', url);
    }
  } finally {
    s.restore();
    await app.close();
  }
});

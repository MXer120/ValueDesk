/**
 * Input validation and bounded caches added by the 2026-09-30 security audit
 * (docs/security/AUDIT-2026-09-30.md). Upstream hosts are stubbed: nothing
 * here leaves the machine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

import { _externalCacheSize, externalRoutes } from '../src/routes/external.js';
import { moneyRoutes } from '../src/routes/money.js';
import { statsRoutes } from '../src/routes/stats.js';

/** Answer every upstream call from the test, and count them. */
function stubFetch(): { calls: string[]; restore: () => void } {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const id = Number(/detail\/(\d+)/.exec(url)?.[1] ?? 0);
    return new Response(JSON.stringify({ code: 0, data: { id, title: `t${id}`, body: '<p>x</p>', articles: [] } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test('external: the upstream cache is bounded, whatever ids a caller walks', async () => {
  const s = stubFetch();
  const app = Fastify();
  await app.register(externalRoutes);
  try {
    for (let id = 1; id <= 650; id++) {
      const r = await app.inject({ method: 'GET', url: `/api/external/announcements/${id}` });
      assert.equal(r.statusCode, 200);
    }
    assert.ok(_externalCacheSize() <= 500, `cache holds ${_externalCacheSize()}`);
    assert.equal(s.calls.length, 650);
  } finally {
    s.restore();
    await app.close();
  }
});

test('external: lang, label and page are bounded before anything is fetched', async () => {
  const s = stubFetch();
  const app = Fastify();
  await app.register(externalRoutes);
  try {
    const bad = [
      '/api/external/announcements?lang=' + 'x'.repeat(40),
      '/api/external/announcements?lang=en%26size%3D100000',
      '/api/external/announcements?label=' + 'a'.repeat(65),
      '/api/external/announcements?page=1001',
      '/api/external/announcements/7?lang=../../x',
      '/api/external/leaderboard?page=1001',
    ];
    for (const url of bad) assert.equal((await app.inject({ method: 'GET', url })).statusCode, 400, url);
    assert.equal(s.calls.length, 0, 'a refused request costs no upstream call');
    // What the web actually sends still works.
    for (const url of ['/api/external/announcements?page=1&size=20&lang=en', '/api/external/announcements?page=1&size=20&lang=en&label=Maintenance', '/api/external/announcements/7?lang=en', '/api/external/announcements?lang=zh-CN']) {
      assert.equal((await app.inject({ method: 'GET', url })).statusCode, 200, url);
    }
  } finally {
    s.restore();
    await app.close();
  }
});

test('money overview: the address must be an address before it is spliced into a gateway path', async () => {
  const s = stubFetch();
  const app = Fastify();
  await app.register(moneyRoutes);
  try {
    for (const address of ['../../v1/perps/markets/symbols%3F', '0x123', 'x'.repeat(42), '0x' + 'g'.repeat(40)]) {
      const r = await app.inject({ method: 'GET', url: `/api/money/overview?address=${address}` });
      assert.equal(r.statusCode, 400, address);
    }
    assert.equal(s.calls.length, 0);
  } finally {
    s.restore();
    await app.close();
  }
});

test('stats: the side-effecting GET refuses cross-site and same-site browser requests', async () => {
  const s = stubFetch();
  const app = Fastify();
  await app.register(statsRoutes);
  try {
    // An invalid address: a request that gets past the guard ends in a 400 before any walk starts.
    const url = '/api/stats/all-time?address=not-an-address&rebuild=1';
    for (const site of ['cross-site', 'same-site']) {
      const r = await app.inject({ method: 'GET', url, headers: { 'sec-fetch-site': site } });
      assert.equal(r.statusCode, 403, site);
    }
    for (const headers of [{ 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'none' }, {}]) {
      const r = await app.inject({ method: 'GET', url, headers });
      assert.equal(r.statusCode, 400, JSON.stringify(headers));
    }
    assert.equal(s.calls.length, 0);
  } finally {
    s.restore();
    await app.close();
  }
});

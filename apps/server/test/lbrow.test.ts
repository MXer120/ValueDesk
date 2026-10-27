/**
 * GET /api/vs/lbrow - one Hyperliquid leaderboard row from the index - and the
 * /api/vs/price route now answered by the shared price core. Hyperliquid is
 * stubbed: its leaderboard file and /info candles come from this test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

import { valuedeskRoutes } from '../src/routes/valuedesk.js';

const A1 = '0x85ecf584f25db6f146718b86d493e33c5af72052';
const A2 = '0x8c625ff57d8a4374784c7eff585dfdc42ccec974';
const A3 = '0xf5d81a135f756ca16544e53c20fc20643ec3ad53';
const UNLISTED = '0x' + '9'.repeat(40);

const lbRow = (addr: string, av: string, pnl30: string, name: string | null = null) => ({
  ethAddress: addr,
  accountValue: av,
  windowPerformances: [
    ['day', { pnl: '1.0', roi: '0.01', vlm: '100.0' }],
    ['week', { pnl: '2.0', roi: '0.02', vlm: '200.0' }],
    ['month', { pnl: pnl30, roi: '0.03', vlm: '300.0' }],
    ['allTime', { pnl: '4.0', roi: '0.04', vlm: '400.0' }],
  ],
  prize: 0,
  displayName: name,
});

const LEADERBOARD = {
  leaderboardRows: [
    lbRow(A1, '1000', '500', 'Some Name'),
    lbRow(A2, '2000', '900'),
    lbRow(A3, '3000', '-50'),
  ],
};

/** 30 hourly candles for BTC on the default dex; nothing for any other name. */
const candles = Array.from({ length: 30 }, (_, i) => ({ t: 1_790_000_000_000 + i * 3_600_000, o: '100', h: '110', l: '90', c: String(100 + i) }));

const calls: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  calls.push(url);
  if (url.includes('stats-data.hyperliquid.xyz')) {
    return new Response(JSON.stringify(LEADERBOARD), { status: 200, headers: { 'content-type': 'application/json', etag: '"v1"' } });
  }
  if (url.includes('api.hyperliquid.xyz/info')) {
    const body = JSON.parse(String(init?.body ?? '{}')) as { type?: string; req?: { coin?: string } };
    const rows = body.type === 'candleSnapshot' && body.req?.coin === 'BTC' ? candles : [];
    return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  throw new Error(`unexpected upstream call in a test: ${url}`);
}) as typeof fetch;

async function app() {
  const a = Fastify();
  await a.register(valuedeskRoutes);
  await a.ready();
  return a;
}

test('lbrow: a listed address gets its row - rank by 30d PnL, HL figures - and nothing else', async () => {
  const a = await app();
  try {
    const r = await a.inject({ method: 'GET', url: `/api/vs/lbrow?venue=hyperliquid&address=${A1}` });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.ok, true);
    assert.deepEqual(Object.keys(body.row).sort(), ['accountValue', 'address', 'label', 'pnl', 'rank', 'rankChange', 'roi', 'venue', 'volume']);
    assert.equal(body.row.venue, 'hyperliquid');
    assert.equal(body.row.address, A1);
    assert.equal(body.row.rank, 2, 'A2 has the higher 30-day PnL');
    assert.equal(body.row.pnl['30d'], 500);
    assert.equal(body.row.accountValue, 1000);
    assert.equal(body.row.rankChange, null, 'no previous file yet');
    assert.equal(body.row.label, null, 'display names are never shown (valuedesk/labels.ts)');
    assert.ok(r.body.length < 600, `a small answer (${r.body.length} bytes)`);
    // Mixed-case input is the same address.
    const upper = await a.inject({ method: 'GET', url: `/api/vs/lbrow?venue=HyperLiquid&address=${A2.toUpperCase().replace('0X', '0x')}` });
    assert.equal(upper.json().row.rank, 1);
  } finally {
    await a.close();
  }
});

test('lbrow: an unlisted address is row null, not an error', async () => {
  const a = await app();
  try {
    const r = await a.inject({ method: 'GET', url: `/api/vs/lbrow?venue=hyperliquid&address=${UNLISTED}` });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { ok: true, row: null });
  } finally {
    await a.close();
  }
});

test('lbrow: venue and address are validated before anything is read', async () => {
  const a = await app();
  const before = calls.length;
  try {
    for (const url of [
      `/api/vs/lbrow?address=${A1}`,
      `/api/vs/lbrow?venue=sodex&address=${A1}`,
      `/api/vs/lbrow?venue=hyperliquid&venue=hyperliquid&address=${A1}`,
      '/api/vs/lbrow?venue=hyperliquid',
      '/api/vs/lbrow?venue=hyperliquid&address=0x123',
      `/api/vs/lbrow?venue=hyperliquid&address=${A1}00`,
      '/api/vs/lbrow?venue=hyperliquid&address=../../x',
    ]) {
      const r = await a.inject({ method: 'GET', url });
      assert.equal(r.statusCode, 400, url);
      assert.equal(r.json().ok, false, url);
    }
    assert.equal(calls.length, before, 'no upstream call for a refused request');
  } finally {
    await a.close();
  }
});

test('price: the shared core answers exactly the old shape', async () => {
  const a = await app();
  try {
    const r = await a.inject({ method: 'GET', url: '/api/vs/price?coin=btc&range=7d' });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.deepEqual(Object.keys(body), ['ok', 'coin', 'market', 'source', 'range', 'interval', 'points', 'candles']);
    assert.equal(body.ok, true);
    assert.equal(body.coin, 'BTC');
    assert.equal(body.market, 'BTC');
    assert.equal(body.source, 'Hyperliquid');
    assert.equal(body.range, '7d');
    assert.equal(body.interval, '1h');
    assert.equal(body.candles.length, 30);
    assert.deepEqual(body.points[0], [candles[0]!.t, 100]);
    assert.deepEqual(body.candles[0], [candles[0]!.t, 100, 110, 90, 100]);
    // A bad name and a coin with no history are not_available, as before.
    for (const url of ['/api/vs/price?coin=', '/api/vs/price?coin=BT%20C', '/api/vs/price?coin=NOPE']) {
      const bad = await a.inject({ method: 'GET', url });
      assert.equal(bad.statusCode, 200, url);
      assert.equal(bad.json().ok, false, url);
      assert.equal(bad.json().code, 'not_available', url);
    }
  } finally {
    await a.close();
  }
});

test.after(() => {
  globalThis.fetch = realFetch;
});

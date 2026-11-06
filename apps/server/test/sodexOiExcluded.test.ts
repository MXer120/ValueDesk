/**
 * GET /api/vs/sodex/oi-excluded: per SoDEX market, the size of SoDEX's internal pair. The gateway is
 * stubbed. What matters most: a failure is an error state, never zeros, and is not kept as an answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

import { perfPlugin } from '../src/perf.js';
import { valuedeskRoutes } from '../src/routes/valuedesk.js';
import { sodex } from '../src/sodex/rest.js';
import { internalByCoin, readOiExcluded, sodexInternalAddresses } from '../src/valuedesk/sodex/oiExcluded.js';

const [A, B] = ['0xa', '0xb'];
const pos = (symbol: string, size: string) => ({ symbol, size, positionSide: 'BOTH' });

test('the addresses are the wallets internalWallets.ts flags as SoDEX internal, nothing else', () => {
  assert.deepEqual(sodexInternalAddresses().sort(), [
    '0x296b81e89f8661ab9af6548628ea629b0f2c049f',
    '0xfd09e83f250b11a9f0efd0daa605e890daf67412',
  ]);
});

test('each leg counts by its own absolute size, whether the two offset or not', async () => {
  const bodies: Record<string, unknown> = {
    [`/api/v1/perps/accounts/${A}/positions`]: { positions: [pos('BTC-USD', '-895.34'), pos('SPCX-USD', '-10'), pos('ONLY-USD', '3')] },
    [`/api/v1/perps/accounts/${B}/positions`]: { positions: [pos('BTC-USD', '895.34'), pos('SPCX-USD', '10.5'), pos('FLAT-USD', '0')] },
  };
  const r = await readOiExcluded(async (p) => bodies[p], [A!, B!], () => 123);
  assert.equal(r.at, 123);
  assert.deepEqual(r.sizes, { 'BTC-USD': 1790.68, 'SPCX-USD': 20.5, 'ONLY-USD': 3 });
});

test('an account not answering, or answering with no positions, is an error', async () => {
  await assert.rejects(readOiExcluded(async () => ({ positions: [] }), [A!, B!]), /empty position list/);
  for (const bad of [null, {}, [], { positions: null }, { positions: 'x' }, { positions: [{ symbol: 'BTC-USD' }] }, { positions: [{ symbol: 'BTC-USD', size: 'x' }] }, { positions: [{ size: '1' }] }]) {
    await assert.rejects(readOiExcluded(async (p) => (p.includes(A!) ? { positions: [pos('BTC-USD', '1')] } : bad), [A!, B!]), Error, JSON.stringify(bad));
  }
  await assert.rejects(readOiExcluded(async (p) => {
    if (p.includes(B!)) throw new Error('down');
    return { positions: [pos('BTC-USD', '1')] };
  }, [A!, B!]));
  await assert.rejects(readOiExcluded(async () => ({ positions: [] }), []));
});

test('route: a failure answers ok:false uncached, the next read succeeds and is held', async () => {
  const realGet = sodex.get;
  let reads = 0;
  let failing = true;
  sodex.get = (async (path: string) => {
    reads++;
    if (failing && path.includes('0x296b')) throw new Error('gateway down');
    return { positions: [pos('BTC-USD', path.includes('0x296b') ? '895' : '-895')] };
  }) as typeof sodex.get;
  const a = Fastify();
  await a.register(perfPlugin);
  await a.register(valuedeskRoutes);
  await a.ready();
  try {
    const bad = await a.inject({ method: 'GET', url: '/api/vs/sodex/oi-excluded' });
    assert.equal(bad.statusCode, 200);
    const badBody = bad.json();
    assert.equal(badBody.ok, false);
    assert.equal(badBody.code, 'upstream');
    assert.equal(badBody.sizes, undefined, 'no figures with a failure');
    assert.ok(!/max-age/.test(String(bad.headers['cache-control'] ?? '')), 'a failure is not cached');

    failing = false;
    const before = reads;
    const good = await a.inject({ method: 'GET', url: '/api/vs/sodex/oi-excluded' });
    const body = good.json();
    assert.equal(reads, before + 2, 'the failure was not kept: both accounts read again');
    assert.equal(body.ok, true);
    assert.deepEqual(body.sizes, { 'BTC-USD': 1790 });
    assert.ok(Number.isFinite(body.at));
    assert.equal(good.headers['cache-control'], 'public, max-age=10');

    await a.inject({ method: 'GET', url: '/api/vs/sodex/oi-excluded' });
    assert.equal(reads, before + 2, 'a success is held 15 s');
  } finally {
    sodex.get = realGet;
    await a.close();
  }
});

test('an account answering with no positions is an error, not zero', async () => {
  const get = async (path: string) => (path.includes('/a/') ? { positions: [{ symbol: 'BTC-USD', size: '-1' }] } : { positions: [] });
  await assert.rejects(readOiExcluded(get, ['a', 'b']), /empty position list for b/);
});

test('the pair per coin is one side of the market: the books against the rest read about 100%, not 54%', () => {
  // Measured BTC, 2026-11-06: SoDEX's figure counts both sides, the legs are 895.34 each, the books held 13.9 a side of 13.95 others.
  const byCoin = internalByCoin({ 'BTC-USD': 1790.68 });
  const others = 1818.58 / 2 - byCoin.get('BTC')!;
  assert.ok(Math.abs(others - 13.95) < 0.01, String(others));
  assert.equal(internalByCoin({}).size, 0);
});

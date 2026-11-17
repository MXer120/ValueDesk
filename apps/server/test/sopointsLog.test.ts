/**
 * The SoPoints week log (routes/sopointsLog.ts): every week kept per wallet and season, the newest answer wins, bad
 * posts refused, a rate limit.
 *   npx tsx --test test/sopointsLog.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { SOPOINTS_LOG_LIMIT, SopointsLog, sopointsLogRoutes } from '../src/routes/sopointsLog.js';

const A = '0x20856bB5cb2b473216EF5229C6aE0e8a61B58e85';
const wk = (n: number, points: number) => ({ weekNo: n, weekName: `Week ${n}`, weekStartTime: 1788264000 + (n - 1) * 604800, points, referralPoints: 1, totalBonusPct: 25 });

test('every week of both seasons is kept; a later post replaces the same week', async () => {
  const log = new SopointsLog(':memory:');
  const a = Fastify();
  void a.register(sopointsLogRoutes({ log }));
  const r = await a.inject({ method: 'POST', url: '/api/vs/sopoints/log', payload: { address: A, summary: { totalPoints: 72617 }, layer1: [wk(1, 10), wk(2, 20)], season1: [{ weekName: 'Week 26', weekStartTime: 1784937600, points: 0 }] } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { ok: true, rows: 3 });
  await a.inject({ method: 'POST', url: '/api/vs/sopoints/log', payload: { address: A.toLowerCase(), layer1: [wk(2, 25)] } });
  assert.deepEqual(log.count(), { wallets: 1, weeks: 3, ownVolume: 0 });
});

test('no address or no weeks: refused', async () => {
  const a = Fastify();
  void a.register(sopointsLogRoutes({ log: new SopointsLog(':memory:') }));
  assert.equal((await a.inject({ method: 'POST', url: '/api/vs/sopoints/log', payload: { layer1: [wk(1, 1)] } })).statusCode, 400);
  assert.equal((await a.inject({ method: 'POST', url: '/api/vs/sopoints/log', payload: { address: A } })).statusCode, 400);
});

test('rate limit per client', async () => {
  const a = Fastify();
  void a.register(sopointsLogRoutes({ log: new SopointsLog(':memory:') }));
  let last = 0;
  for (let i = 0; i <= SOPOINTS_LOG_LIMIT.max; i++) last = (await a.inject({ method: 'POST', url: '/api/vs/sopoints/log', payload: { address: A, layer1: [wk(1, 1)] } })).statusCode;
  assert.equal(last, 429);
});

test('own volume per week from the trade history is kept; bad entries skipped; Season 1 summary kept', async () => {
  const log = new SopointsLog(':memory:');
  const a = Fastify();
  void a.register(sopointsLogRoutes({ log }));
  const r = await a.inject({ method: 'POST', url: '/api/vs/sopoints/log', payload: { address: A, ownVolume: [{ season: 'season1', week: 3, volume: 120000.5 }, { season: 'layer1', week: 2, volume: 0 }, { season: 'x', week: 1, volume: 5 }, { season: 'layer1', week: 1.5, volume: 5 }] } });
  assert.deepEqual(r.json(), { ok: true, rows: 2 });
  await a.inject({ method: 'POST', url: '/api/vs/sopoints/log', payload: { address: A, summaryS1: { totalPoints: 900 }, ownVolume: [{ season: 'season1', week: 3, volume: 130000 }] } });
  assert.deepEqual(log.count(), { wallets: 1, weeks: 0, ownVolume: 2 });
});

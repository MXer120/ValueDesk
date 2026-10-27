/**
 * GET /api/vs/builder/volume: one wallet's counted builder volume for the copy
 * executor on the other server. Internal - only the holder of the token gets an
 * answer; everyone else gets the 404 of a path that does not exist.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';

import { testTiers } from '../src/builder/config.js';
import { BuilderService } from '../src/builder/service.js';
import { writeNewKeyFile } from '../src/builder/terms.js';
import { dayOf } from '../src/builder/counting.js';
import { HOSTED_ROUTES } from '../src/hosted.js';
import { builderRoutes } from '../src/routes/builder.js';
import { BUILDER, CHAIN, Clock, FakeSodex, MemoryLog, tempDir } from './builderFakes.js';

const DIR = tempDir('vs-bvolume-');
const TOKEN = 'internal-token-for-tests-0123456789abcdef';
const WALLET = '0x52908400098527886e0f7030069857d2e4169ee7';

async function setup() {
  const dir = join(DIR, `case-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'builder-tiers.json'), JSON.stringify(testTiers(BUILDER)));
  writeNewKeyFile(join(dir, 'builder-terms.key'));
  const clock = new Clock();
  const svc = new BuilderService({ tiersPath: join(dir, 'builder-tiers.json'), keyPath: join(dir, 'builder-terms.key'), dbPath: join(dir, 'builder.db'), chainId: CHAIN, io: new FakeSodex(clock), log: new MemoryLog(), now: clock.now });
  svc.load();
  const today = dayOf(clock.now());
  const add = svc.store!.db.prepare('INSERT INTO days (builder, address, engine, day, micro) VALUES (?, ?, ?, ?, ?)');
  add.run(BUILDER, WALLET, 'perps', today, 1_500 * 1e6);
  add.run(BUILDER, WALLET, 'spot', today - 3, 250 * 1e6);
  add.run(BUILDER, WALLET, 'perps', today - 20, 9_999 * 1e6); // outside a 14-day window
  const app = Fastify();
  await app.register(builderRoutes, { service: svc, internalToken: TOKEN });
  await app.ready();
  return { app, svc };
}

test('builder volume: the token holder gets the wallet\'s volume in the window, both engines', async () => {
  const { app, svc } = await setup();
  try {
    const r = await app.inject({ method: 'GET', url: `/api/vs/builder/volume?address=${WALLET.toUpperCase().replace('0X', '0x')}&builder=${BUILDER}&days=14`, headers: { 'x-internal-token': TOKEN } });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { ok: true, usd: 1_750, days: 14 });
    assert.equal(r.headers['cache-control'], 'no-store, no-transform');
    const all = await app.inject({ method: 'GET', url: `/api/vs/builder/volume?address=${WALLET}&builder=${BUILDER}&days=30`, headers: { 'x-internal-token': TOKEN } });
    assert.equal(all.json().usd, 11_749);
  } finally {
    await app.close();
    svc.stop();
  }
});

test('builder volume: without the token (or with a wrong one) it does not exist; bad input is a 400', async () => {
  const { app, svc } = await setup();
  try {
    const url = `/api/vs/builder/volume?address=${WALLET}&builder=${BUILDER}`;
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url, headers: { 'x-internal-token': `${TOKEN}x` } })).statusCode, 404);
    const h = { 'x-internal-token': TOKEN };
    assert.equal((await app.inject({ method: 'GET', url: `/api/vs/builder/volume?address=nope&builder=${BUILDER}`, headers: h })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: `/api/vs/builder/volume?address=${WALLET}&builder=0`, headers: h })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: `${url}&days=91`, headers: h })).statusCode, 400);
  } finally {
    await app.close();
    svc.stop();
  }
});

test('builder volume: an unset token answers nobody', async () => {
  const { svc } = await setup();
  const app = Fastify();
  await app.register(builderRoutes, { service: svc, internalToken: '' });
  await app.ready();
  try {
    assert.equal((await app.inject({ method: 'GET', url: `/api/vs/builder/volume?address=${WALLET}&builder=${BUILDER}`, headers: { 'x-internal-token': '' } })).statusCode, 404);
  } finally {
    await app.close();
    svc.stop();
  }
});

test('builder volume: the hosted gate lists the route', () => {
  assert.ok(HOSTED_ROUTES.some((r) => r.method === 'GET' && r.url === '/api/vs/builder/volume'));
});

/**
 * The switch, the public SoPoints reads, and the proof that sodex.com/auth is never called while the
 * switch is off. Every network call here is a mock. What it reads for shapes is SoDEX's live v2 answer.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SODEX_POINTS_SIGNIN_LIVE, SODEX_SIGNIN_LIVE, SodexSigninOff, assertPointsSigninLive, assertSigninLive } from './sodexProgrammes';
import { fetchSignInMessage, signInToPoints, verifySignature } from './pointsAuth';
import { NeedsPointsToken, fetchBoostConfig, fetchMyPoints, fetchMyWeeks, fetchVolumeWeights, fetchWeek } from './points';
import type { Eip1193Provider } from './wallet';

const SRC = dirname(fileURLToPath(import.meta.url));
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function capture(answer: (url: string) => unknown): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ code: 0, data: answer(String(input)) }), { status: 200 });
  }) as typeof fetch;
  return urls;
}

const PROVIDER = { request: async () => { throw new Error('no wallet in a test'); } } as unknown as Eip1193Provider;
const ADDR = '0x1111111111111111111111111111111111111111';

test('SoPoints sign-in is on (relay, owner 2026-11-16); the Blind Box sign-in stays off', () => {
  assert.equal(SODEX_POINTS_SIGNIN_LIVE, true);
  assert.doesNotThrow(() => assertPointsSigninLive());
  assert.equal(SODEX_SIGNIN_LIVE, false);
  assert.throws(() => assertSigninLive(), SodexSigninOff);
  assert.doesNotThrow(() => assertSigninLive(true));
});

test('switched off, sign-in refuses before the network', async () => {
  const urls = capture(() => ({}));
  await assert.rejects(signInToPoints(PROVIDER, ADDR, { live: false }), SodexSigninOff);
  await assert.rejects(fetchSignInMessage(ADDR, { live: false }), SodexSigninOff);
  await assert.rejects(verifySignature(ADDR, 'm', '0xs', { live: false }), SodexSigninOff);
  assert.deepEqual(urls, []);
});

test('with no token, the token reads refuse before the network', async () => {
  const urls = capture(() => ({}));
  await assert.rejects(fetchMyPoints(ADDR), NeedsPointsToken);
  await assert.rejects(fetchMyWeeks(ADDR), NeedsPointsToken);
  assert.deepEqual(urls, []);
});

test('sign-in goes through our relay (two calls), with no Origin set by hand', async () => {
  const calls: Array<{ url: string; body: unknown; origin: string | null }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), origin: new Headers(init?.headers).get('origin') });
    return new Response(JSON.stringify(String(url).endsWith('/nonce') ? { ok: true, message: 'sign this' } : { ok: true, accessToken: 'jwt' }), { status: 200 });
  }) as typeof fetch;
  const token = await signInToPoints(PROVIDER, ADDR, { fetchImpl, sign: async () => '0xs' });
  assert.equal(token, 'jwt');
  assert.deepEqual(calls.map((c) => c.url), ['/api/vs/sodex-auth/nonce', '/api/vs/sodex-auth/verify']);
  assert.deepEqual(calls[1]!.body, { address: ADDR, message: 'sign this', signature: '0xs' });
  assert.ok(calls.every((c) => c.origin === null), 'never an Origin set by hand');
});

test('no source file calls sodex.com/auth directly: the relay does', () => {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && /['"`]https?:\/\/(www\.)?sodex\.com\/auth/.test(readFileSync(p, 'utf8'))) hits.push(name);
    }
  };
  walk(SRC);
  assert.deepEqual(hits, []);
});

test('the old relay path is gone from the web', () => {
  assert.ok(!readFileSync(join(SRC, 'pointsAuth.ts'), 'utf8').includes('/api/points'));
});

test('fetchWeek: v2, no wallet in the URL, the API pool as given', async () => {
  const urls = capture(() => ({ weekNo: 10, weekName: 'Week 10', weekStatus: 'LIVE', weekPoolPoints: 1000000, nextWeekStartTime: 1794312000, distributionTime: 1794571200 }));
  const w = await fetchWeek();
  assert.deepEqual(urls, ['https://alpha-biz.sodex.dev/biz/sopoints/v2/week/info']);
  assert.equal(w.weekNo, 10);
  assert.equal(w.weekPoolPoints, 1000000);
});

test('fetchBoostConfig: v2', async () => {
  const urls = capture(() => ({ windowRounds: 4, maxTotalBonusPct: 50, earlyBirdRounds: 4, earlyBirdBonusPct: 20, tiers: [{ threshold: '100000', bonusPct: 5 }] }));
  const b = await fetchBoostConfig();
  assert.deepEqual(urls, ['https://alpha-biz.sodex.dev/biz/sopoints/v2/team/boost/config']);
  assert.equal(b.tiers[0]!.bonusPct, 5);
  assert.equal(b.maxTotalBonusPct, 50);
});

test('fetchVolumeWeights: the data host', async () => {
  const urls = capture(() => ({ activity_id: 6, round: { round_id: 10, start_ts_ms: 1, end_ts_ms: 2 }, weights: [{ market_type: 'perps', symbol_id: 18, symbol: 'ZEC-USD', coefficient: '1.2' }] }));
  const v = await fetchVolumeWeights();
  assert.deepEqual(urls, ['https://mainnet-data.sodex.dev/api/v1/points/volume-weights']);
  assert.equal(v.weights[0]!.coefficient, '1.2');
});

test('a failing public read throws: the page prints a dash, not a guess', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ code: 7, msg: 'down' }), { status: 200 })) as typeof fetch;
  await assert.rejects(fetchWeek(), /down/);
});

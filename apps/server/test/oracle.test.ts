/**
 * GET /api/vs/oracle (routes/oracle.ts): the query, the answer, and the cache
 * shared by every caller - against a fake venue reader, no network. And the
 * API's copy of the oracle (valuedesk/oracle.ts) is the engine's, line for line.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import Fastify from 'fastify';
import { ORACLE_VENUES, OracleFeed, combineOracle, type FetchLike, type VenueQuote } from '../src/valuedesk/oracle.js';
import { coinsOfSymbols, listedCoins, oracleRoutes, parseOracleQuery } from '../src/routes/oracle.js';

const MARKER = '// ---- shared with apps/server/src/valuedesk/oracle.ts below this line ----\n';
const below = (url: URL) => {
  const s = readFileSync(url, 'utf8').replace(/\r\n/g, '\n');
  const i = s.indexOf(MARKER);
  assert.ok(i >= 0, `${url.pathname} has the marker`);
  return s.slice(i);
};

test("the API's oracle is the engine's, below the marker", () => {
  assert.equal(below(new URL('../src/valuedesk/oracle.ts', import.meta.url)), below(new URL('../../../packages/copy-engine/src/oracle.ts', import.meta.url)));
});

test('the query: a coin, and known venues (all when none)', () => {
  assert.deepEqual(parseOracleQuery({ coin: 'btc', venues: 'bybit,okx,bybit' }), { coin: 'BTC', venues: ['bybit', 'okx'] });
  assert.equal(parseOracleQuery({ coin: 'BTC-USD' }).coin, 'BTC');
  assert.equal(parseOracleQuery({ coin: 'ETH' }).venues.length, ORACLE_VENUES.length);
  assert.throws(() => parseOracleQuery({ coin: '' }), /coin/);
  assert.throws(() => parseOracleQuery({ coin: 'BTC', venues: 'moonex' }), /unknown venue moonex/);
});

test('combined over the same quotes as the engine', () => {
  const at = 1_800_000_000_000;
  const qs: VenueQuote[] = [
    { venue: 'binanceFutures', bid: 99, ask: 101, mid: 100, mark: 100.2, at },
    { venue: 'okx', bid: 101, ask: 103, mid: 102, mark: null, at: at - 9_000 },
  ];
  assert.deepEqual(combineOracle(qs, at), { mid: 100, fair: 100.2, used: ['binanceFutures'], stale: ['okx'], missing: ORACLE_VENUES.filter((v) => v !== 'binanceFutures' && v !== 'okx') });
});

test('the route answers every caller from one read per venue and coin a second', async () => {
  let t = Date.now();
  const reads: string[] = [];
  const feed = new OracleFeed({
    fetch: (async () => ({ ok: true, status: 200, text: async () => '{}' })) as FetchLike,
    now: () => t,
    read: async (_f, venue, coin) => {
      reads.push(`${venue}:${coin}`);
      return { venue, bid: 99, ask: 101, mid: 100, mark: venue === 'bybit' ? 100.4 : null, at: t };
    },
  });
  const app = Fastify();
  oracleRoutes(app, feed, async () => null);
  const get = async (url: string) => (await app.inject({ method: 'GET', url })).json();
  const a = await get('/api/vs/oracle?coin=BTC&venues=bybit,okx');
  assert.equal(a.ok, true);
  assert.equal(a.mid, 100);
  assert.equal(a.fair, 100.2);
  assert.deepEqual(a.used, ['bybit', 'okx']);
  // Several venues: the combined price only, no venue's own quote.
  assert.equal(a.quotes, undefined);
  assert.equal(a.errors, undefined);
  assert.equal(typeof a.ageMs, 'number');
  // Ten more callers within the second: no new read.
  await Promise.all(Array.from({ length: 10 }, () => get('/api/vs/oracle?coin=btc&venues=okx,bybit')));
  assert.deepEqual(reads.sort(), ['bybit:BTC', 'okx:BTC']);
  // A second later: one more read each.
  t += 1_001;
  const one = await get('/api/vs/oracle?coin=BTC&venues=okx');
  // One venue: still only the derived price - no venue's own bid, ask or mark leaves the server.
  assert.equal(one.quotes, undefined);
  assert.equal(one.errors, undefined);
  assert.equal(one.mid, 100);
  assert.deepEqual(one.used, ['okx']);
  assert.equal(reads.filter((r) => r === 'okx:BTC').length, 2);
  const bad = await app.inject({ method: 'GET', url: '/api/vs/oracle?coin=BTC&venues=nope' });
  assert.equal(bad.statusCode, 400);
  await app.close();
});

test("only SoDEX's coins: a made-up coin is a 404 and never reaches a venue; the list is re-read every 10 minutes, and while SoDEX cannot be read every coin is answered", async () => {
  assert.deepEqual(coinsOfSymbols({ data: [{ name: 'BTC-USD' }, { name: 'vMEMEssi_vUSDC', displayName: 'MEMEssi/USDC' }, { name: 'x y' }] }), ['BTC', 'MEMESSI']);
  let t = 0;
  let calls = 0;
  let fail = false;
  const listed = listedCoins(async () => {
    calls++;
    if (fail) throw new Error('down');
    return [{ data: [{ name: 'BTC-USD' }, { name: 'ETH-USD' }] }];
  }, () => t);
  assert.deepEqual([...((await listed()) ?? [])], ['BTC', 'ETH']);
  await listed();
  assert.equal(calls, 1, 'one read within 10 minutes');
  t += 600_000;
  fail = true;
  assert.ok((await listed())?.has('BTC'), 'a failed re-read keeps the last list');
  assert.equal(calls, 2);
  const none = listedCoins(async () => {
    throw new Error('down');
  });
  assert.equal(await none(), null, 'no list yet: unknown, not empty');

  const reads: string[] = [];
  const feed = new OracleFeed({
    fetch: (async () => ({ ok: true, status: 200, text: async () => '{}' })) as FetchLike,
    read: async (_f, venue, coin) => {
      reads.push(`${venue}:${coin}`);
      return { venue, bid: 99, ask: 101, mid: 100, mark: null, at: Date.now() };
    },
  });
  const app = Fastify();
  oracleRoutes(app, feed, async () => new Set(['BTC']));
  const made = await app.inject({ method: 'GET', url: '/api/vs/oracle?coin=NOTACOIN&venues=okx' });
  assert.equal(made.statusCode, 404);
  assert.deepEqual(reads, []);
  const btc = await app.inject({ method: 'GET', url: '/api/vs/oracle?coin=BTC&venues=okx' });
  assert.equal(btc.json().ok, true);
  await app.close();
});

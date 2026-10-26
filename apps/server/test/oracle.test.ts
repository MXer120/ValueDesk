/**
 * GET /api/vs/oracle (routes/oracle.ts): the query, the answer, and the cache
 * shared by every caller - against a fake venue reader, no network. And the
 * API's copy of the oracle (valuescan/oracle.ts) is the engine's, line for line.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import Fastify from 'fastify';
import { OracleFeed, combineOracle, type FetchLike, type VenueQuote } from '../src/valuescan/oracle.js';
import { oracleRoutes, parseOracleQuery } from '../src/routes/oracle.js';

const MARKER = '// ---- shared with apps/server/src/valuescan/oracle.ts below this line ----\n';
const below = (url: URL) => {
  const s = readFileSync(url, 'utf8').replace(/\r\n/g, '\n');
  const i = s.indexOf(MARKER);
  assert.ok(i >= 0, `${url.pathname} has the marker`);
  return s.slice(i);
};

test("the API's oracle is the engine's, below the marker", () => {
  assert.equal(below(new URL('../src/valuescan/oracle.ts', import.meta.url)), below(new URL('../../../packages/copy-engine/src/oracle.ts', import.meta.url)));
});

test('the query: a coin, and known venues (all when none)', () => {
  assert.deepEqual(parseOracleQuery({ coin: 'btc', venues: 'bybit,okx,bybit' }), { coin: 'BTC', venues: ['bybit', 'okx'] });
  assert.equal(parseOracleQuery({ coin: 'BTC-USD' }).coin, 'BTC');
  assert.equal(parseOracleQuery({ coin: 'ETH' }).venues.length, 6);
  assert.throws(() => parseOracleQuery({ coin: '' }), /coin/);
  assert.throws(() => parseOracleQuery({ coin: 'BTC', venues: 'kraken' }), /unknown venue kraken/);
});

test('combined over the same quotes as the engine', () => {
  const at = 1_800_000_000_000;
  const qs: VenueQuote[] = [
    { venue: 'binanceFutures', bid: 99, ask: 101, mid: 100, mark: 100.2, at },
    { venue: 'okx', bid: 101, ask: 103, mid: 102, mark: null, at: at - 9_000 },
  ];
  assert.deepEqual(combineOracle(qs, at), { mid: 100, fair: 100.2, used: ['binanceFutures'], stale: ['okx'], missing: ['binanceSpot', 'bitget', 'hyperliquid', 'bybit'] });
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
  oracleRoutes(app, feed);
  const get = async (url: string) => (await app.inject({ method: 'GET', url })).json();
  const a = await get('/api/vs/oracle?coin=BTC&venues=bybit,okx');
  assert.equal(a.ok, true);
  assert.equal(a.mid, 100);
  assert.equal(a.fair, 100.2);
  assert.deepEqual(a.used, ['bybit', 'okx']);
  assert.equal(a.quotes.length, 2);
  assert.equal(a.quotes[0].stale, false);
  // Ten more callers within the second: no new read.
  await Promise.all(Array.from({ length: 10 }, () => get('/api/vs/oracle?coin=btc&venues=okx,bybit')));
  assert.deepEqual(reads.sort(), ['bybit:BTC', 'okx:BTC']);
  // A second later: one more read each.
  t += 1_001;
  await get('/api/vs/oracle?coin=BTC&venues=okx');
  assert.equal(reads.filter((r) => r === 'okx:BTC').length, 2);
  const bad = await app.inject({ method: 'GET', url: '/api/vs/oracle?coin=BTC&venues=nope' });
  assert.equal(bad.statusCode, 400);
  await app.close();
});

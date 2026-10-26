/**
 * The shared oracle (oracle.ts): the combined mid and fair price, stale and
 * unchosen venues, each venue's answer parsed, and the feed's one read per
 * venue and coin a second. Nothing here calls the network.
 * Run: npx tsx --test test/oracle.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combineOracle, OracleFeed, oracleSymbol, readVenue, sweepRefFor, type FetchLike, type VenueQuote } from '../src/index.ts';

const NOW = 1_800_000_000_000;
const q = (venue: VenueQuote['venue'], mid: number, mark: number | null = null, age = 0): VenueQuote => ({ venue, bid: mid - 1, ask: mid + 1, mid, mark, at: NOW - age });

test('mid is the median of the fresh mids; fair the median of marks, mids where a venue has none', () => {
  const c = combineOracle([q('binanceFutures', 100, 101), q('binanceSpot', 102), q('bybit', 110, 103)], NOW);
  assert.equal(c.mid, 102);
  // fairs: 101, 102 (spot: its mid), 103
  assert.equal(c.fair, 102);
  assert.deepEqual(c.used, ['binanceFutures', 'binanceSpot', 'bybit']);
  // Even count: the mean of the middle two.
  assert.equal(combineOracle([q('okx', 100, 100), q('bitget', 104, 106)], NOW).mid, 102);
  assert.equal(combineOracle([q('okx', 100, 100), q('bitget', 104, 106)], NOW).fair, 103);
});

test('a stale venue is left out and flagged; nothing fresh is no price', () => {
  const c = combineOracle([q('binanceFutures', 100, 100), q('okx', 200, 200, 6_000)], NOW);
  assert.equal(c.mid, 100);
  assert.deepEqual(c.stale, ['okx']);
  assert.ok(c.missing.includes('bybit'));
  const none = combineOracle([q('okx', 200, 200, 6_000)], NOW);
  assert.equal(none.mid, null);
  assert.equal(none.fair, null);
  // A stamp from the future is not trusted either.
  assert.deepEqual(combineOracle([q('okx', 200, null, -5_000)], NOW).stale, ['okx']);
});

test('only the chosen venues count; none chosen is all', () => {
  const qs = [q('binanceFutures', 100), q('bybit', 120), q('hyperliquid', 130)];
  assert.equal(combineOracle(qs, NOW, { venues: ['bybit'] }).mid, 120);
  assert.deepEqual(combineOracle(qs, NOW, { venues: ['bybit', 'okx'] }).missing, ['okx']);
  assert.equal(combineOracle(qs, NOW, { venues: [] }).mid, 120);
});

test("a sweep's reference: oracle mid or fair over its venues, SoDEX mark as fallback, or SoDEX's own prices", () => {
  const qs = [q('binanceFutures', 100, 99), q('bybit', 104, 101)];
  const sodex = { mark: 90, index: 91, at: NOW };
  assert.equal(sweepRefFor({}, qs, sodex, NOW)!.price, 102);
  assert.equal(sweepRefFor({ reference: 'oracleFair' }, qs, sodex, NOW)!.price, 100);
  assert.equal(sweepRefFor({ reference: 'oracleMid', venues: ['bybit'] }, qs, sodex, NOW)!.price, 104);
  const fb = sweepRefFor({ venues: ['okx'] }, qs, sodex, NOW)!;
  assert.equal(fb.price, 90);
  assert.equal(fb.fallback, true);
  assert.equal(sweepRefFor({ reference: 'mark' }, qs, sodex, NOW)!.price, 90);
  assert.equal(sweepRefFor({ reference: 'index' }, qs, sodex, NOW)!.price, 91);
  assert.equal(sweepRefFor({ reference: 'index' }, qs, { ...sodex, at: NOW - 60_000 }, NOW), null);
  assert.equal(sweepRefFor({ venues: ['okx'] }, qs, null, NOW), null);
});

const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

test("each venue's answer is read as bid, ask, mid and mark per one coin", async () => {
  const seen: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    seen.push(url + (init?.body ? ` ${init.body}` : ''));
    if (url.includes('fapi.binance.com/fapi/v1/ticker/bookTicker')) return ok({ bidPrice: '99', askPrice: '101', time: NOW - 10 });
    if (url.includes('premiumIndex')) return ok({ markPrice: '100.5' });
    if (url.includes('api.binance.com')) return ok({ bidPrice: '98', askPrice: '100' });
    if (url.includes('bitget')) return ok({ data: [{ bidPr: '1', askPr: '3', markPrice: '2.5', ts: String(NOW) }] });
    if (url.includes('hyperliquid')) return ok({ levels: [[{ px: '0.009' }], [{ px: '0.011' }]], time: NOW });
    if (url.includes('okx.com/api/v5/market')) return ok({ data: [{ bidPx: '10', askPx: '12', ts: String(NOW) }] });
    if (url.includes('mark-price')) return ok({ data: [{ markPx: '11.5' }] });
    if (url.includes('bybit')) return ok({ result: { list: [{ bid1Price: '5', ask1Price: '7', markPrice: '6.2' }] }, time: NOW });
    return { ok: false, status: 404, text: async () => '' };
  };
  const now = () => NOW;
  assert.deepEqual(await readVenue(fetch, 'binanceFutures', 'BTC', now), { venue: 'binanceFutures', bid: 99, ask: 101, mid: 100, mark: 100.5, at: NOW - 10 });
  assert.equal((await readVenue(fetch, 'binanceSpot', 'BTC', now))!.mid, 99);
  assert.equal((await readVenue(fetch, 'bitget', 'BTC', now))!.mark, 2.5);
  // Hyperliquid lists PEPE as kPEPE, 1000 to a contract.
  const hl = (await readVenue(fetch, 'hyperliquid', 'PEPE', now))!;
  assert.ok(Math.abs(hl.mid - 0.00001) < 1e-12);
  assert.ok(seen.some((s) => s.includes('"coin":"kPEPE"')));
  assert.equal((await readVenue(fetch, 'okx', 'ETH', now))!.mark, 11.5);
  assert.ok(seen.some((s) => s.includes('instId=ETH-USDT-SWAP')));
  assert.equal((await readVenue(fetch, 'bybit', 'SOL', now))!.mid, 6);
  assert.equal(oracleSymbol('binanceFutures', 'pepe').symbol, '1000PEPEUSDT');
  // A crossed or empty book is no quote.
  const crossed: FetchLike = async () => ok({ bidPrice: '101', askPrice: '99' });
  assert.equal(await readVenue(crossed, 'binanceSpot', 'BTC', now), null);
});

test('the feed reads a venue and coin once a second, one read at a time, for every caller', async () => {
  let t = NOW;
  let reads = 0;
  let release: () => void = () => {};
  const feed = new OracleFeed({
    fetch: (async () => ok({})) as FetchLike,
    now: () => t,
    read: async (_f, venue, coin) => {
      reads++;
      await new Promise<void>((r) => (release = r));
      return { venue, bid: 1, ask: 3, mid: 2, mark: null, at: t, coin } as VenueQuote;
    },
  });
  // Three callers at once: one read.
  const all = Promise.all([feed.venue('okx', 'BTC'), feed.venue('okx', 'btc'), feed.venue('okx', 'BTC')]);
  release();
  const got = await all;
  assert.equal(reads, 1);
  assert.ok(got.every((g) => g?.mid === 2));
  // Within the second: from the cache.
  t += 500;
  await feed.venue('okx', 'BTC');
  assert.equal(reads, 1);
  // Another coin or venue is its own read.
  const other = feed.venue('bybit', 'BTC');
  release();
  await other;
  assert.equal(reads, 2);
  // A second later: read again.
  t += 600;
  const again = feed.venue('okx', 'BTC');
  release();
  await again;
  assert.equal(reads, 3);
});

test('a failed read keeps the last quote, which then ages out as stale', async () => {
  let t = NOW;
  let fail = false;
  const feed = new OracleFeed({
    fetch: (async () => ok({})) as FetchLike,
    now: () => t,
    read: async (_f, venue) => {
      if (fail) throw new Error('down');
      return { venue, bid: 1, ask: 3, mid: 2, mark: null, at: t };
    },
  });
  assert.equal((await feed.snapshot('BTC', ['okx'])).mid, 2);
  fail = true;
  t += 6_000;
  const s = await feed.snapshot('BTC', ['okx']);
  assert.equal(s.mid, null);
  assert.deepEqual(s.stale, ['okx']);
  assert.equal(s.quotes[0]!.stale, true);
  assert.equal(s.errors.okx, 'down');
});

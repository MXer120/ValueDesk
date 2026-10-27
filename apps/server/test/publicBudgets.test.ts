/**
 * Run: npx tsx --test test/publicBudgets.test.ts   (from apps/server)
 *
 * What a public API process may cost the exchanges: nothing that grows with
 * the number of visitors. It shares one address with the indexer, and every
 * venue limits per address.
 *
 *   - /api/vs/positioning is answered from the index (the boards' wallets'
 *     books), with no request to a venue - and a process that only serves the
 *     API never falls back to crawling one;
 *   - the Hyperliquid client's share is 200 weight a minute there, so that it
 *     and the indexer's lanes fit Hyperliquid's 1,200;
 *   - the whale feeds answer from a buffer every visitor shares; what they
 *     read upstream is bounded by the clock, not by who asks.
 *
 * Every test here counts the requests that leave: `fetch` is replaced.
 */
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IndexStore } from '../src/indexer/store.js';
import { closeReader } from '../src/indexer/reader.js';
import { boardHoldings, type Holdings } from '../src/indexer/held.js';
import { INDEXER_ENV } from '../src/indexer/engine.js';
import { claimHlShare } from '../src/indexer/worker.js';
import { apiOnly } from '../src/valuedesk/env.js';
import { NotAvailable, type VsPosition } from '../src/valuedesk/types.js';
import {
  HL_LIMIT_PER_MIN, HL_WEIGHT_API_ONLY, HL_WEIGHT_DEFAULT, HlInfoClient, hlWeightPerMin, type InfoBody, type InfoLike,
} from '../src/valuedesk/hyperliquid/info.js';
import { HlPositioning, INDEX_TTL_MS as HL_INDEX_TTL_MS, type IndexSource } from '../src/valuedesk/hyperliquid/positioning.js';
import { HlTradeFeed } from '../src/valuedesk/hyperliquid/whales.js';
import { LbSnapshot, parseLeaderboard } from '../src/valuedesk/hyperliquid/leaderboard.js';
import type { HlLeaderboardRaw } from '../src/valuedesk/hyperliquid/raw.js';
import { INDEX_TTL_MS, indexPositioning, positioning, resetIndexPositioning } from '../src/valuedesk/sodex/positioning.js';
import { START_RETRY_MS, resetWhaleFeed, seedFromIndex, whales } from '../src/valuedesk/sodex/whales.js';
import {
  BULK_FAIL_GAP_MS, BULK_MIN_GAP_MS, bulkWaitMs, knownAddress, prefetchIds, resetResolver, resolveIds, resolverStats,
} from '../src/valuedesk/sodex/resolver.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'vs-budget-'));
  dirs.push(d);
  return d;
}

// --- every outgoing request is counted -------------------------------------------------------

const realFetch = globalThis.fetch;
let sent: string[] = [];
let answer: (url: string, init?: RequestInit) => Promise<Response> = async () => { throw new TypeError('fetch failed'); };
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  sent.push(url);
  return answer(url, init);
}) as typeof fetch;

const ENV_KEYS = ['VALUESCAN_HOSTED', 'VALUESCAN_INDEXER', 'VALUESCAN_HL_WEIGHT_PER_MIN', 'VALUESCAN_INDEX_HL_WEIGHT', 'VALUESCAN_INDEX_DB'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  sent = [];
  answer = async () => { throw new TypeError('fetch failed'); };
  for (const k of ENV_KEYS) delete process.env[k];
  closeReader();
  resetIndexPositioning();
});

after(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetWhaleFeed();
  resetResolver();
  closeReader();
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } catch { /* left for the OS */ }
  }
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const NOW = Date.UTC(2026, 9, 2, 12);
const A = (i: number): string => `0x${i.toString(16).padStart(40, '0')}`;
const env = (o: Record<string, string>) => (k: string): string | undefined => o[k];

/**
 * An index with 30-day boards for `venue` (top: wallets 0-4, worst: 100-104)
 * and whatever books and prices the test gives it.
 */
function indexWith(venue: 'sodex' | 'hyperliquid', fill: (w: IndexStore) => void): string {
  const path = join(tmp(), 'index.db');
  const w = new IndexStore(path);
  for (const side of ['top', 'worst'] as const) {
    const base = side === 'top' ? 0 : 100;
    w.writeBoard(
      { venue, window: '30d', side, filter: 'any', updatedAt: NOW, sourceAt: NOW, complete: true, pending: 0, scanned: 5, note: null },
      Array.from({ length: 5 }, (_, i) => ({
        rank: i + 1, venue, address: A(base + i), label: null, accountId: null, pnl: side === 'top' ? 100 - i : -100 + i,
        volume: 1, trades: 2, tradesCapped: false, winRate: null, accountValue: null, assets: [],
      })),
    );
  }
  fill(w);
  w.close();
  return path;
}

// --- who must not spend ----------------------------------------------------------------------------

test('apiOnly: a process that serves the API beside the indexer, or to the public - not the dev server, not a browser', () => {
  assert.equal(apiOnly(env({})), false);
  assert.equal(apiOnly(env({ VALUESCAN_INDEXER: '1' })), false);
  assert.equal(apiOnly(env({ VALUESCAN_INDEXER: '0' })), true);
  assert.equal(apiOnly(env({ VALUESCAN_HOSTED: '1' })), true);
  assert.equal(apiOnly(env({ VALUESCAN_HOSTED: ' 1 ' })), true);
  assert.equal(apiOnly(env({ VALUESCAN_HOSTED: '0' })), false);
  // The legacy switch that only turns the dev worker off is not a deployment.
  assert.equal(apiOnly(env({ VALUETRADE_TRADER_INDEX: '0' })), false);
  // The real environment of this test process: neither switch.
  assert.equal(apiOnly(), false);
  process.env.VALUESCAN_INDEXER = '0';
  assert.equal(apiOnly(), true);
});

// --- Hyperliquid: the client's share ---------------------------------------------------------------

test("the Hyperliquid client's share: 1,000 alone on an address, 200 beside the indexer, and both fit HL's 1,200", () => {
  assert.equal(hlWeightPerMin(env({})), HL_WEIGHT_DEFAULT);
  assert.equal(HL_WEIGHT_DEFAULT, 1_000);
  assert.equal(hlWeightPerMin(env({ VALUESCAN_INDEXER: '0' })), HL_WEIGHT_API_ONLY);
  assert.equal(hlWeightPerMin(env({ VALUESCAN_HOSTED: '1' })), HL_WEIGHT_API_ONLY);
  assert.equal(HL_WEIGHT_API_ONLY, 200);

  // An explicit share wins for every role, clamped to what HL allows.
  assert.equal(hlWeightPerMin(env({ VALUESCAN_HOSTED: '1', VALUESCAN_HL_WEIGHT_PER_MIN: '450' })), 450);
  assert.equal(hlWeightPerMin(env({ VALUESCAN_HL_WEIGHT_PER_MIN: '5000' })), HL_LIMIT_PER_MIN);
  assert.equal(hlWeightPerMin(env({ VALUESCAN_HL_WEIGHT_PER_MIN: '1' })), 60);
  assert.equal(hlWeightPerMin(env({ VALUESCAN_HL_WEIGHT_PER_MIN: 'lots' })), HL_WEIGHT_DEFAULT);
  assert.equal(hlWeightPerMin(env({ VALUESCAN_INDEXER: '0', VALUESCAN_HL_WEIGHT_PER_MIN: '450' }), true), 450);

  // The indexer keeps its client's ceiling even where one env file hands it the API's switches:
  // there the lanes are the limit, and the client must not hold them below it.
  assert.equal(hlWeightPerMin(env({ VALUESCAN_INDEXER: '0', VALUESCAN_HOSTED: '1' }), true), HL_WEIGHT_DEFAULT);

  // One address: the API's share plus the indexer's two lanes (boards, cohort books) stay inside HL's limit.
  const boards = INDEXER_ENV.hlWeightPerMin();
  const cohortBooks = 200;
  assert.equal(boards, 500);
  assert.ok(HL_WEIGHT_API_ONLY + boards + cohortBooks <= HL_LIMIT_PER_MIN, `${HL_WEIGHT_API_ONLY + boards + cohortBooks} of ${HL_LIMIT_PER_MIN}`);
  // What it was: the API's 1,000 on top of the same lanes.
  assert.ok(HL_WEIGHT_DEFAULT + boards + cohortBooks > HL_LIMIT_PER_MIN);
});

test('a client with the small share: a background request goes out (it used to wait for headroom the bucket cannot hold), and the bucket is the cap', async () => {
  let posts = 0;
  let slept = 0;
  const client = new HlInfoClient(
    'http://hl.test/info', HL_WEIGHT_API_ONLY,
    (async () => { posts++; return new Response('[]', { status: 200 }); }) as typeof fetch,
    async () => { if (++slept > 200) throw new Error('waited for ever'); },
  );
  assert.equal(client.budget.perMin, 200);
  assert.equal(client.budget.capacity, 100);
  // 20 weight + 150 of headroom is more than a bucket of 100 ever holds.
  await client.post({ type: 'metaAndAssetCtxs' }, { background: true });
  assert.equal(posts, 1);
  assert.equal(slept, 0);
  assert.ok(client.budget.available() <= 80.5);

  // The share is a hard cap: spending beyond the bucket makes the next request wait its turn.
  for (let i = 0; i < 4; i++) await client.post({ type: 'meta', i });
  assert.ok(client.budget.available() <= 1);
  const wait = client.budget.reserve(20);
  assert.ok(wait >= 5_000 && wait <= 7_000, `the next 20 weight waits ${wait} ms at 200 a minute`);

  // The indexer gives its client its own ceiling at start (indexer/worker.ts) - also where one env file
  // hands it the API's switches, which gave this client the small share when it was made.
  const shared = env({ VALUESCAN_HOSTED: '1', VALUESCAN_INDEXER: '0' });
  const inIndexer = new HlInfoClient('http://hl.test/info', hlWeightPerMin(shared));
  assert.equal(inIndexer.budget.perMin, 200);
  claimHlShare(inIndexer, shared);
  assert.equal(inIndexer.budget.perMin, 1_000);
  assert.equal(inIndexer.budget.capacity, 500);
  // An explicit share is the operator's word, for the indexer too.
  claimHlShare(inIndexer, env({ VALUESCAN_HL_WEIGHT_PER_MIN: '450' }));
  assert.equal(inIndexer.budget.perMin, 450);
  inIndexer.resize(99_999);
  assert.equal(inIndexer.budget.perMin, HL_LIMIT_PER_MIN);
});

// --- positioning: from the index ---------------------------------------------------------------------

test('boardHoldings: the books of the 30-day boards\' wallets, valued at the stream\'s last prices', () => {
  process.env.VALUESCAN_INDEX_DB = indexWith('hyperliquid', (w) => {
    w.putCohortBooks([
      // Top board.
      { venue: 'hyperliquid', address: A(0), equity: 1, at: NOW - 5, positions: [{ symbol: 'BTC', szi: 2, entry: 50_000 }, { symbol: 'ETH', szi: -10, entry: 3_000 }] },
      { venue: 'hyperliquid', address: A(1), equity: 1, at: NOW - 4, positions: [{ symbol: 'BTC', szi: -1, entry: 61_000 }] },
      { venue: 'hyperliquid', address: A(2), equity: 1, at: NOW - 3, positions: [] },
      // Its xyz dex account is a book of its own, under the venue `tradexyz`.
      { venue: 'tradexyz', address: A(0), equity: 1, at: NOW - 2, positions: [{ symbol: 'xyz:GOLD', szi: 4, entry: 2_400 }] },
      // A wallet with only an xyz book still counts as held.
      { venue: 'tradexyz', address: A(3), equity: 1, at: NOW - 1, positions: [{ symbol: 'xyz:GOLD', szi: -2, entry: null }] },
      // Worst board: no price ever printed for this market, so the entry stands in; with neither, nothing.
      { venue: 'hyperliquid', address: A(100), equity: 1, at: NOW - 9, positions: [{ symbol: 'RARE', szi: 3, entry: 7 }, { symbol: 'NEW', szi: 5, entry: null }] },
      // Not on a board: never part of the answer.
      { venue: 'hyperliquid', address: A(999), equity: 1, at: NOW, positions: [{ symbol: 'BTC', szi: 1_000, entry: 1 }] },
    ]);
    w.putCohortMarks([['hyperliquid|BTC', 60_000], ['hyperliquid|ETH', 3_100], ['tradexyz|xyz:GOLD', 2_500], ['sodex|BTC-USD', 1]], NOW);
  });

  const own = boardHoldings('hyperliquid')!;
  assert.equal(own.tracked, 10);
  assert.equal(own.held, 4, 'wallets 0, 1, 2 and 100 have a Hyperliquid book');
  const both = boardHoldings('hyperliquid', ['hyperliquid', 'tradexyz'])!;
  assert.equal(both.tracked, 10);
  assert.equal(both.held, 5, '... and wallet 3 an xyz one');
  assert.equal(both.at, NOW - 1);

  const flat = both.traders.flat();
  const of = (symbol: string): VsPosition[] => flat.filter((p) => p.symbol === symbol);
  assert.deepEqual(of('BTC').map((p) => [p.side, p.size, p.notional, p.markPx]), [['long', 2, 120_000, 60_000], ['short', 1, 60_000, 60_000]]);
  assert.deepEqual(of('ETH').map((p) => [p.side, p.notional, p.uPnl]), [['short', 31_000, -1_000]]);
  assert.deepEqual(of('xyz:GOLD').map((p) => [p.side, p.notional]).sort(), [['long', 10_000], ['short', 5_000]]);
  assert.deepEqual(of('RARE').map((p) => [p.notional, p.markPx]), [[21, null]]);
  assert.deepEqual(of('NEW').map((p) => p.notional), [0]);
  assert.equal(flat.some((p) => p.size === 1_000), false);
  // Largest first within a wallet, as the venue readers give them.
  assert.deepEqual(both.traders.find((t) => t.some((p) => p.symbol === 'ETH'))!.map((p) => p.symbol), ['BTC', 'ETH', 'xyz:GOLD']);

  // No board for the venue, or no index at all: null, never an empty answer.
  assert.equal(boardHoldings('sodex'), null);
  closeReader();
  process.env.VALUESCAN_INDEX_DB = join(tmp(), 'none.db');
  assert.equal(boardHoldings('hyperliquid'), null);
  assert.deepEqual(sent, []);
});

const p = (symbol: string, side: 'long' | 'short', notional: number): VsPosition => ({
  symbol, side, size: 1, notional, entryPx: null, markPx: null, liqPx: null, uPnl: null, leverage: null,
});

/** Just enough of a leaderboard for a sweep, and a way to see whether it was asked for. */
const perf = { pnl: '5', roi: '0', vlm: '1' };
const LB: HlLeaderboardRaw = {
  leaderboardRows: [{ ethAddress: A(1), accountValue: '1', displayName: null, prize: 0, windowPerformances: [['day', perf], ['week', perf], ['month', perf], ['allTime', perf]] }],
};

function hlHarness(source: { holdings: () => Holdings | null; only: boolean }) {
  const posts: InfoBody[] = [];
  let snapshots = 0;
  let reads = 0;
  let t = NOW;
  const info: InfoLike = {
    async post<T>(body: InfoBody): Promise<T> {
      posts.push(body);
      return { assetPositions: [], marginSummary: { accountValue: '0' } } as T;
    },
  };
  const index: IndexSource = { holdings: () => { reads++; return source.holdings(); }, only: () => source.only };
  const pos = new HlPositioning(info, { snapshot: async () => { snapshots++; return new LbSnapshot(parseLeaderboard(LB), 0, null, 0); } }, () => t, index);
  return { pos, posts, counts: () => ({ posts: posts.length, snapshots, reads }), advance: (ms: number) => { t += ms; } };
}

test('Hyperliquid positioning from the index: no request to Hyperliquid, one read of the index per 15 s, whoever asks', async () => {
  const held: Holdings = {
    tracked: 4, held: 3, at: NOW,
    traders: [[p('BTC', 'long', 100), p('xyz:SP500', 'short', 40)], [p('BTC', 'short', 300)], [p('BTC', 'long', 10), p('BTC', 'long', 5)]],
  };
  for (const only of [true, false]) {
    const h = hlHarness({ holdings: () => held, only });
    const rows = await h.pos.get();
    assert.deepEqual(rows, [
      { venue: 'hyperliquid', symbol: 'BTC', longUsd: 115, shortUsd: 300, longTraders: 2, shortTraders: 1 },
      { venue: 'hyperliquid', symbol: 'xyz:SP500', longUsd: 0, shortUsd: 40, longTraders: 0, shortTraders: 1 },
    ]);
    assert.deepEqual((await h.pos.get('sp500')).map((r) => r.symbol), ['xyz:SP500']);
    // 5,000 visitors inside the TTL.
    for (let i = 0; i < 5_000; i++) await h.pos.get(i % 2 ? 'BTC' : undefined);
    assert.deepEqual(h.counts(), { posts: 0, snapshots: 0, reads: 1 });
    h.advance(HL_INDEX_TTL_MS);
    await h.pos.get();
    await h.pos.get();
    assert.deepEqual(h.counts(), { posts: 0, snapshots: 0, reads: 2 });
  }
  assert.equal(HL_INDEX_TTL_MS, 15_000);
});

test('Hyperliquid positioning, index not ready: an API-only process says so and sends nothing; the dev server sweeps', async () => {
  // No index, no 30-day board, or books for fewer than half the boards' wallets.
  const notReady: Array<Holdings | null> = [null, { tracked: 0, held: 0, at: 0, traders: [] }, { tracked: 200, held: 99, at: NOW, traders: [[p('BTC', 'long', 1)]] }];
  for (const state of notReady) {
    const api = hlHarness({ holdings: () => state, only: true });
    for (let i = 0; i < 50; i++) await assert.rejects(api.pos.get(), (e: unknown) => e instanceof NotAvailable && /index/.test((e as Error).message));
    assert.deepEqual({ posts: api.counts().posts, snapshots: api.counts().snapshots }, { posts: 0, snapshots: 0 });

    const dev = hlHarness({ holdings: () => state, only: false });
    await dev.pos.get();
    assert.equal(dev.counts().snapshots, 1);
    assert.equal(dev.counts().posts, 2, 'one wallet on two dexes');
  }
  // Exactly half is enough.
  const half = hlHarness({ holdings: () => ({ tracked: 200, held: 100, at: NOW, traders: [[p('BTC', 'long', 1)]] }), only: true });
  assert.equal((await half.pos.get()).length, 1);
});

test('SoDEX positioning from the index: summed per market, reused for 15 s, half the wallets at least', () => {
  let reads = 0;
  const held: Holdings = { tracked: 4, held: 2, at: NOW, traders: [[p('BTC-USD', 'long', 100), p('ETH-USD', 'short', 50)], [p('BTC-USD', 'short', 300)]] };
  const read = (): Holdings | null => { reads++; return held; };
  const rows = indexPositioning(read, NOW)!;
  assert.deepEqual(rows, [
    { venue: 'sodex', symbol: 'BTC-USD', longUsd: 100, shortUsd: 300, longTraders: 1, shortTraders: 1 },
    { venue: 'sodex', symbol: 'ETH-USD', longUsd: 0, shortUsd: 50, longTraders: 0, shortTraders: 1 },
  ]);
  for (let i = 0; i < 5_000; i++) assert.equal(indexPositioning(read, NOW + (i % INDEX_TTL_MS)), rows);
  assert.equal(reads, 1);
  assert.notEqual(indexPositioning(read, NOW + INDEX_TTL_MS), null);
  assert.equal(reads, 2);
  assert.equal(INDEX_TTL_MS, 15_000);

  resetIndexPositioning();
  assert.equal(indexPositioning(() => null, NOW), null);
  assert.equal(indexPositioning(() => ({ tracked: 0, held: 0, at: 0, traders: [] }), NOW), null);
  assert.equal(indexPositioning(() => ({ ...held, tracked: 5 }), NOW), null, '2 of 5 wallets is not a positioning');
  assert.notEqual(indexPositioning(() => held, NOW), null);
});

test('GET positioning in an API-only process: the index answers, and without one nothing is sent to SoDEX', async () => {
  process.env.VALUESCAN_HOSTED = '1';
  process.env.VALUESCAN_INDEX_DB = join(tmp(), 'none.db');
  for (let i = 0; i < 100; i++) {
    await assert.rejects(positioning(i % 2 ? 'BTC' : undefined), (e: unknown) => e instanceof NotAvailable && (e as NotAvailable).code === 'not_available');
  }
  assert.deepEqual(sent, [], 'no leaderboard page, no account state: the crawl never starts');

  // The same with VALUESCAN_INDEXER=0 alone, on an index whose boards have no books yet.
  delete process.env.VALUESCAN_HOSTED;
  process.env.VALUESCAN_INDEXER = '0';
  closeReader();
  process.env.VALUESCAN_INDEX_DB = indexWith('sodex', () => {});
  await assert.rejects(positioning(), NotAvailable);
  assert.deepEqual(sent, []);

  // With the books: the answer, and still nothing sent.
  closeReader();
  resetIndexPositioning();
  process.env.VALUESCAN_INDEX_DB = indexWith('sodex', (w) => {
    w.putCohortBooks(Array.from({ length: 10 }, (_, i) => ({
      venue: 'sodex' as const, address: A(i < 5 ? i : 95 + i), equity: 1, at: NOW,
      positions: i % 2 ? [{ symbol: 'BTC-USD', szi: -1, entry: 59_000 }] : [{ symbol: 'BTC-USD', szi: 2, entry: 59_000 }, { symbol: 'ETH-USD', szi: 1, entry: 3_000 }],
    })));
    w.putCohortMarks([['sodex|BTC-USD', 60_000]], NOW);
  });
  const rows = await positioning();
  assert.deepEqual(rows, [
    { venue: 'sodex', symbol: 'BTC-USD', longUsd: 5 * 120_000, shortUsd: 5 * 60_000, longTraders: 5, shortTraders: 5 },
    { venue: 'sodex', symbol: 'ETH-USD', longUsd: 5 * 3_000, shortUsd: 0, longTraders: 5, shortTraders: 0 },
  ]);
  assert.deepEqual((await positioning('eth')).map((r) => r.symbol), ['ETH-USD']);
  for (let i = 0; i < 1_000; i++) await positioning();
  assert.deepEqual(sent, []);
});

// --- whales: one feed for every visitor ----------------------------------------------------------------

test('the Hyperliquid whale feed: a thousand reads cost what one costs - the coin ranking, once', async () => {
  const posts: InfoBody[] = [];
  const info: InfoLike = { async post<T>(body: InfoBody): Promise<T> { posts.push(body); return [{ universe: [] }, []] as T; } };
  // A port nothing listens on: the socket never opens, which is all this test needs.
  const feed = new HlTradeFeed(info, 'ws://127.0.0.1:9');
  try {
    feed.start();
    await sleep(20);
    for (let i = 0; i < 1_000; i++) await feed.recent(i % 3 ? 100_000 : 0, 50);
    assert.equal(posts.length, 2, 'metaAndAssetCtxs for the default dex and for xyz');
    assert.deepEqual(posts.map((b) => b.type), ['metaAndAssetCtxs', 'metaAndAssetCtxs']);
  } finally {
    feed.stop();
  }
});

test('the SoDEX whale feed: a start that fails is tried again after 30 s, not once per request', async () => {
  resetWhaleFeed();
  // The gateway is unreachable: the symbol list cannot be read (the client makes its usual tries).
  await assert.rejects(whales(100_000, 50));
  const tries = sent.length;
  assert.ok(tries >= 1 && tries <= 4, `${tries} tries for one start`);
  assert.ok(sent.every((u) => /symbols/.test(u)), sent.join(' '));
  // 300 visitors in the next moment.
  const results = await Promise.allSettled(Array.from({ length: 300 }, () => whales(100_000, 50)));
  assert.ok(results.every((r) => r.status === 'rejected'));
  assert.equal(sent.length, tries, 'no further request');
  assert.equal(START_RETRY_MS, 30_000);
  resetWhaleFeed();
});

test('SoDEX taker ids: the index answers what it knows; the bulk resolver is called at most once per 2 s, whoever asks', async () => {
  resetResolver();
  // Pure: how long the next call waits.
  assert.equal(bulkWaitMs(10_000, 9_000, false), 1_000);
  assert.equal(bulkWaitMs(10_000, 0, false), 0);
  assert.equal(bulkWaitMs(10_000, 9_000, true), 14_000);
  assert.equal(bulkWaitMs(10_000, 9_999, false), BULK_MIN_GAP_MS - 1);
  assert.equal(BULK_MIN_GAP_MS, 2_000);
  assert.equal(BULK_FAIL_GAP_MS, 15_000);

  // The index pairs ids with wallets: no request for those.
  process.env.VALUESCAN_INDEX_DB = indexWith('sodex', (w) => {
    w.upsertAccount('sodex', A(1), { accountId: 5_001 });
    w.upsertAccount('sodex', A(2), { accountId: 5_002 });
    w.upsertAccount('hyperliquid', A(3), { accountId: 5_003 });
  });
  seedFromIndex([5_001, 5_002, 5_003, 0, -4, 1.5]);
  assert.equal(knownAddress(5_001), A(1));
  assert.equal(knownAddress(5_002), A(2));
  assert.equal(knownAddress(5_003), undefined, 'another venue\'s id is not a SoDEX account');
  assert.deepEqual([...(await resolveIds([5_001, 5_002], 50)).values()], [A(1), A(2)]);
  assert.deepEqual(sent, []);

  // The rest goes to the bulk resolver, in batches at least 2 s apart.
  const calls: Array<{ at: number; ids: number[] }> = [];
  answer = async (_url, init) => {
    const ids = (JSON.parse(String(init?.body)) as { userIds: number[] }).userIds;
    calls.push({ at: Date.now(), ids });
    return new Response(JSON.stringify({ code: 0, data: ids.filter((id) => id < 9_000).map((id) => ({ userId: String(id), address: A(id) })) }), { status: 200 });
  };
  // 200 requests ask for the same 20 unknown ids at once: one call.
  const first = await Promise.all(Array.from({ length: 200 }, () => resolveIds(Array.from({ length: 20 }, (_, i) => 7_000 + i), 1_500)));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.ids.length, 20);
  assert.equal(first[0]!.get(7_003), A(7_003));
  // More ids arrive right behind it, in three bursts: they wait for the gap and go together.
  prefetchIds([7_100, 7_101]);
  await sleep(150);
  prefetchIds([7_102]);
  await sleep(150);
  prefetchIds([7_103, 9_500]);
  await sleep(500);
  assert.equal(calls.length, 1, 'still inside the gap');
  const got = await resolveIds([7_100, 7_101, 7_102, 7_103, 9_500], 3_000);
  assert.equal(calls.length, 2);
  assert.ok(calls[1]!.at - calls[0]!.at >= BULK_MIN_GAP_MS - 20, `${calls[1]!.at - calls[0]!.at} ms apart`);
  assert.deepEqual(calls[1]!.ids.sort(), [7_100, 7_101, 7_102, 7_103, 9_500]);
  assert.equal(got.size, 4);
  // "No such id" is an answer: asked once, not again on the next request.
  await resolveIds([9_500], 100);
  await sleep(100);
  assert.equal(calls.length, 2);
  assert.equal(resolverStats().bulkCalls, 2);
  assert.equal(sent.length, 2);
  resetResolver();
});

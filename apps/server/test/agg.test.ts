/**
 * Run: npx tsx --test test/agg.test.ts   (from apps/server)
 *
 * The day aggregates must answer exactly what a scan of the fills answers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IndexStore, type FillRow } from '../src/indexer/store.js';

const DAY = 86_400_000;
const T0 = 20_000 * DAY; // a UTC midnight

function fill(o: Partial<FillRow> & { id: string; t: number }): FillRow {
  return { venue: 'hyperliquid', address: '0xa', symbol: 'BTC', side: 1, px: 100, sz: 1, fee: 0.1, closedPnl: null, oid: null, src: 1, ...o };
}

const scan = (s: IndexStore, venue: 'hyperliquid' | 'sodex', a: string, from: number) =>
  (s as unknown as { windowStatsScan: (v: string, a: string, f: number) => unknown }).windowStatsScan(venue, a, from);

test('day aggregates equal the fill scan, before and after new fills', () => {
  const s = new IndexStore(':memory:', { aggRefreshMs: 0 });
  const rows: FillRow[] = [];
  // Three days of fills: several per order, closes with profit and loss, two markets.
  for (let d = 0; d < 3; d++) {
    for (let i = 0; i < 6; i++) {
      const t = T0 + d * DAY + i * 3_600_000;
      rows.push(fill({ id: `f${d}-${i}a`, t, oid: `o${d}-${i}`, closedPnl: i % 3 === 0 ? (i % 2 ? 5 : -3) : null }));
      rows.push(fill({ id: `f${d}-${i}b`, t, oid: `o${d}-${i}`, symbol: i % 2 ? 'ETH' : 'BTC', px: 10, sz: 3 }));
    }
  }
  s.putFills(rows);
  // First read queues the build; until it completes the writer answers a capped count.
  assert.equal(s.windowStats('hyperliquid', '0xa', 0).trades, (scan(s, 'hyperliquid', '0xa', 0) as { trades: number }).trades);
  while (s.buildAggregates(1_000) > 0) { /* build */ }
  assert.equal(s.aggregatesReady('hyperliquid', '0xa'), true);
  for (const from of [0, T0 + 5 * 3_600_000, T0 + DAY + 1, T0 + 2 * DAY]) {
    assert.deepEqual(s.windowStats('hyperliquid', '0xa', from), scan(s, 'hyperliquid', '0xa', from), `from ${from}`);
    assert.equal(s.orderCount('hyperliquid', '0xa', from), (scan(s, 'hyperliquid', '0xa', from) as { trades: number }).trades);
  }
  // A late fill on an old day, and a new day: the dirty days are re-summed.
  s.putFills([fill({ id: 'late', t: T0 + 3_600_000 * 2 + 5, oid: 'x1', closedPnl: 9 }), fill({ id: 'new', t: T0 + 3 * DAY + 10, symbol: 'SOL' })]);
  for (const from of [0, T0 + DAY / 2, T0 + 3 * DAY]) {
    assert.deepEqual(s.windowStats('hyperliquid', '0xa', from), scan(s, 'hyperliquid', '0xa', from), `after, from ${from}`);
  }
  // A dropped range: gone from the aggregates too.
  s.putFills([fill({ id: 'stream', t: T0 + DAY + 100, src: 0 })]);
  s.dropStreamRows('hyperliquid', '0xa', T0 + DAY, T0 + DAY + 1_000);
  s.flushAggregates(1_000);
  assert.deepEqual(s.windowStats('hyperliquid', '0xa', 0), scan(s, 'hyperliquid', '0xa', 0));
  s.close();
});

test('SoDEX closes come from the closes table, per day', () => {
  const s = new IndexStore(':memory:', { aggRefreshMs: 0 });
  s.putFills([fill({ venue: 'sodex', id: 'a', t: T0 + 10 }), fill({ venue: 'sodex', id: 'b', t: T0 + DAY + 10 })]);
  s.putCloses([
    { venue: 'sodex', address: '0xa', id: 'c1', t: T0 + 20, openedT: T0, symbol: 'BTC-USD', pnl: 4 },
    { venue: 'sodex', address: '0xa', id: 'c2', t: T0 + DAY + 20, openedT: T0, symbol: 'BTC-USD', pnl: -1 },
  ]);
  s.windowStats('sodex', '0xa', 0);
  while (s.buildAggregates(1_000) > 0) { /* build */ }
  assert.deepEqual(s.windowStats('sodex', '0xa', 0), scan(s, 'sodex', '0xa', 0));
  s.putCloses([{ venue: 'sodex', address: '0xa', id: 'c3', t: T0 + DAY + 30, openedT: T0, symbol: 'BTC-USD', pnl: 2 }]);
  assert.deepEqual(s.windowStats('sodex', '0xa', T0 + 15), scan(s, 'sodex', '0xa', T0 + 15));
  s.close();
});

test('an active trader\'s day is summed at most once per refresh interval', () => {
  const s = new IndexStore(':memory:', { aggRefreshMs: 60_000 });
  s.putFills([fill({ id: 'a', t: T0 + 10 })]);
  s.windowStats('hyperliquid', '0xa', 0);
  while (s.buildAggregates(1_000) > 0) { /* build */ }
  s.putFills([fill({ id: 'b', t: T0 + 20, side: -1 })]);
  assert.equal(s.windowStats('hyperliquid', '0xa', 0).trades, 2, 'first change: summed at once');
  s.putFills([fill({ id: 'c', t: T0 + 30, symbol: 'ETH' })]);
  assert.equal(s.windowStats('hyperliquid', '0xa', 0).trades, 2, 'within the interval: the last sum stands');
  s.close();
});

test('today\'s sum goes on from its last row, and always equals a whole re-sum: appended, same-time, late, upgraded and re-read fills', () => {
  const s = new IndexStore(':memory:', { aggRefreshMs: 0 });
  // Yesterday: kept like today (keepLive), and every time used here is in the past whenever the test runs.
  const today = Math.floor(Date.now() / DAY) * DAY - DAY;
  const live = () => (s as unknown as { liveDays: Map<string, { seen: number }> }).liveDays;
  const check = (what: string) => {
    s.flushAggregates(1_000);
    assert.deepEqual(s.windowStats('hyperliquid', '0xa', today), scan(s, 'hyperliquid', '0xa', today), what);
    assert.equal(s.orderCount('hyperliquid', '0xa', today), (scan(s, 'hyperliquid', '0xa', today) as { trades: number }).trades, `${what}: trades`);
  };
  const batch = (n: number, at: number, tag: string) => Array.from({ length: n }, (_, i) =>
    fill({ id: `${tag}${i}`, t: at + i * 1_000, oid: `${tag}o${i >> 1}`, side: i % 3 ? 1 : -1, closedPnl: i % 4 === 0 ? (i % 8 ? 2 : -1) : null, symbol: i % 5 ? 'BTC' : 'ETH' }));
  s.putFills(batch(40, today + 1_000, 'a'));
  s.windowStats('hyperliquid', '0xa', 0);
  while (s.buildAggregates(1_000) > 0) { /* build */ }
  check('built');
  // New fills after the last one: the kept sum goes on from there.
  s.putFills(batch(30, today + 3_600_000, 'b'));
  check('appended');
  assert.equal(live().size, 1, 'today\'s sum is kept to go on from');
  // A fill at the very time of the last one summed (a second fill of that block): the day is summed whole.
  const last = live().values().next().value!.seen;
  s.putFills([fill({ id: 'same', t: last, oid: 'so' })]);
  check('a fill at the last time summed');
  // A late fill hours back, and a stream print later upgraded to its REST fill (realised PnL arrives).
  s.putFills([fill({ id: 'late', t: today + 2_000, oid: 'lo', closedPnl: 7 }), fill({ id: 'up', t: today + 7_200_000, src: 0 })]);
  check('late fill');
  s.putFills([fill({ id: 'up', t: today + 7_200_000, src: 1, closedPnl: -4 })]);
  check('stream print upgraded');
  // A re-read of rows already held changes nothing: no new version, no day marked behind.
  const v = s.version('hyperliquid', '0xa');
  s.putFills(batch(30, today + 3_600_000, 'b'));
  assert.equal(s.version('hyperliquid', '0xa'), v, 'an identical re-read is no change');
  assert.equal(live().size, 1, 'and keeps the sum to go on from');
  s.putFills(batch(5, today + 10_800_000, 'c'));
  check('appended after the re-read');
  s.close();
});

test('a window\'s first partial day is kept while that day\'s rows stand: a fill today keeps it, a late fill on that day replaces it', async () => {
  const s = new IndexStore(':memory:', { aggRefreshMs: 0 });
  const today = Math.floor(Date.now() / DAY) * DAY - DAY;
  const d0 = today - 2 * DAY;
  const memo = () => (s as unknown as { partialMemo: Map<string, unknown> }).partialMemo;
  s.putFills(Array.from({ length: 20 }, (_, i) => fill({ id: `p${i}`, t: d0 + 3_600_000 + i * 60_000, oid: `po${i}`, closedPnl: i % 3 ? 1 : null })));
  s.windowStats('hyperliquid', '0xa', 0);
  while (s.buildAggregates(1_000) > 0) { /* build */ }
  const from = d0 + 3_600_000 + 5 * 60_000 + 1;
  const pause = async () => {};
  const a = await s.windowStatsAsync('hyperliquid', '0xa', from, pause);
  assert.deepEqual(a, scan(s, 'hyperliquid', '0xa', from));
  const kept = memo().size;
  assert.ok(kept >= 1, 'the partial day is kept');
  // A fill today: the trader's version moves, the old day's does not - the same sum answers.
  s.putFills([fill({ id: 'now', t: today + 1_000, oid: 'n' })]);
  s.flushAggregates(1_000);
  assert.deepEqual(await s.windowStatsAsync('hyperliquid', '0xa', from, pause), scan(s, 'hyperliquid', '0xa', from), 'after a fill today');
  assert.equal(memo().size, kept, 'nothing summed again for it');
  // A late fill on that old day: summed again, and right.
  s.putFills([fill({ id: 'late', t: d0 + 7_200_000, oid: 'l', closedPnl: 3 })]);
  s.flushAggregates(1_000);
  assert.deepEqual(await s.windowStatsAsync('hyperliquid', '0xa', from, pause), scan(s, 'hyperliquid', '0xa', from), 'after a late fill on that day');
  s.close();
});

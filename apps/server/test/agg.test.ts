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

test('a later start in a finished day is summed from the rows held from the first read: the same figures as reading the fills again', async () => {
  const mk = () => new IndexStore(':memory:', { aggRefreshMs: 0 });
  const a = mk();
  const b = mk();
  type Held = { held: Map<string, { from: number; n: number }>; dropHeld: () => void };
  const yesterday = Math.floor(Date.now() / DAY) * DAY - DAY;
  const rows: FillRow[] = [];
  // 2,600 fills (three chunks): blocks of several fills at one time, two markets, both sides,
  // opening (0), closing and unknown PnL, fees and none, REST and stream rows.
  for (let i = 0; i < 2_600; i++) {
    const t = yesterday + 60_000 + Math.floor(i / 3) * 90_000;
    rows.push(fill({
      id: `h${i}`, t, oid: `ho${Math.floor(i / 2)}`, symbol: i % 5 ? 'BTC' : 'ETH', side: i % 7 < 4 ? 1 : -1,
      px: 100 + (i % 13) * 0.37, sz: 0.1 + (i % 11) * 0.013,
      closedPnl: i % 4 === 0 ? 0 : i % 4 === 1 ? ((i % 9) - 4) * 1.17 : i % 4 === 2 ? null : 0.31,
      fee: i % 6 ? 0.0123 * (i % 6) : null, src: i % 10 ? 1 : 0,
    }));
  }
  for (const s of [a, b]) {
    s.putFills(rows);
    s.windowStats('hyperliquid', '0xa', 0);
    while (s.buildAggregates(1_000) > 0) { /* build */ }
  }
  const pause = async () => {};
  const read = async (s: IndexStore, from: number) => ({
    stats: await s.windowStatsAsync('hyperliquid', '0xa', from, pause),
    orders: await s.orderCountAsync('hyperliquid', '0xa', from, pause),
    realized: await s.realizedAsync('hyperliquid', '0xa', from, pause),
  });
  const first = yesterday + 15 * 60_000;
  const starts = [first, first + 1, yesterday + 3_600_000, yesterday + 3_600_000 + 90_000, yesterday + 12 * 3_600_000 + 7, yesterday + 20 * 3_600_000];
  for (const from of starts) {
    (b as unknown as Held).dropHeld();
    const got = await read(a, from);
    assert.deepEqual(got, await read(b, from), `from ${from}`);
  }
  const held = (a as unknown as Held).held;
  assert.equal(held.size, 1);
  assert.equal(a.heldPartials.scans, 1, 'read from the fills once');
  assert.ok(a.heldPartials.hits >= 1, 'then from what is held');
  assert.equal(a.heldPartials.evicted, 0);
  assert.equal([...held.values()][0]!.from, first, 'every later start was summed from the rows read first');
  // A late fill on that day: its rows are read again, and the figures follow.
  const late = [fill({ id: 'late', t: yesterday + 13 * 3_600_000, oid: 'lo', closedPnl: 2.5, side: -1 })];
  for (const s of [a, b]) { s.putFills(late); s.flushAggregates(1_000); }
  const from = yesterday + 12 * 3_600_000 + 15 * 60_000;
  (b as unknown as Held).dropHeld();
  assert.deepEqual(await read(a, from), await read(b, from), 'after a late fill');
  assert.equal([...held.values()][0]!.from, from, 'read again from the new start');
  a.close();
  b.close();
});

test('the held rows go to the next writer through a file beside the index: its first read of a later start sums from them, with the same figures', async () => {
  const { mkdtempSync, existsSync, writeFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'vs-held-'));
  const path = join(dir, 'index.db');
  const file = join(dir, 'held-partial-days.bin');
  type Held = { held: Map<string, { from: number; n: number }>; heldPartials: { days: number; rows: number } };
  const yesterday = Math.floor(Date.now() / DAY) * DAY - DAY;
  const rows: FillRow[] = [];
  for (let i = 0; i < 1_500; i++) {
    rows.push(fill({
      id: `k${i}`, t: yesterday + 120_000 + Math.floor(i / 2) * 100_000, oid: `ko${i}`, symbol: i % 3 ? 'SOL' : 'xyz:TSLA', side: i % 5 < 2 ? -1 : 1,
      px: 20 + (i % 17) * 0.11, sz: 1 + (i % 7) * 0.5, closedPnl: i % 3 === 0 ? 0 : i % 3 === 1 ? (i % 8) - 3.5 : null, fee: i % 4 ? 0.02 : null, src: i % 9 ? 1 : 0,
    }));
  }
  const pause = async () => {};
  const read = async (s: IndexStore, from: number) => ({
    stats: await s.windowStatsAsync('hyperliquid', '0xa', from, pause),
    realized: await s.realizedAsync('hyperliquid', '0xa', from, pause),
  });
  const first = yesterday + 30 * 60_000;
  const later = yesterday + 9 * 3_600_000 + 45 * 60_000;
  const a = new IndexStore(path, { aggRefreshMs: 0 });
  a.putFills(rows);
  a.windowStats('hyperliquid', '0xa', 0);
  while (a.buildAggregates(1_000) > 0) { /* build */ }
  await read(a, first);
  const want = await read(a, later);
  a.close();
  assert.ok(existsSync(file), 'written as the writer closes');
  const b = new IndexStore(path, { aggRefreshMs: 0 });
  assert.ok(!existsSync(file), 'taken by the next writer');
  const given = (b as unknown as Held).heldPartials;
  assert.deepEqual({ days: given.days, rows: given.rows }, { days: 1, rows: rows.filter((r) => r.t >= first).length });
  assert.deepEqual(await read(b, later), want, 'the same figures');
  assert.equal([...(b as unknown as Held).held.values()][0]!.from, first, 'summed from the rows handed over');
  // A late fill on that day: read again.
  b.putFills([fill({ id: 'late', t: yesterday + 10 * 3_600_000, oid: 'lo', closedPnl: 1.25 })]);
  b.flushAggregates(1_000);
  const fresh = new IndexStore(':memory:', { aggRefreshMs: 0 });
  fresh.putFills([...rows, fill({ id: 'late', t: yesterday + 10 * 3_600_000, oid: 'lo', closedPnl: 1.25 })]);
  fresh.windowStats('hyperliquid', '0xa', 0);
  while (fresh.buildAggregates(1_000) > 0) { /* build */ }
  assert.deepEqual(await read(b, later), await read(fresh, later), 'after a late fill');
  b.close();
  fresh.close();
  // A file from another format, or cut short: not read, and removed.
  const c = new IndexStore(path, { aggRefreshMs: 0 });
  assert.equal((c as unknown as Held).heldPartials.days, 1, 'b handed its rows on as well');
  // A row written to a held day after it was read (a stop's last flush): that day is not handed on.
  c.putFills([fill({ id: 'flush', t: yesterday + 11 * 3_600_000, oid: 'fo' })]);
  c.close();
  assert.ok(!existsSync(file), 'nothing still as it was read: no file');
  writeFileSync(file, Buffer.from([5, 0, 0, 0, 0x7b]));
  const d = new IndexStore(path, { aggRefreshMs: 0 });
  const none = (d as unknown as Held).heldPartials;
  assert.deepEqual({ days: none.days, rows: none.rows }, { days: 0, rows: 0 });
  assert.ok(!existsSync(file));
  d.close();
  rmSync(dir, { recursive: true, force: true });
});

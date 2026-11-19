/**
 * The trade chart's kept series (seriesCache.ts): only closed bars are kept, a restore re-reads
 * every bar the stream wrote, a series too far behind is loaded afresh, least recently left first out.
 *   npx tsx --test src/chart/seriesCache.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { KLineData } from 'klinecharts';
import { gapFillLimit } from './feedHealth';
import { KEPT_BARS_MAX, KEPT_GAP_BARS, SeriesCache, keepOf, restorePlan, unverifiedAfterRead } from './seriesCache';

const MIN = 60_000;
const T0 = 1_800_000_000_000 - (1_800_000_000_000 % MIN);
const bars = (n: number, from = T0): KLineData[] =>
  Array.from({ length: n }, (_, i) => ({ timestamp: from + i * MIN, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 10 + i, turnover: 1000 + i }));

test('kept: never the newest bar (it may still be forming), nor a mark older than every kept bar', () => {
  const list = bars(500);
  const k = keepOf('perps|BTC-USD|1m', list, null, true, T0 + 500 * MIN)!;
  assert.equal(k.bars.length, 499);
  assert.equal(k.bars[k.bars.length - 1]!.timestamp, list[498]!.timestamp);
  assert.equal(k.unverifiedFrom, null);
  // The stream wrote the newest two: only the one still kept stays marked.
  const marked = keepOf('k', list, list[498]!.timestamp, true, 0)!;
  assert.equal(marked.unverifiedFrom, list[498]!.timestamp);
  // A mark on the dropped newest bar marks nothing that is kept.
  assert.equal(keepOf('k', list, list[499]!.timestamp, true, 0)!.unverifiedFrom, null);
  // A mark older than the first kept bar (trimmed away) means all of them.
  assert.equal(keepOf('k', list, T0 - 10 * MIN, true, 0)!.unverifiedFrom, T0);
  assert.equal(keepOf('k', bars(1), null, true, 0), null, 'one bar is all forming: nothing to keep');
});

test('kept: bounded per series; trimming leaves older history to the pager', () => {
  const k = keepOf('k', bars(KEPT_BARS_MAX + 600), null, false, 0)!;
  assert.equal(k.bars.length, KEPT_BARS_MAX);
  assert.equal(k.more, true, 'bars were left out at the old end');
  assert.equal(keepOf('k', bars(100), null, false, 0)!.more, false, 'the start of history stays the start');
});

test('restore: shown at once only within KEPT_GAP_BARS; the read reaches back over every unconfirmed bar', () => {
  const k = keepOf('k', bars(500), null, true, 0)!;
  const newest = k.bars[k.bars.length - 1]!.timestamp;
  // Half a minute into the bar after the newest kept one: one slot (the forming bar) is missing.
  const now = newest + MIN + 30_000;
  assert.deepEqual(restorePlan(k, now, MIN), { gap: 1, limit: gapFillLimit(newest, now, MIN, 10, 500) });
  assert.equal(restorePlan(k, newest + (KEPT_GAP_BARS + 1) * MIN - 1, MIN)?.gap, KEPT_GAP_BARS);
  assert.equal(restorePlan(k, newest + (KEPT_GAP_BARS + 1) * MIN, MIN), null, 'too far behind: loaded afresh');
  // Bars the stream wrote 40 minutes back: the read covers all of them (planMerge checks each).
  const streamed = { ...k, unverifiedFrom: newest - 40 * MIN };
  const p = restorePlan(streamed, now, MIN)!;
  assert.ok(p.limit >= 42, `limit ${p.limit} reaches back over 40 streamed bars and the new ones`);
  // More to re-check than one read can hold: loaded afresh.
  assert.equal(restorePlan({ ...k, unverifiedFrom: newest - 600 * MIN }, now, MIN), null);
  assert.equal(restorePlan(k, now, 0), null);
});

test('restore: what a right-edge read confirmed', () => {
  // Every unconfirmed bar inside the read: only its newest (and the chart's, if the stream is ahead) stay.
  assert.equal(unverifiedAfterRead(T0 + 5 * MIN, T0, T0 + 10 * MIN, T0 + 10 * MIN), T0 + 10 * MIN);
  assert.equal(unverifiedAfterRead(T0 + 5 * MIN, T0, T0 + 10 * MIN, T0 + 9 * MIN), T0 + 9 * MIN);
  assert.equal(unverifiedAfterRead(null, T0, T0 + 10 * MIN, null), T0 + 10 * MIN);
  // A short read that did not reach back to the oldest unconfirmed bar confirms nothing older.
  assert.equal(unverifiedAfterRead(T0 - MIN, T0, T0 + 10 * MIN, T0 + 10 * MIN), T0 - MIN);
});

test('cache: least recently left first out; a copy from IndexedDB never replaces a newer one', () => {
  const c = new SeriesCache(2);
  const e = (key: string, at: number) => keepOf(key, bars(3), null, true, at)!;
  c.put(e('a', 1));
  c.put(e('b', 2));
  c.put(e('a', 3));
  c.put(e('c', 4));
  assert.deepEqual(c.list().map((x) => x.key), ['c', 'a'], 'b was left longest ago');
  c.offer(e('a', 0));
  assert.equal(c.peek('a')!.at, 3, 'the older stored copy is ignored');
  c.offer(e('d', 9));
  assert.equal(c.peek('d'), null, 'a stored copy does not push out one left in this page');
  assert.equal(c.take('a')!.at, 3);
  assert.equal(c.peek('a'), null, 'taken out while on the chart');
  c.offer(e('d', 9));
  assert.equal(c.peek('d')!.at, 9);
  c.put(null);
  assert.equal(c.size, 2);
});

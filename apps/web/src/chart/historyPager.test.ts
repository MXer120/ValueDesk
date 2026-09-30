/**
 * Older bars fetched ahead of the user: contiguous pages, a runway of
 * `ahead` pages, hand-over without waiting, retries, the start of history.
 *   npx tsx --test src/chart/historyPager.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { KLineData } from 'klinecharts';
import { HISTORY_RETRY_MS, HistoryPager } from './historyPager';

const MIN = 60_000;
/** A market whose history starts at `start` (ms) with one bar a minute. */
function market(start: number, end: number) {
  const calls: Array<{ endTime: number; limit: number }> = [];
  let fail = 0;
  const fetchOlder = async (endTime: number, limit: number): Promise<KLineData[]> => {
    calls.push({ endTime, limit });
    if (fail > 0) {
      fail--;
      throw new Error('network');
    }
    const rows: KLineData[] = [];
    const last = Math.floor(endTime / MIN) * MIN;
    for (let t = last; t >= start && rows.length < limit; t -= MIN) rows.push({ timestamp: t, open: 1, high: 1, low: 1, close: 1 });
    void end;
    // The gateway answers newest first; the pager must not care.
    return rows;
  };
  return { calls, fetchOlder, failNext: (n: number) => (fail = n) };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
async function drain(times = 10) {
  for (let i = 0; i < times; i++) await settle();
}

test('keeps `ahead` pages fetched, contiguous, before anyone asks', async () => {
  const m = market(0, 10_000 * MIN);
  const first = 10_000 * MIN;
  const p = new HistoryPager({ key: 'k', firstTimestamp: first, fetchOlder: m.fetchOlder, pageSize: 100, ahead: 2 });
  p.prefetch();
  await drain();
  assert.equal(p.held, 200, 'two pages ahead');
  assert.deepEqual(m.calls.map((c) => c.endTime), [first - 1, first - 100 * MIN - 1], 'each page ends just before the one after it');
  // Handed over at once, oldest first, joining onto the chart's oldest bar.
  const page = p.take(first);
  assert.ok(page);
  assert.equal(page.rows.length, 100);
  assert.equal(page.rows[99]!.timestamp, first - MIN);
  for (let i = 1; i < page.rows.length; i++) assert.equal(page.rows[i]!.timestamp - page.rows[i - 1]!.timestamp, MIN);
  assert.equal(page.more, true);
  assert.equal(p.oldest, page.rows[0]!.timestamp);
  // And the runway is topped up again.
  await drain();
  assert.equal(p.held, 200);
  const next = p.take(p.oldest)!;
  assert.equal(next.rows[99]!.timestamp, page.rows[0]!.timestamp - MIN, 'no gap, no overlap');
  p.dispose();
});

test('waits for the page when the user outran the runway', async () => {
  const m = market(0, 10_000 * MIN);
  const first = 5_000 * MIN;
  const p = new HistoryPager({ key: 'k', firstTimestamp: first, fetchOlder: m.fetchOlder, pageSize: 50, ahead: 1 });
  assert.equal(p.take(first), null, 'nothing fetched yet');
  const page = await p.next(first);
  assert.ok(page);
  assert.equal(page.rows.length, 50);
  assert.equal(page.rows[49]!.timestamp, first - MIN);
  p.dispose();
});

test('the start of history: a page with nothing older ends it', async () => {
  const m = market(1_000 * MIN, 0);
  const first = 1_120 * MIN; // 120 bars of history before the chart's oldest
  const p = new HistoryPager({ key: 'k', firstTimestamp: first, fetchOlder: m.fetchOlder, pageSize: 100, ahead: 2 });
  p.prefetch();
  await drain();
  const a = p.take(first)!;
  assert.equal(a.rows.length, 100);
  assert.equal(a.more, true);
  await drain();
  const b = p.take(p.oldest)!;
  assert.equal(b.rows.length, 20, 'a short page is not the end by itself');
  await drain();
  assert.equal(p.more, false, 'the next fetch came back empty: the start');
  assert.deepEqual(p.take(p.oldest), { rows: [], more: false });
  p.dispose();
});

test('failures back off and retry; the waiter gets the page in the end', async () => {
  const m = market(0, 10_000 * MIN);
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const errors: number[] = [];
  const first = 3_000 * MIN;
  const p = new HistoryPager({
    key: 'k',
    firstTimestamp: first,
    fetchOlder: m.fetchOlder,
    pageSize: 10,
    ahead: 1,
    onError: (_e, failures, ms) => errors.push(ms),
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    clearTimer: () => undefined,
  });
  m.failNext(2);
  const waiting = p.next(first);
  await drain();
  assert.deepEqual(errors, [HISTORY_RETRY_MS[0]]);
  timers.shift()!.fn();
  await drain();
  assert.deepEqual(errors, [HISTORY_RETRY_MS[0], HISTORY_RETRY_MS[1]]);
  timers.shift()!.fn();
  const page = await waiting;
  assert.ok(page);
  assert.equal(page.rows.length, 10);
  p.dispose();
});

test('a chart rebuilt with a different oldest bar starts the runway again', async () => {
  const m = market(0, 10_000 * MIN);
  const p = new HistoryPager({ key: 'k', firstTimestamp: 5_000 * MIN, fetchOlder: m.fetchOlder, pageSize: 100, ahead: 1 });
  p.prefetch();
  await drain();
  assert.equal(p.held, 100);
  // The chart now starts later (it lost bars): what is held would leave a gap.
  const page = await p.next(6_000 * MIN);
  assert.ok(page);
  assert.equal(page.rows[page.rows.length - 1]!.timestamp, 6_000 * MIN - MIN);
  p.dispose();
});

test('dispose releases waiters and stops fetching', async () => {
  const m = market(0, 10_000 * MIN);
  const p = new HistoryPager({ key: 'k', firstTimestamp: 100 * MIN, fetchOlder: () => new Promise(() => undefined), pageSize: 10, ahead: 1 });
  const waiting = p.next(100 * MIN);
  p.dispose();
  assert.equal(await waiting, null);
  assert.deepEqual(p.take(100 * MIN), { rows: [], more: false });
  void m;
});

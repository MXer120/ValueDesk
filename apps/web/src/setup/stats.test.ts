/**
 * Pure indexer rules. No `@sodex-core` import — node --test loads this file
 * directly (tsx cannot resolve that alias).
 *
 *   node --experimental-strip-types --test apps/web/src/setup/stats.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAILY_KEEP, HOURLY_KEEP, HOUR_MS, PROFILE, SPEED_ORDER, SPEEDS, dayStart, emptyIndex, foldFlows, foldPage,
  hourStart, recommendProfile,
} from './stats.ts';

const ADDR = '0xabc';

test('a page of funding and trades lands in the right totals and buckets', () => {
  const day = dayStart(Date.UTC(2024, 5, 2));
  const t1 = day + HOUR_MS + 1_000;
  const t2 = day + HOUR_MS + 2_000;
  const t3 = day + 2 * HOUR_MS;
  let idx = emptyIndex(ADDR);

  let r = foldPage(idx, 'funding', [
    { timestamp: t2, fundingFee: '1.5', symbol: 'BTC-USD' },
    { timestamp: t1, fundingFee: '-0.5', symbol: 'ETH-USD' },
    { timestamp: t3, fundingFee: '0', symbol: 'BTC-USD' },
  ], { limit: 10, pass: 'older', endTime: null });
  idx = r.index;

  assert.equal(idx.t.f, 1, 'signed funding: +1.5 received and -0.5 paid');
  assert.deepEqual(idx.xf, { v: 1.5, t: t2 });
  assert.equal(idx.h.f[String(hourStart(t1))], 1);
  assert.equal(idx.h.f[String(hourStart(t3))], undefined, 'a zero payment is not a bucket');
  assert.equal(idx.d.f[String(day)], 1);
  assert.equal(idx.c.f.x, true, 'short page ends the walk');
  assert.equal(idx.c.f.h, t2);
  assert.equal(idx.c.f.b, t1);

  r = foldPage(idx, 'trades-perps', [
    { time: t3, price: '100', quantity: '2', fee: '0.5', symbol: 'BTC-USD' },
    { time: t1, price: '10', quantity: '3', fee: '-0.25', symbol: 'ETH-USD' },
  ], { limit: 10, pass: 'older', endTime: null });
  idx = r.index;

  assert.equal(idx.t.vol, 230);
  assert.equal(idx.t.fee, 0.5, 'a maker rebate is not subtracted from fees paid');
  assert.equal(idx.t.fil, 2);
  assert.deepEqual(idx.xe, { v: 0.5, t: t3 });
  assert.equal(idx.h.vol[String(hourStart(t3))], 200);
  assert.equal(idx.h.vol[String(hourStart(t1))], 30);
  assert.equal(idx.d.fil[String(day)], 2);

  r = foldPage(idx, 'orders-spot', [
    { createdAt: t2, symbol: 'BTC-USD' },
    { createdAt: t1, symbol: 'ETH-USD' },
  ], { limit: 10, pass: 'older', endTime: null });
  assert.equal(r.index.t.ord, 2);
  assert.equal(r.index.h.ord[String(hourStart(t1))], 2);
  assert.equal(r.index.c.os.x, true);
});

test('a second run with a cursor does not double-count', () => {
  const hour = 10 * HOUR_MS;
  const newer = { time: hour + HOUR_MS, price: '10', quantity: '1', fee: '0.25', symbol: 'BTC-USD' };
  const mid = { time: hour, price: '10', quantity: '1', fee: '0.25', symbol: 'BTC-USD' };
  let idx = emptyIndex(ADDR);

  let r = foldPage(idx, 'trades-perps', [newer, mid], { limit: 2, pass: 'older', endTime: null });
  idx = r.index;
  assert.equal(idx.t.fil, 2);
  assert.equal(idx.t.vol, 20);
  assert.equal(idx.t.fee, 0.5);
  assert.equal(idx.c.tp.h, newer.time);
  assert.equal(idx.c.tp.b, mid.time);
  assert.equal(idx.c.tp.x, false, 'a full page is not the end');
  assert.equal(r.nextEndTime, mid.time);

  r = foldPage(idx, 'trades-perps', [newer, mid], { limit: 2, pass: 'newer', endTime: null });
  assert.equal(r.stop, true);
  assert.equal(r.index.t.fil, 2);
  assert.equal(r.index.t.vol, 20);
  assert.equal(r.index.t.fee, 0.5);

  const fresh = { time: hour - HOUR_MS, price: '5', quantity: '2', fee: '0.25', symbol: 'ETH-USD' };
  r = foldPage(idx, 'trades-perps', [mid, fresh], { limit: 2, pass: 'older', endTime: idx.c.tp.b });
  assert.equal(r.index.t.fil, 3, 'the inclusive endTime row is not counted again');
  assert.equal(r.index.t.vol, 30);
  assert.equal(r.index.c.tp.b, fresh.time);

  const again = foldPage(r.index, 'trades-perps', [mid, fresh], { limit: 2, pass: 'older', endTime: fresh.time });
  assert.equal(again.index.t.fil, 3);
  assert.equal(again.index.t.vol, 30);
  assert.equal(again.stop, true);

  const brandNew = { time: newer.time + HOUR_MS, price: '2', quantity: '2', fee: '0.5', symbol: 'BTC-USD' };
  const caught = foldPage(idx, 'trades-perps', [brandNew, newer], { limit: 2, pass: 'newer', endTime: null });
  assert.equal(caught.stop, true, 'stops once it reaches the stored head');
  assert.equal(caught.index.t.fil, 3);
  assert.equal(caught.index.t.vol, 24);
  assert.equal(caught.index.t.fee, 1);
  assert.equal(caught.index.c.tp.h, brandNew.time);
  assert.equal(caught.index.c.tp.b, mid.time, 'a catch-up does not move the backfill cursor');

  let flows = foldFlows(emptyIndex(ADDR), [
    { time: 5_000, kind: 'deposit', amount: 100 },
    { time: 4_000, kind: 'withdraw', amount: 40 },
  ], 2, { limit: 2, pass: 'older', offset: 0 });
  assert.equal(flows.index.t.dep, 100);
  assert.equal(flows.index.t.wd, 40);
  assert.equal(flows.index.c.l.o, 2);
  assert.equal(flows.index.c.l.h, 5_000);
  assert.equal(flows.index.c.l.b, 4_000);

  const replay = foldFlows(flows.index, [
    { time: 5_000, kind: 'deposit', amount: 100 },
    { time: 4_000, kind: 'withdraw', amount: 40 },
  ], 2, { limit: 2, pass: 'newer', offset: 0 });
  assert.equal(replay.stop, true);
  assert.equal(replay.index.t.dep, 100);
  assert.equal(replay.index.t.wd, 40);

  flows = foldFlows(flows.index, [
    { time: 4_000, kind: 'deposit', amount: 7 },
    { time: 3_000, kind: 'deposit', amount: 5 },
  ], 2, { limit: 2, pass: 'older', offset: 2 });
  assert.equal(flows.index.t.dep, 105, 'the boundary flow is not counted again');
  assert.equal(flows.index.c.l.b, 3_000);
});

test('the hourly cap drops the oldest hours and keeps the all-time total', () => {
  const rows = [];
  for (let i = 399; i >= 0; i--) rows.push({ timestamp: i * HOUR_MS + 1, fundingFee: 1, symbol: 'BTC-USD' });
  const r = foldPage(emptyIndex(ADDR), 'funding', rows, { limit: rows.length, pass: 'older', endTime: null });
  const hours = Object.keys(r.index.h.f);
  assert.equal(hours.length, HOURLY_KEEP);
  assert.equal(r.index.t.f, 400);
  assert.equal(r.index.h.f['0'], undefined);
  const oldestKept = (400 - HOURLY_KEEP) * HOUR_MS;
  assert.equal(r.index.h.f[String(oldestKept)], 1);
  assert.equal(r.index.h.f[String(399 * HOUR_MS)], 1);
  assert.ok(Object.keys(r.index.d.f).length < DAILY_KEEP);
  assert.equal(r.index.d.f['0'], 24);
});

test('speed presets raise concurrency and lower the delay, and stay inside the weight budget', () => {
  for (let i = 1; i < SPEED_ORDER.length; i++) {
    const prev = SPEEDS[SPEED_ORDER[i - 1]!];
    const cur = SPEEDS[SPEED_ORDER[i]!];
    assert.ok(cur.concurrency > prev.concurrency, `${cur.id} concurrency`);
    assert.ok(cur.delayMs < prev.delayMs, `${cur.id} delay`);
  }
  assert.equal(SPEEDS.efficient.concurrency, 1);
  assert.ok(SPEEDS.efficient.delayMs >= 5_000);
  assert.equal(SPEEDS.default.concurrency, 2);
  assert.equal(SPEEDS.giga.concurrency, 4);
  // 48 starts/min × (20 + floor(100/20)) = 1,200. Giga sits on that, not under a tighter loop.
  assert.equal(SPEEDS.giga.delayMs, 1_250);
  assert.ok(SPEEDS.default.delayMs > SPEEDS.giga.delayMs);
});

test('profile recommendation thresholds', () => {
  const none = { openPositions: 0, fills: 0, orders: 0, volume: 0, markets: 0 };
  assert.equal(recommendProfile(none), 'beginner');
  assert.equal(recommendProfile({
    ...none,
    fills: PROFILE.beginnerFills - 1,
    orders: PROFILE.beginnerOrders - 1,
    volume: PROFILE.beginnerVolume - 1,
    markets: PROFILE.advancedMarkets - 1,
  }), 'beginner');
  assert.equal(recommendProfile({ ...none, openPositions: 1, markets: 1 }), 'default');
  assert.equal(recommendProfile({ ...none, fills: PROFILE.beginnerFills }), 'default');
  assert.equal(recommendProfile({ ...none, orders: PROFILE.beginnerOrders, fills: PROFILE.beginnerFills }), 'default');
  assert.equal(recommendProfile({ ...none, volume: PROFILE.beginnerVolume, fills: 8 }), 'default');
  assert.equal(recommendProfile({ ...none, markets: PROFILE.advancedMarkets }), 'advanced');
  assert.equal(recommendProfile({ ...none, volume: PROFILE.advancedVolume }), 'advanced');
  assert.equal(recommendProfile({ ...none, orders: PROFILE.advancedOrders }), 'advanced');
  assert.equal(recommendProfile({ ...none, fills: PROFILE.advancedFills }), 'advanced');
  assert.equal(recommendProfile({
    ...none,
    markets: PROFILE.advancedMarkets,
    volume: PROFILE.advancedVolume - 1,
  }), 'advanced', 'many markets is enough on its own');
});

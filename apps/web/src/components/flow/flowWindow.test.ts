import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candleAt, candleCount, flowSpan, stepCandle, windowText } from './flowWindow';

const T = Date.UTC(2026, 9, 29, 8, 17, 42, 5); // Thu 29 Oct 2026 08:17:42.005 UTC

test('candles are cut in UTC the way the venues cut them', () => {
  assert.deepEqual(candleAt('1m', T), { from: Date.UTC(2026, 9, 29, 8, 17), to: Date.UTC(2026, 9, 29, 8, 18) });
  assert.deepEqual(candleAt('15m', T), { from: Date.UTC(2026, 9, 29, 8, 15), to: Date.UTC(2026, 9, 29, 8, 30) });
  assert.deepEqual(candleAt('4h', T), { from: Date.UTC(2026, 9, 29, 8), to: Date.UTC(2026, 9, 29, 12) });
  assert.deepEqual(candleAt('1D', T), { from: Date.UTC(2026, 9, 29), to: Date.UTC(2026, 9, 30) });
  // Weeks start on Monday 00:00 UTC.
  assert.deepEqual(candleAt('1W', T), { from: Date.UTC(2026, 9, 26), to: Date.UTC(2026, 10, 2) });
  assert.equal(new Date(candleAt('1W', T).from).getUTCDay(), 1);
  assert.deepEqual(candleAt('1M', T), { from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 10, 1) });
  assert.deepEqual(candleAt('1M', Date.UTC(2026, 11, 31, 23)), { from: Date.UTC(2026, 11, 1), to: Date.UTC(2027, 0, 1) });
});

test('stepping walks whole candles, months included', () => {
  assert.deepEqual(stepCandle('1M', candleAt('1M', T), 3), { from: Date.UTC(2027, 0, 1), to: Date.UTC(2027, 1, 1) });
  assert.deepEqual(stepCandle('1h', candleAt('1h', T), -9), { from: Date.UTC(2026, 9, 28, 23), to: Date.UTC(2026, 9, 29, 0) });
  assert.match(windowText(candleAt('1h', T)), /^Oct 29, 08:00 – 09:00 UTC$/);
  assert.match(windowText(candleAt('1D', T)), /^Oct 29, 00:00 – Oct 30, 00:00 UTC$/);
});

test('a range is every candle from the picked one to the other, either way round', () => {
  const later = Date.UTC(2026, 9, 29, 8, 40, 3);
  const fwd = flowSpan('5m', T, later);
  assert.deepEqual(fwd, { from: Date.UTC(2026, 9, 29, 8, 15), to: Date.UTC(2026, 9, 29, 8, 45) });
  assert.deepEqual(flowSpan('5m', later, T), fwd);
  assert.equal(candleCount('5m', fwd), 6);
  assert.deepEqual(flowSpan('5m', T, null), candleAt('5m', T));
  assert.equal(candleCount('1M', { from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 3, 1) }), 3);
});

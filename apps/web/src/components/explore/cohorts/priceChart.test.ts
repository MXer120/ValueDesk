import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candleUp, toCandles } from './PriceChart';

test('candles: a flat candle takes the side of its move from the previous close, never grey', () => {
  const cs = [
    [0, 10, 11, 9, 10.5],
    [1, 10.5, 11, 10, 10.5], // flat, closed at the previous close -> up
    [2, 10.5, 10.5, 9, 10], // down
    [3, 9.8, 10, 9.5, 9.8], // flat, below the previous close (10) -> down
  ] as const;
  assert.deepEqual(candleUp(cs), [true, true, false, false]);
});

test('candles: an older server sends closes only - each candle opens at the previous close', () => {
  const cs = toCandles(undefined, [[0, 10], [1, 12], [2, 11]]);
  assert.deepEqual(cs, [[0, 10, 10, 10, 10], [1, 10, 12, 10, 12], [2, 12, 12, 11, 11]]);
  const given = [[0, 1, 2, 0.5, 1.5]] as const;
  assert.deepEqual(toCandles(given, []), [[0, 1, 2, 0.5, 1.5]]);
});

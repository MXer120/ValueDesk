/**
 * The plot invariant: what counts as a plot that must not be shown.
 *   npx tsx --test src/chart/invariant.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plotViolation, type PlotState } from './invariant';

const ok: PlotState = {
  bars: 500,
  range: { from: 83_500, to: 84_200, realFrom: 83_500, realTo: 84_200 },
  auto: true,
  low: 83_560,
  high: 84_080,
  candlesHidden: false,
  layerDrawing: false,
};

test('a normal chart passes', () => {
  assert.equal(plotViolation(ok), null);
  // Manual range (A off) away from the bars is the user's choice, not a fault.
  assert.equal(plotViolation({ ...ok, auto: false, range: { from: 1, to: 2, realFrom: 1, realTo: 2 } }), null);
  // Percentage axis: prices in from/to, percent in realFrom/realTo.
  assert.equal(plotViolation({ ...ok, range: { from: 83_500, to: 84_200, realFrom: -0.4, realTo: 0.43 } }), null);
  // Candles hidden while the morph layer draws them.
  assert.equal(plotViolation({ ...ok, candlesHidden: true, layerDrawing: true }), null);
});

test('the empty chart and the 0-10 scale are caught', () => {
  assert.equal(plotViolation({ ...ok, bars: 0, low: null, high: null }), 'no-bars');
  // Bars in the store but none in view: klinecharts' empty default, -1..12.
  assert.equal(plotViolation({ ...ok, range: { from: -1, to: 12, realFrom: -1, realTo: 12 } }), 'empty-default-range');
  // ...unless the market really trades between 0 and 10 and fills the view.
  assert.equal(plotViolation({ ...ok, low: 0.3, high: 9.8, range: { from: -1, to: 12, realFrom: -1, realTo: 12 } }), null);
  // A coin at 5 shown on the default range is still wrong.
  assert.equal(plotViolation({ ...ok, low: 4.9, high: 5.2, range: { from: -1, to: 12, realFrom: -1, realTo: 12 } }), 'empty-default-range');
});

test('broken ranges and misplaced fits are caught', () => {
  for (const r of [
    null,
    { from: Number.NaN, to: 1, realFrom: 0, realTo: 1 },
    { from: 0, to: Infinity, realFrom: 0, realTo: 1 },
    { from: 5, to: 5, realFrom: 5, realTo: 5 },
    { from: 6, to: 5, realFrom: 6, realTo: 5 },
  ]) {
    assert.equal(plotViolation({ ...ok, range: r }), 'invalid-range', JSON.stringify(r));
  }
  assert.equal(plotViolation({ ...ok, range: { from: 1, to: 2, realFrom: 1, realTo: 2 } }), 'range-misses-bars');
  assert.equal(plotViolation({ ...ok, range: { from: 90_000, to: 91_000, realFrom: 90_000, realTo: 91_000 } }), 'range-misses-bars');
  assert.equal(plotViolation({ ...ok, candlesHidden: true }), 'candles-hidden');
});

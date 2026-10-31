/**
 * The heatmap's resolution per coin (owner 2026-10-31: "instead 200usd ranges on btc 100 per
 * default. And via settings down to $1 (min tick on sodex)... and of course for all coins").
 *   npx tsx --test src/chart/liqSteps.test.ts
 * Prices are the laptop index's of 2026-10-31, ticks SoDEX's market list the same day.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fineWindow, niceUp, stepAt, stepLabel, stepLadder, streamAsk, streamGroup, tickOf } from './liqSteps';

test('each coin its own ladder: the default 0.125% of the price, a tenth, a hundredth, the SoDEX tick last', () => {
  assert.deepEqual(stepLadder(77_545, 1), [100, 10, 1], 'BTC: $100 (history kept $200), down to the $1 tick');
  assert.deepEqual(stepLadder(2_247.2, 0.1), [2.5, 0.25, 0.1], 'ETH: a hundredth would be under the 0.1 tick');
  assert.deepEqual(stepLadder(95.767, 0.01), [0.1, 0.01], 'SOL: the tenth is the tick');
  assert.deepEqual(stepLadder(0.075614, 0.00001), [0.0001, 0.00001], 'DOGE');
  assert.deepEqual(stepLadder(0.16456, 0.00001), [0.0002, 0.00002, 0.00001], 'ARB: decades, then the tick');
  assert.deepEqual(stepLadder(1, 0.01), [0.01], 'a tick coarser than the default: the tick alone');
  assert.deepEqual(stepLadder(0, 1), [], 'no price, no ladder');
  // Relative to the price: the same share wherever the coin trades.
  assert.deepEqual(stepLadder(155_000, 1), [200, 20, 2, 1]);
});

test('a level means the same on every coin: past the finest it is the finest; Auto is no step', () => {
  assert.equal(stepAt(0, [100, 10, 1]), 100);
  assert.equal(stepAt(2, [100, 10, 1]), 1);
  assert.equal(stepAt(2, [0.1, 0.01]), 0.01, 'SOL has no third place: its tick');
  assert.equal(stepAt('auto', [100, 10, 1]), null);
  assert.equal(stepAt(0, []), null);
});

test('steps are named in the coin\'s price units', () => {
  assert.equal(stepLabel(100), '$100');
  assert.equal(stepLabel(1), '$1');
  assert.equal(stepLabel(2.5), '$2.5');
  assert.equal(stepLabel(1_000), '$1,000');
  assert.equal(stepLabel(0.1), '$0.1');
  assert.equal(stepLabel(0.0001), '$0.0001');
  assert.equal(stepLabel(0.00002), '$0.00002');
  assert.equal(stepLabel(0.000001), '$0.000001', 'never 1e-6');
});

test('a whole number of the engine\'s buckets is the stream, summed; anything else is the fine route', () => {
  assert.equal(streamGroup(100, 20), 5, 'BTC $100 from $20 buckets');
  assert.equal(streamGroup(10, 20), null, 'BTC $10: finer than the engine');
  assert.equal(streamGroup(2.5, 0.5), 5);
  assert.equal(streamGroup(0.25, 0.5), null);
  assert.equal(streamGroup(0.1, 0.02), 5, 'SOL $0.1');
  assert.equal(streamGroup(0.0001, 0.00002), 5, 'DOGE, through float noise');
  assert.equal(streamGroup(50, 20), null, '2.5 buckets is not whole');
  // The stream sums to its own widths; the rest is summed in the widget.
  assert.equal(streamAsk(5), 5);
  assert.equal(streamAsk(8), 2);
  assert.equal(streamAsk(4), 2);
  assert.equal(streamAsk(20), 10);
  assert.equal(streamAsk(7), 1);
});

test('the fine window: the screen and half of it each side, on a shared grid, never past the cap', () => {
  // BTC zoomed in to $2,000 around the price at $1: 4,000 buckets would not hold the margin, so $2.
  const a = fineWindow(76_500, 78_500, 1);
  assert.ok(a.from <= 76_500 - 1_000 && a.to >= 78_500 + 1_000, 'the margin is read');
  assert.ok((a.to - a.from) / a.step <= 4_000, 'within the cap');
  // Zoomed in to $500: $1 holds.
  const b = fineWindow(77_300, 77_800, 1);
  assert.equal(b.step, 1);
  assert.ok((b.to - b.from) / b.step <= 4_000);
  // Zoomed out over 0.5x-1.5x: coarser for the view, a round width.
  const c = fineWindow(38_000, 116_000, 1);
  assert.ok(c.step >= 50, 'coarsened');
  assert.equal(c.step, niceUp(c.step), 'a round width');
  assert.ok((c.to - c.from) / c.step <= 4_000);
  // Two viewers a few dollars apart ask the same window (the edge shares the answer).
  assert.deepEqual(fineWindow(77_301, 77_799, 1), fineWindow(77_303, 77_802, 1));
  // A cheap coin at its tick.
  const d = fineWindow(0.074, 0.077, 0.00001);
  assert.equal(d.step, 0.00001);
  assert.ok(d.from <= 0.0725 && d.to >= 0.0785);
  for (const w of [a, b, c, d]) {
    assert.ok(Math.abs(w.from / w.step - Math.round(w.from / w.step)) < 1e-6, 'edges on the step');
    assert.ok(w.from >= 0);
  }
});

test('a coin\'s tick is its SoDEX perps market\'s; a coin SoDEX does not list gets about BTC\'s share', () => {
  const syms = [{ name: 'BTC-USD', tickSize: '1' }, { name: 'ETH-USD', tickSize: '0.1' }, { name: '1000PEPE-USD', tickSize: '0.000001' }];
  assert.equal(tickOf('BTC', syms, 77_545), 1);
  assert.equal(tickOf('ETH', syms, 2_247), 0.1);
  assert.equal(tickOf('1000PEPE', syms, 0.004962), 0.000001);
  assert.equal(tickOf('NVDA', syms, 203.57), 0.002, 'not on SoDEX: niceStep of a hundred-thousandth');
});

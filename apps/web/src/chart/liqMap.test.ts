/**
 * The liquidation layers' shared rules: the heatmap's bar sizes stay put while the view zooms
 * (they follow the price, nothing else), and the Liquidation map's levels.
 *   npx tsx --test src/chart/liqMap.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LiqHeatmap as HeatApi } from '@sign/indexer/liqRead.js';
import { coinOfSymbol, groupFor, mapData } from './liqMap';

test('a bar is a fixed share of the price in round server buckets: fine, medium, coarse', () => {
  // BTC near 80,000: the server's bucket is 20 (niceStep of 0.02%).
  assert.equal(20 * groupFor(20, 80_000, 'fine'), 100);
  assert.equal(20 * groupFor(20, 80_000, 'medium'), 200);
  assert.equal(20 * groupFor(20, 80_000, 'coarse'), 500);
  // Nothing but the step, the price and the resolution goes in: no zoom, no window, no width.
  assert.equal(groupFor.length, 3);
  // A cheap coin the same way: 0.0002 buckets at 1.00.
  assert.equal(groupFor(0.0002, 1, 'fine'), 5);
  assert.ok(groupFor(0.0002, 1, 'coarse') > groupFor(0.0002, 1, 'medium'));
});

test('the map: buckets summed to the Fine bar, the levels the price has crossed left out', () => {
  const a = {
    price: 100, step: 0.02,
    // [index, long USD, short USD, long n, short n]
    buckets: [[4900, 10, 0, 1, 0], [4910, 5, 0, 1, 0], [5010, 0, 7, 0, 1], [5020, 3, 0, 1, 0], [4990, 0, 9, 0, 1]],
  } as unknown as HeatApi;
  const d = mapData(a)!;
  // 0.1% of 100 in 0.02 buckets: 5 of them.
  assert.equal(d.step, 0.1);
  const total = (i: 1 | 2) => d.rows.reduce((s, r) => s + r[i], 0);
  // The long at 100.40 sits above the price (crossed); the short at 99.80 below it (crossed).
  assert.equal(total(1), 15);
  assert.equal(total(2), 7);
  assert.ok(d.rows.every(([lo]) => Math.abs(lo / d.step - Math.round(lo / d.step)) < 1e-6), 'rows start on the bar grid');
  assert.equal(mapData(null), null);
  assert.equal(mapData({ ...a, price: null } as unknown as HeatApi), null);
});

test('the coin of a market, as the server nets it', () => {
  assert.equal(coinOfSymbol('BTC-USD'), 'BTC');
  assert.equal(coinOfSymbol('vETH_vUSDC'), 'ETH');
  assert.equal(coinOfSymbol('xyz:TSLA'), 'TSLA');
});

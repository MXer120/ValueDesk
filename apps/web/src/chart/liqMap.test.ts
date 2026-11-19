/**
 * The liquidation layers' shared rules: the heatmap's bar sizes stay put while the view zooms
 * (they follow the price, nothing else), and the Liquidation map's levels.
 *   npx tsx --test src/chart/liqMap.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LiqHeatmap as HeatApi } from '@sign/indexer/liqRead.js';
import { barHeatmap } from '@sign/valuedesk/liquidations/bars.js';
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

test('the map from the server summed to the Fine bar (bar=fine) is the map from its buckets, to the dollar', () => {
  let x = 9;
  const r = () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
  for (const [price, step] of [[80_123.4, 20], [80_100, 20], [3_012.37, 0.5], [1.0007, 0.0002], [0.04123, 0.000005], [178.42, 0.05]] as const) {
    for (let trial = 0; trial < 20; trial++) {
      // Buckets around the price, some holding levels it has crossed (a long above it, a short below), some with bands.
      const p = trial % 4 === 0 ? Math.round(price / step) * step : price * (1 + (r() - 0.5) * 0.001);
      const by = new Map<number, number[]>();
      for (let k = 0; k < 900; k++) {
        const i = Math.floor((p * (1 + (r() - 0.5) * (k < 60 ? 0.003 : 0.4))) / step);
        const row = by.get(i) ?? [i, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        const usd = Math.round(r() ** 3 * 4e6) + 1;
        const long = r() < 0.5;
        row[long ? 1 : 2]! += usd;
        row[long ? 3 : 4]! += 1;
        if (r() < 0.7) row[(long ? 5 : 8) + Math.floor(r() * 3)]! += Math.round(usd * r());
        by.set(i, row);
      }
      const a = { coin: 'X', venues: [], at: 1, price: p, step, buckets: [...by.values()].sort((m, n) => m[0]! - n[0]!), outside: { long: 0, short: 0, longN: 0, shortN: 0 }, coverage: {} } as unknown as HeatApi;
      // What the map draws by side (liqProfile.ts drawProfile: the rows; the bands only by leverage, which the trade
      // chart's map never is - its unknown share is thresholded per bucket, liqLev.ts sideBands, so it is not compared).
      const drawn = (d: ReturnType<typeof mapData>) => d && { price: d.price, step: d.step, rows: d.rows, colorBy: d.colorBy };
      const want = drawn(mapData(a));
      const summed = barHeatmap(a, 'fine') as unknown as HeatApi;
      assert.ok(summed.buckets.length < a.buckets.length);
      assert.deepEqual(drawn(mapData(summed)), want, `price ${p} step ${step}`);
      assert.equal(mapData(summed)!.colorBy, 'side');
    }
  }
  assert.equal(barHeatmap({ price: null, step: 20, buckets: [] }, 'fine').step, 20, 'no price: as it is');
});

test('the coin of a market, as the server nets it', () => {
  assert.equal(coinOfSymbol('BTC-USD'), 'BTC');
  assert.equal(coinOfSymbol('vETH_vUSDC'), 'ETH');
  assert.equal(coinOfSymbol('xyz:TSLA'), 'TSLA');
});

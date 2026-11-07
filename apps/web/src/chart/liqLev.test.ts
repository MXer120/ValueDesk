/**
 * The liquidation layers' leverage and scales (owner 2026-10-31): bands, the filter, rows from
 * before the bands, the robust scale one giant level cannot flatten, and the historical view's
 * price axis taking in the levels as the live view's window does.
 *   node --import tsx --test src/chart/liqLev.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { KLineData } from 'klinecharts';
import type { LiqHeatmap as HeatApi } from '@sign/indexer/liqRead.js';
import { barFit, isAllLev, levBandOf, levFilterOf, levRgb, levelWindow, robustMax, shownTotal, sideBands } from './liqLev';
import { cellOf, fitRanges, heatScale, type HeatPoint } from './liqHeatIndicator';
import { mapData } from './liqMap';

test('bands: low up to 5x, mid over 5x to 20x, high over 20x (as the server)', () => {
  assert.equal(levBandOf(5), 'low');
  assert.equal(levBandOf(5.5), 'mid');
  assert.equal(levBandOf(20), 'mid');
  assert.equal(levBandOf(25), 'high');
  assert.equal(levBandOf(1000), 'high');
  assert.equal(levBandOf(null), null);
  assert.equal(levBandOf(0), null);
  // A stored filter: known bands in order; nothing left means every band.
  assert.deepEqual(levFilterOf(['high', 'x', 'low', 'low']), ['low', 'high']);
  assert.deepEqual(levFilterOf([]), ['low', 'mid', 'high']);
  assert.deepEqual(levFilterOf('high'), ['low', 'mid', 'high']);
  assert.ok(isAllLev(['high', 'mid', 'low']));
});

test('a side by band: what the bands leave is unknown; a filter shows its bands, unknown only with all', () => {
  // LiqRow [index, long, short, long n, short n, long low, mid, high, short low, mid, high].
  const row = [1, 1_000, 500, 3, 1, 200, 300, 0, 0, 0, 500];
  assert.deepEqual(sideBands(1_000, row, 5), [200, 300, 0, 500]);
  assert.deepEqual(sideBands(500, row, 8), [0, 0, 500, 0]);
  // A row from before the bands: all unknown; shown whole with every band, not at all under a filter.
  const old = [1, 1_000, 0, 3, 0];
  assert.deepEqual(sideBands(1_000, old, 5), [0, 0, 0, 1_000]);
  assert.equal(shownTotal(1_000, sideBands(1_000, old, 5), ['low', 'mid', 'high']), 1_000);
  assert.equal(shownTotal(1_000, sideBands(1_000, old, 5), ['high']), 0);
  assert.equal(shownTotal(1_000, sideBands(1_000, row, 5), ['mid']), 300);
  // A few dollars of rounding between the venues' figures is not unknown leverage.
  assert.deepEqual(sideBands(1_002, [1, 1_002, 0, 1, 0, 1_000], 5), [1_000, 0, 0, 0]);
});

test('colours: ordinal from low to high, grey for unknown', () => {
  assert.deepEqual(levRgb([1, 0, 0, 0]), [61, 139, 253]);
  assert.deepEqual(levRgb([0, 0, 1, 0]), [236, 77, 127]);
  assert.deepEqual(levRgb([0, 0, 0, 1]), [125, 133, 144]);
  assert.deepEqual(levRgb([0, 1, 0, 0]), [240, 180, 41]);
  assert.equal(levRgb([0, 0, 0, 0]), null);
});

test('the robust scale: an ordinary tail reaches full, one giant level (or a mirrored pair) does not set it', () => {
  // A heavy but ordinary tail: the largest is within 8x of the 99th percentile - no clipping.
  const tail = Array.from({ length: 200 }, (_, i) => 1_000 + i * 50);
  tail.push(40_000);
  assert.equal(robustMax(tail), 40_000);
  // SoDEX BTC 2026-10-31: two ~$70M accounts beside levels under $0.3M.
  const sodex = Array.from({ length: 100 }, (_, i) => 10_000 + i * 2_500);
  sodex.push(78_000_000, 62_500_000);
  const s = robustMax(sodex);
  assert.ok(s < 300_000 && s >= 250_000, `scale ${s}`);
  // Few values: the largest; none: 0.
  assert.equal(robustMax([5, 1e9]), 1e9);
  assert.equal(robustMax([]), 0);
});

test('the history scale: a level in every snapshot does not set it; old snapshots read as they did', () => {
  // 50 snapshots of 60 ordinary cells each (5K-64K) and one $78M cell that never goes away.
  const pts: HeatPoint[] = Array.from({ length: 50 }, (_, k) => ({
    t: k * 900_000, p: 77_500, st: 200,
    b: [...Array.from({ length: 60 }, (_, i) => [300 + i, 5_000 + i * 1_000, 0] as [number, number, number]), [429, 0, 78_000_000]],
  }));
  const sc = heatScale(pts);
  assert.ok(sc < 100_000, `scale ${sc}`);
  // Leverage: an old cell has none, so a band filter shows nothing of it and every band shows all of it.
  const old: HeatPoint['b'][number] = [300, 5_000, 0];
  assert.deepEqual(cellOf(old), { v: 5_000, bands: [0, 0, 0, 5_000] });
  assert.equal(cellOf(old, 'both', ['high']).v, 0);
  // A new cell: [index, long, short, long low, mid, high, short low, mid, high].
  const cell: HeatPoint['b'][number] = [300, 5_000, 2_000, 1_000, 4_000, 0, 0, 0, 2_000];
  assert.deepEqual(cellOf(cell, 'both', ['high']), { v: 2_000, bands: [0, 0, 2_000, 0] });
  assert.equal(cellOf(cell, 'long', ['mid', 'high']).v, 4_000);
});

test('the historical price axis takes in each bar\'s levels like the live window, not the candles alone', () => {
  // The live window: 0.5% tails left out, 10% either side of the price at least, 0.4x-1.8x at most.
  const [lo, hi] = levelWindow([[60_000, 1], [70_000, 1_000], [85_800, 78_000_000], [200_000, 1]], 200, 77_500);
  assert.ok(lo < 69_750 && lo > 69_000, `lo ${lo}`);
  assert.ok(hi > 86_000 && hi < 86_500, `hi ${hi}`);
  const [lo2, hi2] = levelWindow([[1_000, 1e9], [500_000, 1e9]], 200, 77_500);
  // Far levels: bounded at 0.4x and 1.8x of the price, then the 2% margin.
  assert.ok(lo2 < 31_000 && lo2 > 28_500 && hi2 > 139_500 && hi2 < 142_000, `${lo2} ${hi2}`);
  // Per bar: the window of the snapshot in force, only when asked (`fit`).
  const pts: HeatPoint[] = [{ t: 0, p: 77_500, st: 200, b: [[350, 1_000, 0], [429, 0, 78_000_000]] }];
  const bars = [{ timestamp: 0 }, { timestamp: 60_000 }] as KLineData[];
  const r = fitRanges(bars, { points: pts, scale: 1, fit: true });
  assert.ok(r[1]!.lo! < 69_750 && r[1]!.hi! > 85_800, JSON.stringify(r[1]));
  assert.deepEqual(fitRanges(bars, { points: pts, scale: 1 }), [{}, {}], 'the main chart\'s layer leaves the axis alone');
});

test('the map of the levels now keeps the bands shown, and reads old rows', () => {
  const a = {
    price: 100, step: 0.02,
    // One Fine bar (5 buckets of 0.02) of longs, one of a short: a high long, an old row, a low short.
    buckets: [[4900, 10_000, 0, 1, 0, 0, 0, 10_000], [4901, 5_000, 0, 1, 0], [5010, 0, 7_000, 0, 1, 0, 0, 0, 7_000]],
  } as unknown as HeatApi;
  const all = mapData(a, { colorBy: 'lev' })!;
  assert.equal(all.colorBy, 'lev');
  assert.deepEqual(all.rows.map((r) => [r[1], r[2]]), [[15_000, 0], [0, 7_000]]);
  assert.deepEqual(all.bands, [[0, 0, 10_000, 5_000], [7_000, 0, 0, 0]]);
  const high = mapData(a, { lev: ['high'] })!;
  assert.deepEqual(high.rows.map((r) => [r[1], r[2]]), [[10_000, 0]], 'the old row and the low short are left out');
});

test('barFit: zoomed out at a fine step every real level fits; only a few lone outliers run past the axis', () => {
  // ~13k bars like BTC at $1 zoomed out (the owner's screenshot, 2026-11-07): most under $4M, the axis was ~$33M (8x the
  // 99th percentile) and some 20 real levels of $35-150M ran into its top.
  let x = 7;
  const r = () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
  const bars = [...Array.from({ length: 12_980 }, () => 1e3 + r() ** 3 * 4e6), ...Array.from({ length: 20 }, () => 3.5e7 + r() * 1.15e8)];
  const top = Math.max(...bars);
  assert.equal(barFit(bars), top, 'no level is clipped');
  assert.ok(robustMax(bars) < top, 'what the quantile scale did: the top of the tail clipped');
  // SoDEX BTC: two ~$70M accounts beside levels under $0.3M - those two drawn at full, the rest readable.
  const sodex = [...Array.from({ length: 400 }, (_, i) => 1e3 + (i % 50) * 5e3), 3e5, 7.8e7, 7.7e7];
  assert.equal(barFit(sodex), 3e5);
  // A single giant one; and no gap anywhere: the largest.
  assert.equal(barFit([1, 2, 3, 100]), 3);
  assert.equal(barFit([10, 9, 8, 7, 6, 5]), 10);
  // More than three alone up there is not "a few": the largest.
  assert.equal(barFit([100, 100, 100, 100, 1, 1]), 100);
  assert.equal(barFit([]), 0);
});

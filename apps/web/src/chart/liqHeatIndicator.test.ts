import assert from 'node:assert/strict';
import test from 'node:test';
import { heatColor, heatScale, snapshotFor, type HeatPoint } from './liqHeatIndicator';

const H = 3_600_000;
const Q = 15 * 60_000;

test('a bar shows the snapshot in force at its close, not one older than two hours (or than the bar)', () => {
  const times = [0, Q, 2 * Q, 3 * Q];
  assert.equal(snapshotFor(times, 0, 60_000), 0, 'a 1m bar at 00:00 closes before the 00:15 snapshot');
  assert.equal(snapshotFor(times, Q + 60_000, 60_000), 1, 'a 1m bar inside the next quarter');
  assert.equal(snapshotFor(times, 0, H), 3, 'a 1h bar: the last snapshot taken in it');
  assert.equal(snapshotFor(times, 3 * Q + 3 * H, 60_000), -1, 'three hours after the last: nothing stands for it');
  assert.equal(snapshotFor(times, -H, 60_000), -1, 'before the first snapshot');
  assert.equal(snapshotFor([0], 0, 86_400_000), 0, 'a daily bar may reach a day back');
});

test('the scale is a high percentile of the cells, by side; colours start above the floor', () => {
  const pts: HeatPoint[] = [{ t: 0, p: 100, st: 1, b: Array.from({ length: 200 }, (_, i) => [i, i + 1, 1_000] as [number, number, number]) }];
  const both = heatScale(pts);
  assert.ok(both > 1_000 && both <= 1_201);
  assert.ok(heatScale(pts, 'long') <= 200);
  assert.equal(heatScale(pts, 'short'), 1_000);
  assert.equal(heatScale([]), 1);
  assert.equal(heatColor(0.01), null);
  assert.match(heatColor(0.5)!, /^rgba\(/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { cellRange, heatColor, heatScale, refStep, snapshotFor, stepNorm, type HeatPoint } from './liqHeatIndicator';

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

test('mixed steps: each snapshot draws over its own ranges, coloured per the newest width', () => {
  // A $200 snapshot (before 2026-10-31) and a $100 one (after), the same $2,000 of longs per $200 of price.
  const old: HeatPoint = { t: 0, p: 77_000, st: 200, b: [[380, 2_000, 0], [381, 2_000, 0]] };
  const now: HeatPoint = { t: Q, p: 77_000, st: 100, b: [[760, 1_000, 0], [761, 1_000, 0], [762, 1_000, 0], [763, 1_000, 0]] };
  assert.deepEqual(old.b.map((r) => cellRange(r, old.st)), [[76_000, 76_200], [76_200, 76_400]]);
  assert.deepEqual(now.b.map((r) => cellRange(r, now.st)), [[76_000, 76_100], [76_100, 76_200], [76_200, 76_300], [76_300, 76_400]]);
  // Both cover the same prices edge to edge: no gap, no overlap within a snapshot.
  for (const q of [old, now]) {
    const rs = q.b.map((r) => cellRange(r, q.st));
    for (let k = 1; k < rs.length; k++) assert.equal(rs[k]![0], rs[k - 1]![1]);
    assert.deepEqual([rs[0]![0], rs.at(-1)![1]], [76_000, 76_400]);
  }
  // Coloured per $100: the old cells read as half their figure, so the two snapshots look alike.
  const pts = [old, now];
  assert.equal(refStep(pts), 100);
  assert.equal(stepNorm(old, 100), 0.5);
  assert.equal(stepNorm(now, 100), 1);
  assert.equal(heatScale(pts, 'long'), 1_000, 'one scale for both: $1,000 per $100');
  assert.equal(refStep([]), null);
  assert.equal(stepNorm(old, null), 1);
});

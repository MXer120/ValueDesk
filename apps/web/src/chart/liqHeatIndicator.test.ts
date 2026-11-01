import assert from 'node:assert/strict';
import test from 'node:test';
import { boxed, cellAt, cellRange, cellsOf, heatColor, heatScale, refStep, snapshotFor, stepNorm, unboxed, type HeatData, type HeatPoint } from './liqHeatIndicator';

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

test('the layer reads exactly the data handed over, never merged into the old (the wallet filter)', async () => {
  // klinecharts' own merge, as overrideIndicator applies it (its module reads `window` on load).
  (globalThis as { window?: unknown }).window ??= { navigator: { userAgent: '' } };
  const { utils } = await import('klinecharts');
  const every: HeatData = { points: [{ t: 1, p: 100, st: 1, b: [[50, 900, 0], [60, 800, 0], [70, 700, 0]] }], scale: 800 };
  const one: HeatData = { points: [{ t: 1, p: 100, st: 1, b: [[74, 12, 0]] }], scale: 12 };
  // An object, as before: the old cells stay past the new one, coloured by the new $12 scale.
  const raw = { extendData: structuredClone(every) as unknown };
  utils.merge(raw, { extendData: one });
  assert.equal((raw.extendData as HeatData).points[0]!.b.length, 3, 'the merge kept two cells no wallet holds');
  // Boxed: replaced whole.
  const held = { extendData: boxed(every) as unknown };
  utils.merge(held, { extendData: boxed(one) });
  assert.deepEqual(unboxed<HeatData>(held.extendData), one);
  assert.equal(unboxed<HeatData>(undefined), null);
});

test('a fine part replaces the snapshot cells inside its range, widened to whole cells: no overlap, no gap', () => {
  // $100 cells 770-790 (77,000-79,000); $10 cells over 77,050-78,350, which covers $100 cells 771-782 whole.
  const q: HeatPoint = {
    t: 0, p: 77_900, st: 100,
    b: Array.from({ length: 20 }, (_, k) => [770 + k, 1_000, 0] as [number, number, number]),
    f: { st: 10, lo: 77_050, hi: 78_350, b: [[7_700, 5, 0], [7_710, 7, 0], [7_789, 9, 0], [7_834, 11, 0], [7_835, 13, 0]] },
  };
  const cells = cellsOf(q);
  // Coarse 770 (77,000-77,100: not whole inside), 771-782 out, 783-789 kept; fine 7,710-7,829 in, 7,700 and 7,834+ out.
  assert.deepEqual(cells.filter((c) => c.st === 100).map((c) => c.r[0]), [770, 783, 784, 785, 786, 787, 788, 789]);
  assert.deepEqual(cells.filter((c) => c.st === 10).map((c) => c.r[0]), [7_710, 7_789]);
  for (let k = 1; k < cells.length; k++) assert.ok(cells[k]!.lo >= cells[k - 1]!.hi - 1e-9, 'lowest first, none overlapping');
  assert.equal(cellAt(q, 77_105)?.r[0], 7_710, 'a price in the fine range: its fine cell');
  assert.equal(cellAt(q, 77_125), null, 'an empty fine cell: none (the coarse one is not drawn there)');
  assert.equal(cellAt(q, 78_450)?.r[0], 784, 'outside it: the snapshot cell');
  assert.equal(cellsOf(q), cellsOf(q), 'kept per point');
  const plain: HeatPoint = { t: 0, p: 1, st: 1, b: [[3, 1, 0]] };
  assert.deepEqual(cellsOf(plain).map((c) => [c.lo, c.hi]), [[3, 4]]);
});

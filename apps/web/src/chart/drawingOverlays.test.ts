/**
 * The arithmetic behind the extra drawing tools — the parts a wrong answer
 * would print on the chart as a confident number.
 *   npx tsx --test src/chart/drawingOverlays.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Point } from 'klinecharts';
import {
  DRAWING_OVERLAYS,
  FIB_EXTENSION_LEVELS,
  constrainPosition,
  fibExtensionValues,
  gannLabel,
  pixelAngle,
  positionLevels,
  positionReading,
  rayToEdge,
  retracement,
} from './drawingOverlays';

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('fib extension lays the A→B move off from C at every level', () => {
  const out = fibExtensionValues(100, 120, 110);
  assert.equal(out.length, FIB_EXTENSION_LEVELS.length);
  const at = (l: number) => out.find((o) => o.level === l)!.value;
  close(at(0), 110);
  close(at(1), 130);
  close(at(1.618), 110 + 20 * 1.618);
  // A falling move projects downwards.
  close(fibExtensionValues(120, 100, 110).find((o) => o.level === 1)!.value, 90);
});

test('gann labels read price units by time units', () => {
  assert.equal(gannLabel(1), '1x1');
  assert.equal(gannLabel(2), '2x1');
  assert.equal(gannLabel(8), '8x1');
  assert.equal(gannLabel(1 / 2), '1x2');
  assert.equal(gannLabel(1 / 3), '1x3');
  assert.equal(gannLabel(1 / 8), '1x8');
});

test('retracement is the share of the previous leg given back, and undefined without one', () => {
  close(retracement(100, 200, 150), 0.5);
  close(retracement(200, 100, 161.8), 0.618);
  assert.ok(Number.isNaN(retracement(100, 100, 150)));
});

test('pixel angle rises positive, as it looks on screen', () => {
  close(pixelAngle({ x: 0, y: 100 }, { x: 100, y: 0 }), 45);
  close(pixelAngle({ x: 0, y: 0 }, { x: 100, y: 100 }), -45);
  close(pixelAngle({ x: 0, y: 0 }, { x: 100, y: 0 }), 0);
});

test('a ray runs from its origin through its point to the pane edge', () => {
  assert.deepEqual(rayToEdge({ x: 0, y: 50 }, { x: 10, y: 50 }, 200, 100), { x: 200, y: 50 });
  const p = rayToEdge({ x: 0, y: 100 }, { x: 10, y: 90 }, 200, 100);
  close(p.x, 100);
  close(p.y, 0);
  // A through-point already beyond the edge is still reached.
  assert.deepEqual(rayToEdge({ x: 0, y: 0 }, { x: 300, y: 0 }, 200, 100), { x: 300, y: 0 });
});

test('position levels: the second click is the target on the profitable side, else the stop', () => {
  assert.deepEqual(positionLevels('long', 100, 110), { target: 110, stop: 90 });
  assert.deepEqual(positionLevels('long', 100, 95), { target: 105, stop: 95 });
  assert.deepEqual(positionLevels('short', 100, 90), { target: 90, stop: 110 });
  assert.deepEqual(positionLevels('short', 100, 104), { target: 96, stop: 104 });
  // With the stop drawn, both are taken as they are.
  assert.deepEqual(positionLevels('long', 100, 110, 97), { target: 110, stop: 97 });
  // A second click on the entry opens a 1% target rather than two empty zones.
  const z = positionLevels('long', 100, 100);
  close(z.target, 101);
  close(z.stop, 99);
});

test('position reading: percents from the entry and reward over risk', () => {
  const r = positionReading(100, 112, 96);
  close(r.targetPct, 12);
  close(r.stopPct, -4);
  close(r.rr, 3);
  assert.ok(Number.isNaN(positionReading(100, 110, 100).rr));
});

test('a dragged position handle cannot cross the entry, and the stop stays on the right edge', () => {
  const pts = (): Array<Partial<Point>> => [
    { timestamp: 1, dataIndex: 1, value: 100 },
    { timestamp: 9, dataIndex: 9, value: 110 },
    { timestamp: 5, dataIndex: 5, value: 90 },
  ];
  const a = pts();
  a[1]!.value = 80; // long target dragged below the entry
  constrainPosition('long', a, 1);
  assert.equal(a[1]!.value, 100);
  assert.equal(a[2]!.timestamp, 9);
  assert.equal(a[2]!.dataIndex, 9);

  const b = pts();
  b[2]!.value = 130; // long stop dragged above the entry
  constrainPosition('long', b, 2);
  assert.equal(b[2]!.value, 100);

  const c = pts();
  c[0]!.value = 150; // entry dragged past the target
  constrainPosition('long', c, 0);
  assert.equal(c[0]!.value, 110);

  const d: Array<Partial<Point>> = [
    { timestamp: 1, dataIndex: 1, value: 100 },
    { timestamp: 9, dataIndex: 9, value: 90 },
    { timestamp: 9, dataIndex: 9, value: 110 },
  ];
  d[1]!.value = 120; // short target dragged above the entry
  constrainPosition('short', d, 1);
  assert.equal(d[1]!.value, 100);
});

test('every registered tool is named, labelled and has a hint', () => {
  const names = new Set<string>();
  for (const t of DRAWING_OVERLAYS) {
    assert.ok(t.name.startsWith('ot_'), t.name);
    assert.ok(t.label.length > 0 && t.hint.length > 0, t.name);
    assert.ok(!names.has(t.name), `duplicate ${t.name}`);
    names.add(t.name);
  }
  assert.equal(names.size, 24);
  assert.ok(names.has('ot_path') && names.has('ot_note'));
});

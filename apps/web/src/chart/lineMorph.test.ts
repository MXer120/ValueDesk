/**
 * The line charts' switch morph (lineMorph.ts).
 *   npx tsx --test src/chart/lineMorph.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LINE_MORPH_MS, blendShapes, easeLineMorph, pathOf, sampleLine, samplesFor, tangents, yExtent, type Pt } from './lineMorph';
import { MORPH_MS } from './morph';
import { easeInOutCubic } from './viewTween';

test('the line morph keeps the trading chart\'s clock and curve', () => {
  assert.equal(LINE_MORPH_MS, MORPH_MS);
  for (let k = 0; k <= 20; k++) assert.equal(easeLineMorph(k / 20), easeInOutCubic(k / 20));
});

test('sampleLine: evenly spaced in x, first and last points exact, straight segments in between', () => {
  const p: Pt[] = [[0, 10], [10, 20], [40, 0]];
  const s = sampleLine(p, 5, false);
  assert.deepEqual(s.map((q) => q[0]), [0, 10, 20, 30, 40]);
  assert.deepEqual(s[0], [0, 10]);
  assert.deepEqual(s[4], [40, 0]);
  assert.equal(s[1]![1], 20);
  assert.ok(Math.abs(s[2]![1] - (20 - 20 / 3)) < 1e-9);
});

test('sampleLine smooth: passes through every point and never past one (monotone cubic)', () => {
  const p: Pt[] = [[0, 50], [30, 10], [60, 40], [90, 40], [120, 0]];
  const s = sampleLine(p, 241, true);
  for (const q of p) {
    const hit = s.find((x) => Math.abs(x[0] - q[0]) < 1e-9);
    assert.ok(hit, `a sample at x=${q[0]}`);
    assert.ok(Math.abs(hit![1] - q[1]) < 1e-9, `through (${q[0]}, ${q[1]})`);
  }
  // Between two points the curve stays inside their y range.
  for (const q of s) {
    const i = Math.min(p.length - 2, p.findIndex((a, k) => k < p.length - 1 && q[0] <= p[k + 1]![0]));
    const lo = Math.min(p[i]![1], p[i + 1]![1]);
    const hi = Math.max(p[i]![1], p[i + 1]![1]);
    assert.ok(q[1] >= lo - 1e-9 && q[1] <= hi + 1e-9, `x=${q[0]} y=${q[1]} inside [${lo}, ${hi}]`);
  }
  // The flat stretch stays flat.
  assert.equal(tangents(p)[2], 0);
  assert.equal(tangents(p)[3], 0);
});

test('blendShapes: starts on the old line, lands exactly on the new one, base on the same clock', () => {
  const a = { pts: sampleLine([[0, 0], [100, 100]], 11, false), base: 0 };
  const b = { pts: sampleLine([[0, 80], [50, 20], [100, 60]], 21, false), base: 80 };
  const start = blendShapes(a, b, 0);
  assert.equal(start.pts.length, 21);
  assert.equal(start.base, 0);
  start.pts.forEach((q, k) => assert.ok(Math.abs(q[1] - k * 5) < 1e-9, 'the old line, resampled'));
  const mid = blendShapes(a, b, 0.5);
  assert.equal(mid.base, 40);
  assert.ok(Math.abs(mid.pts[10]![1] - (50 + 20) / 2) < 1e-9);
  assert.equal(blendShapes(a, b, 1), b);
});

test('pathOf and yExtent', () => {
  assert.equal(pathOf([[0, 1], [2.25, 3]]), 'M0.0,1.0L2.3,3.0');
  assert.deepEqual(yExtent([[0, 5], [1, -2], [2, 9]]), { top: -2, foot: 9 });
  assert.equal(samplesFor(10), 24);
  assert.equal(samplesFor(400), 200);
  assert.equal(samplesFor(5000), 320);
});

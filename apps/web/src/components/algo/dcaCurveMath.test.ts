import assert from 'node:assert/strict';
import { test } from 'node:test';
import { curveAt, type CurvePoint } from './draft';
import { avgReach, fitAvg, ladderAvg, levelX, smoothCurve } from './dcaCurveMath';

const prices = [100, 98, 96, 94, 92, 90, 88, 86, 84, 82];

test('the average if all fill is coin-weighted: even USD buys more coin lower down', () => {
  const even: CurvePoint[] = [[0, 1], [1, 1]];
  assert.equal(ladderAvg(even, [100, 50], true), 75);
  // $1 at 100 and $1 at 50: 0.01 + 0.02 coin for $2.
  assert.ok(Math.abs(ladderAvg(even, [100, 50], false)! - 2 / 0.03) < 1e-9);
});

test('Smooth puts bends on orders, cleans sizes, levels near-flat runs and drops what adds nothing', () => {
  const s = smoothCurve([[0, 1.02], [0.21, 0.97], [0.48, 1.04], [0.7, 2.9], [1, 3.08]], 10);
  // 1.02, 0.97, 1.04 were meant to be level; 2.9 and 3.08 too.
  assert.deepEqual(s, [[0, 1], [0.4444, 1], [0.6667, 3], [1, 3]]);
  // A straight line stays its two ends.
  assert.deepEqual(smoothCurve([[0, 1], [0.5, 1.75], [1, 2.5]], 10), [[0, 1], [1, 2.5]]);
});

test('a target average tilts the curve to it, keeping what it spends and its bends', () => {
  const c: CurvePoint[] = [[0, 1], [0.5, 2], [1, 1.5]];
  const before = ladderAvg(c, prices, false)!;
  const out = fitAvg(c, prices, false, before - 2)!;
  assert.ok(out, 'reachable');
  assert.ok(Math.abs(ladderAvg(out, prices, false)! - (before - 2)) < 0.15);
  const sum = (p: CurvePoint[]) => prices.reduce((a, _, i) => a + curveAt(p, levelX(i, prices.length)), 0);
  assert.ok(Math.abs(sum(out) - sum(c)) / sum(c) < 0.02, 'same total');
  assert.equal(out.length, c.length);
  // Out of reach: none.
  assert.equal(fitAvg(c, prices, false, 120), null);
  const [lo, hi] = avgReach(c, prices, false)!;
  assert.ok(lo > 82 && hi < 100 && lo < before && before < hi);
});

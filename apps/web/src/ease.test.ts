/**
 * One curve for the chart and the UI: styles.css's motion tokens are the numbers src/ease.ts (and through it the
 * chart's viewTween.ts) moves on. A token edited on one side only would split the motion language again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DUR_PAGE_MS, DUR_SHEET_MS, DUR_VIEW_MS, EASE_VIEW, EASE_VIEW_CSS, cubicBezier, easeView } from './ease';
import { TWEEN_MS, easeView as chartEase } from './chart/viewTween';

const SRC = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(SRC, 'styles.css'), 'utf8');
const token = (name: string): string => {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
  assert.ok(m, `--${name} in styles.css`);
  return m![1]!.trim();
};

test('--ease-view is the chart camera curve', () => {
  const m = /^cubic-bezier\(([^)]+)\)$/.exec(token('ease-view'));
  assert.ok(m, token('ease-view'));
  assert.deepEqual(m![1]!.split(',').map((x) => Number(x.trim())), [...EASE_VIEW]);
  assert.equal(EASE_VIEW_CSS, token('ease-view'));
  assert.equal(chartEase, easeView, 'the chart takes its curve from ease.ts');
});

test('the durations match', () => {
  assert.equal(token('dur-view'), `${DUR_VIEW_MS}ms`);
  assert.equal(TWEEN_MS, DUR_VIEW_MS);
  assert.equal(token('dur-sheet'), `${DUR_SHEET_MS}ms`);
  assert.equal(token('dur-page'), `${DUR_PAGE_MS}ms`);
});

test('the curve leaves at once and lands softly', () => {
  // First frame of a 200 ms move at 60 Hz: ~7% of the way (the chart's own measure), not the expo-out's ~43%.
  const first = easeView(16.667 / 200);
  assert.ok(first > 0.05 && first < 0.09, `first frame ${first}`);
  assert.ok(cubicBezier(0.16, 1, 0.3, 1)(16.667 / 200) > 0.4, 'the old --ease-spring jumps');
  // Zero velocity at rest.
  assert.ok(1 - easeView(0.99) < 0.001);
});

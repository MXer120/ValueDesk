import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OVERSCAN, covers, rowRange } from './rowWindow';

test('the rows in view, with the overscan either side, never past the ends', () => {
  assert.deepEqual(rowRange(0, 320, 32, 500), { from: 0, to: 10 + OVERSCAN });
  assert.deepEqual(rowRange(3200, 320, 32, 500), { from: 100 - OVERSCAN, to: 110 + OVERSCAN });
  assert.deepEqual(rowRange(32 * 495, 320, 32, 500), { from: 495 - OVERSCAN, to: 500 });
  assert.deepEqual(rowRange(-50, 320, 32, 500), { from: 0, to: 10 + OVERSCAN }, 'the table starts below the view top');
});

test('a list cut short under the view keeps rows to show', () => {
  const r = rowRange(32 * 400, 320, 32, 70);
  assert.ok(r.from <= 70 && r.to === 70);
});

test('a scroll inside the overscan renders nothing new; past it, it does', () => {
  const shown = rowRange(3200, 320, 32, 500);
  assert.equal(covers(shown, 95, 115, 500), true);
  assert.equal(covers(shown, 80, 90, 500), false);
  assert.equal(covers(shown, 130, 140, 500), false);
  assert.equal(covers({ from: 60, to: 90 }, 65, 95, 80), true, 'the end of a shorter list counts as covered');
});

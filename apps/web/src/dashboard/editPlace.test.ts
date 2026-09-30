/**
 * Fill geometry. The sidebar is an obstacle in columns, and rows below the
 * fold are part of the same pass.
 *   npx tsx --test src/dashboard/editPlace.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { clearColumnSpan, fillGaps, type FillItem } from './editPlace';
import { positionSize } from './widgetCatalog';

const at = (items: FillItem[], id: string): FillItem => {
  const found = items.find((item) => item.i === id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
};

const noOverlap = (items: FillItem[]) => {
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      if (!a || !b) continue;
      const hit = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
      assert.equal(hit, false, `${a.i} overlaps ${b.i}`);
    }
  }
};

test('a right-hand obstacle blocks only the columns it covers', () => {
  const grid = { layoutWidth: 1000, visualLeft: 0, visualWidth: 500 };
  const span = clearColumnSpan(10, grid, [{ left: 400, right: 640 }], 0, 0);
  assert.deepEqual(span, { start: 0, end: 8 });
});

test('vertical scroll does not change the blocked columns', () => {
  const grid = { layoutWidth: 1000, visualLeft: 120, visualWidth: 500 };
  const side = [{ left: 520, right: 760 }];
  const first = clearColumnSpan(10, grid, side, 0, 0);
  const again = clearColumnSpan(10, { ...grid }, side, 0, 0);
  assert.deepEqual(first, again);
  assert.ok(first.end < 10);
});

test('sideways scroll changes which columns sit under the sidebar', () => {
  const side = [{ left: 400, right: 640 }];
  const covered = clearColumnSpan(10, { layoutWidth: 1000, visualLeft: 0, visualWidth: 500 }, side, 0, 0);
  const shifted = clearColumnSpan(10, { layoutWidth: 1000, visualLeft: -50, visualWidth: 500 }, side, 0, 0);
  assert.equal(covered.end, 8);
  assert.equal(shifted.end, 9);
});

test('an obstacle clear of the grid leaves every column usable', () => {
  const span = clearColumnSpan(
    10,
    { layoutWidth: 1000, visualLeft: 0, visualWidth: 500 },
    [{ left: 700, right: 900 }],
    0,
    0,
  );
  assert.deepEqual(span, { start: 0, end: 10 });
});

test('chrome on both sides leaves the middle span', () => {
  const span = clearColumnSpan(
    10,
    { layoutWidth: 1000, visualLeft: 0, visualWidth: 500 },
    [{ left: -20, right: 50 }, { left: 400, right: 640 }],
    0,
    0,
  );
  assert.deepEqual(span, { start: 1, end: 8 });
});

test('side gaps close and the canvas does not grow', () => {
  const out = fillGaps(
    [
      { i: 'a', x: 0, y: 0, w: 3, h: 4 },
      { i: 'b', x: 6, y: 0, w: 3, h: 4 },
    ],
    { start: 0, end: 10 },
  );
  noOverlap(out);
  assert.equal(at(out, 'a').x, 0);
  assert.equal(at(out, 'a').w + at(out, 'b').w, 10);
  assert.equal(at(out, 'a').x + at(out, 'a').w, at(out, 'b').x);
  assert.equal(Math.max(at(out, 'a').y + at(out, 'a').h, at(out, 'b').y + at(out, 'b').h), 4);
});

test('a hole beside a short panel is filled down to the content bottom', () => {
  const out = fillGaps(
    [
      { i: 'a', x: 0, y: 0, w: 4, h: 2 },
      { i: 'b', x: 6, y: 0, w: 4, h: 6 },
    ],
    { start: 0, end: 10 },
  );
  noOverlap(out);
  assert.equal(at(out, 'a').h, 6);
  assert.equal(at(out, 'a').y + at(out, 'a').h, 6);
  assert.equal(at(out, 'b').h, 6);
});

test('growth stops at the sidebar and a panel already under it stays put', () => {
  const out = fillGaps(
    [
      { i: 'chart', x: 0, y: 0, w: 4, h: 10 },
      { i: 'book', x: 8, y: 0, w: 2, h: 10 },
    ],
    { start: 0, end: 6 },
  );
  noOverlap(out);
  assert.deepEqual(
    { x: at(out, 'chart').x, w: at(out, 'chart').w },
    { x: 0, w: 6 },
  );
  assert.deepEqual(
    { x: at(out, 'book').x, y: at(out, 'book').y, w: at(out, 'book').w, h: at(out, 'book').h },
    { x: 8, y: 0, w: 2, h: 10 },
  );
});

test('a panel that already crosses the sidebar is not cropped', () => {
  const out = fillGaps(
    [{ i: 'chart', x: 0, y: 0, w: 8, h: 10 }],
    { start: 0, end: 6 },
  );
  assert.equal(at(out, 'chart').w, 8);
  assert.equal(at(out, 'chart').x, 0);
});

test('a gap below the fold still closes', () => {
  const out = fillGaps(
    [
      { i: 'top', x: 0, y: 0, w: 8, h: 40 },
      { i: 'a', x: 0, y: 40, w: 2, h: 4 },
      { i: 'b', x: 6, y: 40, w: 2, h: 4 },
    ],
    { start: 0, end: 8 },
  );
  noOverlap(out);
  assert.equal(at(out, 'a').y, 40);
  assert.equal(at(out, 'b').y, 40);
  assert.equal(at(out, 'a').x + at(out, 'a').w, at(out, 'b').x);
  assert.equal(at(out, 'b').x + at(out, 'b').w, 8);
});

test('position size is risk divided by the stop distance', () => {
  assert.equal(positionSize(1000, 1, 2, 50), 10);
  assert.equal(positionSize(0, 1, 2, 50), null);
  assert.equal(positionSize(1000, 1, 0, 50), null);
});

test('a panel that cannot grow in width keeps it', () => {
  const out = fillGaps(
    [
      { i: 'strip', x: 0, y: 0, w: 2, h: 2, growW: false },
      { i: 'rest', x: 4, y: 0, w: 2, h: 2 },
    ],
    { start: 0, end: 10 },
  );
  noOverlap(out);
  assert.equal(at(out, 'strip').w, 2);
  assert.equal(at(out, 'rest').x, 2);
  assert.equal(at(out, 'rest').w, 8);
});

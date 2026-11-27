import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeGap, splitMove, stackMove, swapMove, zoneAt, type ArrangeBox } from './arrange';

const box = (i: string, x: number, y: number, w: number, h: number, more: Partial<ArrangeBox> = {}): ArrangeBox => ({ i, x, y, w, h, growW: true, growH: true, minW: 4, minH: 4, ...more });

/** A terminal: the strip, chart over positions, the book a tall column, the ticket over the account. */
const page = (): ArrangeBox[] => [
  box('markets', 0, 0, 48, 4, { growH: false, minH: 4 }),
  box('chart', 0, 4, 29, 56),
  box('positions', 0, 60, 29, 30),
  box('book', 29, 4, 9, 86),
  box('exec', 38, 4, 10, 58),
  box('account', 38, 62, 10, 28),
];

/** Every cell of the 48 x 90 page covered exactly once. */
function tiled(ps: readonly { x: number; y: number; w: number; h: number }[]): boolean {
  const seen = new Uint8Array(48 * 90);
  for (const p of ps) {
    for (let y = p.y; y < p.y + p.h; y++) {
      for (let x = p.x; x < p.x + p.w; x++) {
        if (x < 0 || x >= 48 || y < 0 || y >= 90 || seen[y * 48 + x]) return false;
        seen[y * 48 + x] = 1;
      }
    }
  }
  return seen.every((c) => c === 1);
}

test('zoneAt: a side band splits, the middle swaps, a corner goes to its nearer side', () => {
  assert.equal(zoneAt(0.1, 0.5), 'left');
  assert.equal(zoneAt(0.9, 0.5), 'right');
  assert.equal(zoneAt(0.5, 0.05), 'top');
  assert.equal(zoneAt(0.5, 0.95), 'bottom');
  assert.equal(zoneAt(0.5, 0.5), 'center');
  assert.equal(zoneAt(0.05, 0.2), 'left');
});

test('swap: two panels trade rectangles, nothing else moves', () => {
  const r = swapMove(page(), 'exec', 'book');
  assert.ok(r.ok);
  const at = new Map(r.plan.placements.map((p) => [p.i, p]));
  assert.deepEqual(at.get('exec'), { i: 'exec', x: 29, y: 4, w: 9, h: 86 });
  assert.deepEqual(at.get('book'), { i: 'book', x: 38, y: 4, w: 10, h: 58 });
  assert.deepEqual(at.get('chart'), { i: 'chart', x: 0, y: 4, w: 29, h: 56 });
  assert.equal(r.plan.kind, 'swap');
});

test('swap: refused when a panel cannot take the other one\'s size', () => {
  const r = swapMove(page(), 'markets', 'chart');
  assert.deepEqual(r, { ok: false, why: 'moved' });
  const small = page().map((b) => (b.i === 'account' ? { ...b, maxH: 30 } : b));
  assert.deepEqual(swapMove(small, 'book', 'account'), { ok: false, why: 'target' });
});

test('closeGap: the one panel along a side grows across, before two stacked ones', () => {
  const rest = page().filter((b) => b.i !== 'book');
  const out = closeGap(rest, { x: 29, y: 4, w: 9, h: 86 }, true)!;
  assert.ok(out);
  // Left: chart + positions (two); right: exec + account (two). A tie goes to the left (the first side).
  assert.ok(tiled(out));
});

test('closeGap: null when no side covers the gap end to end', () => {
  const rest = [box('a', 0, 0, 10, 10), box('b', 20, 0, 10, 10)];
  assert.equal(closeGap(rest, { x: 10, y: 0, w: 10, h: 20 }, true), null);
});

test('split: the book onto the chart\'s right side - the page stays tiled, the book keeps its width', () => {
  const r = splitMove(page(), 'book', 'chart', 'right', 48, true);
  assert.ok(r.ok);
  assert.ok(tiled(r.plan.placements));
  const at = new Map(r.plan.placements.map((p) => [p.i, p]));
  const chart = at.get('chart')!;
  const book = at.get('book')!;
  assert.equal(book.y, chart.y);
  assert.equal(book.h, chart.h);
  assert.equal(book.x, chart.x + chart.w);
});

test('split: the ticket onto the top of the positions table', () => {
  const r = splitMove(page(), 'exec', 'positions', 'top', 48, true);
  assert.ok(r.ok);
  assert.ok(tiled(r.plan.placements));
  const at = new Map(r.plan.placements.map((p) => [p.i, p]));
  assert.equal(at.get('exec')!.y + at.get('exec')!.h, at.get('positions')!.y);
  assert.equal(at.get('exec')!.w, at.get('positions')!.w);
});

test('split: the middle of a target swaps', () => {
  const r = splitMove(page(), 'exec', 'book', 'center', 48, true);
  assert.ok(r.ok && r.plan.kind === 'swap');
});

test('split: a strip keeps its height when it goes over a panel', () => {
  const r = splitMove(page(), 'markets', 'chart', 'top', 48, false);
  // The strip is 48 wide and may change width: it takes the chart's 29 columns at its own 4 rows.
  assert.ok(r.ok);
  assert.ok(tiled(r.plan.placements));
  assert.equal(r.plan.box.h, 4);
});

test('move: the book to the right of the ticket - both keep their widths, the ticket takes the old place of the book', () => {
  const r = splitMove(page(), 'book', 'exec', 'right', 48, true);
  assert.ok(r.ok);
  assert.ok(tiled(r.plan.placements));
  const at = new Map(r.plan.placements.map((p) => [p.i, p]));
  assert.deepEqual(at.get('exec'), { i: 'exec', x: 29, y: 4, w: 10, h: 58 });
  assert.deepEqual(at.get('book'), { i: 'book', x: 39, y: 4, w: 9, h: 58 });
  assert.deepEqual(at.get('chart'), { i: 'chart', x: 0, y: 4, w: 29, h: 56 });
});

test('stackMove: a phone row moved above another, every row keeping its height, no gap', () => {
  const rows = [box('markets', 0, 0, 48, 2), box('ticker', 0, 2, 48, 3), box('book', 0, 5, 48, 24), box('positions', 0, 29, 48, 12), box('account', 0, 41, 48, 7)];
  const r = stackMove(rows, 'account', 'book', 'top');
  assert.ok(r.ok);
  assert.deepEqual(r.plan.placements.map((p) => `${p.i}:${p.y}+${p.h}`), ['markets:0+2', 'ticker:2+3', 'account:5+7', 'book:12+24', 'positions:36+12']);
});

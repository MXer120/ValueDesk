import assert from 'node:assert/strict';
import test from 'node:test';
import { clampSeam, findSeams, moveSeam, type SeamBox } from './seams';

const box = (i: string, x: number, y: number, w: number, h: number, o: Partial<SeamBox> = {}): SeamBox =>
  ({ i, x, y, w, h, growH: true, growW: true, minH: 4, minW: 4, ...o });

// The trade page at lg: favourites over the chart, book and ticket beside it, the tables under all three.
const trade = [
  box('markets', 0, 0, 28, 6, { growH: false }),
  box('chart', 0, 6, 28, 54),
  box('book', 28, 0, 10, 60),
  box('exec', 38, 0, 10, 60),
  box('positions', 0, 60, 38, 30),
  box('account', 38, 60, 10, 30),
];

test('the line under the chart and the book is one seam with the positions under both; the ticket and the account are another', () => {
  const at60 = findSeams(trade).filter((x) => x.axis === 'h' && x.at === 60).map((x) => [x.before.sort().join('+'), x.after.sort().join('+'), x.from, x.to]);
  assert.deepEqual(at60, [['book+chart', 'positions', 0, 38], ['exec', 'account', 38, 48]]);
});

test('a seam is offered only when both sides can resize that way', () => {
  assert.equal(findSeams(trade).some((x) => x.axis === 'h' && x.at === 6), false, 'the favourites bar keeps its height');
  const v = findSeams(trade).filter((x) => x.axis === 'v').map((x) => [x.at, x.before.sort().join('+'), x.after.sort().join('+')]);
  assert.deepEqual(v, [
    [28, 'chart+markets', 'book'],
    [38, 'book', 'exec'],
    [38, 'positions', 'account'],
  ]);
});

test('moving the seam up: the chart and the book shorter, the positions taller, nothing past them moves', () => {
  const s = findSeams(trade).find((x) => x.axis === 'h' && x.at === 60 && x.after.includes('positions'))!;
  const next = moveSeam(trade, s, -10);
  const at = (i: string) => next.find((b) => b.i === i)!;
  assert.equal(at('chart').h, 44);
  assert.equal(at('book').h, 50);
  assert.deepEqual([at('positions').y, at('positions').h], [50, 40]);
  assert.equal(at('positions').y + at('positions').h, 90);
  assert.deepEqual(at('markets'), trade[0]);
});

test('clampSeam keeps every panel on both sides at or above its minimum', () => {
  const s = findSeams(trade).find((x) => x.axis === 'h' && x.at === 60 && x.after.includes('positions'))!;
  assert.equal(clampSeam(trade, s, 40), 26, 'the positions keep 4 rows');
  assert.equal(clampSeam(trade, s, -100), -50, 'the chart keeps its 4 rows');
  const v = findSeams(trade).find((x) => x.axis === 'v' && x.at === 38 && x.before.includes('book'))!;
  assert.equal(clampSeam(trade, v, 9), 6, 'the ticket keeps 4 columns');
});

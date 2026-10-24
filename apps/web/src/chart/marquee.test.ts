/**
 * The marked area takes in what crosses it, as drawn.
 *   npx tsx --test src/chart/marquee.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxOf, marqueeHits, segmentHits, type MarqueeItem } from './marquee';

const W = 800;
const H = 400;
const box = boxOf({ x: 300, y: 100 }, { x: 200, y: 200 }); // 200..300 x 100..200
const item = (id: string, name: string, ...pts: Array<[number, number]>): MarqueeItem => ({ id, name, pts: pts.map(([x, y]) => ({ x, y })) });
const hits = (...items: MarqueeItem[]) => marqueeHits(items, box, W, H);

test('a segment counts when it crosses the box, not only when an end lies inside', () => {
  assert.ok(segmentHits({ x: 100, y: 150 }, { x: 400, y: 150 }, box));
  assert.ok(segmentHits({ x: 250, y: 150 }, { x: 900, y: 900 }, box));
  assert.ok(!segmentHits({ x: 100, y: 50 }, { x: 400, y: 50 }, box));
  assert.ok(!segmentHits({ x: 100, y: 300 }, { x: 150, y: 100 }, box));
  assert.equal(boxOf({ x: 5, y: 9 }, { x: 1, y: 2 }).left, 1);
});

test('trend lines, paths and patterns: anchors inside or a leg through the box', () => {
  assert.deepEqual(
    hits(
      item('through', 'segment', [100, 150], [400, 150]),
      item('beside', 'segment', [100, 50], [400, 60]),
      item('anchor', 'segment', [250, 150], [700, 380]),
      item('leg', 'ot_path', [0, 0], [100, 300], [400, 120], [500, 300]),
      item('triangle', 'ot_triangle', [100, 120], [180, 300], [400, 180]),
    ),
    ['through', 'anchor', 'leg', 'triangle'],
  );
});

test('rays and extended lines count where they reach', () => {
  // Pointing at the box from the left, ends short of it.
  assert.deepEqual(hits(item('ray', 'rayLine', [0, 150], [100, 150]), item('seg', 'segment', [0, 150], [100, 150])), ['ray']);
  // The extended line also runs back behind its first anchor.
  assert.deepEqual(hits(item('ext', 'straightLine', [500, 150], [600, 150]), item('ray-away', 'rayLine', [500, 150], [600, 150])), ['ext']);
});

test('horizontal and vertical tools count by their price or time', () => {
  assert.deepEqual(
    hits(
      item('h-in', 'horizontalStraightLine', [700, 150]),
      item('h-out', 'horizontalStraightLine', [700, 250]),
      item('price-right', 'priceLine', [100, 150]),
      item('price-past', 'priceLine', [350, 150]),
      item('hray-left', 'horizontalRayLine', [500, 150], [400, 150]),
      item('v-in', 'verticalStraightLine', [250, 390]),
      item('vray-up', 'verticalRayLine', [250, 390], [250, 380]),
      item('cross', 'ot_crossLine', [600, 120]),
    ),
    ['h-in', 'price-right', 'hray-left', 'v-in', 'vray-up', 'cross'],
  );
});

test('areas count where they overlap, the box inside them too', () => {
  assert.deepEqual(
    hits(
      item('big-rect', 'ot_rect', [100, 50], [500, 350]),
      item('far-rect', 'ot_rect', [500, 250], [600, 350]),
      item('fib', 'fibonacciLine', [600, 120], [700, 300]),
      item('circle', 'ot_circle', [350, 150], [400, 150]),
      item('long', 'ot_longPosition', [150, 90], [600, 90], [150, 300]),
    ),
    ['big-rect', 'fib', 'circle', 'long'],
  );
});

test('labels get a little slack; drawings without a place on screen are skipped', () => {
  assert.deepEqual(hits(item('note', 'ot_note', [305, 95]), item('nowhere', 'segment')), ['note']);
  assert.deepEqual(marqueeHits([{ id: 'half', name: 'segment', pts: [{ x: 250 }, { x: 260, y: 150 }] }], box, W, H), ['half']);
});

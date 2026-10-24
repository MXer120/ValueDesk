import assert from 'node:assert/strict';
import test from 'node:test';
import { fitVideo } from './ytPlayer';

test('a 16:9 picture fits its box, centred', () => {
  assert.deepEqual(fitVideo(1600, 900), { x: 0, y: 0, w: 1600, h: 900 });
  assert.deepEqual(fitVideo(1000, 900), { x: 0, y: 169, w: 1000, h: 563 }, 'a tall box: bars above and below');
  assert.deepEqual(fitVideo(2000, 900), { x: 200, y: 0, w: 1600, h: 900 }, 'a wide box: bars at the sides');
  assert.deepEqual(fitVideo(0, 400), { x: 0, y: 0, w: 0, h: 0 });
});

/**
 * The hero wheel's geometry (wheel.ts, used by Deck.tsx): where a card sits for its distance from the front.
 * Run (from apps/web): npx tsx --test src/components/copy/wheel.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wheelOffset, wheelPlace } from './wheel';

test('a card is measured the short way round the wheel', () => {
  assert.equal(wheelOffset(0, 0, 10), 0);
  assert.equal(wheelOffset(1, 0, 10), 1);
  assert.equal(wheelOffset(9, 0, 10), -1, 'the last card is one to the left of the first');
  assert.equal(wheelOffset(0, 9.5, 10), 0.5);
  assert.equal(wheelOffset(3, 12, 10), 1, 'turns past a full circle wrap');
  for (let at = -7; at < 7; at += 0.25) {
    for (let i = 0; i < 10; i++) {
      const d = wheelOffset(i, at, 10);
      assert.ok(d >= -5 && d < 5, `i=${i} at=${at} d=${d}`);
    }
  }
});

test('the front card is upright and whole; the others turn away symmetrically and fade out past two and a half', () => {
  const f = wheelPlace(0);
  assert.deepEqual([f.x, f.y, f.r, f.s, f.o], [0, 0, 0, 1, 1]);
  for (const d of [0.5, 1, 1.5, 2]) {
    const l = wheelPlace(-d);
    const r = wheelPlace(d);
    assert.ok(Math.abs(l.x + r.x) < 1e-9 && Math.abs(l.y - r.y) < 1e-9 && l.r === -r.r, `mirror at ${d}`);
    assert.ok(r.z < f.z, 'behind the front');
  }
  assert.equal(wheelPlace(1).o, 1, 'the neighbours are whole');
  assert.ok(wheelPlace(2).o > 0 && wheelPlace(2).o < 1, 'two out it is fading');
  assert.equal(wheelPlace(2.7).o, 0, 'gone before it reaches the back');
  assert.ok(wheelPlace(2).x > wheelPlace(1).x && wheelPlace(2).y > wheelPlace(1).y, 'further out and lower: a circle');
});

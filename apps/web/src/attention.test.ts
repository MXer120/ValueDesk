/**
 * Decorative motion rests while nobody uses the page: unfocused, or no input for STILL_MS.
 *   npx tsx --test src/attention.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STILL_MS, createAttention } from './attention';

test('still after STILL_MS without input; moving again at the next input', () => {
  const told: boolean[] = [];
  const a = createAttention((s) => told.push(s), 0);
  assert.equal(a.still, false);
  a.check(STILL_MS - 1);
  assert.equal(a.still, false);
  a.activity(STILL_MS - 1);
  a.check(2 * STILL_MS - 2);
  assert.equal(a.still, false, 'the input restarted the wait');
  a.check(2 * STILL_MS);
  assert.equal(a.still, true);
  a.activity(2 * STILL_MS + 5);
  assert.equal(a.still, false);
  assert.deepEqual(told, [true, false], 'told each change once');
});

test('a window losing focus is still at once; focus or a pointer over it moves it again', () => {
  const told: boolean[] = [];
  const a = createAttention((s) => told.push(s), 0, false);
  assert.equal(a.still, true, 'opened behind another window');
  a.focus(true, 10);
  assert.equal(a.still, false);
  a.focus(false, 20);
  assert.equal(a.still, true);
  a.activity(30); // a pointer over the unfocused window: someone is looking
  assert.equal(a.still, false);
  a.check(30 + STILL_MS);
  assert.equal(a.still, true, 'and still again once it rests');
  assert.deepEqual(told, [true, false, true, false, true]);
});

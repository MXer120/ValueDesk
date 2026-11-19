import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HeldPush } from './heldPush.ts';

type B = { timestamp: number; close: number };

test('pushes straight through while on screen', () => {
  const got: B[] = [];
  const h = new HeldPush<B>();
  h.bind((b) => got.push(b));
  h.push({ timestamp: 1, close: 10 });
  assert.deepEqual(got, [{ timestamp: 1, close: 10 }]);
});

test('off screen keeps the newest push per bar time, in order, and flushes on return', () => {
  const got: B[] = [];
  const h = new HeldPush<B>();
  h.bind((b) => got.push(b));
  h.setOff(true);
  h.push({ timestamp: 1, close: 10 });
  h.push({ timestamp: 1, close: 11 });
  h.push({ timestamp: 2, close: 12 });
  h.push({ timestamp: 2, close: 13 });
  assert.equal(got.length, 0);
  assert.equal(h.waiting, 2);
  h.setOff(false);
  assert.deepEqual(got, [
    { timestamp: 1, close: 11 },
    { timestamp: 2, close: 13 },
  ]);
  assert.equal(h.waiting, 0);
});

test('a new store drops what was held for the old one; unbound pushes nothing', () => {
  const a: B[] = [];
  const b: B[] = [];
  const h = new HeldPush<B>();
  h.bind((x) => a.push(x));
  h.setOff(true);
  h.push({ timestamp: 1, close: 1 });
  h.bind((x) => b.push(x));
  h.setOff(false);
  assert.deepEqual(a, []);
  assert.deepEqual(b, []);
  h.unbind();
  h.push({ timestamp: 2, close: 2 });
  assert.deepEqual(b, []);
});

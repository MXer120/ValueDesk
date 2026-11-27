import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intoReserve } from './reserve';

test('intoReserve: what is free covers the order first, the rest comes out of what copies and bots set aside', () => {
  assert.equal(intoReserve(50, 80, 200), 0);
  assert.equal(intoReserve(120, 80, 200), 40);
  assert.equal(intoReserve(500, 80, 200), 200);
  assert.equal(intoReserve(120, 0, 200), 120);
});

test('intoReserve: nothing set aside, an unknown account or no order is no warning', () => {
  assert.equal(intoReserve(120, 80, 0), 0);
  assert.equal(intoReserve(120, null, 200), 0);
  assert.equal(intoReserve(0, 80, 200), 0);
});

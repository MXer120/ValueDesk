import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_CHAIN, AUTO_LOAD_START, onEndSeen } from './autoLoad';

test('scrolling to the end loads a page; scrolling away resets the count', () => {
  let r = onEndSeen(AUTO_LOAD_START, true);
  assert.equal(r.load, true);
  assert.deepEqual(r.state, { chain: 1, stalled: false });
  r = onEndSeen(r.state, false); // the new rows pushed the end out of view
  assert.deepEqual(r, { state: AUTO_LOAD_START, load: false });
  r = onEndSeen(r.state, true); // the reader scrolled down again
  assert.equal(r.load, true);
});

test('an end that never leaves the screen loads AUTO_CHAIN pages, then waits for a press', () => {
  let s = AUTO_LOAD_START;
  for (let i = 0; i < AUTO_CHAIN; i++) {
    const r = onEndSeen(s, true);
    assert.equal(r.load, true, `page ${i + 1}`);
    s = r.state;
  }
  const stop = onEndSeen(s, true);
  assert.equal(stop.load, false);
  assert.equal(stop.state.stalled, true);
  // Still visible: stays waiting, never loads on its own.
  assert.deepEqual(onEndSeen(stop.state, true), { state: stop.state, load: false });
  // Out of view again: the count starts over.
  assert.deepEqual(onEndSeen(stop.state, false).state, AUTO_LOAD_START);
});

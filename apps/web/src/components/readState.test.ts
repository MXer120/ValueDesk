/**
 * What a polled read shows once a refresh fails (readState.ts): the failure
 * only when there is nothing to show; kept data with a quiet "Updating…".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SAY_AGE_MS, readShown, shownError, updatingLine } from './readState';

test('readState: a failed refresh under data on screen is "updating", not a failure', () => {
  assert.equal(readShown({ data: { positions: [{ s: 'BTC-USD' }] }, error: 'SoDEX could not be reached.' }), 'updating');
  // An empty answer is data too: "No open positions." stays, it is not "couldn't load".
  assert.equal(readShown({ data: { positions: [] }, error: 'The request timed out.' }), 'updating');
  assert.equal(readShown({ data: [], error: 'x' }), 'updating');
});

test('readState: "couldn\'t load" only when nothing was ever read', () => {
  assert.equal(readShown({ data: null, error: 'SoDEX could not be reached.' }), 'failed');
  assert.equal(readShown({ data: undefined, error: new Error('x') }), 'failed');
  assert.equal(readShown({ data: null, error: null }), 'ok');
  assert.equal(readShown({ data: { orders: [] }, error: null }), 'ok');
});

test('readState: the toast gets the error only when there is nothing to draw', () => {
  assert.equal(shownError({ data: null, error: 'down' }), 'down');
  assert.equal(shownError({ data: { orders: [] }, error: 'down' }), null);
  assert.equal(shownError({ data: null, error: null }), null);
});

test('readState: the quiet line says how old the kept copy is once it is a minute old', () => {
  const now = 10_000_000;
  assert.equal(updatingLine(now, null), 'Updating…');
  assert.equal(updatingLine(now, undefined), 'Updating…');
  assert.equal(updatingLine(now, now - 5_000), 'Updating…');
  assert.equal(updatingLine(now, now - SAY_AGE_MS + 1), 'Updating…');
  assert.equal(updatingLine(now, now - SAY_AGE_MS), 'Updating… read 1 min ago');
  assert.equal(updatingLine(now, now - 3 * 60_000 - 59_000), 'Updating… read 3 min ago');
  assert.equal(updatingLine(now, now - 2 * 3_600_000), 'Updating… read 2 h ago');
  // A clock that went backwards (another tab's stamp) is not an age.
  assert.equal(updatingLine(now, now + 60_000), 'Updating…');
});

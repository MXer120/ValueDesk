/**
 * Browser algos go on through a reload and stop when their tab was closed (tabLife.ts): told
 * apart at the next page load by how long before it the running tab last noted itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RELOAD_MS, wasClosed } from './tabLife';

const W = '0x00000000000000000000000000000000000000aa';

test('a reload (or a tab taking over) goes on; a tab closed for longer stops; a wallet never run here is neither', () => {
  const T = 1_800_000_000_000;
  assert.equal(wasClosed({ [W]: T - 3_000 }, T, W), false, 'back 3 s after the note: a reload');
  assert.equal(wasClosed({ [W]: T - RELOAD_MS }, T, W), false, 'right at the limit: still a reload');
  assert.equal(wasClosed({ [W]: T - RELOAD_MS - 1 }, T, W), true, 'later: the last tab was closed');
  assert.equal(wasClosed({ [W]: T - 3_600_000 }, T, W), true, 'an hour later');
  assert.equal(wasClosed({}, T, W), false, 'never run in this browser: nothing to stop');
  assert.equal(wasClosed({ [W]: T + 5_000 }, T, W), false, 'noted after this page loaded (this page runs them)');
});

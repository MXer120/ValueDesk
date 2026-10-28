import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mayPrune } from '../src/retention.js';

test('nothing is pruned for being old without the owner saying so', () => {
  assert.equal(mayPrune('fills', {}), false);
  assert.equal(mayPrune('liq-history', { VALUESCAN_PRUNE: '' }), false);
  assert.equal(mayPrune('status', { VALUESCAN_PRUNE: 'fills, builder' }), false);
});

test('the owner names a kind, or all', () => {
  assert.equal(mayPrune('fills', { VALUESCAN_PRUNE: 'fills, builder' }), true);
  assert.equal(mayPrune('builder', { VALUESCAN_PRUNE: ' Builder ' }), true);
  assert.equal(mayPrune('cohort-history', { VALUESCAN_PRUNE: 'all' }), true);
});

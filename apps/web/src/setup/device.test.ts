/**
 * Potato mode is a small device, never a slow frame sample.
 * Run (from apps/web): npx tsx --test src/setup/device.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestPotato } from './device';

test('a fast machine with a low frame sample stays off potato mode', () => {
  assert.equal(suggestPotato({ cores: 16, memoryGb: 8, fps: 8 }), false);
  assert.equal(suggestPotato({ cores: 8, memoryGb: 16, fps: null }), false);
  assert.equal(suggestPotato({ cores: 4, memoryGb: null, fps: 10 }), false);
  assert.equal(suggestPotato({ cores: 4, memoryGb: 8, fps: 10 }), false);
});

test('four cores and 4 GB or less is potato mode', () => {
  assert.equal(suggestPotato({ cores: 4, memoryGb: 4, fps: null }), true);
  assert.equal(suggestPotato({ cores: 2, memoryGb: 2, fps: 120 }), true);
  assert.equal(suggestPotato({ cores: 8, memoryGb: 2, fps: 10 }), false);
});

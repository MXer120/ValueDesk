/**
 * Explore is built before its first visitor and kept built while it is visited (keepExploreWarm):
 * the first visit after a release or a quiet spell waited for a whole build (14.7 s on www).
 *   npx tsx --test test/exploreWarm.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPLORE_SLICES, EXPLORE_TTL_MS, EXPLORE_WARM_MS, buildExplore, exploreWarmTick, resetExploreCache,
} from '../src/valuedesk/explore.js';
import type { VenueProvider } from '../src/valuedesk/types.js';

function provider() {
  let asked = 0;
  const p = {
    venue: 'sodex',
    leaderboard: async () => { asked++; return { rows: [], total: 0, updatedAt: Date.now(), source: 'test' }; },
  } as unknown as VenueProvider;
  return { p, asked: () => asked };
}

test('built at the start, then only past its TTL while someone visits, and not once they are gone', async () => {
  resetExploreCache();
  const { p, asked } = provider();
  const t0 = Date.now();
  assert.equal(exploreWarmTick([p], t0), null, 'nobody asked yet: nothing built');
  await exploreWarmTick([p], t0, true);
  assert.equal(asked(), EXPLORE_SLICES.length, 'the start builds it');
  await buildExplore([p]); // a visitor: answered from the build
  assert.equal(asked(), EXPLORE_SLICES.length);
  assert.equal(exploreWarmTick([p], t0 + EXPLORE_TTL_MS / 2), null, 'fresh: left alone');
  await exploreWarmTick([p], t0 + EXPLORE_TTL_MS + 1_000);
  assert.equal(asked(), 2 * EXPLORE_SLICES.length, 'past its TTL with a visitor about: built again');
  assert.equal(exploreWarmTick([p], Date.now() + EXPLORE_WARM_MS + EXPLORE_TTL_MS), null, 'nobody for EXPLORE_WARM_MS: left to rest');
  resetExploreCache();
});

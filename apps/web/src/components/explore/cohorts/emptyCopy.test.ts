/**
 * Copy for cohorts the chosen venues leave empty.
 *   npx tsx --test src/components/explore/cohorts/emptyCopy.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COHORT_BY_ID } from '@sign/valuedesk/cohorts/model.js';
import { emptyCohortText, emptyCohortsLine, venueList } from './emptyCopy';

test('venueList: one, two, several', () => {
  assert.equal(venueList([]), '');
  assert.equal(venueList(['SoDEX']), 'SoDEX');
  assert.equal(venueList(['SoDEX', 'Arcus']), 'SoDEX or Arcus');
  assert.equal(venueList(['SoDEX', 'Lighter', 'Arcus']), 'SoDEX, Lighter or Arcus');
});

test('PnL cohorts: made / lost, the range without signs or unit', () => {
  assert.equal(emptyCohortText(COHORT_BY_ID['extremely-profitable'], ['SoDEX']), 'No SoDEX wallet that made $1M+ all-time holds a position');
  assert.equal(emptyCohortText(COHORT_BY_ID['very-profitable'], ['SoDEX', 'Arcus']), 'No SoDEX or Arcus wallet that made $100K to $1M all-time holds a position');
  assert.equal(emptyCohortText(COHORT_BY_ID.rekt, ['Arcus']), 'No Arcus wallet that lost $1M+ all-time holds a position');
  assert.equal(emptyCohortText(COHORT_BY_ID['very-unprofitable'], ['SoDEX']), 'No SoDEX wallet that lost $100K to $1M all-time holds a position');
});

test('size cohorts: perp equity, holds a position', () => {
  assert.equal(emptyCohortText(COHORT_BY_ID.apex, ['SoDEX']), 'No SoDEX wallet with $5M+ perp equity holds a position');
  assert.equal(emptyCohortText(COHORT_BY_ID.whale, ['SoDEX']), 'No SoDEX wallet with $1M – $5M perp equity holds a position');
});

test('page line: names the empty cohorts, null when none', () => {
  assert.equal(emptyCohortsLine([]), null);
  assert.equal(
    emptyCohortsLine([COHORT_BY_ID['extremely-profitable'], COHORT_BY_ID.rekt]),
    'On the chosen venues no wallet holds a position in: Extremely Profitable, Rekt.',
  );
});

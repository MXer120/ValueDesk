/**
 * Copy for cohorts the chosen venues leave empty.
 *   npx tsx --test src/components/explore/cohorts/emptyCopy.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COHORT_BY_ID } from '@sign/valuescan/cohorts/model.js';
import { emptyCohortText, emptyCohortsLine, venueList } from './emptyCopy';

test('venueList: one, two, several', () => {
  assert.equal(venueList([]), '');
  assert.equal(venueList(['SoDEX']), 'SoDEX');
  assert.equal(venueList(['SoDEX', 'Arcus']), 'SoDEX or Arcus');
  assert.equal(venueList(['SoDEX', 'Lighter', 'Arcus']), 'SoDEX, Lighter or Arcus');
});

test('PnL cohorts: made / lost, the range without signs or unit', () => {
  assert.equal(emptyCohortText(COHORT_BY_ID['extremely-profitable'], ['SoDEX']), 'No SoDEX wallet has made $1M+ all-time');
  assert.equal(emptyCohortText(COHORT_BY_ID['very-profitable'], ['SoDEX', 'Arcus']), 'No SoDEX or Arcus wallet has made $100K to $1M all-time');
  assert.equal(emptyCohortText(COHORT_BY_ID.rekt, ['Arcus']), 'No Arcus wallet has lost $1M+ all-time');
  assert.equal(emptyCohortText(COHORT_BY_ID['very-unprofitable'], ['SoDEX']), 'No SoDEX wallet has lost $100K to $1M all-time');
});

test('size cohorts: holds', () => {
  assert.equal(emptyCohortText(COHORT_BY_ID.apex, ['SoDEX']), 'No SoDEX wallet holds $5M+');
  assert.equal(emptyCohortText(COHORT_BY_ID.whale, ['SoDEX']), 'No SoDEX wallet holds $1M – $5M');
});

test('page line: names the empty cohorts, null when none', () => {
  assert.equal(emptyCohortsLine([]), null);
  assert.equal(
    emptyCohortsLine([COHORT_BY_ID['extremely-profitable'], COHORT_BY_ID.rekt]),
    'The chosen venues have no wallet in: Extremely Profitable, Rekt.',
  );
});

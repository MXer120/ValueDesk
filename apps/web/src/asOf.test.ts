/**
 * The "as of" line under answers from the cohort load.
 *   npx tsx --test src/asOf.test.ts   (from apps/web)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asOfText } from './asOf';

const at = new Date(2026, 9, 30, 17, 31, 27).getTime();

test('the time it was taken; the age once it is a minute or more', () => {
  assert.equal(asOfText(at, at + 20_000), 'As of 17:31:27');
  assert.equal(asOfText(at, at + 8.7 * 60_000), 'As of 17:31:27 · 8 min ago');
  assert.equal(asOfText(at, at + 19 * 3_600_000 + 5 * 60_000), 'As of 17:31:27 · 19 h 5 min ago');
});

test('nothing for an answer without it (an older server)', () => {
  assert.equal(asOfText(undefined), null);
  assert.equal(asOfText(0), null);
});

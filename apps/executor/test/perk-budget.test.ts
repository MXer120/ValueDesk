/**
 * The invite welcome's and fee credits' budget as server 1 sends it with a lowered fee (invites/service.ts perkBudget):
 * read whole or not at all - a lowered fee never goes out without its limit.
 * Run (from apps/executor): npx tsx --test test/perk-budget.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBudget } from '../src/service.js';

test('a budget is read whole, or not at all', () => {
  assert.deepEqual(readBudget({ kind: 'welcome', capUsd: 40_000, perUsd: { copy: 1, bots: 1 }, through: 1_800_000_000_000 }), { capUsd: 40_000, perUsd: { copy: 1, bots: 1 }, through: 1_800_000_000_000 });
  assert.equal(readBudget(null), null);
  assert.equal(readBudget({ capUsd: 5, perUsd: { copy: 0.0002 }, through: 1 }), null, 'a product missing');
  assert.equal(readBudget({ capUsd: '5', perUsd: { copy: 1, bots: 1 }, through: 1 }), null, 'not a number');
  assert.equal(readBudget({ capUsd: 5, perUsd: { copy: 1, bots: 1 } }), null, 'no read time');
});

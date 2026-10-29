/**
 * The order ticket's TP/SL entry: the book walk first for a market order, then the touch, then the
 * last trade; a limit's own price; a stop's limit or trigger.
 *   npx tsx --test src/components/exitEntry.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exitEntryFor } from './exitEntry';

const base = { limitPrice: 0, stopPrice: 0, walkAvg: null, touch: 0, last: 0 };

test('market: the walk of this size, else the touch, else the last trade', () => {
  assert.equal(exitEntryFor({ ...base, type: 'market', walkAvg: 80_012.4, touch: 80_010, last: 79_990 }), 80_012.4);
  assert.equal(exitEntryFor({ ...base, type: 'market', touch: 80_010, last: 79_990 }), 80_010, 'no size yet: the touch');
  assert.equal(exitEntryFor({ ...base, type: 'market', last: 79_990 }), 79_990, 'no book: the last trade');
  assert.equal(exitEntryFor({ ...base, type: 'market', walkAvg: Number.NaN, touch: 0, last: 0 }), 0, 'nothing known: none');
});

test('limit: its own price; stop: its limit for a stop-limit, else its trigger', () => {
  assert.equal(exitEntryFor({ ...base, type: 'limit', limitPrice: 79_000, walkAvg: 80_012, touch: 80_010, last: 80_000 }), 79_000);
  assert.equal(exitEntryFor({ ...base, type: 'limit', touch: 80_010 }), 0, 'no price typed: none (not the market)');
  assert.equal(exitEntryFor({ ...base, type: 'stop', stopExec: 'market', stopPrice: 81_000, touch: 80_010 }), 81_000);
  assert.equal(exitEntryFor({ ...base, type: 'stop', stopExec: 'limit', stopPrice: 81_000, limitPrice: 81_050 }), 81_050);
  assert.equal(exitEntryFor({ ...base, type: 'stop', stopExec: 'limit', stopPrice: 81_000 }), 81_000, 'no limit yet: the trigger');
});

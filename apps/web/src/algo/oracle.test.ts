import assert from 'node:assert/strict';
import test from 'node:test';
import { combineOracle } from '@copy-engine';
import { quotesOf } from './oracle';

test('one venue: its own quote, aged on this clock', () => {
  const q = quotesOf({ ok: true, quotes: [{ venue: 'okx', bid: 99, ask: 101, mid: 100, mark: 100.5, at: 0, ageMs: 300 }] }, 10_000);
  assert.deepEqual(q, [{ venue: 'okx', bid: 99, ask: 101, mid: 100, mark: 100.5, at: 9_700 }]);
});

test('several venues: the combined price comes back out of combineOracle unchanged', () => {
  const q = quotesOf({ ok: true, mid: 100, fair: 100.2, used: ['bybit', 'okx', 'binanceFutures'], ageMs: 400 }, 10_000);
  assert.equal(q.length, 3);
  const c = combineOracle(q, 10_000, { venues: ['bybit', 'okx', 'binanceFutures'] });
  assert.equal(c.mid, 100);
  assert.equal(c.fair, 100.2);
  // Old enough, and it is stale like any quote.
  assert.equal(combineOracle(q, 20_000, { venues: null }).mid, null);
});

test('no fresh venue in the combined answer: no quotes', () => {
  assert.deepEqual(quotesOf({ ok: true, mid: null, fair: null, used: [] }, 1), []);
});

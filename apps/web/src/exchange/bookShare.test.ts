/** The book a running feed holds, handed to the ticket instead of a read of its own (bookShare.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shareBook, sharedBook } from './bookShare';

const level = (p: number): [string, string] => [String(p), '1'];

test('the ticket gets the running feed\'s book, cut to its depth, and nothing once the feed closes', () => {
  const bids = Array.from({ length: 500 }, (_, i) => level(100 - i * 0.01));
  const asks = Array.from({ length: 500 }, (_, i) => level(101 + i * 0.01));
  shareBook('perps', 'BTC-USD', { bids, asks, updateID: 7, blockTime: 1 });
  const b = sharedBook('perps', 'BTC-USD', 100);
  assert.ok(b);
  assert.equal(b.bids.length, 100);
  assert.equal(b.asks.length, 100);
  assert.deepEqual(b.bids[0], bids[0]);
  assert.equal(b.updateID, 7);
  assert.equal(sharedBook('spot', 'BTC-USD', 100), null, 'another engine\'s market is not this one');
  assert.equal(sharedBook('perps', 'ETH-USD', 100), null);
  shareBook('perps', 'BTC-USD', null);
  assert.equal(sharedBook('perps', 'BTC-USD', 100), null, 'a closed feed hands nothing out (it would go stale)');
});

test('an empty book is no copy: the ticket reads REST as before', () => {
  shareBook('perps', 'SOL-USD', { bids: [], asks: [], updateID: 1, blockTime: 1 });
  assert.equal(sharedBook('perps', 'SOL-USD', 100), null);
});

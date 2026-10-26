import assert from 'node:assert/strict';
import test from 'node:test';
import { limitImpact } from './orderImpact';

// Asks 100 (2), 101 (3); a buy of 4 limited at 101 takes 2 at 100 and 2 at 101.
const walk = [{ price: 100, taken: 2, qty: 2 }, { price: 101, taken: 2, qty: 3 }];
const buy = (limit: number, tif: 'gtc' | 'ioc' | 'gtx', qty = 4, w = walk) => limitImpact({ side: 'buy', limit, qty, tif, touch: 100, walk: w });

test('a limit that does not cross takes nothing: GTC and post only rest in full, IOC is cancelled', () => {
  assert.deepEqual(buy(99, 'gtc', 4, []), { takes: [], rest: { price: 99, qty: 4 } });
  assert.deepEqual(buy(99, 'gtx', 4, []), { takes: [], rest: { price: 99, qty: 4 } });
  assert.deepEqual(buy(99, 'ioc', 4, []), { takes: [], rest: null });
});

test('a marketable limit fills at once like a market up to its price; GTC rests what is left, IOC cancels it', () => {
  assert.deepEqual(buy(101, 'ioc'), { takes: walk, rest: null });
  assert.deepEqual(buy(101, 'gtc'), { takes: walk, rest: null }, 'all of it filled: nothing rests');
  const part = [{ price: 100, taken: 2, qty: 2 }];
  assert.deepEqual(buy(100, 'gtc', 4, part), { takes: part, rest: { price: 100, qty: 2 } });
  assert.deepEqual(buy(100, 'ioc', 4, part), { takes: part, rest: null });
});

test('post only that would take is rejected whole; a sell crosses at or under the best bid', () => {
  assert.deepEqual(buy(100, 'gtx'), { takes: [], rest: null });
  const sellWalk = [{ price: 99, taken: 1, qty: 5 }];
  assert.deepEqual(limitImpact({ side: 'sell', limit: 99, qty: 1, tif: 'gtc', touch: 99, walk: sellWalk }), { takes: sellWalk, rest: null });
  assert.deepEqual(limitImpact({ side: 'sell', limit: 100, qty: 1, tif: 'gtc', touch: 99, walk: [] }), { takes: [], rest: { price: 100, qty: 1 } });
});

test('an empty far side or no price: nothing crosses, nothing is drawn without a price', () => {
  assert.deepEqual(limitImpact({ side: 'buy', limit: 100, qty: 1, tif: 'gtc', touch: 0, walk: [] }), { takes: [], rest: { price: 100, qty: 1 } });
  assert.deepEqual(limitImpact({ side: 'buy', limit: null, qty: 1, tif: 'gtc', touch: 100, walk }), { takes: [], rest: null });
});

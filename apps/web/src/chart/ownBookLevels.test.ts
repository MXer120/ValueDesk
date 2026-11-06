import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ownBookLevels } from './orderOverlays';

test('own orders mark their rows at the book\'s grouping, stops and other markets do not', () => {
  const orders = [
    { symbol: 'BTC-USD', side: 'SELL', price: '76174', orderID: 1 },
    { symbol: 'BTC-USD', side: 'BUY', price: '76136', quantity: '0.001', orderID: 2 },
    { symbol: 'BTC-USD', side: 'SELL', price: '77000', stopPrice: '76900', orderID: 3 },
    { symbol: 'ETH-USD', side: 'BUY', price: '2200', orderID: 4 },
  ];
  const own = ownBookLevels(orders, 'BTC-USD', 10, 10);
  assert.deepEqual([...own.ask], [76180], 'an ask groups up');
  assert.deepEqual([...own.bid], [76130], 'a bid groups down');
  assert.equal(ownBookLevels(null, 'BTC-USD', 10, 10).ask.size, 0);
});

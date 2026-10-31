/**
 * The leverage the order ticket starts at: what SoDEX holds for the market (accountLeverage.ts).
 * Run (from apps/web): npx tsx --test src/trading/accountLeverage.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountLeverage } from './accountLeverage';

test('the open position\'s leverage and mode first, else the market\'s setting; none: null', () => {
  const state = {
    P: [{ s: 'BTC-USD', sz: '0.001', ep: '70000', l: 3, m: 'ISOLATED' }, { s: 'ETH-USD', sz: '0', l: 9, m: 'CROSS' }],
    S: [{ s: 'BTC-USD', l: 2, m: 'CROSS' }, { s: 'ETH-USD', l: 2, m: 'ISOLATED' }, { s: 'SOL-USD', l: 5, m: 2 }],
  };
  assert.deepEqual(accountLeverage(state, 'BTC-USD'), { leverage: 3, marginMode: 'isolated' }, 'the position\'s own');
  assert.deepEqual(accountLeverage(state, 'ETH-USD'), { leverage: 2, marginMode: 'isolated' }, 'a flat position row is not the setting');
  assert.deepEqual(accountLeverage(state, 'SOL-USD'), { leverage: 5, marginMode: 'cross' }, 'numeric mode 2 is cross');
  assert.equal(accountLeverage(state, 'DOGE-USD'), null, 'never set: the ticket keeps its own');
  assert.equal(accountLeverage(null, 'BTC-USD'), null);
  assert.equal(accountLeverage({ S: [{ s: 'BTC-USD', l: 0 }] }, 'BTC-USD'), null, 'no leverage named');
  assert.deepEqual(accountLeverage({ S: [{ symbol: 'BTC-USD', leverage: '4', marginMode: 1 }] }, 'BTC-USD'), { leverage: 4, marginMode: 'isolated' }, 'long field names too');
});

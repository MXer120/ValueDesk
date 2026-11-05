import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FILL_MAX_WAIT_MS, FILL_QUIET_MS, fillCards, fillWait, type FillGroup } from './fillBatch';

const group = (symbol: string, side: FillGroup['side'] = 'buy', fills = 1): FillGroup => ({ qty: 2, notional: 200, maker: true, side, symbol, fills });

test('a burst waits for a quiet moment, but no longer than the limit: fills that never stop still show', () => {
  assert.equal(fillWait(1_000, 1_000), FILL_QUIET_MS);
  assert.equal(fillWait(1_000, 1_000 + FILL_MAX_WAIT_MS - 100), 100);
  assert.equal(fillWait(1_000, 1_000 + FILL_MAX_WAIT_MS + 500), 0);
});

test('up to three markets get a card each, as before', () => {
  const cards = fillCards([group('BTC-USD'), group('vETH_vUSDC', 'sell')], 'perps');
  assert.equal(cards.length, 2);
  assert.equal(cards[0]!.coin, 'BTC');
  assert.match(cards[0]!.title, /long filled$/);
  assert.match(cards[0]!.detail, /@ 100 · maker$/);
  assert.match(cards[1]!.title, /short filled$/);
  assert.match(fillCards([group('BTC-USD')], 'spot')[0]!.title, /buy filled$/);
});

test('more say so on one card: every fill counted, a market on two sides named once', () => {
  const cards = fillCards([group('BTC-USD', 'buy', 30), group('BTC-USD', 'sell', 12), group('ETH-USD', 'buy', 5), group('SOL-USD', 'buy', 2), group('SUI-USD', 'buy', 1), group('ZEC-USD', 'sell', 1)], 'perps');
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.title, '51 fills');
  assert.equal(cards[0]!.coin, undefined);
  assert.match(cards[0]!.detail, / and 2 more$/);
});

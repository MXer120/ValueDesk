import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyCopy } from './emptyCopy';

test('a known sentence becomes a title, a line and an icon', () => {
  assert.deepEqual(emptyCopy('No open positions.'), {
    icon: 'positions',
    title: 'No open positions',
    line: 'Your open perpetual positions show here once you open one.',
  });
  assert.equal(emptyCopy('No open orders.').icon, 'orders');
  assert.equal(emptyCopy('Nothing held.').icon, 'coins');
});

test('a missing wallet: the sentence is the line, and the state offers Connect', () => {
  const c = emptyCopy('Connect a wallet to see open orders.');
  assert.equal(c.title, 'No wallet connected');
  assert.equal(c.line, 'Connect a wallet to see open orders.');
  assert.equal(c.wallet, true);
});

test('anything else stays a title on its own, without the full stop', () => {
  assert.deepEqual(emptyCopy('Deposits are published for mainnet only.'), { icon: 'search', title: 'Deposits are published for mainnet only' });
});

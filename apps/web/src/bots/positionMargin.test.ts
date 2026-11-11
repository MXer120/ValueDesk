import { test } from 'node:test';
import assert from 'node:assert/strict';
import { positionsMarginOf, splitPositionsMargin } from './positionMargin.ts';

// The test wallet's state on 2026-11-11 (trimmed): bots on SOL, AAVE, ENA; LIT is dust a stopped bot left.
const state = {
  im: '0',
  cm: '6.1733',
  P: [
    { s: 'SOL-USD', sz: '-0.129', ep: '84.62', l: 5 },
    { s: 'AAVE-USD', sz: '0.07', ep: '122.25', l: 5 },
    { s: 'ENA-USD', sz: '-74', ep: '0.1495', l: 5 },
    { s: 'LIT-USD', sz: '-0.1', ep: '3.2997', l: 5 },
  ],
};

test('positions on markets where bots run count as the bots\', whatever the bots\' views say they hold', () => {
  const pm = positionsMarginOf(state);
  assert.equal(pm.total, 6.1733);
  assert.ok(Math.abs(pm.bySymbol.get('SOL-USD')! - 2.183) < 1e-3);
  const caps = new Map([['SOL-USD', 6.6], ['AAVE-USD', 7.2], ['ENA-USD', 6.6]]);
  const s = splitPositionsMargin(pm, caps);
  // Only LIT (no bot there) is the user's own: 0.066 of margin (cm = the four positions at 5x).
  assert.ok(Math.abs(s.own - (6.1733 - s.bots)) < 1e-9);
  assert.ok(Math.abs(s.bots - (pm.bySymbol.get('SOL-USD')! + pm.bySymbol.get('AAVE-USD')! + pm.bySymbol.get('ENA-USD')!)) < 1e-9);
  assert.ok(s.own < 0.1);
});

test('a position bigger than what the market\'s bots may hold: the rest is the user\'s own', () => {
  const pm = positionsMarginOf({ im: 0, cm: 40, P: [{ s: 'BTC-USD', sz: '0.004', ep: '50000', l: 5 }] }); // 40 of margin
  const s = splitPositionsMargin(pm, new Map([['BTC-USD', 6.6]]));
  assert.equal(s.bots, 6.6);
  assert.equal(s.own, 40 - 6.6);
});

test('no bots: every position is the user\'s own; no state: nothing', () => {
  const pm = positionsMarginOf(state);
  assert.deepEqual(splitPositionsMargin(pm, new Map()), { bots: 0, own: 6.1733 });
  assert.deepEqual(splitPositionsMargin(positionsMarginOf(null), new Map([['SOL-USD', 5]])), { bots: 0, own: 0 });
});

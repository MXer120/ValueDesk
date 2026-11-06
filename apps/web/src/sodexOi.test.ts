import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayedOi, type SodexOiExcluded } from './sodexOi';

const ex: SodexOiExcluded = { at: 1, sizes: { 'BTC-USD': 1790.68, 'SPCX-USD': 20.5, 'BIG-USD': 500 } };

test('offsetting legs: the others are what is left', () => {
  assert.ok(Math.abs(displayedOi('BTC-USD', '1816.4', ex)! - 25.72) < 1e-9);
});

test('non-offsetting legs: the summed absolute sizes come off', () => {
  assert.equal(displayedOi('SPCX-USD', 30, ex), 9.5);
});

test('never below zero', () => {
  assert.equal(displayedOi('BIG-USD', '499', ex), 0);
  assert.equal(displayedOi('BIG-USD', '500', ex), 0);
});

test('a market the pair does not hold keeps the venue figure', () => {
  assert.equal(displayedOi('DOGE-USD', '123.5', ex), 123.5);
  assert.equal(displayedOi('DOGE-USD', '0', ex), 0);
});

test('excluded sizes unavailable: nothing to show, not the inflated figure', () => {
  assert.equal(displayedOi('BTC-USD', '1816.4', null), null);
  assert.equal(displayedOi('BTC-USD', '1816.4', undefined), null);
  assert.equal(displayedOi('DOGE-USD', '123.5', null), null);
});

test('no venue figure: nothing to show, not a zero', () => {
  for (const v of [undefined, null, '', '  ', 'x', Number.NaN]) assert.equal(displayedOi('BTC-USD', v, ex), null, String(v));
});

test('an unreadable size: nothing to show', () => {
  const bad = { at: 1, sizes: { 'BTC-USD': Number.NaN } } as SodexOiExcluded;
  assert.equal(displayedOi('BTC-USD', '10', bad), null);
});

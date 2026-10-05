/**
 * Take-profit / stop-loss price and gain, and what Confirm sends.
 *   npx tsx --test src/components/tpsl.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gainFromPrice, planExit, priceFromGain, triggerSideOk } from './tpsl';

const entry = 100;
const qty = 2;

test('gain and price meet for each side', () => {
  // Long take profit, 10% above the entry: 110, and 20 USDC on a size of 2.
  assert.equal(priceFromGain(entry, 10, 'long', 'tp', qty, 'pct'), 110);
  assert.equal(gainFromPrice(entry, 110, 'long', 'tp', qty, 'pct'), 10);
  assert.equal(gainFromPrice(entry, 110, 'long', 'tp', qty, 'usd'), 20);
  assert.equal(priceFromGain(entry, 20, 'long', 'tp', qty, 'usd'), 110);
  // Long stop, 10% under the entry.
  assert.equal(priceFromGain(entry, 10, 'long', 'sl', qty, 'pct'), 90);
  assert.equal(gainFromPrice(entry, 90, 'long', 'sl', qty, 'usd'), 20);
  // Short take profit is a lower price; short stop is a higher one.
  assert.equal(priceFromGain(entry, 10, 'short', 'tp', qty, 'pct'), 90);
  assert.equal(priceFromGain(entry, 10, 'short', 'sl', qty, 'pct'), 110);
  assert.equal(gainFromPrice(entry, 90, 'short', 'tp', qty, 'pct'), 10);
});

test('a trigger has to be on its own side of the mark', () => {
  assert.equal(triggerSideOk(110, 105, 'long', 'tp'), true);
  assert.equal(triggerSideOk(100, 105, 'long', 'tp'), false);
  assert.equal(triggerSideOk(90, 105, 'long', 'sl'), true);
  assert.equal(triggerSideOk(110, 95, 'short', 'tp'), false);
  assert.equal(triggerSideOk(90, 95, 'short', 'tp'), true);
  assert.equal(triggerSideOk(0, 95, 'long', 'sl'), false);
});

test('Confirm leaves an unchanged exit, cancels a cleared one, and replaces a type switch', () => {
  const existing = { orderID: 7, price: '110', quantity: '2', limit: false };
  assert.deepEqual(planExit(existing, { price: '110', quantity: '2', limit: false }), { action: 'keep' });
  assert.deepEqual(planExit(existing, { price: '', quantity: '2', limit: false }), { action: 'cancel' });
  assert.deepEqual(planExit(undefined, { price: '', quantity: '2', limit: false }), { action: 'keep' });
  assert.deepEqual(planExit(undefined, { price: '110', quantity: '2', limit: true }), {
    action: 'place', price: '110', quantity: '2', limit: true,
  });
  assert.deepEqual(planExit(existing, { price: '112', quantity: '2', limit: false }), {
    action: 'modify', price: '112',
  });
  assert.deepEqual(planExit(existing, { price: '110', quantity: '1', limit: false }), {
    action: 'modify', quantity: '1',
  });
  assert.deepEqual(planExit({ ...existing, limit: true }, { price: '112', quantity: '2', limit: true }), {
    action: 'modify', price: '112', limitPrice: '112',
  });
  assert.equal(planExit(existing, { price: '110', quantity: '2', limit: true }).action, 'replace');
  assert.equal(planExit({ ...existing, orderID: undefined }, { price: '112', quantity: '2', limit: false }).action, 'replace');
});

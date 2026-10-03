/**
 * Order lines on the chart: which can be dragged. A spot order is moved like a
 * perps one - changeOrder (trading/actions.ts) picks SoDEX's request - so the
 * only gate left is the one the chart passes in (a locked key).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderLines } from './orderOverlays';

const spotLimit = { symbol: 'vBTC_vUSDC', orderID: 77, side: 'BUY', price: '60000', quantity: '0.001', type: 'LIMIT', timeInForce: 'GTC' };

test('a spot limit order is a draggable line when the key may sign', () => {
  const [line, ...rest] = orderLines([spotLimit], { symbol: 'vBTC_vUSDC', canModify: true });
  assert.equal(rest.length, 0);
  assert.equal(line?.kind, 'limit');
  assert.equal(line?.orderID, 77);
  assert.equal(line?.quantity, '0.001', 'the size is re-sent with the move');
  assert.equal(line?.draggable, true);
  assert.equal(line?.lockedReason, undefined);
});

test('a locked key: drawn, not draggable, and it says why', () => {
  const [line] = orderLines([spotLimit], { symbol: 'vBTC_vUSDC', canModify: false, cannotModifyReason: 'Read-only' });
  assert.equal(line?.draggable, false);
  assert.equal(line?.lockedReason, 'Read-only');
});

test('orders of another market are not drawn', () => {
  assert.deepEqual(orderLines([spotLimit], { symbol: 'vETH_vUSDC', canModify: true }), []);
});

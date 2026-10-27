import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveKeyOf, ordersFromPush, positionsFromPush, restOrder, stateFromPush, STATE_ORDER_CAP } from './liveAccount';

const A = '0xbac7be5dc95f6085c9c7fca2d55cab0557a10394';

// Taken from a live mainnet push and the REST reads of the same wallet at the same moment (2026-10-27).
const statePos = { i: 6848841, s: 'CL-USD', m: 'CROSS', ps: 'BOTH', sz: '-536.657', ep: '97.412005126463314059', co: '52276.83443515242273312', cf: '9.777981774896', ff: '48.570305852748', cc: '300', cp: '91.33', ms: '636.657', cr: '835.578531072681266879', ur: '-2163.79', l: 5, lp: '370.02', ct: 1781614376218, ut: 1793106000038 };
const restPos = { id: 6848841, symbol: 'CL-USD', marginMode: 'CROSS', positionSide: 'BOTH', size: '-536.657', initialMargin: '10455.366887030558', avgEntryPrice: '97.412005126463314059', cumOpenCost: '52276.83443515242273312', cumTradingFee: '9.777981774896', cumFundingFee: '-950.024195128191', cumClosedSize: '300', avgClosePrice: '91.33', maxSize: '636.657', realizedPnL: '835.578531072681266879', leverage: 5, active: true, isTakenOver: false, takeOverPrice: '0', createdAt: 1781614376218, updatedAt: 1793106000038 };
const stateOrd = { s: 'CL-USD', c: '12855-1786949338104', i: 16296382568, S: 'BUY', o: 'LIMIT', f: 'GTC', p: '68.83', q: '33.684', X: 'NEW', z: '0', v: '0', M: '0', ct: 1786949338374, ut: 1786949338374, ps: 'BOTH', R: true };
const restOrd = { symbol: 'CL-USD', orderID: 16296382568, clOrdID: '12855-1786949338104', side: 'BUY', type: 'LIMIT', timeInForce: 'GTC', price: '68.83', origQty: '33.684', status: 'NEW', executedQty: '0', executedValue: '0', marginFrozen: '0', createdAt: 1786949338374, updatedAt: 1786949338374, positionSide: 'BOTH', reduceOnly: true };

test('only the account feeds a push can fill', () => {
  assert.deepEqual(liveKeyOf(`state:perps:${A}`), { kind: 'state', engine: 'perps', user: A });
  assert.deepEqual(liveKeyOf(`orders:spot:${A}`), { kind: 'orders', engine: 'spot', user: A });
  assert.deepEqual(liveKeyOf(`pos:${A}`), { kind: 'pos', engine: 'perps', user: A });
  assert.equal(liveKeyOf(`trades:perps:${A}`), null);
  assert.equal(liveKeyOf('pos:nope'), null);
});

test('an order in the push reads exactly as /orders lists it', () => {
  assert.deepEqual(restOrder(stateOrd), restOrd);
  assert.deepEqual(ordersFromPush('perps', { O: [stateOrd] }), { engine: 'perps', orders: [restOrd] });
  // The state holds the latest 100: with that many, REST decides.
  assert.equal(ordersFromPush('perps', { O: new Array(STATE_ORDER_CAP).fill(stateOrd) }), null);
});

test('a position in the push reads as /positions, keeping what only REST knows', () => {
  assert.deepEqual(positionsFromPush({ P: [statePos] }, { positions: [restPos] }), { positions: [restPos] });
  // Size changed: the cross margin is size x entry / leverage, the funding total still REST's.
  const grown = positionsFromPush({ P: [{ ...statePos, sz: '-600' }] }, { positions: [restPos] })!.positions[0]!;
  assert.equal(grown.size, '-600');
  assert.ok(Math.abs(Number(grown.initialMargin) - (600 * 97.412005126463314059) / 5) < 1e-6);
  assert.equal(grown.cumFundingFee, '-950.024195128191');
  // A closed one is gone; a position REST has not seen yet sends the feed to REST.
  assert.deepEqual(positionsFromPush({ P: [{ ...statePos, sz: '0' }] }, { positions: [restPos] }), { positions: [] });
  assert.equal(positionsFromPush({ P: [{ ...statePos, i: 1 }] }, { positions: [restPos] }), null);
});

test('the state is passed on as /state answers it', () => {
  const d = { aid: 12855, uid: 7, B: [], O: [], P: [] };
  assert.deepEqual(stateFromPush('perps', A, d), { engine: 'perps', address: A, accountId: 12855, userId: 7, exists: true, state: d });
});

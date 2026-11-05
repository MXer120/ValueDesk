/**
 * Order lines on the chart: which can be dragged. A spot order is moved like a
 * perps one - changeOrder (trading/actions.ts) picks SoDEX's request - so the
 * only gate left is the one the chart passes in (a locked key).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtQty } from '../format';
import { draftInkSide, draftLabelParts } from './DraftOrderLines';
import { layoutLabels, orderLines, positionLines } from './orderOverlays';

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

test('each line says what it is in one word, and its size apart from it', () => {
  const o = { symbol: 'S', canModify: true };
  const stop = (extra: object) => orderLines([{ symbol: 'S', orderID: 1, side: 'SELL', stopPrice: '90', quantity: '2', ...extra }], o)[0];
  const limit = orderLines([{ symbol: 'S', orderID: 2, side: 'SELL', price: '100', quantity: '2', type: 'LIMIT' }], o)[0];
  assert.equal(limit?.tag, 'Sell limit');
  assert.equal(limit?.amount, fmtQty('2'));
  assert.equal(stop({ stopType: 'TAKE_PROFIT', reduceOnly: true })?.tag, 'TP');
  assert.equal(stop({ stopType: 'STOP_LOSS', reduceOnly: true })?.tag, 'SL');
  assert.equal(stop({ stopType: 2, reduceOnly: true })?.tag, 'TP', "the stream's enum");
  assert.equal(stop({ stopType: 'STOP_LOSS' })?.tag, 'Sell stop', 'a stop that does not close a position is no stop-loss');
  assert.equal(orderLines([{ symbol: 'S', orderID: 3, price: '100', quantity: '2' }], o)[0]?.tag, 'Limit', 'a side that cannot be read is not guessed');
  const long = positionLines([{ symbol: 'S', positionSide: 2, size: '0.5', avgEntryPrice: '100' }], o)[0];
  const short = positionLines([{ symbol: 'S', size: '-0.5', avgEntryPrice: '100' }], o)[0];
  assert.deepEqual([long?.tag, long?.amount, short?.tag, short?.amount], ['Long', fmtQty('0.5'), 'Short', fmtQty('0.5')]);
});

test('every label is in one column at one size; only ones that would overlap move, and as little as they can', () => {
  const row = (key: string, y: number, head = 80, amount = 60) => ({ key, y, head, amount });
  const at = layoutLabels([row('far', 300, 50, 40), row('b', 110, 100, 70), row('a', 100), row('c', 125)], 1000);
  assert.equal(at.x, 680, 'one left edge for all of them');
  assert.equal(at.head, 104, 'the widest word, in steps so a ticking PnL does not resize them');
  assert.equal(at.amount, 72);
  assert.equal(at.dy.get('far'), 0, 'a line with room keeps its label on it');
  const place = (k: string) => [100, 110, 125].at(['a', 'b', 'c'].indexOf(k))! + at.dy.get(k)!;
  assert.ok(place('b') - place('a') >= 19 && place('c') - place('b') >= 19, 'none on another');
  assert.equal(Math.abs(at.dy.get('a')! + at.dy.get('b')! + at.dy.get('c')!) <= 1, true, 'around where the lines are, not all downwards');

  const narrow = layoutLabels([row('a', 10, 100, 100)], 240);
  assert.equal(narrow.x, 24, 'a phone: the column ends clear of the axis');
  assert.deepEqual(layoutLabels([], 500).dy.size, 0);
});

test('a preview says what the placed order will say, in its colour', () => {
  assert.deepEqual(draftLabelParts('Limit · 0.5 BTC', 'limit', 'sell'), { tag: 'Sell limit', amount: '0.5 BTC' });
  assert.deepEqual(draftLabelParts('Trigger · 0.5 BTC', 'trigger', 'buy'), { tag: 'Buy stop', amount: '0.5 BTC' });
  assert.deepEqual(draftLabelParts('DCA 3/5 · 0.01 BTC', 'limit', 'buy'), { tag: 'DCA 3/5', amount: '0.01 BTC' }, "an algo's own name stays");
  assert.deepEqual(draftLabelParts('TP', 'tp', 'buy'), { tag: 'TP', amount: null });
  assert.equal(draftInkSide('tp', 'buy'), 'sell', 'it closes a long, as the placed TP does');
  assert.equal(draftInkSide('limit', 'buy'), 'buy');
});

test('orders of another market are not drawn', () => {
  assert.deepEqual(orderLines([spotLimit], { symbol: 'vETH_vUSDC', canModify: true }), []);
});

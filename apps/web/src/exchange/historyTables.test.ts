/** What a history table keeps between visits (historyTables.ts trimForStore). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEEP_ROWS, TableStore, holdsAll, newWants, notePush, trimForStore } from './historyTables';

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ tradeID: i, time: 1_000_000 - i * 10 }));
const timeOf = (r: { time: number }) => r.time;

test('history tables: a table within the cap is kept whole, cursor and all', () => {
  const t = { rows: rows(120), next: 998_810, fetchedAt: 5 };
  assert.deepEqual(trimForStore(t, timeOf), t);
});

test('history tables: past the cap the newest rows are kept and "load more" continues from the oldest kept', () => {
  const t = trimForStore({ rows: rows(KEEP_ROWS + 137), next: 123, fetchedAt: 5 }, timeOf);
  assert.equal(t.rows.length, KEEP_ROWS);
  assert.deepEqual(t.rows[0], { tradeID: 0, time: 1_000_000 });
  assert.equal(t.next, 1_000_000 - (KEEP_ROWS - 1) * 10, 'the next page starts at the oldest row kept (endTime is inclusive)');
  assert.equal(t.fetchedAt, 5);
});

test('history tables: without IndexedDB nothing is kept and nothing fails', async () => {
  const store = new TableStore(null);
  assert.equal(await store.get('x'), null);
  store.put('x', { rows: [], next: null, fetchedAt: 1 });
  assert.deepEqual(await store.get('x'), { rows: [], next: null, fetchedAt: 1 }, 'a write still waiting is what a read returns');
});

const tradeId = (r: any) => `${r.symbol}:${r.tradeID}:${r.orderID}`;
const orderId = (r: any) => String(r.orderID);

test('stream wants: a pushed fill the trade history already holds needs no read; one it lacks does', () => {
  const table = [
    { symbol: 'BTC-USD', tradeID: 14135099, orderID: 26740476372 },
    { symbol: 'QNT-USD', tradeID: 122066, orderID: 26740480687 },
  ];
  const w = newWants();
  // The stream's own rows (WsPerpsUserTrade), as pushed.
  notePush(w, 'accountTrade', [{ E: 1, T: 1, t: 14135099, s: 'BTC-USD', i: 26740476372, c: 'x', S: 'BUY', p: '84661', q: '0.01734', f: '0', m: true, d: 'CLOSE_SHORT' }]);
  assert.equal(holdsAll('trades', w, table, tradeId), true, 'the read made for the action brought it');
  // The same trade id on ANOTHER market is another fill (trade ids are per market).
  notePush(w, 'accountTrade', { t: 122066, s: 'XPL-USD', i: 26740466573 });
  assert.equal(holdsAll('trades', w, table, tradeId), false);
  assert.equal(holdsAll('positions', w, [], String), false, 'a fill can close a position: that history reads');
  assert.equal(holdsAll('trades', newWants(), [], tradeId), true, 'nothing reported, nothing to read');
});

test('stream wants: an order that is still open is not in the order history - only a final state asks for a read', () => {
  const table = [{ orderID: 26740477371, status: 'FILLED' }, { orderID: 26740466567, status: 'CANCELED' }];
  const w = newWants();
  notePush(w, 'accountOrderUpdate', [
    { i: 26740478917, X: 'NEW', x: 'NEW', s: 'PENGU-USD' },
    { i: 26702840880, X: 'NEW', x: 'REPLACED', s: 'UNI-USD' },
    { i: 26740473387, X: 'PARTIALLY_FILLED', x: 'PARTIALLY_FILLED', t: 1654182, s: 'LINK-USD' },
  ]);
  notePush(w, 'accountTrade', [{ t: 1654182, s: 'LINK-USD', i: 26740473387 }]); // the partial fill itself
  assert.equal(holdsAll('orders', w, table, orderId), true, 'placed, replaced, partly filled: the history has not changed');
  notePush(w, 'accountOrderUpdate', [{ i: 26740477371, X: 'FILLED' }, { i: 26740466567, X: 'CANCELED' }]);
  assert.equal(holdsAll('orders', w, table, orderId), true, 'final states the table already shows');
  notePush(w, 'accountOrderUpdate', [{ i: 26740480671, X: 'CANCELED' }]);
  assert.equal(holdsAll('orders', w, table, orderId), false, 'a canceled order it does not hold yet');
  const late = newWants();
  notePush(late, 'accountOrderUpdate', [{ i: 26740466567, X: 'EXPIRED' }]);
  assert.equal(holdsAll('orders', late, table, orderId), false, 'held, but in another state than reported');
});

test('stream wants: a push it cannot read means read, as before', () => {
  for (const [channel, data] of [
    ['accountTrade', [{ s: 'BTC-USD', i: 1 }]], // no trade id
    ['accountTrade', 'x'],
    ['accountTrade', null],
    ['accountOrderUpdate', [{ i: 1 }]], // no status
    ['accountOrderUpdate', [{ X: 'FILLED' }]], // no order id
    ['accountUpdate', [{}]], // not a channel a history follows
  ] as Array<[string, unknown]>) {
    const w = newWants();
    notePush(w, channel, data);
    assert.equal(w.unknown, true, `${channel} ${JSON.stringify(data)}`);
    assert.equal(holdsAll('trades', w, [], tradeId), false);
    assert.equal(holdsAll('orders', w, [], orderId), false);
  }
});

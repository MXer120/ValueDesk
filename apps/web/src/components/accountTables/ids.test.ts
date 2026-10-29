import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  algoSupport, closedSupport, fundingSupport, idText, orderSupport, positionSupport, shortId, supportText, tradeSupport, utcStamp,
} from './ids';

const ACCOUNT = '0x04fb0000000000000000000000000000000277d';

test('idText: numbers and strings as text; absent, empty and 0 are no id', () => {
  assert.equal(idText(123456789012), '123456789012');
  assert.equal(idText(' vs-abc '), 'vs-abc');
  assert.equal(idText(0), null);
  assert.equal(idText('0'), null);
  assert.equal(idText(''), null);
  assert.equal(idText(null), null);
  assert.equal(idText(undefined), null);
  assert.equal(idText(Number.NaN), null);
  assert.equal(idText({}), null);
});

test('shortId: the last 8 characters, an ellipsis only when something was cut', () => {
  assert.equal(shortId(1234567890123), '…67890123');
  assert.equal(shortId('vcp3fA9xQ2LmN8pR7tY1wE5'), '…R7tY1wE5');
  assert.equal(shortId('12345678'), '12345678');
  assert.equal(shortId(42), '42');
  assert.equal(shortId('liquidation:987654321'), '…87654321');
  assert.equal(shortId(null), '');
  assert.equal(shortId('abcdef', 3), '…def');
});

test('utcStamp: seconds, in UTC whatever the zone', () => {
  assert.equal(utcStamp(Date.UTC(2026, 9, 29, 20, 48, 55, 712)), '2026-10-29 20:48:55 UTC');
  assert.equal(utcStamp(String(Date.UTC(2026, 0, 2, 3, 4, 5))), '2026-01-02 03:04:05 UTC');
  assert.equal(utcStamp(0), null);
  assert.equal(utcStamp(undefined), null);
  assert.equal(utcStamp('soon'), null);
});

test('supportText: a title, then only the lines that have a value, in a fixed order', () => {
  const t = supportText('SoDEX order', {
    market: 'BTC-USD', engine: 'perps', side: 'Buy', size: '0.5', unit: 'BTC', price: '84211.5',
    time: Date.UTC(2026, 9, 29, 20, 48, 55), timeLabel: 'Placed', orderId: 991, clOrdId: '', tradeId: 0, account: ACCOUNT,
  });
  assert.equal(t, [
    'SoDEX order',
    'Market: BTC-USD (Futures)',
    'Side: Buy',
    'Size: 0.5 BTC',
    'Price: 84211.5',
    'Placed (UTC): 2026-10-29 20:48:55 UTC',
    'Order ID: 991',
    `Account: ${ACCOUNT}`,
  ].join('\n'));
  assert.equal(supportText('Nothing', {}), 'Nothing');
});

test('orderSupport: a history order as SoDEX sent it - raw figures, the status enum, both ids', () => {
  const o = {
    orderID: 812345678901, clOrdID: 'vcp3fA9xQ2LmN8pR7tY1wE5', symbol: 'BTC-USD', side: 'SELL', type: 'LIMIT', price: '84211.5',
    origQty: '0.0125', executedQty: '0.005', executedValue: '421.0575', status: 'PARTIALLY_FILLED', createdAt: Date.UTC(2026, 9, 29, 8, 0, 1),
    reduceOnly: true,
  };
  assert.equal(orderSupport(o, { market: 'BTC-USD', engine: 'perps', unit: 'BTC', account: ACCOUNT, type: 'Limit · GTC' }), [
    'SoDEX order',
    'Market: BTC-USD (Futures)',
    'Side: Sell',
    'Type: Limit · GTC',
    'Status: PARTIALLY_FILLED',
    'Size: 0.0125 BTC',
    'Price: 84211.5',
    'Filled: 0.005',
    'Avg. fill: 84211.5',
    'Reduce-only: yes',
    'Placed (UTC): 2026-10-29 08:00:01 UTC',
    'Order ID: 812345678901',
    'Client order ID (clOrdID): vcp3fA9xQ2LmN8pR7tY1wE5',
    `Account: ${ACCOUNT}`,
  ].join('\n'));
});

test('orderSupport: the stream spelling of an open market order (i, c, S, X as numbers)', () => {
  const o = { i: 77, c: 'vs-1', S: 1, q: '2', z: '0', X: 1, T: Date.UTC(2026, 9, 29, 0, 0, 0) };
  const t = orderSupport(o, { market: 'ETH/USDC', engine: 'spot', account: null, open: true });
  assert.match(t, /^SoDEX open order\n/);
  assert.match(t, /\nMarket: ETH\/USDC \(Spot\)\n/);
  assert.match(t, /\nSide: Buy\n/);
  assert.match(t, /\nStatus: NEW\n/);
  assert.match(t, /\nPrice: Market\n/);
  assert.match(t, /\nOrder ID: 77\nClient order ID \(clOrdID\): vs-1$/);
  assert.doesNotMatch(t, /Account|Avg\. fill|Trigger/);
});

test('tradeSupport: trade ID, order ID and clOrdID, with the fee in its coin', () => {
  const t = tradeSupport(
    { symbol: 'SOL-USD', tradeID: 5501, orderID: 812345678901, clOrdID: 'liquidation:812345678901', side: 'BUY', price: '182.4', quantity: '3', fee: '0.27', feeCoin: 'USDC', isMaker: false, time: Date.UTC(2026, 9, 29, 20, 48, 55) },
    { market: 'SOL-USD', engine: 'perps', unit: 'SOL', account: ACCOUNT },
  );
  assert.equal(t, [
    'SoDEX fill',
    'Market: SOL-USD (Futures)',
    'Side: Buy',
    'Size: 3 SOL',
    'Price: 182.4',
    'Fee: 0.27 USDC',
    'Role: Taker',
    'Time (UTC): 2026-10-29 20:48:55 UTC',
    'Trade ID: 5501',
    'Order ID: 812345678901',
    'Client order ID (clOrdID): liquidation:812345678901',
    `Account: ${ACCOUNT}`,
  ].join('\n'));
});

test('positionSupport: a short position\'s size without its sign, and the position ID', () => {
  const t = positionSupport(
    { id: 3301, symbol: 'BTC-USD', positionSide: 'BOTH', size: '-0.25', avgEntryPrice: '83000', leverage: 10, marginMode: 'CROSS', createdAt: Date.UTC(2026, 9, 28, 12, 0, 0) },
    { market: 'BTC-USD', unit: 'BTC', account: ACCOUNT },
  );
  assert.match(t, /\nSide: Short\nSize: 0\.25 BTC\nEntry price: 83000\nLeverage: 10x\nMargin mode: CROSS\nOpened \(UTC\): 2026-10-28 12:00:00 UTC\nPosition ID: 3301\n/);
});

test('closedSupport and fundingSupport carry the position ID', () => {
  const c = closedSupport(
    { id: 3300, positionSide: 'LONG', maxSize: '1', avgEntryPrice: '80000', avgClosePrice: '81000', realizedPnL: '990.5', leverage: 5, active: false, createdAt: Date.UTC(2026, 9, 1), updatedAt: Date.UTC(2026, 9, 2) },
    { market: 'BTC-USD', unit: 'BTC', account: null },
  );
  assert.match(c, /^SoDEX closed position\nMarket: BTC-USD \(Futures\)\nSide: Long\nMax size: 1 BTC\n/);
  assert.match(c, /\nOpened \(UTC\): 2026-10-01 00:00:00 UTC\nClosed \(UTC\): 2026-10-02 00:00:00 UTC\nPosition ID: 3300$/);
  const f = fundingSupport({ positionID: 3300, positionSide: 'LONG', fundingFee: '-0.12', feeCoin: 'USDC', timestamp: Date.UTC(2026, 9, 1, 8) }, { market: 'BTC-USD', account: ACCOUNT });
  assert.match(f, /\nFunding fee: -0\.12 USDC\nTime \(UTC\): 2026-10-01 08:00:00 UTC\nPosition ID: 3300\n/);
});

test('algoSupport: the algo ID, then each child order with its clOrdID and order ID, newest first', () => {
  const child = (n: number, orderId: string | null, extra: Record<string, unknown> = {}) => ({
    clOrdID: `vs-algo-${n}`, orderId, side: 'buy' as const, price: 84000 + n, quantity: 0.01, filled: 0.01, state: 'done', tag: `slice ${n}/3`, placedAt: Date.UTC(2026, 9, 29, 10, n), ...extra,
  });
  const t = algoSupport(
    {
      algo: {
        id: 'alg_7Kq2', owner: ACCOUNT, status: 'running', createdAt: Date.UTC(2026, 9, 29, 9, 59), startedAt: Date.UTC(2026, 9, 29, 10, 0), filled: 0.02, childCount: 2,
        spec: { symbol: 'BTC-USD', side: 'buy', paper: false, kind: 'twap' },
        children: [child(1, '900001'), child(2, null, { state: 'open', filled: 0 })],
        exitOrders: [child(3, '900003', { exit: 'sl', side: 'sell' })],
      },
      target: 0.03,
      avgPrice: 84001,
    },
    { name: 'TWAP', status: 'Running', place: 'this browser', account: null },
  );
  assert.equal(t, [
    'ValueDesk algo',
    'Market: BTC-USD (Futures)',
    'Side: Buy',
    'Type: TWAP',
    'Status: Running',
    'Size: 0.03 BTC',
    'Filled: 0.02',
    'Avg. fill: 84001',
    'Runs on: this browser',
    'Child orders sent: 2',
    'Started (UTC): 2026-10-29 10:00:00 UTC',
    'Algo ID: alg_7Kq2',
    `Account: ${ACCOUNT}`,
    'Child orders (newest first):',
    '- stop-loss: Sell 0.01 @ 84003, filled 0.01, done, 2026-10-29 10:03:00 UTC; clOrdID vs-algo-3, order ID 900003',
    '- slice 2/3: Buy 0.01 @ 84002, filled 0, open, 2026-10-29 10:02:00 UTC; clOrdID vs-algo-2',
    '- slice 1/3: Buy 0.01 @ 84001, filled 0.01, done, 2026-10-29 10:01:00 UTC; clOrdID vs-algo-1, order ID 900001',
  ].join('\n'));
});

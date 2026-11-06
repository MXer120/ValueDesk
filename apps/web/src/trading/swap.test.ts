/**
 * USDT -> USDC: the quote, the button and the exact order. No network, nothing signed.
 *   npx tsx --test src/trading/swap.test.ts   (from apps/web)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSwap, swapAmount, swapButton, swapQuote, SWAP_FLOOR_PRICE, SWAP_SYMBOL } from './swap';

test('amounts round down to the market step', () => {
  assert.equal(swapAmount('10.129'), '10.12');
  assert.equal(swapAmount('10'), '10.00');
  assert.equal(swapAmount('abc'), '0.00');
  assert.equal(swapAmount(-1), '0.00');
});

test('the quote walks bids and ignores everything under the floor', () => {
  const q = swapQuote(
    [{ price: 0.997, quantity: 10 }, { price: 0.99, quantity: 10 }, { price: 0.98, quantity: 1000 }],
    15,
  );
  assert.equal(q.depth, 20);
  assert.equal(q.filled, 15);
  assert.equal(q.exceedsDepth, false);
  assert.equal(q.receive, 14.92);
  assert.ok(Math.abs(q.avgPrice - 14.92 / 15) < 1e-9);
});

test('more than the book holds above the floor is flagged', () => {
  assert.equal(swapQuote([{ price: 0.98, quantity: 1000 }], 5).exceedsDepth, true);
  assert.equal(swapQuote([{ price: 1, quantity: 4 }], 5).exceedsDepth, true);
});

test('the button says what stands in the way, in order', () => {
  const ok = swapQuote([{ price: 1, quantity: 1e6 }], 10);
  assert.equal(swapButton({ amount: '', balance: 10, quote: ok }), 'enter');
  assert.equal(swapButton({ amount: '10', balance: 10, quote: null }), 'quoting');
  assert.equal(swapButton({ amount: '4.99', balance: 10, quote: ok }), 'below-min');
  assert.equal(swapButton({ amount: '100001', balance: 1e6, quote: ok }), 'above-max');
  assert.equal(swapButton({ amount: '11', balance: 10, quote: ok }), 'no-balance');
  assert.equal(swapButton({ amount: '10', balance: 10, quote: swapQuote([], 10) }), 'no-depth');
  assert.equal(swapButton({ amount: '10', balance: 10, quote: ok }), 'swap');
  assert.equal(swapButton({ amount: '10', balance: null, quote: ok }), 'swap', 'an unread balance is not a short one');
});

const clock = () => { let t = 1_000_000; return { now: () => t, wait: async (ms: number) => { t += ms; } }; };

test('the order is SoDEX\'s own: market IOC sell at the floor, on the spot pair', async () => {
  const sent: any[] = [];
  const c = clock();
  const r = await runSwap('10.129', {
    ...c,
    place: async (t) => { sent.push(t); },
    history: async () => [{ clOrdID: sent[0].clOrdID, status: 'FILLED', executedQty: '10.12', executedValue: '10.09' }],
  });
  assert.equal(sent.length, 1);
  const { clOrdID, ...ticket } = sent[0];
  assert.deepEqual(ticket, { symbol: SWAP_SYMBOL, side: 'sell', type: 'market', tif: 'ioc', price: SWAP_FLOOR_PRICE, quantity: '10.12' });
  assert.match(clOrdID, /^[0-9a-zA-Z_-]{1,36}$/, 'inside the gateway\'s pattern');
  assert.equal(r.status, 'filled');
  assert.equal(r.usdc, 10.09);
});

test('a partial fill says how much, nothing filled is a failure', async () => {
  const c = clock();
  let id = '';
  const partial = await runSwap('10', {
    ...c,
    place: async (t) => { id = t.clOrdID; },
    history: async () => [{ clOrdID: id, status: 'CANCELED', executedQty: '4', executedValue: '3.98' }],
  });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.usdt, 4);
  const none = await runSwap('10', {
    ...c,
    place: async (t) => { id = t.clOrdID; },
    history: async () => [{ clOrdID: id, status: 'CANCELED', executedQty: '0', executedValue: '0' }],
  });
  assert.equal(none.status, 'failed');
});

test('no result in time is "unknown" and the order is never sent twice', async () => {
  let sends = 0;
  const r = await runSwap('10', { ...clock(), place: async () => { sends++; }, history: async () => { throw new Error('down'); } });
  assert.equal(r.status, 'unknown');
  assert.equal(sends, 1);
});

test('a refused send reaches the caller', async () => {
  await assert.rejects(runSwap('10', { ...clock(), place: async () => { throw new Error('refused'); }, history: async () => [] }), /refused/);
});

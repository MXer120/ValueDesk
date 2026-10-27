import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fundingCash } from '../src/valuedesk/liquidations/math.js';

test('an hour of funding: cross pays from the cash, isolated from its margin, the equity moves by the total', () => {
  const book = {
    cash: 10_000, equity: 50_000,
    pos: new Map<string, { szi: number; entry: number | null; iso?: number | null }>([
      ['BTC', { szi: 2, entry: 100_000 }],
      ['ETH', { szi: -10, entry: 4_000, iso: 5_000 }],
      ['DOGE', { szi: 1_000, entry: 0.2 }],
    ]),
  };
  const rates: Record<string, { rate: number; px: number }> = { BTC: { rate: 0.0001, px: 100_000 }, ETH: { rate: 0.0001, px: 4_000 } };
  const paid = fundingCash(book, (s) => rates[s] ?? null);
  assert.equal(paid, 20 - 4);
  assert.equal(book.cash, 10_000 - 20);
  assert.equal(book.pos.get('ETH')!.iso, 5_000 + 4, 'a short receives a positive rate');
  assert.equal(book.equity, 50_000 - 16);
});

test('no cash known: the positions and equity still move, nothing is invented', () => {
  const book = { cash: null, equity: null, pos: new Map([['BTC', { szi: 1, entry: 1 }]]) };
  assert.equal(fundingCash(book, () => ({ rate: -0.0002, px: 50_000 })), -10);
  assert.equal(book.cash, null);
  assert.equal(book.equity, null);
});

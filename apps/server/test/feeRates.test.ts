/**
 * Run: npx tsx --test test/feeRates.test.ts   (from apps/server)
 *
 * Each venue's fee rule against fees its own fills showed (2026-10-28).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE_FEES, fillRate, spotSellRate, type FeeRates } from '../src/indexer/feeRates.js';
import { lighterPrint, sodexPrint } from '../src/indexer/streams.js';

const bp = (x: number) => +(x * 1e4).toFixed(4);

test('Hyperliquid: the account tier, a positive fee cut by its referral discount, a rebate not', () => {
  const ref: FeeRates = { taker: 4.5e-4, maker: 1.5e-4, referral: 0.04, at: 1 };
  assert.equal(bp(fillRate(ref, true)), 4.32, 'the 4.32 bp seen on fills of a 4% referral account');
  assert.equal(bp(fillRate(BASE_FEES.hyperliquid, true)), 4.5);
  assert.equal(bp(fillRate(BASE_FEES.hyperliquid, false)), 1.5);
  const mm: FeeRates = { taker: 1.44e-4, maker: -0.3e-4, referral: 0.04, at: 1 };
  assert.equal(bp(fillRate(mm, false)), -0.3, 'a rebate is paid in full');
});

test('trade.xyz: a market in growth mode scales a fee by (1 + scale) x 0.1, a rebate by 0.1; out of it by (1 + scale)', () => {
  const growth = { scale: 1, growth: true };
  assert.equal(bp(fillRate({ ...BASE_FEES.tradexyz, referral: 0.04 }, true, growth)), 0.864, 'xyz:TSLA taker, 4% referral');
  assert.equal(bp(fillRate(BASE_FEES.tradexyz, false, growth)), 0.3);
  assert.equal(bp(fillRate({ taker: 1.44e-4, maker: -0.3e-4, at: 1 }, false, growth)), -0.03, 'the -0.03 bp rebate seen');
  assert.equal(bp(fillRate(BASE_FEES.tradexyz, false, { scale: 1, growth: false })), 3, 'the 3.0 bp maker seen out of growth mode');
});

test('Hyperliquid spot: a sale pays the spot rate in USDC, less the referral discount', () => {
  assert.equal(bp(spotSellRate(BASE_FEES.hyperliquid, true)), 7);
  assert.equal(bp(spotSellRate({ taker: 4.5e-4, maker: 1.5e-4, spotTaker: 7e-4, spotMaker: 4e-4, referral: 0.04, at: 1 }, false)), 3.84);
});

test('SoDEX names the taker; Lighter carries what each side paid, in millionths of the notional', () => {
  const s = sodexPrint({ T: 9, t: 3, s: 'ETH-USD', p: '2000', q: '1', bi: 1, si: 2, S: 'SELL' } as never)!;
  assert.equal(s.taker, 'seller');
  const l = lighterPrint({ trade_id: 7, market_id: 1, size: '0.5', price: '200', ask_account_id: 10, bid_account_id: 11, timestamp: 5, is_maker_ask: true, maker_fee: 28, taker_fee: 280 } as never, () => 'BTC')!;
  assert.equal(l.taker, 'buyer');
  assert.deepEqual(l.fee, { buyer: 100 * 280e-6, seller: 100 * 28e-6 });
  const free = lighterPrint({ trade_id: 8, market_id: 1, size: '1', price: '100', ask_account_id: 10, bid_account_id: 11, timestamp: 5, is_maker_ask: false, maker_fee: 0 } as never, () => 'BTC')!;
  assert.deepEqual(free.fee, { buyer: 0, seller: 0 }, 'a standard account pays nothing');
});

test('a fill realizes PnL on the part of the position it closes, against the entry; an add realizes nothing', async () => {
  const { realizedOf } = await import('../src/indexer/cohortTracker.js');
  const book = { pos: new Map([['BTC', { szi: 2, entry: 80_000 }], ['ETH', { szi: -10, entry: 3_000 }]]) };
  assert.equal(realizedOf(book, 'BTC', -0.5, 82_000), 1_000, 'a long sells half a coin 2,000 up');
  assert.equal(realizedOf(book, 'BTC', -3, 79_000), -2_000, 'a flip closes only the 2 it held');
  assert.equal(realizedOf(book, 'BTC', 1, 90_000), 0, 'adding realizes nothing');
  assert.equal(realizedOf(book, 'ETH', 4, 2_900), 400, 'a short buys back 100 lower');
  assert.equal(realizedOf(book, 'SOL', 1, 100), 0, 'no position, nothing to realize');
});

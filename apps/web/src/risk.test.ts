import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Symbol } from './api';
import { checkStopAgainstLiquidation, estimateLiquidationPrice, type LiquidationInput } from './risk';

// BTC at $80,000, 1 BTC long at 40x, a flat 0.5% maintenance rate.
const sym = { tickSize: '1', marginTiers: [{ maxNotionalValue: '1000000000', maintenanceMarginRate: '0.005', maxLeverage: 50, maintenanceDeduction: '0' }] } as unknown as Symbol;
const long: LiquidationInput = { entryPrice: 80_000, quantity: 1, side: 'buy', leverage: 40, sym };
const liq = estimateLiquidationPrice(long).price!;

test('a long stop on the liquidation price, or under it, is at / beyond liquidation', () => {
  assert.equal(checkStopAgainstLiquidation(liq, long).verdict, 'at-liquidation');
  assert.equal(checkStopAgainstLiquidation(liq - 1, long).verdict, 'beyond-liquidation');
});

test('a long stop $1 over the estimate is not at liquidation (no tick tolerance)', () => {
  assert.notEqual(checkStopAgainstLiquidation(liq + 1, long).verdict, 'at-liquidation');
  assert.notEqual(checkStopAgainstLiquidation(liq + 1, long).verdict, 'beyond-liquidation');
});

test('at 40x on BTC, $250 over liquidation is fine; $50 over is close', () => {
  assert.equal(checkStopAgainstLiquidation(liq + 250, long).verdict, 'ok');
  assert.equal(checkStopAgainstLiquidation(liq + 50, long).verdict, 'near-liquidation');
});

test('a short mirrors it', () => {
  const short: LiquidationInput = { ...long, side: 'sell' };
  const sl = estimateLiquidationPrice(short).price!;
  assert.equal(checkStopAgainstLiquidation(sl, short).verdict, 'at-liquidation');
  assert.equal(checkStopAgainstLiquidation(sl + 1, short).verdict, 'beyond-liquidation');
  assert.notEqual(checkStopAgainstLiquidation(sl - 1, short).verdict, 'at-liquidation');
  assert.equal(checkStopAgainstLiquidation(sl - 250, short).verdict, 'ok');
});

test('an isolated position with margin added: from its own margin, the price is SoDEX\'s own lp (BTC-USD on SoDEX, 2026-10-31)', () => {
  // A 0.0774 BTC long at 40x, isolated, $1.68 of margin added: SoDEX's state said iw 151.138052974377, lp 76238.1480597085.
  const btc = { tickSize: '0.1', marginTiers: [
    { maxNotionalValue: '4000000', maintenanceMarginRate: '0.0125', maxLeverage: 40, maintenanceDeduction: '0' },
    { maxNotionalValue: '100000000', maintenanceMarginRate: '0.02', maxLeverage: 25, maintenanceDeduction: '30000' },
  ] } as unknown as Symbol;
  const pos: LiquidationInput = { entryPrice: 77237.859231886916795087, quantity: 0.0774, side: 'buy', leverage: 40, sym: btc, marginMode: 'isolated' };
  const lp = 76238.1480597085;
  const fromLeverage = estimateLiquidationPrice(pos).price!;
  const fromMargin = estimateLiquidationPrice({ ...pos, isolatedMargin: 151.138052974377 }).price!;
  assert.ok(Math.abs(fromMargin - lp) < 1e-6, `from the margin: ${fromMargin}, SoDEX ${lp}`);
  assert.ok(Math.abs(fromLeverage - lp) > 20, `from leverage alone it misses the added margin (${fromLeverage})`);
  // Margin taken off (fees, a remove) moves it toward the market; none given, nothing changes.
  assert.ok(estimateLiquidationPrice({ ...pos, isolatedMargin: 140 }).price! > fromLeverage);
  assert.equal(estimateLiquidationPrice({ ...pos, isolatedMargin: 0 }).price, fromLeverage);
});

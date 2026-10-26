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

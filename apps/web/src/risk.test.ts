import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Symbol } from './api';
import { checkStopAgainstLiquidation, estimateLiquidationPrice, positionLiquidation, venueLiqById, type LiquidationInput } from './risk';

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

test("an open cross short shows SoDEX's lp, not the estimate that ignores the account's collateral (AAPL-USD on SoDEX, 2026-11-26)", () => {
  // 0x1978...fe04's perps state: a 10x cross AAPL short beside 14 other positions; mark 355.56; SoDEX's lp 1,034.60.
  const aapl = { tickSize: '0.01', marginTiers: [
    { maxNotionalValue: '125000', maintenanceMarginRate: '0.05', maxLeverage: 10, maintenanceDeduction: '0' },
    { maxNotionalValue: '100000000', maintenanceMarginRate: '0.1', maxLeverage: 5, maintenanceDeduction: '6250' },
  ] } as unknown as Symbol;
  const state = { state: { P: [
    { i: 11600229, s: 'AAPL-USD', m: 'CROSS', sz: '-177.021', ep: '331.564751978578812683', l: 10, lp: '1034.5983589655347113' },
    { i: 44390900, s: 'AMD-USD', m: 'CROSS', sz: '100', ep: '413.75', l: 10, lp: '0' },
  ] } };
  const estimate = () => estimateLiquidationPrice({ entryPrice: 331.564751978578812683, quantity: 177.021, side: 'sell', leverage: 10, sym: aapl, marginMode: 'cross' }).price;
  // The bug: the estimate alone puts a live short's liquidation BELOW its mark, a price already passed.
  assert.ok(estimate()! < 355.56, `estimate ${estimate()}`);
  const lp = venueLiqById(state);
  assert.deepEqual(positionLiquidation(lp.get('11600229'), estimate), { price: 1034.5983589655347, source: 'venue' });
  // A long SoDEX gives no liquidation price (the account covers it at any price): none, not the estimate.
  assert.deepEqual(positionLiquidation(lp.get('44390900'), () => 380), { price: null, source: 'none' });
  // A position the state does not list yet (or no state): the estimate, marked so.
  assert.deepEqual(positionLiquidation(lp.get('99'), estimate), { price: estimate(), source: 'estimate' });
  assert.deepEqual(positionLiquidation(venueLiqById(null).get('11600229'), () => null), { price: null, source: 'estimate' });
});

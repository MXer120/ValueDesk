import test from 'node:test';
import assert from 'node:assert/strict';
import { bandOf, bracketsOf, capOf, coinName, collateralOf, intervalOf, matches, ordered, pctOf, placeSearch, ratioPair, readPlace, shortPrice, type LimitSymbol } from './model';

test('a percentage moves the point in the string, so no float can bend a figure', () => {
  assert.equal(pctOf('0.0125'), '1.25%');
  assert.equal(pctOf('0.00012'), '0.012%');
  assert.equal(pctOf('0.0004'), '0.04%');
  assert.equal(pctOf('0.07'), '7%');
  assert.equal(pctOf('0.166666667'), '16.6666667%');
  assert.equal(pctOf('1'), '100%');
  assert.equal(pctOf('0'), '0%');
  assert.equal(pctOf('-0.04'), '-4%');
  assert.equal(pctOf('0.5'), '50%');
  assert.equal(pctOf(''), null);
  assert.equal(pctOf(undefined), null);
  assert.equal(pctOf('abc'), null);
});

test('a "0" maximum is no maximum, and stays the string otherwise', () => {
  assert.equal(capOf('0'), null);
  assert.equal(capOf(undefined), null);
  assert.equal(capOf('4000000'), '4000000');
});

test('a band with one ratio reads as one', () => {
  assert.equal(bandOf('0.05', '0.05'), '±5%');
  assert.equal(bandOf('1', '0.5'), '+100% / −50%');
  assert.equal(bandOf(undefined, '0.5'), null);
});

test('the limit order pair keeps both ratios', () => {
  assert.equal(ratioPair('0.05', '0.05'), '5% / 5%');
  assert.equal(ratioPair('1', '0.5'), '100% / 50%');
  assert.equal(ratioPair('0.05', undefined), null);
});

test('tiers run from the tier below, in order, whatever order the feed sends', () => {
  const b = bracketsOf([
    { maxNotionalValue: '100000000', maintenanceMarginRate: '0.02', maxLeverage: 25, maintenanceDeduction: '30000' },
    { maxNotionalValue: '4000000', maintenanceMarginRate: '0.0125', maxLeverage: 40, maintenanceDeduction: '0' },
  ]);
  assert.deepEqual(b.map((t) => [t.tier, t.from, t.to, t.maxLeverage, t.rate, t.deduction]), [
    [1, '0', '4000000', 40, '1.25%', '0'],
    [2, '4000000', '100000000', 25, '2%', '30000'],
  ]);
  assert.deepEqual(bracketsOf(undefined), []);
});

test('coins read as people say them', () => {
  assert.equal(coinName('vBTC'), 'BTC');
  assert.equal(coinName('vUSDC'), 'USDC');
  assert.equal(coinName('WSOSO'), 'SOSO');
  assert.equal(coinName('vXAUt'), 'XAUT');
  assert.equal(coinName('vsoUSDC'), 'soUSDC');
  assert.equal(coinName('vMAG7.ssi'), 'MAG7.ssi');
  assert.equal(coinName('BTC'), 'BTC');
});

test('collateral: only what SoDEX counts, USDC first, highest ratio next', () => {
  const rows = collateralOf([
    { id: 1, name: 'vDOGE', marginRatio: '0.7', price: '0.07' },
    { id: 2, name: 'vADA', marginRatio: '0' },
    { id: 3, name: 'vBTC', marginRatio: '0.9', price: '75000' },
    { id: 4, name: 'vUSDC', marginRatio: '1', price: '1' },
    { id: 5, name: 'vNOPE' },
  ]);
  assert.deepEqual(rows.map((r) => [r.name, r.ratio]), [['USDC', '100%'], ['BTC', '90%'], ['DOGE', '70%']]);
});

const sym = (o: Partial<LimitSymbol>): LimitSymbol => ({ id: 1, name: 'BTC-USD', displayName: 'BTC-USD', baseCoin: 'BTC', tickSize: '1', minPrice: '1', maxPrice: '0', stepSize: '1', minQuantity: '1', maxQuantity: '1', marketMinQuantity: '1', marketMaxQuantity: '1', minNotional: '10', maxNotional: '1', makerFee: '0', takerFee: '0', status: 'TRADING', ...o });

test('order and search', () => {
  const rows = [sym({ id: 3, name: 'A-USD', baseCoin: 'A' }), sym({ id: 1, status: 'HALT', name: 'B-USD', baseCoin: 'B' }), sym({ id: 2, name: 'C-USD', baseCoin: 'C' })];
  assert.deepEqual(ordered(rows).map((r) => r.name), ['C-USD', 'A-USD', 'B-USD']);
  assert.ok(matches(sym({ displayName: 'BTC/USDC', name: 'vBTC_vUSDC', baseCoin: 'vBTC' }), 'btc/'));
  assert.ok(!matches(sym({}), 'eth'));
  assert.ok(matches(sym({}), '  '));
});

test('oracle prices are cut for reading, never rounded up', () => {
  assert.equal(shortPrice('75986.355194312420526422'), '75986.35');
  assert.equal(shortPrice('89.714017534399776829'), '89.714');
  assert.equal(shortPrice('0.071880055119525493'), '0.07188');
  assert.equal(shortPrice('1'), '1');
});

test('funding interval', () => {
  assert.equal(intervalOf(3600), '1 h');
  assert.equal(intervalOf(28800), '8 h');
  assert.equal(intervalOf(undefined), null);
});

test('the URL keeps the place and refuses junk', () => {
  assert.deepEqual(readPlace('?tab=rules'), { tab: 'rules', market: null });
  assert.deepEqual(readPlace('?market=ETH-USD'), { tab: 'leverage', market: 'ETH-USD' });
  assert.deepEqual(readPlace('?tab=x&market=<b>'), { tab: 'leverage', market: null });
  assert.equal(placeSearch('leverage', 'ETH-USD'), '?market=ETH-USD');
  assert.equal(placeSearch('rules', 'ETH-USD'), '?tab=rules');
  assert.equal(placeSearch('leverage', null), '');
});

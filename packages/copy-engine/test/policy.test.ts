import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COPY_FEE_MAX, copyFeeFor, effectiveLeverage, feePercent, normaliseCountry, regionPolicy } from '../src/index.ts';

test('the US, its territories and sanctioned countries are blocked, declared or seen', () => {
  for (const c of ['US', 'PR', 'GU', 'IR', 'KP', 'RU', 'CU', 'SY', 'BY']) assert.equal(regionPolicy(c).allowed, false, c);
  const seen = regionPolicy('SG', 'US');
  assert.equal(seen.allowed, false);
  assert.equal(seen.mismatch, true);
  assert.match(seen.reason!, /United States/);
});

test('EEA residents copy at 2x at most; the stricter of declared and seen applies', () => {
  const de = regionPolicy('DE');
  assert.equal(de.allowed, true);
  assert.equal(de.maxLeverage, 2);
  assert.equal(regionPolicy('NO').maxLeverage, 2);
  assert.equal(regionPolicy('SG', 'FR').maxLeverage, 2);
  assert.equal(regionPolicy('FR', 'SG').maxLeverage, 2);
  assert.equal(regionPolicy('SG').maxLeverage, null);
  assert.equal(regionPolicy('CH').maxLeverage, null);
  assert.equal(regionPolicy('GB').maxLeverage, null);
});

test('no declared country, no copy; unknown observed codes are ignored', () => {
  assert.equal(regionPolicy(null).allowed, false);
  assert.equal(regionPolicy('', 'SG').allowed, false);
  assert.equal(normaliseCountry('xx'), null);
  assert.equal(normaliseCountry(' de '), 'DE');
  assert.equal(regionPolicy('SG', 'XX').mismatch, false);
});

test('effective leverage: the lowest of the follower, the region, the market', () => {
  assert.equal(effectiveLeverage(10, { maxLeverage: null }, 20), 10);
  assert.equal(effectiveLeverage(10, { maxLeverage: 2 }, 20), 2);
  assert.equal(effectiveLeverage(10, { maxLeverage: null }, 3), 3);
  assert.equal(effectiveLeverage(0.5, { maxLeverage: null }, 3), 1);
});

test('the copy fee ladder by 14-day volume', () => {
  assert.equal(copyFeeFor(null), 25);
  assert.equal(copyFeeFor(0), 25);
  assert.equal(copyFeeFor(99_999), 25);
  assert.equal(copyFeeFor(100_000), 20);
  assert.equal(copyFeeFor(2_000_000), 12);
  assert.equal(copyFeeFor(50_000_000), 10);
  assert.equal(COPY_FEE_MAX, 25);
  assert.equal(feePercent(25), '0.025%');
  assert.equal(feePercent(10), '0.01%');
});

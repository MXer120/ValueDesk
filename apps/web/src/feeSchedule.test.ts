/**
 * Fee-schedule parsing: venue tiers stay as reported, and the builder row
 * matches only a signed fee.
 * Run (from apps/web): npx tsx --test src/feeSchedule.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builderTierIndex, builderVolumeLabel, copyVolumeLabel } from './builderSchedule';
import {
  feeTierRows,
  feeVolumeLabel,
  fmtRate,
  readVenueFee,
  rebateRows,
  stakingMark,
  withBuilder,
} from './fees';

test('a missing maker rebate stays missing, and tier 0 is kept', () => {
  const rate = readVenueFee({
    takerFeeRate: '0.0004',
    makerFeeRate: '0.00012',
    feeTier: 0,
    stakingTier: 0,
  });
  assert.ok(rate);
  assert.equal(rate.taker, 0.0004);
  assert.equal(rate.maker, 0.00012);
  assert.equal(rate.feeTier, 0);
  assert.equal(rate.stakingTier, 0);
  assert.equal(rate.makerRebateTier, null);
});

test('a wrapped gateway body unwraps, and a reported zero rebate stays zero', () => {
  const rate = readVenueFee({
    engine: 'perps',
    feeRate: {
      takerFeeRate: '0.00065',
      makerFeeRate: '0.00035',
      feeTier: '0',
      stakingTier: 1,
      makerRebateTier: 0,
    },
  });
  assert.equal(rate?.feeTier, 0);
  assert.equal(rate?.stakingTier, 1);
  assert.equal(rate?.makerRebateTier, 0);
  assert.equal(rate?.taker, 0.00065);
});

test('a body without both rates is not a tier', () => {
  assert.equal(readVenueFee(null), null);
  assert.equal(readVenueFee({ feeRate: { takerFeeRate: '0.0004' } }), null);
  assert.equal(readVenueFee({ takerFeeRate: '0.0004', makerFeeRate: 'nope', feeTier: 0 }), null);
});

test('the builder row is the signed fee, not a reported index that disagrees', () => {
  assert.equal(builderTierIndex(10, 'perps', 2), 2);
  assert.equal(builderTierIndex(15, 'perps', 2), 0);
  assert.equal(builderTierIndex(15, 'perps', 0), 0);
  assert.equal(builderTierIndex(12, 'spot', null), 1);
  assert.equal(builderTierIndex(20, 'spot', 0), null);
});

test('the builder fraction is added to the venue rate', () => {
  assert.equal(withBuilder(0.0004, 0.00015), 0.00055);
  assert.equal(fmtRate(withBuilder(0.0004, 0.00015)), '0.055%');
  assert.equal(fmtRate(withBuilder(0.00012, 0.00015)), '0.027%');
});

test('staking tiers are not collapsed when the engines disagree', () => {
  assert.deepEqual(stakingMark(1, 4), { highlight: null, split: true });
  assert.deepEqual(stakingMark(2, 2), { highlight: 2, split: false });
  assert.deepEqual(stakingMark(null, 3), { highlight: 3, split: false });
  assert.deepEqual(stakingMark(0, 0), { highlight: 0, split: false });
  assert.deepEqual(stakingMark(null, null), { highlight: null, split: false });
  assert.deepEqual(stakingMark(7, 2), { highlight: null, split: true });
});

test('fee tier 0 is a real row, and a missing tier is not tier 0', () => {
  assert.deepEqual(feeTierRows(0, 0), { highlight: 0, also: null });
  assert.deepEqual(feeTierRows(null, 0), { highlight: null, also: 0 });
  assert.deepEqual(feeTierRows(1, 4), { highlight: 1, also: 4 });
  assert.deepEqual(feeTierRows(9, 2), { highlight: null, also: 2 });
});

test('volume bands print full dollars, and the boundary stays with the lower tier', () => {
  assert.equal(feeVolumeLabel(0), '≤ $5,000,000');
  assert.equal(feeVolumeLabel(1), '> $5,000,000');
  assert.equal(feeVolumeLabel(6), '> $7,000,000,000');
  assert.equal(builderVolumeLabel(0), '< $1,000,000');
  assert.equal(builderVolumeLabel(1), '≥ $1,000,000');
  assert.equal(builderVolumeLabel(4), '≥ $100,000,000');
  assert.equal(copyVolumeLabel(0), '< $100,000');
  assert.equal(copyVolumeLabel(1), '≥ $100,000');
  assert.equal(copyVolumeLabel(4), '≥ $10,000,000');
});

test('maker rebate tier 0 is not a row', () => {
  assert.deepEqual(rebateRows(0, 2), { highlight: null, also: 2 });
  assert.deepEqual(rebateRows(2, 2), { highlight: 2, also: null });
  assert.deepEqual(rebateRows(2, 3), { highlight: 2, also: 3 });
  assert.deepEqual(rebateRows(null, null), { highlight: null, also: null });
});

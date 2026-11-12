/**
 * Grid presets (gridPresets.ts): the step and range arithmetic, the volatility the presets scale by, the backtest
 * reading at the wallet's own fee, and a running grid read back as its preset.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GRID_PRESETS, draftStepBps, gridEstimate, gridHalfRange, gridStepBps, hourlyVolBps, nearestGridRow, presetRangePct } from './gridPresets';
import { GRID_BT, GRID_BT_FEE_BPS } from './gridBacktest';
import { draftOfRecipe, gridRecipeOf, recipeOfDraft } from './recipes';
import { specOf } from './presets';

test('a geometric grid: the step from its range and levels, and the range from a step, agree', () => {
  const step = 50; // bp
  for (const L of [10, 20, 40]) {
    const half = gridHalfRange(step, L);
    const low = 100 / (1 + half);
    const high = 100 * (1 + half);
    assert.ok(Math.abs(gridStepBps(low, high, L) - step) < 1e-6);
  }
  assert.equal(gridStepBps(100, 100, 10), 0);
  assert.equal(gridStepBps(0, 100, 10), 0);
});

test('hourly volatility: sd of 5-minute returns x sqrt 12; too few candles read as unknown', () => {
  // alternating +-10 bp moves: sd 10 bp a 5-minute step -> about 34.6 bp an hour
  const c = [100];
  for (let i = 0; i < 288; i++) c.push(c[c.length - 1]! * (i % 2 ? 1.001 : 1 / 1.001));
  const v = hourlyVolBps(c)!;
  assert.ok(Math.abs(v - 10 * Math.sqrt(12)) < 0.2, String(v));
  assert.equal(hourlyVolBps([1, 2, 3]), null);
});

test('a preset grid follows the volatility: its step is k x the hourly sd', () => {
  const vol = 40;
  const d = { ...draftOfRecipe('grid', 'BTC-USD'), rangePct: presetRangePct(GRID_PRESETS.grid.k, GRID_PRESETS.grid.levels, vol) };
  assert.equal(d.gridK, GRID_PRESETS.grid.k);
  assert.equal(d.levels, GRID_PRESETS.grid.levels);
  assert.equal(d.outOfRange, 'stop');
  assert.ok(Math.abs(draftStepBps(d, vol) - GRID_PRESETS.grid.k * vol) < 1e-9);
  // its own prices win over the preset
  const own = { ...d, low: 90, high: 110 };
  assert.ok(Math.abs(draftStepBps(own, vol) - gridStepBps(90, 110, d.levels)) < 1e-9);
  // the spec it signs carries a range around the price
  const s = specOf(d, 100) as { low: number; high: number; levels: number; outOfRange: string };
  assert.ok(s.low < 100 && s.high > 100);
  assert.equal(s.outOfRange, 'stop');
});

test('the estimate is the backtest row nearest the step, moved to the wallet fee', () => {
  const vol = 40;
  const at = (feeBps: number) => gridEstimate({ symbol: 'BTC-USD', stepBps: 2 * vol, levels: 20, outOfRange: 'stop', volBps: vol, feeBps });
  const a = at(GRID_BT_FEE_BPS);
  const row = nearestGridRow(2, 20, 'stop')!;
  assert.equal(a.row, row);
  assert.ok(Math.abs(a.bp! - -row.all[4] / 100) < 1e-9);
  // 0.5 bp more a fill costs 0.5 bp more per $1, and 0.5 x turnover bp of the notional a day
  const b = at(GRID_BT_FEE_BPS + 0.5);
  assert.ok(Math.abs(b.bp! - a.bp! - 0.5) < 1e-9);
  assert.ok(Math.abs(a.dayBps! - b.dayBps! - 0.5 * row.all[3]) < 1e-9);
  assert.ok(Math.abs(a.netStepBps - (2 * vol - 2 * GRID_BT_FEE_BPS)) < 1e-9);
  // no volatility reading: no estimate
  assert.equal(gridEstimate({ symbol: 'BTC-USD', stepBps: 80, levels: 20, outOfRange: 'stop', volBps: null, feeBps: 1.7 }).bp, null);
});

test('every preset has a tested row; a running grid reads back as the closest preset', () => {
  for (const p of Object.values(GRID_PRESETS)) {
    const r = nearestGridRow(p.k, p.levels, p.outOfRange)!;
    assert.equal(r.k, p.k);
    assert.equal(r.L, p.levels);
  }
  assert.ok(GRID_BT.length > 0);
  assert.equal(gridRecipeOf(10), 'gridc');
  assert.equal(gridRecipeOf(20), 'grid');
  assert.equal(gridRecipeOf(40), 'gridv');
  assert.equal(recipeOfDraft(draftOfRecipe('gridv', 'ETH-USD')), 'gridv');
});

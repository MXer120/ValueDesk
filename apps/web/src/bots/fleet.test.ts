/** The Bots page's summary and chart (fleet.ts): totals over every bot, and one series on a shared 5-minute grid. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AlgoView } from '@copy-engine';
import { fleetSeries, fleetTotals, fleetWindow, foldRuns, keepSeries } from './fleet';

const M = 5 * 60_000;
const T0 = 1_800_000_000_000 - (1_800_000_000_000 % M);

function view(status: string, series: Array<[number, number, number, number]>, bot: Partial<NonNullable<AlgoView['bot']>>): AlgoView {
  return {
    algo: { status, book: { series } },
    bot: { volume: 0, netPnl: 0, tradeFees: 0, builderFees: 0, inventoryUsd: 0, fills: 0, makerShare: 1, ...bot },
  } as unknown as AlgoView;
}

test('totals: volume, net PnL, both fees, holding and cost per $1M over every bot; running counted', () => {
  const a = view('running', [], { volume: 600_000, netPnl: -120, tradeFees: 72, builderFees: 30, inventoryUsd: 20, fills: 50 });
  const b = view('cancelled', [], { volume: 400_000, netPnl: -80, tradeFees: 48, builderFees: 20, inventoryUsd: -5, fills: 30 });
  const t = fleetTotals([a, b]);
  assert.equal(t.bots, 2);
  assert.equal(t.running, 1);
  assert.equal(t.volume, 1_000_000);
  assert.equal(t.costPerMillion, 200);
  assert.equal(t.tradeFees + t.builderFees, 170);
  assert.equal(t.holdingUsd, 20, 'a stopped bot holds nothing');
  assert.equal(fleetTotals([]).costPerMillion, null);
});

test('series: two bots on their own clocks sum on one grid; bars are volume per step, the line net PnL so far', () => {
  const a = view('cancelled', [[T0 + 10_000, 100, -0.1, 0.02], [T0 + M + 10_000, 300, -0.2, 0.05]], {});
  const b = view('cancelled', [[T0 + M + 60_000, 50, 0.05, 0.01]], {});
  const s = fleetSeries([a, b], T0 + 10 * M);
  assert.deepEqual(s.volume.map((x) => x[1]), [100, 250]);
  assert.deepEqual(s.pnl.map((x) => Math.round(x[1] * 100) / 100), [-0.1, -0.15]);
  assert.deepEqual(fleetSeries([], T0), { volume: [], pnl: [], fees: [] });
});

test('a read without the series keeps each bot its own, and the fresh figures; a bot with none here asks for them all', () => {
  const had = { algo: { id: 'a', status: 'running', book: { fills: 1, series: [[T0, 10, 1, 0]] } } } as unknown as AlgoView;
  const now = { algo: { id: 'a', status: 'running', book: { fills: 9, series: [] } }, bot: { volume: 99 } } as unknown as AlgoView;
  const [v] = keepSeries([now], [had])!;
  assert.deepEqual(v!.algo.book!.series, [[T0, 10, 1, 0]]);
  assert.equal(v!.algo.book!.fills, 9);
  assert.equal(v!.bot!.volume, 99);
  const fresh = { algo: { id: 'b', status: 'running', book: { fills: 0, series: [] } } } as unknown as AlgoView;
  assert.equal(keepSeries([now, fresh], [had]), null);
  const noBook = { algo: { id: 'c', status: 'running' } } as unknown as AlgoView;
  assert.deepEqual(keepSeries([noBook], []), [noBook]);
});

test('window: what the timeframe moved, not the total since the first bot; volume as a running total', () => {
  const s = { volume: [[T0, 100], [T0 + M, 200], [T0 + 2 * M, 50]] as Array<[number, number]>, pnl: [[T0, -1], [T0 + M, -3], [T0 + 2 * M, -2]] as Array<[number, number]>, fees: [[T0, 0.1], [T0 + M, 0.3], [T0 + 2 * M, 0.35]] as Array<[number, number]> };
  const w = fleetWindow(s, T0 + M);
  assert.equal(w.volume, 250);
  assert.equal(w.netPnl, -1, 'from -1 before the window to -2');
  assert.ok(Math.abs(w.fees - 0.25) < 1e-9);
  assert.deepEqual(w.volTrend, [200, 250]);
  assert.deepEqual(w.pnlTrend, [-2, -1]);
  assert.equal(fleetWindow(s, -Infinity).netPnl, -2);
});

test('runs: stopped runs of one bot fold into one row with their figures added up; running bots stand alone', () => {
  const run = (id: string, status: string, end: number, volume: number, netPnl: number) => ({
    algo: { id, status, createdAt: end - 100, startedAt: end - 100, endedAt: status === 'running' ? null : end, spec: { symbol: 'KORU-USD', label: 'KORU' } },
    bot: { volume, netPnl, grossPnl: netPnl, tradeFees: 0, builderFees: 0, inventoryUsd: -3, inventory: -1, fills: 1, makerShare: 1, costPerMillion: null },
  }) as unknown as AlgoView;
  const views = [run('a', 'cancelled', 1000, 100, -1), run('b', 'cancelled', 2000, 200, 1), run('c', 'running', 3000, 50, 0)];
  const { list, runs } = foldRuns(views, () => 'KORU');
  assert.equal(list.length, 2);
  const merged = list.find((v) => v.algo.id === 'b')!;
  assert.equal(runs.get('b'), 2);
  assert.equal(merged.bot!.volume, 300);
  assert.equal(merged.bot!.netPnl, 0);
  assert.equal(merged.bot!.inventoryUsd, 0, 'a stopped run holds nothing');
  assert.ok(list.some((v) => v.algo.id === 'c'));
});

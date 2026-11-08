/** The Bots page's summary and chart (fleet.ts): totals over every bot, and one series on a shared 5-minute grid. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AlgoView } from '@copy-engine';
import { fleetSeries, fleetTotals, fleetWindow, foldRuns, inPlacePatch, keepActed, keepSeries, mergeLog } from './fleet';

const M = 5 * 60_000;
const T0 = 1_800_000_000_000 - (1_800_000_000_000 % M);

function view(status: string, series: Array<[number, number, number, number]>, bot: Partial<NonNullable<AlgoView['bot']>>, paper = false): AlgoView {
  return {
    algo: { status, book: { series }, spec: { paper } },
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

test('totals: practice bots counted apart, never in the money; paused not running; holding gross, never netted', () => {
  const long = view('running', [], { volume: 100, netPnl: 1, inventoryUsd: 40 });
  const short = view('running', [], { volume: 100, netPnl: 1, inventoryUsd: -30 });
  const paused = view('paused', [], { volume: 50, inventoryUsd: 0 });
  const paper = view('running', [], { volume: 9_999, netPnl: 500, inventoryUsd: 77 }, true);
  const t = fleetTotals([long, short, paused, paper]);
  assert.equal(t.bots, 3);
  assert.equal(t.running, 2);
  assert.equal(t.paused, 1);
  assert.deepEqual(t.practice, { bots: 1, running: 1 });
  assert.equal(t.volume, 250, 'practice volume left out');
  assert.equal(t.netPnl, 2);
  assert.equal(t.holdingUsd, 70, '40 long and 30 short is 70 held, not 10');
  assert.equal(t.longUsd, 40);
  assert.equal(t.shortUsd, 30);
});

test('series in a window: the step is the window\'s (1H keeps 5-minute points on a long history), nothing before it counted in it', () => {
  // Thirty days of points, one an hour, then 5-minute points in the last hour.
  const pts: Array<[number, number, number, number]> = [];
  for (let i = 0; i < 30 * 24; i++) pts.push([T0 + i * 3_600_000, i * 10, -i * 0.01, i * 0.001]);
  const end = T0 + 30 * 24 * 3_600_000;
  for (let i = 0; i <= 12; i++) pts.push([end + i * M, 7_200 + i * 5, -7.2, 0.72]);
  const a = view('cancelled', pts, {});
  const now = end + 12 * M;
  const from = now - 3_600_000;
  const s = fleetSeries([a], now, M, from);
  assert.ok(s.volume.length >= 12, `${s.volume.length} points in the hour`);
  assert.ok(s.volume[0]![0] < from, 'one point just before the window');
  assert.equal(s.volume[0]![1], 0);
  const inWin = s.volume.filter((p) => p[0] >= from).reduce((t, p) => t + p[1], 0);
  assert.equal(inWin, 60, 'only what traded inside the hour (12 x 5)');
  const w = fleetWindow(s, from);
  assert.equal(w.volume, 60);
  assert.ok(Math.abs(w.netPnl) < 1e-9, 'PnL did not move inside the hour');
  // The whole history still steps in hours or more.
  const all = fleetSeries([a], now, M);
  assert.ok(all.volume.length <= 1_501);
});

test('runs fold by practice or real too, and the folded series joins every run', () => {
  const run = (id: string, end: number, volume: number, netPnl: number, paper: boolean) => ({
    algo: { id, status: 'cancelled', createdAt: end - 100, startedAt: end - 100, endedAt: end, spec: { symbol: 'KORU-USD', paper }, book: { series: [[end - 50, volume / 2, netPnl / 2, 0], [end, volume, netPnl, 0]] } },
    bot: { volume, netPnl, grossPnl: netPnl, tradeFees: 0, builderFees: 0, inventoryUsd: 0, inventory: 0, fills: 1, makerShare: 1, costPerMillion: null },
  }) as unknown as AlgoView;
  const { list, runs } = foldRuns([run('a', 1000, 100, -1, false), run('b', 2000, 200, 2, false), run('p', 3000, 50, 5, true)], () => 'KORU');
  assert.equal(list.length, 2, 'the practice run stands apart');
  assert.equal(runs.get('b'), 2);
  const merged = list.find((v) => v.algo.id === 'b')!;
  assert.deepEqual(merged.algo.book!.series.map((p) => p[1]), [50, 100, 200, 300], 'the second run on top of the first');
  assert.deepEqual(merged.algo.book!.series.map((p) => p[2]), [-0.5, -1, 0, 1]);
});

test('a read sent before the last action on a bot keeps the bot as the action left it', () => {
  const stopped = { algo: { id: 'a', status: 'cancelled' } } as unknown as AlgoView;
  const stale = { algo: { id: 'a', status: 'running' } } as unknown as AlgoView;
  const other = { algo: { id: 'b', status: 'running' } } as unknown as AlgoView;
  const acted = new Map([['a', 1_000]]);
  assert.equal(keepActed([stale, other], [stopped], 900, acted)[0], stopped, 'asked before the stop: the stop stays');
  assert.equal(keepActed([stale, other], [stopped], 1_100, acted)[0], stale, 'asked after: the read wins');
  assert.equal(keepActed([stale, other], [stopped], 900, acted)[1], other);
});

test('settings: a rename, loss limit, run time or size updates in place; a market, kind or leverage change restarts', () => {
  const base = { kind: 'mm', symbol: 'BTC-USD', paper: false, label: null, orderUsd: 20, maxLossUsd: 50, onStop: 'close', stillBps: 2, stillMs: 60_000 };
  assert.deepEqual(inPlacePatch(base, { ...base, label: 'Mine', maxLossUsd: 80 }, false), { label: 'Mine', maxLossUsd: 80 });
  assert.deepEqual(inPlacePatch(base, { ...base, endAt: 123 }, true), { endAt: 123 });
  assert.deepEqual(inPlacePatch(base, { ...base, maxLossUsd: undefined }, false), { maxLossUsd: null });
  const { stillBps: _a, stillMs: _b, ...noGate } = base;
  assert.deepEqual(inPlacePatch(base, noGate, false), { stillBps: 0, stillMs: 0 }, 'the gate off');
  assert.equal(inPlacePatch(base, { ...base, symbol: 'ETH-USD' }, false), null);
  assert.equal(inPlacePatch(base, { ...base, leverage: 3 }, false), null);
  assert.equal(inPlacePatch(base, { ...base, kind: 'grid' }, false), null);
  assert.equal(inPlacePatch(base, base, false), null, 'nothing changed');
  const grid = { kind: 'grid', symbol: 'BTC-USD', low: 1, high: 2, levels: 10, orderUsd: 20 };
  assert.equal(inPlacePatch(grid, { ...grid, levels: 12 }, false), null, "a grid's levels restart it");
  assert.deepEqual(inPlacePatch(grid, { ...grid, orderUsd: 30 }, false), { orderUsd: 30 });
});

test('log pages: one line per id, newest first, two lines in one millisecond both kept, capped at the oldest', () => {
  const e = (id: string, at: number) => ({ id, at });
  const r = mergeLog([e('a', 10), e('b', 9)], [[e('c', 10), e('a', 10)], [e('d', 8)]]);
  assert.deepEqual(r.list.map((x) => x.id), ['c', 'a', 'b', 'd']);
  assert.equal(r.added, 2);
  assert.equal(r.cut, false);
  const capped = mergeLog([], [[e('x', 3), e('y', 2), e('z', 1)]], 2);
  assert.deepEqual(capped.list.map((x) => x.id), ['x', 'y']);
  assert.equal(capped.cut, true);
});

test('routes: a malformed bot address is an unknown bot, not a page that throws', async () => {
  const { botsViewFor } = await import('./routes');
  assert.deepEqual(botsViewFor('/bots/%E0'), { page: 'bot', id: '%E0' });
  assert.deepEqual(botsViewFor('/bots/a%20b'), { page: 'bot', id: 'a b' });
});

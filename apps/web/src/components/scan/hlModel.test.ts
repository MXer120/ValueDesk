/**
 * Run: npx tsx --test src/components/scan/hlModel.test.ts   (from apps/web)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TraderProfile, VsPosition } from '../../vsApi';
import { analyticsSuspectNote, chartValueIsPnl, curveOf, exposureOf, fillStats, hasActivity, marginOf, maxDrawdownOf, priceDp, unrealizedOf, windowCurve } from './hlModel';

test('analyticsSuspectNote: one sentence per flag, null when the history is usable', () => {
  assert.equal(analyticsSuspectNote(null), null);
  assert.equal(analyticsSuspectNote(undefined), null);
  assert.match(analyticsSuspectNote('no-deposits-recorded')!, /records no deposits, so its account value equals its PnL\. Showing live equity only\.$/);
  assert.match(analyticsSuspectNote('live-mismatch')!, /stopped following this account\. Showing live equity only\.$/);
  assert.match(analyticsSuspectNote('single-jump')!, /incomplete\. Showing live equity only\.$/);
});

const pos = (o: Partial<VsPosition>): VsPosition => ({
  symbol: 'BTC', side: 'long', size: 1, notional: 100, entryPx: 100, markPx: 100,
  liqPx: null, uPnl: 0, leverage: 10, marginMode: 'cross', ...o,
});

const profile = (o: Partial<TraderProfile['summary']> = {}, positions: VsPosition[] = []): TraderProfile => ({
  summary: {
    venue: 'hyperliquid', address: '0x0', accountValue: null, pnl: {}, roi: {}, volume: {}, ...o,
  },
  positions,
  equity: {},
  updatedAt: 0,
  source: 'test',
});

test('hasActivity: null and empty shells are inactive, any one signal is active', () => {
  assert.equal(hasActivity(null), false);
  assert.equal(hasActivity(profile()), false);
  assert.equal(hasActivity(profile({ accountValue: 0, volume: { all: 0 } })), false);
  assert.equal(hasActivity(profile({ accountValue: 12 })), true);
  assert.equal(hasActivity(profile({ volume: { '30d': 5 } })), true);
  assert.equal(hasActivity(profile({ lastActive: 1 })), true);
  assert.equal(hasActivity(profile({}, [pos({})])), true);
});

test('exposureOf: long/short split, shares, leverage and unpriced rows', () => {
  const e = exposureOf(
    [pos({ symbol: 'BTC', notional: 300 }), pos({ symbol: 'ETH', side: 'short', notional: -100 }), pos({ symbol: 'X', notional: Number.NaN })],
    200,
  )!;
  assert.equal(e.long, 300);
  assert.equal(e.short, 100);
  assert.equal(e.gross, 400);
  assert.equal(e.net, 200);
  assert.equal(e.grossLeverage, 2);
  assert.equal(e.unpriced, 1);
  assert.deepEqual(e.byMarket.map((m) => [m.symbol, m.share]), [['BTC', 0.75], ['ETH', 0.25]]);
  assert.equal(exposureOf([], 100), null);
  assert.equal(exposureOf([pos({})], null)!.grossLeverage, null);
});

test('unrealizedOf: a partial sum is null, not a smaller number', () => {
  assert.equal(unrealizedOf([pos({ uPnl: 5 }), pos({ uPnl: -2 })]), 3);
  assert.equal(unrealizedOf([pos({ uPnl: 5 }), pos({ uPnl: null })]), null);
  assert.equal(unrealizedOf([]), null);
});

test('marginOf: notional / leverage split by mode, free floored at zero', () => {
  const m = marginOf(
    [
      pos({ notional: 1000, leverage: 10, marginMode: 'cross' }),
      pos({ notional: 500, leverage: 5, marginMode: 'isolated' }),
      pos({ notional: 200, leverage: 2, marginMode: null }),
      pos({ notional: 50, leverage: null }),
    ],
    250,
  )!;
  assert.equal(m.cross, 200);
  assert.equal(m.isolated, 100);
  assert.equal(m.unknownMode, 1);
  assert.equal(m.skipped, 1);
  assert.equal(m.used, 300);
  assert.equal(m.free, 0);
  assert.equal(marginOf([], null), null);
});

test('curveOf: rebased to the first point, nulls dropped, fewer than two points is null', () => {
  const c = curveOf(
    [
      { t: 3, accountValue: 90, pnl: null },
      { t: 1, accountValue: 100, pnl: 0 },
      { t: 2, accountValue: 120, pnl: 20 },
    ],
    'accountValue',
  )!;
  assert.deepEqual(c.points, [{ t: 1, v: 0 }, { t: 2, v: 20 }, { t: 3, v: -10 }]);
  assert.equal(c.baseline, 100);
  assert.equal(c.change, -10);
  assert.equal(c.maxDrawdown, -30);
  assert.equal(curveOf([{ t: 1, accountValue: 1, pnl: 0 }], 'pnl'), null);
  assert.equal(curveOf(undefined, 'pnl'), null);
  // The pnl series skips the null point.
  assert.equal(curveOf([{ t: 1, accountValue: 1, pnl: 0 }, { t: 2, accountValue: 1, pnl: null }], 'pnl'), null);
});

test('maxDrawdownOf: a fall from a peak, not the lowest point', () => {
  assert.equal(maxDrawdownOf([0, 0.23, -0.25]), -0.48);
  assert.equal(maxDrawdownOf([1, 2, 3]), 0);
});

test('fillStats: sums, closing fills, win count and the time span', () => {
  const s = fillStats([
    { id: '1', time: 10, symbol: 'BTC', side: 'buy', px: 1, sz: 1, notional: 100, fee: 0.1, closedPnl: 0 },
    { id: '2', time: 30, symbol: 'BTC', side: 'sell', px: 1, sz: 1, notional: -50, fee: 0.2, closedPnl: 5 },
    { id: '3', time: 20, symbol: 'ETH', side: 'sell', px: 1, sz: 1, notional: 50, fee: null, closedPnl: -2 },
  ]);
  assert.equal(s.count, 3);
  assert.equal(s.volume, 200);
  assert.ok(Math.abs(s.fees! - 0.3) < 1e-12);
  assert.equal(s.realised, 3);
  assert.equal(s.closing, 2);
  assert.equal(s.wins, 1);
  assert.equal(s.oldest, 10);
  assert.equal(s.newest, 30);
  const empty = fillStats([]);
  assert.equal(empty.fees, null);
  assert.equal(empty.realised, null);
  assert.equal(empty.oldest, null);
});

test('priceDp: precision follows magnitude', () => {
  assert.equal(priceDp(75921.5), 1);
  assert.equal(priceDp(3512.34), 2);
  assert.equal(priceDp(1.2345), 5);
  assert.equal(priceDp(0.0001234), 8);
  assert.equal(priceDp(0), 2);
});

test('windowCurve: a quiet window reads flat from the other windows, never "fewer than two points"', () => {
  const D = 86_400_000;
  const NOW = 100 * D;
  const eq = {
    '30d': [{ t: NOW - 40 * D, accountValue: 500, pnl: 12 }],
    all: [{ t: NOW - 90 * D, accountValue: 300, pnl: 2 }, { t: NOW - 40 * D, accountValue: 500, pnl: 12 }],
  };
  const c = windowCurve(eq, '30d', 'pnl', NOW)!;
  assert.ok(c, 'a curve');
  assert.equal(c.change, 0, 'nothing moved inside 30 days');
  assert.equal(c.points[0]!.t, NOW - 30 * D);
  assert.equal(c.points.at(-1)!.t, NOW);
  assert.equal(windowCurve(eq, 'all', 'pnl', NOW)!.change, 10);
  assert.equal(windowCurve({}, '30d', 'pnl', NOW), null, 'no value at all stays empty');
  const own = { '7d': [{ t: NOW - 2 * D, accountValue: 1, pnl: 1 }, { t: NOW - D, accountValue: 2, pnl: 4 }] };
  assert.equal(windowCurve(own, '7d', 'pnl', NOW)!.change, 3, "the venue's own series wins");
});

test('chartValueIsPnl: SoDEX analytics that never saw a deposit (value == PnL at every funded point)', () => {
  const pt = (accountValue: number, pnl: number) => ({ accountValue, pnl });
  assert.equal(chartValueIsPnl([pt(0, 0), pt(5e6, 5e6), pt(5e6, 5e6), pt(5.1e6, 5.1e6)]), 'no-deposits-recorded');
  assert.equal(chartValueIsPnl([pt(1e6, 0), pt(1.1e6, 1e5), pt(1.2e6, 2e5)]), null); // deposits recorded
  assert.equal(chartValueIsPnl([pt(10, 10), pt(10, 10)]), null); // too few points to mean anything
  assert.equal(chartValueIsPnl(null), null);
});

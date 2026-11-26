/**
 * Run: npx tsx --test src/components/scan/versions/model.test.ts   (from apps/web)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TraderProfile, Venue, VsPosition } from '../../../vsApi';
import type { VenueCard } from '../addressVenues';
import { bestVenue, bookTotals, byRisk, crossPositions, exposureByCoin, liqDistance, moveOf, roeOf, standingOf, windowFigures } from './model';

const card = (venue: Venue, o: Partial<VenueCard> = {}): VenueCard => ({
  venue, exists: true, unknown: false, inactive: false, equity: null, lastActive: null, curve: null, ...o,
});

const pos = (o: Partial<VsPosition>): VsPosition => ({
  symbol: 'BTC-USD', side: 'long', size: 1, notional: 100, entryPx: 100, markPx: 100, liqPx: null, uPnl: 0, leverage: 10, ...o,
});

const profile = (positions: VsPosition[], o: Partial<TraderProfile['summary']> = {}): TraderProfile => ({
  summary: { venue: 'hyperliquid', address: '0x0', accountValue: null, pnl: {}, roi: {}, volume: {}, ...o },
  positions,
  equity: {},
  updatedAt: 0,
  source: '',
});

test('bestVenue waits for every venue, then takes the largest active account', () => {
  assert.equal(bestVenue([card('sodex', { equity: 10 }), card('hyperliquid', { pending: true })]), null);
  assert.equal(bestVenue([card('sodex', { equity: 10 }), card('hyperliquid', { equity: 50 })]), 'hyperliquid');
  // an inactive account loses to any active one, whatever its balance
  assert.equal(bestVenue([card('sodex', { equity: 900, inactive: true }), card('arcus', { equity: 1 })]), 'arcus');
  // only inactive: the first in venue order
  assert.equal(bestVenue([card('lighter', { inactive: true }), card('sodex', { inactive: true })]), 'sodex');
  // no account anywhere
  assert.equal(bestVenue([card('sodex', { exists: false }), card('hyperliquid', { exists: false, unknown: true })]), null);
});

test('standingOf says which kind of quiet', () => {
  assert.equal(standingOf(card('sodex', { pending: true })), 'loading');
  assert.equal(standingOf(card('sodex', { exists: false, unknown: true })), 'unknown');
  assert.equal(standingOf(card('sodex', { exists: false })), 'none');
  assert.equal(standingOf(card('sodex', { inactive: true })), 'inactive');
  assert.equal(standingOf(card('sodex')), 'active');
});

test('crossPositions keeps a position two venues report once, with both venues', () => {
  const aapl = pos({ symbol: 'xyz:AAPL', side: 'short', size: 80, notional: 28_418 });
  const rows = crossPositions({
    hyperliquid: profile([aapl, pos({ symbol: 'BTC', notional: 500 })]),
    tradexyz: profile([{ ...aapl }]),
    sodex: profile([pos({ symbol: 'AAPL-USD', side: 'short', size: 174, notional: 61_860 })]),
  });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.symbol), ['AAPL-USD', 'xyz:AAPL', 'BTC']);
  assert.deepEqual(rows[1]!.venues, ['hyperliquid', 'tradexyz']);
  // the same coin on two venues is one coin in the exposure
  const coins = exposureByCoin(rows);
  assert.equal(coins[0]!.coin, 'AAPL');
  assert.equal(coins[0]!.short, 61_860 + 28_418);
  assert.deepEqual(coins[0]!.venues, ['sodex', 'hyperliquid', 'tradexyz']);
});

test('bookTotals: a position without its own uPnL leaves the sum unknown, not partial', () => {
  const t = bookTotals([pos({ notional: 100, uPnl: 5 }), pos({ side: 'short', notional: 40, uPnl: -1 })])!;
  assert.deepEqual([t.long, t.short, t.gross, t.net, t.upnl], [100, 40, 140, 60, 4]);
  assert.equal(bookTotals([pos({ uPnl: null })])!.upnl, null);
  assert.equal(bookTotals([]), null);
});

test('liqDistance, moveOf and roeOf per side', () => {
  assert.equal(liqDistance(pos({ markPx: 100, liqPx: 80 })), 0.2);
  assert.equal(liqDistance(pos({ side: 'short', markPx: 100, liqPx: 150 })), 0.5);
  assert.equal(liqDistance(pos({ liqPx: null })), null);
  assert.equal(moveOf(pos({ entryPx: 100, markPx: 110 })), 0.1);
  assert.ok(Math.abs(moveOf(pos({ side: 'short', entryPx: 100, markPx: 110 }))! + 0.1) < 1e-12);
  assert.equal(roeOf(pos({ notional: 1000, leverage: 10, uPnl: 50 })), 0.5);
  assert.equal(roeOf(pos({ leverage: null })), null);
});

test('byRisk puts the nearest liquidation first', () => {
  const a = pos({ symbol: 'A', markPx: 100, liqPx: 50 });
  const b = pos({ symbol: 'B', markPx: 100, liqPx: 90 });
  const c = pos({ symbol: 'C', liqPx: null, notional: 9 });
  assert.deepEqual(byRisk([c, a, b]).map((p) => p.symbol), ['B', 'A', 'C']);
});

test('windowFigures: the venue figure first, the curve change only for a missing PnL', () => {
  const p = profile([], { pnl: { '30d': 12 }, roi: { '30d': 0.1 }, volume: {} });
  assert.deepEqual(windowFigures(p, '30d', 99), { pnl: 12, roi: 0.1, volume: null });
  assert.deepEqual(windowFigures(p, '7d', 3), { pnl: 3, roi: null, volume: null });
  assert.deepEqual(windowFigures(null, '7d', null), { pnl: null, roi: null, volume: null });
});

/**
 * Traders across every venue Scan reads: the selection, which venues come from
 * the pool and which from their leaderboards, and how a leaderboard venue's
 * rows meet the filters (hidden, never guessed, when it lacks the figure).
 *   npx tsx --test src/components/palette/venues.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TraderRow, Venue } from '../../vsApi';
import {
  DEFAULT_LIST_FILTERS,
  DEFAULT_SCREENER_FILTERS,
  PALETTE_VENUES,
  boardListRows,
  boardScreenerRows,
  boardVenues,
  interleaveVenues,
  isMissing,
  mergeByPnl,
  normaliseVenues,
  poolToggles,
  toggleVenueIn,
  venueList,
} from './model';

const row = (venue: Venue, n: number, o: Partial<TraderRow> = {}): TraderRow => ({
  venue,
  address: `${venue}-${n}`,
  label: null,
  accountValue: null,
  pnl: {},
  roi: {},
  volume: {},
  ...o,
} as TraderRow);

test('toggleVenueIn: flips one venue, keeps chip order, never empties', () => {
  assert.deepEqual(toggleVenueIn(['sodex'], 'lighter'), ['sodex', 'lighter']);
  assert.deepEqual(toggleVenueIn(['lighter', 'sodex'], 'arcus'), ['sodex', 'lighter', 'arcus']);
  assert.deepEqual(toggleVenueIn(['sodex', 'lighter'], 'sodex'), ['lighter']);
  assert.deepEqual(toggleVenueIn(['arcus'], 'arcus'), ['arcus'], 'the last venue stays on');
});

test('normaliseVenues: a stored selection made valid', () => {
  assert.deepEqual(normaliseVenues(['arcus', 'nope', 'sodex']), ['sodex', 'arcus']);
  assert.deepEqual(normaliseVenues([]), [...PALETTE_VENUES]);
  assert.deepEqual(normaliseVenues('x'), [...PALETTE_VENUES]);
});

test('poolToggles / boardVenues split a selection by data source', () => {
  assert.deepEqual(poolToggles(['sodex', 'lighter']), { sodex: true, hyperliquid: false });
  assert.equal(poolToggles(['tradexyz', 'arcus']), null);
  assert.deepEqual(boardVenues([...PALETTE_VENUES]), ['tradexyz', 'lighter', 'arcus']);
  assert.deepEqual(boardVenues(['sodex']), []);
});

test('interleaveVenues: every venue takes turns, SoDEX first', () => {
  const rows = [row('lighter', 1), row('lighter', 2), row('hyperliquid', 1), row('sodex', 1), row('arcus', 1)];
  assert.deepEqual(
    interleaveVenues(rows, 10).map((r) => r.address),
    ['sodex-1', 'hyperliquid-1', 'lighter-1', 'arcus-1', 'lighter-2'],
  );
});

test('boardListRows: a filter on a figure the venue lacks hides it and says why', () => {
  const rows = [row('lighter', 1, { volume: { '1d': 2_000_000 } }), row('lighter', 2, { volume: { '1d': 10 } }), row('lighter', 3)];
  assert.equal(boardListRows(rows, DEFAULT_LIST_FILTERS).rows.length, 3);
  const wr = [row('lighter', 1, { winRate: 0.7, winRateExact: false } as Partial<TraderRow>), row('lighter', 2, { winRate: 0.4 } as Partial<TraderRow>), row('lighter', 3)];
  assert.deepEqual(boardListRows(wr, { ...DEFAULT_LIST_FILTERS, minWinRate: 60 }), { rows: [wr[0]], hiddenBy: null }, 'an estimate counts; no win rate does not pass');
  assert.deepEqual(boardListRows(rows, { ...DEFAULT_LIST_FILTERS, strategy: 'swing' }).hiddenBy, 'strategy');
  assert.deepEqual(boardListRows(rows, { ...DEFAULT_LIST_FILTERS, active: '24h' }).hiddenBy, 'last active');
  const vol = boardListRows(rows, { ...DEFAULT_LIST_FILTERS, minVolume: 1_000_000, volWindow: '1d' });
  assert.deepEqual(vol.rows.map((r) => r.address), ['lighter-1'], 'an unknown volume does not pass a volume floor');
  assert.equal(vol.hiddenBy, null);
});

test('boardScreenerRows: presets hide; numeric floors (win rate too) filter; the sort is applied', () => {
  const rows = [
    row('arcus', 1, { accountValue: 50, pnl: { '30d': 5 }, roi: { '30d': 0.2 } }),
    row('arcus', 2, { accountValue: 500, pnl: { '30d': 50 }, roi: { '30d': 0.05 } }),
    row('arcus', 3, { accountValue: null, pnl: {} }),
  ];
  assert.equal(boardScreenerRows(rows, { ...DEFAULT_SCREENER_FILTERS, preset: 'whales' }).hiddenBy, 'preset');
  const wr = [row('arcus', 7, { winRate: 0.55 } as Partial<TraderRow>), row('arcus', 8, { winRate: 0.8, winRateExact: false } as Partial<TraderRow>), row('arcus', 9)];
  assert.deepEqual(boardScreenerRows(wr, { ...DEFAULT_SCREENER_FILTERS, minWinRate: 50 }).rows.map((r) => r.address), ['arcus-7', 'arcus-8']);
  assert.deepEqual(boardScreenerRows(wr, { ...DEFAULT_SCREENER_FILTERS, sort: 'winRate' }).rows.map((r) => r.address), ['arcus-8', 'arcus-7', 'arcus-9']);
  assert.deepEqual(boardScreenerRows(rows, DEFAULT_SCREENER_FILTERS).rows.map((r) => r.address), ['arcus-2', 'arcus-1', 'arcus-3']);
  assert.deepEqual(
    boardScreenerRows(rows, { ...DEFAULT_SCREENER_FILTERS, sort: 'pnl', dir: 'asc' }).rows.map((r) => r.address),
    ['arcus-1', 'arcus-2', 'arcus-3'],
    'unknown figures stay last whichever way',
  );
  assert.deepEqual(boardScreenerRows(rows, { ...DEFAULT_SCREENER_FILTERS, minAccountValue: 100 }).rows.map((r) => r.address), ['arcus-2']);
  assert.deepEqual(boardScreenerRows(rows, { ...DEFAULT_SCREENER_FILTERS, minRoi: 10 }).rows.map((r) => r.address), ['arcus-1']);
});

test('mergeByPnl: board rows slot in by PnL, never below a page still to come', () => {
  const pool = [row('sodex', 1, { pnl: { '30d': 100 } }), row('hyperliquid', 1, { pnl: { '30d': 40 } })];
  const boards = [row('lighter', 1, { pnl: { '30d': 70 } }), row('lighter', 2, { pnl: { '30d': 10 } }), row('arcus', 1)];
  assert.deepEqual(mergeByPnl(pool, boards, '30d', false).map((r) => r.address), ['sodex-1', 'lighter-1', 'hyperliquid-1']);
  assert.deepEqual(
    mergeByPnl(pool, boards, '30d', true).map((r) => r.address),
    ['sodex-1', 'lighter-1', 'hyperliquid-1', 'lighter-2', 'arcus-1'],
  );
  assert.deepEqual(mergeByPnl([], boards, '30d', false).map((r) => r.address), ['lighter-1', 'lighter-2', 'arcus-1'], 'no pool: every board row, unknown PnL last');
});

test('venueList and isMissing', () => {
  assert.equal(venueList(['trade.xyz']), 'trade.xyz');
  assert.equal(venueList(['trade.xyz', 'Lighter', 'Arcus']), 'trade.xyz, Lighter and Arcus');
  assert.equal(isMissing('—'), true);
  assert.equal(isMissing('12%'), false);
});

import { amountInput, fmtAmountInput, parseAmount, winRateTint } from './model';

test('amount fields: typed shorthand in, compact text out', () => {
  assert.equal(amountInput('$1,500k'), '1500k');
  assert.equal(amountInput('2.5mm'), '2.5m');
  assert.equal(amountInput('abc'), '');
  assert.equal(parseAmount('250k'), 250_000);
  assert.equal(parseAmount('1.5m'), 1_500_000);
  assert.equal(parseAmount('2b'), 2e9);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount('.'), null);
  assert.equal(fmtAmountInput(250_000), '250k');
  assert.equal(fmtAmountInput(1_500_000), '1.5m');
  assert.equal(fmtAmountInput(950), '950');
  assert.equal(fmtAmountInput(null), '');
});

test('winRateTint: neutral at 50, the pair either side, stronger further out', () => {
  assert.deepEqual(winRateTint(50), { side: null, strength: 0 });
  assert.equal(winRateTint(40).side, 'neg');
  assert.equal(winRateTint(70).side, 'pos');
  assert.ok(winRateTint(70).strength > winRateTint(60).strength);
  assert.equal(winRateTint(100).strength, 1);
});

import { readTraderRefs, isTraderRef } from './model';

test('stored traders: every venue, and an old label never survives a read', () => {
  const A = '0x082e843a431aef031264dc232693dd710aedca88';
  assert.equal(isTraderRef({ venue: 'lighter', address: A, at: 1 }), true);
  const read = readTraderRefs([{ venue: 'arcus', address: A.toUpperCase().replace('0X', '0x'), label: 'Hidden Name', at: 5 }, { venue: 'x', address: A }]);
  assert.deepEqual(read, [{ venue: 'arcus', address: A, at: 5 }]);
  assert.equal(JSON.stringify(read).includes('Hidden'), false);
});

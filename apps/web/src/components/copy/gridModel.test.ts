/**
 * The Copy page's grid: categories, filters, search and sort.
 * Run (from apps/web): npx tsx --test src/components/copy/gridModel.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TraderRow } from '../../vsApi';
import { NO_FILTERS, filtersActive, scoreRows, shapeGrid, tradesCoin } from './gridModel';

const addr = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const row = (n: number, o: Partial<TraderRow> = {}): TraderRow => ({
  venue: 'hyperliquid', address: addr(n), accountValue: 100_000, pnl: { '30d': 10_000 * n }, roi: {}, volume: {},
  winRate: 0.6, winRateExact: true, winRateCloses: 50, trades: 50, assets: ['BTC'], ...o,
});

const base = { category: 'top' as const, filters: NO_FILTERS, sort: 'score' as const, window: '30d' as const };

test('rows of both venues are scored once each', () => {
  const s = scoreRows([row(1), row(1), row(1, { venue: 'sodex' })], '30d');
  assert.equal(s.length, 2);
});

test('the score sort puts a losing trader below the profitable ones', () => {
  const grid = shapeGrid(scoreRows([row(1, { pnl: { '30d': -5_000 }, accountValue: 9e7 }), row(2), row(3)], '30d'), base);
  assert.equal(grid[grid.length - 1]!.row.address, addr(1));
});

test('venue and coin categories', () => {
  const all = scoreRows([row(1), row(2, { venue: 'sodex', assets: ['ETH-USD'] }), row(3, { assets: ['xyz:SP500', 'SOL'] })], '30d');
  assert.deepEqual(shapeGrid(all, { ...base, category: 'sodex' }).map((s) => s.row.address), [addr(2)]);
  assert.deepEqual(shapeGrid(all, { ...base, category: 'eth' }).map((s) => s.row.address), [addr(2)]);
  assert.deepEqual(shapeGrid(all, { ...base, category: 'sol' }).map((s) => s.row.address), [addr(3)]);
  assert.ok(tradesCoin(row(9, { assets: ['xyz:BTC'] }), 'BTC'));
});

test('filters, and how many are on', () => {
  const all = scoreRows([row(1, { accountValue: 5_000 }), row(2, { winRate: 0.4 }), row(3, { pnl: { '30d': -1 } }), row(4)], '30d');
  const f = { minEquity: 10_000, profitableOnly: true, minWinRate: 0.5, minScore: 0 };
  assert.deepEqual(shapeGrid(all, { ...base, filters: f }).map((s) => s.row.address), [addr(4)]);
  assert.equal(filtersActive(f), 3);
  assert.equal(filtersActive(NO_FILTERS), 0);
});

test('search by part of the address', () => {
  const all = scoreRows([row(0xabc), row(0xdef)], '30d');
  assert.deepEqual(shapeGrid(all, { ...base, q: 'ABC' }).map((s) => s.row.address), [addr(0xabc)]);
});

test('a sort key a row lacks puts it last', () => {
  const all = scoreRows([row(1, { winRate: null }), row(2, { winRate: 0.5 })], '30d');
  assert.deepEqual(shapeGrid(all, { ...base, sort: 'winRate' }).map((s) => s.row.address), [addr(2), addr(1)]);
});

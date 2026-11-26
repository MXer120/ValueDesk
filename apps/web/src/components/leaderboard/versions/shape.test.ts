/** The leaderboard versions' shaping (shape.ts): `npx tsx --test` from apps/web. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TraderRow } from '../../../vsApi';
import { assetBase, dirOf, edgeOf, hasVolume, metricOf, shape, sizeOf, usableSort, type Shape } from './shape';

const row = (address: string, o: Partial<TraderRow> = {}): TraderRow => ({
  venue: 'hyperliquid', address, accountValue: null, pnl: {}, roi: {}, volume: {}, ...o,
});
const base: Shape = { window: '30d', side: 'top', sort: 'pnl', q: '', asset: 'all', size: 'all' };

const board = [
  row('0xaa', { rank: 1, pnl: { '30d': 900 }, volume: { '30d': 100_000 }, accountValue: 2_000_000, assets: ['BTC'], winRate: 0.4 }),
  row('0xbb', { rank: 2, pnl: { '30d': 500 }, volume: { '30d': 1_000 }, accountValue: 50_000, assets: ['xyz:NVDA'], winRate: 0.8 }),
  row('0xcc', { rank: 3, pnl: { '30d': 100 }, accountValue: 6_000_000, assets: ['SOL-USD', 'vGOLD'], venues: ['hyperliquid', 'lighter'] }),
];

test('edge is PnL per traded dollar in bps, null without volume', () => {
  assert.equal(edgeOf(board[0]!, '30d'), 90);
  assert.equal(edgeOf(board[1]!, '30d'), 5000);
  assert.equal(edgeOf(board[2]!, '30d'), null);
  assert.equal(edgeOf(row('0x1', { pnl: { '30d': 5 }, volume: { '30d': 0 } }), '30d'), null);
});

test('size bands are the Cohorts page bands over account value', () => {
  assert.equal(sizeOf(board[0]!), 'whale');
  assert.equal(sizeOf(board[1]!), 'medium');
  assert.equal(sizeOf(board[2]!), 'apex');
  assert.equal(sizeOf(row('0x1', { accountValue: 0 })), null);
  assert.equal(sizeOf(row('0x1')), null);
});

test('asset symbols reduce to the coin', () => {
  assert.equal(assetBase('xyz:NVDA'), 'NVDA');
  assert.equal(assetBase('BTC-USD'), 'BTC');
  assert.equal(assetBase('vETH'), 'ETH');
  assert.equal(assetBase('VIRTUAL'), 'VIRTUAL');
});

test('shape keeps the board place, a venue list, and orders by the chosen measure', () => {
  const byPnl = shape(board, base);
  assert.deepEqual(byPnl.map((r) => r.place), [1, 2, 3]);
  assert.deepEqual(byPnl[0]!.venues, ['hyperliquid']);
  assert.deepEqual(byPnl[2]!.venues, ['hyperliquid', 'lighter']);
  // Edge: the row without volume goes last, whatever the direction.
  assert.deepEqual(shape(board, { ...base, sort: 'edge' }).map((r) => r.address), ['0xbb', '0xaa', '0xcc']);
  assert.deepEqual(shape(board, { ...base, sort: 'accountValue' }).map((r) => r.address), ['0xcc', '0xaa', '0xbb']);
});

test('the worst hundred reads worst first on PnL and edge only', () => {
  assert.equal(dirOf('worst', 'pnl'), 'asc');
  assert.equal(dirOf('worst', 'edge'), 'asc');
  assert.equal(dirOf('worst', 'accountValue'), 'desc');
  assert.equal(dirOf('top', 'pnl'), 'desc');
  const worst = [row('0x1', { rank: 1, pnl: { '30d': -900 } }), row('0x2', { rank: 2, pnl: { '30d': -100 } })];
  assert.deepEqual(shape(worst, { ...base, side: 'worst' }).map((r) => r.address), ['0x1', '0x2']);
});

test('search, asset group and size only narrow the hundred', () => {
  assert.deepEqual(shape(board, { ...base, q: 'BB' }).map((r) => r.address), ['0xbb']);
  assert.deepEqual(shape(board, { ...base, asset: 'equities' }).map((r) => r.address), ['0xbb']);
  assert.deepEqual(shape(board, { ...base, asset: 'commodities' }).map((r) => r.address), ['0xcc']);
  assert.deepEqual(shape(board, { ...base, asset: 'majors' }).map((r) => r.address), ['0xaa']);
  assert.deepEqual(shape(board, { ...base, size: 'apex' }).map((r) => r.address), ['0xcc']);
});

test('without volume (90D, YTD) edge and volume fall back to PnL', () => {
  const noVol = [row('0x1', { pnl: { '90d': 5 } })];
  assert.equal(hasVolume(noVol, '90d'), false);
  assert.equal(hasVolume(board, '30d'), true);
  assert.equal(hasVolume(null, '90d'), true);
  assert.equal(usableSort('edge', false), 'pnl');
  assert.equal(usableSort('volume', false), 'pnl');
  assert.equal(usableSort('winRate', false), 'winRate');
  assert.equal(usableSort('edge', true), 'edge');
  assert.equal(metricOf(noVol[0]!, 'volume', '90d'), null);
});

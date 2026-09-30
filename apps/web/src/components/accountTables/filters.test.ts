import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COPY_CLORDID_PREFIX, DEFAULT_FILTER, TAB_CAPS, activeCount, applyFilter, dayEnd, dayStart, directionOfPosition,
  directionOfSide, marginOf, matches, readFilter, sliderDomain, sourceOf, timeWindow, windowKey, ymd,
  type RowFacts, type TableFilter,
} from './filters';

const NOW = Date.UTC(2026, 8, 26, 12);
const H = 3_600_000, D = 24 * H;
const f = (x: Partial<TableFilter>): TableFilter => ({ ...DEFAULT_FILTER, ...x });
const rows: RowFacts[] = [
  { symbol: 'BTC-USD', margin: 'cross', side: 'long', source: 'manual', time: NOW - H },
  { symbol: 'SOL-USD', margin: 'isolated', side: 'short', source: 'copy', time: NOW - 3 * D },
  { symbol: 'BTC-USD', margin: 'isolated', side: 'short', source: 'liquidation', time: NOW - 40 * D },
  { symbol: 'ETH-USD', margin: 'cross', side: 'long', source: 'copy', time: NOW - 100 * D },
];
const run = (tab: keyof typeof TAB_CAPS, flt: TableFilter, market: string | null = null) =>
  applyFilter(rows, (r) => r, flt, TAB_CAPS[tab], { market, now: NOW }).map((r) => rows.indexOf(r));

test('no filter shows everything', () => {
  assert.deepEqual(run('order-history', DEFAULT_FILTER), [0, 1, 2, 3]);
});

test('current market narrows to one symbol, and only where rows carry a market', () => {
  assert.deepEqual(run('trade-history', DEFAULT_FILTER, 'BTC-USD'), [0, 2]);
  assert.deepEqual(run('account-history', DEFAULT_FILTER, 'BTC-USD'), [0, 1, 2, 3]);
});

test('margin, side and source each narrow, and combine', () => {
  assert.deepEqual(run('position-history', f({ margin: 'isolated' })), [1, 2]);
  assert.deepEqual(run('position-history', f({ side: 'long' })), [0, 3]);
  assert.deepEqual(run('trade-history', f({ source: 'copy' })), [1, 3]);
  assert.deepEqual(run('trade-history', f({ source: 'manual' })), [0], 'a liquidation is not a manual order');
  assert.deepEqual(run('position-history', f({ margin: 'isolated', side: 'short' }), 'BTC-USD'), [2]);
});

test('a control that does not apply to a tab is ignored there', () => {
  // Trade history has no margin; Positions no source.
  assert.deepEqual(run('trade-history', f({ margin: 'cross' })), [0, 1, 2, 3]);
  assert.deepEqual(run('positions', f({ source: 'copy' })), [0, 1, 2, 3]);
  // Positions have no timeframe.
  assert.deepEqual(run('positions', f({ preset: '24H' })), [0, 1, 2, 3]);
});

test('timeframe presets and a custom window', () => {
  assert.deepEqual(run('order-history', f({ preset: '24H' })), [0]);
  assert.deepEqual(run('order-history', f({ preset: '7D' })), [0, 1]);
  assert.deepEqual(run('order-history', f({ preset: '90D' })), [0, 1, 2]);
  assert.deepEqual(run('order-history', f({ preset: 'custom', from: NOW - 50 * D, to: NOW - 2 * D })), [1, 2]);
  // Reversed ends are read as meant.
  assert.deepEqual(run('order-history', f({ preset: 'custom', from: NOW - 2 * D, to: NOW - 50 * D })), [1, 2]);
  // Open-ended.
  assert.deepEqual(run('order-history', f({ preset: 'custom', from: NOW - 50 * D, to: null })), [0, 1, 2]);
  // A row with no time never matches a window.
  assert.equal(matches({ time: null }, f({ preset: '7D' }), TAB_CAPS['order-history'], { market: null, now: NOW }), false);
});

test('the window key moves only when the reader moves the start', () => {
  assert.equal(windowKey(f({ preset: '30D' })), '30D');
  assert.equal(windowKey(f({ preset: 'custom', from: 5, to: 9 })), 'c:5');
  assert.equal(windowKey(f({ preset: 'custom', from: 5, to: 99 })), 'c:5');
  assert.deepEqual(timeWindow(f({ preset: '30D' }), NOW), { from: NOW - 30 * D, to: null });
});

test('the badge counts only the filters the tab offers', () => {
  const all = f({ margin: 'cross', side: 'long', source: 'copy', preset: '7D' });
  assert.equal(activeCount(all, TAB_CAPS['position-history']), 3);
  assert.equal(activeCount(all, TAB_CAPS['trade-history']), 3);
  assert.equal(activeCount(all, TAB_CAPS['account-history']), 1);
  assert.equal(activeCount(all, TAB_CAPS.balances), 0);
  assert.equal(activeCount(DEFAULT_FILTER, TAB_CAPS['order-history']), 0);
});

test('copy orders are told apart by their clOrdID prefix', () => {
  assert.equal(sourceOf(`${COPY_CLORDID_PREFIX}7hQ2mX9kLp4Rz1bT0sYd3NfW8`), 'copy');
  assert.equal(sourceOf('vs-m1a2b3-a1b2c3'), 'manual');
  assert.equal(sourceOf('ot-m1a2b3-a1b2c3'), 'manual');
  assert.equal(sourceOf('liquidation:3558819116'), 'liquidation');
  assert.equal(sourceOf(undefined), 'manual');
});

test('row facts from the venue enums', () => {
  assert.equal(marginOf('CROSS'), 'cross');
  assert.equal(marginOf(1), 'isolated');
  assert.equal(marginOf('BOTH'), null);
  assert.equal(directionOfSide('BUY'), 'long');
  assert.equal(directionOfSide(2), 'short');
  assert.equal(directionOfPosition('SHORT', '5'), 'short', 'explicit side wins over an unsigned size');
  assert.equal(directionOfPosition('BOTH', '-4.2'), 'short');
  assert.equal(directionOfPosition(1, '0'), null);
});

test('a stored filter is read defensively', () => {
  assert.deepEqual(readFilter(null), DEFAULT_FILTER);
  assert.deepEqual(readFilter({ margin: 'nope', side: 'long', preset: '7D', from: 5 }), { ...DEFAULT_FILTER, side: 'long', preset: '7D' });
  assert.deepEqual(readFilter({ preset: 'custom' }), DEFAULT_FILTER, 'a custom window with no ends is no window');
  assert.equal(readFilter({ preset: 'custom', from: 1000 }).from, 1000);
});

test('slider domain and day helpers', () => {
  assert.deepEqual(sliderDomain(NOW - 10 * D, null, NOW), [NOW - 10 * D, NOW]);
  assert.deepEqual(sliderDomain(NOW - 10 * D, NOW - 40 * D, NOW), [NOW - 40 * D, NOW]);
  assert.deepEqual(sliderDomain(null, null, NOW), [NOW - 30 * D, NOW]);
  assert.deepEqual(sliderDomain(NOW - 60_000, null, NOW), [NOW - H, NOW], 'never a zero-width track');
  const s = dayStart('2026-09-20')!;
  assert.equal(ymd(s), '2026-09-20');
  assert.equal(dayEnd('2026-09-20')! - s, D - 1);
  assert.equal(dayStart('20.9.2026'), null);
});

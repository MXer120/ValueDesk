/**
 * Pure-logic tests for the leaderboard page's URL state and formatters.
 *   npx tsx --test src/components/leaderboard/lbState.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TraderRow } from '../../vsApi';
import {
  sodexTradesNote,
  DEFAULT_VIEW,
  fmtRoi,
  lastPageOf,
  metricOf,
  parseView,
  rankMove,
  rankMoveText,
  writeView,
  type LbView,
} from './lbState';
import { setNumStyle } from '../../numStyle';
import { fmtRoi as roi } from './lbState';

test('fmtRoi in the default number format (1.234,56)', () => {
  setNumStyle('dot-comma');
  try {
    assert.equal(roi(0.1234), '+12,34%');
    assert.equal(roi(12.3456), '+1.234,56%');
    assert.equal(roi(0), '0,00%');
  } finally {
    setNumStyle('comma-dot');
  }
});

// These cases read the en-US format (1,234.56); the app's default (1.234,56) is checked separately.
setNumStyle('comma-dot');

test('parseView: empty search gives the defaults', () => {
  assert.deepEqual(parseView(''), DEFAULT_VIEW);
});

test('parseView: reads every parameter', () => {
  const v = parseView('?venues=hyperliquid&side=worst&mode=single&window=7d&sort=roi&q=%200xAbC%20&page=3&rows=100');
  assert.deepEqual(v, {
    venues: ['hyperliquid'], side: 'worst', mode: 'single', window: '7d', sort: 'roi', q: '0xAbC', page: 3, rows: 100,
  });
});

test('parseView: venues come back in display order; the older venue= still reads', () => {
  assert.deepEqual(parseView('?venues=hyperliquid,sodex').venues, ['sodex', 'hyperliquid']);
  assert.deepEqual(parseView('?venue=sodex').venues, ['sodex']);
  assert.deepEqual(parseView('?venue=all').venues, ['sodex', 'hyperliquid', 'tradexyz', 'lighter', 'arcus']);
  assert.deepEqual(parseView('?venues=binance').venues, DEFAULT_VIEW.venues);
});

test('parseView: invalid values fall back instead of throwing', () => {
  const v = parseView('?venue=binance&window=2d&sort=fees&page=-4&rows=33');
  assert.deepEqual(v, DEFAULT_VIEW);
  assert.equal(parseView('?page=abc').page, 1);
  assert.equal(parseView('?page=0').page, 1);
});

test('parseView: accountValue and venue are case-insensitive', () => {
  assert.equal(parseView('?sort=accountvalue').sort, 'accountValue');
  assert.equal(parseView('?sort=ACCOUNTVALUE').sort, 'accountValue');
  assert.deepEqual(parseView('?venue=SoDEX').venues, ['sodex']);
});

test('parseView: stored page size is the default when the URL has none', () => {
  assert.equal(parseView('', { ...DEFAULT_VIEW, rows: 25 }).rows, 25);
  assert.equal(parseView('?rows=100', { ...DEFAULT_VIEW, rows: 25 }).rows, 100);
});

test('parseView: search text is capped', () => {
  assert.equal(parseView(`?q=${'a'.repeat(200)}`).q.length, 64);
});

test('writeView: the default view writes nothing', () => {
  assert.equal(writeView('', DEFAULT_VIEW), '');
});

test('writeView: only non-defaults are written, and they round-trip', () => {
  const v: LbView = { venues: ['sodex'], side: 'worst', mode: 'single', window: 'all', sort: 'accountValue', q: 'whale', page: 2, rows: 25 };
  const s = writeView('', v);
  assert.equal(s, '?venues=sodex&side=worst&mode=single&window=all&sort=accountValue&q=whale&page=2&rows=25');
  assert.deepEqual(parseView(s), v);
});

test('writeView: keeps parameters the page does not own and replaces its own', () => {
  const s = writeView('?address=0xabc&venue=sodex&page=9', { ...DEFAULT_VIEW, sort: 'volume' });
  assert.equal(s, '?address=0xabc&sort=volume');
});

test('writeView: rows is compared against the stored default', () => {
  const stored = { ...DEFAULT_VIEW, rows: 100 };
  assert.equal(writeView('', { ...DEFAULT_VIEW, rows: 100 }, stored), '');
  assert.equal(writeView('', { ...DEFAULT_VIEW, rows: 50 }, stored), '?rows=50');
});

test('lastPageOf', () => {
  assert.equal(lastPageOf(undefined, 50), 1);
  assert.equal(lastPageOf(0, 50), 1);
  assert.equal(lastPageOf(50, 50), 1);
  assert.equal(lastPageOf(51, 50), 2);
  assert.equal(lastPageOf(134_605, 50), 2_693);
});

test('fmtRoi: fraction to signed percent with a real minus sign', () => {
  assert.equal(fmtRoi(0.1234), '+12.34%');
  assert.equal(fmtRoi(-0.05), '−5.00%');
  assert.equal(fmtRoi(12.5), '+1,250.00%');
  assert.equal(fmtRoi(0), '0.00%');
  assert.equal(fmtRoi(-0.00001), '0.00%');
  assert.equal(fmtRoi(null), '—');
  assert.equal(fmtRoi(undefined), '—');
  assert.equal(fmtRoi(Number.NaN), '—');
});

test('rankMove: up, down, flat and unknown', () => {
  assert.deepEqual(rankMove(3), { dir: 'up', n: 3 });
  assert.deepEqual(rankMove(-12), { dir: 'down', n: 12 });
  assert.equal(rankMove(0), null);
  assert.equal(rankMove(null), null);
  assert.equal(rankMove(undefined), null);
});

test('rankMoveText: "Since <time>" of the snapshot; the direction alone without one', () => {
  const fmt = (ms: number) => `T${ms}`;
  assert.deepEqual(rankMoveText({ dir: 'up', n: 3 }, 1000, fmt), { title: 'Since T1000', label: 'Up 3 places, since t1000' });
  assert.deepEqual(rankMoveText({ dir: 'down', n: 1 }, null, fmt), { title: 'Down 1 place', label: 'Down 1 place' });
  assert.deepEqual(rankMoveText({ dir: 'down', n: 2 }, undefined, fmt), { title: 'Down 2 places', label: 'Down 2 places' });
});

test('metricOf: reads the sort key for the window, null when not reported', () => {
  const row: TraderRow = {
    venue: 'sodex',
    address: '0x0000000000000000000000000000000000000001',
    accountValue: 1000,
    pnl: { '7d': 12, '30d': null },
    roi: { '7d': 0.1 },
    volume: {},
  };
  assert.equal(metricOf(row, 'pnl', '7d'), 12);
  assert.equal(metricOf(row, 'pnl', '30d'), null);
  assert.equal(metricOf(row, 'pnl', '1d'), null);
  assert.equal(metricOf(row, 'roi', '7d'), 0.1);
  assert.equal(metricOf(row, 'volume', '7d'), null);
  assert.equal(metricOf(row, 'accountValue', 'all'), 1000);
});

test('the note on SoDEX trade counts says the days in figures', () => {
  const short = sodexTradesNote({ days: 30, short: 6, unchecked: 2, lowest: { t: Date.UTC(2026, 9, 27), share: 0.07 } });
  assert.match(short, /on 6 of 30 days here we hold less than SoDEX's own count, lowest 7% on 27 Oct; 2 more are not checked yet/);
  assert.match(sodexTradesNote({ days: 1, short: 0, unchecked: 1, lowest: null }), /1 of 1 day here is not checked yet/);
});

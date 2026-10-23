/**
 * The copy score.
 * Run (from apps/web): npx tsx --test src/components/copy/copyScore.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TraderRow } from '../../vsApi';
import { LOSING_CAP, copyScore, explainScore, scoreBand, windowReturn } from './copyScore';

const row = (o: Partial<TraderRow> = {}): TraderRow => ({
  venue: 'hyperliquid', address: '0x' + '1'.repeat(40), accountValue: 1_000_000,
  pnl: { '30d': 200_000 }, roi: {}, volume: {}, winRate: 0.7, winRateExact: true, winRateCloses: 120, trades: 120, ...o,
});

test('a large, profitable, consistent trader scores high', () => {
  const s = copyScore(row({ accountValue: 20_000_000, pnl: { '30d': 5_000_000 }, winRate: 0.8, trades: 900 }), '30d');
  assert.ok(s.score >= 90, `got ${s.score}`);
  assert.equal(scoreBand(s.score), 'high');
});

test('a losing trader is capped', () => {
  const s = copyScore(row({ pnl: { '30d': -50_000 }, accountValue: 50_000_000, winRate: 0.9, trades: 5_000 }), '30d');
  assert.ok(s.score <= LOSING_CAP);
  assert.equal(s.parts.profit, 0);
  assert.equal(s.parts.roi, 0);
});

test('no PnL for the window counts as no profit, and is capped too', () => {
  const s = copyScore(row({ pnl: {} }), '30d');
  assert.ok(s.score <= LOSING_CAP);
  assert.equal(s.roi, null);
});

test('return: the venue ROI wins; otherwise PnL over the starting equity, with floors', () => {
  assert.equal(windowReturn(row({ roi: { '30d': 0.42 } }), '30d'), 0.42);
  // 200k made on 800k = 25%.
  assert.equal(windowReturn(row(), '30d'), 0.25);
  // Withdrew nearly everything: 6,360 made, 0.69 left. The $1,000 floor keeps it finite.
  assert.equal(windowReturn(row({ accountValue: 0.69, pnl: { '30d': 6_360 } }), '30d'), 6.36);
  // A quarter of today's account value is the other floor: 900k on 1M -> base 250k, not 100k.
  assert.equal(windowReturn(row({ pnl: { '30d': 900_000 } }), '30d'), 3.6);
  assert.equal(windowReturn(row({ accountValue: null }), '30d'), null);
});

test('a win rate from too few closes counts as unknown, not as the number', () => {
  const few = copyScore(row({ winRate: 1, winRateExact: false, winRateCloses: 3 }), '30d');
  assert.equal(few.parts.winRate, 0.4);
  const exact = copyScore(row({ winRate: 1, winRateExact: true, winRateCloses: 3 }), '30d');
  assert.equal(exact.parts.winRate, 1);
});

test('scores are whole numbers in 0..100 and the window matters', () => {
  const r = row({ pnl: { '30d': 200_000, '7d': -1_000 } });
  const a = copyScore(r, '30d');
  const b = copyScore(r, '7d');
  assert.ok(Number.isInteger(a.score) && a.score >= 0 && a.score <= 100);
  assert.ok(b.score <= LOSING_CAP && a.score > b.score);
});

test('the explanation names every part and says it is not a recommendation', () => {
  const t = explainScore(copyScore(row(), '30d'));
  for (const w of ['profit', 'return', 'win rate', 'account size', 'track record', 'Not a recommendation']) assert.match(t, new RegExp(w));
});

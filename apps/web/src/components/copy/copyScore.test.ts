/**
 * The copy score and the counter score.
 * Run (from apps/web): npx tsx --test src/components/copy/copyScore.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TraderRow } from '../../vsApi';
import {
  COPY_COST_BPS, WRONG_SIDE_CAP, cohortOf, copyScore, counterScore, edgeBps, explainScore, scoreBand, wilson, windowReturn,
} from './copyScore';

const row = (o: Partial<TraderRow> = {}): TraderRow => ({
  venue: 'hyperliquid', address: '0x' + '1'.repeat(40), accountValue: 1_000_000,
  pnl: { '30d': 200_000 }, roi: {}, volume: { '30d': 10_000_000 },
  winRate: 0.7, winRateExact: true, winRateCloses: 120, trades: 120, ...o,
});

test('a large trader with a real edge and a sure win rate scores high', () => {
  // 5M on 50M traded = 1,000 bps of edge; 80% of 900 closes.
  const s = copyScore(row({ accountValue: 20_000_000, pnl: { '30d': 5_000_000 }, volume: { '30d': 50_000_000 }, winRate: 0.8, trades: 900, winRateCloses: 900 }), '30d');
  assert.ok(s.score >= 85, `got ${s.score}`);
  assert.equal(scoreBand(s.score), 'high');
  assert.equal(s.edgeBps, 1_000);
});

test('a churner who makes money a copier cannot keep scores low on edge', () => {
  // 200k on 2B traded = 1 bp a dollar: below the ~12 bps a copier pays.
  const churn = copyScore(row({ volume: { '30d': 2_000_000_000 } }), '30d');
  assert.equal(churn.parts.edge, 0);
  const edge = copyScore(row(), '30d');
  assert.ok(edge.score > churn.score + 15, `${edge.score} vs ${churn.score}`);
  assert.equal(COPY_COST_BPS, 12);
});

test('the win rate counts by its interval, not its face value', () => {
  const lucky = copyScore(row({ winRate: 1, winRateExact: false, winRateCloses: 4, trades: 4 }), '30d');
  const sure = copyScore(row({ winRate: 0.8, winRateCloses: 400, trades: 400 }), '30d');
  assert.ok(sure.parts.winRate > lucky.parts.winRate, '80% of 400 beats 4 of 4');
  const w = wilson(0.5, 100);
  assert.ok(w.lo > 0.39 && w.lo < 0.41 && w.hi > 0.59 && w.hi < 0.61);
});

test('a losing trader is capped for copying, and a winning one for countering', () => {
  const loser = row({ pnl: { '30d': -300_000 }, winRate: 0.3, winRateCloses: 300, trades: 300, volume: { '30d': 6_000_000 } });
  assert.ok(copyScore(loser, '30d').score <= WRONG_SIDE_CAP);
  const counter = counterScore(loser, '30d');
  assert.ok(counter.score > 60, `a consistent loser is a counter-trade: ${counter.score}`);
  assert.equal(counter.kind, 'counter');
  assert.ok(counterScore(row(), '30d').score <= WRONG_SIDE_CAP);
});

test('a counter-trade needs the loss to beat the cost too', () => {
  // -500 bps of edge: the counter side keeps ~488 after costs. -5 bps: nothing.
  const deep = counterScore(row({ pnl: { '30d': -500_000 }, volume: { '30d': 1_000_000 } }), '30d');
  const shallow = counterScore(row({ pnl: { '30d': -500_000 }, volume: { '30d': 1_000_000_000 } }), '30d');
  assert.equal(deep.parts.edge, 1);
  assert.equal(shallow.parts.edge, 0);
});

test('percentiles spread a strong board instead of everyone reading 99', () => {
  const board = Array.from({ length: 10 }, (_, i) => row({ address: '0x' + String(i).repeat(40).slice(0, 40), pnl: { '30d': 1_000_000 * (i + 1) }, accountValue: 10_000_000, volume: { '30d': 50_000_000 } }));
  const c = cohortOf(board, '30d');
  const scores = board.map((r) => copyScore(r, '30d', c).score);
  assert.ok(scores[9]! - scores[0]! >= 15, `spread ${scores[0]}..${scores[9]}`);
  assert.ok(scores.every((s, i) => i === 0 || s >= scores[i - 1]!), 'more profit never scores lower');
});

test('return and edge helpers', () => {
  assert.equal(windowReturn(row({ roi: { '30d': 0.42 } }), '30d'), 0.42);
  assert.equal(windowReturn(row(), '30d'), 0.25);
  assert.equal(windowReturn(row({ accountValue: 0.69, pnl: { '30d': 6_360 } }), '30d'), 6.36);
  assert.equal(edgeBps(row(), '30d'), 200);
  assert.equal(edgeBps(row({ volume: {} }), '30d'), null);
});

test('scores are whole numbers in 0..100, and the explanation names every part', () => {
  const s = copyScore(row(), '30d');
  assert.ok(Number.isInteger(s.score) && s.score >= 0 && s.score <= 100);
  const t = explainScore(s);
  for (const w of ['return', 'edge', 'profit', 'win rate', 'account size', 'track record', 'Not a recommendation']) assert.match(t, new RegExp(w));
  assert.match(explainScore(counterScore(row(), '30d')), /^Counter score/);
});

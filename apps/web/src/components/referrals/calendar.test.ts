import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { InviteMe } from '@sign/invites/claim';
import { allWeeks, type S2Week } from '../sodex/soPointsV2';
import { DAY_MS, creditsLine, dayOf, levels, pointsGrid, rewardsGrid, scoredWeeks, valueAt } from './calendar';

const now = Date.UTC(2026, 10, 25, 15);
const D = dayOf(now);
const me = (over: Partial<InviteMe>): InviteMe => ({
  ok: true, joined: null, canJoin: true, welcome: null, credits: { balanceUsd: 0, earnedUsd: 0, grantedUsd: 0, spentUsd: 0, paying: false, rates: [] },
  stats: { referred: [0, 0, 0], perpsUsd: 0, spotUsd: 0, earnedUsd: 0 }, referrals: [], history: [], ...over,
});

test('the credits line: each UTC day once, never falling, ending at what was earned', () => {
  const m = me({ credits: { balanceUsd: 0, earnedUsd: 6, grantedUsd: 0, spentUsd: 1, paying: false, rates: [] }, days: [
    { day: D - 2, kind: 'earn', tier: 1, usd: 1 }, { day: D - 2, kind: 'earn', tier: 2, usd: 2 }, { day: D - 1, kind: 'spend', tier: null, usd: 1 }, { day: D, kind: 'earn', tier: 1, usd: 3 }, { day: D, kind: 'claim', tier: null, usd: 3 },
  ] });
  const l = creditsLine(m, now);
  assert.deepEqual(l.map((p) => p.v), [3, 6]);
  assert.ok(l[1]!.t <= now);
  assert.equal(valueAt(l, now - 1.6 * DAY_MS), 3);
  assert.equal(valueAt(l, 0), 0);
  assert.deepEqual(creditsLine(null, now), []);
  // An older server: its history only, and the line starts at what it does not list.
  const old = me({ credits: { balanceUsd: 0, earnedUsd: 10, grantedUsd: 0, spentUsd: 0, paying: false, rates: [] }, history: [{ at: now, kind: 'earn', usd: 4, tier: 1, from: null }] });
  assert.deepEqual(creditsLine(old, now).map((p) => p.v), [10]);
});

test('rewards by day: USDC claims, credits per tier and spending, each in its own row', () => {
  const m = me({ days: [{ day: D, kind: 'earn', tier: 1, usd: 1 }, { day: D, kind: 'earn', tier: 3, usd: 0.5 }, { day: D - 1, kind: 'spend', tier: null, usd: 2 }, { day: D - 9, kind: 'earn', tier: 1, usd: 1 }] });
  const g = rewardsGrid(m, [{ usd: 4, at: now - DAY_MS, tx: null }], now, 3, 0);
  assert.deepEqual(g.rows.map((r) => r.key), ['USDC', 'T1', 'T2', 'T3', 'Spent']);
  assert.deepEqual(g.rows.map((r) => r.cells.map((c) => c.v)), [[0, 4, 0], [0, 0, 1], [0, 0, 0], [0, 0, 0.5], [0, 2, 0]]);
  assert.deepEqual(g.cols.map((c) => c.label), ['23', '24', '25']);
  assert.equal(g.more, true);
  assert.equal(rewardsGrid(m, null, now, 3, 8).more, false, 'the oldest day is shown');
  assert.equal(rewardsGrid(m, null, now, 3, 0).rows[0]!.key, 'T1', 'no USDC row without a sign-in');
});

test('levels are within a row', () => {
  assert.deepEqual(levels([0, 1, 3, 6.1, 10]).map((c) => c.level), [0, 1, 2, 3, 4]);
  assert.deepEqual(levels([0, 0]).map((c) => c.level), [0, 0]);
});

test('SoPoints by week: only weeks SoDEX has scored; all of them and what came from invitees, nothing else', () => {
  const wk = (n: number, points: number, ref: number, status = 'CONFIRMED'): S2Week => ({
    weekNo: n, weekName: `Week ${n}`, status: 'COMPLETED', weekStartTime: 1_788_264_000 + n * 604_800, weekEndTime: 0, distributionTime: 0, isLive: false, spotVolume: 0, futuresVolume: 1000, vaultHolding: 0, wealthTvl: 0, oi: 0, accountValue: 0,
    teamWeekVolume: 0, teamWindowVolume: 0, totalBonusPct: 20, points, referralPoints: ref, pointsStatus: status, rank: 1, totalUser: 2, rankPercentile: '',
  });
  const weeks = allWeeks([], [wk(1, 120, 40), wk(2, 60, 10), wk(3, 0, 0, 'TBD')]);
  assert.equal(scoredWeeks(weeks).length, 2);
  const g = pointsGrid(weeks, 8, 0);
  assert.deepEqual(g.rows[0]!.cells.map((c) => c.v), [120, 60]);
  assert.deepEqual(g.rows.map((r) => r.key), ['all', 'ref']);
  assert.deepEqual(g.rows[1]!.cells.map((c) => c.v), [40, 10]);
  assert.equal(pointsGrid(weeks, 1, 0).more, true);
});

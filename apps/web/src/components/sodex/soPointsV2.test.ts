import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allWeeks, contentHash, difficultyRows, earnTips, nextStep, splitWeek, squadBreakdown, stepPct, type S2TeamBonus, type S2Week } from './soPointsV2';
import type { BoostConfig } from '../../points';

const CFG: BoostConfig = {
  windowRounds: 4, maxTotalBonusPct: 50, earlyBirdRounds: 4, earlyBirdBonusPct: 20,
  tiers: [{ threshold: '100000', bonusPct: 5 }, { threshold: '400000', bonusPct: 10 }, { threshold: '1500000', bonusPct: 15 }, { threshold: '5000000', bonusPct: 20 }, { threshold: '10000000', bonusPct: 25 }],
};

const week = (p: Partial<S2Week>): S2Week => ({
  weekNo: 1, weekName: 'Week 1', status: 'COMPLETED', weekStartTime: 0, weekEndTime: 0, distributionTime: 0, isLive: false,
  spotVolume: 0, futuresVolume: 0, vaultHolding: 0, wealthTvl: 0, oi: 0, accountValue: 0, teamWeekVolume: 0, teamWindowVolume: 0,
  totalBonusPct: 0, points: 0, referralPoints: 0, pointsStatus: 'CONFIRMED', rank: 0, totalUser: 0, rankPercentile: '', ...p,
});

test('squad steps follow SoDEX\'s ladder; the next step names what is missing', () => {
  assert.equal(stepPct(99_999, CFG), 0);
  assert.equal(stepPct(400_000, CFG), 10);
  assert.equal(stepPct(9_700_000, CFG), 20);
  assert.deepEqual(nextStep(9_700_000, CFG), { threshold: 10_000_000, pct: 25, missing: 300_000 });
  assert.equal(nextStep(12_000_000, CFG), null);
});

test('the wallet\'s boost: joined + built + early bird; SoDEX\'s own week total wins when there is one', () => {
  const bonus: S2TeamBonus = { eligible: true, teamMemberCount: 3, activeTeamCount: 1, isEarlyBird: true, windowRounds: 4, uplineTeamVolume: '450000', downlineTeamVolume: '120000', asOfTsMs: 0 };
  const q = squadBreakdown(bonus, CFG, null);
  assert.deepEqual([q.joined.pct, q.built.pct, q.earlyBird, q.total, q.fromSodex], [10, 5, 20, 15, false]);
  assert.equal(squadBreakdown(bonus, CFG, week({ isLive: true, totalBonusPct: 30 })).total, 30);
});

test('a week splits into trading, referrals and the squad boost (points = (own + ref) x (1 + boost))', () => {
  // 0x2085 Layer 1 week 1: 6,599 points, 2,445 referral, +40%.
  const s = splitWeek(week({ points: 6599, referralPoints: 2445, totalBonusPct: 40, futuresVolume: 2_117_018 }));
  assert.equal(Math.round(s.own), 2269);
  assert.equal(Math.round(s.boost), 1885);
  assert.equal(Math.round(s.dollarsPerPoint!), 933);
  // A referral-only week leaves no trading behind its rounding.
  assert.equal(splitWeek(week({ points: 2040, referralPoints: 1567, totalBonusPct: 30 })).own, 0);
  // An unscored week is not a zero.
  assert.equal(splitWeek(week({ pointsStatus: 'TBD', points: 0 })).dollarsPerPoint, null);
});

test('tips: the squad tip names the cheapest next step; no fitted tip is left on the page', () => {
  const bonus: S2TeamBonus = { eligible: true, teamMemberCount: 3, activeTeamCount: 1, isEarlyBird: false, windowRounds: 4, uplineTeamVolume: '0', downlineTeamVolume: '350000', asOfTsMs: 0 };
  const tips = earnTips({ weeks: [week({ points: 100 })], squad: squadBreakdown(bonus, CFG, null), cfg: CFG, weights: null, pool: 1_000_000, venue: new Map() });
  const sq = tips.find((t) => t.id === 'squad')!;
  assert.equal(sq.value, '+5%');
  assert.match(sq.line, /\$50K more volume in your squad/);
  assert.equal(tips.some((t) => (t.id as string) === 'steady'), false);
});

test('difficulty: a week SoDEX lists without volume takes the wallet\'s own history volume', () => {
  const s1 = [
    { weekName: 'Week 2', weekStartTime: 100, weekEndTime: 200, spotVolume: 0, futuresVolume: 0, vaultHolding: 0, oi: 0, accountValue: 0, points: 500, referralPoints: 0, pointsStatus: 'CONFIRMED', rank: 1, totalUser: 9 },
    { weekName: 'Week 3', weekStartTime: 200, weekEndTime: 300, spotVolume: 0, futuresVolume: 0, vaultHolding: 0, oi: 0, accountValue: 0, points: 400, referralPoints: 0, pointsStatus: 'CONFIRMED', rank: 1, totalUser: 9 },
  ];
  const rows = difficultyRows(allWeeks(s1, []), new Map(), new Map(), null, null, new Map([['s1-2', 1_000_000]]));
  assert.equal(rows[0]!.youVol, 2000);
  assert.equal(rows[1]!.youVol, null);
});

test('log: a changed answer hashes differently, the same answer the same', () => {
  const a = JSON.stringify({ w: [{ weekNo: 11, points: 0, pointsStatus: 'TBD' }] });
  const b = JSON.stringify({ w: [{ weekNo: 11, points: 812, pointsStatus: 'CONFIRMED' }] });
  assert.equal(contentHash(a), contentHash(a));
  assert.notEqual(contentHash(a), contentHash(b));
});

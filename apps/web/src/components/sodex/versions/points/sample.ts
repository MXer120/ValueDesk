/**
 * LOCALHOST ONLY (the switch's "Sample", as the Referrals page's devSample.ts): a made-up signed-in wallet, so the
 * versions can be judged filled. Every figure here is invented and never reaches a build. Its weeks sit on the real
 * season's calendar (this week's number and snapshot time from SoDEX), and it uses SoDEX's real squad steps when known.
 */
import { TIERS, type BoostConfig, type WeekInfo } from '../../../../points';
import { stepPct, type S1Week, type S2State, type S2Week } from '../../soPointsV2';

const WEEK_S = 7 * 86_400;
/* Per settled Layer 1 week: futures, spot, mean open position, Wealth, referral points, own points (made up, no model). */
const L1: ReadonlyArray<readonly [number, number, number, number, number, number]> = [
  [42_000, 0, 1_200, 0, 4, 128], [65_000, 2_000, 900, 0, 6, 160], [18_000, 0, 400, 150, 9, 74], [0, 0, 0, 150, 12, 14],
  [120_000, 5_000, 2_400, 150, 15, 205], [88_000, 0, 1_800, 300, 20, 190], [54_000, 1_000, 600, 300, 18, 98], [140_000, 0, 3_100, 300, 26, 215],
  [96_000, 4_000, 1_500, 500, 31, 126], [210_000, 0, 4_200, 500, 40, 262], [160_000, 2_500, 2_800, 500, 36, 214], [75_000, 0, 1_100, 500, 44, 120],
];
const RANKS = [9_210, 1_740, 15_800, 38_200, 1_100, 5_200, 8_900, 210, 4_700, 1_900, 3_300, 6_100];
const S1_POINTS = [8, 14, 0, 22, 35, 18, 40, 52, 0, 31];

export function samplePoints(week: WeekInfo | null, boost: BoostConfig | null, now = Date.now()): S2State {
  const liveNo = Math.max(2, week?.weekNo ?? 13);
  const liveEnd = week?.nextWeekStartTime ?? Math.floor(now / 1000) + 4 * 86_400;
  const start = (n: number) => liveEnd - (liveNo - n + 1) * WEEK_S;
  const joinedVol = 1_840_000;
  const builtVol = 462_000;
  const squad = boost ? stepPct(joinedVol, boost) + stepPct(builtVol, boost) : 25;
  const users = (n: number) => 217_000 + n * 760;
  const weeks: S2Week[] = [];
  for (let n = 1; n < liveNo; n++) {
    const [futures, spot, oi, wealth, ref, own] = L1[(n - 1) % L1.length]!;
    const bonus = squad + (n <= 4 ? 20 : 0);
    const points = Math.round((own + ref) * (1 + bonus / 100));
    weeks.push({
      weekNo: n, weekName: `Week ${n}`, status: 'COMPLETED', weekStartTime: start(n), weekEndTime: start(n) + WEEK_S, distributionTime: start(n) + WEEK_S + 3 * 86_400,
      isLive: false, spotVolume: spot, futuresVolume: futures, futuresVolumeWeightDetails: futures ? [{ marketType: 'PERP', symbol: 'NVDA-USD', coefficient: '1.2', rawVolumeU: String(futures * 0.2), weightedVolumeU: String(futures * 0.24) }] : [],
      vaultHolding: 0, wealthTvl: wealth, oi, accountValue: 2_400, teamWeekVolume: 0, teamWindowVolume: 0, totalBonusPct: bonus,
      points, referralPoints: ref, pointsStatus: 'CONFIRMED', rank: RANKS[(n - 1) % RANKS.length]!, totalUser: users(n), rankPercentile: '',
    });
  }
  weeks.push({
    weekNo: liveNo, weekName: `Week ${liveNo}`, status: 'LIVE', weekStartTime: start(liveNo), weekEndTime: liveEnd, distributionTime: liveEnd + 3 * 86_400,
    isLive: true, spotVolume: 0, futuresVolume: 58_000, vaultHolding: 0, wealthTvl: 500, oi: 900, accountValue: 2_400, teamWeekVolume: 0, teamWindowVolume: 0,
    totalBonusPct: squad, points: 0, referralPoints: 0, pointsStatus: 'TBD', rank: 0, totalUser: users(liveNo), rankPercentile: '',
  });
  const s1Start = start(1) - (S1_POINTS.length + 1) * WEEK_S;
  const s1: S1Week[] = S1_POINTS.map((p, i) => ({
    weekName: `Week ${i + 1}`, weekStartTime: s1Start + i * WEEK_S, weekEndTime: s1Start + (i + 1) * WEEK_S, spotVolume: 0, futuresVolume: p * 420, vaultHolding: 0, oi: 0,
    accountValue: 800, points: p, referralPoints: Math.round(p * 0.1), pointsStatus: 'CONFIRMED', rank: p ? 22_000 - p * 180 : 0, totalUser: 140_000,
  })).reverse();
  s1.push({ weekName: 'Closed Alpha', weekStartTime: s1Start - 120 * 86_400, weekEndTime: s1Start, spotVolume: 0, futuresVolume: 0, vaultHolding: 0, oi: 0, accountValue: 0, points: 120, referralPoints: 0, pointsStatus: 'CONFIRMED', rank: 0, totalUser: 0 });
  const total = weeks.reduce((t, w) => t + (w.pointsStatus === 'CONFIRMED' ? w.points : 0), 0) + s1.reduce((t, w) => t + w.points, 0);
  const tierIx = TIERS.reduce((ix, t, i) => (total >= t.at ? i : ix), 0);
  const next = TIERS[tierIx + 1] ?? null;
  return {
    summary: { totalPoints: total, currentTier: TIERS[tierIx]!.name, nextTier: next?.name ?? null, nextTierPoints: next?.at ?? null, rank: 4_821, totalUser: users(liveNo) },
    weeks, s1, venueOiDaily: [], mmDays: null, venueDaily: [],
    bonus: { eligible: true, teamMemberCount: 7, activeTeamCount: 3, isEarlyBird: true, windowRounds: boost?.windowRounds ?? 4, uplineTeamVolume: String(joinedVol), downlineTeamVolume: String(builtVol), asOfTsMs: now },
    loading: false, error: null,
  };
}


/** Localhost only (ReferralsPage's switch, "Sample"): made-up referrals to judge a filled page. Never in a build. */
import { sharesFor, type CreditDay, type InviteMe, type InviteReferral } from '@sign/invites/claim';
import { allWeeks, type S2Week } from '../sodex/soPointsV2';
import { usdcLine, type SodexClaim } from '../../invites/sodexRewards';
import type { SodexRewards } from '../../invites/useSodexRewards';

const D = 86_400_000;

export function sampleMe(vip: boolean, now = Date.now()): InviteMe {
  const r = (wallet: string, tier: 1 | 2 | 3, ago: number, perpsUsd: number, spotUsd: number, earnedUsd: number, welcome = false): InviteReferral =>
    ({ wallet, tier, rate: sharesFor(vip)[tier - 1]!, at: now - ago * D, perpsUsd, spotUsd, earnedUsd, welcome });
  const referrals = [
    r('0x5a1e…90c2', 1, 2, 48_200, 0, 0, true), r('0x17bb…4e0d', 1, 6, 412_000, 8_400, 1.96), r('0xc04f…71aa', 1, 11, 2_310_000, 0, 9.24),
    r('0x9d22…ab18', 1, 17, 96_500, 12_000, 0.43), r('0x3ff7…0b65', 2, 9, 780_000, 0, 1.17), r('0xe8a0…5d3c', 2, 14, 154_000, 2_000, 0.23),
    r('0x41c6…f29e', 3, 5, 1_020_000, 0, 0.4),
  ];
  const earned = referrals.reduce((x, y) => x + y.earnedUsd, 0);
  const me: InviteMe = {
    ok: true,
    joined: { inviter: '0x77d0…1c9b', code: 'SAMPLE', at: now - 20 * D },
    canJoin: false,
    welcome: { active: true, usedUsd: 36_400, leftUsd: 63_600, limitUsd: 100_000 },
    vipUntil: vip ? null : now + 4 * D,
    vip,
    vipCode: vip,
    credits: { balanceUsd: earned - 4.1, earnedUsd: earned, grantedUsd: 0, spentUsd: 4.1, paying: true, rates: sharesFor(vip) },
    stats: { referred: [4, 2, 1], perpsUsd: 4_820_700, spotUsd: 22_400, earnedUsd: earned },
    referrals,
    // Every credit of the rows above, so the earnings line starts at zero.
    history: [
      ...[[16, 0.31, 1, '0x9d22…ab18'], [14, 0.12, 1, '0x9d22…ab18'], [12, 0.23, 2, '0xe8a0…5d3c'], [10, 1.84, 1, '0xc04f…71aa'], [9, 2.1, 1, '0xc04f…71aa'], [8, 0.4, 2, '0x3ff7…0b65'], [7, 1.3, 1, '0xc04f…71aa'], [5, 0.62, 1, '0x17bb…4e0d'],
        [4, 0.4, 3, '0x41c6…f29e'], [4, 0.77, 2, '0x3ff7…0b65'], [3, 2.6, 1, '0xc04f…71aa'], [2, 0.94, 1, '0x17bb…4e0d'], [1, 0.4, 1, '0x17bb…4e0d'], [0.5, 1.4, 1, '0xc04f…71aa']]
        .map(([ago, usd, tier, from]) => ({ at: now - Number(ago) * D, kind: 'earn' as const, usd: Number(usd), tier: Number(tier), from: String(from) })),
      { at: now - 1.2 * D, kind: 'spend' as const, usd: 1.7, tier: null, from: null }, { at: now - 4.4 * D, kind: 'spend' as const, usd: 2.4, tier: null, from: null },
    ].sort((a, b) => b.at - a.at),
  };
  me.days = me.history.map((h): CreditDay => ({ day: Math.floor(h.at / D), kind: h.kind as CreditDay['kind'], tier: h.tier, usd: h.usd }));
  me.invites = { week: 2, max: 3, resetsAt: now + 3 * D };
  return me;
}

/** SoDEX's side of the sample. */
export function sampleSodex(now = Date.now()): SodexRewards {
  const claims: SodexClaim[] = [{ usd: 3.18, at: now - 12 * D, tx: null }, { usd: 5.44, at: now - 5 * D, tx: null }];
  const wk = (n: number, points: number, ref: number, status = 'CONFIRMED'): S2Week => ({
    weekNo: n, weekName: `Week ${n}`, status: 'COMPLETED', weekStartTime: Math.floor(Date.UTC(2026, 8, 1, 12) / 1000) + (n - 1) * 604_800, weekEndTime: 0, distributionTime: 0, isLive: false, spotVolume: 0, futuresVolume: 90_000, vaultHolding: 0, wealthTvl: 0, oi: 0, accountValue: 0,
    teamWeekVolume: 0, teamWindowVolume: 0, totalBonusPct: 20, points, referralPoints: ref, pointsStatus: status, rank: 4821, totalUser: 226_000, rankPercentile: '',
  });
  return {
    signedIn: true, loading: false, error: null, claimedUsd: 8.62, claimableUsd: 4.2, earnedUsd: 14.3, claims,
    stats: { settledUsd: 12.82, pendingUsd: 1.48, totalUsd: 14.3, unlocked: true, volumeUsd: 48_000, volumeNeededUsd: 2_000, traders: 5, weekInvites: 2, weekInvitesMax: 100, nextAt: null, code: 'SAMPLE', canModify: true, referredBy: null },
    traders: [
      { wallet: '0xc04f00000000000000000000000000000000071aa'.slice(0, 38) + '71aa', volumeUsd: 2_310_000, rebateUsd: 7.9, points: 640, at: now - 11 * D },
      { wallet: '0x17bb0000000000000000000000000000000000'.slice(0, 38) + '4e0d', volumeUsd: 420_400, rebateUsd: 4.1, points: 210, at: now - 6 * D },
      { wallet: '0x66aa0000000000000000000000000000000000'.slice(0, 38) + '10f3', volumeUsd: 88_000, rebateUsd: 2.3, points: 96, at: now - 30 * D },
    ],
    line: usdcLine(claims, [{ t: now - 8 * D, usd: 6.1 }, { t: now - 2 * D, usd: 12.9 }], 14.3, now),
    summary: null, weeks: allWeeks([], [wk(1, 96, 10), wk(2, 142, 22), wk(3, 120, 30), wk(4, 210, 64), wk(5, 188, 70), wk(6, 260, 82), wk(7, 170, 66), wk(8, 310, 120), wk(9, 290, 96), wk(10, 402, 150), wk(11, 366, 144), wk(12, 0, 0, 'TBD')]),
    signingIn: false, signInError: null, signIn: () => {}, refresh: () => {},
  };
}

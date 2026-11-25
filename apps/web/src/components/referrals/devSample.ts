/** Localhost only (ReferralsPage's switch, "Sample"): made-up referrals to judge a filled page. Never in a build. */
import { sharesFor, type InviteMe, type InviteReferral } from '@sign/invites/claim';

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
  return {
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
}

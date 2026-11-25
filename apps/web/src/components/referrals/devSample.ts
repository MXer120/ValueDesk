/** Localhost only (ReferralsPage's switch, "Sample"): made-up referrals to judge a filled page. Never in a build. */
import type { InviteMe, InviteReferral } from '@sign/invites/claim';

const D = 86_400_000;

export function sampleMe(now = Date.now()): InviteMe {
  const r = (wallet: string, tier: 1 | 2 | 3, ago: number, perpsUsd: number, spotUsd: number, earnedUsd: number, welcome = false): InviteReferral =>
    ({ wallet, tier, rate: [0.2, 0.075, 0.02][tier - 1]!, at: now - ago * D, perpsUsd, spotUsd, earnedUsd, welcome });
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
    vipUntil: now + 4 * D,
    vipCode: true,
    credits: { balanceUsd: earned - 4.1, earnedUsd: earned, grantedUsd: 0, spentUsd: 4.1, paying: true, rates: [0.2, 0.075, 0.02] },
    stats: { referred: [4, 2, 1], perpsUsd: 4_820_700, spotUsd: 22_400, earnedUsd: earned },
    referrals,
    history: [
      { at: now - D, kind: 'earn', usd: 0.42, tier: 1, from: '0xc04f…71aa' }, { at: now - D, kind: 'spend', usd: 0.31, tier: null, from: null },
      { at: now - 2 * D, kind: 'earn', usd: 0.09, tier: 2, from: '0x3ff7…0b65' }, { at: now - 3 * D, kind: 'earn', usd: 0.0214, tier: 3, from: '0x41c6…f29e' },
      { at: now - 4 * D, kind: 'spend', usd: 1.2, tier: null, from: null },
    ],
  };
}

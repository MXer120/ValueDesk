/**
 * Referrals: the wallet's link (its own SoDEX referral code, so every wallet with a SoDEX account has one at once), what
 * it earns three tiers deep, its referrals, and its fee credits with their history. Credits pay the wallet's own
 * ValueDesk fees by themselves: there is nothing to claim. The page itself: GiftPage.tsx.
 *
 * On localhost a pill fills the page with made-up data, as a VIP too (devSample.ts); a build has neither.
 */
import { useEffect, useMemo, useState } from 'react';
import { track } from '../../analytics/usage';
import { isVipMe, useInviteMeState } from '../../invites/invites';
import type { RefView } from './parts';
import { sampleMe } from './devSample';
import { GiftPage } from './GiftPage';
import '../bots/kit/kit.css';
import '../bots/botsPages.css';
import '../vip.css';
import './referrals.css';

const DEV = import.meta.env.DEV;
const KEY = 'vs.dev.referrals.sample';
const SEEN = (a: string) => `vd.credits.seen.${a.toLowerCase()}`;
type Sample = 'off' | 'on' | 'vip';
const SAMPLES: ReadonlyArray<[Sample, string]> = [['off', 'My wallet'], ['on', 'Sample'], ['vip', 'Sample VIP']];

function stored(): Sample {
  if (!DEV) return 'off';
  try {
    const s = localStorage.getItem(KEY);
    return s === 'on' || s === 'vip' ? s : 'off';
  } catch {
    return 'off';
  }
}

export function ReferralsPage({ address }: { address: string | null }) {
  const [pick, setPick] = useState(stored);
  const real = useInviteMeState(address);
  const sample = DEV && pick !== 'off';
  const demo = useMemo(() => (sample ? sampleMe(pick === 'vip') : null), [sample, pick]);
  const { me, error, loading, absent } = demo ? { me: demo, error: false, loading: false, absent: false } : real;
  // New credit since this wallet last looked: counted once (analytics, after consent only).
  const earned = real.me?.credits.earnedUsd ?? null;
  useEffect(() => {
    if (earned === null || !address) return;
    try {
      const was = Number(localStorage.getItem(SEEN(address)) ?? '0');
      if (earned > was + 1e-9) {
        track('credits.earn', {});
        localStorage.setItem(SEEN(address), String(earned));
      }
    } catch { /* private mode */ }
  }, [address, earned]);
  const view: RefView = { address, me, loading, error, absent, sample };
  return (
    <div className={isVipMe(me) ? 'tf bots-page rf-page is-vip' : 'tf bots-page rf-page'}>
      <div className="bots-col"><GiftPage v={view} /></div>
      {DEV && (
        <nav className="rf-switch" aria-label="Sample data" data-no-i18n="">
          {SAMPLES.map(([k, t]) => <button key={k} type="button" aria-pressed={pick === k} className={pick === k ? 'is-on' : ''} onClick={() => { setPick(k); try { localStorage.setItem(KEY, k); } catch { /* this tab only */ } }}>{t}</button>)}
        </nav>
      )}
    </div>
  );
}

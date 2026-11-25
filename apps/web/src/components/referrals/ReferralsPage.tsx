/**
 * Referrals: the wallet's link (its own SoDEX referral code, so every wallet with a SoDEX account has one at once), what
 * it earns three tiers deep, its referrals, and its fee credits with their history. Credits pay the wallet's own
 * ValueDesk fees by themselves: there is nothing to claim.
 *
 * Redesigned 2026-11-25 on the home page's look, in five versions (versions.tsx) while the owner picks one: on
 * localhost a pill switches between them (and fills the page with sample data); a build shows the first.
 */
import { useEffect, useMemo, useState } from 'react';
import { track } from '../../analytics/usage';
import { useInviteMeState } from '../../invites/invites';
import { HowItWorks, type RefView } from './parts';
import { sampleMe } from './devSample';
import { V1Card, V2Orbit, V3Steps, V4Gift, V5Tiers } from './versions';
import '../bots/kit/kit.css';
import '../bots/botsPages.css';
import '../vip.css';
import './referrals.css';

const VERSIONS = [
  { name: 'Card', C: V1Card },
  { name: 'Orbit', C: V2Orbit },
  { name: 'Steps', C: V3Steps },
  { name: 'Gift', C: V4Gift },
  { name: 'Tiers', C: V5Tiers },
] as const;
const DEV = import.meta.env.DEV;
const KEY = 'vs.dev.referrals';
const SEEN = (a: string) => `vd.credits.seen.${a.toLowerCase()}`;

interface Pick { v: number; sample: boolean }
function stored(): Pick {
  if (DEV) {
    try {
      const p = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Pick> | null;
      if (p) return { v: VERSIONS[Number(p.v)] ? Number(p.v) : 0, sample: p.sample === true };
    } catch { /* private mode */ }
  }
  return { v: 0, sample: false };
}

export function ReferralsPage({ address }: { address: string | null }) {
  const [pick, setPick] = useState(stored);
  const [how, setHow] = useState(false);
  const real = useInviteMeState(address);
  const sample = DEV && pick.sample;
  const demo = useMemo(() => (sample ? sampleMe() : null), [sample]);
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
  const choose = (p: Pick) => {
    setPick(p);
    try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* for this tab only */ }
  };
  const view: RefView = { address, me, loading, error, absent, sample, how: () => setHow(true) };
  const V = VERSIONS[pick.v]!.C;
  return (
    <div className="tf bots-page rf-page">
      <div className="bots-col" key={pick.v}><V v={view} /></div>
      {how && <HowItWorks onClose={() => setHow(false)} />}
      {DEV && (
        <nav className="rf-switch" aria-label="Referral page versions" data-no-i18n="">
          {VERSIONS.map((x, i) => <button key={x.name} type="button" aria-pressed={pick.v === i} className={pick.v === i ? 'is-on' : ''} onClick={() => choose({ ...pick, v: i })}><b>{i + 1}</b><span>{x.name}</span></button>)}
          <button type="button" aria-pressed={sample} className={sample ? 'is-sample is-on' : 'is-sample'} onClick={() => choose({ ...pick, sample: !sample })}>{sample ? 'Sample data' : 'Sample'}</button>
        </nav>
      )}
    </div>
  );
}

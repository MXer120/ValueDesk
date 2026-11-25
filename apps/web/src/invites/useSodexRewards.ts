/**
 * A wallet's SoDEX referral rewards on the Referrals page: signed in with the same token as the SoPoints page, read, read
 * again after a claim or when the tab comes back. What was claimed is on chain and shows without a sign-in.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { signInToPoints } from '../pointsAuth';
import { NeedsPointsToken, getPointsToken, setPointsToken } from '../points';
import { SODEX_POINTS_SIGNIN_LIVE } from '../sodexProgrammes';
import { allWeeks, fetchS1Weeks, fetchS2Summary, fetchS2Weeks, logWeeks, type AnyWeek, type S2Summary } from '../components/sodex/soPointsV2';
import { WalletError, type Eip1193Provider } from '../wallet';
import { claimableOf, fetchClaimed, fetchClaims, fetchStats, fetchTraders, noteSeen, readSeen, settledPoint, usdcLine, type LinePoint, type SodexClaim, type SodexStats, type SodexTrader } from './sodexRewards';

export interface SodexRewards {
  /** Signed in with this wallet. */
  signedIn: boolean;
  loading: boolean;
  error: string | null;
  stats: SodexStats | null;
  /** On chain, whoever is signed in. Null: not read. */
  claimedUsd: number | null;
  claimableUsd: number | null;
  /** Everything earned: claimed, claimable and pending. Null without a sign-in. */
  earnedUsd: number | null;
  claims: SodexClaim[] | null;
  traders: SodexTrader[] | null;
  line: LinePoint[];
  summary: S2Summary | null;
  weeks: AnyWeek[] | null;
  signingIn: boolean;
  signInError: string | null;
  signIn: () => void;
  refresh: () => void;
}

interface Data { for: string | null; loading: boolean; error: string | null; stats: SodexStats | null; claims: SodexClaim[] | null; traders: SodexTrader[] | null; summary: S2Summary | null; weeks: AnyWeek[] | null; line: LinePoint[] }
const NONE: Data = { for: null, loading: false, error: null, stats: null, claims: null, traders: null, summary: null, weeks: null, line: [] };

export function useSodexRewards(address: string | null, provider: Eip1193Provider | null): SodexRewards {
  const a = address?.toLowerCase() ?? null;
  const [tick, setTick] = useState(0);
  const [signedIn, setSignedIn] = useState(() => !!a && !!getPointsToken(a));
  const [claimed, setClaimed] = useState<{ for: string | null; usd: number | null }>({ for: null, usd: null });
  const [data, setData] = useState<Data>(NONE);
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    setSignedIn(!!a && !!getPointsToken(a));
    setSignInError(null);
  }, [a]);

  // The chain's word on what was claimed: for everyone.
  useEffect(() => {
    if (!a) return;
    let off = false;
    void fetchClaimed(a).then((usd) => { if (!off) setClaimed((c) => (usd === null && c.for === a ? c : { for: a, usd })); });
    return () => { off = true; };
  }, [a, tick]);

  useEffect(() => {
    if (!a || !signedIn) { setData(NONE); return; }
    let off = false;
    setData((d) => (d.for === a ? { ...d, loading: true, error: null } : { ...NONE, for: a, loading: true }));
    void Promise.allSettled([fetchStats(a), fetchClaims(a), fetchTraders(a), fetchS2Summary(a), fetchS2Weeks(a), fetchS1Weeks(a), fetchClaimed(a)]).then(([st, cl, tr, su, w2, w1, cm]) => {
      if (off) return;
      const all = [st, cl, tr, su, w2, w1];
      if (all.some((r) => r.status === 'rejected' && r.reason instanceof NeedsPointsToken)) { setSignedIn(false); return; }
      const failed = all.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
      const stats = st.status === 'fulfilled' ? st.value : null;
      const claims = cl.status === 'fulfilled' ? cl.value : null;
      const now = Date.now();
      const total = stats ? stats.settledUsd + stats.pendingUsd : null;
      const seen = total !== null ? noteSeen(a, total, now) : readSeen(a);
      const paid = cm.status === 'fulfilled' ? cm.value : null;
      if (paid !== null) setClaimed({ for: a, usd: paid });
      setData((d) => ({
        for: a, loading: false, error: failed ? (failed.reason instanceof Error ? failed.reason.message : String(failed.reason)) : null,
        // A read that failed keeps what was read before: a figure never vanishes for a dropped request.
        stats: stats ?? (d.for === a ? d.stats : null),
        claims: claims ?? (d.for === a ? d.claims : null),
        traders: tr.status === 'fulfilled' ? tr.value : d.for === a ? d.traders : null,
        summary: su.status === 'fulfilled' ? su.value : d.for === a ? d.summary : null,
        weeks: w2.status === 'fulfilled' || w1.status === 'fulfilled' ? allWeeks(w1.status === 'fulfilled' ? w1.value : [], w2.status === 'fulfilled' ? w2.value : []) : d.for === a ? d.weeks : null,
        line: total !== null ? usdcLine(claims ?? [], seen, total, now, stats && settledPoint(stats.settledUsd, now)) : d.for === a ? d.line : [],
      }));
      logWeeks(a, { summary: su.status === 'fulfilled' ? su.value : null, bonus: null, layer1: w2.status === 'fulfilled' ? w2.value : [], season1: w1.status === 'fulfilled' ? w1.value : [] });
    });
    return () => { off = true; };
  }, [a, signedIn, tick]);

  // Back on the tab (a claim on SoDEX, a trade in between): read again, at most every minute. Signed in elsewhere too.
  const last = useRef(0);
  useEffect(() => {
    last.current = Date.now();
    const back = () => {
      if (document.visibilityState !== 'visible') return;
      setSignedIn(!!a && !!getPointsToken(a));
      if (Date.now() - last.current > 60_000) { last.current = Date.now(); setTick((n) => n + 1); }
    };
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
  }, [a]);

  const signIn = useCallback(() => {
    if (!SODEX_POINTS_SIGNIN_LIVE || !a || !provider) return;
    setSigningIn(true);
    setSignInError(null);
    signInToPoints(provider, a).then(
      (token) => { setPointsToken(a, token); if (alive.current) { setSignedIn(!!getPointsToken(a)); setTick((n) => n + 1); } },
      (e: unknown) => {
        const m = e instanceof Error ? e.message : String(e);
        // A rejected signature is someone changing their mind, not a fault.
        if (alive.current && !(e instanceof WalletError && /reject|denied|cancel/i.test(m))) setSignInError(m);
      },
    ).finally(() => { if (alive.current) setSigningIn(false); });
  }, [a, provider]);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  const mine = data.for === a ? data : NONE;
  const claimedUsd = claimed.for === a ? claimed.usd : null;
  return {
    signedIn, loading: mine.loading, error: mine.error, stats: mine.stats, claimedUsd,
    claimableUsd: mine.stats ? claimableOf(mine.stats.settledUsd, claimedUsd) : null,
    earnedUsd: mine.stats ? mine.stats.settledUsd + mine.stats.pendingUsd : null,
    claims: mine.claims, traders: mine.traders, line: mine.line, summary: mine.summary, weeks: mine.weeks,
    signingIn, signInError, signIn, refresh,
  };
}

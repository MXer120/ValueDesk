/**
 * ValueDesk's SoDEX referral code, for wallets that can still use one (owner, 2026-11-05).
 *
 * WHAT SoDEX DOES, read out of its bundle: `GET alpha-biz/biz/referral/checkEligibility` says, without
 * any login, who a wallet's inviter is and who a code belongs to. Binding is
 * `POST biz/referral/v3/join` with a SoDEX identity token, and that token only comes from
 * `sodex.com/auth/v2`, which answers SoDEX's own origins only. Getting past that needs a forged
 * Origin, which SoDEX's terms forbid (s. 5.6; the same reason the SoPoints sign-in is off,
 * apps/server/src/index.ts). So the wallet confirms on SoDEX's own page, /join/VALUEDESK, and this
 * module reads the outcome. Should SoDEX allowlist this site's origin, the same steps can run here
 * with one wallet signature and no new tab.
 *
 * A wallet that joins before it has an exchange account comes back as `needSignature`: SoDEX finishes
 * that with its next visit to sodex.com, after the first deposit. That is the 'pending' state.
 */
import { useEffect, useSyncExternalStore } from 'react';

export const REFERRAL_CODE = 'VALUEDESK';
/** SoDEX's join page for a code (a referral link's code, or ours). */
export const referralUrl = (code: string): string => `https://sodex.com/join/${encodeURIComponent(code)}`;
export const REFERRAL_URL = referralUrl(REFERRAL_CODE);

const BIZ = 'https://alpha-biz.sodex.dev';
const TIMEOUT_MS = 10_000;

interface Eligibility {
  needSignature?: boolean;
  inviterWalletAddress?: string;
}

/**
 *   none      no inviter yet: the code can be applied
 *   pending   joined with ours; SoDEX still wants its signature, on sodex.com
 *   bound     joined with ours
 *   other     already has another inviter: nothing to offer
 *   self      the wallet behind the code
 *   unknown   SoDEX did not answer, or the code is not live: nothing to offer, asked again later
 */
export type ReferralState = 'none' | 'pending' | 'bound' | 'other' | 'self' | 'unknown';

export function referralState(address: string, own: Eligibility | null, ours: Eligibility | null): ReferralState {
  const inviter = ours?.inviterWalletAddress?.toLowerCase();
  if (!own || !inviter) return 'unknown';
  const wallet = address.toLowerCase();
  if (wallet === inviter) return 'self';
  const mine = own.inviterWalletAddress?.toLowerCase();
  if (!mine) return 'none';
  if (mine !== inviter) return 'other';
  return own.needSignature ? 'pending' : 'bound';
}

async function eligibility(query: string): Promise<Eligibility | null> {
  try {
    const r = await fetch(`${BIZ}/biz/referral/checkEligibility?${query}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const j = (await r.json()) as { code?: number; data?: Eligibility };
    return j.code === 0 && j.data ? j.data : null;
  } catch {
    return null;
  }
}

const states = new Map<string, ReferralState>();
const listeners = new Set<() => void>();

const keyOf = (wallet: string, code: string) => (code === REFERRAL_CODE ? wallet : `${wallet}|${code}`);

/**
 * Ask SoDEX again (when the tab comes back from its join page). `code`: the code the wallet is offered - ours, or the
 * code of the referral link it came with ('bound' then means bound to that one).
 */
export async function loadReferral(address: string, code: string = REFERRAL_CODE): Promise<ReferralState> {
  const wallet = address.toLowerCase();
  const [own, theirs] = await Promise.all([
    eligibility(`walletAddress=${wallet}`),
    eligibility(`walletAddress=${wallet}&referralCode=${encodeURIComponent(code)}`),
  ]);
  const s = referralState(wallet, own, theirs);
  const k = keyOf(wallet, code);
  if (states.get(k) !== s) {
    states.set(k, s);
    for (const l of [...listeners]) l();
  }
  return s;
}

/** The wallet's state; `unknown` until SoDEX has answered. Read again whenever the tab comes back. */
/** What is known already, asking SoDEX nothing: for a badge beside the one useReferral that does. */
export function useReferralKnown(address: string | null, code: string = REFERRAL_CODE): ReferralState {
  const wallet = address?.toLowerCase() ?? '';
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => (wallet ? states.get(keyOf(wallet, code)) ?? 'unknown' : 'unknown'),
    () => 'unknown' as ReferralState,
  );
}

export function useReferral(address: string | null, code: string = REFERRAL_CODE): ReferralState {
  const wallet = address?.toLowerCase() ?? '';
  const s = useReferralKnown(address, code);
  useEffect(() => {
    if (!wallet) return;
    void loadReferral(wallet, code);
    const back = () => { if (document.visibilityState === 'visible') void loadReferral(wallet, code); };
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
  }, [wallet, code]);
  return s;
}

/**
 * The weekly claim (owner 2026-11-25): USDC from SoDEX and ValueDesk fee credits, in one field and one popup, by the same
 * rules (owner: "make it just like sodex"): what was earned until a Tuesday 12:00 UTC is claimable from then, from $1.00 on,
 * once a week, and what is not claimed stays claimable.
 *
 *   USDC     SoDEX's own claim (sodexRewards.ts claimRebates): it pays the signed-in wallet
 *   credits  one free signature (invites.ts claimCredits)
 *
 * The two are independent: one failing never holds back the other, and each says its own outcome.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { claimWindow, type InviteMe } from '@sign/invites/claim';
import { track } from '../../analytics/usage';
import { InviteError, claimCredits, loadMe } from '../../invites/invites';
import { MIN_CLAIM_USD, claimRebates, floorCents } from '../../invites/sodexRewards';
import type { SodexRewards } from '../../invites/useSodexRewards';
import { NeedsPointsToken } from '../../points';
import type { Eip1193Provider } from '../../wallet';
import { DASH, fmtUsd } from '../../format';
import { BrandMark } from '../BrandMark';
import { DlgFoot } from '../dialogParts';
import { Modal } from '../Modal';
import { usd2, type RefView } from './parts';

const when = (t: number, o: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' }) => new Date(t).toLocaleDateString('en-US', { timeZone: 'UTC', ...o });
/** "6d 3h", "3h 12m", "8m". */
export function left(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m % 60}m` : `${m % 60}m`;
}
function useNow(ms: number): number {
  const [now, set] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => set(Date.now()), ms); return () => window.clearInterval(t); }, [ms]);
  return now;
}

/** What each side holds now. */
export interface ClaimState {
  opensAt: number; closesAt: number;
  credits: { state: 'none' | 'open' | 'small' | 'claimed' | 'auto' | 'unknown'; usd: number; pendingUsd: number };
  usdc: { state: 'signin' | 'reading' | 'locked' | 'none' | 'small' | 'open'; usd: number; pendingUsd: number; needUsd: number; volumeUsd: number };
  /** Something can be claimed now. */
  any: boolean;
}

export function claimState(me: InviteMe | null, s: SodexRewards, now: number): ClaimState {
  const w = claimWindow(now);
  const c = me?.claims;
  // A page left open over a Tuesday: the server's week is the last one until it is read again.
  const cur = c && c.week === w.week ? c : null;
  const min = cur?.minUsd ?? MIN_CLAIM_USD;
  const credits: ClaimState['credits'] = !me ? { state: 'unknown', usd: 0, pendingUsd: 0 }
    : !c ? { state: 'auto', usd: me.credits.balanceUsd, pendingUsd: 0 }
    : !cur ? { state: 'unknown', usd: 0, pendingUsd: 0 }
    : { state: cur.claimed ? 'claimed' : cur.usd >= min ? 'open' : cur.usd > 0 ? 'small' : 'none', usd: cur.usd, pendingUsd: cur.pendingUsd };
  const st = s.stats;
  const can = s.claimableUsd;
  const usdc: ClaimState['usdc'] = {
    state: !s.signedIn ? 'signin' : !st || can === null ? 'reading' : !st.unlocked && can < MIN_CLAIM_USD ? 'locked' : can >= MIN_CLAIM_USD ? 'open' : can > 0 ? 'small' : 'none',
    usd: can ?? 0, pendingUsd: st?.pendingUsd ?? 0, needUsd: st?.volumeNeededUsd ?? 0, volumeUsd: st?.volumeUsd ?? 0,
  };
  return { opensAt: w.opensAt, closesAt: w.closesAt, credits, usdc, any: credits.state === 'open' || usdc.state === 'open' };
}

const usdcText = (n: number) => usd2(floorCents(n));

/** One side of the claim field: its mark, its amount, one line. */
function Side({ mark, name, value, line, on }: { mark: ReactNode; name: string; value: ReactNode; line: ReactNode; on?: boolean }) {
  return (
    <div className={on ? 'rf-claim__s is-on' : 'rf-claim__s'}>
      <span className="rf-claim__m" aria-hidden="true">{mark}</span>
      <div><span>{name}</span><b>{value}</b><small>{line}</small></div>
    </div>
  );
}
const SodexMark = ({ size = 20 }: { size?: number }) => <img src="/logos/brand/sodex.svg" width={size} height={size} alt="" />;

export function ClaimField({ v, s, provider }: { v: RefView; s: SodexRewards; provider: Eip1193Provider | null }) {
  const now = useNow(30_000);
  const [open, setOpen] = useState(false);
  const c = claimState(v.me, s, now);
  // A page left open over a Tuesday 12:00 UTC: the week it was read in is not the open one any more. Read again, once a minute.
  const stale = !v.sample && !!v.address && !!v.me?.claims && v.me.claims.week !== claimWindow(now).week;
  const minute = Math.floor(now / 60_000);
  useEffect(() => { if (stale && v.address) void loadMe(v.address); }, [stale, stale ? minute : 0, v.address]);
  const usdcLine = !v.address && !v.sample ? 'From SoDEX' : c.usdc.state === 'signin' ? 'Sign in to SoDEX to see it' : c.usdc.state === 'reading' ? 'Reading SoDEX…'
    : c.usdc.state === 'locked' ? `Unlocks at ${fmtUsd(c.usdc.needUsd, 0)} SoDEX volume` : c.usdc.state === 'small' ? `SoDEX pays out from ${usd2(MIN_CLAIM_USD)}`
    : c.usdc.pendingUsd > 0 ? `${usd2(c.usdc.pendingUsd)} pending` : c.usdc.state === 'open' ? 'Ready to claim' : 'Nothing yet';
  const creditLine = c.credits.state === 'auto' ? 'Pays your fees by itself' : c.credits.state === 'claimed' ? `Claimed this week · ${usd2(c.credits.pendingUsd + c.credits.usd)} next`
    : c.credits.state === 'unknown' ? 'From ValueDesk' : c.credits.state === 'small' ? `Claimable from ${usd2(MIN_CLAIM_USD)}` : c.credits.pendingUsd > 0 ? `${usd2(c.credits.pendingUsd)} pending` : c.credits.state === 'open' ? 'Ready to claim' : 'Nothing yet';
  const label = !v.address && !v.sample ? 'Connect a wallet' : c.usdc.state === 'signin' && c.credits.state !== 'open' ? 'See my rewards' : 'Claim';
  return (
    <section className="rf-claim" aria-label="Weekly claim">
      <div className="rf-claim__t">
        <h3>Weekly claim</h3>
        <p><i className={c.any ? 'is-open' : undefined} aria-hidden="true" />{when(c.opensAt)} to {when(c.closesAt)}, 12:00 UTC</p>
        <small>Next one opens in {left(c.closesAt - now)}</small>
      </div>
      <Side mark={<SodexMark />} name="USDC" on={c.usdc.state === 'open'} value={c.usdc.state === 'signin' || c.usdc.state === 'reading' ? DASH : usdcText(c.usdc.usd)} line={usdcLine} />
      <Side mark={<BrandMark size={22} />} name="Fee credits" on={c.credits.state === 'open'} value={c.credits.state === 'unknown' ? DASH : usd2(c.credits.state === 'claimed' ? 0 : c.credits.usd)} line={creditLine} />
      <button type="button" className={`rf-cta${c.any ? ' is-green' : ''}`} disabled={!v.address && !v.sample} onClick={() => setOpen(true)}>{label}</button>
      {open && <ClaimDialog v={v} s={s} provider={provider} onClose={() => setOpen(false)} />}
    </section>
  );
}

/* --------------------------------------------------------------------------------------- the popup ----- */

type Step = { state: 'idle' | 'busy' | 'done' | 'error'; text?: string; tx?: string | null; usd?: number };
const IDLE: Step = { state: 'idle' };
const TX = 'https://main-scan.valuechain.xyz/tx/';

export function ClaimDialog({ v, s, provider, onClose }: { v: RefView; s: SodexRewards; provider: Eip1193Provider | null; onClose: () => void }) {
  const now = useNow(30_000);
  const c = claimState(v.me, s, now);
  const [usdc, setUsdc] = useState<Step>(IDLE);
  const [cred, setCred] = useState<Step>(IDLE);
  const busy = usdc.state === 'busy' || cred.state === 'busy';
  const canUsdc = c.usdc.state === 'open' && usdc.state !== 'done' && usdc.state !== 'busy';
  const canCred = c.credits.state === 'open' && cred.state !== 'done' && cred.state !== 'busy';
  const week = claimWindow(now).week;

  const takeCredits = async () => {
    if (!v.address || !provider) return;
    setCred({ state: 'busy', text: 'Check your wallet…' });
    try {
      const usd = v.sample ? c.credits.usd : await claimCredits(provider, v.address, week);
      setCred({ state: 'done', usd });
      track('rewards.claim', {});
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setCred(/reject|denied|cancel/i.test(m) && !(e instanceof InviteError) ? IDLE : { state: 'error', text: m });
    }
  };
  const takeUsdc = async () => {
    if (!v.address) return;
    setUsdc({ state: 'busy', text: 'SoDEX is paying…' });
    try {
      const r = await claimRebates(v.address.toLowerCase());
      setUsdc({ state: 'done', usd: r.usd, tx: r.tx });
      track('rewards.claim', {});
    } catch (e) {
      setUsdc({ state: 'error', text: e instanceof NeedsPointsToken ? 'Sign in to SoDEX again.' : e instanceof Error ? e.message : String(e) });
    }
    s.refresh();
  };
  const sampleDone = async () => {
    setUsdc({ state: 'busy', text: 'Sample…' });
    await new Promise((r) => setTimeout(r, 700));
    setUsdc({ state: 'done', usd: c.usdc.usd, tx: null });
    setCred({ state: 'busy', text: 'Sample…' });
    await new Promise((r) => setTimeout(r, 700));
    setCred({ state: 'done', usd: c.credits.usd });
  };
  const all = async () => {
    if (v.sample) { await sampleDone(); return; }
    // The credits first: their signature is the one thing that needs the wallet.
    if (canCred) await takeCredits();
    if (canUsdc) await takeUsdc();
  };
  const finished = !canUsdc && !canCred && !busy && (usdc.state === 'done' || cred.state === 'done');
  const n = (canUsdc ? 1 : 0) + (canCred ? 1 : 0);

  return (
    <Modal open size="sm" title={finished ? 'Claimed' : 'Weekly claim'} className="dlg rf-claimdlg" onClose={() => { if (!busy) onClose(); }} dismissOnBackdrop={!busy}>
      <div className="rf-claimdlg__top" aria-hidden="true"><span className="is-usdc"><SodexMark size={30} /></span><span className="is-credit"><BrandMark size={32} /></span></div>
      <p className="rf-claimdlg__when">Earned until {when(c.opensAt, { month: 'short', day: 'numeric' })}<small>Next claim {when(c.closesAt)}, 12:00 UTC · in {left(c.closesAt - now)}</small></p>
      <ul className="rf-claimdlg__rows">
        <Row
          mark={<SodexMark size={22} />} name="USDC" note="From SoDEX, to your wallet" step={usdc}
          value={usdc.state === 'done' ? `+${usdcText(usdc.usd ?? 0)}` : c.usdc.state === 'signin' || c.usdc.state === 'reading' ? DASH : usdcText(c.usdc.usd)}
          line={usdc.state === 'done' ? (usdc.tx ? <a href={`${TX}${usdc.tx}`} target="_blank" rel="noopener noreferrer">See the transaction</a> : 'Paid to your wallet') : c.usdc.state === 'locked' ? <>Unlocks at {fmtUsd(c.usdc.needUsd, 0)} SoDEX volume: you have {fmtUsd(c.usdc.volumeUsd, 0)}</>
            : c.usdc.state === 'small' ? <>SoDEX pays out from {usd2(MIN_CLAIM_USD)}. It stays yours until then</> : c.usdc.pendingUsd > 0 ? <>{usd2(c.usdc.pendingUsd)} more is pending at SoDEX</> : c.usdc.state === 'none' ? 'Nothing to claim' : c.usdc.state === 'open' ? 'No signature needed' : null}
          action={c.usdc.state === 'signin' && n > 0 ? <button type="button" className="dlg-btn" disabled={s.signingIn || !provider} onClick={s.signIn}>{s.signingIn ? 'Check wallet…' : 'Sign in'}</button> : null}
        />
        <Row
          mark={<BrandMark size={24} />} name="Fee credits" note="Pay your ValueDesk fees" step={cred}
          value={cred.state === 'done' ? `+${usd2(cred.usd ?? 0)}` : c.credits.state === 'unknown' ? DASH : usd2(c.credits.state === 'claimed' ? 0 : c.credits.usd)}
          line={cred.state === 'done' || c.credits.state === 'claimed' ? <>Claimed this week. The next claim opens {when(c.closesAt)}</> : c.credits.state === 'auto' ? 'They pay your fees by themselves'
            : c.credits.state === 'small' ? <>Claimable from {usd2(MIN_CLAIM_USD)}. They stay yours until then</>
            : c.credits.state === 'none' ? (c.credits.pendingUsd > 0 ? <>{usd2(c.credits.pendingUsd)} opens on {when(c.closesAt)}</> : 'Nothing to claim') : c.credits.state === 'open' ? 'One free signature. What you leave stays yours' : null}
        />
      </ul>
      {s.signInError && <p className="ref-offer__note" role="alert">{s.signInError}</p>}
      {s.error && s.signedIn && <p className="ref-offer__note" role="alert">Some of SoDEX's figures could not be read. <button type="button" className="rf-text" onClick={s.refresh}>Try again</button></p>}
      <DlgFoot left={<button type="button" className="dlg-btn" disabled={busy} onClick={onClose}>{finished ? 'Close' : 'Not now'}</button>}>
        {finished ? <span className="rf-claimdlg__ok">Next claim {when(c.closesAt)}</span>
          : n === 0 && c.usdc.state === 'signin' ? <button type="button" className="dlg-btn is-go" disabled={s.signingIn || !provider} onClick={s.signIn}>{s.signingIn ? 'Check wallet…' : 'Sign in to SoDEX'}</button>
          : <button type="button" className="dlg-btn is-go" disabled={busy || n === 0} onClick={() => void all()}>{busy ? 'Claiming…' : n === 0 ? 'Nothing to claim' : canUsdc && canCred ? 'Claim both' : canUsdc ? `Claim ${usdcText(c.usdc.usd)} USDC` : `Claim ${usd2(c.credits.usd)}`}</button>}
      </DlgFoot>
    </Modal>
  );
}

function Row({ mark, name, note, value, line, action, step }: { mark: ReactNode; name: string; note: string; value: string; line: ReactNode; action?: ReactNode; step: Step }) {
  return (
    <li className={`is-${step.state}`}>
      <span className="rf-claim__m" aria-hidden="true">{mark}</span>
      <div><b>{name}</b><small>{step.state === 'busy' ? step.text : step.state === 'error' ? <span className="neg" role="alert">{step.text}</span> : line ?? note}</small></div>
      {action ?? <em>{step.state === 'busy' ? <span className="tf-spin" /> : step.state === 'done' ? <><Check />{value}</> : value}</em>}
    </li>
  );
}
const Check = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" /></svg>
);

/**
 * The weekly claim (owner 2026-11-25): SoDEX's USDC rebates, claimable every Tuesday 12:00 UTC from $1.00 on, claimed with
 * SoDEX's own call (sodexRewards.ts claimRebates), which pays the signed-in wallet; what is not claimed stays claimable.
 * ValueDesk's fee credits stand beside them for what they are: they need no claim and pay the wallet's fees as they come
 * (owner 2026-11-26, "make all pay like now").
 */
import { useEffect, useState, type ReactNode } from 'react';
import { claimWindow, type InviteMe } from '@sign/invites/claim';
import { track } from '../../analytics/usage';
import { MIN_CLAIM_USD, claimRebates, floorCents } from '../../invites/sodexRewards';
import type { SodexRewards } from '../../invites/useSodexRewards';
import { NeedsPointsToken } from '../../points';
import type { Eip1193Provider } from '../../wallet';
import { DASH, fmtUsd } from '../../format';
import { localize } from '../../numStyle';
import { BrandMark } from '../BrandMark';
import { DlgFoot } from '../dialogParts';
import { Modal } from '../Modal';
import { usd2, type RefView } from './parts';

const when = (t: number, o: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' }) => new Date(t).toLocaleDateString('en-US', { timeZone: 'UTC', ...o });
const two = (n: number) => String(n).padStart(2, '0');
/** A live countdown: "5d 12h 03m 41s", "3h 12m 05s", "8m 30s". */
export function left(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${two(h)}h ${two(m)}m ${two(s % 60)}s` : h > 0 ? `${h}h ${two(m)}m ${two(s % 60)}s` : `${m}m ${two(s % 60)}s`;
}
function useNow(ms: number): number {
  const [now, set] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => set(Date.now()), ms); return () => window.clearInterval(t); }, [ms]);
  return now;
}

/** What each side holds now. */
export interface ClaimState {
  opensAt: number; closesAt: number;
  /** Fee credits: what is left to pay fees with (they need no claim). */
  credits: { known: boolean; usd: number };
  usdc: { state: 'signin' | 'reading' | 'locked' | 'none' | 'small' | 'open'; usd: number; pendingUsd: number; needUsd: number; volumeUsd: number };
}

export function claimState(me: InviteMe | null, s: SodexRewards, now: number): ClaimState {
  const w = claimWindow(now);
  const st = s.stats;
  const can = s.claimableUsd;
  const usdc: ClaimState['usdc'] = {
    state: !s.signedIn ? 'signin' : !st || can === null ? 'reading' : !st.unlocked && can < MIN_CLAIM_USD ? 'locked' : can >= MIN_CLAIM_USD ? 'open' : can > 0 ? 'small' : 'none',
    usd: can ?? 0, pendingUsd: st?.pendingUsd ?? 0, needUsd: st?.volumeNeededUsd ?? 0, volumeUsd: st?.volumeUsd ?? 0,
  };
  return { opensAt: w.opensAt, closesAt: w.closesAt, credits: { known: !!me, usd: me?.credits.balanceUsd ?? 0 }, usdc };
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

/** The time to the next claim, by the second. */
function Countdown({ to, now }: { to: number; now: number }) {
  return <time className="rf-count" dateTime={new Date(to).toISOString()} title={`${when(to)}, 12:00 UTC`}>{localize(left(to - now))}</time>;
}

export function ClaimField({ v, s, provider }: { v: RefView; s: SodexRewards; provider: Eip1193Provider | null }) {
  const now = useNow(1000);
  const [open, setOpen] = useState(false);
  const c = claimState(v.me, s, now);
  const ready = c.usdc.state === 'open';
  const usdcLine = !v.address && !v.sample ? 'From SoDEX' : c.usdc.state === 'signin' ? 'Sign in to SoDEX to see it' : c.usdc.state === 'reading' ? 'Reading SoDEX…'
    : c.usdc.state === 'locked' ? `Unlocks at ${fmtUsd(c.usdc.needUsd, 0)} SoDEX volume` : c.usdc.state === 'small' ? `SoDEX pays out from ${usd2(MIN_CLAIM_USD)}`
    : c.usdc.pendingUsd > 0 ? `${usd2(c.usdc.pendingUsd)} pending` : ready ? 'Ready to claim' : 'Nothing yet';
  const label = !v.address && !v.sample ? 'Connect a wallet' : c.usdc.state === 'signin' ? 'See my rewards' : 'Claim';
  return (
    <section className="rf-claim" aria-label="Weekly claim">
      <div className="rf-claim__t">
        <h3>Weekly claim</h3>
        <p><i className={ready ? 'is-open' : undefined} aria-hidden="true" />Next in <Countdown to={c.closesAt} now={now} /></p>
      </div>
      <Side mark={<SodexMark />} name="USDC" on={ready} value={c.usdc.state === 'signin' || c.usdc.state === 'reading' ? DASH : usdcText(c.usdc.usd)} line={usdcLine} />
      <Side mark={<BrandMark size={22} />} name="Fee credits" value={c.credits.known ? usd2(c.credits.usd) : DASH} line={c.credits.known ? 'Pay your fees by themselves' : 'From ValueDesk'} />
      <button type="button" className={`rf-cta${ready ? ' is-green' : ''}`} disabled={!v.address && !v.sample} onClick={() => setOpen(true)}>{label}</button>
      {open && <ClaimDialog v={v} s={s} provider={provider} onClose={() => setOpen(false)} />}
    </section>
  );
}

/* --------------------------------------------------------------------------------------- the popup ----- */

type Step = { state: 'idle' | 'busy' | 'done' | 'error'; text?: string; tx?: string | null; usd?: number };
const IDLE: Step = { state: 'idle' };
const TX = 'https://main-scan.valuechain.xyz/tx/';

export function ClaimDialog({ v, s, provider, onClose }: { v: RefView; s: SodexRewards; provider: Eip1193Provider | null; onClose: () => void }) {
  const now = useNow(1000);
  const c = claimState(v.me, s, now);
  const [usdc, setUsdc] = useState<Step>(IDLE);
  const busy = usdc.state === 'busy';
  const can = c.usdc.state === 'open' && usdc.state !== 'done' && !busy;

  const take = async () => {
    if (!v.address) return;
    // What SoDEX pays is what was claimable: shown when the chain's own amount cannot be read.
    const expected = floorCents(c.usdc.usd);
    setUsdc({ state: 'busy', text: 'SoDEX is paying…' });
    try {
      if (v.sample) {
        await new Promise((r) => setTimeout(r, 700));
        setUsdc({ state: 'done', usd: expected, tx: null });
        return;
      }
      const r = await claimRebates(v.address.toLowerCase());
      setUsdc({ state: 'done', usd: r.usd ?? expected, tx: r.tx });
      track('rewards.claim', {});
    } catch (e) {
      setUsdc({ state: 'error', text: e instanceof NeedsPointsToken ? 'Sign in to SoDEX again.' : e instanceof Error ? e.message : String(e) });
    }
    if (!v.sample) s.refresh();
  };
  const finished = usdc.state === 'done';

  return (
    <Modal open size="sm" title={finished ? 'Claimed' : 'Weekly claim'} className="dlg rf-claimdlg" onClose={() => { if (!busy) onClose(); }} dismissOnBackdrop={!busy}>
      <div className="rf-claimdlg__top" aria-hidden="true"><span className="is-usdc"><SodexMark size={30} /></span><span className="is-credit"><BrandMark size={32} /></span></div>
      <p className="rf-claimdlg__when">Next claim in <Countdown to={c.closesAt} now={now} /><small>Every Tuesday, 12:00 UTC</small></p>
      <ul className="rf-claimdlg__rows">
        <Row
          mark={<SodexMark size={22} />} name="USDC" note="From SoDEX, to your wallet" step={usdc}
          value={finished ? `+${usd2(usdc.usd ?? 0)}` : c.usdc.state === 'signin' || c.usdc.state === 'reading' ? DASH : usdcText(c.usdc.usd)}
          line={finished ? (usdc.tx ? <a href={`${TX}${usdc.tx}`} target="_blank" rel="noopener noreferrer">See the transaction</a> : 'Paid to your wallet') : c.usdc.state === 'locked' ? <>Unlocks at {fmtUsd(c.usdc.needUsd, 0)} SoDEX volume: you have {fmtUsd(c.usdc.volumeUsd, 0)}</>
            : c.usdc.state === 'small' ? <>SoDEX pays out from {usd2(MIN_CLAIM_USD)}. It stays yours until then</> : c.usdc.pendingUsd > 0 ? <>{usd2(c.usdc.pendingUsd)} more is pending at SoDEX</> : c.usdc.state === 'none' ? 'Nothing to claim' : c.usdc.state === 'open' ? 'No signature needed' : null}
        />
        <Row mark={<BrandMark size={24} />} name="Fee credits" note="They pay your ValueDesk fees by themselves" step={IDLE} value={c.credits.known ? usd2(c.credits.usd) : DASH} line="They pay your ValueDesk fees by themselves, no claim" />
      </ul>
      {s.signInError && <p className="ref-offer__note" role="alert">{s.signInError}</p>}
      {s.error && s.signedIn && <p className="ref-offer__note" role="alert">Some of SoDEX's figures could not be read. <button type="button" className="rf-text" onClick={s.refresh}>Try again</button></p>}
      <DlgFoot left={<button type="button" className="dlg-btn" disabled={busy} onClick={onClose}>{finished ? 'Close' : 'Not now'}</button>}>
        {finished ? <span className="rf-claimdlg__ok">Next claim {when(c.closesAt)}</span>
          : c.usdc.state === 'signin' ? <button type="button" className="dlg-btn is-go" disabled={s.signingIn || !provider} onClick={s.signIn}>{s.signingIn ? 'Check wallet…' : 'Sign in to SoDEX'}</button>
          : <button type="button" className="dlg-btn is-go" disabled={busy || !can} onClick={() => void take()}>{busy ? 'Claiming…' : can ? `Claim ${usdcText(c.usdc.usd)} USDC` : 'Nothing to claim'}</button>}
      </DlgFoot>
    </Modal>
  );
}

function Row({ mark, name, note, value, line, step }: { mark: ReactNode; name: string; note: string; value: string; line: ReactNode; step: Step }) {
  return (
    <li className={`is-${step.state}`}>
      <span className="rf-claim__m" aria-hidden="true">{mark}</span>
      <div><b>{name}</b><small>{step.state === 'busy' ? step.text : step.state === 'error' ? <span className="neg" role="alert">{step.text}</span> : line ?? note}</small></div>
      <em>{step.state === 'busy' ? <span className="tf-spin" /> : step.state === 'done' ? <><Check />{value}</> : value}</em>
    </li>
  );
}
const Check = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" /></svg>
);

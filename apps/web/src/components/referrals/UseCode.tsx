/**
 * Use a code (owner 2026-11-25): for a wallet SoDEX says has no referrer. The field starts with ValueDesk's own code - or the
 * code of the link the wallet came with, which is never overridden - and takes any other. What the code gives and what its
 * owner gets is said before anything is signed; only then the steps: one free signature to join on ValueDesk (a person's code;
 * ValueDesk's own refers nobody here), and the code on SoDEX, confirmed on sodex.com.
 */
import { useEffect, useState } from 'react';
import { CODE_RE, OURS_CODE, REFERRED_START_USD, TIER_SHARES, VIP_CODE_DAYS, VIP_TIER_SHARES, normCode, type InviteMe } from '@sign/invites/claim';
import { track } from '../../analytics/usage';
import { InviteError, checkCode, dropInvite, joinInvite, loadMe, pendingInvite, useSodexCode, type CodeCheck } from '../../invites/invites';
import { loadReferral, referralUrl, useReferral } from '../../onboarding/referral';
import { markOffered } from '../../onboarding/referralRules';
import { notify } from '../../toast';
import type { Eip1193Provider } from '../../wallet';
import { DlgFoot } from '../dialogParts';
import { Modal } from '../Modal';
import { pct, welcomeText } from './parts';
import '../../onboarding/onboarding.css';

/** The button: only for a connected wallet that SoDEX itself says has no referrer. */
export function UseCodeButton({ address, provider, me }: { address: string | null; provider: Eip1193Provider | null; me: InviteMe | null }) {
  const sc = useSodexCode(address);
  const state = useReferral(address, sc.code);
  const [open, setOpen] = useState(false);
  // While the dialog is open it stays, whatever the state becomes: it says so itself.
  if (!address || !provider || (!open && (state !== 'none' || !sc.ready))) return null;
  return (
    <>
      <button type="button" className="rf-howbtn is-code" onClick={() => setOpen(true)}>Use a code</button>
      {open && <UseCodeDialog address={address} provider={provider} me={me} initial={sc.code} locked={me?.joined?.code ?? null} onClose={() => setOpen(false)} />}
    </>
  );
}

type Checked = { code: string; state: 'asking' } | { code: string; state: 'ok'; check: CodeCheck | null } | { code: string; state: 'bad' | 'silent' | 'own' };

export function UseCodeDialog({ address, provider, me, initial, locked, onClose }: {
  address: string; provider: Eip1193Provider; me: InviteMe | null; initial: string;
  /** The code this wallet joined ValueDesk with: SoDEX gets the same. */
  locked: string | null;
  onClose: () => void;
}) {
  const [text, setText] = useState(locked ?? initial);
  const code = normCode(text);
  const ours = code === OURS_CODE;
  const shaped = CODE_RE.test(code);
  const [checked, setChecked] = useState<Checked>({ code: '', state: 'asking' });
  const [joined, setJoined] = useState(!!locked);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  useEffect(() => markOffered(address), [address]);

  // Whose code it is, asked a moment after the typing stops: SoDEX for ValueDesk's own, the server (which asks SoDEX) for any other.
  useEffect(() => {
    if (!shaped) return;
    let off = false;
    setChecked({ code, state: 'asking' });
    const t = window.setTimeout(() => {
      void (async (): Promise<Checked> => {
        const s = await loadReferral(address, code);
        if (s === 'self') return { code, state: 'own' };
        if (ours) return s === 'unknown' ? { code, state: 'silent' } : { code, state: 'ok', check: null };
        const c = await checkCode(code);
        return c.state === 'ok' ? { code, state: 'ok', check: c } : { code, state: c.state };
      })().then((r) => { if (!off) setChecked(r); });
    }, 350);
    return () => { off = true; window.clearTimeout(t); };
  }, [address, code, shaped, ours]);

  const cur: Checked | null = shaped && checked.code === code ? checked : null;
  const ok = cur?.state === 'ok' ? cur : null;
  const sodex = useReferral(address, shaped ? code : OURS_CODE);
  const applied = sodex === 'bound' || sodex === 'pending';
  /** A person's code is joined on ValueDesk too, while this wallet still may. */
  const canJoin = !!ok && !ours && (joined || me?.canJoin === true);
  const done = applied && (!canJoin || joined);

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await joinInvite(provider, address, code);
      track('invite.bind', {});
      setJoined(true);
      notify('ok', r.vipUntil ? `Joined. You pay the VIP fee for ${VIP_CODE_DAYS} days.` : r.welcome ? `Joined. No ValueDesk fee on your first ${welcomeText()}.` : 'Joined.');
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (!/reject|denied|cancel/i.test(m)) setError(e instanceof InviteError ? m : `Could not join: ${m}`);
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    if (applied && pendingInvite()?.code === code) dropInvite();
    if (joined) void loadMe(address);
    onClose();
  };

  return (
    <Modal open size="sm" title={done ? 'Code applied' : 'Use a code'} className="dlg ref-offer inv-dlg rf-usecode" onClose={close}>
      <label className="rf-usecode__field">
        <span className="inv-code__k">Referral code</span>
        <input
          value={text} onChange={(e) => { setText(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20)); setError(null); setOpened(false); }}
          disabled={!!locked || joined || applied} spellCheck={false} autoCapitalize="characters" autoComplete="off" aria-label="Referral code" aria-invalid={cur?.state === 'bad' || cur?.state === 'own'}
        />
        <i className={ok ? 'is-ok' : cur && cur.state !== 'asking' ? 'is-bad' : undefined} aria-live="polite">
          {!text ? '' : !shaped ? '4 to 20 letters and numbers' : !cur || cur.state === 'asking' ? 'Checking…' : cur.state === 'ok' ? (ours ? "ValueDesk's code" : 'Valid') : cur.state === 'own' ? 'Your own code' : cur.state === 'silent' ? 'SoDEX did not answer' : 'SoDEX has no such code'}
        </i>
      </label>
      {ok && (
        <>
          <ul className="inv-perks">
            {canJoin && ok.check?.welcome !== false && <li><b>$0</b><span>ValueDesk fee on your first {welcomeText()}</span></li>}
            {canJoin && <li><b>${REFERRED_START_USD / 1000}K</b><span>fee tier from your first trade</span></li>}
            {canJoin && (ok.check?.vipDays ?? 0) > 0 && <li><b className="vip-text">VIP</b><span>fee for {ok.check!.vipDays} days</span></li>}
            <li><b>+5%</b><span>SoPoints on SoDEX <a href="https://docs.sodex.com/sopoints/layer-1-season" target="_blank" rel="noopener noreferrer">source</a></span></li>
          </ul>
          <p className="inv-they">
            {ours ? "ValueDesk gets SoDEX's 10% fee rebate and 25% of your SoPoints on top, paid by SoDEX. Your SoDEX fees stay the same."
              : `${canJoin ? `Your inviter gets ${pct(TIER_SHARES[0])} (${pct(VIP_TIER_SHARES[0])} as a VIP) of the ValueDesk fees you pay, as fee credits, and ` : 'Your inviter gets '}SoDEX's 10% fee rebate and 25% of your SoPoints on top. Your SoDEX fees stay the same.`}
            {!ours && !canJoin && me?.blocked === 'has-volume' && ' This wallet has traded on ValueDesk already, so the code counts on SoDEX only.'}
            {!ours && !canJoin && me?.blocked === 'has-referrals' && ' Others joined with your code already, so this one counts on SoDEX only.'}
          </p>
          <ol className="inv-steps">
            {canJoin && (
              <li className={joined ? 'is-done' : ''}>
                <i aria-hidden="true">{joined ? <Check /> : 1}</i>
                <div><b>Join on ValueDesk</b><small>One signature. Free, never a transaction.</small></div>
                {joined ? <span className="inv-pill is-on">Joined</span> : <button type="button" className="dlg-btn is-go" disabled={busy} onClick={() => void join()}>{busy ? 'Check wallet…' : 'Sign'}</button>}
              </li>
            )}
            <li className={applied ? 'is-done' : sodex === 'none' ? '' : 'is-off'}>
              <i aria-hidden="true">{applied ? <Check /> : canJoin ? 2 : 1}</i>
              <div><b>Apply {code} on SoDEX</b><small>{applied ? (sodex === 'pending' ? 'SoDEX finishes it after your first deposit.' : 'Applied.') : sodex === 'none' ? 'Confirm with your wallet on sodex.com.' : sodex === 'other' ? 'Your wallet has another SoDEX referrer.' : 'Checking with SoDEX…'}</small></div>
              {applied ? <span className="inv-pill is-on">Applied</span>
                : sodex === 'none' ? <a className={`dlg-btn ref-offer__go${canJoin && !joined ? '' : ' is-go'}`} href={referralUrl(code)} target="_blank" rel="noopener noreferrer" onClick={() => setOpened(true)}>{opened ? 'Open again' : 'Apply'}</a> : null}
            </li>
          </ol>
        </>
      )}
      {error && <p className="ref-offer__note" role="alert">{error}</p>}
      <DlgFoot>
        <button type="button" className={`dlg-btn${done ? ' is-go' : ''}`} onClick={close}>{done ? 'Done' : 'Close'}</button>
      </DlgFoot>
    </Modal>
  );
}

const Check = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" /></svg>
);

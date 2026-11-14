/**
 * A visitor who came on a referral link (invites.ts captureInvite), now with a wallet connected and the site's terms
 * accepted: two steps with the same code (owner 2026-11-14: "they get their valuedesk code applied + the underlying
 * sodex code") -
 *
 *   1  join on ValueDesk   one free signature: the inviter's fee credits, the wallet's welcome
 *   2  the code on SoDEX   offered only when SoDEX says the wallet has no referrer yet; confirmed on sodex.com
 *
 * Shown while the server says the wallet may still join (step 1), or after it joined while step 2 is still open. What
 * the wallet gets and what its inviter gets is said in a line each.
 */
import { useEffect, useState } from 'react';
import { TIER_SHARES, WELCOME_USD } from '@sign/invites/claim';
import { Modal } from '../components/Modal';
import { DlgFoot } from '../components/dialogParts';
import { StatusPill } from '../components/bots/kit/kit';
import { browseAccepted, useAcceptanceRevision } from '../legal/acceptance';
import { track } from '../analytics/usage';
import { notify } from '../toast';
import type { Eip1193Provider } from '../wallet';
import { referralUrl, useReferral } from '../onboarding/referral';
import { InviteError, dropInvite, joinInvite, loadMe, pendingInvite, useInviteRevision, type Pending } from './invites';
import '../onboarding/onboarding.css';

const SETTLE_MS = 2_500;
const usd = (n: number) => `$${n.toLocaleString('en-US')}`;

export function InviteHost({ address, provider, hold }: { address: string | null; provider: Eip1193Provider | null; hold: boolean }) {
  useAcceptanceRevision();
  useInviteRevision();
  const [open, setOpen] = useState<{ pending: Pending; joined: boolean } | null>(null);
  const [later, setLater] = useState(false);
  const terms = !!browseAccepted();
  const kept = pendingInvite();
  useEffect(() => {
    if (!kept || !address || !provider || !terms || hold || later || open) return;
    let dead = false;
    const t = window.setTimeout(() => {
      void loadMe(address).then((me) => {
        if (dead || !me) return;
        const joinedThis = me.joined?.code === kept.code;
        if (!me.canJoin && !joinedThis) { dropInvite(); return; }
        if (document.querySelector('[role="dialog"]')) return; // another dialog's turn; asked again on the next change
        setOpen({ pending: kept, joined: joinedThis });
      });
    }, SETTLE_MS);
    return () => { dead = true; window.clearTimeout(t); };
  }, [address, provider, terms, hold, later, open, kept?.code]);

  if (!open || !address || !provider) return null;
  const close = (done: boolean) => { if (done) dropInvite(); else setLater(true); setOpen(null); };
  return <InviteDialog pending={open.pending} joined={open.joined} address={address} provider={provider} onClose={close} />;
}

function InviteDialog({ pending, joined: joinedAt, address, provider, onClose }: {
  pending: Pending; joined: boolean; address: string; provider: Eip1193Provider; onClose: (done: boolean) => void;
}) {
  const { code } = pending;
  const [joined, setJoined] = useState(joinedAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const sodex = useReferral(address, code);
  const sodexDone = sodex === 'bound' || sodex === 'pending';
  const sodexOpen = sodex === 'none';
  const allDone = joined && !sodexOpen;

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await joinInvite(provider, address, code);
      track('invite.bind', {});
      setJoined(true);
      notify('ok', r.welcome ? `Joined. No ValueDesk fee on your first ${usd(WELCOME_USD)} of volume.` : 'Joined.');
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (e instanceof InviteError && e.code && e.code !== 'sodex-silent') { notify('warn', m); onClose(true); }
      else if (!/reject|denied|cancel/i.test(m)) setError(m);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open size="sm" title="You were invited" className="dlg ref-offer inv-dlg" onClose={() => onClose(allDone)}>
      <div className="inv-code">
        <span className="inv-code__k">Referral code</span>
        <b>{code}</b>
      </div>
      <ul className="inv-perks">
        {pending.welcome && <li><b>$0</b><span>ValueDesk fee on your first {usd(WELCOME_USD)}</span></li>}
        <li><b>+5%</b><span>SoPoints with this code on SoDEX <a href="https://docs.sodex.com/sopoints/layer-1-season" target="_blank" rel="noopener noreferrer">source</a></span></li>
      </ul>
      <p className="inv-they">Your inviter gets {Math.round(TIER_SHARES[0] * 100)}% of the ValueDesk fees you pay, as fee credits, and SoDEX's referral rebate. Nothing comes out of your trades.</p>
      <ol className="inv-steps">
        <li className={joined ? 'is-done' : ''}>
          <i aria-hidden="true">{joined ? <Check /> : 1}</i>
          <div><b>Join on ValueDesk</b><small>One signature. Free, never a transaction.</small></div>
          {joined ? <StatusPill size="sm" tone="positive" dot>Joined</StatusPill> : (
            <button type="button" className="dlg-btn is-go" disabled={busy} onClick={() => void join()}>{busy ? 'Check wallet…' : 'Sign'}</button>
          )}
        </li>
        <li className={sodexDone ? 'is-done' : sodexOpen ? '' : 'is-off'}>
          <i aria-hidden="true">{sodexDone ? <Check /> : 2}</i>
          <div><b>Apply {code} on SoDEX</b><small>{sodexOpen ? 'Confirm with your wallet on sodex.com.' : sodex === 'other' || sodex === 'self' ? 'Your wallet has a SoDEX referrer already.' : sodex === 'pending' ? 'SoDEX finishes it after your first deposit.' : sodexDone ? 'Applied.' : 'Checking with SoDEX…'}</small></div>
          {sodexDone ? <StatusPill size="sm" tone="positive" dot>Applied</StatusPill>
            : sodexOpen ? <a className="dlg-btn ref-offer__go" href={referralUrl(code)} target="_blank" rel="noopener noreferrer" onClick={() => setOpened(true)}>{opened ? 'Open again' : 'Apply'}</a>
            : sodex === 'unknown' ? null : <StatusPill size="sm" tone="neutral">Skipped</StatusPill>}
        </li>
      </ol>
      {error && <p className="ref-offer__note" role="alert">{error}</p>}
      <DlgFoot left={allDone ? undefined : <button type="button" className="dlg-btn" onClick={() => onClose(false)}>Not now</button>}>
        <button type="button" className={`dlg-btn${allDone ? ' is-go' : ''}`} disabled={!joined} onClick={() => onClose(true)}>Done</button>
      </DlgFoot>
    </Modal>
  );
}

const Check = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" /></svg>
);

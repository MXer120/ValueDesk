/**
 * A visitor who came on an invite link (invites.ts captureInvite), now with a wallet connected and the site's terms
 * accepted: offered to join, with what it gets and what its inviter gets said plainly. One free signature. Shown only
 * while the server says this wallet may still join (no ValueDesk volume, never joined); otherwise the kept invite is
 * let go without a word.
 */
import { useEffect, useState } from 'react';
import { CREDIT_MONTHS, CREDIT_SHARE, WELCOME_USD } from '@sign/invites/claim';
import { Modal } from '../components/Modal';
import { DlgFoot } from '../components/dialogParts';
import { browseAccepted, useAcceptanceRevision } from '../legal/acceptance';
import { track } from '../analytics/usage';
import { notify } from '../toast';
import type { Eip1193Provider } from '../wallet';
import { InviteError, dropInvite, joinInvite, loadMe, pendingInvite } from './invites';
import '../onboarding/onboarding.css';

const SETTLE_MS = 2_500;

export function InviteHost({ address, provider, hold }: { address: string | null; provider: Eip1193Provider | null; hold: boolean }) {
  useAcceptanceRevision();
  const [code, setCode] = useState<string | null>(null);
  const [later, setLater] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const terms = !!browseAccepted();
  useEffect(() => {
    const kept = pendingInvite();
    if (!kept || !address || !provider || !terms || hold || later) { setCode(null); return; }
    let dead = false;
    const t = window.setTimeout(() => {
      void loadMe(address).then((me) => {
        if (dead || !me) return;
        if (!me.canJoin) { dropInvite(); return; }
        if (document.querySelector('[role="dialog"]')) return; // another dialog's turn; asked again on the next change
        setCode(kept);
      });
    }, SETTLE_MS);
    return () => { dead = true; window.clearTimeout(t); };
  }, [address, provider, terms, hold, later]);

  if (!code || !address || !provider) return null;
  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      await joinInvite(provider, address, code);
      track('invite.bind', {});
      notify('ok', `Joined. Your builder fee is 0.1 bp on your first $${WELCOME_USD.toLocaleString('en-US')} of volume.`);
      setCode(null);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (e instanceof InviteError && e.code) { dropInvite(); setCode(null); notify('warn', m); }
      else if (!/reject|denied|cancel/i.test(m)) setError(m);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open size="sm" title="You were invited to ValueDesk" className="dlg ref-offer" onClose={() => setLater(true)}>
      <div className="onb-code"><i aria-hidden="true" /><b>{code.toUpperCase()}</b></div>
      <div className="ref-offer__cols is-one">
        <section className="ref-offer__list">
          <div className="dlg-label"><span>What you get</span></div>
          <ul>
            <li><b>0.1 bp builder fee</b><small>ValueDesk's fee on your first ${WELCOME_USD.toLocaleString('en-US')} of volume, on every product (it is 1.5 bp on futures without it). SoDEX's own fees do not change.</small></li>
          </ul>
        </section>
        <section className="ref-offer__list">
          <div className="dlg-label"><span>What the person who invited you gets</span></div>
          <ul>
            <li><b>Fee credits</b><small>{Math.round(CREDIT_SHARE * 100)}% of the ValueDesk fees you pay, for {CREDIT_MONTHS} months, as credits for their own ValueDesk fees. Paid by ValueDesk, never by you, and never cash.</small></li>
          </ul>
        </section>
      </div>
      <p className="ref-offer__note">Free: one signature, never a transaction. A wallet joins once, before its first trade on ValueDesk.</p>
      {error && <p className="ref-offer__note" role="alert">{error}</p>}
      <DlgFoot left={<button type="button" className="dlg-btn" onClick={() => setLater(true)}>Not now</button>}>
        <button type="button" className="dlg-btn is-go" disabled={busy} onClick={() => void join()}>{busy ? 'Waiting for your wallet…' : 'Sign to join'}</button>
      </DlgFoot>
    </Modal>
  );
}

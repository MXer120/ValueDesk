/**
 * The VALUEDESK referral popup, for any connected wallet SoDEX says has no inviter (referralOffer.ts has the rules).
 * It says what the wallet gets and what ValueDesk gets, each with its source, and binds on SoDEX's own join page
 * (referral.ts: binding needs SoDEX's sign-in, which only sodex.com can do).
 *
 * It opens by itself a few seconds after a wallet connects, never over another dialog, the terms or the first-signup
 * flow; and on request for another wallet (offerReferral: a hedge bot's second account).
 */
import { useEffect, useRef, useState } from 'react';
import { browseAccepted, lookedAround, useAcceptanceRevision } from '../legal/acceptance';
import { Modal } from '../components/Modal';
import { DlgFoot } from '../components/dialogParts';
import type { Eip1193Provider } from '../wallet';
import { REFERRAL_CODE, REFERRAL_URL, loadReferral, useReferral } from './referral';
import { OFFER_EVENT, WE_GET, YOU_GET, markOffered, offeredAt, shouldOffer, type Benefit } from './referralRules';
import './onboarding.css';

const SETTLE_MS = 3_000;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function ReferralOfferHost({ address, provider, hold }: {
  address: string | null;
  provider: Eip1193Provider | null;
  /** The first-signup flow or the account-setup sheets are deciding or open. */
  hold: boolean;
}) {
  useAcceptanceRevision();
  const own = useReferral(provider ? address : null);
  const [open, setOpen] = useState<{ wallet: string; why?: string; asked: boolean } | null>(null);
  const termsUp = !browseAccepted() && !lookedAround();

  // By itself: the connected wallet, once SoDEX has said 'none', when nothing else is on screen.
  useEffect(() => {
    if (!address || !provider || hold || termsUp || open) return;
    if (!shouldOffer(own, offeredAt(address))) return;
    const t = window.setTimeout(() => {
      if (document.querySelector('[role="dialog"]')) return; // someone else's turn; asked again on the next change
      setOpen({ wallet: address.toLowerCase(), asked: false });
    }, SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [address, provider, hold, termsUp, own, open]);

  // On request, for any wallet (no rest period: the user is setting that wallet up right now).
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ wallet: string; why?: string }>).detail;
      if (!d?.wallet) return;
      void loadReferral(d.wallet).then((s) => {
        if (s === 'none') setOpen({ wallet: d.wallet, why: d.why, asked: true });
      });
    };
    window.addEventListener(OFFER_EVENT, on);
    return () => window.removeEventListener(OFFER_EVENT, on);
  }, []);

  if (!open) return null;
  return (
    <ReferralOffer
      wallet={open.wallet}
      why={open.why}
      other={!!address && open.wallet !== address.toLowerCase()}
      onClose={() => { markOffered(open.wallet); setOpen(null); }}
    />
  );
}

export function ReferralOffer({ wallet, why, other, onClose }: { wallet: string; why?: string; other: boolean; onClose: () => void }) {
  const state = useReferral(wallet);
  const [opened, setOpened] = useState(false);
  const joined = state === 'bound' || state === 'pending';
  const seen = useRef(false);
  useEffect(() => {
    if (!seen.current) { seen.current = true; markOffered(wallet); }
  }, [wallet]);
  return (
    <Modal open size="md" title={joined ? 'Code applied' : 'Use ValueDesk\'s SoDEX code'} className="dlg ref-offer" onClose={onClose}>
      {why && <p className="ref-offer__why">{why}</p>}
      <div className={`onb-code${joined ? ' is-on' : ''}`}>
        <i aria-hidden="true">{joined && <Check />}</i>
        <b>{REFERRAL_CODE}</b>
      </div>
      <p className="ref-offer__note">
        {joined
          ? state === 'pending'
            ? 'Joined. SoDEX finishes it on your next visit to sodex.com after your first deposit.'
            : `${other ? short(wallet) : 'Your wallet'} is on ${REFERRAL_CODE}.`
          : <>Shown because SoDEX says {other ? short(wallet) : 'this wallet'} has no referral code yet. You confirm with {other ? 'that wallet' : 'your wallet'} on sodex.com; no funds move.</>}
      </p>
      <div className="ref-offer__cols">
        <BenefitList label="What you get" items={YOU_GET} />
        <BenefitList label="What ValueDesk gets" items={WE_GET} />
      </div>
      <DlgFoot left={joined ? undefined : <button type="button" className="dlg-btn" onClick={onClose}>{opened ? 'Close' : 'Not now'}</button>}>
        {joined ? (
          <button type="button" className="dlg-btn is-go" onClick={onClose}>Done</button>
        ) : (
          <a className="dlg-btn is-go ref-offer__go" href={REFERRAL_URL} target="_blank" rel="noopener noreferrer" onClick={() => setOpened(true)}>
            {opened ? 'Open SoDEX again' : 'Apply on SoDEX'}
          </a>
        )}
      </DlgFoot>
      {opened && !joined && (
        <p className="ref-offer__note">{other ? `Connect ${short(wallet)} on sodex.com and confirm there.` : 'Confirm with your wallet in the SoDEX tab.'} This updates when you come back.</p>
      )}
    </Modal>
  );
}

function BenefitList({ label, items }: { label: string; items: readonly Benefit[] }) {
  return (
    <section className="ref-offer__list">
      <div className="dlg-label"><span>{label}</span></div>
      <ul>
        {items.map((b) => (
          <li key={b.title}>
            <b>{b.title}</b>
            <small>{b.line} <a href={b.source.url} target="_blank" rel="noopener noreferrer">{b.source.label}</a></small>
          </li>
        ))}
      </ul>
    </section>
  );
}

const Check = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" /></svg>
);

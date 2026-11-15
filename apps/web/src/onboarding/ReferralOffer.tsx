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
import { REFERRAL_CODE, loadReferral, referralUrl, useReferral } from './referral';
import { pendingInvite, useSodexCode } from '../invites/invites';
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
  // A wallet that came on a referral link is offered that link's code (InviteHost first, then here), never ours over it.
  const sc = useSodexCode(provider ? address : null);
  const own = useReferral(provider ? address : null, sc.code);
  const [open, setOpen] = useState<{ wallet: string; why?: string; asked: boolean } | null>(null);
  const termsUp = !browseAccepted() && !lookedAround();

  // By itself: the connected wallet, once SoDEX has said 'none', when nothing else is on screen.
  useEffect(() => {
    if (!address || !provider || hold || termsUp || open || !sc.ready || pendingInvite()) return;
    if (!shouldOffer(own, offeredAt(address))) return;
    const t = window.setTimeout(() => {
      if (document.querySelector('[role="dialog"]')) return; // someone else's turn; asked again on the next change
      setOpen({ wallet: address.toLowerCase(), asked: false });
    }, SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [address, provider, hold, termsUp, own, open, sc.ready]);

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
      code={open.asked ? REFERRAL_CODE : sc.code}
      theirs={!open.asked && sc.theirs}
      why={open.why}
      other={!!address && open.wallet !== address.toLowerCase()}
      onClose={() => { markOffered(open.wallet); setOpen(null); }}
    />
  );
}

export function ReferralOffer({ wallet, code = REFERRAL_CODE, theirs = false, why, other, onClose }: {
  wallet: string;
  /** The code offered: ours, or the code of the referral link the wallet came with (`theirs`). */
  code?: string;
  theirs?: boolean;
  why?: string;
  other: boolean;
  onClose: () => void;
}) {
  const state = useReferral(wallet, code);
  const you = theirs ? YOU_GET.map((b) => (b.id === 'squad' ? { ...b, line: b.line.replace('our Squad', "your inviter's Squad") } : b)) : YOU_GET;
  const [opened, setOpened] = useState(false);
  const joined = state === 'bound' || state === 'pending';
  const seen = useRef(false);
  useEffect(() => {
    if (!seen.current) { seen.current = true; markOffered(wallet); }
  }, [wallet]);
  return (
    <Modal open size="md" title={joined ? 'Code applied' : theirs ? "Use your inviter's SoDEX code" : 'Use ValueDesk\'s SoDEX code'} className="dlg ref-offer" onClose={onClose}>
      {why && <p className="ref-offer__why">{why}</p>}
      <div className={`onb-code${joined ? ' is-on' : ''}`}>
        <i aria-hidden="true">{joined && <Check />}</i>
        <b>{code}</b>
      </div>
      <p className="ref-offer__note">
        {joined
          ? state === 'pending'
            ? 'Joined. SoDEX finishes it on your next visit to sodex.com after your first deposit.'
            : `${other ? short(wallet) : 'Your wallet'} is on ${code}.`
          : <>{other ? short(wallet) : 'This wallet'} has no referral code yet (SoDEX). You confirm on sodex.com; no funds move.</>}
      </p>
      <div className="ref-offer__cols">
        <BenefitList label="You get" items={you} />
        <BenefitList label={theirs ? 'Your inviter gets, from SoDEX' : 'ValueDesk gets, from SoDEX'} items={WE_GET} />
      </div>
      <DlgFoot left={joined ? undefined : <button type="button" className="dlg-btn" onClick={onClose}>{opened ? 'Close' : 'Not now'}</button>}>
        {joined ? (
          <button type="button" className="dlg-btn is-go" onClick={onClose}>Done</button>
        ) : (
          <a className="dlg-btn is-go ref-offer__go" href={referralUrl(code)} target="_blank" rel="noopener noreferrer" onClick={() => setOpened(true)}>
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
          <li key={b.id} title={b.line}>
            <b>{b.title}</b>
            <span className="ref-offer__sr">{b.line}</span>
            <a href={b.source.url} target="_blank" rel="noopener noreferrer" aria-label={`Source: ${b.source.label}`} title={b.source.label}><Out /></a>
          </li>
        ))}
      </ul>
    </section>
  );
}

const Out = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6.5 3.5h-3v9h9v-3M9 3h4v4M13 3 7.5 8.5" /></svg>
);

const Check = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" /></svg>
);

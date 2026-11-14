/**
 * One share dialog for the whole app: any page calls openShare(card) (a click on a ShareButton) and the host, mounted
 * once in App, shows ShareCard. The dialog and its canvas drawing load only when someone shares.
 */
import { Suspense, useEffect, useState } from 'react';
import { lazyChunk } from '../../lazyPage';
import { REFERRAL_CODE, useReferralKnown } from '../../onboarding/referral';
import { mayAttachCode } from '../../onboarding/referralRules';
import type { CardData } from './card';
import { useOwnCode, withInvite } from '../../invites/invites';
import './share.css';

const ShareCard = lazyChunk(() => import('./ShareCard'));

const EVENT = 'vd:share-card';

export function openShare(card: CardData): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: card }));
}

/** The connected wallet decides whether ValueDesk's code may be on the card (referralRules.mayAttachCode). */
export function ShareHost({ address }: { address: string | null }) {
  const ref = useReferralKnown(address);
  // Every shared card links with the sharer's own SoDEX referral code: a viewer who joins earns the sharer fee credits
  // (and SoDEX's rebate). Read from SoDEX once someone shares.
  const [card, setCard] = useState<CardData | null>(null);
  const own = useOwnCode(card ? address : null);
  const invite = own.state === 'ok' ? own.code : null;
  useEffect(() => {
    const on = (e: Event) => setCard((e as CustomEvent<CardData>).detail ?? null);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  if (!card) return null;
  return (
    <Suspense fallback={null}>
      <ShareCard card={invite ? { ...card, link: withInvite(card.link, invite) } : card} code={invite ?? (mayAttachCode(ref) ? REFERRAL_CODE : null)} onClose={() => setCard(null)} />
    </Suspense>
  );
}

const SHARE_ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" /></svg>
);

/** The small share button for a row or a card; `make` builds the card at the click (from what the row shows now). */
export function ShareButton({ make, label = 'Share', text }: { make: () => CardData | null; label?: string; text?: string }) {
  return (
    <button
      type="button"
      className={`share-btn${text ? ' is-text' : ''}`}
      aria-label={label}
      title={label}
      onClick={(e) => { e.stopPropagation(); const c = make(); if (c) openShare(c); }}
    >
      {SHARE_ICON}{text && <span>{text}</span>}
    </button>
  );
}

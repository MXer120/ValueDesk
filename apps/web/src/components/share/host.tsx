/**
 * One share dialog for the whole app: any page calls openShare(card) (a click on a ShareButton) and the host, mounted
 * once in App, shows ShareCard. The dialog and its canvas drawing load only when someone shares.
 *
 * The card BUILDERS (shareData.ts) are not in the pages' first render either: they bring the bot presets and the
 * grid backtest's table (~26 KB brotli on /trade). A page with a share button fetches them after its load event
 * (afterLoad.ts), and again on the button's press, so the click finds them in; shareCard() builds the card with
 * them and opens it. The figures are the ones the row showed at the click.
 */
import { Suspense, useEffect, useState } from 'react';
import { lazyChunk } from '../../lazyPage';
import { prefetchAfterLoad } from '../../afterLoad';
import { logger } from '../../log';
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

const log = logger('share');

/** The card builders (shareData.ts). */
export type ShareBuilders = typeof import('./shareData');
let builders: ShareBuilders | null = null;
let loadingBuilders: Promise<ShareBuilders> | null = null;
/** Fetch the card builders (once; again on the next ask if it failed). */
export function loadShareBuilders(): Promise<ShareBuilders> {
  if (builders) return Promise.resolve(builders);
  loadingBuilders ??= import('./shareData').then(
    (m) => (builders = m),
    (e: unknown) => {
      loadingBuilders = null;
      throw e;
    },
  );
  return loadingBuilders;
}
let buttons = 0;
let cancelPrefetch: (() => void) | null = null;
/** A page shows a share button: the builders are fetched after the load event (one fetch, while any button is up). */
export function useShareBuildersPrefetch(): void {
  useEffect(() => {
    buttons += 1;
    if (!builders && !cancelPrefetch) cancelPrefetch = prefetchAfterLoad(loadShareBuilders);
    return () => {
      buttons -= 1;
      if (buttons === 0 && cancelPrefetch) {
        cancelPrefetch();
        cancelPrefetch = null;
      }
    };
  }, []);
}
/** Build a card with the builders - at once when they are in - and open the share dialog. */
export function shareCard(make: (b: ShareBuilders) => CardData | null): void {
  const open = (b: ShareBuilders) => {
    const c = make(b);
    if (c) openShare(c);
  };
  if (builders) {
    open(builders);
    return;
  }
  loadShareBuilders().then(open, (e: unknown) => log.warn('the share card could not be built', { error: String(e) }));
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
export function ShareButton({ make, label = 'Share', text }: { make: (b: ShareBuilders) => CardData | null; label?: string; text?: string }) {
  useShareBuildersPrefetch();
  return (
    <button
      type="button"
      className={`share-btn${text ? ' is-text' : ''}`}
      aria-label={label}
      title={label}
      onPointerDown={() => { void loadShareBuilders().catch(() => {}); }}
      onClick={(e) => { e.stopPropagation(); shareCard(make); }}
    >
      {SHARE_ICON}{text && <span>{text}</span>}
    </button>
  );
}

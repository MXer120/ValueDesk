/**
 * When ValueDesk offers its SoDEX referral code in a popup (owner 2026-11-14: "apply it everywhere + with pop up where
 * user sees his benefits so we dont hide it being used + ONLY if we verified that wallet doesnt already have a ref
 * code").
 *
 * Only a wallet SoDEX itself says has no inviter ('none', from checkEligibility, referral.ts) is ever offered the code.
 * 'unknown' (SoDEX did not answer), 'other', 'self', 'pending' and 'bound' never are. "Not now" rests the offer for a
 * while per wallet; the first-signup flow's referral step counts as an offer made.
 *
 * Every benefit line carries its source. Nothing here is a number of ours.
 */
import type { ReferralState } from './referral';

/** How long "Not now" rests the popup for one wallet. */
export const OFFER_REST_MS = 14 * 24 * 3_600_000;

const KEY = (wallet: string) => `vd.ref.offer.${wallet.toLowerCase()}`;

/** When this wallet was last offered the code in this browser (ms), null: never. */
export function offeredAt(wallet: string): number | null {
  try {
    const v = Number(localStorage.getItem(KEY(wallet)));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Mark the offer made (the popup was answered, or the first-signup step showed it). */
export function markOffered(wallet: string, at = Date.now()): void {
  try {
    localStorage.setItem(KEY(wallet), String(at));
  } catch {
    /* private mode: offered again next visit */
  }
}

/** Whether the popup may open for this wallet now. */
export function shouldOffer(state: ReferralState, lastOffered: number | null, now = Date.now()): boolean {
  if (state !== 'none') return false;
  return lastOffered === null || now - lastOffered >= OFFER_REST_MS;
}

export interface Benefit {
  id: string;
  /** What the popup shows: a few words (owner 2026-11-16: "benefits are way way way too much text"). */
  title: string;
  /** The full sentence, shown on hover and read by screen readers. */
  line: string;
  source: { label: string; url: string };
}

const SEASON = { label: 'SoDEX docs, Layer 1 Season', url: 'https://docs.sodex.com/sopoints/layer-1-season' };
const PROGRAMME = {
  label: 'SoDEX Referral Program, Jan 2026',
  url: 'https://sodex-support.zendesk.com/hc/en-us/articles/14761887936399-SoDEX-Referral-Program-is-now-live-on-SoDEX-Mainnet-January-1-2026',
};

/** What the wallet gets. */
export const YOU_GET: readonly Benefit[] = [
  { id: 'points', title: '+5% SoPoints', line: 'Invitees get an extra 5% points boost on the points they earn.', source: SEASON },
  {
    id: 'squad',
    title: 'Squad boost, up to +25%',
    line: 'You join our Squad. A Squad\'s boost is +5% to +25%, set by its members\' trading volume in the season\'s 4-week window.',
    source: SEASON,
  },
];

/** What ValueDesk gets, said as plainly. */
export const WE_GET: readonly Benefit[] = [
  { id: 'points-rebate', title: '25% points rebate', line: 'SoDEX gives the inviter a rebate of 25% of the points its invitees generate.', source: SEASON },
  { id: 'fee-rebate', title: '10% fee rebate', line: 'SoDEX gives the inviter 10% of its invitees\' trading fees.', source: PROGRAMME },
];

/**
 * Whether ValueDesk's code may ride on a request for this wallet (a Wealth vault deposit's referral): only when SoDEX
 * says it has no inviter, or it is on ours already. 'other', 'self' and 'unknown' never carry it.
 */
export const mayAttachCode = (state: ReferralState): boolean => state === 'none' || state === 'pending' || state === 'bound';

/** Open the popup for one wallet (e.g. the second account a hedge bot connects). Ignored unless SoDEX says 'none'. */
export const OFFER_EVENT = 'vd:referral-offer';
export function offerReferral(wallet: string, why?: string): void {
  window.dispatchEvent(new CustomEvent(OFFER_EVENT, { detail: { wallet: wallet.toLowerCase(), why } }));
}

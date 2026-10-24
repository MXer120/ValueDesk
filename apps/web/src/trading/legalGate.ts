/**
 * The legal gate: ONE check every exchange action passes before it is signed,
 * next to the fee guard (actions.ts `signAndSend` - the only place the app
 * signs one). No code path can open a position where ValueDesk's terms do not
 * allow it: the order ticket, an algo's child order, a position's close button
 * and whatever is added later all end here.
 *
 * WHAT OPENS A POSITION ("opening"): a new order (newOrder, batchNewOrder) with
 * any leg that is not reduce-only on perps or not a sell on spot (a spot sell
 * only ever reduces what is held); a TWAP; a change of a resting order (modify,
 * replace) - the gate cannot tell a change that enlarges an order from one that
 * shrinks it, so in a restricted state the order is cancelled and placed again.
 *
 * THE RULES, by what legal/jurisdictions.mjs `siteAccess` says for the place
 * the edge saw (legal/geo.ts) and the wallet's declared country of residence
 * (its signed terms, legal/acceptance.ts):
 *   blocked                 nothing is signed at all (the app is not shown there either) -
 *                           also for a wallet on a sanctions list (legal/screening.ts);
 *   close-only              nothing opening; everything else is;
 *   terms not signed        (no signature of the current version for this wallet)
 *                           nothing opening, so a wallet that enabled trading before a
 *                           change of the terms signs the new version first;
 *   open, terms signed      everything.
 * Cancels, reduce-only orders, spot sells, leverage and margin, transfers,
 * withdrawals and key revocation are never refused for the last two: nobody is
 * locked into a position by a restriction or a new version of the terms.
 */
import type { SignableAction } from '@sodex-core';
import { OrderSide } from '@sodex-core';
import { signedTerms } from '../legal/acceptance';
import { viewerGeo } from '../legal/geo';
import { SANCTIONED_WALLET_REASON, screeningOf } from '../legal/screening';
import { siteAccess, type SiteAccess } from '../legal/jurisdictions.mjs';
import { TradingError } from './session';
import { logger } from '../log';

const log = logger('trade');

/** Asks the app to show the terms sheet for the connected wallet (AccountController listens). */
export const SIGN_TERMS_EVENT = 'vd:sign-site-terms';

/** Whether an action can open or increase a position. */
export function isOpening(action: SignableAction): boolean {
  switch (action.type) {
    case 'newOrder':
    case 'batchNewOrder': {
      const orders = (action.params as { orders?: unknown }).orders;
      if (!Array.isArray(orders) || orders.length === 0) return true;
      return orders.some((o) => {
        const leg = (o ?? {}) as { side?: unknown; reduceOnly?: unknown };
        return action.engine === 'perps' ? leg.reduceOnly !== true : leg.side !== OrderSide.SELL;
      });
    }
    case 'newTwapOrder':
    case 'modifyOrder':
    case 'replaceOrder':
      return true;
    default:
      return false;
  }
}

export interface LegalState {
  access: SiteAccess;
  /** The wallet has signed the current terms in this browser. */
  signed: boolean;
}

/** A wallet on a sanctions list (legal/screening.ts): blocked, whatever the place. */
const SANCTIONED_WALLET: SiteAccess = { level: 'blocked', country: null, place: null, reason: SANCTIONED_WALLET_REASON, source: 'observed' };

/** The state for `owner` now: the place the edge saw, the declared country, the screening, the signature. */
export function legalStateFor(owner: string | null | undefined): LegalState {
  const g = viewerGeo();
  const t = signedTerms(owner);
  const access = screeningOf(owner) === 'sanctioned'
    ? SANCTIONED_WALLET
    : siteAccess({ country: g.country, region: g.region, declared: t?.country ?? null });
  return { access, signed: !!t };
}

/** null when `action` may be signed in `state`; otherwise why not, for the user. */
export function legalRefusal(action: SignableAction, state: LegalState): string | null {
  if (state.access.level === 'blocked') return state.access.reason;
  if (!isOpening(action)) return null;
  if (state.access.level === 'close-only') return state.access.reason;
  if (!state.signed) return 'Accept the current Terms of use with your wallet before you open or increase a position. Closing, cancelling and withdrawing work without it.';
  return null;
}

/**
 * Called for EVERY action right before it is signed (actions.ts `signAndSend`).
 * Throws TradingError('legal') when it may not be; asks for the terms when the
 * signature is what is missing.
 */
export function guardLegal(action: SignableAction, owner: string): void {
  const state = legalStateFor(owner);
  const why = legalRefusal(action, state);
  if (!why) return;
  log.warn('legal gate: an action was NOT signed', { type: action.type, engine: action.engine, level: state.access.level, signed: state.signed });
  if (state.access.level === 'open' && !state.signed && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SIGN_TERMS_EVENT));
  }
  throw new TradingError(why, 'legal');
}

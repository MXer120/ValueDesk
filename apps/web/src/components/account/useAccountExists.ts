/**
 * Does `address` have a SoDEX account? true / false once the trading session
 * has checked, null while it has not (or the address is not the session's).
 *
 * Transfers move funds between Spot, Perps and the wallet - all of them the
 * account's - so they need one; a brand-new wallet opens its account with a
 * Deposit instead.
 */
import { useSyncExternalStore } from 'react';
import { getTradingState, subscribeTrading } from '../../trading/session';

export function useAccountExists(address: string | null): boolean | null {
  const t = useSyncExternalStore(subscribeTrading, getTradingState, getTradingState);
  const owner = address?.toLowerCase();
  if (!owner || t.owner !== owner) return null;
  return t.accountStatus === 'ready' ? true : t.accountStatus === 'none' ? false : null;
}

/** Why Transfer is off for a wallet SoDEX has never seen. */
export const NO_ACCOUNT_TRANSFER = 'Transfers need a SoDEX account - make a deposit first to open one.';

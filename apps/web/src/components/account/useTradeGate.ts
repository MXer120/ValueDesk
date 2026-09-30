/**
 * What the order button says and does while the ticket cannot trade yet.
 *
 * The Long/Short button IS the fix. With no wallet it reads "Connect wallet",
 * with an address remembered from last time but no live wallet "Reconnect
 * wallet", with a wallet SoDEX has never seen "Create account", and connected
 * but not enabled "Enable trading" - and pressing it does exactly that
 * (actions.ts:walletRoute). There is no second line above or below it saying
 * the same thing: the words sit where the user's eye and pointer already are,
 * and the button keeps its side colour so the ticket does not change shape
 * when trading comes on.
 *
 * Connect and Reconnect open our Connect dialog (connect.ts:openConnectDialog),
 * never AppKit directly. Enable trading and Create account go to
 * AccountController, which owns the signature and the first-deposit dialog.
 */
import { useSyncExternalStore } from 'react';
import { useWalletSnapshot } from './useWallet';
import { requestCreateAccount, requestEnableTrading, useAccountPending, walletRoute } from './actions';
import { openConnectDialog } from './connect';
import { getTradingState, subscribeTrading } from '../../trading/session';

export interface TradeGate {
  /** The button's words. */
  label: string;
  /** The full reason, for the tooltip. */
  why: string;
  act: () => void;
  /** Something is already in flight (a restore, a dialog, a signature). */
  busy: boolean;
  /** Enable trading is waiting for the wallet's signature (the button shows where to approve). */
  approving: boolean;
}

/** Null when the ticket can trade: the button is Long/Short again. */
export function useTradeGate(address: string | null | undefined, unlocked: boolean): TradeGate | null {
  const wallet = useWalletSnapshot();
  const pending = useAccountPending();
  const trading = useSyncExternalStore(subscribeTrading, getTradingState, getTradingState);
  if (unlocked) return null;

  /* AppKit is restoring last session's wallet: say so rather than offering a
     Reconnect that would race the restore. */
  const restoring = wallet.status === 'connecting' && !!address;
  const route = walletRoute({ address, hasProvider: wallet.status === 'connected', unlocked: false });
  const connect = () => openConnectDialog();
  const sameWallet = !!address && trading.owner === address.toLowerCase();
  const noAccount = route === 'enable' && sameWallet && trading.accountStatus === 'none';
  const base =
    route === 'connect'
      ? { why: 'Connect a wallet to trade.', label: 'Connect wallet', act: connect }
      : route === 'reconnect'
        ? { why: 'Your wallet is not connected on this page. Reconnect it to trade.', label: 'Reconnect wallet', act: connect }
        : noAccount
          ? {
              why: 'This wallet has no SoDEX account yet. Your first deposit of USDC creates it, right here.',
              label: 'Create account',
              act: requestCreateAccount,
            }
          : {
              why: 'Enable trading to place orders: one wallet signature registers a trading key in this browser.',
              label: 'Enable trading',
              act: requestEnableTrading,
            };

  const busy = restoring || (route === 'enable' ? pending === 'enable' : pending === 'connect');
  const label = restoring
    ? 'Reconnecting…'
    : busy && route === 'enable'
      ? 'Waiting for wallet…'
      : busy
        ? 'Opening…'
        : base.label;
  return { label, why: base.why, act: base.act, busy, approving: busy && route === 'enable' && !restoring };
}

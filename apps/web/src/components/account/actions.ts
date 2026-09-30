/**
 * Account actions, reachable from anywhere without a wallet sheet.
 *
 * The wallet used to live in one modal ("Wallet") that held connect, enable
 * trading, turn off, advanced key options and disconnect. Connect is now our
 * Connect dialog (ConnectDialog.tsx, which hands off to AppKit only after a row
 * in it is pressed) and nothing else, so everything else moved to where it
 * is used: the navbar's address menu, the order ticket's Long/Short button, the
 * status footer. Those are in three unrelated corners of the tree, and the work
 * itself (a confirm dialog, a signature, a session refresh) needs one owner -
 * `AccountController`, mounted once in App.tsx.
 *
 * They talk to it by WINDOW EVENT, the convention this app already uses for a
 * control in one place driving a handler that lives elsewhere (`dash:lock:toggle`,
 * `dash:menu`, and `wallet:disconnect` before this file). The helpers below are
 * the typed front door to those events.
 *
 * What the controller is doing RIGHT NOW (`pending`) is shared state, not an
 * event, so the button that started an action and every other button for it can
 * show "Waiting for your wallet…" together. It is a tiny external store read with
 * `useSyncExternalStore`.
 */
import { useSyncExternalStore } from 'react';

export const WALLET_EVENTS = {
  /** Open OUR Connect dialog (connect.ts:openConnectDialog) - never AppKit directly. */
  connect: 'wallet:connect',
  /** One signature: register this browser's trading key on SoDEX. */
  enableTrading: 'wallet:enable-trading',
  /** No SoDEX account yet: the Deposit sheet, which opens it with the first deposit. */
  createAccount: 'wallet:create-account',
  /** The Deposit sheet (funds/DepositModal.tsx). */
  deposit: 'wallet:deposit',
  /** The Withdraw sheet (funds/WithdrawModal.tsx); detail `{ from, coin }` preselects the source and coin. */
  withdraw: 'wallet:withdraw',
  /** The Transfer sheet (funds/TransferModal.tsx): Spot / Perps / EVM; detail is a TransferPreset. */
  transfer: 'wallet:transfer',
  /** Delete this machine's trading key (with a confirm). */
  disableTrading: 'wallet:disable-trading',
  /** Manual key creation, import, legacy keystore migration. */
  advanced: 'wallet:advanced',
  /** Forget the wallet (useWallet.ts). */
  disconnect: 'wallet:disconnect',
  /** The address menu's Sign out: forget this browser's trading key, then the wallet. */
  signOut: 'wallet:sign-out',
  /** Open the navbar's address menu (the footer's wallet button uses this). */
  menu: 'wallet:menu',
} as const;

const fire = (name: string) => () => {
  window.dispatchEvent(new CustomEvent(name));
};

export const requestConnect = fire(WALLET_EVENTS.connect);
export const requestEnableTrading = fire(WALLET_EVENTS.enableTrading);
export const requestCreateAccount = fire(WALLET_EVENTS.createAccount);
export const requestDeposit = fire(WALLET_EVENTS.deposit);
/** `from` ticks one source; `coin` is the asset config name (USDC, not vUSDC). */
export const requestWithdraw = (detail?: { from?: 'spot' | 'perps'; coin?: string }) => {
  const from = detail?.from;
  const coin = detail?.coin;
  window.dispatchEvent(new CustomEvent(WALLET_EVENTS.withdraw, {
    detail: from || coin ? { from, coin } : null,
  }));
};
export const requestDisableTrading = fire(WALLET_EVENTS.disableTrading);
export const requestAdvanced = fire(WALLET_EVENTS.advanced);
export const requestDisconnect = fire(WALLET_EVENTS.disconnect);
export const requestSignOut = fire(WALLET_EVENTS.signOut);
export const requestAccountMenu = fire(WALLET_EVENTS.menu);

/** Where the Transfer sheet starts. */
export interface TransferPreset {
  from?: 'spot' | 'perps' | 'evm';
  to?: 'spot' | 'perps' | 'evm';
  coin?: string;
}
/** Withdraw with only `from` ticked as the source (the address menu's per-account buttons). */
export const requestWithdrawFrom = (from: 'spot' | 'perps') => requestWithdraw({ from });
export const requestTransfer = (preset?: TransferPreset) => {
  window.dispatchEvent(new CustomEvent(WALLET_EVENTS.transfer, { detail: preset ?? null }));
};

/* ---------------------------------------------------------------------------
 * Where "the wallet" button should take you.
 * ------------------------------------------------------------------------ */

export type WalletRoute = 'connect' | 'reconnect' | 'enable' | 'menu';

export interface WalletRouteInput {
  /** The address the app is showing (may be restored from storage). */
  address: string | null | undefined;
  /** Is a live provider attached - can this page ask the wallet to sign? */
  hasProvider: boolean;
  /** Does the backend hold an unlocked trading key? */
  unlocked: boolean;
}

/**
 * The one decision every "wallet" affordance makes, in the order the user needs
 * it: no wallet -> connect; an address remembered from last time but nothing to
 * sign with -> reconnect; connected but read-only -> enable trading; everything
 * in place -> the account menu, which is where the rest lives.
 *
 * Pure, so it is tested rather than re-derived at each call site.
 */
export function walletRoute({ address, hasProvider, unlocked }: WalletRouteInput): WalletRoute {
  if (!address) return 'connect';
  if (!hasProvider) return 'reconnect';
  if (!unlocked) return 'enable';
  return 'menu';
}

/** Act on `walletRoute`. Reconnecting IS connecting: the same Connect dialog. */
export function goToWallet(input: WalletRouteInput): void {
  switch (walletRoute(input)) {
    case 'connect':
    case 'reconnect':
      requestConnect();
      return;
    case 'enable':
      requestEnableTrading();
      return;
    case 'menu':
      requestAccountMenu();
  }
}

/** Case-insensitive address equality; `null`/`undefined` never match. */
export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/* ---------------------------------------------------------------------------
 * What the controller is busy with.
 * ------------------------------------------------------------------------ */

export type AccountPending = 'connect' | 'enable' | 'disable' | null;

let pending: AccountPending = null;
const listeners = new Set<() => void>();

export function setAccountPending(next: AccountPending): void {
  if (next === pending) return;
  pending = next;
  for (const l of listeners) l();
}

export function getAccountPending(): AccountPending {
  return pending;
}

function subscribePending(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useAccountPending(): AccountPending {
  return useSyncExternalStore(subscribePending, getAccountPending, getAccountPending);
}

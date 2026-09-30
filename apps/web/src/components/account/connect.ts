/**
 * THE Connect action. Every "Connect wallet" / "Reconnect" button in the app
 * calls `openConnectDialog()`, and it does exactly one thing: open OUR Connect
 * dialog (ConnectDialog.tsx, mounted once by AccountController).
 *
 * AppKit is never opened from here or from any button directly. It appears only
 * after a row in our dialog is pressed, and only the part of it that row needs
 * (walletconnect.ts:connectVia has the table).
 *
 * The open flag is a tiny external store, read with `useSyncExternalStore`, so
 * any module can open the dialog without holding a reference to it - the
 * navbar, the order ticket, the footer and the palette are in unrelated corners
 * of the tree.
 *
 * Kept out of actions.ts on purpose: that module is pure and unit-tested under
 * plain Node, and the dialog reaches walletconnect.ts, which reads
 * `import.meta.env` at load - only Vite provides that.
 *
 * The result of a connect does not come back through here. The new state
 * reaches the app through `subscribeWallet` (see useWallet.ts:useWalletBridge),
 * and the dialog closes itself when it sees the wallet connect.
 */
import { useSyncExternalStore } from 'react';

let open = false;
const listeners = new Set<() => void>();

function setOpen(next: boolean): void {
  if (next === open) return;
  open = next;
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* one bad listener must not stop the others */
    }
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const getOpen = (): boolean => open;

/** THE entry point. Opens our Connect dialog; a second call while it is open is a no-op. */
export function openConnectDialog(): void {
  setOpen(true);
}

/** Ends the dialog's session. Called by the dialog itself. */
export function closeConnectDialog(): void {
  setOpen(false);
}

/** Is the dialog's session active (on screen, or waiting behind AppKit)? */
export function useConnectDialogOpen(): boolean {
  return useSyncExternalStore(subscribe, getOpen, getOpen);
}

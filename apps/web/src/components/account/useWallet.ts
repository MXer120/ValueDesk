/**
 * React access to the wallet layer (walletconnect.ts), and the bridge that feeds
 * App.tsx's `address` / `provider` state from it.
 */
import { useEffect, useRef, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';
import type { Eip1193Provider } from '../../wallet';
import {
  disconnectWallet,
  getWalletSnapshot,
  initWallet,
  onWalletConnectClosed,
  onWalletConnected,
  shouldRestoreOnLoad,
  subscribeWallet,
  type WalletSnapshot,
} from '../../walletconnect';
import { notify } from '../../toast';
import { WALLET_EVENTS, sameAddress } from './actions';

/** The live wallet: provider, address, chain id, wallet name. */
export function useWalletSnapshot(): WalletSnapshot {
  return useSyncExternalStore(subscribeWallet, getWalletSnapshot, getWalletSnapshot);
}

interface BridgeProps {
  address: string | null;
  setAddress: (a: string | null) => void;
  setProvider: Dispatch<SetStateAction<Eip1193Provider | null>>;
}

/**
 * Keep App.tsx's `address` and `provider` in step with the wallet.
 *
 * MOUNTED AT APP LEVEL, for the life of the page, and that is the point. Every
 * one of these subscriptions used to live inside the wallet sheet, which
 * unmounts when closed - so a session the wallet ended, an account switched in
 * the extension, or a Disconnect pressed in the navbar reached a listener only
 * while the sheet happened to be open. That was the "header still says
 * Connected" bug, twice over.
 *
 *  - SILENT RESTORE: if a connection is on disk, AppKit is started at load and
 *    restores it without a prompt (see walletconnect.ts:syncConnection).
 *  - FOLLOW THE WALLET: a connected wallet sets both values; an account switch
 *    moves `address`; a lost connection drops `provider` but KEEPS `address`, so
 *    the app stays readable and every "Reconnect wallet" button knows who to
 *    reconnect.
 *  - THE WALLET HUNG UP: the session ended from the wallet's side, so both are
 *    cleared - the same account cannot be assumed any more.
 *  - DISCONNECT: the navbar's menu dispatches `wallet:disconnect`.
 */
export function useWalletBridge({ address, setAddress, setProvider }: BridgeProps): void {
  // Refs, so the subscriptions below are bound once rather than on every render
  // (useStored's setter is not guaranteed stable).
  const addrRef = useRef(address);
  addrRef.current = address;
  const setAddr = useRef(setAddress);
  setAddr.current = setAddress;
  const setProv = useRef(setProvider);
  setProv.current = setProvider;

  useEffect(() => {
    if (shouldRestoreOnLoad()) {
      void initWallet().catch(() => {
        /* no project id or offline: the app stays read-only, Connect will say why */
      });
    }
  }, []);

  useEffect(() => {
    const apply = () => {
      const s = getWalletSnapshot();
      if (s.status === 'connected' && s.provider && s.address) {
        const p = s.provider;
        // Updater form: a provider is an object, but never hand React a value it
        // could mistake for a state-updater function.
        setProv.current(() => p);
        // Keep the stored spelling when it is the same account: a checksummed
        // copy of a lowercase address would re-key every per-address cache.
        if (!sameAddress(addrRef.current, s.address)) setAddr.current(s.address);
      } else if (s.status === 'disconnected' || s.status === 'idle') {
        setProv.current(null);
      }
    };
    apply();
    return subscribeWallet(apply);
  }, []);

  useEffect(
    () =>
      onWalletConnectClosed(() => {
        setProv.current(null);
        setAddr.current(null);
        notify('info', 'Your wallet ended the connection. Connect again to continue.');
      }),
    [],
  );

  useEffect(
    () => onWalletConnected((s) => notify('ok', `Wallet connected via ${s.walletName}.`)),
    [],
  );

  useEffect(() => {
    const onEvt = () => {
      setProv.current(null);
      setAddr.current(null);
      void disconnectWallet().catch(() => {});
    };
    window.addEventListener(WALLET_EVENTS.disconnect, onEvt);
    return () => window.removeEventListener(WALLET_EVENTS.disconnect, onEvt);
  }, []);
}

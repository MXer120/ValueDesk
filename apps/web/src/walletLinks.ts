/**
 * CONNECTING ON A PHONE (phone pass, 2026-11-18).
 *
 * A phone browser has no wallet extension. Until now every wallet row on a phone started a WalletConnect pairing:
 * the dialog loaded AppKit (~1 MB of script), then sent the visitor to `metamask://wc?uri=...` - a custom scheme that
 * does nothing at all on Android when the app is missing - and from then on every signature (the terms, the trading
 * key) needed another trip to the wallet app and back, with the relay socket suspended in the background meanwhile.
 *
 * Now a wallet row on a phone opens THIS page inside the wallet's own browser, by the link the wallet documents for
 * exactly that. In there the wallet injects its provider: ValueDesk connects straight away (walletBrowser() below,
 * ConnectDialog.tsx), and every later signature is a prompt on the same screen. A wallet that is not installed gets
 * its store page from the same https link (MetaMask, Trust document that).
 *
 * The links, each from the wallet's own documentation (read 2026-11-18):
 *   MetaMask  https://link.metamask.io/dapp/{url without scheme}
 *             docs.metamask.io/metamask-connect/evm/guides/metamask-exclusive/use-deeplinks/
 *   OKX       https://web3.okx.com/download?deeplink=enc("okx://wallet/dapp/url?dappUrl=" + enc(url))
 *             web3.okx.com/build/docs/waas/app-universal-link (the page is gone; its 2025-12-06 archive copy)
 *   Trust     https://link.trustwallet.com/open_url?coin_id=60&url={url}
 *             developer.trustwallet.com/developer/develop-for-trust/deeplinking (2026-01-12 archive copy)
 *   Bitget    https://bkcode.vip?action=dapp&url={url}  ("Android only support https://bkcode.vip")
 *             web3.bitget.com/en/docs/configuration/deeplink
 *   Rabby, SafePal: no such link is documented. Their rows copy the page's address and say where to paste it (Rabby's
 *             support: "open the dapp inside Rabby's browser"; SafePal's: paste it into the DApp search bar).
 *
 * The page's address carries `vsConnect=1`, so the page that opens in the wallet connects without a second tap.
 */

import { INVITE_PARAM } from '@sign/invites/claim';
import { pendingInvite } from './invites/capture';

export type PhoneWalletKey = 'metamask' | 'okx' | 'trust' | 'bitget' | 'rabby' | 'safepal';

export interface PhoneWallet {
  key: PhoneWalletKey;
  label: string;
  /** Reown explorer image id: the icon AppKit's own list shows (walletconnect.ts walletImageUrl). */
  imageId: string;
  /** The documented link that opens `pageUrl` in the wallet's browser; null when the wallet documents none. */
  open: ((pageUrl: string) => string) | null;
  /** Where to paste the address when there is no link. */
  pasteHint?: string;
}

const enc = encodeURIComponent;

/** The order of the phone list: the wallets most visitors hold first (owner 2026-11-18: MetaMask, OKX, Trust, Rabby, Bitget). */
export const PHONE_WALLETS: readonly PhoneWallet[] = [
  { key: 'metamask', label: 'MetaMask', imageId: 'eebe4a7f-7166-402f-92e0-1f64ca2aa800', open: (u) => `https://link.metamask.io/dapp/${u.replace(/^https?:\/\//, '')}` },
  { key: 'okx', label: 'OKX Wallet', imageId: '45f2f08e-fc0c-4d62-3e63-404e72170500', open: (u) => `https://web3.okx.com/download?deeplink=${enc(`okx://wallet/dapp/url?dappUrl=${enc(u)}`)}` },
  { key: 'trust', label: 'Trust Wallet', imageId: '7677b54f-3486-46e2-4e37-bf8747814f00', open: (u) => `https://link.trustwallet.com/open_url?coin_id=60&url=${enc(u)}` },
  { key: 'bitget', label: 'Bitget', imageId: '2b569b7f-e6c6-4faa-8e5a-ecd4dec8cf00', open: (u) => `https://bkcode.vip?action=dapp&url=${enc(u)}` },
  { key: 'rabby', label: 'Rabby', imageId: '255e6ba2-8dfd-43ad-e88e-57cbb98f6800', open: null, pasteHint: "Open Rabby, tap its browser, and paste the link there." },
  { key: 'safepal', label: 'SafePal', imageId: '252753e7-b783-4e03-7f77-d39864530900', open: null, pasteHint: 'Open SafePal, go to its DApp browser, and paste the link into the search bar.' },
];

export const CONNECT_PARAM = 'vsConnect';

/** This page's address as the wallet should open it: the same page, asked to connect, without our own hash noise. */
export function pageForWallet(href: string, invite: string | null = pendingInvite()?.code ?? null): string {
  const u = new URL(href);
  // The wallet's browser has a storage of its own: the referral this one keeps goes along in the address.
  if (invite && !u.searchParams.has(INVITE_PARAM)) u.searchParams.set(INVITE_PARAM, invite);
  u.searchParams.set(CONNECT_PARAM, '1');
  return u.toString();
}

/** The address with the connect request taken off again, once it has been acted on. */
export function withoutConnectParam(href: string): string | null {
  const u = new URL(href);
  if (!u.searchParams.has(CONNECT_PARAM)) return null;
  u.searchParams.delete(CONNECT_PARAM);
  return u.pathname + (u.search ? u.search : '') + u.hash;
}

type Flags = Record<string, unknown>;

export interface WalletBrowser {
  /** Which wallet, when it says so; null for one we cannot name. */
  key: PhoneWalletKey | null;
  label: string;
}

/**
 * Is this page running inside a wallet's own browser? On a phone, any injected provider means yes - phone browsers
 * run no extensions - and the flags (or the user agent, where the wallet documents one) say which wallet. Desktop is
 * never a wallet browser here: an extension there is the dialog's ordinary "Installed" row.
 */
export function walletBrowser(win: { ethereum?: unknown; okxwallet?: unknown; bitkeep?: unknown; isSafePal?: unknown } | undefined, ua: string, phone: boolean): WalletBrowser | null {
  if (!win || !phone) return null;
  const eth = (win.ethereum && typeof win.ethereum === 'object' ? win.ethereum : null) as Flags | null;
  /* Documented markers first: OKX's user agent and window.okxwallet, Bitget's window.bitkeep, SafePal's user agent and
     window.isSafePal, Rabby's isRabby; Trust's isTrust flags and MetaMask's isMetaMask (which others copy) last. */
  if (/OKApp/i.test(ua) || win.okxwallet) return { key: 'okx', label: 'OKX Wallet' };
  if (win.bitkeep || eth?.isBitKeep === true || eth?.isBitgetWallet === true) return { key: 'bitget', label: 'Bitget' };
  if (/SafePal/.test(ua) || win.isSafePal === true || eth?.isSafePal === true) return { key: 'safepal', label: 'SafePal' };
  if (!eth) return null;
  if (eth.isRabby === true) return { key: 'rabby', label: 'Rabby' };
  if (eth.isTrust === true || eth.isTrustWallet === true) return { key: 'trust', label: 'Trust Wallet' };
  if (eth.isMetaMask === true) return { key: 'metamask', label: 'MetaMask' };
  return { key: null, label: 'your wallet' };
}

/** EIP-6963 names of the phone wallets (Reown explorer records), to pick the announced provider of the wallet we are in. */
export const PHONE_RDNS: Record<PhoneWalletKey, readonly string[]> = {
  metamask: ['io.metamask', 'io.metamask.mobile'],
  okx: ['com.okex.wallet'],
  trust: ['com.trustwallet.app'],
  bitget: ['com.bitget.web3'],
  rabby: ['io.rabby'],
  safepal: ['com.safepal'],
};

/*
 * A visitor who disconnected inside a wallet's browser is not connected again on the next load: that would make
 * Disconnect pointless there. Any later connect of theirs takes the mark off.
 */
const HERE_OFF_KEY = 'vs.wallet.hereOff';
const HERE_TRIED_KEY = 'vs.wallet.hereTried';

export function setHereOff(off: boolean): void {
  try {
    if (off) localStorage.setItem(HERE_OFF_KEY, '1');
    else localStorage.removeItem(HERE_OFF_KEY);
  } catch {
    /* no storage: this page only */
  }
}

/**
 * Should this load connect by itself? Inside a wallet's browser, not connected, the visitor has not disconnected
 * here before, and it has not been tried in this tab already (a refused prompt is not shown again on every load).
 * Marks the tab as tried when it answers yes.
 */
export function autoConnectHere(inWallet: boolean): boolean {
  if (!inWallet) return false;
  try {
    if (localStorage.getItem(HERE_OFF_KEY) === '1') return false;
    if (sessionStorage.getItem(HERE_TRIED_KEY) === '1') return false;
    sessionStorage.setItem(HERE_TRIED_KEY, '1');
  } catch {
    /* no storage: try once on this load */
  }
  return true;
}

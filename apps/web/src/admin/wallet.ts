/**
 * The builder wallet on the admin suite: connecting it and having it sign
 * (apps/server/src/admin/signIn.ts says what; admin/auth.ts checks it).
 *
 * A browser extension is found over EIP-6963 (../wallet.ts); a phone wallet
 * pairs over WalletConnect - the site's own Reown setup (../walletconnect.ts),
 * loaded only when chosen. The page never holds a key: it asks the wallet to sign
 * typed data and sends the signature.
 */
import { getChainId, signTypedData, type Eip1193Provider, type WalletInfo } from '../wallet';
import {
  ADMIN_SIGNATURE_TTL_MS, ADMIN_SIGN_IN_STATEMENT, adminActionTypedData, adminPayloadHash, adminSignInTypedData, summaryOf,
  type AdminAction, type AdminActionName, type AdminSignIn,
} from '@sign/admin/signIn';
import { call, saveSession, type AdminSession } from './api';

export interface Connected {
  provider: Eip1193Provider;
  address: string;
  name: string;
  /** How it connected: a WalletConnect pairing is ended when the owner changes wallet. */
  via?: 'extension' | 'walletconnect';
}

/** 16 random bytes as 32 hex characters: a signature's nonce. */
export const nonce = (): string => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

/** Signed messages live a little under the server's limit, so a slow wallet still lands inside it. */
const TTL = ADMIN_SIGNATURE_TTL_MS - 30_000;

export async function connectExtension(w: WalletInfo): Promise<Connected> {
  const accounts = (await w.provider.request({ method: 'eth_requestAccounts' })) as string[];
  const address = accounts?.[0];
  if (!address) throw new Error(`${w.name} gave no account.`);
  return { provider: w.provider, address: address.toLowerCase(), name: w.name, via: 'extension' };
}

/** What connectWalletConnect needs of ../walletconnect.ts (tests hand in a fake). */
export interface WalletConnectModule {
  /** AppKit; its open state tells a QR closed without a wallet. */
  initWallet: () => Promise<{ subscribeState?: (cb: (s: { open: boolean }) => void) => () => void }>;
  getWalletSnapshot: () => { status: string; provider: Eip1193Provider | null; address: string | null; walletName?: string | null };
  subscribeWallet: (cb: () => void) => () => void;
  disconnectWallet: () => Promise<void>;
  connectVia: (choice: 'walletconnect') => Promise<unknown>;
}

/**
 * Pair a wallet over WalletConnect: always a NEW pairing - the QR on a computer, the wallet list on a
 * phone (walletconnect.ts connectVia, as the site's own WalletConnect row). A session AppKit restored
 * (a phone paired before, a browser wallet it remembered) is ended first: taking it silently was
 * "connected and didn't pop up a QR" (owner, 2026-11-02), with no way to sign with another wallet.
 * Resolves once a wallet is connected.
 */
export async function connectWalletConnect(load: () => Promise<WalletConnectModule> = () => import('../walletconnect')): Promise<Connected> {
  const wc = await load();
  const kit = await wc.initWallet();
  if (wc.getWalletSnapshot().status === 'connected') await wc.disconnectWallet().catch(() => {});
  const ready = (): Connected | null => {
    const s = wc.getWalletSnapshot();
    return s.status === 'connected' && s.provider && s.address ? { provider: s.provider, address: s.address.toLowerCase(), name: s.walletName || 'WalletConnect', via: 'walletconnect' } : null;
  };
  return new Promise((resolve, reject) => {
    let unwatch: (() => void) | null = null;
    const end = () => {
      clearTimeout(timer);
      stop();
      unwatch?.();
    };
    const fail = (e: Error) => {
      end();
      reject(e);
    };
    const timer = setTimeout(() => fail(new Error('No wallet was connected.')), 5 * 60_000);
    const stop = wc.subscribeWallet(() => {
      const c = ready();
      if (!c) return;
      end();
      resolve(c);
    });
    wc.connectVia('walletconnect').then(
      () => {
        // The QR closed without a wallet: give the button back. A beat after the close, as AppKit
        // closes its dialog a moment before the account it connected reaches the snapshot.
        // connectVia resolves with the dialog already open, so the first closed state is the close.
        let closing = false;
        unwatch = kit.subscribeState?.((st) => {
          if (st.open || closing) return;
          closing = true;
          setTimeout(() => { if (!ready()) fail(new Error('WalletConnect was closed before a wallet connected.')); }, 2_000);
        }) ?? null;
      },
      (e: unknown) => fail(e instanceof Error ? e : new Error(String(e))),
    );
  });
}

/** Let go of a WalletConnect pairing (the sign-in's "Change wallet"); a browser wallet has nothing to end. */
export async function releaseWallet(c: Connected | null, load: () => Promise<WalletConnectModule> = () => import('../walletconnect')): Promise<void> {
  if (c?.via !== 'walletconnect') return;
  await (await load()).disconnectWallet().catch(() => {});
}

/** The fields every signed message shares. Its chain id is the wallet's own (some wallets refuse any other). */
async function timing(c: Connected): Promise<{ nonce: string; issuedAt: string; expiresAt: string; chainId: number }> {
  const chainId = await getChainId(c.provider).catch(() => 1);
  const t = Date.now();
  return { nonce: nonce(), issuedAt: String(t), expiresAt: String(t + TTL), chainId };
}

/** Sign in: the wallet's signature, then the password - both to the server, which opens a 24-hour session. */
export async function signIn(c: Connected, password: string): Promise<AdminSession> {
  const msg: Omit<AdminSignIn, 'signature'> = { owner: c.address, statement: ADMIN_SIGN_IN_STATEMENT, ...(await timing(c)) };
  const signature = await signTypedData(c.provider, c.address, adminSignInTypedData(msg));
  const r = await call<{ token: string; wallet: string; expiresAt: number }>('session', { signIn: { ...msg, signature }, password }, { anonymous: true });
  const s = { token: r.token, wallet: r.wallet, expiresAt: r.expiresAt };
  saveSession(s);
  return s;
}

/** One write's signature: this action on this target, over exactly this payload (what is then sent). */
export async function signAction(c: Connected, action: AdminActionName, target: string, payload: unknown, summary: string): Promise<AdminAction> {
  const msg: Omit<AdminAction, 'signature'> = {
    owner: c.address, action, target, summary: summaryOf(summary), payload: adminPayloadHash(payload), ...(await timing(c)),
  };
  const signature = await signTypedData(c.provider, c.address, adminActionTypedData(msg));
  return { ...msg, signature };
}

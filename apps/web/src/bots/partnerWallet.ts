/**
 * The hedge's second wallet, picked without touching the wallet this page is connected with (owner 2026-11-15:
 * "dont get anything in my wallet app from choose another account, cant we qr code, browser or something").
 *
 *   QR       a separate WalletConnect pairing (its own storage prefix, so the page's own session is never touched):
 *            the phone wallet scans it, approves, and the address is read. The pairing is closed right after: it is
 *            only how the address arrives, never a second signer.
 *   browser  another wallet extension in this browser (EIP-6963 discovery): asked for its account directly.
 *
 * Either gives an address only. Leg 2 is still signed by that wallet itself (HedgeInvites).
 */
import { discoverWallets, getDiscoveredWallets, isUserRejection, type WalletInfo } from '../wallet';
import { WC_PROJECT_ID, hasWalletConnectConfig } from '../walletconnect';

export const canPairByQr = (): boolean => hasWalletConnectConfig();

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const accountOf = (caip: unknown): string | null => {
  const a = typeof caip === 'string' ? caip.split(':').pop() ?? '' : '';
  return ADDRESS.test(a) ? a.toLowerCase() : null;
};

export interface QrPairing {
  /** Resolves with the address the phone wallet approved (null: closed or refused). */
  address: Promise<string | null>;
  /** Stop waiting and drop the pairing. */
  cancel: () => void;
}

/** Start a pairing: `onUri` gets the wc: link to draw as a QR (and to open on a phone). */
export async function pairByQr(onUri: (uri: string) => void): Promise<QrPairing> {
  const { default: UniversalProvider } = await import('@walletconnect/universal-provider');
  const provider = await UniversalProvider.init({
    projectId: WC_PROJECT_ID,
    customStoragePrefix: 'vd-hedge-leg2',
    metadata: {
      name: 'ValueDesk',
      description: 'The second wallet of a hedge: its address only',
      url: window.location.origin,
      icons: [window.location.origin + '/favicon.svg'],
    },
  });
  let done = false;
  const close = () => { if (provider.session) void provider.disconnect().catch(() => undefined); };
  provider.on('display_uri', (uri: string) => { if (!done) onUri(uri); });
  const address = provider
    .connect({ optionalNamespaces: { eip155: { methods: ['personal_sign'], chains: ['eip155:1'], events: ['accountsChanged'] } } })
    .then((session) => {
      const accounts = (session?.namespaces?.eip155?.accounts ?? []) as string[];
      return accounts.map(accountOf).find((a): a is string => a !== null) ?? null;
    })
    .catch(() => null)
    .finally(() => { done = true; close(); });
  return { address, cancel: () => { done = true; close(); try { provider.abortPairingAttempt?.(); } catch { /* gone */ } } };
}

/** The wallet extensions this browser announced (EIP-6963), discovery asked again first. */
export function browserWallets(): WalletInfo[] {
  discoverWallets();
  return getDiscoveredWallets();
}

/** Ask one extension for its account. Null: refused or none. */
export async function accountFrom(w: WalletInfo): Promise<string | null> {
  try {
    const xs = (await w.provider.request({ method: 'eth_requestAccounts' })) as unknown;
    const list = Array.isArray(xs) ? xs.map(accountOf).filter((a): a is string => a !== null) : [];
    return list[0] ?? null;
  } catch (e) {
    if (isUserRejection(e)) return null;
    return null;
  }
}

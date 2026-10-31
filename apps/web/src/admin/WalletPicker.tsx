/** Choose the builder wallet: a browser extension (EIP-6963) or a phone over WalletConnect. */
import { createContext, useContext, useEffect, useState } from 'react';
import { discoverWallets, isUserRejection, onWallets, type WalletInfo } from '../wallet';
import { connectExtension, connectWalletConnect, type Connected } from './wallet';

export function WalletPicker({ onConnected, wantAddress }: { onConnected: (c: Connected) => void; wantAddress?: string }) {
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const off = onWallets(setWallets);
    discoverWallets();
    return off;
  }, []);
  const pick = async (id: string, connect: () => Promise<Connected>) => {
    setBusy(id);
    setError(null);
    try {
      const c = await connect();
      if (wantAddress && c.address !== wantAddress.toLowerCase()) throw new Error(`That is ${c.address}; this session belongs to ${wantAddress}. Switch to it in your wallet.`);
      onConnected(c);
    } catch (e) {
      setError(isUserRejection(e) ? 'You declined in the wallet.' : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="ad-wallets">
      {wallets.map((w) => (
        <button key={w.uuid} type="button" className="ad-wallet" disabled={!!busy} onClick={() => void pick(w.uuid, () => connectExtension(w))}>
          {w.icon ? <img src={w.icon} alt="" width={20} height={20} /> : <span className="ad-wallet__dot" />}
          <span>{busy === w.uuid ? 'Waiting for the wallet…' : w.name}</span>
        </button>
      ))}
      <button type="button" className="ad-wallet" disabled={!!busy} onClick={() => void pick('wc', connectWalletConnect)}>
        <span className="ad-wallet__dot" />
        <span>{busy === 'wc' ? 'Waiting for WalletConnect…' : 'WalletConnect (phone wallet)'}</span>
      </button>
      {!wallets.length && <p className="ad-dim">No browser wallet found on this page. Install or unlock one, or use WalletConnect.</p>}
      {error && <p className="ad-error" role="alert">{error}</p>}
    </div>
  );
}

/** The connected builder wallet, and a way to get it when a write needs a signature. */
export interface WalletCtx {
  connected: Connected | null;
  /** The connected wallet, asking for it first if there is none. Rejects when the owner closes the picker. */
  ensure: () => Promise<Connected>;
}

export const WalletContext = createContext<WalletCtx>({ connected: null, ensure: () => Promise.reject(new Error('no wallet')) });
export const useWallet = (): WalletCtx => useContext(WalletContext);

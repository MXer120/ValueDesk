/**
 * Advanced key options, in a small modal of its own. Reached from the navbar's
 * address menu ("Advanced…") - never from Connect.
 *
 * Trading keys live in the browser now (trading/session.ts), so what is left
 * to manage is small and all of it is visible here:
 *   - the key THIS browser trades with: its name, address, expiry, the builder
 *     fee it approved, and whether it is kept on this device;
 *   - every key registered on the SoDEX account, from any device or app - key
 *     names and addresses are public on SoDEX, so this is a plain read;
 *   - revoking this browser's key on SoDEX, which also turns trading off here.
 *
 * There is no import and no server keystore: no Valuescan server holds a key,
 * and pasting a private key into a web page is not something to encourage.
 */
import { useEffect, useState } from 'react';
import { api, type SessionInfo, type WalletAccount } from '../../api';
import { useStatus } from '../../hooks';
import { WalletError, type Eip1193Provider } from '../../wallet';
import { WalletConnectError } from '../../walletconnect';
import { disableTrading, getTradingState, subscribeTrading, type TradingState } from '../../trading/session';
import { Modal } from '../Modal';
import { LoadFailed, logLoadFailure } from '../LoadFailed';
import './account.css';

interface Props {
  open: boolean;
  onClose: () => void;
  address: string | null;
  provider: Eip1193Provider | null;
  walletName: string;
  session: SessionInfo | null;
  onSession: () => void;
}

export function AdvancedKeysModal({ open, onClose, ...rest }: Props) {
  return (
    <Modal open={open} title="Advanced key options" size="md" onClose={onClose}>
      {/* Mounted only while open: the key list below is a venue call. */}
      {open && <AdvancedKeys {...rest} />}
    </Modal>
  );
}

const isRejection = (e: unknown): boolean =>
  (e instanceof WalletError || e instanceof WalletConnectError) && /reject|denied|cancel/i.test(e.message);

const when = (ms: number | null | undefined): string => {
  if (!ms) return 'never';
  const d = new Date(ms);
  const left = ms - Date.now();
  const h = Math.floor(left / 3_600_000);
  const m = Math.floor((left % 3_600_000) / 60_000);
  return `${d.toLocaleString()} (${left <= 0 ? 'expired' : h > 0 ? `in ${h} h ${m} min` : `in ${m} min`})`;
};

function AdvancedKeys({ address, provider, walletName, onSession }: Omit<Props, 'open' | 'onClose'>) {
  const [t, setT] = useState<TradingState>(getTradingState());
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const { msg, show, fromError } = useStatus();
  /** The key list's read failed; bumping `attempt` asks again. */
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => subscribeTrading(() => setT(getTradingState())), []);

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    setLoadFailed(false);
    api
      .walletAccount(address)
      .then((a) => {
        if (!cancelled) setAccount(a);
      })
      .catch((e) => {
        if (cancelled) return;
        logLoadFailure('API keys', e);
        setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [address, t.keyName, attempt]);

  const revoke = async () => {
    if (!provider) {
      show('info', 'Reconnect your wallet to sign the revocation.');
      return;
    }
    setBusy(true);
    try {
      show('info', `Approve two signatures in ${walletName || 'your wallet'} (one per SoDEX engine).`, 0);
      await disableTrading({ revoke: true, provider, chainParams: () => api.depositChain() });
      onSession();
      show('ok', 'Revoked on SoDEX and removed from this device.');
    } catch (e) {
      if (isRejection(e)) show('info', 'Trading is off on this device; the key was not revoked on SoDEX.');
      else fromError(e);
    } finally {
      setBusy(false);
    }
  };

  const mine = t.status === 'enabled' ? t : null;
  const keys = account?.apiKeys ?? [];

  return (
    <div className="stack acct-adv">
      <section className="stack">
        <h4>This browser</h4>
        {mine ? (
          <dl className="kv small">
            <dt>Key</dt>
            <dd className="mono">{mine.keyName}</dd>
            <dt>Address</dt>
            <dd className="mono">{mine.keyAddress}</dd>
            <dt>Expires</dt>
            <dd>{when(mine.expiresAt)}</dd>
            <dt>Kept on this device</dt>
            <dd>{mine.remembered ? 'yes, sealed, until it expires' : 'no, this tab only'}</dd>
            <dt>Builder fee approved</dt>
            <dd>
              {mine.builder
                ? `up to ${(mine.builder.maxFeeRate / 1000).toFixed(3)}% per order, builder account ${mine.builder.id}`
                : 'none'}
            </dd>
          </dl>
        ) : (
          <p className="muted small">
            {t.status === 'expired' ? t.reason : 'Trading is not enabled in this browser.'}
          </p>
        )}
        {mine && (
          <div className="row wrap">
            <button className="danger" disabled={busy} onClick={() => void revoke()}>
              Revoke on SoDEX and turn off
            </button>
          </div>
        )}
      </section>

      <section className="stack">
        <h4>All keys on this SoDEX account</h4>
        {!address ? (
          <p className="muted small">Connect a wallet to see its keys.</p>
        ) : !account && loadFailed ? (
          <LoadFailed what="API keys" onRetry={() => setAttempt((n) => n + 1)} />
        ) : !account ? (
          <p className="muted small">Loading…</p>
        ) : !account.exists ? (
          <p className="muted small">This wallet has no SoDEX account yet. SoDEX creates it with the first deposit.</p>
        ) : keys.length === 0 ? (
          <p className="muted small">No API keys are registered.</p>
        ) : (
          <table className="small">
            <thead>
              <tr>
                <th>Name</th>
                <th>Address</th>
                <th>Expires</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.name}>
                  <td className="mono">
                    {k.name}
                    {mine && k.name === mine.keyName ? ' (this browser)' : ''}
                  </td>
                  <td className="mono">{k.publicKey}</td>
                  <td>{k.expiresAt ? new Date(k.expiresAt).toLocaleString() : 'never'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">
          Key names and addresses are public on SoDEX. Keys from other devices or apps are revoked where they were
          created, or on sodex.com.
        </p>
      </section>

      {msg && <p className={`status ${msg.kind}`}>{msg.text}</p>}
    </div>
  );
}

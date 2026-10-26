/**
 * Advanced key options, in a small modal of its own - never part of Connect.
 * It opens on the `wallet:advanced` event (account/actions.ts requestAdvanced).
 * In a build with a builder fee, the order ticket's "Valuescan fee" line and
 * the fee panel fire it, so the approval can always be seen and revoked.
 *
 * Trading keys live in the browser now (trading/session.ts), so what is left
 * to manage is small and all of it is visible here:
 *   - the key THIS browser trades with: its name, address, expiry, the builder
 *     fee it approved, and whether it is kept on this device;
 *   - every key registered on the SoDEX account, from any device or app - key
 *     names and addresses are public on SoDEX, so this is a plain read;
 *   - revoking this browser's key on SoDEX, which also turns trading off here;
 *   - the builder-fee approval, when the build configures a builder: what SoDEX
 *     lists for this ACCOUNT per engine (it is not part of any key);
 *     "Revoke builder approval" - one wallet signature for a maximum of 0; and,
 *     while SoDEX lists no approval that covers what the build charges,
 *     "Approve builder fee" - the same disclosure and the same one signature as
 *     when enabling trading (for whoever enabled without it, or holds a key
 *     from before the build had a builder).
 *
 * There is no import and no server keystore: no Valuescan server holds a key,
 * and pasting a private key into a web page is not something to encourage.
 */
import { useEffect, useState } from 'react';
import { api, type SessionInfo, type WalletAccount } from '../../api';
import { useStatus } from '../../hooks';
import { WalletError, type Eip1193Provider } from '../../wallet';
import { WalletConnectError } from '../../walletconnect';
import { activeBuilder, fmtBuilderRate, fullyApproved, ratesOf, type BuilderApproval, type BuilderTerms } from '../../trading/builder';
import { tradingConfig } from '../../trading/config';
import {
  approveBuilderFee,
  disableTrading,
  getTradingState,
  readBuilderApproval,
  refreshBuilderApproval,
  revokeBuilderApproval,
  subscribeTrading,
  type BuilderChoice,
  type TradingState,
} from '../../trading/session';
import { logger } from '../../log';
import { Modal } from '../Modal';
import { DlgRow, DlgSection } from '../dialogParts';
import { LoadFailed, logLoadFailure } from '../LoadFailed';
import './account.css';
import { NoWallet } from '../EmptyState';

interface Props {
  open: boolean;
  onClose: () => void;
  address: string | null;
  provider: Eip1193Provider | null;
  walletName: string;
  session: SessionInfo | null;
  onSession: () => void;
  /** The builder-fee disclosure (BuilderConsent.tsx); without it nothing can be approved from here. */
  confirmBuilderFee?: (terms: BuilderTerms) => Promise<BuilderChoice>;
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

const log = logger('trade');

/** "perps up to 0.05%, spot up to 0.1% of a fill, builder account 123" - per engine, as SoDEX lists it. */
function describeApproval(a: BuilderApproval): string {
  const parts = (['perps', 'spot'] as const)
    .filter((e) => a.engines?.[e] !== undefined)
    .map((e) => `${e} up to ${fmtBuilderRate(a.engines[e]!)}`);
  if (!parts.length) return 'none';
  return `${parts.join(', ')} of a fill, builder account ${a.id}`;
}

const when = (ms: number | null | undefined): string => {
  if (!ms) return 'never';
  const d = new Date(ms);
  const left = ms - Date.now();
  const h = Math.floor(left / 3_600_000);
  const m = Math.floor((left % 3_600_000) / 60_000);
  return `${d.toLocaleString()} (${left <= 0 ? 'expired' : h > 0 ? `in ${h} h ${m} min` : `in ${m} min`})`;
};

function AdvancedKeys({ address, provider, walletName, onSession, confirmBuilderFee }: Omit<Props, 'open' | 'onClose'>) {
  const [t, setT] = useState<TradingState>(getTradingState());
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const { msg, show, fromError } = useStatus();
  /** The key list's read failed; bumping `attempt` asks again. */
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  /**
   * The account's builder approval as SoDEX lists it right now - read here so
   * it can be seen and revoked with trading off too. `undefined`: not read
   * (no builder configured, or no answer yet).
   */
  const [listed, setListed] = useState<BuilderApproval | null | undefined>(undefined);
  const builder = activeBuilder(tradingConfig().builder);
  const builderConfigured = !!builder;

  useEffect(() => subscribeTrading(() => setT(getTradingState())), []);

  /* A key in this browser for this wallet: the session follows the same answer, so orders and this view agree. */
  const enabledHere = t.status === 'enabled' && !!address && t.owner === address.toLowerCase();
  useEffect(() => {
    if (!address || !builderConfigured) {
      setListed(undefined);
      return;
    }
    let cancelled = false;
    (enabledHere ? refreshBuilderApproval() : readBuilderApproval(address))
      .then((a) => {
        if (!cancelled) setListed(a);
      })
      .catch((e) => {
        // Unknown is shown as unknown: the row falls back to what the key remembers.
        log.debug('builder approval could not be read for the key view', { error: String(e) });
        if (!cancelled) setListed(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [address, builderConfigured, enabledHere, t.keyName, attempt]);

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
  /* What SoDEX lists wins over what the key remembers; with no builder configured only the key's record exists. */
  const approval: BuilderApproval | null = listed !== undefined ? listed : (mine?.builder ?? null);
  const approved = !!approval && describeApproval(approval) !== 'none';
  /* Offered only on SoDEX's own answer (never on a guess): the build charges a fee this account's listing does not cover. */
  const canApprove = !!builder && !!confirmBuilderFee && !!address && listed !== undefined && !fullyApproved(builder, ratesOf(listed));

  const approveBuilder = async () => {
    if (!address || !confirmBuilderFee) return;
    if (!provider) {
      show('info', 'Reconnect your wallet to sign the approval.');
      return;
    }
    setBusy(true);
    try {
      const r = await approveBuilderFee({
        owner: address,
        provider,
        confirmBuilderFee,
        onStep: () => show('info', `Approve one signature in ${walletName || 'your wallet'}: it sets your maximum builder fee.`, 0),
      });
      setListed(r.approval);
      setAttempt((n) => n + 1);
      onSession();
      if (r.status === 'declined') show('info', 'Nothing was approved.');
      else if (r.status === 'already') show('info', 'SoDEX already lists your approval.');
      else if (r.status === 'pending') show('info', 'SoDEX accepted the approval but does not list it on every engine yet. It is followed up automatically; look again in a moment.');
      else show('ok', 'Builder fee approved. Orders placed here carry the ValueDesk fee.');
    } catch (e) {
      if (isRejection(e)) show('info', 'Nothing was approved: the signature was declined.');
      else fromError(e);
    } finally {
      setBusy(false);
    }
  };

  const revokeBuilder = async () => {
    if (!address) return;
    if (!provider) {
      show('info', 'Reconnect your wallet to sign the revocation.');
      return;
    }
    setBusy(true);
    try {
      show('info', `Approve one signature in ${walletName || 'your wallet'}: it sets your maximum builder fee to 0.`, 0);
      const r = await revokeBuilderApproval({ owner: address, provider, builderId: approval?.id });
      setListed(r.cleared ? null : undefined);
      setAttempt((n) => n + 1);
      onSession();
      if (r.nothingToRevoke) show('info', 'SoDEX lists no builder approval for this account.');
      else if (!r.cleared) show('info', 'SoDEX accepted the revocation but still lists the approval. Orders placed here no longer carry the fee; look again in a moment.');
      else if (r.tradingTurnedOff) show('ok', 'Builder approval revoked. Trading through ValueDesk requires it, so trading is now off on this device.');
      else show('ok', 'Builder approval revoked. Orders placed here no longer carry the ValueDesk fee.');
    } catch (e) {
      if (isRejection(e)) show('info', 'Nothing was revoked: the signature was declined.');
      else fromError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="acct-adv dlg">
      <DlgSection label="This browser">
        {mine ? (
          <>
            <DlgRow title="Key" line={<span className="mono acct-adv__v">{mine.keyName}</span>} />
            <DlgRow title="Address" line={<span className="mono acct-adv__v">{mine.keyAddress}</span>} />
            <DlgRow title="Expires" line={when(mine.expiresAt)} />
            <DlgRow title="Kept on this device" line={mine.remembered ? 'yes, sealed, until it expires' : 'no, this tab only'} />
            <DlgRow title="Builder fee approved" line={approved ? describeApproval(approval!) : 'none'} />
          </>
        ) : (
          <p className="dlg-note">
            {t.status === 'expired' ? t.reason : 'Trading is not enabled in this browser.'}
          </p>
        )}
        {/* With trading off there is no key row to carry it: the account's approval is stated on its own. */}
        {!mine && approved && (
          <p className="dlg-note">Builder fee approved on this SoDEX account: {describeApproval(approval!)}.</p>
        )}
      </DlgSection>
      {(mine || approved || canApprove) && (
        <DlgSection label="Actions">
          {canApprove && (
            <DlgRow
              title="Approve builder fee"
              line="Shows what the fee is, then asks your wallet for one signature that sets your maximum builder fee for the ValueDesk builder account."
            >
              <button type="button" className="dlg-btn is-go" disabled={busy} onClick={() => void approveBuilder()}>
                Approve builder fee
              </button>
            </DlgRow>
          )}
          {approved && (
            <DlgRow
              title="Revoke builder approval"
              line="Your wallet signs one message that sets your maximum builder fee for this builder account to 0. The approval belongs to your SoDEX account, not to this browser's key."
            >
              <button type="button" className="dlg-btn" disabled={busy} onClick={() => void revokeBuilder()}>
                Revoke builder approval
              </button>
            </DlgRow>
          )}
          {mine && (
            <DlgRow title="Turn trading off" line="Revokes this browser's key on SoDEX and removes it from this device.">
              <button type="button" className="dlg-btn is-danger" disabled={busy} onClick={() => void revoke()}>
                Revoke on SoDEX and turn off
              </button>
            </DlgRow>
          )}
        </DlgSection>
      )}
      {approved && (
        <p className="dlg-note">
          The builder fee is charged by SoDEX on each fill of an order placed here (not on spot buys), on top of its
          own fee, up to the maximum above. Revoking it stops it for every order placed after that.
        </p>
      )}
      {canApprove && (
        <p className="dlg-note">
          {approved
            ? 'SoDEX does not list an approval that covers the ValueDesk builder fee on every market.'
            : 'SoDEX lists no approval of the ValueDesk builder fee for this account.'}{' '}
          {builder!.required
            ? 'Trading through ValueDesk requires it: orders placed here are refused until it is approved.'
            : 'Orders placed here carry no builder fee where it is not approved.'}
        </p>
      )}

      <section className="stack acct-adv__keys">
        <div className="dlg-label"><span>All keys on this SoDEX account</span></div>
        {!address ? (
          <NoWallet line="Connect a wallet to see its keys." compact />
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

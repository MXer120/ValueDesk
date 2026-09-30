/**
 * The one owner of account ACTIONS, mounted once in App.tsx.
 *
 * Connect is OUR Connect dialog (ConnectDialog.tsx, mounted here), which hands
 * off to AppKit only after a row in it is pressed. What the old wallet sheet did
 * besides connecting - enable trading, turn it off, the advanced key options -
 * is triggered from wherever the user is (address menu, order ticket, status
 * footer) by window event, and runs here: this component holds the confirm
 * dialog, the advanced-keys modal, the Connect dialog and the "waiting for your
 * wallet" state, so there is exactly one of each whichever button was pressed.
 *
 * THE ENABLE-TRADING FLOW runs in this browser (trading/session.ts): one click,
 * then one wallet signature - no dialog in between and no network switch. A
 * fresh trading key is generated here, the wallet signs one EIP-712 message
 * registering it on the user's SoDEX account (exactly what sodex.com does for
 * its own web key), and the key is kept on this device, sealed, until it
 * expires. The wallet's own private key is never read, and no Valuescan server
 * ever holds a key that can trade. A wallet with no SoDEX account yet gets the
 * Deposit sheet (funds/DepositModal.tsx) instead - its first deposit opens the account.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type SessionInfo } from '../../api';
import { useConfirm } from '../Modal';
import { notify, notifyError } from '../../toast';
import { WalletError, type Eip1193Provider } from '../../wallet';
import {
  TradingError,
  disableTrading as disableTradingInBrowser,
  enableTrading as enableTradingInBrowser,
} from '../../trading/session';
import { WalletConnectError } from '../../walletconnect';
import { WALLET_EVENTS, getAccountPending, setAccountPending, type TransferPreset } from './actions';
import { AdvancedKeysModal } from './AdvancedKeys';
import { ConnectDialog } from './ConnectDialog';
import { DepositModal } from '../funds/DepositModal';
import { WithdrawModal } from '../funds/WithdrawModal';
import { TransferModal } from '../funds/TransferModal';
import { openConnectDialog } from './connect';
import { useWalletSnapshot } from './useWallet';

interface Props {
  address: string | null;
  provider: Eip1193Provider | null;
  session: SessionInfo | null;
  onSession: () => void;
}

/** A rejected prompt is a decision, not a fault: say nothing. */
const isRejection = (e: unknown): boolean =>
  (e instanceof WalletError || e instanceof WalletConnectError) && /reject|denied|cancel/i.test(e.message);

export function AccountController({ address, provider, session, onSession }: Props) {
  const { confirm, dialog } = useConfirm();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const wallet = useWalletSnapshot();

  /* The handlers are bound to window once; they read the latest props here. */
  const latest = useRef({ address, provider, session, onSession, walletName: wallet.walletName });
  latest.current = { address, provider, session, onSession, walletName: wallet.walletName };

  /* The same action the navbar's Connect button runs: OUR Connect dialog. */
  const connect = useCallback(() => openConnectDialog(), []);

  const [depositOpen, setDepositOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  /** The one source the address menu's Perps / Spot button asked to withdraw from (null: all). */
  const [withdrawFrom, setWithdrawFrom] = useState<'spot' | 'perps' | null>(null);
  const [withdrawCoin, setWithdrawCoin] = useState<string | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferPreset, setTransferPreset] = useState<TransferPreset | null>(null);

  /**
   * The whole enablement flow: one click, one wallet signature, all in this
   * browser (trading/session.ts) - no dialog in between, no network switch.
   * A wallet SoDEX has never seen goes to Create account instead.
   * Resolves true once trading is on.
   */
  const enableTrading = useCallback(async (): Promise<boolean> => {
    const { address: addr, provider: p, walletName } = latest.current;
    if (getAccountPending()) return false;
    if (!addr) {
      void connect();
      return false;
    }
    if (!p) {
      notify('info', 'Reconnect your wallet to enable trading.');
      void connect();
      return false;
    }
    setAccountPending('enable');
    try {
      notify('info', `Approve the signature in ${walletName || 'your wallet'} - it lets this browser trade for you.`);
      await enableTradingInBrowser({ owner: addr, provider: p, remember: true });
      notify('ok', 'Trading enabled. You can place and cancel orders.');
      latest.current.onSession();
      return true;
    } catch (e) {
      if (isRejection(e)) return false;
      if (e instanceof TradingError && e.kind === 'no-account') {
        setDepositOpen(true);
        return false;
      }
      if (e instanceof TradingError && (e.kind === 'writes-off' || e.kind === 'disabled')) {
        notify('info', e.message);
        return false;
      }
      notifyError('Enable trading', e, () => { void enableTrading(); });
      return false;
    } finally {
      setAccountPending(null);
    }
  }, [connect]);

  const disableTrading = useCallback(async () => {
    if (getAccountPending()) return;
    const revoke = { current: false };
    const ok = await confirm({
      title: 'Turn off trading on this device',
      danger: true,
      confirmLabel: 'Turn off trading',
      cancelLabel: 'Keep trading enabled',
      body: (
        <div className="stack">
          <p>Deletes the trading key from this browser. Orders stop working here until you enable trading again.</p>
          <label className="row small">
            <input
              type="checkbox"
              onChange={(e) => {
                revoke.current = e.target.checked;
              }}
            />{' '}
            Also revoke it on SoDEX (your wallet signs twice, on ValueChain)
          </label>
          <p className="muted small">
            Without revoking, the key stays valid on SoDEX until it expires. Revoke if you think a copy of it could exist
            anywhere else.
          </p>
        </div>
      ),
    });
    if (!ok) return;
    setAccountPending('disable');
    try {
      await disableTradingInBrowser({
        revoke: revoke.current,
        provider: latest.current.provider ?? undefined,
        chainParams: () => api.depositChain(),
      });
      latest.current.onSession();
      notify('info', revoke.current ? 'Trading key revoked on SoDEX and removed from this device.' : 'Trading turned off on this device.');
    } catch (e) {
      if (isRejection(e)) {
        notify('info', 'Trading turned off on this device. The key was not revoked on SoDEX.');
        return;
      }
      notifyError('Turn off trading', e);
    } finally {
      setAccountPending(null);
    }
  }, [confirm]);

  /**
   * Sign out: this browser stops holding a trading key (deleted locally - no
   * signature, nothing sent; the key also expires on SoDEX within 7 days), then
   * the wallet is dropped. Signing back in asks for Enable trading again, which
   * is what "signed out" should mean on a shared machine.
   */
  const signOut = useCallback(async () => {
    try {
      await disableTradingInBrowser();
    } catch {
      /* the key is dropped in disableTrading's finally regardless */
    }
    window.dispatchEvent(new CustomEvent(WALLET_EVENTS.disconnect));
    notify('info', 'Signed out. This browser no longer holds a trading key.');
  }, []);

  useEffect(() => {
    const detail = (e: Event): Record<string, unknown> | null => {
      const d = (e as CustomEvent).detail;
      return d && typeof d === 'object' ? (d as Record<string, unknown>) : null;
    };
    const on: Array<[string, (e: Event) => void]> = [
      [WALLET_EVENTS.connect, () => { void connect(); }],
      [WALLET_EVENTS.enableTrading, () => { void enableTrading(); }],
      [WALLET_EVENTS.createAccount, () => setDepositOpen(true)],
      [WALLET_EVENTS.deposit, () => setDepositOpen(true)],
      [WALLET_EVENTS.withdraw, (e) => {
        const d = detail(e);
        const from = d?.from;
        const coin = d?.coin;
        setWithdrawFrom(from === 'spot' || from === 'perps' ? from : null);
        setWithdrawCoin(typeof coin === 'string' ? coin : null);
        setWithdrawOpen(true);
      }],
      [WALLET_EVENTS.transfer, (e) => {
        setTransferPreset(detail(e) as TransferPreset | null);
        setTransferOpen(true);
      }],
      [WALLET_EVENTS.disableTrading, () => { void disableTrading(); }],
      [WALLET_EVENTS.advanced, () => setAdvancedOpen(true)],
      [WALLET_EVENTS.signOut, () => { void signOut(); }],
    ];
    for (const [name, fn] of on) window.addEventListener(name, fn);
    return () => {
      for (const [name, fn] of on) window.removeEventListener(name, fn);
    };
  }, [connect, enableTrading, disableTrading, signOut]);

  return (
    <>
      {dialog}
      <AdvancedKeysModal
        open={advancedOpen}
        onClose={() => setAdvancedOpen(false)}
        address={address}
        provider={provider}
        walletName={wallet.walletName}
        session={session}
        onSession={onSession}
      />
      <ConnectDialog />
      <DepositModal
        open={depositOpen}
        onClose={() => setDepositOpen(false)}
        address={address}
        provider={provider}
        walletName={wallet.walletName}
        onEnable={enableTrading}
      />
      <WithdrawModal
        open={withdrawOpen}
        onClose={() => setWithdrawOpen(false)}
        address={address}
        provider={provider}
        onEnable={enableTrading}
        initialFrom={withdrawFrom}
        initialCoin={withdrawCoin}
      />
      <TransferModal
        open={transferOpen}
        onClose={() => setTransferOpen(false)}
        address={address}
        provider={provider}
        onEnable={enableTrading}
        preset={transferPreset}
      />
    </>
  );
}

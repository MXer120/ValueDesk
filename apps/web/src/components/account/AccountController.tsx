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
 * expires. The wallet's own private key is never read, and no ValueDesk server
 * ever holds a key that can trade. A wallet with no SoDEX account yet gets the
 * Deposit sheet (funds/DepositModal.tsx) instead - its first deposit opens the account.
 *
 * THE TERMS COME FIRST (legal/acceptance.ts, trading/legalGate.ts): a wallet that
 * has not signed the current Terms of use and Risk disclosure signs them - with
 * the country its connection comes from - in the terms popup (requireTerms), before its key
 * is registered; a wallet on a
 * sanctions list, or a sanctioned place, gets nothing; a close-only place
 * (the US, the UK, Canada) may enable trading to close positions. A refused opening order asks
 * for the signature here too (SIGN_TERMS_EVENT).
 *
 * WITH A BUILDER FEE CONFIGURED (trading/config.ts; off by default) there is one
 * dialog in between, and only the first time: when SoDEX does not already list
 * the account's approval, BuilderConsent.tsx discloses the fee and asks, and a
 * yes adds ONE wallet signature before the key's. Without a configured builder
 * none of that code runs and the flow is exactly the one above.
 */
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { api, type SessionInfo } from '../../api';
import { useConfirm } from '../Modal';
import { notify, notifyError } from '../../toast';
import { WalletError, type Eip1193Provider } from '../../wallet';
import { activeBuilder } from '../../trading/builder';
import { tradingConfig } from '../../trading/config';
import {
  TradingError,
  disableTrading as disableTradingInBrowser,
  enableTrading as enableTradingInBrowser,
} from '../../trading/session';
import { WalletConnectError } from '../../walletconnect';
import { WALLET_EVENTS, getAccountPending, setAccountPending, type TransferPreset } from './actions';
import { useBuilderConsent } from './BuilderConsent';
import { BuilderTermsFollower } from './BuilderTermsFollower';
import { ConnectDialog } from './ConnectDialog';
import { openConnectDialog } from './connect';
import { useWalletSnapshot } from './useWallet';
import { recordPendingSiteTerms, requireTerms } from '../../legal/acceptance';
import { SANCTIONED_WALLET_REASON, screenWallet } from '../../legal/screening';
import { LOCATION_UNKNOWN } from '../../legal/geo';
import { SIGN_TERMS_EVENT, legalStateFor } from '../../trading/legalGate';
import { lazyPage } from '../../lazyPage';
import { startLater } from '../../startLater';

/*
 * THE MONEY SHEETS ARRIVE JUST AFTER THE FIRST PAINT.
 *
 * Deposit, Withdraw, Transfer and the advanced key options are closed on every
 * load, and their code was about a seventh of the entry script. It is fetched
 * in idle time a moment after the page has painted, and at once when a sheet is
 * asked for before that. A sheet is mounted only once its code is in (or once
 * it is opened): closed it renders nothing, so mounting it later shows nothing
 * different, and an open one plays the same entrance either way. lazyPage.ts
 * keeps a loaded sheet rendering synchronously, without a Suspense frame.
 */
const DepositModal = lazyPage('deposit', () => import('../funds/DepositModal').then((m) => m.DepositModal));
const WithdrawModal = lazyPage('withdraw', () => import('../funds/WithdrawModal').then((m) => m.WithdrawModal));
const TransferModal = lazyPage('transfer', () => import('../funds/TransferModal').then((m) => m.TransferModal));
const AdvancedKeysModal = lazyPage('advanced keys', () => import('./AdvancedKeys').then((m) => m.AdvancedKeysModal));
const fetchSheets = startLater(
  () => {
    for (const sheet of [DepositModal, WithdrawModal, TransferModal, AdvancedKeysModal]) sheet.preload().catch(() => {});
  },
  1_500,
  2_000,
);

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
  /* The builder-fee disclosure (only ever opened by a build that configures a builder). */
  const builderConsent = useBuilderConsent();
  const askBuilderFee = builderConsent.ask;
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
  useEffect(() => fetchSheets.arm(), []);

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
    /* The legal gate first (trading/legalGate.ts): a wallet on a sanctions list or a
       sanctioned place gets nothing; in an open place the wallet signs the current
       terms before its key is registered. A close-only place may enable trading -
       to close positions, cancel orders and withdraw - without them. */
    if ((await screenWallet(addr)) === 'sanctioned') {
      notify('error', SANCTIONED_WALLET_REASON);
      return false;
    }
    const legalNow = legalStateFor(addr);
    if (legalNow.access.level === 'blocked') {
      notify('error', legalNow.access.reason ?? 'ValueDesk is not available here.');
      return false;
    }
    if (legalNow.access.level === 'close-only') notify('warn', legalNow.access.reason ?? 'Only closing is possible from here.');
    // The country could not be told (legal/geo.ts): enabled to close only, like a close-only place - no wallet signs the terms without a country.
    else if (legalNow.located === false) notify('warn', LOCATION_UNKNOWN);
    // The terms popup as a gate (legal/LegalGate.tsx): accepted - and signed by this wallet where it may trade.
    // Close-only: trading is enabled only to close, which never waits for the terms.
    if (legalNow.access.level === 'open' && legalNow.located !== false && !(await requireTerms({ owner: addr, reason: 'enable trading' }))) return false;
    setAccountPending('enable');
    try {
      const where = walletName || 'your wallet';
      const keyPrompt = `Approve the signature in ${where} - it lets this browser trade for you.`;
      if (!activeBuilder(tradingConfig().builder)) {
        notify('info', keyPrompt);
        await enableTradingInBrowser({ owner: addr, provider: p, remember: true });
        notify('ok', 'Trading enabled. You can place and cancel orders.');
      } else {
        /* A builder fee is configured: the session reads the account's approval
           first, and each wallet prompt is announced when it is actually due. */
        const st = await enableTradingInBrowser({
          owner: addr,
          provider: p,
          remember: true,
          confirmBuilderFee: askBuilderFee,
          onStep: (step) =>
            notify(
              'info',
              step === 'builder-approval'
                ? `Approve the builder fee in ${where}.`
                : `Approve in ${where} so this browser can place orders.`,
            ),
        });
        notify(
          'ok',
          st.builder
            ? 'Trading enabled. Orders placed here carry the ValueDesk builder fee you approved.'
            : 'Trading enabled, without the ValueDesk builder fee.',
        );
      }
      latest.current.onSession();
      return true;
    } catch (e) {
      if (isRejection(e)) return false;
      /* The builder-fee dialog was closed: a decision, not a fault. */
      if (e instanceof TradingError && e.kind === 'cancelled') return false;
      if (e instanceof TradingError && e.kind === 'builder-required') {
        notify('info', e.message);
        return false;
      }
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
  }, [connect, askBuilderFee]);

  /* A new version of the terms (or a key from before they were signed): an opening
     order was refused (legalGate.ts) and asks for the signature here. */
  const signSiteTermsNow = useCallback(async () => {
    const { address: addr, provider: p } = latest.current;
    if (!addr || !p) {
      void connect();
      return;
    }
    if (await requireTerms({ owner: addr, reason: 'open positions' })) notify('ok', 'Terms accepted. You can open positions again.');
  }, [connect]);

  /* On connect: send a signed acceptance ValueDesk has not recorded yet, and screen the wallet. */
  useEffect(() => {
    if (!address) return;
    void recordPendingSiteTerms(address);
    void screenWallet(address).then((s) => {
      if (s !== 'sanctioned') return;
      notify('error', SANCTIONED_WALLET_REASON);
      window.dispatchEvent(new CustomEvent(WALLET_EVENTS.signOut));
    });
  }, [address]);

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
      [SIGN_TERMS_EVENT, () => { void signSiteTermsNow(); }],
    ];
    for (const [name, fn] of on) window.addEventListener(name, fn);
    return () => {
      for (const [name, fn] of on) window.removeEventListener(name, fn);
    };
  }, [connect, enableTrading, disableTrading, signOut, signSiteTermsNow]);

  return (
    <>
      {dialog}
      {builderConsent.dialog}
      {/* Renders nothing: after a fill it has the fee terms re-checked (only in a build whose fee has volume tiers). */}
      <BuilderTermsFollower address={address} />
      {(AdvancedKeysModal.ready || advancedOpen) && (
        <Suspense fallback={null}>
          <AdvancedKeysModal
            open={advancedOpen}
            onClose={() => setAdvancedOpen(false)}
            address={address}
            provider={provider}
            walletName={wallet.walletName}
            session={session}
            onSession={onSession}
            confirmBuilderFee={askBuilderFee}
          />
        </Suspense>
      )}
      <ConnectDialog />
      {(DepositModal.ready || depositOpen) && (
        <Suspense fallback={null}>
          <DepositModal
            open={depositOpen}
            onClose={() => setDepositOpen(false)}
            address={address}
            provider={provider}
            walletName={wallet.walletName}
            onEnable={enableTrading}
          />
        </Suspense>
      )}
      {(WithdrawModal.ready || withdrawOpen) && (
        <Suspense fallback={null}>
          <WithdrawModal
            open={withdrawOpen}
            onClose={() => setWithdrawOpen(false)}
            address={address}
            provider={provider}
            onEnable={enableTrading}
            initialFrom={withdrawFrom}
            initialCoin={withdrawCoin}
          />
        </Suspense>
      )}
      {(TransferModal.ready || transferOpen) && (
        <Suspense fallback={null}>
          <TransferModal
            open={transferOpen}
            onClose={() => setTransferOpen(false)}
            address={address}
            provider={provider}
            onEnable={enableTrading}
            preset={transferPreset}
          />
        </Suspense>
      )}
    </>
  );
}

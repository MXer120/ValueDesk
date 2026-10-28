/**
 * Transfer - move funds between the owner's own three accounts, in the Deposit
 * and Withdraw sheets' style:
 *
 *   ( [SoDEX] From       ▾   ->   [SoDEX] To          ▾ )   the route IS the picker:
 *   (         SoDEX Spot             SoDEX Perps        )   each end opens its list,
 *                                                            the arrow turns into ⇄
 *                                                            on hover and swaps them
 *   Coin  USDC ▾            (searchable)
 *   [ Amount   Available 84.09 ]
 *   [ amount             Max ]
 *   [ Enable Trading | Transfer ]
 *
 * Spot <-> Perps and Spot/Perps -> the ValueChain wallet ("EVM") are signed in
 * this browser by the trading key; out of the wallet is a wallet transaction
 * (trading/funds.ts:transferFunds). Every destination is the owner's own
 * account.
 *
 * TransferPanel is the whole body, so the Deposit sheet's "Transfer from
 * ValueChain" is this same panel starting at EVM -> Spot. A transfer is NOT a
 * deposit: it only moves funds between the account's own Spot, Perps and EVM,
 * so a wallet SoDEX has never seen gets a pointer to Deposit instead.
 */
import { fmtDecimalString, toInputText } from '../../numStyle';
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Modal } from '../Modal';
import { getTradingState, subscribeTrading } from '../../trading/session';
import { confirmMoneyMove } from '../../trading/keyLock';
import {
  ACCOUNT_LABEL,
  balancesOf,
  cachedAssetConfigs,
  transferFunds,
  transferNeedsKey,
  transferNeedsWallet,
  transferProblem,
  unitsDown,
  type Balances,
  type CoinConfig,
  type FundsAccount,
  type FundsStep,
} from '../../trading/funds';
import { formatUnits, parseUnits } from '../../trading/onboard';
import { refreshWallet } from '../../trading/walletBalances';
import { WalletError, isUserRejection, type Eip1193Provider } from '../../wallet';
import { formatCollateralRatio } from '../../accountData';
import { requestDeposit, type TransferPreset } from '../account/actions';
import { NO_ACCOUNT_TRANSFER, useAccountExists } from '../account/useAccountExists';
import { AutoHeight } from '../motion';
import { decimalInput } from '../numberInput';
import { ApproveLabel, Arrow, FxSelect, ONE_CONFIRM, SodexMark, Spinner, WalletMark, useStepLabel } from './ui';
import { openingWalletStep } from './openingStep';
import { TransferStatus, type DockMode } from './TransferStatus';
import { beginTransfer, dropTransfer, finishTransfer, noteTransferStep } from './transferLog';
import './funds.css';
import { NoWallet } from '../EmptyState';

interface Props {
  open: boolean;
  onClose: () => void;
  address: string | null;
  provider: Eip1193Provider | null;
  onEnable: () => Promise<boolean>;
  /** Where the sheet starts (the address menu's ⇅ opens Spot -> Perps). */
  preset?: TransferPreset | null;
}

const ACCOUNTS: FundsAccount[] = ['spot', 'perps', 'evm'];

interface TransferDockApi {
  onStart: (id: string) => void;
  onCancel: () => void;
  /** Direction change or a fresh sheet: drop the last result so the panel is not left green. */
  onReset: () => void;
}

export function TransferModal({ open, onClose, address, provider, onEnable, preset }: Props) {
  const owner = address?.toLowerCase() ?? null;
  const [mode, setMode] = useState<DockMode>('collapsed');
  const [liveId, setLiveId] = useState<string | null>(null);
  // Each opening starts collapsed. The log itself survives.
  useEffect(() => {
    if (!open) {
      setMode('collapsed');
      setLiveId(null);
    }
  }, [open]);
  const status = useMemo<TransferDockApi>(() => ({
    onStart: (id) => { setLiveId(id); setMode('live'); },
    onCancel: () => setMode('collapsed'),
    onReset: () => { setLiveId(null); setMode('collapsed'); },
  }), []);
  // Modal mounts its body only while open: every opening starts fresh from its preset.
  return (
    <Modal
      open={open}
      title="Transfer"
      onClose={onClose}
      size="md"
      className="fx fx-money"
      dock={<TransferStatus mode={mode} liveId={liveId} onMode={setMode} owner={owner} />}
      dockOpen={mode !== 'collapsed'}
    >
      {!owner ? (
        <NoWallet line="Connect a wallet to move funds between your accounts." compact />
      ) : (
        <TransferPanel owner={owner} provider={provider} onEnable={onEnable} preset={preset} status={status} />
      )}
    </Modal>
  );
}

/** How the route graphic names each account. */
const ROUTE_LABEL: Record<FundsAccount, string> = { evm: 'EVM', spot: 'SoDEX Spot', perps: 'SoDEX Futures' };
const routeMark = (a: FundsAccount, size = 28): ReactNode => (a === 'evm' ? <WalletMark size={size} /> : <SodexMark size={size} />);
export function TransferPanel(props: {
  owner: string;
  provider: Eip1193Provider | null;
  onEnable: () => Promise<boolean>;
  /** Where it starts (the address menu's ⇅ opens Spot -> Perps; the Deposit sheet EVM -> Spot). */
  preset?: TransferPreset | null;
  /** Set when the parent Modal draws the status dock. The deposit sheet omits it. */
  status?: TransferDockApi;
}) {
  if (useAccountExists(props.owner) === false) {
    return (
      <div className="fx-stack">
        <p className="fx-note fx-note--warn">{NO_ACCOUNT_TRANSFER}</p>
        <button type="button" className="fx-cta" onClick={requestDeposit}>Deposit</button>
      </div>
    );
  }
  return <TransferForm {...props} />;
}

function TransferForm({ owner, provider, onEnable, preset, status }: {
  owner: string;
  provider: Eip1193Provider | null;
  onEnable: () => Promise<boolean>;
  preset?: TransferPreset | null;
  status?: TransferDockApi;
}) {
  const trading = useSyncExternalStore(subscribeTrading, getTradingState, getTradingState);
  const enabled = trading.owner === owner && trading.status === 'enabled';

  const [configs, setConfigs] = useState<CoinConfig[] | null>(null);
  const [from, setFrom] = useState<FundsAccount>(preset?.from ?? 'spot');
  const [to, setTo] = useState<FundsAccount>(preset?.to ?? (preset?.from === 'perps' ? 'spot' : 'perps'));
  const [coinName, setCoinName] = useState(preset?.coin ?? 'USDC');
  const [bal, setBal] = useState<Balances | null>(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<FundsStep | null>(null);
  const [enabling, setEnabling] = useState(false);
  const busyLabel = useStepLabel();
  const [error, setError] = useState<string | null>(null);
  const [glare, setGlare] = useState(false);
  /** Only used when this panel is embedded (the deposit sheet) and draws its own status. */
  const [mode, setMode] = useState<DockMode>('collapsed');
  const [liveId, setLiveId] = useState<string | null>(null);
  /** Bumped after every attempt, so balances are re-read whatever happened. */
  const [reads, setReads] = useState(0);

  useEffect(() => {
    let stop = false;
    cachedAssetConfigs()
      .then((c) => !stop && setConfigs(c))
      .catch((e) => !stop && setError(`Could not load SoDEX's coins: ${String((e as Error).message ?? e)}`));
    return () => {
      stop = true;
    };
  }, []);
  // Coins that can make THIS move, USDC first.
  const coins = useMemo(
    () => (configs ?? [])
      .filter((c) => transferProblem(c, from, to) === null)
      .sort((a, b) => (a.coin === 'USDC' ? -1 : b.coin === 'USDC' ? 1 : a.coin.localeCompare(b.coin))),
    [configs, from, to],
  );
  const coin = coins.find((c) => c.coin === coinName) ?? coins[0];

  useEffect(() => {
    if (!coin) return;
    let stop = false;
    setBal(null);
    balancesOf(owner, coin).then((b) => !stop && setBal(b)).catch(() => !stop && setBal({ spot: '0', perps: '0', evm: '0' }));
    return () => {
      stop = true;
    };
  }, [owner, coin, reads]);

  const resetDock = () => status?.onReset();
  /** Picking the other side's account swaps the two, so From and To never match. */
  const pickFrom = (a: FundsAccount) => {
    if (a === from) return;
    resetDock();
    if (a === to) setTo(from);
    setFrom(a);
    setAmount('');
  };
  const pickTo = (a: FundsAccount) => {
    if (a === to) return;
    resetDock();
    if (a === from) setFrom(to);
    setTo(a);
  };
  const swap = () => {
    resetDock();
    setFrom(to);
    setTo(from);
    setAmount('');
  };

  // Exact base units: the Max, the check, the display.
  const dp = coin?.valuechain.decimals ?? 6;
  const units = (a: FundsAccount) => unitsDown(bal?.[a], dp);
  const max = units(from);
  let amtUnits = 0n;
  let problem: string | null = null;
  if (amount) {
    try {
      amtUnits = parseUnits(amount, dp);
      if (amtUnits <= 0n) problem = 'Enter an amount.';
      else if (bal && amtUnits > max) problem = `More than ${ACCOUNT_LABEL[from]} can move.`;
    } catch (e) {
      problem = (e as Error).message;
    }
  }
  /** Display only: at most 6 decimals, cut (never rounded up). */
  const show = (u: bigint) => {
    const s = formatUnits(u, dp);
    const [w, f] = s.split('.');
    return f && f.length > 6 ? `${w}.${f.slice(0, 6)}` : s;
  };
  /** `show` as the screen writes it: grouped, in the number format (numStyle.ts). */
  const showText = (u: bigint) => fmtDecimalString(show(u));

  const needsKey = transferNeedsKey(from, to);
  const needsWallet = transferNeedsWallet(from);
  const cta = needsKey && !enabled ? 'Enable Trading' : 'Transfer';

  async function submit() {
    if (!coin) return;
    if (cta === 'Enable Trading') {
      setEnabling(true);
      try {
        await onEnable();
      } finally {
        setEnabling(false);
      }
      return;
    }
    // The user lock (trading/keyLock.ts) asks again before money moves; cancel = nothing happens.
    if (!(await confirmMoneyMove(owner, `Transfer ${showText(amtUnits)} ${coin.coin}`))) return;
    const opening = from === 'evm' ? openingWalletStep(coin.valuechain.native) : null;
    const id = beginTransfer({
      coin: coin.coin,
      amount: show(amtUnits),
      from,
      to,
      walletStep: opening,
      settling: opening === null,
    });
    if (opening) setStep(opening);
    setBusy(true);
    setError(null);
    if (status) status.onStart(id);
    else { setLiveId(id); setMode('live'); }
    setGlare(true);
    window.setTimeout(() => setGlare(false), 750);
    try {
      await transferFunds({
        owner, provider, coin, from, to, amount,
        onStep: (s) => {
          setStep(s);
          noteTransferStep(id, s);
        },
      });
      finishTransfer(id, 'success');
      setAmount('');
    } catch (e) {
      if (isUserRejection(e)) {
        dropTransfer(id);
        if (status) status.onCancel();
        else setMode('collapsed');
      } else {
        const message = e instanceof WalletError || e instanceof RangeError ? e.message : String((e as Error)?.message ?? e);
        finishTransfer(id, 'failed', message);
        setError(message);
      }
    } finally {
      setStep(null);
      setBusy(false);
      setReads((n) => n + 1);
      if (from === 'evm' || to === 'evm') refreshWallet(owner, true); // the address menu's EVM figure
    }
  }

  /** A balance in the account list: 2 decimals for dollars, 4 otherwise, cut. The exact figure is the yellow Available. */
  const brief = (u: bigint) => {
    const [w, f = ''] = formatUnits(u, dp).split('.');
    const keep = /^(USDC|USDT)$/i.test(coin?.coin ?? '') ? 2 : 4;
    const frac = f.slice(0, keep).replace(/0+$/, '');
    return fmtDecimalString(frac ? `${w ?? 0}.${frac}` : (w ?? '0'));
  };
  const accountOptions = ACCOUNTS.map((a) => ({
    value: a,
    label: ROUTE_LABEL[a],
    iconNode: routeMark(a, 22),
    hint: bal && coin ? `${brief(units(a))} ${coin.coin}` : undefined,
  }));
  /** One end of the route: its mark, From/To over the account, and the list's chevron (FxSelect adds it). */
  const routeEnd = (side: 'From' | 'To', a: FundsAccount) => () => (
    <span key={a} className="fx-route__end mo-fade">
      {routeMark(a)}
      <span className="fx-route__t"><small>{side}</small><b>{ROUTE_LABEL[a]}</b></span>
    </span>
  );
  const coinLabel = coin?.coin ?? coinName;
  const loading = !configs && !error;
  // Spot → Perps is what funds multi-asset margin. Each coin's collateral
  // ratio (USDC 100%, others from SoDEX's coins metadata) sits on the right
  // of that list. Other routes are not moving collateral in.
  const intoPerps = from === 'spot' && to === 'perps';

  return (
    <AutoHeight className="fx-stack">
      <div className={`fx-route${glare ? ' is-glare' : ''}`} role="group" aria-label={`From ${ROUTE_LABEL[from]} to ${ROUTE_LABEL[to]}`}>
        <FxSelect
          label="From"
          value={from}
          onChange={(v) => pickFrom(v as FundsAccount)}
          options={accountOptions}
          trigger={routeEnd('From', from)}
          triggerClassName="fx-route__btn"
          listMinWidth={280}
        />
        <button type="button" className="fx-route__swap" onClick={swap} aria-label="Swap From and To" title="Swap From and To">
          <span className="fx-route__arrow"><Arrow /></span>
          <span className="fx-route__flip"><SwapIcon /></span>
        </button>
        <FxSelect
          label="To"
          value={to}
          onChange={(v) => pickTo(v as FundsAccount)}
          options={accountOptions}
          trigger={routeEnd('To', to)}
          triggerClassName="fx-route__btn"
          listMinWidth={280}
          listAlign="end"
        />
      </div>

      {coin || loading ? (
        <FxSelect
          compact
          searchable
          loading={loading}
          label="Coin"
          value={coinLabel}
          onChange={setCoinName}
          searchPlaceholder="Search coin"
          options={coins.length ? coins.map((c) => ({
            value: c.coin,
            label: c.coin,
            icon: c.coin,
            hint: intoPerps ? formatCollateralRatio(c.marginRatio, c.coin) ?? undefined : undefined,
          })) : [{ value: coinName, label: coinName, icon: coinName }]}
        />
      ) : (
        <p className="fx-note">Nothing can move from {ACCOUNT_LABEL[from]} to {ACCOUNT_LABEL[to]}.</p>
      )}

      {(coin || loading) && (
        <>
          <div className="fx-box">
            <div className="fx-box__head">
              <span>Amount</span>
              <span className="fx-max">Available: {bal && coin ? `${showText(max)} ${coinLabel}` : <Spinner />}</span>
            </div>
            <div className="fx-amount">
              <input value={toInputText(amount)} onChange={(e) => setAmount(decimalInput(e.target.value, { prev: amount }))} inputMode="decimal" placeholder="0.00" aria-label="Amount" />
              <span className="fx-amount__unit">{coinLabel}</span>
              <button type="button" className="fx-chip" disabled={!bal} onClick={() => setAmount(max > 0n ? formatUnits(max, dp) : '')}>Max</button>
            </div>
          </div>

          {problem && <p className="fx-note fx-note--err">{problem}</p>}
          <button
            type="button"
            className="fx-cta"
            onClick={() => void submit()}
            disabled={busy || enabling || !coin || (cta === 'Transfer' && (!amount || !!problem || (needsWallet && !provider)))}
          >
            {busy ? busyLabel(step) : enabling ? <ApproveLabel /> : cta}
          </button>
          {needsWallet && !provider && <p className="fx-note">Reconnect your wallet - moving funds out of it is a wallet transaction.</p>}
          {needsWallet && coin?.valuechain.native && <p className="fx-note">Leave a little SOSO for gas - a native transfer cannot use the whole balance.</p>}
        </>
      )}
      {error && <p className="fx-note fx-note--err">{error}</p>}
      {!status && <TransferStatus variant="inline" mode={mode} liveId={liveId} onMode={setMode} owner={owner} />}
    </AutoHeight>
  );
}

/** Left-right: From and To sit side by side. */
export const SwapIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.5 5h11M11 2.5 13.5 5 11 7.5M13.5 11h-11M5 13.5 2.5 11 5 8.5" />
  </svg>
);

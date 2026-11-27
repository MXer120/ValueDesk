/**
 * The Deposit sheet's "From your wallet" on Base: SoDEX's bridge, no deposit
 * address (sodex.com's "Deposit from connected wallet", 2026-11-27).
 *
 *   Coin  USDC ▾                         (the coins SoDEX bridges from Base now)
 *   ( You send USDC on Base  ->  You receive vUSDC in Spot )
 *   [ Amount   Available on Base 84.09 ]
 *   [ amount                      Max ]
 *   [ Deposit ]                          approve (only when short), then deposit
 *   Arrives in ~2 min ▾
 *
 * Every check and both wallet steps are trading/bridgeDeposit.ts. Once sent, the
 * deposit is followed in SoDEX's own deposit history (a "BridgeDeposit" row),
 * the same strip as the address view.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtDecimalString, toInputText } from '../../numStyle';
import { confirmMoneyMove } from '../../trading/keyLock';
import { bridgeRoutes, depositViaBridge, ethText, networkFeeWei, readBaseHoldings, type BaseHoldings, type BridgeDeposit } from '../../trading/bridgeDeposit';
import type { CoinConfig, FundsStep } from '../../trading/funds';
import { formatUnits, parseUnits } from '../../trading/onboard';
import { maintenanceFor, maintenanceNote, type Maintenance } from '../../trading/relay';
import { refreshWallet } from '../../trading/walletBalances';
import { WalletError, isUserRejection, type Eip1193Provider } from '../../wallet';
import { Collapse } from '../motion';
import { decimalInput } from '../numberInput';
import { DepositProgress, useDepositNotice } from './DepositProgress';
import { useDepositWatch } from './depositWatch';
import { Arrow, Avatar, Chevron, FxSelect, Info, Label, Spinner, useStepLabel } from './ui';

const minutes = (s: number | null | undefined): string => (s ? `~${Math.max(1, Math.round(s / 60))} min` : '');

export function BridgePanel({ owner, provider, configs }: { owner: string; provider: Eip1193Provider | null; configs: CoinConfig[] | null }) {
  const routes = useMemo(() => bridgeRoutes(configs ?? []), [configs]);
  const [coinName, setCoinName] = useState('USDC');
  const route = routes.find((r) => r.coin === coinName) ?? routes[0];
  const sym = route?.coin ?? coinName;

  const [hold, setHold] = useState<BaseHoldings | null>(null);
  const [holdFailed, setHoldFailed] = useState(false);
  const [maint, setMaint] = useState<Maintenance | null>(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<FundsStep | null>(null);
  const busyLabel = useStepLabel();
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<BridgeDeposit | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  /** Bumped after every attempt, so the Base balance is read again whatever happened. */
  const [reads, setReads] = useState(0);

  /** The deposit in SoDEX's own history once it shows up there (baseline taken now, before anything is sent). */
  const watch = useDepositWatch(owner, true);
  useDepositNotice(owner, watch);

  useEffect(() => {
    if (!route) return;
    let stop = false;
    setHold(null);
    setHoldFailed(false);
    readBaseHoldings(route, owner).then((h) => !stop && setHold(h)).catch(() => !stop && setHoldFailed(true));
    return () => {
      stop = true;
    };
  }, [route?.coin, route?.token, owner, reads]);
  useEffect(() => {
    if (!route) return;
    let stop = false;
    setMaint(null);
    maintenanceFor(route.coin, owner).then((m) => !stop && setMaint(m)).catch(() => !stop && setMaint({ known: false, global: {}, coinWide: {}, byChain: {} }));
    return () => {
      stop = true;
    };
  }, [route?.coin, owner]);
  // Another coin: the last result and amount go.
  useEffect(() => {
    setAmount('');
    setError(null);
  }, [coinName]);

  const down = maintenanceNote(maint, 'BASE_ETH', 'deposit');
  const paused = down?.severity === 'unavailable';
  const dp = hold?.decimals ?? 6;
  const max = hold?.balance ?? 0n;
  let units = 0n;
  let problem: string | null = null;
  if (amount) {
    try {
      units = parseUnits(amount, dp);
      if (units <= 0n) problem = 'Enter an amount.';
      else if (hold && units > max) problem = 'More than your wallet holds on Base.';
      else if (route?.min && units < parseUnits(route.min, dp)) problem = `The minimum deposit is ${route.min} ${sym}.`;
    } catch (e) {
      problem = (e as Error).message;
    }
  }
  // Base's network fee in ETH: the deposit, plus the approval when the allowance is short (trading/bridgeDeposit.ts).
  const approving = !!hold && (units > 0n ? hold.allowance < units : hold.allowance === 0n);
  const fee = hold ? networkFeeWei(hold, approving) : 0n;
  const noGas = !!hold && hold.gas === 0n;
  const lowGas = !!hold && !noGas && hold.gas < fee;
  /** Display: at most 6 decimals, cut (never rounded up), grouped. */
  const show = (u: bigint) => {
    const [w, f] = formatUnits(u, dp).split('.');
    return fmtDecimalString(f ? `${w}.${f.slice(0, 6)}` : (w ?? '0'));
  };
  /** What the form says now - read after the wallet prompts, which outlast the render that started them. */
  const form = useRef({ amount, coin: sym });
  form.current = { amount, coin: sym };

  async function submit() {
    if (!route || !provider) return;
    if (!(await confirmMoneyMove(owner, `Deposit ${fmtDecimalString(amount)} ${sym} from Base`))) return;
    setBusy(true);
    setError(null);
    setSent(null);
    try {
      const r = await depositViaBridge({ provider, owner, route, amount, onStep: setStep });
      setSent(r);
      if (form.current.amount === amount && form.current.coin === sym) setAmount('');
    } catch (e) {
      if (!isUserRejection(e)) setError(e instanceof WalletError || e instanceof RangeError ? e.message : String((e as Error)?.message ?? e));
    } finally {
      setStep(null);
      setBusy(false);
      setReads((n) => n + 1);
      refreshWallet(owner, true); // the address menu's Base figure
    }
  }

  if (configs && !routes.length) {
    return <p className="fx-note">SoDEX takes no deposits through its Base bridge right now - use Deposit with your deposit address instead.</p>;
  }
  const loading = !configs;
  const asset = route?.asset ?? sym;
  return (
    <>
      <FxSelect
        compact
        searchable
        loading={loading}
        label="Coin"
        value={sym}
        onChange={setCoinName}
        searchPlaceholder="Search coin"
        options={routes.length ? routes.map((r) => ({ value: r.coin, label: r.coin, icon: r.coin })) : [{ value: sym, label: sym, icon: sym }]}
      />

      <div className={`fx-sendrecv${watch ? ' has-strip' : ''}`}>
        <div className={`fx-pill${watch ? (watch.stage === 'done' ? ' is-done' : watch.stage === 'failed' ? ' is-failed' : watch.stage === 'review' ? '' : ' is-live') : ''}`}>
          <span className="fx-pill__s"><Avatar seed="BASE_ETH" kind="chain" /> <span><small>You send on Base</small><b>{sym}</b></span></span>
          <Arrow />
          <span className="fx-pill__s"><Avatar seed={asset} /> <span><small>You receive in Spot</small><b>{asset}</b></span></span>
        </div>
        <Collapse open={!!watch}>
          {watch && <DepositProgress w={watch} />}
        </Collapse>
      </div>

      <div className="fx-box">
        <div className="fx-box__head fx-box__head--wrap">
          <span>
            <span>Amount</span>
            {route?.min && (
              <span className="fx-box__min">
                <span>Min</span> {route.min} {sym} <Info title={`SoDEX's minimum for a ${sym} deposit through its Base bridge.`} />
              </span>
            )}
          </span>
          <span className="fx-max">Available on Base: {hold ? `${show(max)} ${sym}` : holdFailed ? '-' : <Spinner />}</span>
        </div>
        <div className="fx-amount">
          <input value={toInputText(amount)} onChange={(e) => setAmount(decimalInput(e.target.value, { prev: amount }))} inputMode="decimal" placeholder="0.00" aria-label="Amount" />
          <span className="fx-amount__unit">{sym}</span>
          <button type="button" className="fx-chip" disabled={!hold || max === 0n} onClick={() => setAmount(max > 0n ? formatUnits(max, dp) : '')}>Max</button>
        </div>
      </div>

      {down && (
        <p className={`fx-note ${paused ? 'fx-note--err' : 'fx-note--warn'}`}>
          <span>{paused ? `SoDEX has ${sym} deposits on Base paused - nothing can be sent now.` : 'SoDEX reports Base is congested - crediting may take longer.'}</span>{' '}
          <span data-no-i18n="">{down.message}{down.duration ? ` (${down.duration})` : ''}</span>
        </p>
      )}
      {problem && <p className="fx-note fx-note--err">{problem}</p>}
      {noGas && <p className="fx-note fx-note--warn">Your wallet has no ETH on Base for the network fee.</p>}
      {lowGas && <p className="fx-note fx-note--warn">{`Not enough ETH on Base for the network fee: about ${ethText(fee)} ETH needed.`}</p>}
      {holdFailed && <p className="fx-note">Your Base balance could not be read - it is checked again before anything is sent.</p>}
      <button
        type="button"
        className="fx-cta"
        onClick={() => void submit()}
        disabled={busy || !route || !provider || !amount || !!problem || paused || noGas || lowGas}
      >
        {busy ? busyLabel(step) : 'Deposit'}
      </button>
      {!provider && <p className="fx-note">Reconnect your wallet - a deposit from Base is a wallet transaction.</p>}
      {sent && (
        <p className="fx-note fx-note--ok">
          <span>{sent.confirmed ? `Sent ${fmtDecimalString(sent.amount)} ${sym} to SoDEX's bridge.` : `Sent ${fmtDecimalString(sent.amount)} ${sym} to SoDEX's bridge - Base is still confirming it.`}</span>{' '}
          <a className="fx-link" href={sent.explorerUrl} target="_blank" rel="noreferrer">View on Basescan</a>
        </p>
      )}
      {error && <p className="fx-note fx-note--err">{error}</p>}

      <div className={`fx-info${infoOpen ? ' is-open' : ''}`}>
        <button type="button" className="fx-info__sum" aria-expanded={infoOpen} onClick={() => setInfoOpen((v) => !v)}>
          Arrives in {minutes(route?.etaSeconds) || 'a few minutes'} <Info title="SoDEX's own estimate for its Base bridge." /> <Chevron />
        </button>
        <Collapse open={infoOpen}>
          <div className="fx-info__body">
            <span>{`Your wallet sends ${sym} on Base straight to SoDEX's bridge - no deposit address. It is credited to your SoDEX Spot balance as ${asset}.`}</span>{' '}
            <span>Your wallet asks once to allow the bridge to take the amount (only when it is not allowed yet), then for the deposit; both pay a small Base network fee in ETH.</span>
            {route?.min ? <>{' '}<span>{`At least ${route.min} ${sym}.`}</span></> : null}
          </div>
        </Collapse>
      </div>
    </>
  );
}

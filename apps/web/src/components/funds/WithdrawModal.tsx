/**
 * Withdraw - the owner's reference sheet, in this app's tokens:
 *
 *   Coin ▾ / Withdrawal Chain ▾          (both searchable; a chain shows its fee, "1 USDC")
 *   [ Amount                 Min 5 USDC ]
 *   [ amount                       Max  ]
 *   [ ☑ Spot 84.09     ☐ EVM 0  ]
 *   Destination Address   [ 0x…      📖 ]   ->  the address book opens as a panel beside the sheet
 *   (Use connected wallet)   Save as contact
 *   Fee 1 USDC · You receive 4 USDC
 *   [ Enable Trading | Withdraw ]
 *
 * Spot pays through the trading key (an engine transfer to the owner's own
 * ValueChain wallet); EVM IS that wallet. ValueChain to the own wallet
 * is the engine transfer alone; to anyone else the wallet then sends one token
 * transfer; any other chain goes through SoDEX's permit - one wallet signature
 * (trading/funds.ts). Perps is not a source: SoDEX has no route from Perps to a
 * wallet, so money there moves to Spot first (the Transfer sheet).
 *
 * What ARRIVES is checked against SoDEX's deposit minimum on that chain
 * (depositGuard.ts; withdrawFunds re-checks it): the owner's own SoDEX deposit address is refused; a
 * SoDEX deposit address (the registry knows them) that would get less than the
 * minimum is refused - it would never be credited; any other address below it
 * shows the warning under the amount and needs one tick ("It is a wallet, not
 * a deposit address") before the button lights.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Modal } from '../Modal';
import { getTradingState, subscribeTrading } from '../../trading/session';
import { confirmMoneyMove } from '../../trading/keyLock';
import {
  assetConfigs,
  balancesOf,
  memoProblem,
  planWithdraw,
  receiverProblem,
  unitsDown,
  withdrawFunds,
  withdrawQuote,
  withdrawalProgress,
  forgetSettledPermit,
  type Balances,
  type ChainRoute,
  type CoinConfig,
  type FundsStep,
  type WithdrawQuote,
} from '../../trading/funds';
import { arrivalCheck, receiverAccount, type ArrivalCheck, type ReceiverAccount } from './depositGuard';
import { maintenanceFor, maintenanceNote, type Maintenance } from '../../trading/relay';
import { formatUnits, parseUnits } from '../../trading/onboard';
import { WalletError, isUserRejection, type Eip1193Provider } from '../../wallet';
import { decimalInput } from '../numberInput';
import { AutoHeight, FadeView } from '../motion';
import { AddressBook, BookIcon } from './AddressBook';
import { markUsed, sameAddress, useContacts } from './contacts';
import { CATALOG } from './addrbook/catalogData';
import { KNOWN_COINS, chainById } from './addrbook/ContactAvatar';
import { resolveLook } from './addrbook/detect';
import { ADDRESS_KIND_LABEL, addressKinds, type AddressKind } from '../../trading/addresses';
import { ApproveLabel, Avatar, FxSelect, Info, Label, ONE_CONFIRM, SodexMark, Spinner, WalletIcon, WalletMark, short, useStepLabel } from './ui';
import { announceMoney } from './moneyNotice';
import './funds.css';

interface Props {
  open: boolean;
  onClose: () => void;
  address: string | null;
  provider: Eip1193Provider | null;
  onEnable: () => Promise<boolean>;
  /** Tick only this source (the address menu's Spot button); null ticks all. */
  initialFrom?: 'spot' | 'perps' | null;
  /** Asset config name to open on (USDC, BTC). Null keeps the last choice. */
  initialCoin?: string | null;
}

const VALUECHAIN = 'VALUECHAIN';

export function WithdrawModal({ open, onClose, address, provider, onEnable, initialFrom = null, initialCoin = null }: Props) {
  const trading = useSyncExternalStore(subscribeTrading, getTradingState, getTradingState);
  const owner = address?.toLowerCase() ?? null;
  const enabled = !!owner && trading.owner === owner && trading.status === 'enabled';
  const contacts = useContacts();

  const [configs, setConfigs] = useState<CoinConfig[] | null>(null);
  const [coinName, setCoinName] = useState('USDC');
  const [chainKey, setChainKey] = useState<string>(VALUECHAIN);
  const [bal, setBal] = useState<Balances | null>(null);
  const [amount, setAmount] = useState('');
  /** Where it is paid from: one of the two, as on sodex.com. */
  const [source, setSource] = useState<'spot' | 'evm'>('spot');
  const [receiver, setReceiver] = useState('');
  /** XRP / Stellar: the memo (tag), or "this address takes none". */
  const [memo, setMemo] = useState('');
  const [noMemo, setNoMemo] = useState(false);
  /** The address book panel beside the sheet, and an address to add in it. */
  const [bookOpen, setBookOpen] = useState(false);
  const [bookDraft, setBookDraft] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<FundsStep | null>(null);
  const [enabling, setEnabling] = useState(false);
  const busyLabel = useStepLabel();
  const [result, setResult] = useState<{ text: string; track?: { txHash: string; withdrawId: string | null } } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  /** SoDEX's on-chain fee and liquidity for the chosen chain (null: being read). */
  const [quote, setQuote] = useState<WithdrawQuote | null>(null);
  const [quoteFailed, setQuoteFailed] = useState(false);
  /** SoDEX's maintenance for the chosen coin (null: being read). */
  const [maint, setMaint] = useState<Maintenance | null>(null);
  /** The last look before signing: everything that will happen, confirmed on its own screen. */
  const [review, setReview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Bumped after every attempt, so the balances are re-read whatever happened. */
  const [reads, setReads] = useState(0);
  /** SoDEX's registry on the destination, for `key` (owner|coin|chain|address); `value` null: still read, or it could not be. */
  const [registry, setRegistry] = useState<{ key: string; value: ReceiverAccount | null; done: boolean } | null>(null);
  /** The user said less than SoDEX's deposit minimum may arrive: the destination is a wallet, not a deposit address. */
  const [belowMinOk, setBelowMinOk] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setResult(null);
    setStatus(null);
    setReview(false);
    setBelowMinOk(false);
    setBookOpen(false);
    setBookDraft(undefined);
    setSource('spot');
    setReceiver('');
    setMemo('');
    setNoMemo(false);
    if (initialCoin) setCoinName(initialCoin);
    if (!configs) assetConfigs().then(setConfigs).catch((e) => setError(`Could not load SoDEX's withdrawal networks: ${String((e as Error).message ?? e)}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialFrom, initialCoin]);

  // Coins that can leave: those with a trading-engine id (USDC, ...), USDC first.
  const coins = useMemo(
    () => (configs ?? []).filter((c) => c.assetId !== null).sort((a, b) => (a.coin === 'USDC' ? -1 : b.coin === 'USDC' ? 1 : a.coin.localeCompare(b.coin))),
    [configs],
  );
  const coin = coins.find((c) => c.coin === coinName) ?? coins[0];
  const externals = (coin?.chains ?? []).filter((c) => c.withdraw.allowed && c.addressKind !== 'other');
  const route: ChainRoute | typeof VALUECHAIN = chainKey === VALUECHAIN ? VALUECHAIN : externals.find((c) => c.key === chainKey) ?? VALUECHAIN;
  const external = route !== VALUECHAIN;
  /** The address the chosen chain pays out to (ValueChain: an EVM one). */
  const destKind: AddressKind = external ? ((route as ChainRoute).addressKind as AddressKind) : 'evm';
  const memoRoute = external && (route as ChainRoute).memo === 'numeric';

  useEffect(() => setChainKey(VALUECHAIN), [coinName]);
  // A destination of the wrong kind for the chosen chain is cleared.
  useEffect(() => {
    if (!receiver || addressKinds(receiver).includes(destKind)) return;
    setReceiver('');
    setMemo('');
    setNoMemo(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destKind]);
  useEffect(() => {
    if (!open || !owner || !coin) return;
    let stop = false;
    setBal(null);
    balancesOf(owner, coin).then((b) => !stop && setBal(b)).catch(() => !stop && setBal({ spot: '0', perps: '0', evm: '0' }));
    return () => {
      stop = true;
    };
  }, [open, owner, coin, result, reads]);

  // SoDEX's maintenance for this coin, and the chosen chain's fee and liquidity
  // from the chain itself (where sodex.com reads its fee).
  useEffect(() => {
    if (!open || !owner || !coin) return;
    let stop = false;
    setMaint(null);
    maintenanceFor(coin.coin, owner).then((m) => !stop && setMaint(m)).catch(() => !stop && setMaint({ known: false, global: {}, coinWide: {}, byChain: {} }));
    return () => {
      stop = true;
    };
  }, [open, owner, coin]);
  const routeKey = external ? (route as ChainRoute).key : null;
  useEffect(() => {
    setQuote(null);
    setQuoteFailed(false);
    if (!open || !owner || !coin || !external) return;
    let stop = false;
    withdrawQuote(coin, route as ChainRoute, owner).then((q) => !stop && setQuote(q)).catch(() => !stop && setQuoteFailed(true));
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, owner, coin, routeKey]);

  // Follow a withdrawal to another chain in SoDEX's own on-chain record until it is final.
  useEffect(() => {
    const track = result?.track;
    if (!track || (!track.txHash && !track.withdrawId)) return;
    let stop = false;
    let timer: number | undefined;
    const tick = async () => {
      const s = await withdrawalProgress(track).catch(() => null);
      if (stop) return;
      if (s) setStatus(s.ok && s.destinationTx ? `${s.status} · ${short(s.destinationTx)}` : s.status);
      // Final: nothing about it is unclear any more - the next withdrawal need not stop to say it went through.
      if (s?.done && owner) void forgetSettledPermit('withdraw', owner).catch(() => false);
      if (!s?.done) timer = window.setTimeout(tick, 5000);
    };
    void tick();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [result]);

  // Exact base units throughout (never a float): Max, the minimum, the fee.
  const dp = coin?.valuechain.decimals ?? 6;
  const dest = receiver.trim();
  const toSelf = destKind === 'evm' && !!owner && dest.toLowerCase() === owner;
  const b = { spot: unitsDown(bal?.spot, dp), perps: 0n, evm: unitsDown(bal?.evm, dp) };
  const useSrc = { spot: source === 'spot', perps: false, evm: source === 'evm' };
  const max = source === 'spot' ? b.spot : b.evm;
  const min = external ? (route as ChainRoute).withdraw.min : null;
  /**
   * Either tile can always be chosen. One that cannot pay - empty, or holding
   * less than SoDEX's minimum for this chain (shown as "Min" by the amount) -
   * just leaves the button dark, without a message. Only EVM paying INTO itself
   * says why.
   */
  const sourceEmpty = !!bal && (max === 0n || (!!min && max < unitsDown(min, dp)));
  const sourceProblem = source === 'evm' && toSelf ? 'Your EVM wallet is this address already - withdraw to another address or chain.' : null;
  /** SoDEX's on-chain fee; the asset config's only if the chain cannot be read (the withdrawal re-checks it). */
  const configFee = external ? (route as ChainRoute).withdraw.fee : null;
  const feeUnits = !external ? 0n : quote ? quote.fee : unitsDown(configFee, dp);
  const feeKnown = !external || !!quote || (quoteFailed && configFee !== null);
  /** Maintenance on the chosen chain: 'unavailable' stops it (as on sodex.com), 'congested' only warns. */
  const down = external ? maintenanceNote(maint, (route as ChainRoute).key, 'withdraw') : null;
  let amtUnits = 0n;
  let problem: string | null = null;
  if (amount) {
    try {
      amtUnits = parseUnits(amount, dp);
      if (amtUnits <= 0n) problem = 'Enter an amount.';
      else if (min && amtUnits < unitsDown(min, dp)) problem = `The minimum on ${(route as ChainRoute).label} is ${min} ${coin?.coin}.`;
      else if (bal && amtUnits > max && max > 0n && !sourceProblem) problem = `More than ${source === 'spot' ? 'SoDEX Spot' : 'your EVM wallet'} holds.`;
      else if (external && quote && amtUnits <= quote.fee) problem = `The amount must be more than the ${formatUnits(quote.fee, dp)} ${coin?.coin} fee.`;
      else if (external && quote && amtUnits > quote.available) {
        problem = `SoDEX can pay out ${formatUnits(quote.available, dp)} ${coin?.coin} on ${(route as ChainRoute).label} right now.`;
      }
    } catch (e) {
      problem = (e as Error).message;
    }
  }
  const destProblem = dest ? receiverProblem(route, dest) : null;
  const memoError = memoRoute && dest && !destProblem ? memoProblem(route, memo, noMemo) : null;
  /**
   * Is the destination a SoDEX deposit address - the owner's own, or any
   * account's on this chain? Asked of SoDEX's registry on ValueChain once it is
   * a valid address other than the connected wallet (depositGuard.ts).
   */
  const regKey = owner && coin && dest && !destProblem && !toSelf ? `${owner}|${coin.coin}|${routeKey ?? VALUECHAIN}|${dest}` : null;
  useEffect(() => {
    if (!open || !regKey || !owner || !coin) return;
    let stop = false;
    setRegistry({ key: regKey, value: null, done: false });
    receiverAccount(owner, coin, route, dest)
      .then((value) => !stop && setRegistry({ key: regKey, value, done: true }))
      .catch(() => !stop && setRegistry({ key: regKey, value: null, done: true }));
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, regKey]);
  const reg = registry?.key === regKey ? registry : null;
  /** The registry has not answered yet: the button waits (a fraction of a second). */
  const regPending = !!regKey && !reg?.done;
  /**
   * What arrives, against SoDEX's deposit minimum on that chain: refused for
   * the owner's own deposit address and for a SoDEX deposit address it would
   * not credit; any other address below the minimum needs one tick first.
   */
  const arrival: ArrivalCheck =
    owner && coin && regKey
      ? arrivalCheck({ owner, coin, route, receiver: dest, amount: problem || !feeKnown ? 0n : amtUnits, fee: feeUnits, registry: reg?.value ?? null })
      : { verdict: 'ok' };
  const arrivalRefused = arrival.verdict === 'refuse' ? arrival : null;
  const needsAck = arrival.verdict === 'confirm';
  // A tick covers the amount and address it was given for.
  useEffect(() => setBelowMinOk(false), [amount, dest, chainKey, coinName]);
  const receiveUnits = amtUnits > feeUnits ? amtUnits - feeUnits : 0n;
  const plan = amtUnits > 0n ? planWithdraw(amtUnits, external || !toSelf ? 'EXTERNAL' : 'VALUECHAIN', useSrc, b) : null;
  const needsKey = !!plan && ('problem' in plan || plan.fromSpot > 0n);
  /** A permit, or a transfer the wallet sends. */
  const needsWallet = external || (!!dest && !toSelf);
  const saved = dest ? contacts.find((c) => sameAddress(c.address, dest)) : undefined;
  const ownLabel = toSelf ? 'Your connected wallet' : undefined;
  /** For display only: at most 6 decimals, cut (never rounded up). */
  const show = (u: bigint) => {
    const s = formatUnits(u, dp);
    const [w, f] = s.split('.');
    return f && f.length > 6 ? `${w}.${f.slice(0, 6)}` : s;
  };
  const feeText = (fee: string | null) => `${fee ?? '0'} ${coin?.coin ?? ''}`.trim();

  const cta = needsKey && !enabled ? 'Enable Trading' : 'Withdraw';
  const ctaText = cta === 'Withdraw' ? `Withdraw to ${external ? (route as ChainRoute).label : 'ValueChain'}` : cta;
  /** Anywhere but the connected wallet on ValueChain funds can be lost to a mistake: those are reviewed first. */
  const reviewFirst = external || !toSelf;

  async function submit() {
    if (!owner || !coin) return;
    if (cta === 'Enable Trading') {
      setEnabling(true);
      try {
        await onEnable();
      } finally {
        setEnabling(false);
      }
      return;
    }
    // The user lock (trading/keyLock.ts) asks again before money leaves; cancel = nothing happens.
    setError(null);
    if (!(await confirmMoneyMove(owner, `Withdraw ${amount} ${coin.coin}`))) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setStatus(null);
    try {
      const r = await withdrawFunds({
        owner,
        provider,
        coin,
        route,
        receiver: dest,
        memo: memoRoute && !noMemo ? memo : '',
        amount,
        sources: useSrc,
        expectedFee: external ? feeUnits : undefined,
        onStep: setStep,
      });
      if ('withdrawId' in r) {
        setResult({ text: `Withdrawal of ${amount} ${coin.coin} to ${(route as ChainRoute).label} submitted.`, track: { txHash: r.txHash, withdrawId: r.withdrawId } });
      } else if ('txHash' in r) {
        setResult({ text: `Sent ${amount} ${coin.coin} to ${saved?.name ?? short(dest)} on ValueChain.` });
      } else {
        setResult({ text: `Withdrew ${amount} ${coin.coin} to your ValueChain wallet.` });
      }
      // On the wallet button (moneyNotice.ts): a chain withdrawal is submitted here, the rest is done.
      announceMoney('withdrawId' in r
        ? { kind: 'withdraw', status: 'sent', text: `Withdrawal of ${amount} ${coin.coin} submitted` }
        : { kind: 'withdraw', status: 'done', text: `Withdrawal of ${amount} ${coin.coin} completed` });
      markUsed(dest);
      setAmount('');
      setReview(false);
    } catch (e) {
      if (!isUserRejection(e)) setError(e instanceof WalletError || e instanceof RangeError ? e.message : String((e as Error)?.message ?? e));
    } finally {
      setStep(null);
      setBusy(false);
      setReads((n) => n + 1);
    }
  }

  const coinLabel = coin?.coin ?? coinName;
  const loading = !configs && !error;
  const openBook = (draft?: string) => {
    setBookDraft(draft);
    setBookOpen(true);
  };

  return (
    <Modal
      open={open}
      title="Withdraw"
      onClose={onClose}
      size="md"
      className="fx"
      aside={
        bookOpen && owner ? (
          <AddressBook
            kind={destKind}
            draft={bookDraft}
            onClose={() => setBookOpen(false)}
            onPick={(c) => {
              setReceiver(c.address);
              setMemo(c.memo ?? '');
              setNoMemo(false);
              // The contact's own chain, when this coin can go there.
              const key = chainById(c.look?.chain ?? resolveLook(c, CATALOG, KNOWN_COINS).chain)?.sodexKey;
              if (key && key !== chainKey && (key === VALUECHAIN || externals.some((x) => x.key === key))) setChainKey(key);
              markUsed(c.address);
              setBookOpen(false);
            }}
          />
        ) : null
      }
    >
      {!owner ? (
        <p className="fx-note">Connect a wallet to withdraw.</p>
      ) : (
        <AutoHeight>
          <FadeView viewKey={review ? 'review' : 'form'} className="fx-stack">
          {review ? (
            <WithdrawReview
              amount={show(amtUnits)}
              unit={coinLabel}
              from={source === 'spot' ? 'SoDEX Spot' : 'Your EVM wallet'}
              chainKey={external ? (route as ChainRoute).key : VALUECHAIN}
              chainName={external ? (route as ChainRoute).label : 'ValueChain'}
              address={dest}
              contact={saved?.name ?? ownLabel ?? null}
              memo={memoRoute ? (noMemo ? '' : memo.trim()) : null}
              fee={show(feeUnits)}
              receive={show(receiveUnits)}
              arrivalNote={arrival.verdict === 'confirm' ? arrival.brief : null}
              busy={busy}
              busyText={busyLabel(step)}
              error={error}
              onBack={() => {
                setReview(false);
                setError(null);
              }}
              onConfirm={() => void submit()}
            />
          ) : (
          <>
          <FxSelect
            compact
            searchable
            loading={loading}
            label="Coin"
            value={coinLabel}
            onChange={setCoinName}
            searchPlaceholder="Search coin"
            options={coins.length ? coins.map((c) => ({ value: c.coin, label: c.coin, icon: c.coin })) : [{ value: coinName, label: coinName, icon: coinName }]}
          />
          <FxSelect
            compact
            searchable
            loading={loading}
            label="Withdrawal Chain"
            value={external ? (route as ChainRoute).key : VALUECHAIN}
            onChange={setChainKey}
            searchPlaceholder="Search chain"
            options={[
              { value: VALUECHAIN, label: 'ValueChain', icon: VALUECHAIN, iconKind: 'chain' as const, hint: feeText('0') },
              ...externals.map((c) => {
                const off = maintenanceNote(maint, c.key, 'withdraw')?.severity === 'unavailable';
                const fee = c.key === routeKey && quote ? formatUnits(quote.fee, dp) : c.withdraw.fee;
                return { value: c.key, label: c.label, icon: c.key, iconKind: 'chain' as const, hint: off ? 'Maintenance' : fee !== null ? feeText(fee) : undefined, disabled: off };
              }),
            ]}
          />
          {down && (
            <p className={`fx-note ${down.severity === 'unavailable' ? 'fx-note--err' : 'fx-note--warn'}`}>
              {down.severity === 'unavailable' ? `${coinLabel} withdrawals to ${(route as ChainRoute).label} are paused by SoDEX. ` : 'SoDEX reports this network is congested - it may take longer. '}
              {down.message}
              {down.duration ? ` (${down.duration})` : ''}
            </p>
          )}
          {external && maint && !maint.known && (
            <p className="fx-note">SoDEX's maintenance status could not be read. Your withdrawal is still checked on-chain before anything is sent.</p>
          )}

          <div className="fx-box">
            <div className="fx-box__head">
              <span>Amount</span>
              {min && <span className="fx-min">Min {min} {coinLabel}</span>}
            </div>
            <div className="fx-amount">
              <input value={amount} onChange={(e) => setAmount(decimalInput(e.target.value))} inputMode="decimal" placeholder="0.00" aria-label="Amount" />
              <span className="fx-amount__unit">{coinLabel}</span>
              <button type="button" className="fx-chip" disabled={!bal} onClick={() => setAmount(max > 0n ? formatUnits(max, dp) : '')}>Max</button>
            </div>
            {/* Where it is paid from - one of the two, like the Transfer route's ends:
                Spot left, EVM right, each with its balance; the chosen one is lit. */}
            <div className="fx-srcs" role="radiogroup" aria-label="Withdraw from">
              {(['spot', 'evm'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={source === s}
                  className={`fx-srct${source === s ? ' is-on' : ''}`}
                  onClick={() => setSource(s)}
                >
                  {s === 'spot' ? <SodexMark size={26} /> : <WalletMark size={26} />}
                  <span className="fx-srct__t">
                    <b>{s === 'spot' ? 'SoDEX Spot' : 'EVM'}</b>
                    <small>{bal ? `${show(s === 'spot' ? b.spot : b.evm)} ${coinLabel}` : <Spinner />}</small>
                  </span>
                  <span className="fx-srct__tick" aria-hidden="true"><TickIcon /></span>
                </button>
              ))}
            </div>
          </div>

          {arrivalRefused && arrivalRefused.reason !== 'own' && <p className="fx-note fx-note--err">{arrivalRefused.text}</p>}
          {arrival.verdict === 'confirm' && (
            <div>
              <p className="fx-note fx-note--warn">{arrival.text}</p>
              <label className="fx-check">
                <input type="checkbox" checked={belowMinOk} onChange={(e) => setBelowMinOk(e.target.checked)} />
                It is a wallet, not a deposit address - withdraw anyway
              </label>
            </div>
          )}
          {sourceProblem && <p className="fx-note fx-note--err">{sourceProblem}</p>}

          <div>
            <Label aside={saved ? <span className="fx-contact-tag">{saved.name}</span> : ownLabel}>Destination Address</Label>
            <div className="fx-dest">
              <input
                className="fx-input"
                value={receiver}
                onChange={(e) => setReceiver(e.target.value.trim())}
                placeholder={`${ADDRESS_KIND_LABEL[destKind]} address`}
                aria-label="Destination address"
                spellCheck={false}
              />
              <button
                type="button"
                className={`fx-iconbtn fx-dest__book${bookOpen ? ' is-on' : ''}`}
                onClick={() => (bookOpen ? setBookOpen(false) : openBook())}
                aria-label="Address book"
                aria-pressed={bookOpen}
                title="Address book"
              >
                <BookIcon />
              </button>
            </div>
            <div className="fx-dest__actions">
              {destKind === 'evm' && !toSelf && (
                <button type="button" className="fx-pillbtn" onClick={() => setReceiver(owner)}>
                  <WalletIcon /> Use connected wallet {short(owner)}
                </button>
              )}
              {dest && !saved && !destProblem && addressKinds(dest).includes(destKind) && !toSelf && arrivalRefused?.reason !== 'own' && (
                <button type="button" className="fx-link" onClick={() => openBook(dest)}>Save as contact</button>
              )}
            </div>
            {destProblem && <p className="fx-note fx-note--err" style={{ marginTop: 6 }}>{destProblem}</p>}
            {arrivalRefused?.reason === 'own' && <p className="fx-note fx-note--err" style={{ marginTop: 6 }}>{arrivalRefused.text}</p>}
          </div>

          {memoRoute && (
            <div>
              <Label aside={<Info title="Exchanges credit XRP and Stellar deposits by this number (a destination tag). A wallet you control usually needs none." />}>Memo</Label>
              <input
                className="fx-input"
                value={noMemo ? '' : memo}
                disabled={noMemo}
                onChange={(e) => setMemo(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                placeholder={noMemo ? 'No memo' : 'Memo / destination tag'}
                aria-label="Memo"
              />
              <label className="fx-check">
                <input type="checkbox" checked={noMemo} onChange={(e) => setNoMemo(e.target.checked)} />
                This address needs no memo
              </label>
              {memoError && <p className="fx-note fx-note--err" style={{ marginTop: 6 }}>{memoError}</p>}
            </div>
          )}

          <div className="fx-kv">
            <div><span>Fee</span><b>{loading || !feeKnown ? <Spinner /> : `${show(feeUnits)} ${coinLabel}`}</b></div>
            <div><span>You receive</span><b>{loading || !feeKnown ? <Spinner /> : `${show(receiveUnits)} ${coinLabel}`}</b></div>
          </div>

          {problem && <p className="fx-note fx-note--err">{problem}</p>}
          <button
            type="button"
            className="fx-cta fx-cta--lg"
            onClick={() => (cta === 'Withdraw' && reviewFirst ? (setError(null), setReview(true)) : void submit())}
            disabled={
              busy ||
              enabling ||
              !coin ||
              (cta === 'Withdraw' &&
                (!amount || !!problem || sourceEmpty || !!sourceProblem || !dest || !!destProblem || !!memoError || (needsWallet && !provider) || !feeKnown || down?.severity === 'unavailable' ||
                  regPending || !!arrivalRefused || (needsAck && !belowMinOk)))
            }
          >
            {busy ? busyLabel(step) : enabling ? <ApproveLabel /> : ctaText}
          </button>
          {result && (
            <p className="fx-note fx-note--ok">
              {result.text}
              {result.track && <> Status: <b>{status ?? 'Submitted'}</b>.</>}
            </p>
          )}
          {error && <p className="fx-note fx-note--err">{error}</p>}
          {needsWallet && !provider && <p className="fx-note">Reconnect your wallet - this withdrawal needs one wallet signature.</p>}
          </>
          )}
          </FadeView>
        </AutoHeight>
      )}
    </Modal>
  );
}

/**
 * The review before signing: every figure and the FULL destination, so a wrong
 * network or a mistyped address is caught before the only step that cannot be
 * undone.
 */
function WithdrawReview(p: {
  amount: string;
  unit: string;
  from: string;
  chainKey: string;
  chainName: string;
  address: string;
  contact: string | null;
  /** null: this network takes no memo; '': the user said the address needs none. */
  memo: string | null;
  fee: string;
  receive: string;
  /** Less than SoDEX's deposit minimum arrives, and the user ticked that the address is a wallet. */
  arrivalNote?: string | null;
  busy: boolean;
  busyText: string;
  error: string | null;
  onBack: () => void;
  onConfirm: () => void;
}) {
  return (
    <>
      <p className="fx-review__t">Review withdrawal</p>
      <div className="fx-review">
        <div><span>You send</span><b>{p.amount} {p.unit}</b></div>
        <div><span>From</span><b>{p.from}</b></div>
        <div><span>Network</span><b className="fx-review__net"><Avatar seed={p.chainKey} kind="chain" size={18} />{p.chainName}</b></div>
        <div className="fx-review__to">
          <span>To{p.contact ? <em> · {p.contact}</em> : null}</span>
          <code>{p.address}</code>
        </div>
        {p.memo !== null && <div><span>Memo</span><b>{p.memo || 'None'}</b></div>}
        <div><span>Fee</span><b>{p.fee} {p.unit}</b></div>
        <div className="fx-review__recv"><span>You receive</span><b>{p.receive} {p.unit}</b></div>
      </div>
      {p.arrivalNote && <p className="fx-note fx-note--warn">{p.arrivalNote}</p>}
      <p className="fx-note fx-note--warn">
        A withdrawal cannot be reversed. Check the network and every character of the address{p.memo !== null ? ' and the memo' : ''} - funds sent to a wrong one are lost.
      </p>
      {p.error && <p className="fx-note fx-note--err">{p.error}</p>}
      <div className="fx-review__actions">
        <button type="button" className="fx-cta fx-cta--ghost" onClick={p.onBack} disabled={p.busy}>Back</button>
        <button type="button" className="fx-cta fx-cta--lg" onClick={p.onConfirm} disabled={p.busy}>{p.busy ? p.busyText : 'Confirm withdrawal'}</button>
      </div>
    </>
  );
}

const TickIcon = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
    <path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

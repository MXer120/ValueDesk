/**
 * Buying an index (owner 2026-11-28: "Supported buy modes one-time, recuring"):
 *
 *   once        every leg now, each through its fund's own channel (trading/vdIndexes.ts planLegs), one wallet
 *               confirmation per wallet leg; order-book legs are spot orders from Spot
 *   recurring   one SoDEX recurring plan per leg on one schedule, amounts by weight (trading/recurring.ts createPlan),
 *               drawn from the wallet's pre-funded balance; only funds SoDEX's recurring-buy contract lists can be in
 *               one, and each leg keeps its own minimum per purchase
 *
 * Nothing rebalances; what was bought and set up here is kept in this browser (vdIndexes.ts) so the page can show it.
 * The forms are the app's money sheets (funds.css fx-), the same as every other Invest on the Wealth page.
 */
import { useEffect, useMemo, useState } from 'react';
import { Modal } from '../Modal';
import { CoinIcon } from '../CoinIcon';
import { NoWallet } from '../EmptyState';
import { requestTransfer } from '../account/actions';
import { decimalInput } from '../numberInput';
import { toInputText } from '../../numStyle';
import { FxSelect, Spinner, useStepLabel, type FxOption } from '../funds/ui';
import { ViewSeg } from './RangePicker';
import { DASH, fmt, fmtUsd, num } from '../../format';
import { formatUnits, parseUnits } from '../../trading/onboard';
import { balancesOf, type FundsStep } from '../../trading/funds';
import { placeOrder } from '../../trading/actions';
import { fillQuote, fundAction, fundLabel, requestQuote, requestVault, QUOTE_REASON, type FundAction, type WealthFund } from '../../trading/wealth';
import { earnCoins, requestEarn } from '../../trading/wealthEarn';
import {
  MARKET_LABEL, PLAN_LABEL, PLAN_TYPES, WEEKDAYS, addFunds, createPlan, dayProblem, firstRunDate, readPrefund, readTargets,
  scheduleWords, type PlanType, type PrefundFacts, type RecurringTarget,
} from '../../trading/recurring';
import {
  minimumFor, notRecurring, planLegs, recurringLegs, recurringMinimum, saveBuy, saveIndexPlan, type IndexBuy as IndexBuyRecord, type PlannedLeg, type VdIndex,
} from '../../trading/vdIndexes';
import { isUserRejection, type Eip1193Provider } from '../../wallet';
import { useTradingStatuses, type WealthState } from './useWealth';
import { fundIconOf, fundNameOf, useMinimums } from './indexParts';
import { useNow } from '../sodex/parts';
import { IndexTicket } from './IndexTicket';
import '../funds/funds.css';
import './recurring.css';
import './vdIndexes.css';

const USDC_DP = 6;
const usdUnits = (v: string): bigint => { try { return v ? parseUnits(v, USDC_DP) : 0n; } catch { return 0n; } };
const usd = (u: bigint): string => fmtUsd(Number(formatUnits(u, USDC_DP)));
const dateOnly = (iso: string): string => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const ROUTE_WORDS: Readonly<Record<PlannedLeg['route'], string>> = { spot: 'Order book', batch: 'Batch, priced at the next open', rfq: 'Maker quote', earn: 'Bridge, about a minute', closed: 'Closed' };

export type BuyMode = 'once' | 'recurring';
const MODES: ReadonlyArray<readonly [BuyMode, string]> = [['once', 'One time'], ['recurring', 'Recurring']];

/** What each fund allows right now (SoDEX's trading status, polled while shown). */
export function useFundActions(funds: readonly WealthFund[] | null): Map<string, FundAction | null> {
  const statuses = useTradingStatuses(funds);
  return useMemo(() => new Map((funds ?? []).map((f) => [f.fundId, fundAction(f, statuses.get(f.fundId) ?? null)])), [funds, statuses]);
}

/** The funds SoDEX's recurring-buy contract lists, read from ValueChain once per ten minutes. */
let targetsCache: { key: string; at: number; list: RecurringTarget[] } | null = null;
export function useRecurringTargets(funds: readonly WealthFund[] | null): RecurringTarget[] | null {
  const key = funds?.map((f) => f.fundId).join(',') ?? '';
  const fresh = targetsCache && targetsCache.key === key && Date.now() - targetsCache.at < 600_000 ? targetsCache.list : null;
  const [list, setList] = useState<RecurringTarget[] | null>(fresh);
  useEffect(() => {
    if (!funds || fresh) { if (fresh) setList(fresh); return; }
    let off = false;
    void readTargets(funds).then((l) => { targetsCache = { key, at: Date.now(), list: l }; if (!off) setList(l); }).catch(() => { if (!off) setList([]); });
    return () => { off = true; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return list;
}

type LegState = { status: 'busy' | 'done' | 'failed'; note?: string };

function LegRow({ icon, name, sub, value, st, stepText }: { icon: string; name: string; sub: string; value: string; st?: LegState; stepText: string }) {
  return (
    <li>
      <CoinIcon coin={icon} size={20} />
      <span className="vdi-plan__n"><b>{name}</b><small>{sub}</small></span>
      <b className="vdi-plan__v">{value}</b>
      <span className={`pfx-status ${st?.status === 'done' ? 'pos' : st?.status === 'failed' ? 'neg' : ''}`} title={st?.note}>
        <i aria-hidden="true" />{st ? (st.status === 'busy' ? stepText : st.status === 'done' ? 'Sent' : 'Failed') : ''}
      </span>
    </li>
  );
}

// --- once -------------------------------------------------------------------------------------------

export function BuyOnce({ ix, w, address, provider, onDone, onClose }: {
  ix: VdIndex; w: WealthState; address: string; provider: Eip1193Provider | null; onDone: () => void; onClose?: () => void;
}) {
  const actions = useFundActions(w.funds);
  useNow(30_000); // the "Resuming in" countdowns of closed legs
  const mins = useMinimums(w.funds, ix.legs.map((l) => l.fundId));
  const [amount, setAmount] = useState('');
  const [bal, setBal] = useState<{ spot: number; wallet: number } | null>(null);
  const [states, setStates] = useState<Record<string, LegState>>({});
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<FundsStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const label = useStepLabel();
  const usdIn = num(amount);
  const legs = planLegs(ix, usdIn, w.funds, actions);
  const min = minimumFor(ix, mins);
  const needSpot = legs.filter((l) => l.from === 'spot').reduce((t, l) => t + l.usd, 0);
  const needWallet = legs.filter((l) => l.from === 'wallet').reduce((t, l) => t + l.usd, 0);
  const closed = legs.filter((l) => l.route === 'closed');

  useEffect(() => {
    let off = false;
    void earnCoins().then((c) => balancesOf(address, c.usdc)).then((b) => { if (!off) setBal({ spot: num(b.spot), wallet: num(b.evm) }); }).catch(() => undefined);
    return () => { off = true; };
  }, [address, finished]);

  const problem = !usdIn ? null
    : usdIn < min ? `This index starts at ${fmtUsd(min, 0)}: every leg has its own minimum.`
    : closed.length ? `${closed.map((l) => (l.fund ? fundLabel(l.fund).name : l.fundId)).join(', ')}: ${closed[0]!.why ?? 'closed'}. Buy when every leg is open.`
    : bal && needSpot > bal.spot + 1e-9 ? 'Not enough USDC in Spot for the order-book legs.'
    : bal && needWallet > bal.wallet + 1e-9 ? 'Not enough USDC in your wallet on ValueChain for the vault and USDC Earn legs.'
    : null;

  const run = async () => {
    if (!provider) return;
    setBusy(true);
    setError(null);
    const record: IndexBuyRecord = { id: ix.id, at: Date.now(), usd: usdIn, legs: [] };
    for (const l of legs) {
      setStates((s) => ({ ...s, [l.fundId]: { status: 'busy' } }));
      try {
        const units = parseUnits(l.usd.toFixed(2), 6);
        if (l.route === 'spot') {
          await placeOrder('spot', { symbol: l.fund!.spot!.symbol, side: 'buy', type: 'market', funds: l.usd.toFixed(2) });
        } else if (l.route === 'earn') {
          await requestEarn({ provider, owner: address, side: 'buy', amount: units, onStep: setStep });
        } else if (l.route === 'batch') {
          await requestVault({ provider, owner: address, fundId: l.fundId, side: 'buy', amount: units, onStep: setStep });
        } else if (l.route === 'rfq') {
          const a = actions.get(l.fundId);
          const q = await requestQuote(l.fundId, 'buy', address, units);
          if (!q.quotable) throw new Error(QUOTE_REASON[q.reason?.code ?? ''] ?? 'The maker did not quote this.');
          await fillQuote({ provider, owner: address, fundId: l.fundId, rfq: a && a.kind === 'rfq' ? a.rfq : '', quote: q, onStep: setStep });
        }
        const price = num(w.quotes.get(l.fundId)?.price);
        record.legs.push({ fundId: l.fundId, usd: l.usd, units: price > 0 ? l.usd / price : null, ok: true });
        setStates((s) => ({ ...s, [l.fundId]: { status: 'done' } }));
      } catch (e) {
        const msg = isUserRejection(e) ? 'You declined it in your wallet.' : (e as Error).message;
        record.legs.push({ fundId: l.fundId, usd: l.usd, units: null, ok: false });
        setStates((s) => ({ ...s, [l.fundId]: { status: 'failed', note: msg } }));
        setError(`Stopped at ${l.fund ? fundLabel(l.fund).name : l.fundId}: ${msg} The legs before it went through.`);
        break;
      } finally {
        setStep(null);
      }
    }
    if (record.legs.some((x) => x.ok)) { saveBuy(address, record); onDone(); }
    setBusy(false);
    setFinished(true);
  };

  return (
    <div className="fx-stack">
      <div className="fx-box">
        <div className="fx-box__head"><span>You invest</span>{min > 0 && <span className="fx-max">{`Minimum ${fmtUsd(min, 0)}`}</span>}</div>
        <div className="fx-amount">
          <input value={amount} onChange={(e) => { setAmount(decimalInput(e.target.value, { prev: amount })); setStates({}); setFinished(false); }} inputMode="decimal" placeholder="0.00" aria-label="Amount" disabled={busy} />
          <span className="fx-amount__unit pfx-unit"><CoinIcon coin="USDC" size={16} /> USDC</span>
        </div>
      </div>

      <ul className="vdi-plan">
        {legs.map((l) => (
          <LegRow
            key={l.fundId}
            icon={fundIconOf(l.fund, l.fundId)}
            name={l.fund ? fundLabel(l.fund).name : l.fundId}
            sub={l.route === 'closed' && l.why ? `${Math.round(l.weight * 1000) / 10}% · ${l.why}` : `${Math.round(l.weight * 1000) / 10}% · ${ROUTE_WORDS[l.route]}`}
            value={usdIn ? fmtUsd(l.usd) : DASH}
            st={states[l.fundId]}
            stepText={step ? label(step) : 'Sending'}
          />
        ))}
      </ul>

      <div className="fx-kv">
        <div><span>From Spot, order-book legs</span><b>{`${fmtUsd(needSpot)} of ${bal ? fmtUsd(bal.spot) : '…'}`}</b></div>
        <div><span>From your wallet, vault and USDC Earn legs</span><b>{`${fmtUsd(needWallet)} of ${bal ? fmtUsd(bal.wallet) : '…'}`}</b></div>
      </div>
      {bal && (needSpot > bal.spot || needWallet > bal.wallet) && (
        <p className="fx-note">
          {needSpot > bal.spot && <><button type="button" className="fx-link" onClick={() => requestTransfer({ to: 'spot', coin: 'USDC' })}>Move USDC to Spot</button>. </>}
          {needWallet > bal.wallet && <button type="button" className="fx-link" onClick={() => requestTransfer({ to: 'evm', coin: 'USDC' })}>Move USDC to your wallet</button>}
        </p>
      )}

      {finished && !error ? (
        <>
          <p className="fx-note fx-note--ok">Every leg was sent. Order-book legs fill at once; vault legs arrive when SoDEX settles them, USDC Earn in about a minute. They show in your holdings.</p>
          {onClose && <button type="button" className="fx-cta" onClick={onClose}>Done</button>}
        </>
      ) : !provider ? (
        <p className="fx-note">Reconnect your wallet: some legs are wallet transactions on ValueChain.</p>
      ) : (
        <button type="button" className="fx-cta" disabled={busy || !usdIn || !!problem || !bal} onClick={() => void run()}>
          {busy ? <Spinner label="Sending" /> : `Buy ${legs.length} funds`}
        </button>
      )}
      {problem && !busy && <p className="fx-note fx-note--err">{problem}</p>}
      {error && <p className="fx-note fx-note--err" role="alert">{error}</p>}
      <p className="fx-note">{`Weights are fixed when you buy and then move with prices; nothing rebalances. Order-book legs carry ValueDesk’s usual builder fee; vault and USDC Earn legs carry none. ${fmt(legs.length, 0)} confirmations at most.`}</p>
    </div>
  );
}

// --- on a schedule ------------------------------------------------------------------------------------

export function BuyRecurring({ ix, w, address, provider, onDone, onClose }: {
  ix: VdIndex; w: WealthState; address: string; provider: Eip1193Provider | null; onDone: () => void; onClose?: () => void;
}) {
  const targets = useRecurringTargets(w.funds);
  const [amount, setAmount] = useState('');
  const [type, setType] = useState<PlanType>('WEEKLY');
  const [day, setDay] = useState(1);
  const [pf, setPf] = useState<PrefundFacts | null>(null);
  const [fund, setFund] = useState('');
  const [touchedFund, setTouchedFund] = useState(false);
  const [states, setStates] = useState<Record<string, LegState>>({});
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<FundsStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const label = useStepLabel();

  useEffect(() => { let off = false; readPrefund(address).then((f) => { if (!off) setPf(f); }).catch(() => undefined); return () => { off = true; }; }, [address, finished]);

  const blocked = targets ? notRecurring(ix, targets) : [];
  const perRun = usdUnits(amount);
  const legs = targets ? recurringLegs(ix, perRun, targets) : [];
  const min = targets ? recurringMinimum(ix, targets) : 0n;
  const available = pf?.available ?? null;
  const short = available !== null && perRun > available ? perRun - available : 0n;
  const addUnits = usdUnits(fund);
  const covered = available !== null && perRun > 0n && available + addUnits >= perRun;
  useEffect(() => { if (!touchedFund) setFund(short > 0n ? formatUnits(short, USDC_DP) : ''); }, [short, touchedFund]);

  const pickType = (v: PlanType) => { setType(v); setDay(v === 'DAILY' ? 0 : v === 'MONTHLY' ? (day >= 1 && day <= 30 ? day : 1) : day >= 1 && day <= 5 ? day : 1); };
  const dayOptions: FxOption[] = type === 'MONTHLY'
    ? Array.from({ length: 30 }, (_, i) => ({ value: String(i + 1), label: `Day ${i + 1}` }))
    : WEEKDAYS.map((d, i) => ({ value: String(i + 1), label: d }));

  const problem = !targets ? null
    : blocked.length ? `Not on SoDEX’s recurring-buy list: ${blocked.map((id) => fundNameOf(w.funds, id)).join(', ')}. Buy this index once instead.`
    : !perRun ? null
    : perRun < min ? `This index needs at least ${usd(min)} per purchase: every fund has its own minimum.`
    : dayProblem(type, day)
    ?? (pf && addUnits > pf.walletUsdc ? 'Not enough USDC in your wallet on ValueChain to add that.' : null)
    ?? (pf && pf.gasBalance === 0n ? 'This wallet has no SOSO for gas on ValueChain.' : null);

  const run = async () => {
    if (!provider || !targets) return;
    setBusy(true);
    setError(null);
    const record = { id: ix.id, at: Date.now(), perRun: Number(formatUnits(perRun, USDC_DP)), type, day, legs: [] as Array<{ fundId: string; usd: number; ok: boolean }> };
    try {
      if (addUnits > 0n) {
        setStates({ _funds: { status: 'busy' } });
        await addFunds({ provider, owner: address, amount: addUnits, onStep: setStep });
        setStates({ _funds: { status: 'done' } });
        setTouchedFund(true);
        setFund('');
      }
    } catch (e) {
      const msg = isUserRejection(e) ? 'You declined it in your wallet.' : (e as Error).message;
      setStates({ _funds: { status: 'failed', note: msg } });
      setError(`The balance was not topped up: ${msg} No plan was created.`);
      setBusy(false);
      setStep(null);
      return;
    }
    for (const l of legs) {
      setStates((s) => ({ ...s, [l.fundId]: { status: 'busy' } }));
      try {
        await createPlan({ provider, owner: address, target: l.target!, amount: l.amount, type, day, onStep: setStep });
        record.legs.push({ fundId: l.fundId, usd: Number(formatUnits(l.amount, USDC_DP)), ok: true });
        setStates((s) => ({ ...s, [l.fundId]: { status: 'done' } }));
      } catch (e) {
        const msg = isUserRejection(e) ? 'You declined it in your wallet.' : (e as Error).message;
        record.legs.push({ fundId: l.fundId, usd: Number(formatUnits(l.amount, USDC_DP)), ok: false });
        setStates((s) => ({ ...s, [l.fundId]: { status: 'failed', note: msg } }));
        setError(`Stopped at ${fundNameOf(w.funds, l.fundId)}: ${msg} The plans before it were created; end them under Recurring Buys if you do not want them.`);
        break;
      } finally {
        setStep(null);
      }
    }
    if (record.legs.some((x) => x.ok)) { saveIndexPlan(address, record); onDone(); }
    setBusy(false);
    setFinished(true);
  };

  if (!targets) return <div className="fx-stack"><p className="fx-note"><Spinner /> Reading which funds SoDEX buys on a schedule</p></div>;

  const markets = [...new Set(legs.map((l) => l.target?.market).filter((m): m is 0 | 1 => m === 0 || m === 1))];
  // In the index ticket's trade-page look (owner 2026-11-28: "I want the top looking the same, just with an
  // additional recurring option"): facts, an amount row, the schedule as the ticket's tabs, the read-out, the button.
  return (
    <div className="it-body it-rec">
      <dl className="oe-facts">
        <div className="oe-facts__row"><dt>Pre-funded balance</dt><dd className={available === null ? 'is-dim' : ''}>{available === null ? <Spinner /> : `${usd(available)} USDC`}</dd></div>
        <div className="oe-facts__row"><dt>Minimum per purchase</dt><dd>{min > 0n && !blocked.length ? `${usd(min)} USDC` : DASH}</dd></div>
      </dl>
      <div className="oe-field">
        <div className={`oe-inputrow${problem && perRun ? ' is-bad' : ''}`}>
          <label className="oe-inlabel" htmlFor="it-rec-amt">Per purchase</label>
          <input id="it-rec-amt" className="oe-input" value={toInputText(amount)} onChange={(e) => { setAmount(decimalInput(e.target.value, { prev: amount })); setStates({}); setFinished(false); }} inputMode="decimal" placeholder={toInputText('0.00')} autoComplete="off" aria-label="Amount per purchase" disabled={busy || !!blocked.length} />
          <span className="oe-suffix">USDC</span>
        </div>
      </div>
      <div className="oe-tabs it-rec__freq" role="tablist" aria-label="Frequency">
        {PLAN_TYPES.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={type === t} className={`oe-tab${type === t ? ' is-on' : ''}`} onClick={() => pickType(t)} disabled={busy}>{PLAN_LABEL[t]}</button>
        ))}
      </div>
      {type !== 'DAILY' && (
        <div className="it-rec__day">
          <span>{type === 'MONTHLY' ? 'Day of the month' : 'Day'}</span>
          <FxSelect value={String(day)} options={dayOptions} onChange={(v) => setDay(Number(v))} label={type === 'MONTHLY' ? 'Day of the month' : 'Weekday'} searchable={false} />
        </div>
      )}

      <ul className="vdi-plan">
        {states._funds && <LegRow icon="USDC" name="Pre-funded balance" sub="Top-up" value={usd(addUnits || 0n)} st={states._funds} stepText={step ? label(step) : 'Sending'} />}
        {legs.map((l) => (
          <LegRow
            key={l.fundId}
            icon={fundIconOf(w.funds?.find((f) => f.fundId === l.fundId), l.fundId)}
            name={fundNameOf(w.funds, l.fundId)}
            sub={l.target ? `${Math.round(l.weight * 1000) / 10}% · ${MARKET_LABEL[l.target.market]} · min ${usd(l.target.minAmount)}${perRun ? ` · from ${dateOnly(firstRunDate(type, day, l.target.market))}` : ''}` : `${Math.round(l.weight * 1000) / 10}% · Not on SoDEX’s recurring list`}
            value={perRun ? usd(l.amount) : DASH}
            st={states[l.fundId]}
            stepText={step ? label(step) : 'Sending'}
          />
        ))}
      </ul>

      {!blocked.length && (
        <div className="oe-field">
          <div className="oe-inputrow">
            <label className="oe-inlabel" htmlFor="it-rec-fund">Top up</label>
            <button type="button" className="oe-chip" title="Everything in your wallet on ValueChain" disabled={!pf || pf.walletUsdc <= 0n || busy} onClick={() => { setTouchedFund(true); setFund(pf ? formatUnits(pf.walletUsdc, USDC_DP) : ''); }}>MAX</button>
            <input id="it-rec-fund" className="oe-input" value={toInputText(fund)} onChange={(e) => { setTouchedFund(true); setFund(decimalInput(e.target.value, { prev: fund })); }} inputMode="decimal" placeholder={toInputText('0.00')} autoComplete="off" aria-label="Add to the balance" disabled={busy} />
            <span className="oe-suffix">USDC</span>
          </div>
        </div>
      )}

      <dl className="oe-out">
        <div className="oe-out__row"><dt className="oe-out__k">Schedule</dt><dd className="oe-out__v oe-out__v--small">{scheduleWords(type, day)}</dd></div>
        <div className="oe-out__row"><dt className="oe-out__k">Wallet on ValueChain</dt><dd className="oe-out__v oe-out__v--small">{pf ? `${usd(pf.walletUsdc)} USDC` : DASH}</dd></div>
        <div className="oe-out__row"><dt className="oe-out__k">Confirmations</dt><dd className="oe-out__v oe-out__v--small">{`${legs.length + (addUnits > 0n ? 1 : 0)}`}</dd></div>
      </dl>

      {perRun > 0n && !covered && !blocked.length && <p className="it-err">The first purchase is not covered: top up the balance first.</p>}
      {markets.length > 1 && <p className="it-note">The plans buy in their own market’s morning: China funds by China time, US funds by US time.</p>}
      {problem && !busy && <p className="it-err" role="alert">{problem}</p>}
      {error && <p className="it-err" role="alert">{error}</p>}
      {pf && addUnits > pf.walletUsdc && <button type="button" className="oe-chip it-rec__move" onClick={() => requestTransfer({ to: 'evm', coin: 'USDC' })}>Move USDC to your wallet</button>}
      {finished && !error ? <p className="it-ok">{`${legs.length} recurring plans created, one per fund. Pause, change or end each below.`}</p> : null}
      <div className="oe-side">
        {!provider ? <button type="button" className="oe-side__btn is-buy" disabled>Reconnect your wallet</button> : (
          <button type="button" className="oe-side__btn is-buy" disabled={busy || !perRun || !!problem || !covered} onClick={() => void run()}>
            {busy ? <Spinner label="Sending" /> : addUnits > 0n ? `Top up and start ${legs.length} plans` : `Start ${legs.length} plans`}
          </button>
        )}
      </div>
      {onClose && finished && !error && <button type="button" className="oe-chip" onClick={onClose}>Done</button>}
    </div>
  );
}

// --- both -------------------------------------------------------------------------------------------

/** Once or on a schedule, side by side: the index page's panel and the board's sheet. */
export function IndexBuy({ ix, w, address, provider, onDone, onClose, mode: initial = 'once' }: {
  ix: VdIndex; w: WealthState; address: string | null; provider: Eip1193Provider | null; onDone: () => void; onClose?: () => void; mode?: BuyMode;
}) {
  const [mode, setMode] = useState<BuyMode>(initial);
  if (!address) return <NoWallet line="Connect a wallet to buy an index." compact />;
  return (
    <div className="wp-buy">
      <ViewSeg value={mode} options={MODES} onChange={setMode} label="How to buy" />
      {mode === 'once'
        ? <BuyOnce key={`o${ix.id}`} ix={ix} w={w} address={address} provider={provider} onDone={onDone} onClose={onClose} />
        : <BuyRecurring key={`r${ix.id}`} ix={ix} w={w} address={address} provider={provider} onDone={onDone} onClose={onClose} />}
    </div>
  );
}

export function IndexBuySheet({ ix, onClose, w, address, provider, onDone }: {
  ix: VdIndex | null; onClose: () => void; w: WealthState; address: string | null; provider: Eip1193Provider | null; onDone: () => void;
}) {
  return (
    <Modal open={!!ix} title={ix ? `Buy ${ix.name}` : ''} onClose={onClose} size="sm" className="fx fx-money vdi-sheet rc-sheet">
      {ix && <IndexTicket key={ix.id} ix={ix} w={w} address={address} provider={provider} onDone={onDone} />}
    </Modal>
  );
}

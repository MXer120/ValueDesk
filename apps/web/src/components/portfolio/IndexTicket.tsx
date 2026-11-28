/**
 * Buying and selling an index, drawn like the trade page's ticket (owner 2026-11-28: "Buy & sell needs redesign, make
 * it look like on the trade page ... Recurring just needs to be the third tab next to buy sell. And recurring needs to
 * support everything sodex does"). The trade page's own parts (OrderEntry.css): the underlined tabs, the bordered input
 * row, the read-out rows and the green and red action buttons.
 *
 *   Buy        every leg now, each through its fund's channel; a vault, USDC Earn or ANT Believers leg is a
 *              subscription (sodex.com's word), an order-book leg a buy
 *   Sell       a share of what the wallet holds of each leg: an order-book leg sold on the book, a batch vault or USDC
 *              Earn redeemed from here; a maker-quote leg (CXMT/Unitree in session, ANT Believers) opens its own sheet,
 *              which fetches and checks the maker's quote
 *   Recurring  one SoDEX plan per leg on one schedule (IndexBuy.tsx), and below it the wallet's plans with all that
 *              sodex.com offers: change, pause, resume, end, history, and the pre-funded balance in and out
 */
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { CoinIcon } from '../CoinIcon';
import { NoWallet } from '../EmptyState';
import { decimalInput } from '../numberInput';
import { Spinner, useStepLabel } from '../funds/ui';
import { DASH, fmtUsd, num } from '../../format';
import { useMask } from '../../privacy';
import { parseUnits } from '../../trading/onboard';
import { balancesOf, type FundsStep } from '../../trading/funds';
import { placeOrder } from '../../trading/actions';
import { readGateway } from '../../trading/gateway';
import { getTradingState, subscribeTrading } from '../../trading/session';
import { requestEnableTrading } from '../account/actions';
import { fillQuote, fundLabel, requestQuote, requestVault, QUOTE_REASON, type JoinedHolding, type WealthFund } from '../../trading/wealth';
import { earnCoins, requestEarn } from '../../trading/wealthEarn';
import { minimumFor, planLegs, saveBuy, type IndexBuy as IndexBuyRecord, type PlannedLeg, type VdIndex, LEG_READING } from '../../trading/vdIndexes';
import { isUserRejection, type Eip1193Provider } from '../../wallet';
import { useNow } from '../sodex/parts';
import { RecurringPanel, useRecurring } from './RecurringBuys';
import { BuyRecurring, useFundActions } from './IndexBuy';
import { fundIconOf, fundNameOf, useMinimums } from './indexParts';
import { openWealth } from './WealthHero';
import type { WealthState } from './useWealth';
import '../OrderEntry.css';

type Tab = 'buy' | 'sell' | 'recurring';
type LegState = { status: 'busy' | 'done' | 'failed' | 'sheet'; note?: string };

/** sodex.com's words per channel: a subscription into a vault, USDC Earn or an SSI index; a buy on the order book. */
const subscribes = (f: WealthFund | null | undefined): boolean => !!f && f.fundType !== 'clob';
const inWord = (f: WealthFund | null | undefined) => (subscribes(f) ? 'Subscribe' : 'Buy');
const outWord = (f: WealthFund | null | undefined) => (subscribes(f) ? 'Redeem' : 'Sell');

/** What the wallet holds of a fund that a sell can move: the spot balance of an order-book fund, the wallet's shares otherwise. */
/**
 * An SSI token's spot balance (vMAG7.ssi), free of what rests in orders: SoDEX's Wealth holdings do not list SSI
 * tokens, so without this Sell found nothing to sell (live test 2026-11-28).
 */
function useSpotCoins(address: string, want: boolean, token: unknown): Map<string, number> | null {
  const [m, setM] = useState<Map<string, number> | null>(null);
  useEffect(() => {
    if (!want) return;
    let off = false;
    readGateway<{ B?: Array<{ a?: string; t?: string; wb?: string; l?: string }> } | null>(`/api/v1/spot/accounts/${address}/state`)
      .then((st) => { if (!off) setM(new Map((st?.B ?? []).map((r) => [String(r.a ?? '').toUpperCase(), Math.max(0, num(r.t ?? r.wb) - num(r.l))]))); })
      .catch(() => { if (!off) setM(new Map()); });
    return () => { off = true; };
  }, [address, want, token]);
  return m;
}

function sellable(h: JoinedHolding | undefined, f: WealthFund | null, spot?: Map<string, number> | null, price?: number): { shares: number; value: number } {
  if (f?.spotOnly) {
    const shares = spot?.get(`V${f.share.coin}`.toUpperCase()) ?? spot?.get(f.share.coin.toUpperCase()) ?? 0;
    return { shares, value: price && price > 0 ? shares * price : 0 };
  }
  if (!h || !f || !(h.shares > 0)) return { shares: 0, value: 0 };
  const shares = f.fundType === 'clob' ? h.spotShares : h.evmShares;
  const value = h.marketValue !== null ? h.marketValue * (shares / h.shares) : 0;
  return { shares, value };
}

/**
 * Order-book legs need this browser's trading key, as on the trade page; the Wealth page had no way to make one, so a
 * buy stopped at its first order-book leg ("Enable trading first", live test 2026-11-28). The ticket asks for it here.
 */
function useTradingKey(): 'enabled' | 'restoring' | 'off' {
  const t = useSyncExternalStore(subscribeTrading, getTradingState, getTradingState);
  return t.status === 'enabled' ? 'enabled' : t.status === 'restoring' ? 'restoring' : 'off';
}

function EnableButton({ state, side }: { state: 'restoring' | 'off'; side: 'buy' | 'sell' }) {
  return (
    <button type="button" className={`oe-side__btn is-${side}${state === 'restoring' ? ' is-wait' : ''}`} disabled={state === 'restoring'} onClick={() => requestEnableTrading()}>
      {state === 'restoring' ? <Spinner label="Checking trading" /> : 'Enable trading'}
    </button>
  );
}

function Row({ k, v, cls }: { k: string; v: ReactNode; cls?: string }) {
  return <div className="oe-out__row"><dt className="oe-out__k">{k}</dt><dd className={`oe-out__v oe-out__v--small${cls ? ` ${cls}` : ''}`}>{v}</dd></div>;
}

function LegLine({ f, id, sub, value, st, step }: { f: WealthFund | null; id: string; sub: string; value: ReactNode; st?: LegState; step: string }) {
  return (
    <li className={`it-leg${st ? ` is-${st.status}` : ''}`} title={st?.note}>
      <CoinIcon coin={fundIconOf(f, id)} size={20} />
      <span className="it-leg__n"><b>{f ? fundLabel(f).name : id}</b><small>{sub}</small></span>
      <b className="it-leg__v">{value}</b>
      <span className="it-leg__s" aria-live="polite">{st ? (st.status === 'busy' ? step : st.status === 'done' ? 'Sent' : st.status === 'sheet' ? 'Opened' : 'Failed') : ''}</span>
    </li>
  );
}

export function IndexTicket({ ix, w, address, provider, onDone }: { ix: VdIndex; w: WealthState; address: string | null; provider: Eip1193Provider | null; onDone: () => void }) {
  const [tab, setTab] = useState<Tab>('buy');
  return (
    <div className="oe it">
      <div className="oe-tabs" role="tablist" aria-label="Buy, sell or recurring">
        {(['buy', 'sell', 'recurring'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`oe-tab${tab === t ? ' is-on' : ''}`} onClick={() => setTab(t)}>
            {t === 'buy' ? 'Buy' : t === 'sell' ? 'Sell' : 'Recurring'}
          </button>
        ))}
      </div>
      {!address ? <div className="it-body"><NoWallet line="Connect a wallet to buy or sell an index." compact /></div>
        : tab === 'buy' ? <BuyTab key={`b${ix.id}`} ix={ix} w={w} address={address} provider={provider} onDone={onDone} />
        : tab === 'sell' ? <SellTab key={`s${ix.id}`} ix={ix} w={w} address={address} provider={provider} onDone={onDone} />
        : <RecurringTab key={`r${ix.id}`} ix={ix} w={w} address={address} provider={provider} onDone={onDone} />}
    </div>
  );
}

// --- buy ----------------------------------------------------------------------------------------------

function BuyTab({ ix, w, address, provider, onDone }: { ix: VdIndex; w: WealthState; address: string; provider: Eip1193Provider | null; onDone: () => void }) {
  const actions = useFundActions(w.funds);
  useNow(30_000);
  const mins = useMinimums(w.funds, ix.legs.map((l) => l.fundId));
  const [amount, setAmount] = useState('');
  const [bal, setBal] = useState<{ spot: number; wallet: number } | null>(null);
  const [states, setStates] = useState<Record<string, LegState>>({});
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<FundsStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const key = useTradingKey();
  const label = useStepLabel();
  const usd = num(amount);
  const legs = planLegs(ix, usd, w.funds, actions);
  const min = minimumFor(ix, mins);
  const needSpot = legs.filter((l) => l.from === 'spot').reduce((t, l) => t + l.usd, 0);
  const needWallet = legs.filter((l) => l.from === 'wallet').reduce((t, l) => t + l.usd, 0);
  const closed = legs.filter((l) => l.route === 'closed');
  // The most this wallet can put in: each source's balance over the share of the index it pays for.
  const spotShare = legs.filter((l) => l.from === 'spot').reduce((t, l) => t + l.weight, 0);
  const walletShare = legs.filter((l) => l.from === 'wallet').reduce((t, l) => t + l.weight, 0);
  const spendable = bal ? Math.min(spotShare > 0 ? bal.spot / spotShare : Infinity, walletShare > 0 ? bal.wallet / walletShare : Infinity) : null;

  useEffect(() => {
    let off = false;
    void earnCoins().then((c) => balancesOf(address, c.usdc)).then((b) => { if (!off) setBal({ spot: num(b.spot), wallet: num(b.evm) }); }).catch(() => undefined);
    return () => { off = true; };
  }, [address, finished]);

  // Until SoDEX's fund list is read every leg would look unlisted: nothing is judged before it is.
  const loading = !w.funds || legs.some((l) => l.why === LEG_READING);
  const problem = !usd || loading ? null
    : usd < min ? `This index starts at ${fmtUsd(min, 0)}: every leg has its own minimum.`
    : closed.length ? `${closed.map((l) => (l.fund ? fundLabel(l.fund).name : l.fundId)).join(', ')}: ${(closed[0]!.why ?? 'closed').replace(/\.$/, '')}.`
    : bal && needSpot > bal.spot + 1e-9 ? 'Not enough USDC in Spot for the order-book legs.'
    : bal && needWallet > bal.wallet + 1e-9 ? 'Not enough USDC in your wallet on ValueChain for the subscriptions.'
    : null;

  const run = async () => {
    if (!provider) return;
    setBusy(true);
    setError(null);
    const record: IndexBuyRecord = { id: ix.id, at: Date.now(), usd, legs: [] };
    for (const l of legs) {
      setStates((s) => ({ ...s, [l.fundId]: { status: 'busy' } }));
      try {
        const units = parseUnits(l.usd.toFixed(2), 6);
        if (l.route === 'spot') await placeOrder('spot', { symbol: l.fund!.spot!.symbol, side: 'buy', type: 'market', funds: l.usd.toFixed(2) });
        else if (l.route === 'earn') await requestEarn({ provider, owner: address, side: 'buy', amount: units, onStep: setStep });
        else if (l.route === 'batch') await requestVault({ provider, owner: address, fundId: l.fundId, side: 'buy', amount: units, onStep: setStep });
        else if (l.route === 'rfq' && l.fund?.fundType === 'ssi-v2') {
          // ANT Believers Index: its own sheet fetches the maker's signed order and checks it before the wallet is asked.
          openWealth({ kind: 'vault', fundId: l.fundId, side: 'buy' });
          setStates((s) => ({ ...s, [l.fundId]: { status: 'sheet', note: 'Finish it in its sheet' } }));
          record.legs.push({ fundId: l.fundId, usd: l.usd, units: null, ok: false });
          continue;
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

  const pick = (p: number) => { if (spendable) setAmount(String(Math.floor(spendable * p * 100) / 100)); };
  return (
    <div className="it-body">
      <div className={`oe-inputrow${problem && usd ? ' is-bad' : ''}`}>
        <label className="oe-inlabel" htmlFor="it-amt">Amount</label>
        <input id="it-amt" className="oe-input" value={amount} onChange={(e) => { setAmount(decimalInput(e.target.value, { prev: amount })); setStates({}); setFinished(false); }} inputMode="decimal" placeholder="0.00" autoComplete="off" disabled={busy} />
        <span className="oe-suffix"><CoinIcon coin="USDC" size={14} />&nbsp;USDC</span>
      </div>
      <div className="it-pcts" role="group" aria-label="Part of what you can spend">
        {[0.25, 0.5, 0.75, 1].map((p) => <button key={p} type="button" className="it-pct" disabled={!spendable || busy} onClick={() => pick(p)}>{p === 1 ? 'Max' : `${p * 100}%`}</button>)}
      </div>
      <ul className="it-legs">
        {legs.map((l) => (
          <LegLine key={l.fundId} f={l.fund} id={l.fundId} st={states[l.fundId]} step={step ? label(step) : 'Sending'}
            sub={l.route === 'closed' && l.why ? l.why.replace(/^Trading temporarily unavailable · Resuming in (.+)$/, 'Paused · $1') : `${Math.round(l.weight * 1000) / 10}% · ${inWord(l.fund)} · ${channelWord(l)}`}
            value={usd ? fmtUsd(l.usd) : DASH} />
        ))}
      </ul>
      <dl className="oe-out">
        <Row k="Minimum" v={min > 0 ? fmtUsd(min, 0) : DASH} />
        <Row k="From Spot" v={`${fmtUsd(needSpot)} of ${bal ? fmtUsd(bal.spot) : '…'}`} cls={bal && needSpot > bal.spot ? 'is-neg' : undefined} />
        <Row k="From your wallet" v={`${fmtUsd(needWallet)} of ${bal ? fmtUsd(bal.wallet) : '…'}`} cls={bal && needWallet > bal.wallet ? 'is-neg' : undefined} />
        <Row k="Confirmations" v={`${legs.length} at most`} />
      </dl>
      {problem && !busy && <p className="it-err" role="alert">{problem}</p>}
      {error && <p className="it-err" role="alert">{error}</p>}
      {finished && !error ? <p className="it-ok">Every leg was sent. Order-book legs fill at once; subscriptions arrive when SoDEX settles them.</p> : null}
      <div className="oe-side">
        {provider && !busy && key !== 'enabled' && legs.some((l) => l.route === 'spot') ? <EnableButton state={key} side="buy" /> : <button type="button" className="oe-side__btn is-buy" disabled={!provider || busy || !usd || loading || !!problem || !bal} onClick={() => void run()}>
          {busy ? <Spinner label="Sending" /> : !provider ? 'Reconnect your wallet' : `Buy ${ix.legs.length} funds`}
        </button>}
      </div>
      <p className="it-note">Weights fixed when bought, then held as bought; nothing rebalances. Order-book legs carry ValueDesk’s builder fee; subscriptions carry none.</p>
    </div>
  );
}

const channelWord = (l: Pick<PlannedLeg, 'route' | 'fund'>) =>
  l.route === 'spot' ? 'order book' : l.route === 'earn' ? 'bridge, about a minute' : l.route === 'batch' ? 'batch, at the next price' : l.fund?.fundType === 'ssi-v2' ? 'maker quote, at once' : 'maker quote';

// --- sell ---------------------------------------------------------------------------------------------

function SellTab({ ix, w, address, provider, onDone }: { ix: VdIndex; w: WealthState; address: string; provider: Eip1193Provider | null; onDone: () => void }) {
  const actions = useFundActions(w.funds);
  const maskFunds = useMask('funds');
  const [pct, setPct] = useState(50);
  const [states, setStates] = useState<Record<string, LegState>>({});
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<FundsStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const label = useStepLabel();
  const key = useTradingKey();
  const [sold, setSold] = useState(0);
  const spot = useSpotCoins(address, ix.legs.some((l) => w.funds?.find((x) => x.fundId === l.fundId)?.spotOnly), `${sold}|${w.holdings?.length ?? 0}`);
  const rows = useMemo(() => ix.legs.map((l) => {
    const f = w.funds?.find((x) => x.fundId === l.fundId) ?? null;
    const h = w.holdings?.find((x) => x.fundId === l.fundId);
    const s = sellable(h, f, spot, num(w.quotes.get(l.fundId)?.price));
    const a = actions.get(l.fundId) ?? null;
    const how: 'book' | 'batch' | 'earn' | 'sheet' | 'none' = !f || s.shares <= 0 ? 'none' : f.fundType === 'clob' ? 'book' : f.fundType === 'bridged_vault' ? 'earn' : a?.kind === 'batch' ? 'batch' : 'sheet';
    return { l, f, s, how };
  }), [ix, w.funds, w.holdings, w.quotes, actions, spot]);
  const total = rows.reduce((t, r) => t + r.s.value, 0) * (pct / 100);
  const any = rows.some((r) => r.how !== 'none');

  const run = async () => {
    if (!provider) return;
    setBusy(true);
    setError(null);
    for (const r of rows) {
      if (r.how === 'none') continue;
      const qty = r.s.shares * (pct / 100);
      setStates((s) => ({ ...s, [r.l.fundId]: { status: 'busy' } }));
      try {
        if (r.how === 'sheet') {
          openWealth({ kind: 'vault', fundId: r.l.fundId, side: 'sell' });
          setStates((s) => ({ ...s, [r.l.fundId]: { status: 'sheet', note: 'Finish it in its sheet' } }));
          continue;
        }
        if (r.how === 'book') {
          await placeOrder('spot', { symbol: r.f!.spot!.symbol, side: 'sell', type: 'market', quantity: (Math.floor(qty * 1e6) / 1e6).toString() });
        } else if (r.how === 'earn') {
          const c = await earnCoins();
          await requestEarn({ provider, owner: address, side: 'sell', amount: parseUnits((Math.floor(qty * 1e6) / 1e6).toString(), c.share.valuechain.decimals), onStep: setStep });
        } else if (r.how === 'batch') {
          const dec = r.f!.share.decimals;
          await requestVault({ provider, owner: address, fundId: r.l.fundId, side: 'sell', amount: parseUnits(qty.toFixed(Math.min(dec, 8)), dec), onStep: setStep });
        }
        setStates((s) => ({ ...s, [r.l.fundId]: { status: 'done' } }));
      } catch (e) {
        const msg = isUserRejection(e) ? 'You declined it in your wallet.' : (e as Error).message;
        setStates((s) => ({ ...s, [r.l.fundId]: { status: 'failed', note: msg } }));
        setError(`Stopped at ${r.f ? fundLabel(r.f).name : r.l.fundId}: ${msg} The legs before it went through.`);
        break;
      } finally {
        setStep(null);
      }
    }
    onDone();
    setSold((n) => n + 1);
    setBusy(false);
  };

  return (
    <div className="it-body">
      <div className="oe-slider it-slider">
        <div className="oe-slider__rail" style={{ ['--oe-p' as string]: pct / 100 }}>
          <div className="oe-slider__fill" />
          <input className="oe-slider__input" type="range" min={0} max={100} step={1} value={pct} aria-label="Part of each holding to sell" onChange={(e) => setPct(Number(e.target.value))} disabled={busy} />
        </div>
      </div>
      <div className="it-pcts" role="group" aria-label="Part of each holding">
        {[25, 50, 75, 100].map((p) => <button key={p} type="button" className={`it-pct${pct === p ? ' is-on' : ''}`} disabled={busy} onClick={() => setPct(p)}>{p === 100 ? 'All' : `${p}%`}</button>)}
      </div>
      <ul className="it-legs">
        {rows.map((r) => (
          <LegLine key={r.l.fundId} f={r.f} id={r.l.fundId} st={states[r.l.fundId]} step={step ? label(step) : 'Sending'}
            sub={r.how === 'none' ? 'Nothing held' : `${outWord(r.f)} · ${r.how === 'book' ? 'order book, at once' : r.how === 'earn' ? 'bridge, about a minute' : r.how === 'batch' ? 'batch, at the next price' : 'maker quote, in its sheet'}`}
            value={r.how === 'none' ? DASH : maskFunds(fmtUsd(r.s.value * (pct / 100)))} />
        ))}
      </ul>
      <dl className="oe-out">
        <Row k="Part of each holding" v={`${pct}%`} />
        <Row k="Value, about" v={any ? maskFunds(fmtUsd(total)) : DASH} />
      </dl>
      {!any && <p className="it-note">You hold none of these funds in this wallet.</p>}
      {error && <p className="it-err" role="alert">{error}</p>}
      <div className="oe-side">
        {provider && !busy && key !== 'enabled' && rows.some((r) => r.how === 'book') ? <EnableButton state={key} side="sell" /> : <button type="button" className="oe-side__btn is-sell" disabled={!provider || busy || !any || pct <= 0} onClick={() => void run()}>
          {busy ? <Spinner label="Sending" /> : !provider ? 'Reconnect your wallet' : `Sell ${pct}% of each`}
        </button>}
      </div>
      <p className="it-note">Sells what this wallet holds of each fund, wherever it came from. A maker-quote leg opens its own sheet for the maker’s price.</p>
    </div>
  );
}

// --- recurring ----------------------------------------------------------------------------------------

function RecurringTab({ ix, w, address, provider, onDone }: { ix: VdIndex; w: WealthState; address: string; provider: Eip1193Provider | null; onDone: () => void }) {
  const [ended, setEnded] = useState(false);
  const rec = useRecurring(address, 0, w.funds, ended);
  const ids = new Set(ix.legs.map((l) => l.fundId));
  // The wallet's plans in this index's funds; the rest stay on the Wealth page.
  const scoped = useMemo(() => ({
    ...rec,
    active: rec.active ? { ...rec.active, plans: rec.active.plans.filter((p) => !!p.fundId && ids.has(p.fundId)) } : rec.active,
    ended: rec.ended ? { ...rec.ended, plans: rec.ended.plans.filter((p) => !!p.fundId && ids.has(p.fundId)) } : rec.ended,
  }), [rec, ix]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="it-body">
      <BuyRecurring ix={ix} w={w} address={address} provider={provider} onDone={onDone} />
      <h4 className="it-h">Your plans in these funds</h4>
      <RecurringPanel rec={scoped} funds={w.funds} address={address} onOpen={(target) => openWealth({ kind: 'recurring-sheet', target })} ended={ended} setEnded={setEnded} />
    </div>
  );
}


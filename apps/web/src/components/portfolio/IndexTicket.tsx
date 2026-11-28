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
import { DraftInput, decimalInput, integerInput } from '../numberInput';
import { toInputText } from '../../numStyle';
import { useVenueFees } from '../useVenueFees';
import { FeeSchedule } from '../FeeSchedule';
import { useBuilderFee } from '../account/useBuilderFee';
import { fmtRate, withBuilder } from '../../fees';
import { readInfo } from './FundAbout';
import { useLanguage } from '../../i18n/store';
import { Spinner, useStepLabel } from '../funds/ui';
import { DASH, fmtUsd, num } from '../../format';
import { useMask } from '../../privacy';
import { parseUnits } from '../../trading/onboard';
import { balancesOf, transferFunds, type FundsStep } from '../../trading/funds';
import { placeOrder } from '../../trading/actions';
import { WEALTH_FEE } from '../../trading/feeGuard';
import { readGateway } from '../../trading/gateway';
import { getTradingState, subscribeTrading } from '../../trading/session';
import { requestEnableTrading } from '../account/actions';
import { fillQuote, fundLabel, requestQuote, requestVault, QUOTE_REASON, type JoinedHolding, type WealthFund } from '../../trading/wealth';
import { earnCoins, requestEarn } from '../../trading/wealthEarn';
import { minimumFor, planLegs, saveBuy, type IndexBuy as IndexBuyRecord, type PlannedLeg, type VdIndex, LEG_READING } from '../../trading/vdIndexes';
import { isUserRejection, type Eip1193Provider } from '../../wallet';
import { useNow } from '../sodex/parts';
import { STATUS_WORD, nameOf, useRecurring, type RecurringSheetTarget } from './RecurringBuys';
import { scheduleWords } from '../../trading/recurring';
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

/** The trade page's size slider (OrderEntry.tsx): rail, striped fill, notches at 0/25/50/75/100 and a % box. */
const NOTCHES = [0, 25, 50, 75, 100];
function PctSlider({ pct, onPct, label, disabled }: { pct: number; onPct: (p: number) => void; label: string; disabled?: boolean }) {
  return (
    <div className="oe-slider">
      <div className="oe-slider__rail" style={{ ['--oe-p' as string]: pct / 100 }}>
        <div className="oe-slider__fill" />
        {NOTCHES.map((n) => <i key={n} className={`oe-slider__notch${pct >= n ? ' is-past' : ''}`} style={{ left: `${n}%` }} aria-hidden="true" />)}
        <input className="oe-slider__input" type="range" min={0} max={100} step={1} value={pct} aria-label={label} disabled={disabled}
          onChange={(e) => { e.currentTarget.parentElement?.style.setProperty('--oe-p', String(Number(e.currentTarget.value) / 100)); onPct(Number(e.currentTarget.value)); }} />
      </div>
      <div className="oe-inputrow oe-pctbox">
        <DraftInput className="oe-input" value={pct > 0 ? String(pct) : ''} onDraft={(t) => onPct(t === '' ? 0 : Math.min(100, Number(t)))} sanitize={(raw) => integerInput(raw)} inputMode="numeric" aria-label={label} placeholder="0" disabled={disabled} />
        <span className="oe-suffix">%</span>
      </div>
    </div>
  );
}

/**
 * Fees as the trade page shows them (owner 2026-11-28: "also fees if they're documented from sodex side"): the
 * order-book legs at this account's SoDEX spot taker rate with ValueDesk's builder fee in it, the row opening the
 * same fee schedule; subscription legs at the management fee their vault states on chain (SoDEX's fund details), or
 * "Not stated" where SoDEX states none. Nothing is assumed.
 */
/** ValueDesk's builder fee on an index's order-book legs: 0.01% (owner 2026-11-28), tenths of a bp (feeGuard.ts). SoDEX charges a spot builder fee on sells only. */
const WEALTH_BUILDER_FEE = WEALTH_FEE;

function FeeRows({ legs, side, address }: { legs: ReadonlyArray<{ fundId: string; route: 'spot' | 'sub'; usd?: number }>; side: 'buy' | 'sell'; address: string }) {
  const [open, setOpen] = useState(false);
  const venue = useVenueFees(address);
  const builder = useBuilderFee('spot', side, address);
  const lang = useLanguage();
  const subs = legs.filter((l) => l.route === 'sub').map((l) => l.fundId);
  const [mgmt, setMgmt] = useState<Array<{ fundId: string; fee: number | null }> | null>(null);
  const subKey = subs.join(',');
  useEffect(() => {
    if (!subs.length) { setMgmt([]); return; }
    let off = false;
    void Promise.allSettled(subs.map((id) => readInfo(id, lang))).then((rs) => {
      if (!off) setMgmt(rs.map((r, i) => ({ fundId: subs[i]!, fee: r.status === 'fulfilled' ? r.value?.vault?.managementFee ?? null : null })));
    });
    return () => { off = true; };
  }, [subKey, lang]); // eslint-disable-line react-hooks/exhaustive-deps
  const book = legs.some((l) => l.route === 'spot');
  const taker = venue.spot?.taker ?? null;
  // The builder share as it is charged: SoDEX takes it on spot sells only, at most the Wealth fee.
  const builderFrac = side === 'sell' && builder?.charged ? Math.min(builder.fraction, WEALTH_BUILDER_FEE / 100_000) : 0;
  const bookRate = taker !== null ? withBuilder(taker, builderFrac) : null;
  const bookUsd = legs.filter((l) => l.route === 'spot').reduce((t, l) => t + (l.usd ?? 0), 0);
  const bookFee = bookRate !== null ? `${fmtRate(bookRate)}${bookUsd > 0 ? ` · ${fmtUsd(bookUsd * bookRate)}` : ''}` : null;
  const known = (mgmt ?? []).filter((m) => m.fee !== null && m.fee > 0);
  const subFee = !subs.length ? null : mgmt === null ? '…' : known.length ? `${known.map((m) => `${(m.fee! * 100).toFixed(2)}%`).filter((v, i, a) => a.indexOf(v) === i).join(' / ')} a year` : 'Not stated';
  return (
    <>
      {book && (
        <div className="oe-out__row">
          <dt className="oe-out__k"><button type="button" className="oe-feebtn" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} title="Fee schedule">Fees, order book</button></dt>
          <dd className="oe-out__v"><button type="button" className="oe-feebtn" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} title="Fee schedule">{bookFee ?? DASH}</button></dd>
        </div>
      )}
      {subFee !== null && <Row k="Fund fee, on chain" v={subFee} />}
      <FeeSchedule open={open} onClose={() => setOpen(false)} engine="spot" address={address} rates={venue} />
    </>
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

/**
 * `card`: the trade page's own ticket card (OrderEntry.tsx .panel.oe) with its glow, on the index page. The glow there
 * grows with leverage; here with the share of capital the slider is at (owner 2026-11-28: "the glow thing we did, but
 * instead of leverage bound to % of capital"). In a sheet it is the plain ticket.
 */
export function IndexTicket({ ix, w, address, provider, onDone, card }: { ix: VdIndex; w: WealthState; address: string | null; provider: Eip1193Provider | null; onDone: () => void; card?: boolean }) {
  const [tab, setTab] = useState<Tab>('buy');
  const [heat, setHeat] = useState(0);
  useEffect(() => { setHeat(0); }, [tab]);
  return (
    <section
      className={`${card ? 'panel ' : ''}oe it is-${tab === 'sell' ? 'sell' : 'buy'}`}
      style={card ? { ['--oe-wash' as string]: `${Math.round(7 + heat * 11)}%`, ['--oe-edge' as string]: `${Math.round(22 + heat * 28)}%` } : undefined}
    >
      {card && <div className="oe-fx" aria-hidden="true"><span className="oe-fx__rim"><span className="oe-fx__glare" /></span></div>}
      {/* The trade page's direction tabs (OrderEntry.tsx .oe-dir--tabs), with Recurring as a third. */}
      <div className="oe-dir oe-dir--tabs it-dir" role="radiogroup" aria-label="Buy, sell or recurring">
        {(['buy', 'sell', 'recurring'] as const).map((t) => (
          <button key={t} type="button" role="radio" aria-checked={tab === t} className={`oe-dir__btn is-${t === 'sell' ? 'sell' : t === 'buy' ? 'buy' : 'rec'}${tab === t ? ' is-on' : ''}`} onClick={() => setTab(t)}>
            {t === 'buy' ? 'Buy' : t === 'sell' ? 'Sell' : 'Recurring'}
          </button>
        ))}
      </div>
      {!address ? <div className="it-body"><NoWallet line="Connect a wallet to buy or sell an index." compact /></div>
        : tab === 'buy' ? <BuyTab key={`b${ix.id}`} ix={ix} w={w} address={address} provider={provider} onDone={onDone} onHeat={setHeat} />
        : tab === 'sell' ? <SellTab key={`s${ix.id}`} ix={ix} w={w} address={address} provider={provider} onDone={onDone} onHeat={setHeat} />
        : <RecurringTab key={`r${ix.id}`} ix={ix} w={w} address={address} provider={provider} onDone={onDone} />}
    </section>
  );
}

/**
 * The wallet's plans in this index's funds, in the ticket's width (owner 2026-11-28: "the your plans looks bad"): the
 * pre-funded balance with Add funds and Withdraw, My plans / Ended, and one line per plan opening its own sheet.
 */
function PlanList({ rec, funds, ended, setEnded, onOpen }: {
  rec: ReturnType<typeof useRecurring>; funds: readonly WealthFund[] | null; ended: boolean; setEnded: (v: boolean) => void; onOpen: (t: RecurringSheetTarget) => void;
}) {
  const maskFunds = useMask('funds');
  const read = ended ? rec.ended : rec.active;
  const plans = read?.plans ?? null;
  const balance = rec.active?.availableAssets ?? null;
  return (
    <section className="it-plans" aria-label="Your plans in these funds">
      <div className="it-plans__h">
        <b>Your plans</b>
        <div className="oe-tabs it-plans__seg" role="tablist" aria-label="Plans">
          {([['active', 'Active'], ['ended', 'Ended']] as const).map(([v, l]) => (
            <button key={v} type="button" role="tab" aria-selected={(v === 'ended') === ended} className={`oe-tab${(v === 'ended') === ended ? ' is-on' : ''}`} onClick={() => setEnded(v === 'ended')}>{l}</button>
          ))}
        </div>
      </div>
      <dl className="oe-facts">
        <div className="oe-facts__row">
          <dt>Pre-funded balance</dt>
          <dd>{balance === null ? (rec.error ? DASH : <Spinner />) : maskFunds(`${fmtUsd(num(balance))} USDC`)}</dd>
        </div>
      </dl>
      <div className="it-plans__acts">
        <button type="button" className="oe-chip" onClick={() => onOpen({ kind: 'funds', side: 'add' })}>Add funds</button>
        <button type="button" className="oe-chip" disabled={balance === null || num(balance) <= 0} onClick={() => onOpen({ kind: 'funds', side: 'withdraw' })}>Withdraw</button>
      </div>
      {rec.error && !read ? <p className="it-err">{rec.error}</p>
        : !plans ? <p className="it-dim"><Spinner /> Reading your plans</p>
        : plans.length === 0 ? <p className="it-dim">{ended ? 'No ended plans in these funds.' : 'No plans in these funds yet.'}</p>
        : (
          <ul className="it-legs it-plans__list">
            {plans.map((p) => {
              const f = funds?.find((x) => x.fundId === p.fundId);
              return (
                <li key={`${p.dcaAddress ?? ''}:${p.planIndex}`}>
                  <button type="button" className="it-plan" onClick={() => onOpen({ kind: ended || p.status === 'CANCELLED' ? 'history' : 'edit', plan: p } as RecurringSheetTarget)}>
                    <CoinIcon coin={p.share?.coin ?? f?.share.coin ?? ''} size={20} />
                    <span className="it-plan__t"><b>{nameOf(funds, p)}</b><small>{`${scheduleWords(p.planType, p.dayOfPeriod)} · ${STATUS_WORD[p.status] ?? p.status}`}</small></span>
                    <span className="it-plan__v">{maskFunds(fmtUsd(num(p.amount)))}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
    </section>
  );
}

// --- buy ----------------------------------------------------------------------------------------------

function BuyTab({ ix, w, address, provider, onDone, onHeat }: { ix: VdIndex; w: WealthState; address: string; provider: Eip1193Provider | null; onDone: () => void; onHeat: (h: number) => void }) {
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
  void walletShare;
  // Subscriptions pay from the wallet on ValueChain; what it lacks is moved from Spot as the first step of the buy
  // (owner 2026-11-28: "make the UX as easy as possible"). So the most is all USDC in both, with Spot covering the
  // order-book legs too.
  const spendable = bal ? Math.min(bal.spot + bal.wallet, spotShare > 0 ? bal.spot / spotShare : Infinity) : null;
  const moveFromSpot = bal ? Math.max(0, Math.ceil((needWallet - bal.wallet) * 100) / 100) : 0;

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
    : bal && needSpot + needWallet > bal.spot + bal.wallet + 1e-9 ? 'Not enough USDC in Spot and your wallet together.'
    : bal && needSpot + moveFromSpot > bal.spot + 1e-9 ? 'Not enough USDC in Spot for the order-book legs.'
    : null;

  const run = async () => {
    if (!provider) return;
    setBusy(true);
    setError(null);
    const record: IndexBuyRecord = { id: ix.id, at: Date.now(), usd, legs: [] };
    if (moveFromSpot > 0) {
      setStates((s) => ({ ...s, _move: { status: 'busy' } }));
      try {
        const c = await earnCoins();
        await transferFunds({ owner: address, provider, coin: c.usdc, from: 'spot', to: 'evm', amount: moveFromSpot.toFixed(2), onStep: setStep });
        // Wait until the wallet holds what the subscriptions need (SoDEX pays it out on ValueChain), 3 minutes at most.
        const until = Date.now() + 180_000;
        for (;;) {
          const b = await balancesOf(address, c.usdc);
          if (num(b.evm) + 1e-9 >= needWallet) break;
          if (Date.now() > until) throw new Error('The USDC moved from Spot has not reached your wallet yet. It is on its way; buy again once it shows.');
          await new Promise((r) => setTimeout(r, 3_000));
        }
        setStates((s) => ({ ...s, _move: { status: 'done' } }));
      } catch (e) {
        const msg = isUserRejection(e) ? 'You declined it in your wallet.' : (e as Error).message;
        setStates((s) => ({ ...s, _move: { status: 'failed', note: msg } }));
        setError(`Nothing was bought: ${msg}`);
        setBusy(false);
        setStep(null);
        setFinished(true);
        return;
      } finally {
        setStep(null);
      }
    }
    for (const l of legs) {
      setStates((s) => ({ ...s, [l.fundId]: { status: 'busy' } }));
      try {
        const units = parseUnits(l.usd.toFixed(2), 6);
        if (l.route === 'spot') await placeOrder('spot', { symbol: l.fund!.spot!.symbol, side: 'buy', type: 'market', funds: l.usd.toFixed(2) }, { program: 'wealth' });
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

  const pick = (p: number) => { if (spendable) { setAmount(p > 0 ? String(Math.floor(spendable * (p / 100) * 100) / 100) : ''); setStates({}); setFinished(false); } };
  const base = spendable && spendable > 0 && Number.isFinite(spendable) ? spendable : bal ? bal.spot + bal.wallet : 0;
  const pct = base > 0 && usd > 0 ? Math.min(100, Math.round((usd / base) * 100)) : 0;
  // The glow: the share of this wallet's USDC (Spot and wallet) the amount is.
  const capital = bal ? bal.spot + bal.wallet : 0;
  const heat = capital > 0 && usd > 0 ? Math.min(1, usd / capital) : 0;
  useEffect(() => { onHeat(heat); }, [heat]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="it-body">
      <dl className="oe-facts">
        <div className="oe-facts__row"><dt>Available to buy</dt><dd className={bal === null ? 'is-dim' : ''}>{bal === null ? DASH : `${fmtUsd(bal.spot + bal.wallet)} USDC`}</dd></div>
        <div className="oe-facts__row"><dt>Minimum buy</dt><dd>{min > 0 ? `${fmtUsd(min, 0)} USDC` : DASH}</dd></div>
      </dl>
      <div className="oe-field">
        <div className={`oe-inputrow${problem && usd ? ' is-bad' : ''}`}>
          <label className="oe-inlabel" htmlFor="it-amt">Amount</label>
          <button type="button" className="oe-chip" title="The most this wallet can put in" disabled={!spendable || busy} onClick={() => pick(100)}>MAX</button>
          <input id="it-amt" className="oe-input" value={toInputText(amount)} onChange={(e) => { setAmount(decimalInput(e.target.value, { prev: amount })); setStates({}); setFinished(false); }} inputMode="decimal" placeholder={toInputText('0.00')} autoComplete="off" disabled={busy} />
          <span className="oe-suffix">USDC</span>
        </div>
      </div>
      <PctSlider pct={pct} onPct={pick} label="Amount as a percentage of what you can spend" disabled={!spendable || busy} />
      <ul className="it-legs">
        {moveFromSpot > 0 && !problem && <LegLine f={null} id="Spot to your wallet" st={states._move} step={step ? label(step) : 'Moving'} sub="For the subscriptions, first; no wallet prompt" value={fmtUsd(moveFromSpot)} />}
        {legs.map((l) => (
          <LegLine key={l.fundId} f={l.fund} id={l.fundId} st={states[l.fundId]} step={step ? label(step) : 'Sending'}
            sub={l.route === 'closed' && l.why ? l.why.replace(/^Trading temporarily unavailable · Resuming in (.+)$/, 'Paused · $1') : `${Math.round(l.weight * 1000) / 10}% · ${inWord(l.fund)} · ${channelWord(l)}`}
            value={usd ? fmtUsd(l.usd) : DASH} />
        ))}
      </ul>
      <dl className="oe-out">
        {/* Order-book legs pay from Spot; subscriptions (USDC Earn, the batch vaults) from USDC in the wallet on ValueChain. */}
        {needSpot > 0 && <Row k="Spot, for order-book funds" v={`${fmtUsd(needSpot)} of ${bal ? fmtUsd(bal.spot) : '…'}`} cls={bal && needSpot > bal.spot ? 'is-neg' : undefined} />}
        {needWallet > 0 && <Row k="Wallet on ValueChain, for subscriptions" v={`${fmtUsd(needWallet)} of ${bal ? fmtUsd(bal.wallet) : '…'}`} cls={bal && needWallet > bal.wallet ? 'is-neg' : undefined} />}
        <Row k="Confirmations" v={`${legs.length} at most`} />
        <FeeRows legs={legs.filter((l) => l.route !== 'closed').map((l) => ({ fundId: l.fundId, route: l.route === 'spot' ? 'spot' as const : 'sub' as const, usd: l.usd }))} side="buy" address={address} />
      </dl>
      {problem && !busy && <p className="it-err" role="alert">{problem}</p>}
      {error && <p className="it-err" role="alert">{error}</p>}
      {finished && !error ? <p className="it-ok">Every leg was sent. Order-book legs fill at once; subscriptions arrive when SoDEX settles them.</p> : null}
      <div className="oe-side">
        {provider && !busy && key !== 'enabled' && (legs.some((l) => l.route === 'spot') || moveFromSpot > 0) ? <EnableButton state={key} side="buy" /> : <button type="button" className="oe-side__btn is-buy" disabled={!provider || busy || !usd || loading || !!problem || !bal} onClick={() => void run()}>
          {busy ? <Spinner label="Sending" /> : !provider ? 'Reconnect your wallet' : `Buy ${ix.legs.length} funds`}
        </button>}
      </div>
    </div>
  );
}

const channelWord = (l: Pick<PlannedLeg, 'route' | 'fund'>) =>
  l.route === 'spot' ? 'order book' : l.route === 'earn' ? 'bridge, about a minute' : l.route === 'batch' ? 'batch, at the next price' : l.fund?.fundType === 'ssi-v2' ? 'maker quote, at once' : 'maker quote';

// --- sell ---------------------------------------------------------------------------------------------

function SellTab({ ix, w, address, provider, onDone, onHeat }: { ix: VdIndex; w: WealthState; address: string; provider: Eip1193Provider | null; onDone: () => void; onHeat: (h: number) => void }) {
  const actions = useFundActions(w.funds);
  const maskFunds = useMask('funds');
  const [frac, setFrac] = useState(0);
  const [amount, setAmount] = useState('');
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
  const held = rows.reduce((t, r) => t + r.s.value, 0);
  const pct = Math.round(frac * 100);
  const total = held * frac;
  const setPct = (p: number) => { const f = Math.max(0, Math.min(1, p / 100)); setFrac(f); setAmount(f > 0 && held > 0 ? (Math.floor(held * f * 100) / 100).toFixed(2) : ''); };
  useEffect(() => { onHeat(frac); }, [frac]); // eslint-disable-line react-hooks/exhaustive-deps
  const typed = (v: string) => { setAmount(v); const n = num(v); setFrac(held > 0 && n > 0 ? Math.min(1, n / held) : 0); };
  const any = rows.some((r) => r.how !== 'none');

  const run = async () => {
    if (!provider) return;
    setBusy(true);
    setError(null);
    for (const r of rows) {
      if (r.how === 'none') continue;
      const qty = r.s.shares * frac;
      setStates((s) => ({ ...s, [r.l.fundId]: { status: 'busy' } }));
      try {
        if (r.how === 'sheet') {
          openWealth({ kind: 'vault', fundId: r.l.fundId, side: 'sell' });
          setStates((s) => ({ ...s, [r.l.fundId]: { status: 'sheet', note: 'Finish it in its sheet' } }));
          continue;
        }
        if (r.how === 'book') {
          await placeOrder('spot', { symbol: r.f!.spot!.symbol, side: 'sell', type: 'market', quantity: (Math.floor(qty * 1e6) / 1e6).toString() }, { program: 'wealth' });
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
      <dl className="oe-facts">
        <div className="oe-facts__row"><dt>Held in these funds</dt><dd className={!any ? 'is-dim' : ''}>{any ? maskFunds(`${fmtUsd(held)} USDC`) : DASH}</dd></div>
      </dl>
      <div className="oe-field">
        <div className="oe-inputrow">
          <label className="oe-inlabel" htmlFor="it-sell">Amount</label>
          <button type="button" className="oe-chip" title="Sell all of it" disabled={!any || busy} onClick={() => setPct(100)}>MAX</button>
          <input id="it-sell" className="oe-input" value={toInputText(amount)} onChange={(e) => typed(decimalInput(e.target.value, { prev: amount }))} inputMode="decimal" placeholder={toInputText('0.00')} autoComplete="off" disabled={!any || busy} />
          <span className="oe-suffix">USDC</span>
        </div>
      </div>
      <PctSlider pct={pct} onPct={setPct} label="Part of each holding to sell" disabled={!any || busy} />
      <ul className="it-legs">
        {rows.map((r) => (
          <LegLine key={r.l.fundId} f={r.f} id={r.l.fundId} st={states[r.l.fundId]} step={step ? label(step) : 'Sending'}
            sub={r.how === 'none' ? 'Nothing held' : `${outWord(r.f)} · ${r.how === 'book' ? 'order book, at once' : r.how === 'earn' ? 'bridge, about a minute' : r.how === 'batch' ? 'batch, at the next price' : 'maker quote, in its sheet'}`}
            value={r.how === 'none' ? DASH : maskFunds(fmtUsd(r.s.value * frac))} />
        ))}
      </ul>
      <dl className="oe-out">
        <Row k="Part of each holding" v={`${pct}%`} />
        <Row k="Value, about" v={any ? maskFunds(fmtUsd(total)) : DASH} />
        <FeeRows legs={rows.filter((r) => r.how !== 'none').map((r) => ({ fundId: r.l.fundId, route: r.how === 'book' ? 'spot' as const : 'sub' as const, usd: r.s.value * frac }))} side="sell" address={address} />
      </dl>
      {!any && <p className="it-note">You hold none of these funds in this wallet.</p>}
      {error && <p className="it-err" role="alert">{error}</p>}
      <div className="oe-side">
        {provider && !busy && key !== 'enabled' && rows.some((r) => r.how === 'book') ? <EnableButton state={key} side="sell" /> : <button type="button" className="oe-side__btn is-sell" disabled={!provider || busy || !any || pct <= 0} onClick={() => void run()}>
          {busy ? <Spinner label="Sending" /> : !provider ? 'Reconnect your wallet' : `Sell ${pct}% of each`}
        </button>}
      </div>
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
      <PlanList rec={scoped} funds={w.funds} ended={ended} setEnded={setEnded} onOpen={(target) => openWealth({ kind: 'recurring-sheet', target })} />
    </div>
  );
}


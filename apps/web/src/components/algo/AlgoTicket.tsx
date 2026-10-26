/**
 * The algo half of the order ticket: the inputs the major venues show for an
 * algo order type in their own forms (INLINE_KEYS in draft.ts), a preview
 * drawn from the engine's own plan, and the start. Everything else is in the
 * kind's Advanced pop-up, where it runs first (never a control on the panel:
 * the summary line names it, and a note says why when it cannot start there).
 *
 * WHAT THE TICKET SHARES. Direction, leverage, margin mode, the Amount field
 * (and its % slider) and Reduce only stay the ticket's own: an algo of 0.5 BTC
 * is sized exactly like a limit of 0.5 BTC. Everything below them is the
 * algo's.
 *
 * WHAT YOU SEE IS WHAT RUNS. The preview and the runner call the same engine
 * functions (planAlgo / twapSchedule ...) with the same seed, which is handed
 * to the runner at start - the bars are the slices that go out. VWAP is the one
 * exception: its volume profile is read again, at a finer grain, when it starts.
 *
 * Every rule is validated by the engine's parser (checkAlgoSpec), the one the
 * runner and the executors use, so the ticket cannot start what they refuse.
 * Its errors are shown under the field they belong to; the rest under the
 * preview.
 *
 * The draft and its spec live in draft.ts; where it runs, in executor.ts.
 */
import { forwardRef, useEffect, useId, useImperativeHandle, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  ALGO_NAMES,
  checkAlgoSpec,
  makerPrice,
  newSeed,
  planAlgo,
  volumeProfile,
  type AlgoPlan,
  type AlgoSpec,
  type BoundAction,
  type Candle,
  type ConditionType,
  type MarketInfo,
  type VolumeProfile,
} from '@copy-engine';
import { api, type Symbol as MarketSymbol } from '../../api';
import { algoOwner } from '../../algo/algoBus';
import { executorReady, startOn } from '../../algo/executorAlgos';
import { getLiveCopy, subscribeLiveCopy } from '../../copy/live';
import { DASH, fmtTime, fmtUsd } from '../../format';
import { openTab } from '../../router';
import { notify } from '../../toast';
import { Modal, useConfirm } from '../Modal';
import { decimalInput, integerInput } from '../numberInput';
import { LadderPreview, LevelsPreview, TimelinePreview, type Level } from './AlgoPreview';
import {
  advancedChanges,
  autoSlices,
  cond,
  draftToSpec,
  errFor,
  frac,
  hasBounds,
  hasLimit,
  hasRandomize,
  legs,
  loadDraft,
  n,
  offersExits,
  opt,
  randomizeOn,
  resetAdvanced,
  saveDraft,
  scaleSize,
  setRandomize,
  setScaleSize,
  slicesOf,
  UNIT_NAME,
  type CondDraft,
  type Draft,
  type LegDraft,
  type ScaleSize,
  type TicketShared,
  type Unit,
} from './draft';
import { PLACES, readExecutor, writeExecutor, type Place } from './executor';
import { engineKind, fmtDuration, menuName, usesAmount, type UiKind } from './menu';
import './algo.css';

export { draftToSpec, offersExits, type TicketShared } from './draft';

/** A price level as the preview shows it (SoDEX snaps it to the tick when it is placed). */
const fmtLevel = (x: number): string => x.toLocaleString('en-US', { maximumFractionDigits: Math.abs(x) >= 1000 ? 1 : Math.abs(x) >= 1 ? 4 : 6 });

/** A Symbol from the app's market list, as the engine's MarketInfo. */
export function marketOf(sym: MarketSymbol): MarketInfo {
  return {
    id: sym.id,
    name: sym.name,
    base: sym.baseCoin,
    tickSize: sym.tickSize,
    stepSize: sym.stepSize,
    minQuantity: sym.minQuantity || sym.stepSize,
    maxQuantity: sym.maxQuantity ?? '0',
    marketMaxQuantity: sym.marketMaxQuantity ?? null,
    minNotional: Number(sym.minNotional) > 0 ? Number(sym.minNotional) : 10,
    maxNotional: Number(sym.maxNotional) > 0 ? Number(sym.maxNotional) : null,
    maxLeverage: sym.maxLeverage ?? 1,
    buyLimitUpRatio: 0.05,
    sellLimitDownRatio: 0.05,
    takerFee: Number(sym.takerFee) || 0.0004,
    ...(Number.isFinite(Number(sym.makerFee)) && sym.makerFee !== '' ? { makerFee: Number(sym.makerFee) } : {}),
    status: 'TRADING',
  };
}

/** The spec fields whose errors a kind shows under its own inline fields (the rest go under the preview). */
const INLINE_ERRORS: Record<UiKind, readonly string[]> = {
  twap: ['durationMs', 'closeShare'],
  chasetwap: ['durationMs'],
  vwap: ['durationMs'],
  pov: ['rate'],
  iceberg: ['price', 'displayQty'],
  chase: ['maxChaseBps'],
  scale: ['from', 'to', 'orders'],
  dca: ['perOrderUsd', 'intervalMs', 'orders'],
  swarm: ['clips'],
  trailing: ['trailPct', 'trailAbs', 'activationPrice'],
  bracket: ['price', 'exits'],
  basket: ['durationMs'],
  conditional: [],
};

/** Where it runs, in the few words the summary line gives it. */
const PLACE_WORDS: Record<Place, string> = { hosted: 'on ValueDesk', browser: 'in this browser', self: 'on your copier' };

const SCALE_SIZES: ReadonlyArray<readonly [ScaleSize, string, string]> = [
  ['flat', 'Flat', 'Every order the same size'],
  ['increasing', 'Increasing', 'Bigger toward To'],
  ['decreasing', 'Decreasing', 'Bigger toward From'],
  ['bell', 'Bell', 'Biggest in the middle'],
];

/* ------------------------------------------------------------ controls ----- */

/** Whole numbers; a leading minus where the field allows one (an offset that steps inside the spread). */
const wholeInput = (raw: string, signed: boolean): string => {
  const neg = signed && raw.trim().startsWith('-');
  return (neg ? '-' : '') + integerInput(raw, 5);
};

/**
 * One number, drawn like the ticket's own Price and Amount boxes: the name on
 * the left, the value right-aligned, the unit on the right (a word, or a unit
 * picker drawn like the Amount field's). An error shows under it, in words.
 */
function Field({ label, value, onChange, suffix, placeholder, int = false, signed = false, title, err }: {
  label: string; value: string; onChange: (v: string) => void; suffix?: ReactNode; placeholder?: string; int?: boolean; signed?: boolean; title?: string; err?: string;
}) {
  const id = useId();
  return (
    <>
      <div className={`oe-inputrow algo-in${err ? ' is-bad' : ''}`} title={title}>
        <label className="oe-inlabel" htmlFor={id}>{label}</label>
        <input
          id={id}
          className="oe-input"
          autoComplete="off"
          inputMode={int ? 'numeric' : 'decimal'}
          value={value}
          placeholder={placeholder ?? ''}
          aria-invalid={err ? true : undefined}
          aria-describedby={err ? `${id}-err` : undefined}
          onChange={(e) => onChange(int ? wholeInput(e.target.value, signed) : decimalInput(e.target.value, { signed }))}
        />
        {suffix === undefined || suffix === '' ? null : typeof suffix === 'string' ? <span className="oe-suffix">{suffix}</span> : suffix}
      </div>
      {err && <p id={`${id}-err`} className="oe-hint algo-ferr">{err}</p>}
    </>
  );
}

function Seg<T extends string | number>({ label, value, options, onChange, title }: {
  label?: string; value: T; options: ReadonlyArray<readonly [T, string, string?]>; onChange: (v: T) => void; title?: string;
}) {
  return (
    <div className="algo-seg" role="radiogroup" aria-label={label} title={title}>
      {label && <span className="algo-seg__k">{label}</span>}
      <div className="algo-seg__opts">
        {options.map(([v, text, hint]) => (
          <button key={String(v)} type="button" role="radio" aria-checked={value === v} title={hint} className={`oe-mini${value === v ? ' is-on' : ''}`} onClick={() => onChange(v)}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

/** A unit inside a field's box, picked like the Amount field's unit. */
function ModeSelect<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: ReadonlyArray<readonly [T, string]>; onChange: (v: T) => void }) {
  return (
    <select className="oe-unit algo-unitsel" aria-label={`${label} unit`} value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map(([v, t]) => (
        <option key={v} value={v}>{t}</option>
      ))}
    </select>
  );
}

function UnitSelect({ label, value, units, onChange }: { label: string; value: Unit; units: readonly Unit[]; onChange: (u: Unit) => void }) {
  return <ModeSelect label={label} value={value} options={units.map((u) => [u, UNIT_NAME[u]] as const)} onChange={onChange} />;
}

function Switch({ label, checked, onChange, title }: { label: string; checked: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <label className="oe-switch algo-switch" title={title}>
      <span>{label}</span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/** Where it runs, kept across reloads and kinds (executor.ts). */
function useExecutor(): [Place, (v: Place) => void] {
  const [place, setPlace] = useState<Place>(readExecutor);
  return [
    place,
    (v: Place) => {
      setPlace(v);
      writeExecutor(v);
    },
  ];
}

/* -------------------------------------------------------------- ticket ----- */

export interface AlgoTicketState {
  ready: boolean;
  label: string;
  why: string | null;
  needsAmount: boolean;
  /** A paper algo in this browser: it signs nothing, so the ticket's wallet / trading gate does not stand before it. */
  walletFree: boolean;
  /** The ticket's Long / Short applies (not to a basket: each market has its own side). */
  sided: boolean;
}

export interface AlgoTicketHandle {
  start(): Promise<void>;
}

interface Props extends TicketShared {
  kind: UiKind;
  /** The connected wallet: the runner follows it before the algo is added. */
  address: string | null;
  sym?: MarketSymbol;
  bid: number | null;
  ask: number | null;
  last: number | null;
  network?: string;
  /** The ValueDesk builder fee on this ticket's orders, as a fraction. */
  builderFee: number;
  onState: (s: AlgoTicketState) => void;
}

const AlgoTicket = forwardRef<AlgoTicketHandle, Props>(function AlgoTicket(p, ref) {
  const [d, setD] = useState<Draft>(loadDraft);
  const [place, setPlace] = useExecutor();
  const [advOpen, setAdvOpen] = useState(false);
  const [seed, setSeed] = useState(newSeed);
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [busy, setBusy] = useState(false);
  const { confirm, dialog } = useConfirm();
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  useEffect(() => saveDraft(d), [d]);

  const kind = p.kind;
  const ek = engineKind(kind);
  const mid = p.bid && p.ask ? (p.bid + p.ask) / 2 : p.last;
  const market = useMemo(() => (p.sym ? marketOf(p.sym) : null), [p.sym]);
  const tick = Number(p.sym?.tickSize ?? '0');
  const roundTick = (x: number) => {
    const t = tick > 0 ? tick : 0.01;
    return String(Math.round(x / t) * t).replace(/(\.\d*?)0{6,}\d*$/, '$1');
  };

  // A new market or kind starts from the market's own prices, near the touch.
  useEffect(() => {
    if (!mid) return;
    setD((x) => {
      const patch: Partial<Draft> = {};
      if (kind === 'scale' && (!x.from || !x.to)) {
        patch.from = roundTick(p.side === 'buy' ? mid * 0.998 : mid * 1.002);
        patch.to = roundTick(p.side === 'buy' ? mid * 0.98 : mid * 1.02);
      }
      if (kind === 'conditional' && !x.conds.length) patch.conds = [cond(p.symbol, { value: roundTick(p.side === 'buy' ? mid * 0.99 : mid * 1.01), op: p.side === 'buy' ? 'below' : 'above' })];
      if (kind === 'basket' && !x.legs.length) patch.legs = legs(p.symbol, p.side);
      if (kind === 'bracket' && !x.entryPrice) patch.entryPrice = roundTick(p.side === 'buy' ? mid * 0.998 : mid * 1.002);
      return Object.keys(patch).length ? { ...x, ...patch } : x;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, p.symbol, p.side, !!mid]);
  useEffect(() => setD((x) => ({ ...x, from: '', to: '', conds: [], icePrice: '', entryPrice: '' })), [p.symbol]);

  // VWAP's profile and POV's pace: the market's hourly volume, from SoDEX.
  const wantsCandles = ek === 'vwap' || ek === 'pov';
  useEffect(() => {
    if (!wantsCandles) return;
    let gone = false;
    setCandles(null);
    api
      .klines('perps', p.symbol, '1h', Math.min(1000, 24 * d.lookback + 24))
      .then((r) => {
        if (!gone) setCandles((r.klines ?? []).map((k) => ({ t: Number(k.t), v: Number(k.v) })).filter((c) => Number.isFinite(c.t) && Number.isFinite(c.v)));
      })
      .catch(() => !gone && setCandles([]));
    return () => {
      gone = true;
    };
  }, [wantsCandles, p.symbol, d.lookback]);

  // Re-plan at most once a second: a start time of "now" moves with the clock.
  const [clock, setClock] = useState(() => Math.floor(Date.now() / 1000) * 1000);
  useEffect(() => {
    const t = window.setInterval(() => setClock(Math.floor(Date.now() / 1000) * 1000), 1000);
    return () => window.clearInterval(t);
  }, []);

  const raw = useMemo(() => draftToSpec(kind, d, p, clock), [kind, d, p.symbol, p.side, p.quantity, p.reduceOnly, p.leverage, p.marginMode, clock]); // eslint-disable-line react-hooks/exhaustive-deps
  const check = useMemo(() => checkAlgoSpec(raw), [raw]);
  const profile: VolumeProfile | null = useMemo(() => {
    if (ek !== 'vwap' || !candles?.length || !check.spec || check.spec.kind !== 'vwap') return null;
    return volumeProfile(candles, 3_600_000, clock, check.spec.durationMs, check.spec.slices, d.lookback);
  }, [ek, candles, check.spec, clock, d.lookback]);
  const hourVolume = useMemo(() => {
    if (!candles || candles.length < 2) return null;
    const recent = candles.slice(-25, -1);
    return recent.length ? recent.reduce((a, c) => a + c.v, 0) / recent.length : null;
  }, [candles]);
  const plan: AlgoPlan | null = useMemo(
    () => (check.spec && market ? planAlgo(check.spec, market, { now: clock, price: mid ?? null, seed, profile, hourVolume }) : null),
    [check.spec, market, clock, mid, seed, profile, hourVolume],
  );

  const needsAmount = usesAmount(kind, { trailWhole: d.trailWhole, thenClose: d.then === 'close', twapClose: d.twapClose });
  const amountMissing = needsAmount && !(Number(p.quantity) > 0);
  // Field errors are shown at once; the ticket's own Amount speaks for itself when it is empty.
  const fieldErrors: Record<string, string> = check.errors;
  const inline = INLINE_ERRORS[kind];
  const err = (...keys: string[]) => errFor(fieldErrors, ...keys);
  const restErrors = [
    ...Object.entries(fieldErrors).filter(([k]) => !inline.some((key) => k === key || k.startsWith(`${key}.`)) && !(amountMissing && k === 'quantity')).map(([, v]) => v),
    ...(amountMissing ? [] : plan?.errors ?? []),
  ];
  const allErrors = amountMissing ? [] : [...Object.values(fieldErrors), ...(plan?.errors ?? [])];

  // An executor needs the copy setup's steps (terms, sign-in, fee, key); the browser needs none of them.
  const copy = useSyncExternalStore(subscribeLiveCopy, getLiveCopy, getLiveCopy);
  const walletFree = place === 'browser' && d.paper;
  const where =
    place === 'browser'
      ? !p.address && !d.paper ? { ready: false, why: 'Connect a wallet to run it live, or switch on Paper.' } : { ready: true, why: null }
      : executorReady(place, d.paper);
  const execFee = place === 'browser' ? null : copy[place].info?.builder?.ladder?.[0]?.fee ?? null;
  const feeFraction = place === 'browser' ? p.builderFee : (execFee ?? 0) / 100_000;
  const ready = !!market && !amountMissing && !!check.spec && !!plan && !plan.errors.length && where.ready;
  const label = `Start ${menuName(kind)}${d.paper ? ' (paper)' : ''}`;
  const why = !market ? 'Loading the market…' : amountMissing ? 'Enter an amount.' : allErrors[0] ?? where.why ?? null;
  const sided = kind !== 'basket';
  useEffect(() => p.onState({ ready, label, why, needsAmount, walletFree, sided }), [ready, label, why, needsAmount, walletFree, sided]); // eslint-disable-line react-hooks/exhaustive-deps

  useImperativeHandle(ref, () => ({
    async start() {
      if (busy) return;
      const fresh = checkAlgoSpec(draftToSpec(kind, d, p, Date.now()));
      if (!fresh.spec || !plan || plan.errors.length) {
        notify('error', why ?? 'Check the algo settings.');
        return;
      }
      const spec = fresh.spec;
      const real = p.network === 'mainnet' && !spec.paper;
      const ok = await confirm({
        title: `${spec.paper ? 'Paper ' : ''}${spec.kind === 'basket' ? `${menuName(kind)} of ${spec.legs.length} markets` : `${menuName(kind)} ${p.side === 'buy' ? 'buy' : 'sell'} on ${p.symbol}`}${real ? ' — real funds' : ''}`,
        size: 'md',
        danger: real,
        confirmLabel: label,
        cancelLabel: 'Back to ticket',
        body: <Review spec={spec} plan={plan} kind={kind} feeRates={feeRates(market, feeFraction)} place={place} location={place === 'browser' ? null : copy[place].info?.location ?? null} />,
      });
      if (!ok) return;
      setBusy(true);
      try {
        if (place === 'browser') {
          const { browserAlgos } = await import('../../algo/browserAlgos');
          await browserAlgos.follow(algoOwner(p.address));
          await browserAlgos.start(spec, seed);
        } else {
          await startOn(place, spec, seed);
        }
        notify('ok', `${menuName(kind)} started${spec.paper ? ' (paper)' : ''}${place === 'hosted' ? ' on the ValueDesk executor' : place === 'self' ? ' on your copier' : ''}. Follow it in the Algos tab.`);
        setSeed(newSeed());
      } catch (e) {
        notify('error', e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
  }));

  const levels: Level[] = [];
  if (mid) levels.push({ label: 'Now', price: mid, tone: 'now' });
  if (check.spec) addLevels(levels, check.spec, { bid: p.bid, ask: p.ask, mid, market });
  if (plan?.exits?.tp) levels.push({ label: 'Take-profit', price: plan.exits.tp, tone: 'pos' });
  if (plan?.exits?.sl) levels.push({ label: 'Stop-loss', price: plan.exits.sl, tone: 'neg' });

  const rates = feeRates(market, feeFraction);
  const showTimeline = !!plan && (ek === 'twap' || ek === 'vwap' || ek === 'dca' || ek === 'swarm') && !(ek === 'twap' && d.twapClose);
  const showLadder = !!plan && (ek === 'scale' || (ek === 'iceberg' && !d.icePeg && !!opt(d.icePrice)));
  const showLevels = !showTimeline && !showLadder && levels.length > 1;

  const base = p.sym?.baseCoin ?? '';
  const exitsHere = offersExits(kind, d, p.reduceOnly);
  const changes = advancedChanges(kind, d, exitsHere);
  const dur = <UnitSelect label="Duration" value={d.durUnit} units={['m', 'h', 'd']} onChange={(u) => set({ durUnit: u })} />;
  // The ValueDesk fee, said once: the builder fee in the browser, the copy fee on an executor.
  const feeBp = place === 'browser' ? (p.builderFee > 0 ? `ValueDesk fee ${(p.builderFee * 10_000).toFixed(1)} bp` : null) : execFee ? `ValueDesk fee up to ${(execFee / 10).toFixed(1)} bp` : null;

  return (
    <div className={`algo is-${p.side}`}>
      {/* WHAT THE ORDER TYPE ESSENTIALLY NEEDS, in the ticket's own boxes. */}
      <div className="algo-fields">
        {(ek === 'twap' || ek === 'vwap') && (
          <>
            {kind === 'twap' && d.twapClose && <Field label="Close" value={d.twapCloseShare} onChange={(v) => set({ twapCloseShare: v })} suffix="% of position" err={err('closeShare')} />}
            <Field label="Duration" value={d.dur} onChange={(v) => set({ dur: v })} suffix={dur} err={err('durationMs')} />
            {hasRandomize(kind) && (
              <Switch label="Randomize" checked={randomizeOn(kind, d)} onChange={(v) => set(setRandomize(kind, v))} title="Vary each slice's size and time a little, so the order is harder to spot (how much: Advanced)" />
            )}
          </>
        )}

        {ek === 'bracket' && (
          <>
            <Seg label="Entry" value={d.entry} onChange={(v) => set({ entry: v })} options={[['market', 'Market', 'Takes at once, within your max slippage'], ['limit', 'Limit', 'Rests at your price']]} />
            {d.entry === 'limit' && <Field label="Price" value={d.entryPrice} onChange={(v) => set({ entryPrice: v })} suffix="USD" err={err('price')} />}
            <ExitFields d={d} set={set} side={p.side} always levels={plan?.exits ?? null} err={err('exits')} />
          </>
        )}

        {ek === 'basket' && (
          <>
            <BasketLegs d={d} set={set} />
            <Seg label="Each market" value={d.basketStyle} onChange={(v) => set({ basketStyle: v })} options={[['swarm', 'Swarm', 'Small takers in waves, now'], ['twap', 'TWAP', 'Slices over a time you choose']]} />
            {d.basketStyle === 'twap' && <Field label="Duration" value={d.dur} onChange={(v) => set({ dur: v })} suffix={dur} err={err('durationMs')} />}
          </>
        )}

        {ek === 'pov' && <Field label="Share of volume" value={d.rate} onChange={(v) => set({ rate: v })} suffix="%" title="Of what everyone else trades, while they trade it" err={err('rate')} />}

        {ek === 'iceberg' && (
          <>
            <Field
              label="Price"
              value={d.icePeg ? '' : d.icePrice}
              placeholder="Best price"
              onChange={(v) => set({ icePrice: v, icePeg: v.trim() === '' })}
              suffix="USD"
              title="Empty: follows the best price"
              err={err('price')}
            />
            <Field
              label="Visible"
              value={d.display}
              placeholder={Number(p.quantity) > 0 ? `e.g. ${roundQty(Number(p.quantity) / 10, p.sym?.stepSize)}` : ''}
              onChange={(v) => set({ display: v })}
              suffix={base}
              title="The size shown on the book at a time"
              err={err('displayQty')}
            />
          </>
        )}

        {ek === 'chase' && (
          <Field label="Max chase" value={d.maxChasePct} placeholder="no limit" onChange={(v) => set({ maxChasePct: v })} suffix="%" title="How far from where it started it may follow the price" err={err('maxChaseBps')} />
        )}

        {ek === 'scale' && (
          <>
            <Field label="From" value={d.from} onChange={(v) => set({ from: v })} suffix="USD" title="The first order (nearest the market, usually)" err={err('from')} />
            <Field label="To" value={d.to} onChange={(v) => set({ to: v })} suffix="USD" err={err('to')} />
            <Field label="Orders" value={d.orders} int onChange={(v) => set({ orders: v })} err={err('orders')} />
            <Seg label="Size" value={scaleSize(d)} onChange={(v) => set(setScaleSize(d, v))} options={SCALE_SIZES} />
          </>
        )}

        {ek === 'dca' && (
          <>
            <Field label="Each buy" value={d.perOrder} onChange={(v) => set({ perOrder: v })} suffix="USD" err={err('perOrderUsd')} />
            <Field label="Every" value={d.every} onChange={(v) => set({ every: v })} suffix={<UnitSelect label="Every" value={d.everyUnit} units={['m', 'h', 'd']} onChange={(u) => set({ everyUnit: u })} />} err={err('intervalMs')} />
            <Field label="Times" value={d.dcaOrders} int onChange={(v) => set({ dcaOrders: v })} err={err('orders')} />
          </>
        )}

        {ek === 'swarm' && (
          <>
            <Field label="Clips" value={d.clips} int onChange={(v) => set({ clips: v })} suffix="orders" err={err('clips')} />
            <Switch label="Randomize sizes" checked={randomizeOn(kind, d)} onChange={(v) => set(setRandomize(kind, v))} title="Clips of uneven size, so they read less like one order (how much: Advanced)" />
          </>
        )}

        {ek === 'trailing' && (
          <>
            <Field
              label="Trail"
              value={d.trail}
              onChange={(v) => set({ trail: v })}
              suffix={<ModeSelect label="Trail" value={d.trailMode} options={[['pct', '%'], ['abs', 'USD']]} onChange={(v) => set({ trailMode: v })} />}
              title={p.side === 'sell' ? 'How far the price may fall from its high' : 'How far the price may rise from its low'}
              err={err('trailPct', 'trailAbs')}
            />
            <Field label="Start at" value={d.activation} placeholder="now" onChange={(v) => set({ activation: v })} suffix="USD" title={`Start trailing once the price reaches this (${p.side === 'sell' ? 'at or above' : 'at or below'})`} err={err('activationPrice')} />
          </>
        )}

        {ek === 'conditional' && <ConditionalFields d={d} set={set} symbol={p.symbol} base={base} />}
      </div>

      {/* Where it runs is chosen in the Advanced pop-up; when it cannot start there, the why, with the way out. */}
      {!where.ready && where.why && <WhereNote why={where.why} place={place} onChange={() => setAdvOpen(true)} />}

      <div className="algo-morehead">
        <button
          type="button"
          className="algo-more"
          aria-haspopup="dialog"
          onClick={() => setAdvOpen(true)}
          title={`Runs ${PLACE_WORDS[place]}. ${changes.length ? `Changed: ${changes.join(', ')}` : 'Every other setting at its default'}`}
        >
          <svg className="algo-more__icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M2 4h7M13 4h1M2 12h1M7 12h7M2 8h3M9 8h5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            <circle cx="11" cy="4" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <circle cx="5" cy="12" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <circle cx="7" cy="8" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
          </svg>
          Advanced
          {changes.length > 0 && <span className="algo-badge" aria-label={`${changes.length} changed`}>{changes.length}</span>}
        </button>
        <Switch label="Paper" checked={d.paper} onChange={(v) => set({ paper: v })} title="Run against the live market and send nothing" />
      </div>

      {/* The preview: the plan, one line saying it, one line of cost. */}
      <div className="algo-preview">
        {showTimeline && plan && <TimelinePreview plan={plan} side={p.side} />}
        {showLadder && plan && <LadderPreview plan={plan} side={p.side} mid={mid ?? null} />}
        {showLevels && <LevelsPreview levels={levels} mid={mid ?? null} />}
        <p className="algo-what">
          {oneLine(kind, d, p.side, p.quantity, base)}
          {plan && planFacts(plan, kind) ? ` · ${planFacts(plan, kind)}` : ''}
          {` · ${PLACE_WORDS[place]}`}
        </p>
        <CostLine plan={plan} rates={rates} paper={d.paper} feeNote={feeBp} scale={ek === 'scale'} onShuffle={hasJitter(kind, d) ? () => setSeed(newSeed()) : undefined} />
        {!amountMissing && restErrors[0] && <p className="oe-hint algo-err">{restErrors[0]}</p>}
        {!allErrors.length && plan?.warnings[0] && <p className="oe-hint algo-warn">{plan.warnings[0]}</p>}
      </div>

      <Modal
        open={advOpen}
        onClose={() => setAdvOpen(false)}
        title={`${menuName(kind)}: advanced`}
        className="fx vs-confirm algo-sheet"
        footer={
          <div className="fx-review__actions">
            <button type="button" className="fx-cta fx-cta--ghost" disabled={!changes.length} onClick={() => setD((x) => resetAdvanced(kind, x))}>
              Reset
            </button>
            <button type="button" className="fx-cta" onClick={() => setAdvOpen(false)}>
              Done
            </button>
          </div>
        }
      >
        <div className="algo-rules">
          <RunsOn place={place} onChange={setPlace} where={where} />
          <Advanced kind={kind} d={d} set={set} side={p.side} base={base} mid={mid ?? null} roundTick={roundTick} exitsHere={exitsHere} exits={plan?.exits ?? null} errors={fieldErrors} />
        </div>
      </Modal>
      {dialog}
      {busy && <span className="algo-busy" aria-live="polite">Starting…</span>}
    </div>
  );
});

export default AlgoTicket;

/** The Set up link, where the reason points at Copy → Set up (an executor's steps). */
function SetupLink({ why, place }: { why: string; place: Place }) {
  return place !== 'browser' && why.includes('Set up') ? (
    <button type="button" className="algo-link" onClick={() => openTab('copy')}>Set up</button>
  ) : null;
}

/** On the ticket, only while the chosen executor cannot start it: why, and the way to fix or change it. */
function WhereNote({ why, place, onChange }: { why: string; place: Place; onChange: () => void }) {
  return (
    <p className="oe-hint algo-warn algo-whereline">
      {why}
      <SetupLink why={why} place={place} />
      <button type="button" className="algo-link" aria-haspopup="dialog" onClick={onChange}>Run elsewhere</button>
    </p>
  );
}

/** The Advanced pop-up's first section: where it runs, kept across reloads and kinds (executor.ts). */
function RunsOn({ place, onChange, where }: { place: Place; onChange: (v: Place) => void; where: { ready: boolean; why: string | null } }) {
  const hint = PLACES.find(([v]) => v === place)?.[2];
  return (
    <section className="algo-runs" aria-label="Runs on">
      <Seg label="Runs on" value={place} onChange={onChange} options={PLACES} />
      {!where.ready && where.why ? (
        <p className="oe-hint algo-warn algo-whereline">
          {where.why}
          <SetupLink why={where.why} place={place} />
        </p>
      ) : (
        hint && <p className="oe-hint">{hint}</p>
      )}
    </section>
  );
}

/** A size as the step allows (a hint, so a rough cut is fine). */
function roundQty(x: number, step?: string): string {
  const s = Number(step);
  if (!(s > 0)) return String(Number(x.toPrecision(3)));
  const q = Math.max(s, Math.floor(x / s) * s);
  const dp = (step?.split('.')[1] ?? '').replace(/0+$/, '').length;
  return q.toFixed(dp);
}

/**
 * Everything in the kind's Advanced pop-up: what the kind can be tuned by,
 * its exits, then the shared rules (a price limit, when it starts, price
 * bounds, the spread guard). Every value is the default until changed.
 */
function Advanced({ kind, d, set, side, base, mid, roundTick, exitsHere, exits, errors }: {
  kind: UiKind; d: Draft; set: (p: Partial<Draft>) => void; side: 'buy' | 'sell'; base: string; mid: number | null; roundTick: (x: number) => string;
  exitsHere: boolean; exits: { tp: number | null; sl: number | null } | null; errors: Record<string, string>;
}) {
  const ek = engineKind(kind);
  const err = (...keys: string[]) => errFor(errors, ...keys);
  const slicesField = (
    <Field
      label="Slices"
      value={d.slicesAuto ? '' : d.slices}
      placeholder={`auto · ${autoSlices(d.dur, d.durUnit)}`}
      int
      onChange={(v) => set(v.trim() === '' ? { slicesAuto: true } : { slices: v, slicesAuto: false })}
      title="How many child orders. Empty: one a minute over the duration"
      err={err('slices')}
    />
  );
  return (
    <>
      {(ek === 'twap' || ek === 'vwap') && (
        <>
          {slicesField}
          {ek === 'vwap' && (
            <>
              <Seg label="History" value={d.lookback} onChange={(v) => set({ lookback: v })} options={[[7, '7 d'], [14, '14 d'], [28, '28 d'], [41, '6 w']]} title="Days of volume the profile is the median of" />
              <Switch label="Adaptive" checked={d.adaptive} onChange={(v) => set({ adaptive: v })} title="Faster while the market trades more than usual, slower while it trades less" />
            </>
          )}
          {kind === 'twap' && (
            <>
              <div className="algo-urgency" title="Front-loaded puts more early; back-loaded more late">
                <span className="algo-seg__k">Urgency</span>
                <input type="range" min={-1} max={1} step={0.1} value={d.urgency} aria-label="Urgency" onChange={(e) => set({ urgency: Number(e.target.value) })} />
                <span className="algo-urgency__v">{d.urgency === 0 ? 'Even' : d.urgency > 0 ? `Front ${Math.round(d.urgency * 100)}` : `Back ${Math.round(-d.urgency * 100)}`}</span>
              </div>
              <Switch label="Close position" checked={d.twapClose} onChange={(v) => set({ twapClose: v })} title="Works a share of your position on this market instead of an amount, reduce-only" />
            </>
          )}
          {ek === 'twap' && (
            <>
              <Field label="Smallest slice" value={d.minSlice} placeholder="any" onChange={(v) => set({ minSlice: v })} suffix={base} title="No slice below this: what is due waits until it reaches it (except at the end)" err={err('minSliceQty')} />
              <Field label="Largest slice" value={d.maxSlice} placeholder="any" onChange={(v) => set({ maxSlice: v })} suffix={base} err={err('maxSliceQty')} />
            </>
          )}
          <ExecFields d={d} set={set} chaseOnly={kind === 'chasetwap'} />
        </>
      )}

      {ek === 'bracket' && <Field label="Max slippage" value={d.slip} onChange={(v) => set({ slip: v })} suffix="bp" title="A market entry takes at most this far past the touch" err={err('slippageBps')} />}

      {ek === 'basket' && <BasketMore d={d} set={set} slices={slicesField} />}

      {ek === 'pov' && (
        <>
          <Field label="Largest child" value={d.maxChild} placeholder="any" onChange={(v) => set({ maxChild: v })} suffix={base} err={err('maxChildQty')} />
          <Field label="Stop after" value={d.endIn} placeholder="when filled" onChange={(v) => set({ endIn: v })} suffix={<UnitSelect label="Stop after" value={d.endUnit} units={['m', 'h', 'd']} onChange={(u) => set({ endUnit: u })} />} />
          <ExecFields d={d} set={set} />
        </>
      )}

      {ek === 'iceberg' && (
        <>
          <Field label="Size varies" value={d.displayJitter} onChange={(v) => set({ displayJitter: v })} suffix="± %" title="Each visible clip's size moves up to this much either way" />
          {d.icePeg && <Field label="Offset" value={d.offsetTicks} int signed onChange={(v) => set({ offsetTicks: v })} suffix="ticks" title="Ticks behind the best price" />}
          <Field label="Refill after" value={d.refill} onChange={(v) => set({ refill: v })} suffix="s" title="Wait between clips" err={err('refillMs')} />
          <Switch label="Post only" checked={d.postOnly} onChange={(v) => set({ postOnly: v })} />
        </>
      )}

      {ek === 'chase' && (
        <>
          <Seg label="Rest" value={d.offsetMode} onChange={(v) => set({ offsetMode: v })} options={[['ticks', 'At the touch'], ['bps', 'Behind', 'Rest a set distance behind the best price']]} />
          {d.offsetMode === 'ticks' ? (
            <Field label="Offset" value={d.offsetTicks} int signed onChange={(v) => set({ offsetTicks: v })} suffix="ticks" title="0 joins the best price; -1 steps inside the spread" err={err('offsetTicks')} />
          ) : (
            <Field label="Behind" value={d.offsetBps} onChange={(v) => set({ offsetBps: v })} suffix="bp" err={err('offsetBps')} />
          )}
          <Field label="Re-price after" value={d.chaseTicks} int onChange={(v) => set({ chaseTicks: v })} suffix="ticks" title="Move once the best price is this far away" err={err('chaseTicks')} />
          <Field label="Give up after" value={d.timeout} placeholder="never" onChange={(v) => set({ timeout: v })} suffix={<UnitSelect label="Give up after" value={d.timeoutUnit} units={['s', 'm', 'h']} onChange={(u) => set({ timeoutUnit: u })} />} err={err('timeoutMs')} />
          {opt(d.timeout) && <Seg label="Then" value={d.onEnd} onChange={(v) => set({ onEnd: v })} options={[['take', 'Take'], ['cancel', 'Cancel'], ['rest', 'Leave']]} />}
        </>
      )}

      {ek === 'scale' && (
        <>
          {mid && (
            <div className="algo-seg" aria-label="Range from the price">
              <span className="algo-seg__k">Range</span>
              <div className="algo-seg__opts">
                {[0.5, 1, 2, 5, 10].map((x) => (
                  <button
                    key={x}
                    type="button"
                    className="oe-mini"
                    onClick={() => {
                      const s = side === 'buy' ? -1 : 1;
                      set({ from: roundTick(mid * (1 + s * 0.001)), to: roundTick(mid * (1 + (s * x) / 100)) });
                    }}
                  >
                    {x}%
                  </button>
                ))}
              </div>
            </div>
          )}
          {(scaleSize(d) === 'increasing' || scaleSize(d) === 'decreasing') && (
            <>
              <Seg label="Size curve" value={d.distribution === 'exponential' ? 'exponential' : 'linear'} onChange={(v) => set({ distribution: v })} options={[['linear', 'Linear', 'Each order the same step bigger'], ['exponential', 'Exp', 'Each order the same factor bigger']]} />
              <Field label="Skew" value={d.skew} onChange={(v) => set({ skew: v })} suffix="×" title="The last order's size over the first's (above 1: increasing, below: decreasing)" err={err('skew')} />
            </>
          )}
          <Seg label="Spacing" value={d.spacing} onChange={(v) => set({ spacing: v })} options={[['linear', 'Even'], ['geometric', '%', 'Even in percent'], ['front', 'Front', 'Denser near the first price'], ['back', 'Back', 'Denser near the last price']]} />
          <Field label="Size varies" value={d.scaleJitter} onChange={(v) => set({ scaleJitter: v })} suffix="± %" err={err('sizeJitter')} />
          <Switch label="Post only" checked={d.postOnly} onChange={(v) => set({ postOnly: v })} />
        </>
      )}

      {ek === 'dca' && (
        <>
          <Field label="Budget" value={d.budget} placeholder="no cap" onChange={(v) => set({ budget: v })} suffix="USD" err={err('maxTotalUsd')} />
          <Field label="Dip" value={d.dip} placeholder="off" onChange={(v) => set({ dip: v })} suffix="%" title={`Buy more when the price is this far ${side === 'buy' ? 'below' : 'above'} your average so far`} err={err('dipPct')} />
          {opt(d.dip) && <Field label="Then buy" value={d.dipMult} onChange={(v) => set({ dipMult: v })} suffix="× more" err={err('dipMultiplier')} />}
          <Seg label="Execution" value={d.exec === 'hybrid' ? 'hybrid' : d.exec} onChange={(v) => set({ exec: v })} options={[['taker', 'Taker'], ['hybrid', 'Hybrid', 'Rest, then take'], ['maker', 'Maker']]} />
        </>
      )}

      {ek === 'swarm' && (
        <>
          <Seg label="Per wave" value={d.inFlight} onChange={(v) => set({ inFlight: v })} options={[[1, '1'], [2, '2'], [5, '5'], [10, '10'], [20, '20']]} title="Clips sent at once" />
          <Field label="Between waves" value={d.waveSec} onChange={(v) => set({ waveSec: v })} suffix="s" title="Pause between waves, so the book can refill" err={err('waveMs')} />
          <Field label="Max slippage" value={d.slip} onChange={(v) => set({ slip: v })} suffix="bp" err={err('slippageBps')} />
          <Field label="Retries" value={d.retries} int onChange={(v) => set({ retries: v })} title="What did not fill goes again this many times" err={err('retries')} />
          <Field label="Size varies" value={d.sizeJitter} onChange={(v) => set({ sizeJitter: v })} suffix="± %" err={err('sizeJitter')} />
        </>
      )}

      {ek === 'trailing' && (
        <>
          <Seg label="Size" value={d.trailWhole ? 'pos' : 'amt'} onChange={(v) => set({ trailWhole: v === 'pos' })} options={[['pos', 'Position'], ['amt', 'Amount']]} />
          <Seg label="Price" value={d.source} onChange={(v) => set({ source: v })} options={[['mark', 'Mark'], ['last', 'Last']]} />
          <Seg label="Exit" value={d.exit} onChange={(v) => set({ exit: v })} options={[['market', 'Market'], ['chase', 'Chase', 'Rest at the best price first, then take']]} />
          {d.exit === 'chase' ? <Field label="Chase for" value={d.chaseSec} onChange={(v) => set({ chaseSec: v })} suffix="s" err={err('chaseMs')} /> : <Field label="Max slippage" value={d.slip} onChange={(v) => set({ slip: v })} suffix="bp" err={err('slippageBps')} />}
        </>
      )}

      {ek === 'conditional' && <ConditionalMore d={d} set={set} />}

      {exitsHere && kind !== 'bracket' && <ExitFields d={d} set={set} side={side} always={false} levels={exits} err={err('exits')} />}

      {hasLimit(kind) && (
        <Field label="Limit" value={d.limitPrice} placeholder="none" onChange={(v) => set({ limitPrice: v })} suffix="USD" title={`Never ${side === 'buy' ? 'buy above' : 'sell below'} this price`} err={err('limitPrice')} />
      )}
      <Seg label="Start" value={d.startMode} onChange={(v) => set({ startMode: v })} options={[['now', 'Now'], ['delay', 'Later'], ['price', 'At a price']]} />
      {d.startMode === 'delay' && <Field label="Start in" value={d.startDelay} onChange={(v) => set({ startDelay: v })} suffix="min" err={err('startAt')} />}
      {d.startMode === 'price' && <Field label="When mark" value={d.startPrice} onChange={(v) => set({ startPrice: v })} suffix="USD" title="Starts once the mark reaches this, from wherever it is now" err={err('triggerPrice')} />}
      {hasBounds(kind) && (
        <>
          <div className="algo-bound">
            <Field label="Above" value={d.upper} placeholder="none" onChange={(v) => set({ upper: v })} suffix="USD" err={err('upper')} />
            <Seg value={d.upperThen} onChange={(v) => set({ upperThen: v })} options={BOUND_OPTS} />
          </div>
          <div className="algo-bound">
            <Field label="Below" value={d.lower} placeholder="none" onChange={(v) => set({ lower: v })} suffix="USD" err={err('lower')} />
            <Seg value={d.lowerThen} onChange={(v) => set({ lowerThen: v })} options={BOUND_OPTS} />
          </div>
          <Field label="Max spread" value={d.maxSpread} placeholder="any" onChange={(v) => set({ maxSpread: v })} suffix="bp" title="Take nothing while the spread is wider" err={err('maxSpreadBps')} />
        </>
      )}
    </>
  );
}

const BOUND_OPTS: ReadonlyArray<readonly [BoundAction, string, string?]> = [
  ['hold', 'Hold', 'Pause while the price is past it'],
  ['stop', 'Stop', 'End the algo'],
  ['rush', 'Rush', 'Take everything that is left now'],
];

function hasJitter(kind: UiKind, d: Draft): boolean {
  const ek = engineKind(kind);
  return ((ek === 'twap' || ek === 'vwap' || ek === 'swarm') && (frac(d.sizeJitter) > 0 || frac(d.timeJitter) > 0)) || (ek === 'scale' && frac(d.scaleJitter) > 0);
}

function ExecFields({ d, set, chaseOnly = false }: { d: Draft; set: (p: Partial<Draft>) => void; chaseOnly?: boolean }) {
  const style = chaseOnly && d.exec === 'taker' ? 'hybrid' : d.exec;
  const opts: ReadonlyArray<readonly ['taker' | 'maker' | 'hybrid', string, string?]> = chaseOnly
    ? [['hybrid', 'Rest, then take', 'Each slice rests at the best price; what is behind after the resting share is taken'], ['maker', 'Maker only', 'Never takes: what does not fill rests on']]
    : [['taker', 'Taker', 'Each slice takes at once (IOC)'], ['hybrid', 'Hybrid', 'Rests first, takes what falls behind'], ['maker', 'Maker', 'Post-only, re-priced as the book moves']];
  return (
    <>
      <Seg label="Each slice" value={style} onChange={(v) => set({ exec: v })} options={opts} />
      {style !== 'maker' && <Field label="Max slippage" value={d.slip} onChange={(v) => set({ slip: v })} suffix="bp" title="Worst price per taker child, past the touch" />}
      {style === 'hybrid' && <Field label="Rest for" value={d.makerShare} onChange={(v) => set({ makerShare: v })} suffix="% of slice" title="Share of each slice spent resting before the rest is taken" />}
      {style !== 'taker' && <Field label="Re-price after" value={d.chaseTicks} int onChange={(v) => set({ chaseTicks: v })} suffix="ticks" />}
      <Field label="Size varies" value={d.sizeJitter} onChange={(v) => set({ sizeJitter: v })} suffix="± %" title="Randomise each slice's size (the total stays)" />
      <Field label="Time varies" value={d.timeJitter} onChange={(v) => set({ timeJitter: v })} suffix="± %" title="Randomise each slice's time, as a share of the interval" />
      <Field label="Max of volume" value={d.maxPart} placeholder="off" onChange={(v) => set({ maxPart: v })} suffix="%" title="A slice takes at most this share of the volume printed in the last interval" />
      <Seg label="At the end" value={d.finish} onChange={(v) => set({ finish: v })} options={[['take', 'Take rest'], ['leave', 'Leave it']]} />
    </>
  );
}

/**
 * Exits after the fills: SoDEX's own position stops (a reduce-only market
 * order on the mark), resized as the algo fills; when one fills, the other is
 * cancelled. Distances are from the average fill.
 */
function ExitFields({ d, set, side, always, levels, err }: { d: Draft; set: (p: Partial<Draft>) => void; side: 'buy' | 'sell'; always: boolean; levels: { tp: number | null; sl: number | null } | null; err?: string }) {
  const on = always || d.exitsOn;
  const unit = (label: string, mode: 'pct' | 'price', key: 'tpMode' | 'slMode') => (
    <ModeSelect label={label} value={mode} options={[['pct', '%'], ['price', 'USD']]} onChange={(v) => set({ [key]: v } as Partial<Draft>)} />
  );
  const at = (x: number | null | undefined) => (x ? ` · ${fmtLevel(x)}` : '');
  return (
    <div className="algo-exits">
      {!always && <Switch label="Take-profit / stop-loss" checked={d.exitsOn} onChange={(v) => set({ exitsOn: v })} title="SoDEX holds them as position stops, resized as the algo fills; when one fills the other is cancelled" />}
      {on && (
        <>
          <Field label="Take-profit" value={d.tp} placeholder="none" onChange={(v) => set({ tp: v })} suffix={unit('Take-profit', d.tpMode, 'tpMode')} title={`${side === 'buy' ? 'Above' : 'Below'} your average fill${at(levels?.tp)}`} />
          <Field label="Stop-loss" value={d.sl} placeholder="none" onChange={(v) => set({ sl: v })} suffix={unit('Stop-loss', d.slMode, 'slMode')} title={`${side === 'buy' ? 'Below' : 'Above'} your average fill${at(levels?.sl)}`} />
          {err && <p className="oe-hint algo-ferr">{err}</p>}
        </>
      )}
    </div>
  );
}

function BasketLegs({ d, set }: { d: Draft; set: (p: Partial<Draft>) => void }) {
  const edit = (i: number, patch: Partial<LegDraft>) => set({ legs: d.legs.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  return (
    <>
      <ol className="algo-legs">
        {d.legs.map((l, i) => (
          <li key={i} className="algo-leg">
            <input className="algo-sym" value={l.symbol} aria-label={`Market ${i + 1}`} onChange={(e) => edit(i, { symbol: e.target.value.toUpperCase() })} />
            <Seg value={l.side} onChange={(v) => edit(i, { side: v })} options={[['buy', 'Long'], ['sell', 'Short']]} />
            <Field label="USD" value={l.usd} onChange={(v) => edit(i, { usd: v })} />
            {d.legs.length > 2 && (
              <button type="button" className="algo-x" aria-label={`Remove ${l.symbol}`} onClick={() => set({ legs: d.legs.filter((_, j) => j !== i) })}>×</button>
            )}
          </li>
        ))}
      </ol>
      {d.legs.length < 10 && (
        <button type="button" className="algo-add" onClick={() => set({ legs: [...d.legs, { symbol: '', side: 'buy', usd: '100' }] })}>
          + Add a market
        </button>
      )}
    </>
  );
}

/** A basket's advanced settings: how each market is worked is on the ticket, its tuning here. */
function BasketMore({ d, set, slices }: { d: Draft; set: (p: Partial<Draft>) => void; slices: ReactNode }) {
  return (
    <>
      {d.basketStyle === 'twap' ? (
        slices
      ) : (
        <>
          <Field label="Clips" value={d.clips} int onChange={(v) => set({ clips: v })} suffix="per market" />
          <Field label="Between waves" value={d.waveSec} onChange={(v) => set({ waveSec: v })} suffix="s" />
        </>
      )}
      <Field label="Max slippage" value={d.slip} onChange={(v) => set({ slip: v })} suffix="bp" />
    </>
  );
}

const POS_OPS: ReadonlyArray<readonly [CondDraft['pos'], string]> = [
  ['flat', 'Is flat'],
  ['long', 'Is long'],
  ['short', 'Is short'],
  ['sizeAbove', 'Size ≥'],
  ['sizeBelow', 'Size ≤'],
  ['pnlAbove', 'PnL ≥'],
  ['pnlBelow', 'PnL ≤'],
];

const COND_TYPES: ReadonlyArray<readonly [ConditionType, string]> = [
  ['price', 'Price'],
  ['cross', 'Crosses'],
  ['move', 'Moves'],
  ['funding', 'Funding'],
  ['oi', 'Open interest'],
  ['spread', 'Spread'],
  ['volume', 'Volume'],
  ['ratio', 'Ratio'],
  ['position', 'Position'],
  ['time', 'Time'],
];

function ConditionalFields({ d, set, symbol, base }: { d: Draft; set: (p: Partial<Draft>) => void; symbol: string; base: string }) {
  const edit = (i: number, patch: Partial<CondDraft>) => set({ conds: d.conds.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  return (
    <>
      <ol className="algo-conds">
        {d.conds.map((c, i) => (
          <li key={i} className="algo-cond">
            <div className="algo-cond__head">
              <select className="oe-select" value={c.type} aria-label="Condition" onChange={(e) => edit(i, { type: e.target.value as ConditionType })}>
                {COND_TYPES.map(([v, t]) => (
                  <option key={v} value={v}>{t}</option>
                ))}
              </select>
              {c.type !== 'time' && (
                <input className="algo-sym" value={c.symbol} aria-label="Market" onChange={(e) => edit(i, { symbol: e.target.value.toUpperCase() })} />
              )}
              <button type="button" className="algo-x" aria-label="Remove this condition" onClick={() => set({ conds: d.conds.filter((_, j) => j !== i) })}>×</button>
            </div>
            <CondBody c={c} edit={(patch) => edit(i, patch)} />
          </li>
        ))}
      </ol>
      {d.conds.length < 5 && (
        <button type="button" className="algo-add" onClick={() => set({ conds: [...d.conds, cond(symbol)] })}>
          + Add a condition
        </button>
      )}
      <Seg label="Then" value={d.then} onChange={(v) => set({ then: v })} options={[['market', 'Market'], ['limit', 'Limit'], ['close', 'Close'], ['twap', 'TWAP'], ['chase', 'Chase']]} />
      {d.then === 'limit' && <Field label="Price" value={d.thenPrice} onChange={(v) => set({ thenPrice: v })} suffix="USD" />}
      {d.then === 'close' && <Field label="Close" value={d.closePct} onChange={(v) => set({ closePct: v })} suffix={base ? `% of ${base}` : '%'} />}
      {d.then === 'twap' && <Field label="Over" value={d.thenMin} onChange={(v) => set({ thenMin: v })} suffix="min" />}
    </>
  );
}

function ConditionalMore({ d, set }: { d: Draft; set: (p: Partial<Draft>) => void }) {
  return (
    <>
      {d.conds.length > 1 && <Seg label="When" value={d.match} onChange={(v) => set({ match: v })} options={[['all', 'All hold'], ['any', 'Any holds']]} />}
      <Field label="Hold for" value={d.holdSec} onChange={(v) => set({ holdSec: v })} suffix="s" title="It acts only once the conditions held this long (no firing on a wick)" />
      <Field label="Expires in" value={d.expires} placeholder="never" onChange={(v) => set({ expires: v })} suffix={<UnitSelect label="Expires in" value={d.expiresUnit} units={['m', 'h', 'd']} onChange={(u) => set({ expiresUnit: u })} />} />
      {(d.then === 'market' || d.then === 'close') && <Field label="Max slippage" value={d.slip} onChange={(v) => set({ slip: v })} suffix="bp" />}
      {d.then === 'limit' && <Switch label="Post only" checked={d.postOnly} onChange={(v) => set({ postOnly: v })} />}
      {d.then === 'twap' && <Field label="Slices" value={d.thenSlices} int onChange={(v) => set({ thenSlices: v })} />}
    </>
  );
}

function CondBody({ c, edit }: { c: CondDraft; edit: (p: Partial<CondDraft>) => void }) {
  const src = <Seg value={c.source} onChange={(v) => edit({ source: v })} options={[['mark', 'Mark'], ['last', 'Last'], ['mid', 'Mid']]} />;
  const op = <Seg value={c.op} onChange={(v) => edit({ op: v })} options={[['above', '≥'], ['below', '≤']]} />;
  const dir = <Seg value={c.dir} onChange={(v) => edit({ dir: v })} options={[['up', 'Up'], ['down', 'Down'], ['either', 'Either']]} />;
  switch (c.type) {
    case 'price':
      return <div className="algo-cond__body">{src}{op}<Field label="Price" value={c.value} onChange={(v) => edit({ value: v })} /></div>;
    case 'cross':
      return <div className="algo-cond__body">{src}<Seg value={c.dir === 'down' ? 'down' : 'up'} onChange={(v) => edit({ dir: v })} options={[['up', 'Up through'], ['down', 'Down through']]} /><Field label="Price" value={c.value} onChange={(v) => edit({ value: v })} /></div>;
    case 'move':
      return <div className="algo-cond__body">{dir}<div className="algo-grid"><Field label="By" value={c.pct} onChange={(v) => edit({ pct: v })} suffix="%" /><Field label="Within" value={c.windowMin} onChange={(v) => edit({ windowMin: v })} suffix="min" /></div></div>;
    case 'funding':
      return <div className="algo-cond__body">{op}<Field label="Rate" value={c.pct} onChange={(v) => edit({ pct: v })} suffix="%" title="Per funding period, as SoDEX publishes it" /></div>;
    case 'oi':
      return <div className="algo-cond__body">{dir}<div className="algo-grid"><Field label="By" value={c.pct} onChange={(v) => edit({ pct: v })} suffix="%" /><Field label="Within" value={c.windowMin} onChange={(v) => edit({ windowMin: v })} suffix="min" /></div></div>;
    case 'spread':
      return <div className="algo-cond__body">{op}<Field label="Spread" value={c.bps} onChange={(v) => edit({ bps: v })} suffix="bp" /></div>;
    case 'volume':
      return <div className="algo-cond__body"><div className="algo-grid"><Field label="Trades" value={c.usd} onChange={(v) => edit({ usd: v })} suffix="USD" /><Field label="Within" value={c.windowMin} onChange={(v) => edit({ windowMin: v })} suffix="min" /></div></div>;
    case 'ratio':
      return <div className="algo-cond__body"><input className="algo-sym" value={c.other} aria-label="Divided by" onChange={(e) => edit({ other: e.target.value.toUpperCase() })} />{op}<Field label="Ratio" value={c.value} onChange={(v) => edit({ value: v })} /></div>;
    case 'position':
      return (
        <div className="algo-cond__body">
          <select className="oe-select" value={c.pos} aria-label="Your position" onChange={(e) => edit({ pos: e.target.value as CondDraft['pos'] })}>
            {POS_OPS.map(([v, t]) => (
              <option key={v} value={v}>{t}</option>
            ))}
          </select>
          {(c.pos === 'sizeAbove' || c.pos === 'sizeBelow') && <Field label="Size" value={c.value} onChange={(v) => edit({ value: v })} title="Your position's size in the base coin, long or short" />}
          {(c.pos === 'pnlAbove' || c.pos === 'pnlBelow') && <Field label="PnL" value={c.value} signed onChange={(v) => edit({ value: v })} suffix="USD" title="Unrealised, at the mark (a loss is negative)" />}
        </div>
      );
    case 'time':
      return <div className="algo-cond__body"><Field label="In" value={c.inMin} onChange={(v) => edit({ inMin: v })} suffix="min" /></div>;
  }
}

/* -------------------------------------------------------------- summary ----- */

interface Rates {
  taker: number;
  maker: number;
}

function feeRates(m: MarketInfo | null, builder: number): Rates {
  const taker = (m?.takerFee ?? 0.0004) + builder;
  const maker = (m?.makerFee ?? (m?.takerFee ?? 0.0004) / 2) + builder;
  return { taker, maker };
}

/** What the plan adds to the summary line: slice sizes and pace, when it ends, the exits. */
function planFacts(plan: AlgoPlan, kind: UiKind): string {
  const ek = engineKind(kind);
  const kids = plan.children.filter((c) => c.qty > 0).length;
  const took = plan.endsAt && plan.endsAt > plan.startsAt ? `about ${fmtDuration(plan.endsAt - plan.startsAt)}` : null;
  const parts: string[] = [];
  if (ek === 'twap' || ek === 'vwap') {
    const each = plan.notional && kids ? ` of ~${fmtUsd(plan.notional / kids, 0)}` : '';
    if (kids) parts.push(`${kids} slices${each}${plan.intervalMs ? ` every ${fmtDuration(plan.intervalMs)}` : ''}`);
    if (plan.endsAt) parts.push(`ends ${fmtTime(plan.endsAt)}`);
  } else if (ek === 'dca') {
    if (plan.endsAt) parts.push(`last ${fmtTime(plan.endsAt)}`);
  } else if (ek === 'swarm' || ek === 'basket') {
    parts.push(took ?? 'one wave');
  } else if (ek === 'scale') {
    if (plan.avgPrice) parts.push(`avg ${fmtLevel(plan.avgPrice)} if all fill`);
  } else if (ek === 'iceberg') {
    if (kids) parts.push(`about ${kids} clips`);
  } else if (ek === 'pov') {
    parts.push(took ? `${took} at the last day's volume` : 'paced by the volume that prints');
  }
  if (plan.exits && (plan.exits.tp || plan.exits.sl)) {
    const f = (x: number | null) => (x ? fmtLevel(x) : DASH);
    parts.push(`TP ${f(plan.exits.tp)} · SL ${f(plan.exits.sl)}`);
  }
  return parts.join(' · ');
}

/** The cost line: the value, the fee range (all resting to all taking), and the ValueDesk fee in it. */
function CostLine({ plan, rates, paper, feeNote, scale, onShuffle }: { plan: AlgoPlan | null; rates: Rates; paper: boolean; feeNote: string | null; scale: boolean; onShuffle?: () => void }) {
  const notional = plan?.notional ?? null;
  if (!notional && !onShuffle) return null;
  const lo = notional ? notional * rates.maker : 0;
  const hi = notional ? notional * rates.taker : 0;
  return (
    <p className="algo-cost">
      {notional ? (
        <span>
          {paper ? 'Paper · ' : ''}
          {fmtUsd(notional, 2)} · fees {scale ? fmtUsd(lo, 2) : `${fmtUsd(lo, 2)}–${fmtUsd(hi, 2)}`}
          {feeNote ? `, incl. ${feeNote}` : ''}
        </span>
      ) : (
        <span />
      )}
      {onShuffle && (
        <button type="button" className="algo-shuffle" onClick={onShuffle} title="Draw another random schedule (sizes and times)">
          New draw
        </button>
      )}
    </p>
  );
}

function addLevels(out: Level[], s: AlgoSpec, ctx: { bid: number | null; ask: number | null; mid: number | null; market: MarketInfo | null }): void {
  const { bid, ask, mid, market } = ctx;
  if (s.limitPrice !== null) out.push({ label: 'Limit', price: s.limitPrice, tone: 'warn' });
  if (s.triggerPrice !== null) out.push({ label: 'Starts at', price: s.triggerPrice, tone: 'muted' });
  if (s.upper) out.push({ label: `Above: ${s.upper.then}`, price: s.upper.price, tone: 'muted' });
  if (s.lower) out.push({ label: `Below: ${s.lower.then}`, price: s.lower.price, tone: 'muted' });
  if (s.kind === 'chase' && bid && ask && market) {
    const q = { bid, ask, at: Date.now() };
    const ref = s.side === 'buy' ? bid : ask;
    let cap = s.limitPrice;
    if (s.maxChaseBps !== null) {
      const c = s.side === 'buy' ? ref * (1 + s.maxChaseBps / 10_000) : ref * (1 - s.maxChaseBps / 10_000);
      cap = cap === null ? c : s.side === 'buy' ? Math.min(cap, c) : Math.max(cap, c);
      out.push({ label: 'Chases to', price: c, tone: 'muted' });
    }
    out.push({ label: 'Rests at', price: makerPrice(s.side, q, s.offsetTicks, s.offsetBps, market, cap), tone: s.side === 'buy' ? 'pos' : 'neg' });
  }
  if (s.kind === 'iceberg' && s.price === null && bid && ask && market) {
    out.push({ label: 'Clip at', price: makerPrice(s.side, { bid, ask, at: 0 }, s.pegOffsetTicks, null, market, s.limitPrice), tone: s.side === 'buy' ? 'pos' : 'neg' });
  }
  if (s.kind === 'trailing' && mid) {
    const from = s.activationPrice ?? mid;
    const dist = s.trailAbs !== null ? s.trailAbs : from * (s.trailPct ?? 0);
    if (s.activationPrice !== null) out.push({ label: 'Trails from', price: s.activationPrice, tone: 'muted' });
    out.push({ label: 'Stop', price: s.side === 'sell' ? from - dist : from + dist, tone: s.side === 'buy' ? 'pos' : 'neg' });
  }
  if (s.kind === 'conditional') {
    for (const c of s.conditions) {
      if ((c.type === 'price' || c.type === 'cross') && c.symbol === s.symbol) out.push({ label: c.type === 'cross' ? `Crosses ${c.dir}` : c.op === 'above' ? 'When ≥' : 'When ≤', price: c.value, tone: 'warn' });
    }
    if (s.then.type === 'limit') out.push({ label: 'Then limit', price: s.then.price, tone: s.side === 'buy' ? 'pos' : 'neg' });
  }
  if (s.kind === 'bracket' && s.entry === 'limit' && s.price !== null) out.push({ label: 'Entry', price: s.price, tone: 'warn' });
}

/** The summary line, in words: "Buys 0.5 BTC over 30 min" (the plan adds its slices and times). */
function oneLine(kind: UiKind, d: Draft, side: 'buy' | 'sell', quantity: string, base: string): string {
  const verb = side === 'buy' ? 'Buys' : 'Sells';
  const q = Number(quantity) > 0 ? `${quantity} ${base}`.trim() : 'the amount';
  const x = (s: string) => (s.trim() === '' ? '…' : s);
  const over = `${x(d.dur)} ${UNIT_NAME[d.durUnit]}`;
  switch (kind) {
    case 'twap':
      if (d.twapClose) return `Closes ${x(d.twapCloseShare)}% of your position in ${x(slicesOf(d))} slices over ${over}`;
      return `${verb} ${q} over ${over}`;
    case 'chasetwap':
      return `${verb} ${q} over ${over}, each slice resting first`;
    case 'vwap':
      return `${verb} ${q} over ${over}, with the market's volume`;
    case 'pov':
      return `${verb} ${q} as ${x(d.rate)}% of market volume`;
    case 'iceberg':
      return `${verb} ${q}, showing ${x(d.display)} ${base} at a time${!d.icePeg && opt(d.icePrice) ? ` at ${d.icePrice}` : ' at the best price'}`;
    case 'chase':
      return `${verb} ${q} with one order that follows the best price`;
    case 'scale':
      return `${verb} ${q} in ${x(d.orders)} orders from ${x(d.from)} to ${x(d.to)}`;
    case 'dca': {
      const total = n(d.perOrder) * n(d.dcaOrders);
      return `${verb} $${x(d.perOrder)} every ${x(d.every)} ${UNIT_NAME[d.everyUnit]}, ${x(d.dcaOrders)} times${Number.isFinite(total) && total > 0 ? ` (${fmtUsd(total, 0)})` : ''}`;
    }
    case 'swarm':
      return `${verb} ${q} in ${x(d.clips)} clips, ${d.inFlight} at a time`;
    case 'conditional': {
      const then = d.then === 'close' ? `close ${x(d.closePct)}%` : d.then === 'limit' ? `limit ${side === 'buy' ? 'buy' : 'sell'} at ${x(d.thenPrice)}` : d.then === 'twap' ? `TWAP over ${x(d.thenMin)} min` : `${d.then} ${side === 'buy' ? 'buy' : 'sell'}`;
      return `${d.conds.length > 1 ? (d.match === 'all' ? 'When all conditions hold' : 'When any condition holds') : 'When the condition holds'}: ${then}`;
    }
    case 'trailing': {
      const t = d.trailMode === 'pct' ? `${x(d.trail)}%` : `$${x(d.trail)}`;
      return side === 'sell' ? `Sells when the price falls ${t} from its high` : `Buys when the price rises ${t} from its low`;
    }
    case 'bracket':
      return `${side === 'buy' ? 'Goes long' : 'Goes short'} ${q} ${d.entry === 'limit' ? `at ${x(d.entryPrice)}` : 'at market'}, with take-profit and stop-loss`;
    case 'basket': {
      const total = d.legs.reduce((a, l) => a + (Number(l.usd) || 0), 0);
      return `Trades ${d.legs.length || '…'} markets ${d.basketStyle === 'twap' ? `over ${over}` : 'at once'}${total > 0 ? `, ${fmtUsd(total, 0)} in all` : ''}`;
    }
  }
}

function Review({ spec, plan, kind, feeRates: r, place, location }: { spec: AlgoSpec; plan: AlgoPlan; kind: UiKind; feeRates: Rates; place: Place; location: string | null }) {
  const rows: Array<[string, string]> = [
    ['Order', spec.kind === 'basket' ? `${menuName(kind)} of ${spec.legs.length} markets, ${fmtUsd(plan.notional ?? 0, 2)} in all` : `${menuName(kind)} ${spec.side === 'buy' ? 'buy / long' : 'sell / short'} on ${spec.symbol}`],
  ];
  if (plan.total !== null) rows.push(['Size', `${plan.total} ${spec.symbol.replace(/-USD$/, '')}${plan.notional ? ` (${fmtUsd(plan.notional, 2)})` : ''}`]);
  if (spec.kind === 'dca') rows.push(['Spend', `${spec.orders} × ${fmtUsd(spec.perOrderUsd, 2)}${spec.maxTotalUsd ? `, at most ${fmtUsd(spec.maxTotalUsd, 2)}` : ''}`]);
  if (plan.children.length && spec.kind !== 'conditional' && spec.kind !== 'trailing' && spec.kind !== 'chase' && spec.kind !== 'basket') rows.push(['Children', String(plan.children.filter((c) => c.qty > 0).length)]);
  if (plan.endsAt) rows.push(['Until', `${fmtTime(plan.endsAt)} (${fmtDuration(plan.endsAt - plan.startsAt)})`]);
  if (spec.startAt) rows.push(['Starts', fmtTime(spec.startAt)]);
  if (spec.triggerPrice) rows.push(['Starts when the mark reaches', String(spec.triggerPrice)]);
  if (spec.limitPrice) rows.push(['Limit', `never ${spec.side === 'buy' ? 'above' : 'below'} ${spec.limitPrice}`]);
  if (spec.upper) rows.push(['Above ' + spec.upper.price, spec.upper.then]);
  if (spec.lower) rows.push(['Below ' + spec.lower.price, spec.lower.then]);
  if (spec.kind === 'basket') rows.push(['Markets', spec.legs.map((l) => `${l.side === 'buy' ? 'long' : 'short'} ${fmtUsd(l.usd, 0)} ${l.symbol}`).join(', ')]);
  if (spec.kind === 'twap' && spec.closeShare !== null) rows.push(['Closes', `${Math.round(spec.closeShare * 100)}% of your ${spec.symbol} position, reduce-only`]);
  if (spec.kind === 'bracket') rows.push(['Entry', spec.entry === 'limit' ? `limit at ${spec.price}` : `market, at most ${spec.slippageBps} bp past the touch`]);
  if (plan.exits && (plan.exits.tp || plan.exits.sl)) {
    const f = (x: number | null) => (x ? fmtLevel(x) : 'none');
    rows.push(['Exits', `take-profit ${f(plan.exits.tp)}, stop-loss ${f(plan.exits.sl)} - SoDEX position stops on the mark, resized as it fills; one fills, the other is cancelled`]);
  }
  if (spec.reduceOnly) rows.push(['Reduce only', 'yes']);
  if (plan.notional) rows.push(['Fees', `${fmtUsd(plan.notional * r.maker, 2)} (all resting) to ${fmtUsd(plan.notional * r.taker, 2)} (all taking)`]);
  rows.push([
    'Runs',
    place === 'hosted'
      ? `On the ValueDesk executor${location ? ` (${location})` : ''}, 24/7${spec.paper ? ' - paper: nothing is sent' : ', signed by the key you registered for it'}`
      : place === 'self'
        ? `On your copier${spec.paper ? ' - paper: nothing is sent' : ', signed by its key'}`
        : spec.paper
          ? 'Paper: in this browser, nothing is sent'
          : 'In this browser, signed with your trading key - keep a ValueDesk tab open',
  ]);
  return (
    <div className="algo-review">
      <dl>
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {plan.warnings.map((w) => (
        <p key={w} className="oe-hint algo-warn">{w}</p>
      ))}
      <p className="oe-hint">You can pause or cancel it any time in the Algos tab; what has filled stays filled. {ALGO_NAMES[spec.kind]} child orders also show in your open orders and can be cancelled there.</p>
    </div>
  );
}

/**
 * The algo half of the order ticket: the inputs the major venues show for an
 * algo order type in their own forms (INLINE_KEYS in draft.ts), the cost
 * line, and two buttons: Advanced (the kind's settings window, where it runs
 * first - never a control on the panel; a notification says why when it
 * cannot start there) and Preview (the same window, open on its Preview: the
 * engine's own plan drawn, every child, the total and the fees).
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
import { fmtFixed, fmtNum, fmtPlain, toInputText } from '../../numStyle';
import { LIVE_ALGOS_OFF, liveAlgosFor } from '../../algo/liveAlgos';
import { createContext, forwardRef, useContext, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import {
  ALGO_NAMES,
  ORACLE_VENUES,
  SLIP_FROM_NAMES,
  ORACLE_VENUE_NAMES,
  SWEEP_REFERENCE_NAMES,
  sweepRefWords,
  checkAlgoSpec,
  makerPrice,
  newSeed,
  planAlgo,
  volumeProfile,
  isWeekend,
  algoClosesOnly,
  type AlgoKind,
  type AlgoPlan,
  type AlgoSpec,
  type BoundAction,
  type Candle,
  type ConditionType,
  type MarketInfo,
  type PlannedChild,
  type OracleVenue,
  type VolumeProfile,
} from '@copy-engine';
import { api, type OrderBook, type Symbol as MarketSymbol } from '../../api';
import { algoOwner } from '../../algo/algoBus';
import { executorReady, startOn } from '../../algo/executorAlgos';
import { getLiveCopy, subscribeLiveCopy } from '../../copy/live';
import { DASH, fmtQty, fmtTime, fmtUsd, num, pick } from '../../format';
import { useChannel, useStored } from '../../hooks';
import { publishDraftOrders, type DraftLine } from '../../draftOrders';
import { notify } from '../../toast';
import { Modal, useConfirm } from '../Modal';
import { decimalInput, integerInput } from '../numberInput';
import { PlanPreview, type Level } from './AlgoPreview';
import { fmtQ } from './AlgoStory';
import { VenuePicker } from './VenuePicker';
import { useHistory } from './liveData';
import { DcaCurve } from './DcaCurve';
import { pctAsUnit, unitAsPct, useSlipUnit, type SlipUnit } from '../../slipUnit';
import { MarketSelect, MiniSelect } from './MarketSelect';
import { coinOf, useOracle } from '../../algo/oracle';
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
  marketOf,
  parsePriceList,
  parsePrices,
  priceListInput,
  PRICE_LIST_SEP,
  n,
  offersExits,
  redWarnings,
  opt,
  POV_PRESETS,
  povPreset,
  randomizeOn,
  resetAdvanced,
  saveDraft,
  scaleSize,
  setPovPreset,
  setRandomize,
  setScaleSize,
  slicesOf,
  UNIT_NAME,
  type CondDraft,
  dcaLadder,
  type DcaSizing,
  type Draft,
  type LegDraft,
  type PovPreset,
  type ScaleSize,
  type TicketShared,
  type Unit,
} from './draft';
import { blockedState, noticeFor, readExecutor, writeExecutor, type Place } from './executor';
import { engineKind, fmtDuration, menuName, usesAmount, type UiKind } from './menu';
import { AlgoIcon } from './AlgoIcon';
import { feeRange, feeSplit, feeWords } from './fees';
import { SlideConfirm } from './SlideConfirm';
import '../SettingsMenu.css';
import './algo.css';

export { draftToSpec, marketOf, offersExits, type TicketShared } from './draft';

/** A price level as the preview shows it (SoDEX snaps it to the tick when it is placed). */
const fmtLevel = (x: number): string => fmtNum(x, { maximumFractionDigits: Math.abs(x) >= 1000 ? 1 : Math.abs(x) >= 1 ? 4 : 6 });

/** The spec fields whose errors a kind shows under its own inline fields (the rest go under the preview). */
const INLINE_ERRORS: Record<UiKind, readonly string[]> = {
  twap: ['durationMs', 'closeShare'],
  chasetwap: ['durationMs'],
  vwap: ['durationMs'],
  pov: ['rate'],
  iceberg: ['price', 'displayQty'],
  chase: ['maxChaseBps'],
  scale: ['from', 'to', 'orders'],
  dca: ['perOrderUsd', 'orders', 'from', 'to', 'skew', 'quantity', 'prices', 'weights'],
  swarm: ['clips'],
  trailing: ['trailPct', 'trailAbs', 'activationPrice'],
  bracket: ['price', 'exits'],
  sweep: ['slippageBps'],
  basket: ['durationMs'],
  conditional: [],
};

/** Where it runs, in the few words the summary line gives it. */
const PLACE_WORDS: Record<Place, string> = { hosted: 'on ValueDesk', browser: 'in this browser', self: 'on your copier' };

const POV_OPTS: ReadonlyArray<readonly [PovPreset | 'custom', string, string]> = [
  ['low', 'Low', `${POV_PRESETS.low}% of volume: slow and quiet`],
  ['medium', 'Medium', `${POV_PRESETS.medium}% of volume`],
  ['high', 'High', `${POV_PRESETS.high}% of volume: faster, more visible`],
];

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
function Field({ label, value, onChange, suffix, placeholder, int = false, signed = false, list = false, title, err }: {
  label: string; value: string; onChange: (v: string) => void; suffix?: ReactNode; placeholder?: string; int?: boolean; signed?: boolean; title?: string; err?: string;
  /** A list of numbers (the DCA's "Then at"): kept as typed, read by parsePriceList - not one number's filter. */
  list?: boolean;
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
          inputMode={int ? 'numeric' : list ? 'text' : 'decimal'}
          value={int || list ? value : toInputText(value)}
          placeholder={placeholder ?? ''}
          aria-invalid={err ? true : undefined}
          aria-describedby={err ? `${id}-err` : undefined}
          onChange={(e) => onChange(list ? priceListInput(e.target.value) : int ? wholeInput(e.target.value, signed) : decimalInput(e.target.value, { signed, prev: value }))}
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
/**
 * Two units (bp / %, coin / USD, % / USD): one button, the unit and its arrows both clickable, a click
 * switches to the other - not a list that always holds exactly two. Three or more stay a list.
 */
function UnitToggle<T extends string>({ label, value, options, onChange, className }: { label: string; value: T; options: ReadonlyArray<readonly [T, string]>; onChange: (v: T) => void; className: string }) {
  const i = Math.max(0, options.findIndex(([v]) => v === value));
  const next = options[(i + 1) % options.length]!;
  return (
    <button type="button" className={`${className} algo-unitswap`} aria-label={`${label} in ${next[1]}`} title={`Switch to ${next[1]}`} onClick={() => onChange(next[0])}>
      <span>{options[i]![1]}</span>
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 6h8.5L10 3.5M12 10H3.5L6 12.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
  );
}

function ModeSelect<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: ReadonlyArray<readonly [T, string]>; onChange: (v: T) => void }) {
  if (options.length === 2) return <UnitToggle label={label} value={value} options={options} onChange={onChange} className="oe-unit" />;
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
  /** A practice run: nothing reaches SoDEX (the ticket turns blue). */
  paper?: boolean;
  /** Its first order, for the order book: the size, its price (null: at market), and whether it rests or takes. */
  impact?: { qty: number; price: number | null; rests: boolean } | null;
  /** The ticket's Long / Short applies (not to a basket: each market has its own side). */
  sided: boolean;
  /** The chosen executor cannot start it (unreachable, not set up, key missing): the button's short reason. Never for a missing wallet. */
  blocked: string | null;
  /** It can only make a position smaller (copy-engine algoClosesOnly): a close-only place may start it. */
  closesOnly?: boolean;
}

export interface AlgoTicketHandle {
  start(): Promise<void>;
}

/** The prices the open Preview draws from (see `snap`). */
interface Snap {
  bid: number | null;
  ask: number | null;
  last: number | null;
  mark: number | null;
  index: number | null;
  oracleMid: number | null;
  oracleFair: number | null;
  books: OrderBook[] | null;
}

interface Props extends TicketShared {
  kind: UiKind;
  /** The ticket's engine: the chart draws the unplaced order only on its own market. */
  engine?: string;
  /** The connected wallet: the runner follows it before the algo is added. */
  address: string | null;
  sym?: MarketSymbol;
  bid: number | null;
  ask: number | null;
  last: number | null;
  /** SoDEX's book as the ticket holds it (Fill fast's preview averages its depth). */
  depth?: OrderBook | null;
  /** The order panel's size unit: the previews draw sizes in it. */
  sizeUnit?: 'coin' | 'usd';
  /** Switches the order panel's size unit (the fields sized in the coin show it). */
  onSizeUnit?: (u: 'coin' | 'usd') => void;
  /** The open position on this market (signed, base units; null: not known). */
  positionQty?: number | null;
  /** The ticket's Amount slider and its setters, for the window's Order section. */
  sizePct?: number;
  onSizePct?: (pct: number) => void;
  onQuantity?: (v: string) => void;
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
  // The Preview holds still: while its window is open every price is the one of the moment it opened
  // (each filled in once it is first known), so the plan and its pictures do not shift under the reader.
  const [snap, setSnap] = useState<Snap | null>(null);
  const bid = snap?.bid ?? p.bid;
  const ask = snap?.ask ?? p.ask;
  const mid = bid && ask ? (bid + ask) / 2 : snap?.last ?? p.last;
  const market = useMemo(() => (p.sym ? marketOf(p.sym) : null), [p.sym]);
  const tick = Number(p.sym?.tickSize ?? '0');
  // A DCA's first price while it is "at market": the book's own side when post-only (it rests there,
  // never refused), else the far side (it takes). Shown live in the field; typing or MID fixes it.
  const dcaTouch = d.postOnly ? (p.side === 'buy' ? bid : ask) : (p.side === 'buy' ? ask : bid);
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

  const raw = useMemo(() => draftToSpec(kind, d, { ...p, bid, ask }, clock), [kind, d, p.symbol, p.side, p.quantity, p.reduceOnly, p.leverage, p.marginMode, kind === 'dca' ? bid : null, kind === 'dca' ? ask : null, clock]); // eslint-disable-line react-hooks/exhaustive-deps
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
  // Fill fast is priced from its reference: the shared oracle (our API), or SoDEX's own mark or index (its markPrice stream).
  const [sodexRef, setSodexRef] = useState<{ symbol: string; mark: number | null; index: number | null } | null>(null);
  const ownRef = ek === 'sweep' && (d.sweepRef === 'mark' || d.sweepRef === 'index');
  // Also while the window is open: the Preview marks SoDEX's mark and index (slippage references).
  useChannel('perps', ownRef || advOpen ? { channel: 'markPrice', symbols: [p.symbol] } : null, (data) => {
    const rows: unknown[] = Array.isArray(data) ? data : [data];
    for (const r of rows) {
      if (pick<string>(r, 's', 'symbol') !== p.symbol) continue;
      const mk = num(pick(r, 'p', 'markPrice'));
      const ix = num(pick(r, 'i', 'indexPrice'));
      setSodexRef({ symbol: p.symbol, mark: mk > 0 ? mk : null, index: ix > 0 ? ix : null });
    }
  });
  const own = sodexRef?.symbol === p.symbol ? sodexRef : null;
  // The market's open interest (SoDEX's markPrice stream), for its cap: kept only when it moves by 0.1%, so the ticket does not redraw on every update.
  const [oiNow, setOiNow] = useState<{ symbol: string; oi: number } | null>(null);
  const capped = !!(p.sym?.openInterestCap || p.sym?.openInterestCapUSD);
  useChannel('perps', capped ? { channel: 'markPrice', symbols: [p.symbol] } : null, (data) => {
    const rows: unknown[] = Array.isArray(data) ? data : [data];
    for (const r of rows) {
      if (pick<string>(r, 's', 'symbol') !== p.symbol) continue;
      const v = num(pick(r, 'oi', 'openInterest'));
      if (!(v >= 0)) continue;
      setOiNow((x) => (x && x.symbol === p.symbol && Math.abs(x.oi - v) <= x.oi * 0.001 ? x : { symbol: p.symbol, oi: v }));
    }
  });
  const oi = oiNow?.symbol === p.symbol ? oiNow.oi : null;
  // Fill fast's oracle over its venues; a slice's slippage measured from the oracle uses every venue (as the engine does).
  const sweepOracle = ek === 'sweep' && (d.sweepRef === 'oracleMid' || d.sweepRef === 'oracleFair');
  const slipOracle = ek !== 'sweep' && advOpen && (d.slipFrom === 'oracleMid' || d.slipFrom === 'oracleFair');
  const oracle = useOracle(sweepOracle || slipOracle ? coinOf(p.symbol) : null, ek === 'sweep' ? d.sweepVenues : ORACLE_VENUES, sweepOracle || slipOracle);
  // Fill fast's preview: how much SoDEX's book holds within the max slippage, averaged over its last updates
  // (the ticket's own book subscription, the one the order book panel shares: nothing more is read).
  const books = useRef<OrderBook[]>([]);
  useEffect(() => {
    if (ek === 'sweep' && p.depth) books.current = [...books.current.slice(-39), p.depth];
  }, [ek, p.depth]);
  useEffect(() => {
    books.current = [];
  }, [p.symbol]);
  useEffect(() => {
    if (!advOpen) {
      setSnap(null);
      return;
    }
    const cur: Snap = { bid: p.bid, ask: p.ask, last: p.last, mark: own?.mark ?? null, index: own?.index ?? null, oracleMid: oracle?.mid ?? null, oracleFair: oracle?.fair ?? null, books: books.current.length ? books.current : null };
    setSnap((x) => {
      if (!x) return cur;
      let n: Snap | null = null;
      for (const k of Object.keys(cur) as Array<keyof Snap>) if (x[k] == null && cur[k] != null) (n ??= { ...x })[k] = cur[k] as never;
      return n ?? x;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [advOpen, p.bid, p.ask, p.last, own?.mark, own?.index, oracle?.mid, oracle?.fair, p.depth]);
  const markPx = snap?.mark ?? own?.mark ?? null;
  const indexPx = snap?.index ?? own?.index ?? null;
  const oracleMid = snap?.oracleMid ?? oracle?.mid ?? null;
  const oracleFair = snap?.oracleFair ?? oracle?.fair ?? null;
  const sweepPx = ek !== 'sweep' ? null
    : d.sweepRef === 'mark' ? markPx
    : d.sweepRef === 'index' ? indexPx
    : d.sweepRef === 'oracleFair' ? oracleFair
    : oracleMid;
  const planPx = ek === 'sweep' ? sweepPx ?? mid ?? null : mid ?? null;
  // The Preview's live pictures: recent prices behind it, and Fill fast's book against its reference.
  const history = useHistory(p.symbol, advOpen && ek !== 'sweep' && ek !== 'basket');
  const plan: AlgoPlan | null = useMemo(
    () => (check.spec && market ? planAlgo(check.spec, market, { now: clock, price: planPx, seed, profile, hourVolume, positionSize: p.positionQty ?? null, oi }) : null),
    [check.spec, market, clock, planPx, seed, profile, hourVolume, p.positionQty, oi],
  );
  // VWAP's picture: the usual volume in each of the 24 hours from a little before it starts - for each, the
  // median of the same hour on past days of the same kind (weekdays with weekdays, weekends with weekends),
  // as the engine's own profile is made (volumeProfile).
  const startHour = plan ? Math.floor(plan.startsAt / 3_600_000) : 0;
  const dayVolume = useMemo(() => {
    if (ek !== 'vwap' || !candles?.length || !startHour) return null;
    const H = 3_600_000;
    const from = (startHour - 4) * H;
    const byT = new Map(candles.map((c) => [Math.floor(c.t / H) * H, c.v]));
    const match = d.lookback >= 14;
    const v = Array.from({ length: 24 }, (_, i) => {
      const h0 = from + i * H;
      const xs: number[] = [];
      for (let k = 1; k <= d.lookback; k++) {
        const t = h0 - k * 86_400_000;
        if (match && isWeekend(t) !== isWeekend(h0)) continue;
        const x = byT.get(t);
        if (x !== undefined) xs.push(x);
      }
      xs.sort((x, y) => x - y);
      return xs.length ? (xs.length % 2 ? xs[xs.length >> 1]! : (xs[xs.length / 2 - 1]! + xs[xs.length / 2]!) / 2) : 0;
    });
    return { from, v };
  }, [ek, candles, startHour, d.lookback]);
  // Fill fast: the book's average size within the max slippage, at the open window's reference.
  const bandDepth = useMemo(() => {
    const bs = snap?.books ?? null;
    const spec = check.spec;
    if (ek !== 'sweep' || !bs?.length || !sweepPx || spec?.kind !== 'sweep') return null;
    const cap = sweepPx * (1 + (p.side === 'buy' ? 1 : -1) * (spec.slippageBps / 10_000));
    const one = (b: OrderBook) => (p.side === 'buy' ? b.asks : b.bids).reduce((q, [px, sz]) => q + ((p.side === 'buy' ? Number(px) <= cap : Number(px) >= cap) ? Number(sz) : 0), 0);
    return bs.reduce((q, b) => q + one(b), 0) / bs.length;
  }, [ek, snap?.books, sweepPx, check.spec, p.side]);
  const [chartTz] = useStored<'local' | 'utc'>('chart.tz', 'local');

  const needsAmount = usesAmount(kind, { trailWhole: d.trailWhole, thenClose: d.then === 'close', twapClose: d.twapClose });
  const amountMissing = needsAmount && !(Number(p.quantity) > 0);
  // Field errors are shown at once; the ticket's own Amount speaks for itself when it is empty.
  // A typed DCA list with an item that cannot be read (or may be two prices run together): said under the box, and nothing starts.
  const listError = kind === 'dca' && d.dcaLevels === 'list' ? parsePriceList(d.dcaPrices).error : null;
  const fieldErrors: Record<string, string> = listError ? { ...check.errors, prices: listError } : check.errors;
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
  // Real algos are off, but for a dev server's test wallets (liveAlgos.ts).
  const liveOk = liveAlgosFor(p.address);
  const where =
    !d.paper && !liveOk
      ? { ready: false, why: LIVE_ALGOS_OFF }
      : place === 'browser'
      ? !p.address && !d.paper ? { ready: false, why: 'Connect a wallet to run it live, or turn on Practice run in Advanced.' } : { ready: true, why: null }
        : executorReady(place, d.paper);
  const execFee = place === 'browser' ? null : copy[place].info?.builder?.ladder?.[0]?.fee ?? null;
  const feeFraction = place === 'browser' ? p.builderFee : (execFee ?? 0) / 100_000;
  const ready = !!market && !amountMissing && !!check.spec && !!plan && !plan.errors.length && where.ready;
  const label = `Start ${menuName(kind)}${d.paper ? ' (paper)' : ''}`;
  // The first order it sends, as the order book should draw it: a resting kind (a ladder, an iceberg, a
  // chase, or a slice that rests first) at its price; a taker walks the book to its slippage limit.
  const planned = plan ? ((plan.schedule?.length ? plan.schedule : plan.children).find((c) => c.qty > 0) ?? null) : null;
  // A trailing stop and a conditional place nothing now: what they would send when they fire stands in -
  // a stop closes at market; a conditional's action at market, or its limit at its price.
  const sp0 = check.spec;
  const fires: PlannedChild | null =
    planned ? null
    : sp0?.kind === 'trailing' && Number(sp0.quantity ?? p.quantity) > 0 ? { at: null, qty: Number(sp0.quantity ?? p.quantity), price: null, tag: 'stop' }
    : sp0?.kind === 'conditional' && sp0.then.type === 'limit' ? { at: null, qty: Number(sp0.then.quantity), price: sp0.then.price, tag: 'then' }
    : sp0?.kind === 'conditional' && sp0.then.type === 'market' && Number(sp0.then.quantity) > 0 ? { at: null, qty: Number(sp0.then.quantity), price: null, tag: 'then' }
    : null;
  const firstChild = planned ?? fires;
  const restsFirst = ek === 'scale' || ek === 'iceberg' || ek === 'chase' || (check.spec && 'exec' in check.spec && check.spec.exec.style !== 'taker');
  const touchPx = p.side === 'buy' ? ask : bid;
  const firstPrice = firstChild?.price ?? (restsFirst ? (p.side === 'buy' ? bid : ask) ?? null : touchPx ? touchPx * (1 + (p.side === 'buy' ? 1 : -1) * (Number(d.slip) || 10) / 10_000) : null);
  const firstImpact = firstChild && !amountMissing ? { qty: firstChild.qty, price: firstPrice, rests: firstChild.price !== null ? (p.side === 'buy' ? firstChild.price < (ask ?? Infinity) : firstChild.price > (bid ?? 0)) : !!restsFirst } : null;
  const firstKey = firstImpact ? `${firstImpact.qty.toPrecision(6)}@${firstImpact.price ? firstImpact.price.toPrecision(8) : 'm'}:${firstImpact.rests}` : '';
  const why = !market ? 'Loading the market…' : amountMissing ? 'Enter an amount.' : allErrors[0] ?? where.why ?? null;
  const sided = kind !== 'basket';
  // With no wallet, executorReady stops at "Connect your wallet." before it
  // looks at the executor; the executor's own trouble still blocks the ticket.
  const execOwn =
    place === 'browser' || copy.owner || where.ready
      ? where
      : !copy[place].info
        ? { ready: false, why: place === 'hosted' ? 'The ValueDesk executor is not reachable right now.' : 'Connect your self-hosted copier in Copy → Set up.' }
        : !copy[place].info?.algos
          ? { ready: false, why: `${place === 'hosted' ? 'The ValueDesk executor' : 'Your copier'} does not run algo orders yet (update it).` }
          : where;
  const block = blockedState(place, execOwn, !!p.address);
  const blocked = block?.short ?? null;
  const closesOnly = check.spec ? algoClosesOnly(check.spec) : false;
  useEffect(() => p.onState({ ready, label, why, needsAmount, walletFree, sided, blocked, paper: d.paper, impact: firstImpact, closesOnly }), [ready, label, why, needsAmount, walletFree, sided, blocked, d.paper, firstKey, closesOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  // The executor's trouble is a notification, not a line on the panel: raised
  // once when it begins or changes, after it has held a moment (the executor's
  // status is still loading on the first renders).
  const noticed = useRef<string | null>(null);
  const blockMsg = block?.message ?? null;
  useEffect(() => {
    if (blockMsg === null) {
      noticed.current = null;
      return;
    }
    const t = window.setTimeout(() => {
      const msg = noticeFor(noticed.current, blockMsg);
      noticed.current = blockMsg;
      if (msg) notify('warn', msg);
    }, 1500);
    return () => window.clearTimeout(t);
  }, [blockMsg]);

  // The slide on the Summary let go at its end: checked once more, then started where it runs.
  const launch = async () => {
    if (busy) return;
    if (!where.ready) {
      notify('warn', block?.message ?? where.why ?? 'It cannot start where it is set to run.');
      return;
    }
    const fresh = checkAlgoSpec(draftToSpec(kind, d, p, Date.now()));
    if (!fresh.spec || !plan || plan.errors.length) {
      notify('error', why ?? 'Check the algo settings.');
      return;
    }
    const spec = fresh.spec;
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
      placedDraft.current = draftKey;
      publishDraftOrders(null);
      setSeed(newSeed());
      setAdvOpen(false);
    } catch (e) {
      notify('error', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  useImperativeHandle(ref, () => ({
    async start() {
      if (busy) return;
      if (!where.ready) {
        notify('warn', block?.message ?? where.why ?? 'It cannot start where it is set to run.');
        return;
      }
      const fresh = checkAlgoSpec(draftToSpec(kind, d, p, Date.now()));
      if (!fresh.spec || !plan || plan.errors.length) {
        notify('error', why ?? 'Check the algo settings.');
        return;
      }
      // Placing goes through the Summary: every order at a glance, then the slide to confirm.
      lastSec.set(kind, 'summary');
      setAdvOpen(true);
    },
  }));

  const levels: Level[] = [];
  if (mid) levels.push({ label: 'Now', price: mid, tone: 'now' });
  if (check.spec) addLevels(levels, check.spec, { bid, ask, mid, market });
  if (plan?.exits?.tp) levels.push({ label: 'Take-profit', price: plan.exits.tp, tone: 'pos' });
  if (plan?.exits?.sl) levels.push({ label: 'Stop-loss', price: plan.exits.sl, tone: 'neg' });

  const rates = feeRates(market, feeFraction);
  // The ValueDesk fee, said once: the builder fee in the browser, the copy fee on an executor.
  const feeBp = place === 'browser' ? (p.builderFee > 0 ? `ValueDesk fee ${fmtFixed(p.builderFee * 10_000, 1)} bp` : null) : execFee ? `ValueDesk fee up to ${fmtFixed(execFee / 10, 1)} bp` : null;
  // What the engine will run: a DCA is a scale ladder.
  const pk: AlgoKind = check.spec?.kind ?? ek;

  const base = p.sym?.baseCoin ?? '';

  // The unplaced order's prices on the chart (draftOrders.ts), from the spec and the engine's plan.
  // An unplaced order's size on the chart in the order panel's unit: the coin, or USD at its own price.
  const qtyText = (q: number, px?: number | null) => {
    if (!(q > 0)) return '';
    const at = px ?? mid ?? 0;
    return p.sizeUnit === 'usd' && at > 0 ? ` · $${fmtNum(q * at, { maximumFractionDigits: 2 })}` : ` · ${fmtQty(q, p.sym?.stepSize)} ${base}`.trimEnd();
  };
  const ticketQty = Number(p.quantity) > 0 ? Number(p.quantity) : 0;
  const draftLines: DraftLine[] = [];
  const sp = check.spec;
  if (sp && sp.kind !== 'basket') {
    if (sp.kind === 'scale' && plan) {
      const word = kind === 'dca' ? 'DCA' : 'Level';
      plan.children.forEach((c, i) => {
        if (c.price) draftLines.push({ price: c.price, label: `${word} ${i + 1}/${plan.children.length}${qtyText(c.qty, c.price)}`, kind: 'limit' });
      });
    }
    if (sp.kind === 'iceberg' && sp.price !== null) draftLines.push({ price: sp.price, label: `Iceberg${qtyText(ticketQty, sp.price)}`, kind: 'limit' });
    if (sp.kind === 'bracket' && sp.entry === 'limit' && sp.price !== null) draftLines.push({ price: sp.price, label: `Entry${qtyText(ticketQty, sp.price)}`, kind: 'limit' });
    if (sp.kind === 'conditional') {
      if (sp.then.type === 'limit' && sp.then.price) draftLines.push({ price: sp.then.price, label: `Limit${qtyText(Number(sp.then.quantity), sp.then.price)}`, kind: 'limit' });
      for (const c of sp.conditions) if ((c.type === 'price' || c.type === 'cross') && c.symbol === sp.symbol && c.value) draftLines.push({ price: c.value, label: 'When', kind: 'trigger' });
    }
    if (sp.kind === 'sweep' && plan?.children[0]?.price) draftLines.push({ price: plan.children[0].price, label: `Fill-fast edge${qtyText(ticketQty, plan.children[0].price)}`, kind: 'limit' });
    if (sp.kind === 'trailing' && sp.activationPrice !== null) draftLines.push({ price: sp.activationPrice, label: 'Trails from', kind: 'trigger' });
    if (sp.limitPrice !== null) draftLines.push({ price: sp.limitPrice, label: 'Limit', kind: 'limit' });
    if (sp.triggerPrice !== null) draftLines.push({ price: sp.triggerPrice, label: 'Starts at', kind: 'trigger' });
    if (plan?.exits?.tp) draftLines.push({ price: plan.exits.tp, label: 'TP', kind: 'tp' });
    if (plan?.exits?.sl) draftLines.push({ price: plan.exits.sl, label: 'SL', kind: 'sl' });
  }
  const draftKey = `${p.symbol}|${p.side}|${draftLines.map((l) => `${l.kind}:${l.price}:${l.label}`).join(',')}`;
  const placedDraft = useRef<string | null>(null);
  useEffect(() => {
    if (!draftLines.length || placedDraft.current === draftKey) {
      publishDraftOrders(null);
      return;
    }
    placedDraft.current = null;
    publishDraftOrders({ engine: p.engine ?? 'perps', symbol: p.symbol, side: p.side, lines: draftLines });
    // draftKey is the published value; the array is new every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);
  useEffect(() => () => publishDraftOrders(null), []);

  // The plan drawn: in the settings window's Preview section (the Preview button opens it there).
  if (sp?.kind === 'sweep' && sweepPx) levels.push({ label: 'Reference', price: sweepPx, tone: 'muted' });
  if (sp?.kind === 'sweep' && plan?.children[0]?.price) levels.push({ label: 'Band edge', price: plan.children[0].price, tone: p.side === 'buy' ? 'pos' : 'neg' });
  const previewNode = (
    <section className="algo-group" aria-label="Preview">
      <div className="stg__label">What it will do</div>
      <div className="stg__card algo-pvcard">
        <PlanPreview
          plan={amountMissing ? null : plan}
          spec={check.spec}
          side={p.side}
          mid={mid ?? null}
          levels={levels}
          base={kind === 'basket' ? '' : base}
          rates={rates}
          feeNote={feeBp}
          words={`${oneLine(kind, d, p.side, p.quantity, base)}${plan && planFacts(plan, pk) ? ` · ${planFacts(plan, pk)}` : ''} · ${PLACE_WORDS[place]}`}
          why={amountMissing ? 'Enter an amount on the ticket.' : allErrors[0] ?? null}
          onShuffle={hasJitter(kind, d) ? () => setSeed(newSeed()) : undefined}
          uiKind={kind}
          history={history}
          book={bid && ask ? { bid, ask } : null}
          refs={{ mid: bid && ask ? (bid + ask) / 2 : null, mark: markPx, index: indexPx, oracleMid, oracleFair }}
          bandDepth={bandDepth}
          sizeUnit={p.sizeUnit}
          tickSize={tick > 0 ? tick : undefined}
          farBook={(() => {
            const b = snap?.books?.[snap.books.length - 1] ?? null;
            return b ? (p.side === 'buy' ? b.asks : b.bids).map(([px, sz]) => [Number(px), Number(sz)] as [number, number]) : null;
          })()}
          tz={chartTz}
          profile={profile?.weights ?? null}
          dayVolume={dayVolume}
          sweepRef={
            ek === 'sweep'
              ? {
                  price: sweepPx,
                  name: SWEEP_REFERENCE_NAMES[d.sweepRef],
                  used: d.sweepRef === 'mark' || d.sweepRef === 'index' ? ['SoDEX'] : (oracle?.used ?? []).map((v) => ORACLE_VENUE_NAMES[v]),
                  stale: d.sweepRef === 'mark' || d.sweepRef === 'index' ? [] : (oracle?.stale ?? []).map((v) => ORACLE_VENUE_NAMES[v]),
                }
              : null
          }
        />
      </div>
    </section>
  );
  const openPreview = () => {
    lastSec.set(kind, 'preview');
    setAdvOpen(true);
  };
  const exitsHere = offersExits(kind, d, p.reduceOnly);
  const changes = advancedChanges(kind, d, exitsHere);
  const dur = <UnitSelect label="Duration" value={d.durUnit} units={['m', 'h', 'd']} onChange={(u) => set({ durUnit: u })} />;

  // A warning (or a problem no field shows) is a notification, never a box on the ticket: once it has
  // held for a moment (not on every keystroke), and once per message while the ticket is open.
  const said = useRef(new Set<string>());
  // Nothing to say before the amount is in: the empty field speaks for itself.
  const tell = amountMissing ? null : restErrors[0] || (!allErrors.length && plan?.warnings[0]) || null;
  // An order that would hit SoDEX's open-interest cap is said in red, not amber.
  const tellRed = !!tell && (restErrors[0] === tell || redWarnings(plan).has(tell));
  useEffect(() => {
    if (!tell || said.current.has(tell)) return;
    const t = window.setTimeout(() => {
      said.current.add(tell);
      notify(tellRed ? 'error' : 'warn', tell);
    }, 1_500);
    return () => window.clearTimeout(t);
  }, [tell, tellRed]);

  const ticketFields = (
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

          {ek === 'pov' && (
            <>
              <Seg
                label="Speed"
                value={povPreset(d.rate)}
                onChange={(v) => (v === 'custom' ? setAdvOpen(true) : set(setPovPreset(v)))}
                options={[...POV_OPTS, ...(povPreset(d.rate) === 'custom' ? [['custom', 'Custom', `${d.rate || '…'}% of volume (set in Advanced)`] as const] : [])]}
                title="How big a share of the market's volume it takes while it trades"
              />
              {err('rate') && <p className="oe-hint algo-ferr">{err('rate')}</p>}
            </>
          )}

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
              <QtyField
                ticket
                title="Visible"
                value={d.display}
                placeholder={Number(p.quantity) > 0 ? `e.g. ${roundQty(Number(p.quantity) / 10, p.sym?.stepSize)}` : ''}
                onChange={(v) => set({ display: v })}
                hint="The size shown on the book at a time"
                err={err('displayQty')}
              />
            </>
          )}

          {ek === 'sweep' && (
            <SlipField ticket title="Max slippage" stored="pct" value={d.sweepSlip} onChange={(v) => set({ sweepSlip: v })} hint={`How far from the reference price (${SWEEP_REFERENCE_NAMES[d.sweepRef]}) it may fill; every round is an IOC limited there`} err={err('slippageBps')} />
          )}

          {ek === 'chase' && (
            <SlipField ticket title="Max chase" stored="pct" value={d.maxChasePct} placeholder="no limit" onChange={(v) => set({ maxChasePct: v })} hint="How far from where it started it may follow the price" err={err('maxChaseBps')} />
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
              <EachField ticket title={p.side === 'buy' ? 'Each buy' : 'Each sell'} value={d.perOrder} valueUnit={d.dcaUnit} onChange={(v, u) => set({ perOrder: v, dcaUnit: u })} hint={DCA_EACH_HINT[d.dcaSizing]} err={err('perOrderUsd', 'quantity')} />
              <Field
                label="First at"
                value={d.dcaFirst === 'price' ? d.dcaStart : dcaTouch ? roundTick(dcaTouch) : ''}
                onChange={(v) => set({ dcaStart: v, dcaFirst: 'price' })}
                suffix={
                  <>
                    <span className="oe-suffix">USD</span>
                    <button type="button" className="oe-chip" disabled={!mid} title={mid ? 'Use the mid price' : 'No two-sided book to take a mid from'} onClick={() => mid && set({ dcaStart: roundTick(mid), dcaFirst: 'price' })}>MID</button>
                  </>
                }
                title="The first order's price; the later ones step from it"
                err={err('from')}
              />
              {d.dcaLevels === 'step' ? (
                <>
                  <Field label="Step" value={d.dcaStep} onChange={(v) => set({ dcaStep: v })} suffix="%" title={`How far ${p.side === 'buy' ? 'below' : 'above'} the one before each next order rests (Advanced: a step scale, or prices you type)`} err={err('to', 'prices')} />
                  <Field label={p.side === 'buy' ? 'Buys' : 'Sells'} value={d.dcaOrders} int onChange={(v) => set({ dcaOrders: v })} title="How many orders in all, the first included" err={err('orders')} />
                </>
              ) : (
                <Field label="Then at" list value={d.dcaPrices} placeholder={mid ? `e.g. ${toInputText(roundTick(mid * (p.side === 'buy' ? 0.97 : 1.03)))}${PRICE_LIST_SEP} ${toInputText(roundTick(mid * (p.side === 'buy' ? 0.94 : 1.06)))}` : `prices, separated by ${PRICE_LIST_SEP}`} onChange={(v) => set({ dcaPrices: v })} suffix="USD" title={`The later orders' prices, separated by “${PRICE_LIST_SEP}”`} err={err('prices', 'orders')} />
              )}
              {/* Every order the same unless the settings window chose to grow them (Weighted: its curve is there only). */}
              {d.dcaSizing === 'geometric' && <Field label="Size ×" value={d.dcaMult} onChange={(v) => set({ dcaMult: v })} suffix="per order" title="Each next order this many times the one before (Settings: sizing)" err={err('skew', 'weights')} />}
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
  );
  // The window's last section: what it will do, every order it sends, and the slide that places it.
  const kids = plan ? (plan.schedule?.length ? plan.schedule : plan.children).filter((c) => c.qty > 0) : [];
  const verbWord = p.side === 'buy' ? 'buy' : 'sell';
  const sizeWords = plan?.total ? `${fmtQty(plan.total, p.sym?.stepSize)} ${base}` : '';
  const kidUsd = (c: PlannedChild) => c.usd ?? c.qty * (c.price ?? mid ?? 0);
  const ordersNote = !plan ? ''
    : plan.endsAt ? `over ${fmtDuration(plan.endsAt - plan.startsAt)}`
    : pk === 'sweep' ? 'fill-or-cancel rounds'
    : pk === 'scale' || (pk === 'iceberg' && kids.some((c) => c.price !== null)) ? 'resting at their prices'
    : kids.every((c) => c.at === null) ? 'at once'
    : 'as it goes';
  // A basket's orders are on several markets: each row names its own, and sizes carry their coin.
  const multi = pk === 'basket';
  // A basket slice's tag is "<side> <SYMBOL> <k>/<n>" (planAlgo).
  const legOf = (c: PlannedChild) => {
    const market = c.tag.split(' ')[1] ?? '';
    return { market, coin: market.replace(/-USD$/, '') };
  };
  // What it pays: each order's way into the book, from the spec (fees.ts), at this market's rates.
  const split = check.spec && plan ? feeSplit(check.spec, plan, { bid, ask, px: mid }) : null;
  const fee = split && split.maker + split.taker + split.either > 0 ? feeRange(split, rates) : null;
  // How its orders meet the book, where the kind lets the trader choose.
  const style: { value: string; options: ReadonlyArray<Opt<string>>; onChange: (v: string) => void } | null =
    ek === 'twap' || ek === 'vwap' || ek === 'pov'
      ? {
          value: kind === 'chasetwap' && d.exec === 'taker' ? 'hybrid' : d.exec,
          options: kind === 'chasetwap'
            ? [['hybrid', 'Rest, then take', 'Each slice rests at the best price; what falls behind is taken.'], ['maker', 'Maker only', 'Post-only: never takes, what does not fill keeps resting.']]
            : [['taker', 'Taker', 'Each slice takes at once, within your slippage.'], ['hybrid', 'Hybrid', 'Each slice rests first, then takes what falls behind.'], ['maker', 'Maker', 'Post-only, re-priced as the book moves: never takes.']],
          onChange: (v) => set({ exec: v as Draft['exec'] }),
        }
      : kind === 'scale' || kind === 'dca' || kind === 'iceberg' || (kind === 'conditional' && d.then === 'limit')
        ? {
            value: d.postOnly ? 'post' : 'take',
            options: [['post', 'Post only · maker', 'Every order rests in the book at the maker rate; one at or through the market is refused, never filled as a taker.'], ['take', 'Limit · may take', 'An order at or through the market fills at once at the taker rate; the rest wait in the book.']],
            onChange: (v) => set({ postOnly: v === 'post' }),
          }
        : null;
  const summaryNode = (
    <section className={`algo-group algo-summary is-${p.side}`} aria-label="Summary">
      {check.spec && plan ? (
        <>
          <header className="algo-sum__lead">
            <span className="algo-sum__mark" aria-hidden="true"><AlgoIcon kind={kind} size={18} /></span>
            <div>
              <strong>{oneLine(kind, d, p.side, p.quantity, base)}</strong>
              {planFacts(plan, pk) && <span>{planFacts(plan, pk)}</span>}
            </div>
            {d.paper && <span className="algo-practice">Practice</span>}
          </header>
          <dl className="algo-sum__stats">
            {plan.total !== null && (
              <div><dt>Size</dt><dd>{sizeWords}</dd>{plan.notional ? <small>{fmtUsd(plan.notional, 2)}</small> : null}</div>
            )}
            {kids.length > 0 && <div><dt>Orders</dt><dd>{kids.length}</dd><small>{ordersNote}</small></div>}
            {plan.avgPrice && <div><dt>Avg if all fill</dt><dd>{fmtLevel(plan.avgPrice)}</dd><small>USD</small></div>}
            {fee && (
              <div><dt>Fees</dt><dd>{fee.lo === fee.hi ? fmtUsd(fee.lo, 2) : `${fmtUsd(fee.lo, 2)}–${fmtUsd(fee.hi, 2)}`}</dd><small>{feeWords(split!)}</small></div>
            )}
          </dl>
          {style && (
            <div className="algo-sum__block">
              <h4>Orders go in as</h4>
              <div className="algo-sum__style">
                <SSeg label="Orders go in as" value={style.value} options={style.options} onChange={style.onChange} />
              </div>
            </div>
          )}
          <div className="algo-sum__block">
            <h4>Details</h4>
            <Review spec={check.spec} plan={plan} kind={kind} feeRates={rates} place={place} location={place === 'browser' ? null : copy[place].info?.location ?? null} />
          </div>
          {kids.length > 0 && (
            <div className="algo-sum__block">
              <h4>{kids.length > 1 ? `Every order · ${kids.length}` : 'The order'}</h4>
              <div className="algo-sum__kids">
                <table className="algo-sumkids">
                  <thead>
                    <tr><th>#</th><th>When</th><th>{multi ? 'Market' : 'Price'}</th><th>{multi ? 'Size' : `Size (${base})`}</th><th>USD</th></tr>
                  </thead>
                  <tbody>
                    {kids.map((c, i) => (
                      <tr key={i}>
                        <td>{i + 1}</td>
                        <td>{c.at ? fmtTime(c.at) : c.price !== null ? 'when reached' : 'at once'}</td>
                        <td>{multi ? legOf(c).market : c.price !== null ? fmtLevel(c.price) : 'best price'}</td>
                        <td className="is-size">{multi ? `${fmtQ(c.qty)} ${legOf(c).coin}` : fmtQty(c.qty, p.sym?.stepSize)}</td>
                        <td>{c.usd !== undefined || c.price !== null || mid ? fmtUsd(kidUsd(c), 2) : DASH}</td>
                      </tr>
                    ))}
                  </tbody>
                  {kids.length > 1 && (
                    <tfoot>
                      <tr>
                        <td colSpan={2}>Total</td>
                        <td>{plan.avgPrice ? `avg ${fmtLevel(plan.avgPrice)}` : ''}</td>
                        <td>{multi ? '' : fmtQty(kids.reduce((a, c) => a + c.qty, 0), p.sym?.stepSize)}</td>
                        <td>{fmtUsd(kids.reduce((a, c) => a + kidUsd(c), 0), 2)}</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </div>
          )}
          {changes.length > 0 && <p className="algo-sum__changes">Changed from the defaults: {changes.join(', ')}.</p>}
          <div className="algo-sum__go">
            <SlideConfirm
              label={d.paper ? `Slide to start the practice ${verbWord}` : `Slide to ${verbWord} ${sizeWords}`.trim()}
              tone={p.side}
              disabled={!ready}
              busy={busy}
              onConfirm={() => void launch()}
            />
            {!ready && (why || where.why) && (
              <p className="algo-sum__why">
                {why ?? where.why}
                {!d.paper && !liveOk && (
                  <button type="button" className="acctf-view" onClick={() => set({ paper: true })}>Turn on Practice run</button>
                )}
              </p>
            )}
          </div>
        </>
      ) : (
        <p className="oe-hint">{amountMissing ? 'Enter an amount on the ticket.' : allErrors[0] ?? 'Waiting for the market…'}</p>
      )}
    </section>
  );

  return (
    <SizeCtx.Provider value={{ unit: p.sizeUnit ?? 'coin', setUnit: p.onSizeUnit, px: mid ?? null, base, step: p.sym?.stepSize }}>
    <div className={`algo is-${p.side}`}>
      {/* WHAT THE ORDER TYPE ESSENTIALLY NEEDS, in the ticket's own boxes. */}
      {ticketFields}

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
        <button type="button" className="algo-more" aria-haspopup="dialog" onClick={openPreview} title="What it will do: every order, its time and price, sizes, the total and the fees">
          <svg className="algo-more__icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
            <circle cx="8" cy="8" r="1.9" fill="none" stroke="currentColor" strokeWidth="1.4" />
          </svg>
          Preview
        </button>
      </div>

      {/* What it will do, and what it costs, is in the Preview. */}
      <AdvancedWindow
        open={advOpen}
        onClose={() => setAdvOpen(false)}
        kind={kind}
        d={d}
        exitsHere={exitsHere}
        preview={previewNode}
        summary={summaryNode}
        hasOrder
        canReset={changes.length > 0}
        onReset={() => setD((x) => resetAdvanced(kind, x))}
        runsOn={<RunsOn place={place} onChange={setPlace} paper={d.paper} setPaper={(v) => set({ paper: v })} />}
      >
        <TicketSettings
          kind={kind} d={d} set={set} side={p.side} base={base} mid={mid ?? null} dcaFirstLive={dcaTouch ? roundTick(dcaTouch) : null} roundTick={roundTick} err={err}
          quantity={p.quantity} onQuantity={p.onQuantity} sizePct={p.sizePct} onSizePct={p.onSizePct} positionQty={p.positionQty ?? null}
          symbol={p.symbol} needsAmount={needsAmount} exits={plan?.exits ?? null}
          total={plan?.total ?? null} notional={plan?.notional ?? null} stepSize={p.sym?.stepSize}
        />
        <Advanced kind={kind} d={d} set={set} side={p.side} base={base} mid={mid ?? null} roundTick={roundTick} exitsHere={exitsHere} exits={plan?.exits ?? null} errors={fieldErrors} oracleLive={oracle ? { used: oracle.used, stale: oracle.stale } : null} />
      </AdvancedWindow>
      {dialog}
      {busy && <span className="algo-busy" aria-live="polite">Starting…</span>}
    </div>
    </SizeCtx.Provider>
  );
});

export default AlgoTicket;

/** A size as the step allows (a hint, so a rough cut is fine). */
function roundQty(x: number, step?: string): string {
  const s = Number(step);
  if (!(s > 0)) return String(Number(x.toPrecision(3)));
  const q = Math.max(s, Math.floor(x / s) * s);
  const dp = (step?.split('.')[1] ?? '').replace(/0+$/, '').length;
  return q.toFixed(dp);
}

/* ------------------------------------------- the Advanced pop-up ----- */

/* The general Settings window, for this order (SettingsMenu.tsx/.css, whose
   stg__* shell it is): the kind's name and its sections down the left, Reset
   to defaults at their foot; the chosen section on the inner pane - its icon
   and title, one line saying what it is, then labelled cards of rows (title,
   line, control). Each Group names the section it belongs to and renders only
   while that section is open. */

type Sec = 'order' | 'runs' | 'preview' | 'slicing' | 'exec' | 'exits' | 'start' | 'summary';

const SecIcon = ({ children, size = 18 }: { children: ReactNode; size?: number }) => (
  <svg viewBox="0 0 20 20" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);

const SECS: Record<Sec, { label: string; lede: string; icon: ReactNode }> = {
  summary: { label: 'Summary', lede: 'Every choice made, at a glance: what it does, where it runs, what it costs.', icon: <><path d="M5 5h10M5 10h10M5 15h6" /><path d="m13 14 1.5 1.5L17 13" /></> },
  order: { label: 'Order', lede: 'What it trades: the amount and the order\u2019s own choices. The same as on the ticket: a change here is a change there.', icon: <><rect x="3.5" y="3.5" width="13" height="13" rx="2" /><path d="M7 8h6M7 12h4" /></> },
  runs: { label: 'Runs on', lede: 'Where the order is worked, and whether it sends real orders or only practises against the live market.', icon: <><rect x="3" y="4" width="14" height="5" rx="1.5" /><rect x="3" y="11" width="14" height="5" rx="1.5" /><path d="M6 6.5h.01M6 13.5h.01" /></> },
  preview: { label: 'Preview', lede: 'What the engine will do with these settings: its orders over time, or its prices, from the same plan it runs.', icon: <><path d="M2.5 10s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5Z" /><circle cx="10" cy="10" r="2.2" /></> },
  slicing: { label: 'Slicing', lede: 'How the amount is split into child orders: how many, how big, how often.', icon: <><path d="M3 15h14" /><rect x="4" y="10" width="2.5" height="5" rx="0.6" /><rect x="8.75" y="7" width="2.5" height="8" rx="0.6" /><rect x="13.5" y="4" width="2.5" height="11" rx="0.6" /></> },
  exec: { label: 'Price & execution', lede: 'How each order meets the book: where it rests, how far it may slip, when it takes.', icon: <><path d="M3 14.5 7.5 10l3 3L17 6.5" /><path d="M13 6.5h4v4" /></> },
  exits: { label: 'Exits', lede: 'Take profit and stop loss, placed once the order has filled.', icon: <><path d="M4 3v14" /><path d="M4 4h10l-2 3 2 3H4" /></> },
  start: { label: 'Start & limits', lede: 'When it begins, and the prices and spread it keeps to while it runs.', icon: <><circle cx="10" cy="10" r="7" /><path d="M10 6v4l2.5 2" /></> },
};

/** The sections a kind has: the ticket's own fields first, then Runs on. */
function sectionsFor(kind: UiKind, exitsHere: boolean, hasOrder: boolean): Sec[] {
  const ek: string = engineKind(kind);
  const out: Sec[] = [...(hasOrder ? ['order' as const] : []), 'runs', 'preview'];
  if (['twap', 'vwap', 'basket', 'pov', 'iceberg', 'scale', 'dca', 'swarm'].includes(ek)) out.push('slicing');
  // A DCA's orders are resting limits: nothing to tune in how they meet the book.
  if (ek !== 'basket' && ek !== 'dca') out.push('exec');
  if (exitsHere && kind !== 'bracket') out.push('exits');
  out.push('start', 'summary');
  return out;
}

/* The last open section per kind, for as long as the page lives (never stored). */
const lastSec = new Map<UiKind, Sec>();

const SecCtx = createContext<Sec | null>(null);

function AdvancedWindow({ open, onClose, kind, d, exitsHere, canReset, onReset, runsOn, preview, summary, hasOrder, children }: {
  open: boolean; onClose: () => void; kind: UiKind; d: Draft; exitsHere: boolean; canReset: boolean; onReset: () => void; runsOn: ReactNode; preview: ReactNode; summary: ReactNode; hasOrder: boolean; children: ReactNode;
}) {
  const secs = sectionsFor(kind, exitsHere, hasOrder);
  const [, bump] = useState(0);
  const want = lastSec.get(kind) ?? secs[0]!;
  const sec: Sec = secs.includes(want) ? want : secs[0]!;
  const pick = (v: Sec) => {
    lastSec.set(kind, v);
    bump((n) => n + 1);
  };
  const cur = SECS[sec];
  const name = `${menuName(kind)} settings`;
  return (
    <Modal open={open} onClose={onClose} title={name} size="lg" className="stg algo-sheet">
      <div className="stg__body">
        <nav className="stg__nav" aria-label={`${name} sections`}>
          <div className="stg__brand"><AlgoIcon kind={kind} size={22} /><span>{name}</span></div>
          <span className="stg__rule" aria-hidden="true" />
          <div className="stg__tabs">
            {secs.map((id) => (
              <button key={id} type="button" className={`stg__tab${sec === id ? ' is-on' : ''}`} aria-current={sec === id ? 'page' : undefined} onClick={() => pick(id)}>
                <SecIcon size={17}>{SECS[id].icon}</SecIcon>
                <span>{SECS[id].label}</span>
              </button>
            ))}
          </div>
          <button type="button" className="stg__tab stg__out" disabled={!canReset} onClick={onReset} title={canReset ? 'Every setting here back to its default' : 'Every setting is at its default'}>
            <SecIcon size={17}><path d="M4 10a6 6 0 1 0 1.8-4.3" /><path d="M4 3.5v3h3" /></SecIcon>
            <span>Reset to defaults</span>
          </button>
        </nav>
        <div className="stg__pane" key={sec}>
          <div className="stg__panehead"><SecIcon size={22}>{cur.icon}</SecIcon><h3>{cur.label}</h3></div>
          <p className="stg__lede">{cur.lede}</p>
          {sec === 'summary' ? summary : sec === 'runs' ? runsOn : sec === 'preview' ? preview : <SecCtx.Provider value={sec}>{children}</SecCtx.Provider>}
          {sec !== 'summary' && (
            <div className="stg__actions algo-done">
              <button type="button" className="stg__btn is-go" onClick={onClose}>Done</button>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

type Opt<T> = readonly [T, string, string?];

/** Children only in their own section of the window. */
function InSec({ sec, children }: { sec: Sec; children: ReactNode }) {
  const open = useContext(SecCtx);
  return open !== null && open !== sec ? null : <>{children}</>;
}

function Group({ label, sec = 'exec', children }: { label: string; sec?: Sec; children: ReactNode }) {
  const open = useContext(SecCtx);
  if (open !== null && open !== sec) return null;
  return (
    <section className="algo-group" aria-label={label}>
      <div className="stg__label">{label}</div>
      <div className="stg__card">{children}</div>
    </section>
  );
}

function Row({ title, hint, id, children }: { title: string; hint?: ReactNode; id?: string; children?: ReactNode }) {
  return (
    <div className="stg__row">
      <div className="stg__rowtext">
        {id ? (
          <label htmlFor={id}>
            <b>{title}</b>
          </label>
        ) : (
          <b>{title}</b>
        )}
        {hint && <small>{hint}</small>}
      </div>
      {children}
    </div>
  );
}

/**
 * A max slippage in the app's one unit, bp or % (slipUnit.ts), switched in its own box: the value is
 * kept as the draft keeps it (`stored`), only what is shown converts. On the ticket in its boxes, in
 * the settings window in its own.
 */
function SlipField({ title, hint, value, onChange, stored, err, ticket = false, after, placeholder }: {
  title: string; hint: string; value: string; onChange: (v: string) => void; stored: 'bp' | 'pct'; err?: string; ticket?: boolean; after?: string; placeholder?: string;
}) {
  const [u, setU] = useSlipUnit();
  const [text, setText] = useState<string | null>(null);
  const pct = stored === 'bp' ? Number(value) / 100 : Number(value);
  const shown = text ?? (value.trim() === '' ? '' : pctAsUnit(pct, u));
  const write = (t: string) => {
    setText(t);
    const p2 = unitAsPct(t, u);
    if (t.trim() === '') onChange('');
    else if (Number.isFinite(p2)) onChange(String(Number((stored === 'bp' ? p2 * 100 : p2).toFixed(6))));
  };
  const opts: ReadonlyArray<readonly [SlipUnit, string]> = [['bp', 'bp'], ['pct', '%']];
  const pick = (v: SlipUnit) => {
    setText(null);
    setU(v);
  };
  const unit = ticket ? <ModeSelect label={title} value={u} options={opts} onChange={pick} /> : <APick label={title} value={u} options={opts} onChange={pick} />;
  return ticket ? (
    <Field label={title} value={shown} placeholder={placeholder} onChange={write} suffix={unit} title={hint} err={err} />
  ) : (
    <AField title={title} hint={after ? `${hint} ${after}` : hint} value={shown} placeholder={placeholder} onChange={write} unit={unit} err={err} />
  );
}

/** The order panel's size unit for the fields sized in the coin (AlgoTicket provides it). */
const SizeCtx = createContext<{ unit: 'coin' | 'usd'; setUnit?: (u: 'coin' | 'usd') => void; px: number | null; base: string; step?: string }>({ unit: 'coin', px: null, base: '' });

/**
 * A size in the coin, shown in the order panel's unit (the coin, or USD at the price now) with that
 * unit's switch in its box; it is kept in the coin as the draft keeps it.
 */
/** "1× to 2.5×": a weighted curve's smallest and largest size. */
const curveSpan = (c: Draft['dcaCurve']): string => {
  const ys = c.map((q) => q[1]);
  return `${fmtPlain(Number(Math.min(...ys).toFixed(2)))}× to ${fmtPlain(Number(Math.max(...ys).toFixed(2)))}×`;
};

const DCA_EACH_HINT: Record<DcaSizing, string> = {
  linear: 'Every order exactly this size',
  weighted: 'The size at 1× on the curve; each order is its point on the curve times this',
  geometric: 'The first order’s size; each next one Size × times the one before',
};
const DCA_SIZINGS: ReadonlyArray<Opt<DcaSizing>> = [
  ['linear', 'Linear', 'Every order the same size: the plain DCA.'],
  ['weighted', 'Weighted', 'Each order’s size off a curve you draw: drag its points, add more.'],
  ['geometric', 'Geometric', 'Each next order a multiple of the one before (1, 1.5, 2.25 …): the martingale DCA bots use.'],
];

/**
 * A DCA's each order, in the order panel's unit (USD or the coin). It is kept in the unit it is
 * shown in (`valueUnit`), so a linear DCA is exactly that amount every time; switching the unit
 * converts it at the price now.
 */
function EachField({ title, hint, value, valueUnit, onChange, err, ticket = false }: {
  title: string; hint: string; value: string; valueUnit: 'usd' | 'coin'; onChange: (v: string, u: 'usd' | 'coin') => void; err?: string; ticket?: boolean;
}) {
  const { unit, setUnit, px, base, step } = useContext(SizeCtx);
  const want: 'usd' | 'coin' = unit === 'coin' && px ? 'coin' : 'usd';
  const conv = (v: string, from: 'usd' | 'coin', to: 'usd' | 'coin'): string =>
    v.trim() === '' || from === to || !px ? v : to === 'coin' ? toStep(Number(v) / px, step) : (Number(v) * px).toFixed(2);
  // The panel's unit moved (here or on the order panel): the amount follows it, converted once.
  useEffect(() => {
    if (valueUnit !== want && px) onChange(conv(value, valueUnit, want), want);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [want]);
  const shown = conv(value, valueUnit, want);
  const write = (t: string) => onChange(t, want);
  const opts: ReadonlyArray<readonly ['usd' | 'coin', string]> = [['usd', 'USD'], ['coin', base || 'Coin']];
  const pick = (u: 'coin' | 'usd') => setUnit?.(u);
  const box = setUnit ? (ticket ? <ModeSelect label={title} value={want} options={opts} onChange={pick} /> : <APick label={title} value={want} options={opts} onChange={pick} />) : 'USD';
  return ticket ? (
    <Field label={title} value={shown} onChange={write} suffix={box} title={hint} err={err} />
  ) : (
    <AField title={title} hint={hint} value={shown} onChange={write} unit={box} err={err} />
  );
}

function QtyField({ title, hint, value, onChange, placeholder, err, ticket = false }: {
  title: string; hint: string; value: string; onChange: (v: string) => void; placeholder?: string; err?: string; ticket?: boolean;
}) {
  const { unit, setUnit, px, base, step } = useContext(SizeCtx);
  const [text, setText] = useState<string | null>(null);
  const usd = unit === 'usd' && !!px;
  const shown = text ?? (value.trim() === '' ? '' : usd ? (Number(value) * px!).toFixed(2) : value);
  const write = (t: string) => {
    if (!usd) {
      setText(null);
      onChange(t);
      return;
    }
    setText(t);
    onChange(t.trim() === '' ? '' : toStep(Number(t) / px!, step));
  };
  const opts: ReadonlyArray<readonly ['coin' | 'usd', string]> = [['coin', base || 'Coin'], ['usd', 'USD']];
  const pick = (u: 'coin' | 'usd') => {
    setText(null);
    setUnit?.(u);
  };
  const box = setUnit ? (ticket ? <ModeSelect label={title} value={unit} options={opts} onChange={pick} /> : <APick label={title} value={unit} options={opts} onChange={pick} />) : usd ? 'USD' : base;
  return ticket ? (
    <Field label={title} value={shown} placeholder={placeholder} onChange={write} suffix={box} title={hint} err={err} />
  ) : (
    <AField title={title} hint={hint} value={shown} placeholder={placeholder} onChange={write} unit={box} err={err} />
  );
}

function AField({ title, hint, value, onChange, unit, placeholder, int = false, signed = false, list = false, err }: {
  title: string; hint: ReactNode; value: string; onChange: (v: string) => void; unit?: ReactNode; placeholder?: string; int?: boolean; signed?: boolean; list?: boolean; err?: string;
}) {
  const id = useId();
  return (
    <Row title={title} hint={hint} id={id}>
      <div className="algo-ctl">
        <div className={`algo-sf${err ? ' is-bad' : ''}`}>
          <input
            id={id}
            autoComplete="off"
            inputMode={int ? 'numeric' : list ? 'text' : 'decimal'}
            value={int || list ? value : toInputText(value)}
            placeholder={placeholder ?? ''}
            aria-invalid={err ? true : undefined}
            aria-describedby={err ? `${id}-err` : undefined}
            onChange={(e) => onChange(list ? priceListInput(e.target.value) : int ? wholeInput(e.target.value, signed) : decimalInput(e.target.value, { signed, prev: value }))}
          />
          {unit === undefined || unit === '' ? null : typeof unit === 'string' ? <span className="algo-sf__unit">{unit}</span> : unit}
        </div>
        {err && <p id={`${id}-err`} className="oe-hint algo-ferr">{err}</p>}
      </div>
    </Row>
  );
}

/** A unit picked inside a pop-up field's box. */
function APick<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: ReadonlyArray<readonly [T, string]>; onChange: (v: T) => void }) {
  if (options.length === 2) return <UnitToggle label={label} value={value} options={options} onChange={onChange} className="algo-sf__unit" />;
  return (
    <select className="algo-sf__unit algo-sf__pick" aria-label={`${label} unit`} value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map(([v, t]) => (
        <option key={v} value={v}>{t}</option>
      ))}
    </select>
  );
}

const ATime = ({ label, value, units, onChange }: { label: string; value: Unit; units: readonly Unit[]; onChange: (u: Unit) => void }) => (
  <APick label={label} value={value} options={units.map((u) => [u, UNIT_NAME[u]] as const)} onChange={onChange} />
);

/** One of a few, as a segmented control; the chosen option's line under it. */
function SSeg<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: ReadonlyArray<Opt<T>>; onChange: (v: T) => void }) {
  const note = options.find(([v]) => v === value)?.[2];
  return (
    <div className="algo-ctl">
      <div className="algo-sseg" role="radiogroup" aria-label={label}>
        {options.map(([v, text, hint]) => (
          <button key={String(v)} type="button" role="radio" aria-checked={value === v} title={hint} className={value === v ? 'is-on' : undefined} onClick={() => onChange(v)}>
            {text}
          </button>
        ))}
      </div>
      {note && <small className="algo-sseg__note">{note}</small>}
    </div>
  );
}

function ASeg<T extends string | number>({ title, hint, value, options, onChange }: { title: string; hint: ReactNode; value: T; options: ReadonlyArray<Opt<T>>; onChange: (v: T) => void }) {
  return (
    <Row title={title} hint={hint}>
      <SSeg label={title} value={value} options={options} onChange={onChange} />
    </Row>
  );
}

/** A switch that says what it means in either position. */
function ASwitch({ title, hint, checked, onChange, on = 'On', off = 'Off' }: { title: string; hint: ReactNode; checked: boolean; onChange: (v: boolean) => void; on?: string; off?: string }) {
  return (
    <Row title={title} hint={hint}>
      <button type="button" role="switch" aria-checked={checked} aria-label={title} className={`stg__switch${checked ? ' is-on' : ''}`} onClick={() => onChange(!checked)}>
        <i className="stg__track"><i /></i>
        <span aria-hidden="true">{checked ? on : off}</span>
      </button>
    </Row>
  );
}

const PLACE_CARDS: ReadonlyArray<readonly [Place, string, string]> = [
  ['hosted', 'ValueDesk', 'Runs 24/7 on our executor, even with your browser closed.'],
  ['browser', 'This browser', 'Signed here with your trading key. Keep a ValueDesk tab open.'],
  ['self', 'Self-hosted', 'Runs on the copier you host yourself.'],
];

/** The pop-up's first section: where it runs (kept across reloads and kinds, executor.ts), then the practice run. */
function RunsOn({ place, onChange, paper, setPaper }: {
  place: Place; onChange: (v: Place) => void; paper: boolean; setPaper: (v: boolean) => void;
}) {
  return (
    <section className="algo-group" aria-label="Runs on">
      <div className="stg__label">Executor</div>
      <div className="stg__choices is-three algo-places" role="radiogroup" aria-label="Runs on">
        {PLACE_CARDS.map(([v, t, line]) => (
          <button key={v} type="button" role="radio" aria-checked={place === v} className={`stg__choice${place === v ? ' is-on' : ''}`} onClick={() => onChange(v)}>
            <b>{t}</b>
            <small>{line}</small>
          </button>
        ))}
      </div>
      <div className="stg__label">Practice</div>
      <div className="stg__card">
        <ASwitch
          title="Practice run · no real orders"
          hint="Works the plan against the live market and sends nothing, so you can watch what it would do."
          checked={paper}
          onChange={setPaper}
          on="On · nothing is sent"
          off="Off · real orders"
        />
      </div>
    </section>
  );
}

const POST_ONLY_HINT = 'Never takes: an order that would cross the book is refused instead of filling.';

function PostOnly({ d, set }: { d: Draft; set: (p: Partial<Draft>) => void }) {
  return <ASwitch title="Post only" hint={POST_ONLY_HINT} checked={d.postOnly} onChange={(v) => set({ postOnly: v })} on="On · maker only" off="Off · may take" />;
}

/**
 * Everything in the kind's Advanced pop-up, in sections: what the kind is tuned
 * by, how it trades, its exits, then when it starts and what limits it (a price
 * limit, the start, price bounds, the spread guard). Every value is the default
 * until changed.
 */
/**
 * The ticket's own fields in the settings window, each in the section it belongs to (the duration with
 * the slicing, a max slippage with the execution, a start price with the start), in the window's own
 * controls. The same draft as the ticket: a change here is a change there.
 */
/** Where an order type not sized by the Amount gets its size. */
const SIZED_BY: Partial<Record<string, string>> = {
  dca: 'All its orders together, from the USD of each and how many (below).',
  basket: 'Sized by the USD of each market (below). Here, all of them together.',
  trailing: 'It closes the whole position on this market when it fires (Price & execution: Size).',
  conditional: 'It closes a share of the position when it fires (below).',
  twap: 'It closes a share of your position (below).',
};

/** A size on the market's step, as typed text. */
const toStep = (x: number, step: string | undefined): string => {
  const st = Number(step);
  if (!(st > 0)) return String(Number(x.toPrecision(8)));
  const dp = (String(st).split('.')[1] ?? '').length;
  return (Math.floor(x / st + 1e-9) * st).toFixed(dp);
};

function TicketSettings({ kind, d, set, side, base, mid, dcaFirstLive, roundTick, err, quantity, onQuantity, sizePct, onSizePct, positionQty, symbol, needsAmount, exits, total, notional, stepSize }: {
  kind: UiKind; d: Draft; set: (p: Partial<Draft>) => void; side: 'buy' | 'sell'; base: string; mid: number | null; dcaFirstLive?: string | null; roundTick: (x: number) => string;
  err: (...keys: string[]) => string | undefined; quantity: string; onQuantity?: (v: string) => void; sizePct?: number; onSizePct?: (pct: number) => void;
  positionQty: number | null; symbol: string; needsAmount: boolean; exits: { tp: number | null; sl: number | null } | null;
  total: number | null; notional: number | null; stepSize?: string;
}) {
  const ek = engineKind(kind);
  // The USD box while it is typed in (the coin amount follows it); otherwise it shows the amount's value.
  const [usdDraft, setUsdDraft] = useState<string | null>(null);
  const durUnit = <ATime label="Duration" value={d.durUnit} units={['m', 'h', 'd']} onChange={(u) => set({ durUnit: u })} />;
  const duration = <AField title="Duration" hint="How long it takes from its first slice to its last." value={d.dur} onChange={(v) => set({ dur: v })} unit={durUnit} err={err('durationMs')} />;
  const pct = sizePct ?? 0;
  return (
    <>
      <Group label="Size" sec="order">
        {needsAmount && onQuantity ? (
          <>
            <Row title="Amount" hint={kind === 'trailing' ? 'How much of the position it closes when it fires: in the coin or in USD.' : 'The whole order: in the coin or in USD at the price now.'}>
              <div className="algo-pair">
                <div className="algo-sf">
                  <input autoComplete="off" inputMode="decimal" aria-label={`Amount in ${base}`} value={toInputText(quantity)} placeholder="0" onChange={(e) => onQuantity(decimalInput(e.target.value, { prev: quantity }))} />
                  <span className="algo-sf__unit">{base}</span>
                </div>
                <div className="algo-sf">
                  <input
                    autoComplete="off"
                    inputMode="decimal"
                    aria-label="Amount in USD"
                    value={toInputText(usdDraft ?? (Number(quantity) > 0 && mid ? (Number(quantity) * mid).toFixed(2) : ''))}
                    placeholder="0"
                    onFocus={() => setUsdDraft(Number(quantity) > 0 && mid ? (Number(quantity) * mid).toFixed(2) : '')}
                    onBlur={() => setUsdDraft(null)}
                    onChange={(e) => {
                      const v = decimalInput(e.target.value);
                      setUsdDraft(v);
                      onQuantity(Number(v) > 0 && mid ? toStep(Number(v) / mid, stepSize) : '');
                    }}
                  />
                  <span className="algo-sf__unit">USD</span>
                </div>
              </div>
            </Row>
            {onSizePct && (
              <Row
                title={kind === 'trailing' ? 'Share of the position' : 'Share of what is available'}
                hint={kind === 'trailing' ? (positionQty ? `Of your ${fmtQ(Math.abs(positionQty))} ${base} ${positionQty > 0 ? 'long' : 'short'} on ${symbol}.` : `No open position on ${symbol}: nothing to measure.`) : undefined}
              >
                <div className="oe-slider algo-slider">
                  <div className="oe-slider__rail" style={{ ['--oe-p' as string]: pct / 100 } as CSSProperties}>
                    <div className="oe-slider__fill" />
                    {[0, 25, 50, 75, 100].map((n) => (
                      <i key={n} className={`oe-slider__notch${pct >= n ? ' is-past' : ''}`} style={{ left: `${n}%` }} aria-hidden="true" />
                    ))}
                    <input className="oe-slider__input" type="range" min={0} max={100} step={1} value={pct} aria-label="Share" onChange={(e) => onSizePct(Number(e.currentTarget.value))} />
                  </div>
                  <span className="algo-slider__v">{Math.round(pct)}%</span>
                </div>
              </Row>
            )}
            {kind === 'twap' && d.twapClose && <AField title="Close" hint="The share of your position it closes, reduce-only." value={d.twapCloseShare} onChange={(v) => set({ twapCloseShare: v })} unit="% of position" err={err('closeShare')} />}
          </>
        ) : (
          // Sized another way (DCA by USD per order, a basket per market, a close or a whole position): what that comes to.
          <Row title="Amount" hint={SIZED_BY[ek] ?? 'Sized by its own settings.'}>
            <span className="algo-readout">{total && total > 0 ? `${fmtQ(total)} ${base}` : '—'}{notional ? ` · ${fmtUsd(notional, 2)}` : ''}</span>
          </Row>
        )}
      </Group>

      {(ek === 'twap' || ek === 'vwap') && <Group label="Time" sec="slicing">{duration}{hasRandomize(kind) && <ASwitch title="Randomize" hint="Varies each slice’s size and time a little, so the order is harder to spot (how much: below)." checked={randomizeOn(kind, d)} onChange={(v) => set(setRandomize(kind, v))} on="On · harder to spot" off="Off · even slices" />}</Group>}

      {ek === 'iceberg' && (
        <>
          <Group label="Price" sec="exec">
            <AField title="Price" hint="Where the clips rest. Empty: at the best price, following it." value={d.icePeg ? '' : d.icePrice} placeholder="best price" onChange={(v) => set({ icePrice: v, icePeg: v.trim() === '' })} unit="USD" err={err('price')} />
          </Group>
          <Group label="Clips" sec="slicing">
            <QtyField title="Visible" hint="The size shown on the book at a time." value={d.display} onChange={(v) => set({ display: v })} err={err('displayQty')} />
          </Group>
        </>
      )}

      {ek === 'sweep' && (
        <Group label="Max slippage" sec="exec">
          <SlipField title="Max slippage" stored="pct" hint="How far from the reference price (below) it may fill; every round is an IOC limited there." value={d.sweepSlip} onChange={(v) => set({ sweepSlip: v })} err={err('slippageBps')} />
        </Group>
      )}

      {ek === 'chase' && (
        <Group label="Chase" sec="exec">
          <SlipField title="Max chase" stored="pct" hint="How far from where it started it may follow the price. Empty: no limit." value={d.maxChasePct} placeholder="no limit" onChange={(v) => set({ maxChasePct: v })} err={err('maxChaseBps')} />
        </Group>
      )}

      {ek === 'scale' && (
        <Group label="Levels" sec="slicing">
          <AField title="From" hint="The first order (nearest the market, usually)." value={d.from} onChange={(v) => set({ from: v })} unit="USD" err={err('from')} />
          <AField title="To" hint="The last order." value={d.to} onChange={(v) => set({ to: v })} unit="USD" err={err('to')} />
          <AField title="Orders" hint="How many orders between them." value={d.orders} int onChange={(v) => set({ orders: v })} err={err('orders')} />
          <ASeg title="Size" hint="How the amount is spread over the orders." value={scaleSize(d)} onChange={(v) => set(setScaleSize(d, v))} options={SCALE_SIZES} />
        </Group>
      )}

      {ek === 'dca' && (
        <Group label="Orders" sec="order">
          <EachField title={side === 'buy' ? 'Each buy' : 'Each sell'} hint={`${DCA_EACH_HINT[d.dcaSizing]}.`} value={d.perOrder} valueUnit={d.dcaUnit} onChange={(v, u) => set({ perOrder: v, dcaUnit: u })} err={err('perOrderUsd', 'quantity')} />
          <AField
            title="First at"
            hint="The first order’s price; the later ones step from it."
            value={d.dcaFirst === 'price' ? d.dcaStart : dcaFirstLive ?? ''}
            onChange={(v) => set({ dcaStart: v, dcaFirst: 'price' })}
            unit={<span className="algo-sf__unit algo-sf__units">USD<button type="button" className="oe-chip" disabled={!mid} onClick={() => mid && set({ dcaStart: roundTick(mid), dcaFirst: 'price' })}>MID</button></span>}
            err={err('from')}
          />
          {d.dcaLevels === 'step' ? (
            <>
              <AField title="Step" hint={`How far ${side === 'buy' ? 'below' : 'above'} the one before each next order rests.`} value={d.dcaStep} onChange={(v) => set({ dcaStep: v })} unit="%" err={err('to', 'prices')} />
              <AField title={side === 'buy' ? 'Buys' : 'Sells'} hint="How many orders in all, the first included." value={d.dcaOrders} int onChange={(v) => set({ dcaOrders: v })} err={err('orders')} />
            </>
          ) : (
            <AField title="Then at" list hint={`The later orders’ prices, separated by “${PRICE_LIST_SEP}”.`} value={d.dcaPrices} onChange={(v) => set({ dcaPrices: v })} unit="USD" err={err('prices', 'orders')} />
          )}
          <ASeg title="Sizing" hint="How the orders’ sizes go, one after another." value={d.dcaSizing} onChange={(v) => set({ dcaSizing: v })} options={DCA_SIZINGS} />
          {d.dcaSizing === 'weighted' && (
            <div className="algo-curvewrap">
              <DcaCurve
                points={d.dcaCurve}
                orders={d.dcaLevels === 'list' ? parsePrices(d.dcaPrices).length + 1 : Number(d.dcaOrders)}
                each={Number(d.perOrder) || 0}
                unit={d.dcaUnit === 'coin' ? base : 'USD'}
                side={side}
                prices={mid ? dcaLadder(d, { side, bid: mid, ask: mid }).prices : null}
                coin={d.dcaUnit === 'coin'}
                onChange={(v) => set({ dcaCurve: v })}
              />
              {err('skew', 'weights') && <p className="oe-hint algo-ferr">{err('skew', 'weights')}</p>}
            </div>
          )}
          {d.dcaSizing === 'geometric' && <AField title="Size ×" hint="Each next order this many times the one before: 1.5 gives 1, 1.5, 2.25, 3.4 …" value={d.dcaMult} onChange={(v) => set({ dcaMult: v })} unit="per order" err={err('skew', 'weights')} />}
          <PostOnly d={d} set={set} />
        </Group>
      )}

      {ek === 'swarm' && (
        <Group label="Clips" sec="slicing">
          <AField title="Clips" hint="How many small orders it is cut into." value={d.clips} int onChange={(v) => set({ clips: v })} unit="orders" err={err('clips')} />
          <ASwitch title="Randomize sizes" hint="Clips of uneven size, so they read less like one order." checked={randomizeOn(kind, d)} onChange={(v) => set(setRandomize(kind, v))} on="On · uneven" off="Off · even" />
        </Group>
      )}

      {ek === 'trailing' && (
        <>
          <Group label="Trail" sec="exec">
            <AField title="Trail" hint={side === 'sell' ? 'How far the price may fall from its high before it closes.' : 'How far the price may rise from its low before it closes.'} value={d.trail} onChange={(v) => set({ trail: v })} unit={<APick label="Trail" value={d.trailMode} options={[['pct', '%'], ['abs', 'USD']]} onChange={(v) => set({ trailMode: v })} />} err={err('trailPct', 'trailAbs')} />
          </Group>
          <Group label="Activation" sec="start">
            <AField title="Start at" hint={`It starts trailing once the price reaches this (${side === 'sell' ? 'at or above' : 'at or below'}). Empty: now.`} value={d.activation} placeholder="now" onChange={(v) => set({ activation: v })} unit="USD" err={err('activationPrice')} />
          </Group>
        </>
      )}

      {ek === 'bracket' && (
        <Group label="Entry and exits" sec="order">
          <ASeg title="Entry" hint="How it gets in." value={d.entry} onChange={(v) => set({ entry: v })} options={[['market', 'Market', 'Takes at once, within your max slippage.'], ['limit', 'Limit', 'Rests at your price.']]} />
          {d.entry === 'limit' && <AField title="Entry price" hint="Where it rests." value={d.entryPrice} onChange={(v) => set({ entryPrice: v })} unit="USD" err={err('price')} />}
          <AField title="Take-profit" hint={`${side === 'buy' ? 'Above' : 'Below'} the entry, as a distance or a price.${exits?.tp ? ` Now ${fmtLevel(exits.tp)}.` : ''}`} value={d.tp} placeholder="none" onChange={(v) => set({ tp: v })} unit={<APick label="Take-profit" value={d.tpMode} options={[['pct', '%'], ['price', 'USD']]} onChange={(v) => set({ tpMode: v })} />} />
          <AField title="Stop-loss" hint={`${side === 'buy' ? 'Below' : 'Above'} the entry, as a distance or a price.${exits?.sl ? ` Now ${fmtLevel(exits.sl)}.` : ''}`} value={d.sl} placeholder="none" onChange={(v) => set({ sl: v })} unit={<APick label="Stop-loss" value={d.slMode} options={[['pct', '%'], ['price', 'USD']]} onChange={(v) => set({ slMode: v })} />} err={err('exits')} />
        </Group>
      )}

      {ek === 'basket' && (
        <>
          <Group label="Markets" sec="order"><div className="algo-inset"><BasketLegs d={d} set={set} /></div></Group>
          <Group label="Each market" sec="slicing">
            <ASeg title="Each market" hint="How each market is worked." value={d.basketStyle} onChange={(v) => set({ basketStyle: v })} options={[['swarm', 'Swarm', 'Small takers in waves, now.'], ['twap', 'TWAP', 'Slices over a time you choose.']]} />
            {d.basketStyle === 'twap' && duration}
          </Group>
        </>
      )}

      {ek === 'conditional' && <Group label="When and then" sec="order"><div className="algo-inset"><ConditionalFields d={d} set={set} symbol={symbol} base={base} /></div></Group>}
    </>
  );
}

function Advanced({ kind, d, set, side, base, mid, roundTick, exitsHere, exits, errors, oracleLive }: {
  kind: UiKind; d: Draft; set: (p: Partial<Draft>) => void; side: 'buy' | 'sell'; base: string; mid: number | null; roundTick: (x: number) => string;
  exitsHere: boolean; exits: { tp: number | null; sl: number | null } | null; errors: Record<string, string>;
  oracleLive: { used: readonly OracleVenue[]; stale: readonly OracleVenue[] } | null;
}) {
  const ek = engineKind(kind);
  const err = (...keys: string[]) => errFor(errors, ...keys);
  const auto = autoSlices(d.dur, d.durUnit);
  const slicesRow = (
    <AField
      title="Slices"
      hint={`How many child orders it sends. Empty: one a minute over the duration (${auto}).`}
      value={d.slicesAuto ? '' : d.slices}
      placeholder={`auto · ${auto}`}
      int
      onChange={(v) => set(v.trim() === '' ? { slicesAuto: true } : { slices: v, slicesAuto: false })}
      err={err('slices')}
    />
  );
  const slip = (hint: string) => <SlipField title="Max slippage" stored="bp" hint={hint} value={d.slip} onChange={(v) => set({ slip: v })} err={err('slippageBps')} />;
  const sizeVaries = (key: 'sizeJitter' | 'scaleJitter' | 'displayJitter', hint: string) => (
    <AField title="Size varies" hint={hint} value={d[key]} onChange={(v) => set({ [key]: v } as Partial<Draft>)} unit="± %" err={err('sizeJitter', 'displayJitter')} />
  );
  const fromAvg = side === 'buy' ? 'below' : 'above';
  return (
    <>
      {(ek === 'twap' || ek === 'vwap') && (
        <>
          <Group label="Slicing" sec="slicing">
            {slicesRow}
            {ek === 'vwap' && (
              <>
                <ASeg title="History" hint="Days of volume the hour-by-hour profile is the median of." value={d.lookback} onChange={(v) => set({ lookback: v })} options={[[7, '7 days'], [14, '14 days'], [28, '28 days'], [41, '6 weeks']]} />
                <ASwitch title="Adaptive" hint="Goes faster while the market trades more than usual, slower while it trades less." checked={d.adaptive} onChange={(v) => set({ adaptive: v })} on="On · follows today's volume" off="Off · the profile only" />
              </>
            )}
            {kind === 'twap' && (
              <>
                <Row title="Urgency" hint="Front-loaded puts more of the amount early; back-loaded puts more late.">
                  <div className="algo-ctl">
                    <div className="algo-urgency">
                      <input type="range" min={-1} max={1} step={0.1} value={d.urgency} aria-label="Urgency" onChange={(e) => set({ urgency: Number(e.target.value) })} />
                      <span className="algo-urgency__v">{d.urgency === 0 ? 'Even' : d.urgency > 0 ? `Front ${Math.round(d.urgency * 100)}` : `Back ${Math.round(-d.urgency * 100)}`}</span>
                    </div>
                  </div>
                </Row>
                <ASwitch title="Close position" hint="Works a share of your position on this market instead of an amount, reduce-only." checked={d.twapClose} onChange={(v) => set({ twapClose: v })} on="On · closes a share" off="Off · trades the amount" />
              </>
            )}
            {ek === 'twap' && (
              <>
                <QtyField title="Smallest slice" hint="No slice below this: what is due waits until it reaches it (except at the end). Empty: any." value={d.minSlice} placeholder="any" onChange={(v) => set({ minSlice: v })} err={err('minSliceQty')} />
                <QtyField title="Largest slice" hint="No slice above this. Empty: any." value={d.maxSlice} placeholder="any" onChange={(v) => set({ maxSlice: v })} err={err('maxSliceQty')} />
              </>
            )}
          </Group>
          <ExecGroup d={d} set={set} chaseOnly={kind === 'chasetwap'} jitter={ek === 'vwap' ? 'size' : 'both'} cap err={err} />
        </>
      )}

      {ek === 'bracket' && <Group label="Entry">{slip('A market entry takes at most this far past the best price.')}</Group>}

      {ek === 'basket' && (
        <Group label="Execution" sec="slicing">
          {d.basketStyle === 'twap' ? (
            slicesRow
          ) : (
            <>
              <AField title="Clips" hint="How many small orders each market is split into." value={d.clips} int onChange={(v) => set({ clips: v })} unit="per market" err={err('clips')} />
              <ASeg title="Per wave" hint="Clips of each market sent at the same time." value={d.inFlight} onChange={(v) => set({ inFlight: v })} options={[[1, '1'], [2, '2'], [5, '5'], [10, '10'], [20, '20']]} />
              <AField title="Between waves" hint="Pause between waves, so the book can refill." value={d.waveSec} onChange={(v) => set({ waveSec: v })} unit="s" err={err('waveMs')} />
            </>
          )}
          {slip('Worst price each order accepts, past the best price.')}
        </Group>
      )}

      {ek === 'pov' && (
        <>
          <Group label="Speed" sec="slicing">
            <ASeg title="Speed" hint="A preset share of the market’s volume; or type your own below." value={povPreset(d.rate)} onChange={(v) => v !== 'custom' && set(setPovPreset(v))} options={[...POV_OPTS.filter(([v]) => v !== 'custom'), ...(povPreset(d.rate) === 'custom' ? [['custom', 'Custom', `${d.rate || '…'}% of volume`] as const] : [])]} />
            <AField
              title="Share of volume"
              hint={`Of what everyone else trades, while they trade it. Low is ${POV_PRESETS.low}%, Medium ${POV_PRESETS.medium}%, High ${POV_PRESETS.high}%.`}
              value={d.rate}
              onChange={(v) => set({ rate: v })}
              unit="%"
              err={err('rate')}
            />
            <QtyField title="Largest child" hint="No single order bigger than this. Empty: any size." value={d.maxChild} placeholder="any" onChange={(v) => set({ maxChild: v })} err={err('maxChildQty')} />
            <AField title="Stop after" hint="Ends the algo after this long, filled or not. Empty: runs until filled." value={d.endIn} placeholder="when filled" onChange={(v) => set({ endIn: v })} unit={<ATime label="Stop after" value={d.endUnit} units={['m', 'h', 'd']} onChange={(u) => set({ endUnit: u })} />} err={err('endAt')} />
          </Group>
          <ExecGroup d={d} set={set} jitter="none" cap={false} err={err} />
        </>
      )}

      {ek === 'iceberg' && (
        <>
          <Group label="Clips" sec="slicing">
            {sizeVaries('displayJitter', "Each visible clip's size moves up to this much either way.")}
            {d.icePeg && <AField title="Offset" hint="Ticks behind the best price; a negative number steps inside the spread." value={d.offsetTicks} int signed onChange={(v) => set({ offsetTicks: v })} unit="ticks" err={err('pegOffsetTicks')} />}
            <AField title="Refill after" hint="Wait between one clip filling and the next one appearing." value={d.refill} onChange={(v) => set({ refill: v })} unit="s" err={err('refillMs')} />
          </Group>
          <Group label="Execution">
            <PostOnly d={d} set={set} />
          </Group>
        </>
      )}

      {ek === 'chase' && (
        <>
          <Group label="Resting">
            <ASeg
              title="Rest"
              hint="Where the order sits while it follows the price."
              value={d.offsetMode}
              onChange={(v) => set({ offsetMode: v })}
              options={[['ticks', 'At the best price', 'Joins the best price, or a few ticks from it.'], ['bps', 'Behind it', 'Sits a set distance, in bp, behind the best price.']]}
            />
            {d.offsetMode === 'ticks' ? (
              <AField title="Offset" hint="0 joins the best price; -1 steps one tick inside the spread." value={d.offsetTicks} int signed onChange={(v) => set({ offsetTicks: v })} unit="ticks" err={err('offsetTicks')} />
            ) : (
              <AField title="Behind" hint="How far behind the best price it rests." value={d.offsetBps} onChange={(v) => set({ offsetBps: v })} unit="bp" err={err('offsetBps')} />
            )}
            <AField title="Re-price after" hint="It moves once the best price is this far away." value={d.chaseTicks} int onChange={(v) => set({ chaseTicks: v })} unit="ticks" err={err('chaseTicks')} />
          </Group>
          <Group label="Giving up">
            <AField title="Give up after" hint="Stops chasing after this long. Empty: never." value={d.timeout} placeholder="never" onChange={(v) => set({ timeout: v })} unit={<ATime label="Give up after" value={d.timeoutUnit} units={['s', 'm', 'h']} onChange={(u) => set({ timeoutUnit: u })} />} err={err('timeoutMs')} />
            {opt(d.timeout) && (
              <ASeg
                title="Then"
                hint="What happens to what is left when it gives up."
                value={d.onEnd}
                onChange={(v) => set({ onEnd: v })}
                options={[['take', 'Take the rest', 'Takes what is left at once.'], ['cancel', 'Cancel', 'Cancels what is left.'], ['rest', 'Leave it', 'Leaves the order resting where it is.']]}
              />
            )}
          </Group>
        </>
      )}

      {ek === 'scale' && (
        <>
          <Group label="Ladder" sec="slicing">
            {mid && (
              <Row title="Range" hint="Sets From and To this far from the current price, in one tap.">
                <div className="algo-ctl">
                  <div className="algo-sseg" aria-label="Range from the price">
                    {[0.5, 1, 2, 5, 10].map((x) => (
                      <button
                        key={x}
                        type="button"
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
              </Row>
            )}
            {(scaleSize(d) === 'increasing' || scaleSize(d) === 'decreasing') && (
              <>
                <ASeg
                  title="Size curve"
                  hint="How the order sizes grow along the ladder."
                  value={d.distribution === 'exponential' ? 'exponential' : 'linear'}
                  onChange={(v) => set({ distribution: v })}
                  options={[['linear', 'Linear', 'Each order the same step bigger.'], ['exponential', 'Exponential', 'Each order the same factor bigger.']]}
                />
                <AField title="Skew" hint="The last order's size over the first's: above 1 increasing, below 1 decreasing." value={d.skew} onChange={(v) => set({ skew: v })} unit="×" err={err('skew')} />
              </>
            )}
            <ASeg
              title="Spacing"
              hint="How the prices are spread between From and To."
              value={d.spacing}
              onChange={(v) => set({ spacing: v })}
              options={[['linear', 'Even', 'The same price gap between orders.'], ['geometric', 'Even in %', 'The same percentage gap between orders.'], ['front', 'Front', 'Denser near From.'], ['back', 'Back', 'Denser near To.']]}
            />
            {sizeVaries('scaleJitter', "Randomises each order's size; the total stays the same.")}
          </Group>
          <Group label="Execution">
            <PostOnly d={d} set={set} />
          </Group>
        </>
      )}

      {ek === 'dca' && (
        <Group label="Ladder" sec="slicing">
          <ASeg
            title="Prices"
            hint={`Where the orders after the first rest. Always at set prices: a DCA here never buys on a clock.`}
            value={d.dcaLevels}
            onChange={(v) => set({ dcaLevels: v })}
            options={[['step', 'Step apart', `Every Step % ${fromAvg} the one before, as DCA bots space their safety orders.`], ['list', 'Prices I type', 'Exactly the prices you type on the ticket, in order.']]}
          />
          {d.dcaLevels === 'step' && (
            <AField
              title="Step scale"
              hint={`Each gap is this many times the one before (3Commas' safety order step scale): 1 keeps every step at ${d.dcaStep || '…'}%, 1.5 makes them 2%, 3%, 4.5%… so the ladder reaches further.`}
              value={d.dcaStepScale}
              onChange={(v) => set({ dcaStepScale: v })}
              unit="×"
              err={err('prices')}
            />
          )}
        </Group>
      )}

      {ek === 'swarm' && (
        <>
          <Group label="Waves" sec="slicing">
            <ASeg title="Per wave" hint="Clips sent at the same time." value={d.inFlight} onChange={(v) => set({ inFlight: v })} options={[[1, '1'], [2, '2'], [5, '5'], [10, '10'], [20, '20']]} />
            <AField title="Between waves" hint="Pause between waves, so the book can refill." value={d.waveSec} onChange={(v) => set({ waveSec: v })} unit="s" err={err('waveMs')} />
            <AField title="Retries" hint="What did not fill is sent again this many times." value={d.retries} int onChange={(v) => set({ retries: v })} err={err('retries')} />
            {sizeVaries('sizeJitter', 'Clips of uneven size, so they read less like one order.')}
          </Group>
          <Group label="Execution">{slip('Worst price each clip accepts, past the best price.')}</Group>
        </>
      )}

      {ek === 'trailing' && (
        <Group label="Stop">
          <ASeg title="Size" hint="How much it closes when it is hit." value={d.trailWhole ? 'pos' : 'amt'} onChange={(v) => set({ trailWhole: v === 'pos' })} options={[['pos', 'Whole position', 'Everything you hold on this market.'], ['amt', 'The amount', "Only the ticket's Amount."]]} />
          <ASeg title="Price" hint="The price it trails." value={d.source} onChange={(v) => set({ source: v })} options={[['mark', 'Mark', 'The mark price: harder to set off with a wick.'], ['last', 'Last', 'The last trade.']]} />
          <ASeg title="Exit" hint="How it closes once hit." value={d.exit} onChange={(v) => set({ exit: v })} options={[['market', 'Market', 'Takes at once.'], ['chase', 'Chase', 'Rests at the best price first, then takes.']]} />
          {d.exit === 'chase' ? (
            <AField title="Chase for" hint="How long it rests before it takes what is left." value={d.chaseSec} onChange={(v) => set({ chaseSec: v })} unit="s" err={err('chaseMs')} />
          ) : (
            slip('Worst price the exit accepts, past the best price.')
          )}
        </Group>
      )}

      {ek === 'sweep' && (
        <>
          <Group label="Rounds">
            <AField title="Between rounds" hint="The wait after a round that left something unfilled, before the next one re-prices from the reference." value={d.sweepRound} onChange={(v) => set({ sweepRound: v })} unit="s" err={err('roundMs')} />
            <AField title="Give up after" hint="Stops trying after this long; what filled stays filled. Empty: never." value={d.sweepGiveUp} placeholder="never" onChange={(v) => set({ sweepGiveUp: v })} unit="min" err={err('timeoutMs')} />
          </Group>
          <Group label="Reference price">
            <ASeg
              title="Price it is held to"
              hint="Every round's limit is this price plus your max slippage (a sell: minus)."
              value={d.sweepRef}
              onChange={(v) => set({ sweepRef: v })}
              options={[
                ['oracleMid', 'Oracle mid', 'The median of the chosen venues\u2019 mids (best bid and ask), read once a second by our server.'],
                ['oracleFair', 'Oracle fair', 'The median of the chosen venues\u2019 fair prices: each perpetual venue\u2019s own mark price, a spot venue\u2019s mid. A thin book\u2019s spread or one venue\u2019s wick cannot move it.'],
                ['mark', 'SoDEX mark', 'SoDEX\u2019s own mark price.'],
                ['index', 'SoDEX index', 'SoDEX\u2019s index price (its spot reference).'],
              ]}
            />
          </Group>
          {(d.sweepRef === 'oracleMid' || d.sweepRef === 'oracleFair') && (
            <InSec sec="exec">
              <VenuePicker value={d.sweepVenues} onChange={(v) => set({ sweepVenues: v })} live={oracleLive} err={err('venues')} />
            </InSec>
          )}
        </>
      )}

      {ek === 'conditional' && <ConditionalMore d={d} set={set} slip={slip} err={err} />}

      {exitsHere && kind !== 'bracket' && <AExits d={d} set={set} side={side} levels={exits} err={err('exits')} />}

      <Group label="Start and limits" sec="start">
        {hasLimit(kind) && (
          <AField title="Limit" hint={`Never ${side === 'buy' ? 'buys above' : 'sells below'} this price. Empty: none.`} value={d.limitPrice} placeholder="none" onChange={(v) => set({ limitPrice: v })} unit="USD" err={err('limitPrice')} />
        )}
        <ASeg
          title="Start"
          hint="When it begins."
          value={d.startMode}
          onChange={(v) => set({ startMode: v })}
          options={[['now', 'Now', 'As soon as you start it.'], ['delay', 'Later', 'After a delay you set.'], ['price', 'At a price', 'Once the mark reaches a price.']]}
        />
        {d.startMode === 'delay' && <AField title="Start in" hint="How long after you start it." value={d.startDelay} onChange={(v) => set({ startDelay: v })} unit="min" err={err('startAt')} />}
        {d.startMode === 'price' && <AField title="When the mark reaches" hint="Starts once the mark reaches this, from wherever it is now." value={d.startPrice} onChange={(v) => set({ startPrice: v })} unit="USD" err={err('triggerPrice')} />}
        {hasBounds(kind) && (
          <>
            <ABound title="Above" hint="What it does while the price is above this. Empty: nothing." value={d.upper} onValue={(v) => set({ upper: v })} then={d.upperThen} onThen={(v) => set({ upperThen: v })} err={err('upper')} />
            <ABound title="Below" hint="What it does while the price is below this. Empty: nothing." value={d.lower} onValue={(v) => set({ lower: v })} then={d.lowerThen} onThen={(v) => set({ lowerThen: v })} err={err('lower')} />
            <SlipField title="Max spread" stored="bp" hint="Takes nothing while the spread is wider than this. Empty: any." value={d.maxSpread} placeholder="any" onChange={(v) => set({ maxSpread: v })} err={err('maxSpreadBps')} />
          </>
        )}
      </Group>
    </>
  );
}

const BOUND_OPTS: ReadonlyArray<Opt<BoundAction>> = [
  ['hold', 'Hold', 'Pauses while the price is past it.'],
  ['stop', 'Stop', 'Ends the algo.'],
  ['rush', 'Rush', 'Takes everything that is left at once.'],
];

/** A price bound: the price, then what it does past it. */
function ABound({ title, hint, value, onValue, then, onThen, err }: {
  title: string; hint: string; value: string; onValue: (v: string) => void; then: BoundAction; onThen: (v: BoundAction) => void; err?: string;
}) {
  const id = useId();
  return (
    <Row title={title} hint={hint} id={id}>
      <div className="algo-ctl">
        <div className={`algo-sf${err ? ' is-bad' : ''}`}>
          <input id={id} autoComplete="off" inputMode="decimal" value={toInputText(value)} placeholder="none" aria-invalid={err ? true : undefined} onChange={(e) => onValue(decimalInput(e.target.value, { prev: value }))} />
          <span className="algo-sf__unit">USD</span>
        </div>
        {err && <p className="oe-hint algo-ferr">{err}</p>}
        {opt(value) !== null && <SSeg label={`${title}: then`} value={then} options={BOUND_OPTS} onChange={onThen} />}
      </div>
    </Row>
  );
}

function hasJitter(kind: UiKind, d: Draft): boolean {
  const ek = engineKind(kind);
  return ((ek === 'twap' || ek === 'vwap' || ek === 'swarm') && (frac(d.sizeJitter) > 0 || frac(d.timeJitter) > 0)) || (ek === 'scale' && frac(d.scaleJitter) > 0);
}

/** How the slices meet the book (TWAP, VWAP, POV): only what the kind's spec uses. */
function ExecGroup({ d, set, chaseOnly = false, jitter, cap, err }: {
  d: Draft; set: (p: Partial<Draft>) => void; chaseOnly?: boolean; jitter: 'both' | 'size' | 'none'; cap: boolean; err: (...keys: string[]) => string | undefined;
}) {
  const style = chaseOnly && d.exec === 'taker' ? 'hybrid' : d.exec;
  const opts: ReadonlyArray<Opt<'taker' | 'maker' | 'hybrid'>> = chaseOnly
    ? [['hybrid', 'Rest, then take', 'Each slice rests at the best price; what falls behind is taken.'], ['maker', 'Maker only', 'Never takes: what does not fill keeps resting.']]
    : [['taker', 'Taker', 'Each slice takes at once.'], ['hybrid', 'Hybrid', 'Each slice rests first, then takes what falls behind.'], ['maker', 'Maker', 'Post-only, re-priced as the book moves.']];
  return (
    <Group label="Price and execution">
      <ASeg title="Each slice" hint="How each child order meets the book." value={style} onChange={(v) => set({ exec: v })} options={opts} />
      {style !== 'maker' && (
        <ASeg
          title="Slippage from"
          hint="The price your max slippage is measured from. A taking child is limited at it plus the slippage (a sell: minus); with that price not fresh, the slice waits."
          value={d.slipFrom}
          onChange={(v) => set({ slipFrom: v })}
          options={[
            ['touch', 'Best price', 'SoDEX\u2019s best ask (a sell: bid) when the child goes out.'],
            ['mid', 'Mid', 'SoDEX\u2019s mid: halfway between its best bid and ask.'],
            ['mark', 'Mark', 'SoDEX\u2019s mark price.'],
            ['index', 'Index', 'SoDEX\u2019s index (its spot reference).'],
            ['oracleMid', 'Oracle mid', 'The median mid of every oracle venue, read by our server.'],
            ['oracleFair', 'Oracle fair', 'The median fair price of every oracle venue (perpetuals\u2019 marks).'],
          ]}
        />
      )}
      {style !== 'maker' && <SlipField title="Max slippage" stored="bp" hint={`Worst price a taking child accepts, past the ${d.slipFrom === 'touch' ? 'best price' : SLIP_FROM_NAMES[d.slipFrom].toLowerCase()}.`} value={d.slip} onChange={(v) => set({ slip: v })} err={err('exec.slippageBps')} />}
      {style === 'hybrid' && <AField title="Rest for" hint="Share of each slice's time spent resting before what is left is taken." value={d.makerShare} onChange={(v) => set({ makerShare: v })} unit="% of slice" err={err('exec.makerShare')} />}
      {style !== 'taker' && <AField title="Re-price after" hint="A resting child moves once the best price is this far away." value={d.chaseTicks} int onChange={(v) => set({ chaseTicks: v })} unit="ticks" err={err('exec.chaseTicks')} />}
      {jitter !== 'none' && <AField title="Size varies" hint="Randomises each slice's size; the total stays the same." value={d.sizeJitter} onChange={(v) => set({ sizeJitter: v })} unit="± %" err={err('sizeJitter')} />}
      {jitter === 'both' && <AField title="Time varies" hint="Randomises each slice's time, as a share of the gap between slices." value={d.timeJitter} onChange={(v) => set({ timeJitter: v })} unit="± %" err={err('timeJitter')} />}
      {cap && <AField title="Max of volume" hint="A slice takes at most this share of the volume printed since the last one. Empty: no cap." value={d.maxPart} placeholder="off" onChange={(v) => set({ maxPart: v })} unit="%" err={err('maxParticipation')} />}
      <ASeg title="At the end" hint="What happens to anything not filled when the time is up." value={d.finish} onChange={(v) => set({ finish: v })} options={[['take', 'Take the rest', 'Takes what is left at once.'], ['leave', 'Leave it', 'Stops; what is left is not traded.']]} />
    </Group>
  );
}

/** The pop-up's exits: SoDEX position stops after the fills (see ExitFields). */
function AExits({ d, set, side, levels, err }: { d: Draft; set: (p: Partial<Draft>) => void; side: 'buy' | 'sell'; levels: { tp: number | null; sl: number | null } | null; err?: string }) {
  const unit = (label: string, mode: 'pct' | 'price', key: 'tpMode' | 'slMode') => (
    <APick label={label} value={mode} options={[['pct', '%'], ['price', 'USD']]} onChange={(v) => set({ [key]: v } as Partial<Draft>)} />
  );
  const at = (x: number | null | undefined) => (x ? ` Now ${fmtLevel(x)}.` : '');
  return (
    <Group label="Exits" sec="exits">
      <ASwitch
        title="Take-profit / stop-loss"
        hint="SoDEX holds them as position stops, resized as the algo fills; when one fills, the other is cancelled."
        checked={d.exitsOn}
        onChange={(v) => set({ exitsOn: v })}
        on="On · exits after the fills"
        off="Off · no exits"
      />
      {d.exitsOn && (
        <>
          <AField title="Take-profit" hint={`${side === 'buy' ? 'Above' : 'Below'} your average fill, as a distance or a price. Empty: none.${at(levels?.tp)}`} value={d.tp} placeholder="none" onChange={(v) => set({ tp: v })} unit={unit('Take-profit', d.tpMode, 'tpMode')} />
          <AField title="Stop-loss" hint={`${side === 'buy' ? 'Below' : 'Above'} your average fill, as a distance or a price. Empty: none.${at(levels?.sl)}`} value={d.sl} placeholder="none" onChange={(v) => set({ sl: v })} unit={unit('Stop-loss', d.slMode, 'slMode')} err={err} />
        </>
      )}
    </Group>
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
            <MarketSelect value={l.symbol} onChange={(v) => edit(i, { symbol: v })} label={`Market ${i + 1}`} />
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
              {i > 0 && <span className="algo-cond__join">{d.match === 'any' ? 'or' : 'and'}</span>}
              <MiniSelect label="Condition" value={c.type} options={COND_TYPES} onChange={(v) => edit(i, { type: v })} />
              {c.type !== 'time' && <MarketSelect value={c.symbol} onChange={(v) => edit(i, { symbol: v })} compact />}
              <button type="button" className="algo-x" aria-label="Remove this condition" onClick={() => set({ conds: d.conds.filter((_, j) => j !== i) })}>×</button>
            </div>
            <CondBody c={c} edit={(patch) => edit(i, patch)} />
          </li>
        ))}
      </ol>
      {d.conds.length < 5 && (
        <button type="button" className="algo-addcond" onClick={() => set({ conds: [...d.conds, cond(symbol)] })}>
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          {d.conds.length ? 'Add another condition' : 'Add a condition'}
        </button>
      )}
      <Seg label="Then" value={d.then} onChange={(v) => set({ then: v })} options={[['market', 'Market'], ['limit', 'Limit'], ['close', 'Close'], ['twap', 'TWAP'], ['chase', 'Chase']]} />
      {d.then === 'limit' && <Field label="Price" value={d.thenPrice} onChange={(v) => set({ thenPrice: v })} suffix="USD" />}
      {d.then === 'close' && <Field label="Close" value={d.closePct} onChange={(v) => set({ closePct: v })} suffix={base ? `% of ${base}` : '%'} />}
      {d.then === 'twap' && <Field label="Over" value={d.thenMin} onChange={(v) => set({ thenMin: v })} suffix="min" />}
    </>
  );
}

/** A conditional order's advanced settings: when it fires, then how its action trades. */
function ConditionalMore({ d, set, slip, err }: { d: Draft; set: (p: Partial<Draft>) => void; slip: (hint: string) => ReactNode; err: (...keys: string[]) => string | undefined }) {
  const then =
    d.then === 'market' || d.then === 'close' ? slip('Worst price the action accepts, past the best price.')
    : d.then === 'limit' ? <PostOnly d={d} set={set} />
    : d.then === 'twap' ? <AField title="Slices" hint="How many child orders the TWAP it starts sends." value={d.thenSlices} int onChange={(v) => set({ thenSlices: v })} err={err('then')} />
    : null;
  return (
    <>
      <Group label="Trigger">
        {d.conds.length > 1 && <ASeg title="When" hint="Whether every condition must hold, or one is enough." value={d.match} onChange={(v) => set({ match: v })} options={[['all', 'All hold'], ['any', 'Any holds']]} />}
        <AField title="Hold for" hint="Acts only once the conditions have held this long, so a wick does not set it off." value={d.holdSec} onChange={(v) => set({ holdSec: v })} unit="s" err={err('holdMs')} />
        <AField title="Expires in" hint="Cancels it if nothing fired by then. Empty: never." value={d.expires} placeholder="never" onChange={(v) => set({ expires: v })} unit={<ATime label="Expires in" value={d.expiresUnit} units={['m', 'h', 'd']} onChange={(u) => set({ expiresUnit: u })} />} err={err('expiresAt')} />
      </Group>
      {then && <Group label="Then">{then}</Group>}
    </>
  );
}

/** A price source and a comparison in one short choice: "Mark ≥". */
const SRC_OP: ReadonlyArray<readonly [string, string]> = (['mark', 'last', 'mid'] as const).flatMap((s) =>
  (['above', 'below'] as const).map((o) => [`${s}|${o}`, `${s[0]!.toUpperCase()}${s.slice(1)} ${o === 'above' ? '≥' : '≤'}`] as const),
);
const SRC_CROSS: ReadonlyArray<readonly [string, string]> = (['mark', 'last', 'mid'] as const).flatMap((s) =>
  (['up', 'down'] as const).map((o) => [`${s}|${o}`, `${s[0]!.toUpperCase()}${s.slice(1)} ${o === 'up' ? 'up through' : 'down through'}`] as const),
);
const OPS: ReadonlyArray<readonly [CondDraft['op'], string]> = [['above', '≥'], ['below', '≤']];
const DIRS: ReadonlyArray<readonly [CondDraft['dir'], string]> = [['up', 'Up'], ['down', 'Down'], ['either', 'Either way']];

function CondBody({ c, edit }: { c: CondDraft; edit: (p: Partial<CondDraft>) => void }) {
  const op = <MiniSelect label="Comparison" value={c.op} options={OPS} onChange={(v) => edit({ op: v })} />;
  const dir = <MiniSelect label="Direction" value={c.dir} options={DIRS} onChange={(v) => edit({ dir: v })} />;
  const line = (lead: ReactNode, field: ReactNode) => <div className="algo-cond__line">{lead}{field}</div>;
  switch (c.type) {
    case 'price':
      return line(
        <MiniSelect label="Price and comparison" value={`${c.source}|${c.op}`} options={SRC_OP} onChange={(v) => { const [s, o] = v.split('|'); edit({ source: s as CondDraft['source'], op: o as CondDraft['op'] }); }} />,
        <Field label="Price" value={c.value} onChange={(v) => edit({ value: v })} suffix="USD" />,
      );
    case 'cross':
      return line(
        <MiniSelect label="Price and direction" value={`${c.source}|${c.dir === 'down' ? 'down' : 'up'}`} options={SRC_CROSS} onChange={(v) => { const [s, o] = v.split('|'); edit({ source: s as CondDraft['source'], dir: o as CondDraft['dir'] }); }} />,
        <Field label="Price" value={c.value} onChange={(v) => edit({ value: v })} suffix="USD" />,
      );
    case 'move':
    case 'oi':
      return (
        <div className="algo-cond__body">
          {line(dir, <Field label="By" value={c.pct} onChange={(v) => edit({ pct: v })} suffix="%" />)}
          <Field label="Within" value={c.windowMin} onChange={(v) => edit({ windowMin: v })} suffix="min" />
        </div>
      );
    case 'funding':
      return line(op, <Field label="Rate" value={c.pct} onChange={(v) => edit({ pct: v })} suffix="%" title="Per funding period, as SoDEX publishes it" />);
    case 'spread':
      return line(op, <Field label="Spread" value={c.bps} onChange={(v) => edit({ bps: v })} suffix="bp" />);
    case 'volume':
      return (
        <div className="algo-cond__body">
          <Field label="Trades" value={c.usd} onChange={(v) => edit({ usd: v })} suffix="USD" />
          <Field label="Within" value={c.windowMin} onChange={(v) => edit({ windowMin: v })} suffix="min" />
        </div>
      );
    case 'ratio':
      return (
        <div className="algo-cond__body">
          <div className="algo-cond__line"><span className="algo-cond__word">divided by</span><MarketSelect value={c.other} onChange={(v) => edit({ other: v })} label="Divided by" compact /></div>
          {line(op, <Field label="Ratio" value={c.value} onChange={(v) => edit({ value: v })} />)}
        </div>
      );
    case 'position':
      return (
        <div className="algo-cond__body">
          <MiniSelect label="Your position" value={c.pos} options={POS_OPS} onChange={(v) => edit({ pos: v })} />
          {(c.pos === 'sizeAbove' || c.pos === 'sizeBelow') && <Field label="Size" value={c.value} onChange={(v) => edit({ value: v })} title="Your position's size in the base coin, long or short" />}
          {(c.pos === 'pnlAbove' || c.pos === 'pnlBelow') && <Field label="PnL" value={c.value} signed onChange={(v) => edit({ value: v })} suffix="USD" title="Unrealised, at the mark (a loss is negative)" />}
        </div>
      );
    case 'time':
      return <Field label="In" value={c.inMin} onChange={(v) => edit({ inMin: v })} suffix="min" />;
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
function planFacts(plan: AlgoPlan, ek: AlgoKind): string {
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
  const x = (s: string) => (s.trim() === '' ? '…' : toInputText(s));
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
      const first = d.dcaFirst === 'market' ? 'now' : `at ${x(d.dcaStart)}`;
      const m = d.dcaSizing === 'geometric' ? `, each ${x(d.dcaMult)}× the last` : d.dcaSizing === 'weighted' ? `, sized by your curve (${curveSpan(d.dcaCurve)})` : ', all the same size';
      const each = d.dcaUnit === 'coin' ? `${x(d.perOrder)} ${base}` : `$${x(d.perOrder)}`;
      if (d.dcaLevels === 'list') return `${verb} ${each} ${first}, then at ${x(d.dcaPrices)}${m}`;
      const sc = n(d.dcaStepScale) > 0 && n(d.dcaStepScale) !== 1 ? ` (each step ${x(d.dcaStepScale)}× the last)` : '';
      return `${verb} ${each} ${first}, then every ${x(d.dcaStep)}% ${side === 'buy' ? 'lower' : 'higher'}${sc}, ${x(d.dcaOrders)} orders in all${m}`;
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
    case 'sweep':
      return `${verb} ${q} as fast as the book allows, within ${x(d.sweepSlip)}% of the ${SWEEP_REFERENCE_NAMES[d.sweepRef].replace(/^Oracle/, 'oracle').replace(/^SoDEX/, 'SoDEX')}`;
    case 'bracket':
      return `${side === 'buy' ? 'Goes long' : 'Goes short'} ${q} ${d.entry === 'limit' ? `at ${x(d.entryPrice)}` : 'at market'}, with take-profit and stop-loss`;
    case 'basket': {
      const total = d.legs.reduce((a, l) => a + (Number(l.usd) || 0), 0);
      return `Trades ${d.legs.length || '…'} markets ${d.basketStyle === 'twap' ? `over ${over}` : 'at once'}${total > 0 ? `, ${fmtUsd(total, 0)} in all` : ''}`;
    }
  }
}

// Size, orders and fees stand in the Summary's numbers above it.
function Review({ spec, plan, kind, place, location }: { spec: AlgoSpec; plan: AlgoPlan; kind: UiKind; feeRates: Rates; place: Place; location: string | null }) {
  const rows: Array<[string, string]> = [
    ['Order', spec.kind === 'basket' ? `${menuName(kind)} of ${spec.legs.length} markets, ${fmtUsd(plan.notional ?? 0, 2)} in all` : `${menuName(kind)} ${spec.side === 'buy' ? 'buy / long' : 'sell / short'} on ${spec.symbol}`],
  ];
  if (spec.kind === 'dca') rows.push(['Spend', `${spec.orders} × ${fmtUsd(spec.perOrderUsd, 2)}${spec.maxTotalUsd ? `, at most ${fmtUsd(spec.maxTotalUsd, 2)}` : ''}`]);
  if (spec.kind === 'sweep') rows.push(['Reference', `${sweepRefWords(spec)}, at most ${fmtFixed(spec.slippageBps / 100, 2)}% from it`]);
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
        <p key={w} className={`oe-hint ${redWarnings(plan).has(w) ? 'algo-err' : 'algo-warn'}`}>{w}</p>
      ))}
      {(plan.notes ?? []).map((n) => (
        <p key={n} className="oe-hint algo-note">{n}</p>
      ))}
    </div>
  );
}

/**
 * The algo half of the order ticket: the settings of one algo order type,
 * a preview drawn from the engine's own plan, and the start.
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
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
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
import { notify } from '../../toast';
import { useConfirm } from '../Modal';
import { Collapse } from '../motion';
import { decimalInput, integerInput } from '../numberInput';
import { LadderPreview, LevelsPreview, TimelinePreview, type Level } from './AlgoPreview';
import { engineKind, fmtDuration, menuName, usesAmount, type UiKind } from './menu';
import './algo.css';

/* ------------------------------------------------------------------ draft ----- */

type Unit = 's' | 'm' | 'h' | 'd';
const UNIT_MS: Record<Unit, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const UNIT_NAME: Record<Unit, string> = { s: 's', m: 'min', h: 'h', d: 'd' };

interface CondDraft {
  type: ConditionType;
  symbol: string;
  source: 'mark' | 'last' | 'mid' | 'index';
  op: 'above' | 'below';
  dir: 'up' | 'down' | 'either';
  value: string;
  pct: string;
  windowMin: string;
  bps: string;
  usd: string;
  other: string;
  inMin: string;
  pos: 'long' | 'short' | 'flat' | 'sizeAbove' | 'sizeBelow' | 'pnlAbove' | 'pnlBelow';
}

interface LegDraft {
  symbol: string;
  side: 'buy' | 'sell';
  usd: string;
}

interface Draft {
  dur: string;
  durUnit: Unit;
  slices: string;
  exec: 'taker' | 'maker' | 'hybrid';
  slip: string;
  makerShare: string;
  offsetTicks: string;
  chaseTicks: string;
  sizeJitter: string;
  timeJitter: string;
  urgency: number;
  finish: 'take' | 'leave';
  maxPart: string;
  lookback: number;
  adaptive: boolean;
  rate: string;
  maxChild: string;
  endIn: string;
  endUnit: Unit;
  display: string;
  displayJitter: string;
  icePeg: boolean;
  icePrice: string;
  postOnly: boolean;
  refill: string;
  offsetMode: 'ticks' | 'bps';
  offsetBps: string;
  maxChase: string;
  timeout: string;
  timeoutUnit: Unit;
  onEnd: 'take' | 'cancel' | 'rest';
  from: string;
  to: string;
  orders: string;
  distribution: 'flat' | 'linear' | 'exponential' | 'bell';
  skew: string;
  spacing: 'linear' | 'geometric' | 'front' | 'back';
  scaleJitter: string;
  perOrder: string;
  dcaOrders: string;
  every: string;
  everyUnit: Unit;
  outOfBand: 'skip' | 'wait';
  dip: string;
  dipMult: string;
  budget: string;
  clips: string;
  inFlight: number;
  waveSec: string;
  retries: string;
  match: 'all' | 'any';
  conds: CondDraft[];
  holdSec: string;
  expires: string;
  expiresUnit: Unit;
  then: 'market' | 'limit' | 'close' | 'twap' | 'chase';
  thenPrice: string;
  closePct: string;
  thenMin: string;
  thenSlices: string;
  trailMode: 'pct' | 'abs';
  trail: string;
  activation: string;
  trailWhole: boolean;
  source: 'mark' | 'last';
  exit: 'market' | 'chase';
  chaseSec: string;
  limitPrice: string;
  startMode: 'now' | 'delay' | 'price';
  startDelay: string;
  startPrice: string;
  upper: string;
  upperThen: BoundAction;
  lower: string;
  lowerThen: BoundAction;
  maxSpread: string;
  paper: boolean;
  /** Where it runs: this browser, ValueDesk's executor (Tokyo, 24/7), or the trader's own. */
  place: 'browser' | 'hosted' | 'self';
  /** TWAP: a time-sliced close of this share of the position, instead of an amount. */
  twapClose: boolean;
  twapCloseShare: string;
  minSlice: string;
  maxSlice: string;
  /** Exits after the fills: a take-profit and a stop-loss, each a distance (%) or a price. */
  exitsOn: boolean;
  tpMode: 'pct' | 'price';
  tp: string;
  slMode: 'pct' | 'price';
  sl: string;
  /** Basket. */
  legs: LegDraft[];
  basketStyle: 'swarm' | 'twap';
  /** Bracket. */
  entry: 'market' | 'limit';
  entryPrice: string;
}

const cond = (symbol: string, over: Partial<CondDraft> = {}): CondDraft => ({
  type: 'price', symbol, source: 'mark', op: 'below', dir: 'either', value: '', pct: '1', windowMin: '5', bps: '10', usd: '1000000', other: 'BTC-USD', inMin: '60', pos: 'flat', ...over,
});

const legs = (symbol: string, side: 'buy' | 'sell'): LegDraft[] => [
  { symbol, side, usd: '100' },
  { symbol: symbol === 'ETH-USD' ? 'BTC-USD' : 'ETH-USD', side: side === 'buy' ? 'sell' : 'buy', usd: '100' },
];

const DEFAULT: Draft = {
  dur: '30', durUnit: 'm', slices: '30', exec: 'hybrid', slip: '30', makerShare: '60', offsetTicks: '0', chaseTicks: '2', sizeJitter: '15', timeJitter: '20', urgency: 0,
  finish: 'take', maxPart: '', lookback: 14, adaptive: true, rate: '10', maxChild: '', endIn: '', endUnit: 'h',
  display: '', displayJitter: '20', icePeg: true, icePrice: '', postOnly: true, refill: '0',
  offsetMode: 'ticks', offsetBps: '10', maxChase: '', timeout: '', timeoutUnit: 'm', onEnd: 'take',
  from: '', to: '', orders: '10', distribution: 'flat', skew: '1', spacing: 'linear', scaleJitter: '0',
  perOrder: '50', dcaOrders: '10', every: '1', everyUnit: 'h', outOfBand: 'skip', dip: '', dipMult: '2', budget: '',
  clips: '10', inFlight: 2, waveSec: '3', retries: '2',
  match: 'all', conds: [], holdSec: '0', expires: '', expiresUnit: 'd', then: 'market', thenPrice: '', closePct: '100', thenMin: '15', thenSlices: '15',
  trailMode: 'pct', trail: '1', activation: '', trailWhole: true, source: 'mark', exit: 'market', chaseSec: '15',
  limitPrice: '', startMode: 'now', startDelay: '5', startPrice: '', upper: '', upperThen: 'hold', lower: '', lowerThen: 'hold', maxSpread: '',
  paper: false,
  place: 'browser',
  twapClose: false, twapCloseShare: '100', minSlice: '', maxSlice: '',
  exitsOn: false, tpMode: 'pct', tp: '2', slMode: 'pct', sl: '1',
  legs: [], basketStyle: 'swarm',
  entry: 'market', entryPrice: '',
};

const DRAFT_KEY = 'vs.algo.draft.v1';

function loadDraft(): Draft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) return { ...DEFAULT, ...(JSON.parse(raw) as Partial<Draft>), conds: [], legs: [] };
  } catch {
    /* storage blocked: defaults */
  }
  return { ...DEFAULT };
}

function saveDraft(d: Draft): void {
  try {
    const { conds: _c, from: _f, to: _t, icePrice: _i, limitPrice: _l, upper: _u, lower: _lo, startPrice: _s, thenPrice: _tp, activation: _a, legs: _lg, entryPrice: _ep, ...keep } = d;
    localStorage.setItem(DRAFT_KEY, JSON.stringify(keep));
  } catch {
    /* storage blocked */
  }
}

const n = (s: string): number => {
  const v = Number(s);
  return s.trim() !== '' && Number.isFinite(v) ? v : NaN;
};
const opt = (s: string): number | null => (Number.isFinite(n(s)) && n(s) > 0 ? n(s) : null);
const frac = (s: string): number => (Number.isFinite(n(s)) ? n(s) / 100 : 0);
/** A price level as the preview shows it (SoDEX snaps it to the tick when it is placed). */
const fmtLevel = (x: number): string => x.toLocaleString('en-US', { maximumFractionDigits: Math.abs(x) >= 1000 ? 1 : Math.abs(x) >= 1 ? 4 : 6 });

/* ------------------------------------------------------------ the spec ----- */

export interface TicketShared {
  symbol: string;
  side: 'buy' | 'sell';
  quantity: string;
  reduceOnly: boolean;
  leverage: number | null;
  marginMode: 'cross' | 'isolated';
}

/** Whether the ticket offers exits for this kind: anything that opens a position (a bracket always has them). */
export function offersExits(kind: UiKind, d: Draft, reduceOnly: boolean): boolean {
  if (reduceOnly || kind === 'trailing' || kind === 'basket') return false;
  if (kind === 'twap' && d.twapClose) return false;
  if (kind === 'conditional') return d.then !== 'close';
  return true;
}

function exitsOf(d: Draft): Record<string, number | null> {
  return {
    tpPct: d.tpMode === 'pct' && opt(d.tp) ? frac(d.tp) : null,
    tpPrice: d.tpMode === 'price' ? opt(d.tp) : null,
    slPct: d.slMode === 'pct' && opt(d.sl) ? frac(d.sl) : null,
    slPrice: d.slMode === 'price' ? opt(d.sl) : null,
  };
}

/** The draft as an engine spec (unvalidated: checkAlgoSpec decides). */
export function draftToSpec(kind: UiKind, d: Draft, p: TicketShared, now: number): Record<string, unknown> {
  const k = engineKind(kind);
  const withExits = offersExits(kind, d, p.reduceOnly) && (kind === 'bracket' || d.exitsOn);
  const base: Record<string, unknown> = {
    kind: k,
    symbol: p.symbol,
    side: p.side,
    reduceOnly: p.reduceOnly,
    limitPrice: opt(d.limitPrice),
    upper: opt(d.upper) ? { price: opt(d.upper), then: d.upperThen } : null,
    lower: opt(d.lower) ? { price: opt(d.lower), then: d.lowerThen } : null,
    triggerPrice: d.startMode === 'price' ? opt(d.startPrice) : null,
    startAt: d.startMode === 'delay' && opt(d.startDelay) ? now + n(d.startDelay) * 60_000 : null,
    maxSpreadBps: opt(d.maxSpread),
    leverage: p.reduceOnly ? null : p.leverage,
    marginMode: p.reduceOnly ? null : p.marginMode,
    paper: d.paper,
    label: null,
    exits: withExits ? exitsOf(d) : null,
  };
  const exec = {
    style: kind === 'chasetwap' && d.exec === 'taker' ? 'hybrid' : d.exec,
    slippageBps: n(d.slip),
    offsetTicks: Math.trunc(n(d.offsetTicks) || 0),
    chaseTicks: Math.max(1, Math.trunc(n(d.chaseTicks) || 1)),
    makerShare: frac(d.makerShare),
  };
  const dur = n(d.dur) * UNIT_MS[d.durUnit];
  switch (kind) {
    case 'twap':
    case 'chasetwap': {
      const close = kind === 'twap' && d.twapClose;
      return {
        ...base,
        quantity: close ? '0' : p.quantity,
        closeShare: close ? frac(d.twapCloseShare) : null,
        minSliceQty: opt(d.minSlice) ? d.minSlice : null,
        maxSliceQty: opt(d.maxSlice) ? d.maxSlice : null,
        durationMs: Math.round(dur),
        slices: Math.trunc(n(d.slices)),
        urgency: d.urgency,
        sizeJitter: frac(d.sizeJitter),
        timeJitter: frac(d.timeJitter),
        exec,
        finish: d.finish,
        maxParticipation: opt(d.maxPart) ? frac(d.maxPart) : null,
      };
    }
    case 'bracket':
      return { ...base, quantity: p.quantity, entry: d.entry, price: d.entry === 'limit' ? opt(d.entryPrice) : null, slippageBps: n(d.slip) };
    case 'basket':
      return {
        ...base,
        leverage: null,
        marginMode: null,
        legs: d.legs.map((l) => ({ symbol: l.symbol, side: l.side, usd: n(l.usd) })),
        style: d.basketStyle,
        durationMs: Math.round(dur),
        slices: Math.trunc(n(d.slices)),
        clips: Math.trunc(n(d.clips)),
        inFlight: d.inFlight,
        waveMs: Math.round((n(d.waveSec) || 0) * 1000),
        slippageBps: n(d.slip),
      };
    case 'vwap':
      return { ...base, quantity: p.quantity, durationMs: Math.round(dur), slices: Math.trunc(n(d.slices)), lookbackDays: d.lookback, adaptive: d.adaptive, sizeJitter: frac(d.sizeJitter), exec, finish: d.finish, maxParticipation: opt(d.maxPart) ? frac(d.maxPart) : null };
    case 'pov':
      return { ...base, quantity: p.quantity, rate: frac(d.rate), maxChildQty: opt(d.maxChild) ? d.maxChild : null, endAt: opt(d.endIn) ? now + n(d.endIn) * UNIT_MS[d.endUnit] : null, exec, finish: d.finish };
    case 'iceberg':
      return { ...base, quantity: p.quantity, displayQty: d.display, displayJitter: frac(d.displayJitter), price: d.icePeg ? null : opt(d.icePrice), pegOffsetTicks: Math.trunc(n(d.offsetTicks) || 0), chaseTicks: exec.chaseTicks, postOnly: d.postOnly, refillMs: Math.round((n(d.refill) || 0) * 1000), refillJitter: 0.5 };
    case 'chase':
      return { ...base, quantity: p.quantity, offsetTicks: Math.trunc(n(d.offsetTicks) || 0), offsetBps: d.offsetMode === 'bps' ? opt(d.offsetBps) : null, chaseTicks: exec.chaseTicks, maxChaseBps: opt(d.maxChase), timeoutMs: opt(d.timeout) ? n(d.timeout) * UNIT_MS[d.timeoutUnit] : null, onEnd: d.onEnd, minRepriceMs: 1_000 };
    case 'scale':
      return { ...base, quantity: p.quantity, from: opt(d.from), to: opt(d.to), orders: Math.trunc(n(d.orders)), distribution: d.distribution, skew: n(d.skew) || 1, spacing: d.spacing, sizeJitter: frac(d.scaleJitter), postOnly: d.postOnly };
    case 'dca':
      return { ...base, perOrderUsd: n(d.perOrder), orders: Math.trunc(n(d.dcaOrders)), intervalMs: Math.round(n(d.every) * UNIT_MS[d.everyUnit]), outOfBand: d.outOfBand, dipPct: opt(d.dip) ? frac(d.dip) : null, dipMultiplier: n(d.dipMult) || 1, maxTotalUsd: opt(d.budget), exec: { ...exec, style: d.exec === 'hybrid' ? 'hybrid' : d.exec } };
    case 'swarm':
      return { ...base, quantity: p.quantity, clips: Math.trunc(n(d.clips)), inFlight: d.inFlight, waveMs: Math.round((n(d.waveSec) || 0) * 1000), sizeJitter: frac(d.sizeJitter), slippageBps: n(d.slip), retries: Math.trunc(n(d.retries) || 0) };
    case 'trailing':
      return { ...base, reduceOnly: true, leverage: null, marginMode: null, quantity: d.trailWhole ? null : p.quantity, trailPct: d.trailMode === 'pct' ? frac(d.trail) : null, trailAbs: d.trailMode === 'abs' ? opt(d.trail) : null, activationPrice: opt(d.activation), source: d.source, exit: d.exit, chaseMs: Math.round((n(d.chaseSec) || 15) * 1000), slippageBps: n(d.slip) };
    case 'conditional': {
      const conditions = d.conds.map((c) => {
        switch (c.type) {
          case 'price':
            return { type: 'price', symbol: c.symbol, source: c.source, op: c.op, value: opt(c.value) };
          case 'cross':
            return { type: 'cross', symbol: c.symbol, source: c.source, dir: c.dir === 'down' ? 'down' : 'up', value: opt(c.value) };
          case 'move':
            return { type: 'move', symbol: c.symbol, source: c.source, dir: c.dir, pct: frac(c.pct), windowMs: Math.round(n(c.windowMin) * 60_000) };
          case 'funding':
            return { type: 'funding', symbol: c.symbol, op: c.op, value: frac(c.pct) };
          case 'oi':
            return { type: 'oi', symbol: c.symbol, dir: c.dir, pct: frac(c.pct), windowMs: Math.round(n(c.windowMin) * 60_000) };
          case 'spread':
            return { type: 'spread', symbol: c.symbol, op: c.op, bps: n(c.bps) };
          case 'volume':
            return { type: 'volume', symbol: c.symbol, windowMs: Math.round(n(c.windowMin) * 60_000), aboveUsd: n(c.usd) };
          case 'ratio':
            return { type: 'ratio', symbol: c.symbol, other: c.other, op: c.op, value: opt(c.value) };
          case 'position':
            return { type: 'position', symbol: c.symbol, op: c.pos, value: c.pos === 'long' || c.pos === 'short' || c.pos === 'flat' ? 0 : n(c.value) };
          case 'time':
            return { type: 'time', at: now + Math.max(0, n(c.inMin) || 0) * 60_000 };
        }
      });
      // An algo it starts carries the exits itself (they follow that algo's fills).
      const inner = { symbol: p.symbol, side: p.side, reduceOnly: p.reduceOnly, quantity: p.quantity, limitPrice: base.limitPrice, leverage: base.leverage, marginMode: base.marginMode, paper: d.paper, exits: base.exits };
      if (d.then === 'twap' || d.then === 'chase') base.exits = null;
      const then =
        d.then === 'market' ? { type: 'market', quantity: p.quantity, slippageBps: n(d.slip) }
        : d.then === 'limit' ? { type: 'limit', quantity: p.quantity, price: opt(d.thenPrice), postOnly: d.postOnly }
        : d.then === 'close' ? { type: 'close', share: frac(d.closePct), slippageBps: n(d.slip) }
        : d.then === 'twap' ? { type: 'algo', algo: { ...inner, kind: 'twap', durationMs: Math.round(n(d.thenMin) * 60_000), slices: Math.trunc(n(d.thenSlices)), exec, finish: 'take' } }
        : { type: 'algo', algo: { ...inner, kind: 'chase', offsetTicks: 0, chaseTicks: 1, onEnd: 'take' } };
      return { ...base, match: d.match, conditions, holdMs: Math.round((n(d.holdSec) || 0) * 1000), expiresAt: opt(d.expires) ? now + n(d.expires) * UNIT_MS[d.expiresUnit] : null, then };
    }
  }
}

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

/* ------------------------------------------------------------ controls ----- */

/** Whole numbers; a leading minus where the field allows one (an offset that steps inside the spread). */
const wholeInput = (raw: string, signed: boolean): string => {
  const neg = signed && raw.trim().startsWith('-');
  return (neg ? '-' : '') + integerInput(raw, 5);
};

function Field({ label, value, onChange, suffix, placeholder, int = false, signed = false, title, bad = false }: {
  label: string; value: string; onChange: (v: string) => void; suffix?: ReactNode; placeholder?: string; int?: boolean; signed?: boolean; title?: string; bad?: boolean;
}) {
  return (
    <div className={`oe-inputrow algo-in${bad ? ' is-bad' : ''}`} title={title}>
      <label className="oe-inlabel">{label}</label>
      <input
        className="oe-input"
        autoComplete="off"
        inputMode={int ? 'numeric' : 'decimal'}
        value={value}
        placeholder={placeholder ?? ''}
        aria-label={label}
        onChange={(e) => onChange(int ? wholeInput(e.target.value, signed) : decimalInput(e.target.value, { signed }))}
      />
      {suffix !== undefined && <span className="oe-suffix">{suffix}</span>}
    </div>
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

function UnitSwitch({ value, units, onChange }: { value: Unit; units: readonly Unit[]; onChange: (u: Unit) => void }) {
  return (
    <button
      type="button"
      className="algo-unit"
      title="Change the unit"
      onClick={() => onChange(units[(units.indexOf(value) + 1) % units.length]!)}
    >
      {UNIT_NAME[value]}
    </button>
  );
}

function Switch({ label, checked, onChange, title }: { label: string; checked: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <label className="oe-switch algo-switch" title={title}>
      <span>{label}</span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
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
  const [more, setMore] = useState(false);
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

  // A new market or kind starts from the market's own prices.
  useEffect(() => {
    if (!mid) return;
    const tick = Number(p.sym?.tickSize ?? '0.01');
    const r = (x: number) => String(Math.round(x / tick) * tick).replace(/(\.\d*?)0{6,}\d*$/, '$1');
    setD((x) => {
      const patch: Partial<Draft> = {};
      if (kind === 'scale' && (!x.from || !x.to)) {
        patch.from = r(p.side === 'buy' ? mid * 0.998 : mid * 1.002);
        patch.to = r(p.side === 'buy' ? mid * 0.98 : mid * 1.02);
      }
      if (kind === 'conditional' && !x.conds.length) patch.conds = [cond(p.symbol, { value: r(p.side === 'buy' ? mid * 0.99 : mid * 1.01), op: p.side === 'buy' ? 'below' : 'above' })];
      if (kind === 'basket' && !x.legs.length) patch.legs = legs(p.symbol, p.side);
      if (kind === 'bracket' && !x.entryPrice) patch.entryPrice = r(p.side === 'buy' ? mid * 0.998 : mid * 1.002);
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
  const errors = amountMissing ? [] : [...Object.values(check.errors), ...(plan?.errors ?? [])];
  // An executor needs the copy setup's steps (terms, sign-in, fee, key); the browser needs none of them.
  const copy = useSyncExternalStore(subscribeLiveCopy, getLiveCopy, getLiveCopy);
  const walletFree = d.place === 'browser' && d.paper;
  const where =
    d.place === 'browser'
      ? !p.address && !d.paper ? { ready: false, why: 'Connect a wallet to run it live, or switch on Paper.' } : { ready: true, why: null }
      : executorReady(d.place, d.paper);
  const execFee = d.place === 'browser' ? null : copy[d.place].info?.builder?.ladder?.[0]?.fee ?? null;
  const feeFraction = d.place === 'browser' ? p.builderFee : (execFee ?? 0) / 100_000;
  const ready = !!market && !amountMissing && !!check.spec && !!plan && !plan.errors.length && where.ready;
  const label = `Start ${menuName(kind)}${d.paper ? ' (paper)' : ''}`;
  const why = !market ? 'Loading the market…' : amountMissing ? 'Enter an amount.' : errors[0] ?? where.why ?? null;
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
        body: <Review spec={spec} plan={plan} kind={kind} feeRates={feeRates(market, feeFraction)} place={d.place} location={d.place === 'browser' ? null : copy[d.place].info?.location ?? null} />,
      });
      if (!ok) return;
      setBusy(true);
      try {
        if (d.place === 'browser') {
          const { browserAlgos } = await import('../../algo/browserAlgos');
          await browserAlgos.follow(algoOwner(p.address));
          await browserAlgos.start(spec, seed);
        } else {
          await startOn(d.place, spec, seed);
        }
        notify('ok', `${menuName(kind)} started${spec.paper ? ' (paper)' : ''}${d.place === 'hosted' ? ' on the ValueDesk executor' : d.place === 'self' ? ' on your copier' : ''}. Follow it in the Algos tab.`);
        setSeed(newSeed());
      } catch (e) {
        notify('error', e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
  }));

  const tick = Number(p.sym?.tickSize ?? '0');
  const levels: Level[] = [];
  if (mid) levels.push({ label: 'Now', price: mid, tone: 'now' });
  if (check.spec) addLevels(levels, check.spec, { bid: p.bid, ask: p.ask, mid, market });
  if (plan?.exits?.tp) levels.push({ label: 'Take-profit', price: plan.exits.tp, tone: 'pos' });
  if (plan?.exits?.sl) levels.push({ label: 'Stop-loss', price: plan.exits.sl, tone: 'neg' });

  const rates = feeRates(market, feeFraction);
  const notional = plan?.notional ?? null;
  const showTimeline = !!plan && (ek === 'twap' || ek === 'vwap' || ek === 'dca' || ek === 'swarm') && !(ek === 'twap' && d.twapClose);
  const showLadder = !!plan && (ek === 'scale' || (ek === 'iceberg' && !d.icePeg));
  const showLevels = !showTimeline && !showLadder && levels.length > 1;

  return (
    <div className={`algo is-${p.side}`}>
      <p className="algo-what">{whatItDoes(kind, d, p.side)}</p>

      {(ek === 'twap' || ek === 'vwap') && (
        <>
          <div className="algo-grid">
            <Field label="Duration" value={d.dur} onChange={(v) => set({ dur: v })} suffix={<UnitSwitch value={d.durUnit} units={['m', 'h', 'd']} onChange={(u) => set({ durUnit: u })} />} />
            <Field label="Slices" value={d.slices} int onChange={(v) => set({ slices: v })} title="How many child orders" />
          </div>
          {ek === 'vwap' && (
            <div className="algo-row">
              <Seg label="History" value={d.lookback} onChange={(v) => set({ lookback: v })} options={[[7, '7 d'], [14, '14 d'], [28, '28 d'], [41, '6 w']]} title="Days of volume the profile is the median of (weekdays and weekends apart from 14 days)" />
              <Switch label="Adaptive" checked={d.adaptive} onChange={(v) => set({ adaptive: v })} title="Faster while the market trades more than usual, slower while it trades less" />
            </div>
          )}
          {ek === 'twap' && kind === 'twap' && (
            <div className="algo-urgency" title="Front-loaded puts more early; back-loaded more late">
              <span className="algo-seg__k">Urgency</span>
              <input type="range" min={-1} max={1} step={0.1} value={d.urgency} aria-label="Urgency" onChange={(e) => set({ urgency: Number(e.target.value) })} />
              <span className="algo-urgency__v">{d.urgency === 0 ? 'Even' : d.urgency > 0 ? `Front ${Math.round(d.urgency * 100)}` : `Back ${Math.round(-d.urgency * 100)}`}</span>
            </div>
          )}
          {ek === 'twap' && (
            <>
              {kind === 'twap' && (
                <div className="algo-row">
                  <Switch label="Close position" checked={d.twapClose} onChange={(v) => set({ twapClose: v })} title="A time-sliced close: works a share of your position on this market, on the side that reduces it, reduce-only" />
                  {d.twapClose && <Field label="Share" value={d.twapCloseShare} onChange={(v) => set({ twapCloseShare: v })} suffix="%" title="Of the position when it starts" />}
                </div>
              )}
              <div className="algo-grid">
                <Field label="Smallest" value={d.minSlice} placeholder="min" onChange={(v) => set({ minSlice: v })} suffix={p.sym?.baseCoin} title="No slice below this: what is due waits until it reaches it (except at the end)" />
                <Field label="Largest" value={d.maxSlice} placeholder="any" onChange={(v) => set({ maxSlice: v })} suffix={p.sym?.baseCoin} title="No slice above this" />
              </div>
            </>
          )}
          <ExecFields d={d} set={set} chaseOnly={kind === 'chasetwap'} />
        </>
      )}

      {ek === 'bracket' && (
        <>
          <div className="algo-row">
            <Seg label="Entry" value={d.entry} onChange={(v) => set({ entry: v })} options={[['market', 'Market', 'Takes at once, within your max slippage'], ['limit', 'Limit', 'Rests at your price']]} />
          </div>
          {d.entry === 'limit' ? (
            <Field label="Price" value={d.entryPrice} onChange={(v) => set({ entryPrice: v })} />
          ) : (
            <Field label="Max slip" value={d.slip} onChange={(v) => set({ slip: v })} suffix="bp" />
          )}
        </>
      )}

      {ek === 'basket' && <BasketFields d={d} set={set} />}

      {ek === 'pov' && (
        <>
          <div className="algo-row">
            <Seg label="Share of volume" value={d.rate} onChange={(v) => set({ rate: v })} options={[['5', '5%', 'Low urgency'], ['10', '10%', 'Medium'], ['20', '20%', 'High']]} />
          </div>
          <div className="algo-grid">
            <Field label="Rate" value={d.rate} onChange={(v) => set({ rate: v })} suffix="%" />
            <Field label="Largest" value={d.maxChild} placeholder="any" onChange={(v) => set({ maxChild: v })} suffix={p.sym?.baseCoin} title="The largest single child" />
          </div>
          <Field label="Stop after" value={d.endIn} placeholder="when filled" onChange={(v) => set({ endIn: v })} suffix={<UnitSwitch value={d.endUnit} units={['m', 'h', 'd']} onChange={(u) => set({ endUnit: u })} />} />
          <ExecFields d={d} set={set} />
        </>
      )}

      {ek === 'iceberg' && (
        <>
          <div className="algo-grid">
            <Field label="Visible" value={d.display} onChange={(v) => set({ display: v })} suffix={p.sym?.baseCoin} title="The size shown at once" />
            <Field label="± random" value={d.displayJitter} onChange={(v) => set({ displayJitter: v })} suffix="%" />
          </div>
          <div className="algo-row">
            <Seg value={d.icePeg ? 'peg' : 'fixed'} onChange={(v) => set({ icePeg: v === 'peg' })} options={[['peg', 'Pegged', 'Follows the best price'], ['fixed', 'At a price']]} />
            <Switch label="Post only" checked={d.postOnly} onChange={(v) => set({ postOnly: v })} />
          </div>
          {d.icePeg ? (
            <div className="algo-grid">
              <Field label="Offset" value={d.offsetTicks} int signed onChange={(v) => set({ offsetTicks: v })} suffix="ticks" title="Ticks behind the best price" />
              <Field label="Refill" value={d.refill} onChange={(v) => set({ refill: v })} suffix="s" title="Wait between clips" />
            </div>
          ) : (
            <div className="algo-grid">
              <Field label="Price" value={d.icePrice} onChange={(v) => set({ icePrice: v })} />
              <Field label="Refill" value={d.refill} onChange={(v) => set({ refill: v })} suffix="s" />
            </div>
          )}
        </>
      )}

      {ek === 'chase' && (
        <>
          <div className="algo-row">
            <Seg label="Rest" value={d.offsetMode} onChange={(v) => set({ offsetMode: v })} options={[['ticks', 'At the touch'], ['bps', 'Stalk', 'Rest a set distance behind the best price']]} />
          </div>
          <div className="algo-grid">
            {d.offsetMode === 'ticks' ? (
              <Field label="Offset" value={d.offsetTicks} int signed onChange={(v) => set({ offsetTicks: v })} suffix="ticks" title="0 joins the best price; -1 steps inside the spread" />
            ) : (
              <Field label="Behind" value={d.offsetBps} onChange={(v) => set({ offsetBps: v })} suffix="bp" />
            )}
            <Field label="Re-price" value={d.chaseTicks} int onChange={(v) => set({ chaseTicks: v })} suffix="ticks" title="Move once the best price is this far away" />
            <Field label="Max chase" value={d.maxChase} placeholder="none" onChange={(v) => set({ maxChase: v })} suffix="bp" title="How far from where it started it may follow" />
            <Field label="Give up" value={d.timeout} placeholder="never" onChange={(v) => set({ timeout: v })} suffix={<UnitSwitch value={d.timeoutUnit} units={['s', 'm', 'h']} onChange={(u) => set({ timeoutUnit: u })} />} />
          </div>
          {opt(d.timeout) && (
            <Seg label="Then" value={d.onEnd} onChange={(v) => set({ onEnd: v })} options={[['take', 'Take the rest'], ['cancel', 'Cancel'], ['rest', 'Leave resting']]} />
          )}
        </>
      )}

      {ek === 'scale' && (
        <>
          <div className="algo-grid">
            <Field label="From" value={d.from} onChange={(v) => set({ from: v })} title="The first order (nearest the market, usually)" />
            <Field label="To" value={d.to} onChange={(v) => set({ to: v })} />
          </div>
          {mid && (
            <div className="algo-chips" aria-label="Range from the price">
              {[0.5, 1, 2, 5, 10].map((x) => (
                <button
                  key={x}
                  type="button"
                  className="oe-mini"
                  onClick={() => {
                    const r = (v: number) => String(Math.round(v / tick) * tick).replace(/(\.\d*?)0{6,}\d*$/, '$1');
                    const s = p.side === 'buy' ? -1 : 1;
                    set({ from: r(mid * (1 + s * 0.001)), to: r(mid * (1 + (s * x) / 100)) });
                  }}
                >
                  {x}%
                </button>
              ))}
            </div>
          )}
          <div className="algo-grid">
            <Field label="Orders" value={d.orders} int onChange={(v) => set({ orders: v })} />
            <Field label="Skew" value={d.skew} onChange={(v) => set({ skew: v })} suffix="×" title="The last order's size over the first's" />
          </div>
          <Seg label="Size" value={d.distribution} onChange={(v) => set({ distribution: v })} options={[['flat', 'Flat'], ['linear', 'Linear'], ['exponential', 'Exp'], ['bell', 'Bell']]} />
          <Seg label="Spacing" value={d.spacing} onChange={(v) => set({ spacing: v })} options={[['linear', 'Even'], ['geometric', '%', 'Even in percent'], ['front', 'Front', 'Denser near the first price'], ['back', 'Back', 'Denser near the last price']]} />
          <div className="algo-row">
            <Switch label="Post only" checked={d.postOnly} onChange={(v) => set({ postOnly: v })} />
            <Field label="± random" value={d.scaleJitter} onChange={(v) => set({ scaleJitter: v })} suffix="%" />
          </div>
        </>
      )}

      {ek === 'dca' && (
        <>
          <div className="algo-grid">
            <Field label="Each" value={d.perOrder} onChange={(v) => set({ perOrder: v })} suffix="USD" />
            <Field label="Orders" value={d.dcaOrders} int onChange={(v) => set({ dcaOrders: v })} />
            <Field label="Every" value={d.every} onChange={(v) => set({ every: v })} suffix={<UnitSwitch value={d.everyUnit} units={['m', 'h', 'd']} onChange={(u) => set({ everyUnit: u })} />} />
            <Field label="Budget" value={d.budget} placeholder="no cap" onChange={(v) => set({ budget: v })} suffix="USD" />
          </div>
          <div className="algo-grid">
            <Field label="Dip" value={d.dip} placeholder="off" onChange={(v) => set({ dip: v })} suffix="%" title={`Buy more when the price is this far ${p.side === 'buy' ? 'below' : 'above'} your average so far`} />
            <Field label="× more" value={d.dipMult} onChange={(v) => set({ dipMult: v })} suffix="×" />
          </div>
          <Seg label="Execution" value={d.exec === 'hybrid' ? 'hybrid' : d.exec} onChange={(v) => set({ exec: v })} options={[['taker', 'Taker'], ['hybrid', 'Rest, then take'], ['maker', 'Maker']]} />
        </>
      )}

      {ek === 'swarm' && (
        <>
          <div className="algo-grid">
            <Field label="Clips" value={d.clips} int onChange={(v) => set({ clips: v })} />
            <Field label="Between" value={d.waveSec} onChange={(v) => set({ waveSec: v })} suffix="s" title="Pause between waves, so the book can refill" />
            <Field label="Max slip" value={d.slip} onChange={(v) => set({ slip: v })} suffix="bp" />
            <Field label="Retries" value={d.retries} int onChange={(v) => set({ retries: v })} title="What did not fill goes again this many times" />
          </div>
          <Seg label="Per wave" value={d.inFlight} onChange={(v) => set({ inFlight: v })} options={[[1, '1'], [2, '2'], [5, '5'], [10, '10'], [20, '20']]} title="Aggression: clips sent at once" />
          <Field label="Irregular" value={d.sizeJitter} onChange={(v) => set({ sizeJitter: v })} suffix="%" title="Each clip's size moves up to this much either way" />
        </>
      )}

      {ek === 'trailing' && (
        <>
          <div className="algo-grid">
            <Field label="Trail" value={d.trail} onChange={(v) => set({ trail: v })} suffix={<button type="button" className="algo-unit" onClick={() => set({ trailMode: d.trailMode === 'pct' ? 'abs' : 'pct' })}>{d.trailMode === 'pct' ? '%' : 'USD'}</button>} />
            <Field label="From" value={d.activation} placeholder="now" onChange={(v) => set({ activation: v })} title={`Start trailing once the price reaches this (${p.side === 'sell' ? 'at or above' : 'at or below'})`} />
          </div>
          <div className="algo-row">
            <Seg value={d.trailWhole ? 'pos' : 'amt'} onChange={(v) => set({ trailWhole: v === 'pos' })} options={[['pos', 'Whole position'], ['amt', 'Amount']]} />
            <Seg value={d.source} onChange={(v) => set({ source: v })} options={[['mark', 'Mark'], ['last', 'Last']]} />
          </div>
          <div className="algo-row">
            <Seg label="Exit" value={d.exit} onChange={(v) => set({ exit: v })} options={[['market', 'Market'], ['chase', 'Chase', 'Rest at the best price first, then take']]} />
            {d.exit === 'chase' ? <Field label="For" value={d.chaseSec} onChange={(v) => set({ chaseSec: v })} suffix="s" /> : <Field label="Max slip" value={d.slip} onChange={(v) => set({ slip: v })} suffix="bp" />}
          </div>
        </>
      )}

      {ek === 'conditional' && <ConditionalFields d={d} set={set} symbol={p.symbol} base={p.sym?.baseCoin ?? ''} />}

      {offersExits(kind, d, p.reduceOnly) && <ExitFields d={d} set={set} side={p.side} always={kind === 'bracket'} levels={plan?.exits ?? null} />}

      {/* Shared rules: a price limit, when to start, price bounds, the spread guard. */}
      <div className="algo-morehead">
        <button type="button" className="algo-more" aria-expanded={more} onClick={() => setMore((v) => !v)}>
          {more ? 'Fewer rules' : 'Limit, start, bounds'}
          {!more && activeRules(d) > 0 && <span className="algo-badge">{activeRules(d)}</span>}
        </button>
        <Switch label="Paper" checked={d.paper} onChange={(v) => set({ paper: v })} title="Run against the live market and send nothing" />
      </div>
      <Seg
        label="Runs"
        value={d.place}
        onChange={(v) => set({ place: v })}
        options={[
          ['browser', 'This browser', 'Signed with your trading key, while a ValueDesk tab is open'],
          ['hosted', 'ValueDesk 24/7', 'On the ValueDesk executor, with the key you registered for it - keeps running while your browser is closed'],
          ['self', 'Self-hosted', 'On the copier you run yourself'],
        ]}
      />
      <Collapse open={more}>
        <div className="algo-rules">
          {ek !== 'scale' && ek !== 'trailing' && ek !== 'basket' && (
            <Field label="Limit" value={d.limitPrice} placeholder="none" onChange={(v) => set({ limitPrice: v })} title={`Never ${p.side === 'buy' ? 'buy above' : 'sell below'} this price`} />
          )}
          <Seg label="Start" value={d.startMode} onChange={(v) => set({ startMode: v })} options={[['now', 'Now'], ['delay', 'Later'], ['price', 'At a price']]} />
          {d.startMode === 'delay' && <Field label="In" value={d.startDelay} onChange={(v) => set({ startDelay: v })} suffix="min" />}
          {d.startMode === 'price' && <Field label="When mark" value={d.startPrice} onChange={(v) => set({ startPrice: v })} title="Starts once the mark reaches this, from wherever it is now" />}
          {ek !== 'scale' && ek !== 'trailing' && ek !== 'conditional' && ek !== 'basket' && ek !== 'bracket' && (
            <>
              <div className="algo-bound">
                <Field label="Above" value={d.upper} placeholder="—" onChange={(v) => set({ upper: v })} />
                <Seg value={d.upperThen} onChange={(v) => set({ upperThen: v })} options={BOUND_OPTS} />
              </div>
              <div className="algo-bound">
                <Field label="Below" value={d.lower} placeholder="—" onChange={(v) => set({ lower: v })} />
                <Seg value={d.lowerThen} onChange={(v) => set({ lowerThen: v })} options={BOUND_OPTS} />
              </div>
              <Field label="Max spread" value={d.maxSpread} placeholder="any" onChange={(v) => set({ maxSpread: v })} suffix="bp" title="Take nothing while the spread is wider" />
            </>
          )}
        </div>
      </Collapse>

      {/* The preview. */}
      <div className="algo-preview">
        {showTimeline && plan && <TimelinePreview plan={plan} side={p.side} />}
        {showLadder && plan && <LadderPreview plan={plan} side={p.side} mid={mid ?? null} />}
        {showLevels && <LevelsPreview levels={levels} mid={mid ?? null} />}
        <Summary plan={plan} kind={kind} d={d} rates={rates} notional={notional} onShuffle={hasJitter(kind, d) ? () => setSeed(newSeed()) : undefined} />
        {errors.slice(0, 3).map((e) => (
          <p key={e} className="oe-hint algo-err">{e}</p>
        ))}
        {!errors.length && plan?.warnings.slice(0, 3).map((w) => (
          <p key={w} className="oe-hint algo-warn">{w}</p>
        ))}
        {!errors.length && where.why && <p className="oe-hint algo-warn">{where.why}</p>}
        {!d.paper && d.place === 'browser' && (
          <p className="oe-hint algo-where">
            Runs in this browser: keep a ValueDesk tab open. Every child is an ordinary SoDEX order with the ValueDesk fee{p.builderFee > 0 ? ` (${(p.builderFee * 10_000).toFixed(1)} bp)` : ''}.
          </p>
        )}
        {!d.paper && d.place !== 'browser' && (
          <p className="oe-hint algo-where">
            Runs on {d.place === 'hosted' ? `the ValueDesk executor${copy.hosted.info?.location ? ` (${copy.hosted.info.location})` : ''}, 24/7` : 'your copier'}, signed by the key you registered for it. Each child carries the copy fee{execFee ? ` (up to ${(execFee / 10).toFixed(1)} bp)` : ''}.
          </p>
        )}
      </div>
      {dialog}
      {busy && <span className="algo-busy" aria-live="polite">Starting…</span>}
    </div>
  );
});

export default AlgoTicket;

const BOUND_OPTS: ReadonlyArray<readonly [BoundAction, string, string?]> = [
  ['hold', 'Hold', 'Pause while the price is past it'],
  ['stop', 'Stop', 'End the algo'],
  ['rush', 'Rush', 'Take everything that is left now'],
];

function activeRules(d: Draft): number {
  return [d.limitPrice, d.upper, d.lower, d.maxSpread].filter((x) => opt(x)).length + (d.startMode !== 'now' ? 1 : 0);
}

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
      <div className="algo-grid">
        {style !== 'maker' && <Field label="Max slip" value={d.slip} onChange={(v) => set({ slip: v })} suffix="bp" title="Worst price per taker child, past the touch" />}
        {style === 'hybrid' && <Field label="Rest for" value={d.makerShare} onChange={(v) => set({ makerShare: v })} suffix="%" title="Share of each slice spent resting before the rest is taken" />}
        {style !== 'taker' && <Field label="Re-price" value={d.chaseTicks} int onChange={(v) => set({ chaseTicks: v })} suffix="ticks" />}
        <Field label="± size" value={d.sizeJitter} onChange={(v) => set({ sizeJitter: v })} suffix="%" title="Randomise each slice's size (the total stays)" />
        <Field label="± time" value={d.timeJitter} onChange={(v) => set({ timeJitter: v })} suffix="%" title="Randomise each slice's time, as a share of the interval" />
        <Field label="Max part." value={d.maxPart} placeholder="off" onChange={(v) => set({ maxPart: v })} suffix="%" title="A slice takes at most this share of the volume printed in the last interval" />
      </div>
      <Seg label="When time is up" value={d.finish} onChange={(v) => set({ finish: v })} options={[['take', 'Take the rest'], ['leave', 'Leave it']]} />
    </>
  );
}

/**
 * Exits after the fills: SoDEX's own position stops (a reduce-only market
 * order on the mark), resized as the algo fills; when one fills, the other is
 * cancelled. Distances are from the average fill.
 */
function ExitFields({ d, set, side, always, levels }: { d: Draft; set: (p: Partial<Draft>) => void; side: 'buy' | 'sell'; always: boolean; levels: { tp: number | null; sl: number | null } | null }) {
  const on = always || d.exitsOn;
  const unit = (mode: 'pct' | 'price', key: 'tpMode' | 'slMode') => (
    <button type="button" className="algo-unit" title="A distance from your average fill, or a price" onClick={() => set({ [key]: mode === 'pct' ? 'price' : 'pct' } as Partial<Draft>)}>
      {mode === 'pct' ? '%' : 'USD'}
    </button>
  );
  const at = (x: number | null | undefined) => (x ? ` · ${fmtLevel(x)}` : '');
  return (
    <div className="algo-exits">
      {!always && <Switch label="Take-profit / stop-loss" checked={d.exitsOn} onChange={(v) => set({ exitsOn: v })} title="SoDEX holds them as position stops, resized as the algo fills; when one fills the other is cancelled" />}
      {on && (
        <div className="algo-grid">
          <Field label="TP" value={d.tp} placeholder="none" onChange={(v) => set({ tp: v })} suffix={unit(d.tpMode, 'tpMode')} title={`Take-profit ${side === 'buy' ? 'above' : 'below'} your average fill${at(levels?.tp)}`} />
          <Field label="SL" value={d.sl} placeholder="none" onChange={(v) => set({ sl: v })} suffix={unit(d.slMode, 'slMode')} title={`Stop-loss ${side === 'buy' ? 'below' : 'above'} your average fill${at(levels?.sl)}`} />
        </div>
      )}
    </div>
  );
}

function BasketFields({ d, set }: { d: Draft; set: (p: Partial<Draft>) => void }) {
  const edit = (i: number, patch: Partial<LegDraft>) => set({ legs: d.legs.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const total = d.legs.reduce((a, l) => a + (Number(l.usd) || 0), 0);
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
      <Seg label="Each market" value={d.basketStyle} onChange={(v) => set({ basketStyle: v })} options={[['swarm', 'Swarm', 'Small takers in waves, now'], ['twap', 'TWAP', 'Slices over a time you choose']]} />
      {d.basketStyle === 'twap' ? (
        <div className="algo-grid">
          <Field label="Duration" value={d.dur} onChange={(v) => set({ dur: v })} suffix={<UnitSwitch value={d.durUnit} units={['m', 'h', 'd']} onChange={(u) => set({ durUnit: u })} />} />
          <Field label="Slices" value={d.slices} int onChange={(v) => set({ slices: v })} />
        </div>
      ) : (
        <div className="algo-grid">
          <Field label="Clips" value={d.clips} int onChange={(v) => set({ clips: v })} title="Per market" />
          <Field label="Between" value={d.waveSec} onChange={(v) => set({ waveSec: v })} suffix="s" />
        </div>
      )}
      <div className="algo-grid">
        <Field label="Max slip" value={d.slip} onChange={(v) => set({ slip: v })} suffix="bp" />
        <div className="algo-total">{total > 0 ? `${fmtUsd(total, 0)} in all` : ''}</div>
      </div>
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
      <div className="algo-row">
        <Seg label="When" value={d.match} onChange={(v) => set({ match: v })} options={[['all', 'All hold'], ['any', 'Any holds']]} />
      </div>
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
      <div className="algo-grid">
        <Field label="Hold for" value={d.holdSec} onChange={(v) => set({ holdSec: v })} suffix="s" title="It acts only once the conditions held this long (no firing on a wick)" />
        <Field label="Expires" value={d.expires} placeholder="never" onChange={(v) => set({ expires: v })} suffix={<UnitSwitch value={d.expiresUnit} units={['m', 'h', 'd']} onChange={(u) => set({ expiresUnit: u })} />} />
      </div>
      <Seg label="Then" value={d.then} onChange={(v) => set({ then: v })} options={[['market', 'Market'], ['limit', 'Limit'], ['close', 'Close'], ['twap', 'TWAP'], ['chase', 'Chase']]} />
      {d.then === 'market' && <Field label="Max slip" value={d.slip} onChange={(v) => set({ slip: v })} suffix="bp" />}
      {d.then === 'limit' && (
        <div className="algo-row">
          <Field label="Price" value={d.thenPrice} onChange={(v) => set({ thenPrice: v })} />
          <Switch label="Post only" checked={d.postOnly} onChange={(v) => set({ postOnly: v })} />
        </div>
      )}
      {d.then === 'close' && <Field label="Close" value={d.closePct} onChange={(v) => set({ closePct: v })} suffix={`% of the ${base} position`} />}
      {d.then === 'twap' && (
        <div className="algo-grid">
          <Field label="Over" value={d.thenMin} onChange={(v) => set({ thenMin: v })} suffix="min" />
          <Field label="Slices" value={d.thenSlices} int onChange={(v) => set({ thenSlices: v })} />
        </div>
      )}
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

function Summary({ plan, kind, d, rates, notional, onShuffle }: { plan: AlgoPlan | null; kind: UiKind; d: Draft; rates: Rates; notional: number | null; onShuffle?: () => void }) {
  if (!plan) return null;
  const ek = engineKind(kind);
  const rows: Array<[string, ReactNode]> = [];
  const kids = plan.children.filter((c) => c.qty > 0).length;
  if (ek === 'twap' || ek === 'vwap') {
    const spread = plan.minChildUsd !== null && plan.maxChildUsd !== null && plan.maxChildUsd - plan.minChildUsd > 0.01 ? ` (${fmtUsd(plan.minChildUsd, 0)}–${fmtUsd(plan.maxChildUsd, 0)})` : '';
    rows.push(['Slices', `${kids} · ${notional && kids ? `${fmtUsd(notional / kids, 2)} each${spread}` : DASH}`]);
    rows.push(['Every', plan.intervalMs ? `${fmtDuration(plan.intervalMs)} · ends ${plan.endsAt ? fmtTime(plan.endsAt) : DASH}` : DASH]);
  } else if (ek === 'dca') {
    rows.push(['Orders', `${kids} × ${fmtUsd(n(d.perOrder), 2)}`]);
    rows.push(['Every', plan.intervalMs ? `${fmtDuration(plan.intervalMs)} · last ${plan.endsAt ? fmtTime(plan.endsAt) : DASH}` : DASH]);
  } else if (ek === 'swarm') {
    rows.push(['Clips', `${kids} in ${Math.ceil(kids / Math.max(1, d.inFlight))} waves`]);
    rows.push(['Takes', plan.endsAt && plan.endsAt > plan.startsAt ? `about ${fmtDuration(plan.endsAt - plan.startsAt)}` : 'one wave']);
  } else if (ek === 'scale') {
    rows.push(['Orders', `${kids} resting`]);
    rows.push(['If all fill', plan.avgPrice ? `avg ${plan.avgPrice.toLocaleString('en-US', { maximumFractionDigits: 6 })}` : DASH]);
  } else if (ek === 'iceberg') {
    rows.push(['Clips', `about ${kids}`]);
  } else if (ek === 'pov') {
    rows.push(['Pace', plan.endsAt ? `about ${fmtDuration(plan.endsAt - plan.startsAt)} at the last day's volume` : 'by the volume that prints']);
  } else if (ek === 'chase') {
    rows.push(['Order', 'one, post-only, re-priced']);
  } else if (ek === 'basket') {
    rows.push(['Markets', d.legs.map((l) => `${l.side === 'buy' ? '+' : '−'}${l.symbol.replace(/-USD$/, '')}`).join(' ')]);
    rows.push(['Takes', plan.endsAt && plan.endsAt > plan.startsAt ? `about ${fmtDuration(plan.endsAt - plan.startsAt)}` : 'one wave']);
  }
  if (plan.exits && (plan.exits.tp || plan.exits.sl)) {
    const f = (x: number | null) => (x ? fmtLevel(x) : DASH);
    rows.push(['Exits', `TP ${f(plan.exits.tp)} · SL ${f(plan.exits.sl)}`]);
  }
  if (notional) {
    rows.push(['Value', fmtUsd(notional, 2)]);
    const lo = notional * rates.maker;
    const hi = notional * rates.taker;
    rows.push(['Fees', ek === 'scale' ? fmtUsd(lo, 2) : `${fmtUsd(lo, 2)} – ${fmtUsd(hi, 2)}`]);
  }
  if (!rows.length) return null;
  return (
    <dl className="algo-sum">
      {rows.map(([k, v]) => (
        <div key={k} className="algo-sum__row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
      {onShuffle && (
        <button type="button" className="algo-shuffle" onClick={onShuffle} title="Draw another random schedule (sizes and times)">
          New draw
        </button>
      )}
    </dl>
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

function whatItDoes(kind: UiKind, d: Draft, side: 'buy' | 'sell'): string {
  const verb = side === 'buy' ? 'Buys' : 'Sells';
  switch (kind) {
    case 'twap':
      if (d.twapClose) return `Closes ${d.twapCloseShare || '…'}% of your position in ${d.slices || '…'} slices over ${d.dur || '…'} ${UNIT_NAME[d.durUnit]}.`;
      return `${verb} the amount in ${d.slices || '…'} slices over ${d.dur || '…'} ${UNIT_NAME[d.durUnit]}.`;
    case 'chasetwap':
      return `${verb} in ${d.slices || '…'} slices over ${d.dur || '…'} ${UNIT_NAME[d.durUnit]}, each resting at the best price first.`;
    case 'vwap':
      return `${verb} over ${d.dur || '…'} ${UNIT_NAME[d.durUnit]}, faster in the hours the market usually trades most.`;
    case 'pov':
      return `${verb} ${d.rate || '…'}% of what everyone else trades, as they trade it.`;
    case 'iceberg':
      return `Shows ${d.display || '…'} at a time and refills it until the amount is done.`;
    case 'chase':
      return 'Rests one post-only order at the best price and follows it until it fills.';
    case 'scale':
      return `Rests ${d.orders || '…'} orders between your two prices at once.`;
    case 'dca':
      return `${verb} $${d.perOrder || '…'} every ${d.every || '…'} ${UNIT_NAME[d.everyUnit]}, ${d.dcaOrders || '…'} times.`;
    case 'swarm':
      return `${verb} in ${d.clips || '…'} small takers, ${d.inFlight} at a time.`;
    case 'conditional':
      return `Waits until ${d.match === 'all' ? 'every condition holds' : 'any condition holds'}, then acts.`;
    case 'trailing':
      return side === 'sell' ? 'Follows the high and sells when the price falls back by the trail (protects a long).' : 'Follows the low and buys when the price bounces by the trail (protects a short).';
    case 'bracket':
      return `${side === 'buy' ? 'Goes long' : 'Goes short'} ${d.entry === 'limit' ? `at ${d.entryPrice || '…'}` : 'at market'}, then SoDEX holds the take-profit and stop-loss: when one fills, the other is cancelled.`;
    case 'basket':
      return `Trades ${d.legs.length || '…'} markets at once, each as its own ${d.basketStyle === 'twap' ? 'TWAP' : 'swarm'}; pause or cancel them together.`;
  }
}

function Review({ spec, plan, kind, feeRates: r, place, location }: { spec: AlgoSpec; plan: AlgoPlan; kind: UiKind; feeRates: Rates; place: Draft['place']; location: string | null }) {
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

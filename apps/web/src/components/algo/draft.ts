/**
 * The algo ticket's form as data: the draft, its defaults, how it is saved,
 * and how it becomes an engine spec. No React here, so it can be tested.
 *
 * WHAT IS ESSENTIAL. Each kind shows on the ticket what the major venues show
 * in their own order forms (INLINE_KEYS: a running time and Randomize for a
 * TWAP, a range, a count and a size curve for a scale, a distance for a
 * trailing stop...). Everything else is an advanced setting, in the kind's
 * Advanced pop-up, with the value it always had (ADVANCED_KEYS), under where
 * the algo runs.
 */
import type { BoundAction, ConditionType } from '@copy-engine';
import { engineKind, type UiKind } from './menu';

export type Unit = 's' | 'm' | 'h' | 'd';
export const UNIT_MS: Record<Unit, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
export const UNIT_NAME: Record<Unit, string> = { s: 's', m: 'min', h: 'h', d: 'd' };

export interface CondDraft {
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

export interface LegDraft {
  symbol: string;
  side: 'buy' | 'sell';
  usd: string;
}

export interface Draft {
  dur: string;
  durUnit: Unit;
  slices: string;
  /** The slice count follows the duration (one a minute) until the trader sets one. */
  slicesAuto: boolean;
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
  /** Chase: how far it may follow the price, in % as Bybit and OKX ask for it (the spec takes bp). */
  maxChasePct: string;
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

export const cond = (symbol: string, over: Partial<CondDraft> = {}): CondDraft => ({
  type: 'price', symbol, source: 'mark', op: 'below', dir: 'either', value: '', pct: '1', windowMin: '5', bps: '10', usd: '1000000', other: 'BTC-USD', inMin: '60', pos: 'flat', ...over,
});

export const legs = (symbol: string, side: 'buy' | 'sell'): LegDraft[] => [
  { symbol, side, usd: '100' },
  { symbol: symbol === 'ETH-USD' ? 'BTC-USD' : 'ETH-USD', side: side === 'buy' ? 'sell' : 'buy', usd: '100' },
];

export const DEFAULT: Draft = {
  dur: '30', durUnit: 'm', slices: '30', slicesAuto: true, exec: 'hybrid', slip: '30', makerShare: '60', offsetTicks: '0', chaseTicks: '2', sizeJitter: '15', timeJitter: '20', urgency: 0,
  finish: 'take', maxPart: '', lookback: 14, adaptive: true, rate: '10', maxChild: '', endIn: '', endUnit: 'h',
  display: '', displayJitter: '20', icePeg: true, icePrice: '', postOnly: true, refill: '0',
  offsetMode: 'ticks', offsetBps: '10', maxChasePct: '', timeout: '', timeoutUnit: 'm', onEnd: 'take',
  from: '', to: '', orders: '10', distribution: 'flat', skew: '1', spacing: 'linear', scaleJitter: '0',
  perOrder: '50', dcaOrders: '10', every: '1', everyUnit: 'h', outOfBand: 'skip', dip: '', dipMult: '2', budget: '',
  clips: '10', inFlight: 2, waveSec: '3', retries: '2',
  match: 'all', conds: [], holdSec: '0', expires: '', expiresUnit: 'd', then: 'market', thenPrice: '', closePct: '100', thenMin: '15', thenSlices: '15',
  trailMode: 'pct', trail: '1', activation: '', trailWhole: true, source: 'mark', exit: 'market', chaseSec: '15',
  limitPrice: '', startMode: 'now', startDelay: '5', startPrice: '', upper: '', upperThen: 'hold', lower: '', lowerThen: 'hold', maxSpread: '',
  paper: false,
  twapClose: false, twapCloseShare: '100', minSlice: '', maxSlice: '',
  exitsOn: false, tpMode: 'pct', tp: '2', slMode: 'pct', sl: '1',
  legs: [], basketStyle: 'swarm',
  entry: 'market', entryPrice: '',
};

/** The draft in storage. Where the algo runs is not in it any more (executor.ts keeps that). */
export const DRAFT_KEY = 'vs.algo.draft.v1';

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const local = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

export const n = (s: string): number => {
  const v = Number(s);
  return s.trim() !== '' && Number.isFinite(v) ? v : NaN;
};
export const opt = (s: string): number | null => (Number.isFinite(n(s)) && n(s) > 0 ? n(s) : null);
export const frac = (s: string): number => (Number.isFinite(n(s)) ? n(s) / 100 : 0);

/** A distance typed in % as basis points for the spec (0.15 % = 15 bp, without float dust); empty or 0: none. */
export const pctToBps = (s: string): number | null => (opt(s) ? Math.round(n(s) * 100 * 1e6) / 1e6 : null);
/** Basis points as the % the field shows (an old draft's 25 bp: '0.25'). */
export const bpsToPct = (s: string): string => (opt(s) ? String(Math.round((n(s) / 100) * 1e8) / 1e8) : '');

/** One slice a minute over the duration (30 min: 30, the old default), within what the engine takes. */
export function autoSlices(dur: string, unit: Unit): string {
  const ms = n(dur) * UNIT_MS[unit];
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT.slices;
  return String(Math.min(2000, Math.max(2, Math.round(ms / 60_000))));
}

/** The slice count the spec gets: the trader's own, or the one that follows the duration. */
export const slicesOf = (d: Pick<Draft, 'slices' | 'slicesAuto' | 'dur' | 'durUnit'>): string => (d.slicesAuto ? autoSlices(d.dur, d.durUnit) : d.slices);

/**
 * The saved draft. Prices and lists start fresh (they belong to one market).
 * A draft saved before slices could follow the duration keeps the count it
 * had: it follows the duration only if it was already the count it would give.
 */
export function loadDraft(store: Store | null = local()): Draft {
  try {
    const raw = store?.getItem(DRAFT_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Draft> & { place?: unknown; maxChase?: unknown };
      delete saved.place;
      // A chase's max distance was kept in bp before the field took % (2026-10-26).
      const oldChase = saved.maxChase;
      delete saved.maxChase;
      if (saved.maxChasePct === undefined && typeof oldChase === 'string') saved.maxChasePct = bpsToPct(oldChase);
      const d: Draft = { ...DEFAULT, ...saved, conds: [], legs: [] };
      if (saved.slicesAuto === undefined) d.slicesAuto = d.slices === autoSlices(d.dur, d.durUnit);
      return d;
    }
  } catch {
    /* storage blocked or the draft unreadable: defaults */
  }
  return { ...DEFAULT };
}

export function saveDraft(d: Draft, store: Store | null = local()): void {
  try {
    const { conds: _c, from: _f, to: _t, icePrice: _i, limitPrice: _l, upper: _u, lower: _lo, startPrice: _s, thenPrice: _tp, activation: _a, legs: _lg, entryPrice: _ep, ...keep } = d;
    store?.setItem(DRAFT_KEY, JSON.stringify(keep));
  } catch {
    /* storage blocked */
  }
}

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
  const slices = Math.trunc(n(slicesOf(d)));
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
        slices,
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
        slices,
        clips: Math.trunc(n(d.clips)),
        inFlight: d.inFlight,
        waveMs: Math.round((n(d.waveSec) || 0) * 1000),
        slippageBps: n(d.slip),
      };
    case 'vwap':
      return { ...base, quantity: p.quantity, durationMs: Math.round(dur), slices, lookbackDays: d.lookback, adaptive: d.adaptive, sizeJitter: frac(d.sizeJitter), exec, finish: d.finish, maxParticipation: opt(d.maxPart) ? frac(d.maxPart) : null };
    case 'pov':
      return { ...base, quantity: p.quantity, rate: frac(d.rate), maxChildQty: opt(d.maxChild) ? d.maxChild : null, endAt: opt(d.endIn) ? now + n(d.endIn) * UNIT_MS[d.endUnit] : null, exec, finish: d.finish };
    case 'iceberg':
      return { ...base, quantity: p.quantity, displayQty: d.display, displayJitter: frac(d.displayJitter), price: d.icePeg ? null : opt(d.icePrice), pegOffsetTicks: Math.trunc(n(d.offsetTicks) || 0), chaseTicks: exec.chaseTicks, postOnly: d.postOnly, refillMs: Math.round((n(d.refill) || 0) * 1000), refillJitter: 0.5 };
    case 'chase':
      return { ...base, quantity: p.quantity, offsetTicks: Math.trunc(n(d.offsetTicks) || 0), offsetBps: d.offsetMode === 'bps' ? opt(d.offsetBps) : null, chaseTicks: exec.chaseTicks, maxChaseBps: pctToBps(d.maxChasePct), timeoutMs: opt(d.timeout) ? n(d.timeout) * UNIT_MS[d.timeoutUnit] : null, onEnd: d.onEnd, minRepriceMs: 1_000 };
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

/* ------------------------------------------------------ advanced settings ----- */

const EXEC_KEYS: ReadonlyArray<keyof Draft> = ['exec', 'slip', 'makerShare', 'chaseTicks', 'sizeJitter', 'timeJitter', 'maxPart', 'finish'];

/**
 * Per kind, what the ticket itself shows (beside the ticket's own Amount and
 * Reduce only): the fields Hyperliquid, Binance, Bybit, OKX and Insilico put
 * in their main order forms (benchmark of 2026-10-26). A TWAP is a running
 * time and a Randomize switch (Hyperliquid, Bybit); a chase its max distance
 * in % (Bybit, OKX, Insilico); a scale its range, count and size curve
 * (Binance, Bybit); a swarm its lots and Irregular lots (Insilico); a basket
 * its legs and how each is worked (Insilico).
 *
 * Draft keys, plus two switches drawn from several: 'randomize' (the jitter)
 * and 'scaleSize' (distribution with skew).
 */
export const INLINE_KEYS: Record<UiKind, readonly string[]> = {
  twap: ['dur', 'durUnit', 'randomize', 'twapCloseShare'],
  chasetwap: ['dur', 'durUnit'],
  vwap: ['dur', 'durUnit'],
  pov: ['rate'],
  iceberg: ['icePrice', 'display'],
  chase: ['maxChasePct'],
  scale: ['from', 'to', 'orders', 'scaleSize'],
  dca: ['perOrder', 'every', 'everyUnit', 'dcaOrders'],
  swarm: ['clips', 'randomize'],
  trailing: ['trail', 'trailMode', 'activation'],
  conditional: ['conds', 'then', 'thenPrice', 'closePct', 'thenMin'],
  bracket: ['entry', 'entryPrice', 'tp', 'tpMode', 'sl', 'slMode'],
  basket: ['legs', 'basketStyle', 'dur', 'durUnit'],
};

/** Per kind, the settings in its Advanced pop-up (the shared rules and the exits are counted apart). */
export const ADVANCED_KEYS: Record<UiKind, ReadonlyArray<keyof Draft>> = {
  twap: ['slicesAuto', 'urgency', 'twapClose', 'minSlice', 'maxSlice', ...EXEC_KEYS],
  chasetwap: ['slicesAuto', 'minSlice', 'maxSlice', ...EXEC_KEYS],
  vwap: ['slicesAuto', 'lookback', 'adaptive', ...EXEC_KEYS],
  pov: ['maxChild', 'endIn', ...EXEC_KEYS],
  iceberg: ['displayJitter', 'offsetTicks', 'refill', 'postOnly'],
  chase: ['offsetMode', 'offsetTicks', 'offsetBps', 'chaseTicks', 'timeout', 'onEnd'],
  scale: ['skew', 'spacing', 'scaleJitter', 'postOnly'],
  dca: ['budget', 'dip', 'dipMult', 'exec'],
  swarm: ['inFlight', 'waveSec', 'slip', 'retries', 'sizeJitter'],
  trailing: ['trailWhole', 'source', 'exit', 'slip', 'chaseSec'],
  conditional: ['match', 'holdSec', 'expires', 'slip', 'postOnly', 'thenSlices'],
  bracket: ['slip'],
  basket: ['slicesAuto', 'clips', 'waveSec', 'slip'],
};

/* Randomize: the TWAP's and the swarm's switch on the ticket (Hyperliquid's
   "Randomize", Insilico's "Irregular lots"). On is the jitter the Advanced
   pop-up sets (by default ±15 % size, and ±20 % time for a TWAP); off is none. */

/** The kinds whose Randomize switch is on the ticket. */
export const hasRandomize = (kind: UiKind): boolean => kind === 'twap' || kind === 'swarm';

export function randomizeOn(kind: UiKind, d: Pick<Draft, 'sizeJitter' | 'timeJitter'>): boolean {
  return frac(d.sizeJitter) > 0 || (kind === 'twap' && frac(d.timeJitter) > 0);
}

/** The patch for the switch: off is no jitter at all, on is the default jitter back. */
export function setRandomize(kind: UiKind, on: boolean): Partial<Draft> {
  if (!on) return kind === 'twap' ? { sizeJitter: '0', timeJitter: '0' } : { sizeJitter: '0' };
  return kind === 'twap' ? { sizeJitter: DEFAULT.sizeJitter, timeJitter: DEFAULT.timeJitter } : { sizeJitter: DEFAULT.sizeJitter };
}

/* Scale's size curve on the ticket, as Binance and Bybit name it: flat,
   increasing (bigger toward To), decreasing, or a bell. Increasing and
   decreasing are a linear curve with a skew (the last order over the first);
   the Advanced pop-up tunes the curve and the skew. */

export type ScaleSize = 'flat' | 'increasing' | 'decreasing' | 'bell';
export const SCALE_SKEW = { increasing: '2', decreasing: '0.5' } as const;

export function scaleSize(d: Pick<Draft, 'distribution' | 'skew'>): ScaleSize {
  if (d.distribution === 'flat') return 'flat';
  if (d.distribution === 'bell') return 'bell';
  const s = n(d.skew) || 1;
  return s > 1 ? 'increasing' : s < 1 ? 'decreasing' : 'flat';
}

export function setScaleSize(d: Pick<Draft, 'distribution' | 'skew'>, v: ScaleSize): Partial<Draft> {
  if (v === 'flat') return { distribution: 'flat', skew: DEFAULT.skew };
  if (v === 'bell') return { distribution: 'bell' };
  const curve = d.distribution === 'exponential' ? 'exponential' : 'linear';
  const s = n(d.skew) || 1;
  const keep = v === 'increasing' ? s > 1 : s < 1;
  return { distribution: curve, skew: keep ? d.skew : SCALE_SKEW[v] };
}

const ADV_LABEL: Partial<Record<keyof Draft, string>> = {
  slicesAuto: 'slices', urgency: 'urgency', twapClose: 'close position', minSlice: 'smallest slice', maxSlice: 'largest slice',
  exec: 'execution', slip: 'max slippage', makerShare: 'rest share', chaseTicks: 're-price', sizeJitter: 'size varies', timeJitter: 'time varies', maxPart: 'max of volume', finish: 'at the end',
  lookback: 'history', adaptive: 'adaptive', maxChild: 'largest child', endIn: 'stop after',
  displayJitter: 'size varies', offsetTicks: 'offset', refill: 'refill', postOnly: 'post only',
  offsetMode: 'rest', offsetBps: 'behind', timeout: 'give up after', onEnd: 'then',
  distribution: 'size curve', skew: 'skew', spacing: 'spacing', scaleJitter: 'size varies',
  budget: 'budget', dip: 'dip', dipMult: 'dip size',
  inFlight: 'per wave', waveSec: 'between waves', retries: 'retries',
  trailWhole: 'size', source: 'price', exit: 'exit', chaseSec: 'chase for',
  match: 'when', holdSec: 'hold for', expires: 'expires', thenSlices: 'slices',
  basketStyle: 'each market', dur: 'duration', clips: 'clips',
};

/** Whether the shared rules apply to the kind (a price limit; bounds and the spread guard). */
export const hasLimit = (kind: UiKind): boolean => kind !== 'scale' && kind !== 'trailing' && kind !== 'basket';
export const hasBounds = (kind: UiKind): boolean => hasLimit(kind) && kind !== 'conditional' && kind !== 'bracket';

/**
 * What in the Advanced pop-up differs from the defaults, in a word each: the
 * badge on the Advanced button counts them and its tooltip names them.
 */
export function advancedChanges(kind: UiKind, d: Draft, exits: boolean): string[] {
  const out: string[] = [];
  for (const k of ADVANCED_KEYS[kind]) {
    // Randomize off is the ticket's own switch, not an advanced change.
    if ((k === 'sizeJitter' || k === 'timeJitter') && hasRandomize(kind) && !randomizeOn(kind, d)) continue;
    // A scale's direction is on the ticket; the pop-up's curve and skew count only when tuned past it.
    if (kind === 'scale' && k === 'skew') {
      const sz = scaleSize(d);
      if (sz === 'increasing' || sz === 'decreasing') {
        if (d.distribution === 'exponential') out.push('size curve');
        if (d.skew !== SCALE_SKEW[sz]) out.push('skew');
      }
      continue;
    }
    if (kind === 'basket' && (d.basketStyle === 'twap' ? k === 'clips' || k === 'waveSec' : k === 'slicesAuto')) continue;
    if (k === 'offsetBps' && d.offsetMode !== 'bps') continue;
    if (k === 'offsetTicks' && kind === 'chase' && d.offsetMode === 'bps') continue;
    if (k === 'dipMult' && !opt(d.dip)) continue;
    if (k === 'onEnd' && !opt(d.timeout)) continue;
    if (d[k] !== DEFAULT[k]) out.push(ADV_LABEL[k] ?? k);
  }
  if (exits && kind !== 'bracket' && d.exitsOn) out.push('take-profit / stop-loss');
  if (hasLimit(kind) && opt(d.limitPrice)) out.push('limit');
  if (d.startMode !== 'now') out.push(d.startMode === 'delay' ? 'starts later' : 'starts at a price');
  if (hasBounds(kind)) {
    if (opt(d.upper)) out.push('above');
    if (opt(d.lower)) out.push('below');
    if (opt(d.maxSpread)) out.push('max spread');
  }
  return [...new Set(out)];
}

/**
 * The draft with the kind's advanced settings (and the shared rules) back at
 * their defaults. What the ticket shows stays: Randomize off stays off, a
 * scale's direction stays (at its plain skew).
 */
export function resetAdvanced(kind: UiKind, d: Draft): Draft {
  const x: Draft = { ...d, exitsOn: kind === 'bracket' ? d.exitsOn : false, limitPrice: '', startMode: 'now', upper: '', lower: '', maxSpread: '', upperThen: 'hold', lowerThen: 'hold' };
  for (const k of ADVANCED_KEYS[kind]) (x as unknown as Record<string, unknown>)[k] = DEFAULT[k];
  if (hasRandomize(kind) && !randomizeOn(kind, d)) Object.assign(x, setRandomize(kind, false));
  if (kind === 'scale') {
    const sz = scaleSize(d);
    if (sz === 'increasing' || sz === 'decreasing') Object.assign(x, { distribution: 'linear', skew: SCALE_SKEW[sz] });
  }
  return x;
}

/**
 * The first engine error for any of these spec fields (a key, or a key's
 * children: 'exits' matches 'exits.tpPct'), so a field can show its own.
 */
export function errFor(errors: Record<string, string>, ...keys: string[]): string | undefined {
  for (const [k, v] of Object.entries(errors)) if (keys.some((key) => k === key || k.startsWith(`${key}.`))) return v;
  return undefined;
}

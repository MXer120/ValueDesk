/**
 * Algo specs: defaults, validation and the canonical form that is signed.
 *
 * One parser for the order ticket, the browser runner and every executor, so
 * a spec one of them accepts is accepted by all. It rebuilds the spec field
 * by field: unknown keys are dropped, numbers are numbers, quantities are
 * canonical decimals - so `canonicalJSON(parseAlgoSpec(x))` is the exact text
 * a wallet signs and an executor stores.
 */
import { canonicalDecimal } from '../../../sodex-core/src/index.ts';
import { DEFAULT_EXEC } from './math.ts';
import {
  ALGO_KINDS,
  type AlgoBase,
  type AlgoKind,
  type AlgoSpec,
  type BoundAction,
  type Condition,
  type ConditionalAction,
  type ExecSpec,
  type PriceBound,
  type PriceSource,
  type Side,
} from './types.ts';

export class AlgoSpecError extends Error {
  override name = 'AlgoSpecError';
  constructor(
    message: string,
    readonly errors: Record<string, string>,
  ) {
    super(message);
  }
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const ALGO_LIMITS = {
  twap: { durationMs: { min: MIN, max: 30 * DAY }, slices: { min: 1, max: 2000 }, minIntervalMs: 5_000 },
  vwap: { durationMs: { min: 15 * MIN, max: 7 * DAY }, slices: { min: 2, max: 2000 }, lookbackDays: { min: 1, max: 56 }, minIntervalMs: 5_000 },
  pov: { rate: { min: 0.01, max: 0.5 } },
  iceberg: { refillMs: { min: 0, max: 10 * MIN } },
  chase: { offsetTicks: { min: -5, max: 10_000 }, offsetBps: { min: 0, max: 2_000 }, chaseTicks: { min: 1, max: 10_000 }, maxChaseBps: { min: 1, max: 5_000 }, timeoutMs: { min: 5_000, max: 7 * DAY }, minRepriceMs: { min: 250, max: MIN } },
  scale: { orders: { min: 2, max: 100 }, skew: { min: 0.1, max: 10 }, sizeJitter: { min: 0, max: 0.3 } },
  dca: { perOrderUsd: { min: 10, max: 1_000_000 }, orders: { min: 2, max: 1000 }, intervalMs: { min: MIN, max: 30 * DAY }, dipPct: { min: 0.01, max: 0.9 }, dipMultiplier: { min: 1, max: 5 } },
  swarm: { clips: { min: 2, max: 200 }, inFlight: { min: 1, max: 20 }, waveMs: { min: 0, max: MIN }, sizeJitter: { min: 0, max: 0.9 }, retries: { min: 0, max: 5 } },
  conditional: { conditions: { min: 1, max: 5 }, holdMs: { min: 0, max: HOUR }, windowMs: { min: 5_000, max: HOUR } },
  trailing: { trailPct: { min: 0.001, max: 0.5 }, chaseMs: { min: 1_000, max: 10 * MIN } },
  exec: { slippageBps: { min: 1, max: 500 }, offsetTicks: { min: -5, max: 10_000 }, chaseTicks: { min: 1, max: 10_000 }, makerShare: { min: 0.1, max: 0.95 } },
  jitter: { min: 0, max: 0.5 },
  maxSpreadBps: { min: 1, max: 5_000 },
  leverage: { min: 1, max: 100 },
  label: 40,
} as const;

/* ---------------------------------------------------------------- readers ----- */

type Errors = Record<string, string>;
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

function num(o: Obj, key: string, label: string, lim: { min: number; max: number }, e: Errors, path = key): number {
  const raw = o[key];
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    e[path] = `${label} must be a number.`;
    return NaN;
  }
  if (n < lim.min || n > lim.max) e[path] = `${label} must be between ${lim.min} and ${lim.max}.`;
  return n;
}

function int(o: Obj, key: string, label: string, lim: { min: number; max: number }, e: Errors, path = key): number {
  const n = num(o, key, label, lim, e, path);
  if (Number.isFinite(n) && !Number.isInteger(n)) e[path] = `${label} must be a whole number.`;
  return n;
}

function opt(o: Obj, key: string, label: string, lim: { min: number; max: number }, e: Errors, path = key): number | null {
  const v = o[key];
  if (v === null || v === undefined || v === '') return null;
  return num(o, key, label, lim, e, path);
}

function price(o: Obj, key: string, label: string, e: Errors, path = key): number {
  const raw = o[key];
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > 1e12) {
    e[path] = `${label} must be a price above 0.`;
    return NaN;
  }
  return n;
}

function optPrice(o: Obj, key: string, label: string, e: Errors, path = key): number | null {
  const v = o[key];
  if (v === null || v === undefined || v === '') return null;
  return price(o, key, label, e, path);
}

function time(o: Obj, key: string, label: string, e: Errors, path = key): number | null {
  const v = o[key];
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1_500_000_000_000 || n > 4_000_000_000_000) {
    e[path] = `${label} must be a time.`;
    return null;
  }
  return n;
}

function qty(o: Obj, key: string, label: string, e: Errors, path = key): string {
  const raw = o[key];
  const s = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d+(\.\d+)?$/.test(s) || !(Number(s) > 0)) {
    e[path] = `${label} must be a positive amount.`;
    return '0';
  }
  if (Number(s) > 1e12) {
    e[path] = `${label} is too large.`;
    return '0';
  }
  return canonicalDecimal(s);
}

function optQty(o: Obj, key: string, label: string, e: Errors, path = key): string | null {
  const v = o[key];
  if (v === null || v === undefined || v === '') return null;
  return qty(o, key, label, e, path);
}

function oneOf<T extends string>(o: Obj, key: string, label: string, allowed: readonly T[], fallback: T, e: Errors, path = key): T {
  const v = o[key];
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
  e[path] = `${label} must be one of ${allowed.join(', ')}.`;
  return fallback;
}

const bool = (o: Obj, key: string, fallback = false): boolean => (typeof o[key] === 'boolean' ? (o[key] as boolean) : fallback);

const SYMBOL = /^[A-Z0-9]{1,24}-USD$/;

function symbol(o: Obj, key: string, e: Errors, path = key): string {
  const s = typeof o[key] === 'string' ? (o[key] as string).trim().toUpperCase() : '';
  if (!SYMBOL.test(s)) e[path] = 'Choose a SoDEX perps market (like BTC-USD).';
  return s;
}

const BOUND_ACTIONS: readonly BoundAction[] = ['hold', 'stop', 'rush'];

function bound(o: Obj, key: string, label: string, e: Errors): PriceBound | null {
  const v = o[key];
  if (v === null || v === undefined) return null;
  if (!isObj(v)) {
    e[key] = `${label} must be a price and what to do there.`;
    return null;
  }
  return { price: price(v, 'price', `${label} price`, e, `${key}.price`), then: oneOf(v, 'then', `${label} action`, BOUND_ACTIONS, 'hold', e, `${key}.then`) };
}

function exec(v: unknown, e: Errors, path: string): ExecSpec {
  const o = isObj(v) ? v : {};
  const L = ALGO_LIMITS.exec;
  return {
    style: oneOf(o, 'style', 'Execution', ['taker', 'maker', 'hybrid'] as const, DEFAULT_EXEC.style, e, `${path}.style`),
    slippageBps: o.slippageBps === undefined ? DEFAULT_EXEC.slippageBps : num(o, 'slippageBps', 'Max slippage', L.slippageBps, e, `${path}.slippageBps`),
    offsetTicks: o.offsetTicks === undefined ? DEFAULT_EXEC.offsetTicks : int(o, 'offsetTicks', 'Offset', L.offsetTicks, e, `${path}.offsetTicks`),
    chaseTicks: o.chaseTicks === undefined ? DEFAULT_EXEC.chaseTicks : int(o, 'chaseTicks', 'Re-price distance', L.chaseTicks, e, `${path}.chaseTicks`),
    makerShare: o.makerShare === undefined ? DEFAULT_EXEC.makerShare : num(o, 'makerShare', 'Resting share', L.makerShare, e, `${path}.makerShare`),
  };
}

function base(o: Obj, kind: AlgoKind, e: Errors): AlgoBase {
  const label = typeof o.label === 'string' ? o.label.trim().slice(0, ALGO_LIMITS.label) : '';
  const marginMode = o.marginMode === null || o.marginMode === undefined ? null : oneOf(o, 'marginMode', 'Margin mode', ['cross', 'isolated'] as const, 'cross', e);
  const b: AlgoBase = {
    kind,
    symbol: symbol(o, 'symbol', e),
    side: oneOf<Side>(o, 'side', 'Side', ['buy', 'sell'], 'buy', e),
    reduceOnly: bool(o, 'reduceOnly'),
    limitPrice: optPrice(o, 'limitPrice', 'Limit price', e),
    upper: bound(o, 'upper', 'Upper bound', e),
    lower: bound(o, 'lower', 'Lower bound', e),
    triggerPrice: optPrice(o, 'triggerPrice', 'Start price', e),
    startAt: time(o, 'startAt', 'Start time', e),
    maxSpreadBps: opt(o, 'maxSpreadBps', 'Max spread', ALGO_LIMITS.maxSpreadBps, e),
    leverage: o.leverage === null || o.leverage === undefined || o.leverage === '' ? null : int(o, 'leverage', 'Leverage', ALGO_LIMITS.leverage, e),
    marginMode,
    paper: bool(o, 'paper'),
    label: label || null,
  };
  if (b.upper && b.lower && b.upper.price <= b.lower.price) e.upper = 'The upper bound must be above the lower bound.';
  return b;
}

/* -------------------------------------------------------------- conditions ----- */

const SOURCES: readonly PriceSource[] = ['mark', 'last', 'mid', 'index'];

function condition(v: unknown, e: Errors, path: string): Condition | null {
  if (!isObj(v)) {
    e[path] = 'Each condition needs a type.';
    return null;
  }
  const L = ALGO_LIMITS.conditional;
  const type = v.type;
  const sym = () => symbol(v, 'symbol', e, `${path}.symbol`);
  const src = () => oneOf(v, 'source', 'Price source', SOURCES, 'mark', e, `${path}.source`);
  const op = () => oneOf(v, 'op', 'Comparison', ['above', 'below'] as const, 'above', e, `${path}.op`);
  const dir3 = () => oneOf(v, 'dir', 'Direction', ['up', 'down', 'either'] as const, 'either', e, `${path}.dir`);
  const pct = () => num(v, 'pct', 'Move', { min: 0.0001, max: 10 }, e, `${path}.pct`);
  const win = () => int(v, 'windowMs', 'Window', L.windowMs, e, `${path}.windowMs`);
  switch (type) {
    case 'price':
      return { type, symbol: sym(), source: src(), op: op(), value: price(v, 'value', 'Price', e, `${path}.value`) };
    case 'cross':
      return { type, symbol: sym(), source: src(), dir: oneOf(v, 'dir', 'Direction', ['up', 'down'] as const, 'up', e, `${path}.dir`), value: price(v, 'value', 'Price', e, `${path}.value`) };
    case 'move':
      return { type, symbol: sym(), source: src(), dir: dir3(), pct: pct(), windowMs: win() };
    case 'funding':
      return { type, symbol: sym(), op: op(), value: num(v, 'value', 'Funding rate', { min: -1, max: 1 }, e, `${path}.value`) };
    case 'oi':
      return { type, symbol: sym(), dir: dir3(), pct: pct(), windowMs: win() };
    case 'spread':
      return { type, symbol: sym(), op: op(), bps: num(v, 'bps', 'Spread', { min: 0, max: 10_000 }, e, `${path}.bps`) };
    case 'volume':
      return { type, symbol: sym(), windowMs: win(), aboveUsd: num(v, 'aboveUsd', 'Volume', { min: 1, max: 1e12 }, e, `${path}.aboveUsd`) };
    case 'ratio': {
      const other = symbol(v, 'other', e, `${path}.other`);
      return { type, symbol: sym(), other, op: op(), value: num(v, 'value', 'Ratio', { min: 1e-12, max: 1e12 }, e, `${path}.value`) };
    }
    case 'time': {
      const at = time(v, 'at', 'Time', e, `${path}.at`);
      return { type, at: at ?? 0 };
    }
    default:
      e[path] = 'Unknown condition.';
      return null;
  }
}

function action(v: unknown, e: Errors, depth: number): ConditionalAction {
  const o = isObj(v) ? v : {};
  const t = o.type;
  if (t === 'market') return { type: t, quantity: qty(o, 'quantity', 'Size', e, 'then.quantity'), slippageBps: num(o, 'slippageBps', 'Max slippage', ALGO_LIMITS.exec.slippageBps, e, 'then.slippageBps') };
  if (t === 'limit') return { type: t, quantity: qty(o, 'quantity', 'Size', e, 'then.quantity'), price: price(o, 'price', 'Price', e, 'then.price'), postOnly: bool(o, 'postOnly') };
  if (t === 'close') return { type: t, share: num(o, 'share', 'Share of the position', { min: 0.01, max: 1 }, e, 'then.share'), slippageBps: num(o, 'slippageBps', 'Max slippage', ALGO_LIMITS.exec.slippageBps, e, 'then.slippageBps') };
  if (t === 'algo') {
    if (depth > 0) {
      e.then = 'A conditional cannot start another conditional.';
      return { type: 'market', quantity: '0', slippageBps: 30 };
    }
    const inner = checkAlgoSpec(o.algo, depth + 1);
    for (const [k, m] of Object.entries(inner.errors)) e[`then.algo.${k}`] = m;
    if (inner.spec?.kind === 'conditional') e.then = 'A conditional cannot start another conditional.';
    return { type: 'algo', algo: (inner.spec ?? { kind: 'twap' }) as Exclude<AlgoSpec, { kind: 'conditional' }> };
  }
  e.then = 'Choose what happens when the conditions hold.';
  return { type: 'market', quantity: '0', slippageBps: 30 };
}

/* ------------------------------------------------------------------ specs ----- */

export interface AlgoSpecCheck {
  spec: AlgoSpec | null;
  errors: Record<string, string>;
}

/** Validate an algo spec; every problem is named by its field. */
export function checkAlgoSpec(input: unknown, depth = 0): AlgoSpecCheck {
  const e: Errors = {};
  if (!isObj(input)) return { spec: null, errors: { kind: 'Choose an order type.' } };
  const kind = input.kind as AlgoKind;
  if (!ALGO_KINDS.includes(kind)) return { spec: null, errors: { kind: 'Unknown order type.' } };
  const o = input;
  const b = base(o, kind, e);
  const jit = (key: string, label: string) => (o[key] === undefined ? 0 : num(o, key, label, ALGO_LIMITS.jitter, e));
  const finish = () => oneOf(o, 'finish', 'At the end', ['take', 'leave'] as const, 'take', e);
  let spec: AlgoSpec;
  switch (kind) {
    case 'twap': {
      const L = ALGO_LIMITS.twap;
      const durationMs = int(o, 'durationMs', 'Duration', L.durationMs, e);
      const slices = int(o, 'slices', 'Slices', L.slices, e);
      if (durationMs / slices < L.minIntervalMs) e.slices = `At most one slice every ${L.minIntervalMs / 1000} s: use at most ${Math.floor(durationMs / L.minIntervalMs)} slices.`;
      spec = {
        ...b,
        kind,
        quantity: qty(o, 'quantity', 'Size', e),
        durationMs,
        slices,
        urgency: o.urgency === undefined ? 0 : num(o, 'urgency', 'Urgency', { min: -1, max: 1 }, e),
        sizeJitter: jit('sizeJitter', 'Size randomisation'),
        timeJitter: jit('timeJitter', 'Time randomisation'),
        exec: exec(o.exec, e, 'exec'),
        finish: finish(),
        maxParticipation: opt(o, 'maxParticipation', 'Max participation', { min: 0.01, max: 1 }, e),
      };
      break;
    }
    case 'vwap': {
      const L = ALGO_LIMITS.vwap;
      const durationMs = int(o, 'durationMs', 'Duration', L.durationMs, e);
      const slices = int(o, 'slices', 'Slices', L.slices, e);
      if (durationMs / slices < L.minIntervalMs) e.slices = `At most one slice every ${L.minIntervalMs / 1000} s: use at most ${Math.floor(durationMs / L.minIntervalMs)} slices.`;
      spec = {
        ...b,
        kind,
        quantity: qty(o, 'quantity', 'Size', e),
        durationMs,
        slices,
        lookbackDays: int(o, 'lookbackDays', 'History', L.lookbackDays, e),
        adaptive: bool(o, 'adaptive', true),
        sizeJitter: jit('sizeJitter', 'Size randomisation'),
        exec: exec(o.exec, e, 'exec'),
        finish: finish(),
        maxParticipation: opt(o, 'maxParticipation', 'Max participation', { min: 0.01, max: 1 }, e),
      };
      break;
    }
    case 'pov':
      spec = {
        ...b,
        kind,
        quantity: qty(o, 'quantity', 'Size', e),
        rate: num(o, 'rate', 'Participation', ALGO_LIMITS.pov.rate, e),
        maxChildQty: optQty(o, 'maxChildQty', 'Largest child', e),
        endAt: time(o, 'endAt', 'End time', e),
        exec: exec(o.exec, e, 'exec'),
        finish: finish(),
      };
      break;
    case 'iceberg': {
      const quantity = qty(o, 'quantity', 'Size', e);
      const displayQty = qty(o, 'displayQty', 'Visible size', e);
      if (Number(displayQty) > Number(quantity)) e.displayQty = 'The visible size cannot be more than the whole size.';
      spec = {
        ...b,
        kind,
        quantity,
        displayQty,
        displayJitter: jit('displayJitter', 'Visible size randomisation'),
        price: optPrice(o, 'price', 'Price', e),
        pegOffsetTicks: o.pegOffsetTicks === undefined ? 0 : int(o, 'pegOffsetTicks', 'Offset', ALGO_LIMITS.chase.offsetTicks, e),
        chaseTicks: o.chaseTicks === undefined ? 2 : int(o, 'chaseTicks', 'Re-price distance', ALGO_LIMITS.chase.chaseTicks, e),
        postOnly: bool(o, 'postOnly', true),
        refillMs: o.refillMs === undefined ? 0 : int(o, 'refillMs', 'Refill delay', ALGO_LIMITS.iceberg.refillMs, e),
        refillJitter: o.refillJitter === undefined ? 0 : num(o, 'refillJitter', 'Refill randomisation', { min: 0, max: 1 }, e),
      };
      break;
    }
    case 'chase': {
      const L = ALGO_LIMITS.chase;
      spec = {
        ...b,
        kind,
        quantity: qty(o, 'quantity', 'Size', e),
        offsetTicks: o.offsetTicks === undefined ? 0 : int(o, 'offsetTicks', 'Offset', L.offsetTicks, e),
        offsetBps: opt(o, 'offsetBps', 'Offset', L.offsetBps, e),
        chaseTicks: o.chaseTicks === undefined ? 1 : int(o, 'chaseTicks', 'Re-price distance', L.chaseTicks, e),
        maxChaseBps: opt(o, 'maxChaseBps', 'Max chase', L.maxChaseBps, e),
        timeoutMs: opt(o, 'timeoutMs', 'Time limit', L.timeoutMs, e),
        onEnd: oneOf(o, 'onEnd', 'At the end', ['take', 'cancel', 'rest'] as const, 'take', e),
        minRepriceMs: o.minRepriceMs === undefined ? 1_000 : int(o, 'minRepriceMs', 'Re-price pause', L.minRepriceMs, e),
      };
      break;
    }
    case 'scale': {
      const L = ALGO_LIMITS.scale;
      const from = price(o, 'from', 'First price', e);
      const to = price(o, 'to', 'Last price', e);
      if (from === to) e.to = 'The last price must differ from the first.';
      spec = {
        ...b,
        kind,
        quantity: qty(o, 'quantity', 'Size', e),
        from,
        to,
        orders: int(o, 'orders', 'Orders', L.orders, e),
        distribution: oneOf(o, 'distribution', 'Size curve', ['flat', 'linear', 'exponential', 'bell'] as const, 'flat', e),
        skew: o.skew === undefined ? 1 : num(o, 'skew', 'Size skew', L.skew, e),
        spacing: oneOf(o, 'spacing', 'Price spacing', ['linear', 'geometric', 'front', 'back'] as const, 'linear', e),
        sizeJitter: o.sizeJitter === undefined ? 0 : num(o, 'sizeJitter', 'Size randomisation', L.sizeJitter, e),
        postOnly: bool(o, 'postOnly'),
      };
      break;
    }
    case 'dca': {
      const L = ALGO_LIMITS.dca;
      const perOrderUsd = num(o, 'perOrderUsd', 'Amount per order', L.perOrderUsd, e);
      const maxTotalUsd = opt(o, 'maxTotalUsd', 'Total budget', { min: 10, max: 1e9 }, e);
      if (maxTotalUsd !== null && maxTotalUsd < perOrderUsd) e.maxTotalUsd = 'The budget must cover at least one order.';
      spec = {
        ...b,
        kind,
        perOrderUsd,
        orders: int(o, 'orders', 'Orders', L.orders, e),
        intervalMs: int(o, 'intervalMs', 'Every', L.intervalMs, e),
        outOfBand: oneOf(o, 'outOfBand', 'Outside the limit', ['skip', 'wait'] as const, 'skip', e),
        dipPct: opt(o, 'dipPct', 'Dip', L.dipPct, e),
        dipMultiplier: o.dipMultiplier === undefined ? 1 : num(o, 'dipMultiplier', 'Dip multiplier', L.dipMultiplier, e),
        maxTotalUsd,
        exec: exec(o.exec ?? { style: 'taker' }, e, 'exec'),
      };
      break;
    }
    case 'swarm': {
      const L = ALGO_LIMITS.swarm;
      spec = {
        ...b,
        kind,
        quantity: qty(o, 'quantity', 'Size', e),
        clips: int(o, 'clips', 'Clips', L.clips, e),
        inFlight: int(o, 'inFlight', 'Clips per wave', L.inFlight, e),
        waveMs: int(o, 'waveMs', 'Between waves', L.waveMs, e),
        sizeJitter: o.sizeJitter === undefined ? 0 : num(o, 'sizeJitter', 'Irregular clips', L.sizeJitter, e),
        slippageBps: num(o, 'slippageBps', 'Max slippage', ALGO_LIMITS.exec.slippageBps, e),
        retries: o.retries === undefined ? 2 : int(o, 'retries', 'Retries', L.retries, e),
      };
      break;
    }
    case 'conditional': {
      const L = ALGO_LIMITS.conditional;
      const list = Array.isArray(o.conditions) ? o.conditions : [];
      if (list.length < L.conditions.min || list.length > L.conditions.max) e.conditions = `Add 1 to ${L.conditions.max} conditions.`;
      const conditions = list.slice(0, L.conditions.max).map((c, i) => condition(c, e, `conditions.${i}`)).filter((c): c is Condition => c !== null);
      spec = {
        ...b,
        kind,
        match: oneOf(o, 'match', 'Match', ['all', 'any'] as const, 'all', e),
        conditions,
        holdMs: o.holdMs === undefined ? 0 : int(o, 'holdMs', 'Hold for', L.holdMs, e),
        expiresAt: time(o, 'expiresAt', 'Expiry', e),
        then: action(o.then, e, depth),
      };
      break;
    }
    case 'trailing': {
      const L = ALGO_LIMITS.trailing;
      const trailPct = opt(o, 'trailPct', 'Trail', L.trailPct, e);
      const trailAbs = optPrice(o, 'trailAbs', 'Trail', e);
      if ((trailPct === null) === (trailAbs === null)) e.trailPct = 'Set the trail as a percentage or as a price distance (one of the two).';
      spec = {
        ...b,
        kind,
        quantity: optQty(o, 'quantity', 'Size', e),
        trailPct,
        trailAbs,
        activationPrice: optPrice(o, 'activationPrice', 'Activation price', e),
        source: oneOf(o, 'source', 'Price', ['mark', 'last'] as const, 'mark', e),
        exit: oneOf(o, 'exit', 'Exit', ['market', 'chase'] as const, 'market', e),
        chaseMs: o.chaseMs === undefined ? 15_000 : int(o, 'chaseMs', 'Chase for', L.chaseMs, e),
        slippageBps: o.slippageBps === undefined ? 50 : num(o, 'slippageBps', 'Max slippage', ALGO_LIMITS.exec.slippageBps, e),
      };
      if (spec.quantity === null) spec.reduceOnly = true;
      break;
    }
  }
  return { spec: Object.keys(e).length ? null : spec, errors: e };
}

/** Validate, or throw an AlgoSpecError naming the first problem. */
export function parseAlgoSpec(input: unknown): AlgoSpec {
  const r = checkAlgoSpec(input);
  if (!r.spec) {
    const first = Object.values(r.errors)[0] ?? 'The order is not valid.';
    throw new AlgoSpecError(first, r.errors);
  }
  return r.spec;
}

/** The total base quantity an algo works, where it is fixed up front (dca and position-sized orders: null). */
export function algoQuantity(s: AlgoSpec): number | null {
  switch (s.kind) {
    case 'dca':
      return null;
    case 'trailing':
      return s.quantity === null ? null : Number(s.quantity);
    case 'conditional':
      return s.then.type === 'market' || s.then.type === 'limit' ? Number(s.then.quantity) : null;
    default:
      return Number(s.quantity);
  }
}

/** Every market an algo watches (its own, those its conditions name, and those of the algo it starts). */
export function algoSymbols(s: AlgoSpec): string[] {
  const out = new Set<string>([s.symbol]);
  if (s.kind === 'conditional') {
    for (const c of s.conditions) {
      if (c.type === 'time') continue;
      out.add(c.symbol);
      if (c.type === 'ratio') out.add(c.other);
    }
    if (s.then.type === 'algo') for (const x of algoSymbols(s.then.algo)) out.add(x);
  }
  return [...out];
}

export const ALGO_NAMES: Readonly<Record<AlgoKind, string>> = {
  twap: 'TWAP',
  vwap: 'VWAP',
  pov: 'POV',
  iceberg: 'Iceberg',
  chase: 'Chase',
  scale: 'Scale',
  dca: 'DCA',
  swarm: 'Swarm',
  conditional: 'Conditional',
  trailing: 'Trailing stop',
};

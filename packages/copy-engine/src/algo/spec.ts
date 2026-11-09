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
import { DEFAULT_EXEC, withinLimit } from './math.ts';
import { isOracleVenue } from '../oracle.ts';
import { validZone } from './bots.ts';
import {
  ALGO_KINDS,
  type AlgoBase,
  type AlgoKind,
  type AlgoSpec,
  type BotLimits,
  type MmSpec,
  type FlowGate,
  type QuietWindow,
  type NewsGate,
  BOT_KINDS,
  type ScaleSpec,
  type SweepSpec,
  type BoundAction,
  type Condition,
  type ConditionalAction,
  SLIP_FROM,
  type ExecSpec,
  type Exits,
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
  scale: { orders: { min: 2, max: 100 }, skew: { min: 0.001, max: 1000 }, sizeJitter: { min: 0, max: 0.3 } },
  dca: { perOrderUsd: { min: 10, max: 1_000_000 }, orders: { min: 2, max: 1000 }, intervalMs: { min: MIN, max: 30 * DAY }, dipPct: { min: 0.01, max: 0.9 }, dipMultiplier: { min: 1, max: 5 } },
  swarm: { clips: { min: 2, max: 200 }, inFlight: { min: 1, max: 20 }, waveMs: { min: 0, max: MIN }, sizeJitter: { min: 0, max: 0.9 }, retries: { min: 0, max: 5 } },
  conditional: { conditions: { min: 1, max: 5 }, holdMs: { min: 0, max: HOUR }, windowMs: { min: 5_000, max: HOUR } },
  trailing: { trailPct: { min: 0.001, max: 0.5 }, chaseMs: { min: 1_000, max: 10 * MIN } },
  basket: { legs: { min: 2, max: 10 }, legUsd: { min: 10, max: 10_000_000 } },
  sweep: { slippageBps: { min: 1, max: 1_000 }, roundMs: { min: 500, max: MIN }, timeoutMs: { min: 5_000, max: DAY } },
  mm: { orderUsd: { min: 10, max: 100_000 }, maxInventoryUsd: { min: 10, max: 1_000_000 }, offsetTicks: { min: -1, max: 1_000 }, chaseTicks: { min: 1, max: 1_000 }, minRepriceMs: { min: 1_000, max: MIN }, skewTicks: { min: 0, max: 1_000 }, edgeBps: { min: 0, max: 100 }, queueGuard: { min: 0, max: 0.5 }, levels: { min: 1, max: 5 }, moveGuard: { min: 0, max: 100 }, refBps: { min: 0, max: 50 }, pullBps: { min: 0, max: 20 }, placeBps: { min: 0, max: 20 }, calmBps: { min: 0, max: 20 }, calmMs: { min: 50, max: 10_000 }, stillBps: { min: 0, max: 500 }, stillMs: { min: 1_000, max: 120_000 }, restMs: { min: 500, max: 120_000 }, flowMinUsd: { min: 1_000, max: 100_000_000 }, flowWindowMs: { min: MIN, max: HOUR }, flowShrink: { min: 0.1, max: 1 }, quietWindows: 6 },
  grid: { levels: { min: 3, max: 60 }, orderUsd: { min: 10, max: 100_000 } },
  bot: { volumeTargetUsd: { min: 100, max: 1e10 }, maxLossUsd: { min: 1, max: 1e8 } },
  exitPct: { min: 0.001, max: 10 },
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

/** MmSpec.flowGate: null when absent (or null). */
function flowGate(o: Obj, e: Errors): FlowGate | null {
  const raw = o.flowGate;
  if (raw === undefined || raw === null) return null;
  if (!isObj(raw)) {
    e.flowGate = 'The patient-taker gate must be an object (minUsd, windowMs, action, shrink).';
    return null;
  }
  const L = ALGO_LIMITS.mm;
  const minUsd = num(raw, 'minUsd', 'Patient-taker volume', L.flowMinUsd, e, 'flowGate.minUsd');
  const windowMs = raw.windowMs === undefined || raw.windowMs === null ? 600_000 : int(raw, 'windowMs', 'Patient-taker window', L.flowWindowMs, e, 'flowGate.windowMs');
  const action = oneOf(raw, 'action', 'When it is quiet', ['pause', 'shrink'] as const, 'pause', e, 'flowGate.action');
  const shrink = raw.shrink === undefined || raw.shrink === null ? 0.5 : num(raw, 'shrink', 'Smaller size', L.flowShrink, e, 'flowGate.shrink');
  return { minUsd, windowMs, action, shrink };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** MmSpec.quiet: null when absent, null or empty. */
function quietWindows(o: Obj, e: Errors): QuietWindow[] | null {
  const raw = o.quiet;
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) {
    e.quiet = 'Quiet windows must be a list.';
    return null;
  }
  if (!raw.length) return null;
  const most = ALGO_LIMITS.mm.quietWindows;
  if (raw.length > most) {
    e.quiet = `At most ${most} quiet windows.`;
    return null;
  }
  const out: QuietWindow[] = [];
  raw.forEach((w: unknown, i) => {
    const path = `quiet.${i}`;
    if (!isObj(w)) {
      e[path] = `Quiet window ${i + 1} must be an object (from, to, zone, days).`;
      return;
    }
    for (const k of ['from', 'to'] as const) if (typeof w[k] !== 'string' || !HHMM.test(w[k] as string)) e[`${path}.${k}`] = `Quiet window ${i + 1}: ${k === 'from' ? 'the start' : 'the end'} must be a time like 09:30 (24 h).`;
    if (typeof w.from === 'string' && w.from === w.to) e[`${path}.to`] = `Quiet window ${i + 1}: the end must differ from the start.`;
    // utc, new_york, london, or any IANA time zone (owner 2026-11-08: time zones everywhere).
    const z = w.zone === undefined || w.zone === null || w.zone === '' ? 'utc' : w.zone;
    if (!validZone(z)) e[`${path}.zone`] = `Quiet window ${i + 1}: the time zone must be utc, new_york, london or a time zone name such as Europe/Berlin.`;
    const zone = validZone(z) ? z : 'utc';
    const days = oneOf(w, 'days', `Quiet window ${i + 1}: the days`, ['all', 'weekdays', 'trading'] as const, 'all', e, `${path}.days`);
    out.push({ from: String(w.from), to: String(w.to), zone, days });
  });
  return out;
}

/** MmSpec.news: null when absent or null. */
function newsGate(o: Obj, e: Errors): NewsGate | null {
  const raw = o.news;
  if (raw === undefined || raw === null) return null;
  if (!isObj(raw)) {
    e.news = 'The news gate must be an object (beforeMin, afterMin, level).';
    return null;
  }
  const beforeMin = int(raw, 'beforeMin', 'Minutes before a release', { min: 0, max: 240 }, e, 'news.beforeMin');
  const afterMin = int(raw, 'afterMin', 'Minutes after a release', { min: 0, max: 240 }, e, 'news.afterMin');
  if (beforeMin + afterMin <= 0) e['news.afterMin'] = 'The news gate needs some minutes before or after a release.';
  const level = oneOf(raw, 'level', 'Which releases', ['high', 'medium'] as const, 'high', e, 'news.level');
  return { beforeMin, afterMin, level };
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
    // Only when given: a spec without it measures from the touch, as before.
    ...(o.slipFrom === undefined ? {} : { slipFrom: oneOf(o, 'slipFrom', 'Slippage from', SLIP_FROM, 'touch', e, `${path}.slipFrom`) }),
  };
}

function exits(o: Obj, side: Side, e: Errors): Exits | null {
  const v = o.exits;
  if (v === null || v === undefined) return null;
  if (!isObj(v)) {
    e.exits = 'Exits must be a take-profit and/or a stop-loss.';
    return null;
  }
  const x: Exits = {
    tpPrice: optPrice(v, 'tpPrice', 'Take-profit price', e, 'exits.tpPrice'),
    slPrice: optPrice(v, 'slPrice', 'Stop-loss price', e, 'exits.slPrice'),
    tpPct: opt(v, 'tpPct', 'Take-profit distance', ALGO_LIMITS.exitPct, e, 'exits.tpPct'),
    slPct: opt(v, 'slPct', 'Stop-loss distance', { min: ALGO_LIMITS.exitPct.min, max: 0.99 }, e, 'exits.slPct'),
  };
  if (x.tpPrice !== null && x.tpPct !== null) e['exits.tpPct'] = 'Set the take-profit as a price or a distance, not both.';
  if (x.slPrice !== null && x.slPct !== null) e['exits.slPct'] = 'Set the stop-loss as a price or a distance, not both.';
  if (x.tpPrice !== null && x.slPrice !== null && (side === 'buy' ? x.tpPrice <= x.slPrice : x.tpPrice >= x.slPrice)) {
    e['exits.tpPrice'] = side === 'buy' ? 'A long\'s take-profit must be above its stop-loss.' : 'A short\'s take-profit must be below its stop-loss.';
  }
  // A short's take-profit 100% or more under its entry would be at or below 0: it would have none at all.
  if (side === 'sell' && x.tpPct !== null && x.tpPct >= 1) e['exits.tpPct'] = 'A short\'s take-profit distance must be under 100%.';
  return x.tpPrice === null && x.slPrice === null && x.tpPct === null && x.slPct === null ? null : x;
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
    exits: null,
  };
  b.exits = exits(o, b.side, e);
  if (b.exits && b.reduceOnly) e.exits = 'A reduce-only order opens nothing to protect: no exits on it.';
  // Only when true, so a spec from before bots keeps its canonical text (what was signed).
  // (A bot DCA, started before 2026-11-02 when the owner took it off the Bots page, keeps its stored spec; none starts now.)
  if (BOT_KINDS.includes(kind)) b.bot = true;
  else if (o.bot === true) e.bot = kind === 'dca' ? 'A DCA runs as an algo order, not a bot: start it from the order ticket.' : 'Only a volume maker or a grid runs as a bot.';
  if (b.bot && b.exits) e.exits = 'A bot places no take-profit or stop-loss: set a loss limit instead.';
  // A volume maker and a grid buy and sell: one limit price would stop one side only. Their range is the bounds (hold or stop).
  if (BOT_KINDS.includes(kind) && b.limitPrice !== null) e.limitPrice = 'A bot buys and sells: it has no limit price. Use the bounds to hold or stop it.';
  if (BOT_KINDS.includes(kind) && (b.upper?.then === 'rush' || b.lower?.then === 'rush')) e[b.upper?.then === 'rush' ? 'upper' : 'lower'] = 'A bot has nothing to rush: hold or stop it at a bound.';
  if (b.upper && b.lower && b.upper.price <= b.lower.price) e.upper = 'The upper bound must be above the lower bound.';
  return b;
}

/**
 * A bot's limits: volume target, loss limit, end time, what happens to what it holds when it stops. A real bot
 * (not practice) must have a loss limit (audit 2026-11-08): it trades unattended with real money, and the loss
 * limit is what stops it when the market runs against what it holds.
 */
function botLimits(o: Obj, e: Errors, paper: boolean): BotLimits {
  const L = ALGO_LIMITS.bot;
  const maxLossUsd = opt(o, 'maxLossUsd', 'Loss limit', L.maxLossUsd, e);
  if (!paper && maxLossUsd === null && !e.maxLossUsd) e.maxLossUsd = 'A real bot needs a loss limit: set the most it may lose before it stops.';
  return {
    volumeTargetUsd: opt(o, 'volumeTargetUsd', 'Volume target', L.volumeTargetUsd, e),
    maxLossUsd,
    endAt: time(o, 'endAt', 'End time', e),
    onStop: oneOf(o, 'onStop', 'When it stops', ['close', 'keep'] as const, 'close', e),
    // Post-only unless switched off (kept out of the spec while on, so a spec from before reads the same).
    ...(o.postOnly === false ? { postOnly: false as const } : o.postOnly === undefined || o.postOnly === true || o.postOnly === null ? {} : (e.postOnly = 'Post-only is on or off (true or false).', {})),
  };
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
    case 'position': {
      const pop = oneOf(v, 'op', 'Position', ['long', 'short', 'flat', 'sizeAbove', 'sizeBelow', 'pnlAbove', 'pnlBelow'] as const, 'long', e, `${path}.op`);
      const needs = pop === 'sizeAbove' || pop === 'sizeBelow' || pop === 'pnlAbove' || pop === 'pnlBelow';
      const value = needs ? num(v, 'value', pop.startsWith('pnl') ? 'PnL' : 'Size', pop.startsWith('pnl') ? { min: -1e12, max: 1e12 } : { min: 0, max: 1e12 }, e, `${path}.value`) : 0;
      return { type, symbol: sym(), op: pop, value };
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
    if (inner.spec && BOT_KINDS.includes(inner.spec.kind)) e.then = 'A conditional cannot start a bot: start it from the Bots page.';
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
      const closeShare = opt(o, 'closeShare', 'Share of the position', { min: 0.01, max: 1 }, e);
      const minSliceQty = optQty(o, 'minSliceQty', 'Smallest slice', e);
      const maxSliceQty = optQty(o, 'maxSliceQty', 'Largest slice', e);
      if (minSliceQty !== null && maxSliceQty !== null && Number(minSliceQty) > Number(maxSliceQty)) e.minSliceQty = 'The smallest slice cannot be larger than the largest.';
      if (closeShare !== null && b.exits) e.exits = 'A close opens nothing to protect: no exits on it.';
      spec = {
        ...b,
        kind,
        // A time-sliced close takes its size from the position when it starts: always reduce-only.
        reduceOnly: closeShare !== null ? true : b.reduceOnly,
        quantity: closeShare !== null ? '0' : qty(o, 'quantity', 'Size', e),
        closeShare,
        minSliceQty,
        maxSliceQty,
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
      // A fixed price past the limit price would send every clip past it.
      if (spec.price !== null && Number.isFinite(spec.price) && !withinLimit(b.side, spec.price, b.limitPrice)) e.price = `The price is past your limit price of ${b.limitPrice}.`;
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
      // Explicit levels (a DCA ladder): positive, distinct, as many as the orders; sizes alongside, positive.
      if (Array.isArray(o.prices)) {
        const ps = (o.prices as unknown[]).map(Number);
        if (ps.length < L.orders.min || ps.length > L.orders.max) e.prices = `Between ${L.orders.min} and ${L.orders.max} prices.`;
        else if (ps.some((x) => !Number.isFinite(x) || x <= 0)) e.prices = 'Every price must be a positive number.';
        else if (new Set(ps).size !== ps.length) e.prices = 'Each price only once.';
        else {
          const sc = spec as ScaleSpec;
          sc.prices = ps;
          sc.from = ps[0]!;
          sc.to = ps[ps.length - 1]!;
          sc.orders = ps.length;
          delete e.from;
          delete e.to;
          delete e.orders;
          if (Array.isArray(o.weights)) {
            const ws = (o.weights as unknown[]).map(Number);
            if (ws.length !== ps.length || ws.some((x) => !Number.isFinite(x) || x <= 0)) e.weights = 'One positive size per price.';
            else {
              sc.weights = ws;
              // The sizes are spelled out: the skew only describes them (for an executor that predates explicit levels), so its range does not apply.
              if (e.skew && Number.isFinite(sc.skew) && sc.skew > 0) delete e.skew;
            }
          }
        }
      }
      {
        // Every level rests at its own price: one past the limit price would buy above it (sell below it).
        const sc = spec as ScaleSpec;
        const levels = sc.prices?.length ? sc.prices : [sc.from, sc.to];
        if (levels.every(Number.isFinite) && levels.some((p) => !withinLimit(b.side, p, b.limitPrice))) e.limitPrice = `Some levels of the ladder are past your limit price of ${b.limitPrice}.`;
      }
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
      // A limit order it places rests at its price: one past the limit price would buy above it (sell below it).
      if (spec.then.type === 'limit' && Number.isFinite(spec.then.price) && !withinLimit(b.side, spec.then.price, b.limitPrice)) e['then.price'] = `The price is past your limit price of ${b.limitPrice}.`;
      if (b.exits && (spec.then.type === 'close' || spec.then.type === 'algo')) e.exits = spec.then.type === 'close' ? 'A close opens nothing to protect: no exits on it.' : 'Set the exits on the algo it starts.';
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
      // A trailing stop closes a position (or buys the turn): exits on it would never be placed.
      if (b.exits) e.exits = 'A trailing stop places no exits: set them on the order that opens the position.';
      break;
    }
    case 'basket': {
      const L = ALGO_LIMITS.basket;
      const raw = Array.isArray(o.legs) ? o.legs : [];
      if (raw.length < L.legs.min || raw.length > L.legs.max) e.legs = `A basket has ${L.legs.min} to ${L.legs.max} markets.`;
      const legs = raw.slice(0, L.legs.max).map((x, i) => {
        const v = isObj(x) ? x : {};
        return {
          symbol: symbol(v, 'symbol', e, `legs.${i}.symbol`),
          side: oneOf<Side>(v, 'side', 'Side', ['buy', 'sell'], 'buy', e, `legs.${i}.side`),
          usd: num(v, 'usd', 'Amount', L.legUsd, e, `legs.${i}.usd`),
        };
      });
      if (new Set(legs.map((l) => l.symbol)).size !== legs.length) e.legs = 'Each market once in a basket.';
      if (b.exits) e.exits = 'Exits are set per market: not on a basket.';
      const style = oneOf(o, 'style', 'Each leg', ['swarm', 'twap'] as const, 'swarm', e);
      const durationMs = style === 'twap' ? int(o, 'durationMs', 'Duration', ALGO_LIMITS.twap.durationMs, e) : 0;
      const slices = style === 'twap' ? int(o, 'slices', 'Slices', ALGO_LIMITS.twap.slices, e) : 0;
      if (style === 'twap' && durationMs / slices < ALGO_LIMITS.twap.minIntervalMs) e.slices = `At most one slice every ${ALGO_LIMITS.twap.minIntervalMs / 1000} s.`;
      spec = {
        ...b,
        kind,
        symbol: legs[0]?.symbol ?? b.symbol,
        side: legs[0]?.side ?? b.side,
        legs,
        style,
        durationMs,
        slices,
        clips: style === 'swarm' ? int(o, 'clips', 'Clips', ALGO_LIMITS.swarm.clips, e) : 0,
        inFlight: style === 'swarm' ? int(o, 'inFlight', 'Clips per wave', ALGO_LIMITS.swarm.inFlight, e) : 0,
        waveMs: style === 'swarm' ? int(o, 'waveMs', 'Between waves', ALGO_LIMITS.swarm.waveMs, e) : 0,
        slippageBps: num(o, 'slippageBps', 'Max slippage', ALGO_LIMITS.exec.slippageBps, e),
      };
      break;
    }
    case 'sweep': {
      const L = ALGO_LIMITS.sweep;
      spec = {
        ...b,
        kind,
        quantity: qty(o, 'quantity', 'Size', e),
        slippageBps: num(o, 'slippageBps', 'Max slippage', L.slippageBps, e),
        roundMs: o.roundMs === undefined ? 500 : int(o, 'roundMs', 'Between rounds', L.roundMs, e),
        timeoutMs: opt(o, 'timeoutMs', 'Give up after', L.timeoutMs, e),
      };
      const sw = spec as SweepSpec;
      if (o.reference !== undefined) sw.reference = oneOf(o, 'reference', 'Reference price', ['oracleMid', 'oracleFair', 'mark', 'index'] as const, 'oracleMid', e);
      if (o.venues !== undefined) {
        const vs = Array.isArray(o.venues) ? (o.venues as unknown[]) : null;
        if (!vs || !vs.every(isOracleVenue)) e.venues = 'Unknown venue.';
        else if (!vs.length && sw.reference !== 'mark' && sw.reference !== 'index') e.venues = 'Choose at least one venue.';
        else sw.venues = [...new Set(vs)];
      }
      break;
    }
    case 'mm': {
      const L = ALGO_LIMITS.mm;
      const orderUsd = num(o, 'orderUsd', 'Order size', L.orderUsd, e);
      const maxInventoryUsd = num(o, 'maxInventoryUsd', 'Inventory cap', L.maxInventoryUsd, e);
      if (Number.isFinite(orderUsd) && Number.isFinite(maxInventoryUsd) && maxInventoryUsd < orderUsd) e.maxInventoryUsd = 'The inventory cap must hold at least one order.';
      if (b.reduceOnly) e.reduceOnly = 'A volume maker quotes both sides: it cannot be reduce-only.';
      spec = {
        ...b,
        ...botLimits(o, e, b.paper),
        kind,
        side: 'buy',
        orderUsd,
        maxInventoryUsd,
        offsetTicks: o.offsetTicks === undefined ? 0 : int(o, 'offsetTicks', 'Distance from the best price', L.offsetTicks, e),
        chaseTicks: o.chaseTicks === undefined ? 2 : int(o, 'chaseTicks', 'Re-price distance', L.chaseTicks, e),
        minRepriceMs: o.minRepriceMs === undefined ? 3_000 : int(o, 'minRepriceMs', 'Re-price pause', L.minRepriceMs, e),
        skewTicks: o.skewTicks === undefined ? 3 : int(o, 'skewTicks', 'Inventory skew', L.skewTicks, e),
      };
      // Only when above 0, so a spec without it keeps its canonical text.
      if (o.edgeBps !== undefined && o.edgeBps !== null && Number(o.edgeBps) !== 0) (spec as MmSpec).edgeBps = num(o, 'edgeBps', 'Distance from the mid', L.edgeBps, e);
      if (o.queueGuard !== undefined && o.queueGuard !== null && Number(o.queueGuard) !== 0) (spec as MmSpec).queueGuard = num(o, 'queueGuard', 'Queue guard', L.queueGuard, e);
      // Only when they change something (above 1 level, above 0 ticks): a spec without them keeps its canonical text.
      if (o.levels !== undefined && o.levels !== null && Number(o.levels) !== 1) (spec as MmSpec).levels = int(o, 'levels', 'Ladder', L.levels, e);
      if (o.moveGuard !== undefined && o.moveGuard !== null && Number(o.moveGuard) !== 0) (spec as MmSpec).moveGuard = num(o, 'moveGuard', 'Move guard', L.moveGuard, e);
      // The Binance-led maker: only Binance today; its two distances only with it.
      if (o.ref !== undefined && o.ref !== null) {
        if (o.ref !== 'binance') e.ref = 'The reference must be binance.';
        else {
          (spec as MmSpec).ref = 'binance';
          if (o.refBps !== undefined && o.refBps !== null && Number(o.refBps) !== 0) (spec as MmSpec).refBps = num(o, 'refBps', 'Distance from the oracle price', L.refBps, e);
          if (o.pullBps !== undefined && o.pullBps !== null && Number(o.pullBps) !== 0) (spec as MmSpec).pullBps = num(o, 'pullBps', 'Pull distance', L.pullBps, e);
          if (o.placeBps !== undefined && o.placeBps !== null && Number(o.placeBps) !== 0) (spec as MmSpec).placeBps = num(o, 'placeBps', 'Send distance', L.placeBps, e);
          if (o.calmBps !== undefined && o.calmBps !== null && Number(o.calmBps) !== 0) {
            (spec as MmSpec).calmBps = num(o, 'calmBps', 'Calm move', L.calmBps, e);
            if (o.calmMs !== undefined && o.calmMs !== null) (spec as MmSpec).calmMs = int(o, 'calmMs', 'Calm window', L.calmMs, e);
          }
          if (o.stillBps !== undefined && o.stillBps !== null && Number(o.stillBps) !== 0) {
            (spec as MmSpec).stillBps = num(o, 'stillBps', 'Still market', L.stillBps, e);
            if (o.stillMs !== undefined && o.stillMs !== null) (spec as MmSpec).stillMs = int(o, 'stillMs', 'Still window', L.stillMs, e);
          }
          if (o.restMs !== undefined && o.restMs !== null && Number(o.restMs) !== 0) (spec as MmSpec).restMs = int(o, 'restMs', 'Longest rest', L.restMs, e);
          if (o.noFair === true) (spec as MmSpec).noFair = true;
          if (o.pauseAfter !== undefined && o.pauseAfter !== null && Number(o.pauseAfter) !== 0) {
            (spec as MmSpec).pauseAfter = int(o, 'pauseAfter', 'Pause after account', { min: 1, max: 100_000_000 }, e);
            (spec as MmSpec).pauseMs = int(o, 'pauseMs', 'Pause', L.restMs, e);
          }
        }
      }
      // With or without ref; only when set, so a spec without them keeps its canonical text.
      const gate = flowGate(o, e);
      if (gate) (spec as MmSpec).flowGate = gate;
      const quiet = quietWindows(o, e);
      if (quiet) (spec as MmSpec).quiet = quiet;
      // Trade only inside the windows: needs at least one.
      if (o.quietOnly === true) {
        if (quiet) (spec as MmSpec).quietOnly = true;
        else e.quiet = 'Trading only in set hours needs at least one window.';
      }
      const news = newsGate(o, e);
      if (news) (spec as MmSpec).news = news;
      break;
    }
    case 'grid': {
      const L = ALGO_LIMITS.grid;
      const low = price(o, 'low', 'Lowest price', e);
      const high = price(o, 'high', 'Highest price', e);
      if (Number.isFinite(low) && Number.isFinite(high) && high <= low) e.high = 'The highest price must be above the lowest.';
      if (b.reduceOnly) e.reduceOnly = 'A grid buys and sells: it cannot be reduce-only.';
      spec = {
        ...b,
        ...botLimits(o, e, b.paper),
        kind,
        side: 'buy',
        low,
        high,
        levels: int(o, 'levels', 'Levels', L.levels, e),
        orderUsd: num(o, 'orderUsd', 'Order size', L.orderUsd, e),
        spacing: oneOf(o, 'spacing', 'Spacing', ['linear', 'geometric'] as const, 'geometric', e),
        outOfRange: oneOf(o, 'outOfRange', 'Out of the range', ['wait', 'stop'] as const, 'wait', e),
      };
      break;
    }
    case 'bracket': {
      const entry = oneOf(o, 'entry', 'Entry', ['market', 'limit'] as const, 'market', e);
      if (!b.exits) e.exits = 'A bracket needs a take-profit, a stop-loss, or both.';
      spec = {
        ...b,
        kind,
        quantity: qty(o, 'quantity', 'Size', e),
        entry,
        price: entry === 'limit' ? price(o, 'price', 'Entry price', e) : null,
        slippageBps: o.slippageBps === undefined ? 30 : num(o, 'slippageBps', 'Max slippage', ALGO_LIMITS.exec.slippageBps, e),
      };
      // A limit entry rests at its price: one past the limit price would buy above it (sell below it).
      if (spec.price !== null && Number.isFinite(spec.price) && !withinLimit(b.side, spec.price, b.limitPrice)) e.price = `The entry price is past your limit price of ${b.limitPrice}.`;
      break;
    }
  }
  return { spec: Object.keys(e).length ? null : spec, errors: e };
}

/**
 * Whether an algo can only make a position smaller: reduce-only itself (a close, a whole-position trailing
 * stop), or a conditional whose action closes or starts an algo that does. A close-only place (the US, the
 * UK, Canada) may run exactly these - its users can close any position (owner, 2026-10-29); everything else
 * is held there (policy.ts RegionPolicy.closeOnly, runtime.ts).
 */
export const algoClosesOnly = (s: AlgoSpec): boolean =>
  s.reduceOnly || (s.kind === 'conditional' && (s.then.type === 'close' || (s.then.type === 'algo' && algoClosesOnly(s.then.algo))));

/** Whether an algo opens (or adds to) a position, so exits can follow it. */
export const opensPosition = (s: AlgoSpec): boolean =>
  !s.reduceOnly && s.kind !== 'trailing' && s.kind !== 'basket' && !(s.kind === 'conditional' && (s.then.type === 'close' || s.then.type === 'algo'));

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
    case 'basket':
    case 'mm':
    case 'grid':
      return null;
    case 'twap':
      return s.closeShare !== null ? null : Number(s.quantity);
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
  if (s.kind === 'basket') for (const l of s.legs) out.add(l.symbol);
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
  basket: 'Basket',
  bracket: 'Bracket',
  sweep: 'Fill fast',
  mm: 'Volume maker',
  grid: 'Grid',
};

/** Started from the Bots page: keeps a bot book and carries the bot builder fee (policy.ts BOT_FEE). */
export const isBotSpec = (s: AlgoSpec): boolean => s.bot === true;

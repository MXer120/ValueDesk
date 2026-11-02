/**
 * Every option of every algo kind, through the one parser the ticket, the
 * browser runner and every executor share (spec.ts checkAlgoSpec): each
 * numeric field at its smallest and largest value (accepted) and just past
 * either (refused, the error named by its field), whole numbers where the
 * field takes only those, every value of every choice (kept as given) and an
 * unknown one (refused), the defaults of what is left out, and every pair of
 * options that cannot go together. docs/COVERAGE-ALGOS.md lists where each
 * option is also exercised at run time and on the exchange.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALGO_KINDS, BOT_KINDS, ALGO_LIMITS, ORACLE_VENUES, SLIP_FROM, algoClosesOnly, algoQuantity, algoSymbols, canonicalJSON, checkAlgoSpec, opensPosition, parseAlgoSpec, type AlgoKind, type AlgoSpec } from '../src/index.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = 1_800_000_000_000;

/** One valid spec per kind, as small as the parser takes it: each case below changes one thing. */
const BASE: Record<AlgoKind, Record<string, unknown>> = {
  twap: { kind: 'twap', symbol: 'BTC-USD', side: 'buy', quantity: '0.01', durationMs: 10 * MIN, slices: 10 },
  vwap: { kind: 'vwap', symbol: 'BTC-USD', side: 'buy', quantity: '0.01', durationMs: HOUR, slices: 12, lookbackDays: 7 },
  pov: { kind: 'pov', symbol: 'BTC-USD', side: 'buy', quantity: '0.01', rate: 0.1 },
  iceberg: { kind: 'iceberg', symbol: 'BTC-USD', side: 'buy', quantity: '0.01', displayQty: '0.001' },
  chase: { kind: 'chase', symbol: 'BTC-USD', side: 'buy', quantity: '0.01' },
  scale: { kind: 'scale', symbol: 'BTC-USD', side: 'buy', quantity: '0.01', from: 60_000, to: 58_000, orders: 5 },
  dca: { kind: 'dca', symbol: 'BTC-USD', side: 'buy', perOrderUsd: 20, orders: 5, intervalMs: HOUR },
  swarm: { kind: 'swarm', symbol: 'BTC-USD', side: 'buy', quantity: '0.01', clips: 5, inFlight: 2, waveMs: 1_000, slippageBps: 20 },
  conditional: { kind: 'conditional', symbol: 'BTC-USD', side: 'buy', conditions: [{ type: 'price', symbol: 'BTC-USD', source: 'mark', op: 'above', value: 60_000 }], then: { type: 'market', quantity: '0.01', slippageBps: 20 } },
  trailing: { kind: 'trailing', symbol: 'BTC-USD', side: 'sell', trailPct: 0.01 },
  basket: { kind: 'basket', symbol: 'BTC-USD', side: 'buy', legs: [{ symbol: 'BTC-USD', side: 'buy', usd: 100 }, { symbol: 'ETH-USD', side: 'sell', usd: 100 }], style: 'swarm', clips: 4, inFlight: 2, waveMs: 1_000, slippageBps: 20 },
  bracket: { kind: 'bracket', symbol: 'BTC-USD', side: 'buy', quantity: '0.01', entry: 'market', exits: { tpPct: 0.02 } },
  sweep: { kind: 'sweep', symbol: 'BTC-USD', side: 'buy', quantity: '0.01', slippageBps: 10 },
  mm: { kind: 'mm', symbol: 'BTC-USD', orderUsd: 20, maxInventoryUsd: 100 },
  grid: { kind: 'grid', symbol: 'BTC-USD', low: 55_000, high: 65_000, levels: 10, orderUsd: 20 },
};

const accepted = (x: Record<string, unknown>, what: string): AlgoSpec => {
  const r = checkAlgoSpec(x);
  assert.ok(r.spec, `${what}: accepted (${JSON.stringify(r.errors)})`);
  return r.spec;
};
const refused = (x: Record<string, unknown>, path: string, what: string, re?: RegExp): void => {
  const r = checkAlgoSpec(x);
  assert.equal(r.spec, null, `${what}: refused`);
  assert.ok(path in r.errors, `${what}: the error is named ${path} (${JSON.stringify(r.errors)})`);
  if (re) assert.match(r.errors[path]!, re, what);
};

/** Set a dotted path ('exec.slippageBps', 'then.share', 'conditions.0.pct') on a copy. */
function withPath(base: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const out = structuredClone(base);
  const keys = path.split('.');
  let o: Record<string, unknown> = out;
  for (const k of keys.slice(0, -1)) {
    o[k] = o[k] && typeof o[k] === 'object' ? o[k] : {};
    o = o[k] as Record<string, unknown>;
  }
  o[keys[keys.length - 1]!] = value;
  return out;
}

function getPath(spec: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), spec);
}

/* --------------------------------------------------------------- numbers ----- */

interface NumCase {
  kind: AlgoKind;
  path: string;
  min: number;
  max: number;
  int?: boolean;
  /** Changes the base so the bounds alone decide (a duration long enough for the most slices...). */
  over?: Record<string, unknown>;
  /** Not given: past the bound is refused; with `belowOk` the value under the minimum is the parser's own null (empty / off). */
  noBelow?: boolean;
}

const L = ALGO_LIMITS;
const NUMBERS: NumCase[] = [
  // Every kind's shared rules (on a TWAP).
  { kind: 'twap', path: 'maxSpreadBps', ...L.maxSpreadBps },
  { kind: 'twap', path: 'leverage', ...L.leverage, int: true },
  // Execution of a slice.
  { kind: 'twap', path: 'exec.slippageBps', ...L.exec.slippageBps },
  { kind: 'twap', path: 'exec.offsetTicks', ...L.exec.offsetTicks, int: true },
  { kind: 'twap', path: 'exec.chaseTicks', ...L.exec.chaseTicks, int: true },
  { kind: 'twap', path: 'exec.makerShare', ...L.exec.makerShare },
  // TWAP.
  { kind: 'twap', path: 'durationMs', ...L.twap.durationMs, int: true, over: { slices: 1 } },
  { kind: 'twap', path: 'slices', ...L.twap.slices, int: true, over: { durationMs: 30 * DAY } },
  { kind: 'twap', path: 'closeShare', min: 0.01, max: 1, over: { quantity: undefined } },
  { kind: 'twap', path: 'urgency', min: -1, max: 1 },
  { kind: 'twap', path: 'sizeJitter', ...L.jitter },
  { kind: 'twap', path: 'timeJitter', ...L.jitter },
  { kind: 'twap', path: 'maxParticipation', min: 0.01, max: 1 },
  // VWAP.
  { kind: 'vwap', path: 'durationMs', ...L.vwap.durationMs, int: true, over: { slices: 2 } },
  { kind: 'vwap', path: 'slices', ...L.vwap.slices, int: true, over: { durationMs: 7 * DAY } },
  { kind: 'vwap', path: 'lookbackDays', ...L.vwap.lookbackDays, int: true },
  { kind: 'vwap', path: 'sizeJitter', ...L.jitter },
  { kind: 'vwap', path: 'maxParticipation', min: 0.01, max: 1 },
  { kind: 'vwap', path: 'exec.makerShare', ...L.exec.makerShare },
  // POV.
  { kind: 'pov', path: 'rate', ...L.pov.rate },
  { kind: 'pov', path: 'exec.slippageBps', ...L.exec.slippageBps },
  // Iceberg.
  { kind: 'iceberg', path: 'displayJitter', ...L.jitter },
  { kind: 'iceberg', path: 'pegOffsetTicks', ...L.chase.offsetTicks, int: true },
  { kind: 'iceberg', path: 'chaseTicks', ...L.chase.chaseTicks, int: true },
  { kind: 'iceberg', path: 'refillMs', ...L.iceberg.refillMs, int: true },
  { kind: 'iceberg', path: 'refillJitter', min: 0, max: 1 },
  // Chase.
  { kind: 'chase', path: 'offsetTicks', ...L.chase.offsetTicks, int: true },
  { kind: 'chase', path: 'offsetBps', ...L.chase.offsetBps },
  { kind: 'chase', path: 'chaseTicks', ...L.chase.chaseTicks, int: true },
  { kind: 'chase', path: 'maxChaseBps', ...L.chase.maxChaseBps },
  { kind: 'chase', path: 'timeoutMs', ...L.chase.timeoutMs },
  { kind: 'chase', path: 'minRepriceMs', ...L.chase.minRepriceMs, int: true },
  // Scale.
  { kind: 'scale', path: 'orders', ...L.scale.orders, int: true },
  { kind: 'scale', path: 'skew', ...L.scale.skew },
  { kind: 'scale', path: 'sizeJitter', ...L.scale.sizeJitter },
  // DCA.
  { kind: 'dca', path: 'perOrderUsd', ...L.dca.perOrderUsd },
  { kind: 'dca', path: 'orders', ...L.dca.orders, int: true },
  { kind: 'dca', path: 'intervalMs', ...L.dca.intervalMs, int: true },
  { kind: 'dca', path: 'dipPct', ...L.dca.dipPct },
  { kind: 'dca', path: 'dipMultiplier', ...L.dca.dipMultiplier },
  { kind: 'dca', path: 'maxTotalUsd', min: 20, max: 1e9 },
  { kind: 'dca', path: 'exec.slippageBps', ...L.exec.slippageBps },
  // Swarm.
  { kind: 'swarm', path: 'clips', ...L.swarm.clips, int: true },
  { kind: 'swarm', path: 'inFlight', ...L.swarm.inFlight, int: true },
  { kind: 'swarm', path: 'waveMs', ...L.swarm.waveMs, int: true },
  { kind: 'swarm', path: 'sizeJitter', ...L.swarm.sizeJitter },
  { kind: 'swarm', path: 'slippageBps', ...L.exec.slippageBps },
  { kind: 'swarm', path: 'retries', ...L.swarm.retries, int: true },
  // Conditional.
  { kind: 'conditional', path: 'holdMs', ...L.conditional.holdMs, int: true },
  { kind: 'conditional', path: 'then.slippageBps', ...L.exec.slippageBps },
  { kind: 'conditional', path: 'conditions.0.pct', min: 0.0001, max: 10, over: { conditions: [{ type: 'move', symbol: 'BTC-USD', source: 'mark', dir: 'up', pct: 0.01, windowMs: MIN }] } },
  { kind: 'conditional', path: 'conditions.0.windowMs', ...L.conditional.windowMs, int: true, over: { conditions: [{ type: 'oi', symbol: 'BTC-USD', dir: 'up', pct: 0.01, windowMs: MIN }] } },
  { kind: 'conditional', path: 'conditions.0.value', min: -1, max: 1, over: { conditions: [{ type: 'funding', symbol: 'BTC-USD', op: 'above', value: 0 }] } },
  { kind: 'conditional', path: 'conditions.0.bps', min: 0, max: 10_000, over: { conditions: [{ type: 'spread', symbol: 'BTC-USD', op: 'below', bps: 5 }] } },
  { kind: 'conditional', path: 'conditions.0.aboveUsd', min: 1, max: 1e12, over: { conditions: [{ type: 'volume', symbol: 'BTC-USD', windowMs: MIN, aboveUsd: 1_000 }] } },
  { kind: 'conditional', path: 'conditions.0.value', min: 1e-12, max: 1e12, over: { conditions: [{ type: 'ratio', symbol: 'ETH-USD', other: 'BTC-USD', op: 'above', value: 0.05 }] } },
  { kind: 'conditional', path: 'conditions.0.value', min: 0, max: 1e12, over: { conditions: [{ type: 'position', symbol: 'BTC-USD', op: 'sizeAbove', value: 0.1 }] } },
  { kind: 'conditional', path: 'conditions.0.value', min: -1e12, max: 1e12, over: { conditions: [{ type: 'position', symbol: 'BTC-USD', op: 'pnlBelow', value: -10 }] } },
  { kind: 'conditional', path: 'then.share', min: 0.01, max: 1, over: { then: { type: 'close', share: 1, slippageBps: 20 } } },
  // Trailing stop.
  { kind: 'trailing', path: 'trailPct', ...L.trailing.trailPct },
  { kind: 'trailing', path: 'chaseMs', ...L.trailing.chaseMs, int: true },
  { kind: 'trailing', path: 'slippageBps', ...L.exec.slippageBps },
  // Basket.
  { kind: 'basket', path: 'legs.0.usd', ...L.basket.legUsd },
  { kind: 'basket', path: 'clips', ...L.swarm.clips, int: true },
  { kind: 'basket', path: 'inFlight', ...L.swarm.inFlight, int: true },
  { kind: 'basket', path: 'waveMs', ...L.swarm.waveMs, int: true },
  { kind: 'basket', path: 'slippageBps', ...L.exec.slippageBps },
  { kind: 'basket', path: 'durationMs', ...L.twap.durationMs, int: true, over: { style: 'twap', slices: 1, durationMs: HOUR } },
  { kind: 'basket', path: 'slices', ...L.twap.slices, int: true, over: { style: 'twap', durationMs: 30 * DAY, slices: 2 } },
  // Bracket.
  { kind: 'bracket', path: 'slippageBps', ...L.exec.slippageBps },
  { kind: 'bracket', path: 'exits.tpPct', ...L.exitPct },
  { kind: 'bracket', path: 'exits.slPct', min: L.exitPct.min, max: 0.99, over: { exits: { slPct: 0.02 } } },
  // Fill fast.
  { kind: 'sweep', path: 'slippageBps', ...L.sweep.slippageBps },
  { kind: 'sweep', path: 'roundMs', ...L.sweep.roundMs, int: true },
  { kind: 'sweep', path: 'timeoutMs', ...L.sweep.timeoutMs },
];

for (const c of NUMBERS) {
  test(`numbers: ${c.kind} ${c.path} takes ${c.min} .. ${c.max}${c.int ? ' (whole)' : ''}, and nothing past either end`, () => {
    const base = { ...BASE[c.kind], ...(c.over ?? {}) };
    const at = (v: unknown) => withPath(base, c.path, v);
    const s1 = accepted(at(c.min), `${c.path} = ${c.min}`);
    const s2 = accepted(at(c.max), `${c.path} = ${c.max}`);
    assert.equal(getPath(s1, c.path), c.min, `${c.path} kept as ${c.min}`);
    assert.equal(getPath(s2, c.path), c.max, `${c.path} kept as ${c.max}`);
    // A number typed as text is the number (a form's input).
    assert.equal(getPath(accepted(at(String(c.max)), `${c.path} = "${c.max}"`), c.path), c.max);
    const eps = c.int ? 1 : Math.max(Math.abs(c.min), Math.abs(c.max), 1) * 1e-6;
    if (!c.noBelow) refused(at(c.min - (c.int ? 1 : Math.max(Math.abs(c.min) * 1e-3, 1e-6))), c.path, `${c.path} under ${c.min}`, /between|must be|must cover/);
    refused(at(c.max + eps), c.path, `${c.path} over ${c.max}`, /between|must be/);
    refused(at('abc'), c.path, `${c.path} = "abc"`, /must be a number/);
    if (c.int) refused(at(c.min + 0.5), c.path, `${c.path} = ${c.min + 0.5}`, /whole number/);
  });
}

/* ----------------------------------------------------------------- prices ----- */

const PRICES: Array<{ kind: AlgoKind; path: string; over?: Record<string, unknown>; optional?: boolean }> = [
  { kind: 'twap', path: 'limitPrice', optional: true },
  { kind: 'twap', path: 'triggerPrice', optional: true },
  { kind: 'twap', path: 'upper.price' },
  { kind: 'twap', path: 'lower.price' },
  { kind: 'twap', path: 'exits.tpPrice', optional: true },
  { kind: 'twap', path: 'exits.slPrice', optional: true },
  { kind: 'iceberg', path: 'price', optional: true },
  { kind: 'scale', path: 'from' },
  { kind: 'scale', path: 'to' },
  { kind: 'conditional', path: 'conditions.0.value' },
  { kind: 'conditional', path: 'then.price', over: { then: { type: 'limit', quantity: '0.01', price: 59_000, postOnly: true } } },
  { kind: 'trailing', path: 'trailAbs', over: { trailPct: null } },
  { kind: 'trailing', path: 'activationPrice', optional: true },
  { kind: 'bracket', path: 'price', over: { entry: 'limit' } },
];

for (const c of PRICES) {
  test(`prices: ${c.kind} ${c.path} is a price above 0 (0, negative, text, over 1e12 refused)${c.optional ? '; empty is none' : ''}`, () => {
    const base = { ...BASE[c.kind], ...(c.over ?? {}) };
    const at = (v: unknown) => withPath(base, c.path, v);
    // A bound needs its action; an exit price on the right side of the other.
    const ok = c.path === 'exits.slPrice' ? 1 : c.path === 'from' ? 61_000 : 1000;
    accepted(at(ok), `${c.path} = ${ok}`);
    for (const bad of [0, -5, 'x', 2e12]) refused(at(bad), c.path, `${c.path} = ${bad}`, /price above 0/);
    if (c.optional) {
      const s = accepted(at(null), `${c.path} = null`);
      const top = c.path.split('.')[0]!;
      // An exits object with nothing left in it is no exits at all.
      if (top === 'exits') assert.equal(s.exits, null);
      else assert.equal(getPath(s, c.path), null);
      accepted(at(''), `${c.path} = ''`);
    }
  });
}

/* ---------------------------------------------------------------- choices ----- */

const CHOICES: Array<{ kind: AlgoKind; path: string; values: readonly string[]; over?: Record<string, unknown>; fallback?: string }> = [
  { kind: 'twap', path: 'side', values: ['buy', 'sell'], fallback: 'buy' },
  { kind: 'twap', path: 'marginMode', values: ['cross', 'isolated'] },
  { kind: 'twap', path: 'upper.then', values: ['hold', 'stop', 'rush'], over: { upper: { price: 70_000 } }, fallback: 'hold' },
  { kind: 'twap', path: 'lower.then', values: ['hold', 'stop', 'rush'], over: { lower: { price: 50_000 } }, fallback: 'hold' },
  // Left out, a slice rests first (math.ts DEFAULT_EXEC); the ticket always sends its own (taker by default).
  { kind: 'twap', path: 'exec.style', values: ['taker', 'maker', 'hybrid'], fallback: 'hybrid' },
  { kind: 'twap', path: 'exec.slipFrom', values: SLIP_FROM },
  { kind: 'twap', path: 'finish', values: ['take', 'leave'], fallback: 'take' },
  { kind: 'vwap', path: 'finish', values: ['take', 'leave'], fallback: 'take' },
  { kind: 'vwap', path: 'exec.style', values: ['taker', 'maker', 'hybrid'] },
  { kind: 'pov', path: 'finish', values: ['take', 'leave'], fallback: 'take' },
  { kind: 'pov', path: 'exec.style', values: ['taker', 'maker', 'hybrid'] },
  { kind: 'pov', path: 'exec.slipFrom', values: SLIP_FROM },
  { kind: 'dca', path: 'exec.style', values: ['taker', 'maker', 'hybrid'] },
  { kind: 'dca', path: 'outOfBand', values: ['skip', 'wait'], fallback: 'skip' },
  { kind: 'chase', path: 'onEnd', values: ['take', 'cancel', 'rest'], fallback: 'take' },
  { kind: 'scale', path: 'distribution', values: ['flat', 'linear', 'exponential', 'bell'], fallback: 'flat' },
  { kind: 'scale', path: 'spacing', values: ['linear', 'geometric', 'front', 'back'], fallback: 'linear' },
  { kind: 'conditional', path: 'match', values: ['all', 'any'], fallback: 'all' },
  { kind: 'conditional', path: 'conditions.0.source', values: ['mark', 'last', 'mid', 'index'], fallback: 'mark' },
  { kind: 'conditional', path: 'conditions.0.op', values: ['above', 'below'], fallback: 'above' },
  { kind: 'conditional', path: 'conditions.0.dir', values: ['up', 'down'], over: { conditions: [{ type: 'cross', symbol: 'BTC-USD', source: 'mark', dir: 'up', value: 60_000 }] }, fallback: 'up' },
  { kind: 'conditional', path: 'conditions.0.dir', values: ['up', 'down', 'either'], over: { conditions: [{ type: 'move', symbol: 'BTC-USD', source: 'mark', dir: 'up', pct: 0.01, windowMs: MIN }] }, fallback: 'either' },
  { kind: 'conditional', path: 'conditions.0.dir', values: ['up', 'down', 'either'], over: { conditions: [{ type: 'oi', symbol: 'BTC-USD', dir: 'up', pct: 0.01, windowMs: MIN }] }, fallback: 'either' },
  { kind: 'conditional', path: 'conditions.0.op', values: ['long', 'short', 'flat', 'sizeAbove', 'sizeBelow', 'pnlAbove', 'pnlBelow'], over: { conditions: [{ type: 'position', symbol: 'BTC-USD', op: 'long', value: 1 }] }, fallback: 'long' },
  { kind: 'trailing', path: 'source', values: ['mark', 'last'], fallback: 'mark' },
  { kind: 'trailing', path: 'exit', values: ['market', 'chase'], fallback: 'market' },
  { kind: 'basket', path: 'style', values: ['swarm', 'twap'], over: { durationMs: HOUR, slices: 6 }, fallback: 'swarm' },
  { kind: 'basket', path: 'legs.1.side', values: ['buy', 'sell'], fallback: 'buy' },
  { kind: 'bracket', path: 'entry', values: ['market', 'limit'], over: { price: 59_000 }, fallback: 'market' },
  { kind: 'sweep', path: 'reference', values: ['oracleMid', 'oracleFair', 'mark', 'index'] },
];

for (const c of CHOICES) {
  test(`choices: ${c.kind} ${c.path} takes ${c.values.join(' / ')}${c.fallback ? `, left out it is ${c.fallback}` : ''}, and nothing else`, () => {
    const base = { ...BASE[c.kind], ...(c.over ?? {}) };
    for (const v of c.values) {
      const s = accepted(withPath(base, c.path, v), `${c.path} = ${v}`);
      assert.equal(getPath(s, c.path), v, `${c.path} kept as ${v}`);
    }
    refused(withPath(base, c.path, 'sideways'), c.path, `${c.path} = sideways`, /must be one of/);
    if (c.fallback) {
      const s = accepted(withPath(base, c.path, undefined), `${c.path} left out`);
      assert.equal(getPath(s, c.path), c.fallback);
    }
  });
}

test('choices: every condition type parses (and an unknown one is refused)', () => {
  const conds = [
    { type: 'price', symbol: 'BTC-USD', source: 'index', op: 'below', value: 50_000 },
    { type: 'cross', symbol: 'BTC-USD', source: 'last', dir: 'down', value: 50_000 },
    { type: 'move', symbol: 'BTC-USD', source: 'mid', dir: 'either', pct: 0.02, windowMs: 5 * MIN },
    { type: 'funding', symbol: 'BTC-USD', op: 'below', value: -0.0001 },
    { type: 'oi', symbol: 'BTC-USD', dir: 'down', pct: 0.05, windowMs: HOUR },
    { type: 'spread', symbol: 'BTC-USD', op: 'above', bps: 3 },
    { type: 'volume', symbol: 'ETH-USD', windowMs: 10 * MIN, aboveUsd: 1e6 },
    { type: 'ratio', symbol: 'ETH-USD', other: 'BTC-USD', op: 'below', value: 0.04 },
    { type: 'position', symbol: 'ETH-USD', op: 'flat' },
    { type: 'time', at: T0 },
  ];
  // At most five at once: two specs.
  const s1 = accepted({ ...BASE.conditional, match: 'any', conditions: conds.slice(0, 5) }, 'five conditions');
  const s2 = accepted({ ...BASE.conditional, conditions: conds.slice(5) }, 'five more');
  assert.deepEqual([...(s1 as Extract<AlgoSpec, { kind: 'conditional' }>).conditions, ...(s2 as Extract<AlgoSpec, { kind: 'conditional' }>).conditions].map((c) => c.type), conds.map((c) => c.type));
  // Every market a condition names is watched; a time condition names none.
  assert.deepEqual(algoSymbols(s2).sort(), ['BTC-USD', 'ETH-USD']);
  refused({ ...BASE.conditional, conditions: [{ type: 'weather', symbol: 'BTC-USD' }] }, 'conditions.0', 'an unknown condition', /Unknown condition/);
  refused({ ...BASE.conditional, conditions: [] }, 'conditions', 'no condition', /1 to 5/);
  refused({ ...BASE.conditional, conditions: conds.slice(0, 6) }, 'conditions', 'six conditions', /1 to 5/);
  refused({ ...BASE.conditional, conditions: [{ type: 'time', at: 12 }] }, 'conditions.0.at', 'a time that is not a time', /must be a time/);
  refused({ ...BASE.conditional, conditions: [{ type: 'price', symbol: 'btc', op: 'above', value: 1 }] }, 'conditions.0.symbol', 'a market that is no SoDEX market');
  // A position that is long / short / flat needs no value; size and PnL take theirs.
  const p = accepted({ ...BASE.conditional, conditions: [{ type: 'position', symbol: 'BTC-USD', op: 'short', value: 99 }] }, 'short') as Extract<AlgoSpec, { kind: 'conditional' }>;
  assert.equal((p.conditions[0] as { value: number }).value, 0);
});

test('choices: every action of a conditional (market, limit, close, an algo of every other kind); never another conditional', () => {
  const then = (t: Record<string, unknown>) => ({ ...BASE.conditional, then: t });
  accepted(then({ type: 'market', quantity: '0.01', slippageBps: 30 }), 'market');
  const lim = accepted(then({ type: 'limit', quantity: '0.01', price: 59_000 }), 'limit') as Extract<AlgoSpec, { kind: 'conditional' }>;
  assert.equal((lim.then as { postOnly: boolean }).postOnly, false, 'a limit is not post-only unless asked');
  assert.equal((accepted(then({ type: 'limit', quantity: '0.01', price: 59_000, postOnly: true }), 'post-only limit') as Extract<AlgoSpec, { kind: 'conditional' }>).then.type, 'limit');
  const close = accepted({ ...then({ type: 'close', share: 0.5, slippageBps: 30 }), side: 'sell' }, 'close');
  assert.ok(algoClosesOnly(close), 'a conditional close only closes');
  assert.equal(opensPosition(close), false);
  for (const k of ALGO_KINDS.filter((x) => x !== 'conditional' && !BOT_KINDS.includes(x))) {
    const inner = { ...BASE[k] };
    const s = accepted(then({ type: 'algo', algo: inner }), `starts a ${k}`) as Extract<AlgoSpec, { kind: 'conditional' }>;
    assert.equal(s.then.type === 'algo' && s.then.algo.kind, k);
    assert.equal(opensPosition(s), false, 'the algo it starts opens (and carries the exits), not the conditional');
  }
  refused(then({ type: 'algo', algo: BASE.conditional }), 'then', 'a conditional that starts a conditional', /cannot start another conditional/);
  for (const k of BOT_KINDS) refused(then({ type: 'algo', algo: BASE[k] }), 'then', `a conditional that starts a ${k} bot`, /cannot start a bot/);
  refused(then({ type: 'algo', algo: { ...BASE.twap, slices: 0 } }), 'then.algo.slices', 'the inner algo is checked as its own');
  refused(then({ type: 'nap' }), 'then', 'an unknown action', /Choose what happens/);
  refused(then({ type: 'market', quantity: '-1', slippageBps: 30 }), 'then.quantity', 'a negative size');
});

/* ------------------------------------------------------------- quantities ----- */

const QTYS: Array<{ kind: AlgoKind; path: string; optional?: boolean; over?: Record<string, unknown> }> = [
  ...(['twap', 'vwap', 'pov', 'iceberg', 'chase', 'scale', 'swarm', 'bracket', 'sweep'] as const).map((kind) => ({ kind, path: 'quantity' })),
  { kind: 'iceberg', path: 'displayQty' },
  { kind: 'twap', path: 'minSliceQty', optional: true },
  { kind: 'twap', path: 'maxSliceQty', optional: true },
  { kind: 'pov', path: 'maxChildQty', optional: true },
  { kind: 'trailing', path: 'quantity', optional: true },
  { kind: 'conditional', path: 'then.quantity' },
];

for (const c of QTYS) {
  test(`sizes: ${c.kind} ${c.path} is a positive decimal, kept canonical (0, negative, 1e13, '1e-3', text refused)${c.optional ? '; empty is none' : ''}`, () => {
    const base = { ...BASE[c.kind], ...(c.over ?? {}) };
    const at = (v: unknown) => withPath(base, c.path, v);
    assert.equal(getPath(accepted(at('0.00100'), `${c.path} = 0.00100`), c.path), '0.001', 'trailing zeros dropped');
    assert.equal(getPath(accepted(at(0.002), `${c.path} = 0.002`), c.path), '0.002', 'a number becomes its decimal');
    for (const bad of ['0', '-1', '1e-3', 'abc', '1e13', '10000000000000']) refused(at(bad), c.path, `${c.path} = ${bad}`, /positive amount|too large/);
    if (c.optional) assert.equal(getPath(accepted(at(null), `${c.path} = null`), c.path), null);
  });
}

/* --------------------------------------------------------------- the base ----- */

test('base: a SoDEX market (upper-cased, trimmed), a label of at most 40, reduce-only and paper as booleans, times as times', () => {
  const s = accepted({ ...BASE.twap, symbol: ' eth-usd ', label: `  ${'x'.repeat(60)}  `, reduceOnly: true, paper: true, startAt: T0 }, 'all of them');
  assert.equal(s.symbol, 'ETH-USD');
  assert.equal(s.label, 'x'.repeat(40));
  assert.equal(s.reduceOnly, true);
  assert.equal(s.paper, true);
  assert.equal(s.startAt, T0);
  assert.equal(accepted({ ...BASE.twap, label: '   ' }, 'a blank label').label, null);
  assert.equal(accepted({ ...BASE.twap, reduceOnly: 'yes', paper: 1 }, 'not booleans').reduceOnly, false, 'only true is true');
  for (const bad of ['BTC', 'BTC-USDT', 'BTC/USD', '', 42]) refused({ ...BASE.twap, symbol: bad }, 'symbol', `symbol ${bad}`, /SoDEX perps market/);
  for (const bad of [12, 'tomorrow', 5_000_000_000_000]) refused({ ...BASE.twap, startAt: bad }, 'startAt', `startAt ${bad}`, /must be a time/);
  refused({ ...BASE.pov, endAt: 'later' }, 'endAt', 'endAt not a time', /must be a time/);
  refused({ ...BASE.conditional, expiresAt: 3 }, 'expiresAt', 'expiresAt not a time', /must be a time/);
  refused({ ...BASE.twap, upper: 70_000 }, 'upper', 'a bound that is only a number', /price and what to do/);
  refused({ ...BASE.twap, kind: 'lattice' }, 'kind', 'an unknown kind', /Unknown order type/);
  assert.deepEqual(checkAlgoSpec('twap').errors, { kind: 'Choose an order type.' });
  assert.equal(accepted({ ...BASE.twap, marginMode: null, leverage: '' }, 'no margin mode, no leverage').leverage, null);
});

test('base: every kind takes the shared rules a ticket may send, and drops what it does not know', () => {
  // A bot buys and sells: no limit price, nothing to rush (bots below).
  for (const k of ALGO_KINDS.filter((x) => !BOT_KINDS.includes(x))) {
    const s = accepted({ ...BASE[k], limitPrice: 100_000, triggerPrice: 59_000, startAt: T0, maxSpreadBps: 10, leverage: 3, marginMode: 'isolated', label: 'x', surprise: 1, upper: k === 'scale' ? null : { price: 90_000, then: 'stop' }, lower: { price: 1_000, then: 'rush' } }, `${k} with every shared rule`);
    assert.equal(s.kind, k);
    assert.equal('surprise' in s, false, 'an unknown key is dropped');
    assert.equal(s.leverage, 3);
    assert.equal(s.marginMode, 'isolated');
    // The canonical text is the same every time (what a wallet signs).
    assert.equal(canonicalJSON(parseAlgoSpec(s)), canonicalJSON(s));
  }
});

test('base: a bot takes the bounds (hold or stop), the spread guard and leverage; never a limit price or a rush', () => {
  for (const k of BOT_KINDS) {
    const s = accepted({ ...BASE[k], startAt: T0, maxSpreadBps: 10, leverage: 3, label: 'x', surprise: 1, upper: { price: 90_000, then: 'stop' }, lower: { price: 1_000, then: 'hold' } }, `${k} with the shared rules`);
    assert.equal(s.bot, true);
    assert.equal('surprise' in s, false);
    assert.equal(canonicalJSON(parseAlgoSpec(s)), canonicalJSON(s));
    refused({ ...BASE[k], limitPrice: 60_000 }, 'limitPrice', `${k} with a limit price`, /no limit price/);
    refused({ ...BASE[k], lower: { price: 1_000, then: 'rush' } }, 'lower', `${k} with a rush`, /nothing to rush/);
  }
});

/* -------------------------------------------------------------- defaults ----- */

test('defaults: what a spec leaves out', () => {
  const twap = accepted(BASE.twap, 'twap') as Extract<AlgoSpec, { kind: 'twap' }>;
  assert.deepEqual([twap.urgency, twap.sizeJitter, twap.timeJitter, twap.finish, twap.maxParticipation, twap.closeShare, twap.minSliceQty, twap.maxSliceQty], [0, 0, 0, 'take', null, null, null, null]);
  assert.deepEqual(twap.exec, { style: 'hybrid', slippageBps: 30, offsetTicks: 0, chaseTicks: 2, makerShare: 0.6 }, 'the engine default: rest first (the ticket sends taker)');
  assert.equal('slipFrom' in twap.exec, false, 'no slipFrom: measured from the touch, as every spec before it');
  const vwap = accepted(BASE.vwap, 'vwap') as Extract<AlgoSpec, { kind: 'vwap' }>;
  assert.equal(vwap.adaptive, true);
  const ice = accepted(BASE.iceberg, 'iceberg') as Extract<AlgoSpec, { kind: 'iceberg' }>;
  assert.deepEqual([ice.postOnly, ice.price, ice.pegOffsetTicks, ice.chaseTicks, ice.refillMs, ice.refillJitter, ice.displayJitter], [true, null, 0, 2, 0, 0, 0]);
  const chase = accepted(BASE.chase, 'chase') as Extract<AlgoSpec, { kind: 'chase' }>;
  assert.deepEqual([chase.offsetTicks, chase.offsetBps, chase.chaseTicks, chase.maxChaseBps, chase.timeoutMs, chase.onEnd, chase.minRepriceMs], [0, null, 1, null, null, 'take', 1_000]);
  const scale = accepted(BASE.scale, 'scale') as Extract<AlgoSpec, { kind: 'scale' }>;
  assert.deepEqual([scale.distribution, scale.skew, scale.spacing, scale.sizeJitter, scale.postOnly], ['flat', 1, 'linear', 0, false]);
  const dca = accepted(BASE.dca, 'dca') as Extract<AlgoSpec, { kind: 'dca' }>;
  assert.deepEqual([dca.outOfBand, dca.dipPct, dca.dipMultiplier, dca.maxTotalUsd, dca.exec.style], ['skip', null, 1, null, 'taker']);
  const swarm = accepted(BASE.swarm, 'swarm') as Extract<AlgoSpec, { kind: 'swarm' }>;
  assert.deepEqual([swarm.sizeJitter, swarm.retries], [0, 2]);
  const cond = accepted(BASE.conditional, 'conditional') as Extract<AlgoSpec, { kind: 'conditional' }>;
  assert.deepEqual([cond.match, cond.holdMs, cond.expiresAt], ['all', 0, null]);
  const trail = accepted(BASE.trailing, 'trailing') as Extract<AlgoSpec, { kind: 'trailing' }>;
  assert.deepEqual([trail.quantity, trail.reduceOnly, trail.source, trail.exit, trail.chaseMs, trail.slippageBps, trail.activationPrice], [null, true, 'mark', 'market', 15_000, 50, null]);
  assert.equal((accepted({ ...BASE.trailing, quantity: '0.01' }, 'a trailing stop of an amount') as Extract<AlgoSpec, { kind: 'trailing' }>).reduceOnly, false, 'sized: reduce-only as given');
  const bracket = accepted(BASE.bracket, 'bracket') as Extract<AlgoSpec, { kind: 'bracket' }>;
  assert.deepEqual([bracket.price, bracket.slippageBps], [null, 30]);
  const sweep = accepted(BASE.sweep, 'sweep') as Extract<AlgoSpec, { kind: 'sweep' }>;
  assert.deepEqual([sweep.roundMs, sweep.timeoutMs, sweep.reference, sweep.venues], [500, null, undefined, undefined]);
  const basket = accepted(BASE.basket, 'basket') as Extract<AlgoSpec, { kind: 'basket' }>;
  assert.deepEqual([basket.symbol, basket.side, basket.durationMs, basket.slices], ['BTC-USD', 'buy', 0, 0], 'its market and side are the first leg\'s; a swarm basket has no schedule');
  const twapBasket = accepted({ ...BASE.basket, style: 'twap', durationMs: HOUR, slices: 6, legs: [{ symbol: 'ETH-USD', side: 'sell', usd: 50 }, { symbol: 'BTC-USD', side: 'buy', usd: 50 }] }, 'a TWAP basket') as Extract<AlgoSpec, { kind: 'basket' }>;
  assert.deepEqual([twapBasket.symbol, twapBasket.side, twapBasket.clips, twapBasket.inFlight, twapBasket.waveMs], ['ETH-USD', 'sell', 0, 0, 0]);
});

test('defaults: the quantity each kind works up front (none for what is sized in USD or by the position)', () => {
  assert.equal(algoQuantity(accepted(BASE.twap, 'twap')), 0.01);
  assert.equal(algoQuantity(accepted({ ...BASE.twap, quantity: undefined, closeShare: 0.5 }, 'close')), null);
  assert.equal(algoQuantity(accepted(BASE.dca, 'dca')), null);
  assert.equal(algoQuantity(accepted(BASE.basket, 'basket')), null);
  assert.equal(algoQuantity(accepted(BASE.trailing, 'trailing')), null);
  assert.equal(algoQuantity(accepted({ ...BASE.trailing, quantity: '0.02' }, 'trailing amount')), 0.02);
  assert.equal(algoQuantity(accepted(BASE.conditional, 'conditional market')), 0.01);
  assert.equal(algoQuantity(accepted({ ...BASE.conditional, side: 'sell', then: { type: 'close', share: 1, slippageBps: 20 } }, 'conditional close')), null);
  for (const k of ['vwap', 'pov', 'iceberg', 'chase', 'scale', 'swarm', 'bracket', 'sweep'] as const) assert.equal(algoQuantity(accepted(BASE[k], k)), 0.01, k);
});

/* -------------------------------------------------------------- conflicts ----- */

const CONFLICTS: Array<{ what: string; spec: Record<string, unknown>; path: string; re: RegExp }> = [
  { what: 'a take-profit as a price and a distance', spec: { ...BASE.twap, exits: { tpPrice: 70_000, tpPct: 0.02 } }, path: 'exits.tpPct', re: /price or a distance, not both/ },
  { what: 'a stop-loss as a price and a distance', spec: { ...BASE.twap, exits: { slPrice: 50_000, slPct: 0.02 } }, path: 'exits.slPct', re: /price or a distance, not both/ },
  { what: 'a long\'s take-profit under its stop-loss', spec: { ...BASE.twap, exits: { tpPrice: 50_000, slPrice: 55_000 } }, path: 'exits.tpPrice', re: /long's take-profit must be above/ },
  { what: 'a long\'s take-profit at its stop-loss', spec: { ...BASE.twap, exits: { tpPrice: 55_000, slPrice: 55_000 } }, path: 'exits.tpPrice', re: /must be above/ },
  { what: 'a short\'s take-profit above its stop-loss', spec: { ...BASE.twap, side: 'sell', exits: { tpPrice: 70_000, slPrice: 65_000 } }, path: 'exits.tpPrice', re: /short's take-profit must be below/ },
  { what: 'a short\'s take-profit 100% away (at or under 0)', spec: { ...BASE.twap, side: 'sell', exits: { tpPct: 1 } }, path: 'exits.tpPct', re: /under 100%/ },
  { what: 'a stop-loss 99% or more away', spec: { ...BASE.twap, exits: { slPct: 0.995 } }, path: 'exits.slPct', re: /between/ },
  { what: 'exits on a reduce-only order', spec: { ...BASE.twap, reduceOnly: true, exits: { tpPct: 0.02 } }, path: 'exits', re: /reduce-only order opens nothing/ },
  { what: 'exits that are not an object', spec: { ...BASE.twap, exits: 'tp 2%' }, path: 'exits', re: /take-profit and\/or a stop-loss/ },
  { what: 'exits on a time-sliced close', spec: { ...BASE.twap, quantity: undefined, closeShare: 1, exits: { slPct: 0.02 } }, path: 'exits', re: /close opens nothing/ },
  { what: 'exits on a trailing stop', spec: { ...BASE.trailing, quantity: '0.01', exits: { tpPct: 0.02 } }, path: 'exits', re: /trailing stop places no exits/ },
  { what: 'exits on a basket', spec: { ...BASE.basket, exits: { tpPct: 0.02 } }, path: 'exits', re: /not on a basket/ },
  { what: 'exits on a conditional close', spec: { ...BASE.conditional, side: 'sell', then: { type: 'close', share: 1, slippageBps: 20 }, exits: { slPct: 0.02 } }, path: 'exits', re: /close opens nothing/ },
  { what: 'exits on a conditional that starts an algo (they go on the algo)', spec: { ...BASE.conditional, then: { type: 'algo', algo: BASE.chase }, exits: { slPct: 0.02 } }, path: 'exits', re: /Set the exits on the algo it starts/ },
  { what: 'a bracket without exits', spec: { ...BASE.bracket, exits: null }, path: 'exits', re: /needs a take-profit, a stop-loss, or both/ },
  { what: 'a bracket whose exits are all empty', spec: { ...BASE.bracket, exits: { tpPct: null, slPrice: '' } }, path: 'exits', re: /needs a take-profit/ },
  { what: 'a bracket limit entry without a price', spec: { ...BASE.bracket, entry: 'limit' }, path: 'price', re: /price above 0/ },
  { what: 'a bracket limit entry past the limit price', spec: { ...BASE.bracket, entry: 'limit', price: 61_000, limitPrice: 60_000 }, path: 'price', re: /past your limit price of 60000/ },
  { what: 'a sell bracket limit entry under the limit price', spec: { ...BASE.bracket, side: 'sell', entry: 'limit', price: 59_000, limitPrice: 60_000, exits: { tpPct: 0.02 } }, path: 'price', re: /past your limit price/ },
  { what: 'the upper bound under the lower', spec: { ...BASE.twap, upper: { price: 50_000, then: 'hold' }, lower: { price: 60_000, then: 'hold' } }, path: 'upper', re: /upper bound must be above the lower/ },
  { what: 'the upper bound at the lower', spec: { ...BASE.twap, upper: { price: 50_000, then: 'hold' }, lower: { price: 50_000, then: 'hold' } }, path: 'upper', re: /must be above/ },
  { what: 'too many TWAP slices for the duration (one every 5 s at most)', spec: { ...BASE.twap, durationMs: MIN, slices: 13 }, path: 'slices', re: /At most one slice every 5 s: use at most 12 slices/ },
  { what: 'too many VWAP slices for the duration', spec: { ...BASE.vwap, durationMs: 15 * MIN, slices: 181 }, path: 'slices', re: /use at most 180 slices/ },
  { what: 'too many TWAP basket slices for the duration', spec: { ...BASE.basket, style: 'twap', durationMs: MIN, slices: 13 }, path: 'slices', re: /At most one slice every 5 s/ },
  { what: 'a smallest slice over the largest', spec: { ...BASE.twap, minSliceQty: '0.005', maxSliceQty: '0.002' }, path: 'minSliceQty', re: /cannot be larger than the largest/ },
  { what: 'an iceberg showing more than its size', spec: { ...BASE.iceberg, displayQty: '0.02' }, path: 'displayQty', re: /visible size cannot be more/ },
  { what: 'an iceberg price past the limit price (buy)', spec: { ...BASE.iceberg, price: 61_000, limitPrice: 60_000 }, path: 'price', re: /past your limit price of 60000/ },
  { what: 'an iceberg price past the limit price (sell)', spec: { ...BASE.iceberg, side: 'sell', price: 59_000, limitPrice: 60_000 }, path: 'price', re: /past your limit price/ },
  { what: 'a scale from and to the same price', spec: { ...BASE.scale, to: 60_000 }, path: 'to', re: /must differ from the first/ },
  { what: 'a buy ladder with a level past the limit price', spec: { ...BASE.scale, limitPrice: 59_000 }, path: 'limitPrice', re: /Some levels of the ladder are past your limit price of 59000/ },
  { what: 'a sell ladder with a level under the limit price', spec: { ...BASE.scale, side: 'sell', from: 60_000, to: 62_000, limitPrice: 61_000 }, path: 'limitPrice', re: /past your limit price/ },
  { what: 'a ladder of explicit prices past the limit price', spec: { ...BASE.scale, prices: [60_000, 59_000], limitPrice: 59_500 }, path: 'limitPrice', re: /past your limit price/ },
  { what: 'a ladder of one price', spec: { ...BASE.scale, prices: [60_000] }, path: 'prices', re: /Between 2 and 100 prices/ },
  { what: 'a ladder with a price twice', spec: { ...BASE.scale, prices: [60_000, 60_000, 59_000] }, path: 'prices', re: /Each price only once/ },
  { what: 'a ladder with a price of 0', spec: { ...BASE.scale, prices: [60_000, 0] }, path: 'prices', re: /positive number/ },
  { what: 'a ladder\'s sizes not one per price', spec: { ...BASE.scale, prices: [60_000, 59_000], weights: [1] }, path: 'weights', re: /One positive size per price/ },
  { what: 'a ladder\'s size of 0', spec: { ...BASE.scale, prices: [60_000, 59_000], weights: [1, 0] }, path: 'weights', re: /One positive size per price/ },
  { what: 'a DCA budget under one order', spec: { ...BASE.dca, maxTotalUsd: 15 }, path: 'maxTotalUsd', re: /cover at least one order/ },
  { what: 'a trailing stop with a % and a $ trail', spec: { ...BASE.trailing, trailAbs: 100 }, path: 'trailPct', re: /one of the two/ },
  { what: 'a trailing stop with no trail', spec: { ...BASE.trailing, trailPct: null }, path: 'trailPct', re: /one of the two/ },
  { what: 'a basket of one market', spec: { ...BASE.basket, legs: [{ symbol: 'BTC-USD', side: 'buy', usd: 100 }] }, path: 'legs', re: /2 to 10 markets/ },
  { what: 'a basket of eleven markets', spec: { ...BASE.basket, legs: Array.from({ length: 11 }, (_, i) => ({ symbol: `C${i}-USD`, side: 'buy', usd: 100 })) }, path: 'legs', re: /2 to 10 markets/ },
  { what: 'a basket with a market twice', spec: { ...BASE.basket, legs: [{ symbol: 'BTC-USD', side: 'buy', usd: 100 }, { symbol: 'BTC-USD', side: 'sell', usd: 100 }] }, path: 'legs', re: /Each market once/ },
  { what: 'a basket leg under $10', spec: { ...BASE.basket, legs: [{ symbol: 'BTC-USD', side: 'buy', usd: 9 }, { symbol: 'ETH-USD', side: 'sell', usd: 100 }] }, path: 'legs.0.usd', re: /between 10/ },
  { what: 'a fill fast with an unknown venue', spec: { ...BASE.sweep, venues: ['binanceFutures', 'mtgox'] }, path: 'venues', re: /Unknown venue/ },
  { what: 'a fill fast on the oracle with no venue', spec: { ...BASE.sweep, venues: [] }, path: 'venues', re: /at least one venue/ },
  { what: 'a fill fast with venues that are not a list', spec: { ...BASE.sweep, venues: 'okx' }, path: 'venues', re: /Unknown venue/ },
  { what: 'a conditional limit past the limit price', spec: { ...BASE.conditional, limitPrice: 58_000, then: { type: 'limit', quantity: '0.01', price: 59_000, postOnly: true } }, path: 'then.price', re: /past your limit price of 58000/ },
];

for (const c of CONFLICTS) {
  test(`conflicts: ${c.what} is refused`, () => refused(c.spec, c.path, c.what, c.re));
}

test('conflicts: what CAN go together', () => {
  accepted({ ...BASE.twap, exits: { tpPrice: 70_000, slPct: 0.02 } }, 'a take-profit price with a stop-loss distance');
  accepted({ ...BASE.twap, side: 'sell', exits: { tpPct: 0.99, slPrice: 70_000 } }, 'a short\'s take-profit under 100%');
  accepted({ ...BASE.twap, exits: { tpPct: 10 } }, 'a long\'s take-profit 1000% up');
  accepted({ ...BASE.sweep, reference: 'mark', venues: [] }, 'no venue on a mark reference');
  accepted({ ...BASE.sweep, reference: 'index', venues: [] }, 'no venue on an index reference');
  const v = accepted({ ...BASE.sweep, venues: [ORACLE_VENUES[0], ORACLE_VENUES[0], ORACLE_VENUES[1]] }, 'a venue twice') as Extract<AlgoSpec, { kind: 'sweep' }>;
  assert.deepEqual(v.venues, [ORACLE_VENUES[0], ORACLE_VENUES[1]], 'each venue once');
  accepted({ ...BASE.twap, minSliceQty: '0.002', maxSliceQty: '0.002' }, 'smallest = largest slice');
  accepted({ ...BASE.iceberg, displayQty: '0.01' }, 'showing all of it');
  accepted({ ...BASE.iceberg, price: 60_000, limitPrice: 60_000 }, 'an iceberg at its limit');
  accepted({ ...BASE.scale, limitPrice: 60_000 }, 'a ladder that ends at its limit');
  // The explicit levels win over from/to/orders; their sizes over the skew's range.
  const ladder = accepted({ ...BASE.scale, from: 1, to: 1, orders: 1, prices: [60_000, 59_000, 58_000], weights: [1, 2, 4], skew: 5000 }, 'explicit levels') as Extract<AlgoSpec, { kind: 'scale' }>;
  assert.deepEqual([ladder.from, ladder.to, ladder.orders, ladder.skew], [60_000, 58_000, 3, 5000]);
  refused({ ...BASE.scale, prices: [60_000, 59_000], skew: 5000 }, 'skew', 'a skew out of range without explicit sizes');
  // A time-sliced close is reduce-only whatever was sent, and carries no quantity.
  const close = accepted({ ...BASE.twap, quantity: '5', closeShare: 0.25, reduceOnly: false }, 'a close') as Extract<AlgoSpec, { kind: 'twap' }>;
  assert.deepEqual([close.reduceOnly, close.quantity, close.closeShare], [true, '0', 0.25]);
  assert.ok(algoClosesOnly(close));
  // A trailing stop of the whole position is reduce-only; a reduce-only twap closes only.
  assert.ok(algoClosesOnly(accepted(BASE.trailing, 'trailing')));
  assert.ok(algoClosesOnly(accepted({ ...BASE.twap, reduceOnly: true }, 'reduce-only TWAP')));
  assert.ok(!algoClosesOnly(accepted(BASE.twap, 'TWAP')));
  assert.ok(algoClosesOnly(accepted({ ...BASE.conditional, then: { type: 'algo', algo: { ...BASE.twap, reduceOnly: true } } }, 'conditional starting a reduce-only TWAP')));
  // Both bounds, each with its own reaction.
  const b = accepted({ ...BASE.twap, upper: { price: 70_000, then: 'rush' }, lower: { price: 50_000, then: 'stop' } }, 'two bounds');
  assert.deepEqual([b.upper, b.lower], [{ price: 70_000, then: 'rush' }, { price: 50_000, then: 'stop' }]);
});

test('every kind: its menu entry exists, its base spec opens (or closes) as expected', () => {
  const opens: Record<AlgoKind, boolean> = { twap: true, vwap: true, pov: true, iceberg: true, chase: true, scale: true, dca: true, swarm: true, conditional: true, trailing: false, basket: false, bracket: true, sweep: true, mm: true, grid: true };
  for (const k of ALGO_KINDS) assert.equal(opensPosition(accepted(BASE[k], k)), opens[k], k);
  // A bot buys and sells: it is never reduce-only (refused, its own test).
  for (const k of ALGO_KINDS.filter((x) => x !== 'bracket' && !BOT_KINDS.includes(x))) assert.equal(opensPosition(accepted({ ...BASE[k], reduceOnly: true, exits: null }, `${k} reduce-only`)), false, `${k} reduce-only opens nothing`);
  // A bracket needs its exits and a reduce-only order may have none: there is no reduce-only bracket (the ticket's switch shows the error).
  refused({ ...BASE.bracket, reduceOnly: true }, 'exits', 'a reduce-only bracket with exits', /reduce-only order opens nothing/);
  refused({ ...BASE.bracket, reduceOnly: true, exits: null }, 'exits', 'a reduce-only bracket without', /needs a take-profit/);
});

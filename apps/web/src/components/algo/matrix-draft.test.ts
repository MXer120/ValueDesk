/**
 * Every field of the algo ticket, set away from its default, reaches the spec
 * as the engine reads it (draftToSpec), and the spec is one the engine
 * accepts: the UI half of the option matrix (docs/COVERAGE-ALGOS.md; the engine
 * half is packages/copy-engine/test/matrix-*.test.ts). Each case names the
 * draft fields it sets and the spec fields they must become.
 * Run (from apps/web): npx tsx --test src/components/algo/matrix-draft.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAlgoSpec, type AlgoSpec } from '@copy-engine';
import { DEFAULT, cond, draftToSpec, legs, offersExits, type Draft, type TicketShared } from './draft';
import type { UiKind } from './menu';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const shared = (o: Partial<TicketShared> = {}): TicketShared => ({ symbol: 'BTC-USD', side: 'buy', quantity: '0.05', reduceOnly: false, leverage: 5, marginMode: 'isolated', bid: 99_990, ask: 100_000, ...o });

/** The form with the book's prices a kind needs before it can be sent. */
function base(kind: UiKind): Draft {
  const d: Draft = { ...DEFAULT };
  if (kind === 'scale') Object.assign(d, { from: '99800', to: '98000' });
  if (kind === 'conditional') d.conds = [cond('BTC-USD', { value: '99000' })];
  if (kind === 'basket') d.legs = legs('BTC-USD', 'buy');
  if (kind === 'iceberg') d.display = '0.01';
  return d;
}

interface Case {
  kind: UiKind;
  what: string;
  draft: Partial<Draft>;
  p?: Partial<TicketShared>;
  /** Dotted spec paths and the value each must have. */
  want: Record<string, unknown>;
}

const get = (o: unknown, path: string): unknown => path.split('.').reduce<unknown>((x, k) => (x && typeof x === 'object' ? (x as Record<string, unknown>)[k] : undefined), o);

const CASES: Case[] = [
  // The shared rules.
  { kind: 'twap', what: 'side, reduce-only off, leverage and margin mode', draft: {}, p: { side: 'sell', leverage: 7, marginMode: 'cross' }, want: { side: 'sell', reduceOnly: false, leverage: 7, marginMode: 'cross' } },
  { kind: 'twap', what: 'reduce-only: no leverage, no margin mode', draft: {}, p: { reduceOnly: true }, want: { reduceOnly: true, leverage: null, marginMode: null } },
  { kind: 'twap', what: 'a limit price', draft: { limitPrice: '101000' }, want: { limitPrice: 101_000 } },
  { kind: 'twap', what: 'bounds with each reaction', draft: { upper: '110000', upperThen: 'rush', lower: '90000', lowerThen: 'stop' }, want: { 'upper.price': 110_000, 'upper.then': 'rush', 'lower.price': 90_000, 'lower.then': 'stop' } },
  { kind: 'twap', what: 'a hold bound', draft: { upper: '110000', upperThen: 'hold' }, want: { 'upper.then': 'hold', lower: null } },
  { kind: 'twap', what: 'a start delay in minutes', draft: { startMode: 'delay', startDelay: '5' }, want: { startAt: NOW + 5 * MIN, triggerPrice: null } },
  { kind: 'twap', what: 'a start price', draft: { startMode: 'price', startPrice: '99500' }, want: { triggerPrice: 99_500, startAt: null } },
  { kind: 'twap', what: 'a spread guard', draft: { maxSpread: '8' }, want: { maxSpreadBps: 8 } },
  { kind: 'twap', what: 'practice', draft: { paper: true }, want: { paper: true } },
  { kind: 'twap', what: 'exits in %', draft: { exitsOn: true, tpMode: 'pct', tp: '3', slMode: 'pct', sl: '1.5' }, want: { 'exits.tpPct': 0.03, 'exits.slPct': 0.015, 'exits.tpPrice': null, 'exits.slPrice': null } },
  { kind: 'twap', what: 'exits as prices', draft: { exitsOn: true, tpMode: 'price', tp: '105000', slMode: 'price', sl: '97000' }, want: { 'exits.tpPrice': 105_000, 'exits.slPrice': 97_000, 'exits.tpPct': null } },
  { kind: 'twap', what: 'exits switched off are not sent', draft: { exitsOn: false, tp: '3' }, want: { exits: null } },
  // TWAP and Chase TWAP.
  { kind: 'twap', what: 'duration, slices, urgency, jitter', draft: { dur: '2', durUnit: 'h', slicesAuto: false, slices: '40', urgency: -0.5, sizeJitter: '30', timeJitter: '10' }, want: { durationMs: 2 * 60 * MIN, slices: 40, urgency: -0.5, sizeJitter: 0.3, timeJitter: 0.1 } },
  { kind: 'twap', what: 'execution maker, chase ticks', draft: { exec: 'maker', chaseTicks: '4' }, want: { 'exec.style': 'maker', 'exec.chaseTicks': 4, 'exec.offsetTicks': 0 } },
  { kind: 'twap', what: 'execution hybrid with its resting share', draft: { exec: 'hybrid', makerShare: '75' }, want: { 'exec.style': 'hybrid', 'exec.makerShare': 0.75 } },
  { kind: 'twap', what: 'slippage and what it is measured from', draft: { slip: '25', slipFrom: 'oracleFair' }, want: { 'exec.slippageBps': 25, 'exec.slipFrom': 'oracleFair' } },
  { kind: 'twap', what: 'slippage from the touch is left out (as every spec before it)', draft: { slipFrom: 'touch' }, want: { 'exec.slipFrom': undefined } },
  { kind: 'twap', what: 'finish leave, max participation, smallest and largest slice', draft: { finish: 'leave', maxPart: '20', minSlice: '0.001', maxSlice: '0.004' }, want: { finish: 'leave', maxParticipation: 0.2, minSliceQty: '0.001', maxSliceQty: '0.004' } },
  { kind: 'twap', what: 'close a share of the position', draft: { twapClose: true, twapCloseShare: '40' }, want: { quantity: '0', closeShare: 0.4 } },
  { kind: 'chasetwap', what: 'Chase TWAP rests first, no urgency, labelled', draft: { exec: 'taker', urgency: 1 }, want: { kind: 'twap', 'exec.style': 'hybrid', urgency: 0, label: 'Chase TWAP' } },
  { kind: 'chasetwap', what: 'Chase TWAP maker', draft: { exec: 'maker' }, want: { 'exec.style': 'maker' } },
  // VWAP.
  { kind: 'vwap', what: 'history, adaptive off, size jitter, finish, participation', draft: { lookback: 28, adaptive: false, sizeJitter: '5', finish: 'leave', maxPart: '10', dur: '1', durUnit: 'h' }, want: { lookbackDays: 28, adaptive: false, sizeJitter: 0.05, finish: 'leave', maxParticipation: 0.1, durationMs: 60 * MIN } },
  // POV.
  { kind: 'pov', what: 'rate, largest child, stop after, execution', draft: { rate: '25', maxChild: '0.01', endIn: '3', endUnit: 'h', exec: 'maker' }, want: { rate: 0.25, maxChildQty: '0.01', endAt: NOW + 3 * 60 * MIN, 'exec.style': 'maker' } },
  // Iceberg.
  { kind: 'iceberg', what: 'pegged: visible size, jitter, offset, re-price, refill, GTC', draft: { display: '0.02', displayJitter: '10', icePeg: true, offsetTicks: '-1', chaseTicks: '3', refill: '2.5', postOnly: false }, want: { displayQty: '0.02', displayJitter: 0.1, price: null, pegOffsetTicks: -1, chaseTicks: 3, refillMs: 2_500, postOnly: false, refillJitter: 0.5 } },
  { kind: 'iceberg', what: 'at a fixed price, post-only', draft: { icePeg: false, icePrice: '99000', postOnly: true }, want: { price: 99_000, postOnly: true } },
  // Chase.
  { kind: 'chase', what: 'offset in ticks, re-price, max chase in %, give up, take', draft: { offsetMode: 'ticks', offsetTicks: '2', chaseTicks: '3', maxChasePct: '0.25', timeout: '90', timeoutUnit: 's', onEnd: 'take' }, want: { offsetTicks: 2, offsetBps: null, chaseTicks: 3, maxChaseBps: 25, timeoutMs: 90_000, onEnd: 'take', minRepriceMs: 1_000 } },
  { kind: 'chase', what: 'stalking in bp, left resting at the end', draft: { offsetMode: 'bps', offsetBps: '15', timeout: '10', timeoutUnit: 'm', onEnd: 'rest' }, want: { offsetBps: 15, timeoutMs: 10 * MIN, onEnd: 'rest' } },
  { kind: 'chase', what: 'cancel at the end', draft: { onEnd: 'cancel', timeout: '1', timeoutUnit: 'h' }, want: { onEnd: 'cancel', timeoutMs: 60 * MIN } },
  // Scale.
  { kind: 'scale', what: 'range, orders, curve, skew, spacing, jitter, post-only', draft: { from: '99900', to: '95000', orders: '12', distribution: 'exponential', skew: '3', spacing: 'geometric', scaleJitter: '20', postOnly: false }, want: { from: 99_900, to: 95_000, orders: 12, distribution: 'exponential', skew: 3, spacing: 'geometric', sizeJitter: 0.2, postOnly: false } },
  { kind: 'scale', what: 'a bell, denser near the last price', draft: { distribution: 'bell', spacing: 'back' }, want: { distribution: 'bell', spacing: 'back' } },
  { kind: 'scale', what: 'linear, denser near the first price', draft: { distribution: 'linear', skew: '0.5', spacing: 'front' }, want: { distribution: 'linear', skew: 0.5, spacing: 'front' } },
  // DCA (a ladder of explicit levels).
  { kind: 'dca', what: 'a first buy at a price, then steps, geometric sizes, post-only', draft: { dcaFirst: 'price', dcaStart: '100000', dcaStep: '1', dcaOrders: '4', dcaSizing: 'geometric', dcaMult: '2', perOrder: '20', postOnly: true }, want: { kind: 'scale', label: 'DCA', orders: 4, prices: [100_000, 99_000, 98_000, 97_000], postOnly: true, limitPrice: null } },
  { kind: 'dca', what: 'sizes in the coin, a widening step', draft: { dcaFirst: 'price', dcaStart: '100000', dcaStep: '1', dcaStepScale: '2', dcaOrders: '3', dcaUnit: 'coin', perOrder: '0.001' }, want: { prices: [100_000, 99_000, 97_000], weights: [0.001, 0.001, 0.001] } },
  { kind: 'dca', what: 'typed prices, weighted by the curve', draft: { dcaFirst: 'price', dcaStart: '100000', dcaLevels: 'list', dcaPrices: '99000; 97500', dcaSizing: 'weighted', dcaCurve: [[0, 1], [1, 3]] }, want: { prices: [100_000, 99_000, 97_500], orders: 3 } },
  { kind: 'dca', what: 'a first sell at market from the bid, upward', draft: { dcaFirst: 'market', dcaStep: '2', dcaOrders: '2', postOnly: false }, p: { side: 'sell' }, want: { side: 'sell', prices: [99_990, 101_989.8] } },
  // Swarm.
  { kind: 'swarm', what: 'clips, per wave, pause, slippage, retries, irregular', draft: { clips: '8', inFlight: 4, waveSec: '1.5', slip: '35', retries: '5', sizeJitter: '40' }, want: { clips: 8, inFlight: 4, waveMs: 1_500, slippageBps: 35, retries: 5, sizeJitter: 0.4 } },
  // Trailing stop.
  { kind: 'trailing', what: 'a % trail of an amount, mark, a market exit', draft: { trailMode: 'pct', trail: '0.5', trailWhole: false, source: 'mark', exit: 'market', slip: '40' }, want: { trailPct: 0.005, trailAbs: null, quantity: '0.05', source: 'mark', exit: 'market', slippageBps: 40, reduceOnly: true, leverage: null } },
  { kind: 'trailing', what: 'a $ trail of the whole position, last, a chase exit, activation', draft: { trailMode: 'abs', trail: '250', trailWhole: true, source: 'last', exit: 'chase', chaseSec: '30', activation: '102000' }, p: { side: 'sell' }, want: { trailAbs: 250, trailPct: null, quantity: null, source: 'last', exit: 'chase', chaseMs: 30_000, activationPrice: 102_000 } },
  // Bracket.
  { kind: 'bracket', what: 'a market entry with a slippage cap and both exits', draft: { entry: 'market', slip: '15', tpMode: 'pct', tp: '2', slMode: 'price', sl: '97000' }, want: { entry: 'market', price: null, slippageBps: 15, 'exits.tpPct': 0.02, 'exits.slPrice': 97_000 } },
  { kind: 'bracket', what: 'a limit entry', draft: { entry: 'limit', entryPrice: '99500', tp: '1', sl: '1' }, want: { entry: 'limit', price: 99_500 } },
  // Fill fast.
  { kind: 'sweep', what: 'slippage in %, rounds, give up, the oracle fair of two venues', draft: { sweepSlip: '0.2', sweepRound: '2', sweepGiveUp: '5', sweepRef: 'oracleFair', sweepVenues: ['okx', 'bybit'] }, want: { slippageBps: 20, roundMs: 2_000, timeoutMs: 5 * MIN, reference: 'oracleFair', venues: ['okx', 'bybit'] } },
  { kind: 'sweep', what: 'SoDEX\'s index (the venues do not apply)', draft: { sweepRef: 'index', sweepVenues: ['okx'] }, want: { reference: 'index', timeoutMs: null } },
  { kind: 'sweep', what: 'SoDEX\'s mark', draft: { sweepRef: 'mark' }, want: { reference: 'mark' } },
  // Basket.
  { kind: 'basket', what: 'swarm legs, long and short, in USD', draft: { legs: [{ symbol: 'BTC-USD', side: 'buy', usd: '200' }, { symbol: 'ETH-USD', side: 'sell', usd: '150' }], basketStyle: 'swarm', clips: '4', inFlight: 2, waveSec: '2', slip: '20' }, want: { 'legs.0.usd': 200, 'legs.1.side': 'sell', 'legs.1.usd': 150, style: 'swarm', clips: 4, waveMs: 2_000, leverage: null, marginMode: null } },
  { kind: 'basket', what: 'TWAP legs over a duration', draft: { basketStyle: 'twap', dur: '20', durUnit: 'm', slicesAuto: false, slices: '10' }, want: { style: 'twap', durationMs: 20 * MIN, slices: 10 } },
];

for (const c of CASES) {
  test(`ticket -> spec: ${c.kind}, ${c.what}`, () => {
    const s = draftToSpec(c.kind, { ...base(c.kind), ...c.draft }, shared(c.p), NOW);
    for (const [k, v] of Object.entries(c.want)) assert.deepEqual(get(s, k), v, `${k}`);
    const r = checkAlgoSpec(s);
    assert.deepEqual(r.errors, {}, `the engine accepts it: ${JSON.stringify(r.errors)}`);
  });
}

/* Every condition the ticket offers, as the engine reads it (the % fields become fractions, minutes milliseconds). */
const CONDS: Array<{ what: string; c: Parameters<typeof cond>[1]; want: Record<string, unknown> }> = [
  { what: 'price (index) above', c: { type: 'price', source: 'index', op: 'above', value: '101000' }, want: { type: 'price', source: 'index', op: 'above', value: 101_000 } },
  { what: 'crosses down', c: { type: 'cross', source: 'last', dir: 'down', value: '98000' }, want: { type: 'cross', source: 'last', dir: 'down', value: 98_000 } },
  { what: 'crosses: "either" is up', c: { type: 'cross', dir: 'either', value: '98000' }, want: { dir: 'up' } },
  { what: 'moves 2% either way in 15 min', c: { type: 'move', source: 'mid', dir: 'either', pct: '2', windowMin: '15' }, want: { type: 'move', pct: 0.02, windowMs: 15 * MIN, source: 'mid' } },
  { what: 'funding below -0.01%', c: { type: 'funding', op: 'below', pct: '-0.01' }, want: { type: 'funding', op: 'below', value: -0.0001 } },
  { what: 'open interest up 5% in an hour', c: { type: 'oi', dir: 'up', pct: '5', windowMin: '60' }, want: { type: 'oi', dir: 'up', pct: 0.05, windowMs: 60 * MIN } },
  { what: 'spread above 4 bp', c: { type: 'spread', op: 'above', bps: '4' }, want: { type: 'spread', op: 'above', bps: 4 } },
  { what: 'volume over $2M in 30 min', c: { type: 'volume', usd: '2000000', windowMin: '30' }, want: { type: 'volume', aboveUsd: 2_000_000, windowMs: 30 * MIN } },
  { what: 'ratio of ETH over BTC below', c: { type: 'ratio', symbol: 'ETH-USD', other: 'BTC-USD', op: 'below', value: '0.03' }, want: { type: 'ratio', symbol: 'ETH-USD', other: 'BTC-USD', value: 0.03 } },
  { what: 'your position short (no value)', c: { type: 'position', pos: 'short', value: '7' }, want: { type: 'position', op: 'short', value: 0 } },
  { what: 'your position size above', c: { type: 'position', pos: 'sizeAbove', value: '0.2' }, want: { op: 'sizeAbove', value: 0.2 } },
  { what: 'your PnL below', c: { type: 'position', pos: 'pnlBelow', value: '-50' }, want: { op: 'pnlBelow', value: -50 } },
  { what: 'in 90 minutes', c: { type: 'time', inMin: '90' }, want: { type: 'time', at: NOW + 90 * MIN } },
];

for (const k of CONDS) {
  test(`ticket -> spec: a conditional on ${k.what}`, () => {
    const s = draftToSpec('conditional', { ...base('conditional'), conds: [cond('BTC-USD', k.c)], match: 'any', holdSec: '12', expires: '2', expiresUnit: 'd' }, shared(), NOW);
    const c0 = (s.conditions as unknown[])[0];
    for (const [key, v] of Object.entries(k.want)) assert.deepEqual(get(c0, key), v, key);
    assert.deepEqual([s.match, s.holdMs, s.expiresAt], ['any', 12_000, NOW + 2 * 24 * 60 * MIN]);
    assert.deepEqual(checkAlgoSpec(s).errors, {});
  });
}

test('ticket -> spec: every action of a conditional; an algo it starts carries the exits, the conditional none', () => {
  const at = (then: Draft['then'], o: Partial<Draft> = {}, p: Partial<TicketShared> = {}) => draftToSpec('conditional', { ...base('conditional'), then, ...o }, shared(p), NOW);
  assert.deepEqual(at('market', { slip: '22' }).then, { type: 'market', quantity: '0.05', slippageBps: 22 });
  assert.deepEqual(at('limit', { thenPrice: '98500', postOnly: true }).then, { type: 'limit', quantity: '0.05', price: 98_500, postOnly: true });
  assert.deepEqual(at('close', { closePct: '50', slip: '30' }, { side: 'sell' }).then, { type: 'close', share: 0.5, slippageBps: 30 });
  const twap = at('twap', { thenMin: '20', thenSlices: '10', exitsOn: true, tp: '2', sl: '1' });
  const tAlgo = (twap.then as { algo: Record<string, unknown> }).algo;
  assert.deepEqual([tAlgo.kind, tAlgo.durationMs, tAlgo.slices, twap.exits], ['twap', 20 * MIN, 10, null]);
  assert.deepEqual(tAlgo.exits, { tpPct: 0.02, tpPrice: null, slPct: 0.01, slPrice: null });
  const chase = at('chase', { exitsOn: true, tp: '2', sl: '1', paper: true });
  const cAlgo = (chase.then as { algo: Record<string, unknown> }).algo;
  assert.deepEqual([cAlgo.kind, cAlgo.paper, chase.exits === null], ['chase', true, true]);
  for (const s of [twap, chase]) assert.deepEqual(checkAlgoSpec(s).errors, {});
  // A close offers no exits on the ticket, and sends none.
  assert.equal(offersExits('conditional', { ...DEFAULT, then: 'close' }, false), false);
  assert.equal(at('close', { exitsOn: true, tp: '2' }, { side: 'sell' }).exits, null);
});

test('ticket -> spec: what a kind does not show is never sent with it (limit, bounds, spread guard, exits)', () => {
  const noisy: Partial<Draft> = { limitPrice: '50000', upper: '200000', lower: '1000', maxSpread: '3', exitsOn: true, tp: '2', sl: '1' };
  const shows: Record<UiKind, { limit: boolean; bounds: boolean }> = {
    twap: { limit: true, bounds: true }, chasetwap: { limit: true, bounds: true }, vwap: { limit: true, bounds: true }, pov: { limit: true, bounds: true }, iceberg: { limit: true, bounds: true }, chase: { limit: true, bounds: true },
    swarm: { limit: true, bounds: true }, conditional: { limit: true, bounds: false }, bracket: { limit: true, bounds: false }, scale: { limit: false, bounds: false }, dca: { limit: false, bounds: false }, trailing: { limit: false, bounds: false }, sweep: { limit: false, bounds: false }, basket: { limit: false, bounds: false },
  };
  for (const [kind, sh] of Object.entries(shows) as Array<[UiKind, { limit: boolean; bounds: boolean }]>) {
    const s = draftToSpec(kind, { ...base(kind), ...noisy, ...(kind === 'dca' ? { dcaFirst: 'price', dcaStart: '100000' } : {}) }, shared({ side: kind === 'trailing' ? 'sell' : 'buy' }), NOW) as Record<string, unknown>;
    assert.equal(s.limitPrice !== null, sh.limit, `${kind}: the limit price ${sh.limit ? 'goes' : 'stays behind'}`);
    assert.equal(s.upper !== null || s.lower !== null || s.maxSpreadBps !== null, sh.bounds, `${kind}: bounds and the spread guard ${sh.bounds ? 'go' : 'stay behind'}`);
    const exits = kind === 'trailing' || kind === 'basket' ? null : s.exits;
    if (kind === 'trailing' || kind === 'basket') assert.equal(s.exits, null, `${kind}: never exits`);
    else assert.ok(exits, `${kind}: exits switched on are sent`);
  }
  // Reduce-only: exits never sent (the bracket is refused: it needs them).
  for (const kind of ['twap', 'iceberg', 'chase', 'swarm', 'scale', 'sweep'] as const) assert.equal(draftToSpec(kind, { ...base(kind), ...noisy }, shared({ reduceOnly: true }), NOW).exits, null, kind);
  const rb = checkAlgoSpec(draftToSpec('bracket', base('bracket'), shared({ reduceOnly: true }), NOW));
  assert.equal(rb.spec, null);
  assert.match(rb.errors.exits ?? '', /needs a take-profit/);
});

test('ticket -> spec: the kinds the ticket offers are every engine kind but the scheduled DCA (reached by the API only)', () => {
  const engine = new Set<string>();
  for (const k of ['twap', 'chasetwap', 'vwap', 'pov', 'iceberg', 'chase', 'scale', 'dca', 'swarm', 'conditional', 'trailing', 'sweep', 'bracket', 'basket'] as const) {
    engine.add((draftToSpec(k, { ...base(k), ...(k === 'dca' ? { dcaFirst: 'price', dcaStart: '100000' } : {}) }, shared({ side: k === 'trailing' ? 'sell' : 'buy' }), NOW) as unknown as AlgoSpec).kind);
  }
  assert.deepEqual([...engine].sort(), ['basket', 'bracket', 'chase', 'conditional', 'iceberg', 'pov', 'scale', 'swarm', 'sweep', 'trailing', 'twap', 'vwap']);
});

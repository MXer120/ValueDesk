import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adaptiveShare,
  allocateSteps,
  checkAlgoSpec,
  canonicalJSON,
  curveWeights,
  dueShare,
  ladderPrices,
  ladderWeights,
  makeRng,
  makerPrice,
  minChildQty,
  parseAlgoSpec,
  planAlgo,
  sliceTimes,
  takerPrice,
  trail,
  twapSchedule,
  volumeProfile,
  DAY_MS,
} from '../src/index.ts';
import { BTC } from './helpers.ts';
import { checkAlgoSpec as parseCheck } from '../src/algo/spec.ts';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

const twap = (over: Record<string, unknown> = {}) => ({
  kind: 'twap',
  symbol: 'BTC-USD',
  side: 'buy',
  quantity: '1',
  durationMs: 600_000,
  slices: 10,
  exec: { style: 'taker', slippageBps: 30 },
  ...over,
});

test('curve weights: sum to 1; urgency front-loads, negative back-loads; jitter keeps the total', () => {
  const r = makeRng(1);
  const flat = curveWeights(10, 0, 0, r);
  close(sum(flat), 1);
  for (const w of flat) close(w, 0.1);
  const front = curveWeights(10, 1, 0, r);
  assert.ok(front[0]! > front[9]! * 15, 'urgency 1 puts ~20x in the first slice');
  const back = curveWeights(10, -0.5, 0, r);
  assert.ok(back[9]! > back[0]!);
  const jit = curveWeights(50, 0, 0.4, makeRng(7));
  close(sum(jit), 1);
  assert.ok(Math.max(...jit) / Math.min(...jit) > 1.2, 'jitter changes the sizes');
});

test('slice times: the first at the start, in order, inside the window, jitter bounded', () => {
  const t = sliceTimes(1_000_000, 600_000, 10, 0.5, makeRng(3));
  assert.equal(t[0], 1_000_000);
  for (let i = 1; i < t.length; i++) assert.ok(t[i]! > t[i - 1]!);
  assert.ok(t[t.length - 1]! < 1_600_000);
  for (let i = 1; i < t.length; i++) assert.ok(Math.abs(t[i]! - (1_000_000 + i * 60_000)) <= 30_001);
  assert.deepEqual(sliceTimes(0, 100, 4, 0, makeRng(1)), [0, 25, 50, 75]);
});

test('the same seed gives the same schedule (the preview is what runs)', () => {
  const s = parseAlgoSpec(twap({ urgency: 0.3, sizeJitter: 0.2, timeJitter: 0.3 })) as Extract<ReturnType<typeof parseAlgoSpec>, { kind: 'twap' }>;
  assert.deepEqual(twapSchedule(s, 5_000, 42), twapSchedule(s, 5_000, 42));
  assert.notDeepEqual(twapSchedule(s, 5_000, 42), twapSchedule(s, 5_000, 43));
  const plan = planAlgo(s, BTC, { now: 5_000, price: 60_000, seed: 42 });
  assert.deepEqual(plan.children.map((c) => c.at), twapSchedule(s, 5_000, 42).times);
});

test('due share counts the slices whose time has come', () => {
  close(dueShare([0, 10, 20], [0.2, 0.3, 0.5], -1), 0);
  close(dueShare([0, 10, 20], [0.2, 0.3, 0.5], 10), 0.5);
  close(dueShare([0, 10, 20], [0.2, 0.3, 0.5], 99), 1);
});

test('allocateSteps places every whole step, never a fraction', () => {
  const parts = allocateSteps(1, [1, 1, 1], 0.00001);
  close(sum(parts), 1, 1e-9);
  for (const p of parts) close(Math.round(p / 0.00001) * 0.00001, p, 1e-12);
  const odd = allocateSteps(0.00007, [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 0.00001);
  assert.equal(odd.filter((p) => p > 0).length, 7);
  close(sum(odd), 0.00007, 1e-12);
});

test('ladder: prices snapped and distinct, spacing curves, size curves', () => {
  const lin = ladderPrices(100, 90, 5, 'linear', '0.5');
  assert.deepEqual(lin, [100, 97.5, 95, 92.5, 90]);
  const front = ladderPrices(100, 90, 5, 'front', '0.01');
  assert.ok(front[1]! - front[0]! > -1 && front[0]! - front[1]! < front[3]! - front[4]!, 'front: dense near the first price');
  const geo = ladderPrices(100, 50, 3, 'geometric', '0.01');
  close(geo[1]!, 70.71);
  assert.deepEqual(ladderPrices(100, 100.4, 10, 'linear', '1'), [100]);
  const w = ladderWeights(5, 'linear', 3, 0, makeRng(1));
  close(w[4]! / w[0]!, 3);
  const e = ladderWeights(5, 'exponential', 4, 0, makeRng(1));
  close(e[4]! / e[0]!, 4);
  const b = ladderWeights(5, 'bell', 1, 0, makeRng(1));
  assert.ok(b[2]! > b[0]! && b[2]! > b[4]!);
});

test('maker price never crosses the book and respects the limit', () => {
  const q = { bid: 100, ask: 101, at: 0 };
  const m = { tickSize: '0.5' };
  assert.equal(makerPrice('buy', q, 0, null, m, null), 100);
  assert.equal(makerPrice('buy', q, -1, null, m, null), 100.5, 'one tick inside the spread');
  assert.equal(makerPrice('buy', q, -5, null, m, null), 100.5, 'never at or through the ask');
  assert.equal(makerPrice('buy', q, 2, null, m, null), 99);
  assert.equal(makerPrice('buy', q, 0, null, m, 99.2), 99, 'the limit, snapped down');
  assert.equal(makerPrice('sell', q, 0, null, m, null), 101);
  assert.equal(makerPrice('sell', q, -1, null, m, null), 100.5);
  assert.equal(makerPrice('sell', { bid: 100, ask: 100.5, at: 0 }, -3, null, m, null), 100.5, 'never at the bid');
  assert.equal(makerPrice('buy', q, 0, 100, m, null), 99, '100 bp behind the bid');
});

test('taker price: touch plus slippage, capped by the limit; nothing when the limit is under the touch', () => {
  const q = { bid: 60_000, ask: 60_010, at: 0 };
  assert.equal(takerPrice('buy', q, 10, BTC, 60_005, null), 60_070);
  assert.equal(takerPrice('buy', q, 10, BTC, 60_005, 60_020), 60_020);
  assert.equal(takerPrice('buy', q, 10, BTC, 60_005, 60_000), null);
  assert.equal(takerPrice('sell', q, 10, BTC, 60_005, 59_990), 59_990);
  assert.equal(takerPrice('sell', q, 10, BTC, 60_005, null), 59_940);
});

test('taker price measured from a chosen reference (mid, mark, index, oracle) instead of the touch', () => {
  const q = { bid: 60_000, ask: 60_010, at: 0 };
  // 10 bp from a 59,990 oracle price: 60,049.99 floored to the 1 USD tick, under the 60,070 the touch gives.
  assert.equal(takerPrice('buy', q, 10, BTC, 60_005, null, 59_990), 60_049);
  assert.equal(takerPrice('sell', q, 10, BTC, 60_005, null, 60_100), 60_040);
  assert.equal(takerPrice('buy', q, 10, BTC, 60_005, null, null), 60_070, 'none given: the touch');
  const c = parseCheck({ kind: 'twap', symbol: 'BTC-USD', side: 'buy', quantity: '1', durationMs: 600_000, slices: 10, exec: { style: 'taker', slippageBps: 10, slipFrom: 'oracleMid' } });
  assert.equal(c.spec?.kind === 'twap' && c.spec.exec.slipFrom, 'oracleMid');
  const old = parseCheck({ kind: 'twap', symbol: 'BTC-USD', side: 'buy', quantity: '1', durationMs: 600_000, slices: 10, exec: { style: 'taker', slippageBps: 10 } });
  assert.equal(old.spec?.kind === 'twap' && 'slipFrom' in old.spec.exec, false, 'an old spec is unchanged');
  assert.ok(parseCheck({ kind: 'twap', symbol: 'BTC-USD', side: 'buy', quantity: '1', durationMs: 600_000, slices: 10, exec: { slipFrom: 'moon' } }).errors['exec.slipFrom']);
});

test('min child: one step, the minimum quantity, and the minimum order value', () => {
  close(minChildQty(BTC, 60_000), 0.00017, 1e-12);
  close(minChildQty({ ...BTC, minNotional: 0 }, 60_000), 0.00001, 1e-12);
});

test('trailing: a sell stop trails the high; activation waits; a buy stop trails the low', () => {
  let st = { armed: false, extreme: null as number | null };
  const o = { trailPct: 0.01, trailAbs: null, activationPrice: 105 };
  let r = trail(st, 'sell', 100, o);
  assert.equal(r.state.armed, false);
  r = trail(r.state, 'sell', 106, o);
  assert.equal(r.state.armed, true);
  close(r.stop!, 104.94);
  r = trail(r.state, 'sell', 110, o);
  close(r.stop!, 108.9);
  assert.equal(r.fired, false);
  r = trail(r.state, 'sell', 108.8, o);
  assert.equal(r.fired, true);
  st = { armed: false, extreme: null };
  let b = trail(st, 'buy', 50, { trailPct: null, trailAbs: 2, activationPrice: null });
  b = trail(b.state, 'buy', 45, { trailPct: null, trailAbs: 2, activationPrice: null });
  assert.equal(b.stop, 47);
  assert.equal(trail(b.state, 'buy', 47.5, { trailPct: null, trailAbs: 2, activationPrice: null }).fired, true);
});

test('volume profile: the median of the same slot on past days, floored at a tenth of the mean', () => {
  const start = Date.UTC(2026, 9, 21, 12, 0); // a Wednesday
  const candles = [];
  for (let d = 1; d <= 5; d++) {
    for (let h = 0; h < 2; h++) {
      const t = start - d * DAY_MS + h * 3_600_000;
      candles.push({ t, v: h === 0 ? 100 + d : 0 });
    }
  }
  const p = volumeProfile(candles, 3_600_000, start, 2 * 3_600_000, 2, 5);
  assert.equal(p.days, 5);
  close(p.expected[0]!, 103);
  close(p.expected[1]!, 103 / 2 / 10, 1e-9);
  assert.ok(p.weights[0]! > 0.9);
  close(sum(p.weights), 1);
});

test('adaptive share: between half and twice the schedule, never past 1', () => {
  close(adaptiveShare(0.5, 0, 1000), 0.25);
  close(adaptiveShare(0.2, 1000, 1000), 0.4);
  close(adaptiveShare(0.5, 400, 1000), 0.45);
  close(adaptiveShare(1, 0, 1000), 1);
});

test('spec: errors are named by field; too many slices for the duration; nested conditional refused', () => {
  assert.ok(checkAlgoSpec(twap()).spec);
  const bad = checkAlgoSpec(twap({ quantity: '-1', slices: 500, durationMs: 60_000 }));
  assert.equal(bad.spec, null);
  assert.match(bad.errors.quantity!, /positive/);
  assert.match(bad.errors.slices!, /at most 12 slices/);
  const nested = checkAlgoSpec({
    kind: 'conditional',
    symbol: 'BTC-USD',
    side: 'buy',
    conditions: [{ type: 'price', symbol: 'BTC-USD', source: 'mark', op: 'below', value: 50_000 }],
    then: { type: 'algo', algo: { kind: 'conditional', symbol: 'BTC-USD', side: 'buy', conditions: [{ type: 'time', at: 1_900_000_000_000 }], then: { type: 'market', quantity: '1', slippageBps: 10 } } },
  });
  assert.equal(nested.spec, null);
  assert.ok(Object.values(nested.errors).some((e) => /cannot start another conditional/.test(e)));
  const tr = checkAlgoSpec({ kind: 'trailing', symbol: 'BTC-USD', side: 'sell', trailPct: 0.01, trailAbs: 50 });
  assert.match(tr.errors.trailPct!, /one of the two/);
});

test('spec: canonical - unknown keys dropped, quantities canonical, the same text every time', () => {
  const a = parseAlgoSpec({ ...twap({ quantity: '1.500' }), junk: 1 });
  assert.equal((a as { quantity: string }).quantity, '1.5');
  assert.equal('junk' in a, false);
  assert.equal(canonicalJSON(parseAlgoSpec(JSON.parse(canonicalJSON(a)))), canonicalJSON(a));
});

test('plan: SoDEX minimum per slice is an error with the fix in it', () => {
  const s = parseAlgoSpec(twap({ quantity: '0.001', slices: 20 }));
  const p = planAlgo(s, BTC, { now: 0, price: 60_000, seed: 1 });
  assert.ok(p.errors.some((e) => /under SoDEX's minimum of \$10.00 per order: use at most 6 slices/.test(e)), p.errors.join(' | '));
  const ok = planAlgo(parseAlgoSpec(twap({ quantity: '0.01', slices: 20 })), BTC, { now: 0, price: 60_000, seed: 1 });
  assert.deepEqual(ok.errors, []);
  close(sum(ok.children.map((c) => c.qty)), 0.01, 1e-12);
});

test('plan: scale ladder average, refused levels, crossing warning', () => {
  const s = parseAlgoSpec({ kind: 'scale', symbol: 'BTC-USD', side: 'buy', quantity: '0.1', from: 61_000, to: 59_000, orders: 5, distribution: 'linear', skew: 2, postOnly: true });
  const p = planAlgo(s, BTC, { now: 0, price: 60_000, seed: 1 });
  assert.equal(p.children.length, 5);
  assert.ok(p.avgPrice! < 60_000, 'more size lower down');
  assert.ok(p.warnings.some((w) => /post-only/.test(w)));
});

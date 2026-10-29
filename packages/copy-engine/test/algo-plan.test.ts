/**
 * The planner, one test per algo type: what the ticket previews and what
 * SoDEX would refuse. (TWAP's schedule, scale's ladder and the shared math are
 * in algo-math.test.ts.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAlgoSpec, exitLevels, parseAlgoSpec, planAlgo, sliceBounds, volumeProfile, DAY_MS, type AlgoSpec } from '../src/index.ts';
import { BTC } from './helpers.ts';

const NOW = Date.UTC(2026, 9, 21, 12, 0);
const ctx = (over: Record<string, unknown> = {}) => ({ now: NOW, price: 60_000, seed: 1, ...over });
const S = (x: Record<string, unknown>): AlgoSpec => parseAlgoSpec({ symbol: 'BTC-USD', side: 'buy', ...x });
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('twap: a time-sliced close is sized from the position and closes it whatever side the ticket shows', () => {
  const s = S({ kind: 'twap', closeShare: 0.5, durationMs: 600_000, slices: 4, exec: { style: 'taker' } });
  assert.equal(s.reduceOnly, true);
  const p = planAlgo(s, BTC, ctx({ positionSize: 0.01 }));
  close(p.total!, 0.005);
  close(sum(p.children.map((c) => c.qty)), 0.005, 1e-12);
  assert.ok(p.warnings.some((w) => /closes your long: it sells/.test(w)));
  assert.ok(planAlgo(s, BTC, ctx({ positionSize: 0 })).errors.some((e) => /no position/.test(e)));
  assert.ok(planAlgo(s, BTC, ctx()).warnings.some((w) => /Sized from your position/.test(w)));
});

test('twap: smallest and largest slice - small slices wait and go together, large ones are capped and the rest goes at the end', () => {
  assert.deepEqual(sliceBounds([1, 1, 1, 1], 2, Infinity, 1), [0, 2, 0, 2]);
  assert.deepEqual(sliceBounds([3, 3, 3], 0, 2, 1), [2, 2, 2]);
  const s = S({ kind: 'twap', quantity: '0.01', durationMs: 600_000, slices: 5, maxSliceQty: '0.0015', exec: { style: 'taker' } });
  const p = planAlgo(s, BTC, ctx());
  assert.equal(p.children.at(-1)!.tag, 'finish');
  close(p.children.at(-1)!.qty, 0.0025, 1e-9);
  assert.ok(p.warnings.some((w) => /holds back/.test(w)));
  const small = planAlgo(S({ kind: 'twap', quantity: '0.01', durationMs: 600_000, slices: 10, minSliceQty: '0.002', exec: { style: 'taker' } }), BTC, ctx());
  assert.equal(small.children.filter((c) => c.qty > 0).length, 5);
  assert.ok(checkAlgoSpec({ kind: 'twap', symbol: 'BTC-USD', side: 'buy', quantity: '1', durationMs: 600_000, slices: 5, minSliceQty: '0.5', maxSliceQty: '0.1' }).errors.minSliceQty);
});

test('vwap: the profile weights the slices; without one the preview is even and says so', () => {
  const s = S({ kind: 'vwap', quantity: '0.02', durationMs: 2 * 3_600_000, slices: 2, lookbackDays: 3 });
  const flat = planAlgo(s, BTC, ctx());
  assert.ok(flat.warnings.some((w) => /read when it starts/.test(w)));
  close(flat.children[0]!.qty, flat.children[1]!.qty, 1e-12);
  const candles = [];
  for (let d = 1; d <= 3; d++) candles.push({ t: NOW - d * DAY_MS, v: 300 }, { t: NOW - d * DAY_MS + 3_600_000, v: 100 });
  const profile = volumeProfile(candles, 3_600_000, NOW, 2 * 3_600_000, 2, 3);
  const p = planAlgo(s, BTC, ctx({ profile }));
  close(p.children[0]!.qty, 0.015, 1e-9);
  close(p.children[1]!.qty, 0.005, 1e-9);
});

test('pov: the pace at the last hour\'s volume, and a warning when the end time comes first', () => {
  // 20% of the total volume while others trade 5 an hour: 5 x 0.2 / 0.8 = 1.25 an hour.
  const s = S({ kind: 'pov', quantity: '2.5', rate: 0.2, exec: { style: 'taker' } });
  const p = planAlgo(s, BTC, ctx({ hourVolume: 5 }));
  assert.equal(p.endsAt, NOW + 2 * 3_600_000);
  const q = planAlgo(S({ kind: 'pov', quantity: '2.5', rate: 0.2, endAt: NOW + 3_600_000, exec: { style: 'taker' } }), BTC, ctx({ hourVolume: 5 }));
  assert.ok(q.warnings.some((w) => /about 50% by the end time/.test(w)));
  assert.equal(q.endsAt, NOW + 3_600_000);
});

test('iceberg: clips of the visible size; a clip under the minimum is refused; a large clip hides little', () => {
  const p = planAlgo(S({ kind: 'iceberg', quantity: '0.01', displayQty: '0.002', price: 59_900 }), BTC, ctx());
  assert.equal(p.children.length, 5);
  assert.ok(planAlgo(S({ kind: 'iceberg', quantity: '0.01', displayQty: '0.0001' }), BTC, ctx()).errors.some((e) => /under SoDEX/.test(e)));
  assert.ok(planAlgo(S({ kind: 'iceberg', quantity: '0.01', displayQty: '0.005' }), BTC, ctx()).warnings.some((w) => /hides little/.test(w)));
});

test('chase: one order, ending at its time limit; under the minimum is refused', () => {
  const p = planAlgo(S({ kind: 'chase', quantity: '0.01', timeoutMs: 60_000 }), BTC, ctx());
  assert.equal(p.children.length, 1);
  assert.equal(p.endsAt, NOW + 60_000);
  assert.ok(planAlgo(S({ kind: 'chase', quantity: '0.0001' }), BTC, ctx()).errors.length);
});

test('dca: one order per interval, the budget, the minimum', () => {
  const p = planAlgo(S({ kind: 'dca', perOrderUsd: 50, orders: 4, intervalMs: 3_600_000, dipPct: 0.05, dipMultiplier: 2 }), BTC, ctx());
  assert.equal(p.children.length, 4);
  assert.equal(p.endsAt, NOW + 3 * 3_600_000);
  assert.ok(p.warnings.some((w) => /set a total budget/.test(w)));
  assert.ok(planAlgo(S({ kind: 'dca', perOrderUsd: 10, orders: 2, intervalMs: 60_000 }), { ...BTC, minNotional: 20 }, ctx()).errors.length);
});

test('swarm: clips in waves', () => {
  const p = planAlgo(S({ kind: 'swarm', quantity: '0.006', clips: 6, inFlight: 2, waveMs: 3_000, slippageBps: 20 }), BTC, ctx());
  assert.equal(p.children.length, 6);
  assert.deepEqual(p.children.map((c) => c.at! - NOW), [0, 0, 3_000, 3_000, 6_000, 6_000]);
  assert.equal(p.endsAt, NOW + 6_000);
});

test('conditional: its window, and what it starts', () => {
  const p = planAlgo(
    S({ kind: 'conditional', conditions: [{ type: 'position', symbol: 'BTC-USD', op: 'flat' }], expiresAt: NOW + 86_400_000, then: { type: 'algo', algo: { kind: 'chase', symbol: 'BTC-USD', side: 'buy', quantity: '0.01' } } }),
    BTC,
    ctx(),
  );
  assert.equal(p.endsAt, NOW + 86_400_000);
  assert.ok(p.warnings.some((w) => /starts a Chase/.test(w)));
});

test('trailing: on the whole position, or an amount over the minimum', () => {
  assert.ok(planAlgo(S({ kind: 'trailing', side: 'sell', trailPct: 0.01 }), BTC, ctx()).warnings.some((w) => /whole position/.test(w)));
  assert.ok(planAlgo(S({ kind: 'trailing', side: 'sell', trailPct: 0.01, quantity: '0.0001' }), BTC, ctx()).errors.length);
});

test('basket: one leg per market, its value, and legs too small per clip', () => {
  const s = S({ kind: 'basket', legs: [{ symbol: 'BTC-USD', side: 'buy', usd: 600 }, { symbol: 'ETH-USD', side: 'sell', usd: 300 }], style: 'swarm', clips: 5, inFlight: 2, waveMs: 1_000, slippageBps: 20 });
  const p = planAlgo(s, BTC, ctx({ prices: (sym: string) => (sym === 'ETH-USD' ? 3_000 : null) }));
  assert.equal(p.children.length, 2);
  close(p.children[1]!.qty, 0.1);
  assert.equal(p.notional, 900);
  assert.equal(p.errors.length, 0);
  const tiny = S({ kind: 'basket', legs: [{ symbol: 'BTC-USD', side: 'buy', usd: 40 }, { symbol: 'ETH-USD', side: 'buy', usd: 600 }], style: 'swarm', clips: 5, inFlight: 1, waveMs: 0, slippageBps: 20 });
  assert.ok(planAlgo(tiny, BTC, ctx()).errors.some((e) => /^BTC-USD: (Each of the 5|All 5|\d+ of the 5) clips would be (about \$\d+(\.\d\d)?, )?under SoDEX's \$10 minimum/.test(e)), planAlgo(tiny, BTC, ctx()).errors.join(' | '));
  assert.ok(checkAlgoSpec({ kind: 'basket', symbol: 'BTC-USD', side: 'buy', legs: [{ symbol: 'BTC-USD', side: 'buy', usd: 50 }, { symbol: 'BTC-USD', side: 'sell', usd: 50 }], style: 'swarm', clips: 2, inFlight: 1, waveMs: 0, slippageBps: 10 }).errors.legs);
});

test('bracket: an entry with exits; exits on the wrong side of the price are refused', () => {
  const ok = planAlgo(S({ kind: 'bracket', quantity: '0.01', entry: 'market', exits: { tpPct: 0.02, slPct: 0.01 } }), BTC, ctx());
  assert.deepEqual(ok.errors, []);
  close(ok.exits!.tp!, 61_200);
  close(ok.exits!.sl!, 59_400);
  const bad = planAlgo(S({ kind: 'bracket', quantity: '0.01', entry: 'market', exits: { tpPrice: 59_000 } }), BTC, ctx());
  assert.ok(bad.errors.some((e) => /take-profit 59000 is on the wrong side/.test(e)));
  assert.ok(checkAlgoSpec({ kind: 'bracket', symbol: 'BTC-USD', side: 'buy', quantity: '0.01', entry: 'market' }).errors.exits);
  const lim = planAlgo(S({ kind: 'bracket', quantity: '0.01', entry: 'limit', price: 59_000, exits: { tpPct: 0.02 } }), BTC, ctx());
  close(lim.exits!.tp!, 60_180);
  // A buy-limit under the market: its exits guard the entry, not the price now.
  const under = planAlgo(S({ kind: 'bracket', quantity: '0.01', entry: 'limit', price: 59_000, exits: { tpPrice: 59_800, slPrice: 59_600 } }), BTC, ctx());
  assert.ok(!under.errors.some((e) => /take-profit/.test(e)), 'a take-profit above the entry is fine, though under the market');
  assert.ok(under.errors.some((e) => /stop-loss 59600 is on the wrong side of the expected entry \(59000\)/.test(e)), 'a stop over the entry would fire on the fill');
});

test('exits: levels from the average fill for a short, a price wins over a distance, and no exits on what opens nothing', () => {
  assert.deepEqual(exitLevels('sell', { tpPrice: null, slPrice: 110, tpPct: 0.1, slPct: null }, 100), { tp: 90, sl: 110 });
  assert.ok(checkAlgoSpec({ kind: 'twap', symbol: 'BTC-USD', side: 'buy', quantity: '0.01', durationMs: 600_000, slices: 2, reduceOnly: true, exits: { tpPct: 0.01 } }).errors.exits);
  assert.ok(checkAlgoSpec({ kind: 'bracket', symbol: 'BTC-USD', side: 'buy', quantity: '0.01', exits: { tpPrice: 50_000, slPrice: 55_000 } }).errors['exits.tpPrice']);
  assert.ok(checkAlgoSpec({ kind: 'conditional', symbol: 'BTC-USD', side: 'sell', conditions: [{ type: 'time', at: NOW }], then: { type: 'close', share: 1, slippageBps: 20 }, exits: { slPct: 0.01 } }).errors.exits);
});

test('position conditions parse: long / short / flat need no value; size and PnL do', () => {
  assert.ok(checkAlgoSpec({ kind: 'conditional', symbol: 'BTC-USD', side: 'buy', conditions: [{ type: 'position', symbol: 'ETH-USD', op: 'short' }], then: { type: 'market', quantity: '0.01', slippageBps: 10 } }).spec);
  assert.ok(checkAlgoSpec({ kind: 'conditional', symbol: 'BTC-USD', side: 'buy', conditions: [{ type: 'position', symbol: 'ETH-USD', op: 'pnlBelow' }], then: { type: 'market', quantity: '0.01', slippageBps: 10 } }).errors['conditions.0.value']);
});

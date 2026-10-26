/**
 * Fill fast (sweep.ts): the reference, the band on the tick, the remaining
 * size, the stop conditions, and a stale oracle (pause, never trade on it).
 * Run: npx tsx --test test/algo-sweep.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAlgoSpec, planAlgo, sweepBand, sweepReference, sweepStep, toGrid, type SweepState } from '../src/index.ts';

const NOW = 1_800_000_000_000;

const st = (over: Partial<SweepState> = {}): SweepState => ({
  side: 'buy',
  total: 1,
  filled: 0,
  pending: 0,
  startedAt: NOW - 1_000,
  now: NOW,
  timeoutMs: null,
  roundMs: 1_000,
  lastRoundAt: null,
  slippageBps: 50,
  tickSize: '0.1',
  stepSize: '0.001',
  minQty: () => 0.001,
  ref: { price: 100_000, sources: ['binance', 'binanceSpot'], fallback: false },
  ...over,
});

test('the reference is the median of the fresh Binance quotes, SoDEX only as the fallback', () => {
  const r = sweepReference([{ source: 'binance', price: 100, at: NOW }, { source: 'binanceSpot', price: 102, at: NOW - 1_000 }], { price: 90, at: NOW }, NOW)!;
  assert.equal(r.price, 101);
  assert.equal(r.fallback, false);
  // Binance spot stale: futures alone.
  assert.equal(sweepReference([{ source: 'binance', price: 100, at: NOW }, { source: 'binanceSpot', price: 102, at: NOW - 60_000 }], null, NOW)!.price, 100);
  // Both stale: the SoDEX mark, if fresh.
  const fb = sweepReference([{ source: 'binance', price: 100, at: NOW - 60_000 }], { price: 99, at: NOW - 500 }, NOW)!;
  assert.equal(fb.price, 99);
  assert.equal(fb.fallback, true);
  // Everything stale: none.
  assert.equal(sweepReference([{ source: 'binance', price: 100, at: NOW - 60_000 }], { price: 99, at: NOW - 60_000 }, NOW), null);
  // Other sources are not read here.
  assert.equal(sweepReference([{ source: 'hyperliquid', price: 100, at: NOW }], null, NOW), null);
});

test('the band edge is on the tick and never past the slippage', () => {
  assert.equal(sweepBand('buy', 100_000, 50, '0.1'), 100_500);
  assert.equal(sweepBand('sell', 100_000, 50, '0.1'), 99_500);
  // 1.23456 x 1.001 = 1.2357945...: a buy rounds down, a sell (1.2333254...) up.
  assert.equal(sweepBand('buy', 1.23456, 10, '0.0001'), 1.2357);
  assert.equal(sweepBand('sell', 1.23456, 10, '0.0001'), 1.2334);
  assert.equal(toGrid(0.3, '0.1', 'up'), 0.3);
  assert.equal(toGrid(0.31, '0.1', 'up'), 0.4);
});

test('each round sends the rest, floored to the step, at the band', () => {
  assert.deepEqual(sweepStep(st()), { type: 'send', price: 100_500, qty: 1 });
  assert.deepEqual(sweepStep(st({ filled: 0.4567 })), { type: 'send', price: 100_500, qty: 0.543 });
  assert.deepEqual(sweepStep(st({ side: 'sell', filled: 0.25 })), { type: 'send', price: 99_500, qty: 0.75 });
});

test('it waits while a round is out and between rounds', () => {
  assert.deepEqual(sweepStep(st({ pending: 0.5 })), { type: 'wait', reason: null });
  assert.deepEqual(sweepStep(st({ lastRoundAt: NOW - 400 })), { type: 'wait', reason: null });
  assert.equal(sweepStep(st({ lastRoundAt: NOW - 1_000 })).type, 'send');
});

test('no round while the book is outside the band: an IOC could fill nothing', () => {
  // Band edge 100,500 (buy) / 99,500 (sell).
  assert.deepEqual(sweepStep(st({ touch: 100_600 })), { type: 'wait', reason: null });
  assert.equal(sweepStep(st({ touch: 100_500 })).type, 'send');
  assert.equal(sweepStep(st({ touch: 100_100 })).type, 'send');
  assert.deepEqual(sweepStep(st({ side: 'sell', touch: 99_400 })), { type: 'wait', reason: null });
  assert.equal(sweepStep(st({ side: 'sell', touch: 99_600 })).type, 'send');
  assert.equal(sweepStep(st({ touch: null })).type, 'send', 'no book known: the IOC decides');
});

test('a stale oracle pauses it: nothing is sent', () => {
  const a = sweepStep(st({ ref: null }));
  assert.equal(a.type, 'wait');
  assert.match((a as { reason: string }).reason, /no fresh reference/);
});

test('it stops when filled, when the rest is under the minimum, and when time is up', () => {
  assert.deepEqual(sweepStep(st({ filled: 1 })), { type: 'done' });
  assert.deepEqual(sweepStep(st({ filled: 0.9995 })), { type: 'done' });
  assert.deepEqual(sweepStep(st({ filled: 0.99, minQty: () => 0.05 })), { type: 'done' });
  assert.deepEqual(sweepStep(st({ timeoutMs: 1_000, filled: 0.5 })), { type: 'expired', left: 0.5 });
  // Even with no reference, time still runs out.
  assert.equal(sweepStep(st({ timeoutMs: 1_000, ref: null })).type, 'expired');
});

test('the spec and its plan', () => {
  const c = checkAlgoSpec({ kind: 'sweep', symbol: 'BTC-USD', side: 'buy', quantity: '0.5', slippageBps: 30 });
  assert.deepEqual(c.errors, {});
  assert.equal(c.spec!.kind === 'sweep' && c.spec!.roundMs, 500);
  assert.ok(checkAlgoSpec({ kind: 'sweep', symbol: 'BTC-USD', side: 'buy', quantity: '0.5', slippageBps: 0 }).errors.slippageBps);
  const m = { name: 'BTC-USD', base: 'BTC', tickSize: '0.1', stepSize: '0.001', minNotional: 10, maxNotional: null, status: 'TRADING' } as never;
  const plan = planAlgo(c.spec!, m, { now: NOW, price: 100_000, seed: 1 });
  assert.equal(plan.children[0]!.price, 100_300);
  assert.equal(plan.errors.length, 0);
});

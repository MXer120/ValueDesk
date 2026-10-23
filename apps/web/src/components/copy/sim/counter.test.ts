/**
 * The replay of a counter-trade: the same engine on the leader's mirrored position.
 * Run (from apps/web): npx tsx --test src/components/copy/sim/counter.test.ts
 *
 * Fees 0, slippage 0, lot 0.001 TST, allocation $10,000, fixed ratio 10%.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CopyConfig, SimFill as Fill } from './types';
import { runCopySimulation, type SimOptions } from './engine';

const BASE: CopyConfig = {
  sizingMode: 'fixedRatio',
  allocationUsd: 10_000,
  ratio: 0.1,
  maxLeverage: 10,
  maxPositionUsd: 1e9,
  stopLossPct: null,
  drawdownStopPct: null,
  takeProfitPct: null,
  assetAllow: [],
  assetDeny: [],
  copyExisting: false,
  slippageBps: 0,
};
const OPTS: SimOptions = { feeRate: 0, lotSize: { TST: 0.001 } };

let seq = 0;
const fill = (side: 'buy' | 'sell', size: number, price: number, time: number): Fill => ({
  id: String(++seq), venue: 'hyperliquid', symbol: 'TST', coin: 'TST', side, price, size, notionalUsd: price * size,
  fee: 0, feeAsset: 'USDC', realizedPnl: null, dir: null, startPosition: null, orderId: null, time,
});

// The leader buys 100 at 100, adds 100 at 110, sells all 200 at 120: a winning long.
const WIN = () => [fill('buy', 100, 100, 1), fill('buy', 100, 110, 2), fill('sell', 200, 120, 3)];

test('a winning long, countered: short 10, short 10 more, buy back 20 - the mirror of the copy', () => {
  const copy = runCopySimulation(WIN(), BASE, OPTS);
  const counter = runCopySimulation(WIN(), { ...BASE, direction: 'counter' }, OPTS);
  const sizes = (r: typeof copy) => r.fills.map((t) => Math.round(t.size * 1e6) / 1e6);
  assert.deepEqual(sizes(copy), [10, 10, -20]);
  assert.deepEqual(sizes(counter), [-10, -10, 20]);
  // Copy: +10 x (120 - 100) + 10 x (120 - 110) = +300. The counter-trade loses exactly that.
  assert.ok(Math.abs(copy.pnl - 300) < 1e-6, `copy pnl ${copy.pnl}`);
  assert.ok(Math.abs(counter.pnl + 300) < 1e-6, `counter pnl ${counter.pnl}`);
  assert.equal(counter.openPositions.length, 0);
});

test('the leader flips long to short: the counter-trade flips short to long', () => {
  const r = runCopySimulation([fill('buy', 100, 100, 1), fill('sell', 200, 100, 2)], { ...BASE, direction: 'counter' }, OPTS);
  const sizes = r.fills.map((t) => Math.round(t.size * 1e6) / 1e6);
  // Short 10, then the flip: buy 10 to close and buy 10 to open long = +20 in one entry.
  assert.deepEqual(sizes, [-10, 20]);
});

test('the leader curve stays the leader\'s: the same in both directions', () => {
  const copy = runCopySimulation(WIN(), BASE, OPTS);
  const counter = runCopySimulation(WIN(), { ...BASE, direction: 'counter' }, OPTS);
  assert.equal(copy.leaderRoi, counter.leaderRoi);
});

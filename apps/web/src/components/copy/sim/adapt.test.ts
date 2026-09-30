/**
 * VsFill -> engine input: coins, order grouping, and the backward walk that
 * recovers the leader's position before every fill.
 * Run (from apps/web): npx tsx --test src/components/copy/sim/adapt.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { VsFill } from '../../../vsApi';
import { coinOf, dirConstraint, reconstructStartPositions, toSimFills } from './adapt';
import { runCopySimulation } from './engine';
import type { CopyConfig, SimFill } from './types';

let seq = 0;
function vs(side: 'buy' | 'sell', sz: number, px: number, time: number, o: Partial<VsFill> = {}): VsFill {
  return {
    id: String(++seq),
    time,
    symbol: 'BTC',
    side,
    px,
    sz,
    notional: px * sz,
    fee: 0,
    closedPnl: null,
    dir: null,
    ...o,
  };
}

const starts = (fills: SimFill[]): Array<number | null> =>
  [...fills].sort((a, b) => a.time - b.time).map((f) => f.startPosition);

test('coinOf: SoDEX perps and spot, Hyperliquid perps and spot', () => {
  assert.equal(coinOf('sodex', 'BTC-USD'), 'BTC');
  assert.equal(coinOf('sodex', 'vBTC_vUSDC'), 'BTC');
  assert.equal(coinOf('sodex', 'WSOSO_vUSDC'), 'WSOSO');
  assert.equal(coinOf('hyperliquid', 'ETH'), 'ETH');
  assert.equal(coinOf('hyperliquid', 'kPEPE'), 'KPEPE');
  assert.equal(coinOf('hyperliquid', 'PURR/USDC'), 'PURR');
  assert.equal(coinOf('hyperliquid', ''), '');
});

test('dirConstraint reads the venue labels and ignores the rest', () => {
  assert.deepEqual(dirConstraint('Open Long'), { before: null, after: 1 });
  assert.deepEqual(dirConstraint('Close Short'), { before: -1, after: null });
  assert.deepEqual(dirConstraint('Long > Short'), { before: 1, after: -1 });
  assert.equal(dirConstraint('Buy'), null);
  assert.equal(dirConstraint(null), null);
});

test('toSimFills maps fields, adds the venue and coin, and groups one millisecond into one order', () => {
  const { fills, reconstruction } = toSimFills('hyperliquid', [
    vs('buy', 1, 100, 5, { fee: 0.05, closedPnl: 1.5, dir: 'Open Long' }),
    vs('buy', 2, 101, 5),
  ]);
  assert.equal(reconstruction, null);
  assert.equal(fills[0]!.venue, 'hyperliquid');
  assert.equal(fills[0]!.coin, 'BTC');
  assert.equal(fills[0]!.price, 100);
  assert.equal(fills[0]!.size, 1);
  assert.equal(fills[0]!.fee, 0.05);
  assert.equal(fills[0]!.realizedPnl, 1.5);
  assert.equal(fills[0]!.feeAsset, null);
  assert.equal(fills[0]!.orderId, fills[1]!.orderId);
  assert.equal(toSimFills('hyperliquid', [vs('buy', 1, 1, 1)], { groupSameTime: false }).fills[0]!.orderId, null);
});

test('backward walk from the current position recovers every position-before', () => {
  // Leader is long 3 now. History: buy 2 (t1), buy 2 (t2), sell 1 (t3). So before t1 they held 0.
  const { fills, reconstruction } = toSimFills(
    'hyperliquid',
    [vs('sell', 1, 110, 3), vs('buy', 2, 100, 1), vs('buy', 2, 105, 2)],
    { positions: [{ symbol: 'BTC', side: 'long', size: 3 }] },
  );
  assert.deepEqual(starts(fills), [0, 2, 4]);
  assert.deepEqual(reconstruction!.markets, ['BTC']);
});

test('a position that predates the fills is found, so its close is not copied as a fresh short', () => {
  // Leader holds nothing now; the only fill in the window is a sell of 5 that closed a long.
  const { fills } = toSimFills('hyperliquid', [vs('sell', 5, 100, 1, { dir: 'Close Long' })], { positions: [] });
  assert.deepEqual(starts(fills), [5]);

  const config: CopyConfig = {
    sizingMode: 'fixedRatio', allocationUsd: 10_000, ratio: 0.1, maxLeverage: 10, maxPositionUsd: 1e9,
    stopLossPct: null, drawdownStopPct: null, takeProfitPct: null, assetAllow: [], assetDeny: [],
    copyExisting: false, slippageBps: 0,
  };
  const reconstructed = runCopySimulation(fills, config, { feeRate: 0, lotSize: { BTC: 0.001 } });
  assert.equal(reconstructed.copiedFills, 0);
  assert.equal(reconstructed.fills[0]!.skippedReason, 'pre-existing-position');

  // Without the walk, the engine would read the same close as a new 0.5 short.
  const naive = runCopySimulation(toSimFills('hyperliquid', [vs('sell', 5, 100, 1)]).fills, config, { feeRate: 0, lotSize: { BTC: 0.001 } });
  assert.equal(naive.fills[0]!.action, 'open');
  assert.equal(naive.fills[0]!.size, -0.5);
});

test('shorts, flips and several markets walk independently', () => {
  const { fills } = toSimFills(
    'hyperliquid',
    [
      vs('sell', 4, 100, 1),
      vs('buy', 6, 100, 2), // -4 -> +2: a flip
      vs('sell', 1, 3000, 1, { symbol: 'ETH' }),
    ],
    { positions: [{ symbol: 'BTC', side: 'long', size: 2 }, { symbol: 'ETH', side: 'short', size: 3 }] },
  );
  const btc = fills.filter((f) => f.symbol === 'BTC').sort((a, b) => a.time - b.time);
  assert.deepEqual(btc.map((f) => f.startPosition), [0, -4]);
  assert.equal(fills.find((f) => f.symbol === 'ETH')!.startPosition, -2);
});

test('a walk that contradicts the direction labels is rejected and left to the forward rebuild', () => {
  // Positions say flat, but the labels say these fills OPENED a long: the snapshot does not fit.
  const input = [
    vs('buy', 1, 100, 1, { dir: 'Open Long' }),
    vs('buy', 1, 100, 2, { dir: 'Open Long' }),
    vs('buy', 1, 100, 3, { dir: 'Open Long' }),
  ];
  const r = reconstructStartPositions('hyperliquid', toSimFills('hyperliquid', input).fills, []);
  assert.deepEqual(r.rejected, ['BTC']);
  assert.deepEqual(starts(r.fills), [null, null, null]);
});

test('spot markets and fills that already carry a position-before are left alone', () => {
  const base = toSimFills('sodex', [vs('buy', 1, 100, 1, { symbol: 'vBTC_vUSDC' }), vs('buy', 1, 100, 2, { symbol: 'BTC-USD' })]).fills;
  base[1] = { ...base[1]!, startPosition: 7 };
  const r = reconstructStartPositions('sodex', base, [{ symbol: 'BTC-USD', side: 'long', size: 8 }]);
  assert.equal(r.fills[0]!.startPosition, null);
  assert.equal(r.fills[1]!.startPosition, 7);
  assert.deepEqual(r.markets, []);
});

test('same-millisecond fills get positions in the engine\'s own order', () => {
  // Two prints of one buy order at t=5 and a sell at t=5 on the same market. The engine
  // sorts buys before sells at one time (order id 't:BTC:buy' < 't:BTC:sell').
  const { fills } = toSimFills(
    'hyperliquid',
    [vs('sell', 1, 100, 5), vs('buy', 2, 100, 5), vs('buy', 3, 100, 5)],
    { positions: [{ symbol: 'BTC', side: 'long', size: 4 }] },
  );
  const r = runCopySimulation(fills, {
    sizingMode: 'fixedRatio', allocationUsd: 10_000, ratio: 1, maxLeverage: 10, maxPositionUsd: 1e9,
    stopLossPct: null, drawdownStopPct: null, takeProfitPct: null, assetAllow: [], assetDeny: [],
    copyExisting: false, slippageBps: 0,
  }, { feeRate: 0, lotSize: { BTC: 0.001 } });
  // Buy 5 merged (0 -> 5), then sell 1 (5 -> 4). No re-sync means the positions lined up.
  assert.deepEqual(r.fills.map((t) => [t.action, t.leaderPositionBefore, t.leaderPositionAfter]), [
    ['open', 0, 5],
    ['decrease', 5, 4],
  ]);
});

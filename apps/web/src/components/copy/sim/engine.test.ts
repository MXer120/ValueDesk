/**
 * Copy simulation engine - hand-computed scenarios.
 * Run (from apps/web): npx tsx --test src/components/copy/sim/engine.test.ts
 *
 * Ported with the engine from the rejected web draft; every scenario is kept.
 * Unless a test says otherwise: fees 0, slippage 0, lot 0.001 TST / 0.0001 BTC,
 * min notional $10, allocation $10,000, no stops. Every expected number below
 * is worked out by hand in the comment next to it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CopyConfig, SimFill as Fill } from './types';
import { downsampleIndices, runCopySimulation, type SimOptions, type SimResult } from './engine';

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
const cfg = (o: Partial<CopyConfig> = {}): CopyConfig => ({ ...BASE, ...o });
const OPTS: SimOptions = { feeRate: 0, lotSize: { TST: 0.001, BTC: 0.0001 } };
const opt = (o: SimOptions = {}): SimOptions => ({ ...OPTS, ...o });

let seq = 0;
function fill(side: 'buy' | 'sell', size: number, price: number, time: number, o: Partial<Fill> = {}): Fill {
  return {
    id: String(++seq),
    venue: 'hyperliquid',
    symbol: 'TST',
    coin: 'TST',
    side,
    price,
    size,
    notionalUsd: price * size,
    fee: 0,
    feeAsset: 'USDC',
    realizedPnl: null,
    dir: null,
    startPosition: null,
    orderId: null,
    time,
    ...o,
  };
}

function approx(actual: number | null | undefined, expected: number, eps = 1e-6, msg = ''): void {
  assert.ok(
    typeof actual === 'number' && Math.abs(actual - expected) <= eps,
    `${msg} expected ${expected}, got ${String(actual)}`,
  );
}
const actions = (r: SimResult): string[] => r.fills.map((t) => t.action);
const sizes = (r: SimResult): number[] => r.fills.map((t) => Math.round(t.size * 1e6) / 1e6);

/* ------------------------------------------------------------ sizing modes */

test('proportional: follower notional = leader notional x followerEquity / leaderEquity', () => {
  const r = runCopySimulation(
    [fill('buy', 100, 100, 1), fill('sell', 50, 110, 2), fill('sell', 50, 120, 3)],
    cfg({ sizingMode: 'proportional' }),
    opt({ leaderEquity: 100_000 }),
  );
  // open: 100 x 10k/100k = 10 TST ($1000). decrease half at 110: sell 5 (+50). close 5 at 120 (+100).
  assert.deepEqual(actions(r), ['open', 'decrease', 'close']);
  assert.deepEqual(sizes(r), [10, -5, -5]);
  approx(r.fills[1]!.realizedPnl, 50);
  approx(r.fills[2]!.realizedPnl, 100);
  approx(r.endEquity, 10_150);
  approx(r.pnl, 150);
  approx(r.roi, 0.015);
  assert.equal(r.copiedFills, 3);
  assert.equal(r.skippedFills, 0);
  assert.equal(r.maxDrawdown, 0);
  assert.equal(r.leaderEquitySource, 'option');
  // Leader: +500 +1000 on a 100k base, normalised to 10k -> 10,150.
  approx(r.leaderCurve.at(-1)!.accountValue, 10_150);
  approx(r.leaderRoi, 0.015);
  assert.equal(r.from, 1);
  assert.equal(r.to, 3);
});

test('proportional: sizes against the leader equity series at each fill', () => {
  const r = runCopySimulation(
    [fill('buy', 100, 100, 10), fill('buy', 100, 100, 30)],
    cfg({ sizingMode: 'proportional' }),
    opt({
      leaderEquitySeries: [
        { t: 0, accountValue: 100_000, pnl: 0 },
        { t: 20, accountValue: 50_000, pnl: 0 },
      ],
    }),
  );
  // t10: E_L 100k -> target 10. t30: E_L 50k, leader 200 -> target 200 x 10k/50k = 40 -> buy 30.
  assert.equal(r.leaderEquitySource, 'series');
  assert.deepEqual(sizes(r), [10, 30]);
  approx(r.fills[1]!.followerPositionAfter, 40);
});

test('leader curve scales each PnL step by the leader equity at the time, so a deposit is not a gain or a loss', () => {
  const r = runCopySimulation(
    [fill('buy', 10, 100, 10), fill('sell', 10, 110, 20), fill('buy', 10, 100, 40), fill('sell', 10, 110, 50)],
    cfg({ ratio: 0.1 }),
    opt({
      leaderEquitySeries: [
        { t: 0, accountValue: 1_000, pnl: 0 },
        // A $9,000 deposit between the two round trips.
        { t: 30, accountValue: 10_000, pnl: 100 },
      ],
    }),
  );
  // Round trip 1: +100 on $1,000 = +10% -> +1,000 on the follower's 10k.
  // Round trip 2: +100 on $10,000 = +1% -> +100. Leader line ends at 11,100, not 10k x (1 + 200/1,000) = 12,000.
  approx(r.leaderCurve.at(-1)!.accountValue, 11_100);
  approx(r.leaderRoi, 0.11);
});

test('dust leader equity (a brand-new account) is ignored, not divided by', () => {
  const r = runCopySimulation(
    [fill('buy', 10, 100, 10), fill('sell', 10, 110, 20)],
    cfg({ sizingMode: 'proportional' }),
    opt({
      startAt: 5,
      leaderEquitySeries: [
        { t: 0, accountValue: 0.000001, pnl: 0 },
        { t: 8, accountValue: 10_000, pnl: 0 },
      ],
    }),
  );
  // The base is the first real equity, $10k: follower 10 x 10k/10k = 10, +100; leader +100 on 10k -> +100.
  approx(r.leaderEquityBase, 10_000);
  approx(r.fills[0]!.size, 10);
  approx(r.leaderCurve.at(-1)!.accountValue, 10_100);
});

test('proportional without any leader equity uses a flagged 1x estimate', () => {
  const r = runCopySimulation([fill('buy', 100, 100, 1), fill('sell', 100, 100, 2)], cfg({ sizingMode: 'proportional' }), opt());
  // Peak leader exposure $10k is taken as equity -> follower mirrors 1x: 100 x 10k/10k = 100.
  assert.equal(r.leaderEquitySource, 'estimated');
  approx(r.leaderEquityBase, 10_000);
  assert.deepEqual(sizes(r), [100, -100]);
  assert.ok(r.notes.some((n) => n.includes('Leader equity was not provided')));
});

test('fixedRatio: increase averages the entry, close realises against it', () => {
  const r = runCopySimulation(
    [fill('buy', 20, 50, 1), fill('buy', 20, 60, 2), fill('sell', 40, 70, 3)],
    cfg({ ratio: 0.1 }),
    opt(),
  );
  // 2 @ 50, +2 @ 60 -> 4 @ 55. Close 4 @ 70 -> +60.
  assert.deepEqual(actions(r), ['open', 'increase', 'close']);
  assert.deepEqual(sizes(r), [2, 2, -4]);
  approx(r.fills[2]!.realizedPnl, 60);
  approx(r.endEquity, 10_060);
});

test('fixedNotional: fixed USD per open, scaled on increases, same-fraction decreases', () => {
  const r = runCopySimulation(
    [fill('buy', 3, 100, 1), fill('buy', 3, 100, 2), fill('sell', 2, 100, 3), fill('sell', 4, 100, 4)],
    cfg({ sizingMode: 'fixedNotional', maxPositionUsd: 1_000 }),
    opt({ fixedNotionalUsd: 500 }),
  );
  // open $500 = 5; leader 3->6 (x2) -> 10 ($1000, at the cap); leader 6->4 -> 10 x 4/6 = 6.667
  // (sell floor(3.333/0.001) = 3333 lots = 3.333); close.
  assert.deepEqual(actions(r), ['open', 'increase', 'decrease', 'close']);
  assert.deepEqual(sizes(r), [5, 5, -3.333, -6.667]);
  approx(r.fills[2]!.followerPositionAfter, 6.667);
  approx(r.fills[3]!.followerPositionAfter, 0);
});

test('fixedNotional: default size is maxPositionUsd, so increases hit the cap', () => {
  const r = runCopySimulation(
    [fill('buy', 3, 100, 1), fill('buy', 3, 100, 2), fill('sell', 6, 100, 3)],
    cfg({ sizingMode: 'fixedNotional', maxPositionUsd: 1_000 }),
    opt(),
  );
  // open $1000 = 10; the add would need 20 ($2000) -> no room -> skipped; close 10.
  assert.deepEqual(actions(r), ['open', 'skip', 'close']);
  assert.deepEqual(r.skippedByReason, { 'max-position': 1 });
  assert.deepEqual(sizes(r), [10, 0, -10]);
});

/* ------------------------------------------------------ position lifecycle */

test('flip: close the old side (reduce-only), then open the new side', () => {
  const r = runCopySimulation(
    [
      fill('buy', 10, 100, 1, { startPosition: 0 }),
      fill('sell', 30, 90, 2, { startPosition: 10 }),
      fill('buy', 20, 80, 3, { startPosition: -20 }),
    ],
    cfg({ ratio: 0.1 }),
    opt(),
  );
  // +1 @100. Flip: sell 1 @90 (-10) and open -2 @90 -> one entry of -3. Close: buy 2 @80 (+20).
  assert.deepEqual(actions(r), ['open', 'flip', 'close']);
  assert.deepEqual(sizes(r), [1, -3, 2]);
  approx(r.fills[1]!.realizedPnl, -10);
  approx(r.fills[1]!.followerPositionAfter, -2);
  approx(r.fills[2]!.realizedPnl, 20);
  approx(r.endEquity, 10_010);
});

test('partial closes reduce by the same fraction as the leader', () => {
  const r = runCopySimulation(
    [fill('buy', 10, 100, 1), fill('sell', 2.5, 100, 2), fill('sell', 2.5, 100, 3), fill('sell', 5, 100, 4)],
    cfg({ ratio: 0.1 }),
    opt(),
  );
  // 1 -> 0.75 -> 0.5 -> 0.
  assert.deepEqual(sizes(r), [1, -0.25, -0.25, -0.5]);
  assert.deepEqual(
    r.fills.map((t) => Math.round(t.followerPositionAfter! * 1e6) / 1e6),
    [1, 0.75, 0.5, 0],
  );
});

test('copyExisting=false ignores positions opened before the start until the leader is flat', () => {
  const r = runCopySimulation(
    [
      fill('buy', 5, 100, 1, { startPosition: 5 }), // pre-existing 5 -> 10: ignored
      fill('sell', 10, 100, 2, { startPosition: 10 }), // closed: re-attach, still ignored
      fill('buy', 10, 100, 3, { startPosition: 0 }), // fresh position: copied
    ],
    cfg({ ratio: 0.1 }),
    opt(),
  );
  assert.deepEqual(actions(r), ['skip', 'skip', 'open']);
  assert.deepEqual(r.skippedByReason, { 'pre-existing-position': 2 });
  approx(r.fills[2]!.followerPositionAfter, 1);
});

test('copyExisting=false: a flip out of a pre-existing position copies only the new side', () => {
  const r = runCopySimulation([fill('sell', 15, 100, 1, { startPosition: 5 })], cfg({ ratio: 0.1 }), opt());
  // Leader +5 (pre-existing) -> -10. Close leg ignored, open -10 x 0.1 = -1.
  assert.deepEqual(actions(r), ['open']);
  assert.deepEqual(sizes(r), [-1]);
});

test('copyExisting=true joins the leader position at the first observed price', () => {
  const r = runCopySimulation([fill('buy', 5, 100, 1, { startPosition: 5 })], cfg({ ratio: 0.1, copyExisting: true }), opt());
  // Leader 5 -> 10; follower joins at 10 x 0.1 = 1.
  assert.deepEqual(actions(r), ['join']);
  assert.deepEqual(sizes(r), [1]);
});

test('startAt: warm-up fills reconstruct the leader position but are not copied', () => {
  const r = runCopySimulation(
    [fill('buy', 10, 100, 1), fill('sell', 10, 110, 5), fill('buy', 5, 100, 6)],
    cfg({ ratio: 0.1 }),
    opt({ startAt: 3 }),
  );
  // t1 is warm-up (leader 10 at the start = pre-existing). t5 closes it (skipped). t6 opens 0.5.
  assert.equal(r.warmupFills, 1);
  assert.equal(r.from, 3);
  assert.deepEqual(actions(r), ['skip', 'open']);
  assert.equal(r.fills[0]!.skippedReason, 'pre-existing-position');
  assert.equal(r.copiedFills + r.skippedFills + r.warmupFills, 3);
});

/* -------------------------------------------------------------- guards */

test('drawdown stop closes everything and halts copying', () => {
  const r = runCopySimulation(
    [fill('buy', 50, 100, 1), fill('buy', 1, 95, 2), fill('sell', 51, 110, 3)],
    cfg({ ratio: 1, allocationUsd: 1_000, drawdownStopPct: 0.2 }),
    opt(),
  );
  // 50 @100 ($5000, 5x). At 95 equity = 1000 - 250 = 750 -> 25% >= 20% -> close at 95, halt.
  assert.deepEqual(actions(r), ['open', 'drawdown-stop', 'skip', 'skip']);
  approx(r.fills[1]!.realizedPnl, -250);
  assert.equal(r.stoppedBy, 'drawdownStop');
  assert.equal(r.haltReason, 'drawdownStop');
  assert.equal(r.stoppedAt, 2);
  assert.deepEqual(r.skippedByReason, { halted: 2 });
  assert.equal(r.riskEvents.drawdownStop, 1);
  approx(r.endEquity, 750);
  approx(r.maxDrawdown, 0.25);
  assert.equal(r.openPositions.length, 0);
});

test('per-trade stop loss (fraction of margin) closes at the trigger and detaches the market', () => {
  const r = runCopySimulation(
    [fill('buy', 10, 100, 1), fill('buy', 1, 85, 2), fill('sell', 11, 95, 3), fill('buy', 10, 100, 4)],
    cfg({ ratio: 1, maxLeverage: 5, stopLossPct: 0.5 }),
    opt(),
  );
  // Margin at 5x: SL at -50% of margin = -10% price -> trigger 90. Mark 85 crosses it: close 10 @ 90 (-100).
  // t2 add and t3 close are skipped; t3 re-attaches; t4 opens again.
  assert.deepEqual(actions(r), ['open', 'stop-loss', 'skip', 'skip', 'open']);
  approx(r.fills[1]!.price, 90);
  approx(r.fills[1]!.realizedPnl, -100);
  assert.deepEqual(r.skippedByReason, { 'after-stop-loss': 2 });
  assert.equal(r.riskEvents.stopLoss, 1);
  assert.equal(r.stoppedBy, null);
  approx(r.endEquity, 9_900);
});

test('take profit closes at the trigger price', () => {
  const r = runCopySimulation(
    [fill('buy', 10, 100, 1), fill('buy', 1, 115, 2)],
    cfg({ ratio: 1, maxLeverage: 5, takeProfitPct: 0.5 }),
    opt(),
  );
  // TP at +50% of margin at 5x = +10% -> 110: +100.
  assert.deepEqual(actions(r), ['open', 'take-profit', 'skip']);
  approx(r.fills[1]!.realizedPnl, 100);
  assert.deepEqual(r.skippedByReason, { 'after-take-profit': 1 });
  approx(r.endEquity, 10_100);
});

test('account liquidation backstop: equity floored at zero, run halted', () => {
  const r = runCopySimulation(
    [fill('buy', 100, 100, 1), fill('buy', 1, 85, 2)],
    cfg({ ratio: 1, allocationUsd: 1_000 }),
    opt(),
  );
  // 100 @100 = 10x. At 85: equity 1000 - 1500 = -500 <= 2.5% x 8500 -> liquidated, floored at 0.
  assert.deepEqual(actions(r), ['open', 'liquidation', 'skip']);
  assert.equal(r.haltReason, 'liquidation');
  assert.equal(r.stoppedBy, 'drawdownStop');
  assert.equal(r.riskEvents.liquidation, 1);
  approx(r.endEquity, 0);
  assert.ok(r.notes.some((n) => n.includes('liquidated')));
});

test('leverage cap clamps an open, then blocks further adds', () => {
  const r = runCopySimulation(
    [fill('buy', 200, 100, 1), fill('buy', 10, 100, 2), fill('sell', 105, 100, 3)],
    cfg({ sizingMode: 'proportional', maxLeverage: 1 }),
    opt({ leaderEquity: 10_000 }),
  );
  // Target 200 ($20k) > 1x of $10k -> 100. Add: no room. Leader halves (210 -> 105): 100 -> 50.
  assert.deepEqual(actions(r), ['open', 'skip', 'decrease']);
  assert.deepEqual(sizes(r), [100, 0, -50]);
  assert.equal(r.fills[0]!.clampedBy, 'max-leverage');
  assert.equal(r.clampedFills, 1);
  assert.deepEqual(r.clampedByReason, { 'max-leverage': 1 });
  assert.deepEqual(r.skippedByReason, { 'max-leverage': 1 });
});

test('min notional skips small increases, accumulates the residual, exempts reduce-only', () => {
  const r = runCopySimulation(
    [fill('buy', 50, 100, 1), fill('buy', 60, 100, 2), fill('sell', 55, 100, 3), fill('sell', 55, 100, 4)],
    cfg({ ratio: 0.001 }),
    opt(),
  );
  // 0.05 ($5) < $10: skip. Leader 110 -> target 0.11 ($11): buy 0.11. Half: sell 0.055 ($5.50, reduce-only OK).
  assert.deepEqual(actions(r), ['skip', 'open', 'decrease', 'close']);
  assert.equal(r.fills[0]!.skippedReason, 'min-notional');
  assert.deepEqual(sizes(r), [0, 0.11, -0.055, -0.055]);
});

test('min notional is configurable per venue', () => {
  const r = runCopySimulation([fill('buy', 50, 100, 1)], cfg({ ratio: 0.001 }), opt({ minNotionalUsd: { hyperliquid: 1 } }));
  assert.deepEqual(sizes(r), [0.05]);
});

test('deny list (case-insensitive) and allow list', () => {
  const denied = runCopySimulation([fill('buy', 10, 100, 1), fill('sell', 10, 100, 2)], cfg({ assetDeny: ['tst'] }), opt());
  assert.equal(denied.copiedFills, 0);
  assert.deepEqual(denied.skippedByReason, { 'asset-denied': 2 });

  const allowed = runCopySimulation(
    [fill('buy', 10, 100, 1), fill('buy', 1, 50_000, 2, { symbol: 'BTC', coin: 'BTC' })],
    cfg({ assetAllow: ['BTC'] }),
    opt(),
  );
  assert.deepEqual(allowed.skippedByReason, { 'asset-not-allowed': 1 });
  assert.equal(allowed.copiedFills, 1);
  approx(allowed.fills[1]!.size, 0.1);
});

/* ------------------------------------------------------------ costs */

test('slippage (adverse), taker fee and builder fee', () => {
  const r = runCopySimulation(
    [fill('buy', 10, 100, 1), fill('sell', 10, 100, 2)],
    cfg({ ratio: 0.1, slippageBps: 10 }),
    opt({ feeRate: 0.0005, builderFeeTenthsBps: 50 }),
  );
  // Buy 1 @ 100.1: taker 0.05005 + builder 0.05005. Sell 1 @ 99.9: 0.04995 + 0.04995.
  // Realised -0.2 (slippage both ways), fees 0.2 -> equity 9999.6.
  approx(r.fills[0]!.price, 100.1);
  approx(r.fills[1]!.price, 99.9);
  approx(r.fills[1]!.realizedPnl, -0.2);
  approx(r.feesUsd, 0.2);
  approx(r.builderFeesUsd, 0.1);
  approx(r.slippageUsd, 0.2);
  approx(r.endEquity, 9_999.6);
  approx(r.volumeUsd, 200);
});

test('venue default taker fees apply when feeRate is not given', () => {
  const r = runCopySimulation([fill('buy', 10, 100, 1)], cfg({ ratio: 0.1 }), { lotSize: { TST: 0.001 } });
  approx(r.feesUsd, 100 * 0.00045); // Hyperliquid perps tier 0
  const s = runCopySimulation(
    [fill('buy', 10, 100, 1, { venue: 'sodex', symbol: 'TST-USD' })],
    cfg({ ratio: 0.1 }),
    { lotSize: { TST: 0.001 } },
  );
  approx(s.feesUsd, 100 * 0.0004); // SoDEX perps tier 0
});

/* ------------------------------------------------------------ data hygiene */

test('duplicates and unusable fills are skipped and counted; counts add up', () => {
  const a = fill('buy', 10, 100, 1);
  const r = runCopySimulation([a, { ...a }, fill('buy', 10, Number.NaN, 2), fill('sell', 10, 110, 3)], cfg(), opt());
  assert.deepEqual(r.skippedByReason, { duplicate: 1, 'invalid-fill': 1 });
  assert.equal(r.copiedFills, 2);
  assert.equal(r.copiedFills + r.skippedFills, 4);
  assert.ok(r.notes.some((n) => n.includes('duplicate')));
});

test('fills of one order at one time are merged into one copy', () => {
  const r = runCopySimulation(
    [fill('buy', 1, 100, 1, { orderId: 'o1' }), fill('buy', 2, 103, 1, { orderId: 'o1' }), fill('sell', 3, 110, 2)],
    cfg({ sizingMode: 'fixedNotional', maxPositionUsd: 1_000 }),
    opt(),
  );
  // One open of $1000 at VWAP 102 (not an open + a capped add).
  assert.deepEqual(actions(r), ['open', 'close']);
  assert.equal(r.fills[0]!.leaderFillCount, 2);
  approx(r.fills[0]!.leaderFill.price, 102);
  approx(r.fills[0]!.leaderFill.size, 3);
  assert.equal(r.copiedFills, 3);
});

test('fills without position-before (SoDEX) are reconstructed and flagged', () => {
  const r = runCopySimulation(
    [fill('buy', 10, 100, 1, { venue: 'sodex', symbol: 'TST-USD' }), fill('sell', 10, 105, 2, { venue: 'sodex', symbol: 'TST-USD' })],
    cfg(),
    opt(),
  );
  assert.deepEqual(actions(r), ['open', 'close']);
  approx(r.fills[1]!.realizedPnl, 5);
  assert.ok(r.notes.some((n) => n.includes('no position-before')));
});

test('empty input yields a flat, empty result', () => {
  const r = runCopySimulation([], cfg(), opt());
  assert.equal(r.fills.length, 0);
  assert.equal(r.equityCurve.length, 0);
  assert.equal(r.endEquity, 10_000);
  assert.equal(r.roi, 0);
  assert.equal(r.stoppedBy, null);
});

test('builderFeeOnReduce=false charges the builder fee on opens and adds only', () => {
  const r = runCopySimulation(
    [fill('buy', 10, 100, 1), fill('buy', 10, 100, 2), fill('sell', 10, 100, 3), fill('sell', 10, 100, 4)],
    cfg({ ratio: 0.1 }),
    opt({ builderFeeTenthsBps: 50, builderFeeOnReduce: false }),
  );
  // Open 1 ($100) and add 1 ($100) pay 5 bp each = 0.05 + 0.05. The decrease and the close pay none.
  assert.deepEqual(actions(r), ['open', 'increase', 'decrease', 'close']);
  approx(r.builderFeesUsd, 0.1);
  approx(r.fills[0]!.fee, 0.05);
  approx(r.fills[2]!.fee, 0);
  approx(r.fills[3]!.fee, 0);
  approx(r.endEquity, 10_000 - 0.1);
});

test('builderFeeOnReduce=false: a flip pays the builder fee on its open leg only', () => {
  const r = runCopySimulation(
    [fill('buy', 10, 100, 1, { startPosition: 0 }), fill('sell', 30, 100, 2, { startPosition: 10 })],
    cfg({ ratio: 0.1 }),
    opt({ builderFeeTenthsBps: 50, builderFeeOnReduce: false }),
  );
  // Open +1 ($100): 0.05. Flip: close 1 (free), open -2 ($200): 0.10.
  assert.deepEqual(actions(r), ['open', 'flip']);
  approx(r.fills[1]!.fee, 0.1);
  approx(r.builderFeesUsd, 0.15);
});

test('default builderFeeOnReduce charges every leg', () => {
  const r = runCopySimulation(
    [fill('buy', 10, 100, 1), fill('sell', 10, 100, 2)],
    cfg({ ratio: 0.1 }),
    opt({ builderFeeTenthsBps: 50 }),
  );
  approx(r.builderFeesUsd, 0.1);
});

/* ------------------------------------------------------ determinism & perf */

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A consistent leader history: random walk prices, positions that open, scale, reduce and flip. */
function genFills(n: number, seed: number): Fill[] {
  const r = rng(seed);
  const coins = [
    { coin: 'BTC', px: 60_000 },
    { coin: 'ETH', px: 3_000 },
    { coin: 'SOL', px: 150 },
    { coin: 'DOGE', px: 0.15 },
    { coin: 'HYPE', px: 30 },
  ];
  const pos = new Map<string, number>();
  const out: Fill[] = [];
  let t = 1_700_000_000_000;
  for (let i = 0; i < n; i++) {
    const c = coins[Math.floor(r() * coins.length)]!;
    c.px *= 1 + (r() - 0.5) * 0.01;
    const before = pos.get(c.coin) ?? 0;
    const unit = 20_000 / c.px;
    let delta: number;
    const u = r();
    if (before === 0 || u < 0.35) delta = (r() < 0.5 ? 1 : -1) * unit * (0.2 + r());
    else if (u < 0.7) delta = -before * (0.2 + r() * 0.6);
    else if (u < 0.9) delta = -before;
    else delta = -before * 2;
    if (Math.abs(delta) < 1e-12) delta = unit;
    const after = before + delta;
    pos.set(c.coin, Math.abs(after) < 1e-12 ? 0 : after);
    t += 1 + Math.floor(r() * 60_000);
    out.push(
      fill(delta > 0 ? 'buy' : 'sell', Math.abs(delta), c.px, t, {
        id: `${seed}-${i}`,
        symbol: c.coin,
        coin: c.coin,
        startPosition: before,
        fee: Math.abs(delta) * c.px * 0.00045,
        orderId: String(i),
      }),
    );
  }
  return out;
}

const RISKY = cfg({
  sizingMode: 'proportional',
  allocationUsd: 5_000,
  maxLeverage: 5,
  maxPositionUsd: 10_000,
  stopLossPct: 0.6,
  takeProfitPct: 1.5,
  drawdownStopPct: 0.5,
  slippageBps: 5,
});

const signature = (r: SimResult) => ({
  summary: [r.endEquity, r.copiedFills, r.skippedFills, r.feesUsd, r.maxDrawdown, r.stoppedAt, r.skippedByReason],
  log: r.fills.map((t) => [t.time, t.symbol, t.action, t.size, t.price, t.skippedReason, t.leaderFill.id]),
  curve: r.equityCurve,
});

test('determinism: identical input -> identical output; input order does not matter', () => {
  const fills = genFills(3_000, 7);
  const o = { leaderEquity: 250_000, builderFeeTenthsBps: 20 };
  const a = runCopySimulation(fills, RISKY, o);
  const b = runCopySimulation(fills, RISKY, o);
  assert.deepEqual(a, b);
  assert.ok(a.copiedFills > 100, 'the scenario should actually copy');

  const desc = runCopySimulation([...fills].reverse(), RISKY, o);
  const shuffled = [...fills];
  const r = rng(99);
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  const shuf = runCopySimulation(shuffled, RISKY, o);
  assert.deepEqual(signature(desc), signature(a));
  assert.deepEqual(signature(shuf), signature(a));
  // leaderIndex points into the caller's array.
  for (const t of shuf.fills.slice(0, 50)) assert.equal(shuffled[t.leaderIndex]!.id, t.leaderFill.id);
});

test('performance: 100k fills in under ~1s, counts add up, curve is bounded', () => {
  const fills = genFills(100_000, 42);
  runCopySimulation(fills.slice(0, 2_000), RISKY, { leaderEquity: 250_000 }); // JIT warm-up
  // The fastest of up to three runs: the deploy gate runs three suites at once on a shared build
  // machine (Vercel, 2026-10-29: 1030 ms), and one slow run there is contention, not the code.
  let ms = Infinity;
  let r!: ReturnType<typeof runCopySimulation>;
  for (let i = 0; i < 3 && ms >= 1_000; i++) {
    const t0 = performance.now();
    r = runCopySimulation(fills, { ...RISKY, drawdownStopPct: null }, { leaderEquity: 250_000 });
    ms = Math.min(ms, performance.now() - t0);
  }
  assert.ok(ms < 1_000, `took ${ms.toFixed(0)} ms (the fastest of up to 3 runs)`);
  assert.equal(r.copiedFills + r.skippedFills + r.warmupFills, 100_000);
  assert.ok(r.equityCurve.length <= 2_000 && r.equityCurve.length > 100);
  assert.equal(r.leaderCurve.length, r.equityCurve.length);
  for (let i = 1; i < r.equityCurve.length; i++) assert.ok(r.equityCurve[i]!.t > r.equityCurve[i - 1]!.t);
});

test('downsampling keeps the extremes and strictly increasing time', () => {
  const n = 10_000;
  const ts = Array.from({ length: n }, (_, i) => i);
  const a = ts.map((i) => Math.sin(i / 50) * 100 + (i === 6_543 ? -1_000 : 0));
  const b = ts.map((i) => i);
  const keep = downsampleIndices(ts, a, b, 200);
  assert.ok(keep.length <= 200);
  assert.ok(keep.includes(6_543), 'the global minimum survives');
  assert.equal(keep[0], 0);
  assert.equal(keep.at(-1), n - 1);
  const dup = downsampleIndices([1, 1, 2, 2, 3], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], 10);
  assert.deepEqual(dup, [1, 3, 4]);
});

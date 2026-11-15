import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAlgoSpec } from '@copy-engine';
import { HEDGE_DEFAULT, hedgeNumbers, hedgeProblems, hedgeSpecs, newPairId, mmrOf, type HedgeDraft } from './hedge';
import { mustTakeCode } from './hedgeRules';

const A = '0x00000000000000000000000000000000000000a1';
const B = '0x00000000000000000000000000000000000000b2';
const draft = (o: Partial<HedgeDraft> = {}): HedgeDraft => ({ ...HEDGE_DEFAULT, symbol: 'BTC-USD', partner: B, ...o });

test('a pair: two specs the engine takes, opposite sides, the same pair id, each naming the other', () => {
  const id = newPairId(() => 0.5);
  const { main, partner } = hedgeSpecs(draft(), A, id);
  const m = parseAlgoSpec(main);
  const p = parseAlgoSpec(partner!);
  assert.ok(m.kind === 'hedge' && p.kind === 'hedge');
  if (m.kind !== 'hedge' || p.kind !== 'hedge') return;
  assert.deepEqual([m.side, p.side, m.role, p.role, m.pairId === p.pairId, m.partner, p.partner], ['buy', 'sell', 'main', 'partner', true, B, A]);
  assert.equal(m.leverage, 40);
});

test('spot: one short leg, no pair', () => {
  const { main, partner } = hedgeSpecs(draft({ shape: 'spot', side: 'buy' }), A, newPairId());
  assert.equal(partner, null);
  const s = parseAlgoSpec(main);
  assert.ok(s.kind === 'hedge' && s.side === 'sell' && s.pairId === null);
});

test('problems: the second wallet must be another valid wallet; a real hedge needs a loss limit', () => {
  assert.ok(hedgeProblems(draft({ partner: 'x' }), A).partner);
  assert.ok(hedgeProblems(draft({ partner: A }), A).partner);
  assert.ok(hedgeProblems(draft({ maxLossUsd: null }), A).loss);
  assert.equal(hedgeProblems(draft({ maxLossUsd: null, paper: true }), A).loss, undefined);
  assert.ok(hedgeProblems(draft({ minLiqPct: 6, growLiqPct: 6 }), A).buffer);
  assert.deepEqual(hedgeProblems(draft(), A), {});
});

test('numbers: the size is set by the buffer, never the leverage alone; OI counts both legs', () => {
  // $200 margin a leg on BTC (40x): growLiq 6% allows about $200 / (0.0125 + 0.06 x 1.0125) = $2,700 a leg.
  const n = hedgeNumbers(draft({ sizeUsd: 100_000, marginUsd: 200 }), 100_000, 40);
  const mmr = mmrOf(40);
  assert.ok(Math.abs(n.maxLegUsd - 200 / (mmr + 0.06 * (1 + mmr))) < 1, String(n.maxLegUsd));
  assert.equal(n.legUsd, n.maxLegUsd);
  assert.equal(n.oiUsd, 2 * n.legUsd);
  assert.ok(Math.abs((n.liqDistance ?? 0) - 0.06) < 1e-9);
  // A smaller target: held as asked, the liquidation further away, a bigger move before both legs shrink.
  const small = hedgeNumbers(draft({ sizeUsd: 1_000, marginUsd: 200 }), 100_000, 40);
  assert.equal(small.legUsd, 1_000);
  assert.ok((small.liqDistance ?? 0) > 0.18 && (small.trimMove ?? 0) > 0.15);
  // Fees: both legs take, in and out.
  assert.ok(Math.abs(small.roundTripFeesUsd - 1_000 * 2 * 2 * (4.4 / 10_000)) < 1e-9);
});

test('a new second wallet without an inviter takes the code before its leg; one with an account or another code is never held', () => {
  assert.equal(mustTakeCode('none', false), true);
  assert.equal(mustTakeCode('none', true), false);
  assert.equal(mustTakeCode('none', null), false, 'SoDEX did not answer: not held');
  assert.equal(mustTakeCode('other', false), false);
  assert.equal(mustTakeCode('unknown', false), false);
});

test('safety is a share of the way to the liquidation, so a high leverage never trims at once (owner 2026-11-15)', async () => {
  const { buffersFor, startDistance } = await import('./hedge.ts');
  // BTC 40x: a leg starts about 1.23% from its liquidation.
  assert.ok(Math.abs(startDistance(40, 40) - 0.0125 / 1.0125) < 1e-9);
  for (const lev of [2, 5, 10, 20, 40]) {
    for (const s of ['early', 'balanced', 'late'] as const) {
      const b = buffersFor(lev, 40, s);
      assert.ok(b.minLiqPct >= 0.5 && b.growLiqPct > b.minLiqPct, `${lev}x ${s}: ${JSON.stringify(b)}`);
      // Never trims at the start: the buffer is inside the distance a leg starts with (or the engine's floor).
      assert.ok(b.minLiqPct < b.startPct || b.minLiqPct === 0.5, `${lev}x ${s}: trims at once`);
    }
  }
  const tenX = buffersFor(10, 40, 'balanced');
  assert.equal(tenX.minLiqPct, Math.round(tenX.startPct * 0.4 * 100) / 100);
  assert.ok(buffersFor(10, 40, 'early').minLiqPct > buffersFor(10, 40, 'late').minLiqPct, 'early shrinks sooner');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstMmr, hedgeClose, hedgePlan, liqDistance, maxQtyAt, spotHedgeMove, type HedgeCfg, type HedgeLeg } from '../src/algo/hedge.ts';

const MMR = 0.0125; // BTC 40x: initial 2.5%, maintenance half of it
const leg = (qty: number, equity: number, liq: number | null = null, maintenance: number | null = null): HedgeLeg => ({ qty, equity, liq, maintenance });
const cfg = (o: Partial<HedgeCfg> = {}): HedgeCfg => ({ targetQty: 1, minLiq: 0.03, growLiq: 0.06, sliceQty: 0.1, tolQty: 0.001, mmr: MMR, ...o });

test('liquidation distance: the closed form matches SoDEX-style liquidation prices both ways', () => {
  // 1 BTC long at 100k with 5k equity: liquidation where 5k - (100k - P) = 0.0125 P -> P = 95k / 0.9875
  const long = leg(1, 5_000);
  const pLong = 95_000 / (1 - MMR);
  assert.ok(Math.abs(liqDistance(long, 100_000, MMR)! - (100_000 - pLong) / 100_000) < 1e-12);
  const short = leg(-1, 5_000);
  const pShort = 105_000 / (1 + MMR);
  assert.ok(Math.abs(liqDistance(short, 100_000, MMR)! - (pShort - 100_000) / 100_000) < 1e-12);
  // SoDEX's own price wins when it sends one.
  assert.equal(liqDistance(leg(1, 5_000, 97_000), 100_000, MMR), 0.03);
  assert.equal(liqDistance(leg(0, 5_000), 100_000, MMR), Infinity);
});

test('maxQtyAt is the inverse of the distance: holding that much puts the liquidation exactly d away', () => {
  for (const sign of [1, -1] as const) {
    const q = maxQtyAt(10_000, 100_000, MMR, 0.04, sign);
    const d = liqDistance(leg(sign * q, 10_000), 100_000, MMR)!;
    assert.ok(Math.abs(d - 0.04) < 1e-9, `${sign}: ${d}`);
  }
  assert.equal(maxQtyAt(0, 100_000, MMR, 0.04, 1), 0);
});

test('another position in the same account eats the equity the hedge may count on', () => {
  const alone = maxQtyAt(10_000, 100_000, MMR, 0.04, 1);
  const shared = liqDistance(leg(alone, 10_000, null, alone * 100_000 * MMR + 2_000), 100_000, MMR)!;
  assert.ok(shared < 0.04);
});

test('grow: equal legs with room grow one slice each, long on leg 0 and short on leg 1', () => {
  const p = hedgePlan([leg(0, 10_000), leg(0, 10_000)], 100_000, 'buy', cfg());
  assert.deepEqual(p.moves.map((m) => [m.leg, m.side, Number(m.qty.toFixed(6)), m.why]), [[0, 'buy', 0.1, 'grow'], [1, 'sell', 0.1, 'grow']]);
});

test('grow stops at what both accounts allow with the liquidation growLiq away (max leverage set, size by distance)', () => {
  // 10k each at 100k: growLiq 6% allows 10k / (100k x (0.0125 + 0.06 x 0.9875)) = 1.39 BTC long; target 5 BTC.
  const c = cfg({ targetQty: 5, sliceQty: 10 });
  const p = hedgePlan([leg(0, 10_000), leg(0, 10_000)], 100_000, 'buy', c);
  const long = maxQtyAt(10_000, 100_000, MMR, 0.06, 1);
  const short = maxQtyAt(10_000, 100_000, MMR, 0.06, -1);
  assert.ok(Math.abs(p.moves[0]!.qty - Math.min(long, short)) < 1e-9);
  // At that size nothing more is planned.
  const q = Math.min(long, short);
  assert.equal(hedgePlan([leg(q, 10_000), leg(-q, 10_000)], 100_000, 'buy', c).moves.length, 0);
});

test('trim: a move against the short leg brings its liquidation inside minLiq; both legs shrink by the same amount', () => {
  const c = cfg({ targetQty: 5, sliceQty: 10 });
  const q = 1.2;
  // Price up 4%: the short lost 4.8k of its 10k, the long gained it.
  const legs = [leg(q, 14_800), leg(-q, 5_200)] as const;
  const d = liqDistance(legs[1], 104_000, MMR)!;
  assert.ok(d < 0.03, `short leg ${d}`);
  const p = hedgePlan(legs, 104_000, 'buy', c);
  assert.equal(p.moves.length, 2);
  assert.ok(p.moves.every((m) => m.why === 'trim' && m.reduceOnly));
  assert.equal(p.moves[0]!.side, 'sell');
  assert.equal(p.moves[1]!.side, 'buy');
  assert.ok(Math.abs(p.moves[0]!.qty - p.moves[1]!.qty) < 1e-12);
  const after = q - p.moves[1]!.qty;
  const dAfter = liqDistance(leg(-after, 5_200), 104_000, MMR)!;
  assert.ok(Math.abs(dAfter - 0.045) < 1e-9, `after ${dAfter}`);
});

test('balance: a leg that filled less is brought up to the other; a liquidated leg takes the other one down', () => {
  const c = cfg({ targetQty: 2 });
  const p = hedgePlan([leg(0.5, 10_000), leg(-0.3, 10_000)], 100_000, 'buy', c);
  assert.deepEqual(p.moves.map((m) => [m.leg, m.side, Number(m.qty.toFixed(6)), m.why]), [[1, 'sell', 0.2, 'balance']]);
  // Leg 1 was liquidated: nothing left behind it, so leg 0 comes down to nothing.
  const gone = hedgePlan([leg(0.5, 10_500), leg(0, 3)], 100_000, 'buy', c);
  assert.ok(gone.moves.some((m) => m.leg === 0 && m.side === 'sell' && m.reduceOnly && Math.abs(m.qty - 0.5) < 1e-9));
  assert.ok(!gone.moves.some((m) => m.leg === 1 && !m.reduceOnly && m.qty > 0.01));
});

test('a leg on the wrong side is not traded', () => {
  const p = hedgePlan([leg(0.5, 10_000), leg(0.5, 10_000)], 100_000, 'buy', cfg());
  assert.equal(p.wrong, 1);
  assert.equal(p.moves.length, 0);
});

test('close: both legs down a slice at a time, evened out', () => {
  const m = hedgeClose([leg(0.35, 10_000), leg(-0.3, 10_000)], 'buy', 0.1, 0.001);
  assert.deepEqual(m.map((x) => [x.leg, x.side, Number(x.qty.toFixed(6))]), [[0, 'sell', 0.15], [1, 'buy', 0.1]]);
  const last = hedgeClose([leg(0.05, 10_000), leg(-0.05, 10_000)], 'buy', 0.1, 0.001);
  assert.deepEqual(last.map((x) => [x.leg, Number(x.qty.toFixed(6))]), [[0, 0.05], [1, 0.05]]);
});

test('spot shape: the short follows the coin held, never above it', () => {
  const l = leg(0, 50_000);
  const c = { targetQty: 1, sliceQty: 0.3, tolQty: 0.001 };
  assert.deepEqual(spotHedgeMove(0, 0.5, c, l, 100_000, MMR, 0.03), { leg: 0, side: 'sell', qty: 0.3, reduceOnly: false, why: 'grow' });
  const over = spotHedgeMove(-0.8, 0.5, c, leg(-0.8, 50_000), 100_000, MMR, 0.03)!;
  assert.equal(over.side, 'buy');
  assert.ok(over.reduceOnly && Math.abs(over.qty - 0.3) < 1e-9);
  assert.equal(spotHedgeMove(-0.5, 0.5, c, leg(-0.5, 50_000), 100_000, MMR, 0.03), null);
});

test('firstMmr: SoDEX tiers first, else half the initial rate at max leverage', () => {
  assert.equal(firstMmr([{ maintenanceMarginRate: '0.0125' }], 40), 0.0125);
  assert.equal(firstMmr(null, 25), 0.02);
});

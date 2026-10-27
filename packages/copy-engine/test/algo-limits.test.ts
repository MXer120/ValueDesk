/**
 * SoDEX's limits beyond one order (limits.ts) and children fitted to its
 * order sizes (fitOrders): the position limit per leverage tier, the
 * open-interest cap, its refusals, and what the ticket's plan says about them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bandRefused, checkLimits, fitOrders, limitRefusal, oiHeadroom, parseAlgoSpec, parseMarkets, planAlgo, positionCapUsd, type MarketInfo } from '../src/index.ts';
import { BTC } from './helpers.ts';

/** BTC-USD's tiers and caps as SoDEX listed them on 2026-10-27. */
const LIVE: MarketInfo = {
  ...BTC,
  maxNotional: 4_000_000,
  maxLeverage: 40,
  initLeverage: 20,
  marginTiers: [
    { maxNotionalValue: 4_000_000, maxLeverage: 40 },
    { maxNotionalValue: 100_000_000, maxLeverage: 25 },
    { maxNotionalValue: 200_000_000_000, maxLeverage: 1 },
  ],
  openInterestCap: 2_000_000,
  openInterestCapUSD: 200_000_000,
};
const NOW = Date.UTC(2026, 9, 27, 12, 0);
const S = (x: Record<string, unknown>) => parseAlgoSpec({ symbol: 'BTC-USD', side: 'buy', ...x });
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

test('parseMarkets reads SoDEX\'s tiers, caps and default leverage by their own names', () => {
  const [m] = parseMarkets([{ id: 1, name: 'DOGE-USD', baseCoin: 'DOGE', tickSize: '0.00001', stepSize: '1', minQuantity: '1', maxQuantity: '100000000', minNotional: '10', maxNotional: '2000000', maxLeverage: 10, initLeverage: 10, openInterestCap: '1000000000000', openInterestCapUSD: '5000000', marginTiers: [{ maxNotionalValue: '1000000000', maintenanceMarginRate: '0.1', maxLeverage: 5, maintenanceDeduction: '100000' }, { maxNotionalValue: '2000000', maintenanceMarginRate: '0.05', maxLeverage: 10, maintenanceDeduction: '0' }] }]);
  assert.equal(m!.initLeverage, 10);
  assert.equal(m!.openInterestCap, 1_000_000_000_000);
  assert.equal(m!.openInterestCapUSD, 5_000_000);
  assert.deepEqual(m!.marginTiers, [{ maxNotionalValue: 2_000_000, maxLeverage: 10 }, { maxNotionalValue: 1_000_000_000, maxLeverage: 5 }], 'by rising notional');
  const [bare] = parseMarkets([{ id: 2, name: 'X-USD', tickSize: '1', stepSize: '1' }]);
  assert.equal(bare!.marginTiers, undefined);
  assert.equal(bare!.openInterestCap, null);
});

test('position cap: the largest tier that still allows the leverage', () => {
  assert.equal(positionCapUsd(LIVE, 40), 4_000_000);
  assert.equal(positionCapUsd(LIVE, 30), 4_000_000);
  assert.equal(positionCapUsd(LIVE, 25), 100_000_000);
  assert.equal(positionCapUsd(LIVE, 2), 100_000_000);
  assert.equal(positionCapUsd(LIVE, 1), 200_000_000_000);
  assert.equal(positionCapUsd(LIVE, null), 200_000_000_000, 'leverage unknown: the cap at any leverage');
  assert.equal(positionCapUsd(LIVE, 50), 4_000_000, 'over every tier: the smallest');
  assert.equal(positionCapUsd(BTC, 10), null, 'no tiers listed');
});

test('open interest: the smaller of the coin and the USD cap, less what is open', () => {
  const doge = { openInterestCap: 1e12, openInterestCapUSD: 5_000_000 };
  const h = oiHeadroom(doge, 20_000_000, 0.2)!;
  assert.equal(h.cap, 25_000_000);
  assert.equal(h.room, 5_000_000);
  assert.equal(oiHeadroom(doge, 30_000_000, 0.2)!.room, 0);
  assert.equal(oiHeadroom(doge, null, 0.2), null, 'open interest not known');
  assert.equal(oiHeadroom({ openInterestCap: null, openInterestCapUSD: null }, 5, 1), null, 'no cap listed');
  assert.equal(oiHeadroom({ openInterestCap: 100, openInterestCapUSD: 1e9 }, 40, null)!.room, 60, 'without a price: the coin cap');
});

test('checkLimits: over the position limit is an error; a sell against a long counts only what it opens', () => {
  const over = checkLimits(LIVE, { side: 'buy', quantity: 10, price: 60_000, position: 60, leverage: 40, oi: null });
  assert.match(over.errors[0]!, /Your BTC-USD position would be about \$4,200,000, over SoDEX's limit of \$4,000,000 at 40x\. Use a smaller size or lower leverage\./);
  close(over.maxByPosition, 4_000_000 / 60_000 - 60);
  assert.deepEqual(checkLimits(LIVE, { side: 'buy', quantity: 10, price: 60_000, position: 60, leverage: 25, oi: null }).errors, []);
  // Short 60, buy 120: closes 60, opens 60 long - within 4M at 40x.
  const flip = checkLimits(LIVE, { side: 'buy', quantity: 120, price: 60_000, position: -60, leverage: 40, oi: null });
  assert.deepEqual(flip.errors, []);
  close(flip.maxByPosition, 60 + 4_000_000 / 60_000);
  // Long 60, sell 30: it only reduces.
  const less = checkLimits(LIVE, { side: 'sell', quantity: 30, price: 60_000, position: 60, leverage: 40, oi: 200_000_000 / 60_000 });
  assert.deepEqual([less.errors, less.warnings, less.oi], [[], [], null]);
  close(less.maxByOi, 60, 1e-6);
});

test('checkLimits: the open-interest cap warns when the order would hit it (red) or take 80% of what is left (amber)', () => {
  // Cap: min(2,000,000 BTC, $200M / 60,000 = 3,333.33 BTC). Open 3,233.33: 100 BTC ($6M) left.
  const oi = 200_000_000 / 60_000 - 100;
  const at = (q: number) => checkLimits(LIVE, { side: 'buy', quantity: q, price: 60_000, position: 0, leverage: 1, oi });
  assert.equal(at(50).oi, null);
  assert.deepEqual(at(50).warnings, []);
  const near = at(85);
  assert.equal(near.oi!.level, 'near');
  assert.match(near.warnings[0]!, /use 85% of the open interest still allowed on BTC-USD \(about \$6,000,000 left\)/);
  const hit = at(120);
  assert.equal(hit.oi!.level, 'over');
  assert.match(hit.warnings[0]!, /would hit SoDEX's open-interest cap on BTC-USD: about \$6,000,000 is left and it adds \$7,200,000/);
  assert.deepEqual(hit.errors, [], 'a warning: the open interest moves');
  close(hit.maxByOi, 100);
  const full = checkLimits(LIVE, { side: 'buy', quantity: 1, price: 60_000, position: 0, leverage: 1, oi: 200_000_000 / 60_000 });
  assert.match(full.warnings[0]!, /is at SoDEX's cap/);
});

test('limitRefusal: SoDEX\'s limit refusals are told apart from ordinary ones', () => {
  assert.equal(limitRefusal('order rejected: open interest cap exceeded', 'BTC-USD')!.kind, 'oi');
  assert.equal(limitRefusal('OpenInterest limit reached', 'BTC-USD')!.kind, 'oi');
  assert.equal(limitRefusal('exceeds max position size for current leverage', 'BTC-USD')!.kind, 'position');
  assert.equal(limitRefusal('risk limit exceeded', 'BTC-USD')!.kind, 'position');
  assert.equal(limitRefusal('too many open orders', 'BTC-USD')!.kind, 'orders');
  assert.equal(limitRefusal('SoDEX rejected the order: position not found: 1', 'BTC-USD'), null, 'reduce-only without a position is not a limit');
  assert.equal(limitRefusal('too many requests', 'BTC-USD'), null);
  assert.equal(limitRefusal('insufficient margin', 'BTC-USD'), null);
  assert.equal(limitRefusal(null, 'BTC-USD'), null);
  assert.equal(limitRefusal('open interest cap exceeded', 'ETH-USD')!.text, "SoDEX's open-interest cap on ETH-USD is reached.");
});

test('fitOrders: under the minimum they go out together, over the maximum they are split, nothing is lost', () => {
  const kids = (qs: number[]) => qs.map((qty, i) => ({ at: i * 1000, qty, price: null, tag: `slice ${i + 1}` }));
  const a = fitOrders(kids([1, 1, 1, 1, 1]), 2, Infinity, 1);
  assert.deepEqual(a.children.map((c) => [c.at, c.qty]), [[1000, 2], [3000, 3]], 'the last one goes with the one before');
  assert.equal(a.merged, 3);
  const b = fitOrders(kids([5, 1]), 1, 2, 1);
  assert.deepEqual(b.children.map((c) => [c.at, c.qty, c.tag]), [[0, 2, 'slice 1 (1/3)'], [0, 2, 'slice 1 (2/3)'], [0, 1, 'slice 1 (3/3)'], [1000, 1, 'slice 2']]);
  assert.equal(b.split, 2);
  assert.equal(b.merged, 0);
  assert.ok(b.children.every((c) => c.qty <= 2));
  const c = fitOrders(kids([0.5, 0.5]), 2, Infinity, 0.5);
  assert.deepEqual(c.children.map((x) => x.qty), [1], 'all under the minimum: one order with all of it');
});

test('plan: slices over SoDEX\'s largest order are split, not refused', () => {
  const p = planAlgo(S({ kind: 'twap', quantity: '200', durationMs: 600_000, slices: 2, exec: { style: 'taker' } }), LIVE, { now: NOW, price: 60_000, seed: 1 });
  assert.deepEqual(p.errors.filter((e) => /largest/.test(e)), []);
  assert.ok(p.children.every((c) => c.qty * 60_000 <= 4_000_000 + 1e-6), p.children.map((c) => c.qty).join(','));
  assert.ok(Math.abs(sum(p.children.map((c) => c.qty)) - 200) < 1e-9);
  assert.ok(p.warnings.some((w) => /Slices over SoDEX's largest order \(\$4,000,000\) are split: \d+ more orders/.test(w)), p.warnings.join(' | '));
});

test('plan: the position limit is an error and the open-interest cap a warning, both first; reduce-only is not checked', () => {
  const big = planAlgo(S({ kind: 'twap', quantity: '10', durationMs: 600_000, slices: 5, leverage: 40, exec: { style: 'taker' } }), LIVE, { now: NOW, price: 60_000, seed: 1, positionSize: 60 });
  assert.match(big.errors[0]!, /over SoDEX's limit of \$4,000,000 at 40x/);
  // No leverage on the spec: SoDEX's default for the market (initLeverage 20, the 25x tier: $100M).
  assert.deepEqual(planAlgo(S({ kind: 'twap', quantity: '10', durationMs: 600_000, slices: 5, exec: { style: 'taker' } }), LIVE, { now: NOW, price: 60_000, seed: 1, positionSize: 60 }).errors, []);
  const oi = 200_000_000 / 60_000 - 12;
  const near = planAlgo(S({ kind: 'chase', quantity: '10' }), LIVE, { now: NOW, price: 60_000, seed: 1, oi });
  assert.equal(near.oi!.level, 'near');
  assert.match(near.warnings[0]!, /83% of the open interest still allowed/);
  const over = planAlgo(S({ kind: 'sweep', quantity: '13', slippageBps: 20 }), LIVE, { now: NOW, price: 60_000, seed: 1, oi });
  assert.equal(over.oi!.level, 'over');
  assert.match(over.warnings[0]!, /would hit SoDEX's open-interest cap/);
  const dca = planAlgo(S({ kind: 'dca', perOrderUsd: 100_000, orders: 10, intervalMs: 3_600_000 }), LIVE, { now: NOW, price: 60_000, seed: 1, oi });
  assert.equal(dca.oi!.level, 'over', 'a DCA by its total in USD');
  const closing = planAlgo(S({ kind: 'chase', quantity: '13', reduceOnly: true, side: 'sell' }), LIVE, { now: NOW, price: 60_000, seed: 1, oi, positionSize: 13 });
  assert.equal(closing.oi, undefined);
});

test('plan: a resting price outside SoDEX\'s limit band is an error', () => {
  assert.equal(bandRefused('buy', [{ price: 63_100 }, { price: 62_900 }, { price: null }], LIVE, 60_000), 1);
  assert.equal(bandRefused('sell', [{ price: 56_900 }], LIVE, 60_000), 1);
  const p = planAlgo(S({ kind: 'bracket', quantity: '0.01', entry: 'limit', price: 64_000, exits: { tpPct: 0.02, slPct: 0.01 } }), LIVE, { now: NOW, price: 60_000, seed: 1 });
  assert.match(p.errors[0]!, /1 order is priced more than 5% over the price: SoDEX refuses a limit buy that far from the mark/);
});

function close(a: number, b: number, eps = 1e-9): void {
  assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
}

/**
 * SoDEX's limits beyond one order (limits.ts) and every child inside its
 * order sizes (sizes.ts: an error with the fix, never merged or split): the
 * position limit per leverage tier, the open-interest cap, its refusals, and
 * what the ticket's plan says about them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bandRefused, checkLimits, checkSizes, followerFromState, limitLeverage, limitRefusal, money, oiHeadroom, oiRoomWords, parseAlgoSpec, parseMarkets, planAlgo, positionCapUsd, type MarketInfo } from '../src/index.ts';
import { BTC, ETH } from './helpers.ts';

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
  assert.equal(over.errors[0], "Your BTC-USD position would be about $4.2M, over SoDEX's limit of $4M at 40x. You hold about $3.6M long now. At most about $400,000 (6.67 BTC) can be bought under it. Use a smaller size or lower leverage.");
  // A short adds on the sell side: the room is what it may still sell.
  const short = checkLimits(LIVE, { side: 'sell', quantity: 10, price: 60_000, position: -60, leverage: 40, oi: null });
  assert.match(short.errors[0]!, /You hold about \$3\.6M short now\. At most about \$400,000 \(6\.67 BTC\) can be sold under it/);
  // Already at the limit: nothing more.
  assert.match(checkLimits(LIVE, { side: 'buy', quantity: 1, price: 60_000, position: 4_000_000 / 60_000, leverage: 40, oi: null }).errors[0]!, /Nothing more can be added under it/);
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
  assert.equal(near.warnings[0], "Open interest on BTC-USD is at 97% of SoDEX's cap: about $6M (100 BTC) can still be added market-wide. This order would use 85% of that.");
  close(near.oi!.roomQty, 100, 1e-6);
  close(near.oi!.roomUsd, 6_000_000, 1e-3);
  const hit = at(120);
  assert.equal(hit.oi!.level, 'over');
  assert.equal(hit.warnings[0], "This order would hit SoDEX's open-interest cap on BTC-USD: it adds about $7.2M, and only about $6M (100 BTC) can still be added market-wide. SoDEX refuses what goes over the cap.");
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

test('oiRoomWords: the share of the cap in use, and what can still be added in USD and in the coin', () => {
  const eth = { name: 'ETH-USD', base: 'ETH' };
  assert.equal(oiRoomWords(eth, { cap: 2_660, open: 2_048, room: 612 }, 3_760), "Open interest on ETH-USD is at 76% of SoDEX's cap: about $2.3M (612 ETH) can still be added market-wide.");
  assert.equal(oiRoomWords(eth, { cap: 100, open: 100, room: 0 }, 3_760), "Open interest on ETH-USD is at SoDEX's cap: nothing can be added market-wide until it drops.");
  assert.deepEqual([money(6.2), money(10), money(120), money(12_345), money(5_200_000), money(1.3e9)], ['$6.20', '$10', '$120', '$12,345', '$5.2M', '$1.3B']);
});

test('sizes: slices under SoDEX\'s minimum are an error with the fix - never merged into fewer orders', () => {
  const twap = S({ kind: 'twap', quantity: '0.00124', durationMs: 600_000, slices: 12, exec: { style: 'taker' } });
  const p = planAlgo(twap, LIVE, { now: NOW, price: 60_000, seed: 1 });
  assert.equal(p.errors[0], "Each of the 12 slices would be about $6.20, under SoDEX's $10 minimum. Use at most 7 slices, or raise the size to $123.");
  assert.equal(p.children.length, 12, 'the plan still shows the 12 slices that were asked for');
  // The fix works: 7 slices, or the size it names.
  assert.deepEqual(planAlgo(S({ kind: 'twap', quantity: '0.00124', durationMs: 600_000, slices: 7, exec: { style: 'taker' } }), LIVE, { now: NOW, price: 60_000, seed: 1 }).errors, []);
  assert.deepEqual(planAlgo(S({ kind: 'twap', quantity: '0.00205', durationMs: 600_000, slices: 12, exec: { style: 'taker' } }), LIVE, { now: NOW, price: 60_000, seed: 1 }).errors, []);
  // Uneven slices (urgency, jitter): how many are under, and the smallest.
  const uneven = planAlgo(S({ kind: 'twap', quantity: '0.00124', durationMs: 600_000, slices: 12, sizeJitter: 0.3, urgency: 0.5, exec: { style: 'taker' } }), LIVE, { now: NOW, price: 60_000, seed: 1 });
  assert.match(uneven.errors[0]!, /^(\d+ of the|All) 12 slices would be under SoDEX's \$10 minimum \(the smallest about \$\d+\.\d\d\)\. Use at most \d+ slices, or raise the size to \$\d+\.$/);
  // Swarm clips, and the whole order under the minimum.
  assert.match(planAlgo(S({ kind: 'swarm', quantity: '0.004', clips: 200, inFlight: 20, waveMs: 0, slippageBps: 20 }), LIVE, { now: NOW, price: 60_000, seed: 1 }).errors[0]!, /^Each of the 200 clips would be about \$1\.20, under SoDEX's \$10 minimum\. Use at most 2\d clips, or raise the size to \$2,040\.$/);
  assert.match(planAlgo(S({ kind: 'twap', quantity: '0.0001', durationMs: 600_000, slices: 4, exec: { style: 'taker' } }), LIVE, { now: NOW, price: 60_000, seed: 1 }).errors[0]!, /The whole order is about \$6, under SoDEX's \$10 minimum\. Raise the size to at least \$10\.20\./);
});

test('sizes: slices over SoDEX\'s largest order are an error - never split into more orders', () => {
  const p = planAlgo(S({ kind: 'twap', quantity: '200', durationMs: 600_000, slices: 2, exec: { style: 'taker' } }), LIVE, { now: NOW, price: 60_000, seed: 1 });
  assert.equal(p.errors[0], "Each slice would be about $6M, over SoDEX's $4M per order on BTC-USD. Use at least 4 slices.");
  assert.equal(p.children.length, 2);
  assert.deepEqual(planAlgo(S({ kind: 'twap', quantity: '200', durationMs: 600_000, slices: 4, exec: { style: 'taker' } }), LIVE, { now: NOW, price: 60_000, seed: 1 }).errors, []);
  // One order (a chase, Fill fast, a bracket's entry): over the largest, it names the most and the algos that spread it.
  assert.equal(planAlgo(S({ kind: 'chase', quantity: '100' }), LIVE, { now: NOW, price: 60_000, seed: 1 }).errors[0], "The order would be about $6M, over SoDEX's $4M per order on BTC-USD. Use at most 66.66666 BTC, or a TWAP or Swarm to spread it over several orders.");
  assert.match(planAlgo(S({ kind: 'sweep', quantity: '0.0001', slippageBps: 20 }), LIVE, { now: NOW, price: 60_000, seed: 1 }).errors[0]!, /^The order would be about \$6, under SoDEX's \$10 minimum\. Raise the size to at least 0\.00017 BTC/);
  assert.match(planAlgo(S({ kind: 'bracket', quantity: '100', entry: 'market', exits: { slPct: 0.01 } }), LIVE, { now: NOW, price: 60_000, seed: 1 }).errors.join(' '), /The entry would be about \$6M, over SoDEX's \$4M per order/);
});

test('sizes: a DCA ladder, a scale and a DCA are never merged: each level or order must fit by itself', () => {
  const ladder = planAlgo(S({ kind: 'scale', quantity: '0.001', from: 60_000, to: 55_000, orders: 10 }), LIVE, { now: NOW, price: 60_000, seed: 1 });
  assert.equal(ladder.errors[0], "Each of the 10 orders would be about $5.75, under SoDEX's $10 minimum. Use at most 5 orders, or raise the size to $104.");
  // Two typed prices on one tick would be one order.
  const dup = planAlgo(S({ kind: 'scale', quantity: '0.01', from: 60_000, to: 58_000, orders: 3, prices: [60_000, 58_000.2, 58_000.4], label: 'DCA' }), LIVE, { now: NOW, price: 60_000, seed: 1 });
  assert.equal(dup.errors[0], "Orders 2 and 3 both land on 58000 (SoDEX's price step on BTC-USD is 1). Move them apart, or use fewer orders.");
  // A range narrower than its orders at the tick: an error (it used to be fewer levels, silently).
  assert.match(planAlgo(S({ kind: 'scale', quantity: '0.01', from: 60_000, to: 59_996, orders: 10 }), LIVE, { now: NOW, price: 60_000, seed: 1 }).errors[0]!, /^Only 5 different prices fit between 60000 and 59996 at SoDEX's price step of 1\. Use at most 5 orders, or a wider range\.$/);
  // A typed DCA ladder whose smaller levels are under the minimum: only the size is offered (the prices are the trader's).
  const typed = planAlgo(S({ kind: 'scale', quantity: '0.0006', from: 60_000, to: 54_000, orders: 3, prices: [60_000, 57_000, 54_000], weights: [1, 1, 4], label: 'DCA' }), LIVE, { now: NOW, price: 60_000, seed: 1 });
  assert.match(typed.errors[0]!, /^2 of the 3 orders would be under SoDEX's \$10 minimum \(the smallest about \$\d+\.\d\d\)\. Raise the size to \$59\.94, or use fewer orders\.$/);
  const dca = (x: Record<string, unknown>) => planAlgo(S({ kind: 'dca', orders: 5, intervalMs: 3_600_000, ...x }), LIVE, { now: NOW, price: 60_000, seed: 1 }).errors;
  assert.deepEqual(dca({ perOrderUsd: 1_000_000, dipPct: 0.05, dipMultiplier: 5 }), ["With the dip boost (5x), an order would be $5M, over SoDEX's $4M per order on BTC-USD. Use at most $800,000 per order, or a smaller boost."]);
  assert.deepEqual(dca({ perOrderUsd: 60, maxTotalUsd: 125 }), ["Your budget of $125 leaves a last order of $5, under SoDEX's $10 minimum. Use a budget of $120 or $180."]);
  assert.deepEqual(dca({ perOrderUsd: 60, maxTotalUsd: 130 }), [], 'a last order of $10 is one SoDEX takes');
});

test('sizes: a basket checks each market with its own rules and price; an iceberg its smallest and largest clip', () => {
  const s = S({ kind: 'basket', legs: [{ symbol: 'BTC-USD', side: 'buy', usd: 40 }, { symbol: 'ETH-USD', side: 'buy', usd: 30 }], style: 'swarm', clips: 5, inFlight: 1, waveMs: 0, slippageBps: 20 });
  const p = planAlgo(s, LIVE, { now: NOW, price: 60_000, seed: 1, market: (x) => (x === 'ETH-USD' ? ETH : null), prices: (x) => (x === 'ETH-USD' ? 3_000 : null) });
  assert.equal(p.errors.length, 2);
  assert.match(p.errors[0]!, /^BTC-USD: All 5 clips would be under SoDEX's \$10 minimum/);
  assert.match(p.errors[1]!, /^ETH-USD: All 5 clips would be under SoDEX's \$10 minimum .*Use at most 2 clips/);
  const ice = planAlgo(S({ kind: 'iceberg', quantity: '1', displayQty: '0.0002', displayJitter: 0.2 }), LIVE, { now: NOW, price: 60_000, seed: 1 });
  assert.equal(ice.errors[0], "The smallest visible clip (with clips changing up to 20% either way) would be about $9.60, under SoDEX's $10 minimum. Show at least 0.00022 BTC, or let the clips change less.");
  assert.deepEqual(ice.notes, ["When what is left after a clip is under SoDEX's $10 minimum, it goes out with that clip."]);
});

test('sizes: what the algo sizes as it runs is said before the start (notes), not hidden', () => {
  const pov = planAlgo(S({ kind: 'pov', quantity: '1', rate: 0.1, exec: { style: 'taker' } }), LIVE, { now: NOW, price: 60_000, seed: 1 });
  assert.deepEqual(pov.errors, []);
  assert.deepEqual(pov.notes, ["POV sizes each order from the market's volume as it runs: what is due waits until it reaches SoDEX's $10 minimum, and no order is over SoDEX's $4M per order on BTC-USD."]);
  assert.match(planAlgo(S({ kind: 'pov', quantity: '1', rate: 0.1, maxChildQty: '100', exec: { style: 'taker' } }), LIVE, { now: NOW, price: 60_000, seed: 1 }).errors[0]!, /Your largest child \(100 BTC, about \$6M\) is over SoDEX's \$4M per order on BTC-USD\. Lower it to 66\.66666 BTC or less\./);
  const maker = planAlgo(S({ kind: 'twap', quantity: '0.01', durationMs: 600_000, slices: 4, exec: { style: 'maker' } }), LIVE, { now: NOW, price: 60_000, seed: 1 });
  assert.deepEqual(maker.notes, ['A slice that has not filled when the next one is due rests together with it as one order.']);
  // A DCA never merges an unfilled order into the next one, so it says nothing of the kind.
  assert.deepEqual(planAlgo(S({ kind: 'dca', perOrderUsd: 60, orders: 5, intervalMs: 3_600_000, exec: { style: 'maker' } }), LIVE, { now: NOW, price: 60_000, seed: 1 }).notes, []);
  const closing = checkSizes(S({ kind: 'trailing', side: 'sell', trailPct: 0.01, reduceOnly: true }), LIVE, { price: 60_000, seed: 1, positionSize: 100 });
  assert.deepEqual(closing, { errors: [], notes: ["Closing about $6M is over SoDEX's $4M per order on BTC-USD: it closes in 2 orders, one after the other."] });
  assert.deepEqual(planAlgo(S({ kind: 'twap', quantity: '0.01', durationMs: 600_000, slices: 4, exec: { style: 'taker' } }), LIVE, { now: NOW, price: 60_000, seed: 1 }).notes, []);
});

test('plan: the position limit is an error and the open-interest cap a warning, both first; reduce-only is not checked', () => {
  const big = planAlgo(S({ kind: 'twap', quantity: '10', durationMs: 600_000, slices: 5, leverage: 40, exec: { style: 'taker' } }), LIVE, { now: NOW, price: 60_000, seed: 1, positionSize: 60 });
  assert.match(big.errors[0]!, /over SoDEX's limit of \$4M at 40x\. You hold about \$3\.6M long now/);
  // No leverage on the spec: SoDEX's default for the market (initLeverage 20, the 25x tier: $100M).
  assert.deepEqual(planAlgo(S({ kind: 'twap', quantity: '10', durationMs: 600_000, slices: 5, exec: { style: 'taker' } }), LIVE, { now: NOW, price: 60_000, seed: 1, positionSize: 60 }).errors, []);
  const oi = 200_000_000 / 60_000 - 12;
  const near = planAlgo(S({ kind: 'chase', quantity: '10' }), LIVE, { now: NOW, price: 60_000, seed: 1, oi });
  assert.equal(near.oi!.level, 'near');
  assert.match(near.warnings[0]!, /about \$720,000 \(12 BTC\) can still be added market-wide\. This order would use 83% of that/);
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

test('plan: the position held counts on its side for a live algo; a practice run starts from an empty paper book', () => {
  const at = (side: 'buy' | 'sell', positionSize: number, paper = false) => planAlgo(S({ kind: 'twap', side, quantity: '10', durationMs: 600_000, slices: 5, leverage: 40, paper, exec: { style: 'taker' } }), LIVE, { now: NOW, price: 60_000, seed: 1, positionSize }).errors;
  assert.match(at('buy', 60)[0]!, /You hold about \$3\.6M long now/);
  assert.deepEqual(at('sell', 60), [], 'a sell against the long reduces it');
  assert.match(at('sell', -60)[0]!, /You hold about \$3\.6M short now\. At most about \$400,000 \(6\.67 BTC\) can be sold under it/);
  assert.deepEqual(at('buy', -60), [], 'a buy against the short closes first');
  assert.deepEqual(at('buy', 60, true), [], 'paper: as the runtime counts it');
});

test('limitLeverage: own, then the position leverage as reported, then the SoDEX default, then the strictest tier - never a guessed 1x', () => {
  assert.equal(limitLeverage(LIVE, 5, 30), 5);
  assert.equal(limitLeverage(LIVE, null, 30), 30);
  assert.equal(limitLeverage(LIVE, null, null), 20);
  assert.equal(limitLeverage({ marginTiers: LIVE.marginTiers }, null, null), 40);
  assert.equal(limitLeverage({}, null, null), null);
  const snap = followerFromState({ P: [{ s: 'BTC-USD', sz: '1', ep: '60000' }, { s: 'ETH-USD', sz: '2', ep: '3000', l: 10 }] } as never);
  assert.deepEqual([snap.positions['BTC-USD']!.leverage, snap.positions['BTC-USD']!.leverageReported], [1, false], 'the 1x stays for others; the check sees it was not sent');
  assert.equal(snap.positions['ETH-USD']!.leverageReported, true);
});

function close(a: number, b: number, eps = 1e-9): void {
  assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
}

/**
 * Pure-logic tests for the order book's grouping and hover-popup maths.
 *   npx tsx --test src/components/bookDepth.test.ts
 *
 * THE PROPERTY UNDER TEST: the popup's Price is the focused row's own price -
 * its Price cell's text and the price a click on it fills the ticket with - and
 * its sums equal what a user gets by adding up the rows the book renders, from
 * the touch through that row - at every grouping step, on both sides, in both
 * display units - printed by the book's own cell formatters.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtPrice, fmtQty, precisionOf } from '../format';
import {
  aggregate,
  bucketOf,
  depthAt,
  depthFiguresAt,
  depthFiguresThrough,
  depthThrough,
  fmtNotional,
  rowFigures,
  withCumulative,
  type BookFormat,
  type BookLevel,
  type BookSide,
  type BookUnit,
  type RenderedLevel,
} from './bookDepth';
import { groupingSteps } from './bookGroup';

const close = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} !~ ${b}`);

// Raw ladders, best first, as the venue publishes them.
const ASKS: [string, string][] = [
  ['100.1', '2'],
  ['100.2', '1'],
  ['100.4', '3'],
  ['101.0', '4'],
];
const BIDS: [string, string][] = [
  ['99.9', '1'],
  ['99.8', '2'],
  ['99.5', '5'],
  ['99.0', '10'],
];

/** A deterministic, deep, uneven raw ladder around 1000 with tick 0.1. */
function rawLadder(side: BookSide, n: number): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < n; i++) {
    const price = side === 'ask' ? 1000.1 + i * 0.1 : 999.9 - i * 0.1;
    // Uneven sizes with fractional parts, and a few gaps (every 7th level empty).
    const qty = i % 7 === 3 ? 0 : ((i * 37) % 11) * 0.137 + 0.01;
    out.push([price.toFixed(1), qty.toFixed(3)]);
  }
  return out;
}

/** What Book() renders for one side: `nRows` buckets, best first (asks are reversed only for drawing). */
function renderedLadder(raw: [string, string][], inc: number, side: BookSide, nRows: number): BookLevel[] {
  return withCumulative(aggregate(raw, inc, side)).slice(0, nRows);
}

/** A user's manual check: add up the displayed Size cells from the touch through row `i`. */
function sumOfDisplayed(ladder: BookLevel[], i: number, unit: BookUnit): number {
  let s = 0;
  for (let k = 0; k <= i; k++) s += rowFigures(ladder[k]!, unit).size;
  return s;
}

test('groupingSteps: a BTC tick of 1 offers 1, 10, 100', () => {
  assert.deepEqual(groupingSteps(1), [1, 10, 100]);
});

test('groupingSteps: a tick of 0.01 does not offer 0.001', () => {
  const steps = groupingSteps(0.01);
  assert.deepEqual(steps, [0.01, 0.1, 1]);
  assert.ok(!steps.includes(0.001));
  assert.ok(steps.every((s) => s >= 0.01));
  for (const s of steps) {
    const q = s / 0.01;
    assert.equal(q, Math.round(q));
  }
});

test('aggregate: increment 10 puts bid 84592 in 84590 and ask 84601 in 84610', () => {
  assert.equal(aggregate([['84592', '1.5']], 10, 'bid')[0]!.price, 84590);
  assert.equal(aggregate([['84601', '2']], 10, 'ask')[0]!.price, 84610);
});

test('aggregate: a price already on the boundary stays in that bucket', () => {
  assert.equal(aggregate([['84590', '1']], 10, 'bid')[0]!.price, 84590);
  assert.equal(aggregate([['84610', '1']], 10, 'ask')[0]!.price, 84610);
  assert.equal(bucketOf(84590, 10, 'bid'), 84590);
  assert.equal(bucketOf(84610, 10, 'ask'), 84610);
});

test('bucketOf: asks round up, bids round down, away from the touch', () => {
  assert.equal(bucketOf(100.1, 0.5, 'ask'), 100.5);
  assert.equal(bucketOf(100.5, 0.5, 'ask'), 100.5);
  assert.equal(bucketOf(99.9, 0.5, 'bid'), 99.5);
  assert.equal(bucketOf(99.5, 0.5, 'bid'), 99.5);
});

test('bucketOf: float dust does not split a bucket', () => {
  // 0.1 * 3 is 0.30000000000000004 in binary floating point.
  assert.equal(bucketOf(0.3, 0.1, 'ask'), 0.3);
  assert.equal(bucketOf(0.30000000000000004, 0.1, 'bid'), 0.3);
});

test('bucketOf: a tick-aligned price is its own bucket at the 1x step', () => {
  // 0.07 / 0.01 === 7.000000000000001 - a bare Math.ceil put this ask in 0.08.
  assert.equal(bucketOf(0.07, 0.01, 'ask'), 0.07);
  assert.equal(bucketOf(0.29, 0.01, 'bid'), 0.29);
  for (const tick of [0.01, 0.001, 0.0001, 0.1, 0.5, 0.00001]) {
    for (let i = 1; i < 5000; i++) {
      const p = Number((i * tick).toFixed(8));
      assert.equal(bucketOf(p, tick, 'ask'), p, `ask ${p} @ ${tick}`);
      assert.equal(bucketOf(p, tick, 'bid'), p, `bid ${p} @ ${tick}`);
    }
  }
  // Off-edge prices still round outward.
  assert.equal(bucketOf(0.071, 0.01, 'ask'), 0.08);
  assert.equal(bucketOf(0.079, 0.01, 'bid'), 0.07);
});

test('aggregate skips zero-size levels and sorts best first', () => {
  const b = aggregate([['99', '0'], ['98', '1'], ['99.5', '2']], 1, 'bid');
  assert.deepEqual(b.map((x) => [x.price, x.qty]), [[99, 2], [98, 1]]);
});

test('asks: popup through the Nth level from the touch, at the 1x step', () => {
  const asks = withCumulative(aggregate(ASKS, 0.1, 'ask'));
  const top = depthThrough(asks, 0)!;
  assert.equal(top.price, 100.1);
  close(top.sumBase, 2);
  close(top.sumQuote, 200.2);
  assert.equal(top.levels, 1);
  // Through the third level: 2@100.1 + 1@100.2 + 3@100.4.
  const third = depthAt(asks, 100.4)!;
  const quote = 2 * 100.1 + 1 * 100.2 + 3 * 100.4;
  close(third.sumBase, 6);
  close(third.sumQuote, quote);
  assert.equal(third.price, 100.4);
  assert.equal(third.levels, 3);
});

test('asks render worst-first: the focused row sums DOWN to the touch, not up from the top', () => {
  const ladder = withCumulative(aggregate(ASKS, 0.1, 'ask')); // best first
  const drawn = [...ladder].reverse(); // what the book draws top-down
  // Focus the second row from the TOP of the ask block (100.4).
  const focused = drawn[1]!;
  const s = depthAt(ladder, focused.price)!;
  // Rows from the focused one down to the touch: drawn[1], drawn[2], drawn[3].
  const rows = drawn.slice(1);
  close(s.sumBase, rows.reduce((a, r) => a + r.qty, 0));
  close(s.sumQuote, rows.reduce((a, r) => a + r.price * r.qty, 0));
  // The deeper row above it (101.0) is NOT included.
  assert.ok(s.sumBase < ladder[ladder.length - 1]!.cum);
});

test('bids: popup accumulates downward from the best bid', () => {
  const bids = withCumulative(aggregate(BIDS, 0.1, 'bid'));
  const s = depthAt(bids, 99.5)!;
  const quote = 1 * 99.9 + 2 * 99.8 + 5 * 99.5;
  close(s.sumBase, 8);
  close(s.sumQuote, quote);
  assert.equal(s.price, 99.5);
});

test('grouping: figures come from the RENDERED buckets and their label prices', () => {
  // Step 0.5: asks 100.1/100.2/100.4 all ceil into 100.5; 101.0 stays 101.
  const asks = withCumulative(aggregate(ASKS, 0.5, 'ask'));
  assert.deepEqual(asks.map((l) => [l.price, l.qty]), [[100.5, 6], [101, 4]]);
  const first = depthAt(asks, 100.5)!;
  // The row reads 100.5 x 6, so the popup reads exactly that - not the raw
  // pre-grouping notional (2*100.1 + 1*100.2 + 3*100.4), which no visible row
  // shows and which is what made the old popup disagree with the book.
  close(first.sumBase, 6);
  close(first.sumQuote, 6 * 100.5);
  assert.equal(first.price, 100.5);
  const all = depthAt(asks, 101)!;
  close(all.sumBase, 10);
  close(all.sumQuote, 6 * 100.5 + 4 * 101);
  assert.equal(all.price, 101);
});

for (const side of ['ask', 'bid'] as const) {
  for (const inc of groupingSteps(0.1)) {
    test(`${side}s at step ${inc}: popup == sum of the visible rows, in both units, at every row`, () => {
      const tick = 0.1;
      // Enough raw levels that a coarse step still fills the rendered window.
      const need = Math.ceil((12 * inc) / tick) + 2;
      const ladder = renderedLadder(rawLadder(side, Math.max(400, need)), inc, side, 12);
      assert.ok(ladder.length >= 5, `enough rows at step ${inc} (${ladder.length})`);
      // Bucket prices ascend (asks) / descend (bids) away from the touch, one row each.
      for (let i = 1; i < ladder.length; i++) {
        assert.ok(side === 'ask' ? ladder[i]!.price > ladder[i - 1]!.price : ladder[i]!.price < ladder[i - 1]!.price);
      }
      for (let i = 0; i < ladder.length; i++) {
        const s = depthAt(ladder, ladder[i]!.price)!;
        assert.ok(s, `row ${i}`);
        assert.equal(s.levels, i + 1);
        // COIN display: the Size cells are base sizes, and they add up to Sum <BASE>.
        close(s.sumBase, sumOfDisplayed(ladder, i, 'base'));
        // USD display: the Size cells are price x size, and they add up to Sum USDC.
        close(s.sumQuote, sumOfDisplayed(ladder, i, 'quote'));
        // Sum <BASE> is base units even while the book displays USD.
        close(s.sumBase, ladder.slice(0, i + 1).reduce((a, r) => a + r.qty, 0));
        // The popup and the row's own Sum cell print the same number, bit for bit.
        assert.equal(s.sumBase, rowFigures(ladder[i]!, 'base').total);
        assert.equal(s.sumQuote, rowFigures(ladder[i]!, 'quote').total);
        // The popup's price is the focused row's own price.
        assert.equal(s.price, ladder[i]!.price);
      }
    });
  }
}

test('display unit: rowFigures prints price x size in quote and size in base', () => {
  const [l] = withCumulative([{ price: 250, qty: 0.4 }]);
  assert.deepEqual(rowFigures(l!, 'quote'), { size: 100, total: 100 });
  assert.deepEqual(rowFigures(l!, 'base'), { size: 0.4, total: 0.4 });
  // The popup does not depend on the unit at all.
  const s = depthThrough([l!], 0)!;
  assert.equal(s.sumBase, 0.4);
  assert.equal(s.sumQuote, 100);
});

test('the same raw set is summed at any step when the whole side is shown', () => {
  const fine = withCumulative(aggregate(BIDS, 0.1, 'bid'));
  const coarse = withCumulative(aggregate(BIDS, 1, 'bid'));
  // Step 1: 99.9/99.8/99.5/99.0 all floor into 99.
  assert.deepEqual(coarse.map((l) => l.price), [99]);
  close(depthAt(coarse, 99)!.sumBase, depthAt(fine, 99)!.sumBase);
});

test('depthAt / depthThrough return null off the rendered ladder', () => {
  const asks = withCumulative(aggregate(ASKS, 0.1, 'ask'));
  assert.equal(depthAt(asks, 100.3), null);
  assert.equal(depthAt([], 100), null);
  assert.equal(depthThrough(asks, -1), null);
  assert.equal(depthThrough(asks, asks.length), null);
  assert.equal(depthThrough(asks, 1.5), null);
  // A row that is off screen (sliced away) is not a level the popup can describe.
  assert.equal(depthAt(asks.slice(0, 2), 101), null);
});

test('live update: the same price re-resolves to the new cumulative figures', () => {
  const before = withCumulative(aggregate(ASKS, 0.1, 'ask'));
  // A new level appears nearer the touch; 100.2 now sits a row deeper.
  const after = withCumulative(aggregate([['100.0', '5'], ...ASKS], 0.1, 'ask'));
  const b = depthAt(before, 100.2)!;
  const a = depthAt(after, 100.2)!;
  close(a.sumBase, b.sumBase + 5);
  close(a.sumQuote, b.sumQuote + 500);
  assert.equal(a.levels, b.levels + 1);
});

// --- what the popup PRINTS ---------------------------------------------------
//
// THE OWNER'S RULE: "in the pop up the price needs to match the one in the OB
// to the ticket" - fixed once and for all: the popup's Price IS the hovered
// row's price, printed by the row's own Price-cell formatter (`fmtPrice` at the
// tick's places), which is also the price a click on that row fills the ticket
// with. It used to be the VWAP from the touch ("Avg. Price"), which lands
// between rows. Sum <BASE> and Sum USDC print through the book's own
// Size/Sum-cell formatters (`fmtQty` at the step's places, `fmtNotional`) over
// exact decimal sums.
//
// The reference below is deliberately independent of bookDepth.ts: it takes
// each row's cells as the book PRINTS them (price at tick dp, size at step
// dp), adds them up in exact decimal (BigInt), and rounds half-up itself.

const BTC: BookFormat = { tickSize: '1', stepSize: '0.00001' };
const SOL: BookFormat = { tickSize: '0.01', stepSize: '0.001' };

/** A printed cell as an exact decimal mantissa at `dp` places. */
const decOf = (v: number, dp: number): bigint => BigInt(v.toFixed(dp).replace('.', ''));
/** The positive rational num/den rounded half-up to `dp` places, as a PLAIN decimal (no separators). */
function roundHalfUp(num: bigint, den: bigint, dp: number): string {
  const f = 10n ** BigInt(dp);
  const q = (num * f * 2n + den) / (den * 2n);
  const int = (q / f).toString();
  return dp ? `${int}.${(q % f).toString().padStart(dp, '0')}` : int;
}
/** Places after the decimal point in a printed figure. */
const placesOf = (s: string): number => (s.includes('.') ? s.split('.')[1]!.length : 0);
/** What a user gets adding up the printed rows 0..i by hand, as exact decimals. */
function byHand(ladder: readonly RenderedLevel[], i: number, fmt: BookFormat) {
  const pd = precisionOf(fmt.tickSize);
  const qd = precisionOf(fmt.stepSize);
  let sq = 0n;
  let spq = 0n;
  for (let k = 0; k <= i; k++) {
    const P = decOf(ladder[k]!.price, pd);
    const Q = decOf(ladder[k]!.qty, qd);
    sq += Q;
    spq += P * Q;
  }
  const pScale = 10n ** BigInt(pd);
  const qScale = 10n ** BigInt(qd);
  return {
    pd,
    /** Exact Σ size, at the step's places. */
    sumBase: roundHalfUp(sq, qScale, qd),
    /** Exact Σ price x size, every place kept. */
    sumQuote: roundHalfUp(spq, pScale * qScale, pd + qd),
  };
}

test("REPRO (live BTC-USD capture): the popup Price is the hovered row's price, not a VWAP between rows", () => {
  // Rows as captured on /trade: 83,840 x 0.67682 (touch), 83,841 x 0.47717.
  const asks = withCumulative(aggregate([['83840', '0.67682'], ['83841', '0.47717']], 1, 'ask'));
  const f = depthFiguresAt(asks, 83841, BTC)!;
  assert.equal(f.levels, 2);
  // The hovered row prints 83,841 and a click on it fills the ticket with 83841.
  // The old "Avg. Price" printed the VWAP 83,840.41 rounded - 83,840, the price
  // of the row ABOVE the one under the pointer: "on a normal hover the price is wrong".
  assert.equal(f.text.price, '83,841');
  assert.equal(f.text.price, fmtPrice(83841, BTC.tickSize));
  // The ticket's price field is filled with BookRow's `priceStr`
  // (`v.toFixed(precisionOf(tickSize))`): the same number, without separators.
  assert.equal(f.text.price.replace(/,/g, ''), (83841).toFixed(precisionOf(BTC.tickSize)));
  assert.equal(f.text.sumBase, '1.15399');
  assert.equal(f.text.sumQuote, '96.75K');
});

test('REPRO (live BTC-USD capture): the 2nd bid shows its own price', () => {
  const bids = withCumulative(aggregate([['83829', '1.50672'], ['83828', '1.76143']], 1, 'bid'));
  const f = depthFiguresAt(bids, 83828, BTC)!;
  assert.equal(f.text.price, '83,828');
  assert.equal(f.text.sumBase, '3.26815');
  assert.equal(f.text.sumQuote, '273.96K');
});

test("Price prints exactly like the row's Price cell: tick places, separators, trailing zeros, bucket labels", () => {
  // Every level of a two-level book shows its own price, not a blend of the two.
  const two = withCumulative(aggregate([['83840', '1'], ['83841', '3']], 1, 'ask'));
  assert.equal(depthFiguresAt(two, 83840, BTC)!.text.price, '83,840');
  assert.equal(depthFiguresAt(two, 83841, BTC)!.text.price, '83,841');
  // SOL (tick 0.01): a price on a whole cent keeps the tick's places - 187.20, not 187.2.
  const s4 = withCumulative(aggregate([['187.10', '1'], ['187.20', '1']], 0.01, 'ask'));
  assert.equal(depthFiguresAt(s4, 187.2, SOL)!.text.price, '187.20');
  // A coarse grouping prints the BUCKET's label - which is what its row shows.
  const g = withCumulative(aggregate([['187.11', '1'], ['187.13', '1']], 0.05, 'ask'));
  assert.deepEqual(g.map((l) => l.price), [187.15]);
  assert.equal(depthFiguresAt(g, 187.15, SOL)!.text.price, '187.15');
});

test('Sum USDC is the EXACT sum of the printed rows, rounded half-up by the book\'s notional cell', () => {
  // 333 x 1 + 336 x 2 = 1,005 exactly -> 1.01K. A float `(1005 / 1e3).toFixed(2)` floors it to 1.00K.
  const asks = withCumulative(aggregate([['333', '1'], ['336', '2']], 1, 'ask'));
  const f = depthFiguresAt(asks, 336, { tickSize: '1', stepSize: '1' })!;
  assert.equal(f.text.sumQuote, '1.01K');
  assert.equal((1005 / 1e3).toFixed(2), '1.00');
  // 83,840 x 0.01338 + 83,841 x 0.09380 = 8,986.065 exactly (the float is 8986.064999999999).
  const b = withCumulative(aggregate([['83840', '0.01338'], ['83841', '0.09380']], 1, 'ask'));
  const g = depthFiguresAt(b, 83841, BTC)!;
  assert.equal(byHand(b, 1, BTC).sumQuote, '8986.06500');
  assert.equal(g.text.sumQuote, fmtNotional('8986.06500'));
  assert.equal(g.text.sumQuote, '8.99K');
});

test('fmtNotional: the book\'s K/M/B cell, half-up on decimal digits', () => {
  assert.equal(fmtNotional(0), '0.00');
  assert.equal(fmtNotional(12.345), '12.35');
  assert.equal(fmtNotional(2.675), '2.68'); // 2.675 is 2.67499... in binary; toFixed says 2.67
  assert.equal(fmtNotional(999.994), '999.99');
  assert.equal(fmtNotional(999.995), '1.00K');
  assert.equal(fmtNotional(1005), '1.01K');
  assert.equal(fmtNotional(922_470), '922.47K');
  assert.equal(fmtNotional(999_995), '1.00M'); // not 1000.00K
  assert.equal(fmtNotional(2_110_000), '2.11M');
  assert.equal(fmtNotional(123_456_789_012), '123.46B');
  assert.equal(fmtNotional('96750.99877'), '96.75K');
  assert.equal(fmtNotional(Number.NaN), '—');
  // Away from a rounding tie it prints exactly what the old float formatter did.
  const legacy = (v: number) =>
    v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(2)}K` : v.toFixed(2);
  let x = 12345;
  let checked = 0;
  for (let i = 0; i < 20000; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const v = (x / 2147483648) * 10 ** ((i % 11) + (x % 7) / 7);
    const scaled = v >= 1e9 ? v / 1e9 : v >= 1e6 ? v / 1e6 : v >= 1e3 ? v / 1e3 : v;
    if (Math.abs(scaled * 100 - Math.floor(scaled * 100) - 0.5) < 1e-6 || scaled >= 999.99) continue;
    assert.equal(fmtNotional(v), legacy(v), `v=${v}`);
    checked++;
  }
  assert.ok(checked > 19000, `checked ${checked}`);
});

test('huge sizes on a tiny tick do not lose precision (DOGE-like: tick 0.00001, step 1)', () => {
  const DOGE: BookFormat = { tickSize: '0.00001', stepSize: '1' };
  const bids = withCumulative(
    aggregate([['0.23457', '987654321'], ['0.23456', '123456789'], ['0.23455', '555555555']], 0.00001, 'bid'),
  );
  const f = depthFiguresAt(bids, 0.23455, DOGE)!;
  const ref = byHand(bids, 2, DOGE);
  assert.equal(f.text.sumBase, '1,666,666,665');
  assert.equal(f.text.sumBase, fmtQty(ref.sumBase, DOGE.stepSize));
  assert.equal(f.text.sumQuote, fmtNotional(ref.sumQuote));
  assert.equal(f.text.price, '0.23455');
  assert.equal(placesOf(f.text.price), 5);
});

test('the popup text is null off the rendered ladder', () => {
  const asks = withCumulative(aggregate(ASKS, 0.1, 'ask'));
  const fmt: BookFormat = { tickSize: '0.1', stepSize: '1' };
  assert.equal(depthFiguresAt(asks, 100.3, fmt), null);
  assert.equal(depthFiguresThrough(asks, asks.length, fmt), null);
  assert.equal(depthFiguresAt([], 100, fmt), null);
});

/** A deterministic pseudo-random ladder on a real tick/step grid. */
function randomLadder(side: BookSide, n: number, mid: number, tick: string, step: string, seed: number) {
  let x = seed;
  const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pd = precisionOf(tick);
  const qd = precisionOf(step);
  const out: [string, string][] = [];
  let ticks = Math.round(mid / Number(tick));
  for (let i = 0; i < n; i++) {
    ticks += side === 'ask' ? 1 + Math.floor(rnd() * 3) : -(1 + Math.floor(rnd() * 3));
    const steps = 1 + Math.floor(rnd() * rnd() * 2_000_000);
    out.push([(ticks * Number(tick)).toFixed(pd), (steps * Number(step)).toFixed(qd)]);
  }
  return out;
}

const MARKETS = [
  { name: 'BTC-USD', mid: 83_835, tick: '1', step: '0.00001' },
  { name: 'ETH-USD', mid: 3_921.4, tick: '0.1', step: '0.0001' },
  { name: 'SOL-USD', mid: 187.23, tick: '0.01', step: '0.001' },
  { name: 'XAUT-USD', mid: 3_345.6, tick: '0.1', step: '0.0001' },
  { name: 'DOGE-USD', mid: 0.23456, tick: '0.00001', step: '1' },
  { name: 'PUMP-USD', mid: 0.005123, tick: '0.000001', step: '1' },
  { name: 'vBTC_vUSDC (spot)', mid: 83_835.5, tick: '0.1', step: '0.00001' },
];
for (const mk of MARKETS) {
  for (const side of ['ask', 'bid'] as const) {
    test(`${mk.name} ${side}s: every row's popup Price == its row's price, and its sums == the exact sums, at every grouping`, () => {
      const fmt: BookFormat = { tickSize: mk.tick, stepSize: mk.step };
      for (const seed of [1, 7, 42, 1234]) {
        const out = randomLadder(side, 300, mk.mid, mk.tick, mk.step, seed);
        for (const inc of groupingSteps(Number(mk.tick))) {
          const ladder = renderedLadder(out, inc, side, 24);
          for (let i = 0; i < ladder.length; i++) {
            const f = depthFiguresThrough(ladder, i, fmt)!;
            const ref = byHand(ladder, i, fmt);
            const at = `${mk.name} ${side} step ${inc} seed ${seed} row ${i + 1}`;
            // Price: the focused row's own Price cell, character for character...
            assert.equal(f.text.price, fmtPrice(ladder[i]!.price, mk.tick), `Price ${at}`);
            // ...and the price a click on that row puts in the ticket.
            assert.equal(f.text.price.replace(/,/g, ''), ladder[i]!.price.toFixed(precisionOf(mk.tick)), `Ticket ${at}`);
            // Sums: the base and quote cells' formatters over the exact sums...
            assert.equal(f.text.sumBase, fmtQty(ref.sumBase, mk.step), `Sum base ${at}`);
            assert.equal(f.text.sumQuote, fmtNotional(ref.sumQuote), `Sum quote ${at}`);
            // ...which is exactly what the focused row's own Sum cell prints, in either display unit.
            assert.equal(f.text.sumBase, fmtQty(rowFigures(ladder[i]!, 'base').total, mk.step), `Sum cell (base) ${at}`);
            assert.equal(f.text.sumQuote, fmtNotional(rowFigures(ladder[i]!, 'quote').total), `Sum cell (quote) ${at}`);
          }
        }
      }
    });
  }
}

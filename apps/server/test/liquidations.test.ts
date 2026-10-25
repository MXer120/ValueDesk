/**
 * Run: npx tsx --test test/liquidations.test.ts   (from apps/server)
 *
 * The figures are live venue reads from 2026-10-25 (tools/liq-check.ts reproduced
 * every Hyperliquid, trade.xyz, Lighter and SoDEX figure it sampled).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountLiqs, addDrift, calibrate, emptyDrift, fillCash, flatTiers, mmOf, niceStep, solveLiq, tiersOf, type FillBook, type ReadPos,
} from '../src/valuescan/liquidations/math.js';
import { LevelsBuilder, bucketize, coinLevels, liqCoin, snapOfNow, type LevelPos } from '../src/valuescan/liquidations/levels.js';
import { hlTiers, lighterMarkets, sodexTiers } from '../src/valuescan/liquidations/rules.js';
import { applyFill, liqBacklogPrio, type Book } from '../src/indexer/cohortTracker.js';
import { IndexStore } from '../src/indexer/store.js';

const near = (a: number | null, b: number, tol = 1e-6) => assert.ok(a !== null && Math.abs(a - b) <= tol * Math.abs(b), `${a} vs ${b}`);

// Hyperliquid's tables (meta, 2026-10-25): BTC is table 56 (40x, 20x from $150M).
const HL_META = {
  universe: [
    { name: 'BTC', maxLeverage: 40, marginTableId: 56 },
    { name: 'ETH', maxLeverage: 25, marginTableId: 55 },
    { name: 'SOL', maxLeverage: 20, marginTableId: 54 },
    { name: 'LIT', maxLeverage: 5, marginTableId: 5 },
  ],
  marginTables: [
    [56, { marginTiers: [{ lowerBound: '0.0', maxLeverage: 40 }, { lowerBound: '150000000.0', maxLeverage: 20 }] }],
    [55, { marginTiers: [{ lowerBound: '0.0', maxLeverage: 25 }, { lowerBound: '100000000.0', maxLeverage: 15 }] }],
    [54, { marginTiers: [{ lowerBound: '0.0', maxLeverage: 20 }, { lowerBound: '70000000.0', maxLeverage: 10 }] }],
  ] as Array<[number, { marginTiers: Array<{ lowerBound: string; maxLeverage: number }> }]>,
};
const HL = hlTiers(HL_META);
const tiersFor = (s: string) => HL.get(s) ?? null;

test('tiers: Hyperliquid rate 1 / (2 x leverage), deductions keep the margin continuous; a table id under 50 is one tier', () => {
  const btc = HL.get('BTC')!;
  assert.equal(btc.length, 2);
  assert.equal(btc[0]!.r, 1 / 80);
  near(btc[1]!.ded, 150_000_000 * (1 / 40 - 1 / 80));
  // Continuous at the bound.
  near(mmOf(btc, 150_000_000 - 1e-6), mmOf(btc, 150_000_000), 1e-9);
  assert.deepEqual(HL.get('LIT'), flatTiers(0.1));
  // SoDEX publishes upper bounds and its own deductions.
  const sd = sodexTiers([{ name: 'ADA-USD', marginTiers: [
    { maxNotionalValue: '1000000', maintenanceMarginRate: '0.05', maintenanceDeduction: '0' },
    { maxNotionalValue: '1000000000', maintenanceMarginRate: '0.1', maintenanceDeduction: '50000' },
  ] }]).get('ADA-USD')!;
  assert.deepEqual(sd.map((t) => t.lb), [0, 1_000_000]);
  assert.equal(sd[1]!.ded, 50_000);
  // Lighter: 1e-4 units, one rate; spot books left out.
  const lm = lighterMarkets([{ symbol: 'BTC', market_type: 'perp', maintenance_margin_fraction: 120, open_interest: 5, mark_price: '80000' }, { symbol: 'ETH/USDC', market_type: 'spot' }]);
  assert.deepEqual(lm.tiers.get('BTC'), flatTiers(0.012));
  assert.equal(lm.tiers.size, 1);
  assert.deepEqual(lm.oi.get('BTC'), { oi: 5, px: 80000 });
});

test('Hyperliquid: one cross BTC short, from its account value', () => {
  // accountValue 7963.005348, BTC szi -0.0344, positionValue 2765.2096, liquidationPx 308016.507263853.
  const mark = 2765.2096 / 0.0344;
  const cash = 7963.005348 + 0.0344 * mark;
  near(solveLiq(HL.get('BTC')!, -0.0344, cash), 308016.507263853);
  const c = calibrate({ cash0: cash, positions: [{ symbol: 'BTC', szi: -0.0344, mark, vliq: 308016.507263853 }] }, tiersFor);
  assert.equal(c.checked, 1);
  assert.equal(c.matched, 1);
  near(c.cash, cash, 1e-9);
});

// A unified account (margin in spot): its cross summary says 121,912.96, but the venue's figures
// imply ~$489K of margin. Calibrated from BTC, the model reproduces the other three.
const UNIFIED: ReadPos[] = [
  { symbol: 'BTC', szi: -7.22568, mark: 580944.672 / 7.22568, vliq: 147225.8062770905 },
  { symbol: 'ETH', szi: -62.0476, mark: 144601.9318 / 62.0476, vliq: 10055.3988971813 },
  { symbol: 'SOL', szi: -1431.71, mark: 144302.0509 / 1431.71, vliq: 433.9394033306 },
  { symbol: 'LIT', szi: -22413, mark: 71361.086895 / 22413, vliq: 23.0140324865 },
];

test('Hyperliquid unified account: the cash comes from the venue figure, not the margin summary', () => {
  const fromSummary = 121912.963995 + UNIFIED.reduce((a, p) => a - p.szi * p.mark!, 0);
  const c = calibrate({ cash0: fromSummary, positions: UNIFIED }, tiersFor);
  assert.equal(c.checked, 4);
  assert.equal(c.matched, 4, JSON.stringify(c.pos));
  assert.ok(c.cash! > fromSummary + 300_000);
  // Every figure agrees again when recomputed from the book's state.
  const lv = accountLiqs(c.cash, UNIFIED, (s) => UNIFIED.find((p) => p.symbol === s)!.mark, tiersFor);
  UNIFIED.forEach((p, i) => near(lv[i]!, p.vliq!, 1e-4));
});

test('prices move every cross figure; a print moves the cash', () => {
  const c = calibrate({ cash0: null, positions: UNIFIED }, tiersFor);
  const marks = new Map(UNIFIED.map((p) => [p.symbol, p.mark!]));
  const pos = UNIFIED.map((p) => ({ symbol: p.symbol, szi: p.szi }));
  const before = accountLiqs(c.cash, pos, (s) => marks.get(s)!, tiersFor);
  // ETH up 10%: the shorts lose, so BTC's liquidation price comes nearer.
  marks.set('ETH', marks.get('ETH')! * 1.1);
  const after = accountLiqs(c.cash, pos, (s) => marks.get(s)!, tiersFor);
  assert.ok(after[0]! < before[0]!);
  // Buying back half the BTC short at the mark: what the account holds at the mark is unchanged,
  // and the rest of the short gets further from liquidation.
  const book: Book = { equity: null, at: 0, cash: c.cash, pos: new Map(pos.map((p) => [p.symbol, { szi: p.szi, entry: null }])) };
  const px = marks.get('BTC')!;
  applyFill(book, 'BTC', 7.22568 / 2, px);
  near(book.cash!, c.cash! - (7.22568 / 2) * px, 1e-12);
  const moved = accountLiqs(book.cash!, [...book.pos].map(([symbol, p]) => ({ symbol, ...p })), (s) => marks.get(s)!, tiersFor);
  assert.ok(moved[0]! > after[0]!);
});

test('tiers: SoDEX prices at the tier the position is in now, Hyperliquid at the tier it reaches', () => {
  // A small short (tier 0 now) whose liquidation price is far enough to reach tier 1 there.
  const rows = [{ lb: 0, r: 0.05 }, { lb: 125_000, r: 0.1, ded: 6250 }];
  const hl = tiersOf(rows);
  const sd = tiersOf(rows, { now: true });
  const s = -0.038;
  const fixed = 15_000_000; // the account's cash beside it
  const now = 0.038 * 160; // $6 of notional now
  const atNow = solveLiq(sd, s, fixed, now)!;
  near(atNow, fixed / (0.038 * 1.05)); // tier 0's line
  const atPrice = solveLiq(hl, s, fixed, now)!;
  near(atPrice, (fixed + 6250) / (0.038 * 1.1)); // tier 1 at the solution
  // From SoDEX's figure, its calibration reproduces it (the venue's live check: 260/260).
  const c = calibrate({ cash0: null, positions: [{ symbol: 'X', szi: s, mark: 160, vliq: atNow }] }, () => sd);
  assert.equal(c.matched, 1);
});

test('a long the venue says cannot be liquidated stays so; a missed figure is kept as read', () => {
  // cash0 says it could be, the venue says none: the cash is raised to keep it none.
  const c = calibrate({ cash0: -50_000, positions: [{ symbol: 'BTC', szi: 1, mark: 80_000, vliq: null }] }, tiersFor);
  assert.equal(c.matched, 1);
  assert.equal(accountLiqs(c.cash, [{ symbol: 'BTC', szi: 1 }], () => 80_000, tiersFor)[0], null);
  // Unknown market: no tiers, the venue's figure is kept.
  const k = calibrate({ cash0: 1000, positions: [{ symbol: 'NEW', szi: 1, mark: 10, vliq: 5 }] }, tiersFor);
  assert.equal(k.pos[0]!.fix, 5);
  assert.equal(accountLiqs(k.cash, [{ symbol: 'NEW', szi: 1, ...k.pos[0] }], () => 10, tiersFor)[0], 5);
  // A Lighter wallet split over sub-accounts: every figure kept as read, no cash.
  const sp = calibrate({ cash0: null, split: true, positions: [{ symbol: 'BTC', szi: 1, mark: 80_000, vliq: 60_000 }, { symbol: 'ETH', szi: 1, mark: 2000, vliq: null }] }, tiersFor);
  assert.equal(sp.cash, null);
  assert.equal(sp.kept, 2);
  assert.deepEqual(sp.pos.map((p) => p.fix), [60_000, 0]);
});

test('isolated: the position carries its own cash; added size brings margin over, a reduction hands value back', () => {
  const t = flatTiers(0.0125);
  const L = 70_000;
  const c = calibrate({ cash0: 10_000, positions: [{ symbol: 'BTC', szi: 1, mark: 80_000, vliq: L, isolated: true, lev: 10 }] }, () => t);
  assert.equal(c.matched, 1);
  const iso = c.pos[0]!.iso!;
  near(solveLiq(t, 1, iso), L);
  const book: FillBook = { cash: 10_000, pos: new Map([['BTC', { szi: 1, entry: 80_000, iso, lev: 10 }]]) };
  fillCash(book, 'BTC', 1, 80_000);
  near(book.cash!, 10_000 - 8_000, 1e-12);
  near(book.pos.get('BTC')!.iso!, iso - 80_000 + 8_000, 1e-12);
  // Reduce by half at the same price: the liquidation price stays where it was.
  const b2: FillBook = { cash: 0, pos: new Map([['BTC', { szi: 1, entry: 80_000, iso, lev: 10 }]]) };
  fillCash(b2, 'BTC', -0.5, 80_000);
  b2.pos.get('BTC')!.szi = 0.5;
  near(solveLiq(t, 0.5, b2.pos.get('BTC')!.iso!), L);
  near(b2.cash!, 0.5 * (iso + 80_000), 1e-12);
});

test('applyFill keeps a position\'s liquidation extras, and a figure kept as read no longer stands', () => {
  const book: Book = { equity: null, at: 0, cash: 1000, pos: new Map([['BTC', { szi: 1, entry: 100, iso: 50, lev: 5 }], ['ETH', { szi: 2, entry: 10, fix: 7 }]]) };
  applyFill(book, 'BTC', 1, 100);
  assert.equal(book.pos.get('BTC')!.lev, 5);
  assert.ok(book.pos.get('BTC')!.iso !== undefined);
  applyFill(book, 'ETH', 1, 10);
  assert.equal(book.pos.get('ETH')!.fix, undefined);
});

test('levels and buckets: longs below, shorts above, notional at the liquidation price', () => {
  const accounts: Array<[string, { cash: number | null; positions: Array<{ symbol: string; szi: number; fix?: number }> }]> = [
    ['0xa', { cash: null, positions: [{ symbol: 'BTC', szi: 2, fix: 654.15 }, { symbol: 'ETH', szi: 1, fix: 1 }] }],
    ['0xb', { cash: null, positions: [{ symbol: 'BTC', szi: -1, fix: 1200 }] }],
    ['0xc', { cash: null, positions: [{ symbol: 'ETH', szi: 1, fix: 1 }] }],
  ];
  const lv = [...coinLevels('hyperliquid', accounts, 'BTC', () => 952, tiersFor)];
  assert.deepEqual(lv.map((l) => [l.address, l.liq]), [['0xa', 654.15], ['0xb', 1200]]);
  const { buckets, outside } = bucketize(lv, 1, 400, 1100);
  assert.deepEqual(buckets, [[654, 1308.3, 0, 2, 0, 1, 0]]);
  assert.equal(outside.short, 1200);
  assert.equal(niceStep(0.952), 1);
  assert.equal(niceStep(80_000 * 0.001), 100);
  assert.equal(niceStep(3.1), 2.5);
});

test('minute rows: every coin per venue, past liquidations kept out, snapshots from the same rows', () => {
  const lb = new LevelsBuilder((c) => (c === 'BTC' ? 1000 : c === 'ETH' ? 10 : null));
  lb.add('hyperliquid', 'BTC', 1, 800, 1000);
  lb.add('lighter', 'BTC', -1, 1100, 1000);
  lb.add('hyperliquid', 'BTC', 2, null, 1000); // held, not priced
  lb.add('hyperliquid', 'BTC', 1, 1010, 1000); // a long priced above the price: past
  lb.add('hyperliquid', 'BTC', 1, 100, 1000); // outside the buckets
  lb.add('hyperliquid', 'ETH', 1, 8, 10);
  lb.add('hyperliquid', 'DOGE', 1, 0.1, 0.12); // no price for the coin: left out
  const rows = lb.rows();
  assert.deepEqual([...rows.keys()].sort(), ['BTC', 'ETH']);
  assert.deepEqual(lb.ranked(), ['BTC', 'ETH']);
  const btc = rows.get('BTC')!;
  assert.equal(btc.st, 0.2);
  const hl = btc.v.hyperliquid!;
  assert.deepEqual(hl.b, [[4000, 800, 0, 1, 0]]);
  assert.deepEqual(hl.c, [5, 0, 3, 0, 4, 1]);
  assert.deepEqual(hl.o, [100, 0, 1, 0]);
  assert.deepEqual(btc.v.lighter!.b, [[5500, 0, 1100, 0, 1]]);
  const snap = snapOfNow(btc);
  assert.equal(snap.st, 2.5);
  assert.deepEqual(snap.v.hyperliquid, [[320, 800, 0]]);
  assert.deepEqual(snap.v.lighter, [[440, 0, 1100]]);
});

test('the same market under other names counts as one coin', () => {
  assert.equal(liqCoin('kPEPE'), '1000PEPE');
  assert.equal(liqCoin('1000PEPE-USD'), '1000PEPE');
  assert.equal(liqCoin('KBONK-USD'), '1000BONK');
  assert.equal(liqCoin('xyz:XYZ100'), 'USTECH100');
  assert.equal(liqCoin('xyz:SP500'), 'US500');
  assert.equal(liqCoin('xyz:GOLD'), 'XAUT');
  assert.equal(liqCoin('KAS'), 'KAS');
});

test('drift counts', () => {
  const d = emptyDrift(0);
  addDrift(d, 100, 100.05, 1000);
  addDrift(d, 100, 103, 1000);
  addDrift(d, null, 50, 10);
  assert.deepEqual([d.n, d.within01, d.within1, d.within5, d.usd, d.usd1], [3, 1, 1, 2, 2010, 1000]);
});

test('store: books keep the cash and the extras; snapshots thin and prune', () => {
  const s = new IndexStore(':memory:');
  s.putCohortBooks([{ venue: 'hyperliquid', address: '0xa', equity: 5, at: 1, cash: 123.5, positions: [
    { symbol: 'BTC', szi: 1, entry: 2 }, { symbol: 'ETH', szi: -1, entry: 3, iso: 40, lev: 10 }, { symbol: 'SOL', szi: 2, entry: 1, fix: 0.5 }, { symbol: 'X', szi: 1, entry: 1, iso: null, lev: null },
  ] }]);
  const b = s.cohortBook('hyperliquid', '0xa')!;
  assert.equal(b.cash, 123.5);
  assert.deepEqual(b.positions, [
    { symbol: 'BTC', szi: 1, entry: 2 }, { symbol: 'ETH', szi: -1, entry: 3, iso: 40, lev: 10 }, { symbol: 'SOL', szi: 2, entry: 1, fix: 0.5 }, { symbol: 'X', szi: 1, entry: 1, iso: null, lev: null },
  ]);
  const H = 3_600_000;
  s.putLiqHist(10 * H, [['BTC', '{}']]);
  s.putLiqHist(10 * H + 900_000, [['BTC', '{}']]);
  s.putLiqHist(20 * H, [['BTC', '{"p":1}'], ['ETH', '{}']]);
  assert.equal(s.liqHistLastT(), 20 * H);
  assert.deepEqual(s.liqHistCoins().sort(), ['BTC', 'ETH']);
  s.pruneLiqHist(0, 15 * H, H);
  assert.deepEqual(s.liqHist('BTC', 0).map((r) => r.t), [10 * H, 20 * H]);
  const z = new Uint8Array([1, 2, 3]);
  s.putLiqNow(5, [['BTC', z], ['ETH', z]]);
  s.putLiqNow(6, [['BTC', z]]);
  assert.equal(s.liqNow('ETH'), null, 'a coin the last pass did not write is dropped');
  assert.equal(s.liqNow('BTC')!.at, 6);
  assert.deepEqual([...s.liqNow('BTC')!.data], [1, 2, 3]);
  s.close?.();
});

test('liquidation levels type check helper', () => {
  const l: LevelPos = { venue: 'sodex', address: '0x', symbol: 'BTC-USD', szi: 1, liq: null };
  assert.equal(bucketize([l], 1, 0, 10).buckets.length, 0);
});

test('the one-time re-read for liquidation prices goes by leverage: the books whose liquidations sit nearest the price first', () => {
  const size = (eq: number) => Math.round(Math.log10(eq) * 100);
  const whale = liqBacklogPrio(2_000_000, 10_000_000, size(10_000_000)); // 0.2x
  const degen = liqBacklogPrio(400_000, 20_000, size(20_000)); // 20x
  assert.ok(degen > whale);
  // Above a stale re-read of a large book, below a new wallet the stream saw trade.
  assert.ok(degen > 900 + size(10_000_000));
  assert.ok(liqBacklogPrio(1e9, 1, size(1)) <= 1600);
});

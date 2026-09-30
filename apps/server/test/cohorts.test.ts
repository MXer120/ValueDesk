/**
 * Run: npx tsx --test test/cohorts.test.ts   (from apps/server)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregate, biasOf, coinOf, leanOf, longShare, netWallet, pnlCohort, scopeKey, sectorOf, sizeCohort, walletRow,
  type Position, type WalletVenue,
} from '../src/valuescan/cohorts/model.js';
import { allScopes, applyFill, pollTtl, reconcileTtl, type Book } from '../src/indexer/cohortTracker.js';
import { Lane } from '../src/indexer/lanes.js';
import type { Venue } from '../src/valuescan/types.js';

const w = (o: Partial<WalletVenue>): WalletVenue => ({ pnl: null, equity: null, label: null, positions: null, at: 0, weight: 1, ...o });
const pos = (symbol: string, szi: number, entry: number | null = null): Position => ({ symbol, szi, entry });
const MARKS: Record<string, number> = { BTC: 100, ETH: 10, 'xyz:TSLA': 5, 'BTC-USD': 100 };
const mark = (_v: Venue, s: string) => MARKS[s] ?? null;

test('cohort thresholds', () => {
  assert.equal(pnlCohort(1_000_000), 'extremely-profitable');
  assert.equal(pnlCohort(999_999), 'very-profitable');
  assert.equal(pnlCohort(0), 'profitable');
  assert.equal(pnlCohort(-1), 'unprofitable');
  assert.equal(pnlCohort(-100_000), 'very-unprofitable');
  assert.equal(pnlCohort(-1_000_000), 'rekt');
  assert.equal(sizeCohort(5_000_000), 'apex');
  assert.equal(sizeCohort(10_000), 'medium');
  assert.equal(sizeCohort(1), 'small');
  assert.equal(sizeCohort(0), null, 'an empty account weighs nothing');
});

test('bias words match the published splits', () => {
  const cases: Array<[number, number, string]> = [
    [2653.79, 1275.93, 'very-bullish'], [636.07, 418.66, 'bullish'], [2707.85, 2284.46, 'slightly-bullish'],
    [531.09, 823.2, 'slightly-bearish'], [883, 1533.43, 'slightly-bearish'], [1740.48, 982.87, 'bullish'],
  ];
  for (const [l, s, b] of cases) assert.equal(biasOf(longShare(l, s)), b, `${l}/${s}`);
  assert.equal(leanOf(1), 'extremely-bullish');
  assert.equal(leanOf(0.52), 'slightly-bullish');
  assert.equal(leanOf(0.48), 'slightly-bearish');
  assert.equal(leanOf(0), 'extremely-bearish');
});

test('coins and sectors', () => {
  assert.equal(coinOf('xyz:TSLA'), 'TSLA');
  assert.equal(coinOf('BTC-USD'), 'BTC');
  assert.equal(coinOf('vBTC_vUSDC'), 'BTC');
  assert.equal(sectorOf('BTC'), 'majors');
  assert.equal(sectorOf('DOGE'), 'memes');
  assert.equal(sectorOf('GOLD', true), 'commodities');
  assert.equal(sectorOf('XYZ100', true), 'indices');
  assert.equal(sectorOf('SKHX', true), 'equities', 'a builder-dex listing is a stock unless named otherwise');
  assert.equal(sectorOf('NEWCOIN'), 'other');
});

test('fills move a book: averaging in, reducing, flipping, closing', () => {
  const b: Book = { equity: 0, at: 0, pos: new Map() };
  applyFill(b, 'BTC', 1, 100);
  applyFill(b, 'BTC', 1, 110);
  assert.deepEqual(b.pos.get('BTC'), { szi: 2, entry: 105 });
  applyFill(b, 'BTC', -0.5, 200);
  assert.deepEqual(b.pos.get('BTC'), { szi: 1.5, entry: 105 }, 'a reduction keeps the entry');
  applyFill(b, 'BTC', -2.5, 90);
  assert.deepEqual(b.pos.get('BTC'), { szi: -1, entry: 90 }, 'a flip starts at the print');
  applyFill(b, 'BTC', 1, 95);
  assert.equal(b.pos.has('BTC'), false, 'flat is gone');
});

test('netting: one wallet, figures summed, trade.xyz not counted twice under Hyperliquid', () => {
  const per = new Map<Venue, WalletVenue>([
    ['hyperliquid', w({ pnl: 900_000, equity: 2_000_000, positions: [pos('BTC', 1, 90), pos('ETH', -5, 12)] })],
    ['tradexyz', w({ pnl: 50_000, equity: 300_000, positions: [pos('xyz:TSLA', 4, 4)] })],
    ['sodex', w({ pnl: 200_000, equity: 10_000, positions: [pos('BTC-USD', -0.3, 100)] })],
  ]);
  const n = netWallet('0xa', per, mark);
  assert.equal(n.pnl, 1_100_000, 'HL + SoDEX; xyz is inside HL');
  assert.equal(n.equity, 2_010_000);
  const btc = n.holdings.find((h) => h.coin === 'BTC')!;
  assert.equal(btc.notional, 70, 'BTC nets across venues');
  assert.equal(btc.upnl, 10, '+10 on HL, 0 on SoDEX');
  assert.equal(n.holdings.find((h) => h.coin === 'TSLA')!.sector, 'equities');
  const row = walletRow(n, {});
  assert.equal(row.value, 70 + 50 + 20);
  assert.equal(row.lean, leanOf(longShare(90, 50)));
});

test('aggregate: coverage, profit / loss, markets, filters and sampled weights', () => {
  // 0x1: BTC +30, ETH short -10 -> +20. 0x3 (a sampled wallet standing for ten): BTC short from 110 -> +10.
  const a = netWallet('0x1', new Map([['hyperliquid', w({ pnl: 2_000_000, equity: 6_000_000, positions: [pos('BTC', 3, 90), pos('ETH', -10, 9)] })]]), mark);
  const b = netWallet('0x2', new Map([['hyperliquid', w({ pnl: 1_500_000, equity: 50_000 })]]), mark);
  const c = netWallet('0x3', new Map([['lighter', w({ pnl: 1_200_000, equity: 5_000, weight: 10, positions: [pos('BTC', -1, 110)] })]]), mark);
  const ep = aggregate([a, b, c]).find((s) => s.id === 'extremely-profitable')!;
  assert.equal(ep.wallets, 3);
  // The sampled wallet stands for ten, but a cohort never reports more covered wallets than it has
  // (the nine it stands for are counted in `wallets` only when they are members here too).
  assert.equal(ep.covered, 3, 'capped at the exact wallet count');
  assert.equal(ep.long, 300);
  assert.equal(ep.short, 100 + 1000, 'amounts keep the sample weight');
  assert.equal(ep.inProfit, 3);
  assert.equal(ep.inLoss, 0);
  assert.equal(ep.upnl, 20 + 100);
  assert.deepEqual(ep.markets.map((m) => m.coin), ['BTC', 'ETH']);
  const onlyEth = aggregate([a, b, c], { coin: 'ETH' }).find((s) => s.id === 'extremely-profitable')!;
  assert.equal(onlyEth.long, 0);
  assert.equal(onlyEth.short, 100);
  assert.equal(onlyEth.holding, 1);
  assert.equal(onlyEth.inLoss, 1, 'on ETH alone wallet 1 is down');
  const majors = aggregate([a], { sector: 'majors' }).find((s) => s.id === 'apex')!;
  assert.equal(majors.long + majors.short, 400);
});

test('scopes and read ages', () => {
  assert.equal(allScopes().length, 31);
  assert.equal(scopeKey(['sodex', 'hyperliquid', 'sodex']), 'hyperliquid+sodex');
  assert.ok(reconcileTtl(2e6) < reconcileTtl(2e5) && reconcileTtl(2e5) < reconcileTtl(10));
  assert.ok(pollTtl(6e6) < pollTtl(2e6) && pollTtl(2e4) < pollTtl(10));
});

test('lane shares: a steady flood of urgent work cannot starve a reserved prefix', async () => {
  const ran: string[] = [];
  const lane = new Lane({ name: 't', perMin: 1e9, shares: [{ prefix: 'walk:', share: 0.4 }], sleep: () => new Promise((r) => setImmediate(r)) });
  for (let i = 0; i < 20; i++) lane.add({ key: `q:${i}`, prio: 9_000, run: async () => { ran.push('q'); return 0; } });
  for (let i = 0; i < 20; i++) lane.add({ key: `walk:${i}`, prio: 1, run: async () => { ran.push('walk'); return 0; } });
  lane.start();
  for (let i = 0; i < 50 && ran.length < 20; i++) await new Promise((r) => setTimeout(r, 5));
  lane.stop();
  const walks = ran.slice(0, 20).filter((r) => r === 'walk').length;
  assert.ok(walks >= 7 && walks <= 10, `walk got ${walks} of 20`);
});

/**
 * Run: npx tsx --test test/cohorts.test.ts   (from apps/server)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregate, biasOf, coinOf, holdsPosition, leanOf, longShare, netWallet, perpEquity, pnlCohort, sampledVenue, scopeKey, sectorOf, sizeCohort,
  sumCohorts, walletRow,
  type Position, type WalletVenue,
} from '../src/valuedesk/cohorts/model.js';
import { PLAN_FULL_MS, PLAN_LOW, allScopes, applyFill, fullPassDue, needsSpot, pollTtl, reconcileTtl, staleEquity, type Book } from '../src/indexer/cohortTracker.js';
import { spotCollateral } from '../src/indexer/cohortSource.js';
import { Lane } from '../src/indexer/lanes.js';
import type { Venue } from '../src/valuedesk/types.js';

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
  // 0x2 holds nothing: not part of the cohort. The sampled wallet stands for ten, but a cohort
  // never reports more wallets than it has (the nine count only when they are in it too).
  assert.equal(ep.wallets, 3, '1 + 10 holding, capped at the 3 wallets the cohort has');
  assert.equal(ep.long, 300);
  assert.equal(ep.short, 100 + 1000, 'amounts keep the sample weight');
  assert.equal(ep.inProfit, 3);
  assert.equal(ep.inLoss, 0);
  assert.equal(ep.upnl, 20 + 100);
  assert.deepEqual(ep.markets.map((m) => m.coin), ['BTC', 'ETH']);
  const onlyEth = aggregate([a, b, c], { coin: 'ETH' }).find((s) => s.id === 'extremely-profitable')!;
  assert.equal(onlyEth.long, 0);
  assert.equal(onlyEth.short, 100);
  assert.equal(onlyEth.wallets, 1, 'only the wallet holding ETH');
  assert.equal(onlyEth.inLoss, 1, 'on ETH alone wallet 1 is down');
  const majors = aggregate([a], { sector: 'majors' }).find((s) => s.id === 'apex')!;
  assert.equal(majors.long + majors.short, 400);
});

test('a cohort is its wallets holding positions, as Hyperdash counts it; the total holds every one', () => {
  const held = (id: string, o: Partial<WalletVenue>) => netWallet(id, new Map([['hyperliquid', w({ positions: [pos('BTC', 1, 100)], ...o })]]), mark);
  const flat = netWallet('0xf', new Map([['hyperliquid', w({ pnl: 5e6, equity: 9e6, positions: [] })]]), mark);
  const unread = netWallet('0xu', new Map([['hyperliquid', w({ pnl: 5e6, equity: 9e6 })]]), mark);
  // Positions, but no perp equity known yet (read empty, funded since): no size cohort, still in the total.
  const unsized = held('0xn', { pnl: 2e6, equity: 0 });
  const apex = held('0xa', { pnl: 2e6, equity: 6e6 });
  const s = sumCohorts([flat, unread, unsized, apex]);
  const by = (id: string) => s.cohorts.find((c) => c.id === id)!;
  assert.equal(by('apex').wallets, 1, 'the flat and the unread $9M wallets are not in it');
  assert.equal(by('extremely-profitable').wallets, 2);
  assert.equal(by('small').wallets, 0);
  assert.equal(s.all.wallets, 2);
  assert.equal(s.all.long, 200, 'the market map keeps the unsized wallet');
  assert.equal(walletRow(flat, {}).value, 0);
  assert.ok(holdsPosition(apex, {}) && !holdsPosition(flat, {}) && !holdsPosition(unread, {}));
  assert.equal(holdsPosition(apex, { coin: 'ETH' }), false, 'under a filter: a position it keeps');
});

test('perp equity per venue: unified collateral once, dexes summed, the others their own', () => {
  const hl = { equity: 159e6, collateral: null };
  const xyz = { equity: 9.7e6 };
  assert.equal(perpEquity('hyperliquid', hl, xyz), 168.7e6, 'standard: main dex + xyz dex');
  assert.equal(perpEquity('tradexyz', xyz, hl), 9.7e6, 'trade.xyz alone: its own margin book');
  const unified = { equity: 3e6, collateral: 20.1e6 };
  assert.equal(perpEquity('hyperliquid', unified, xyz), 20.1e6, 'unified: the collateral, which the dexes share');
  assert.equal(perpEquity('tradexyz', xyz, unified), 20.1e6);
  assert.equal(perpEquity('hyperliquid', undefined, xyz), 9.7e6, 'no main-dex read yet: the xyz book');
  assert.equal(perpEquity('hyperliquid', undefined, undefined), null);
  assert.equal(perpEquity('lighter', { equity: 50_000 }), 50_000);
  // Netted with both chosen, trade.xyz's figure is inside Hyperliquid's: not added again.
  const n = netWallet('0xu', new Map<Venue, WalletVenue>([
    ['hyperliquid', w({ equity: perpEquity('hyperliquid', unified, xyz), positions: [pos('BTC', 1, 100)] })],
    ['tradexyz', w({ equity: perpEquity('tradexyz', xyz, unified), positions: [pos('xyz:TSLA', 1, 5)] })],
  ]), mark);
  assert.equal(n.equity, 20.1e6);
  // The sampling stratum stays the member's equity; the wallet carries its perp equity.
  const sv = sampledVenue(1, '0xu', { pnl: 1, equity: 250e6, label: null }, { equity: 3e6, positions: [], at: 1 }, 20.1e6);
  assert.equal(sv.equity, 20.1e6);
});

test('the spot state: unified collateral in stablecoins; a standard account has none', () => {
  assert.equal(spotCollateral({ balances: [{ coin: 'USDC', token: 0, total: '65407.1' }] }), null, 'standard: spot is spot');
  assert.equal(spotCollateral({
    balances: [
      { coin: 'USDC', token: 0, total: '191147342.25' }, { coin: 'HYPE', token: 150, total: '529458' },
      { coin: 'USDT0', token: 268, total: '8' }, { coin: 'USDH', token: 360, total: '0.01' },
    ],
    tokenToAvailableAfterMaintenance: [[0, '162591964.9'], [268, '8'], [360, '0.01']],
  }), 191147342.25 + 8 + 0.01, 'no prices: the stablecoins alone, as before');
  // With prices every token counts at its spot price (Hyperdash's "perp equity"), HYPE here.
  const px = new Map([['HYPE', 40], ['PURR', 0.2]]);
  assert.equal(spotCollateral({
    balances: [
      { coin: 'USDC', token: 0, total: '1000' }, { coin: 'HYPE', token: 150, total: '50' },
      { coin: 'PURR', token: 1, total: '100' }, { coin: 'NOPRICE', token: 9, total: '5' },
    ],
    tokenToAvailableAfterMaintenance: [[0, '900']],
  }, px), 1000 + 50 * 40 + 100 * 0.2);
  assert.equal(spotCollateral({ balances: [{ coin: 'HYPE', token: 150, total: '50' }] }, px), null, 'standard: spot is still spot');
  assert.equal(needsSpot(252.9e6, 159e6, 17), true, 'the leaderboard sees far more than the perps value');
  assert.equal(needsSpot(1_050_000, 1_000_000, 3), false, 'within 10%');
  assert.equal(needsSpot(5e6, 0, 0), false, 'no positions: nothing to size');
  assert.equal(needsSpot(null, 0, 3), true, 'off the leaderboard: its equity is uncertain (unifiedSpot.test.ts)');
});

test('a book read empty or small, holding more since, is read again - not in a loop', () => {
  const now = 10 * 3_600_000;
  assert.equal(staleEquity({ equity: 0, at: now - 40 * 60_000 }, 377_104, now), true, 'read empty, funded and opened since');
  assert.equal(staleEquity({ equity: 0, at: now - 10 * 60_000 }, 377_104, now), false, 'just read: wait');
  assert.equal(staleEquity({ equity: 2_272, at: now - 7 * 3_600_000 }, 1_752_586, now), true, '771x');
  assert.equal(staleEquity({ equity: 2_272, at: now - 3_600_000 }, 1_752_586, now), false, 'within 6 h of its read');
  assert.equal(staleEquity({ equity: 75_000, at: 0 }, 377_104, now), false, '5x is a book');
  assert.equal(staleEquity({ equity: 3e6, collateral: 20e6, at: 0 }, 41.9e6, now), false, 'unified: against its collateral');
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

test('the plan: each venue gets its full pass every 5 minutes, sooner after an outage or when its queue runs low with more due', () => {
  const t = 1_800_000_000_000;
  const at = (o: Partial<Parameters<typeof fullPassDue>[0]>) => fullPassDue({ lastAt: t, now: t + 60_000, queued: 400, dueLeft: 50, outage: false, ...o });
  assert.equal(at({ lastAt: undefined }), true, 'the first plan after a start');
  assert.equal(at({}), false, 'a minute later, with a full queue: no pass');
  assert.equal(at({ now: t + PLAN_FULL_MS - 1 }), false);
  assert.equal(at({ now: t + PLAN_FULL_MS }), true, 'five minutes on');
  assert.equal(at({ outage: true }), true, 'a stream outage: its large books are unknown again');
  assert.equal(at({ queued: PLAN_LOW - 1 }), true, 'the queue ran low while more was due');
  assert.equal(at({ queued: PLAN_LOW - 1, dueLeft: 0 }), false, 'low, but everything due was queued: it waits for the five minutes');
});

/**
 * SoDEX provider mappers (src/valuedesk/sodex/mappers.ts, util.ts, resolver.ts).
 *
 * DELIBERATELY OFFLINE, like the rest of this suite: the SoDEX budget is shared
 * with the running app. Fixtures are verbatim (trimmed) mainnet responses
 * recorded on 2026-09-25.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHART_WINDOW,
  LB_WINDOW,
  RankHistory,
  WhaleAggregator,
  aggregatePositioning,
  chartToEquity,
  closedStats,
  downsample,
  feeUsd,
  lbItemToRow,
  markMap,
  matchesQuery,
  maxDrawdown,
  num,
  pagesFor,
  returnIndex,
  sharpe,
  spotPrices,
  spotValue,
  statePositions,
  styleTags,
  summariseChart,
  symbolMatches,
  takerOf,
  tradeToFill,
  type ClosedPosition,
  type LbItem,
  type PortfolioChart,
  type StatePosition,
  type WsPrint,
} from '../src/valuedesk/sodex/mappers.js';
import { Limiter, TtlCache, isRateLimit, within } from '../src/valuedesk/sodex/util.js';
import { parseBulk } from '../src/valuedesk/sodex/resolver.js';

// --- fixtures ----------------------------------------------------------------

/** /api/v1/leaderboard?window_type=30D&sort_by=pnl, items[2]. */
const LB_ITEM: LbItem = {
  window_type: '30D',
  wallet_address: '0x7f5e7d70b4a9960d45d7f9cffb1a2705ee839245',
  account_id: 220959,
  pnl_usd: '23340.676038463',
  volume_usd: '468078.31748',
  rank: 3,
};

/** /api/v1/wallet/portfolio/chart?account_id=220959&window=7D (first 3 points). */
const CHART_7D: PortfolioChart = {
  account_id: 220959,
  window: '7D',
  market_type: 'all',
  total_pnl_usd: '7269.556063332',
  roi: '0.081814409',
  chart: [
    { ts_ms: 1789945200000, account_value_usd: '90454.392277442', pnl_usd: '1600.165414186', roi: '0.018008883' },
    { ts_ms: 1789858800000, account_value_usd: '90068.529612845', pnl_usd: '1214.302749589', roi: '0.013666235' },
    { ts_ms: 1790031600000, account_value_usd: '108449.120009971', pnl_usd: '19594.893146715', roi: '0.220528543' },
  ],
};

/** perps state P[0] of account 52599. */
const POS_LONG: StatePosition = {
  i: 17557126,
  s: 'BTC-USD',
  m: 'CROSS',
  ps: 'BOTH',
  sz: '0.01178',
  ep: '84574.06334841628959276',
  cr: '-0.142710918256108597',
  ur: '-0.4784252443438914027128',
  l: 10,
  lp: '0',
  ct: 1790337519789,
  ut: 1790337564734,
};

/** WS `trade` push data[0] (perps). */
const PRINT: WsPrint = {
  E: 1790337743941,
  T: 1790337743902,
  t: 13661142,
  s: 'BTC-USD',
  S: 'SELL',
  p: '84617',
  q: '0.01914',
  bi: 23342,
  si: 1002,
};

// --- primitives --------------------------------------------------------------

test('num: decimal strings and numbers, never a default 0', () => {
  assert.equal(num('23340.676038463'), 23340.676038463);
  assert.equal(num(5), 5);
  assert.equal(num(''), null);
  assert.equal(num(null), null);
  assert.equal(num(undefined), null);
  assert.equal(num('abc'), null);
  assert.equal(num({}), null);
});

test('window maps match the two hosts\' enums', () => {
  assert.deepEqual(LB_WINDOW, { '1d': '24H', '7d': '7D', '30d': '30D', all: 'ALL_TIME' });
  assert.equal(CHART_WINDOW.all, '1Y'); // the chart has no all-time window
});

test('downsample keeps first and last and the requested count', () => {
  const xs = Array.from({ length: 100 }, (_, i) => i);
  const d = downsample(xs, 10);
  assert.equal(d.length, 10);
  assert.equal(d[0], 0);
  assert.equal(d[9], 99);
  assert.deepEqual(downsample([1, 2, 3], 10), [1, 2, 3]);
});

// --- leaderboard -------------------------------------------------------------

test('lbItemToRow maps a leaderboard item for its window', () => {
  const r = lbItemToRow(LB_ITEM, '30d')!;
  assert.equal(r.venue, 'sodex');
  assert.equal(r.address, '0x7f5e7d70b4a9960d45d7f9cffb1a2705ee839245');
  assert.equal(r.accountId, 220959);
  assert.equal(r.pnl['30d'], 23340.676038463);
  assert.equal(r.volume['30d'], 468078.31748);
  assert.equal(r.roi['30d'], null); // not on the leaderboard
  assert.equal(r.accountValue, null);
  assert.equal(r.rank, 3);
});

test('lbItemToRow lower-cases and rejects malformed addresses', () => {
  const r = lbItemToRow({ ...LB_ITEM, wallet_address: '0x7F5E7D70b4a9960d45d7F9cfFb1A2705EE839245' }, '7d')!;
  assert.equal(r.address, '0x7f5e7d70b4a9960d45d7f9cffb1a2705ee839245');
  assert.equal(lbItemToRow({ ...LB_ITEM, wallet_address: 'nope' }, '7d'), null);
});

test('pagesFor covers exactly the requested slice', () => {
  assert.deepEqual(pagesFor(0, 50, 50), [1]);
  assert.deepEqual(pagesFor(0, 51, 50), [1, 2]);
  assert.deepEqual(pagesFor(49, 2, 50), [1, 2]);
  assert.deepEqual(pagesFor(100, 50, 50), [3]);
  assert.deepEqual(pagesFor(0, 500, 50).length, 10);
  assert.deepEqual(pagesFor(0, 0, 50), []);
});

test('matchesQuery: address prefix with or without 0x and account id; never a name', () => {
  const r = lbItemToRow(LB_ITEM, '30d')!;
  assert.ok(matchesQuery(r, '0x7f5e'));
  assert.ok(matchesQuery(r, '7F5E7D'));
  assert.ok(matchesQuery(r, '220959'));
  assert.ok(!matchesQuery(r, '22095'));
  assert.ok(!matchesQuery(r, '0xabc'));
  assert.ok(!matchesQuery({ ...r, label: 'Big Fish' }, 'fish'), 'no username is searched (valuedesk/labels.ts)');
  // Digits may also be the start of an address.
  const digits = { ...r, address: '0x1234567890abcdef1234567890abcdef12345678' };
  assert.ok(matchesQuery(digits, '1234'));
  assert.ok(!matchesQuery(digits, 'zz12'));
});

test('RankHistory reports movement only across two snapshots', () => {
  const h = new RankHistory();
  assert.equal(h.observe('30D|pnl', 1000, '0xa', 5), null);
  assert.equal(h.observe('30D|pnl', 1000, '0xa', 5), null); // same snapshot
  assert.equal(h.observe('30D|pnl', 2000, '0xa', 3), 2); // moved up two places
  assert.equal(h.observe('30D|pnl', 2000, '0xb', 7), null); // new on the board
  assert.equal(h.observe('30D|pnl', 1000, '0xa', 5), null); // stale page is ignored
  assert.equal(h.observe('7D|pnl', 2000, '0xa', 1), null); // boards are separate
});

// --- portfolio chart ---------------------------------------------------------

test('chartToEquity sorts by time and keeps the venue\'s numbers', () => {
  const e = chartToEquity(CHART_7D);
  assert.deepEqual(
    e.map((p) => p.t),
    [1789858800000, 1789945200000, 1790031600000],
  );
  assert.equal(e[0]!.accountValue, 90068.529612845);
  assert.equal(e[0]!.pnl, 1214.302749589);
  assert.deepEqual(chartToEquity(null), []);
  assert.deepEqual(chartToEquity({ ...CHART_7D, chart: null }), []);
});

test('summariseChart: window pnl/roi, latest account value, spark', () => {
  const s = summariseChart(CHART_7D);
  assert.equal(s.pnl, 7269.556063332);
  assert.equal(s.roi, 0.081814409);
  assert.equal(s.accountValue, 108449.120009971);
  assert.equal(s.asOf, 1790031600000);
  assert.deepEqual(s.spark, [1214.302749589, 1600.165414186, 19594.893146715]);
  assert.equal(s.vaultShare, null); // the fixture points carry no vault split
  const vaulty = summariseChart({
    ...CHART_7D,
    chart: [
      { ts_ms: 1, account_value_usd: '972925.8', pnl_usd: '20642.6', vault_pnl_usd: '20641.9', roi: '0.02' },
    ],
  });
  assert.ok(Math.abs(vaulty.vaultShare! - 20641.9 / 20642.6) < 1e-12);
  const empty = summariseChart(null);
  assert.equal(empty.pnl, null);
  assert.equal(empty.accountValue, null);
  assert.deepEqual(empty.spark, []);
});

test('returnIndex trims the pre-account stretch', () => {
  const c: PortfolioChart = {
    ...CHART_7D,
    chart: [
      { ts_ms: 1, account_value_usd: '0', pnl_usd: '0', roi: '0' },
      { ts_ms: 2, account_value_usd: '0', pnl_usd: '0', roi: '0' },
      { ts_ms: 3, account_value_usd: '100', pnl_usd: '0', roi: '0' },
      { ts_ms: 4, account_value_usd: '110', pnl_usd: '10', roi: '0.1' },
    ],
  };
  assert.deepEqual(returnIndex(c), [1, 1.1]);
});

test('maxDrawdown on the return index, from the window start', () => {
  assert.equal(maxDrawdown([1.1]), null);
  assert.equal(maxDrawdown([1.1, 1.2, 1.3]), 0);
  // peak 1.2 -> trough 0.9: 25 %
  assert.ok(Math.abs(maxDrawdown([1.2, 1.0, 0.9, 1.1])! - 0.25) < 1e-12);
  // straight down from the start (index 1) to 0.8: 20 %
  assert.ok(Math.abs(maxDrawdown([0.9, 0.8])! - 0.2) < 1e-12);
  assert.equal(maxDrawdown([1, 0]), 1);
});

test('sharpe needs enough non-flat returns', () => {
  assert.equal(sharpe([1, 1.01, 1.02]), null); // too short
  assert.equal(sharpe(Array(30).fill(1)), null); // flat
  const up = Array.from({ length: 31 }, (_, i) => 1 + i * 0.01 + (i % 2 ? 0.002 : 0));
  const s = sharpe(up)!;
  assert.ok(s > 0);
  const down = up.map((v) => 2 - v);
  assert.ok(sharpe(down)! < 0);
});

// --- positions and balances --------------------------------------------------

test('statePositions: side from the sign of sz, venue mark, liq "0" = none', () => {
  const marks = markMap([{ symbol: 'BTC-USD', markPrice: '84600' }]);
  const [p] = statePositions([POS_LONG], marks);
  assert.equal(p!.symbol, 'BTC-USD');
  assert.equal(p!.side, 'long');
  assert.equal(p!.size, 0.01178);
  assert.equal(p!.markPx, 84600);
  assert.ok(Math.abs(p!.notional - 0.01178 * 84600) < 1e-9);
  assert.equal(p!.liqPx, null);
  assert.equal(p!.uPnl, -0.4784252443438914);
  assert.equal(p!.leverage, 10);
  assert.equal(p!.marginMode, 'cross');
});

test('statePositions: short, implied mark without a venue mark, flat rows dropped', () => {
  const short: StatePosition = { s: 'ETH-USD', m: 'ISOLATED', sz: '-2', ep: '2700', ur: '20', l: 5, lp: '3000' };
  const flat: StatePosition = { s: 'SOL-USD', sz: '0', ep: '100' };
  const out = statePositions([short, flat], new Map());
  assert.equal(out.length, 1);
  assert.equal(out[0]!.side, 'short');
  assert.equal(out[0]!.size, 2);
  assert.equal(out[0]!.markPx, 2690); // 2700 + 20 / -2
  assert.equal(out[0]!.liqPx, 3000);
  assert.equal(out[0]!.marginMode, 'isolated');
  assert.deepEqual(statePositions(null, new Map()), []);
});

test('spotPrices + spotValue: ticker, then perps mark, else unpriced', () => {
  const marks = markMap([{ symbol: 'SOSO-USD', markPrice: '0.3' }, { symbol: 'ETH-USD', markPrice: '2700' }]);
  const prices = spotPrices([{ symbol: 'vETH_vUSDC', lastPx: '2719.9' }, { symbol: 'vQQQ_vUSDC', lastPx: '744.36' }], marks);
  assert.equal(prices.get('vUSDC'), 1);
  assert.equal(prices.get('vETH'), 2719.9); // the spot ticker wins over the perps mark
  assert.equal(prices.get('WSOSO'), 0.3);
  const v = spotValue(
    [
      { a: 'vUSDC', t: '100' },
      { a: 'vETH', t: '0.5' },
      { a: 'vMYSTERY', t: '10' },
      { a: 'vQQQ', t: '0' },
    ],
    prices,
  );
  assert.ok(Math.abs(v.value - (100 + 0.5 * 2719.9)) < 1e-9);
  assert.deepEqual(v.unpriced, ['vMYSTERY']);
});

test('closedStats: win rate ignores break-even, median hold and leverage', () => {
  const rows: ClosedPosition[] = [
    { realizedPnL: '-0.0253303344', createdAt: 1790337721941, updatedAt: 1790337735775, leverage: 10 },
    { realizedPnL: '0.0002538458', createdAt: 1790337704159, updatedAt: 1790337721941, leverage: 10 },
    { realizedPnL: '0.331690306399999999', createdAt: 1790337519789, updatedAt: 1790337704159, leverage: 20 },
    { realizedPnL: '0', createdAt: 1, updatedAt: 2, leverage: 10 },
  ];
  const s = closedStats(rows);
  assert.equal(s.count, 4);
  assert.equal(s.winRate, 2 / 3);
  assert.equal(s.medianLeverage, 10);
  assert.equal(s.lastClosedAt, 1790337735775);
  assert.equal(closedStats(null).winRate, null);
});

test('styleTags', () => {
  const closed = { ...closedStats([]), count: 50, medianHoldMs: 5 * 60_000, medianLeverage: 25 };
  const tags = styleTags({ accountValue: 600_000, positions: [], closed });
  assert.deepEqual(tags, ['whale', 'high-leverage', 'scalper']);
  const quiet = styleTags({ accountValue: 1_000, positions: [], closed: closedStats([]) });
  assert.deepEqual(quiet, []);
});

// --- fills -------------------------------------------------------------------

test('tradeToFill: perps fill, fee already in vUSDC', () => {
  const f = tradeToFill(
    'perps',
    { symbol: 'BTC-USD', tradeID: 13661142, orderID: 1, side: 'BUY', price: '84617', quantity: '0.01', fee: '0.338468', feeCoin: 'vUSDC', time: 1790337743902, isMaker: false },
    'abcdef0123456789',
  )!;
  assert.equal(f.id, 'p:13661142:abcdef0123');
  assert.equal(f.side, 'buy');
  assert.equal(f.px, 84617);
  assert.equal(f.sz, 0.01);
  assert.ok(Math.abs(f.notional - 846.17) < 1e-9);
  assert.equal(f.fee, 0.338468);
  assert.equal(f.closedPnl, null);
});

test('feeUsd: spot BUY fees are in the base coin and get converted', () => {
  assert.equal(feeUsd(0.001, 'vETH', 'vETH_vUSDC', 2700), 2.7);
  assert.equal(feeUsd(1.5, 'vUSDC', 'vETH_vUSDC', 2700), 1.5);
  assert.equal(feeUsd(1, 'WSOSO', 'vETH_vUSDC', 2700), null); // unrelated coin: not dollars
  assert.equal(feeUsd(1, undefined, 'BTC-USD', 1), null);
  assert.equal(feeUsd(null, 'vUSDC', 'BTC-USD', 1), null);
});

test('tradeToFill rejects rows it cannot read', () => {
  assert.equal(tradeToFill('spot', { symbol: 'vETH_vUSDC', side: 'HOLD', price: '1', quantity: '1', time: 1 }, 'x'), null);
  assert.equal(tradeToFill('spot', { symbol: 'vETH_vUSDC', side: 'SELL', price: 'x', quantity: '1', time: 1 }, 'x'), null);
});

// --- whales ------------------------------------------------------------------

test('takerOf: S is the aggressor', () => {
  assert.deepEqual(takerOf(PRINT), { side: 'sell', accountId: 1002 });
  assert.deepEqual(takerOf({ ...PRINT, S: 'BUY' }), { side: 'buy', accountId: 23342 });
  assert.equal(takerOf({ ...PRINT, S: '?' }), null);
});

test('WhaleAggregator folds one taker order into one trade and applies the floor', () => {
  const agg = new WhaleAggregator(1_000);
  const t0 = 1_000_000;
  // One sweep: three prints, same taker (si=7), same block time.
  agg.add({ ...PRINT, si: 7, p: '100000', q: '0.05' }, t0);
  agg.add({ ...PRINT, si: 7, p: '100010', q: '0.05' }, t0);
  agg.add({ ...PRINT, si: 7, p: '100020', q: '0.05' }, t0 + 10);
  // A small unrelated print.
  agg.add({ ...PRINT, si: 8, p: '100000', q: '0.001', T: PRINT.T + 1 }, t0);
  assert.deepEqual(agg.flush(t0 + 500, 10_000), []); // still inside the hold window
  const out = agg.flush(t0 + 1_500, 10_000);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.accountId, 7);
  assert.equal(out[0]!.side, 'sell');
  assert.ok(Math.abs(out[0]!.sz - 0.15) < 1e-12);
  assert.ok(Math.abs(out[0]!.notional - 15_001.5) < 1e-6);
  assert.equal(agg.size, 0); // the small one was discarded, not kept
});

// --- positioning -------------------------------------------------------------

test('aggregatePositioning sums per symbol and counts traders per side', () => {
  const pos = (symbol: string, side: 'long' | 'short', notional: number) => ({
    symbol, side, size: 1, notional, entryPx: null, markPx: null, liqPx: null, uPnl: null, leverage: null,
  });
  const rows = aggregatePositioning([
    { positions: [pos('BTC-USD', 'long', 100), pos('ETH-USD', 'short', 50)] },
    { positions: [pos('BTC-USD', 'short', 30)] },
    { positions: [pos('BTC-USD', 'long', 20)] },
  ]);
  assert.deepEqual(rows[0], { venue: 'sodex', symbol: 'BTC-USD', longUsd: 120, shortUsd: 30, longTraders: 2, shortTraders: 1 });
  assert.deepEqual(rows[1], { venue: 'sodex', symbol: 'ETH-USD', longUsd: 0, shortUsd: 50, longTraders: 0, shortTraders: 1 });
});

test('symbolMatches accepts bare, full and lower-case names', () => {
  assert.ok(symbolMatches('BTC-USD', 'btc'));
  assert.ok(symbolMatches('BTC-USD', 'BTC-USD'));
  assert.ok(!symbolMatches('BTC-USD', 'ETH'));
  assert.ok(symbolMatches('BTC-USD', ''));
});

// --- resolver / util ---------------------------------------------------------

test('parseBulk: string ids, checksummed addresses, unknown ids absent', () => {
  const m = parseBulk([
    { userId: '52599', address: '0xe290506a7472136dF8f49Fe1e35d2079a61Dcb67' },
    { userId: '220959', address: '0x7F5E7D70b4a9960d45d7F9cfFb1A2705EE839245' },
    { userId: 'x', address: '0x7F5E7D70b4a9960d45d7F9cfFb1A2705EE839245' },
    { userId: '1', address: 'nope' },
  ]);
  assert.equal(m.size, 2);
  assert.equal(m.get(52599), '0xe290506a7472136df8f49fe1e35d2079a61dcb67');
  assert.equal(parseBulk(null).size, 0);
});

test('isRateLimit recognises 429s and Cloudflare 1015', () => {
  assert.ok(isRateLimit({ httpStatus: 429 }));
  assert.ok(isRateLimit(new Error('non-JSON response (HTTP 429): error code: 1015')));
  assert.ok(!isRateLimit(new Error('HTTP 500')));
});

test('TtlCache coalesces concurrent misses and does not cache failures', async () => {
  const c = new TtlCache();
  let calls = 0;
  const fn = async () => {
    calls++;
    return calls;
  };
  const [a, b] = await Promise.all([c.wrap('k', 1_000, fn), c.wrap('k', 1_000, fn)]);
  assert.equal(a, 1);
  assert.equal(b, 1);
  assert.equal(calls, 1);
  await assert.rejects(c.wrap('bad', 1_000, async () => { throw new Error('x'); }));
  assert.equal(await c.wrap('bad', 1_000, async () => 7), 7);
});

test('Limiter runs high priority first and respects concurrency', async () => {
  const lim = new Limiter(1, 0);
  const order: string[] = [];
  const job = (name: string) => async () => {
    order.push(name);
  };
  const p = [lim.run(job('first')), lim.run(job('low'), 'low'), lim.run(job('high'))];
  await Promise.all(p);
  assert.deepEqual(order, ['first', 'high', 'low']);
});

test('within returns the fallback on timeout without rejecting', async () => {
  const slow = new Promise<number>((r) => setTimeout(() => r(1), 200));
  assert.equal(await within(slow, 10, 0), 0);
  assert.equal(await within(Promise.resolve(5), 100, 0), 5);
});

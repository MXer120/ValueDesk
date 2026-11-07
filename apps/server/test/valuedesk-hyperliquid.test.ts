/**
 * Hyperliquid provider tests: leaderboard parsing and ranking, the pure
 * mappers, the weight budget and the info client's retry/dedup behaviour.
 *
 * DELIBERATELY OFFLINE. Nothing here opens a socket: every HTTP call goes to an
 * injected fake fetch or a stub InfoLike. Fixtures are trimmed copies of live
 * responses recorded on 2026-09-25 (field names and value formats verbatim).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HlApiError,
  HlInfoClient,
  WeightBudget,
  baseWeight,
  hlBackoffMs,
  hlRetryKind,
  itemWeight,
  mapLimit,
  type InfoBody,
  type InfoLike,
} from '../src/valuedesk/hyperliquid/info.js';
import {
  HlLeaderboardStore,
  LbSnapshot,
  ROI_MIN_ACCOUNT_USD,
  matchesQuery,
  parseLeaderboard,
  parseLeaderboardStream,
  queryLeaderboard,
} from '../src/valuedesk/hyperliquid/leaderboard.js';
import {
  aggregatePositioning,
  aggregateTakerPrints,
  coinsFromMeta,
  equitySeries,
  fillStats,
  mapFill,
  mapPortfolio,
  mapPosition,
  mapPositions,
  maxDrawdownOf,
  periodReturns,
  portfolioHasActivity,
  portfolioMaxDrawdown,
  summaryFromPortfolio,
  symbolKey,
  symbolMatches,
  takerOf,
  topCoins,
  twr,
} from '../src/valuedesk/hyperliquid/mappers.js';
import { HlPositioning } from '../src/valuedesk/hyperliquid/positioning.js';
import { HL_FILLS_PAGE, hlFills, hlPeek, hlTrader } from '../src/valuedesk/hyperliquid/trader.js';
import { HlTradeFeed, SeenIds, TradeRing, WHALE_KEEP_USD } from '../src/valuedesk/hyperliquid/whales.js';
import type {
  HlClearinghouseState,
  HlFillRaw,
  HlLeaderboardRaw,
  HlLeaderboardRowRaw,
  HlMetaAndAssetCtxs,
  HlPortfolio,
  HlWsTrade,
} from '../src/valuedesk/hyperliquid/raw.js';
import type { EquityPoint, LeaderboardQuery } from '../src/valuedesk/types.js';

// --- fixtures --------------------------------------------------------------------

const A1 = '0x85ecf584f25db6f146718b86d493e33c5af72052';
const A2 = '0x8c625ff57d8a4374784c7eff585dfdc42ccec974';
const A3 = '0xf5d81a135f756ca16544e53c20fc20643ec3ad53';
const A4 = '0xa9b95f2a00000000000000000000000000000004';

function lbRow(addr: string, av: string, pnl30: string, opts: Partial<{ name: string | null; roiAll: string; vol7: string }> = {}): HlLeaderboardRowRaw {
  return {
    ethAddress: addr,
    accountValue: av,
    windowPerformances: [
      ['day', { pnl: '1.0', roi: '0.01', vlm: '100.0' }],
      ['week', { pnl: '2.0', roi: '0.02', vlm: opts.vol7 ?? '200.0' }],
      ['month', { pnl: pnl30, roi: '0.03', vlm: '300.0' }],
      ['allTime', { pnl: '4.0', roi: opts.roiAll ?? '0.04', vlm: '400.0' }],
    ],
    prize: 0,
    displayName: opts.name ?? null,
  };
}

const LB: HlLeaderboardRaw = {
  leaderboardRows: [
    lbRow(A1.toUpperCase().replace('0X', '0x'), '59712661.8517849892', '-597010.1154979998', { vol7: '11008809761.69' }),
    lbRow(A2, '4729502.3674179995', '647337.6484740002', { name: '  Loracle ', roiAll: '0.2572' }),
    lbRow(A3, '69221131.6025169939', '-8103266.8744379999', { roiAll: '999999' }),
    // Near-empty account with an absurd ROI: must rank after real accounts on ROI.
    lbRow(A4, '1.0', '0.0', { roiAll: '151390.117' }),
    // Junk the parser must drop: bad address, duplicate.
    lbRow('not-an-address', '1', '1'),
    lbRow(A2, '1', '999999999'),
  ],
};

const Q = (o: Partial<LeaderboardQuery> = {}): LeaderboardQuery => ({ window: '30d', sort: 'pnl', limit: 50, offset: 0, ...o });

// --- leaderboard -----------------------------------------------------------------

test('parseLeaderboard: lower-cases, trims labels, maps windows, drops junk and duplicates', () => {
  const p = parseLeaderboard(LB);
  assert.deepEqual(p.addresses, [A1, A2, A3, A4]);
  assert.deepEqual(p.labels, [null, 'Loracle', null, null]);
  const snap = new LbSnapshot(p, 1790337075000, '"etag"', 0);
  const r = snap.row(1);
  assert.equal(r.venue, 'hyperliquid');
  assert.equal(r.address, A2);
  assert.equal(r.accountValue, 4729502.3674179995);
  assert.deepEqual(r.pnl, { '1d': 1, '7d': 2, '30d': 647337.6484740002, all: 4 });
  assert.deepEqual(r.roi, { '1d': 0.01, '7d': 0.02, '30d': 0.03, all: 0.2572 });
  assert.deepEqual(r.volume, { '1d': 100, '7d': 200, '30d': 300, all: 400 });
  assert.equal(snap.updatedAt, 1790337075000);
});

test('parseLeaderboard: a missing window becomes null, never 0', () => {
  const raw: HlLeaderboardRaw = {
    leaderboardRows: [{ ethAddress: A1, accountValue: '5', windowPerformances: [['day', { pnl: '1', roi: '0.1', vlm: '2' }]], displayName: null }],
  };
  const r = new LbSnapshot(parseLeaderboard(raw), 0, null, 42).row(0);
  assert.equal(r.pnl['1d'], 1);
  assert.equal(r.pnl['30d'], null);
  assert.equal(r.volume.all, null);
});

test('queryLeaderboard: sorts, pages, counts and ranks', () => {
  const snap = new LbSnapshot(parseLeaderboard(LB), 0, null, 7);
  const page = queryLeaderboard(snap, null, Q({ limit: 2 }));
  assert.equal(page.total, 4);
  assert.equal(page.source, 'Hyperliquid leaderboard');
  assert.equal(page.updatedAt, 7);
  assert.deepEqual(
    page.rows.map((r) => [r.rank, r.address]),
    [
      [1, A2],
      [2, A4],
    ],
  );
  assert.equal(page.rows[0]!.rankChange, null, 'no previous snapshot, no rank change');

  const p2 = queryLeaderboard(snap, null, Q({ limit: 2, offset: 2 }));
  assert.deepEqual(p2.rows.map((r) => [r.rank, r.address]), [
    [3, A1],
    [4, A3],
  ]);

  const byAv = queryLeaderboard(snap, null, Q({ sort: 'accountValue', window: '1d' }));
  assert.deepEqual(byAv.rows.map((r) => r.address), [A3, A1, A2, A4]);

  const byVol = queryLeaderboard(snap, null, Q({ sort: 'volume', window: '7d', limit: 1 }));
  assert.equal(byVol.rows[0]!.address, A1);

  const worst = queryLeaderboard(snap, null, Q({ window: '30d', side: 'worst', limit: 1 }));
  assert.equal(worst.rows[0]!.address, A3);
});

test('queryLeaderboard: ROI ranking puts dust accounts last but keeps them', () => {
  const snap = new LbSnapshot(parseLeaderboard(LB), 0, null, 0);
  const page = queryLeaderboard(snap, null, Q({ sort: 'roi', window: 'all' }));
  assert.equal(page.total, 4);
  assert.deepEqual(page.rows.map((r) => r.address), [A3, A2, A1, A4]);
  assert.ok(ROI_MIN_ACCOUNT_USD > 1);
});

test('queryLeaderboard: q matches an address prefix (with or without 0x), never a name; rank stays global', () => {
  const snap = new LbSnapshot(parseLeaderboard(LB), 0, null, 0);
  // No username is shown or searched (valuedesk/labels.ts).
  assert.equal(queryLeaderboard(snap, null, Q({ q: 'lorac' })).total, 0);
  for (const q of ['0x8C625', '8c625']) {
    const page = queryLeaderboard(snap, null, Q({ q }));
    assert.equal(page.total, 1, q);
    assert.equal(page.rows[0]!.address, A2);
  }
  const hit = queryLeaderboard(snap, null, Q({ q: A3 }));
  assert.equal(hit.rows[0]!.rank, 4, 'rank is the position in the full ordering');
  assert.equal(queryLeaderboard(snap, null, Q({ q: 'zzz' })).total, 0);
  assert.equal(matchesQuery(A1, null, '  '), true);
});

test('queryLeaderboard: rankChange is previous rank minus current rank', () => {
  const prevRaw: HlLeaderboardRaw = {
    leaderboardRows: [lbRow(A1, '1', '500'), lbRow(A3, '1', '400'), lbRow(A2, '1', '100')],
  };
  const prev = new LbSnapshot(parseLeaderboard(prevRaw), 0, null, 0);
  const cur = new LbSnapshot(parseLeaderboard(LB), 0, null, 0);
  const rows = queryLeaderboard(cur, prev, Q()).rows;
  const by = new Map(rows.map((r) => [r.address, r]));
  assert.equal(by.get(A2)!.rankChange, 2, 'A2 went from #3 to #1');
  assert.equal(by.get(A1)!.rankChange, -2, 'A1 went from #1 to #3');
  assert.equal(by.get(A4)!.rankChange, null, 'new entrant');
});

function fakeResponse(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(status === 304 ? null : body, { status, headers });
}

test('HlLeaderboardStore: conditional re-checks, 304 keeps, a new file rotates the previous one', async () => {
  let t = 1_000_000;
  const calls: Array<Record<string, string>> = [];
  const replies: Response[] = [
    fakeResponse(200, JSON.stringify({ leaderboardRows: [lbRow(A1, '1', '500'), lbRow(A2, '1', '100')] }), {
      etag: '"v1"',
      'last-modified': 'Fri, 25 Sep 2026 10:51:07 GMT',
    }),
    fakeResponse(304, ''),
    fakeResponse(200, JSON.stringify({ leaderboardRows: [lbRow(A1, '1', '100'), lbRow(A2, '1', '500')] }), {
      etag: '"v2"',
      'last-modified': 'Fri, 25 Sep 2026 11:51:15 GMT',
    }),
  ];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    calls.push({ ...(init?.headers as Record<string, string>) });
    return replies.shift()!;
  }) as unknown as typeof fetch;
  const store = new HlLeaderboardStore('https://example.invalid/lb', fetchImpl, () => t);

  const s1 = await store.snapshot();
  assert.equal(s1.n, 2);
  assert.equal(s1.lastModified, Date.parse('Fri, 25 Sep 2026 10:51:07 GMT'));
  assert.equal(calls.length, 1);

  await store.snapshot(); // within 60 s: no request
  assert.equal(calls.length, 1);

  t += 61_000;
  await store.refresh();
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!['If-None-Match'], '"v1"');
  assert.ok(calls[1]!['If-Modified-Since']);
  assert.equal(store.peek(), s1, '304 keeps the snapshot');
  assert.equal(store.previous(), null);

  t += 61_000;
  await store.refresh();
  const s3 = store.peek()!;
  assert.notEqual(s3, s1);
  assert.equal(store.previous(), s1);
  const row = queryLeaderboard(s3, store.previous(), Q({ q: A2 })).rows[0]!;
  assert.equal(row.rank, 1);
  assert.equal(row.rankChange, 1);
});

// --- positions -------------------------------------------------------------------

const CH: HlClearinghouseState = {
  marginSummary: { accountValue: '10179.613924', totalNtlPos: '81560.41068', totalRawUsd: '-29243.413956', totalMarginUsed: '9495.256257' },
  assetPositions: [
    {
      type: 'oneWay',
      position: {
        coin: 'BTC',
        szi: '0.04508',
        leverage: { type: 'cross', value: 40 },
        entryPx: '84784.9',
        positionValue: '3816.022',
        unrealizedPnl: '-6.0857',
        liquidationPx: null,
        marginUsed: '95.40055',
      },
    },
    {
      type: 'oneWay',
      position: {
        coin: 'AAVE',
        szi: '-141.23',
        leverage: { type: 'isolated', value: 10 },
        entryPx: '145.2827',
        positionValue: '21068.6914',
        unrealizedPnl: '-550.4152',
        liquidationPx: '322.7249843248',
        marginUsed: '2106.86914',
      },
    },
    {
      type: 'oneWay',
      position: { coin: 'ETH', szi: '0.0', leverage: { type: 'cross', value: 25 }, entryPx: null, positionValue: '0.0', unrealizedPnl: '0.0', liquidationPx: null, marginUsed: '0.0' },
    },
  ],
  time: 1790337529806,
};

test('mapPositions: sides, sizes, derived mark, liq, leverage, flat entries dropped, largest first', () => {
  const ps = mapPositions(CH);
  assert.equal(ps.length, 2);
  const [aave, btc] = ps;
  assert.deepEqual(aave, {
    symbol: 'AAVE',
    side: 'short',
    size: 141.23,
    notional: 21068.6914,
    entryPx: 145.2827,
    markPx: 21068.6914 / 141.23,
    liqPx: 322.7249843248,
    uPnl: -550.4152,
    leverage: 10,
    marginMode: 'isolated',
  });
  assert.equal(btc!.side, 'long');
  assert.equal(btc!.liqPx, null);
  assert.equal(btc!.marginMode, 'cross');
  assert.ok(Math.abs(btc!.markPx! - 84650.00) < 0.5);
});

test('mapPosition: HIP-3 dex prefix only when missing; mark fallback', () => {
  const base = CH.assetPositions[0]!.position;
  assert.equal(mapPosition({ ...base, coin: 'xyz:SP500' }, 'xyz')!.symbol, 'xyz:SP500');
  assert.equal(mapPosition({ ...base, coin: 'SP500' }, 'xyz')!.symbol, 'xyz:SP500');
  const noValue = mapPosition({ ...base, positionValue: '' }, '', new Map([['BTC', 80000]]))!;
  assert.equal(noValue.markPx, 80000);
  assert.equal(noValue.notional, 0.04508 * 80000);
});

// --- fills -----------------------------------------------------------------------

const fill = (o: Partial<HlFillRaw> & { tid: number }): HlFillRaw => ({
  coin: 'ETH',
  px: '2718.6',
  sz: '0.0605',
  side: 'B',
  time: 1790337572478,
  dir: 'Open Long',
  closedPnl: '0.0',
  oid: 1,
  fee: '0.123356',
  feeToken: 'USDC',
  ...o,
});

test('mapFill: id, user side, notional, USD fee, closed PnL, dir', () => {
  const f = mapFill(fill({ tid: 103284849280132, builderFee: '0.064145' }));
  assert.deepEqual(f, {
    id: '103284849280132',
    time: 1790337572478,
    symbol: 'ETH',
    side: 'buy',
    px: 2718.6,
    sz: 0.0605,
    notional: 2718.6 * 0.0605,
    fee: 0.123356,
    closedPnl: 0,
    dir: 'Open Long',
    oid: '1',
  });
  assert.equal(mapFill(fill({ tid: 1, side: 'A' })).side, 'sell');
  // Spot buy: fee charged in the base token, converted at the fill price.
  const spot = mapFill(fill({ tid: 2, coin: '@107', px: '40', fee: '0.01', feeToken: 'HYPE', dir: 'Buy' }));
  assert.equal(spot.fee, 0.4);
  assert.equal(mapFill(fill({ tid: 3, fee: undefined })).fee, null);
});

test('fillStats: one trade per closing order; win rate by runs of reducing fills (shared definition)', () => {
  const s = fillStats([
    fill({ tid: 1, oid: 10, time: 100, side: 'B' }), // open long: not a trade
    fill({ tid: 2, oid: 11, time: 200, side: 'A', dir: 'Close Long', closedPnl: '5' }),
    fill({ tid: 3, oid: 11, time: 200, side: 'A', dir: 'Close Long', closedPnl: '-1' }), // same run: +4
    fill({ tid: 4, oid: 12, time: 250, side: 'A', dir: 'Close Long', closedPnl: '-3' }), // another order, SAME run: +1
    fill({ tid: 5, oid: 13, time: 300, side: 'A', dir: 'Open Short', closedPnl: '0.0' }), // opens
    fill({ tid: 6, oid: 14, time: 400, side: 'B', dir: 'Short > Long', closedPnl: '-2' }), // a flip closes: loss
    fill({ tid: 7, oid: 15, time: 500, side: 'A', dir: 'Close Long', closedPnl: '0.0' }), // break-even: no run
  ]);
  assert.equal(s.trades, 4, 'orders 11, 12, 14, 15 closed or reduced');
  assert.equal(s.closes, 2);
  assert.equal(s.wins, 1);
  assert.equal(s.winRate, 1 / 2, 'the whole history (under a page): exact, shown from one close');
  assert.equal(s.winRateExact, true);
  assert.equal(s.lastActive, 500);
  assert.equal(s.sampleFrom, 100);
  assert.equal(s.sampleSize, 7);
  assert.deepEqual(fillStats([]), { trades: 0, winRate: null, winRateExact: true, closes: 0, wins: 0, lastActive: null, sampleFrom: null, sampleSize: 0 });
});

test('fillStats: a TWAP closing one losing short in 135 slices is ONE close, not 135 (the 0% case)', () => {
  const twap = Array.from({ length: 135 }, (_, i) => fill({ tid: 100 + i, oid: 1_000 + i, time: 1_000 + i, side: 'B', coin: 'ZEC', dir: 'Close Short', closedPnl: '-5000' }));
  const s = fillStats(twap);
  assert.equal(s.trades, 135);
  assert.equal(s.closes, 1);
  // A full page is a sample, not the history: an estimate needs 10 closes before it shows.
  const page = fillStats(twap, 100);
  assert.equal(page.winRateExact, false);
  assert.equal(page.winRate, null);
});

// --- portfolio -------------------------------------------------------------------

const PF: HlPortfolio = [
  [
    'day',
    {
      accountValueHistory: [
        [1, '1000.0'],
        [2, '1100.0'],
        [3, '990.0'],
      ],
      pnlHistory: [
        [1, '0.0'],
        [2, '100.0'],
        [3, '-10.0'],
      ],
      vlm: '5000.0',
    },
  ],
  [
    'month',
    {
      // Deposit of 9,000 between t=2 and t=3: AV jumps, PnL does not.
      accountValueHistory: [
        [1, '1000.0'],
        [2, '1000.0'],
        [3, '10000.0'],
        [4, '9000.0'],
      ],
      pnlHistory: [
        [1, '0.0'],
        [2, '0.0'],
        [3, '0.0'],
        [4, '-1000.0'],
      ],
      vlm: '9.0',
    },
  ],
  ['allTime', { accountValueHistory: [[1, '5.0'], [2, '9000.0']], pnlHistory: [[1, '0.0'], [2, '-271000000.0']], vlm: '1.0' }],
  ['perpDay', { accountValueHistory: [[1, '1.0']], pnlHistory: [[1, '0.0']], vlm: '0.0' }],
];

test('mapPortfolio: our window names, zipped by timestamp, perp-only windows skipped', () => {
  const eq = mapPortfolio(PF);
  assert.deepEqual(Object.keys(eq).sort(), ['1d', '30d', 'all']);
  assert.deepEqual(eq['1d']![1], { t: 2, accountValue: 1100, pnl: 100 });
  const ragged = equitySeries({ accountValueHistory: [[5, '1']], pnlHistory: [[6, '2']], vlm: '0' });
  assert.deepEqual(ragged, [
    { t: 5, accountValue: 1, pnl: null },
    { t: 6, accountValue: null, pnl: 2 },
  ]);
});

test('periodReturns / twr / maxDrawdownOf: flow-neutral and dust-proof', () => {
  const s = (pts: Array<[number, number]>): EquityPoint[] => pts.map(([av, pnl], t) => ({ t, accountValue: av, pnl }));
  // +10% then -10% on 1,000: TWR = 1.1 * 0.9 - 1 = -1%, drawdown 10%.
  const plain = s([
    [1000, 0],
    [1100, 100],
    [990, -10],
  ]);
  assert.ok(Math.abs(twr(plain)! - -0.01) < 1e-12);
  assert.ok(Math.abs(maxDrawdownOf(plain)! - 0.1) < 1e-12);
  // A deposit is not a return; the loss after it is measured on the new capital.
  const month = equitySeries(PF[1]![1]);
  assert.deepEqual(periodReturns(month), [0, 0, -0.1]);
  // A wipe-out while the account held under 1% of its later peak is ignored.
  const dust = s([
    [2000, 0],
    [0, -2000],
    [500000, -2000],
    [450000, -52000],
  ]);
  assert.deepEqual(periodReturns(dust), [0, -0.1]);
  assert.equal(twr([]), null);
  assert.equal(maxDrawdownOf(s([[1, 0], [1, 0]])), null, 'no interval above the floor');
});

test('portfolioMaxDrawdown: 30-day windows only, allTime accounting jumps ignored', () => {
  assert.ok(Math.abs(portfolioMaxDrawdown(PF)! - 0.1) < 1e-12);
  assert.equal(portfolioMaxDrawdown(null), null);
});

test('portfolioHasActivity and summaryFromPortfolio', () => {
  const empty: HlPortfolio = [['day', { accountValueHistory: [[1, '0.0']], pnlHistory: [[1, '0.0']], vlm: '0.0' }]];
  assert.equal(portfolioHasActivity(empty), false);
  assert.equal(portfolioHasActivity(PF), true);
  assert.equal(portfolioHasActivity(null), false);

  const row = summaryFromPortfolio(A1, PF, 123);
  assert.equal(row.address, A1);
  assert.equal(row.accountValue, 9000, 'latest account value across windows');
  assert.equal(row.pnl['1d'], -10);
  assert.equal(row.pnl['30d'], -1000);
  assert.equal(row.volume['1d'], 5000);
  assert.ok(Math.abs(row.roi['1d']! - -0.01) < 1e-12);
  assert.equal(row.roi.all, null, 'allTime ROI is not derived');
  assert.equal(summaryFromPortfolio(A1, null, 123).accountValue, 123);
});

// --- whales ----------------------------------------------------------------------

const wsTrade = (o: Partial<HlWsTrade> & { tid: number }): HlWsTrade => ({
  coin: 'ETH',
  side: 'B',
  px: '2718.6',
  sz: '0.0605',
  time: 1790337572478,
  hash: '0xa5e4d1f8a04be669a75e04452ca58b02027801013b4f053b49ad7d4b5f4fc054',
  users: ['0xE6CAF898D70A0F0365AE8C6211ADE489025AA1BB', '0x023a3d058020fb76cca98f01b3c48c8938a22355'],
  ...o,
});

test('takerOf: side B is the buyer (users[0]), side A the seller (users[1])', () => {
  assert.equal(takerOf(wsTrade({ tid: 1 })), '0xe6caf898d70a0f0365ae8c6211ade489025aa1bb');
  assert.equal(takerOf(wsTrade({ tid: 1, side: 'A' })), '0x023a3d058020fb76cca98f01b3c48c8938a22355');
  assert.equal(takerOf({ side: 'B', users: ['nope', 'x'] as [string, string] }), null);
});

test('aggregateTakerPrints: one taker order across makers becomes one VWAP trade', () => {
  const out = aggregateTakerPrints([
    wsTrade({ tid: 1, px: '100', sz: '1' }),
    wsTrade({ tid: 2, px: '110', sz: '3', users: ['0xe6caf898d70a0f0365ae8c6211ade489025aa1bb', '0xcd82f03d5df801a69af899a7f13263388e1f6274'] }),
    wsTrade({ tid: 3, side: 'A', hash: '0x296c', px: '99', sz: '2' }),
    wsTrade({ tid: 4, hash: '0x0000000000000000000000000000000000000000000000000000000000000000', px: '1', sz: '1' }),
    wsTrade({ tid: 5, hash: '0x0000000000000000000000000000000000000000000000000000000000000000', px: '1', sz: '1' }),
  ]);
  assert.equal(out.length, 4);
  const [agg, sell] = out;
  assert.equal(agg!.sz, 4);
  assert.equal(agg!.notional, 430);
  assert.equal(agg!.px, 107.5);
  assert.equal(agg!.side, 'buy');
  assert.equal(agg!.address, '0xe6caf898d70a0f0365ae8c6211ade489025aa1bb');
  assert.equal(sell!.side, 'sell');
  assert.equal(sell!.address, '0x023a3d058020fb76cca98f01b3c48c8938a22355');
});

test('HlTradeFeed.ingest: keeps taker orders >= $10k, dedupes snapshot replays; TradeRing filters', () => {
  const feed = new HlTradeFeed({ post: async () => { throw new Error('offline'); } });
  const big = [wsTrade({ tid: 10, px: '100000', sz: '0.1' }), wsTrade({ tid: 11, px: '100000', sz: '0.05' })];
  feed.ingest(big);
  feed.ingest(big); // reconnect snapshot replays the same tids
  feed.ingest([wsTrade({ tid: 12, px: '10', sz: '1', hash: '0xsmall' })]);
  assert.equal(feed.buffered, 1);

  const ring = new TradeRing(3);
  for (let i = 0; i < 5; i++) {
    ring.push({ venue: 'hyperliquid', time: i, symbol: 'BTC', side: 'buy', px: 1, sz: 1, notional: WHALE_KEEP_USD * (i + 1), address: null });
  }
  assert.deepEqual(ring.recent(0, 10).map((t) => t.time), [4, 3, 2], 'trimmed to the newest 3');
  assert.deepEqual(ring.recent(WHALE_KEEP_USD * 4, 10).map((t) => t.time), [4, 3]);
  assert.deepEqual(ring.recent(0, 2).map((t) => t.time), [4, 3]);

  const seen = new SeenIds(2);
  assert.equal(seen.add(1), true);
  assert.equal(seen.add(1), false);
  seen.add(2); // rotates a generation; 1 is still remembered
  assert.equal(seen.add(1), false);
});

test('coinsFromMeta / topCoins: rank by 24h notional, skip delisted', () => {
  const meta: HlMetaAndAssetCtxs = [
    {
      universe: [
        { name: 'BTC', szDecimals: 5, maxLeverage: 40 },
        { name: 'OLD', szDecimals: 0, maxLeverage: 3, isDelisted: true },
        { name: 'ETH', szDecimals: 4, maxLeverage: 25 },
        { name: 'DEAD', szDecimals: 0, maxLeverage: 3 },
      ],
    },
    [
      { dayNtlVlm: '3333107237.55', markPx: '84568.0' },
      { dayNtlVlm: '9e12', markPx: '1' },
      { dayNtlVlm: '1023390737.60', markPx: '2718.0' },
      { dayNtlVlm: '0.0', markPx: '1' },
    ],
  ];
  const coins = coinsFromMeta(meta);
  assert.deepEqual(coins.map((c) => c.coin), ['BTC', 'ETH', 'DEAD']);
  assert.deepEqual(topCoins([...coins, { coin: 'xyz:SP500', dayNtlVlm: 2e9, markPx: null }], 2), ['BTC', 'xyz:SP500']);
  assert.deepEqual(coinsFromMeta(null), []);
});

// --- positioning -----------------------------------------------------------------

test('symbolKey / symbolMatches: venue spellings meet', () => {
  assert.equal(symbolKey('btc-usd'), 'BTC');
  assert.equal(symbolKey('BTC/USDC'), 'BTC');
  assert.equal(symbolKey('ETH-USD-PERP'), 'ETH');
  assert.equal(symbolMatches('BTC', 'btc-usd'), true);
  assert.equal(symbolMatches('xyz:SP500', 'SP500'), true);
  assert.equal(symbolMatches('xyz:SP500', 'xyz:sp500'), true);
  assert.equal(symbolMatches('xyz:SP500', 'abc:SP500'), false);
  assert.equal(symbolMatches('BTC', 'ETH'), false);
});

test('aggregatePositioning: long/short USD and trader counts per coin, biggest market first', () => {
  const p = (symbol: string, side: 'long' | 'short', notional: number) => ({
    symbol, side, size: 1, notional, entryPx: null, markPx: null, liqPx: null, uPnl: null, leverage: null,
  });
  const rows = aggregatePositioning([
    [p('BTC', 'long', 100), p('ETH', 'short', 50)],
    [p('BTC', 'short', 300)],
    [p('BTC', 'long', 10)],
  ]);
  assert.deepEqual(rows, [
    { venue: 'hyperliquid', symbol: 'BTC', longUsd: 110, shortUsd: 300, longTraders: 2, shortTraders: 1 },
    { venue: 'hyperliquid', symbol: 'ETH', longUsd: 0, shortUsd: 50, longTraders: 0, shortTraders: 1 },
  ]);
});

test('HlPositioning: sweeps the top accounts on both dexes, caches, filters by symbol', async () => {
  const snap = new LbSnapshot(parseLeaderboard(LB), 0, null, 0);
  const bodies: InfoBody[] = [];
  const info: InfoLike = {
    async post<T>(body: InfoBody): Promise<T> {
      bodies.push(body);
      if (body.dex === 'xyz') {
        return {
          ...CH,
          assetPositions: [{ type: 'oneWay', position: { ...CH.assetPositions[0]!.position, coin: 'xyz:SP500' } }],
        } as T;
      }
      return CH as T;
    },
  };
  let t = 0;
  const pos = new HlPositioning(info, { snapshot: async () => snap }, () => t);
  const all = await pos.get();
  assert.equal(bodies.length, 8, '4 accounts x 2 dexes');
  assert.deepEqual(new Set(bodies.map((b) => b.user)), new Set([A1, A2, A3, A4]));
  const aave = all.find((r) => r.symbol === 'AAVE')!;
  assert.equal(aave.shortTraders, 4);
  assert.equal(aave.shortUsd, 4 * 21068.6914);
  assert.deepEqual((await pos.get('sp500')).map((r) => r.symbol), ['xyz:SP500']);
  assert.equal(bodies.length, 8, 'cached');
  t += 4 * 60_000;
  await pos.get();
  await new Promise((r) => setImmediate(r));
  assert.ok(bodies.length > 8, 'stale cache triggers a background sweep');
});

// --- trader / fills --------------------------------------------------------------

function stubInfo(handler: (body: InfoBody) => unknown): InfoLike & { bodies: InfoBody[] } {
  const bodies: InfoBody[] = [];
  return {
    bodies,
    async post<T>(body: InfoBody): Promise<T> {
      bodies.push(body);
      return handler(body) as T;
    },
  };
}

const EMPTY_CH: HlClearinghouseState = {
  marginSummary: { accountValue: '0.0', totalNtlPos: '0.0', totalRawUsd: '0.0', totalMarginUsed: '0.0' },
  assetPositions: [],
};
const EMPTY_PF: HlPortfolio = [['day', { accountValueHistory: [[1, '0.0']], pnlHistory: [[1, '0.0']], vlm: '0.0' }]];

test('hlTrader: null for an address with no Hyperliquid activity', async () => {
  const info = stubInfo((b) => (b.type === 'clearinghouseState' ? EMPTY_CH : b.type === 'portfolio' ? EMPTY_PF : []));
  const snap = new LbSnapshot(parseLeaderboard(LB), 0, null, 0);
  const lb = { snapshot: async () => snap, peek: () => snap, previous: () => null };
  assert.equal(await hlTrader('0x1234567890abcdef1234567890abcdef12345678', { info, leaderboard: lb }), null);
});

test('hlTrader: leaderboard row + positions (all dexes seen) + fill stats + 30d drawdown', async () => {
  const sample = [
    fill({ tid: 1, oid: 1, time: 10, dir: 'Close Long', closedPnl: '5' }),
    fill({ tid: 2, oid: 2, time: 20, dir: 'Close Short', closedPnl: '-1', coin: 'flx:GOLD' }),
  ];
  const info = stubInfo((b) => {
    if (b.type === 'clearinghouseState') return b.dex ? EMPTY_CH : CH;
    if (b.type === 'portfolio') return PF;
    if (b.type === 'userFills') return sample;
    throw new Error(`unexpected ${b.type}`);
  });
  const snap = new LbSnapshot(parseLeaderboard(LB), 0, null, 0);
  const lb = { snapshot: async () => snap, peek: () => snap, previous: () => null };
  const p = (await hlTrader(A2, { info, leaderboard: lb }))!;
  assert.ok(p);
  assert.equal(p.summary.label, 'Loracle');
  assert.equal(p.summary.rank, 1, '#1 by 30d PnL');
  assert.equal(p.summary.trades, 2);
  assert.equal(p.summary.winRate, 0.5);
  assert.equal(p.summary.lastActive, 20);
  assert.ok(Math.abs(p.summary.maxDrawdown! - 0.1) < 1e-12);
  assert.deepEqual(p.summary.tags, ['whale', 'high-leverage']);
  assert.deepEqual(p.summary.spark, [0, 0, 0, -1000]);
  assert.equal(p.positions.length, 2);
  assert.deepEqual(Object.keys(p.equity).sort(), ['1d', '30d', 'all']);
  assert.equal(p.source, 'Hyperliquid info API + leaderboard');
  const dexes = info.bodies.filter((b) => b.type === 'clearinghouseState').map((b) => b.dex ?? '');
  assert.deepEqual(dexes.sort(), ['', 'flx', 'xyz'], 'a dex seen in the fills is checked too');
});

/** HL over one account's fill times: userFillsByTime ascending from startTime, userFills newest first, 2,000 an answer. */
function fillsInfo(times: number[]) {
  const all = times.map((t, i) => fill({ tid: i + 1, oid: i + 1, time: t })).sort((a, b) => a.time - b.time);
  return stubInfo((b) => {
    if (b.type === 'portfolio') return PF;
    if (b.type === 'userFillsByTime') return all.filter((f) => f.time >= (b.startTime as number)).slice(0, HL_FILLS_PAGE);
    if (b.type === 'userFills') return [...all].reverse().slice(0, HL_FILLS_PAGE);
    throw new Error(`unexpected ${b.type}`);
  });
}

test('hlPeek: the newest fill exactly as the profile has it, without the 2,000-fill sample, and the same curves', async () => {
  const now = 1_790_000_000_000;
  const H = 3_600_000;
  const D = 24 * H;
  const byTime = (n: number) => Array<string>(n).fill('userFillsByTime');
  const cases: Array<[string, number[], string[]]> = [
    ['busy: a fill a minute ago', [now - 2 * H, now - 60_000], byTime(1)],
    ['active this hour', [now - 3 * D, now - 2 * H, now - 10 * 60_000], byTime(2)],
    ['quiet two days', [now - 20 * D, now - 2 * D - 5], byTime(6)],
    ['dormant two months', [now - 90 * D, now - 61 * D], [...byTime(8), 'userFills']],
    ['a bot: 2,500 fills in five minutes', Array.from({ length: 2500 }, (_, i) => now - 250_000 + i * 100), byTime(2)],
    ['a bot past five pages', Array.from({ length: 11_000 }, (_, i) => now - 225_000 + i * 20), [...byTime(5), 'userFills']],
  ];
  for (const [what, times, asks] of cases) {
    const info = fillsInfo(times);
    const peek = (await hlPeek(A2, info, now))!;
    assert.equal(peek.summary.lastActive, Math.max(...times), what);
    assert.deepEqual(info.bodies.filter((b) => b.type !== 'portfolio').map((b) => b.type), asks, `${what}: what was asked`);
  }
  // The curves are the profile's own (another address than above: hlTrader keeps profiles 20 s).
  const sample = [fill({ tid: 1, oid: 1, time: now - 60_000 })];
  const full = (await hlTrader(A4, {
    info: stubInfo((b) => (b.type === 'clearinghouseState' ? CH : b.type === 'portfolio' ? PF : b.type === 'userFills' ? sample : [])),
    leaderboard: { snapshot: async () => new LbSnapshot(parseLeaderboard(LB), 0, null, 0), peek: () => null, previous: () => null },
  }))!;
  const peek = (await hlPeek(A4, fillsInfo([now - 60_000]), now))!;
  assert.deepEqual(peek.equity, full.equity);
  assert.deepEqual(peek.summary.spark, full.summary.spark);
  assert.equal(peek.summary.lastActive, full.summary.lastActive);
  // Nothing ever done: null, as hlTrader.
  assert.equal(await hlPeek(A1, stubInfo((b) => (b.type === 'portfolio' ? EMPTY_PF : [])), now), null);
});

test('hlPeek with the index\'s hint: one read from the minute before it, the same newest fill; a hint HL does not confirm falls back', async () => {
  const now = 1_790_000_000_000;
  const H = 3_600_000;
  const D = 24 * H;
  const cases: Array<[string, number[], number, string[]]> = [
    // The walk asked 8 windows and the sample for this one; the hint finds it in one.
    ['dormant two months, hinted at its last fill', [now - 90 * D, now - 61 * D], now - 61 * D, ['userFillsByTime']],
    ['quiet two days, hinted', [now - 20 * D, now - 2 * D - 5], now - 2 * D - 5, ['userFillsByTime']],
    // The index is behind: the fills since its newest hold a newer one, which is what is shown.
    ['the index behind by a day', [now - 3 * D, now - 2 * D, now - 3 * H], now - 2 * D, ['userFillsByTime']],
    ['a bot past five pages from the hint: the sample', Array.from({ length: 11_000 }, (_, i) => now - 225_000 + i * 20), now - 225_000, [...Array<string>(5).fill('userFillsByTime'), 'userFills']],
    // A hint with no fill after it on HL (a wrong row): the windows, as without one.
    ['a hint HL does not confirm', [now - 20 * D, now - 2 * D - 5], now - 60_000, [...Array<string>(7).fill('userFillsByTime')]],
  ];
  for (const [what, times, hint, asks] of cases) {
    const info = fillsInfo(times);
    const peek = (await hlPeek(A2, info, now, hint))!;
    assert.equal(peek.summary.lastActive, Math.max(...times), what);
    assert.deepEqual(info.bodies.filter((b) => b.type !== 'portfolio').map((b) => b.type), asks, `${what}: what was asked`);
    const first = info.bodies.find((b) => b.type === 'userFillsByTime') as { startTime?: number } | undefined;
    if (hint <= Math.max(...times)) assert.equal(first?.startTime, Math.floor((hint - 60_000) / 60_000) * 60_000, `${what}: from the minute before the hint`);
  }
});

test('hlFills: one page answers a recent query, newest first, limited', async () => {
  const recent = Array.from({ length: 5 }, (_, i) => fill({ tid: 100 + i, time: 1000 - i * 10 }));
  const info = stubInfo(() => recent);
  const got = await hlFills(info, A1, { limit: 3 });
  assert.deepEqual(got.map((f) => f.id), ['100', '101', '102']);
  assert.equal(info.bodies.length, 1);
  assert.equal(info.bodies[0]!.type, 'userFills');
  const ranged = await hlFills(info, A1, { from: 965, to: 990 });
  assert.deepEqual(ranged.map((f) => f.time), [990, 980, 970]);
});

test('hlFills: pages forward past a full page, dedupes the boundary, caps at 10,000', async () => {
  // HL keeps the 10,000 most recent fills reachable: the newest page (2,000
  // fills, times 10000..11999) plus 8,000 older ones (times 2000..9999).
  const newest = Array.from({ length: 2000 }, (_, i) => fill({ tid: 20000 + i, time: 11999 - i }));
  const older = Array.from({ length: 8000 }, (_, i) => fill({ tid: i, time: 2000 + i }));
  const info = stubInfo((b) => {
    if (b.type === 'userFills') return newest;
    const start = b.startTime as number;
    const end = b.endTime as number;
    // Ascending, capped at 2,000, and it re-sends the boundary fill.
    return [...older, newest.at(-1)!].filter((f) => f.time >= start && f.time <= end).sort((x, y) => x.time - y.time).slice(0, 2000);
  });
  const got = await hlFills(info, A1, { limit: 3000 });
  assert.equal(got.length, 3000);
  assert.equal(got[0]!.time, 11999);
  assert.equal(got.at(-1)!.time, 9000);
  assert.equal(new Set(got.map((f) => f.id)).size, 3000);
  const pages = info.bodies.filter((b) => b.type === 'userFillsByTime');
  assert.ok(pages.length >= 1 && pages.length <= 5);
  assert.equal(pages[0]!.startTime, 0);
  assert.equal((await hlFills(info, A1, { limit: 1e9 })).length, 10000, 'limit clamps to what HL can reach');
  const old = await hlFills(info, A1, { to: 5000, limit: 10 });
  assert.deepEqual(old.map((f) => f.time), [5000, 4999, 4998, 4997, 4996, 4995, 4994, 4993, 4992, 4991]);
});

// --- info client -----------------------------------------------------------------

test('weights: documented base weights and per-20-items extra', () => {
  assert.equal(baseWeight('clearinghouseState'), 2);
  assert.equal(baseWeight('allMids'), 2);
  assert.equal(baseWeight('userRole'), 60);
  assert.equal(baseWeight('portfolio'), 20);
  assert.equal(itemWeight('userFills', new Array(2000)), 100);
  assert.equal(itemWeight('userFills', new Array(21)), 2);
  assert.equal(itemWeight('portfolio', new Array(2000)), 0);
  assert.equal(itemWeight('userFills', { not: 'an array' }), 0);
});

test('WeightBudget: burst, debt serialises callers, post-hoc charge, 429 penalty', () => {
  const b = new WeightBudget(600, 100, 0); // 10 weight per second
  assert.equal(b.reserve(60, 0), 0);
  assert.equal(b.reserve(40, 0), 0);
  assert.equal(b.reserve(20, 0), 2000, 'debt of 20 at 10/s');
  assert.equal(b.reserve(20, 0), 4000, 'next caller queues behind');
  assert.equal(b.available(4000), 0);
  b.charge(30, 4000);
  assert.equal(b.msUntil(10, 4000), 4000);
  b.penalize(10_000, 4000);
  assert.equal(b.available(4000), -100);
  assert.equal(b.available(1_000_000), 100, 'refill caps at capacity');
});

test('backoff and retry classification', () => {
  for (let n = 1; n <= 8; n++) {
    const lo = hlBackoffMs(n, 'rateLimit', 0);
    const hi = hlBackoffMs(n, 'rateLimit', 1);
    assert.ok(lo >= 1000 && hi <= 15_000 && lo <= hi);
  }
  assert.equal(hlBackoffMs(1, 'transport', 0), 200);
  assert.equal(hlRetryKind(new HlApiError(429, 'x', 'portfolio')), 'rateLimit');
  assert.equal(hlRetryKind(new HlApiError(502, 'x', 'portfolio')), 'transport');
  assert.equal(hlRetryKind(new HlApiError(422, 'x', 'portfolio')), null);
  assert.equal(hlRetryKind(new TypeError('fetch failed')), 'transport');
  assert.equal(hlRetryKind(new Error('boom')), null);
});

function clientWith(replies: Array<() => Response>) {
  const sent: string[] = [];
  const slept: number[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    sent.push(String(init?.body));
    const next = replies.shift();
    if (!next) throw new Error('no more replies');
    return next();
  }) as unknown as typeof fetch;
  const client = new HlInfoClient('https://example.invalid/info', 1200, fetchImpl, async (ms) => {
    slept.push(ms);
  });
  return { client, sent, slept };
}

test('HlInfoClient: in-flight dedup and TTL cache', async () => {
  const { client, sent } = clientWith([() => new Response('{"a":1}'), () => new Response('{"a":2}')]);
  const body = { type: 'clearinghouseState', user: A1 };
  const [x, y] = await Promise.all([client.post(body, { ttlMs: 60_000 }), client.post(body, { ttlMs: 60_000 })]);
  assert.deepEqual(x, { a: 1 });
  assert.equal(x, y);
  assert.deepEqual(await client.post(body, { ttlMs: 60_000 }), { a: 1 }, 'cached');
  assert.equal(sent.length, 1);
  assert.deepEqual(await client.post(body), { a: 2 }, 'ttl 0 = fresh request');
  assert.equal(sent.length, 2);
});

test('HlInfoClient: 429 is retried after a backoff and drains the bucket; 422 is final', async () => {
  const { client, sent, slept } = clientWith([
    () => new Response('rate limited', { status: 429 }),
    () => new Response('[1,2,3]'),
  ]);
  assert.deepEqual(await client.post({ type: 'userFills', user: A1 }), [1, 2, 3]);
  assert.equal(sent.length, 2);
  assert.ok(slept.some((ms) => ms >= 1000), 'backed off before the retry');
  assert.ok(client.budget.available() < 0, 'the 429 penalty leaves the bucket in debt');

  const bad = clientWith([() => new Response('Failed to deserialize the JSON body', { status: 422 })]);
  await assert.rejects(bad.client.post({ type: 'nope' }), (e: unknown) => e instanceof HlApiError && e.status === 422);
  assert.equal(bad.sent.length, 1);
});

test('mapLimit: bounded concurrency, results in input order, failures isolated', async () => {
  let live = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
    live++;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 5));
    live--;
    if (n === 3) throw new Error('three');
    return n * 10;
  });
  assert.equal(peak, 2);
  assert.deepEqual(out.map((r) => (r.status === 'fulfilled' ? r.value : 'x')), [10, 20, 'x', 40, 50]);
});

/** A body that arrives in pieces of `size` bytes, like a slow download. */
function streamOf(text: string, size: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream({
    pull(c) {
      if (at >= bytes.length) return c.close();
      c.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  });
}

test('parseLeaderboardStream: row by row, whatever the chunk size, the same columns as parsing the whole file', async () => {
  // A label holding quotes, braces, brackets and a non-ASCII character split across chunks must not confuse the scan.
  const raw: HlLeaderboardRaw = { leaderboardRows: [...LB.leaderboardRows, { ...LB.leaderboardRows[1]!, ethAddress: '0x' + 'ab'.repeat(20), displayName: 'a "}{[]\\" € trader' }] };
  const whole = parseLeaderboard(raw);
  for (const text of [JSON.stringify(raw), JSON.stringify(raw, null, 2)]) {
    for (const size of [1, 3, 7, 64, 1 << 16]) {
      const streamed = await parseLeaderboardStream(streamOf(text, size));
      assert.deepEqual(streamed, whole, `chunks of ${size}`);
    }
  }
  assert.equal(whole.labels.at(-1), 'a "}{[]\\" € trader');
});

test('parseLeaderboardStream: a download cut short is an error, never a shorter leaderboard', async () => {
  const text = JSON.stringify(LB, null, 2);
  await assert.rejects(parseLeaderboardStream(streamOf(text.slice(0, Math.floor(text.length * 0.6)), 50)), /ended early/);
  await assert.rejects(parseLeaderboardStream(null), /no body/);
});

test('parseLeaderboardStream: 50,000 rows in 64 KB pieces - only the row being read is held as text', async () => {
  const rows = Array.from({ length: 50_000 }, (_, i) => ({ ...LB.leaderboardRows[0]!, ethAddress: '0x' + i.toString(16).padStart(40, '0') }));
  const p = await parseLeaderboardStream(streamOf(JSON.stringify({ leaderboardRows: rows }, null, 2), 1 << 16));
  assert.equal(p.addresses.length, 50_000);
  assert.equal(p.accountValue.length, 50_000);
});

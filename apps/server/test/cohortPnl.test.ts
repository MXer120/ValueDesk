/**
 * PnL for the Hyperliquid holders the leaderboard does not rank: read from each
 * wallet's portfolio (cohortSource.ts hlPortfolioPnl), kept in cohort_pnl, and
 * scheduled largest first (cohortTracker.ts pnlPrio / pnlTtl).
 *
 *   npx tsx --test test/cohortPnl.test.ts   (from apps/server)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { portfolioPnl } from '../src/indexer/cohortSource.js';
import { PNL_SHARE, pnlPrio, pnlTtl } from '../src/indexer/cohortTracker.js';
import { IndexStore } from '../src/indexer/store.js';
import type { HlPortfolio } from '../src/valuescan/hyperliquid/raw.js';

const DAY = 86_400_000;

test('portfolioPnl: the last point of the window asked for, the whole account (allTime), not perps only', () => {
  const p: HlPortfolio = [
    ['day', { accountValueHistory: [[1, '10']], pnlHistory: [[1, '0'], [2, '-12.5']], vlm: '0' }],
    ['allTime', { accountValueHistory: [[1, '10']], pnlHistory: [[1, '0'], [2, '900'], [3, '1234.5']], vlm: '0' }],
    ['perpAllTime', { accountValueHistory: [[1, '10']], pnlHistory: [[1, '0'], [3, '700']], vlm: '0' }],
  ];
  assert.equal(portfolioPnl(p, 'allTime'), 1234.5);
  assert.equal(portfolioPnl(p, 'day'), -12.5);
  assert.equal(portfolioPnl(p, 'month'), null, 'a window it does not have');
  assert.equal(portfolioPnl(null, 'allTime'), null);
  assert.equal(portfolioPnl([['allTime', { accountValueHistory: [], pnlHistory: [], vlm: '0' }]], 'allTime'), null, 'an empty chart');
});

test('a $100K+ holder is read just under a stale book of its size, the tail after every position read; the large again sooner', () => {
  // Position reads (cohortTracker.ts plan): size = log10(equity) x 100.
  const size = (eq: number) => Math.round(Math.log10(Math.max(1, eq)) * 100);
  for (const eq of [100_000, 150_000, 5_000_000, 80_000_000]) {
    const p = pnlPrio(eq);
    assert.ok(p < 1_000 + size(eq) && p < 950 + size(eq), `${eq}: under a first read and a stale book`);
    assert.ok(p > 900 + size(eq) && p > 400 + size(eq), `${eq}: over a gap / spot re-read and a reconcile`);
  }
  assert.ok(pnlPrio(5_000_000) > pnlPrio(150_000));
  for (const eq of [0, 50, 9_999, 99_999]) assert.ok(pnlPrio(eq) < 400 && pnlPrio(eq) >= 300, `${eq}: the tail after every position read`);
  assert.ok(PNL_SHARE > 0 && PNL_SHARE < 1);
  assert.equal(pnlTtl(2_000_000), DAY);
  assert.equal(pnlTtl(200_000), 3 * DAY);
  assert.equal(pnlTtl(5_000), 7 * DAY);
});

test('cohort_pnl keeps the last read per venue and wallet, nulls included', () => {
  const s = new IndexStore(':memory:');
  s.putCohortPnl('hyperliquid', [
    { address: '0xa', pnl: 1_500, pnl1d: -20, pnl7d: 100, pnl30d: null },
    { address: '0xb', pnl: null, pnl1d: null, pnl7d: null, pnl30d: null },
  ], 1_000);
  s.putCohortPnl('hyperliquid', [{ address: '0xa', pnl: -300, pnl1d: 5, pnl7d: 6, pnl30d: 7 }], 2_000);
  s.putCohortPnl('sodex', [{ address: '0xa', pnl: 9, pnl1d: null, pnl7d: null, pnl30d: null }], 3_000);
  const hl = s.cohortPnl('hyperliquid');
  assert.deepEqual(hl.get('0xa'), { address: '0xa', pnl: -300, pnl1d: 5, pnl7d: 6, pnl30d: 7, at: 2_000 });
  assert.deepEqual(hl.get('0xb'), { address: '0xb', pnl: null, pnl1d: null, pnl7d: null, pnl30d: null, at: 1_000 }, 'a wallet with no chart is remembered, so it is not asked again at once');
  assert.equal(s.cohortPnl('sodex').get('0xa')!.pnl, 9);
});

test('spot prices: the pairs quoted in USDC, by token name; a unified book valued before the token rule is read again once', async () => {
  const { spotPrices } = await import('../src/indexer/cohortSource.js');
  const { spotDue, SPOT_VALUE_SINCE } = await import('../src/indexer/cohortTracker.js');
  const px = spotPrices([
    { tokens: [{ name: 'USDC', index: 0 }, { name: 'PURR', index: 1 }, { name: 'HYPE', index: 150 }, { name: 'USDT0', index: 268 }],
      universe: [{ tokens: [1, 0], index: 0 }, { tokens: [150, 0], index: 107 }, { tokens: [150, 268], index: 200 }] },
    Object.assign([], { 0: { markPx: '0.2' }, 107: { markPx: '40.5' }, 200: { markPx: '41' } }),
  ]);
  assert.deepEqual([...px], [['PURR', 0.2], ['HYPE', 40.5]], 'USDC pairs only');
  assert.equal(spotPrices(null).size, 0);

  const before = SPOT_VALUE_SINCE - 1;
  const pos = { size: 2 };
  assert.equal(spotDue({ spotAt: before, collateral: 5e6, equity: 1e6, pos }, null), true, 'unified, valued by the old rule');
  assert.equal(spotDue({ spotAt: SPOT_VALUE_SINCE + 1, collateral: 5e6, equity: 1e6, pos }, null), false, 'valued by the new one');
  assert.equal(spotDue({ spotAt: before, collateral: null, equity: 1e6, pos }, null), false, 'a standard account: nothing to revalue');
  assert.equal(spotDue({ spotAt: null, collateral: null, equity: 159e6, pos: { size: 17 } }, 252.9e6), true, 'never looked, the leaderboard sees far more');
});

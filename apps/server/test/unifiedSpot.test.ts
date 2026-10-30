/**
 * Run: npx tsx --test test/unifiedSpot.test.ts   (from apps/server)
 *
 * Unified / portfolio-margin Hyperliquid accounts were sized by their perps account value -
 * only the margin in use - whenever the spot state was not read (off the leaderboard) or was
 * read once and kept. Audit 2026-10-30, live reads of three accounts (fixtures below):
 *
 *   0x591e...9657  ours $952K (large)   Hyperliquid $5.75M spot (apex)    never read: off the leaderboard
 *   0xcb84...52cd  ours $951K (large)   Hyperliquid $2.28M spot (whale)   never read: off the leaderboard
 *   0xb8e4...a206  ours $96K  (medium)  Hyperliquid $111K spot (large)    read once, kept since
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsSpot, readNotional, spotDue } from '../src/indexer/cohortTracker.js';
import { spotCollateral } from '../src/indexer/cohortSource.js';
import { perpEquity, sizeCohort } from '../src/valuedesk/cohorts/model.js';

// Spot prices at the reads (spotMetaAndAssetCtxs, USDC pairs).
const PX = new Map([['HYPE', 91.0], ['PURR', 0.12221]]);

const A591E = {
  perps: 940_915.77, notional: 9_559_423, positions: 1,
  spot: {
    balances: [{ coin: 'USDC', token: 0, total: '-3799723.9440839798' }, { coin: 'HYPE', token: 150, total: '105000.0792461' }, { coin: 'USDT0', token: 268, total: '0.0' }],
    tokenToAvailableAfterMaintenance: [[0, '3608234.0929499902'], [150, '48043.14826393'], [197, '0.0'], [268, '685304.32624969'], [360, '0.0']] as Array<[number, string]>,
  },
};
const ACB84 = {
  perps: 893_288.41, notional: 6_362_599, positions: 24,
  spot: { balances: [{ coin: 'USDC', token: 0, total: '2308558.0613389998' }], tokenToAvailableAfterMaintenance: [[0, '1803992.8371250001']] as Array<[number, string]> },
};
const AB8E4 = {
  perps: 19_250.55, notional: 28_581, positions: 1, kept: 96_459,
  spot: {
    balances: [{ coin: 'USDC', token: 0, total: '61295.34604488' }, { coin: 'PURR', token: 1, total: '404946.39772' }],
    tokenToAvailableAfterMaintenance: [[0, '56531.88604488']] as Array<[number, string]>,
  },
};

const sized = (collateral: number | null, perps: number) => sizeCohort(perpEquity('hyperliquid', { equity: perps, collateral }, { equity: 0 })!);

test('off the leaderboard: the read looks at the spot state, and the account is sized by it', () => {
  for (const [name, a, want] of [['0x591e', A591E, 'apex'], ['0xcb84', ACB84, 'whale']] as const) {
    assert.equal(sized(null, a.perps), 'large', `${name}: sized by its perps value alone (the bug)`);
    assert.equal(needsSpot(null, a.perps, a.positions, { notional: a.notional }), true, `${name}: off the leaderboard, its read must look`);
    assert.equal(spotDue({ spotAt: null, collateral: null, equity: a.perps, pos: { size: a.positions } }, null, a.notional), true, `${name}: due a look ahead of its schedule`);
    const c = spotCollateral(a.spot, PX);
    assert.equal(sized(c, a.perps), want, `${name}: ${c} of spot`);
  }
  assert.ok(Math.abs(spotCollateral(A591E.spot, PX)! - 5_755_284) < 1_000);
});

test('a book found unified looks again at every read: its collateral follows the schedule, not the first read', () => {
  // On the leaderboard with a total equal to its perps value, notional within 5x: the old rule read nothing.
  assert.equal(needsSpot(AB8E4.kept, AB8E4.kept, 1, { notional: AB8E4.notional }), false, 'nothing else makes it uncertain');
  assert.equal(needsSpot(AB8E4.kept, AB8E4.kept, 1, { notional: AB8E4.notional, unified: true }), true, 'unified: every read looks');
  assert.equal(sized(AB8E4.kept, AB8E4.perps), 'medium', 'the value kept from the first read');
  assert.equal(sized(spotCollateral(AB8E4.spot, PX), AB8E4.perps), 'large', 'the value now');
});

test('notional far above the perps value is uncertain too; a leaderboard account within 10% and under 5x is not', () => {
  assert.equal(needsSpot(1_000_000, 1_000_000, 2, { notional: 5_500_000 }), true);
  assert.equal(needsSpot(1_050_000, 1_000_000, 2, { notional: 3_000_000 }), false);
  assert.equal(needsSpot(null, 0, 0), false, 'no positions: nothing to size');
  assert.equal(readNotional({ positions: [{ symbol: 'BTC', szi: -2, entry: 70_000 }, { symbol: 'ETH', szi: 10, entry: 2_000 }], marks: [['BTC', 77_000]] }), 2 * 77_000 + 10 * 2_000);
});

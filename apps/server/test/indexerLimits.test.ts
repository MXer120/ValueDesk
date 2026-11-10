/**
 * The indexer's SoDEX `/trades` drip against the measured history rule
 * (docs/ARCH-traffic.md §2): `/trades` and `/orders/history` share one
 * Cloudflare counter of ~4 requests per ~60 s per IP, so the drip may never
 * exceed 2 per 60 s, however it is configured.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INDEXER_ENV, SODEX_HISTORY_PAIR_PER_MIN } from '../src/indexer/engine.js';
import { Lane } from '../src/indexer/lanes.js';

const KEY = 'VALUESCAN_INDEX_SODEX_TRADES';

test('the /trades drip is off by default and never configurable above 2 per minute', () => {
  const saved = process.env[KEY];
  try {
    assert.equal(SODEX_HISTORY_PAIR_PER_MIN, 2);
    delete process.env[KEY];
    assert.equal(INDEXER_ENV.sodexTradesEnabled(), false);
    assert.equal(INDEXER_ENV.sodexTradesPerMin(), 0.05);
    for (const [v, want] of [['6', 2], ['100', 2], ['2', 2], ['1', 1], ['0.5', 0.5], ['0.01', 0.05]] as const) {
      process.env[KEY] = v;
      assert.equal(INDEXER_ENV.sodexTradesEnabled(), true, v);
      assert.equal(INDEXER_ENV.sodexTradesPerMin(), want, v);
    }
  } finally {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  }
});

test('the Copy leaders\' drip: 0.5 a minute by default, only what the trade checks leave of 2, off at 0', () => {
  const keys = ['VALUESCAN_INDEX_SODEX_LEADER_TRADES', 'VALUESCAN_INDEX_SODEX_CHECKS', KEY, 'VALUESCAN_WALLET_BACKFILL'] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    assert.equal(INDEXER_ENV.sodexLeaderTradesPerMin(), 0.5);
    assert.ok(INDEXER_ENV.sodexChecksPerMin() + INDEXER_ENV.sodexLeaderTradesPerMin() <= SODEX_HISTORY_PAIR_PER_MIN);
    process.env.VALUESCAN_INDEX_SODEX_LEADER_TRADES = '5';
    assert.equal(INDEXER_ENV.sodexLeaderTradesPerMin(), 1, 'capped at what the checks (1) leave');
    process.env.VALUESCAN_INDEX_SODEX_CHECKS = '2';
    assert.equal(INDEXER_ENV.sodexLeaderTradesPerMin(), 0, 'nothing left');
    delete process.env.VALUESCAN_INDEX_SODEX_CHECKS;
    process.env.VALUESCAN_INDEX_SODEX_LEADER_TRADES = '0';
    assert.equal(INDEXER_ENV.sodexLeaderTradesPerMin(), 0);
    // The wallet backfill gets only what checks and leaders leave.
    process.env.VALUESCAN_INDEX_SODEX_LEADER_TRADES = '0.5';
    process.env.VALUESCAN_WALLET_BACKFILL = '2';
    assert.equal(INDEXER_ENV.sodexChecksPerMin() + INDEXER_ENV.sodexLeaderTradesPerMin() + INDEXER_ENV.walletBackfillPerMin(), SODEX_HISTORY_PAIR_PER_MIN);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test('at the cap, a one-page task is followed by 30 s of rest: 2 requests per 60 s', async () => {
  const saved = process.env[KEY];
  process.env[KEY] = '999';
  const rests: number[] = [];
  let pages = 0;
  const lane = new Lane({
    name: 'strades',
    perMin: INDEXER_ENV.sodexTradesPerMin(),
    sleep: (ms) => {
      rests.push(ms);
      return new Promise((r) => setImmediate(r));
    },
  });
  try {
    for (let i = 0; i < 3; i++) {
      lane.add({
        key: `h:perps:0x${i}`,
        prio: 1,
        run: async () => {
          pages++;
          return 1; // one /trades page, as syncTrades(maxPages: 1) reports it
        },
      });
    }
    lane.start();
    while (pages < 3) await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    // After each one-page task the lane rests (1 / 2) minutes.
    assert.deepEqual(rests.filter((ms) => ms !== 1_000).slice(0, 3), [30_000, 30_000, 30_000]);
  } finally {
    lane.stop();
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  }
});

/**
 * Lighter's tail (wallets under TAIL_EQUITY) is read in full since 2026-10-31, and counted as its old
 * 10% sample until 99% of it holds a book (cohortTracker.ts tailCountRate): counting every wallet at
 * once would show it at a tenth of the truth while the reads go on.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TAIL_FULL_SHARE, TAIL_RATE, tailCountRate, tailOf } from '../src/indexer/cohortTracker.js';
import { TAIL_EQUITY, sampleRule } from '../src/valuedesk/cohorts/model.js';

test('every venue reads its whole tail; Lighter counts its old sample until 99% of the tail has a book', () => {
  for (const v of ['hyperliquid', 'tradexyz', 'sodex', 'arcus', 'lighter'] as const) assert.equal(TAIL_RATE[v], 1, `${v} reads every wallet`);
  assert.equal(tailCountRate('lighter', { members: 1000, read: 100 }), 0.1, 'a tenth read: the sample, each standing for ten');
  assert.equal(tailCountRate('lighter', { members: 1000, read: 989 }), 0.1, 'just under 99%: still the sample');
  assert.equal(tailCountRate('lighter', { members: 1000, read: Math.ceil(1000 * TAIL_FULL_SHARE) }), 1, 'at 99%: every wallet counts once');
  assert.equal(tailCountRate('lighter', { members: 0, read: 0 }), 0.1, 'no tail known yet: the sample');
  assert.equal(tailCountRate('hyperliquid', { members: 1000, read: 10 }), 1, 'a venue never sampled counts everything');
});

test('the tail is the members under TAIL_EQUITY; read = those with a book', () => {
  const members = new Map<string, { equity: number | null }>([
    ['0xa', { equity: 5 }], ['0xb', { equity: TAIL_EQUITY - 1 }], ['0xc', { equity: TAIL_EQUITY }], ['0xd', { equity: null }],
  ]);
  assert.deepEqual(tailOf(members, (a) => a === '0xb' || a === '0xc'), { members: 3, read: 1 });
});

test('the sample counted meanwhile is the one read before: 10% of tail wallets, each weighted 10', () => {
  let counted = 0;
  for (let i = 0; i < 20_000; i++) {
    const r = sampleRule(0.1, `0x${i.toString(16).padStart(40, '0')}`, 50);
    if (r.counts) { counted++; assert.equal(r.weight, 10); }
  }
  assert.ok(counted > 1_700 && counted < 2_300, `about a tenth counts (${counted} of 20000)`);
});

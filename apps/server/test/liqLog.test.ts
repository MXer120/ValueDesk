/**
 * Run: npx tsx --test test/liqLog.test.ts   (from apps/server)
 *
 * The level change log (store liq_log / liq_cur): written as steps change, read back as the
 * history's wallet filter (liqRead.ts liqHistory with wallets), pruned without losing a state.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'vs-liqlog-'));
process.env.VALUESCAN_INDEX_DB = join(dir, 'index.db');
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle */ } });

const A = `0x${'a'.repeat(40)}`;
const B = `0x${'b'.repeat(40)}`;
const Q = 15 * 60_000;
const HL = 1; // VENUES.indexOf('hyperliquid')

test('a wallet history is rebuilt from the change log at each step the history kept; others stay out', async () => {
  const { IndexStore } = await import('../src/indexer/store.js');
  const { liqHistory } = await import('../src/indexer/liqRead.js');
  const { VENUES } = await import('../src/valuedesk/types.js');
  assert.equal(VENUES.indexOf('hyperliquid'), HL);
  const s = new IndexStore(process.env.VALUESCAN_INDEX_DB!);
  const t0 = Math.floor((Date.now() - 2 * 60 * 60_000) / Q) * Q;
  const snap = (p: number) => JSON.stringify({ p, st: 200, v: {} });
  for (let i = 0; i < 4; i++) s.putLiqHist(t0 + i * Q, [['BTC', snap(80_000)]]);
  // Step 0: A opens a long (liq 70,100) and B a short; step 1: A's level moves; step 2: nothing; step 3: A closes.
  const ids = s.putLiqLog(t0, [A, B], [
    { aid: A, coin: 'BTC', venue: HL, side: 1, liq: 70_100, usd: 1_000_000 },
    { aid: B, coin: 'BTC', venue: HL, side: -1, liq: 90_000, usd: 500_000 },
  ], []);
  const a = ids.get(A)!;
  s.putLiqLog(t0 + Q, [], [{ aid: a, coin: 'BTC', venue: HL, side: 1, liq: 69_100, usd: 990_000 }], []);
  s.putLiqLog(t0 + 3 * Q, [], [], [{ aid: a, coin: 'BTC', venue: HL }]);
  assert.deepEqual(s.liqCur().map((r) => r.aid), [ids.get(B)], 'A left the current state when it closed');

  const h = liqHistory('BTC', ['hyperliquid'], '1d', [A])!;
  assert.deepEqual(h.points.map((p) => [p.t - t0, p.b]), [
    [0, [[350, 1_000_000, 0]]], // 70,100 / 200 = bucket 350
    [Q, [[345, 990_000, 0]]],
    [2 * Q, [[345, 990_000, 0]]], // unchanged: the last row stands
  ], 'closed at step 3: no point');
  assert.equal(liqHistory('BTC', ['lighter'], '1d', [A])!.points.length, 0, 'another venue: none');
  assert.equal(liqHistory('BTC', ['hyperliquid'], '1d', [`0x${'c'.repeat(40)}`])!.points.length, 0, 'a wallet never logged');
});

test('pruning keeps each position\'s state at the cut, drops what a later row replaced and old closes', async () => {
  const { IndexStore } = await import('../src/indexer/store.js');
  const s = new IndexStore(join(dir, 'prune.db'));
  const ids = s.putLiqLog(1_000, [A], [{ aid: A, coin: 'ETH', venue: HL, side: 1, liq: 2_000, usd: 10 }], []);
  const a = ids.get(A)!;
  s.putLiqLog(2_000, [], [{ aid: a, coin: 'ETH', venue: HL, side: 1, liq: 1_900, usd: 10 }], []);
  s.putLiqLog(5_000, [], [{ aid: a, coin: 'ETH', venue: HL, side: 1, liq: 1_800, usd: 10 }], []);
  s.pruneLiqLog(3_000);
  assert.deepEqual(s.liqLog([a], 'ETH', 3_000).map((r) => [r.t, r.liq]), [[2_000, 1_900], [5_000, 1_800]], 'the 2,000 row is the state at the cut');
  s.putLiqLog(6_000, [], [], [{ aid: a, coin: 'ETH', venue: HL }]);
  s.pruneLiqLog(7_000);
  assert.deepEqual(s.liqLog([a], 'ETH', 0), [], 'closed before the cut: gone');
});

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

test('one cell at a past time: who sat there by the row then, with size, entry, margin, since when and what came next', async () => {
  const { IndexStore } = await import('../src/indexer/store.js');
  const { liqAt } = await import('../src/indexer/liqRead.js');
  const s = new IndexStore(process.env.VALUESCAN_INDEX_DB!);
  const t0 = Math.floor((Date.now() - 6 * 60 * 60_000) / Q) * Q;
  const C = `0x${'c'.repeat(40)}`;
  const D = `0x${'d'.repeat(40)}`;
  for (let i = 0; i < 8; i++) s.putLiqHist(t0 + i * Q, [['ETH', JSON.stringify({ p: 3_000, st: 10, v: {} })]]);
  // C: a long at 2,505 (cell 2,500-2,510) from step 0, moves out of the cell at step 4, closes at step 6.
  // D: a short at 3,500 - another side and cell; and a long at 2,508 that opened only at step 3.
  const ids = s.putLiqLog(t0, [C, D], [
    { aid: C, coin: 'ETH', venue: HL, side: 1, liq: 2_505, usd: 50_000, sym: 'ETH', sz: 20, entry: 2_900, mark: 3_000, iso: false, lev: 10, eq: 9_000, cash: 1_200, readAt: t0 - 60_000 },
    { aid: D, coin: 'ETH', venue: HL, side: -1, liq: 3_500, usd: 70_000 },
  ], []);
  const c = ids.get(C)!;
  const d = ids.get(D)!;
  s.putLiqLog(t0 + 3 * Q, [], [{ aid: d, coin: 'ETH', venue: 0, side: 1, liq: 2_508, usd: 8_000 }], []);
  s.putLiqLog(t0 + 4 * Q, [], [{ aid: c, coin: 'ETH', venue: HL, side: 1, liq: 2_450, usd: 49_000 }], []);
  s.putLiqLog(t0 + 6 * Q, [], [], [{ aid: c, coin: 'ETH', venue: HL, mark: 2_455 }]);

  const at2 = liqAt('ETH', ['hyperliquid'], t0 + 2 * Q + 60_000, 2_500, 2_510, 'both')!;
  assert.equal(at2.price, 3_000, 'the snapshot then');
  assert.equal(at2.count, 1);
  const p = at2.positions[0]!;
  assert.equal(p.address, C);
  assert.deepEqual([p.side, p.liq, p.usd, p.sym, p.sz, p.entry, p.mark, p.iso, p.lev, p.eq, p.cash], ['long', 2_505, 50_000, 'ETH', 20, 2_900, 3_000, false, 10, 9_000, 1_200]);
  assert.equal(p.since, t0);
  assert.deepEqual(p.next, { t: t0 + 4 * Q, kind: 'changed', liq: 2_450, usd: 49_000, mark: null, nearLevel: null }, 'next: it moved out of the cell');
  assert.ok(Math.abs(p.dist! - (2_505 / 3_000 - 1)) < 1e-12);

  const both = liqAt('ETH', ['sodex', 'hyperliquid'], t0 + 3 * Q, 2_500, 2_510, 'both')!;
  assert.deepEqual(both.positions.map((x) => x.address).sort(), [C, D].sort(), 'D opened in the cell on SoDEX at step 3');
  assert.equal(liqAt('ETH', ['hyperliquid'], t0 + 3 * Q, 2_500, 2_510, 'both')!.count, 1, 'venues filter');
  assert.equal(liqAt('ETH', ['sodex', 'hyperliquid'], t0 + 3 * Q, 2_500, 2_510, 'short')!.count, 0, 'side filter');
  assert.equal(liqAt('ETH', ['hyperliquid'], t0 + 5 * Q, 2_500, 2_510, 'both')!.count, 0, 'after it left the cell');
  const later = liqAt('ETH', ['hyperliquid'], t0 + 5 * Q, 2_440, 2_460, 'both')!;
  assert.deepEqual(later.positions[0]!.next, { t: t0 + 6 * Q, kind: 'closed', liq: null, usd: 0, mark: 2_455, nearLevel: true }, 'closed within 1% of its level');
  assert.equal(liqAt('ETH', ['hyperliquid'], t0 + 7 * Q, 2_440, 2_460, 'both')!.count, 0, 'closed');
  assert.equal(liqAt('ETH', ['hyperliquid'], t0 + 2 * Q, 2_500, 2_510, 'both', [D])!.count, 0, 'wallet filter');
});

test('the wallet history from the steps the index holds equals the one read from the snapshots, reading none; a cell at a past time reads one', async () => {
  const { IndexStore } = await import('../src/indexer/store.js');
  const { liqAt, liqHistory } = await import('../src/indexer/liqRead.js');
  const s = new IndexStore(process.env.VALUESCAN_INDEX_DB!);
  const W1 = `0x${'e'.repeat(40)}`;
  const t0 = Math.floor((Date.now() - 5 * 60 * 60_000) / Q) * Q;
  const points = Array.from({ length: 12 }, (_, i) => ({ t: t0 + i * Q, p: 500 + i, st: 2 }));
  for (const q of points) s.putLiqHist(q.t, [['LOGC', JSON.stringify({ p: q.p, st: q.st, v: {} })]]);
  const ids = s.putLiqLog(t0, [W1], [{ aid: W1, coin: 'LOGC', venue: HL, side: 1, liq: 440, usd: 9_000 }], []);
  s.putLiqLog(t0 + 3 * Q, [], [{ aid: ids.get(W1)!, coin: 'LOGC', venue: HL, side: 1, liq: 430, usd: 8_000 }], []);
  const read = liqHistory('LOGC', ['hyperliquid'], '1d', [W1])!;
  const parse = JSON.parse;
  let parsed = 0;
  JSON.parse = ((text: string, rev?: Parameters<typeof JSON.parse>[1]) => { parsed++; return parse(text, rev); }) as typeof JSON.parse;
  let known;
  let at;
  try {
    known = liqHistory('LOGC', ['hyperliquid'], '1d', [W1], { points, coins: read.coins })!;
    assert.equal(parsed, 0, 'no snapshot read');
    at = liqAt('LOGC', ['hyperliquid'], t0 + 5 * Q + 1, 400, 500, 'both')!;
  } finally {
    JSON.parse = parse;
  }
  assert.deepEqual(known.points, read.points);
  assert.equal(parsed, 1, 'one snapshot read for the cell, though newer ones exist');
  assert.equal(at.snapT, t0 + 5 * Q);
  assert.equal(at.price, 505);
  assert.equal(at.count, 1);
  // A bad row: the one before it stands.
  s.putLiqHist(t0 + 5 * Q, [['LOGC', 'not json']]);
  const bad = liqAt('LOGC', ['hyperliquid'], t0 + 5 * Q + 1, 400, 500, 'both')!;
  assert.equal(bad.snapT, t0 + 4 * Q);
  s.close();
});

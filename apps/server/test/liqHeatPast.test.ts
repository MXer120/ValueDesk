/**
 * Run: npx tsx --test test/liqHeatPast.test.ts   (from apps/server)
 *
 * The live engine (valuedesk/liquidations/live.ts) leaves "past" to the reader: its coverage has
 * no past figure, and a long priced at or above the price (a short at or below) stays in its
 * buckets. heatOf (indexer/liqRead.ts) is that reader: the coverage it answers must say how much
 * size the price has crossed, as the minute rows (LevelsBuilder) do - the web draws none of it
 * and its coverage line is the only place it is told (audit 2026-10-30: BTC on Hyperliquid had
 * $29.7M of longs priced above the price and $4.5M of shorts below it, coverage.past 0).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'vs-liqpast-'));
process.env.VALUESCAN_INDEX_DB = join(dir, 'index.db');
process.env.VALUESCAN_LIQ_FEED = '0';
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle */ } });

test('live source: size the price has crossed is counted as past in the coverage', async () => {
  const { heatOf } = await import('../src/indexer/liqRead.js');
  const st = 10;
  const p = 1_000;
  // Live rows: [index, long USD, short USD, long n, short n]; coverage has no past (5 entries).
  const b: Array<[number, number, number, number, number]> = [
    [90, 905 * 2, 0, 1, 0], //   long at ~905 (2 coins): a level
    [101, 1015 * 3, 0, 1, 0], // long at ~1015 (3 coins): the price is below it - past
    [110, 0, 1105 * 4, 0, 1], // short at ~1105 (4 coins): a level
    [95, 0, 955 * 5, 0, 1], //   short at ~955 (5 coins): the price is above it - past
  ];
  const h = heatOf('BTC', ['hyperliquid'], { at: 1, p, st, v: () => ({ b, c: [5, 9, 5, 9, 4], o: [0, 0, 0, 0] }) }, new Map());
  const c = h.coverage.hyperliquid!;
  assert.ok(Math.abs(c.past - 8) < 1e-9, `past ${c.past}, want 3 + 5 coins`);
});

test('minute rows keep their own past figure', async () => {
  const { heatOf } = await import('../src/indexer/liqRead.js');
  const h = heatOf('BTC', ['hyperliquid'], { at: 1, p: 1_000, st: 10, v: () => ({ b: [[90, 1810, 0, 1, 0]], c: [2, 0, 2, 0, 1, 0.5], o: [0, 0, 0, 0] }) }, new Map());
  assert.equal(h.coverage.hyperliquid!.past, 0.5);
});

test('liq_now rows from the live engine (past written as 0) are counted the same way', async () => {
  const { heatOf } = await import('../src/indexer/liqRead.js');
  const h = heatOf('BTC', ['hyperliquid'], { at: 1, p: 1_000, st: 10, v: () => ({ b: [[101, 1015 * 3, 0, 1, 0]], c: [3, 0, 3, 0, 1, 0], o: [0, 0, 0, 0] }) }, new Map());
  assert.ok(Math.abs(h.coverage.hyperliquid!.past - 3) < 1e-9);
});

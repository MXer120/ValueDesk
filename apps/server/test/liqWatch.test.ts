/**
 * Run: npx tsx --test test/liqWatch.test.ts   (from apps/server)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'vs-watch-'));
process.env.VALUESCAN_INDEX_DB = join(dir, 'index.db');
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle */ } });

test('wallets looked up are kept for the history, lower-cased, until not asked for in 30 days; junk is left out', async () => {
  const { noteWatched, watchedWallets, WATCH_TTL_MS } = await import('../src/indexer/liqWatch.js');
  const A = `0x${'a'.repeat(40)}`;
  const B = `0x${'B'.repeat(40)}`;
  noteWatched([A, B, 'not an address'], 1_000);
  assert.deepEqual([...watchedWallets(2_000)].sort(), [A, B.toLowerCase()]);
  noteWatched([A], 1_000 + WATCH_TTL_MS + 10 * 60 * 60_000);
  assert.deepEqual([...watchedWallets(1_000 + WATCH_TTL_MS + 10 * 60 * 60_000)], [A], 'B was not asked for again');
});

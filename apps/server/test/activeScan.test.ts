/**
 * The window's active accounts read on the index reader's thread (activeScan.ts, 2026-11-08: the GROUP BY held the
 * indexer 33-74 s): the same answer as the inline read, and none of it on this thread.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'vs-activescan-'));
process.env.VALUESCAN_INDEX_DB = join(dir, 'index.db');
after(() => rmSync(dir, { recursive: true, force: true }));

test('active accounts come from the reader thread, equal to the inline read', async () => {
  const { IndexStore } = await import('../src/indexer/store.js');
  const { activeAccountsAsync } = await import('../src/indexer/activeScan.js');
  const R = await import('../src/indexer/liqReadThread.js');
  const store = new IndexStore(process.env.VALUESCAN_INDEX_DB!);
  const kept = IndexStore.prototype.activeAccounts;
  try {
    const hour = 490_000;
    store.addActivity([
      { venue: 'tradexyz', acct: '0xa', hour, trades: 3, volume: 900 },
      { venue: 'tradexyz', acct: '0xb', hour: hour + 1, trades: 1, volume: 5_000 },
      { venue: 'tradexyz', acct: '0xa', hour: hour + 2, trades: 2, volume: 100 },
      { venue: 'arcus', acct: '0xc', hour, trades: 9, volume: 1 },
    ]);
    const inline = store.activeAccounts('tradexyz', { hour }, 1, 10);
    assert.deepEqual(inline.map((a) => a.acct), ['0xb', '0xa']);
    process.env.VALUESCAN_LIQ_THREAD = '1';
    (IndexStore.prototype as unknown as Record<string, unknown>).activeAccounts = () => { throw new Error('activeAccounts ran on this thread'); };
    const off = await activeAccountsAsync(store, 'tradexyz', { hour }, 1, 10);
    assert.deepEqual(off.map((a) => ({ ...a })), inline.map((a) => ({ ...a })));
  } finally {
    IndexStore.prototype.activeAccounts = kept;
    delete process.env.VALUESCAN_LIQ_THREAD;
    await R.stopLiqReadThread();
    store.close();
  }
});

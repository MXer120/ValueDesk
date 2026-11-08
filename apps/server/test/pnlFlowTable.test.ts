/**
 * The cohort tracker's PnL flows in their own table (2026-11-08): only changed rows written, ended flows removed,
 * read back as saved.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'vs-pnlflow-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('flows are upserted row by row and ended flows leave the table', async () => {
  const { IndexStore } = await import('../src/indexer/store.js');
  const store = new IndexStore(join(dir, 'index.db'));
  try {
    assert.deepEqual(store.pnlFlowRows(), []);
    store.putPnlFlows([['0xa', 1.5, 10], ['0xb', -2, 0], ['0xc', 0, 3.25]]);
    store.putPnlFlows([['0xa', 4.25, 10]], ['0xb']);
    store.putPnlFlows([], []);
    const rows = new Map(store.pnlFlowRows().map((r) => [r.address, [r.flow, r.u0]]));
    assert.deepEqual(rows, new Map([['0xa', [4.25, 10]], ['0xc', [0, 3.25]]]));
  } finally {
    store.close();
  }
});

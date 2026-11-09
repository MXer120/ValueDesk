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

test('sliced cohort writes put every row and the newest time, in several transactions with pauses between', async () => {
  const { IndexStore } = await import('../src/indexer/store.js');
  const store = new IndexStore(join(dir, 'sliced.db'));
  try {
    const series = Array.from({ length: 1_234 }, (_, i) => ({ scope: 'all', cohort: `c${i % 40}`, t: 900 * (1 + Math.floor(i / 40)), long: i, short: -i }));
    const mix = Array.from({ length: 123 }, (_, i) => ({ scope: 'all', cohort: `c${i}`, t: 3_600 * (1 + (i % 7)), data: `{"i":${i}}` }));
    let pauses = 0;
    const pause = async () => { pauses++; };
    await store.putCohortSeriesSliced(series, pause);
    await store.putCohortMixSliced(mix, pause);
    assert.ok(pauses >= 4, `paused ${pauses} times`);
    assert.equal(store.cohortSeries('all', 0).length, series.length);
    assert.equal(store.cohortSeriesLastT(), Math.max(...series.map((r) => r.t)));
    assert.equal(store.cohortMixLastT(), Math.max(...mix.map((r) => r.t)));
  } finally {
    store.close();
  }
});

test('the newest cohort series and mix time is kept by the writes, not scanned', async () => {
  const { IndexStore } = await import('../src/indexer/store.js');
  const store = new IndexStore(join(dir, 'lastT.db'));
  try {
    assert.equal(store.cohortSeriesLastT(), 0);
    assert.equal(store.cohortMixLastT(), 0);
    store.putCohortSeries([{ scope: 'all', cohort: 'a', t: 300, long: 1, short: 2 }, { scope: 'all', cohort: 'b', t: 500, long: 1, short: 2 }]);
    store.putCohortSeries([{ scope: 'all', cohort: 'a', t: 100, long: 1, short: 2, rebuilt: true }]);
    store.putCohortMix([{ scope: 'all', cohort: 'a', t: 7_200, data: '{}' }]);
    assert.equal(store.cohortSeriesLastT(), 500);
    assert.equal(store.cohortMixLastT(), 7_200);
    assert.equal(store.getMeta('cohort_series_last_t'), '500');
  } finally {
    store.close();
  }
});

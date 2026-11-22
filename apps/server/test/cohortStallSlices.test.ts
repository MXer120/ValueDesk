/**
 * The cohort pass's whole-venue reads and writes in slices (2026-11-22: one transaction of every dirty book held the
 * indexer 6-23 s, whole-table reads up to 12 s, several times an hour; the status page called the indexer degraded).
 * Pages read in address order cover every row once; the books' prints-through mark goes in with their last batch.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IndexStore } from '../src/indexer/store.js';

const dir = mkdtempSync(join(tmpdir(), 'vs-cohort-slices-'));
const store = new IndexStore(join(dir, 'index.db'));
after(() => { store.close?.(); rmSync(dir, { recursive: true, force: true }); });

const addr = (i: number) => `0x${String(i).padStart(40, '0')}`;

test('pnlAllPage and accountValuesPage read every row once, in address order, a page at a time', () => {
  const n = 1_234;
  store.putPnl('sodex', 'all', Array.from({ length: n }, (_, i) => ({ address: addr(i), pnl: i, volume: null })), 1, Date.now());
  for (let i = 0; i < n; i++) store.setAccountValue('sodex', addr(i), i % 7 === 0 ? null : i * 2, Date.now());
  const read = (page: (after: string, limit: number) => Array<[string, number]>) => {
    const out: Array<[string, number]> = [];
    for (let after = '', p: Array<[string, number]>; (p = page(after, 100)).length; after = p[p.length - 1]![0]) out.push(...p);
    return out;
  };
  const pnl = read((a, l) => store.pnlAllPage('sodex', a, l));
  assert.deepEqual(pnl, [...store.pnlAll('sodex')].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  assert.equal(pnl.length, n);
  const av = read((a, l) => store.accountValuesPage('sodex', a, l));
  assert.deepEqual(new Map(av), store.accountValues('sodex'));
  assert.equal(av.length, n - Math.ceil(n / 7), 'no row without an account value');
});

test('putCohortBooks sets the meta key in the same transaction as the rows', () => {
  const book = (i: number) => ({ venue: 'sodex' as const, address: addr(i), equity: i, positions: [], at: 1, collateral: null, spotAt: null, cash: null });
  store.putCohortBooks([book(1), book(2)]);
  assert.equal(store.getMeta('cohort_prints_through_test'), null, 'no meta without one given');
  store.putCohortBooks([book(3)], ['cohort_prints_through_test', '{"sodex":5}']);
  assert.equal(store.getMeta('cohort_prints_through_test'), '{"sodex":5}');
  assert.equal(store.cohortBooks('sodex').size, 3);
});

/**
 * The stream's fine window as the widget holds it: whole on "fs", moved by "fd" (cells with no
 * positions go).
 *   npx tsx --test src/components/liqmap/liveHeat.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeFine, type LiveFine } from './liveHeat';

test('a fine delta moves the cells it names and leaves the rest', () => {
  const f: LiveFine = { coin: 'BTC', at: 1, p: 78_000, st: 10, base: 1, k: 10, from: 77_000, to: 79_000, buckets: [[7_700, 500, 0, 1, 0], [7_750, 0, 0, 0, 0], [7_810, 0, 900, 0, 2]] as never };
  const g = mergeFine(f, { at: 2, p: 78_010, b: [[7_700, 0, 0, 0, 0], [7_760, 300, 0, 1, 0], [7_810, 0, 1_000, 0, 3]] as never });
  assert.deepEqual(g.buckets.map((r) => r[0]), [7_750, 7_760, 7_810]);
  assert.equal(g.buckets.find((r) => r[0] === 7_810)![2], 1_000);
  assert.equal(g.at, 2);
  assert.equal(g.p, 78_010);
  assert.equal(g.from, 77_000, 'the window stays');
  assert.equal(f.buckets.length, 3, 'the held one is not changed');
});

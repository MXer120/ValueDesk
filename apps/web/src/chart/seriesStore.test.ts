/**
 * Kept series across a reload (seriesStore.ts): a lossless packed layout, a schema that ignores
 * old records, and no IndexedDB meaning no copy, never an error.
 *   npx tsx --test src/chart/seriesStore.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { KLineData } from 'klinecharts';
import { SERIES_SCHEMA, STORED_SERIES, SeriesStore, fromRecord, packBars, toRecord, unpackBars } from './seriesStore';
import type { KeptSeries } from './seriesCache';

const bar = (t: number, extra: Partial<KLineData> = {}): KLineData => ({ timestamp: t, open: 84_123.5, high: 84_200.25, low: 84_001.125, close: 84_150, volume: 12.34567, turnover: 1_038_925.5, ...extra });

test('store: bars round-trip exactly, a missing volume stays missing', () => {
  const list = [bar(60_000), bar(120_000, { volume: undefined, turnover: undefined }), bar(180_000, { close: 0.000_012_345_678 })];
  const back = unpackBars(packBars(list));
  assert.deepEqual(back, [list[0], { timestamp: 120_000, open: 84_123.5, high: 84_200.25, low: 84_001.125, close: 84_150 }, list[2]]);
});

test('store: a record of another schema, or a broken one, reads as nothing', () => {
  const s: KeptSeries = { key: 'perps|BTC-USD|1m', at: 5, more: true, unverifiedFrom: 120_000, bars: [bar(60_000), bar(120_000)] };
  const rec = toRecord([s]);
  assert.equal(rec.schema, SERIES_SCHEMA);
  assert.deepEqual(fromRecord(rec), [s]);
  assert.deepEqual(fromRecord({ ...rec, schema: SERIES_SCHEMA + 1 }), []);
  assert.deepEqual(fromRecord(null), []);
  assert.deepEqual(fromRecord({ schema: SERIES_SCHEMA, series: [{ key: 'x', at: 1, bars: [1, 2, 3] }] }), [], 'not a packed array');
  const many = Array.from({ length: 6 }, (_, i) => ({ ...s, key: `k${i}` }));
  assert.equal(toRecord(many).series.length, STORED_SERIES);
});

test('store: no IndexedDB means no copy, never an error', async () => {
  const st = new SeriesStore(null);
  assert.deepEqual(await st.read(), []);
  await st.write([{ key: 'k', at: 1, more: true, unverifiedFrom: null, bars: [bar(60_000)] }]);
});

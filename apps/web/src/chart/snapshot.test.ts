/**
 * The chart's snapshot, as "Download snapshot" saves it: what is frozen into it.
 *   npx tsx --test src/chart/snapshot.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_EXECUTIONS,
  buildSnapshot,
  frozenFills,
  frozenPosition,
  snapshotFileName,
  type SnapshotParts,
} from './snapshot';

const at = Date.UTC(2026, 9, 24, 15, 30);
const fills = [
  { symbol: 'BTC-USD', side: 'BUY', price: '79400', quantity: '0.01', time: at - 60_000 },
  { symbol: 'BTC-USD', side: 2, price: '79500.5', quantity: '0.004', time: at - 30_000 },
  { symbol: 'ETH-USD', side: 'BUY', price: '2300', quantity: '1', time: at },
  { symbol: 'BTC-USD', side: 'BUY', price: '0', quantity: '1', time: at },
];
const parts = (over: Partial<SnapshotParts> = {}): SnapshotParts => ({
  engine: 'perps',
  symbol: 'BTC-USD',
  interval: '1h',
  priceSource: 'latest',
  range: { from: at - 3_600_000, to: at },
  drawings: [{ name: 'segment', points: [{ timestamp: 1, value: 2 }, { timestamp: 3, value: 4 }], lock: true, z: 3 }],
  indicators: [{ name: 'VOL', calcParams: [], visible: true }],
  position: { side: 'long', size: '0.014', entry: '79428.6' },
  fills,
  at,
  ...over,
});

test('the position and the fills go in only when the user includes them', () => {
  const none = buildSnapshot(parts(), { position: false, executions: false });
  assert.deepEqual(none.include, { position: false, executions: false });
  assert.equal('position' in none, false);
  assert.equal('executions' in none, false);

  const all = buildSnapshot(parts(), { position: true, executions: true });
  assert.deepEqual(all.position, { side: 'long', size: '0.014', entry: '79428.6' });
  assert.deepEqual(all.executions, [
    { time: at - 30_000, side: 'sell', price: '79500.5', size: '0.004' },
    { time: at - 60_000, side: 'buy', price: '79400', size: '0.01' },
  ]);
  // Asked for, but there is no position: not claimed as included.
  assert.equal(buildSnapshot(parts({ position: null }), { position: true, executions: false }).include.position, false);
});

test('the open position and the fills are read from the gateway rows', () => {
  assert.deepEqual(frozenPosition([{ symbol: 'ETH-USD', size: '1', avgEntryPrice: '1' }, { symbol: 'BTC-USD', size: '-0.5', avgEntryPrice: '79000' }], 'BTC-USD'), {
    side: 'short',
    size: '0.5',
    entry: '79000',
  });
  assert.equal(frozenPosition([{ symbol: 'BTC-USD', size: '0', avgEntryPrice: '79000' }], 'BTC-USD'), null);
  const many = Array.from({ length: 700 }, (_, i) => ({ symbol: 'BTC-USD', side: 'BUY', price: '1', quantity: '1', time: i + 1 }));
  const kept = frozenFills(many, 'BTC-USD');
  assert.equal(kept.length, MAX_EXECUTIONS);
  assert.equal(kept[0]!.time, 700);
});

test('a snapshot names its file after the market, interval and time', () => {
  const t = new Date(2026, 9, 24, 17, 5).getTime();
  assert.equal(snapshotFileName({ symbol: 'BTC-USD', interval: '1h', at: t }), 'chart-BTC-USD-1h-2026-10-24-1705.json');
});

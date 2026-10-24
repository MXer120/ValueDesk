/**
 * The chart's snapshot for the knowledge folders (folders/bridge.ts): what is
 * frozen into it, what a parse keeps and drops, and where an opened one lands.
 *   npx tsx --test src/chart/snapshot.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_EXECUTIONS,
  buildSnapshot,
  dataUrlBytes,
  frozenFills,
  frozenPosition,
  openSnapshot,
  parseChartSnapshot,
  registerLiveChart,
  snapshotFileName,
  snapshotFills,
  snapshotPosition,
  takePendingSnapshot,
  type ChartSnapshot,
  type LiveChart,
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

test('a snapshot survives JSON and a parse unchanged', () => {
  const s = buildSnapshot(parts(), { position: true, executions: true });
  assert.deepEqual(parseChartSnapshot(JSON.parse(JSON.stringify(s))), s);
});

test('anything that is not a snapshot is refused', () => {
  const s = buildSnapshot(parts(), { position: false, executions: false });
  for (const bad of [null, 'x', {}, { ...s, v: 2 }, { ...s, engine: 'cex' }, { ...s, symbol: '<b>' }, { ...s, interval: 'week' }]) {
    assert.equal(parseChartSnapshot(bad), null);
  }
});

test("a parse drops the chart's own marks, broken entries and anything not included", () => {
  const s = parseChartSnapshot({
    ...buildSnapshot(parts(), { position: false, executions: false }),
    drawings: [
      { name: 'vs_exec', points: [{ timestamp: 1, value: 1 }] },
      { name: 'ot_order_line', points: [{ timestamp: 1, value: 1 }] },
      { name: 'segment', points: [] },
      { name: 'segment', points: [{ timestamp: 5, value: 6 }] },
    ],
    priceSource: 'vibes',
    range: { from: 9, to: 1 },
    // Present but not included: dropped.
    position: { side: 'long', size: '1', entry: '2' },
    include: { position: false, executions: true },
    executions: [{ time: 5, side: 'buy', price: '1', size: '1' }, { time: 6, side: 'hold', price: '1', size: '1' }],
  })!;
  assert.deepEqual(s.drawings.map((d) => d.points[0]!.timestamp), [5]);
  assert.equal(s.priceSource, 'latest');
  assert.equal(s.range, undefined);
  assert.equal(s.position, undefined);
  assert.deepEqual(s.executions, [{ time: 5, side: 'buy', price: '1', size: '1' }]);
  assert.deepEqual(s.include, { position: false, executions: true });
});

test('the frozen parts come back as the rows the chart draws from', () => {
  const s = buildSnapshot(parts({ position: { side: 'short', size: '2', entry: '100' } }), { position: true, executions: true });
  assert.deepEqual(snapshotPosition(s), [{ symbol: 'BTC-USD', size: -2, positionSide: 3, avgEntryPrice: '100' }]);
  assert.deepEqual((snapshotFills(s)[0] as { side: string }).side, 'SELL');
  assert.deepEqual(snapshotPosition({ ...s, include: { position: false, executions: true } }), []);
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

test('an opened snapshot waits for its market, or lands on the chart on screen', () => {
  const s = buildSnapshot(parts({ symbol: 'ETH-USD' }), { position: false, executions: false });
  assert.equal(openSnapshot(s), 'staged');
  assert.equal(takePendingSnapshot('perps', 'ETH-USD')?.symbol, 'ETH-USD');
  assert.equal(takePendingSnapshot('perps', 'ETH-USD'), null);

  const opened: string[] = [];
  const chart: LiveChart = { engine: () => 'perps', symbol: () => 'BTC-USD', open: (x: ChartSnapshot) => opened.push(x.interval) };
  const off = registerLiveChart(chart);
  assert.equal(openSnapshot(buildSnapshot(parts(), { position: false, executions: false })), 'shown');
  assert.deepEqual(opened, ['1h']);
  off();
  assert.equal(openSnapshot(buildSnapshot(parts(), { position: false, executions: false })), 'staged');
  takePendingSnapshot('perps', 'BTC-USD');
});

test('a snapshot names its file after the market, interval and time; a data URL counts its bytes', () => {
  const t = new Date(2026, 9, 24, 17, 5).getTime();
  assert.equal(snapshotFileName({ symbol: 'BTC-USD', interval: '1h', at: t }), 'chart-BTC-USD-1h-2026-10-24-1705.json');
  assert.equal(dataUrlBytes('data:image/jpeg;base64,AAAA'), 3);
});

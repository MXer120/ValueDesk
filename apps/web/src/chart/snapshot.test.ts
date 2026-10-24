/**
 * The chart snapshot: its shape, what a parse keeps and drops, and where a
 * restore lands.
 *   npx tsx --test src/chart/snapshot.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  captureChart,
  parseChartSnapshot,
  registerLiveChart,
  restoreChart,
  snapshotFileName,
  takePendingSnapshot,
  touchChart,
  type ChartSnapshot,
  type LiveChart,
} from './snapshot';

const snap = (over: Partial<ChartSnapshot> = {}): ChartSnapshot => ({
  kind: 'valuedesk.chart',
  v: 1,
  takenAt: Date.UTC(2026, 9, 24, 15, 30),
  engine: 'perps',
  symbol: 'BTC-USD',
  interval: '1h',
  priceSource: 'latest',
  tz: 'utc',
  view: { from: 1, to: 2 },
  lastPrice: 79_400,
  drawings: [{ name: 'segment', points: [{ timestamp: 1, value: 2 }, { timestamp: 3, value: 4 }], lock: true, z: 3 }],
  indicators: [{ name: 'VOL', calcParams: [], visible: true }],
  show: { position: true, orders: false, executions: true, news: 'macro' },
  ...over,
});

test('a snapshot survives JSON and a parse unchanged', () => {
  const s = snap();
  assert.deepEqual(parseChartSnapshot(JSON.parse(JSON.stringify(s))), s);
});

test('anything that is not a snapshot is refused', () => {
  for (const bad of [null, 'x', {}, { ...snap(), kind: 'other' }, { ...snap(), v: 2 }, { ...snap(), engine: 'cex' }, { ...snap(), symbol: '<b>' }, { ...snap(), interval: 'week' }]) {
    assert.equal(parseChartSnapshot(bad), null);
  }
});

test('a parse drops the chart\'s own marks, broken drawings and bad settings', () => {
  const s = parseChartSnapshot({
    ...snap(),
    drawings: [
      { name: 'vs_exec', points: [{ timestamp: 1, value: 1 }] },
      { name: 'ot_order_line', points: [{ timestamp: 1, value: 1 }] },
      { name: 'segment', points: [] },
      { name: 'segment', points: [{ timestamp: 5, value: 6 }] },
    ],
    tz: 'mars',
    priceSource: 'vibes',
    view: { from: 9, to: 1 },
    show: { news: 'everything', position: false },
  })!;
  assert.deepEqual(s.drawings.map((d) => d.points[0]!.timestamp), [5]);
  assert.equal(s.tz, 'local');
  assert.equal(s.priceSource, 'latest');
  assert.equal(s.view, null);
  assert.deepEqual(s.show, { position: false, orders: true, executions: true, news: 'off' });
});

test('a restore waits for its market\'s chart, or lands on the one on screen', () => {
  assert.equal(restoreChart(snap({ symbol: 'ETH-USD' })), 'stored');
  assert.equal(takePendingSnapshot('perps', 'ETH-USD')?.symbol, 'ETH-USD');
  assert.equal(takePendingSnapshot('perps', 'ETH-USD'), null);

  const applied: string[] = [];
  const chart: LiveChart = {
    engine: () => 'perps',
    symbol: () => 'BTC-USD',
    capture: () => snap({ interval: '5m' }),
    image: () => null,
    apply: (s) => applied.push(s.interval),
  };
  const off = registerLiveChart(chart);
  touchChart(chart);
  assert.equal(restoreChart(snap()), 'applied');
  assert.deepEqual(applied, ['1h']);
  assert.equal(captureChart()?.interval, '5m');
  off();
  assert.equal(captureChart(), null);
  assert.throws(() => restoreChart({} as ChartSnapshot));
});

test('a snapshot names its file after the market, interval and time', () => {
  const t = new Date(2026, 9, 24, 17, 5).getTime();
  assert.equal(snapshotFileName({ symbol: 'BTC-USD', interval: '1h', takenAt: t }), 'chart-BTC-USD-1h-2026-10-24-1705.json');
});

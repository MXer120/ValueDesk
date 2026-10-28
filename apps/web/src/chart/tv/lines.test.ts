/**
 * DIY order and position lines on the free drawings API: the line manager's
 * diffing against a fake chart, live PnL text, reading a drag back, and the
 * modify request a confirmed drag turns into.
 *   npx tsx --test src/chart/tv/lines.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setNumStyle } from '../../numStyle';
import type { OrderLine } from '../orderOverlays';
import { LineManager, type LineChart } from './lineManager';
import {
  droppedPrice,
  horizontalLineOptions,
  lineShapes,
  liveText,
  modifyRequestFor,
  positionDirection,
  positionPnl,
  type LineShape,
} from './lines';

setNumStyle('comma-dot');
import type { CreateMultipointShapeOptions, EntityId, ShapePoint } from './types';

const line = (over: Partial<OrderLine>): OrderLine => ({
  key: 'o1',
  kind: 'limit',
  side: 'buy',
  price: '100',
  quantity: '2',
  label: 'BUY 2 @ 100',
  symbol: 'BTC-USD',
  orderID: 7,
  draggable: true,
  ...over,
});
const colors = { pos: 'G', neg: 'R', text: 'W', muted: 'M' };

/** A chart that records every call, with shapes you can "drag". */
function fakeChart() {
  let seq = 0;
  const shapes = new Map<EntityId, { points: ShapePoint[]; options: CreateMultipointShapeOptions; props: Record<string, unknown> }>();
  const log: string[] = [];
  const chart: LineChart = {
    createMultipointShape: (points, options) => {
      const id = `s${++seq}`;
      shapes.set(id, { points, options, props: { text: options.text } });
      log.push(`create ${options.text}`);
      return Promise.resolve(id);
    },
    removeEntity: (id) => {
      log.push(`remove ${shapes.get(id)?.props.text}`);
      shapes.delete(id);
    },
    getShapeById: (id) => {
      const s = shapes.get(id);
      if (!s) return null;
      return {
        getPoints: () => s.points.map((p) => ({ time: p.time, price: p.price ?? 0 })),
        setPoints: (pts) => {
          s.points = pts;
          log.push(`move ${s.props.text} -> ${pts[0]?.price}`);
        },
        setProperties: (p) => {
          Object.assign(s.props, p);
          log.push(`text ${String(p.text)}`);
        },
      };
    },
  };
  return { chart, shapes, log, drag: (id: EntityId, price: number) => (shapes.get(id)!.points = [{ time: 1, price }]) };
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function manager(opts: { onMove?: (s: LineShape, p: string) => void } = {}) {
  const f = fakeChart();
  const timers: (() => void)[] = [];
  const m = new LineManager({
    chart: () => f.chart,
    tickSize: () => '0.5',
    nowSec: () => 1,
    setTimer: (fn) => (timers.push(fn), timers.length),
    clearTimer: () => undefined,
    ...(opts.onMove ? { onMove: opts.onMove } : {}),
  });
  const fire = () => timers.splice(0).forEach((fn) => fn());
  return { m, f, fire };
}

// --- pure parts -------------------------------------------------------------------

test('order lines drag only when the session could modify them; positions never', () => {
  const shapes = lineShapes(
    [
      line({}),
      line({ key: 'ro', draggable: false }),
      line({ key: 'noid', orderID: undefined }),
      line({ key: 'p', kind: 'position', side: null, label: 'LONG 2 @ 100', draggable: false }),
    ],
    colors,
  );
  assert.deepEqual(shapes.map((s) => [s.key, s.draggable]), [
    ['o1', true],
    ['ro', false],
    ['noid', false],
    ['p', false],
  ]);
  const drag = horizontalLineOptions(shapes[0]!);
  assert.equal(drag.lock, false);
  assert.equal(drag.disableSelection, false);
  assert.equal(drag.disableSave, true, 'never saved into a layout');
  const pos = horizontalLineOptions(shapes[3]!);
  assert.equal(pos.lock, true, 'the position line is locked');
  assert.equal(pos.disableSelection, true);
});

test('position PnL: long, short, and nothing when it cannot be honest', () => {
  const long = line({ kind: 'position', side: null, label: 'LONG 2 @ 100', price: '100', quantity: '2' });
  const short = line({ kind: 'position', side: null, label: 'SHORT 2 @ 100', price: '100', quantity: '2' });
  assert.equal(positionDirection(long), 1);
  assert.equal(positionDirection(short), -1);
  assert.equal(positionPnl(long, '110'), 20);
  assert.equal(positionPnl(short, '110'), -20);
  assert.equal(positionPnl(long, ''), null);
  assert.equal(positionPnl(line({ kind: 'position', label: 'POSITION 2 @ 100' }), '110'), null);
  assert.equal(positionPnl(line({}), '110'), null, 'an order has no PnL');
});

test('live text adds the PnL to a position and leaves orders alone', () => {
  const [pos, ord] = lineShapes(
    [line({ key: 'p', kind: 'position', side: null, label: 'LONG 2 @ 100' }), line({})],
    colors,
  );
  assert.equal(liveText(pos!, '105', 'vUSDC'), 'LONG 2 @ 100  PnL +$10.00');
  assert.equal(liveText(pos!, '95', 'vUSDC'), `LONG 2 @ 100  PnL ${'−'}$10.00`);
  assert.equal(liveText(ord!, '105', 'vUSDC'), 'BUY 2 @ 100');
});

test('a drop is snapped to the tick; junk points are no price', () => {
  assert.equal(droppedPrice([{ time: 1, price: 101.26 }], '0.5'), '101.5');
  assert.equal(droppedPrice([{ time: 1, price: 101.24 }], '0.5'), '101');
  assert.equal(droppedPrice([], '0.5'), null);
  assert.equal(droppedPrice([{ time: 1, price: Number.NaN }], '0.5'), null);
});

test('the modify request re-sends the other leg verbatim and only changes the dragged one', () => {
  assert.deepEqual(modifyRequestFor(line({ restPrice: undefined }), '101'), {
    symbol: 'BTC-USD', orderID: 7, quantity: '2', price: '101',
  });
  assert.deepEqual(modifyRequestFor(line({ kind: 'trigger', restPrice: '99.5' }), '98'), {
    symbol: 'BTC-USD', orderID: 7, quantity: '2', stopPrice: '98', price: '99.5',
  });
  assert.deepEqual(modifyRequestFor(line({ stopPrice: '97' }), '101'), {
    symbol: 'BTC-USD', orderID: 7, quantity: '2', price: '101', stopPrice: '97',
  });
  assert.equal(modifyRequestFor(line({ kind: 'position' }), '101'), null);
  assert.equal(modifyRequestFor(line({ orderID: undefined }), '101'), null);
});

// --- the manager ------------------------------------------------------------------

test('sync draws what is new, removes what is gone, leaves the rest untouched', async () => {
  const { m, f } = manager();
  const a = lineShapes([line({ key: 'a', label: 'A' }), line({ key: 'b', label: 'B' })], colors);
  m.sync(a);
  await settle();
  assert.deepEqual(f.log, ['create A', 'create B']);
  f.log.length = 0;
  m.sync(a); // same again
  await settle();
  assert.deepEqual(f.log, []);
  m.sync(lineShapes([line({ key: 'a', label: 'A' }), line({ key: 'c', label: 'C' })], colors));
  await settle();
  assert.deepEqual(f.log, ['remove B', 'create C']);
  f.log.length = 0;
  m.sync(lineShapes([line({ key: 'a', label: 'A', price: '101' }), line({ key: 'c', label: 'C' })], colors));
  await settle();
  assert.deepEqual(f.log, ['remove A', 'create A'], 'a changed price redraws that line only');
});

test('a price tick rewrites the PnL in place - it never redraws the line', async () => {
  const { m, f } = manager();
  m.sync(lineShapes([line({ key: 'p', kind: 'position', side: null, label: 'LONG 2 @ 100', draggable: false })], colors));
  await settle();
  f.log.length = 0;
  m.setLiveText('101', 'vUSDC');
  m.setLiveText('101', 'vUSDC'); // unchanged: no call
  m.setLiveText('102', 'vUSDC');
  assert.deepEqual(f.log, ['text LONG 2 @ 100  PnL +$2.00', 'text LONG 2 @ 100  PnL +$4.00']);
});

test('a drag is read back through getPoints, snapped, held there and reported once', async () => {
  const moves: [string, string][] = [];
  const { m, f, fire } = manager({ onMove: (s, p) => moves.push([s.key, p]) });
  m.sync(lineShapes([line({})], colors));
  await settle();
  const id = m.idOf('o1')!;
  f.drag(id, 103.3);
  m.handleDrawingEvent(id, 'move');
  m.handleDrawingEvent(id, 'points_changed'); // a burst...
  fire(); // ...settles into one report
  assert.deepEqual(moves, [['o1', '103.5']]);
  assert.equal(m.isHeld('o1'), true);
  assert.equal(f.shapes.get(id)?.points[0]?.price, 103.5, 'snapped onto the tick it would be sent at');
  // a poll with the same server state does not snap it back while held
  m.sync(lineShapes([line({})], colors));
  await settle();
  assert.equal(f.shapes.get(id)?.points[0]?.price, 103.5);
  // cancel -> back on the venue's price
  m.restore('o1');
  assert.equal(f.shapes.get(id)?.points[0]?.price, 100);
  assert.equal(m.isHeld('o1'), false);
});

test('a line dropped where it was, or events for shapes that are not ours, report nothing', async () => {
  const moves: string[] = [];
  const { m, f, fire } = manager({ onMove: (_s, p) => moves.push(p) });
  m.sync(lineShapes([line({})], colors));
  await settle();
  const id = m.idOf('o1')!;
  f.drag(id, 100.1); // snaps back to 100
  m.handleDrawingEvent(id, 'move');
  m.handleDrawingEvent('someone-elses-trendline', 'move');
  fire();
  assert.deepEqual(moves, []);
});

test('a locked line that somehow moved is put back, and never reported', async () => {
  const moves: string[] = [];
  const { m, f, fire } = manager({ onMove: (_s, p) => moves.push(p) });
  m.sync(lineShapes([line({ draggable: false })], colors));
  await settle();
  const id = m.idOf('o1')!;
  f.drag(id, 120);
  m.handleDrawingEvent(id, 'move');
  fire();
  assert.deepEqual(moves, []);
  assert.equal(f.shapes.get(id)?.points[0]?.price, 100);
});

test('a line the user deleted by hand is drawn again - the order did not change', async () => {
  const { m, f } = manager();
  m.sync(lineShapes([line({})], colors));
  await settle();
  const id = m.idOf('o1')!;
  f.chart.removeEntity(id); // the library removed it
  m.handleDrawingEvent(id, 'remove');
  await settle();
  assert.ok(m.idOf('o1') && m.idOf('o1') !== id);
  assert.equal(f.shapes.size, 1);
});

test('forget() drops bookkeeping without touching the chart; clear() removes everything', async () => {
  const { m, f } = manager();
  m.sync(lineShapes([line({ key: 'a' }), line({ key: 'b' })], colors));
  await settle();
  f.log.length = 0;
  m.forget();
  assert.deepEqual(f.log, []);
  assert.deepEqual(m.keys(), []);
  m.sync(lineShapes([line({ key: 'a' })], colors));
  await settle();
  m.clear();
  // (cast: the deepEqual assertion above narrowed the array to never[])
  assert.ok((f.log as string[]).some((l) => l.startsWith('remove')));
});

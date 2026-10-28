/**
 * The volume scale: round steps from zero, compact labels.
 *   npx tsx --test src/chart/volumeAxis.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AxisRange, Bounding } from 'klinecharts';
import { compactNumber, createVolumeTicks, volumeStep } from './volumeAxis';
import { setNumStyle } from '../numStyle';

setNumStyle('comma-dot');

const range = (to: number): AxisRange => ({
  from: 0,
  to,
  range: to,
  realFrom: 0,
  realTo: to,
  realRange: to,
  displayFrom: 0,
  displayTo: to,
  displayRange: to,
});
const box = (height: number) => ({ width: 50, height, left: 0, right: 0, top: 0, bottom: 0 }) as Bounding;

test('compact numbers drop padding zeros and fold thousands', () => {
  assert.equal(compactNumber(5000), '5K');
  assert.equal(compactNumber(2500), '2.5K');
  assert.equal(compactNumber(1276.12), '1.28K');
  assert.equal(compactNumber(4_803_000), '4.8M');
  assert.equal(compactNumber(1), '1');
  assert.equal(compactNumber(0.5, 1), '0.5');
  assert.equal(compactNumber(696.15681, 5), '696.15681');
});

test('a 1m BTC pane reads 1 (or 0.5 / 1 / 1.5 when taller), not 0.3000 / 0.9000 / 1.50', () => {
  const short = createVolumeTicks({ range: range(1.95), bounding: box(90), defaultTicks: [] });
  assert.deepEqual(short.map((t) => t.text), ['1']);
  const tall = createVolumeTicks({ range: range(1.95), bounding: box(200), defaultTicks: [] });
  assert.deepEqual(tall.map((t) => t.text), ['0.5', '1', '1.5']);
});

test('a 1D BTC pane reads in round thousands, like SoDEX', () => {
  const ticks = createVolumeTicks({ range: range(5800), bounding: box(80), defaultTicks: [] });
  const texts = ticks.map((t) => t.text);
  assert.ok(texts.every((t) => /^\d+(\.5)?K$/.test(t)), texts.join(' '));
  assert.ok(!texts.includes('0'));
});

test('ticks never crowd closer than the minimum pitch', () => {
  const ticks = createVolumeTicks({ range: range(123), bounding: box(200), defaultTicks: [] });
  for (let i = 1; i < ticks.length; i++) assert.ok(Math.abs(ticks[i]!.coord - ticks[i - 1]!.coord) >= 31);
  assert.equal(volumeStep(0, 100), 0);
});

test('volume tick labels follow the number format (default 1.234,5)', () => {
  setNumStyle('dot-comma');
  try {
    const tall = createVolumeTicks({ range: range(1.95), bounding: box(200), defaultTicks: [] });
    assert.deepEqual(tall.map((t) => t.text), ['0,5', '1', '1,5']);
    assert.equal(compactNumber(2500), '2.5K'); // machine text: the formatter the library groups
  } finally {
    setNumStyle('comma-dot');
  }
});

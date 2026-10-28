/**
 * klinecharts' numbers in the app's number format (klineNumbers.ts) and the
 * dense price ticks reading those labels back (theme.ts).
 *   npx tsx --test src/chart/klineNumbers.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AxisTick, Bounding } from 'klinecharts';
import { foldDecimal, groupLocalized } from './klineNumbers';
import { createDenseYTicks } from './theme';
import { setNumStyle } from '../numStyle';

test('the grouping step groups in en-US and then localizes', () => {
  setNumStyle('comma-dot');
  assert.equal(groupLocalized('1234567.891'), '1,234,567.891');
  assert.equal(groupLocalized('-1234'), '-1,234');
  assert.equal(groupLocalized('1.28K'), '1.28K');
  setNumStyle('dot-comma');
  assert.equal(groupLocalized('1234567.891'), '1.234.567,891');
  assert.equal(groupLocalized('0.5'), '0,5');
  assert.equal(groupLocalized('1.28K'), '1,28K');
  assert.equal(groupLocalized(80123), '80.123');
});

test('the decimal fold works on either mark and never on a grouping segment', () => {
  assert.equal(foldDecimal('0.0000012'), '0.0{5}12');
  assert.equal(foldDecimal('0,0000012'), '0,0{5}12');
  assert.equal(foldDecimal('1.000.001'), '1.000.001');
  assert.equal(foldDecimal('1,001'), '1,001');
});

/** Ticks as the library would label them (linear, 1px per unit / 10). */
function libraryTicks(values: number[], height: number, lo: number, hi: number): AxisTick[] {
  return values.map((v) => ({
    value: v,
    coord: height - ((v - lo) / (hi - lo)) * height,
    text: groupLocalized(v.toFixed(2)),
  }));
}

test('dense price ticks read localized labels back and print in the same format', () => {
  for (const style of ['dot-comma', 'comma-dot', 'space-comma'] as const) {
    setNumStyle(style);
    const height = 450;
    const lo = 1000;
    const hi = 9000;
    const defaultTicks = libraryTicks([2000, 4000, 6000, 8000], height, lo, hi);
    const out = createDenseYTicks({
      range: { from: lo, to: hi, range: hi - lo, realFrom: lo, realTo: hi, realRange: hi - lo, displayFrom: lo, displayTo: hi, displayRange: hi - lo },
      bounding: { width: 60, height, left: 0, right: 0, top: 0, bottom: 0 } as Bounding,
      defaultTicks,
    } as Parameters<typeof createDenseYTicks>[0]);
    assert.ok(out.length > defaultTicks.length, `${style}: densified`);
    for (const t of out) assert.equal(t.text, groupLocalized(Number(t.value).toFixed(2)), style);
  }
  setNumStyle('comma-dot');
});

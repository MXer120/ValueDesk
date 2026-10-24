/**
 * Indicator specs: the default, the price source, what survives storage.
 *   npx tsx --test src/chart/indicators.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_INDICATORS, legendName, sanitizeSpecs, stylesFor, withSource } from './indicators';

const bar = { timestamp: 1, open: 10, high: 14, low: 8, close: 12 };

test('the default is volume with no moving averages', () => {
  assert.deepEqual(DEFAULT_INDICATORS, [{ name: 'VOL', calcParams: [], visible: true }]);
});

test('a source replaces close and nothing else; Close is the list untouched', () => {
  const list = [bar];
  assert.equal(withSource(list, 'close'), list);
  assert.equal(withSource(list, undefined), list);
  assert.equal(withSource(list, 'high')[0]!.close, 14);
  assert.equal(withSource(list, 'hl2')[0]!.close, 11);
  assert.equal(withSource(list, 'hlc3')[0]!.close, (14 + 8 + 12) / 3);
  assert.equal(withSource(list, 'ohlc4')[0]!.close, 11);
  assert.equal(withSource(list, 'open')[0]!.high, 14);
});

test('the legend names a non-default source', () => {
  assert.equal(legendName('MA', [9]), 'MA 9');
  assert.equal(legendName('MA', [9], 'close'), 'MA 9');
  assert.equal(legendName('MA', [9], 'hl2'), 'MA 9 hl2');
  assert.equal(legendName('VOL', []), 'Volume');
});

test('a saved setup survives: source and pane kept, junk dropped', () => {
  const out = sanitizeSpecs(
    [
      { name: 'MA', visible: true, source: 'hl2', pane: 'main', calcParams: [9, 21] },
      { name: 'RSI', visible: false, source: 'bogus', pane: 'ind_RSI_4' },
      { name: 'MA', visible: true },
      { name: 'NOPE', visible: true },
    ],
    new Set(['MA', 'RSI']),
  );
  assert.deepEqual(out, [
    { name: 'MA', visible: true, calcParams: [9, 21], source: 'hl2', pane: 'main' },
    { name: 'RSI', visible: false, pane: 'ind_RSI_4' },
  ]);
  // Nothing stored yet: the default. An emptied list stays empty - it is theirs.
  assert.deepEqual(sanitizeSpecs(null, null), DEFAULT_INDICATORS);
  assert.deepEqual(sanitizeSpecs([], null), []);
});

test('every style entry is complete, hidden lines are transparent', () => {
  const s = stylesFor({ name: 'MA', visible: true, lines: [{ hidden: true }, { color: '#f06292', size: 2 }] }, 2);
  assert.equal(s.lines?.[0]?.color, 'rgba(0, 0, 0, 0)');
  assert.equal(s.lines?.[1]?.color, '#f06292');
  assert.equal(s.lines?.[1]?.size, 2);
  assert.equal(s.lines?.[1]?.style, 'solid');
});

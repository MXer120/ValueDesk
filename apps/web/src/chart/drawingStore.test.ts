/**
 * Drawings kept per market: what is stored of an overlay, and what is read back.
 *   npx tsx --test src/chart/drawingStore.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawingsKey, parseDrawings, toStored } from './drawingStore';

const known = new Set(['segment', 'ot_note']);

test('an overlay is stored as tool, anchors, style, text and lock - nothing derived', () => {
  const d = toStored({
    name: 'ot_note',
    points: [{ timestamp: 1000, value: 80_000, dataIndex: 12 }],
    styles: { line: { color: '#f06292' } },
    extendData: 'Breakout here',
    lock: true,
  });
  assert.deepEqual(d, {
    name: 'ot_note',
    points: [{ timestamp: 1000, value: 80_000 }],
    styles: { line: { color: '#f06292' } },
    extendData: 'Breakout here',
    lock: true,
  });
});

test('hidden on its own and the stacking order are kept; defaults are not written', () => {
  const base = { name: 'segment', points: [{ timestamp: 1, value: 2 }], styles: null, extendData: undefined, lock: false };
  assert.deepEqual(toStored({ ...base, zLevel: 3 }, true), { name: 'segment', points: [{ timestamp: 1, value: 2 }], hidden: true, z: 3 });
  assert.deepEqual(toStored({ ...base, zLevel: 0 }), { name: 'segment', points: [{ timestamp: 1, value: 2 }] });
  // The selection's temporary lift is never kept, from the overlay or from storage.
  assert.equal(toStored({ ...base, zLevel: Number.MAX_SAFE_INTEGER })?.z, undefined);
  assert.equal(parseDrawings([{ ...base, z: Number.MAX_SAFE_INTEGER }], known)[0]?.z, undefined);
  assert.deepEqual(parseDrawings([{ ...base, hidden: true, z: -2 }], known), [{ name: 'segment', points: [{ timestamp: 1, value: 2 }], hidden: true, z: -2 }]);
});

test('an overlay with no complete anchor is not stored', () => {
  assert.equal(toStored({ name: 'segment', points: [{ value: 1 }], styles: null, extendData: undefined, lock: false }), null);
});

test('reading back drops unknown tools and malformed entries', () => {
  const raw = [
    { name: 'segment', points: [{ timestamp: 1, value: 2 }, { timestamp: 3, value: 4 }] },
    { name: 'removedTool', points: [{ timestamp: 1, value: 2 }] },
    { name: 'segment', points: [{ timestamp: 'x', value: 2 }] },
    'junk',
    { name: 'ot_note', points: [{ timestamp: 5, value: 6 }], extendData: 'hi', lock: 'yes' },
  ];
  const out = parseDrawings(raw, known);
  assert.equal(out.length, 2);
  assert.deepEqual(out[1], { name: 'ot_note', points: [{ timestamp: 5, value: 6 }], extendData: 'hi' });
  assert.deepEqual(parseDrawings({ not: 'a list' }, known), []);
});

test('the key is the market, not the price source', () => {
  assert.equal(drawingsKey('perps', 'BTC-USD'), 'chart.drawings.v1:perps:BTC-USD');
  assert.notEqual(drawingsKey('perps', 'BTC-USD'), drawingsKey('spot', 'BTC-USD'));
});

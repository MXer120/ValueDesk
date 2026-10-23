import assert from 'node:assert/strict';
import test from 'node:test';
import { activateSlot, removeSlot, seedTerminals, terminalsOf, type SavedDashboard } from './storage';
import type { TerminalSeed } from './types';

const seeds: TerminalSeed[] = [
  { id: 'trade', name: 'Trade', icon: 'trade' },
  { id: 'news', name: 'News', icon: 'news', blank: true, shown: ['livefeed', 'news', 'chart'], layouts: { lg: [{ i: 'livefeed', x: 0, y: 0, w: 30, h: 52 }] } },
];
const fresh: SavedDashboard = { v: 13, layouts: { lg: [{ i: 'chart', x: 0, y: 6, w: 28, h: 54 }] }, hidden: ['venue'], shown: [] };

test('a record with no slots: Trade takes the arrangement on screen and stays active, News follows it', () => {
  const s = seedTerminals(fresh, seeds);
  assert.deepEqual(terminalsOf(s), [
    { id: 'trade', name: 'Trade', icon: 'trade' },
    { id: 'news', name: 'News', icon: 'news' },
  ]);
  assert.equal(s.activeSlot, 'trade');
  assert.deepEqual(s.slots![0]!.layouts, fresh.layouts, 'the user’s own layout is Trade');
  assert.equal(s.slots![0]!.blank, undefined);
  assert.equal(s.slots![1]!.blank, true);
  assert.deepEqual(s.slots![1]!.shown, ['livefeed', 'news', 'chart']);
  assert.deepEqual(s.seeded, ['trade', 'news']);
  assert.equal(seedTerminals(s, seeds), s, 'seeding twice changes nothing');
});

test('existing slots: the first unnamed one becomes Trade, News is appended once', () => {
  const had: SavedDashboard = { ...fresh, slots: [{ id: 'primary', layouts: {} }, { id: 'alt', layouts: {} }], activeSlot: 'alt' };
  const s = seedTerminals(had, seeds);
  assert.deepEqual(terminalsOf(s).map((t) => t.name), ['Trade', 'Layout 2', 'News']);
  assert.equal(s.activeSlot, 'alt', 'the canvas on screen stays on screen');
});

test('a deleted terminal stays deleted', () => {
  const s = seedTerminals(fresh, seeds);
  const gone = removeSlot(activateSlot(s, 'trade'), 'news');
  assert.deepEqual(terminalsOf(seedTerminals(gone, seeds)).map((t) => t.id), ['trade']);
});

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

test('reset: News goes back to the News layout, sizes only keeps the widgets', async () => {
  const { resetSlot } = await import('./storage');
  const s = activateSlot(seedTerminals(fresh, seeds), 'news');
  const moved: SavedDashboard = {
    ...s,
    layouts: { lg: [{ i: 'livefeed', x: 0, y: 0, w: 20, h: 30 }, { i: 'trades', x: 20, y: 0, w: 10, h: 30 }] },
    shown: ['livefeed', 'news', 'chart', 'trades'],
  };
  const sizes = resetSlot(moved, seeds, 'sizes');
  assert.deepEqual(sizes.layouts, seeds[1]!.layouts, 'the seed’s sizes and places');
  assert.deepEqual(sizes.shown, ['livefeed', 'news', 'chart', 'trades'], 'the added widget stays');
  const all = resetSlot(moved, seeds, 'all');
  assert.deepEqual(all.layouts, seeds[1]!.layouts);
  assert.deepEqual(all.shown, ['livefeed', 'news', 'chart'], 'only the panels it started with');
  assert.equal(all.slots!.find((x) => x.id === 'news')!.blank, true);
  assert.deepEqual(all.slots!.find((x) => x.id === 'trade')!.layouts, fresh.layouts, 'the other terminal is untouched');
});

test('an untouched terminal moves to its seed\'s new design; one its owner changed stays theirs', () => {
  const OLD = { lg: [{ i: 'livefeed', x: 0, y: 0, w: 30, h: 52 }, { i: 'news', x: 30, y: 0, w: 18, h: 90 }] };
  const NEW = { lg: [{ i: 'livefeed', x: 0, y: 0, w: 26, h: 40 }, { i: 'news', x: 26, y: 0, w: 12, h: 90 }, { i: 'exec', x: 38, y: 0, w: 10, h: 60 }] };
  const v2: TerminalSeed[] = [seeds[0]!, { id: 'news', name: 'News', icon: 'news', blank: true, shown: ['livefeed', 'news', 'exec'], layouts: NEW, was: [{ shown: ['livefeed', 'news'], layouts: OLD }] }];
  const v1: TerminalSeed[] = [seeds[0]!, { id: 'news', name: 'News', icon: 'news', blank: true, shown: ['livefeed', 'news'], layouts: OLD }];
  const before = seedTerminals(fresh, v1);
  // The grid writes its placements back with extra fields, in its own order: still untouched.
  const asSaved = {
    ...before,
    slots: before.slots!.map((s) => (s.id === 'news' ? { ...s, layouts: { lg: [...OLD.lg].reverse().map((p) => ({ ...p, moved: false, static: false })) } } : s)),
  };
  const up = seedTerminals(asSaved, v2);
  const news = up.slots!.find((s) => s.id === 'news')!;
  assert.deepEqual(news.layouts.lg, NEW.lg);
  assert.deepEqual(news.shown, ['livefeed', 'news', 'exec']);
  assert.deepEqual(up.slots!.find((s) => s.id === 'trade')!.layouts, fresh.layouts, 'Trade is not a seed with a past');
  assert.equal(seedTerminals(up, v2), up, 'once moved, nothing changes again');

  const moved = { ...before, slots: before.slots!.map((s) => (s.id === 'news' ? { ...s, layouts: { lg: [{ ...OLD.lg[0]!, h: 40 }, OLD.lg[1]!] } } : s)) };
  assert.equal(seedTerminals(moved, v2), moved, 'a resized panel keeps the owner\'s design');
  const added = { ...before, slots: before.slots!.map((s) => (s.id === 'news' ? { ...s, shown: ['livefeed', 'news', 'trades'] } : s)) };
  assert.equal(seedTerminals(added, v2), added, 'an added widget keeps it too');

  // On screen, the top-level copy is the canvas: it moves with its slot.
  const onScreen = activateSlot(before, 'news');
  const upOn = seedTerminals(onScreen, v2);
  assert.deepEqual(upOn.layouts.lg, NEW.lg);
  assert.deepEqual(upOn.shown, ['livefeed', 'news', 'exec']);
});

test('reset: Trade goes back to the designed default', async () => {
  const { resetSlot } = await import('./storage');
  const s = seedTerminals(fresh, seeds);
  const all = resetSlot({ ...s, hidden: ['venue', 'book'] }, seeds, 'all');
  assert.deepEqual(all.layouts, {});
  assert.deepEqual(all.hidden, []);
  assert.equal(all.slots!.find((x) => x.id === 'trade')!.blank, undefined);
});

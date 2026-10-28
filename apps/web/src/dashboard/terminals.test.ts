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

test('history: a deleted terminal can be restored, under its name, on screen; it then leaves the history', async () => {
  const { restoreFromHistory } = await import('./storage');
  const s = activateSlot(seedTerminals(fresh, seeds), 'news');
  const gone = removeSlot(s, 'news', 1_000);
  assert.deepEqual(terminalsOf(gone).map((t) => t.id), ['trade']);
  assert.equal(gone.activeSlot, 'trade', 'the one on screen hands over');
  assert.equal(gone.history?.length, 1);
  assert.deepEqual({ why: gone.history![0]!.why, name: gone.history![0]!.slot.name, at: gone.history![0]!.at }, { why: 'deleted', name: 'News', at: 1_000 });
  const back = restoreFromHistory(gone, gone.history![0]!.id);
  assert.deepEqual(terminalsOf(back).map((t) => t.name), ['Trade', 'News']);
  assert.equal(back.activeSlot, 'news');
  assert.deepEqual(back.layouts, s.slots!.find((x) => x.id === 'news')!.layouts);
  assert.equal(back.history?.length, 0);
});

test('history: a reset and a preset keep the layout they replace; the same layout is not kept twice; 20 at most', async () => {
  const { remember, resetSlot, HISTORY_MAX } = await import('./storage');
  const s = activateSlot(seedTerminals(fresh, seeds), 'trade');
  const reset = resetSlot(s, seeds, 'all', 5);
  assert.equal(reset.history?.[0]?.why, 'reset');
  assert.deepEqual(reset.history?.[0]?.slot.layouts, fresh.layouts, 'the user’s own layout is kept');
  assert.equal(remember(remember(s, 'trade', 'preset', 6), 'trade', 'preset', 7).history?.length, 1, 'unchanged: once');
  let many = s;
  for (let i = 0; i < 30; i++) many = remember({ ...many, layouts: { lg: [{ i: 'chart', x: i, y: 0, w: 10, h: 10 }] } }, 'trade', 'edited', 100 + i);
  assert.equal(many.history?.length, HISTORY_MAX);
  assert.equal(many.history?.[0]?.at, 129, 'newest first');
});

test('history: what edit mode changed is kept as it was when edit mode opened', async () => {
  const { mirrorIntoActiveSlot, rememberEdits } = await import('./storage');
  const s = activateSlot(seedTerminals(fresh, seeds), 'trade');
  const before = mirrorIntoActiveSlot(s).slots!;
  const edited = { ...s, layouts: { lg: [{ i: 'chart', x: 3, y: 3, w: 9, h: 9 }] } };
  const done = rememberEdits(edited, before, 50);
  assert.equal(done.history?.length, 1);
  assert.deepEqual({ why: done.history![0]!.why, id: done.history![0]!.slot.id }, { why: 'edited', id: 'trade' });
  assert.deepEqual(done.history![0]!.slot.layouts, fresh.layouts);
  assert.equal(rememberEdits(s, before, 51).history, s.history, 'nothing changed: nothing kept');
});

test('hide from sidebar: off the rail, kept; the one on screen hands over; the last one stays', async () => {
  const { setSlotOff, hiddenTerminalsOf } = await import('./storage');
  const s = activateSlot(seedTerminals(fresh, seeds), 'news');
  const off = setSlotOff(s, 'news', true);
  assert.deepEqual(terminalsOf(off).map((t) => t.id), ['trade']);
  assert.deepEqual(hiddenTerminalsOf(off).map((t) => t.id), ['news']);
  assert.equal(off.activeSlot, 'trade');
  assert.equal(setSlotOff(off, 'trade', true), off, 'the last on the rail cannot be hidden');
  assert.deepEqual(terminalsOf(setSlotOff(off, 'news', false)).map((t) => t.id), ['trade', 'news']);
  // Deleting the only visible one brings a hidden one back on the rail.
  const onlyHidden = removeSlot(off, 'trade', 9);
  assert.deepEqual(terminalsOf(onlyHidden).map((t) => t.id), ['news']);
});

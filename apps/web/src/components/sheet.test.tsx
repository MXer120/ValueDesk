/**
 * The phone sheet's drag (motion.tsx useSheetDrag): it follows the finger down and gives a little upwards, goes when
 * pulled a quarter or flung, and its exit carries the release speed on. The tab bar lights More for every page the
 * sheet opens (PhoneTabBar itemForRoute). The slots the notes portal into (slots.ts).
 * Run (from apps/web): npx tsx --test src/components/sheet.test.tsx
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerTestLoader } from '../testRender';
import { cubicBezier } from '../ease';

registerTestLoader();

test('it follows the finger down, and rubber-bands up to 12 px', async () => {
  const { sheetOffset } = await import('./motion');
  assert.equal(sheetOffset(0), 0);
  assert.equal(sheetOffset(140), 140);
  assert.equal(sheetOffset(-20), -4);
  assert.equal(sheetOffset(-400), -12);
});

test('it goes past a quarter of its height or on a fling, else it settles back', async () => {
  const { sheetDismisses, SHEET_FLING } = await import('./motion');
  assert.equal(sheetDismisses(101, 0, 400), true);
  assert.equal(sheetDismisses(99, 0, 400), false);
  assert.equal(sheetDismisses(30, SHEET_FLING + 0.01, 400), true);
  assert.equal(sheetDismisses(30, -1, 400), false, 'flung upwards: stays');
});

test('the exit starts at the release speed and lands softly', async () => {
  const { sheetExit } = await import('./motion');
  for (const [dy, v, h] of [[60, 1.2, 420], [150, 0.7, 420], [200, 0, 420], [20, 3, 300]] as const) {
    const { ms, easing } = sheetExit(dy, v, h);
    assert.ok(ms >= 120 && ms <= 280, `${ms} ms`);
    const m = /cubic-bezier\(0\.25, ([\d.]+), 0\.25, 1\)/.exec(easing);
    assert.ok(m, easing);
    const y1 = Number(m![1]);
    // Initial speed of the curve over the rest of the way, in px/ms: y1/x1 * rest / ms.
    const start = (y1 / 0.25) * (h - dy) / ms;
    if (y1 < 1) assert.ok(Math.abs(start - v) < 0.01, `start ${start} vs release ${v}`);
    const f = cubicBezier(0.25, y1, 0.25, 1);
    assert.ok(1 - f(0.98) < 0.01, 'lands with no jolt');
  }
});

test('the bar lights More for every page its sheet opens', async () => {
  const { itemForRoute } = await import('./PhoneTabBar');
  assert.equal(itemForRoute('tab:trade'), 'trade');
  assert.equal(itemForRoute('tab:bots'), 'bots');
  assert.equal(itemForRoute('tab:portfolio'), 'portfolio');
  assert.equal(itemForRoute('sodex:points'), 'points');
  for (const k of ['tab:explore', 'tab:copy', 'tab:scan', 'tab:leaderboard', 'sodex:wealth', 'legal:terms', 'status', 'limits', 'excluded']) assert.equal(itemForRoute(k), 'more', k);
});

test('a slot is known from its own ref, and forgotten when it goes', async () => {
  const { slotEl, slotRef } = await import('../slots');
  const el = {} as HTMLElement;
  assert.equal(slotEl('vs-toast-pin'), null);
  slotRef('vs-toast-pin')(el);
  assert.equal(slotEl('vs-toast-pin'), el);
  assert.equal(slotRef('vs-toast-pin'), slotRef('vs-toast-pin'), 'one stable callback');
  slotRef('vs-toast-pin')(null);
  assert.equal(slotEl('vs-toast-pin'), null);
});

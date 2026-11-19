/** Polling pauses while the tab is hidden and catches up the moment it is shown (visibility.ts). */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// A document stand-in, installed before the module first looks for one.
const listeners: Array<() => void> = [];
const fakeDoc = {
  visibilityState: 'visible' as 'visible' | 'hidden',
  addEventListener: (type: string, fn: () => void) => {
    if (type === 'visibilitychange') listeners.push(fn);
  },
};
(globalThis as { document?: unknown }).document = fakeDoc;
const setVisibility = (v: 'visible' | 'hidden') => {
  fakeDoc.visibilityState = v;
  for (const fn of listeners) fn();
};

// The window's focus events, for pollWhileShown.
const winListeners = new Map<string, Set<() => void>>();
(globalThis as { window?: unknown }).window = {
  addEventListener: (type: string, fn: () => void) => { if (!winListeners.has(type)) winListeners.set(type, new Set()); winListeners.get(type)!.add(fn); },
  removeEventListener: (type: string, fn: () => void) => { winListeners.get(type)?.delete(fn); },
};
const focusWindow = () => { for (const fn of [...(winListeners.get('focus') ?? [])]) fn(); };

const { pollEvery, pollWhileShown, visibleTimeout, isHidden } = await import('./visibility');

test('pollEvery: ticks while visible, none while hidden, one at once on return', () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 });
  try {
    let runs = 0;
    const stop = pollEvery(10_000, () => runs++);
    mock.timers.tick(30_000);
    assert.equal(runs, 3);
    setVisibility('hidden');
    assert.equal(isHidden(), true);
    mock.timers.tick(60_000);
    assert.equal(runs, 3, 'nothing is fetched for a hidden tab');
    setVisibility('visible');
    assert.equal(runs, 4, 'caught up the moment the tab is shown');
    mock.timers.tick(10_000);
    assert.equal(runs, 5, 'and back on its interval');
    stop();
    mock.timers.tick(60_000);
    assert.equal(runs, 5, 'stopped');
  } finally {
    setVisibility('visible');
    mock.timers.reset();
  }
});

test('pollEvery: a brief switch away does not cause an extra fetch', () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 });
  try {
    let runs = 0;
    const stop = pollEvery(10_000, () => runs++);
    mock.timers.tick(2_000);
    setVisibility('hidden');
    setVisibility('visible');
    assert.equal(runs, 0, 'no tick was missed, nothing to catch up');
    stop();
  } finally {
    mock.timers.reset();
  }
});

test('pollWhileShown: on its interval while visible, never while hidden, and once at once when the visitor comes back', () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 });
  try {
    let runs = 0;
    const stop = pollWhileShown(60_000, () => runs++);
    mock.timers.tick(120_000);
    assert.equal(runs, 2, 'every minute while visible');
    setVisibility('hidden');
    mock.timers.tick(600_000);
    assert.equal(runs, 2, 'nothing for a hidden tab');
    setVisibility('visible');
    assert.equal(runs, 3, 'at once on return - once, though the tab was shown and the window focused');
    focusWindow();
    assert.equal(runs, 3);
    // Away briefly (no tick missed): coming back still reads, past the gap.
    mock.timers.tick(20_000);
    setVisibility('hidden');
    setVisibility('visible');
    assert.equal(runs, 4, 'back after 20 s: read at once, not at the next minute');
    mock.timers.tick(2_000);
    focusWindow();
    assert.equal(runs, 4, 'not more often than every 5 s');
    mock.timers.tick(5_000);
    focusWindow();
    assert.equal(runs, 5, 'the window focused (another browser window)');
    stop();
    focusWindow();
    setVisibility('hidden');
    setVisibility('visible');
    mock.timers.tick(600_000);
    assert.equal(runs, 5, 'stopped: no interval, no focus');
    assert.equal(winListeners.get('focus')?.size ?? 0, 0);
  } finally {
    setVisibility('visible');
    mock.timers.reset();
  }
});

test('visibleTimeout: a retry scheduled for a hidden tab fires when it is shown', () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 });
  try {
    let fired = 0;
    setVisibility('hidden');
    visibleTimeout(5_000, () => fired++);
    mock.timers.tick(20_000);
    assert.equal(fired, 0);
    setVisibility('visible');
    assert.equal(fired, 1);
    const cancel = visibleTimeout(5_000, () => fired++);
    cancel();
    mock.timers.tick(10_000);
    assert.equal(fired, 1, 'cancelled');
  } finally {
    setVisibility('visible');
    mock.timers.reset();
  }
});

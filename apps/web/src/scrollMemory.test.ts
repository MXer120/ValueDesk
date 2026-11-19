/**
 * The one scroll manager (scrollMemory.ts): a pushed page at its top, Back to the entry's own offset once the page
 * is tall enough, the user's input ending a wait, offsets kept over a reload.
 * Run (from apps/web): npx tsx --test src/scrollMemory.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESTORE_MS, createScrollMemory, type ScrollEnv } from './scrollMemory';

function rig(stored: Record<string, number> = {}) {
  const el = { scrollTop: 0, scrollHeight: 3000, clientHeight: 700 };
  let key = 'a';
  let t = 0;
  let frames: Array<() => void> = [];
  const anchors: boolean[] = [];
  let saved: Record<string, number> = {};
  const env: ScrollEnv = {
    key: () => key,
    el: () => el,
    raf: (fn) => { frames.push(fn); return frames.length; },
    caf: () => { frames = []; },
    anchor: (on) => anchors.push(on),
    now: () => t,
    load: () => stored,
    save: (s) => { saved = s; },
  };
  const m = createScrollMemory(env);
  const frame = (ms = 16) => {
    t += ms;
    const run = frames;
    frames = [];
    run.forEach((f) => f());
  };
  // A scroll event: what the browser dispatches after scrollTop moved.
  const scrollTo = (y: number) => { el.scrollTop = y; m.scrolled(); };
  return { m, el, frame, scrollTo, anchors, go: (k: string) => { key = k; }, saved: () => saved, pending: () => frames.length };
}

test('a pushed page opens at its top; each entry keeps its own offset', () => {
  const r = rig();
  r.scrollTo(900);
  r.m.pushed();
  r.go('b');
  assert.equal(r.m.takeKind(), 'push');
  r.m.top();
  r.m.scrolled();
  assert.equal(r.el.scrollTop, 0);
  assert.equal(r.m.saved('a'), 900);
  assert.equal(r.m.saved('b'), 0);
});

test('Back restores the entry once its page is tall enough, and the page swap in between is not recorded', () => {
  const r = rig();
  r.scrollTo(1800);
  r.m.pushed();
  r.go('b');
  r.m.top();
  r.scrollTo(200);
  // Back: the entry changes, the new page is short at first (its list still loading).
  r.go('a');
  r.m.popped();
  r.el.scrollHeight = 1200;
  r.scrollTo(500); // the browser clamping while the pages swap
  assert.equal(r.m.saved('a'), 1800, 'held while the restore owns the scroller');
  r.m.restore();
  r.frame();
  assert.equal(r.el.scrollTop, 500, 'as far as the short page goes');
  r.el.scrollHeight = 4000; // the list landed
  r.frame();
  assert.equal(r.el.scrollTop, 1800);
  assert.equal(r.pending(), 0, 'done');
  assert.equal(r.m.takeKind(), 'pop');
  assert.deepEqual(r.anchors, [false], 'scroll anchoring is off while the page builds up');
});

test('the user scrolling ends a restore still waiting, and their offset counts', () => {
  const r = rig();
  r.scrollTo(2500);
  r.m.pushed();
  r.go('b');
  r.go('a');
  r.m.popped();
  r.el.scrollHeight = 900;
  r.m.restore();
  r.frame();
  r.m.input();
  assert.equal(r.pending(), 0);
  assert.deepEqual(r.anchors, [false, true], 'anchoring back on');
  r.scrollTo(100);
  assert.equal(r.m.saved('a'), 100);
});

test('a page that never gets tall enough stops waiting after RESTORE_MS and keeps the old offset', () => {
  const r = rig();
  r.scrollTo(2000);
  r.go('b');
  r.go('a');
  r.m.popped();
  r.el.scrollHeight = 1000;
  r.m.restore();
  for (let i = 0; i < Math.ceil(RESTORE_MS / 16) + 5; i++) r.frame();
  assert.equal(r.pending(), 0);
  r.scrollTo(300); // e.g. the browser's clamp
  assert.equal(r.m.saved('a'), 2000, 'not overwritten until the user scrolls');
});

test('kept over a reload', () => {
  const r = rig({ a: 640, x: 'bad' as unknown as number });
  assert.equal(r.m.saved('a'), 640);
  assert.equal(r.m.saved('x'), undefined);
  r.m.restore();
  r.frame();
  assert.equal(r.el.scrollTop, 640);
  r.scrollTo(700);
  r.m.persist();
  assert.equal(r.saved().a, 700);
});

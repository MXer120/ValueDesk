/**
 *   npx tsx --test src/startLater.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startLater, startLaterEnv } from './startLater';

interface Timer { id: number; fn: () => void; ms: number; cleared: boolean }
let timers: Timer[] = [];
let idles: Array<{ cb: () => void; timeout: number | undefined }> = [];
let hasIdle = true;

beforeEach(() => {
  timers = [];
  idles = [];
  hasIdle = true;
  startLaterEnv.setTimeout = (fn, ms) => {
    const t = { id: timers.length + 1, fn, ms, cleared: false };
    timers.push(t);
    return t.id;
  };
  startLaterEnv.clearTimeout = (id) => {
    const t = timers.find((x) => x.id === id);
    if (t) t.cleared = true;
  };
  startLaterEnv.idle = () => (hasIdle ? (cb, opts) => { idles.push({ cb, timeout: opts?.timeout }); } : undefined);
});

/** Fire the pending timers that were not cleared. */
const fire = () => { for (const t of timers.splice(0)) if (!t.cleared) t.fn(); };

test('armed: nothing runs until the delay has passed AND the thread is idle', () => {
  let runs = 0;
  const later = startLater(() => { runs++; }, 2_000, 1_000);
  assert.equal(timers.length, 0, 'creating it schedules nothing');
  later.arm();
  assert.deepEqual(timers.map((t) => t.ms), [2_000]);
  assert.equal(runs, 0);
  fire();
  assert.equal(runs, 0, 'the delay passed: now it waits for an idle moment');
  assert.deepEqual(idles.map((i) => i.timeout), [1_000], 'at most this much longer');
  idles[0]!.cb();
  assert.equal(runs, 1);
});

test('now(): at once, exactly once, and the schedule is dropped', () => {
  let runs = 0;
  const later = startLater(() => { runs++; }, 2_000, 1_000);
  later.arm();
  later.now();
  assert.equal(runs, 1);
  assert.equal(timers[0]!.cleared, true);
  fire();
  later.now();
  later.arm();
  assert.equal(runs, 1);
  assert.equal(timers.length, 0, 'and nothing is scheduled again');
});

test('now() between the delay and the idle moment: the idle callback does nothing more', () => {
  let runs = 0;
  const later = startLater(() => { runs++; }, 2_000, 1_000);
  later.arm();
  fire();
  later.now();
  assert.equal(runs, 1);
  idles[0]!.cb();
  assert.equal(runs, 1);
});

test('arm() twice schedules once; without requestIdleCallback the delay alone decides', () => {
  let runs = 0;
  hasIdle = false;
  const later = startLater(() => { runs++; }, 500, 1_000);
  later.arm();
  later.arm();
  assert.equal(timers.length, 1);
  fire();
  assert.equal(runs, 1);
  assert.equal(idles.length, 0);
});

test('now() without arm() works too', () => {
  let runs = 0;
  const later = startLater(() => { runs++; }, 500, 1_000);
  later.now();
  assert.equal(runs, 1);
  assert.equal(timers.length, 0);
});

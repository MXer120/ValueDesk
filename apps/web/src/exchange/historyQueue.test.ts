/**
 * Who gets the next history read (historyQueue.ts): the table on screen takes
 * any free slot; background readers only an idle drip, a minute after the last
 * visible demand in any tab; a hidden tab has nothing visible; within a tab a
 * lower priority never jumps ahead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HistoryQueue, STARTUP_GRACE_MS, VISIBLE_QUIET_MS } from './historyQueue';
import { SharedLedger, type KeyValueStore } from './ledger';

const WINDOW = 60_000;

function memStore(): KeyValueStore {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

/** Virtual time: `sleep` parks on a timer; `until` runs what can run, then jumps to the next timer. */
function virtualTime(start: number) {
  const timers: Array<{ at: number; fire: () => void }> = [];
  const clock = { t: start };
  const sleep = (ms: number) => new Promise<void>((fire) => void timers.push({ at: clock.t + Math.max(0, ms), fire }));
  async function until<T>(p: Promise<T>): Promise<T> {
    let settled = false;
    const out = p.finally(() => void (settled = true));
    out.catch(() => undefined);
    for (let guard = 0; !settled; guard++) {
      if (guard > 100_000) throw new Error('virtual time: runaway');
      await new Promise((r) => setImmediate(r));
      if (settled || timers.length === 0) continue;
      timers.sort((a, b) => a.at - b.at);
      const next = timers.shift()!;
      clock.t = Math.max(clock.t, next.at);
      next.fire();
    }
    return out;
  }
  return { clock, sleep, until };
}

function world(start = 1_000_000) {
  const vt = virtualTime(start);
  const store = memStore();
  const tab = (hidden = () => false) => {
    const deps = { store, locks: null, now: () => vt.clock.t, sleep: vt.sleep };
    const drip = new SharedLedger('sodex-history', 2, WINDOW, deps);
    return new HistoryQueue({ drip, store, now: deps.now, sleep: deps.sleep, hidden });
  };
  /** Start a read; record the virtual time it got its slot. */
  const read = (q: HistoryQueue, priority: 'visible' | 'background' | 'walk', log: Array<[string, number]>, label: string) =>
    q.take(priority, 10 * WINDOW).then(() => void log.push([label, vt.clock.t]));
  return { vt, tab, read };
}

test('history queue: reads for the table on screen take the free slots at once; the next waits for the window', async () => {
  const { vt, tab, read } = world();
  const q = tab();
  const got: Array<[string, number]> = [];
  const t0 = vt.clock.t;
  await vt.until(Promise.all([read(q, 'visible', got, 'a'), read(q, 'visible', got, 'b'), read(q, 'visible', got, 'c')]));
  const at = Object.fromEntries(got);
  assert.equal(at.a, t0);
  assert.equal(at.b, t0);
  assert.ok(at.c! >= t0 + WINDOW, 'the third waits for the oldest to leave the minute');
});

test('history queue: a visible read that arrives later still goes before a waiting background one', async () => {
  const { vt, tab, read } = world();
  const q = tab();
  const got: Array<[string, number]> = [];
  const t0 = vt.clock.t;
  await vt.until(Promise.all([read(q, 'visible', got, 'v1'), read(q, 'visible', got, 'v2')])); // the drip is full
  const bg = read(q, 'background', got, 'bg');
  await vt.until(vt.sleep(1_000));
  const v3 = read(q, 'visible', got, 'v3');
  await vt.until(Promise.all([bg, v3]));
  const order = got.map(([l]) => l);
  assert.deepEqual(order.slice(2), ['v3', 'bg'], 'the table on screen first');
  const at = Object.fromEntries(got);
  assert.ok(at.v3! >= t0 + WINDOW && at.v3! < t0 + WINDOW + 2_000, 'the visible read took the first slot that freed');
  assert.ok(at.bg! >= at.v3! + VISIBLE_QUIET_MS, 'background waits a quiet minute after visible demand');
});

test('history queue: background reads go on an idle drip when no tab has wanted history for a minute', async () => {
  const { vt, tab, read } = world();
  const q = tab();
  const got: Array<[string, number]> = [];
  const t0 = vt.clock.t;
  await vt.until(read(q, 'background', got, 'bg'));
  assert.ok(got[0]![1] >= t0 + STARTUP_GRACE_MS && got[0]![1] < t0 + STARTUP_GRACE_MS + 1_000, 'once the page has been open a while: its first seconds belong to the tables the user opens');
  // With one slot taken the drip is not idle: the next background read waits for it to clear.
  await vt.until(read(q, 'walk', got, 'walk'));
  assert.ok(got[1]![1] >= got[0]![1] + WINDOW, 'background leaves the second slot to the table on screen');
});

test('history queue: a hidden tab has nothing on screen - its visible reads wait like background ones', async () => {
  const { vt, tab, read } = world();
  let hidden = true;
  const q = tab(() => hidden);
  const shown = tab();
  const got: Array<[string, number]> = [];
  const t0 = vt.clock.t;
  await vt.until(read(shown, 'visible', got, 'other tab')); // visible demand, one slot left
  const p = read(q, 'visible', got, 'hidden tab');
  await vt.until(vt.sleep(20_000));
  assert.equal(got.length, 1, 'not while it is hidden and another tab shows history');
  hidden = false;
  await vt.until(p);
  assert.ok(got[1]![1] >= t0 + 20_000 && got[1]![1] < t0 + 21_000, 'shown again: it takes the free slot at once');
});

test('history queue: a visible read waiting in one tab holds back every tab\'s background reads', async () => {
  const { vt, tab, read } = world();
  const a = tab();
  const b = tab();
  const got: Array<[string, number]> = [];
  await vt.until(Promise.all([read(a, 'visible', got, 'a1'), read(a, 'visible', got, 'a2')])); // full
  const waitingVisible = read(a, 'visible', got, 'a3');
  const otherTabBackground = read(b, 'background', got, 'b-bg');
  await vt.until(Promise.all([waitingVisible, otherTabBackground]));
  assert.deepEqual(got.map(([l]) => l), ['a1', 'a2', 'a3', 'b-bg']);
});

test('history queue: never two background reads at once - one takes the idle drip, the next waits for it to clear', async () => {
  const { vt, tab, read } = world();
  const a = tab();
  const b = tab();
  const got: Array<[string, number]> = [];
  // Two streams of the index walk in one tab, and another tab's walk, all waiting for the idle drip.
  await vt.until(Promise.all([read(a, 'background', got, 'a1'), read(a, 'background', got, 'a2'), read(b, 'walk', got, 'b')]));
  const at = got.map(([, t]) => t).sort((x, y) => x - y);
  assert.ok(at[1]! - at[0]! >= WINDOW, 'the second waited a full window');
  assert.ok(at[2]! - at[1]! >= WINDOW, 'and so did the third');
});

/** One tab with its drip in reach (the tests below look at what was taken). */
function oneTab(start = 1_000_000) {
  const vt = virtualTime(start);
  const store = memStore();
  const deps = { store, locks: null, now: () => vt.clock.t, sleep: vt.sleep };
  const drip = new SharedLedger('sodex-history', 2, WINDOW, deps);
  const q = new HistoryQueue({ drip, store, now: deps.now, sleep: deps.sleep, hidden: () => false });
  return { vt, drip, q };
}

test('history queue: a read held by a cooldown takes no slot, and goes when the cooldown is over', async () => {
  const { vt, drip, q } = oneTab();
  const t0 = vt.clock.t;
  const coolUntil = t0 + 5_000;
  let sentAt = 0;
  const held = q.take('visible', 10 * WINDOW, undefined, () => Math.max(0, coolUntil - vt.clock.t)).then(() => void (sentAt = vt.clock.t));
  await vt.until(vt.sleep(3_000));
  assert.equal(drip.spent(), 0, 'held: nothing taken');
  await vt.until(held);
  assert.ok(sentAt >= coolUntil && sentAt < coolUntil + 1_000, 'at the end of the cooldown');
  assert.equal(drip.spent(), 1);
});

test('history queue: a hold that gives up ends the wait with its error, without a slot', async () => {
  const { vt, drip, q } = oneTab();
  await vt.until(Promise.all([q.take('visible', 10 * WINDOW), q.take('visible', 10 * WINDOW)])); // the drip is full
  const t0 = vt.clock.t;
  let closed = false;
  const outcome = q.take('visible', 10 * WINDOW, undefined, () => {
    if (closed) throw new Error('history is closed');
    return 0;
  }).then(() => 'sent', (e) => (e as Error).message);
  await vt.until(vt.sleep(4_000));
  closed = true; // a refusal elsewhere, while this read waited for its slot
  assert.equal(await vt.until(outcome), 'history is closed');
  assert.ok(vt.clock.t - t0 < 6_000, 'at its next look - not when the slot would have come');
  assert.equal(drip.spent(), 2);
  assert.equal(q.pending().visible, 0);
});

test('history queue: a reader that leaves ends its wait at once, without a slot', async () => {
  const { vt, drip, q } = oneTab();
  await vt.until(Promise.all([q.take('visible', 10 * WINDOW), q.take('visible', 10 * WINDOW)])); // the drip is full
  const t0 = vt.clock.t;
  const ctl = new AbortController();
  const outcome = q.take('visible', 10 * WINDOW, ctl.signal).then(() => 'sent', (e) => (e as Error).name);
  await vt.until(vt.sleep(2_500));
  assert.equal(q.pending().visible, 1);
  ctl.abort();
  assert.equal(await vt.until(outcome), 'AbortError');
  assert.equal(vt.clock.t, t0 + 2_500, 'no timer had to fire: its place is free for the table shown now');
  assert.equal(q.pending().visible, 0);
  assert.equal(drip.spent(), 2);
});

test('history queue: a table goes before a view\'s many pages that asked first; those still go before background readers', async () => {
  const { vt, q } = oneTab();
  const got: Array<[string, number]> = [];
  const take = (p: 'visible' | 'bulk' | 'background', label: string) => q.take(p, 10 * WINDOW).then(() => void got.push([label, vt.clock.t]));
  const t0 = vt.clock.t;
  // A scanned wallet's fills: two pages take the free slots at once (no idle drip, no quiet minute needed).
  await vt.until(Promise.all([take('bulk', 'fills-1'), take('bulk', 'fills-2')]));
  assert.deepEqual(got.map(([, t]) => t), [t0, t0]);
  const waiting = [take('bulk', 'fills-3'), take('background', 'index')];
  await vt.until(vt.sleep(5_000));
  assert.deepEqual(q.pending(), { visible: 0, bulk: 1, background: 1, walk: 0 });
  const table = take('visible', 'table'); // a history table, opened 5 s later
  await vt.until(Promise.all([...waiting, table]));
  assert.deepEqual(got.map(([l]) => l).slice(2), ['table', 'fills-3', 'index']);
  const at = Object.fromEntries(got);
  assert.ok(at.table! >= t0 + WINDOW && at.table! < t0 + WINDOW + 2_000, 'the table took the first slot that freed');
  assert.ok(at['fills-3']! < at.table! + 2_000, 'the page took the other');
  assert.ok(at.index! >= at['fills-3']! + VISIBLE_QUIET_MS, 'background only after a quiet minute');
});

test('history queue: from a hidden tab a view\'s pages wait like background ones', async () => {
  const vt = virtualTime(1_000_000);
  const store = memStore();
  const deps = { store, locks: null, now: () => vt.clock.t, sleep: vt.sleep };
  const drip = new SharedLedger('sodex-history', 2, WINDOW, deps);
  let hidden = true;
  const q = new HistoryQueue({ drip, store, now: deps.now, sleep: deps.sleep, hidden: () => hidden });
  const t0 = vt.clock.t;
  let at = 0;
  const p = q.take('bulk', 10 * WINDOW).then(() => void (at = vt.clock.t));
  await vt.until(vt.sleep(5_000));
  assert.deepEqual(q.pending(), { visible: 0, bulk: 0, background: 1, walk: 0 });
  assert.equal(at, 0, 'not in the first seconds after a page load, like any background read');
  hidden = false;
  await vt.until(p);
  assert.ok(at >= t0 + 5_000 && at < t0 + 6_000, 'shown again: the free slot at once');
});

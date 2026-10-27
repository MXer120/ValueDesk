/** One poll per resource, at the shortest interval any reader wants (sharedPoll.ts). */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// A document stand-in, installed before visibility.ts first looks for one.
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

const { subscribeShared, refreshShared, peekShared, _resetSharedPoll } = await import('./sharedPoll');

/** A loader that counts its reads and answers at once. */
function counter() {
  let n = 0;
  return {
    load: () => Promise.resolve(++n),
    get reads() {
      return n;
    },
  };
}

/** Let the answered reads settle (their .then / .finally). */
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function withTimers(fn: () => Promise<void>) {
  return async () => {
    mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1_000_000 });
    try {
      await fn();
    } finally {
      _resetSharedPoll();
      setVisibility('visible');
      mock.timers.reset();
    }
  };
}

test('three readers of one resource cost one read per interval', withTimers(async () => {
  const c = counter();
  const seen: Array<number | null> = [];
  const offs = [0, 1, 2].map(() => subscribeShared('t', c.load, 30_000, (s) => seen.push(s.data)));
  await settle();
  assert.equal(c.reads, 1, 'the second and third reader take the first one\'s read');
  mock.timers.tick(30_000);
  await settle();
  assert.equal(c.reads, 2);
  for (let i = 0; i < 3; i++) {
    mock.timers.tick(30_000);
    await settle();
  }
  assert.equal(c.reads, 5, 'one read every 30 s, not three');
  assert.equal(seen.at(-1), 5, 'every reader got the newest answer');
  offs.forEach((off) => off());
  mock.timers.tick(120_000);
  await settle();
  assert.equal(c.reads, 5, 'nothing is read once every reader has gone');
  assert.equal(peekShared('t'), 5, 'the last answer is kept');
}));

test('the poll runs at the fastest reader\'s interval, and slows when it leaves', withTimers(async () => {
  const c = counter();
  const slow = subscribeShared('t', c.load, 30_000, () => {});
  await settle();
  assert.equal(c.reads, 1);
  mock.timers.tick(5_000);
  // A 15 s reader arrives on a 5 s old answer (younger than half its interval): no read now.
  const fast = subscribeShared('t', c.load, 15_000, () => {});
  await settle();
  assert.equal(c.reads, 1, 'a fresh enough answer is shared, not read again');
  mock.timers.tick(10_000);
  await settle();
  assert.equal(c.reads, 2, 'due 15 s after the last read started, for the fast reader');
  mock.timers.tick(15_000);
  await settle();
  assert.equal(c.reads, 3);
  // The fast reader leaves 10 s after a read: the next one is 30 s after THAT read, not 30 s from now.
  mock.timers.tick(10_000);
  fast();
  mock.timers.tick(19_999);
  await settle();
  assert.equal(c.reads, 3);
  mock.timers.tick(1);
  await settle();
  assert.equal(c.reads, 4, 'the slow reader\'s answer is never older than its own interval');
  slow();
}));

test('a newcomer on an answer older than half its interval reads at once', withTimers(async () => {
  const c = counter();
  const a = subscribeShared('t', c.load, 30_000, () => {});
  await settle();
  mock.timers.tick(20_000);
  let got: number | null = null;
  const b = subscribeShared<number>('t', c.load, 30_000, (s) => (got = s.data));
  assert.equal(got, 1, 'it paints the kept answer at once');
  await settle();
  assert.equal(c.reads, 2, 'and reads again: 20 s is past half of its 30 s');
  assert.equal(got, 2);
  a();
  b();
}));

test('nothing is read while the tab is hidden; a missed read runs when it is shown', withTimers(async () => {
  const c = counter();
  const off = subscribeShared('t', c.load, 10_000, () => {});
  await settle();
  setVisibility('hidden');
  for (let i = 0; i < 6; i++) {
    mock.timers.tick(10_000);
    await settle();
  }
  await settle();
  assert.equal(c.reads, 1, 'no reads for a hidden tab');
  setVisibility('visible');
  await settle();
  assert.equal(c.reads, 2, 'caught up the moment the tab is shown');
  mock.timers.tick(10_000);
  await settle();
  assert.equal(c.reads, 3, 'and back on its interval');
  off();
}));

test('a failed read keeps the last answer, says why, and is tried again on the interval', withTimers(async () => {
  let fail = false;
  let n = 0;
  const load = () => (fail ? Promise.reject(new Error('down')) : Promise.resolve(++n));
  const states: Array<{ data: number | null; error: string | null }> = [];
  const off = subscribeShared<number>('t', load, 10_000, (s) => states.push({ data: s.data, error: s.error }));
  await settle();
  fail = true;
  mock.timers.tick(10_000);
  await settle();
  assert.deepEqual(states.at(-1), { data: 1, error: 'down' });
  fail = false;
  mock.timers.tick(10_000);
  await settle();
  assert.deepEqual(states.at(-1), { data: 2, error: null });
  off();
}));

test('refresh reads now, shared with a read already on its way', withTimers(async () => {
  let n = 0;
  let release: (() => void) | null = null;
  const load = () => new Promise<number>((r) => (release = () => r(++n)));
  const off = subscribeShared('t', load, 30_000, () => {});
  refreshShared('t');
  refreshShared('t');
  assert.equal(n, 0);
  release!();
  await settle();
  assert.equal(n, 1, 'one read, not three');
  refreshShared('t');
  release!();
  await settle();
  assert.equal(n, 2, 'a Retry after it reads again');
  off();
}));

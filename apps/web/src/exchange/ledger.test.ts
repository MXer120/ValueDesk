/**
 * The per-IP budgets every tab shares (ledger.ts): a sliding-window budget and
 * per-endpoint cooldowns, over one store that two "tabs" (two instances) see.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BudgetWaitError, SharedCooldowns, SharedLedger, type KeyValueStore, type LedgerDeps } from './ledger';

function memStore(): KeyValueStore {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

/** A clock that only moves when something sleeps. */
function fakeDeps(store: KeyValueStore = memStore()): LedgerDeps & { clock: { t: number }; slept: number[] } {
  const clock = { t: 1_000_000 };
  const slept: number[] = [];
  return {
    store,
    locks: null,
    now: () => clock.t,
    sleep: async (ms) => {
      slept.push(ms);
      clock.t += ms;
    },
    clock,
    slept,
  };
}

test('ledger: records up to the limit at once, then waits for the window to free exactly enough', async () => {
  const d = fakeDeps();
  const t0 = d.clock.t;
  const l = new SharedLedger('t', 10, 60_000, d);
  await l.take(4);
  d.clock.t += 10_000;
  await l.take(6);
  assert.equal(l.spent(), 10);
  assert.equal(d.slept.length, 0, 'within the budget: no wait');
  d.clock.t += 10_000;
  await l.take(3, 60_000); // the 4 taken at t0 must leave the window first (a 40 s wait)
  assert.ok(d.slept.length > 0, 'it waited');
  assert.ok(d.clock.t >= t0 + 60_000, 'until the oldest entry expired');
  assert.ok(d.clock.t < t0 + 70_000, 'and no longer than that');
  assert.equal(l.spent(), 9, '6 + 3 in the window now');
});

test('ledger: two tabs (two instances, one store) spend ONE budget', async () => {
  const store = memStore();
  const a = fakeDeps(store);
  const b: LedgerDeps = { store, locks: null, now: a.now, sleep: a.sleep };
  const tabA = new SharedLedger('gw', 1200, 60_000, a);
  const tabB = new SharedLedger('gw', 1200, 60_000, b);
  await tabA.take(700);
  assert.equal(await tabB.tryTake(600), 60_000, "tab B sees tab A's spend and must wait for it to leave the window");
  assert.equal(await tabB.tryTake(500), 0, "what is left is B's to take");
  assert.equal(tabA.spent(), 1200);
});

test('ledger: a wait longer than the caller allows is refused, not queued forever', async () => {
  const d = fakeDeps();
  const l = new SharedLedger('drip', 4, 30_000, d);
  for (let i = 0; i < 4; i++) await l.take(1);
  await assert.rejects(l.take(1, 5_000), BudgetWaitError);
  // With enough patience it goes through once the window frees.
  await l.take(1, 60_000);
  assert.equal(l.spent(), 1, 'the four early ones left the window');
});

test('ledger: the history drip never lets a 5th request into any 30 s window', async () => {
  const d = fakeDeps();
  const drip = new SharedLedger('trades', 4, 30_000, d);
  const at: number[] = [];
  for (let i = 0; i < 12; i++) {
    await drip.take(1, 120_000);
    at.push(d.clock.t);
  }
  for (let i = 4; i < at.length; i++) assert.ok(at[i]! - at[i - 4]! >= 30_000, `request ${i} is at least 30 s after request ${i - 4}`);
});

test('ledger: a budget with no storage still works for the tab it lives in', async () => {
  const d = { ...fakeDeps(), store: null };
  const l = new SharedLedger('x', 2, 1_000, d);
  await l.take(1);
  await l.take(1);
  assert.ok((await l.tryTake(1)) > 0);
});

test('cooldowns: 15 s, doubling while rate limits continue, capped, cleared by a success - for every tab', () => {
  const store = memStore();
  const d = fakeDeps(store);
  const tab1 = new SharedCooldowns('gw', 15_000, 300_000, d);
  const tab2 = new SharedCooldowns('gw', 15_000, 300_000, { ...d });
  assert.equal(tab1.left('/trades'), 0);
  assert.equal(tab1.hit('/trades'), 15_000);
  assert.equal(tab2.left('/trades'), 15_000, 'the other tab sees the cooldown');
  assert.equal(tab2.hit('/trades'), 30_000, 'a second 429 doubles it');
  assert.equal(tab1.hit('/trades'), 60_000);
  for (let i = 0; i < 10; i++) tab1.hit('/trades');
  assert.equal(tab1.left('/trades'), 300_000, 'capped at 5 min');
  assert.equal(tab1.left('/orders/history'), 0, 'per endpoint');
  tab2.clear('/trades');
  assert.equal(tab1.left('/trades'), 0);
  assert.equal(tab1.hit('/trades'), 15_000, 'after a success the doubling starts over');
});

test('ledger: a non-atomic budget never waits for the lock, and still counts every tab', async () => {
  const store = memStore();
  let lockCalls = 0;
  const locks = { request: async <T>(_n: string, cb: () => Promise<T> | T) => { lockCalls++; return cb(); } };
  const deps = { store, locks, now: () => 1_000, sleep: async () => {} };
  const a = new SharedLedger('budget', 10, 60_000, deps, false);
  const b = new SharedLedger('budget', 10, 60_000, deps, false);
  await a.take(4);
  await b.take(4);
  assert.equal(lockCalls, 0, 'without the lock');
  assert.equal(a.spent(), 8, 'both tabs are counted');
  assert.equal(await b.tryTake(4), 60_000, 'and the budget still holds');
});

test('ledger: tryTakeIdle records only on an empty window', async () => {
  const d = fakeDeps();
  const l = new SharedLedger('drip', 2, 60_000, d);
  assert.equal(await l.tryTakeIdle(1), 0);
  assert.equal(await l.tryTakeIdle(1), 60_000, 'one entry in the window: not idle, although a slot is free');
  assert.equal(await l.tryTake(1), 0, 'a normal take still gets the free slot');
  d.clock.t += 60_000;
  assert.equal(await l.tryTakeIdle(1), 0, 'idle again once the window is clear');
});

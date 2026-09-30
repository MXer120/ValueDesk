/**
 * Nonce manager: monotone per key, unique across "tabs", window-enforced.
 *
 * Node 24 ships Web Locks (navigator.locks) and BroadcastChannel, so two
 * managers in one process behave like two tabs of one origin: they share the
 * lock manager and the channel, and (optionally) a fake localStorage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DAY_MS } from '../src/keys.ts';
import {
  NonceWindowError,
  assertNonceInWindow,
  createMemoryNonceManager,
  createNonceManager,
  nonceKey,
  nonceWindowProblem,
  type KeyValueStore,
  type LockManagerLike,
} from '../src/nonce.ts';

const KEY = nonceKey('0xAbC0000000000000000000000000000000000001', 286623);
const T0 = 1_760_000_000_000;

class MemStore implements KeyValueStore {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

class BrokenStore implements KeyValueStore {
  getItem(): string | null {
    throw new Error('SecurityError');
  }
  setItem(): void {
    throw new Error('QuotaExceededError');
  }
  removeItem(): void {
    throw new Error('SecurityError');
  }
}

const locks = (globalThis as unknown as { navigator: { locks: LockManagerLike } }).navigator.locks;
const tick = () => new Promise((r) => setTimeout(r, 0));

test('nonceKey is per network and case-insensitive', () => {
  assert.equal(KEY, '286623:0xabc0000000000000000000000000000000000001');
  assert.notEqual(nonceKey('0xabc', 286623), nonceKey('0xabc', 138565));
});

test('window: (now - 2d, now + 1d), shrunk by the margin', () => {
  assert.equal(nonceWindowProblem(T0, T0), null);
  assert.match(nonceWindowProblem(T0 - 2 * DAY_MS, T0, 0)!, /behind/);
  assert.equal(nonceWindowProblem(T0 - 2 * DAY_MS + 1, T0, 0), null);
  assert.match(nonceWindowProblem(T0 + DAY_MS, T0, 0)!, /ahead/);
  assert.equal(nonceWindowProblem(T0 + DAY_MS - 1, T0, 0), null);
  assert.match(nonceWindowProblem(T0 + DAY_MS - 1, T0)!, /ahead/, 'default margin is 60 s');
  assert.throws(() => assertNonceInWindow(1n, T0), NonceWindowError);
});

test('memory manager: strictly increasing even with a frozen clock and concurrent callers', async () => {
  const m = createMemoryNonceManager({ now: () => T0, maxFenceWaitMs: 0 });
  const got = await Promise.all(Array.from({ length: 50 }, () => m.next(KEY)));
  const sorted = [...got].sort((a, b) => (a < b ? -1 : 1));
  assert.deepEqual(got, sorted, 'allocation order is call order');
  assert.equal(new Set(got.map(String)).size, 50);
  assert.equal(got[0], BigInt(T0));
  assert.equal(got[49], BigInt(T0 + 49));
  assert.equal(m.crossTab, false);
});

test('keys are independent', async () => {
  const m = createMemoryNonceManager({ now: () => T0, maxFenceWaitMs: 0 });
  assert.equal(await m.next('a'), BigInt(T0));
  assert.equal(await m.next('b'), BigInt(T0));
  assert.equal(await m.next('a'), BigInt(T0 + 1));
});

test('clock stepping BACKWARDS never repeats or decreases a nonce', async () => {
  let t = T0;
  const m = createMemoryNonceManager({ now: () => t, maxFenceWaitMs: 0 });
  const a = await m.next(KEY);
  t = T0 - 5_000;
  const b = await m.next(KEY);
  assert.ok(b > a);
});

test('clockOffsetMs corrects a skewed local clock', async () => {
  const m = createMemoryNonceManager({ now: () => T0, clockOffsetMs: -420, maxFenceWaitMs: 0 });
  assert.equal(await m.next(KEY), BigInt(T0 - 420));
});

test('a high-water mark more than a day ahead is refused, and reset() recovers', async () => {
  const store = new MemStore();
  store.setItem(`sodex-core.nonce:${KEY}`, String(T0 + 2 * DAY_MS));
  const m = createNonceManager({ now: () => T0, storage: store, channel: null, locks: null, maxFenceWaitMs: 0 });
  await assert.rejects(m.next(KEY), NonceWindowError);
  m.reset(KEY);
  assert.equal(await m.next(KEY), BigInt(T0));
});

test('withNonce holds the lock: nothing else allocates until fn settles', async () => {
  const m = createMemoryNonceManager({ now: () => T0, maxFenceWaitMs: 0 });
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const first = m.withNonce(KEY, async (n) => {
    order.push(`start ${n}`);
    await gate;
    order.push(`end ${n}`);
    return n;
  });
  const second = m.next(KEY).then((n) => {
    order.push(`next ${n}`);
    return n;
  });
  await tick();
  assert.deepEqual(order, [`start ${T0}`]);
  release();
  assert.equal(await first, BigInt(T0));
  assert.equal(await second, BigInt(T0 + 1));
  assert.deepEqual(order, [`start ${T0}`, `end ${T0}`, `next ${T0 + 1}`]);
});

test('a throwing fn inside withNonce does not wedge the key', async () => {
  const m = createMemoryNonceManager({ now: () => T0, maxFenceWaitMs: 0 });
  await assert.rejects(m.withNonce(KEY, () => { throw new Error('boom'); }), /boom/);
  assert.equal(await m.next(KEY), BigInt(T0 + 1));
});

test('two "tabs" (real Web Locks + BroadcastChannel + shared storage): all nonces unique and increasing', async () => {
  const store = new MemStore();
  const ns = `test-${Math.random()}`;
  // Frozen clock: only the shared HWM can keep the tabs apart.
  const tabA = createNonceManager({ now: () => T0, storage: store, locks, namespace: ns, maxFenceWaitMs: 0 });
  const tabB = createNonceManager({ now: () => T0, storage: store, locks, namespace: ns, maxFenceWaitMs: 0 });
  assert.equal(tabA.crossTab, true);
  const all = await Promise.all(
    Array.from({ length: 40 }, (_, i) => (i % 2 ? tabA : tabB).next(KEY)),
  );
  assert.equal(new Set(all.map(String)).size, 40, 'no collisions');
  assert.equal(all.reduce((mx, n) => (n > mx ? n : mx), 0n), BigInt(T0 + 39));
  tabA.close();
  tabB.close();
});

test('two "tabs" with storage BLOCKED: the broadcast channel plus the clock fence keep them unique', async () => {
  const ns = `test-${Math.random()}`;
  // Real clock, real fence: storage throws on every call.
  const tabA = createNonceManager({ storage: new BrokenStore(), locks, namespace: ns });
  const tabB = createNonceManager({ storage: new BrokenStore(), locks, namespace: ns });
  const all = await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? tabA : tabB).next(KEY)));
  assert.equal(new Set(all.map(String)).size, 30, 'no collisions');
  tabA.close();
  tabB.close();
});

test('a broadcast from another tab raises this tab\'s high-water mark', async () => {
  const ns = `test-${Math.random()}`;
  const tabA = createNonceManager({ now: () => T0, storage: null, locks, namespace: ns, maxFenceWaitMs: 0 });
  const tabB = createNonceManager({ now: () => T0, storage: null, locks, namespace: ns, maxFenceWaitMs: 0 });
  await tabA.next(KEY);
  await tabA.next(KEY);
  for (let i = 0; i < 20 && tabB.highWater(KEY) === undefined; i++) await tick();
  assert.equal(tabB.highWater(KEY), BigInt(T0 + 1));
  assert.equal(await tabB.next(KEY), BigInt(T0 + 2));
  tabA.close();
  tabB.close();
});

test('the clock fence holds the lock until the clock passes the issued nonce', async () => {
  let t = T0;
  const slept: number[] = [];
  const m = createMemoryNonceManager({
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += 1;
    },
  });
  const a = await m.next(KEY);
  assert.equal(a, BigInt(T0));
  assert.ok(slept.length >= 1, 'waited for the clock');
  assert.ok(t > T0);
  const tAfterFence = t;
  const b = await m.next(KEY);
  // The next allocation starts from a clock already past `a`, so it needs no HWM bump.
  assert.equal(b, BigInt(tAfterFence));
  assert.ok(b > a);
});

test('a closed manager refuses to allocate', async () => {
  const m = createMemoryNonceManager({ now: () => T0 });
  m.close();
  await assert.rejects(m.next(KEY), /closed/);
});

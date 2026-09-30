import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { lazyPage, lazyPageEnv, reloadForChunkError } from './lazyPage';

/** An in-memory sessionStorage for the reload guard. */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => void m.delete(k),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
  };
}

let reloads = 0;
let clock = 1_000_000;
let storage = memoryStorage();
beforeEach(() => {
  reloads = 0;
  clock = 1_000_000;
  storage = memoryStorage();
  lazyPageEnv.reload = () => { reloads++; };
  lazyPageEnv.retryDelayMs = 0;
  lazyPageEnv.now = () => clock;
  lazyPageEnv.storage = () => storage;
});

const Hello = (p: { name: string }) => `hello ${p.name}` as unknown as JSX.Element;
const isThenable = (x: unknown): x is PromiseLike<unknown> => !!x && typeof (x as { then?: unknown }).then === 'function';

/** Render once: the element it returns, or what it threw. */
function render<P extends object>(Page: (p: P) => unknown, props: P): { el?: unknown; thrown?: unknown } {
  try {
    return { el: Page(props) };
  } catch (thrown) {
    return { thrown };
  }
}

test('suspends until loaded, then renders the page synchronously', async () => {
  let calls = 0;
  const Page = lazyPage('t', async () => { calls++; return Hello; });
  assert.equal(Page.ready, false);
  const first = render(Page, { name: 'a' });
  assert.ok(isThenable(first.thrown), 'the first render suspends');
  await first.thrown;
  assert.equal(Page.ready, true);
  const second = render(Page, { name: 'a' });
  assert.equal(second.thrown, undefined);
  assert.equal((second.el as { type: unknown }).type, Hello);
  assert.deepEqual((second.el as { props: unknown }).props, { name: 'a' });
  assert.equal(calls, 1);
});

test('preload is shared: one load however often it is asked for', async () => {
  let calls = 0;
  const Page = lazyPage('t', async () => { calls++; return Hello; });
  await Promise.all([Page.preload(), Page.preload(), Page.preload()]);
  await Page.preload();
  assert.equal(calls, 1);
  assert.equal(Page.ready, true);
  assert.ok(render(Page, { name: 'x' }).el, 'no suspension after a preload');
});

test('a failed load is retried once before giving up', async () => {
  let calls = 0;
  const Page = lazyPage('t', async () => {
    calls++;
    if (calls === 1) throw new Error('network');
    return Hello;
  });
  await Page.preload();
  assert.equal(calls, 2);
  assert.equal(Page.ready, true);
});

test('a prefetch that failed twice is tried again when asked again', async () => {
  let calls = 0;
  let fail = true;
  const Page = lazyPage('t', async () => {
    calls++;
    if (fail) throw new Error('offline');
    return Hello;
  });
  await assert.rejects(Page.preload(), /offline/);
  assert.equal(calls, 2);
  assert.equal(Page.ready, false);
  fail = false;
  await Page.preload();
  assert.equal(Page.ready, true);
  assert.equal(reloads, 0, 'a failed prefetch alone never reloads');
});

test('a render waiting on a load that fails reloads the page (once a minute at most)', async () => {
  const Page = lazyPage('t', async () => { throw new Error('stale chunk'); });
  const first = render(Page, { name: 'a' });
  assert.ok(isThenable(first.thrown));
  await first.thrown; // settles (the rejection is swallowed for Suspense)
  const second = render(Page, { name: 'a' });
  assert.equal(reloads, 1, 'reloaded to fetch the current build');
  assert.ok(isThenable(second.thrown), 'keeps suspending while the reload happens');

  // A second failure inside the window: no reload loop, the error surfaces.
  clock += 5_000;
  const third = render(Page, { name: 'a' });
  assert.ok(isThenable(third.thrown), 'a render starts a fresh attempt first');
  await third.thrown;
  const fourth = render(Page, { name: 'a' });
  assert.equal(reloads, 1);
  assert.ok(fourth.thrown instanceof Error);
  assert.match((fourth.thrown as Error).message, /stale chunk/);
});

test('the reload guard: once per minute, and best-effort without storage', () => {
  assert.equal(reloadForChunkError(), true);
  assert.equal(reloadForChunkError(), false);
  clock += 61_000;
  assert.equal(reloadForChunkError(), true);
  assert.equal(reloads, 2);
  lazyPageEnv.storage = () => null;
  assert.equal(reloadForChunkError(), true, 'no storage: still reloads');
});

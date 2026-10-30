import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { StaleBuild, holdReloadWhile, installChunkErrorReload, isChunkError, lazyPage, lazyPageEnv, loadChunk, reloadForChunkError, reloadHeldBy, reloadUnderway } from './lazyPage';
import { capture } from './errorReport';

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
  lazyPageEnv.reloadingAt = 0;
});

const Hello = (p: { name: string }) => `hello ${p.name}` as unknown as JSX.Element;
const isThenable = (x: unknown): x is PromiseLike<unknown> => !!x && typeof (x as { then?: unknown }).then === 'function';
/** Wait (up to 2 s) for `cond`: on a busy machine the retry's timer can come after a fixed few ms. */
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
}

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

test('any lazily loaded module that fails (vite:preloadError, a release replaced the file names): one reload to the current build, never a loop', () => {
  const target = new EventTarget();
  installChunkErrorReload(target as unknown as Window);
  const fire = (): boolean => {
    const e = new Event('vite:preloadError', { cancelable: true });
    target.dispatchEvent(e);
    return e.defaultPrevented;
  };
  assert.equal(fire(), true, 'handled: the import does not throw at the caller while the page reloads');
  assert.equal(reloads, 1);
  clock += 10_000;
  assert.equal(fire(), false, 'within a minute of the last reload: the error goes to the caller');
  assert.equal(reloads, 1);
  clock += 60_000;
  assert.equal(fire(), true);
  assert.equal(reloads, 2);
});

test('while that reload is under way, a part whose import came back empty waits for it: no crash, no report', async () => {
  // Live 2026-10-29 after v0.2.85: the order entry's boundary caught "Cannot read properties of undefined
  // (reading 'default')" - the preload error was taken over, so its import resolved to nothing.
  const target = new EventTarget();
  installChunkErrorReload(target as unknown as Window);
  target.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
  assert.equal(reloads, 1);
  assert.equal(reloadUnderway(), true);
  const settled = (p: Promise<unknown>) => Promise.race([p.then(() => 'settled', () => 'settled'), new Promise((r) => setTimeout(() => r('waiting'), 30))]);
  const chunk = loadChunk(async () => undefined as unknown as { default: typeof Hello });
  assert.equal(await settled(chunk), 'waiting', 'the lazy part stays suspended until the page goes');
  const Page = lazyPage('empty', async () => (undefined as unknown as { X: typeof Hello }).X);
  const first = render(Page, { name: 'x' });
  assert.ok(isThenable(first.thrown), 'the page suspends');
  assert.equal(await settled(Page.preload()), 'waiting', 'and is never shown as failed');
  assert.equal(capture('boundary', new TypeError("Cannot read properties of undefined (reading 'default')"), { boundary: 'Order entry' }), null, 'nothing is reported while the old build goes');
});

test('a release never reloads a tab that runs live algos or copies: it is held, and says so', () => {
  let algos = 2;
  const stopA = holdReloadWhile(() => (algos ? `${algos} live algos` : null));
  const stopB = holdReloadWhile(() => null);
  assert.equal(reloadHeldBy(), '2 live algos');
  assert.equal(reloadForChunkError(), false, 'held: no reload');
  assert.equal(reloads, 0);
  algos = 0;
  assert.equal(reloadHeldBy(), null);
  assert.equal(reloadForChunkError(), true, 'once they are done, the next failure reloads');
  assert.equal(reloads, 1);
  const stopC = holdReloadWhile(() => { throw new Error('broken'); });
  assert.equal(reloadHeldBy(), 'a running algo or copy', 'a hold that cannot answer holds');
  stopA(); stopB(); stopC();
  assert.equal(reloadHeldBy(), null);
});

test('a part of a page from an older build (AlgoTable after a release): one retry, then a reload - or, held or just reloaded, the reload note, never the error screen', async () => {
  const gone = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/AlgoTable-XzbNlZd5.js'));
  let calls = 0;
  const once = await loadChunk(async () => { calls++; if (calls === 1) throw new TypeError('Failed to fetch dynamically imported module: /x.js'); return { default: Hello }; });
  assert.equal(once.default, Hello, 'a blip: the retry loads it');
  assert.equal(reloads, 0);
  void loadChunk(gone);
  await until(() => reloads > 0);
  assert.equal(reloads, 1, 'gone twice: the tab reloads to the current build');
  assert.equal(await Promise.race([loadChunk(gone).then(() => 'settled'), new Promise((r) => setTimeout(() => r('waiting'), 20))]), 'waiting', 'while it reloads, a part asked for waits');
  lazyPageEnv.reloadingAt = 0; // the page that loaded after it: its own module state
  const note = await loadChunk(gone);
  assert.equal(note.default, StaleBuild, 'reloaded a moment ago: the note, not a loop and not the boundary');
  await assert.rejects(loadChunk(() => Promise.reject(new Error('boom'))), /boom/, 'any other error is thrown as before');
  assert.ok(isChunkError(new TypeError('Importing a module script failed.')));
  assert.ok(!isChunkError(new Error('network')));
});

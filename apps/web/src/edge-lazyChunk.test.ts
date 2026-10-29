/**
 * Stale build chunks (lazyPage.ts lazyChunk / loadChunk): what each browser says when a release
 * renamed a file this tab still asks for, a tab that runs live algos (never reloaded by a
 * release), and errors that are not about a missing file (thrown at once, never retried).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { StaleBuild, holdReloadWhile, isChunkError, lazyPageEnv, loadChunk } from './lazyPage';

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
beforeEach(() => {
  reloads = 0;
  clock = 1_000_000;
  const storage = memoryStorage();
  lazyPageEnv.reload = () => { reloads++; };
  lazyPageEnv.retryDelayMs = 0;
  lazyPageEnv.now = () => clock;
  lazyPageEnv.storage = () => storage;
});

const Part = () => null;

test('every browser\'s words for a file a release removed are a stale chunk; other errors are not', () => {
  for (const words of [
    'Failed to fetch dynamically imported module: https://www.valuedesk.so/assets/AlgoTable-XzbNlZd5.js', // Chrome, Edge
    'error loading dynamically imported module: https://www.valuedesk.so/assets/AlgoTicket-1.js', // Firefox
    'Importing a module script failed.', // Safari
    'Unable to preload CSS for /assets/algo-Bq1.css', // Vite's CSS preload
  ]) {
    assert.ok(isChunkError(new TypeError(words)), words);
    assert.ok(isChunkError(words), `as a bare string too: ${words}`);
  }
  for (const other of ['NetworkError when attempting to fetch resource.', 'Cannot read properties of undefined', 'Unexpected token <']) assert.ok(!isChunkError(new Error(other)), other);
  assert.ok(!isChunkError(null));
  assert.ok(!isChunkError({}));
});

test('a tab running live algos is never reloaded by a stale chunk: it shows the reload note, and the algos keep running', async () => {
  const stop = holdReloadWhile(() => '1 live algo');
  try {
    let calls = 0;
    const got = await loadChunk(async () => {
      calls++;
      throw new TypeError('Failed to fetch dynamically imported module: /assets/AlgoTable-old.js');
    });
    assert.equal(got.default, StaleBuild, 'the note in place of the part');
    assert.equal(calls, 2, 'tried once more first');
    assert.equal(reloads, 0, 'never reloaded under a running algo');
  } finally {
    stop();
  }
});

test('an error that is not a missing file is thrown at once, without a retry; a retry that fails otherwise throws that error', async () => {
  let calls = 0;
  await assert.rejects(loadChunk(async () => { calls++; throw new Error('render crashed'); }), /render crashed/);
  assert.equal(calls, 1, 'not retried');
  calls = 0;
  await assert.rejects(
    loadChunk(async () => {
      calls++;
      throw calls === 1 ? new TypeError('Importing a module script failed.') : new SyntaxError('Unexpected token <');
    }),
    /Unexpected token/,
  );
  assert.equal(calls, 2);
  assert.equal(reloads, 0);
});

test('a stale chunk twice reloads once; asked again a minute later (still stale) it reloads again - never a loop inside the minute', async () => {
  const gone = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/x.js'));
  void loadChunk(gone);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(reloads, 1);
  clock += 30_000;
  assert.equal((await loadChunk(gone)).default, StaleBuild, 'within the minute: the note');
  assert.equal(reloads, 1);
  clock += 31_000;
  void loadChunk(gone);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(reloads, 2);
  assert.equal((await loadChunk(async () => ({ default: Part }))).default, Part, 'a part that loads is the part');
});

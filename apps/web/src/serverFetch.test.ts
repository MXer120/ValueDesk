/**
 *   npx tsx --test src/serverFetch.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { _resetServerFetch, primeFirstReads, revalidating, serverFetchEnv, serverGet, serverGetJson } from './serverFetch';

interface Call {
  url: string;
  cache: RequestCache | undefined;
  accept: string | undefined;
  signal: AbortSignal | undefined;
  resolve: (body: string, status?: number) => void;
  reject: (e: unknown) => void;
}
let calls: Call[] = [];
let store: Record<string, string> = {};
let timers: Array<{ fn: () => void; ms: number }> = [];
let hidden = false;

beforeEach(() => {
  _resetServerFetch();
  calls = [];
  store = {};
  timers = [];
  hidden = false;
  serverFetchEnv.fetch = (url, init) =>
    new Promise<Response>((res, rej) => {
      const c: Call = {
        url,
        cache: init.cache,
        accept: (init.headers as Record<string, string> | undefined)?.Accept,
        signal: init.signal ?? undefined,
        resolve: (body, status = 200) => res(new Response(body, { status })),
        reject: rej,
      };
      init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
      calls.push(c);
    });
  serverFetchEnv.storage = () => ({
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => { store[k] = v; },
  });
  serverFetchEnv.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  serverFetchEnv.hidden = () => hidden;
});

const tick = () => new Promise((r) => setTimeout(r, 0));
/** Run the timers of `ms` (the recording window is 4 s, the early answers' life 10 s). */
const elapse = (ms: number) => { for (const t of timers.filter((x) => x.ms === ms)) t.fn(); timers = timers.filter((x) => x.ms !== ms); };
const KEY = 'vs.firstReads';
const kept = (): Record<string, string[]> => JSON.parse(store[KEY] ?? '{}');

test('identical concurrent reads share one request; each caller parses its own copy', async () => {
  const a = serverGetJson<{ rows: number[] }>('/api/vs/explore');
  const b = serverGetJson<{ rows: number[] }>('/api/vs/explore');
  await tick();
  assert.equal(calls.length, 1);
  calls[0]!.resolve('{"rows":[3,1,2]}');
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepEqual(ra.body, { rows: [3, 1, 2] });
  ra.body!.rows.sort();
  assert.deepEqual(rb.body!.rows, [3, 1, 2], 'no shared objects');
});

test('a read is left to the browser\'s HTTP cache; a read made inside revalidating() asks the server', async () => {
  const a = serverGet('/api/vs/leaderboard?window=30d');
  await tick();
  calls[0]!.resolve('{}');
  await a;
  const b = revalidating(() => serverGet('/api/vs/leaderboard?window=30d'));
  await tick();
  calls[1]!.resolve('{}');
  await b;
  const c = serverGet('/api/vs/leaderboard?window=30d');
  await tick();
  calls[2]!.resolve('{}');
  await c;
  assert.deepEqual(calls.map((x) => x.cache), ['default', 'no-cache', 'default'], 'only the read started inside it');
  assert.deepEqual(calls.map((x) => x.accept), ['application/json', 'application/json', 'application/json']);
});

test('revalidating() returns what fn returns, nests, and ends when fn throws', async () => {
  assert.equal(revalidating(() => 7), 7);
  const inner = revalidating(() => {
    revalidating(() => undefined);
    return serverGetJson('/api/vs/explore'); // still inside the outer call
  });
  assert.throws(() => revalidating(() => { throw new Error('boom'); }), /boom/);
  const after = serverGet('/api/vs/cohorts');
  await tick();
  assert.deepEqual(calls.map((x) => [x.url, x.cache]), [['/api/vs/explore', 'no-cache'], ['/api/vs/cohorts', 'default']]);
  calls[0]!.resolve('{"a":1}');
  calls[1]!.resolve('{}');
  assert.deepEqual((await inner).body, { a: 1 });
  await after;
});

test('a read that asks the server does not share a plain read in flight; a plain read shares one that asks', async () => {
  const first = serverGet('/api/vs/leaderboard?window=30d');
  const poll = revalidating(() => serverGet('/api/vs/leaderboard?window=30d'));
  await tick();
  assert.deepEqual(calls.map((x) => x.cache), ['default', 'no-cache'], 'the cache might have answered the first: the poll sends its own');
  const second = serverGet('/api/vs/leaderboard?window=30d');
  const poll2 = revalidating(() => serverGet('/api/vs/leaderboard?window=30d'));
  await tick();
  assert.equal(calls.length, 2, 'both later reads joined the one that asks');
  calls[0]!.resolve('{"from":"cache"}');
  calls[1]!.resolve('{"from":"server"}');
  assert.equal((await first).text, '{"from":"cache"}');
  assert.equal((await poll).text, '{"from":"server"}');
  assert.equal((await second).text, '{"from":"server"}');
  assert.equal((await poll2).text, '{"from":"server"}');
});

test('aborting the only caller of a read that asks cancels it, and the next one starts afresh', async () => {
  const ac = new AbortController();
  const poll = revalidating(() => serverGet('/api/vs/explore', ac.signal));
  await tick();
  ac.abort();
  await assert.rejects(poll);
  assert.equal(calls[0]!.signal?.aborted, true);
  const next = revalidating(() => serverGet('/api/vs/explore'));
  await tick();
  assert.equal(calls.length, 2);
  calls[1]!.resolve('{}');
  assert.equal((await next).ok, true);
});

test('reads of different URLs never share', async () => {
  const a = serverGet('/api/vs/leaderboard?window=30d');
  const b = serverGet('/api/vs/leaderboard?window=7d');
  await tick();
  assert.deepEqual(calls.map((c) => c.url), ['/api/vs/leaderboard?window=30d', '/api/vs/leaderboard?window=7d']);
  calls[0]!.resolve('{"w":30}');
  calls[1]!.resolve('{"w":7}');
  assert.equal((await a).text, '{"w":30}');
  assert.equal((await b).text, '{"w":7}');
});

test('a read after the last one answered is a new request', async () => {
  const a = serverGet('/api/vs/positioning');
  await tick();
  calls[0]!.resolve('{"a":1}');
  assert.equal((await a).text, '{"a":1}');
  const b = serverGet('/api/vs/positioning');
  const joiner = serverGet('/api/vs/positioning');
  await tick();
  assert.equal(calls.length, 2);
  calls[1]!.resolve('{"a":2}');
  assert.equal((await b).text, '{"a":2}');
  assert.equal((await joiner).text, '{"a":2}');
});

test('one caller aborting leaves the shared request to the others', async () => {
  const ac = new AbortController();
  const a = serverGet('/api/vs/cohorts', ac.signal);
  const b = serverGet('/api/vs/cohorts');
  await tick();
  ac.abort();
  await assert.rejects(a, (e: unknown) => (e as Error).name === 'AbortError');
  assert.equal(calls[0]!.signal!.aborted, false);
  calls[0]!.resolve('{"ok":true}');
  assert.equal((await b).text, '{"ok":true}');
});

test('when every caller has gone the request is cancelled, and the next read starts afresh', async () => {
  const ac1 = new AbortController();
  const ac2 = new AbortController();
  const a = serverGet('/api/vs/whales', ac1.signal);
  const b = serverGet('/api/vs/whales', ac2.signal);
  await tick();
  ac1.abort();
  ac2.abort();
  await assert.rejects(a);
  await assert.rejects(b);
  assert.equal(calls[0]!.signal!.aborted, true);
  const c = serverGet('/api/vs/whales');
  await tick();
  assert.equal(calls.length, 2);
  calls[1]!.resolve('[]');
  assert.equal((await c).text, '[]');
});

test('an abort after the answer changes nothing', async () => {
  const ac = new AbortController();
  const a = serverGet('/api/vs/explore', ac.signal);
  await tick();
  calls[0]!.resolve('{"n":1}');
  assert.equal((await a).text, '{"n":1}');
  ac.abort();
  const b = serverGet('/api/vs/explore');
  await tick();
  assert.equal(calls.length, 2, 'the finished read is not reused');
  assert.equal(calls[1]!.signal!.aborted, false);
  calls[1]!.resolve('{"n":2}');
  assert.equal((await b).text, '{"n":2}');
});

test('an already-aborted signal never starts a request, and rejects with its reason', async () => {
  const ac = new AbortController();
  ac.abort(new Error('gone'));
  await assert.rejects(serverGet('/api/vs/explore', ac.signal), /gone/);
  assert.equal(calls.length, 0);
});

test('errors reach every caller; the status and non-JSON bodies come through', async () => {
  const a = serverGet('/api/vs/explore');
  const b = serverGet('/api/vs/explore');
  await tick();
  calls[0]!.reject(new TypeError('Failed to fetch'));
  await assert.rejects(a, /Failed to fetch/);
  await assert.rejects(b, /Failed to fetch/);
  const c = serverGetJson('/api/vs/explore');
  await tick();
  assert.equal(calls.length, 2, 'a failed read is not kept');
  calls[1]!.resolve('<html>', 502);
  const r = await c;
  assert.equal(r.status, 502);
  assert.equal(r.ok, false);
  assert.equal(r.body, null);
});

/* --- first reads --------------------------------------------------------------------------- */

test('a first visit starts nothing early, and remembers what the page read first', async () => {
  primeFirstReads('/explore');
  assert.equal(calls.length, 0);
  const reads = [serverGet('/api/vs/explore'), serverGet('/api/vs/whales?venue=all&minUsd=100000&limit=40'), serverGet('/api/vs/positioning?venue=all'), serverGet('/api/vs/explore')];
  await tick();
  for (const c of calls) c.resolve('{}');
  await Promise.all(reads);
  assert.equal(store[KEY], undefined, 'nothing is written while the page is still starting');
  elapse(4_000);
  assert.deepEqual(kept(), { '/explore': ['/api/vs/explore', '/api/vs/whales?venue=all&minUsd=100000&limit=40', '/api/vs/positioning?venue=all'] });
  // A read after the window is a poll, not a first read.
  const late = serverGet('/api/vs/leaderboard?window=30d');
  await tick();
  calls.at(-1)!.resolve('{}');
  await late;
  assert.deepEqual(Object.keys(kept()), ['/explore']);
});

test('the next start sends them at once, and the page\'s own read takes that answer - once', async () => {
  store[KEY] = JSON.stringify({ '/leaderboard': ['/api/vs/leaderboard?window=30d', '/api/vs/leaderboard?window=30d&curves=1'] });
  primeFirstReads('/leaderboard');
  await tick();
  assert.deepEqual(calls.map((c) => c.url), ['/api/vs/leaderboard?window=30d', '/api/vs/leaderboard?window=30d&curves=1'], 'on their way before the page exists');
  assert.deepEqual(calls.map((c) => c.cache), ['default', 'default'], 'the page\'s first reads, sent earlier: the HTTP cache may answer them');
  calls[0]!.resolve('{"rows":[1]}');
  await tick();

  const page = await serverGetJson<{ rows: number[] }>('/api/vs/leaderboard?window=30d');
  assert.deepEqual(page.body, { rows: [1] });
  assert.equal(calls.length, 2, 'the page sent nothing: it took the answer that was already in');

  const joined = serverGet('/api/vs/leaderboard?window=30d&curves=1'); // still on the wire: the page waits on it
  await tick();
  assert.equal(calls.length, 2);
  calls[1]!.resolve('{"rows":[2]}');
  assert.equal((await joined).text, '{"rows":[2]}');

  const poll = serverGet('/api/vs/leaderboard?window=30d'); // the next read is the page's own again
  await tick();
  assert.equal(calls.length, 3);
  calls[2]!.resolve('{"rows":[9]}');
  assert.equal((await poll).text, '{"rows":[9]}');
  elapse(4_000);
  assert.deepEqual(kept()['/leaderboard'], ['/api/vs/leaderboard?window=30d', '/api/vs/leaderboard?window=30d&curves=1'], 'the same first reads: nothing rewritten');
});

test('a read that asks the server neither takes an early answer nor counts as a first read', async () => {
  store[KEY] = JSON.stringify({ '/explore': ['/api/vs/explore'] });
  primeFirstReads('/explore');
  await tick();
  assert.equal(calls.length, 1);
  const poll = revalidating(() => serverGet('/api/vs/explore'));
  const other = revalidating(() => serverGet('/api/vs/whales?limit=40'));
  await tick();
  assert.deepEqual(calls.map((c) => c.cache), ['default', 'no-cache', 'no-cache'], 'a request of its own');
  calls[0]!.resolve('{"early":true}');
  calls[1]!.resolve('{"asked":true}');
  calls[2]!.resolve('{}');
  assert.equal((await poll).text, '{"asked":true}');
  await other;
  const page = await serverGet('/api/vs/explore');
  assert.equal(page.text, '{"early":true}', 'the early answer was still there for the page');
  elapse(4_000);
  assert.deepEqual(kept(), { '/explore': ['/api/vs/explore'] }, 'what was asked inside revalidating() is not remembered');
});

test('an early read that failed is not handed over: the page reads for itself', async () => {
  store[KEY] = JSON.stringify({ '/explore': ['/api/vs/explore', '/api/vs/positioning?venue=all'] });
  primeFirstReads('/explore');
  await tick();
  calls[0]!.reject(new TypeError('Failed to fetch'));
  calls[1]!.resolve('{"ok":false}', 503);
  await tick();
  const a = serverGet('/api/vs/explore');
  const b = serverGet('/api/vs/positioning?venue=all');
  await tick();
  assert.equal(calls.length, 4, 'both were asked again');
  calls[2]!.resolve('{"n":1}');
  calls[3]!.resolve('{"n":2}');
  assert.equal((await a).text, '{"n":1}');
  assert.equal((await b).text, '{"n":2}');
});

test('the reader of an early answer keeps its own abort', async () => {
  store[KEY] = JSON.stringify({ '/explore': ['/api/vs/explore'] });
  primeFirstReads('/explore');
  await tick();
  const ac = new AbortController();
  const a = serverGet('/api/vs/explore', ac.signal);
  ac.abort();
  await assert.rejects(a, (e: unknown) => (e as Error).name === 'AbortError');
  calls[0]!.resolve('{}');
});

test('an early answer nobody asked for is dropped, and what the page reads now replaces the list', async () => {
  store[KEY] = JSON.stringify({ '/explore?view=cohorts': ['/api/vs/cohorts?venues=sodex'], '/copy': ['/api/vs/leaderboard?venue=hyperliquid'] });
  primeFirstReads('/explore?view=cohorts');
  await tick();
  calls[0]!.resolve('{"old":true}');
  const now = serverGet('/api/vs/cohorts?venues=sodex%2Chyperliquid'); // the venue set changed since
  await tick();
  calls[1]!.resolve('{"new":true}');
  await now;
  elapse(4_000);
  assert.deepEqual(kept(), { '/copy': ['/api/vs/leaderboard?venue=hyperliquid'], '/explore?view=cohorts': ['/api/vs/cohorts?venues=sodex%2Chyperliquid'] });
  elapse(10_000);
  const later = serverGet('/api/vs/cohorts?venues=sodex');
  await tick();
  assert.equal(calls.length, 3, 'the unused early answer was let go');
  calls[2]!.resolve('{}');
  await later;
});

test('a page that reads nothing forgets its list; it is called once per load', async () => {
  store[KEY] = JSON.stringify({ '/trade': ['/api/vs/explore'] });
  primeFirstReads('/trade');
  primeFirstReads('/explore');
  await tick();
  assert.equal(calls.length, 1, 'the second call did nothing');
  calls[0]!.resolve('{}');
  elapse(4_000);
  assert.deepEqual(kept(), {});
});

test('nothing personal is remembered or sent early; a tampered list is ignored', async () => {
  primeFirstReads('/scan?address=0xabc&venue=hyperliquid');
  const a = serverGet('/api/vs/lbrow?venue=hyperliquid&address=0xabc');
  await tick();
  calls[0]!.resolve('{}');
  await a;
  assert.equal(timers.length, 0, 'a URL with a wallet in it is not learned at all');
  assert.equal(store[KEY], undefined);

  _resetServerFetch();
  calls = [];
  primeFirstReads('/leaderboard');
  const b = serverGet('/api/vs/leaderboard?venue=all&q=0xdef');
  const c = serverGet('/api/health');
  await tick();
  for (const x of calls) x.resolve('{}');
  await Promise.all([b, c]);
  elapse(4_000);
  assert.equal(store[KEY], undefined, 'a search and a non-index read are not first reads');

  _resetServerFetch();
  calls = [];
  store[KEY] = JSON.stringify({ '/explore': ['https://evil.example/x', '//evil.example/api/vs/x', '/api/acct/state', '/api/vs/lbrow?address=0x1', 7, '/api/vs/explore'], '/copy': 'nope' });
  primeFirstReads('/explore');
  await tick();
  assert.deepEqual(calls.map((x) => x.url), ['/api/vs/explore'], 'only our own index paths are ever sent');
});

test('a tab opened in the background starts nothing early and learns nothing', async () => {
  store[KEY] = JSON.stringify({ '/explore': ['/api/vs/explore'] });
  hidden = true;
  primeFirstReads('/explore');
  await tick();
  assert.equal(calls.length, 0);
  assert.equal(timers.length, 0);
  assert.deepEqual(kept(), { '/explore': ['/api/vs/explore'] }, 'and the list is kept for the next visible start');
});

test('at most six reads per page and sixteen pages are remembered', async () => {
  primeFirstReads('/explore');
  const reads = Array.from({ length: 9 }, (_, i) => serverGet(`/api/vs/cohorts/detail?cohort=c${i}`));
  await tick();
  for (const c of calls) c.resolve('{}');
  await Promise.all(reads);
  elapse(4_000);
  assert.equal(kept()['/explore']!.length, 6);

  for (let i = 0; i < 20; i++) {
    _resetServerFetch();
    timers = [];
    primeFirstReads(`/explore?view=cohorts&coin=C${i}`);
    for (const c of calls.splice(0)) c.resolve('{}'); // whatever the last round remembered was started early
    const r = serverGet(`/api/vs/cohorts/focus?coin=C${i}`);
    await tick();
    for (const c of calls.splice(0)) c.resolve('{}');
    await r;
    elapse(4_000);
  }
  const routes = Object.keys(kept());
  assert.equal(routes.length, 16);
  assert.equal(routes.at(-1), '/explore?view=cohorts&coin=C19', 'the newest are kept');
  assert.equal(routes.includes('/explore'), false, 'the oldest went');
});

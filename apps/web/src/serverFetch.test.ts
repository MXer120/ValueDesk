/**
 *   npx tsx --test src/serverFetch.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIRST_READS_BUDGET, _resetServerFetch, keepWindowMs, peekAnswer, peekJson, pickFirstReads, primeFirstReads, primeRoute, revalidating,
  serverFetchEnv, serverGet, serverGetJson,
} from './serverFetch';

interface Call {
  url: string;
  cache: RequestCache | undefined;
  accept: string | undefined;
  signal: AbortSignal | undefined;
  resolve: (body: string, status?: number, headers?: Record<string, string>) => void;
  reject: (e: unknown) => void;
}
let calls: Call[] = [];
let store: Record<string, string> = {};
let timers: Array<{ fn: () => void; ms: number }> = [];
let hidden = false;
let now = 1_800_000_000_000;
let saveData = false;
let globals: Record<string, unknown> = {};
let here: string | null = null;

beforeEach(() => {
  _resetServerFetch();
  calls = [];
  store = {};
  timers = [];
  hidden = false;
  now = 1_800_000_000_000;
  saveData = false;
  globals = {};
  here = null;
  serverFetchEnv.fetch = (url, init) =>
    new Promise<Response>((res, rej) => {
      const c: Call = {
        url,
        cache: init.cache,
        accept: (init.headers as Record<string, string> | undefined)?.Accept,
        signal: init.signal ?? undefined,
        resolve: (body, status = 200, headers = {}) => res(new Response(body, { status, headers })),
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
  serverFetchEnv.now = () => now;
  serverFetchEnv.saveData = () => saveData;
  serverFetchEnv.encodedSize = () => null;
  serverFetchEnv.globals = () => globals as never;
  serverFetchEnv.route = () => here;
});

const tick = () => new Promise((r) => setTimeout(r, 0));
/** Run the timers of `ms` (the recording window is 4 s, the early answers' life 10 s). */
const elapse = (ms: number) => { for (const t of timers.filter((x) => x.ms === ms)) t.fn(); timers = timers.filter((x) => x.ms !== ms); };
const KEY = 'vs.firstReads';
/** What is remembered: the paths per page (their sizes: `sized`). */
const kept = (): Record<string, string[]> => Object.fromEntries(Object.entries(sized()).map(([k, v]) => [k, v.map((e) => (typeof e === 'string' ? e : e[0]))]));
const sized = (): Record<string, Array<[string, number] | string>> => JSON.parse(store[KEY] ?? '{}');
const http = (date: number) => new Date(date).toUTCString();

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
  assert.deepEqual(kept()['/leaderboard'], ['/api/vs/leaderboard?window=30d', '/api/vs/leaderboard?window=30d&curves=1'], 'the same first reads');
  assert.deepEqual(sized()['/leaderboard'], [['/api/vs/leaderboard?window=30d', 12], ['/api/vs/leaderboard?window=30d&curves=1', 12]], 'now with their sizes');
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

test('a page that reads nothing keeps an empty list (no default is started for it either); it is called once per load', async () => {
  store[KEY] = JSON.stringify({ '/trade': ['/api/vs/explore'] });
  primeFirstReads('/trade');
  primeFirstReads('/explore');
  await tick();
  assert.equal(calls.length, 1, 'the second call did nothing');
  calls[0]!.resolve('{}');
  elapse(4_000);
  assert.deepEqual(kept(), { '/trade': [] });

  _resetServerFetch();
  calls = [];
  globals = { __vsReads: { '/trade': ['/api/vs/sodex/oi-excluded'] } };
  primeFirstReads('/trade');
  await tick();
  assert.equal(calls.length, 0, 'the remembered empty list wins over the build default');
});

test("an empty build default is the page's rule: nothing early whatever is remembered, nothing learned, nothing primed", async () => {
  globals = { __vsReads: { '/explore': [] } };
  store[KEY] = JSON.stringify({ '/explore': [['/api/vs/screener?view=assets', 13_301]] });
  primeFirstReads('/explore');
  primeRoute('/explore');
  await tick();
  assert.equal(calls.length, 0);
  const r = serverGet('/api/vs/screener?view=assets');
  await tick();
  calls[0]!.resolve('{}');
  await r;
  elapse(4_000);
  assert.deepEqual(kept(), { '/explore': ['/api/vs/screener?view=assets'] }, 'the list is left as it was');
});

test('such a page about to be opened in the app starts its reads on intent (no first paint to share the line with)', async () => {
  globals = { __vsReads: { '/explore': [] }, __vsAhead: { '/explore': ['/api/vs/screener?view=assets', '/api/vs/cohorts/map?v=1'] } };
  primeRoute('/explore');
  await tick();
  assert.deepEqual(calls.map((c) => c.url), ['/api/vs/screener?view=assets', '/api/vs/cohorts/map?v=1']);
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
  assert.deepEqual(kept(), { '/leaderboard': [] }, 'a search and a non-index read are not first reads');

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

/* --- the route script's early reads, the window from boot, the budget ------------------------------ */

test("the route script's reads are adopted: one request each, nothing sent again, a late script starts nothing", async () => {
  let resolveA!: (r: Response) => void;
  const a = new Promise<Response>((r) => { resolveA = r; });
  globals = { __vsEarly: { '/api/vs/cohorts?venues=sodex': a, 'https://evil.example/x': Promise.resolve(new Response('{}')) } };
  store[KEY] = JSON.stringify({ '/explore?view=cohorts': ['/api/vs/other'] });
  primeFirstReads('/explore?view=cohorts');
  assert.equal(globals.__vsPrimed, true, 'a route script that runs after this starts nothing');
  assert.equal(globals.__vsEarly, undefined, 'taken once');
  const page = serverGet('/api/vs/cohorts?venues=sodex');
  const other = serverGet('/api/vs/cohorts?venues=sodex'); // a second reader joins the same request
  await tick();
  assert.equal(calls.length, 0, 'neither the remembered list nor the page sent anything of its own');
  resolveA(new Response('{"n":1}', { status: 200 }));
  assert.equal((await page).text, '{"n":1}');
  assert.equal((await other).text, '{"n":1}');
});

test('without the route script, the remembered reads are sent here, as before', async () => {
  store[KEY] = JSON.stringify({ '/leaderboard': [['/api/vs/leaderboard?win=1', 900]] });
  primeFirstReads('/leaderboard');
  await tick();
  assert.deepEqual(calls.map((c) => c.url), ['/api/vs/leaderboard?win=1']);
});

test('a first visit starts the build defaults for its URL; a remembered list wins over them', async () => {
  globals = { __vsReads: { '/leaderboard': ['/api/vs/leaderboard?d=1'], '/explore': ['/api/vs/x'] } };
  store[KEY] = JSON.stringify({ '/explore': [['/api/vs/y', 10]] });
  primeFirstReads('/leaderboard');
  await tick();
  assert.deepEqual(calls.map((c) => c.url), ['/api/vs/leaderboard?d=1']);
  _resetServerFetch();
  calls = [];
  primeFirstReads('/explore');
  await tick();
  assert.deepEqual(calls.map((c) => c.url), ['/api/vs/y']);
});

test('the recording window and the early answers count from the moment the landing page is in, not from the start', async () => {
  let booted!: () => void;
  const boot = new Promise<void>((r) => { booted = r; });
  store[KEY] = JSON.stringify({ '/explore': ['/api/vs/a'] });
  primeFirstReads('/explore', boot);
  await tick();
  calls[0]!.resolve('{}');
  assert.deepEqual(timers.map((t) => t.ms), [60_000, 60_000], 'only the give-up timers while the code is still coming');
  booted();
  await tick();
  assert.deepEqual(timers.map((t) => t.ms).sort((x, y) => x - y), [4_000, 10_000, 60_000, 60_000]);
  // The page renders and reads, seconds after the module ran: still its first reads, and the early answer is there.
  const page = serverGet('/api/vs/a');
  const more = serverGet('/api/vs/b');
  await tick();
  assert.equal(calls.length, 2, 'only /b went out');
  calls[1]!.resolve('{"b":1}');
  await Promise.all([page, more]);
  elapse(4_000);
  assert.deepEqual(kept(), { '/explore': ['/api/vs/a', '/api/vs/b'] });
});

test('reads made after the visitor moved to another page are not the landing page\'s first reads', async () => {
  here = '/trade?symbol=ETH-USD';
  primeFirstReads('/trade?symbol=ETH-USD');
  const a = serverGet('/api/vs/a');
  here = '/trade'; // the page cleaned its own query: still the landing page
  const b = serverGet('/api/vs/b');
  here = '/leaderboard';
  const c = serverGet('/api/vs/c');
  await tick();
  for (const x of calls) x.resolve('{}');
  await Promise.all([a, b, c]);
  elapse(4_000);
  assert.deepEqual(kept(), { '/trade?symbol=ETH-USD': ['/api/vs/a', '/api/vs/b'] });
});

test('a list is written with each read\'s bytes, once those are in', async () => {
  serverFetchEnv.encodedSize = (p) => (p === '/api/vs/a' ? 7_000 : null);
  primeFirstReads('/explore');
  const a = serverGet('/api/vs/a');
  const b = serverGet('/api/vs/b');
  await tick();
  calls[0]!.resolve('{"a":1}');
  await a;
  elapse(4_000);
  assert.equal(store[KEY], undefined, '/b is still on the wire');
  calls[1]!.resolve('{"bb":22}');
  await b;
  await tick();
  assert.deepEqual(sized(), { '/explore': [['/api/vs/a', 7_000], ['/api/vs/b', 9]] }, 'the wire size when the browser says it, else the body');
});

test('at most six reads and 64 KB on the wire are started early for a page', () => {
  assert.deepEqual(pickFirstReads([['/api/vs/a', 40_000], ['/api/vs/b', 30_000], ['/api/vs/c', 20_000], ['/api/vs/d', 0]]), ['/api/vs/a', '/api/vs/c', '/api/vs/d'], 'a read that would pass the budget is left to the page');
  assert.equal(FIRST_READS_BUDGET, 65_536);
  assert.equal(pickFirstReads(Array.from({ length: 9 }, (_, i) => [`/api/vs/x${i}`, 100] as [string, number])).length, 6);
  assert.deepEqual(pickFirstReads([['/api/vs/a', 1], ['/api/vs/a', 1], ['/api/acct/x', 1], ['/api/vs/lbrow?address=0x1', 1]]), ['/api/vs/a']);
});

/* --- kept answers ---------------------------------------------------------------------------------- */

test('an answer is kept for exactly as long as its Cache-Control allows any cache to hand it out', async () => {
  const a = serverGet('/api/vs/leaderboard?win=30d');
  await tick();
  calls[0]!.resolve('{"rows":[1]}', 200, { 'cache-control': 'public, max-age=10, stale-while-revalidate=20', date: http(now - 4_000), age: '2' });
  await a;
  const k = peekAnswer('/api/vs/leaderboard?win=30d');
  assert.equal(k?.text, '{"rows":[1]}');
  assert.equal(k?.at, now - 4_000, 'made 4 s ago by its Date (its Age says less)');
  assert.equal(k?.until, now - 4_000 + 30_000);
  assert.deepEqual(peekJson('/api/vs/leaderboard?win=30d')?.body, { rows: [1] });
  now += 25_999;
  assert.ok(peekAnswer('/api/vs/leaderboard?win=30d'));
  now += 1;
  assert.equal(peekAnswer('/api/vs/leaderboard?win=30d'), null, 'past max-age + stale-while-revalidate: gone');
});

test('nothing is kept that a cache may not keep: no-cache, no-store, a failure, an error status, a wallet or a search', async () => {
  const cases: Array<[string, string, number, Record<string, string>]> = [
    ['/api/vs/whales', '{"trades":[]}', 200, { 'cache-control': 'public, no-cache' }],
    ['/api/vs/bots/access', '{}', 200, { 'cache-control': 'no-store' }],
    ['/api/vs/cohorts?v=1', '{"ok":false,"error":"down"}', 200, { 'cache-control': 'public, max-age=30' }],
    ['/api/vs/cohorts?v=2', '{}', 503, { 'cache-control': 'public, max-age=30' }],
    ['/api/vs/lbrow?address=0x1', '{}', 200, { 'cache-control': 'public, max-age=30' }],
    ['/api/vs/leaderboard?q=0x1', '{}', 200, { 'cache-control': 'public, max-age=30' }],
    ['/api/health', '{}', 200, { 'cache-control': 'public, max-age=10' }],
    ['/api/vs/old', '{}', 200, { 'cache-control': 'public, max-age=10', age: '11' }],
  ];
  const reads = cases.map(([p]) => serverGet(p));
  await tick();
  cases.forEach(([, body, status, headers], i) => calls[i]!.resolve(body, status, headers));
  await Promise.all(reads);
  for (const [p] of cases) assert.equal(peekAnswer(p), null, p);
  assert.equal(keepWindowMs('public, max-age=30, stale-while-revalidate=30'), 60_000);
  assert.equal(keepWindowMs('public, max-age=10'), 10_000);
  assert.equal(keepWindowMs('public, s-maxage=10'), null);
  assert.equal(keepWindowMs(null), null);
});

test('a poll\'s answer replaces the kept one; the oldest answers go once 64 are kept', async () => {
  const cc = { 'cache-control': 'public, max-age=30' };
  const a = serverGet('/api/vs/a');
  await tick();
  calls[0]!.resolve('{"v":1}', 200, cc);
  await a;
  const poll = revalidating(() => serverGet('/api/vs/a'));
  await tick();
  calls[1]!.resolve('{"v":2}', 200, cc);
  await poll;
  assert.equal(peekAnswer('/api/vs/a')?.text, '{"v":2}');
  const many = Array.from({ length: 64 }, (_, i) => serverGet(`/api/vs/m${i}`));
  await tick();
  calls.slice(2).forEach((c) => c.resolve('{}', 200, cc));
  await Promise.all(many);
  assert.equal(peekAnswer('/api/vs/a'), null, 'the oldest went');
  assert.ok(peekAnswer('/api/vs/m63'));
});

test("an early answer is the page's own first read, not a kept one, until the page has taken it", async () => {
  const cc = { 'cache-control': 'public, max-age=30, stale-while-revalidate=30' };
  store[KEY] = JSON.stringify({ '/leaderboard': ['/api/vs/lb'] });
  primeFirstReads('/leaderboard');
  await tick();
  calls[0]!.resolve('{"rows":[1]}', 200, cc);
  await tick();
  await tick();
  assert.equal(peekAnswer('/api/vs/lb'), null, 'in before the page rendered: not drawn as an older answer, not asked again');
  const page = await serverGet('/api/vs/lb');
  assert.equal(page.text, '{"rows":[1]}');
  assert.equal(calls.length, 1);
  assert.equal(peekAnswer('/api/vs/lb')?.text, '{"rows":[1]}', 'taken: kept from now on, for the page reopened later');

  // One nobody took is kept once it is let go.
  globals = { __vsReads: { '/copy': ['/api/vs/c'] } };
  primeRoute('/copy');
  await tick();
  calls[1]!.resolve('{"c":1}', 200, cc);
  await tick();
  await tick();
  assert.equal(peekAnswer('/api/vs/c'), null);
  elapse(10_000);
  assert.equal(peekAnswer('/api/vs/c')?.text, '{"c":1}');
});

/* --- a page about to be opened --------------------------------------------------------------------- */

test('primeRoute starts what the page will read; its read takes the answer once; nothing for a kept path or Save-Data', async () => {
  globals = { __vsReads: { '/leaderboard': ['/api/vs/lb'], '/explore': ['/api/vs/k', '/api/vs/e'] } };
  primeRoute('/leaderboard');
  primeRoute('/leaderboard');
  await tick();
  assert.deepEqual(calls.map((c) => c.url), ['/api/vs/lb'], 'once, however often it is touched');
  calls[0]!.resolve('{"lb":1}');
  await tick();
  const page = await serverGet('/api/vs/lb');
  assert.equal(page.text, '{"lb":1}');
  assert.equal(calls.length, 1, 'the page took it');

  const k = serverGet('/api/vs/k');
  await tick();
  calls[1]!.resolve('{}', 200, { 'cache-control': 'public, max-age=30' });
  await k;
  primeRoute('/explore');
  await tick();
  assert.deepEqual(calls.slice(2).map((c) => c.url), ['/api/vs/e'], 'a kept path is painted and asked for by the page itself');

  saveData = true;
  primeRoute('/copy');
  globals.__vsReads = { '/copy': ['/api/vs/c'] };
  primeRoute('/copy');
  primeRoute('/scan?address=0x1');
  await tick();
  assert.equal(calls.length, 3);
});

test('a primed answer is handed over for ten seconds only', async () => {
  globals = { __vsReads: { '/bots': ['/api/vs/r'] } };
  primeRoute('/bots');
  await tick();
  calls[0]!.resolve('{"old":1}');
  await tick();
  now += 10_000;
  const late = serverGet('/api/vs/r');
  await tick();
  assert.equal(calls.length, 2, 'too old to hand over: the page reads for itself');
  calls[1]!.resolve('{"new":1}');
  assert.equal((await late).text, '{"new":1}');
});

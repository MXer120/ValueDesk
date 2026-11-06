/**
 * Run: node --import tsx --test test/indexerFetchThread.test.ts   (from apps/server)
 *
 * The indexer's HTTP on its own thread: a request that was answered in time counts as answered, however long this thread was busy.
 * The server runs on a thread of its own, so a held main thread does not hold it too.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { FetchThread, installFetchThread } from '../src/indexer/fetchThread.js';
import { hlMarkets } from '../src/indexer/streams.js';

const SERVER = `
const { parentPort } = require('node:worker_threads');
const http = require('node:http');
const big = 'x'.repeat(3 * 1024 * 1024);
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (req.url === '/never') return;
    if (req.url === '/big') { res.end(big); return; }
    if (req.url === '/empty') { res.statusCode = 204; res.end(); return; }
    if (req.url === '/missing') { res.statusCode = 404; res.setHeader('x-why', 'gone'); res.end('no'); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ method: req.method, type: req.headers['content-type'] ?? null, body: Buffer.concat(chunks).toString() }));
  });
});
server.listen(0, '127.0.0.1', () => parentPort.postMessage(server.address().port));
`;

let serverThread: Worker;
let base = '';
before(async () => {
  serverThread = new Worker(SERVER, { eval: true });
  const port = await new Promise<number>((r) => serverThread.once('message', r));
  base = `http://127.0.0.1:${port}`;
});
after(async () => { await serverThread.terminate(); });

const hold = (ms: number): void => { const end = Date.now() + ms; while (Date.now() < end); };

test('a response comes back whole: status, headers, JSON, a POST body, no body at all', async () => {
  const t = new FetchThread();
  const post = await t.fetch(`${base}/x`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' });
  assert.equal(post.status, 200);
  assert.equal(post.ok, true);
  assert.equal(post.headers.get('content-type'), 'application/json');
  assert.ok(post.url.endsWith('/x'));
  assert.deepEqual(await post.json(), { method: 'POST', type: 'application/json', body: '{"a":1}' });
  const missing = await t.fetch(new URL(`${base}/missing`));
  assert.equal(missing.status, 404);
  assert.equal(missing.ok, false);
  assert.equal(missing.headers.get('x-why'), 'gone');
  assert.equal(await missing.text(), 'no');
  const empty = await t.fetch(`${base}/empty`);
  assert.equal(empty.status, 204);
  assert.equal(await empty.text(), '');
  t.stop();
});

test('the thread held past the timeout: the old way throws an answer away, this way keeps it', async () => {
  // On this thread: the timer of the timeout runs before the socket that holds the answer.
  const plain = fetch(`${base}/x`, { signal: AbortSignal.timeout(200) }).then((r) => r.text()).then(() => 'answered', (e: Error) => e.name);
  hold(800);
  assert.equal(await plain, 'TimeoutError', 'what production did: a held thread looks like a slow server');

  const t = new FetchThread();
  const res = t.fetch(`${base}/x`, { signal: AbortSignal.timeout(200) }).then((r) => r.status, (e: Error) => e.name);
  hold(800);
  assert.equal(await res, 200);
  t.stop();
});

test('a request that really takes too long still fails with the caller\'s timeout, and leaves nothing waiting', async () => {
  const t = new FetchThread();
  const t0 = Date.now();
  await assert.rejects(t.fetch(`${base}/never`, { signal: AbortSignal.timeout(150) }), (e: Error) => e.name === 'TimeoutError');
  assert.ok(Date.now() - t0 < 5_000);
  assert.equal(t.pending, 0);
  t.stop();
});

test('a caller\'s own abort stops the request, one already aborted never starts', async () => {
  const t = new FetchThread();
  const stop = new AbortController();
  const p = t.fetch(`${base}/never`, { signal: stop.signal });
  setTimeout(() => stop.abort(), 20);
  await assert.rejects(p, (e: Error) => e.name === 'AbortError');
  await assert.rejects(t.fetch(`${base}/x`, { signal: AbortSignal.abort() }), (e: Error) => e.name === 'AbortError');
  assert.equal(t.pending, 0);
  t.stop();
});

test('a connection refused reads as a failed fetch with its cause, as a lane expects', async () => {
  const t = new FetchThread();
  const free = 'http://127.0.0.1:1/';
  await assert.rejects(t.fetch(free), (e: Error & { cause?: { code?: string } }) => e.message === 'fetch failed' && !!e.cause?.code);
  t.stop();
});

test('a large body arrives in pieces with the loop let in between, byte for byte', async () => {
  const t = new FetchThread();
  const res = await t.fetch(`${base}/big`);
  const reader = res.body!.getReader();
  let turns = 0;
  const timer = setInterval(() => turns++, 0);
  let bytes = 0;
  let pieces = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    assert.ok(value.every((c) => c === 120));
    bytes += value.length;
    pieces++;
  }
  clearInterval(timer);
  assert.equal(bytes, 3 * 1024 * 1024);
  assert.ok(pieces >= 40, `pieces ${pieces}`);
  assert.ok(turns >= 5, `the loop ran between pieces (${turns} timer turns)`);
  assert.equal((await (await t.fetch(`${base}/big`)).text()).length, 3 * 1024 * 1024, 'and whole for a caller that wants text');
  t.stop();
});

test('what cannot be carried over goes the old way', async () => {
  const seen: string[] = [];
  const t = new FetchThread(async (input) => { seen.push(input instanceof Request ? 'request' : String(input)); return new Response('old'); });
  assert.equal(await (await t.fetch(new Request(`${base}/x`))).text(), 'old');
  assert.equal(await (await t.fetch(`${base}/x`, { body: new ReadableStream(), method: 'POST', duplex: 'half' } as RequestInit)).text(), 'old');
  assert.equal(await (await t.fetch(`${base}/x`, { dispatcher: {} } as RequestInit)).text(), 'old');
  assert.equal(seen.length, 3);
  t.stop();
});

test('the thread gone: what waited fails as a failed fetch, and the next request starts a new one', async () => {
  const t = new FetchThread();
  await (await t.fetch(`${base}/x`)).text();
  const waiting = t.fetch(`${base}/never`);
  (t as unknown as { worker: Worker }).worker.terminate();
  await assert.rejects(waiting, /fetch failed/);
  assert.equal((await t.fetch(`${base}/x`)).status, 200);
  t.stop();
});

test('the switch: off leaves fetch as it is, on replaces it', () => {
  const was = globalThis.fetch;
  process.env.VALUESCAN_INDEX_FETCH_THREAD = '0';
  assert.equal(installFetchThread(), null);
  assert.equal(globalThis.fetch, was);
  delete process.env.VALUESCAN_INDEX_FETCH_THREAD;
  const t = installFetchThread();
  assert.notEqual(globalThis.fetch, was);
  t!.stop();
  globalThis.fetch = was;
});

// --- Hyperliquid's market list ----------------------------------------------------------------

const lists = (fail: (b: { type: string; dex?: string }) => boolean) => async <T,>(b: { type: string; dex?: string }): Promise<T> => {
  if (fail(b)) throw new Error('timeout');
  if (b.type === 'perpDexs') return [null, { name: 'xyz' }] as T;
  if (b.type === 'spotMeta') return { universe: [{ name: 'PURR/USDC' }] } as T;
  return { universe: b.dex ? [{ name: 'xyz:TSLA' }] : [{ name: 'BTC' }, { name: 'OLD', isDelisted: true }] } as T;
};

test('Hyperliquid\'s list: whole when all reads answer', async () => {
  assert.deepEqual(await hlMarkets(true, lists(() => false)), { markets: ['BTC', 'xyz:TSLA', 'PURR/USDC'], partial: false });
});

test('Hyperliquid\'s list: the main list or spot unread is no list, so the socket tries again rather than subscribing to what is left', async () => {
  await assert.rejects(hlMarkets(true, lists((b) => b.type === 'meta' && !b.dex)), /a read failed/);
  await assert.rejects(hlMarkets(true, lists((b) => b.type === 'spotMeta')), /a read failed/);
});

test('Hyperliquid\'s list: one dex or the dex list unread keeps the venue up and says so', async () => {
  assert.deepEqual(await hlMarkets(true, lists((b) => b.dex === 'xyz')), { markets: ['BTC', 'PURR/USDC'], partial: true });
  assert.deepEqual(await hlMarkets(true, lists((b) => b.type === 'perpDexs')), { markets: ['BTC', 'PURR/USDC'], partial: true });
});

test('Hyperliquid\'s list: the first read waits behind nothing, a refresh yields to the rest', async () => {
  const seen: boolean[] = [];
  const post = async <T,>(b: { type: string; dex?: string }, o: { background: boolean }): Promise<T> => { seen.push(o.background); return lists(() => false)<T>(b); };
  await hlMarkets(true, post);
  assert.ok(seen.every((x) => !x));
  seen.length = 0;
  await hlMarkets(false, post);
  assert.ok(seen.every((x) => x));
});

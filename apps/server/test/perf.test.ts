/**
 * perf.ts: compression and index caching. Everything runs through fastify.inject;
 * nothing listens on a port.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import Fastify from 'fastify';

import { CompressedCache, etagMatches, perfPlugin, pickEncoding, weakEtag, CACHE_POLICIES } from '../src/perf.js';

/** A payload well above the compression threshold, shaped like an index page. */
const BIG = { ok: true, rows: Array.from({ length: 200 }, (_, i) => ({ rank: i + 1, address: `0x${String(i).padStart(40, '0')}`, pnl: { '30d': i * 1234.5 } })) };

/** The plugin plus index.ts's own header hook, in the same order the server has them. */
async function server() {
  const app = Fastify();
  await app.register(perfPlugin);
  app.get('/api/vs/leaderboard', async () => BIG);
  app.get('/api/vs/whales', async () => BIG);
  app.get('/api/acct/positions', async () => BIG);
  app.get('/api/small', async () => ({ ok: true }));
  app.get('/api/text', async (_req, reply) => reply.type('text/plain').send('x'.repeat(5000)));
  app.get('/api/fail', async (_req, reply) => reply.code(500).send(BIG));
  app.addHook('onSend', async (_req, reply, payload) => {
    if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    return payload;
  });
  await app.ready();
  return app;
}

test('pickEncoding: brotli first, then gzip, honouring q=0 and *', () => {
  assert.equal(pickEncoding('gzip, deflate, br, zstd'), 'br');
  assert.equal(pickEncoding('gzip, deflate'), 'gzip');
  assert.equal(pickEncoding('br;q=0, gzip'), 'gzip');
  assert.equal(pickEncoding('br;q=0, gzip;q=0'), null);
  assert.equal(pickEncoding('identity'), null);
  assert.equal(pickEncoding('*'), 'br');
  assert.equal(pickEncoding('*;q=0'), null);
  assert.equal(pickEncoding('x-gzip'), 'gzip');
  assert.equal(pickEncoding(undefined), null);
  assert.equal(pickEncoding(''), null);
});

test('etagMatches: weak comparison, lists, *', () => {
  const e = 'W/"abc"';
  assert.equal(etagMatches('W/"abc"', e), true);
  assert.equal(etagMatches('"abc"', e), true);
  assert.equal(etagMatches('"x", W/"abc"', e), true);
  assert.equal(etagMatches('*', e), true);
  assert.equal(etagMatches('"abd"', e), false);
  assert.equal(etagMatches(undefined, e), false);
});

test('JSON over 1 KiB is brotli-encoded for a client that accepts it, and decodes to the same body', async () => {
  const app = await server();
  const plain = await app.inject({ method: 'GET', url: '/api/acct/positions' });
  const res = await app.inject({ method: 'GET', url: '/api/acct/positions', headers: { 'accept-encoding': 'gzip, deflate, br' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-encoding'], 'br');
  assert.match(String(res.headers.vary), /Accept-Encoding/i);
  assert.equal(brotliDecompressSync(res.rawPayload).toString('utf8'), plain.body);
  assert.ok(res.rawPayload.length < plain.rawPayload.length / 3, 'actually smaller');
  assert.equal(Number(res.headers['content-length']), res.rawPayload.length);
  await app.close();
});

test('gzip when brotli is not accepted; identity when nothing is', async () => {
  const app = await server();
  const gz = await app.inject({ method: 'GET', url: '/api/acct/positions', headers: { 'accept-encoding': 'gzip' } });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.deepEqual(JSON.parse(gunzipSync(gz.rawPayload).toString('utf8')), BIG);
  const none = await app.inject({ method: 'GET', url: '/api/acct/positions' });
  assert.equal(none.headers['content-encoding'], undefined);
  assert.deepEqual(JSON.parse(none.body), BIG);
  assert.match(String(none.headers.vary), /Accept-Encoding/i, 'the response still varies by it');
  await app.close();
});

test('small bodies, non-JSON and HEAD are left alone', async () => {
  const app = await server();
  const small = await app.inject({ method: 'GET', url: '/api/small', headers: { 'accept-encoding': 'br' } });
  assert.equal(small.headers['content-encoding'], undefined);
  const text = await app.inject({ method: 'GET', url: '/api/text', headers: { 'accept-encoding': 'br' } });
  assert.equal(text.headers['content-encoding'], undefined);
  const head = await app.inject({ method: 'HEAD', url: '/api/acct/positions', headers: { 'accept-encoding': 'br' } });
  assert.equal(head.headers['content-encoding'], undefined);
  await app.close();
});

test('account data keeps no-store and gets no ETag; errors are never cached', async () => {
  const app = await server();
  const acct = await app.inject({ method: 'GET', url: '/api/acct/positions' });
  assert.equal(acct.headers['cache-control'], 'no-store');
  assert.equal(acct.headers.etag, undefined);
  const fail = await app.inject({ method: 'GET', url: '/api/fail' });
  assert.equal(fail.statusCode, 500);
  assert.equal(fail.headers['cache-control'], 'no-store');
  assert.equal(fail.headers.etag, undefined);
  await app.close();
});

test('index routes: their Cache-Control, a weak ETag, and 304 with no body on a match', async () => {
  const app = await server();
  const first = await app.inject({ method: 'GET', url: '/api/vs/leaderboard?window=30d', headers: { 'accept-encoding': 'br' } });
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers['cache-control'], CACHE_POLICIES['/api/vs/leaderboard']!.cacheControl);
  const etag = String(first.headers.etag);
  assert.match(etag, /^W\/"[A-Za-z0-9_-]{27}"$/);
  assert.equal(etag, weakEtag(Buffer.from(JSON.stringify(BIG))), 'the ETag is over the uncompressed JSON');

  const again = await app.inject({ method: 'GET', url: '/api/vs/leaderboard?window=30d', headers: { 'accept-encoding': 'br', 'if-none-match': etag } });
  assert.equal(again.statusCode, 304);
  assert.equal(again.rawPayload.length, 0);
  assert.equal(again.headers.etag, etag);

  const other = await app.inject({ method: 'GET', url: '/api/vs/leaderboard?window=30d', headers: { 'if-none-match': 'W/"stale"' } });
  assert.equal(other.statusCode, 200);
  assert.deepEqual(JSON.parse(other.body), BIG);

  const live = await app.inject({ method: 'GET', url: '/api/vs/whales' });
  assert.equal(live.headers['cache-control'], 'public, no-cache');
  assert.ok(live.headers.etag);
  await app.close();
});

test('index bodies are compressed once per content and encoding', async () => {
  const app = await server();
  const a = await app.inject({ method: 'GET', url: '/api/vs/leaderboard', headers: { 'accept-encoding': 'br' } });
  const b = await app.inject({ method: 'GET', url: '/api/vs/leaderboard', headers: { 'accept-encoding': 'br' } });
  assert.ok(a.rawPayload.equals(b.rawPayload));
  assert.equal(brotliDecompressSync(b.rawPayload).toString('utf8'), JSON.stringify(BIG));
  await app.close();
});

test('CompressedCache stays within its bounds', () => {
  const c = new CompressedCache(3, 1000);
  for (let i = 0; i < 10; i++) c.set(`k${i}`, Buffer.alloc(100));
  assert.equal(c.size, 3);
  assert.ok(c.get('k9') && !c.get('k0'));
  const d = new CompressedCache(100, 1000);
  for (let i = 0; i < 10; i++) d.set(`k${i}`, Buffer.alloc(200));
  assert.ok(d.size <= 5, 'the byte bound applies too');
  d.set('huge', Buffer.alloc(900));
  assert.equal(d.get('huge'), undefined, 'an entry larger than a quarter of the budget is not kept');
});

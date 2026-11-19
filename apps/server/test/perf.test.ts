/**
 * perf.ts: compression and index caching. Everything runs through fastify.inject;
 * nothing listens on a port.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import Fastify from 'fastify';

import { CompressedCache, bestCompressionIdle, etagMatches, isFailure, isLongLived, omitNullLabels, perfPlugin, pickEncoding, prepareJson, sendPrepared, serverTiming, weakEtag, CACHE_POLICIES } from '../src/perf.js';

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

test('omitNullLabels: only members named label with the value null, with one comma', () => {
  const same = (v: unknown) => assert.equal(omitNullLabels(JSON.stringify(v)), JSON.stringify(v));
  const to = (v: unknown, want: unknown) => {
    const out = omitNullLabels(JSON.stringify(v));
    assert.equal(out, JSON.stringify(want));
    JSON.parse(out);
  };
  to({ label: null }, {});
  to({ label: null, a: 1 }, { a: 1 });
  to({ a: 1, label: null }, { a: 1 });
  to({ a: 1, label: null, b: 2 }, { a: 1, b: 2 });
  to({ rows: [{ address: '0x1', label: null, pnl: {} }, { label: null }, { x: null, label: null }] }, { rows: [{ address: '0x1', pnl: {} }, {}, { x: null }] });
  to({ row: { venue: 'hyperliquid', address: '0x1', label: null, accountValue: 1 } }, { row: { venue: 'hyperliquid', address: '0x1', accountValue: 1 } });
  // A name is data: it stays. So do other nulls and other keys.
  same({ label: 'Majors' });
  same({ label: 0, xlabel: null, labels: null, Label: null });
  same({ a: ['label', null], b: 'label' });
  // The text inside a string, in a value and in a key, is never touched.
  same({ note: '"label":null', other: ',"label":null,' });
  same({ 'a"label': null, 'a,"label': null, '\\"label': null });
  to({ 'a"label': null, label: null }, { 'a"label': null });
  same({ note: 'ends with a backslash\\', label: 'x' });
  to({ note: 'ends with a backslash\\', label: null }, { note: 'ends with a backslash\\' });
  // Not compact JSON: left alone rather than guessed at.
  assert.equal(omitNullLabels('{ "label": null }'), '{ "label": null }');
});

test('index answers go out without label: null, hashed and compressed as sent; other routes keep it', async () => {
  const rows = Array.from({ length: 120 }, (_, i) => ({ venue: 'sodex', address: `0x${String(i).padStart(40, '0')}`, label: null, pnl: { '30d': i } }));
  const app = Fastify();
  await app.register(perfPlugin);
  app.get('/api/vs/leaderboard', async () => ({ ok: true, rows }));
  app.get('/api/vs/lbrow', async () => ({ ok: true, row: { ...rows[0], rank: 1 } }));
  app.get('/api/vs/trader', async () => ({ ok: true, rows }));
  await app.ready();

  const want = JSON.stringify({ ok: true, rows: rows.map(({ label: _label, ...r }) => r) });
  const plain = await app.inject({ method: 'GET', url: '/api/vs/leaderboard' });
  assert.equal(plain.body, want);
  assert.equal(Number(plain.headers['content-length']), Buffer.byteLength(want));
  assert.equal(plain.headers.etag, weakEtag(Buffer.from(want)), 'the ETag is over what is sent');

  const br = await app.inject({ method: 'GET', url: '/api/vs/leaderboard', headers: { 'accept-encoding': 'br' } });
  assert.equal(brotliDecompressSync(br.rawPayload).toString('utf8'), want);
  assert.equal(br.headers.etag, plain.headers.etag);
  const head = await app.inject({ method: 'HEAD', url: '/api/vs/leaderboard' });
  assert.equal(head.headers.etag, plain.headers.etag);

  const lbrow = await app.inject({ method: 'GET', url: '/api/vs/lbrow?venue=hyperliquid&address=0x1' });
  assert.equal('label' in lbrow.json().row, false);
  assert.equal(lbrow.json().row.rank, 1);
  assert.equal(lbrow.headers['cache-control'], 'public, max-age=10, stale-while-revalidate=20');
  assert.ok(lbrow.headers.etag);

  // Not an index route: its answer is its own business.
  const trader = await app.inject({ method: 'GET', url: '/api/vs/trader' });
  assert.equal(trader.json().rows[0].label, null);
  await app.close();
});

test('boards may be reused for ten seconds, and for twenty more while a cache fetches the next copy', () => {
  for (const route of ['/api/vs/leaderboard', '/api/vs/explore', '/api/vs/screener', '/api/vs/lbrow']) {
    assert.equal(CACHE_POLICIES[route]!.cacheControl, 'public, max-age=10, stale-while-revalidate=20', route);
  }
  // The cohort pages follow the cohort load (about a minute) and get each new one pushed (routes/liveHub.ts): 30 s + 30.
  for (const route of ['/api/vs/cohorts', '/api/vs/cohorts/detail', '/api/vs/cohorts/map', '/api/vs/cohorts/focus', '/api/vs/cohorts/wallets']) {
    assert.equal(CACHE_POLICIES[route]!.cacheControl, 'public, max-age=30, stale-while-revalidate=30', route);
  }
  // Every tab's health poll may be shared ten seconds at the edge, never stale.
  assert.equal(CACHE_POLICIES['/api/health']!.cacheControl, 'public, max-age=10');
  for (const route of ['/api/vs/whales', '/api/vs/positioning']) assert.equal(CACHE_POLICIES[route]!.cacheControl, 'public, no-cache', route);
});

test('the maintenance flag may be shared for ten seconds, without a stale copy after that', () => {
  assert.equal(CACHE_POLICIES['/api/external/maintenance/status']!.cacheControl, 'public, max-age=10');
});

test('a failure answered as 200 {ok:false} on an index route is not cacheable and gets no ETag', async () => {
  const app = Fastify();
  await app.register(perfPlugin);
  let down = true;
  app.get('/api/vs/explore', async (_req, reply) => (down
    ? reply.code(200).send({ ok: false, code: 'upstream', error: 'explore: sodex leaderboard timed out', label: null, pad: 'x'.repeat(2000) })
    : { ok: true, segments: [] }));
  app.addHook('onSend', async (_req, reply, payload) => {
    if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    return payload;
  });
  await app.ready();

  const failed = await app.inject({ method: 'GET', url: '/api/vs/explore', headers: { 'accept-encoding': 'br' } });
  assert.equal(failed.statusCode, 200);
  assert.equal(failed.headers['cache-control'], 'no-store');
  assert.equal(failed.headers.etag, undefined);
  assert.equal(failed.headers['content-encoding'], 'br', 'still compressed');
  const body = JSON.parse(brotliDecompressSync(failed.rawPayload).toString('utf8'));
  assert.equal(body.ok, false);
  assert.equal(body.label, null, 'and sent as the route wrote it');

  down = false;
  const ok = await app.inject({ method: 'GET', url: '/api/vs/explore' });
  assert.equal(ok.headers['cache-control'], 'public, max-age=10, stale-while-revalidate=20');
  assert.ok(ok.headers.etag);
  assert.equal(isFailure('{"ok":true,"rows":[]}'), false);
  assert.equal(isFailure(Buffer.from('{"ok":false,"error":"x"}')), true);
  await app.close();
});

test('an answer kept a day is sent at quality 5 first, then its quality-11 copy, smaller and the same once decoded', async () => {
  // A final heatmap tile's shape: rows of numbers, a few hundred KB of JSON.
  let x = 5;
  const r = () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
  const tile = { ok: true, final: true, points: Array.from({ length: 96 }, (_, k) => ({ t: 1_763_000_000_000 + k * 900_000, p: 80_000 + k, st: 100, b: Array.from({ length: 50 }, (_, i) => [800 + i, Math.round(r() ** 3 * 5e6), Math.round(r() ** 4 * 2e6)]) })) };
  const app = Fastify();
  await app.register(perfPlugin, { policies: { '/api/vs/liquidations/tiles': { cacheControl: 'public, max-age=60', own: true } } });
  app.get('/api/vs/liquidations/tiles', async (req, reply) => {
    reply.header('Cache-Control', (req.query as { final?: string }).final === '0' ? 'public, max-age=60, stale-while-revalidate=120' : 'public, max-age=86400, stale-while-revalidate=86400');
    return tile;
  });
  await app.ready();
  const plain = JSON.stringify(tile);
  const first = await app.inject({ method: 'GET', url: '/api/vs/liquidations/tiles', headers: { 'accept-encoding': 'br' } });
  assert.equal(brotliDecompressSync(first.rawPayload).toString('utf8'), plain);
  await bestCompressionIdle();
  const second = await app.inject({ method: 'GET', url: '/api/vs/liquidations/tiles', headers: { 'accept-encoding': 'br' } });
  assert.equal(brotliDecompressSync(second.rawPayload).toString('utf8'), plain);
  assert.ok(second.rawPayload.length < first.rawPayload.length, `quality 11 ${second.rawPayload.length} B against 5 ${first.rawPayload.length} B`);
  assert.equal(second.headers.etag, first.headers.etag, 'the same answer');
  // Not kept a day (the index, a slot still filling): quality 5 every time.
  const live1 = await app.inject({ method: 'GET', url: '/api/vs/liquidations/tiles?final=0', headers: { 'accept-encoding': 'br' } });
  await bestCompressionIdle();
  const live2 = await app.inject({ method: 'GET', url: '/api/vs/liquidations/tiles?final=0', headers: { 'accept-encoding': 'br' } });
  assert.ok(live1.rawPayload.equals(live2.rawPayload));
  assert.equal(live1.rawPayload.length, first.rawPayload.length);
  // gzip is never touched.
  const gz = await app.inject({ method: 'GET', url: '/api/vs/liquidations/tiles', headers: { 'accept-encoding': 'gzip' } });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.equal(isLongLived('public, max-age=86400, stale-while-revalidate=86400'), true);
  assert.equal(isLongLived('public, s-maxage=86400, max-age=60'), false);
  assert.equal(isLongLived('no-store'), false);
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

test('Server-Timing on every answer: the handler, its serialization, the trim and ETag, compression and the total', async () => {
  const app = await server();
  const idx = await app.inject({ method: 'GET', url: '/api/vs/leaderboard', headers: { 'accept-encoding': 'br' } });
  const st = String(idx.headers['server-timing']);
  for (const part of ['pre', 'app', 'json', 'etag', 'cmp', 'tot']) assert.match(st, new RegExp(`(^|, )${part};dur=\\d+(\\.\\d+)?(,|$)`), `${part} in ${st}`);
  // Every other answer too, even one perf.ts leaves alone.
  const acct = await app.inject({ method: 'GET', url: '/api/acct/positions' });
  assert.match(String(acct.headers['server-timing']), /app;dur=.*tot;dur=/);
  const text = await app.inject({ method: 'GET', url: '/api/text' });
  assert.match(String(text.headers['server-timing']), /tot;dur=/);
  const not = await app.inject({ method: 'GET', url: '/api/vs/leaderboard', headers: { 'if-none-match': String(idx.headers.etag) } });
  assert.equal(not.statusCode, 304);
  assert.match(String(not.headers['server-timing']), /etag;dur=.*tot;dur=/);
  await app.close();
});

test('a route adds its own parts; bad names and descriptions are left out', async () => {
  const app = Fastify();
  await app.register(perfPlugin);
  app.get('/api/x', async (_req, reply) => {
    serverTiming(reply, 'thr', 12.345);
    serverTiming(reply, 'memo', undefined, 'hit');
    serverTiming(reply, 'Bad Name', 1);
    serverTiming(reply, 'evil', undefined, 'a"b, c=d');
    return { ok: true };
  });
  await app.ready();
  const res = await app.inject({ method: 'GET', url: '/api/x' });
  const st = String(res.headers['server-timing']);
  assert.match(st, /thr;dur=12\.35/);
  assert.match(st, /memo;desc=hit/);
  assert.doesNotMatch(st, /Bad Name|a"b/);
  assert.match(st, /(^|, )evil(,|$)/, 'the name stays, the description does not');
  await app.close();
});

test('a prepared body goes out as the same bytes with the same ETag as the text it was made from, trimmed once', async () => {
  const json = JSON.stringify({ ok: true, rows: Array.from({ length: 80 }, (_, i) => ({ address: `0x${String(i).padStart(40, '0')}`, label: null, v: i })) });
  const prepared = prepareJson(json);
  assert.equal(prepared.buf.toString('utf8'), omitNullLabels(json));
  assert.equal(prepared.etag, weakEtag(Buffer.from(omitNullLabels(json))));
  assert.equal(prepareJson(json, false).buf.toString('utf8'), json);
  const app = Fastify();
  await app.register(perfPlugin);
  app.get('/api/vs/cohorts', async (req, reply) => ((req.query as { p?: string }).p
    ? sendPrepared(reply, prepared)
    : reply.type('application/json; charset=utf-8').send(json)));
  await app.ready();
  const text = await app.inject({ method: 'GET', url: '/api/vs/cohorts' });
  const prep = await app.inject({ method: 'GET', url: '/api/vs/cohorts?p=1' });
  assert.equal(prep.body, text.body);
  assert.equal(prep.headers.etag, text.headers.etag);
  assert.equal(prep.headers['cache-control'], text.headers['cache-control']);
  const br = await app.inject({ method: 'GET', url: '/api/vs/cohorts?p=1', headers: { 'accept-encoding': 'br' } });
  assert.equal(brotliDecompressSync(br.rawPayload).toString('utf8'), text.body);
  const not = await app.inject({ method: 'GET', url: '/api/vs/cohorts?p=1', headers: { 'if-none-match': String(text.headers.etag) } });
  assert.equal(not.statusCode, 304);
  await app.close();
});

test('routes with their own Cache-Control get an ETag, 304s and the compressed cache, sent exactly as built', async () => {
  for (const route of ['/api/vs/bots/markets', '/api/vs/bots/regime', '/api/vs/sodex/mm-daily', '/api/vs/sodex/lottery/meta', '/api/vs/sodex/lottery/feed', '/api/vs/sodex/wealth/maintenance', '/api/vs/fed/live', '/api/vs/fedwatch', '/api/vs/fedwatch/history', '/api/vs/indicator', '/api/vs/etf/flows']) {
    assert.equal(CACHE_POLICIES[route]?.own, true, route);
    assert.equal(CACHE_POLICIES[route]?.trim, false, route);
  }
  // Its body carries the request's own time: never the same twice.
  assert.equal(CACHE_POLICIES['/api/vs/calendar/results'], undefined);

  const app = Fastify();
  await app.register(perfPlugin);
  let failing = false;
  app.get('/api/vs/bots/markets', async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    return { ok: true, at: 1, markets: Array.from({ length: 60 }, (_, i) => ({ symbol: `C${i}-USD`, label: null, bps: i })) };
  });
  // mm-daily sets its Cache-Control before its read: a failure after that must not be cached.
  app.get('/api/vs/sodex/mm-daily', async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=600');
    if (failing) return reply.code(200).send({ ok: false, code: 'upstream', error: 'down' });
    return { ok: true, days: [] };
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    return payload;
  });
  await app.ready();
  const a = await app.inject({ method: 'GET', url: '/api/vs/bots/markets', headers: { 'accept-encoding': 'br' } });
  assert.equal(a.headers['cache-control'], 'public, max-age=60, stale-while-revalidate=300', 'the route\'s own');
  assert.ok(a.headers.etag);
  assert.match(brotliDecompressSync(a.rawPayload).toString('utf8'), /"label":null/, 'not trimmed: these are not trader rows');
  const b = await app.inject({ method: 'GET', url: '/api/vs/bots/markets', headers: { 'accept-encoding': 'br' } });
  assert.ok(b.rawPayload.equals(a.rawPayload));
  const c = await app.inject({ method: 'GET', url: '/api/vs/bots/markets', headers: { 'if-none-match': String(a.headers.etag) } });
  assert.equal(c.statusCode, 304);
  assert.equal(c.rawPayload.length, 0);

  const good = await app.inject({ method: 'GET', url: '/api/vs/sodex/mm-daily' });
  assert.equal(good.headers['cache-control'], 'public, max-age=600');
  failing = true;
  const bad = await app.inject({ method: 'GET', url: '/api/vs/sodex/mm-daily' });
  assert.equal(bad.json().ok, false);
  assert.equal(bad.headers['cache-control'], 'no-store', 'a failure is never cached');
  assert.equal(bad.headers.etag, undefined);
  await app.close();
});

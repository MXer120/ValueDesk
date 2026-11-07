/**
 * Signed-write latency (latency.ts) and GET /api/copy/v1/bots/latency (server.ts): place vs cancel, percentiles
 * from a histogram within a few ms, 10-minute rollover, buckets kept across a re-open of the database, the
 * route's shape and its hours clamp.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { ExecutorConfig } from '../src/config.ts';
import { ExecutorDb } from '../src/db.ts';
import { classifyWrite, clampHours, Hist, LATENCY_BUCKET_MS, WriteLatency, type BotLatencyResponse } from '../src/latency.ts';
import { createExecutorServer } from '../src/server.ts';
import type { ExecutorService } from '../src/service.ts';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const TOKYO = [{ id: 'tokyo', label: 'Tokyo · SoDEX', where: 'ap-northeast-1 (Tokyo)' }];
const T0 = 1_700_000_400_000; // a bucket start (divisible by 600 000)
const place = (ms: number) => ({ method: 'POST', path: '/api/v1/perps/trade/orders', queueMs: 0, wireMs: ms, status: 200 });
const cancel = (ms: number) => ({ method: 'DELETE', path: '/api/v1/perps/trade/orders', queueMs: 2, wireMs: ms - 2, status: 200 });

test('classify: orders are place, deletes and cancel paths are cancel, leverage is neither', () => {
  assert.equal(classifyWrite('POST', '/api/v1/perps/trade/orders'), 'place');
  assert.equal(classifyWrite('POST', '/api/v1/spot/trade/orders/batch'), 'place');
  assert.equal(classifyWrite('POST', '/api/v1/perps/trade/orders/replace'), 'place');
  assert.equal(classifyWrite('DELETE', '/api/v1/perps/trade/orders'), 'cancel');
  assert.equal(classifyWrite('DELETE', '/api/v1/spot/trade/orders/batch'), 'cancel');
  assert.equal(classifyWrite('POST', '/api/v1/perps/trade/orders/schedule-cancel'), 'cancel');
  assert.equal(classifyWrite('POST', '/api/v1/perps/trade/leverage'), null);
  assert.equal(classifyWrite('GET', '/api/v1/perps/trade/orders'), null);
});

test('histogram: p50/p95/p99 of a synthetic sample within 0.5 % (a few ms)', () => {
  // 20 000 samples, a skewed spread 30 ms .. 3 s, against the exact nearest-rank percentiles.
  let seed = 7;
  const rnd = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
  const xs: number[] = [];
  const h = new Hist();
  for (let i = 0; i < 20_000; i++) {
    const v = 30 + 370 * rnd() + (rnd() < 0.05 ? 2_600 * rnd() : 0);
    xs.push(v);
    h.add(v);
  }
  xs.sort((a, b) => a - b);
  for (const p of [0.5, 0.95, 0.99]) {
    const exact = xs[Math.ceil(p * xs.length) - 1]!;
    const got = h.quantile(p)!;
    assert.ok(Math.abs(got - exact) <= Math.max(0.6, exact * 0.006), `p${p * 100}: ${got} vs ${exact}`);
  }
  assert.equal(new Hist().quantile(0.5), null);
  const round = Hist.decode(h.encode());
  assert.equal(round.n, h.n);
  assert.equal(round.quantile(0.99), h.quantile(0.99));
  // Below 100 ms: 1 ms bins.
  const s = new Hist();
  for (const v of [10, 20, 30, 40, 50]) s.add(v);
  assert.equal(s.quantile(0.5), 30.5);
});

test('rollover: a write in the next 10 minutes closes the bucket and writes it; recording never throws', () => {
  let now = T0 + 1_000;
  const saved: unknown[] = [];
  const store = { saveLatency: (rows: unknown[]) => saved.push(...rows), loadLatency: () => [] };
  const lat = new WriteLatency(TOKYO, store, () => now);
  for (let i = 0; i < 10; i++) lat.record('tokyo', place(100 + i));
  lat.record('tokyo', cancel(50));
  assert.equal(saved.length, 0, 'the open bucket is not written yet');
  now = T0 + LATENCY_BUCKET_MS + 5;
  lat.record('tokyo', place(200));
  assert.equal(saved.length, 2, 'place and cancel of the closed bucket');
  assert.deepEqual((saved as Array<{ t: number; kind: string; n: number }>).map((r) => [r.t, r.kind, r.n]), [[T0, 'place', 10], [T0, 'cancel', 1]]);
  const v = lat.view(1);
  assert.equal(v.regions[0]!.buckets.length, 6);
  assert.deepEqual(v.regions[0]!.buckets.slice(-2).map((b) => b.n), [11, 1]);
  // A store that throws, a region that does not exist, a garbage timing: nothing reaches the write path.
  const bad = new WriteLatency(TOKYO, { saveLatency: () => { throw new Error('disk full'); }, loadLatency: () => { throw new Error('locked'); } }, () => now);
  assert.doesNotThrow(() => {
    bad.record('tokyo', place(10));
    bad.record('nowhere', place(10));
    bad.record('tokyo', { method: 'POST', path: '/api/v1/perps/trade/orders', queueMs: NaN, wireMs: Infinity, status: 0 });
    now += LATENCY_BUCKET_MS;
    bad.record('tokyo', place(10));
    bad.stop();
  });
});

test('persistence: buckets survive a re-open of the database (closed ones and the open one written on stop)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vd-latency-'));
  const path = join(dir, 'executor.db');
  try {
    let now = T0 + 1_000;
    let db = new ExecutorDb(path);
    let lat = new WriteLatency(TOKYO, db, () => now);
    for (let i = 0; i < 100; i++) lat.record('tokyo', place(300 + i));
    now = T0 + LATENCY_BUCKET_MS + 1_000;
    for (let i = 0; i < 50; i++) lat.record('tokyo', cancel(80));
    const before = lat.view(24).regions[0]!.buckets.filter((b) => b.n);
    lat.stop();
    db.close();

    db = new ExecutorDb(path);
    lat = new WriteLatency(TOKYO, db, () => now);
    const after = lat.view(24).regions[0]!;
    assert.deepEqual(after.buckets.filter((b) => b.n), before);
    assert.equal(after.kinds.place.n, 100);
    assert.equal(after.kinds.cancel.n, 50);
    // The open bucket, loaded back, keeps growing and is written again as a whole.
    lat.record('tokyo', cancel(90));
    lat.stop();
    db.close();
    db = new ExecutorDb(path);
    lat = new WriteLatency(TOKYO, db, () => now);
    assert.equal(lat.view(1).regions[0]!.buckets.at(-1)!.n, 51);
    // Older than 48 h: not read back.
    now += 49 * 3_600_000;
    assert.equal(new WriteLatency(TOKYO, db, () => now).view(48).regions[0]!.buckets.filter((b) => b.n).length, 0);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hours: 1..48, clamped; 24 when missing or unreadable', () => {
  assert.equal(clampHours(null), 24);
  assert.equal(clampHours(''), 24);
  assert.equal(clampHours('abc'), 24);
  assert.equal(clampHours('0'), 1);
  assert.equal(clampHours('-5'), 1);
  assert.equal(clampHours('6'), 6);
  assert.equal(clampHours('1000'), 48);
});

test('GET /api/copy/v1/bots/latency: public, the contract shape, hours clamped', async () => {
  const now = T0 + 120_000;
  const lat = new WriteLatency(TOKYO, null, () => now);
  for (let i = 0; i < 40; i++) lat.record('tokyo', place(350 + i));
  for (let i = 0; i < 10; i++) lat.record('tokyo', cancel(60 + i));
  const svc = { latency: lat, info: () => ({}), health: () => ({}), audit: () => {} } as unknown as ExecutorService;
  const cfg = { trustEdge: false, allowedOrigins: [], originSecrets: [] } as unknown as ExecutorConfig;
  const server = createExecutorServer(svc, cfg, silent);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/copy/v1/bots/latency`;
  try {
    const res = await fetch(base);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = (await res.json()) as BotLatencyResponse;
    assert.deepEqual(Object.keys(body).sort(), ['at', 'bucketMs', 'regions']);
    assert.equal(body.at, now);
    assert.equal(body.bucketMs, 600_000);
    assert.equal(body.regions.length, 1);
    const r = body.regions[0]!;
    assert.deepEqual(Object.keys(r).sort(), ['buckets', 'id', 'kinds', 'label', 'now', 'where']);
    assert.deepEqual([r.id, r.label, r.where], ['tokyo', 'Tokyo · SoDEX', 'ap-northeast-1 (Tokyo)']);
    assert.equal(r.buckets.length, 24 * 6);
    assert.deepEqual(Object.keys(r.buckets[0]!).sort(), ['n', 'p50', 'p95', 'p99', 't']);
    assert.equal(r.buckets[0]!.n, 0);
    assert.equal(r.buckets[0]!.p50, null);
    const last = r.buckets.at(-1)!;
    assert.equal(last.t, T0);
    assert.equal(last.n, 50);
    assert.ok(last.p50! > 340 && last.p50! < 375, `p50 ${last.p50}`);
    assert.equal(r.now.n, 50);
    assert.ok(r.now.p99! >= r.now.p95! && r.now.p95! >= r.now.p50!);
    assert.equal(r.kinds.place.n, 40);
    assert.equal(r.kinds.cancel.n, 10);
    assert.ok(Math.abs(r.kinds.cancel.p50! - 64.5) <= 1, `cancel p50 ${r.kinds.cancel.p50}`);
    for (const [q, n] of [['?hours=1', 6], ['?hours=0', 6], ['?hours=999', 288], ['?hours=x', 144], ['?hours=12', 72]] as const) {
      const b = (await (await fetch(base + q)).json()) as BotLatencyResponse;
      assert.equal(b.regions[0]!.buckets.length, n, q);
    }
  } finally {
    server.close();
  }
});

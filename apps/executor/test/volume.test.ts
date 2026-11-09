/**
 * The copy fee step on the hosted executor when the builder ledger lives on the
 * API server: the follower's volume is read from GET /api/vs/builder/volume with
 * the internal token, kept for 10 minutes, and a failed read keeps the last answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchLike, WebSocketLike } from '../../../packages/copy-engine/src/index.ts';
import { loadConfig } from '../src/config.ts';
import { ExecutorDb } from '../src/db.ts';
import { Secrets } from '../src/secrets.ts';
import { ExecutorService } from '../src/service.ts';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const noWs = (): WebSocketLike => ({ readyState: 0, send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null });
const OWNER = '0x1111111111111111111111111111111111111111';

function make(answer: () => { status: number; body: unknown }) {
  const dir = mkdtempSync(join(tmpdir(), 'vd-volume-'));
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const a = answer();
    return { status: a.status, ok: a.status < 400, text: async () => JSON.stringify(a.body) };
  };
  const cfg = loadConfig({
    EXECUTOR_DATA_DIR: dir, EXECUTOR_KIND: 'hosted', EXECUTOR_ORIGIN_SECRET: 'edge-secret', EXECUTOR_BUILDER_ID: '234812',
    EXECUTOR_BUILDER_URL: 'https://api.example/api/vs/builder/volume', EXECUTOR_BUILDER_TOKEN: 'internal-token',
  });
  const db = new ExecutorDb(':memory:');
  const svc = new ExecutorService(cfg, db, new Secrets(dir), { fetch, factory: noWs, log: silent });
  const fresh = (o: string) => (svc as unknown as { freshVolume(o: string): Promise<number | null> }).freshVolume(o);
  return { svc, calls, fresh, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('volume: read from the API with the internal token and the origin secret, then kept', async () => {
  const { calls, fresh, cleanup } = make(() => ({ status: 200, body: { ok: true, usd: 250_000, days: 14 } }));
  assert.equal(await fresh(OWNER), 250_000);
  assert.equal(await fresh(OWNER), 250_000);
  assert.equal(calls.length, 1, 'one read for ten minutes');
  const u = new URL(calls[0]!.url);
  assert.equal(u.searchParams.get('address'), OWNER);
  assert.equal(u.searchParams.get('builder'), '234812');
  assert.equal(u.searchParams.get('days'), '14');
  assert.equal(calls[0]!.headers['X-Internal-Token'], 'internal-token');
  assert.equal(calls[0]!.headers['X-Origin-Verify'], 'edge-secret');
  cleanup();
});

test('volume: two reads at once share one request; a failure keeps the last answer', async () => {
  let fail = false;
  const { calls, fresh, cleanup } = make(() => (fail ? { status: 503, body: { ok: false } } : { status: 200, body: { ok: true, usd: 80_000 } }));
  const [a, b] = await Promise.all([fresh(OWNER), fresh(OWNER)]);
  assert.equal(a, 80_000);
  assert.equal(b, 80_000);
  assert.equal(calls.length, 1);
  fail = true;
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60_000;
  try {
    assert.equal(await fresh(OWNER), 80_000, 'not dropped to the first (dearest) step');
  } finally {
    Date.now = realNow;
  }
  cleanup();
});

test('volume: a builder URL that is not https is refused at start', () => {
  assert.throws(() => loadConfig({ EXECUTOR_KIND: 'hosted', EXECUTOR_EDGE: 'none', EXECUTOR_BUILDER_URL: 'http://api.example/x', EXECUTOR_DATA_DIR: tmpdir() }), /https/);
});

test('fees: VIP and a program from the same read lower copy and bot fees; a program stops counting the moment it ends', async () => {
  const until = Date.now() + 60_000;
  const { svc, fresh, cleanup } = make(() => ({ status: 200, body: { ok: true, usd: 50_000, days: 14, vip: false, fees: { copy: { fee: 0, until }, bots: null } } }));
  const fee = (spec: Record<string, unknown>) => (svc as unknown as { algoFee(a: { owner: string; spec: unknown }): Promise<number> }).algoFee({ owner: OWNER, spec });
  await fresh(OWNER);
  assert.equal(await fee({ kind: 'twap' }), 0, 'copy and algo orders: the program, 0');
  assert.equal(await fee({ kind: 'mm', bot: true }), 3, 'bots: not in the program, the bot ladder ($50K: 0.3 bp)');
  const realNow = Date.now;
  Date.now = () => until + 1;
  try {
    assert.equal((svc as unknown as { copyFee(o: string, v: number | null): number }).copyFee(OWNER, 50_000), 25, 'ended: back on the copy ladder');
  } finally {
    Date.now = realNow;
  }
  cleanup();
  const v = make(() => ({ status: 200, body: { ok: true, usd: 50_000, days: 14, vip: true, fees: { copy: { fee: 10, until: null }, bots: { fee: 1, until: null } } } }));
  await v.fresh(OWNER);
  const vfee = (spec: Record<string, unknown>) => (v.svc as unknown as { algoFee(a: { owner: string; spec: unknown }): Promise<number> }).algoFee({ owner: OWNER, spec });
  assert.equal(await vfee({ kind: 'mm', bot: true }), 1, 'VIP: the lowest bot step');
  assert.equal(await vfee({ kind: 'twap' }), 10, 'VIP: the lowest copy step');
  v.cleanup();
});

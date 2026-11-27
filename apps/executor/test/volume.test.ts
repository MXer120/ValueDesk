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
import { DatabaseSync } from 'node:sqlite';
import { loadConfig, perksUrlFrom } from '../src/config.ts';
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
  assert.equal(await fee({ kind: 'mm', bot: true }), 2, 'bots: not in the program, the bot ladder (0.2 bp)');
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

test('fees: the invite welcome and fee credits come with a budget - the lowered fee holds until this executor\'s own fills use it up', async () => {
  const through = Date.now() - 1_000;
  const until = Date.now() + 3 * 60_000;
  // The welcome: $1,000 of volume left at fee 0, every dollar of either product using a dollar of it.
  const { svc, fresh, cleanup } = make(() => ({ status: 200, body: { ok: true, usd: 50_000, days: 14, vip: false, fees: {
    copy: { fee: 0, until, budget: { kind: 'welcome', capUsd: 1_000, perUsd: { copy: 1, bots: 1 }, through } },
    bots: { fee: 0, until, budget: { kind: 'welcome', capUsd: 1_000, perUsd: { copy: 1, bots: 1 }, through } },
  } } }));
  const s = svc as unknown as { algoFee(a: { owner: string; spec: unknown }): Promise<number>; noteFill(o: string, p: 'copy' | 'bots', usd: number, at: number): void };
  await fresh(OWNER);
  assert.equal(await s.algoFee({ owner: OWNER, spec: { kind: 'mm', bot: true } }), 0, 'bots: the welcome');
  // Fills from before the ledger's read are in the budget already: they use nothing up.
  s.noteFill(OWNER, 'bots', 5_000, through - 10);
  assert.equal(await s.algoFee({ owner: OWNER, spec: { kind: 'mm', bot: true } }), 0);
  s.noteFill(OWNER, 'bots', 600, Date.now());
  assert.equal(await s.algoFee({ owner: OWNER, spec: { kind: 'mm', bot: true } }), 0, '$600 of $1,000 used');
  s.noteFill(OWNER, 'copy', 400, Date.now());
  assert.equal(await s.algoFee({ owner: OWNER, spec: { kind: 'mm', bot: true } }), 2, 'used up: the bot ladder (0.2 bp), until a read says more is left');
  assert.equal(await s.algoFee({ owner: OWNER, spec: { kind: 'twap' } }), 25, 'copy and algos too');
  cleanup();

  // Credits: $1 of credit; a dollar of a copy order uses 2.4 bp of it.
  const c = make(() => ({ status: 200, body: { ok: true, usd: 50_000, days: 14, vip: false, fees: {
    copy: { fee: 1, until, budget: { kind: 'credits', capUsd: 1, perUsd: { copy: 24 / 100_000, bots: 3 / 100_000 }, through } },
    bots: { fee: 1, until, budget: { kind: 'credits', capUsd: 1, perUsd: { copy: 24 / 100_000, bots: 3 / 100_000 }, through } },
  } } }));
  const cs = c.svc as unknown as typeof s;
  await c.fresh(OWNER);
  assert.equal(await cs.algoFee({ owner: OWNER, spec: { kind: 'twap' } }), 1, 'copy: 0.1 bp while credits pay');
  cs.noteFill(OWNER, 'copy', 4_000, Date.now()); // $0.96 of the $1
  assert.equal(await cs.algoFee({ owner: OWNER, spec: { kind: 'twap' } }), 1);
  cs.noteFill(OWNER, 'bots', 2_000, Date.now()); // $0.06 more: over
  assert.equal(await cs.algoFee({ owner: OWNER, spec: { kind: 'twap' } }), 25, 'the credit is used up');
  c.cleanup();

  // A budget that cannot be read: no lowered fee at all.
  const bad = make(() => ({ status: 200, body: { ok: true, usd: 50_000, days: 14, vip: false, fees: { copy: { fee: 0, until, budget: { capUsd: 'lots' } }, bots: null } } }));
  await bad.fresh(OWNER);
  assert.equal(await (bad.svc as unknown as typeof s).algoFee({ owner: OWNER, spec: { kind: 'twap' } }), 25);
  bad.cleanup();
});

/* -------- server 2 and the VIP box: the volume from a ledger copy, server 1 named only by the beta URL -------- */

/** An executor set up as server 2 is: EXECUTOR_BUILDER_DB (a copy of server 1's ledger) and EXECUTOR_BETA_URL, no builder URL. */
function makeCopy(usd: number, answer: () => { status: number; body: unknown }, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vd-perks-'));
  const ledger = join(dir, 'builder.db');
  const l = new DatabaseSync(ledger);
  l.exec('CREATE TABLE days (builder INTEGER NOT NULL, address TEXT NOT NULL, engine TEXT NOT NULL, day INTEGER NOT NULL, micro INTEGER NOT NULL, PRIMARY KEY (builder, address, engine, day)) WITHOUT ROWID');
  l.prepare('INSERT INTO days VALUES (234812, ?, ?, ?, ?)').run(OWNER, 'perps', Math.floor(Date.now() / 86_400_000), Math.round(usd * 1e6));
  l.close();
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const a = answer();
    return { status: a.status, ok: a.status < 400, text: async () => JSON.stringify(a.body) };
  };
  const cfg = loadConfig({
    EXECUTOR_DATA_DIR: dir, EXECUTOR_KIND: 'hosted', EXECUTOR_ORIGIN_SECRET: 'edge-secret', EXECUTOR_BUILDER_ID: '234812',
    EXECUTOR_BUILDER_DB: ledger, EXECUTOR_BETA_URL: 'https://api.example/api/vs/builder/beta', EXECUTOR_BUILDER_TOKEN: 'internal-token', ...env,
  });
  const db = new ExecutorDb(':memory:');
  const svc = new ExecutorService(cfg, db, new Secrets(dir), { fetch, factory: noWs, log: silent });
  const s = svc as unknown as { algoFee(a: { owner: string; spec: unknown }): Promise<number>; volumeOf(o: string): number | null };
  const botFee = () => s.algoFee({ owner: OWNER, spec: { kind: 'mm', bot: true } });
  return { cfg, calls, botFee, s, cleanup: async () => { await svc.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('perks URL: the builder URL, else /api/vs/builder/volume on the beta URL\'s server, else none', () => {
  assert.equal(perksUrlFrom('https://api.example/api/vs/builder/volume', 'https://other.example/api/vs/builder/beta'), 'https://api.example/api/vs/builder/volume');
  assert.equal(perksUrlFrom(undefined, 'https://api.example/api/vs/builder/beta?x=1'), 'https://api.example/api/vs/builder/volume');
  assert.equal(perksUrlFrom(undefined, undefined), null);
});

test('fees on a ledger copy (server 2, 2026-11-27): a Beta VIP wallet\'s bots pay 0.1 bp, not the standard 0.2 bp; the volume stays the copy\'s', async () => {
  const until = Date.now() + 28 * 86_400_000;
  const { cfg, calls, botFee, s, cleanup } = makeCopy(202_000, () => ({ status: 200, body: { ok: true, usd: 999_999, days: 14, vip: false, fees: { copy: { fee: 10, until }, bots: { fee: 1, until } } } }));
  assert.equal(cfg.perksUrl, 'https://api.example/api/vs/builder/volume');
  assert.equal(await botFee(), 1, 'the program\'s fee from the first order on (its first read is waited for)');
  assert.equal(await botFee(), 1);
  assert.equal(calls.length, 1, 'one read for two minutes');
  const u = new URL(calls[0]!.url);
  assert.equal(u.pathname, '/api/vs/builder/volume');
  assert.equal(u.searchParams.get('address'), OWNER);
  assert.equal(calls[0]!.headers['X-Internal-Token'], 'internal-token');
  assert.equal(calls[0]!.headers['X-Origin-Verify'], 'edge-secret');
  assert.equal(s.volumeOf(OWNER), 202_000, 'the volume is the ledger copy\'s, not the answer\'s');
  await cleanup();
});

test('fees on a ledger copy: a failed read keeps the last answer; no answer at all is the bot ladder; nothing to ask, nothing asked', async () => {
  let fail = false;
  const until = Date.now() + 86_400_000;
  const a = makeCopy(50_000, () => (fail ? { status: 503, body: { ok: false } } : { status: 200, body: { ok: true, usd: 50_000, vip: false, fees: { copy: null, bots: { fee: 1, until } } } }));
  assert.equal(await a.botFee(), 1);
  fail = true;
  const realNow = Date.now;
  Date.now = () => realNow() + 3 * 60_000;
  try {
    assert.equal(await a.botFee(), 1, 'server 1 away: the program still counts');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(a.calls.length, 2, 'read again after two minutes, in the background');
    assert.equal(await a.botFee(), 1);
  } finally {
    Date.now = realNow;
  }
  await a.cleanup();

  const b = makeCopy(50_000, () => ({ status: 503, body: { ok: false } }));
  assert.equal(await b.botFee(), 2, 'never read: the bot ladder (0.2 bp)');
  assert.equal(await b.botFee(), 2);
  assert.equal(b.calls.length, 1, 'a failed read is not tried again for two minutes');
  await b.cleanup();

  const c = makeCopy(50_000, () => ({ status: 200, body: { ok: true, usd: 0 } }), { EXECUTOR_BETA_URL: '' });
  assert.equal(c.cfg.perksUrl, null);
  assert.equal(await c.botFee(), 2);
  assert.equal(c.calls.length, 0);
  await c.cleanup();
});

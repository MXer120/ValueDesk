import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes, privateKeyToAddress } from '../../../packages/sodex-core/src/index.ts';
import { COPY_TERMS_VERSION, buildCopyRequest, copyRequestDigest, type AlgoFeed, type CopyAction, type FetchLike, type WebSocketLike } from '../../../packages/copy-engine/src/index.ts';
import { loadConfig, type ExecutorConfig } from '../src/config.ts';
import { ExecutorDb } from '../src/db.ts';
import { Secrets } from '../src/secrets.ts';
import { createExecutorServer } from '../src/server.ts';
import { ApiError, ExecutorService } from '../src/service.ts';

class Wallet {
  readonly pk = secp256k1.utils.randomPrivateKey();
  readonly address = privateKeyToAddress(this.pk).toLowerCase();
  sign(executor: string, action: CopyAction, payload: unknown, now = Date.now()) {
    const r = buildCopyRequest({ action, owner: this.address, executor, payload, chainId: 42161, now });
    const sig = secp256k1.sign(hexToBytes(copyRequestDigest(r)), this.pk);
    const out = new Uint8Array(65);
    out.set(sig.toCompactRawBytes(), 0);
    out[64] = 27 + sig.recovery;
    return { ...r, signature: bytesToHex(out) };
  }
}

const BTC_ROW = { id: 1, name: 'BTC-USD', baseCoin: 'BTC', tickSize: '1', stepSize: '0.00001', minQuantity: '0.00001', maxQuantity: '1000', minNotional: '10', maxNotional: '5000000', maxLeverage: 50, buyLimitUpRatio: '0.05', sellLimitDownRatio: '0.05', takerFee: '0.0004', makerFee: '0.0001', status: 'TRADING' };

function fakeFetch(): FetchLike {
  const ok = (data: unknown) => ({ status: 200, ok: true, text: async () => JSON.stringify({ code: 0, timestamp: Date.now(), data }) });
  return async (url) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path.endsWith('/markets/symbols')) return ok([BTC_ROW]);
    if (path.endsWith('/markets/mark-prices')) return ok([]);
    if (/\/api\/v1\/perps\/accounts\/0x[0-9a-f]{40}\/api-keys$/.test(path)) return ok([]);
    if (/\/api\/v1\/user\/0x[0-9a-f]{40}\/subaccounts$/.test(path)) return ok({ primaryAccountID: 42 });
    return { status: 404, ok: false, text: async () => '{"code":404,"message":"not found"}' };
  };
}

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const noWs = (): WebSocketLike => ({ readyState: 0, send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null });

function make(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vd-algo-'));
  const cfg: ExecutorConfig = loadConfig({ EXECUTOR_DATA_DIR: dir, EXECUTOR_KIND: 'hosted', EXECUTOR_EDGE: 'none', ...env });
  const db = new ExecutorDb(':memory:');
  const svc = new ExecutorService(cfg, db, new Secrets(dir), { fetch: fakeFetch(), factory: noWs, log: silent });
  return { cfg, db, svc, cleanup: async () => { await svc.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const TERMS = { termsVersion: COPY_TERMS_VERSION, termsHash: `0x${'ab'.repeat(32)}`, country: 'SG', adult: true, notUsPerson: true, ownDecision: true, risksUnderstood: true };
const TWAP = { kind: 'twap', symbol: 'BTC-USD', side: 'buy', quantity: '0.01', durationMs: 600_000, slices: 10, exec: { style: 'taker', slippageBps: 20 }, paper: true };

const code = async (p: Promise<unknown> | (() => unknown)): Promise<string> => {
  try {
    await (typeof p === 'function' ? p() : p);
    return 'ok';
  } catch (e) {
    return e instanceof ApiError ? `${e.status}:${e.code}` : String(e);
  }
};

test('algos: a signed start runs the spec it names, kept as the wallet signed it; terms, spec and seed are checked', async () => {
  const { svc, db, cleanup } = make();
  const w = new Wallet();
  const ctx = { viewerCountry: 'SG' };
  assert.equal(await code(svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: TWAP, seed: 7 }), ctx)), '412:terms');
  svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), ctx);
  assert.equal(await code(svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: { ...TWAP, slices: 0 }, seed: 7 }), ctx)), '400:spec');
  assert.equal(await code(svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: TWAP, seed: -1 }), ctx)), '400:seed');
  assert.equal(await code(svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: { ...TWAP, symbol: 'NOPE-USD' }, seed: 7 }), ctx)), '400:algo');
  // A live one is refused while real algo orders are off.
  assert.equal(await code(svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: { ...TWAP, paper: false }, seed: 7 }), ctx)), '403:paper-only');
  const v = await svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: TWAP, seed: 7 }), ctx);
  assert.equal(v.algo.owner, w.address);
  assert.equal(v.algo.seed, 7);
  assert.equal(v.algo.spec.kind, 'twap');
  assert.equal(v.algo.consent?.action, 'algo-start');
  assert.match(v.algo.consent!.payload, /"slices":10/);
  assert.equal(svc.algoList(w.address).length, 1);
  assert.ok(db.consents(w.address).some((c) => c.action === 'algo-start'));
  const events = await svc.algoEvents(w.address, v.algo.id, {});
  assert.ok(events.length >= 1);
  await cleanup();
});

test('algos: only the wallet that started one can act on it; cancel-all is its kill switch', async () => {
  const { svc, cleanup } = make();
  const a = new Wallet();
  const b = new Wallet();
  const ctx = { viewerCountry: 'SG' };
  svc.acceptTerms(a.sign(svc.executorId, 'accept-terms', TERMS), ctx);
  svc.acceptTerms(b.sign(svc.executorId, 'accept-terms', TERMS), ctx);
  const x = await svc.algoStart(a.sign(svc.executorId, 'algo-start', { spec: TWAP, seed: 1 }), ctx);
  const y = await svc.algoStart(a.sign(svc.executorId, 'algo-start', { spec: { ...TWAP, kind: 'chase', side: 'sell' }, seed: 2 }), ctx);
  assert.equal(await code(svc.algoAct(b.sign(svc.executorId, 'algo-action', { op: 'cancel', id: x.algo.id }), ctx)), '404:algo');
  assert.equal(await code(() => svc.algoEvents(b.address, x.algo.id, {})), '404:algo');
  const paused = await svc.algoAct(a.sign(svc.executorId, 'algo-action', { op: 'pause', id: x.algo.id }), ctx);
  assert.equal(paused.algos[0]!.algo.status, 'paused');
  const resumed = await svc.algoAct(a.sign(svc.executorId, 'algo-action', { op: 'resume', id: x.algo.id }), ctx);
  assert.equal(resumed.algos[0]!.algo.status, 'scheduled');
  const all = await svc.algoAct(a.sign(svc.executorId, 'algo-action', { op: 'cancel-all' }), ctx);
  assert.deepEqual(all.algos.map((v) => v.algo.status).sort(), ['cancelled', 'cancelled']);
  assert.ok(all.algos.some((v) => v.algo.id === y.algo.id));
  // An instruction is used once.
  const req = a.sign(svc.executorId, 'algo-action', { op: 'cancel-all' });
  await svc.algoAct(req, ctx);
  assert.equal(await code(svc.algoAct(req, ctx)), '409:replay');
  await cleanup();
});

test('algos: at most EXECUTOR_MAX_ALGOS live per wallet; a closed executor takes none', async () => {
  const { svc, cleanup } = make({ EXECUTOR_MAX_ALGOS: '2' });
  const w = new Wallet();
  const ctx = { viewerCountry: 'SG' };
  svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), ctx);
  await svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: TWAP, seed: 1 }), ctx);
  await svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: TWAP, seed: 2 }), ctx);
  assert.equal(await code(svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: TWAP, seed: 3 }), ctx)), '429:limit');
  assert.equal(svc.info({ viewerCountry: null }).algos?.maxPerOwner, 2);
  await cleanup();
  const closed = make({ EXECUTOR_OPEN: '0' });
  const v = new Wallet();
  assert.equal(await code(closed.svc.algoStart(v.sign(closed.svc.executorId, 'algo-start', { spec: TWAP, seed: 1 }), ctx)), '503:closed');
  await closed.cleanup();
});

test('HTTP: POST /algos with a signed request, GET /algos and its events with the session', async () => {
  const { svc, cfg, cleanup } = make();
  const server = createExecutorServer(svc, cfg, silent);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/copy/v1`;
  const w = new Wallet();
  const post = (path: string, request: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request }) });
  assert.equal((await post('/terms', w.sign(svc.executorId, 'accept-terms', TERMS))).status, 200);
  const { token } = (await (await post('/session', w.sign(svc.executorId, 'session', {}))).json()) as { token: string };
  const started = await post('/algos', w.sign(svc.executorId, 'algo-start', { spec: TWAP, seed: 9 }));
  assert.equal(started.status, 200);
  const view = (await started.json()) as { algo: { id: string } };
  const list = (await (await fetch(`${base}/algos`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { algos: Array<{ algo: { id: string } }> };
  assert.deepEqual(list.algos.map((v) => v.algo.id), [view.algo.id]);
  const ev = await fetch(`${base}/algos/${view.algo.id}/events`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(ev.status, 200);
  assert.equal((await fetch(`${base}/algos`)).status, 401);
  const act = await post('/algos/action', w.sign(svc.executorId, 'algo-action', { op: 'cancel', id: view.algo.id }));
  assert.equal(act.status, 200);
  server.close();
  await cleanup();
});

test('end to end, in paper: a signed TWAP with exits runs on the executor against the market it sees, fills, ends, keeps its exits, and survives a restart', async () => {
  const realNow = Date.now;
  let clock = Date.now();
  Date.now = () => clock;
  const dir = mkdtempSync(join(tmpdir(), 'vd-algo-e2e-'));
  const cfg = loadConfig({ EXECUTOR_DATA_DIR: dir, EXECUTOR_KIND: 'hosted', EXECUTOR_EDGE: 'none' });
  const path = join(dir, 'executor.db');
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 3));
    }
  };
  try {
    const db = new ExecutorDb(path);
    const svc = new ExecutorService(cfg, db, new Secrets(dir), { fetch: fakeFetch(), factory: noWs, log: silent });
    const w = new Wallet();
    const ctx = { viewerCountry: 'SG' };
    svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), ctx);
    const spec = { kind: 'twap', symbol: 'BTC-USD', side: 'buy', quantity: '0.004', durationMs: 120_000, slices: 2, exec: { style: 'taker', slippageBps: 20 }, exits: { tpPct: 0.02, slPct: 0.01 }, paper: true };
    const v = await svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec, seed: 5 }), ctx);
    const id = v.algo.id;
    // What the executor's socket would bring: the book and the mark.
    const feed = svc.algos.market as AlgoFeed;
    const book = (bid: number, ask: number) => {
      feed.handle({ channel: 'bookTicker', data: [{ s: 'BTC-USD', b: String(bid), a: String(ask) }] });
      feed.handle({ channel: 'allMarkPrice', data: [{ s: 'BTC-USD', p: String((bid + ask) / 2) }] });
    };
    book(60_000, 60_010);
    await svc.algos.stepNow(id, clock);
    await settle();
    assert.equal(svc.algos.get(id)!.filled, 0.002, 'the first slice took at the ask');
    clock += 61_000;
    book(60_100, 60_110);
    await svc.algos.stepNow(id, clock);
    await settle();
    clock += 60_000;
    book(60_100, 60_110);
    await svc.algos.stepNow(id, clock);
    await settle();
    const done = svc.algos.get(id)!;
    assert.equal(done.status, 'done');
    assert.equal(done.filled, 0.004);
    const exits = done.exitOrders!.filter((x) => x.state === 'open');
    assert.deepEqual(exits.map((x) => x.exit).sort(), ['sl', 'tp']);
    assert.ok(exits.every((x) => x.quantity === 0.004 && x.side === 'sell'));
    const events = await svc.algoEvents(w.address, id, {});
    assert.ok(events.some((e) => /Exits for 0.004/.test(e.text)));
    await svc.stop();
    db.close();
    // A restart reads the books back from SQLite, exits and all.
    const db2 = new ExecutorDb(path);
    const svc2 = new ExecutorService(cfg, db2, new Secrets(dir), { fetch: fakeFetch(), factory: noWs, log: silent });
    await svc2.algos.start();
    const back = svc2.algos.get(id)!;
    assert.equal(back.status, 'done');
    assert.equal(back.exitOrders!.filter((x) => x.state === 'open').length, 2);
    // The mark falls through the stop-loss: it fills (paper) and the take-profit is cancelled.
    const feed2 = svc2.algos.market as AlgoFeed;
    feed2.handle({ channel: 'allMarkPrice', data: [{ s: 'BTC-USD', p: '59000' }] });
    svc2.algos.tick(clock);
    await settle();
    const after = svc2.algos.get(id)!;
    // The latest pair (the first one, for 0.002, was replaced when the TWAP finished).
    assert.equal(after.exitOrders!.filter((x) => x.exit === 'sl').at(-1)!.filled, 0.004);
    assert.equal(after.exitOrders!.filter((x) => x.exit === 'tp').at(-1)!.state, 'done');
    assert.equal(after.exitOrders!.filter((x) => x.exit === 'tp').at(-1)!.filled, 0);
    await svc2.stop();
    db2.close();
  } finally {
    Date.now = realNow;
    // Windows may still hold SQLite's WAL files for a moment: a temp folder left behind is not a failure.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* left for the OS to clean */
    }
  }
});

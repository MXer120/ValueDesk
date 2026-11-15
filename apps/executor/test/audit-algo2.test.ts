/**
 * Pre-go-live audit, round 2: the executor's algo path (service.ts algoStart / algoAct,
 * the live gate, signed-instruction auth, restart, and how it wires the AlgoRuntime).
 * A test named "BUG ..." asserts the correct behaviour and fails while the bug is there.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes, privateKeyToAddress } from '../../../packages/sodex-core/src/index.ts';
import { COPY_TERMS_VERSION, FINAL_STATUSES, buildCopyRequest, copyRequestDigest, type AlgoFeed, type CopyAction, type FetchLike, type WebSocketLike } from '../../../packages/copy-engine/src/index.ts';
import { loadConfig, type ExecutorConfig } from '../src/config.ts';
import { ExecutorDb } from '../src/db.ts';
import { Secrets } from '../src/secrets.ts';
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

const ROW = (id: number, name: string, base: string) => ({ id, name, baseCoin: base, tickSize: '1', stepSize: '0.00001', minQuantity: '0.00001', maxQuantity: '1000', minNotional: '10', maxNotional: '5000000', maxLeverage: 50, buyLimitUpRatio: '0.05', sellLimitDownRatio: '0.05', takerFee: '0.0004', makerFee: '0.0001', status: 'TRADING' });

interface Fake {
  keys: Record<string, Array<{ name: string; publicKey: string; expiresAt: number }>>;
  /** 'ok' | 'error' (SoDEX answers the builders read with an error) */
  builders: 'ok' | 'error';
  /** Every write (signed POST) the executor sent to SoDEX. */
  writes: string[];
  /** The wallet's positions as SoDEX reports them (the account state's P). */
  positions?: Array<{ s: string; sz: string; ep: string }>;
  /** Markets SoDEX lists (default: BTC, ETH, SOL without tiers). */
  rows?: unknown[];
  /** SoDEX does not answer the account state (the positions). */
  stateFails?: boolean;
}

function fakeFetch(f: Fake): FetchLike {
  const ok = (data: unknown) => ({ status: 200, ok: true, text: async () => JSON.stringify({ code: 0, timestamp: Date.now(), data }) });
  return async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const method = (init as { method?: string } | undefined)?.method ?? 'GET';
    if (method !== 'GET') {
      f.writes.push(String((init as { body?: unknown }).body ?? ''));
      return ok([]);
    }
    if (path.endsWith('/markets/symbols')) return ok(f.rows ?? [ROW(1, 'BTC-USD', 'BTC'), ROW(2, 'ETH-USD', 'ETH'), ROW(3, 'SOL-USD', 'SOL')]);
    if (path.endsWith('/markets/mark-prices')) return ok([]);
    let m = /\/api\/v1\/perps\/accounts\/(0x[0-9a-f]{40})\/api-keys$/.exec(path);
    if (m) return ok(f.keys[m[1]!] ?? []);
    if (/\/api\/v1\/user\/0x[0-9a-f]{40}\/subaccounts$/.test(path)) return ok({ primaryAccountID: 42 });
    if (/\/perps\/accounts\/0x[0-9a-f]{40}\/state$/.test(path) && f.stateFails) return { status: 500, ok: false, text: async () => '{"code":500,"message":"down"}' };
    if (/\/perps\/accounts\/0x[0-9a-f]{40}\/state$/.test(path)) return ok({ aid: 42, av: '100000', P: f.positions ?? [] });
    m = /\/user\/0x[0-9a-f]{40}\/builders$/.exec(path);
    if (m) {
      if (f.builders === 'error') return { status: 403, ok: false, text: async () => '{"code":403,"message":"forbidden"}' };
      return ok({ perps: [{ builderID: 234812, feeRate: 25 }], spot: [] });
    }
    return { status: 404, ok: false, text: async () => '{"code":404,"message":"not found"}' };
  };
}

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const noWs = (): WebSocketLike => ({ readyState: 0, send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null });

function make(env: Record<string, string> = {}, fake: Fake = { keys: {}, builders: 'ok', writes: [] }, path = ':memory:', dirIn?: string) {
  const dir = dirIn ?? mkdtempSync(join(tmpdir(), 'vd-algo2-'));
  const cfg: ExecutorConfig = loadConfig({ EXECUTOR_PRACTICE_BOTS: '1', EXECUTOR_DATA_DIR: dir, EXECUTOR_KIND: 'hosted', EXECUTOR_EDGE: 'none', ...env });
  const db = new ExecutorDb(path === ':memory:' ? path : join(dir, path));
  const svc = new ExecutorService(cfg, db, new Secrets(dir), { fetch: fakeFetch(fake), factory: noWs, log: silent });
  return {
    cfg,
    db,
    svc,
    dir,
    fake,
    cleanup: async (rm = true) => {
      await svc.stop();
      db.close();
      if (rm) {
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        } catch {
          /* Windows may hold the WAL a moment */
        }
      }
    },
  };
}

const TERMS = { termsVersion: COPY_TERMS_VERSION, termsHash: `0x${'ab'.repeat(32)}`, country: 'SG', adult: true, notUsPerson: true, ownDecision: true, risksUnderstood: true };
const TWAP = { kind: 'twap', symbol: 'BTC-USD', side: 'buy', quantity: '0.01', durationMs: 600_000, slices: 10, exec: { style: 'taker', slippageBps: 20 }, paper: true };
const ctx = { viewerCountry: 'SG' };

const code = async (p: Promise<unknown> | (() => unknown)): Promise<string> => {
  try {
    await (typeof p === 'function' ? p() : p);
    return 'ok';
  } catch (e) {
    return e instanceof ApiError ? `${e.status}:${e.code}` : String(e);
  }
};

const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 3));
  }
};

function book(svc: ExecutorService, symbol: string, bid: number, ask: number) {
  const feed = svc.algos.market as AlgoFeed;
  feed.handle({ channel: 'bookTicker', data: [{ s: symbol, b: String(bid), a: String(ask) }] });
  feed.handle({ channel: 'allMarkPrice', data: [{ s: symbol, p: String((bid + ask) / 2) }] });
}

/** A live-capable executor and a wallet with terms and a registered key. */
async function liveSetup(env: Record<string, string> = {}, file = ':memory:', more: Partial<Fake> = {}) {
  const fake: Fake = { keys: {}, builders: 'ok', writes: [], ...more };
  const h = make({ EXECUTOR_LIVE_ALGOS: '1', ...env }, fake, file);
  const w = new Wallet();
  h.svc.acceptTerms(w.sign(h.svc.executorId, 'accept-terms', TERMS), ctx);
  const k = h.svc.createKey(w.sign(h.svc.executorId, 'create-key', { accountId: 42, days: 30 }), ctx);
  fake.keys[w.address] = [{ name: k.name, publicKey: k.address, expiresAt: Date.now() + 30 * 86_400_000 }];
  await h.svc.verifyKey(w.address);
  assert.equal(h.db.key(w.address, 'active')?.registered, true, 'harness: the key is registered');
  return { ...h, w };
}

/* ------------------------------------------------------------------ live gate ----- */

test('gate: paper as a string, a number or missing is live, and refused while real algos are off', async () => {
  const { svc, cleanup } = make();
  const w = new Wallet();
  svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), ctx);
  for (const paper of ['true', 1, undefined, null, 'yes']) {
    const spec: Record<string, unknown> = { ...TWAP, paper };
    if (paper === undefined) delete spec.paper;
    assert.equal(await code(svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec, seed: 1 }), ctx)), '403:paper-only', `paper: ${String(paper)}`);
  }
  assert.equal(svc.algoList(w.address).length, 0);
  await cleanup();
});

test('gate: a basket\'s legs, a conditional\'s inner algo: a live one anywhere is refused while real algos are off', async () => {
  const { svc, cleanup } = make();
  const w = new Wallet();
  svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), ctx);
  const basket = { kind: 'basket', symbol: 'BTC-USD', side: 'buy', legs: [{ symbol: 'BTC-USD', side: 'buy', usd: 100 }, { symbol: 'ETH-USD', side: 'sell', usd: 100 }], style: 'swarm', clips: 2, inFlight: 1, waveMs: 1000, slippageBps: 20 };
  assert.equal(await code(svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: { ...basket, paper: false }, seed: 1 }), ctx)), '403:paper-only');
  // Legs carry no paper flag of their own: they run as the basket does (the runtime gives them s.paper).
  assert.equal(await code(svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: { ...basket, legs: basket.legs.map((l) => ({ ...l, paper: false })), paper: true }, seed: 1 }), ctx)), 'ok');
  const cond = (outer: boolean, inner: unknown) => ({
    kind: 'conditional', symbol: 'BTC-USD', side: 'buy', paper: outer,
    conditions: [{ type: 'price', symbol: 'BTC-USD', source: 'mark', op: 'above', value: '1' }],
    then: { type: 'algo', algo: { ...TWAP, paper: inner } },
  });
  assert.equal(await code(svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: cond(false, true), seed: 1 }), ctx)), '403:paper-only');
  assert.equal(await code(svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: cond(true, 'true'), seed: 1 }), ctx)), '403:paper-only');
  assert.equal(await code(svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: cond(true, true), seed: 1 }), ctx)), 'ok');
  await cleanup();
});

test('BUG gate: a PAPER conditional whose inner algo has no paper flag is accepted (the runtime runs that child as paper)', async () => {
  // runtime.ts conditional: the child gets `paper: s.paper || t.algo.paper`, so it can only be paper; the web
  // client's requirePaperAlgo checks only the outer flag - and the executor answers "Real algo orders are off".
  const { svc, cleanup } = make();
  const w = new Wallet();
  svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), ctx);
  const inner: Record<string, unknown> = { ...TWAP };
  delete inner.paper;
  const spec = { kind: 'conditional', symbol: 'BTC-USD', side: 'buy', paper: true, conditions: [{ type: 'price', symbol: 'BTC-USD', source: 'mark', op: 'above', value: '1' }], then: { type: 'algo', algo: inner } };
  assert.equal(await code(svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec, seed: 1 }), ctx)), 'ok');
  await cleanup();
});

test('gate: a paper conditional starts a paper child; nothing is ever written to SoDEX', async () => {
  const fake: Fake = { keys: {}, builders: 'ok', writes: [] };
  const { svc, cleanup } = make({}, fake);
  const w = new Wallet();
  svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), ctx);
  const spec = { kind: 'conditional', symbol: 'BTC-USD', side: 'buy', paper: true, conditions: [{ type: 'price', symbol: 'BTC-USD', source: 'mark', op: 'above', value: '1' }], then: { type: 'algo', algo: TWAP } };
  const v = await svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec, seed: 1 }), ctx);
  book(svc, 'BTC-USD', 60_000, 60_010);
  await svc.algos.stepNow(v.algo.id, Date.now());
  await settle();
  const child = svc.algos.list(w.address).find((a) => a.parentId === v.algo.id);
  assert.ok(child, 'the conditional fired');
  assert.equal(child!.spec.paper, true);
  await svc.algos.stepNow(child!.id, Date.now());
  await settle();
  assert.equal(fake.writes.length, 0);
  await cleanup();
});

/* ------------------------------------------------------------------ auth ----- */

test('auth: another wallet cannot pause, resume or cancel an algo (nor a basket leg) by its id; cancel-all is the signer\'s only', async () => {
  const { svc, cleanup } = make();
  const a = new Wallet();
  const b = new Wallet();
  svc.acceptTerms(a.sign(svc.executorId, 'accept-terms', TERMS), ctx);
  svc.acceptTerms(b.sign(svc.executorId, 'accept-terms', TERMS), ctx);
  const basket = { kind: 'basket', symbol: 'BTC-USD', side: 'buy', legs: [{ symbol: 'BTC-USD', side: 'buy', usd: 100 }, { symbol: 'ETH-USD', side: 'sell', usd: 100 }], style: 'swarm', clips: 2, inFlight: 1, waveMs: 1000, slippageBps: 20, paper: true };
  const v = await svc.algoStart(a.sign(svc.executorId, 'algo-start', { spec: basket, seed: 1 }), ctx);
  book(svc, 'BTC-USD', 60_000, 60_010);
  book(svc, 'ETH-USD', 3_000, 3_001);
  await svc.algos.stepNow(v.algo.id, Date.now());
  await settle();
  const legs = svc.algos.list(a.address).filter((x) => x.parentId === v.algo.id);
  assert.equal(legs.length, 2);
  for (const op of ['pause', 'resume', 'cancel'] as const) {
    for (const id of [v.algo.id, legs[0]!.id]) assert.equal(await code(svc.algoAct(b.sign(svc.executorId, 'algo-action', { op, id }), ctx)), '404:algo');
  }
  // An instruction a signs for the wrong executor, or a's request with b's owner: refused.
  assert.equal(await code(svc.algoAct(a.sign('another-executor', 'algo-action', { op: 'cancel-all' }), ctx)), '401:signature');
  const forged = { ...a.sign(svc.executorId, 'algo-action', { op: 'cancel-all' }), owner: b.address };
  assert.equal(await code(svc.algoAct(forged, ctx)), '401:signature');
  const killed = await svc.algoAct(b.sign(svc.executorId, 'algo-action', { op: 'cancel-all' }), ctx);
  assert.equal(killed.algos.length, 0);
  assert.ok(svc.algos.list(a.address).every((x) => !FINAL_STATUSES.has(x.status)));
  await cleanup();
});

test('auth: a signed algo-start is not an algo-action, and an algo-action payload names its op exactly', async () => {
  const { svc, cleanup } = make();
  const w = new Wallet();
  svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), ctx);
  const v = await svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: TWAP, seed: 1 }), ctx);
  assert.equal(await code(svc.algoAct(w.sign(svc.executorId, 'algo-start', { op: 'cancel', id: v.algo.id }), ctx)), '400:action');
  assert.equal(await code(svc.algoStart(w.sign(svc.executorId, 'algo-action', { spec: TWAP, seed: 1 }), ctx)), '400:action');
  assert.equal(await code(svc.algoAct(w.sign(svc.executorId, 'algo-action', { op: 'CANCEL', id: v.algo.id }), ctx)), '400:op');
  assert.equal(svc.algos.get(v.algo.id)!.status, 'scheduled');
  await cleanup();
});

test('serial: two starts sent together do not both pass the per-wallet limit', async () => {
  const { svc, cleanup } = make({ EXECUTOR_MAX_ALGOS: '1' });
  const w = new Wallet();
  svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), ctx);
  const r = await Promise.all([1, 2, 3].map((seed) => code(svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: TWAP, seed }), ctx))));
  assert.deepEqual(r.sort(), ['429:limit', '429:limit', 'ok']);
  await cleanup();
});

test('BUG limit: a basket\'s legs count toward EXECUTOR_MAX_ALGOS (one start cannot run more algos than the cap)', async () => {
  // service.ts algoStart checks the cap once, for the basket itself; its legs are started by the runtime's add, unchecked.
  const { svc, cleanup } = make({ EXECUTOR_MAX_ALGOS: '2' });
  const w = new Wallet();
  svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), ctx);
  const basket = { kind: 'basket', symbol: 'BTC-USD', side: 'buy', legs: [{ symbol: 'BTC-USD', side: 'buy', usd: 100 }, { symbol: 'ETH-USD', side: 'sell', usd: 100 }, { symbol: 'SOL-USD', side: 'buy', usd: 100 }], style: 'swarm', clips: 2, inFlight: 1, waveMs: 1000, slippageBps: 20, paper: true };
  const v = await code(svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: basket, seed: 1 }), ctx));
  if (v === 'ok') {
    const id = svc.algos.list(w.address)[0]!.id;
    for (const [s, p] of [['BTC-USD', 60_000], ['ETH-USD', 3_000], ['SOL-USD', 150]] as const) book(svc, s, p, p + 1);
    await svc.algos.stepNow(id, Date.now());
    await settle();
  }
  const live = svc.algos.list(w.address).filter((a) => !FINAL_STATUSES.has(a.status)).length;
  assert.ok(live <= 2, `${live} algos run for this wallet with EXECUTOR_MAX_ALGOS=2`);
  await cleanup();
});

/* ---------------------------------------------------------------- live wiring ----- */

test('live: with real algos on, a live TWAP signs its slice with the wallet\'s key; a paper one with the same key sends nothing', async () => {
  const { svc, w, fake, cleanup } = await liveSetup();
  const paper = await svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: TWAP, seed: 1 }), ctx);
  book(svc, 'BTC-USD', 60_000, 60_010);
  await svc.algos.stepNow(paper.algo.id, Date.now());
  await settle();
  assert.equal(fake.writes.length, 0, 'paper sent nothing');
  const live = await svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: { ...TWAP, paper: false }, seed: 2 }), ctx);
  assert.equal(live.algo.accountId, 42);
  book(svc, 'BTC-USD', 60_000, 60_010);
  await svc.algos.stepNow(live.algo.id, Date.now());
  await settle();
  assert.equal(fake.writes.length, 1, 'the live slice went out');
  await cleanup();
});

test('BUG live: when the builder-approval read fails on the first check, the algo is held - it does not trade unchecked', async () => {
  // runtime.ts problemOf: a throwing host.problem gives `hit?.problem ?? null` - with no earlier answer that is null, "no problem".
  const { svc, w, fake, cleanup } = await liveSetup();
  fake.builders = 'error';
  const live = await svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: { ...TWAP, paper: false }, seed: 2 }), ctx);
  book(svc, 'BTC-USD', 60_000, 60_010);
  await svc.algos.stepNow(live.algo.id, Date.now());
  await settle();
  assert.equal(fake.writes.length, 0, 'an order went out although the fee approval could not be checked');
  await cleanup();
});

test('BUG region: a wallet that re-declares a blocked country (US) has its running live algos held', async () => {
  // policyFor uses the country copied into the record at start (a.country); the terms the wallet signs later are not read.
  const { svc, w, fake, cleanup } = await liveSetup();
  const live = await svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: { ...TWAP, slices: 2, durationMs: 120_000, paper: false }, seed: 2 }), ctx);
  assert.equal(await code(() => svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', { ...TERMS, country: 'US' }), ctx)), '451:region');
  assert.equal(await code(svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: TWAP, seed: 3 }), ctx)), '451:region', 'new ones are refused');
  book(svc, 'BTC-USD', 60_000, 60_010);
  await svc.algos.stepNow(live.algo.id, Date.now());
  await settle();
  assert.equal(fake.writes.length, 0, 'the running live algo still traded for a wallet that declared the US');
  await cleanup();
});

test('BUG delete-key: forgetting the key leaves no exits on SoDEX that the executor can no longer cancel (OCO)', async () => {
  // service.ts deleteKey: cancelAll ends a running algo with its exits kept on SoDEX, then the key is deleted,
  // so sinkFor() is null: when one exit fills the other is never cancelled (cancelExits marks it cancelling and returns).
  const { svc, w, fake, db, cleanup } = await liveSetup();
  const spec = { ...TWAP, quantity: '0.004', slices: 2, durationMs: 120_000, exits: { tpPct: 0.02, slPct: 0.01 }, paper: false };
  const v = await svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec, seed: 2 }), ctx);
  const id = v.algo.id;
  book(svc, 'BTC-USD', 60_000, 60_010);
  await svc.algos.stepNow(id, Date.now());
  await settle();
  const slice = svc.algos.get(id)!.children[0]!;
  const feed = svc.algos.market as AlgoFeed;
  feed.handle({ channel: 'accountOrderUpdate', data: [{ c: slice.clOrdID, i: 1, s: 'BTC-USD', X: 'FILLED', z: '0.002', v: '120.02', m: false, E: Date.now() }] });
  await settle();
  await svc.algos.stepNow(id, Date.now());
  await settle();
  const exits = () => (svc.algos.get(id)!.exitOrders ?? []).filter((x) => x.state === 'open' || x.state === 'sending' || x.state === 'unknown');
  assert.equal(exits().length, 2, 'harness: take-profit and stop-loss are on SoDEX');
  const before = fake.writes.length;
  await svc.deleteKey(w.sign(svc.executorId, 'delete-key', {}), ctx);
  await settle();
  assert.equal(db.key(w.address, 'active'), null);
  const left = exits();
  const cancelled = left.every((x) => fake.writes.slice(before).some((b) => b.includes(x.clOrdID)));
  assert.ok(left.length === 0 || cancelled, `${left.length} exits stay on SoDEX with no key to manage them`);
  // And the take-profit filling must still cancel the stop-loss.
  const tp = left.find((x) => x.exit === 'tp');
  if (tp) {
    const n = fake.writes.length;
    feed.handle({ channel: 'accountOrderUpdate', data: [{ c: tp.clOrdID, i: 2, s: 'BTC-USD', X: 'FILLED', z: '0.002', v: '122', m: false, E: Date.now() }] });
    await settle();
    const sl = svc.algos.get(id)!.exitOrders!.find((x) => x.exit === 'sl' && x.clOrdID !== tp.clOrdID && x.quantity === tp.quantity)!;
    assert.ok(fake.writes.length > n || sl.state === 'done', 'the stop-loss is left on SoDEX after the take-profit filled');
  }
  await cleanup();
});

/* -------------------------------------------------------------------- restart ----- */

test('restart: a second start() loads nothing twice; a running paper algo goes on; act still checks the owner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vd-algo2-r-'));
  const h1 = make({}, undefined, 'executor.db', dir);
  const w = new Wallet();
  const x = new Wallet();
  h1.svc.acceptTerms(w.sign(h1.svc.executorId, 'accept-terms', TERMS), ctx);
  h1.svc.acceptTerms(x.sign(h1.svc.executorId, 'accept-terms', TERMS), ctx);
  const v = await h1.svc.algoStart(w.sign(h1.svc.executorId, 'algo-start', { spec: TWAP, seed: 1 }), ctx);
  const req = w.sign(h1.svc.executorId, 'algo-action', { op: 'pause', id: v.algo.id });
  await h1.svc.algoAct(req, ctx);
  await h1.cleanup(false);
  const h2 = make({}, undefined, 'executor.db', dir);
  await h2.svc.start();
  await h2.svc.start();
  assert.equal(h2.svc.algoList(w.address).length, 1);
  assert.equal(h2.svc.algos.get(v.algo.id)!.status, 'paused');
  // A signed instruction used before the restart is still used.
  assert.equal(await code(h2.svc.algoAct(req, ctx)), '409:replay');
  assert.equal(await code(h2.svc.algoAct(x.sign(h2.svc.executorId, 'algo-action', { op: 'resume', id: v.algo.id }), ctx)), '404:algo');
  const back = await h2.svc.algoAct(w.sign(h2.svc.executorId, 'algo-action', { op: 'resume', id: v.algo.id }), ctx);
  assert.equal(back.algos[0]!.algo.status, 'scheduled');
  await h2.cleanup();
});

test('restart: a live algo\'s slice sent before the restart is asked about, never sent again', async () => {
  const h = await liveSetup({}, 'executor.db');
  const { svc, w, fake } = h;
  const v = await svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: { ...TWAP, slices: 2, durationMs: 120_000, paper: false }, seed: 2 }), ctx);
  book(svc, 'BTC-USD', 60_000, 60_010);
  const t0 = Date.now();
  await svc.algos.stepNow(v.algo.id, t0);
  await settle();
  assert.equal(fake.writes.length, 1);
  await h.cleanup(false);
  const fake2: Fake = { keys: fake.keys, builders: 'ok', writes: [] };
  const h2 = make({ EXECUTOR_LIVE_ALGOS: '1' }, fake2, 'executor.db', h.dir);
  await h2.svc.start();
  const back = h2.svc.algos.get(v.algo.id)!;
  assert.equal(back.children.length, 1);
  assert.notEqual(back.children[0]!.state, 'sending');
  book(h2.svc, 'BTC-USD', 60_000, 60_010);
  await h2.svc.algos.stepNow(v.algo.id, t0 + 1_000);
  await settle();
  assert.equal(fake2.writes.filter((b) => b.includes(back.children[0]!.clOrdID)).length, 0, 'the first slice was sent again');
  assert.equal(h2.svc.algos.get(v.algo.id)!.children.length, 1, 'no second slice before its time');
  await h2.cleanup();
});

test('BUG cancel-all: the kill switch pulls a running algo\'s exits too, as it does an ended one\'s (one press leaves nothing)', async () => {
  // runtime.ts cancelAll: a running algo is cancel()led -> end() keeps (and re-places) its exits; only an algo that had
  // ALREADY ended has its exits pulled. A second cancel-all would pull them: the first one leaves both stops on SoDEX.
  const { svc, w, fake, cleanup } = await liveSetup();
  const spec = { ...TWAP, quantity: '0.004', slices: 2, durationMs: 120_000, exits: { tpPct: 0.02, slPct: 0.01 }, paper: false };
  const v = await svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec, seed: 2 }), ctx);
  const id = v.algo.id;
  book(svc, 'BTC-USD', 60_000, 60_010);
  await svc.algos.stepNow(id, Date.now());
  await settle();
  const slice = svc.algos.get(id)!.children[0]!;
  (svc.algos.market as AlgoFeed).handle({ channel: 'accountOrderUpdate', data: [{ c: slice.clOrdID, i: 1, s: 'BTC-USD', X: 'FILLED', z: '0.002', v: '120.02', m: false, E: Date.now() }] });
  await settle();
  await svc.algos.stepNow(id, Date.now());
  await settle();
  const live = () => (svc.algos.get(id)!.exitOrders ?? []).filter((x) => (x.state === 'open' || x.state === 'sending' || x.state === 'unknown') && !x.cancelling);
  assert.equal(live().length, 2, 'harness: exits are on SoDEX');
  void fake;
  await svc.algoAct(w.sign(svc.executorId, 'algo-action', { op: 'cancel-all' }), ctx);
  await settle();
  assert.equal(live().length, 0, `${live().length} exits left on SoDEX after the kill switch`);
  await cleanup();
});

test('live: the position SoDEX reports counts at the start - on its side; a start that would take it over the limit at the leverage is refused', async () => {
  const tiered = { ...ROW(1, 'BTC-USD', 'BTC'), initLeverage: 20, marginTiers: [{ maxNotionalValue: '4000000', maxLeverage: 40 }, { maxNotionalValue: '100000000', maxLeverage: 25 }] };
  const { svc, w, fake, cleanup } = await liveSetup({}, ':memory:', { rows: [tiered], positions: [{ s: 'BTC-USD', sz: '60', ep: '60000' }] });
  book(svc, 'BTC-USD', 60_000, 60_010);
  const start = (spec: Record<string, unknown>, seed: number) => svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: { ...TWAP, paper: false, ...spec }, seed }), ctx);
  // Long 60 ($3.6M): buying 10 more at 40x is about $4.2M, over the $4M tier.
  await assert.rejects(start({ quantity: '10', leverage: 40 }, 1), (e: unknown) => e instanceof ApiError && e.status === 400 && /over SoDEX's limit of \$4M at 40x\. You hold about \$3\.6M long now\. At most about \$\d{3},\d{3} \(6\.6\d BTC\) can be bought under it/.test(e.message));
  // Selling 10 only reduces it: no limit to hit.
  assert.equal((await start({ side: 'sell', quantity: '10', leverage: 40 }, 2)).algo.status, 'scheduled');
  // Short 60: selling more is what grows it.
  fake.positions = [{ s: 'BTC-USD', sz: '-60', ep: '60000' }];
  await new Promise((r) => setTimeout(r, 5_100)); // the positions read is kept 5 s
  await assert.rejects(start({ side: 'sell', quantity: '10', leverage: 40 }, 3), /You hold about \$3\.6M short now\. At most about \$\d{3},\d{3} \(6\.6\d BTC\) can be sold under it/);
  assert.equal((await start({ quantity: '10', leverage: 40 }, 4)).algo.status, 'scheduled', 'a buy against the short closes first');
  assert.equal(fake.writes.length, 0, 'nothing was sent for the refused starts');
  await cleanup();
});

test('live: when SoDEX does not report the position, the start is refused with the reason - the position is never assumed to be none', async () => {
  const tiered = { ...ROW(1, 'BTC-USD', 'BTC'), initLeverage: 20, marginTiers: [{ maxNotionalValue: '4000000', maxLeverage: 40 }, { maxNotionalValue: '100000000', maxLeverage: 25 }] };
  const { svc, w, fake, cleanup } = await liveSetup({}, ':memory:', { rows: [tiered], stateFails: true });
  book(svc, 'BTC-USD', 60_000, 60_010);
  await assert.rejects(svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: { ...TWAP, paper: false, leverage: 40 }, seed: 1 }), ctx), (e: unknown) => e instanceof ApiError && e.status === 400 && e.message === 'SoDEX did not report your position on BTC-USD, so the position limit cannot be checked. Try again in a moment.');
  assert.equal(svc.algoList(w.address).length, 0);
  fake.stateFails = false;
  assert.equal((await svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: { ...TWAP, paper: false, leverage: 40 }, seed: 2 }), ctx)).algo.status, 'scheduled');
  await cleanup();
});

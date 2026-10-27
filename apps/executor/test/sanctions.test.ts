/**
 * Sanctions screening on the executor (service.ts `screen`, copy-engine
 * sanctions.ts): a listed follower or leader is refused on every request that
 * lets a wallet trade or be copied, what runs is held, and stopping stays open.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes, privateKeyToAddress } from '../../../packages/sodex-core/src/index.ts';
import {
  COPY_TERMS_VERSION,
  SANCTIONED_LEADER_REASON,
  SANCTIONED_WALLET_REASON,
  _resetSanctionsForTests,
  _sanctionForTests,
  buildCopyRequest,
  canonicalSettings,
  copyRequestDigest,
  isSanctionedAddress,
  parseSettings,
  type CopyAction,
  type FetchLike,
  type RegionPolicy,
  type WebSocketLike,
} from '../../../packages/copy-engine/src/index.ts';
import { loadConfig } from '../src/config.ts';
import { ExecutorDb } from '../src/db.ts';
import { Secrets } from '../src/secrets.ts';
import { ApiError, ExecutorService } from '../src/service.ts';

/** On the list (a Lazarus Group address on OFAC's SDN list). */
const LISTED_LEADER = '0x098b716b8aaf21512996dc57eb0615e2383e2f96';
const LEADER = '0x1111111111111111111111111111111111111111';

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
    if (/\/perps\/accounts\/0x[0-9a-f]{40}\/state$/.test(path)) return ok({ aid: 42, av: '1000', P: [] });
    return { status: 404, ok: false, text: async () => '{"code":404,"message":"not found"}' };
  };
}

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const noWs = (): WebSocketLike => ({ readyState: 0, send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null });

function make() {
  const dir = mkdtempSync(join(tmpdir(), 'vd-sanctions-'));
  const cfg = loadConfig({ EXECUTOR_DATA_DIR: dir, EXECUTOR_KIND: 'hosted', EXECUTOR_EDGE: 'none' });
  const db = new ExecutorDb(':memory:');
  const svc = new ExecutorService(cfg, db, new Secrets(dir), { fetch: fakeFetch(), factory: noWs, log: silent });
  return { svc, cleanup: async () => { _resetSanctionsForTests(); await svc.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const TERMS = { termsVersion: COPY_TERMS_VERSION, termsHash: `0x${'ab'.repeat(32)}`, country: 'SG', adult: true, notUsPerson: true, ownDecision: true, risksUnderstood: true };
const TWAP = { kind: 'twap', symbol: 'BTC-USD', side: 'buy', quantity: '0.01', durationMs: 600_000, slices: 10, exec: { style: 'taker', slippageBps: 20 }, paper: true };
const settings = (leader = LEADER, over: Record<string, unknown> = {}) => canonicalSettings(parseSettings({ leader: { venue: 'sodex', address: leader }, paper: true, ...over }));

/** The rule the copy runtime applies to a running copy (its host's policyFor). */
const copyPolicy = (svc: ExecutorService, id: string): RegionPolicy =>
  (svc.runtime as unknown as { host: { policyFor(s: unknown): RegionPolicy } }).host.policyFor(svc.runtime.get(id));

const code = async (p: Promise<unknown> | (() => unknown)): Promise<string> => {
  try {
    await (typeof p === 'function' ? p() : p);
    return 'ok';
  } catch (e) {
    return e instanceof ApiError ? `${e.status}:${e.code}` : String(e);
  }
};

test('the built-in list knows a listed address, in any case', () => {
  assert.ok(isSanctionedAddress(LISTED_LEADER));
  assert.ok(isSanctionedAddress(LISTED_LEADER.toUpperCase().replace('0X', '0x')));
  assert.equal(isSanctionedAddress(LEADER), false);
});

test('a listed leader cannot be copied, and a copy of one already running is held', async () => {
  const { svc, cleanup } = make();
  await svc.start();
  const w = new Wallet();
  const ctx = { viewerCountry: 'SG' };
  svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), ctx);
  assert.equal(await code(svc.subscribe(w.sign(svc.executorId, 'subscribe', { settings: settings(LISTED_LEADER), termsVersion: COPY_TERMS_VERSION }), ctx)), '451:sanctioned');
  const v = await svc.subscribe(w.sign(svc.executorId, 'subscribe', { settings: settings(), termsVersion: COPY_TERMS_VERSION }), ctx);
  const id = v.subscription.id;
  assert.equal(await code(svc.act(w.sign(svc.executorId, 'update', { id, settings: settings(LISTED_LEADER) }), ctx)), '451:sanctioned');
  assert.equal(copyPolicy(svc, id).allowed, true);

  // The leader is listed later (a new list released): the copy is held, a resume refused, a stop goes through.
  _sanctionForTests(LEADER);
  const held = copyPolicy(svc, id);
  assert.equal(held.allowed, false);
  assert.equal(held.reason, SANCTIONED_LEADER_REASON);
  await svc.act(w.sign(svc.executorId, 'pause', { id }), ctx);
  assert.equal(await code(svc.act(w.sign(svc.executorId, 'resume', { id }), ctx)), '451:sanctioned');
  assert.equal(await code(svc.act(w.sign(svc.executorId, 'stop', { id, close: false }), ctx)), 'ok');
  await cleanup();
});

test('a listed follower: no terms, no key, no copy, no algo, no resume; what runs is held; stopping and cancelling stay open', async () => {
  const { svc, cleanup } = make();
  await svc.start();
  const ctx = { viewerCountry: 'SG' };
  const listed = new Wallet();
  _sanctionForTests(listed.address);
  assert.equal(await code(() => svc.acceptTerms(listed.sign(svc.executorId, 'accept-terms', TERMS), ctx)), '451:sanctioned');

  // A wallet that accepted the terms, started a copy and an algo, and is listed afterwards.
  _resetSanctionsForTests();
  const w = new Wallet();
  svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), ctx);
  const copy = (await svc.subscribe(w.sign(svc.executorId, 'subscribe', { settings: settings(), termsVersion: COPY_TERMS_VERSION }), ctx)).subscription.id;
  const algo = (await svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: TWAP, seed: 7 }), ctx)).algo.id;
  await svc.algoAct(w.sign(svc.executorId, 'algo-action', { op: 'pause', id: algo }), ctx);
  _sanctionForTests(w.address);

  assert.equal(svc.me(w.address, ctx).policy.allowed, false);
  assert.equal(svc.me(w.address, ctx).policy.reason, SANCTIONED_WALLET_REASON);
  assert.equal(copyPolicy(svc, copy).reason, SANCTIONED_WALLET_REASON);
  assert.equal(await code(() => svc.createKey(w.sign(svc.executorId, 'create-key', { days: 7 }), ctx)), '451:sanctioned');
  assert.equal(await code(svc.importKey(w.address, { name: 'my-desk', envelope: {} }, ctx)), '451:sanctioned');
  assert.equal(await code(svc.subscribe(w.sign(svc.executorId, 'subscribe', { settings: settings('0x2222222222222222222222222222222222222222'), termsVersion: COPY_TERMS_VERSION }), ctx)), '451:sanctioned');
  assert.equal(await code(svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: TWAP, seed: 8 }), ctx)), '451:sanctioned');
  assert.equal(await code(svc.algoAct(w.sign(svc.executorId, 'algo-action', { op: 'resume', id: algo }), ctx)), '451:sanctioned');
  await svc.act(w.sign(svc.executorId, 'pause', { id: copy }), ctx);
  assert.equal(await code(svc.act(w.sign(svc.executorId, 'resume', { id: copy }), ctx)), '451:sanctioned');
  const algoPolicy = (svc as unknown as { algoPolicy(a: unknown): { allowed: boolean } }).algoPolicy(svc.algos.get(algo));
  assert.equal(algoPolicy.allowed, false);

  // Ending the service is never refused.
  assert.equal(await code(svc.algoAct(w.sign(svc.executorId, 'algo-action', { op: 'cancel-all' }), ctx)), 'ok');
  assert.equal(await code(svc.act(w.sign(svc.executorId, 'stop-all', { close: false }), ctx)), 'ok');
  assert.equal(await code(svc.deleteKey(w.sign(svc.executorId, 'delete-key', {}), ctx)), 'ok');
  await cleanup();
});

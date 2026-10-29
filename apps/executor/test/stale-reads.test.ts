/**
 * SoDEX's reads disagree (mainnet, 2026-10-29 ~20:55 UTC): GET /api/v1/user/{a}/api-keys and the
 * engines' key lists alternated between the current list and one 17 minutes old, and nothing in an
 * answer tells the backends apart. The executor's key checks hold up to it: a key one read misses is
 * read again (KEY_READS over a few seconds) before anything is refused, and an active key once seen
 * registered (its address, under its name, with its expiry) stays until it expires - unless SoDEX
 * itself refuses what it signs with a key error, when it is read again (and only reads that all miss
 * it take it away). The fakes here answer the stale list on some reads and the fresh one on others.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes, privateKeyToAddress } from '../../../packages/sodex-core/src/index.ts';
import { COPY_TERMS_VERSION, buildCopyRequest, canonicalSettings, copyRequestDigest, parseSettings, type CopyAction, type FetchLike, type WebSocketLike } from '../../../packages/copy-engine/src/index.ts';
import { parsePrivateKey, sealForImport } from '../../web/src/copy/keyImport.ts';
import { loadConfig } from '../src/config.ts';
import { ExecutorDb } from '../src/db.ts';
import { Secrets } from '../src/secrets.ts';
import { ApiError, ExecutorService } from '../src/service.ts';

const LEADER = '0x1111111111111111111111111111111111111111';

class Wallet {
  readonly pk = secp256k1.utils.randomPrivateKey();
  readonly address = privateKeyToAddress(this.pk).toLowerCase();
  sign(executor: string, action: CopyAction, payload: unknown) {
    const r = buildCopyRequest({ action, owner: this.address, executor, payload, chainId: 42161 });
    const sig = secp256k1.sign(hexToBytes(copyRequestDigest(r)), this.pk);
    const out = new Uint8Array(65);
    out.set(sig.toCompactRawBytes(), 0);
    out[64] = 27 + sig.recovery;
    return { ...r, signature: bytesToHex(out) };
  }
}

type KeyRow = { name: string; publicKey: string; expiresAt: number };

/** SoDEX as the executor reads it; `keys(n)` answers the n-th key-list read (0-based), so a test makes some of them stale. */
interface Fake {
  keys: (n: number, owner: string) => KeyRow[];
  keyReads: number;
}

const BTC_ROW = { id: 1, name: 'BTC-USD', baseCoin: 'BTC', tickSize: '1', stepSize: '0.00001', minQuantity: '0.00001', maxQuantity: '1000', minNotional: '10', maxNotional: '5000000', maxLeverage: 50, buyLimitUpRatio: '0.05', sellLimitDownRatio: '0.05', takerFee: '0.0004', makerFee: '0.0001', status: 'TRADING' };

function fakeFetch(f: Fake): FetchLike {
  const ok = (data: unknown) => ({ status: 200, ok: true, text: async () => JSON.stringify({ code: 0, timestamp: Date.now(), data }) });
  return async (url) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path.endsWith('/markets/symbols')) return ok([BTC_ROW]);
    if (path.endsWith('/markets/mark-prices')) return ok([{ symbol: 'BTC-USD', markPrice: '60000' }]);
    const m = /\/api\/v1\/perps\/accounts\/(0x[0-9a-f]{40})\/api-keys$/.exec(path);
    if (m) return ok(f.keys(f.keyReads++, m[1]!));
    if (/\/api\/v1\/user\/0x[0-9a-f]{40}\/subaccounts$/.test(path)) return ok({ primaryAccountID: 42 });
    if (/\/perps\/accounts\/0x[0-9a-f]{40}\/state$/.test(path)) return ok({ aid: 42, av: '1000', P: [] });
    if (/\/user\/0x[0-9a-f]{40}\/builders$/.test(path)) return ok({ perps: [{ builderID: 234812, feeRate: 25 }], spot: [] });
    return { status: 404, ok: false, text: async () => '{"code":404,"message":"not found"}' };
  };
}

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const noWs = (): WebSocketLike => ({ readyState: 0, send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null });
const TERMS = { termsVersion: COPY_TERMS_VERSION, termsHash: `0x${'ab'.repeat(32)}`, country: 'SG', adult: true, notUsPerson: true, ownDecision: true, risksUnderstood: true };
const ctx = { viewerCountry: 'SG' };
const settings = (over: Record<string, unknown> = {}) => canonicalSettings(parseSettings({ leader: { venue: 'sodex', address: LEADER }, ...over }));

function make(f: Fake, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vd-stale-'));
  const cfg = loadConfig({ EXECUTOR_DATA_DIR: dir, EXECUTOR_KIND: 'hosted', EXECUTOR_EDGE: 'none', ...env });
  const db = new ExecutorDb(':memory:');
  const svc = new ExecutorService(cfg, db, new Secrets(dir), { fetch: fakeFetch(f), factory: noWs, log: silent, readGapMs: 0 });
  return { db, svc, cleanup: async () => { await svc.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof ApiError ? `${e.status}:${e.code}` : `throw:${String(e)}`;
  }
};

/** The private key-problem check a copy's and an algo's readiness ask (service.ts keyProblem). */
const keyProblem = (svc: ExecutorService, owner: string) => (svc as unknown as { keyProblem(o: string): Promise<string | null> }).keyProblem(owner);

/** Terms, and a key the executor made, listed on SoDEX and verified: the wallet's active key. */
async function withActiveKey(svc: ExecutorService, f: Fake, w: Wallet) {
  svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), ctx);
  const k = svc.createKey(w.sign(svc.executorId, 'create-key', { accountId: 42, days: 30 }), ctx);
  const row = { name: k.name, publicKey: k.address, expiresAt: Date.now() + 30 * 86_400_000 };
  f.keys = () => [row];
  assert.equal((await svc.verifyKey(w.address))!.registered, true);
  return row;
}

test('stale key list: an imported key one read misses (the list 17 minutes old) is read again and taken - no 412 not-registered', async () => {
  const f: Fake = { keys: () => [], keyReads: 0 };
  const { svc, db, cleanup } = make(f);
  try {
    const w = new Wallet();
    svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), ctx);
    const pk = secp256k1.utils.randomPrivateKey();
    const address = privateKeyToAddress(pk).toLowerCase();
    const row = { name: 'my-desk', publicKey: address, expiresAt: Date.now() + 30 * 86_400_000 };
    // The first read is the stale backend's (no such key yet), the next the current one.
    f.keys = (n) => (n === 0 ? [] : [row]);
    const info = svc.info(ctx).keyImport!;
    const envelope = await sealForImport(info.publicKey, info.info.replace('<owner>', w.address), parsePrivateKey(`0x${Buffer.from(pk).toString('hex')}`)!);
    const k = await svc.importKey(w.address, { name: 'my-desk', envelope }, ctx);
    assert.equal(k.registered, true);
    assert.equal(db.key(w.address, 'active')!.address, address);
    assert.equal(f.keyReads, 2, 'read twice: the second listed it');
    // Missing on every read: refused, after KEY_READS reads.
    f.keys = () => [];
    f.keyReads = 0;
    const pk2 = secp256k1.utils.randomPrivateKey();
    const envelope2 = await sealForImport(info.publicKey, info.info.replace('<owner>', w.address), parsePrivateKey(`0x${Buffer.from(pk2).toString('hex')}`)!);
    assert.equal(await code(svc.importKey(w.address, { name: 'other', envelope: envelope2 }, ctx)), '412:not-registered');
    assert.equal(f.keyReads, 3, 'refused only when three reads agree');
  } finally {
    await cleanup();
  }
});

test('stale key list: an active key once seen registered is kept until it expires - a read without it neither refuses a live copy or algo nor blocks a running copy', async () => {
  const f: Fake = { keys: () => [], keyReads: 0 };
  const { svc, db, cleanup } = make(f, { EXECUTOR_LIVE_ALGOS: '1', EXECUTOR_BUILDER_ID: '0' });
  await svc.start();
  try {
    const w = new Wallet();
    await withActiveKey(svc, f, w);
    // From now on every read is the stale backend's: the key is not on it.
    f.keys = () => [];
    f.keyReads = 0;
    const v = await svc.subscribe(w.sign(svc.executorId, 'subscribe', { settings: settings({ paper: false }), termsVersion: COPY_TERMS_VERSION }), ctx);
    assert.equal(v.subscription.status, 'active', 'the live copy starts');
    assert.equal(await keyProblem(svc, w.address), null, 'its readiness check finds no problem');
    await svc.runtime.checkReady(svc.runtime.get(v.subscription.id)!);
    assert.equal(svc.runtime.get(v.subscription.id)!.status, 'active', 'and does not block it');
    const spec = { kind: 'twap', symbol: 'BTC-USD', side: 'buy', quantity: '0.01', durationMs: 600_000, slices: 10, exec: { style: 'taker', slippageBps: 20 }, paper: false };
    assert.equal(await code(svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec, seed: 7 }), ctx)), 'ok', 'a live algo starts: no "Register this executor\'s key on SoDEX first"');
    assert.equal(f.keyReads, 0, 'a trusted key is not read at all');
    assert.equal(db.key(w.address, 'active')!.registered, true, 'still registered in the store');
    // The site's polling reads it once a call: a miss there changes nothing either.
    assert.equal((await svc.verifyKey(w.address))!.registered, true);
  } finally {
    await cleanup();
  }
});

test('stale key list: a key SoDEX refused a signed action for is read again; reads that disagree keep it, reads that all miss it block the copy', async () => {
  const f: Fake = { keys: () => [], keyReads: 0 };
  const { svc, db, cleanup } = make(f, { EXECUTOR_BUILDER_ID: '0' });
  try {
    const w = new Wallet();
    const row = await withActiveKey(svc, f, w);
    // SoDEX refused an order with a key error (guard.ts): the key is no longer trusted from having been listed.
    svc.guard.recordError({ kind: 'copy', id: 'c1', owner: w.address }, new Error('api key not found'));
    // The first read is stale (no key), the second current (listed): kept.
    f.keys = (n) => (n === 0 ? [] : [row]);
    f.keyReads = 0;
    assert.equal(await keyProblem(svc, w.address), null);
    assert.equal(f.keyReads, 2);
    assert.equal(db.key(w.address, 'active')!.registered, true);
    // Refused again, and now every read agrees it is gone (revoked): taken away, with the reason.
    svc.guard.recordError({ kind: 'copy', id: 'c1', owner: w.address }, new Error('api key not found'));
    f.keys = () => [];
    f.keyReads = 0;
    assert.match((await keyProblem(svc, w.address)) ?? '', /no longer registered on SoDEX/);
    assert.equal(f.keyReads, 3);
    assert.equal(db.key(w.address, 'active')!.registered, false);
  } finally {
    await cleanup();
  }
});

test('stale key list: a pending key the follower just registered, missed by one read, still lets a live copy start (no 412 key)', async () => {
  const f: Fake = { keys: () => [], keyReads: 0 };
  const { svc, cleanup } = make(f, { EXECUTOR_BUILDER_ID: '0' });
  await svc.start();
  try {
    const w = new Wallet();
    svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), ctx);
    const k = svc.createKey(w.sign(svc.executorId, 'create-key', { accountId: 42, days: 30 }), ctx);
    const row = { name: k.name, publicKey: k.address, expiresAt: Date.now() + 30 * 86_400_000 };
    // Stale, current, stale, ...
    f.keys = (n) => (n % 2 === 0 ? [] : [row]);
    const v = await svc.subscribe(w.sign(svc.executorId, 'subscribe', { settings: settings({ paper: false }), termsVersion: COPY_TERMS_VERSION }), ctx);
    assert.equal(v.subscription.settings.paper, false);
    // Never registered: refused, after three reads that all miss it.
    const other = new Wallet();
    svc.acceptTerms(other.sign(svc.executorId, 'accept-terms', TERMS), ctx);
    svc.createKey(other.sign(svc.executorId, 'create-key', { accountId: 42, days: 30 }), ctx);
    f.keys = () => [];
    f.keyReads = 0;
    assert.equal(await code(svc.subscribe(other.sign(svc.executorId, 'subscribe', { settings: settings({ paper: false }), termsVersion: COPY_TERMS_VERSION }), ctx)), '412:key');
    assert.equal(f.keyReads, 3);
  } finally {
    await cleanup();
  }
});

test('an expired key is refused at once, trusted or not (no read needed)', async () => {
  const f: Fake = { keys: () => [], keyReads: 0 };
  const { svc, db, cleanup } = make(f);
  try {
    const w = new Wallet();
    const row = await withActiveKey(svc, f, w);
    db.markKey(w.address, 'active', true, Date.now() - 1, Date.now());
    f.keyReads = 0;
    assert.match((await keyProblem(svc, w.address)) ?? '', /expired/);
    assert.equal(f.keyReads, 0);
    assert.ok(row.expiresAt > Date.now());
  } finally {
    await cleanup();
  }
});

/**
 * Edge cases of the executor around a running algo or copy (docs/TESTING-MATRIX.md):
 * the trading key expiring mid-run (inside SoDEX's re-check window and after it),
 * the builder approval lowered under the fee, and the emergency brake switched on
 * mid-run for maintenance or by an operator - both hold live trading, only the
 * operator's is an alert.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes, privateKeyToAddress } from '../../../packages/sodex-core/src/index.ts';
import { COPY_TERMS_VERSION, buildCopyRequest, copyRequestDigest, type CopyAction, type FetchLike, type WebSocketLike } from '../../../packages/copy-engine/src/index.ts';
import { Alerts } from '../src/alerts.ts';
import { loadConfig } from '../src/config.ts';
import { ExecutorDb } from '../src/db.ts';
import { Secrets } from '../src/secrets.ts';
import { ExecutorService } from '../src/service.ts';

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

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const noWs = (): WebSocketLike => ({ readyState: 0, send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null });
const TERMS = { termsVersion: COPY_TERMS_VERSION, termsHash: `0x${'ab'.repeat(32)}`, country: 'SG', adult: true, notUsPerson: true, ownDecision: true, risksUnderstood: true };

/** SoDEX's REST as the key and fee checks read it: the account's API keys and its builder approval. */
interface World {
  keys: Record<string, Array<{ name: string; publicKey: string; expiresAt: number }>>;
  /** The approved perps fee for ValueDesk's builder, tenths of a bp (null: none). */
  feeRate: number | null;
}
function fakeFetch(w: World): FetchLike {
  const ok = (data: unknown) => ({ status: 200, ok: true, text: async () => JSON.stringify({ code: 0, data }) });
  return async (url) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path.endsWith('/markets/symbols') || path.endsWith('/markets/mark-prices')) return ok([]);
    let m = /\/perps\/accounts\/(0x[0-9a-f]{40})\/api-keys$/.exec(path);
    if (m) return ok(w.keys[m[1]!] ?? []);
    m = /\/user\/(0x[0-9a-f]{40})\/subaccounts$/.exec(path);
    if (m) return ok({ primaryAccountID: 42 });
    if (/\/state$/.test(path)) return ok({ aid: 42, av: '1000', am: '1000', P: [] });
    if (/\/builders$/.test(path)) return ok({ perps: w.feeRate === null ? [] : [{ builderID: 234812, feeRate: w.feeRate }], spot: [] });
    return { status: 404, ok: false, text: async () => '{"code":404,"message":"not found"}' };
  };
}

async function service(w: World, env: Record<string, string> = {}, alerts?: Alerts) {
  const dir = mkdtempSync(join(tmpdir(), 'vd-edge-'));
  const cfg = loadConfig({ EXECUTOR_DATA_DIR: dir, EXECUTOR_EDGE: 'none', EXECUTOR_KIND: 'hosted', EXECUTOR_BRAKE_FILE: 'none', ...env });
  const db = new ExecutorDb(':memory:');
  const svc = new ExecutorService(cfg, db, new Secrets(dir), { fetch: fakeFetch(w), factory: noWs, log: silent, alerts });
  const done = async () => {
    await svc.stop().catch(() => undefined);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { svc, db, dir, done };
}

/** A wallet with terms and an active key on SoDEX that expires at `expiresAt`. */
async function keyed(svc: ExecutorService, w: World, expiresAt: number): Promise<Wallet> {
  const wallet = new Wallet();
  const ctx = { viewerCountry: 'SG' };
  svc.acceptTerms(wallet.sign(svc.executorId, 'accept-terms', TERMS), ctx);
  const k = svc.createKey(wallet.sign(svc.executorId, 'create-key', { accountId: 42, days: 30 }), ctx);
  w.keys[wallet.address] = [{ name: k.name, publicKey: k.address, expiresAt }];
  await svc.verifyKey(wallet.address);
  return wallet;
}

type Private = { algoProblem(a: { owner: string }): Promise<string | null>; signers: Map<string, unknown>; signer(o: string): unknown };
const priv = (svc: ExecutorService) => svc as unknown as Private;

test('the trading key expiring mid-run: a running algo is held with "The copy key expired" - inside the 10-minute re-check and after it - and its key is no longer used', async () => {
  const realNow = Date.now;
  const w: World = { keys: {}, feeRate: 25 };
  const { svc, done } = await service(w);
  try {
    const t0 = Date.now();
    // Inside the re-check window: the expiry SoDEX gave at registration is checked here, no read.
    const a = await keyed(svc, w, t0 + 5 * 60_000);
    assert.equal(await priv(svc).algoProblem({ owner: a.address }), null, 'valid now');
    Date.now = () => t0 + 6 * 60_000;
    assert.match((await priv(svc).algoProblem({ owner: a.address })) ?? '', /The copy key expired/);
    Date.now = realNow;
    // After it: the expiry SoDEX gave is still what counts (a listed key is trusted until it expires, stale-reads.test.ts), and the opened key is dropped.
    const b = await keyed(svc, w, t0 + 30 * 60_000);
    assert.ok(priv(svc).signer(b.address), 'the key opens while valid');
    Date.now = () => t0 + 31 * 60_000;
    assert.match((await priv(svc).algoProblem({ owner: b.address })) ?? '', /The copy key expired/);
    assert.equal(priv(svc).signers.has(b.address), false, 'no longer held in memory to sign with');
  } finally {
    Date.now = realNow;
    await done();
  }
});

test('builder approval below the fee, lowered mid-run: a running algo is held naming the fee; approved again it may trade', async () => {
  const w: World = { keys: {}, feeRate: 25 };
  const { svc, done } = await service(w);
  try {
    const a = await keyed(svc, w, Date.now() + 30 * 86_400_000);
    assert.equal(await priv(svc).algoProblem({ owner: a.address }), null);
    w.feeRate = 10;
    assert.match((await priv(svc).algoProblem({ owner: a.address })) ?? '', /does not approve the ValueDesk fee \(2\.5 bp\)/);
    w.feeRate = null;
    assert.match((await priv(svc).algoProblem({ owner: a.address })) ?? '', /does not approve the ValueDesk fee/, 'revoked: held too');
    w.feeRate = 25;
    assert.equal(await priv(svc).algoProblem({ owner: a.address }), null);
  } finally {
    await done();
  }
});

test('brake mid-run: a maintenance brake holds running live algos and copies exactly as an operator brake does; only the operator\'s is a Telegram alert', async () => {
  const w: World = { keys: {}, feeRate: 25 };
  const dir = mkdtempSync(join(tmpdir(), 'vd-edge-brake-'));
  const file = join(dir, 'brake.json');
  const alerts = new Alerts({ sender: async () => true, label: 'test executor', dedupeMs: 0 });
  const { svc, done } = await service(w, { EXECUTOR_BRAKE_FILE: file }, alerts);
  type Hosted = { host: { brake?: (x: unknown) => string | null } };
  const algoBrake = () => (svc.algos as unknown as Hosted).host.brake?.({}) ?? null;
  const copyBrake = () => (svc.runtime as unknown as Hosted).host.brake?.({}) ?? null;
  let t = Date.now();
  try {
    assert.equal(algoBrake(), null);
    writeFileSync(file, JSON.stringify({ copies: true, algos: true, reason: 'Updating the copy executor.', since: 1, cause: 'maintenance' }));
    svc.brake.current((t += 2_000));
    assert.match(algoBrake() ?? '', /paused all algo orders on this executor: Updating the copy executor\./);
    assert.match(copyBrake() ?? '', /paused all copy trading on this executor: Updating the copy executor\./);
    assert.deepEqual(alerts.sent, [], 'planned work is not an alert');
    writeFileSync(file, JSON.stringify({ copies: false, algos: true, reason: 'Investigating a fill problem.', since: 2 }));
    svc.brake.current((t += 2_000));
    assert.match(algoBrake() ?? '', /Investigating a fill problem/);
    assert.equal(copyBrake(), null, 'copies run while only the algo switch is on');
    assert.equal(alerts.sent.length, 1);
    assert.match(alerts.sent[0]!, /^🛑 BRAKE/);
    rmSync(file);
    svc.brake.current((t += 2_000));
    assert.equal(algoBrake(), null, 'lifted: held algos go on by themselves');
  } finally {
    await done();
    rmSync(dir, { recursive: true, force: true });
  }
});

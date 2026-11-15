/**
 * A SoDEX API key the follower made themselves, brought to the executor: sealed
 * in the browser with WebCrypto (apps/web/src/copy/keyImport.ts), opened
 * here, and used only when SoDEX lists it on the follower's account, under the
 * name given, for at most 90 days.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes, privateKeyToAddress } from '../../../packages/sodex-core/src/index.ts';
import { COPY_TERMS_VERSION, buildCopyRequest, copyRequestDigest, type CopyAction, type FetchLike, type WebSocketLike } from '../../../packages/copy-engine/src/index.ts';
// The browser's half: the site seals the key with exactly this code.
import { parsePrivateKey, sealForImport } from '../../web/src/copy/keyImport.ts';
import { loadConfig } from '../src/config.ts';
import { ExecutorDb } from '../src/db.ts';
import { Secrets } from '../src/secrets.ts';
import { createExecutorServer } from '../src/server.ts';
import { ApiError, ExecutorService } from '../src/service.ts';

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

type Keys = Record<string, Array<{ name: string; publicKey: string; expiresAt: number }>>;
function fakeFetch(keys: Keys): FetchLike {
  const ok = (data: unknown) => ({ status: 200, ok: true, text: async () => JSON.stringify({ code: 0, timestamp: Date.now(), data }) });
  return async (url) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const m = /\/api\/v1\/perps\/accounts\/(0x[0-9a-f]{40})\/api-keys$/.exec(path);
    if (m) return ok(keys[m[1]!] ?? []);
    if (path.endsWith('/markets/symbols') || path.endsWith('/markets/mark-prices')) return ok([]);
    return { status: 404, ok: false, text: async () => '{"code":404}' };
  };
}

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const noWs = (): WebSocketLike => ({ readyState: 0, send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null });
const TERMS = { termsVersion: COPY_TERMS_VERSION, termsHash: `0x${'ab'.repeat(32)}`, country: 'SG', adult: true, notUsPerson: true, ownDecision: true, risksUnderstood: true };
const ctx = { viewerCountry: 'SG' };

function make(keys: Keys) {
  const dir = mkdtempSync(join(tmpdir(), 'vd-import-'));
  const cfg = loadConfig({ EXECUTOR_PRACTICE_BOTS: '1', EXECUTOR_DATA_DIR: dir, EXECUTOR_KIND: 'hosted', EXECUTOR_EDGE: 'none' });
  const db = new ExecutorDb(':memory:');
  const svc = new ExecutorService(cfg, db, new Secrets(dir), { fetch: fakeFetch(keys), factory: noWs, log: silent, readGapMs: 0 });
  return { cfg, db, svc, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/** A key as the follower would have made it on sodex.com: its private key and address. */
function sodexKey() {
  const pk = secp256k1.utils.randomPrivateKey();
  return { pk, hex: `0x${Buffer.from(pk).toString('hex')}`, address: privateKeyToAddress(pk).toLowerCase() };
}

async function seal(svc: ExecutorService, owner: string, hex: string) {
  const info = svc.info(ctx).keyImport!;
  return sealForImport(info.publicKey, info.info.replace('<owner>', owner), parsePrivateKey(hex)!);
}

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof ApiError ? `${e.status}:${e.code}` : `throw:${String(e)}`;
  }
};

test('key import: a key SoDEX lists on the account under its name becomes the active key, sealed', async () => {
  const keys: Keys = {};
  const { svc, db, cleanup } = make(keys);
  const w = new Wallet();
  svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), ctx);
  const k = sodexKey();
  keys[w.address] = [{ name: 'my-desk', publicKey: k.address, expiresAt: Date.now() + 60 * 86_400_000 }];
  const info = await svc.importKey(w.address, { name: 'my-desk', envelope: await seal(svc, w.address, k.hex) }, ctx);
  assert.equal(info.address, k.address);
  assert.equal(info.name, 'my-desk');
  assert.equal(info.registered, true);
  const row = db.key(w.address, 'active')!;
  assert.equal(row.address, k.address);
  assert.ok(!row.sealed.includes(k.hex.slice(2)), 'stored sealed, never in the clear');
  cleanup();
});

test('key import: refused when SoDEX does not list it, under another name, for over 90 days, or sealed for another wallet', async () => {
  const keys: Keys = {};
  const { svc, cleanup } = make(keys);
  const w = new Wallet();
  const other = new Wallet();
  svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), ctx);
  const k = sodexKey();
  assert.equal(await code(svc.importKey(w.address, { name: 'my-desk', envelope: await seal(svc, w.address, k.hex) }, ctx)), '412:not-registered');
  keys[w.address] = [{ name: 'other-name', publicKey: k.address, expiresAt: Date.now() + 30 * 86_400_000 }];
  assert.equal(await code(svc.importKey(w.address, { name: 'my-desk', envelope: await seal(svc, w.address, k.hex) }, ctx)), '412:not-registered');
  keys[w.address] = [{ name: 'my-desk', publicKey: k.address, expiresAt: Date.now() + 365 * 86_400_000 }];
  assert.equal(await code(svc.importKey(w.address, { name: 'my-desk', envelope: await seal(svc, w.address, k.hex) }, ctx)), '412:key-ttl');
  keys[w.address] = [{ name: 'my-desk', publicKey: k.address, expiresAt: Date.now() + 30 * 86_400_000 }];
  // Sealed for another wallet: it does not open for this one.
  assert.equal(await code(svc.importKey(w.address, { name: 'my-desk', envelope: await seal(svc, other.address, k.hex) }, ctx)), '400:envelope');
  // A bad name or envelope.
  assert.equal(await code(svc.importKey(w.address, { name: '', envelope: await seal(svc, w.address, k.hex) }, ctx)), '400:name');
  assert.equal(await code(svc.importKey(w.address, { name: 'my-desk', envelope: { epk: 'x', iv: 'y', ct: 'z' } }, ctx)), '400:envelope');
  cleanup();
});

test('key import: needs the copy terms first', async () => {
  const { svc, cleanup } = make({});
  const w = new Wallet();
  const k = sodexKey();
  assert.equal(await code(svc.importKey(w.address, { name: 'my-desk', envelope: await seal(svc, w.address, k.hex) }, ctx)), '412:terms');
  cleanup();
});

test('key import over HTTP: POST /keys/import with a session token', async () => {
  const keys: Keys = {};
  const { cfg, svc, cleanup } = make(keys);
  const w = new Wallet();
  svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), ctx);
  const { token } = svc.session(w.sign(svc.executorId, 'session', {}), ctx);
  const k = sodexKey();
  keys[w.address] = [{ name: 'my-desk', publicKey: k.address, expiresAt: Date.now() + 30 * 86_400_000 }];
  const server = createExecutorServer(svc, cfg, silent);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/copy/v1`;
  const body = JSON.stringify({ name: 'my-desk', envelope: await seal(svc, w.address, k.hex) });
  const anon = await fetch(`${base}/keys/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  assert.equal(anon.status, 401);
  const res = await fetch(`${base}/keys/import`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { key: { address: string } }).key.address, k.address);
  server.close();
  cleanup();
});

test('parsePrivateKey: 64 hex characters, with or without 0x; anything else is not a key', () => {
  assert.equal(parsePrivateKey(`0x${'ab'.repeat(32)}`)?.length, 32);
  assert.equal(parsePrivateKey(` ${'AB'.repeat(32)} `)?.length, 32);
  assert.equal(parsePrivateKey('0x1234'), null);
  assert.equal(parsePrivateKey('not a key'), null);
});

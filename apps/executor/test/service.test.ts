import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes, privateKeyToAddress } from '../../../packages/sodex-core/src/index.ts';
import {
  COPY_TERMS_EXECUTOR,
  COPY_TERMS_VERSION,
  buildCopyRequest,
  canonicalSettings,
  copyRequestDigest,
  parseSettings,
  type CopyAction,
  type FetchLike,
  type WebSocketLike,
} from '../../../packages/copy-engine/src/index.ts';
import { loadConfig, type ExecutorConfig } from '../src/config.ts';
import { ExecutorDb } from '../src/db.ts';
import { Secrets } from '../src/secrets.ts';
import { createExecutorServer } from '../src/server.ts';
import { ApiError, ExecutorService } from '../src/service.ts';

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

interface FakeSodex {
  keys: Record<string, Array<{ name: string; publicKey: string; expiresAt: number }>>;
}

function fakeFetch(s: FakeSodex): FetchLike {
  const ok = (data: unknown) => ({ status: 200, ok: true, text: async () => JSON.stringify({ code: 0, timestamp: Date.now(), data }) });
  return async (url) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path.endsWith('/markets/symbols')) return ok([]);
    if (path.endsWith('/markets/mark-prices')) return ok([]);
    let m = /\/api\/v1\/perps\/accounts\/(0x[0-9a-f]{40})\/api-keys$/.exec(path);
    if (m) return ok(s.keys[m[1]!] ?? []);
    m = /\/api\/v1\/user\/(0x[0-9a-f]{40})\/subaccounts$/.exec(path);
    if (m) return ok({ primaryAccountID: m[1] === LEADER ? 7 : 42 });
    if (/\/perps\/accounts\/0x[0-9a-f]{40}\/state$/.test(path)) return ok({ aid: 42, av: '1000', P: [] });
    if (/\/user\/0x[0-9a-f]{40}\/builders$/.test(path)) return ok({ perps: [{ builderID: 221909, feeRate: 25 }], spot: [] });
    return { status: 404, ok: false, text: async () => '{"code":404,"message":"not found"}' };
  };
}

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const noWs = (): WebSocketLike => ({ readyState: 0, send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null });

function make(env: Record<string, string>, fake: FakeSodex = { keys: {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'vd-exec-'));
  const cfg: ExecutorConfig = loadConfig({ EXECUTOR_DATA_DIR: dir, ...env });
  const db = new ExecutorDb(':memory:');
  const svc = new ExecutorService(cfg, db, new Secrets(dir), { fetch: fakeFetch(fake), factory: noWs, log: silent });
  return { cfg, db, svc, dir, cleanup: async () => { await svc.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const TERMS = { termsVersion: COPY_TERMS_VERSION, termsHash: `0x${'ab'.repeat(32)}`, country: 'SG', adult: true, notUsPerson: true, ownDecision: true, risksUnderstood: true };
const settings = (over: Record<string, unknown> = {}) => canonicalSettings(parseSettings({ leader: { venue: 'sodex', address: LEADER }, ...over }));

const code = async (p: Promise<unknown> | (() => unknown)): Promise<string> => {
  try {
    await (typeof p === 'function' ? p() : p);
    return 'ok';
  } catch (e) {
    return e instanceof ApiError ? `${e.status}:${e.code}` : String(e);
  }
};

test('sessions: a signed request gives a token; a replay, another executor, a forged token do not', async () => {
  const { svc, cleanup } = make({ EXECUTOR_KIND: 'hosted' });
  const w = new Wallet();
  const req = w.sign(svc.executorId, 'session', {});
  const g = svc.session(req, { viewerCountry: 'SG' });
  assert.equal(svc.authenticate(g.token), w.address);
  assert.equal(await code(() => svc.session(req, { viewerCountry: 'SG' })), '409:replay');
  assert.equal(await code(() => svc.session(w.sign('someone-else', 'session', {}), { viewerCountry: null })), '401:signature');
  assert.equal(await code(() => svc.authenticate(g.token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')))), '401:session');
  await cleanup();
});

test('self-hosted: only the wallet that paired with the printed code is served', async () => {
  const { svc, cleanup } = make({ EXECUTOR_KIND: 'self' });
  const a = new Wallet();
  const b = new Wallet();
  assert.ok(svc.pairingCode && /^[A-Z0-9]{8}$/.test(svc.pairingCode));
  assert.equal(await code(() => svc.session(a.sign(svc.executorId, 'session', {}), { viewerCountry: null })), '403:unpaired');
  assert.equal(await code(() => svc.session(a.sign(svc.executorId, 'session', {}), { viewerCountry: null, pairingCode: 'WRONG123' })), '403:unpaired');
  const g = svc.session(a.sign(svc.executorId, 'session', {}), { viewerCountry: null, pairingCode: svc.pairingCode!.toLowerCase() });
  assert.equal(svc.owner(), a.address);
  assert.equal(svc.authenticate(g.token), a.address);
  assert.equal(await code(() => svc.session(b.sign(svc.executorId, 'session', {}), { viewerCountry: null, pairingCode: svc.pairingCode })), '403:owner');
  await cleanup();
});

test('terms: every statement, a country, and a region that allows copying', async () => {
  const { svc, cleanup } = make({ EXECUTOR_KIND: 'hosted' });
  const w = new Wallet();
  assert.equal(await code(() => svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', { ...TERMS, risksUnderstood: false }), { viewerCountry: null })), '400:statements');
  assert.equal(await code(() => svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', { ...TERMS, country: 'US' }), { viewerCountry: null })), '451:region');
  assert.equal(await code(() => svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), { viewerCountry: 'US' })), '451:region');
  const me = svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', { ...TERMS, country: 'DE' }), { viewerCountry: 'DE' });
  assert.equal(me.policy.maxLeverage, 2);
  assert.equal(me.terms?.country, 'DE');
  await cleanup();
});

test('one terms signature is accepted by ValueDesk and by a self-hosted copier, a week later too', async () => {
  const hosted = make({ EXECUTOR_KIND: 'hosted' });
  const self = make({ EXECUTOR_KIND: 'self' });
  const w = new Wallet();
  const signedAt = Date.now() - 7 * 86_400_000;
  const terms = w.sign(COPY_TERMS_EXECUTOR, 'accept-terms', TERMS, signedAt);
  assert.equal(hosted.svc.acceptTerms(terms, { viewerCountry: 'SG' }).terms?.country, 'SG');
  self.svc.session(w.sign(self.svc.executorId, 'session', {}), { viewerCountry: null, pairingCode: self.svc.pairingCode });
  assert.equal(self.svc.acceptTerms(terms, { viewerCountry: null }).terms?.country, 'SG');
  // Any other action must name the executor itself.
  assert.equal(await code(() => hosted.svc.session(w.sign(COPY_TERMS_EXECUTOR, 'session', {}), { viewerCountry: null })), '401:signature');
  await hosted.cleanup();
  await self.cleanup();
});

test('keys: created sealed, registered by the follower on SoDEX, then promoted', async () => {
  const fake: FakeSodex = { keys: {} };
  const { svc, db, cleanup } = make({ EXECUTOR_KIND: 'hosted' }, fake);
  const w = new Wallet();
  assert.equal(await code(() => svc.createKey(w.sign(svc.executorId, 'create-key', { accountId: 42, days: 30 }), { viewerCountry: 'SG' })), '412:terms');
  svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), { viewerCountry: 'SG' });
  assert.equal(await code(() => svc.createKey(w.sign(svc.executorId, 'create-key', { accountId: 42, days: 400 }), { viewerCountry: 'SG' })), '400:days');
  const k = svc.createKey(w.sign(svc.executorId, 'create-key', { accountId: 42, days: 30 }), { viewerCountry: 'SG' });
  assert.match(k.address, /^0x[0-9a-f]{40}$/);
  assert.equal(k.name, 'vd-copy-tokyo');
  const row = db.key(w.address, 'pending')!;
  assert.ok(!row.sealed.includes(k.address.slice(2)));
  assert.equal((await svc.verifyKey(w.address))!.registered, false);
  fake.keys[w.address] = [{ name: 'vd-copy-tokyo', publicKey: k.address, expiresAt: Date.now() + 30 * 86_400_000 }];
  const v = await svc.verifyKey(w.address);
  assert.equal(v!.registered, true);
  assert.equal(db.key(w.address, 'active')!.address, k.address);
  assert.equal(db.key(w.address, 'pending'), null);
  await cleanup();
});

test('copies: paper needs no key; live needs a registered key; one copy per trader; owners are kept apart', async () => {
  const fake: FakeSodex = { keys: {} };
  const { svc, cleanup } = make({ EXECUTOR_KIND: 'hosted' }, fake);
  await svc.start();
  const w = new Wallet();
  const other = new Wallet();
  const ctx = { viewerCountry: 'SG' };
  assert.equal(await code(svc.subscribe(w.sign(svc.executorId, 'subscribe', { settings: settings({ paper: true }), termsVersion: COPY_TERMS_VERSION }), ctx)), '412:terms');
  svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), ctx);
  const v = await svc.subscribe(w.sign(svc.executorId, 'subscribe', { settings: settings({ paper: true }), termsVersion: COPY_TERMS_VERSION }), ctx);
  assert.equal(v.subscription.status, 'active');
  assert.equal(v.subscription.settings.paper, true);
  assert.equal(v.subscription.settings.direction, 'copy', 'rules signed without a direction are a plain copy');
  assert.ok(svc.info(ctx).features?.includes('counter'), 'the executor says it runs counter-trades');
  assert.ok(v.subscription.consent?.payload.includes('"subscribe"') === false && v.subscription.consent?.action === 'subscribe');
  assert.equal(await code(svc.subscribe(w.sign(svc.executorId, 'subscribe', { settings: settings({ paper: true }), termsVersion: COPY_TERMS_VERSION }), ctx)), '409:duplicate');
  assert.equal(await code(svc.subscribe(w.sign(svc.executorId, 'subscribe', { settings: settings({ paper: false }), termsVersion: COPY_TERMS_VERSION }), ctx)), '412:key');
  assert.equal(await code(svc.subscribe(w.sign(svc.executorId, 'subscribe', { settings: { leader: { venue: 'sodex', address: 'x' } }, termsVersion: COPY_TERMS_VERSION }), ctx)), '400:settings');

  const id = v.subscription.id;
  assert.equal(await code(svc.act(other.sign(svc.executorId, 'pause', { id }), ctx)), '404:copy');
  const paused = await svc.act(w.sign(svc.executorId, 'pause', { id }), ctx);
  assert.equal(paused.copies[0]!.subscription.status, 'paused');
  const resumed = await svc.act(w.sign(svc.executorId, 'resume', { id }), ctx);
  assert.equal(resumed.copies[0]!.subscription.status, 'active');
  const stopped = await svc.act(w.sign(svc.executorId, 'stop-all', { close: false }), ctx);
  assert.equal(stopped.copies[0]!.subscription.status, 'stopped');
  assert.ok((await svc.activity(w.address, id, {})).some((e) => e.kind === 'status' && e.reason === 'stopped'));
  assert.equal(await code(svc.activity(other.address, id, {})), '404:copy');
  assert.deepEqual(svc.consents(w.address).map((c) => c.action).slice(0, 3), ['stop-all', 'resume', 'pause']);
  await cleanup();
});

test('a closed hosted executor takes no new copies', async () => {
  const { svc, cleanup } = make({ EXECUTOR_KIND: 'hosted', EXECUTOR_OPEN: '0' });
  const w = new Wallet();
  svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), { viewerCountry: null });
  assert.equal(await code(svc.subscribe(w.sign(svc.executorId, 'subscribe', { settings: settings({ paper: true }), termsVersion: COPY_TERMS_VERSION }), { viewerCountry: null })), '503:closed');
  await cleanup();
});

test('secrets: a sealed key opens only for its own follower and address', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vd-sec-'));
  const s = new Secrets(dir);
  const owner = new Wallet().address;
  const k = s.newKey('mainnet', owner);
  const ref = s.open('mainnet', owner, k.address, k.sealed, { name: 'n', expiresAt: null });
  assert.equal(privateKeyToAddress(ref.privateKey).toLowerCase(), k.address);
  assert.equal(JSON.stringify(ref).includes('privateKey'), false);
  assert.throws(() => s.open('mainnet', new Wallet().address, k.address, k.sealed, { name: 'n', expiresAt: null }));
  assert.throws(() => s.open('testnet', owner, k.address, k.sealed, { name: 'n', expiresAt: null }));
  // The same files reopen the same secrets (restart).
  const again = new Secrets(dir);
  assert.equal(privateKeyToAddress(again.open('mainnet', owner, k.address, k.sealed, { name: 'n', expiresAt: null }).privateKey).toLowerCase(), k.address);
  rmSync(dir, { recursive: true, force: true });
});

test('HTTP: info, the private-network preflight, the origin gate, and a signed session', async () => {
  const { cfg, svc, cleanup } = make({ EXECUTOR_KIND: 'hosted', EXECUTOR_ORIGIN_SECRET: 's3cret', EXECUTOR_TRUST_EDGE: '1' });
  const server = createExecutorServer(svc, cfg, silent);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/copy/v1`;
  const gate = { 'X-Origin-Verify': 's3cret', 'X-Viewer-Country': 'jp', Origin: 'https://valuedeskapp.vercel.app' };
  assert.equal((await fetch(`${base}/info`)).status, 403);
  const info = (await (await fetch(`${base}/info`, { headers: gate })).json()) as { executorId: string; viewerCountry: string };
  assert.equal(info.executorId, 'valuedesk-mainnet-tokyo');
  assert.equal(info.viewerCountry, 'JP');
  const pre = await fetch(`${base}/session`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://valuedeskapp.vercel.app', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Private-Network': 'true' },
  });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-private-network'), 'true');
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://valuedeskapp.vercel.app');
  const w = new Wallet();
  const res = await fetch(`${base}/session`, { method: 'POST', headers: { ...gate, 'Content-Type': 'application/json' }, body: JSON.stringify({ request: w.sign(svc.executorId, 'session', {}) }) });
  const g = (await res.json()) as { token: string };
  assert.equal(res.status, 200);
  const me = (await (await fetch(`${base}/me`, { headers: { ...gate, Authorization: `Bearer ${g.token}` } })).json()) as { owner: string; policy: { allowed: boolean } };
  assert.equal(me.owner, w.address);
  assert.equal(me.policy.allowed, false); // no terms accepted yet: no declared country
  server.close();
  await cleanup();
});

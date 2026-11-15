// Pre-go-live audit of the executor (2026-10-27). Every test asserts the CORRECT
// behaviour: a failing test is a confirmed bug; passing ones stay as coverage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes, privateKeyToAddress } from '../../../packages/sodex-core/src/index.ts';
import {
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

const here = dirname(fileURLToPath(import.meta.url));
const APP = resolve(here, '..');
const REPO = resolve(APP, '../..');
const LEADER = '0x1111111111111111111111111111111111111111';

class Wallet {
  readonly pk = secp256k1.utils.randomPrivateKey();
  readonly address = privateKeyToAddress(this.pk).toLowerCase();
  sign(executor: string, action: CopyAction, payload: unknown, now = Date.now(), ttlMs?: number) {
    const r = buildCopyRequest({ action, owner: this.address, executor, payload, chainId: 42161, now, ttlMs });
    const sig = secp256k1.sign(hexToBytes(copyRequestDigest(r)), this.pk);
    const out = new Uint8Array(65);
    out.set(sig.toCompactRawBytes(), 0);
    out[64] = 27 + sig.recovery;
    return { ...r, signature: bytesToHex(out), _sig: sig };
  }
}

interface FakeSodex {
  keys: Record<string, Array<{ name: string; publicKey: string; expiresAt: number }>>;
  /** When set, every api-keys read waits for this. */
  keysGate?: Promise<void> | null;
  /** When set, every subaccounts read waits for this. */
  accountGate?: Promise<void> | null;
}

function fakeFetch(s: FakeSodex): FetchLike {
  const ok = (data: unknown) => ({ status: 200, ok: true, text: async () => JSON.stringify({ code: 0, timestamp: Date.now(), data }) });
  return async (url) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path.endsWith('/markets/symbols')) return ok([]);
    if (path.endsWith('/markets/mark-prices')) return ok([]);
    let m = /\/api\/v1\/perps\/accounts\/(0x[0-9a-f]{40})\/api-keys$/.exec(path);
    if (m) {
      if (s.keysGate) await s.keysGate;
      return ok(s.keys[m[1]!] ?? []);
    }
    m = /\/api\/v1\/user\/(0x[0-9a-f]{40})\/subaccounts$/.exec(path);
    if (m) {
      if (s.accountGate) await s.accountGate;
      return ok({ primaryAccountID: m[1] === LEADER ? 7 : 42 });
    }
    if (/\/perps\/accounts\/0x[0-9a-f]{40}\/state$/.test(path)) return ok({ aid: 42, av: '1000', P: [] });
    if (/\/user\/0x[0-9a-f]{40}\/builders$/.test(path)) return ok({ perps: [{ builderID: 234812, feeRate: 25 }], spot: [] });
    return { status: 404, ok: false, text: async () => '{"code":404,"message":"not found"}' };
  };
}

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const noWs = (): WebSocketLike => ({ readyState: 0, send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null });

function make(env: Record<string, string>, fake: FakeSodex = { keys: {} }, o: { dbPath?: string; dir?: string; log?: typeof silent } = {}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'vd-audit-'));
  const cfg: ExecutorConfig = loadConfig({ EXECUTOR_PRACTICE_BOTS: '1', EXECUTOR_DATA_DIR: dir, EXECUTOR_EDGE: 'none', ...env });
  const db = new ExecutorDb(o.dbPath ?? ':memory:');
  const svc = new ExecutorService(cfg, db, new Secrets(dir), { fetch: fakeFetch(fake), factory: noWs, log: o.log ?? silent });
  return {
    cfg,
    db,
    svc,
    dir,
    cleanup: async (rm = true) => {
      await svc.stop();
      try {
        db.close();
      } catch {
        /* closed already */
      }
      if (rm) rmSync(dir, { recursive: true, force: true });
    },
  };
}

const TERMS = { termsVersion: COPY_TERMS_VERSION, termsHash: `0x${'ab'.repeat(32)}`, country: 'SG', adult: true, notUsPerson: true, ownDecision: true, risksUnderstood: true };
const settings = (over: Record<string, unknown> = {}) => canonicalSettings(parseSettings({ leader: { venue: 'sodex', address: LEADER }, ...over }));
const strip = <T extends { _sig?: unknown }>(r: T) => {
  const { _sig, ...rest } = r;
  return rest;
};

const code = async (p: Promise<unknown> | (() => unknown)): Promise<string> => {
  try {
    await (typeof p === 'function' ? p() : p);
    return 'ok';
  } catch (e) {
    return e instanceof ApiError ? `${e.status}:${e.code}` : `throw:${String(e)}`;
  }
};

/** Terms accepted and a key registered on the fake SoDEX: ready for a live copy. */
async function liveReady(svc: ExecutorService, fake: FakeSodex, w: Wallet, ctx = { viewerCountry: 'SG' }) {
  svc.acceptTerms(strip(w.sign(svc.executorId, 'accept-terms', TERMS)), ctx);
  const k = svc.createKey(strip(w.sign(svc.executorId, 'create-key', { accountId: 42, days: 30 })), ctx);
  fake.keys[w.address] = [{ name: k.name, publicKey: k.address, expiresAt: Date.now() + 30 * 86_400_000 }];
  assert.equal((await svc.verifyKey(w.address))!.registered, true);
  return k;
}

/* ------------------------------------------------- signed requests (coverage) ----- */

test('audit: a signed request is bound to its action, its executor, its time; owner case and signature malleability do not open a replay', async () => {
  const { svc, cleanup } = make({ EXECUTOR_KIND: 'hosted' });
  const w = new Wallet();
  const ctx = { viewerCountry: 'SG' };
  // Wrong action for the endpoint.
  assert.equal(await code(() => svc.session(strip(w.sign(svc.executorId, 'pause', { id: 'x' })), ctx)), '400:action');
  // Another executor's id.
  assert.equal(await code(() => svc.session(strip(w.sign('self-someone', 'session', {})), ctx)), '401:signature');
  // Expired (signed 10 minutes ago, 5-minute window).
  assert.equal(await code(() => svc.session(strip(w.sign(svc.executorId, 'session', {}, Date.now() - 10 * 60_000)), ctx)), '401:signature');
  // From the future beyond the skew allowance.
  assert.equal(await code(() => svc.session(strip(w.sign(svc.executorId, 'session', {}, Date.now() + 20 * 60_000)), ctx)), '401:signature');
  // A window longer than allowed (2 h for an instruction).
  assert.equal(await code(() => svc.session(strip(w.sign(svc.executorId, 'session', {}, Date.now(), 2 * 3600_000)), ctx)), '401:signature');
  // Upper-case owner: the same wallet; a re-cased copy of a used request is a replay.
  const r = strip(w.sign(svc.executorId, 'session', {}));
  const upper = { ...r, owner: `0x${r.owner.slice(2).toUpperCase()}` };
  assert.equal(svc.authenticate(svc.session(upper, ctx).token), w.address);
  assert.equal(await code(() => svc.session(r, ctx)), '409:replay');
  // The other valid (high-s) signature of the same request: same digest, refused.
  const signed = w.sign(svc.executorId, 'session', {}, Date.now() + 1);
  svc.session(strip(signed), ctx);
  const sig = signed._sig as { r: bigint; s: bigint; recovery: number };
  const n = secp256k1.CURVE.n;
  const hi = new Uint8Array(65);
  hi.set(hexToBytes(sig.r.toString(16).padStart(64, '0')), 0);
  hi.set(hexToBytes((n - sig.s).toString(16).padStart(64, '0')), 32);
  hi[64] = 27 + (sig.recovery ^ 1);
  assert.equal(await code(() => svc.session({ ...strip(signed), signature: bytesToHex(hi) }, ctx)), '409:replay');
  // A payload that is not canonical JSON.
  const nc = w.sign(svc.executorId, 'pause', { id: 'x' });
  assert.equal(await code(() => svc.act({ ...strip(nc), payload: '{ "id": "x" }' }, ctx)), '401:signature');
  await cleanup();
});

test('audit: a used request stays refused after a restart (the consent log is on disk)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vd-audit-'));
  const dbPath = join(dir, 'executor.db');
  const w = new Wallet();
  const a = make({ EXECUTOR_KIND: 'hosted' }, { keys: {} }, { dir, dbPath });
  const req = strip(w.sign(a.svc.executorId, 'session', {}));
  a.svc.session(req, { viewerCountry: null });
  await a.cleanup(false);
  const b = make({ EXECUTOR_KIND: 'hosted' }, { keys: {} }, { dir, dbPath });
  assert.equal(await code(() => b.svc.session(req, { viewerCountry: null })), '409:replay');
  await b.cleanup();
});

test('audit: pairing - the code pairs on a session only, is never logged, and stops working once paired', async () => {
  const lines: string[] = [];
  const log = { debug: (m: string, d?: object) => void lines.push(m + JSON.stringify(d ?? {})), info: (m: string, d?: object) => void lines.push(m + JSON.stringify(d ?? {})), warn() {}, error() {} } as unknown as typeof silent;
  const { svc, cleanup } = make({ EXECUTOR_KIND: 'self' }, { keys: {} }, { log });
  const a = new Wallet();
  const b = new Wallet();
  const pc = svc.pairingCode!;
  // Not with another action, even with the right code.
  assert.equal(await code(() => svc.acceptTerms(strip(a.sign(svc.executorId, 'accept-terms', TERMS)), { viewerCountry: null, pairingCode: pc })), '403:unpaired');
  svc.session(strip(a.sign(svc.executorId, 'session', {})), { viewerCountry: null, pairingCode: ` ${pc.toLowerCase()} ` });
  assert.equal(svc.owner(), a.address);
  assert.equal(await code(() => svc.session(strip(b.sign(svc.executorId, 'session', {})), { viewerCountry: null, pairingCode: pc })), '403:owner');
  assert.ok(!lines.some((l) => l.includes(pc)), 'the pairing code is in a log line');
  await cleanup();
});

/* --------------------------------------------------------------- confirmed bugs ----- */

test('BUG: two live subscribes for the same trader sent together start two copies (the duplicate and limit checks race the key check)', async () => {
  const fake: FakeSodex = { keys: {} };
  const { svc, cleanup } = make({ EXECUTOR_KIND: 'hosted' }, fake);
  await svc.start();
  const w = new Wallet();
  const ctx = { viewerCountry: 'SG' };
  await liveReady(svc, fake, w);
  let open!: () => void;
  fake.accountGate = new Promise<void>((r) => (open = r));
  const t = Date.now();
  const one = svc.subscribe(strip(w.sign(svc.executorId, 'subscribe', { settings: settings({ paper: false }), termsVersion: COPY_TERMS_VERSION }, t)), ctx);
  const two = svc.subscribe(strip(w.sign(svc.executorId, 'subscribe', { settings: settings({ paper: false }), termsVersion: COPY_TERMS_VERSION }, t + 1)), ctx);
  await new Promise((r) => setTimeout(r, 20));
  fake.accountGate = null;
  open();
  const results = await Promise.all([code(one), code(two)]);
  const live = svc.runtime.list(w.address).filter((s) => s.status !== 'stopped' && !s.settings.paper);
  assert.equal(live.length, 1, `copies of one trader started: ${live.length} (${results.join(', ')})`);
  assert.deepEqual(results.sort(), ['409:duplicate', 'ok']);
  await cleanup();
});

test('BUG: a readiness check that ends after the copy was stopped rejects (a `void checkReady` then crashes the process)', async () => {
  const fake: FakeSodex = { keys: {} };
  const { svc, db, cleanup } = make({ EXECUTOR_KIND: 'hosted' }, fake);
  await svc.start();
  const w = new Wallet();
  const ctx = { viewerCountry: 'SG' };
  await liveReady(svc, fake, w);
  const v = await svc.subscribe(strip(w.sign(svc.executorId, 'subscribe', { settings: settings({ paper: false }), termsVersion: COPY_TERMS_VERSION })), ctx);
  const sub = svc.runtime.get(v.subscription.id)!;
  // The key was revoked on SoDEX; the next check (older than 10 min) finds it - slowly.
  const k = db.key(w.address, 'active')!;
  db.markKey(w.address, 'active', true, k.expiresAt, Date.now() - 11 * 60_000);
  fake.keys[w.address] = [];
  let open!: () => void;
  fake.keysGate = new Promise<void>((r) => (open = r));
  const check = svc.runtime.checkReady(sub);
  await new Promise((r) => setTimeout(r, 10));
  await svc.act(strip(w.sign(svc.executorId, 'stop', { id: sub.id, close: false })), ctx);
  fake.keysGate = null;
  open();
  assert.equal(await code(check), 'ok');
  assert.equal(svc.runtime.get(sub.id)!.status, 'stopped');
  await cleanup();
});

test('BUG: GET .../activity?limit=abc (or before=abc) answers 500 instead of using the default / a 400', async () => {
  const { cfg, svc, cleanup } = make({ EXECUTOR_KIND: 'hosted' });
  await svc.start();
  const w = new Wallet();
  const ctx = { viewerCountry: 'SG' };
  svc.acceptTerms(strip(w.sign(svc.executorId, 'accept-terms', TERMS)), ctx);
  const v = await svc.subscribe(strip(w.sign(svc.executorId, 'subscribe', { settings: settings({ paper: true }), termsVersion: COPY_TERMS_VERSION })), ctx);
  const { token } = svc.session(strip(w.sign(svc.executorId, 'session', {})), ctx);
  const server = createExecutorServer(svc, cfg, silent);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/copy/v1`;
  const auth = { Authorization: `Bearer ${token}` };
  assert.equal((await fetch(`${base}/copies/${v.subscription.id}/activity`, { headers: auth })).status, 200);
  const a = await fetch(`${base}/copies/${v.subscription.id}/activity?limit=abc`, { headers: auth });
  const b = await fetch(`${base}/copies/${v.subscription.id}/activity?before=abc`, { headers: auth });
  server.close();
  await cleanup();
  // before=abc answers 200 with an empty list (at < NaN matches nothing): wrong too, but quiet.
  assert.ok(b.status !== 500);
  assert.notEqual(a.status, 500, `limit=abc -> ${a.status}`);
});

test('BUG: a hosted executor starts without EXECUTOR_ORIGIN_SECRET (its own origin gate silently off)', () => {
  assert.throws(() => loadConfig({ EXECUTOR_KIND: 'hosted', EXECUTOR_DATA_DIR: tmpdir() }), /ORIGIN_SECRET/);
});

test('BUG: a mistyped EXECUTOR_KIND (e.g. "Hosted") silently becomes a self-hosted executor with a pairing code', () => {
  let cfg: ExecutorConfig | null = null;
  try {
    cfg = loadConfig({ EXECUTOR_KIND: 'Hosted', EXECUTOR_ORIGIN_SECRET: 'x', EXECUTOR_DATA_DIR: tmpdir() });
  } catch {
    return; // refused: correct
  }
  assert.equal(cfg.kind, 'hosted');
});

test('BUG: a key registered on SoDEX for longer than EXECUTOR_KEY_TTL_DAYS (90) is accepted and trades', async () => {
  const fake: FakeSodex = { keys: {} };
  const { svc, db, cleanup } = make({ EXECUTOR_KIND: 'hosted' }, fake);
  const w = new Wallet();
  const ctx = { viewerCountry: 'SG' };
  svc.acceptTerms(strip(w.sign(svc.executorId, 'accept-terms', TERMS)), ctx);
  const k = svc.createKey(strip(w.sign(svc.executorId, 'create-key', { accountId: 42, days: 30 })), ctx);
  fake.keys[w.address] = [{ name: k.name, publicKey: k.address, expiresAt: Date.now() + 400 * 86_400_000 }];
  const info = await svc.verifyKey(w.address);
  const active = db.key(w.address, 'active');
  await cleanup();
  assert.ok(!(info?.registered && active), 'a 400-day key became the active trading key');
});

test('BUG: a request from a client whose clock is 6 minutes slow is refused as "expired; sign it again" (re-signing never helps)', async () => {
  const { svc, cleanup } = make({ EXECUTOR_KIND: 'hosted' });
  const w = new Wallet();
  let msg = '';
  try {
    svc.session(strip(w.sign(svc.executorId, 'session', {}, Date.now() - 6 * 60_000)), { viewerCountry: null });
  } catch (e) {
    msg = (e as Error).message;
  }
  await cleanup();
  assert.match(msg, /clock/i);
});

test('BUG: /health says ok with the database gone (release and monitoring cannot see a broken executor)', async () => {
  const { svc, db, cleanup } = make({ EXECUTOR_KIND: 'hosted' });
  db.close();
  let ok: boolean;
  try {
    ok = svc.health().ok;
  } catch {
    ok = false;
  }
  await cleanup();
  assert.equal(ok, false);
});

test('BUG: a second executor on the same data directory is not refused (two copiers place every copy twice)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vd-audit-'));
  const path = join(dir, 'executor.db');
  const first = new ExecutorDb(path);
  let second: ExecutorDb | null = null;
  try {
    second = new ExecutorDb(path);
    // A real lock may also only bite on first write.
    second.setMeta('probe', '1');
  } catch {
    second = null;
  }
  const opened = second !== null;
  second?.close();
  first.close();
  rmSync(dir, { recursive: true, force: true });
  assert.equal(opened, false);
});

/* ----------------------------------------------------- HTTP edges (coverage) ----- */

test('the VIP import takes a body far over 64 KB, but only with the VIP token (2026-11-09: 7 small bots were refused "too large")', async () => {
  const { cfg, svc, cleanup } = make({ EXECUTOR_KIND: 'hosted', EXECUTOR_EDGE: 'none', EXECUTOR_TIER: 'vip', EXECUTOR_VIP_TOKEN: 'tok' });
  await svc.start();
  const server = createExecutorServer(svc, cfg, silent);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/copy/v1`;
  const body = JSON.stringify({ owner: '0x0', job: 'j', pad: 'x'.repeat(2 * 1024 * 1024) });
  const ok = await fetch(`${base}/internal/vip/import`, { method: 'POST', headers: { 'X-Internal-Token': 'tok', 'Content-Type': 'application/json' }, body });
  assert.notEqual(ok.status, 413, 'a 2 MB import is read');
  const no = await fetch(`${base}/internal/vip/import`, { method: 'POST', headers: { 'X-Internal-Token': 'wrong' }, body });
  assert.equal(no.status, 404, 'without the token: no such route, the body is never read');
  const big = await fetch(`${base}/session`, { method: 'POST', body: 'x'.repeat(70 * 1024) });
  assert.equal(big.status, 413, 'every other route keeps 64 KB');
  await new Promise<void>((r) => server.close(() => r()));
  await cleanup();
});

test('audit: HTTP - body limit, CORS only for allowed origins, the write rate limit, a closed executor still stops copies', async () => {
  const { cfg, svc, cleanup } = make({ EXECUTOR_KIND: 'hosted', EXECUTOR_OPEN: '0', EXECUTOR_ALLOWED_ORIGINS: 'https://valuedesk.so' });
  await svc.start();
  const server = createExecutorServer(svc, cfg, silent);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/copy/v1`;
  const big = await fetch(`${base}/session`, { method: 'POST', body: 'x'.repeat(70 * 1024) });
  assert.equal(big.status, 413);
  const evil = await fetch(`${base}/info`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  const good = await fetch(`${base}/info`, { headers: { Origin: 'https://valuedesk.so' } });
  assert.equal(good.headers.get('access-control-allow-origin'), 'https://valuedesk.so');
  const internal = await (await fetch(`${base}/session`, { method: 'POST', body: '{"request":{}}' })).json() as { error: string };
  assert.ok(!/at .*\.ts/.test(internal.error), 'no stack in an error');
  // Closed to new copies, but stop works (a paper copy started while open is simulated by the runtime directly).
  const w = new Wallet();
  svc.acceptTerms(strip(w.sign(svc.executorId, 'accept-terms', TERMS)), { viewerCountry: 'SG' });
  assert.equal(await code(svc.subscribe(strip(w.sign(svc.executorId, 'subscribe', { settings: settings({ paper: true }), termsVersion: COPY_TERMS_VERSION })), { viewerCountry: 'SG' })), '503:closed');
  assert.equal(await code(svc.act(strip(w.sign(svc.executorId, 'stop-all', { close: false })), { viewerCountry: 'SG' })), 'ok');
  let last = 0;
  for (let i = 0; i < 45; i++) last = (await fetch(`${base}/session`, { method: 'POST', body: '{}' })).status;
  assert.equal(last, 429);
  server.close();
  await cleanup();
});

/* --------------------------------------------- the shipped artefacts (static) ----- */

test('the site offers no self-hosted copier (owner 2026-11-10: only the browser and the executor)', () => {
  assert.equal(existsSync(join(REPO, 'apps/web/public/copier/valuedesk-copier.mjs')), false, 'no bundle to download');
  assert.ok(!readFileSync(join(REPO, 'apps/web/src/copy/CopySetupSheet.tsx'), 'utf8').includes('valuedesk-copier.mjs'), 'no download link');
});

test('BUG: the Dockerfile cannot build - tools/bundle.mjs imports apps/web/tools/licenses.mjs, which the image never copies', () => {
  const bundler = readFileSync(join(APP, 'tools/bundle.mjs'), 'utf8');
  const docker = readFileSync(join(APP, 'Dockerfile'), 'utf8');
  assert.ok(bundler.includes('../../web/tools/licenses.mjs'));
  assert.ok(/COPY\s+apps\/web\/tools\b/.test(docker) || /COPY\s+apps\/web\s/.test(docker) || /COPY\s+\.\s/.test(docker), 'apps/web/tools is not in the build stage');
});

test('BUG: main.ts starts the copy and algo runtimes before the port is bound (a second copier trades, then dies on EADDRINUSE)', () => {
  const src = readFileSync(join(APP, 'src/main.ts'), 'utf8');
  assert.ok(src.indexOf('server.listen(') < src.indexOf('await svc.start()'), 'svc.start() runs before listen');
});

test('BUG: main.ts handles no unhandled rejection or uncaught exception (one stray rejection stops every wallet\'s copies)', () => {
  const src = readFileSync(join(APP, 'src/main.ts'), 'utf8');
  assert.ok(src.includes('unhandledRejection'), 'no process.on("unhandledRejection")');
});

test('BUG: the README downloads the copier from the old vercel.app address, not https://www.valuedesk.so', () => {
  const readme = readFileSync(join(APP, 'README.md'), 'utf8');
  const urls = [...readme.matchAll(/https:\/\/[^\s)]+\/copier\/[^\s)]+/g)].map((m) => m[0]);
  assert.ok(urls.length > 0);
  // www: valuedesk.so answers 308 to www.valuedesk.so, and a download without following redirects would save that answer, not the copier.
  for (const u of urls) assert.ok(u.startsWith('https://www.valuedesk.so/'), u);
});

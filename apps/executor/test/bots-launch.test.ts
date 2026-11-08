/**
 * The bots launch audit's executor fixes (docs/BOTS-LAUNCH-AUDIT.md, 2026-11-08): the key's expiry (A1), the beta
 * answer kept in the db (A2), margin and one market per bot (A3), the VIP move (A6), the real-bot cap (A7), the bot
 * fee on /me and the refusal codes (B), and the small ones (C).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes, privateKeyToAddress } from '../../../packages/sodex-core/src/index.ts';
import { COPY_TERMS_VERSION, buildCopyRequest, canonicalSettings, copyRequestDigest, parseSettings, type AlgoRecord, type CopyAction, type FetchLike, type WebSocketLike } from '../../../packages/copy-engine/src/index.ts';
import { loadConfig, type ExecutorConfig } from '../src/config.ts';
import { ExecutorDb } from '../src/db.ts';
import { Secrets } from '../src/secrets.ts';
import { CalendarFeed } from '../src/calendar.ts';
import { ApiError, ExecutorService, remember } from '../src/service.ts';

class Wallet {
  readonly pk = secp256k1.utils.randomPrivateKey();
  readonly address = privateKeyToAddress(this.pk).toLowerCase();
  sign(executor: string, action: CopyAction, payload: unknown, now = Date.now()) {
    const r = buildCopyRequest({ action, owner: this.address, executor, payload, chainId: 42161, now });
    const sig = secp256k1.sign(hexToBytes(copyRequestDigest(r)), this.pk);
    const out = new Uint8Array(65);
    out.set(sig.toCompactRawBytes(), 0);
    out[64] = 27 + sig.recovery;
    const { _sig, ...rest } = { ...r, signature: bytesToHex(out) } as Record<string, unknown>;
    void _sig;
    return rest;
  }
}

const ROW = (id: number, name: string, base: string) => ({ id, name, baseCoin: base, tickSize: '1', stepSize: '0.00001', minQuantity: '0.00001', maxQuantity: '1000', minNotional: '10', maxNotional: '5000000', maxLeverage: 50, buyLimitUpRatio: '0.05', sellLimitDownRatio: '0.05', takerFee: '0.0004', makerFee: '0.0001', status: 'TRADING' });
const LEADER = '0x' + '77'.repeat(20);

/** The fake SoDEX and API server, per test. */
interface World {
  keys: Record<string, Array<{ name: string; publicKey: string; expiresAt: number }>>;
  /** Account value per wallet; null: the state read fails. */
  equity: Record<string, number | null>;
  positions: Record<string, Array<{ s: string; sz: string }>>;
  beta: string[] | null;
  volume: { usd: number; vip?: boolean; fees?: { bots?: { fee: number; until: number | null } | null } } | null;
  /** The VIP side's answers (a function: called with the path and body). */
  vip?: (path: string, body: unknown) => Promise<{ status: number; body: unknown }>;
}

function fakeFetch(w: World): FetchLike {
  const ok = (data: unknown) => ({ status: 200, ok: true, text: async () => JSON.stringify({ code: 0, timestamp: Date.now(), data }) });
  const json = (status: number, body: unknown) => ({ status, ok: status < 400, text: async () => JSON.stringify(body) });
  return async (url, init) => {
    const u = new URL(url);
    const path = u.pathname;
    if (u.hostname === 'vip.test') {
      if (!w.vip) throw new Error('vip down');
      const r = await w.vip(path, init?.body ? JSON.parse(String(init.body)) : null);
      return json(r.status, r.body);
    }
    if (path.startsWith('/api/vs/builder/beta')) {
      if (w.beta === null) return json(503, { ok: false });
      return json(200, { ok: true, listed: w.beta.includes(u.searchParams.get('address') ?? '') });
    }
    if (path.startsWith('/api/vs/builder/volume')) {
      if (!w.volume) return json(503, { ok: false });
      return json(200, { ok: true, usd: w.volume.usd, vip: w.volume.vip ?? false, fees: { copy: null, bots: w.volume.fees?.bots ?? null } });
    }
    if (path.endsWith('/markets/symbols')) return ok([ROW(1, 'BTC-USD', 'BTC'), ROW(2, 'ETH-USD', 'ETH')]);
    if (path.endsWith('/markets/mark-prices')) return ok([{ symbol: 'BTC-USD', markPrice: '60000' }, { symbol: 'ETH-USD', markPrice: '3000' }]);
    const m = /\/api\/v1\/perps\/accounts\/(0x[0-9a-f]{40})\/(api-keys|state|fee-rate)$/.exec(path);
    if (m && m[2] === 'api-keys') return ok(w.keys[m[1]!] ?? []);
    if (m && m[2] === 'fee-rate') return ok({ makerFeeRate: '0.00012', takerFeeRate: '0.0004' });
    if (m && m[2] === 'state') {
      const e = w.equity[m[1]!];
      if (e === null || e === undefined) return { status: 500, ok: false, text: async () => 'down' };
      return ok({ aid: 42, av: String(e), am: String(e), P: w.positions[m[1]!] ?? [] });
    }
    if (/\/api\/v1\/user\/0x[0-9a-f]{40}\/subaccounts$/.test(path)) return ok({ primaryAccountID: 42 });
    return { status: 404, ok: false, text: async () => '{"code":404,"message":"not found"}' };
  };
}

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const noWs = (): WebSocketLike => ({ readyState: 0, send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null });

function make(env: Record<string, string> = {}, world: Partial<World> = {}, shared?: { db?: ExecutorDb; dir?: string }) {
  const dir = shared?.dir ?? mkdtempSync(join(tmpdir(), 'vd-launch-'));
  const w: World = { keys: {}, equity: {}, positions: {}, beta: [], volume: null, ...world };
  const cfg: ExecutorConfig = loadConfig({ EXECUTOR_DATA_DIR: dir, EXECUTOR_KIND: 'hosted', EXECUTOR_EDGE: 'none', EXECUTOR_BRAKE_FILE: 'none', EXECUTOR_ID: 'valuedesk-test', ...env });
  const db = shared?.db ?? new ExecutorDb(':memory:');
  const alerts: string[] = [];
  const svc = new ExecutorService(cfg, db, new Secrets(dir), { fetch: fakeFetch(w), factory: noWs, log: silent, readGapMs: 0, alerts: { raise: (kind: string) => void alerts.push(kind) } as never });
  return { cfg, db, svc, w, dir, alerts, cleanup: async () => { await svc.stop(); if (!shared?.db) db.close(); if (!shared?.dir) rmSync(dir, { recursive: true, force: true }); } };
}

const TERMS = (country = 'SG') => ({ termsVersion: COPY_TERMS_VERSION, termsHash: `0x${'ab'.repeat(32)}`, country, adult: true, notUsPerson: true, ownDecision: true, risksUnderstood: true });
const MM = { kind: 'mm', symbol: 'BTC-USD', orderUsd: 20, maxInventoryUsd: 100, maxLossUsd: 50, paper: false };
const ctx = { viewerCountry: 'SG' };

const code = async (p: Promise<unknown> | (() => unknown)): Promise<string> => {
  try {
    await (typeof p === 'function' ? p() : p);
    return 'ok';
  } catch (e) {
    return e instanceof ApiError ? `${e.status}:${e.code}` : `throw:${String(e)}`;
  }
};
const refusal = async (p: Promise<unknown>): Promise<ApiError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error('not refused');
};

/** Terms, a registered key (SoDEX lists it), an account: ready for real bots. */
async function ready(h: ReturnType<typeof make>, w: Wallet, o: { equity?: number | null; expiresIn?: number; country?: string } = {}) {
  h.svc.acceptTerms(w.sign(h.svc.executorId, 'accept-terms', TERMS(o.country)), { viewerCountry: o.country ?? 'SG' });
  const k = h.svc.createKey(w.sign(h.svc.executorId, 'create-key', { accountId: 42, days: 30 }), ctx);
  h.w.keys[w.address] = [{ name: k.name, publicKey: k.address, expiresAt: Date.now() + (o.expiresIn ?? 30 * 86_400_000) }];
  assert.equal((await h.svc.verifyKey(w.address))!.registered, true);
  h.w.equity[w.address] = o.equity === undefined ? 10_000 : o.equity;
  return k;
}
const start = (h: ReturnType<typeof make>, w: Wallet, spec: Record<string, unknown>, seed = 1, c: Record<string, unknown> = ctx) => h.svc.algoStart(w.sign(h.svc.executorId, 'algo-start', { spec, seed }), c as never);

/* ------------------------------------------------------------------ A3 margin ----- */

test('A3 margin: unreadable equity refuses a real bot (503 margin-unknown); too little is a 409 margin with the figures; enough starts it', async () => {
  const w = new Wallet();
  const h = make({ EXECUTOR_LIVE_ALGOS_WALLETS: w.address });
  await ready(h, w, { equity: null });
  assert.equal(await code(start(h, w, MM)), '503:margin-unknown');
  h.w.equity[w.address] = 100;
  const e = await refusal(start(h, w, MM, 2));
  assert.equal(`${e.status}:${e.code}`, '409:margin');
  assert.match(e.message, /needs \$\d+ of margin, but only \$100 of your \$100 futures balance is free/);
  assert.equal(e.detail?.equityUsd, 100);
  assert.equal(e.detail?.freeUsd, 100);
  assert.ok(Number(e.detail?.needUsd) >= 140, 'max holding 100 + a quote each side at 1x');
  h.w.equity[w.address] = 10_000;
  const v = await start(h, w, MM, 3);
  assert.equal(v.algo.status, 'scheduled');
  await h.cleanup();
});

test('A3 margin: a signed update that needs more margin passes the start check; one that needs no more (a label, a smaller size) is never refused for it', async () => {
  const w = new Wallet();
  const h = make({ EXECUTOR_LIVE_ALGOS_WALLETS: w.address });
  await ready(h, w, { equity: 1_000 });
  const v = await start(h, w, MM);
  const up = (patch: unknown) => h.svc.algoAct(w.sign(h.svc.executorId, 'algo-action', { op: 'update', id: v.algo.id, patch }), ctx);
  const e = await refusal(up({ orderUsd: 1_000 }));
  assert.equal(`${e.status}:${e.code}`, '409:margin');
  assert.match(e.message, /This change needs/);
  assert.equal(await code(up({ maxInventoryUsd: 5_000 })), '409:margin');
  // The balance cannot be read: a change that needs no more still goes through.
  h.w.equity[w.address] = null;
  assert.equal(await code(up({ label: 'night' })), 'ok');
  assert.equal(await code(up({ orderUsd: 10 })), 'ok');
  assert.equal(await code(up({ orderUsd: 30 })), '503:margin-unknown');
  await h.cleanup();
});

test('A3 margin: a live copy subscribed (or its allocation raised) counts the running real bots too', async () => {
  const w = new Wallet();
  const h = make({ EXECUTOR_LIVE_ALGOS_WALLETS: w.address });
  await ready(h, w, { equity: 1_000 });
  await start(h, w, MM);
  const settings = (over: Record<string, unknown>) => canonicalSettings(parseSettings({ leader: { venue: 'sodex', address: LEADER }, assetDeny: ['BTC'], ...over }));
  const e = await refusal(h.svc.subscribe(w.sign(h.svc.executorId, 'subscribe', { settings: settings({ paper: false, allocationUsd: 950 }), termsVersion: COPY_TERMS_VERSION }), ctx));
  assert.equal(`${e.status}:${e.code}`, '409:margin');
  assert.match(e.message, /running bot holds/);
  const c = await h.svc.subscribe(w.sign(h.svc.executorId, 'subscribe', { settings: settings({ paper: false, allocationUsd: 300 }), termsVersion: COPY_TERMS_VERSION }), ctx);
  const upd = (alloc: number) => h.svc.act(w.sign(h.svc.executorId, 'update', { id: c.subscription.id, settings: settings({ paper: false, allocationUsd: alloc }) }), ctx);
  assert.equal(await code(upd(950)), '409:margin');
  assert.equal(await code(upd(200)), 'ok', 'a smaller allocation is never refused for it');
  await h.cleanup();
});

/* ---------------------------------------------------------- A3 one market ----- */

test('A3 market: several bots share a market at one leverage, beside a position the wallet holds; a live algo or a copy on it still refuses - saying what to stop', async () => {
  const w = new Wallet();
  const h = make({ EXECUTOR_LIVE_ALGOS_WALLETS: w.address });
  await ready(h, w);
  // A position the bot did not open: left alone, so the bot starts (owner 2026-11-08).
  h.w.positions[w.address] = [{ s: 'BTC-USD', sz: '0.01' }];
  const first = await start(h, w, { ...MM, leverage: 3 }, 2);
  // A second bot on BTC at the same leverage starts; at another it is refused, naming the first one's.
  assert.equal(await code(start(h, w, { ...MM, leverage: 3 }, 3)), 'ok', 'a second bot on the same market');
  const lv = await refusal(start(h, w, { ...MM, leverage: 5 }, 4));
  assert.equal(`${lv.status}:${lv.code}`, '409:bot-leverage');
  assert.match(lv.message, /uses 3x\. Bots on one market share one leverage: set 3x/);
  assert.equal(lv.detail?.leverage, 3);
  assert.ok(lv.detail?.algoId === first.algo.id || typeof lv.detail?.algoId === 'string');
  h.w.positions[w.address] = [];
  // A live TWAP on ETH: a bot on ETH is refused, one on BTC is not.
  const twap = await start(h, w, { kind: 'twap', symbol: 'ETH-USD', side: 'buy', quantity: '0.1', durationMs: 600_000, slices: 10, exec: { style: 'taker', slippageBps: 20 } }, 5);
  const a = await refusal(start(h, w, { ...MM, symbol: 'ETH-USD' }, 6));
  assert.equal(`${a.status}:${a.code}`, '409:market-algo');
  assert.equal(a.detail?.algoId, twap.algo.id);
  // A copy whose allow list names BTC.
  const settings = canonicalSettings(parseSettings({ leader: { venue: 'sodex', address: LEADER }, assetAllow: ['BTC'], paper: false, allocationUsd: 100 }));
  const c = await h.svc.subscribe(w.sign(h.svc.executorId, 'subscribe', { settings, termsVersion: COPY_TERMS_VERSION }), ctx);
  const b = await refusal(start(h, w, { ...MM, leverage: 3 }, 7));
  assert.equal(`${b.status}:${b.code}`, '409:market-copy');
  assert.match(b.message, /Stop that copy/);
  assert.equal(b.detail?.copyId, c.subscription.id);
  await h.svc.act(w.sign(h.svc.executorId, 'stop', { id: c.subscription.id, close: false }), ctx);
  assert.equal(await code(start(h, w, { ...MM, leverage: 3 }, 8)), 'ok', 'with the copy stopped it starts');
  await h.cleanup();
});

/* ------------------------------------------------------------- A7 capacity ----- */

test('A7: a hard cap on real bots per executor (EXECUTOR_MAX_LIVE_BOTS), every wallet together: a clear 429; practice is never capped', async () => {
  const a = new Wallet();
  const b = new Wallet();
  const h = make({ EXECUTOR_LIVE_ALGOS_WALLETS: `${a.address},${b.address}`, EXECUTOR_MAX_LIVE_BOTS: '1' });
  assert.equal(loadConfig({ EXECUTOR_EDGE: 'none' }).maxLiveBots, 10, 'default 10');
  await ready(h, a);
  await ready(h, b);
  await start(h, a, MM);
  const e = await refusal(start(h, b, MM, 2));
  assert.equal(`${e.status}:${e.code}`, '429:bot-capacity');
  assert.match(e.message, /as many real bots as it can take \(1\)/);
  assert.equal(await code(start(h, b, { ...MM, paper: true }, 3)), 'ok');
  await h.cleanup();
});

/* ------------------------------------------------------------- A2 beta list ----- */

test('A2: the beta answer is kept in the db; a list that does not answer keeps it (no hold); only an explicit "not listed" holds; never answered: refused', async () => {
  const w = new Wallet();
  const env = { EXECUTOR_BUILDER_URL: 'http://127.0.0.1:9/api/vs/builder/volume', EXECUTOR_BUILDER_TOKEN: 't' };
  const h = make(env, { beta: [] });
  const answer = (s: ExecutorService, o = w.address) => (s as unknown as { betaAnswer(o: string): Promise<boolean | null> }).betaAnswer(o);
  const forget = (s: ExecutorService) => (s as unknown as { betaCache: Map<string, unknown> }).betaCache.clear();
  h.w.beta = [w.address];
  assert.equal(await answer(h.svc), true);
  assert.deepEqual(h.db.betaAnswer(w.address)?.listed, true);
  // Server 1 down, memory gone (a restart): the db's answer stands.
  h.w.beta = null;
  forget(h.svc);
  assert.equal(await answer(h.svc), true);
  const again = make(env, { beta: null }, { db: h.db });
  assert.equal(await answer(again.svc), true, 'a new process on the same db');
  await again.cleanup();
  // An explicit "not listed": held.
  h.w.beta = [];
  forget(h.svc);
  assert.equal(await answer(h.svc), false);
  const problem = (s: ExecutorService, a: Partial<AlgoRecord>) => (s as unknown as { algoProblem(a: unknown): Promise<string | null> }).algoProblem(a);
  h.db.putKey({ owner: w.address, slot: 'active', address: w.address, name: 'k', sealed: 'x', createdAt: 1, expiresAt: null, registered: true, checkedAt: Date.now() });
  assert.match((await problem(h.svc, { owner: w.address, spec: { ...MM, bot: true } as never }))!, /no longer on the beta list/);
  // Never answered and unreadable: a new real bot is refused (fails closed).
  const z = new Wallet();
  h.w.beta = null;
  assert.equal(await answer(h.svc, z.address), null);
  await h.cleanup();
});

/* ------------------------------------------------------------ A1 key expiry ----- */

test('A1: the engine reads the active key\'s expiry; a notice ~24 h and ~1 h before a key that real bots use expires, once each', async () => {
  const w = new Wallet();
  const p = new Wallet();
  const h = make({ EXECUTOR_LIVE_ALGOS_WALLETS: `${w.address},${p.address}` });
  const k = await ready(h, w, { expiresIn: 23 * 3_600_000 });
  await start(h, w, MM);
  const exp = h.db.key(w.address, 'active')!.expiresAt!;
  const host = (h.svc.algos as unknown as { host: { keyExpiresAt?(o: string): number | null } }).host;
  assert.equal(host.keyExpiresAt?.(w.address), exp);
  assert.equal(host.keyExpiresAt?.('0x' + '0'.repeat(40)), null);
  // Practice-only wallet with an expiring key: nothing.
  await ready(h, p, { expiresIn: 3_600_000 / 2 });
  await start(h, p, { ...MM, paper: true }, 2);
  h.svc.warnKeyExpiry();
  h.svc.warnKeyExpiry();
  let n = h.db.notices(w.address);
  assert.equal(n.length, 1);
  assert.match(n[0]!.title, /expires in about 24 hours/);
  assert.equal(n[0]!.id, `key-expiry:24h:${w.address}:${k.address}:${exp}`);
  assert.equal(h.db.notices(p.address).length, 0);
  h.svc.warnKeyExpiry(exp - 30 * 60_000);
  n = h.db.notices(w.address);
  assert.equal(n.length, 2);
  assert.match(n[0]!.title, /expires within the hour/);
  assert.equal(n[0]!.grade, 'error');
  await h.cleanup();
});

/* -------------------------------------------------------- B fee and codes ----- */

test('B: /me carries the bot fee - the ladder by volume, or a program\'s (the beta VIP from server 1) with its end; no own 30 days from the first bot', async () => {
  const w = new Wallet();
  const env = { EXECUTOR_BUILDER_URL: 'http://127.0.0.1:9/api/vs/builder/volume', EXECUTOR_BUILDER_TOKEN: 't' };
  const h = make(env, { volume: { usd: 0 } });
  const fresh = (s: ExecutorService) => (s as unknown as { freshVolume(o: string): Promise<number | null> }).freshVolume(w.address);
  await fresh(h.svc);
  assert.deepEqual(h.svc.me(w.address, ctx).bots, { feeTenths: 5, vip: false, until: null });
  const until = Date.now() + 10 * 86_400_000;
  h.w.volume = { usd: 300_000, fees: { bots: { fee: 1, until } } };
  (h.svc as unknown as { volumes: Map<string, unknown> }).volumes.clear();
  await fresh(h.svc);
  assert.deepEqual(h.svc.me(w.address, ctx).bots, { feeTenths: 1, vip: true, until });
  // VIP by volume (no end).
  h.w.volume = { usd: 1_500_000, vip: true, fees: { bots: { fee: 1, until: null } } };
  (h.svc as unknown as { volumes: Map<string, unknown> }).volumes.clear();
  await fresh(h.svc);
  assert.deepEqual(h.svc.me(w.address, ctx).bots, { feeTenths: 1, vip: true, until: null });
  // C: perks not read again for 6 h end (VIP included): the ladder again.
  const perks = (h.svc as unknown as { perks: Map<string, { at: number }> }).perks;
  perks.get(w.address)!.at = Date.now() - 7 * 3_600_000;
  assert.deepEqual(h.svc.me(w.address, ctx).bots, { feeTenths: 2, vip: false, until: null }, 'the ladder at $1.5M');
  await h.cleanup();
});

test('B: bot refusals in plain words with a code - key, account (deposit), beta (Discord, no beta site named), limit', async () => {
  const w = new Wallet();
  const h = make({ EXECUTOR_MAX_ALGOS: '1' });
  h.svc.acceptTerms(w.sign(h.svc.executorId, 'accept-terms', TERMS()), ctx);
  const beta = await refusal(start(h, w, MM));
  assert.equal(`${beta.status}:${beta.code}`, '403:beta');
  assert.match(beta.message, /ask on Discord/);
  assert.doesNotMatch(beta.message, /beta\.valuedesk\.so/);
  await h.cleanup();
  const k = make({ EXECUTOR_LIVE_ALGOS_WALLETS: w.address, EXECUTOR_MAX_ALGOS: '1' });
  k.svc.acceptTerms(w.sign(k.svc.executorId, 'accept-terms', TERMS()), ctx);
  const key = await refusal(start(k, w, MM));
  assert.equal(`${key.status}:${key.code}`, '412:key');
  assert.equal(key.message, 'Set up real orders: approve the trading key first.');
  await start(k, w, { ...MM, paper: true }, 2);
  const lim = await refusal(start(k, w, { ...MM, paper: true }, 3));
  assert.equal(`${lim.status}:${lim.code}`, '429:limit');
  assert.match(lim.message, /bots and orders here; 1 is the most at once/);
  await k.cleanup();
  // No SoDEX account: "Deposit to SoDEX first".
  const n = make({ EXECUTOR_LIVE_ALGOS_WALLETS: w.address });
  await ready(n, w);
  (n.svc.sodex as unknown as { accountId(a: string): Promise<number> }).accountId = async () => 0;
  const acc = await refusal(start(n, w, MM));
  assert.equal(`${acc.status}:${acc.code}`, '412:account');
  assert.match(acc.message, /^Deposit to SoDEX first/);
  await n.cleanup();
});

/* ------------------------------------------------------------------- A6 VIP ----- */

/** A standard executor and a VIP one, the standard side's fetch reaching the VIP service. */
function pair(o: { brakeVip?: boolean; vip?: (svc: ExecutorService, path: string, body: unknown) => Promise<{ status: number; body: unknown }> } = {}) {
  const vipDir = mkdtempSync(join(tmpdir(), 'vd-vip-'));
  if (o.brakeVip) writeFileSync(join(vipDir, 'brake.json'), JSON.stringify({ copies: true, algos: true, reason: 'test brake', cause: 'operator' }));
  const vip = make({ EXECUTOR_TIER: 'vip', EXECUTOR_VIP_TOKEN: 'tok', ...(o.brakeVip ? { EXECUTOR_BRAKE_FILE: join(vipDir, 'brake.json') } : {}) }, {}, { dir: vipDir });
  const pub = new Secrets(vipDir).importPublicKey();
  const std = make({ EXECUTOR_VIP_URL: 'https://vip.test/api/copy/v1', EXECUTOR_VIP_TOKEN: 'tok', EXECUTOR_VIP_PUBKEY: pub, EXECUTOR_VIP_OPEN: '1' });
  std.w.vip = async (path, body) => {
    if (o.vip) return o.vip(vip.svc, path, body);
    return route(vip.svc, path, body);
  };
  return { vip, std, cleanup: async () => { await std.cleanup(); await vip.cleanup(); rmSync(vipDir, { recursive: true, force: true }); } };
}
/** The VIP executor's three routes, as server.ts answers them. */
async function route(svc: ExecutorService, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  try {
    if (path.endsWith('/info')) return { status: 200, body: svc.info({ viewerCountry: null }) };
    if (path.endsWith('/internal/vip/import')) return { status: 200, body: await svc.vipImport(body) };
    if (path.endsWith('/internal/vip/import/status')) return { status: 200, body: svc.vipImportStatus(body) };
  } catch (e) {
    if (e instanceof ApiError) return { status: e.status, body: { ok: false, code: e.code, error: e.message } };
    return { status: 500, body: { ok: false, error: 'internal' } };
  }
  return { status: 404, body: { ok: false } };
}
const until = async (f: () => boolean) => {
  for (let i = 0; i < 400 && !f(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(f(), 'timed out');
};

test('A6 VIP: a move hands the bots over (adopted and resumed there, ended here, wallet marked moved); the job is in the db; the moved wallet starts no bot here', async () => {
  const w = new Wallet();
  const p = pair();
  p.std.svc.acceptTerms(w.sign(p.std.svc.executorId, 'accept-terms', TERMS()), ctx);
  const b = await start(p.std, w, { ...MM, paper: true });
  assert.equal(p.std.svc.info(ctx).vip?.canMove, true);
  const job = p.std.svc.vipMove(w.sign(p.std.svc.executorId, 'vip-move', {}), ctx);
  await until(() => p.std.svc.vipJob(w.address)?.state !== 'running');
  const done = p.std.svc.vipJob(w.address)!;
  assert.equal(done.state, 'done', done.error ?? '');
  assert.equal(done.outcome, 'moved');
  assert.equal(p.std.svc.algos.get(b.algo.id)!.status, 'cancelled');
  assert.equal(p.vip.svc.algos.get(b.algo.id)!.status, 'scheduled', 'resumed on the VIP side');
  assert.equal(p.std.db.vipJobs<{ id: string; state: string }>(w.address)[0]!.id, job.id);
  assert.equal(p.vip.db.vipImport(job.id)!.state, 'done');
  assert.equal(await code(start(p.std, w, { ...MM, paper: true }, 9)), '409:moved');
  assert.equal(await code(() => p.std.svc.vipMove(w.sign(p.std.svc.executorId, 'vip-move', {}), ctx)), '409:moved');
  await p.cleanup();
});

test('A6 VIP: the key is sealed only to the pinned public key - another one in /info sends nothing and the bots resume here', async () => {
  const w = new Wallet();
  const p = pair({ vip: async (svc, path, body) => (path.endsWith('/info') ? { status: 200, body: { ...svc.info({ viewerCountry: null }), keyImport: { publicKey: new Secrets(mkdtempSync(join(tmpdir(), 'vd-x-'))).importPublicKey() } } } : route(svc, path, body)) });
  p.std.svc.acceptTerms(w.sign(p.std.svc.executorId, 'accept-terms', TERMS()), ctx);
  const b = await start(p.std, w, { ...MM, paper: true });
  p.std.svc.vipMove(w.sign(p.std.svc.executorId, 'vip-move', {}), ctx);
  await until(() => p.std.svc.vipJob(w.address)?.state !== 'running');
  const j = p.std.svc.vipJob(w.address)!;
  assert.equal(j.state, 'failed');
  assert.equal(j.outcome, 'not-moved');
  assert.match(j.error!, /did not prove who they are/);
  assert.ok(p.std.alerts.includes('vip-key-mismatch'));
  assert.equal(p.std.svc.algos.get(b.algo.id)!.status, 'scheduled', 'resumed here');
  assert.equal(p.vip.svc.algos.get(b.algo.id), null);
  // Without a pinned key there is no move at all; an http VIP URL is refused at load.
  assert.equal(loadConfig({ EXECUTOR_EDGE: 'none', EXECUTOR_VIP_URL: 'https://vip.test/x', EXECUTOR_VIP_TOKEN: 't' }).vipPubkey, null);
  assert.throws(() => loadConfig({ EXECUTOR_EDGE: 'none', EXECUTOR_VIP_URL: 'http://vip.example.com/x' }), /https/);
  assert.throws(() => loadConfig({ EXECUTOR_EDGE: 'none', EXECUTOR_VIP_PUBKEY: 'short!' }), /EXECUTOR_VIP_PUBKEY/);
  await p.cleanup();
});

test('A6 VIP: a send that times out is asked about - taken in there: finished here; never begun: given up there (a late import is refused) and resumed here; no answer: unknown, paused, operator told', async () => {
  // 1. The import ran on the VIP side but its answer was lost.
  {
    const w = new Wallet();
    const p = pair({ vip: async (svc, path, body) => {
      if (path.endsWith('/internal/vip/import')) {
        await route(svc, path, body);
        throw new Error('timeout');
      }
      return route(svc, path, body);
    } });
    p.std.svc.acceptTerms(w.sign(p.std.svc.executorId, 'accept-terms', TERMS()), ctx);
    const b = await start(p.std, w, { ...MM, paper: true });
    p.std.svc.vipMove(w.sign(p.std.svc.executorId, 'vip-move', {}), ctx);
    await until(() => p.std.svc.vipJob(w.address)?.state !== 'running');
    const j = p.std.svc.vipJob(w.address)!;
    assert.equal(j.state, 'done', j.error ?? '');
    assert.ok(j.session?.token, 'the status answer carries a read token');
    assert.equal(p.std.svc.algos.get(b.algo.id)!.status, 'cancelled', 'ended here, runs there');
    assert.equal(p.vip.svc.algos.get(b.algo.id)!.status, 'scheduled');
    await p.cleanup();
  }
  // 2. The import never arrived: the status question gives it up, and its late arrival is refused.
  {
    const w = new Wallet();
    let late: unknown = null;
    const p = pair({ vip: async (svc, path, body) => {
      if (path.endsWith('/internal/vip/import')) {
        late = body;
        throw new Error('timeout');
      }
      return route(svc, path, body);
    } });
    p.std.svc.acceptTerms(w.sign(p.std.svc.executorId, 'accept-terms', TERMS()), ctx);
    const b = await start(p.std, w, { ...MM, paper: true });
    p.std.svc.vipMove(w.sign(p.std.svc.executorId, 'vip-move', {}), ctx);
    await until(() => p.std.svc.vipJob(w.address)?.state !== 'running');
    const j = p.std.svc.vipJob(w.address)!;
    assert.equal(j.outcome, 'not-moved');
    assert.equal(p.std.svc.algos.get(b.algo.id)!.status, 'scheduled', 'resumed here');
    assert.equal(await code(p.vip.svc.vipImport(late)), '409:vip-abandoned');
    assert.equal(p.vip.svc.algos.get(b.algo.id), null);
    await p.cleanup();
  }
  // 3. No answer at all: unknown - the bots stay paused here, nothing is resumed on a guess.
  {
    const w = new Wallet();
    const p = pair({ vip: async (svc, path, body) => {
      if (path.includes('/internal/vip/import')) throw new Error('down');
      return route(svc, path, body);
    } });
    p.std.svc.acceptTerms(w.sign(p.std.svc.executorId, 'accept-terms', TERMS()), ctx);
    const b = await start(p.std, w, { ...MM, paper: true });
    p.std.svc.vipMove(w.sign(p.std.svc.executorId, 'vip-move', {}), ctx);
    await until(() => p.std.svc.vipJob(w.address)?.state !== 'running');
    const j = p.std.svc.vipJob(w.address)!;
    assert.equal(j.outcome, 'unknown');
    assert.equal(p.std.svc.algos.get(b.algo.id)!.status, 'paused');
    assert.ok(p.std.alerts.includes('vip-move-unknown'));
    await p.cleanup();
  }
});

test('A6 VIP: starts and resumes are refused while a move runs (stop still goes through after it); a move cut by a restart is reported, not resumed', async () => {
  const w = new Wallet();
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const p = pair({ vip: async (svc, path, body) => {
    if (path.endsWith('/info')) await gate;
    return route(svc, path, body);
  } });
  p.std.svc.acceptTerms(w.sign(p.std.svc.executorId, 'accept-terms', TERMS()), ctx);
  const b = await start(p.std, w, { ...MM, paper: true });
  p.std.svc.vipMove(w.sign(p.std.svc.executorId, 'vip-move', {}), ctx);
  assert.equal(await code(start(p.std, w, { ...MM, paper: true }, 4)), '409:vip-moving');
  assert.equal(await code(p.std.svc.algoAct(w.sign(p.std.svc.executorId, 'algo-action', { op: 'resume', id: b.algo.id }), ctx)), '409:vip-moving');
  assert.equal(await code(p.std.svc.subscribe(w.sign(p.std.svc.executorId, 'subscribe', { settings: canonicalSettings(parseSettings({ leader: { venue: 'sodex', address: LEADER }, paper: true })), termsVersion: COPY_TERMS_VERSION }), ctx)), '409:vip-moving');
  // A cancel is not refused for the move: it waits for it (one instruction of a wallet at a time), then finds the
  // bot handed over (it runs on the VIP side now, where it is stopped).
  const cancel = code(p.std.svc.algoAct(w.sign(p.std.svc.executorId, 'algo-action', { op: 'cancel', id: b.algo.id }), ctx));
  open();
  await until(() => p.std.svc.vipJob(w.address)?.state !== 'running');
  assert.notEqual(await cancel, '409:vip-moving');
  assert.equal(p.std.svc.vipJob(w.address)!.state, 'done');
  await p.cleanup();
  // A job the db still has as running when the executor starts: failed, outcome unknown, the operator told.
  const h = make();
  h.db.saveVipJob({ id: 'aaaaaaaaaaaaaaaa', owner: w.address, state: 'running', startedAt: 1, endedAt: null, steps: [], bots: 1, error: null, session: null } as never);
  await h.svc.start();
  const j = h.svc.vipJob(w.address)!;
  assert.equal(j.state, 'failed');
  assert.equal(j.outcome, 'unknown');
  assert.ok(h.alerts.includes('vip-move-unknown'));
  await h.cleanup();
});

test('A6 VIP import: a null body is a 400; a retry skips what it took in; part-way failure rolls back; under the brake nothing resumes', async () => {
  const w = new Wallet();
  const src = make();
  src.svc.acceptTerms(w.sign(src.svc.executorId, 'accept-terms', TERMS()), ctx);
  const one = (await start(src, w, { ...MM, paper: true })).algo.id;
  const two = (await start(src, w, { ...MM, paper: true, symbol: 'ETH-USD' }, 2)).algo.id;
  await src.svc.algos.pause(one);
  await src.svc.algos.pause(two);
  const rec = (id: string) => JSON.parse(JSON.stringify(src.svc.algos.get(id))) as AlgoRecord;
  const vip = make({ EXECUTOR_TIER: 'vip' });
  assert.equal(await code(vip.svc.vipImport(null)), '400:vip');
  assert.equal(await code(vip.svc.vipImport([])), '400:vip');
  assert.equal(await code(vip.svc.vipImport({ owner: w.address, algos: [] })), '400:vip', 'a job id is needed');
  // Taken in, then the same job again: the same answer, nothing doubled; another job naming a bot still running here: skipped.
  const r1 = await vip.svc.vipImport({ owner: w.address, job: '1111111111111111', key: null, algos: [rec(one)], resume: [one] });
  assert.equal(r1.started, 1);
  const r2 = await vip.svc.vipImport({ owner: w.address, job: '1111111111111111', key: null, algos: [rec(one)], resume: [one] });
  assert.equal(r2.started, 1);
  const r3 = await vip.svc.vipImport({ owner: w.address, job: '2222222222222222', key: null, algos: [rec(one), rec(two)], resume: [one, two] });
  assert.equal(vip.svc.algos.list(w.address).length, 2);
  assert.equal(r3.started, 2);
  // Part-way failure: a bot that has ended here cannot be taken in again - the one adopted before it is handed back.
  const three = (await start(src, w, { ...MM, paper: true, symbol: 'ETH-USD' }, 3)).algo.id;
  await vip.svc.algos.cancel(two);
  const before = vip.svc.algos.list(w.address).length;
  assert.equal(await code(vip.svc.vipImport({ owner: w.address, job: '3333333333333333', key: null, algos: [rec(three), rec(two)], resume: [three, two] })), '409:vip');
  assert.equal(vip.svc.algos.list(w.address).length, before + 1);
  assert.equal(vip.svc.algos.get(three)!.status, 'cancelled', 'rolled back: ended there, nothing resumed');
  assert.equal(vip.db.vipImport('3333333333333333')!.state, 'failed');
  await vip.cleanup();
  // Under the brake: taken in, nothing resumes.
  const dir = mkdtempSync(join(tmpdir(), 'vd-brake-'));
  writeFileSync(join(dir, 'brake.json'), JSON.stringify({ copies: true, algos: true, reason: 'test', cause: 'operator' }));
  const braked = make({ EXECUTOR_TIER: 'vip', EXECUTOR_BRAKE_FILE: join(dir, 'brake.json') });
  const four = (await start(src, w, { ...MM, paper: true, symbol: 'BTC-USD' }, 4)).algo.id;
  await src.svc.algos.pause(four);
  const r = await braked.svc.vipImport({ owner: w.address, job: '4444444444444444', key: null, algos: [rec(four)], resume: [four] });
  assert.deepEqual([r.started, r.held], [0, 1]);
  assert.equal(braked.svc.algos.get(four)!.status, 'paused');
  await braked.cleanup();
  rmSync(dir, { recursive: true, force: true });
  await src.cleanup();
});

/* -------------------------------------------------------------------- C ----- */

test('C: the calendar stopped during a read arms no next read; started again it reads on', async () => {
  let release!: () => void;
  let reads = 0;
  const fetch: FetchLike = async () => {
    reads++;
    await new Promise<void>((r) => (release = r));
    return { status: 200, ok: true, text: async () => JSON.stringify({ events: [] }) };
  };
  const c = new CalendarFeed({ url: 'http://127.0.0.1:9/api/vs/calendar', fetch });
  c.start();
  c.stop();
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((c as unknown as { timer: unknown }).timer, null, 'nothing armed');
  assert.equal(reads, 1);
  c.start();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(reads, 2);
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.notEqual((c as unknown as { timer: unknown }).timer, null, 'armed again');
  c.stop();
});

test('C: wallet caches are bounded (oldest out first)', () => {
  const m = new Map<string, number>();
  for (let i = 0; i < 10; i++) remember(m, `w${i}`, i, 3);
  assert.deepEqual([...m.keys()], ['w7', 'w8', 'w9']);
  remember(m, 'w8', 80, 3);
  assert.deepEqual([...m.keys()], ['w7', 'w9', 'w8'], 'used again: newest');
});

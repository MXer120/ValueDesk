/**
 * Spot bots on the executor (2026-11-19, feature 'spot-bots'): a volume maker or grid on a SoDEX spot market starts
 * only with its key registered on SoDEX spot, the ValueDesk fee approved on spot and the vUSDC to buy with in the spot
 * account; its orders go out on the spot route (POST /api/v1/spot/trade/orders/batch) with the builder.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes, privateKeyToAddress } from '../../../packages/sodex-core/src/index.ts';
import { COPY_TERMS_VERSION, buildCopyRequest, copyRequestDigest, type AlgoRuntime, type CopyAction, type FetchLike, type WebSocketLike } from '../../../packages/copy-engine/src/index.ts';
import { loadConfig } from '../src/config.ts';
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

const SYM = 'vBTC_vUSDC';
const PERPS_ROW = { id: 1, name: 'BTC-USD', baseCoin: 'BTC', tickSize: '1', stepSize: '0.00001', minQuantity: '0.00001', maxQuantity: '1000', minNotional: '10', maxNotional: '5000000', maxLeverage: 50, buyLimitUpRatio: '0.05', sellLimitDownRatio: '0.05', takerFee: '0.0004', makerFee: '0.0001', status: 'TRADING' };
/** As SoDEX lists it (GET /api/v1/spot/markets/symbols, 2026-11-19). */
const SPOT_ROW = { id: 1, name: SYM, baseCoin: 'vBTC', quoteCoin: 'vUSDC', tickSize: '1', stepSize: '0.00001', minQuantity: '0.00001', maxQuantity: '0', marketMaxQuantity: '0', minNotional: '5', maxNotional: '0', buyLimitUpRatio: '1', sellLimitDownRatio: '0.5', makerFee: '0.00035', takerFee: '0.00065', status: 'TRADING' };

interface World {
  keys: { perps: Record<string, unknown[]>; spot: Record<string, unknown[]> };
  builders: { perps: number | null; spot: number | null };
  usdc: number;
  sent: Array<{ method: string; path: string; body: string }>;
}

function fakeFetch(w: World): FetchLike {
  const ok = (data: unknown) => ({ status: 200, ok: true, text: async () => JSON.stringify({ code: 0, timestamp: Date.now(), data }) });
  return async (url, init) => {
    const path = new URL(url).pathname;
    const method = init?.method ?? 'GET';
    if (path === '/api/v1/spot/trade/orders/batch') {
      w.sent.push({ method, path, body: String(init?.body ?? '') });
      const body = JSON.parse(String(init?.body ?? '{}')) as { orders?: Array<{ clOrdID: string }>; cancels?: Array<{ clOrdID: string }> };
      return ok((body.orders ?? body.cancels ?? []).map((o, i) => ({ clOrdID: o.clOrdID, orderID: 100 + i, code: 0 })));
    }
    if (path.startsWith('/api/v1/perps/trade')) {
      w.sent.push({ method, path, body: String(init?.body ?? '') });
      return ok([]);
    }
    if (path.startsWith('/api/vs/builder/beta')) return { status: 200, ok: true, text: async () => JSON.stringify({ ok: true, listed: false }) };
    if (path === '/api/v1/spot/markets/symbols') return ok([SPOT_ROW]);
    if (path === '/api/v1/spot/markets/bookTickers') return ok([{ symbol: SYM, bidPx: '60000', bidSz: '1', askPx: '60002', askSz: '1' }]);
    if (path === '/api/v1/perps/markets/symbols') return ok([PERPS_ROW]);
    if (path === '/api/v1/perps/markets/mark-prices') return ok([{ symbol: 'BTC-USD', markPrice: '60000' }]);
    if (path === '/api/v1/perps/markets/bookTickers') return ok([]);
    const k = /\/api\/v1\/(perps|spot)\/accounts\/(0x[0-9a-f]{40})\/api-keys$/.exec(path);
    if (k) return ok(w.keys[k[1] as 'perps' | 'spot'][k[2]!] ?? []);
    if (/\/api\/v1\/spot\/accounts\/0x[0-9a-f]{40}\/state$/.test(path)) return ok({ aid: 42, B: [{ i: 0, a: 'vUSDC', t: String(w.usdc), l: '0' }, { i: 1, a: 'vBTC', t: '5', l: '0' }] });
    if (/\/api\/v1\/spot\/accounts\/0x[0-9a-f]{40}\/orders/.test(path)) return ok({ orders: [] });
    if (/\/api\/v1\/perps\/accounts\/0x[0-9a-f]{40}\/state$/.test(path)) return ok({ aid: 42, av: '0', am: '0', P: [] });
    if (/\/api\/v1\/perps\/accounts\/0x[0-9a-f]{40}\/fee-rate$/.test(path)) return ok({ makerFeeRate: '0.00012', takerFeeRate: '0.0004' });
    if (/\/api\/v1\/user\/0x[0-9a-f]{40}\/builders$/.test(path)) {
      const row = (r: number | null) => (r === null ? [] : [{ builderID: 234812, feeRate: r }]);
      return ok({ perps: row(w.builders.perps), spot: row(w.builders.spot) });
    }
    if (/\/api\/v1\/user\/0x[0-9a-f]{40}\/subaccounts$/.test(path)) return ok({ primaryAccountID: 42 });
    return { status: 404, ok: false, text: async () => '{"code":404,"message":"not found"}' };
  };
}

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const noWs = (): WebSocketLike => ({ readyState: 0, send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null });
const TERMS = { termsVersion: COPY_TERMS_VERSION, termsHash: `0x${'ab'.repeat(32)}`, country: 'SG', adult: true, notUsPerson: true, ownDecision: true, risksUnderstood: true };
const ctx = { viewerCountry: 'SG' };
const MM = { kind: 'mm', engine: 'spot', symbol: SYM, orderUsd: 20, maxInventoryUsd: 100, maxLossUsd: 50, paper: false };

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof ApiError ? `${e.status}:${e.code}` : `throw:${String(e)}`;
  }
};

test('spot bots: advertised; a real one needs its key on spot, the fee approved on spot and the vUSDC; its orders go out as spot orders', async () => {
  const w = new Wallet();
  const dir = mkdtempSync(join(tmpdir(), 'vd-spot-'));
  const world: World = { keys: { perps: {}, spot: {} }, builders: { perps: 50, spot: null }, usdc: 50, sent: [] };
  const cfg = loadConfig({ EXECUTOR_PRACTICE_BOTS: '1', EXECUTOR_DATA_DIR: dir, EXECUTOR_KIND: 'hosted', EXECUTOR_EDGE: 'none', EXECUTOR_BRAKE_FILE: 'none', EXECUTOR_LIVE_ALGOS_WALLETS: w.address });
  const db = new ExecutorDb(':memory:');
  const svc = new ExecutorService(cfg, db, new Secrets(dir), { fetch: fakeFetch(world), factory: noWs, log: silent, readGapMs: 0 });
  try {
    assert.ok(svc.info(ctx).features?.includes('spot-bots'));
    svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), ctx);
    const k = svc.createKey(w.sign(svc.executorId, 'create-key', { accountId: 42, days: 30 }), ctx);
    const row = { name: k.name, publicKey: k.address, expiresAt: Date.now() + 30 * 86_400_000 };
    world.keys.perps[w.address] = [row];
    assert.equal((await svc.verifyKey(w.address))!.registered, true);
    const start = (seed: number, spec: Record<string, unknown> = MM) => svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec, seed }), ctx);
    // The key is on perps only (as the site registers it today): refused with what to do.
    assert.equal(await code(start(1)), '412:key-spot');
    world.keys.spot[w.address] = [row];
    // Registered on spot; the fee approved on perps only.
    assert.equal(await code(start(2)), '412:builder-spot');
    world.builders.spot = 50;
    // 50 vUSDC cannot hold a $100 inventory and its quotes.
    assert.equal(await code(start(3)), '409:margin');
    world.usdc = 10_000;
    // The wallet's own 5 vBTC are no "position this bot did not open" on spot.
    const v = await start(4);
    assert.equal(v.algo.spec.symbol, SYM);
    assert.equal((v.algo.spec as { engine?: string }).engine, 'spot');
    // One live bot per wallet and spot market.
    assert.equal(await code(start(5)), '409:bot-market');

    // Its first step: a bid on the spot route, with the builder (spot: charged on sells only by SoDEX).
    const rt = (svc as unknown as { algos: AlgoRuntime }).algos;
    (rt.market as unknown as { handle(m: unknown): void }).handle({ channel: 'bookTicker', data: [{ s: SYM, b: '60000', B: '1', a: '60002', A: '1' }] });
    await rt.stepNow(v.algo.id, Date.now());
    for (let i = 0; i < 20 && !world.sent.length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(world.sent.length, 1, 'one signed write');
    const sent = world.sent[0]!;
    assert.equal(sent.method, 'POST');
    assert.equal(sent.path, '/api/v1/spot/trade/orders/batch');
    const body = JSON.parse(sent.body) as { accountID: number; orders: Array<{ symbolID: number; side: number; price: string; reduceOnly?: boolean }>; builder?: { id: number; fee: number } };
    assert.equal(body.accountID, 42);
    assert.deepEqual(body.orders.map((o) => o.symbolID), [1]);
    assert.equal(body.orders.length, 1, 'nothing held: a bid only, no ask');
    assert.equal(body.orders[0]!.reduceOnly, undefined);
    assert.equal(body.builder?.id, 234812);
    assert.ok(!world.sent.some((x) => x.path.startsWith('/api/v1/perps/trade')), 'nothing on perps (no leverage)');
  } finally {
    await svc.stop().catch(() => undefined);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spot bots: a practice spot bot starts without any key; a spot symbol with engine perps is a spec error', async () => {
  const w = new Wallet();
  const dir = mkdtempSync(join(tmpdir(), 'vd-spot-'));
  const world: World = { keys: { perps: {}, spot: {} }, builders: { perps: null, spot: null }, usdc: 0, sent: [] };
  const cfg = loadConfig({ EXECUTOR_PRACTICE_BOTS: '1', EXECUTOR_DATA_DIR: dir, EXECUTOR_KIND: 'hosted', EXECUTOR_EDGE: 'none', EXECUTOR_BRAKE_FILE: 'none' });
  const db = new ExecutorDb(':memory:');
  const svc = new ExecutorService(cfg, db, new Secrets(dir), { fetch: fakeFetch(world), factory: noWs, log: silent, readGapMs: 0 });
  try {
    svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), ctx);
    const start = (seed: number, spec: Record<string, unknown>) => svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec, seed }), ctx);
    const v = await start(1, { ...MM, kind: 'grid', low: 55_000, high: 65_000, levels: 5, paper: true });
    assert.equal((v.algo.spec as { direction?: string }).direction, 'long');
    assert.equal(await code(start(2, { ...MM, engine: 'perps', paper: true })), '400:spec');
  } finally {
    await svc.stop().catch(() => undefined);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

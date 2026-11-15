import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * Bots on the executor (algo kinds 'mm' and 'grid', bot DCAs): the bot fee on their orders and in their
 * approval check, the live gate they share with algos, the one-live-bot-per-market rule, signed updates of
 * their settings.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes, privateKeyToAddress } from '../../../packages/sodex-core/src/index.ts';
import { BETA_VIP_DAYS, BOT_FEE, BOT_FEE_LADDER, BOT_FEE_VIP, COPY_FEE_LADDER, COPY_TERMS_VERSION, buildCopyRequest, copyRequestDigest, type AlgoRecord, type CopyAction, type FetchLike, type WebSocketLike } from '../../../packages/copy-engine/src/index.ts';
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

const BTC_ROW = { id: 1, name: 'BTC-USD', baseCoin: 'BTC', tickSize: '1', stepSize: '0.00001', minQuantity: '0.00001', maxQuantity: '1000', minNotional: '10', maxNotional: '5000000', maxLeverage: 50, buyLimitUpRatio: '0.05', sellLimitDownRatio: '0.05', takerFee: '0.0004', makerFee: '0.0001', status: 'TRADING' };

/** The beta list the fake API server answers /api/vs/builder/beta from (null: it does not answer). */
let BETA: string[] | null = [];
/** Server 1's VALUEDESK_BOTS_OPEN: the answer carries bots: true for every wallet. undefined: an older server (no `bots`). */
let BOTS_OPEN: boolean | undefined;
function fakeFetch(rows: unknown[] = [BTC_ROW], marks: unknown[] = []): FetchLike {
  const ok = (data: unknown) => ({ status: 200, ok: true, text: async () => JSON.stringify({ code: 0, timestamp: Date.now(), data }) });
  return async (url) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path.startsWith('/api/vs/builder/beta')) {
      if (BETA === null) return { status: 503, ok: false, text: async () => '{"ok":false}' };
      const a = new URL(url).searchParams.get('address') ?? '';
      const listed = (BETA ?? []).includes(a);
      return { status: 200, ok: true, text: async () => JSON.stringify(BOTS_OPEN === undefined ? { ok: true, listed } : { ok: true, listed, bots: listed || BOTS_OPEN }) };
    }
    if (path.endsWith('/markets/symbols')) return ok(rows);
    if (path.endsWith('/markets/mark-prices')) return ok(marks);
    if (/\/api\/v1\/perps\/accounts\/0x[0-9a-f]{40}\/api-keys$/.test(path)) return ok([]);
    if (/\/api\/v1\/user\/0x[0-9a-f]{40}\/subaccounts$/.test(path)) return ok({ primaryAccountID: 42 });
    return { status: 404, ok: false, text: async () => '{"code":404,"message":"not found"}' };
  };
}

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const noWs = (): WebSocketLike => ({ readyState: 0, send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null });

function make(env: Record<string, string> = {}, market: { rows?: unknown[]; marks?: unknown[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vd-algo-'));
  const cfg: ExecutorConfig = loadConfig({ EXECUTOR_PRACTICE_BOTS: '1', EXECUTOR_DATA_DIR: dir, EXECUTOR_KIND: 'hosted', EXECUTOR_EDGE: 'none', ...env });
  const db = new ExecutorDb(':memory:');
  const svc = new ExecutorService(cfg, db, new Secrets(dir), { fetch: fakeFetch(market.rows, market.marks), factory: noWs, log: silent });
  return { cfg, db, svc, cleanup: async () => { await svc.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const TERMS = { termsVersion: COPY_TERMS_VERSION, termsHash: `0x${'ab'.repeat(32)}`, country: 'SG', adult: true, notUsPerson: true, ownDecision: true, risksUnderstood: true };
const MM = { kind: 'mm', symbol: 'BTC-USD', orderUsd: 20, maxInventoryUsd: 100, paper: true };
const TWAP = { kind: 'twap', symbol: 'BTC-USD', side: 'buy', quantity: '0.01', durationMs: 600_000, slices: 10, exec: { style: 'taker', slippageBps: 20 }, paper: true };

const code = async (p: Promise<unknown> | (() => unknown)): Promise<string> => {
  try {
    await (typeof p === 'function' ? p() : p);
    return 'ok';
  } catch (e) {
    return e instanceof ApiError ? `${e.status}:${e.code}` : String(e);
  }
};

test('bots: the executor advertises them and their fee ladder; a bot is charged by the bot ladder (0.5 bp with no volume known), every other algo the copy ladder', async () => {
  const { svc, cleanup } = make();
  const ctx = { viewerCountry: 'SG' };
  const info = svc.info(ctx);
  assert.ok(info.features?.includes('bots'));
  assert.deepEqual(info.bots, { fee: BOT_FEE, ladder: BOT_FEE_LADDER, vipFee: BOT_FEE_VIP, betaVipDays: BETA_VIP_DAYS });
  const fee = (spec: Record<string, unknown>) => (svc as unknown as { algoFee(a: Pick<AlgoRecord, 'owner' | 'spec'>): Promise<number> }).algoFee({ owner: '0x' + '1'.repeat(40), spec: spec as never });
  assert.equal(await fee({ kind: 'mm', bot: true }), BOT_FEE_LADDER[0]!.fee);
  assert.equal(await fee({ kind: 'dca', bot: true }), BOT_FEE_LADDER[0]!.fee, 'a bot DCA stored before they left the Bots page keeps the bot fee');
  assert.equal(await fee({ kind: 'dca' }), COPY_FEE_LADDER[0]!.fee, 'a plain DCA stays on the copy ladder');
  assert.equal(await fee({ kind: 'twap' }), COPY_FEE_LADDER[0]!.fee);
  await cleanup();
});

test('bots: a practice bot starts for anyone; a live one only for the wallets real algos are on for', async () => {
  const { svc, cleanup } = make();
  const w = new Wallet();
  const ctx = { viewerCountry: 'SG' };
  svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), ctx);
  const v = await svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: MM, seed: 3 }), ctx);
  assert.equal(v.algo.spec.kind, 'mm');
  assert.equal(v.algo.spec.bot, true);
  assert.ok(v.bot, 'its view carries the bot figures');
  assert.equal(await code(svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: { ...MM, maxLossUsd: 50, paper: false }, seed: 3 }), ctx)), '403:beta');
  // Several practice bots on one market are fine (nothing reaches SoDEX).
  await svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: { kind: 'grid', symbol: 'BTC-USD', low: 50_000, high: 70_000, levels: 10, orderUsd: 20, paper: true }, seed: 4 }), ctx);
  assert.equal(svc.algoList(w.address).length, 2);
  await cleanup();
});

test('bots: a signed update changes a bot\'s sizes and limits, each of its type; never its market or range', async () => {
  const { svc, cleanup } = make();
  const w = new Wallet();
  const ctx = { viewerCountry: 'SG' };
  svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), ctx);
  const x = await svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: MM, seed: 1 }), ctx);
  const up = (patch: unknown) => svc.algoAct(w.sign(svc.executorId, 'algo-action', { op: 'update', id: x.algo.id, patch }), ctx);
  const v = await up({ orderUsd: 30, maxLossUsd: 5, volumeTargetUsd: 10_000, onStop: 'keep', label: 'night shift' });
  const s = v.algos[0]!.algo.spec;
  assert.ok(s.kind === 'mm' && s.orderUsd === 30 && s.maxLossUsd === 5 && s.volumeTargetUsd === 10_000 && s.onStop === 'keep' && s.label === 'night shift');
  assert.equal(await code(up({ orderUsd: '30' })), '400:patch');
  assert.equal(await code(up({ onStop: 'sell' })), '400:patch');
  assert.equal(await code(up({ symbol: 'ETH-USD' })), '400:patch');
  assert.equal(await code(up({ maxInventoryUsd: 10 })), '409:state', 'the spec parser judges the value: under one order');
  const cleared = await up({ maxLossUsd: null });
  assert.equal(cleared.algos[0]!.algo.spec.kind === 'mm' && cleared.algos[0]!.algo.spec.maxLossUsd, null);
  await cleanup();
});

test('bots: delete (archive) takes an ended bot off the list and keeps its record; a running one must be stopped first', async () => {
  const { svc, db, cleanup } = make();
  const w = new Wallet();
  const ctx = { viewerCountry: 'SG' };
  svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), ctx);
  const x = await svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: MM, seed: 1 }), ctx);
  const act = (op: string) => svc.algoAct(w.sign(svc.executorId, 'algo-action', { op, id: x.algo.id }), ctx);
  assert.equal(await code(act('archive')), '409:state');
  await act('cancel');
  await act('archive');
  assert.equal(svc.algoList(w.address).length, 0, 'off the list');
  const kept = await db.algos();
  assert.ok(kept.length === 1 && kept[0]!.k.archived === true, 'kept on record');
  await cleanup();
});

test('bots: real bots only for a listed wallet, on the beta site or the main one (or the live-algo wallets); unreadable list: refused', async () => {
  const { svc, cleanup } = make({ EXECUTOR_BUILDER_URL: 'http://127.0.0.1:9/api/vs/builder/volume', EXECUTOR_BUILDER_TOKEN: 't' });
  const w = new Wallet();
  const other = new Wallet();
  const beta = { viewerCountry: 'SG', channel: 'beta' as const };
  const main = { viewerCountry: 'SG', channel: 'main' as const };
  for (const x of [w, other]) svc.acceptTerms(x.sign(svc.executorId, 'accept-terms', TERMS), main);
  const live = { ...MM, maxLossUsd: 50, paper: false };
  BETA = [w.address];
  // Listed, from beta or from the main site: past the gate - it stops at the key it has not registered yet.
  assert.equal(await code(svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: live, seed: 1 }), beta)), '412:key');
  assert.equal(await code(svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: live, seed: 2 }), main)), '412:key');
  // A wallet that is not listed: refused from either.
  assert.equal(await code(svc.algoStart(other.sign(svc.executorId, 'algo-start', { spec: live, seed: 3 }), beta)), '403:beta');
  assert.equal(await code(svc.algoStart(other.sign(svc.executorId, 'algo-start', { spec: live, seed: 6 }), main)), '403:beta');
  // A live algo that is not a bot is not opened by the beta list.
  assert.equal(await code(svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: { kind: 'twap', symbol: 'BTC-USD', side: 'buy', quantity: '0.01', durationMs: 600_000, slices: 10 }, seed: 4 }), beta)), '403:paper-only');
  await cleanup();
  // The list cannot be read: nobody is listed (fails closed).
  BETA = null;
  const b = make({ EXECUTOR_BUILDER_URL: 'http://127.0.0.1:9/api/vs/builder/volume', EXECUTOR_BUILDER_TOKEN: 't' });
  const z = new Wallet();
  b.svc.acceptTerms(z.sign(b.svc.executorId, 'accept-terms', TERMS), main);
  assert.equal(await code(b.svc.algoStart(z.sign(b.svc.executorId, 'algo-start', { spec: live, seed: 5 }), beta)), '403:beta');
  await b.cleanup();
  BETA = [];
});

test('bots open for everyone (server 1 VALUEDESK_BOTS_OPEN, owner 2026-11-13): an unlisted wallet passes the gate; switched off it is refused again', async () => {
  const { svc, cleanup } = make({ EXECUTOR_BUILDER_URL: 'http://127.0.0.1:9/api/vs/builder/volume', EXECUTOR_BUILDER_TOKEN: 't' });
  const w = new Wallet();
  const main = { viewerCountry: 'SG', channel: 'main' as const };
  svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), main);
  const live = { ...MM, maxLossUsd: 50, paper: false };
  BETA = [];
  BOTS_OPEN = true;
  // Past the gate: it stops at the key it has not registered yet.
  assert.equal(await code(svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: live, seed: 11 }), main)), '412:key');
  await cleanup();
  BOTS_OPEN = false;
  const b = make({ EXECUTOR_BUILDER_URL: 'http://127.0.0.1:9/api/vs/builder/volume', EXECUTOR_BUILDER_TOKEN: 't' });
  const z = new Wallet();
  b.svc.acceptTerms(z.sign(b.svc.executorId, 'accept-terms', TERMS), main);
  assert.equal(await code(b.svc.algoStart(z.sign(b.svc.executorId, 'algo-start', { spec: live, seed: 12 }), main)), '403:beta');
  await b.cleanup();
  BOTS_OPEN = undefined;
});

test('hedge: two wallets each start their own leg of a pair; a wallet cannot pair with itself; the executor advertises it', async () => {
  const { svc, cleanup } = make();
  assert.ok(svc.info({ viewerCountry: 'SG' }).features?.includes('hedge'));
  const a = new Wallet();
  const b = new Wallet();
  const ctx = { viewerCountry: 'SG' };
  for (const w of [a, b]) svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), ctx);
  const HEDGE = { kind: 'hedge', symbol: 'BTC-USD', shape: 'pair', pairId: 'pair-exec-0001', sizeUsd: 1_000, minLiqPct: 3, growLiqPct: 6, sliceUsd: 200, maxSlipBps: 20, marginUsd: 200, leverage: 40, paper: true };
  assert.equal(await code(svc.algoStart(a.sign(svc.executorId, 'algo-start', { spec: { ...HEDGE, side: 'buy', role: 'main', partner: a.address }, seed: 1 }), ctx)), '400:partner');
  const main = await svc.algoStart(a.sign(svc.executorId, 'algo-start', { spec: { ...HEDGE, side: 'buy', role: 'main', partner: b.address }, seed: 1 }), ctx);
  const leg = await svc.algoStart(b.sign(svc.executorId, 'algo-start', { spec: { ...HEDGE, side: 'sell', role: 'partner', partner: a.address }, seed: 2 }), ctx);
  assert.equal(main.algo.spec.kind, 'hedge');
  assert.equal(leg.algo.owner, b.address);
  assert.ok(main.bot?.hedge, 'the view carries the pair');
  // A real two-wallet pair waits for the terms (owner 2026-11-14): refused, whatever else the wallet may do.
  const real = { ...HEDGE, pairId: 'pair-exec-0002', side: 'buy', role: 'main', partner: b.address, maxLossUsd: 50, paper: false };
  assert.equal(await code(svc.algoStart(a.sign(svc.executorId, 'algo-start', { spec: real, seed: 3 }), ctx)), '403:hedge-pair');
  await cleanup();
  // Switched on (EXECUTOR_HEDGE_PAIRS=1): a real leg is then refused off the beta list like every real bot.
  const on = make({ EXECUTOR_HEDGE_PAIRS: '1' });
  on.svc.acceptTerms(a.sign(on.svc.executorId, 'accept-terms', TERMS), ctx);
  assert.equal(await code(on.svc.algoStart(a.sign(on.svc.executorId, 'algo-start', { spec: real, seed: 3 }), ctx)), '403:beta');
  await on.cleanup();
  // The live test's own wallet (EXECUTOR_LIVE_ALGOS_WALLETS) is not held by the pair switch.
  const tester = make({ EXECUTOR_LIVE_ALGOS_WALLETS: a.address });
  tester.svc.acceptTerms(a.sign(tester.svc.executorId, 'accept-terms', TERMS), ctx);
  assert.notEqual(await code(tester.svc.algoStart(a.sign(tester.svc.executorId, 'algo-start', { spec: real, seed: 3 }), ctx)), '403:hedge-pair');
  await tester.cleanup();
});

test('bots: a running grid takes its take-profit and stop prices in place (2026-11-13), and a hedge its size and buffers', async () => {
  const { svc, cleanup } = make();
  const w = new Wallet();
  const ctx = { viewerCountry: 'SG' };
  svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), ctx);
  const g = await svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: { kind: 'grid', symbol: 'BTC-USD', low: 50_000, high: 70_000, levels: 10, orderUsd: 20, paper: true }, seed: 4 }), ctx);
  const up = (id: string, patch: unknown) => svc.algoAct(w.sign(svc.executorId, 'algo-action', { op: 'update', id, patch }), ctx);
  const v = await up(g.algo.id, { takeProfitUsd: 25, upper: { price: 72_000, then: 'stop' }, lower: { price: 48_000, then: 'stop' } });
  const s = v.algos.find((x) => x.algo.id === g.algo.id)!.algo.spec;
  assert.ok(s.kind === 'grid' && s.takeProfitUsd === 25 && s.upper?.price === 72_000 && s.lower?.then === 'stop');
  assert.equal(await code(up(g.algo.id, { upper: { price: 72_000, then: 'rush' } })), '400:patch');
  const h = await svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: { kind: 'hedge', symbol: 'BTC-USD', shape: 'spot', sizeUsd: 1_000, minLiqPct: 3, growLiqPct: 6, sliceUsd: 200, maxSlipBps: 20, marginUsd: 200, paper: true }, seed: 5 }), ctx);
  const hv = await up(h.algo.id, { sizeUsd: 2_000, minLiqPct: 4, growLiqPct: 8 });
  const hs = hv.algos.find((x) => x.algo.id === h.algo.id)!.algo.spec;
  assert.ok(hs.kind === 'hedge' && hs.sizeUsd === 2_000 && hs.minLiqPct === 4);
  assert.equal(await code(up(h.algo.id, { minLiqPct: 9 })), '409:state', 'the buffer must stay under the grow-back buffer');
  await cleanup();
});

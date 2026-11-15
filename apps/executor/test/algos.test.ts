import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes, privateKeyToAddress } from '../../../packages/sodex-core/src/index.ts';
import { COPY_TERMS_VERSION, buildCopyRequest, copyRequestDigest, limitNoticeOf, parseAlgoSpec, parseMarkets, planAlgo, type AlgoFeed, type CopyAction, type FetchLike, type WebSocketLike } from '../../../packages/copy-engine/src/index.ts';
import { liveAlgoWalletsFrom, loadConfig, type ExecutorConfig } from '../src/config.ts';
import { ExecutorDb } from '../src/db.ts';
import { Secrets } from '../src/secrets.ts';
import { createExecutorServer, withoutSeries } from '../src/server.ts';
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

function fakeFetch(rows: unknown[] = [BTC_ROW], marks: unknown[] = []): FetchLike {
  const ok = (data: unknown) => ({ status: 200, ok: true, text: async () => JSON.stringify({ code: 0, timestamp: Date.now(), data }) });
  return async (url) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
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
const TWAP = { kind: 'twap', symbol: 'BTC-USD', side: 'buy', quantity: '0.01', durationMs: 600_000, slices: 10, exec: { style: 'taker', slippageBps: 20 }, paper: true };

const code = async (p: Promise<unknown> | (() => unknown)): Promise<string> => {
  try {
    await (typeof p === 'function' ? p() : p);
    return 'ok';
  } catch (e) {
    return e instanceof ApiError ? `${e.status}:${e.code}` : String(e);
  }
};

test('algos: a signed start runs the spec it names, kept as the wallet signed it; terms, spec and seed are checked', async () => {
  const { svc, db, cleanup } = make();
  const w = new Wallet();
  const ctx = { viewerCountry: 'SG' };
  assert.equal(await code(svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: TWAP, seed: 7 }), ctx)), '412:terms');
  svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), ctx);
  assert.equal(await code(svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: { ...TWAP, slices: 0 }, seed: 7 }), ctx)), '400:spec');
  assert.equal(await code(svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: TWAP, seed: -1 }), ctx)), '400:seed');
  assert.equal(await code(svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: { ...TWAP, symbol: 'NOPE-USD' }, seed: 7 }), ctx)), '400:algo');
  // A live one is refused while real algo orders are off.
  assert.equal(await code(svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: { ...TWAP, paper: false }, seed: 7 }), ctx)), '403:paper-only');
  const v = await svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: TWAP, seed: 7 }), ctx);
  assert.equal(v.algo.owner, w.address);
  assert.equal(v.algo.seed, 7);
  assert.equal(v.algo.spec.kind, 'twap');
  assert.equal(v.algo.consent?.action, 'algo-start');
  assert.match(v.algo.consent!.payload, /"slices":10/);
  assert.equal(svc.algoList(w.address).length, 1);
  assert.ok(db.consents(w.address).some((c) => c.action === 'algo-start'));
  const events = await svc.algoEvents(w.address, v.algo.id, {});
  assert.ok(events.length >= 1);
  await cleanup();
});

test('algos: only the wallet that started one can act on it; cancel-all is its kill switch', async () => {
  const { svc, cleanup } = make();
  const a = new Wallet();
  const b = new Wallet();
  const ctx = { viewerCountry: 'SG' };
  svc.acceptTerms(a.sign(svc.executorId, 'accept-terms', TERMS), ctx);
  svc.acceptTerms(b.sign(svc.executorId, 'accept-terms', TERMS), ctx);
  const x = await svc.algoStart(a.sign(svc.executorId, 'algo-start', { spec: TWAP, seed: 1 }), ctx);
  const y = await svc.algoStart(a.sign(svc.executorId, 'algo-start', { spec: { ...TWAP, kind: 'chase', side: 'sell' }, seed: 2 }), ctx);
  assert.equal(await code(svc.algoAct(b.sign(svc.executorId, 'algo-action', { op: 'cancel', id: x.algo.id }), ctx)), '404:algo');
  assert.equal(await code(() => svc.algoEvents(b.address, x.algo.id, {})), '404:algo');
  const paused = await svc.algoAct(a.sign(svc.executorId, 'algo-action', { op: 'pause', id: x.algo.id }), ctx);
  assert.equal(paused.algos[0]!.algo.status, 'paused');
  const resumed = await svc.algoAct(a.sign(svc.executorId, 'algo-action', { op: 'resume', id: x.algo.id }), ctx);
  assert.equal(resumed.algos[0]!.algo.status, 'scheduled');
  const all = await svc.algoAct(a.sign(svc.executorId, 'algo-action', { op: 'cancel-all' }), ctx);
  assert.deepEqual(all.algos.map((v) => v.algo.status).sort(), ['cancelled', 'cancelled']);
  assert.ok(all.algos.some((v) => v.algo.id === y.algo.id));
  // An instruction is used once.
  const req = a.sign(svc.executorId, 'algo-action', { op: 'cancel-all' });
  await svc.algoAct(req, ctx);
  assert.equal(await code(svc.algoAct(req, ctx)), '409:replay');
  await cleanup();
});

test('algos: at most EXECUTOR_MAX_ALGOS live per wallet; a closed executor takes none', async () => {
  const { svc, cleanup } = make({ EXECUTOR_MAX_ALGOS: '2' });
  const w = new Wallet();
  const ctx = { viewerCountry: 'SG' };
  svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), ctx);
  await svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: TWAP, seed: 1 }), ctx);
  await svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: TWAP, seed: 2 }), ctx);
  assert.equal(await code(svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: TWAP, seed: 3 }), ctx)), '429:limit');
  assert.equal(svc.info({ viewerCountry: null }).algos?.maxPerOwner, 2);
  await cleanup();
  const closed = make({ EXECUTOR_OPEN: '0' });
  const v = new Wallet();
  assert.equal(await code(closed.svc.algoStart(v.sign(closed.svc.executorId, 'algo-start', { spec: TWAP, seed: 1 }), ctx)), '503:closed');
  await closed.cleanup();
});

test('HTTP: POST /algos with a signed request, GET /algos and its events with the session', async () => {
  const { svc, cfg, cleanup } = make();
  const server = createExecutorServer(svc, cfg, silent);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/copy/v1`;
  const w = new Wallet();
  const post = (path: string, request: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request }) });
  assert.equal((await post('/terms', w.sign(svc.executorId, 'accept-terms', TERMS))).status, 200);
  const { token } = (await (await post('/session', w.sign(svc.executorId, 'session', {}))).json()) as { token: string };
  const started = await post('/algos', w.sign(svc.executorId, 'algo-start', { spec: TWAP, seed: 9 }));
  assert.equal(started.status, 200);
  const view = (await started.json()) as { algo: { id: string } };
  const list = (await (await fetch(`${base}/algos`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { algos: Array<{ algo: { id: string } }> };
  assert.deepEqual(list.algos.map((v) => v.algo.id), [view.algo.id]);
  const thin = (await (await fetch(`${base}/algos?series=0`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { algos: Array<{ algo: { id: string } }>; noSeries?: boolean };
  assert.deepEqual(thin.algos.map((v) => v.algo.id), [view.algo.id]);
  assert.equal(thin.noSeries, true);
  const ev = await fetch(`${base}/algos/${view.algo.id}/events`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(ev.status, 200);
  assert.equal((await fetch(`${base}/algos`)).status, 401);
  const act = await post('/algos/action', w.sign(svc.executorId, 'algo-action', { op: 'cancel', id: view.algo.id }));
  assert.equal(act.status, 200);
  server.close();
  await cleanup();
});

test('end to end, in paper: a signed TWAP with exits runs on the executor against the market it sees, fills, ends, keeps its exits, and survives a restart', async () => {
  const realNow = Date.now;
  let clock = Date.now();
  Date.now = () => clock;
  const dir = mkdtempSync(join(tmpdir(), 'vd-algo-e2e-'));
  const cfg = loadConfig({ EXECUTOR_PRACTICE_BOTS: '1', EXECUTOR_DATA_DIR: dir, EXECUTOR_KIND: 'hosted', EXECUTOR_EDGE: 'none' });
  const path = join(dir, 'executor.db');
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 3));
    }
  };
  try {
    const db = new ExecutorDb(path);
    const svc = new ExecutorService(cfg, db, new Secrets(dir), { fetch: fakeFetch(), factory: noWs, log: silent });
    const w = new Wallet();
    const ctx = { viewerCountry: 'SG' };
    svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), ctx);
    const spec = { kind: 'twap', symbol: 'BTC-USD', side: 'buy', quantity: '0.004', durationMs: 120_000, slices: 2, exec: { style: 'taker', slippageBps: 20 }, exits: { tpPct: 0.02, slPct: 0.01 }, paper: true };
    const v = await svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec, seed: 5 }), ctx);
    const id = v.algo.id;
    // What the executor's socket would bring: the book and the mark.
    const feed = svc.algos.market as AlgoFeed;
    const book = (bid: number, ask: number) => {
      feed.handle({ channel: 'bookTicker', data: [{ s: 'BTC-USD', b: String(bid), a: String(ask) }] });
      feed.handle({ channel: 'allMarkPrice', data: [{ s: 'BTC-USD', p: String((bid + ask) / 2) }] });
    };
    book(60_000, 60_010);
    await svc.algos.stepNow(id, clock);
    await settle();
    assert.equal(svc.algos.get(id)!.filled, 0.002, 'the first slice took at the ask');
    clock += 61_000;
    book(60_100, 60_110);
    await svc.algos.stepNow(id, clock);
    await settle();
    clock += 60_000;
    book(60_100, 60_110);
    await svc.algos.stepNow(id, clock);
    await settle();
    const done = svc.algos.get(id)!;
    assert.equal(done.status, 'done');
    assert.equal(done.filled, 0.004);
    const exits = done.exitOrders!.filter((x) => x.state === 'open');
    assert.deepEqual(exits.map((x) => x.exit).sort(), ['sl', 'tp']);
    assert.ok(exits.every((x) => x.quantity === 0.004 && x.side === 'sell'));
    const events = await svc.algoEvents(w.address, id, {});
    assert.ok(events.some((e) => /Exits for 0.004/.test(e.text)));
    await svc.stop();
    db.close();
    // A restart reads the books back from SQLite, exits and all.
    const db2 = new ExecutorDb(path);
    const svc2 = new ExecutorService(cfg, db2, new Secrets(dir), { fetch: fakeFetch(), factory: noWs, log: silent });
    await svc2.algos.start();
    const back = svc2.algos.get(id)!;
    assert.equal(back.status, 'done');
    assert.equal(back.exitOrders!.filter((x) => x.state === 'open').length, 2);
    // The mark falls through the stop-loss: it fills (paper) and the take-profit is cancelled.
    const feed2 = svc2.algos.market as AlgoFeed;
    feed2.handle({ channel: 'allMarkPrice', data: [{ s: 'BTC-USD', p: '59000' }] });
    svc2.algos.tick(clock);
    await settle();
    const after = svc2.algos.get(id)!;
    // The latest pair (the first one, for 0.002, was replaced when the TWAP finished).
    assert.equal(after.exitOrders!.filter((x) => x.exit === 'sl').at(-1)!.filled, 0.004);
    assert.equal(after.exitOrders!.filter((x) => x.exit === 'tp').at(-1)!.state, 'done');
    assert.equal(after.exitOrders!.filter((x) => x.exit === 'tp').at(-1)!.filled, 0);
    await svc2.stop();
    db2.close();
  } finally {
    Date.now = realNow;
    // Windows may still hold SQLite's WAL files for a moment: a temp folder left behind is not a failure.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* left for the OS to clean */
    }
  }
});

test('algos: a signed update changes a running algo\'s size (and only what may change); another wallet cannot', async () => {
  const { svc, cleanup } = make();
  const a = new Wallet();
  const b = new Wallet();
  const ctx = { viewerCountry: 'SG' };
  svc.acceptTerms(a.sign(svc.executorId, 'accept-terms', TERMS), ctx);
  svc.acceptTerms(b.sign(svc.executorId, 'accept-terms', TERMS), ctx);
  assert.ok(svc.info(ctx).features?.includes('algo-update'));
  const x = await svc.algoStart(a.sign(svc.executorId, 'algo-start', { spec: TWAP, seed: 1 }), ctx);
  const up = (w: Wallet, patch: unknown) => svc.algoAct(w.sign(svc.executorId, 'algo-action', { op: 'update', id: x.algo.id, patch }), ctx);
  const v = await up(a, { quantity: '0.02' });
  assert.equal(v.algos[0]!.algo.spec.kind === 'twap' && v.algos[0]!.algo.spec.quantity, '0.02');
  assert.equal(await code(up(b, { quantity: '0.03' })), '404:algo');
  // Only the fields a running algo may change, each of its own type.
  assert.equal(await code(up(a, { side: 'sell' })), '400:patch');
  assert.equal(await code(up(a, { paper: false })), '400:patch');
  assert.equal(await code(up(a, { quantity: 0.03 })), '400:patch');
  assert.equal(await code(up(a, { quantity: '-1' })), '400:patch');
  assert.equal(await code(up(a, {})), '400:patch');
  assert.equal(await code(up(a, null)), '400:patch');
  assert.equal(await code(up(a, { limitPrice: 'x' })), '400:patch');
  const lim = await up(a, { limitPrice: 120_000 });
  assert.equal(lim.algos[0]!.algo.spec.limitPrice, 120_000);
  // The signed instruction is kept as the wallet's record.
  assert.ok(svc.consents(a.address).some((c) => c.action === 'algo-action' && /"op":"update"/.test(c.payload)));
  // An ended algo cannot change.
  await svc.algoAct(a.sign(svc.executorId, 'algo-action', { op: 'cancel', id: x.algo.id }), ctx);
  assert.equal(await code(up(a, { quantity: '0.05' })), '409:state');
  await cleanup();
});

test('algos: SoDEX\'s limits are checked at the start, on the server - the position limit at the leverage and the limit band refuse it', async () => {
  // BTC-USD's tiers as SoDEX lists them, and its mark and open interest from the REST mark prices (the feed is not up).
  const row = { ...BTC_ROW, initLeverage: 20, openInterestCap: '2000000', openInterestCapUSD: '200000000', marginTiers: [{ maxNotionalValue: '4000000', maintenanceMarginRate: '0.0125', maxLeverage: 40, maintenanceDeduction: '0' }, { maxNotionalValue: '100000000', maintenanceMarginRate: '0.02', maxLeverage: 25, maintenanceDeduction: '30000' }] };
  const { svc, cleanup } = make({}, { rows: [row], marks: [{ symbol: 'BTC-USD', markPrice: '60000', indexPrice: '60000', openInterest: '3000', fundingRate: '0' }] });
  const w = new Wallet();
  const ctx = { viewerCountry: 'SG' };
  svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), ctx);
  const start = (spec: Record<string, unknown>, seed: number) => svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: { ...TWAP, ...spec }, seed }), ctx);
  // 70 BTC at 40x is $4.2M, over the $4M tier.
  await assert.rejects(start({ quantity: '70', leverage: 40 }, 1), (e: unknown) => e instanceof ApiError && e.status === 400 && /over SoDEX's limit of \$4M at 40x\. At most about \$4M \(66\.67 BTC\) can be bought under it\. Use a smaller size or lower leverage\./.test(e.message));
  // At 25x the tier is $100M: it starts.
  const ok = await start({ quantity: '70', leverage: 25 }, 2);
  assert.equal(ok.algo.status, 'scheduled');
  // A limit entry 10% over the mark: SoDEX refuses a limit buy past 5%.
  await assert.rejects(start({ kind: 'bracket', entry: 'limit', price: 66_000, quantity: '0.01', exits: { tpPct: 0.02, slPct: 0.01 }, durationMs: undefined, slices: undefined, exec: undefined }, 3), (e: unknown) => e instanceof ApiError && e.status === 400 && /priced too far from the price: SoDEX refuses a limit buy more than 5% over the mark/.test(e.message));
  await cleanup();
});

test('algos: the executor refuses slices SoDEX would refuse, in the ticket\'s words - never merged into fewer orders or split into more', async () => {
  const { svc, cleanup } = make({}, { marks: [{ symbol: 'BTC-USD', markPrice: '60000', indexPrice: '60000', openInterest: '3000', fundingRate: '0' }] });
  const w = new Wallet();
  const ctx = { viewerCountry: 'SG' };
  svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), ctx);
  const start = (spec: Record<string, unknown>, seed: number) => svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: { ...TWAP, ...spec }, seed }), ctx);
  // The ticket's plan of the same spec, at the same price and seed: the executor's reason is word for word the same.
  const spec = { quantity: '0.00124', slices: 12 };
  const [m] = parseMarkets([BTC_ROW]);
  const plan = planAlgo(parseAlgoSpec({ ...TWAP, ...spec }), m!, { now: Date.now(), price: 60_000, seed: 5 });
  assert.match(plan.errors[0]!, /^Each of the 12 slices would be about \$6\.20, under SoDEX's \$10 minimum\. Use at most 7 slices/);
  await assert.rejects(start(spec, 5), (e: unknown) => e instanceof ApiError && e.status === 400 && e.code === 'algo' && e.message === plan.errors.join(' '));
  // Over SoDEX's $5M per order: refused, not split.
  await assert.rejects(start({ quantity: '200', slices: 2 }, 6), (e: unknown) => e instanceof ApiError && e.status === 400 && /^Each slice would be about \$6M, over SoDEX's \$5M per order on BTC-USD\. Use at least 3 slices\.$/.test(e.message));
  // A swarm's clips and a DCA ladder's levels the same.
  await assert.rejects(start({ kind: 'swarm', quantity: '0.004', clips: 200, inFlight: 20, waveMs: 0, slippageBps: 20, durationMs: undefined, slices: undefined, exec: undefined }, 7), /Each of the 200 clips would be about \$1\.20, under SoDEX's \$10 minimum/);
  await assert.rejects(start({ kind: 'scale', quantity: '0.01', from: 59_000, to: 58_000, orders: 3, prices: [59_000, 58_000.2, 58_000.4], label: 'DCA', durationMs: undefined, slices: undefined, exec: undefined }, 8), /Orders 2 and 3 both land on 58000/);
  assert.equal(svc.algoList(w.address).length, 0);
  // What it names as the fix starts.
  assert.equal((await start({ quantity: '0.00124', slices: 7 }, 9)).algo.status, 'scheduled');
  await cleanup();
});

test('algos: at the open-interest cap an executor algo holds, and the notice with the room left reaches the wallet\'s algo list', async () => {
  const row = { ...BTC_ROW, openInterestCap: '1000.5', openInterestCapUSD: '0' };
  const { svc, cleanup } = make({}, { rows: [row] });
  const w = new Wallet();
  const ctx = { viewerCountry: 'SG' };
  svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), ctx);
  const feed = svc.algos.market as AlgoFeed;
  const quote = (oi: number) => {
    feed.handle({ channel: 'bookTicker', data: [{ s: 'BTC-USD', b: '60000', a: '60010' }] });
    feed.handle({ channel: 'allMarkPrice', data: [{ s: 'BTC-USD', p: '60005', oi: String(oi) }] });
  };
  quote(1000.5);
  const v = await svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: { ...TWAP, quantity: '0.004', slices: 2, durationMs: 120_000 }, seed: 1 }), ctx);
  await svc.algos.stepNow(v.algo.id, Date.now());
  const [row0] = svc.algoList(w.address);
  assert.equal(row0!.algo.status, 'waiting');
  assert.equal(row0!.algo.statusReason, "Held: Open interest on BTC-USD is at SoDEX's cap: nothing can be added market-wide until it drops. Nothing goes out until there is room.");
  // What GET /algos sends the browser carries the notice; the bell shows it once (by its id).
  const n = limitNoticeOf(row0!.algo)!;
  assert.deepEqual([n.kind, n.what, n.title], ['oi', 'held', 'TWAP on BTC-USD is held']);
  // Room again: it goes on.
  quote(900);
  await svc.algos.stepNow(v.algo.id, Date.now());
  assert.notEqual(svc.algoList(w.address)[0]!.algo.status, 'waiting');
  await cleanup();
});

test('algos: EXECUTOR_LIVE_ALGOS_WALLETS lets real algo orders start for the wallets it names only; * for every wallet; EXECUTOR_LIVE_ALGOS=1 still for everyone', async () => {
  const listed = new Wallet();
  const other = new Wallet();
  const ctx = { viewerCountry: 'SG' };
  const live = { ...TWAP, paper: false };
  // A real start that passes the gate goes on to the key check: no key is registered here, so 412 key.
  const starts = async (env: Record<string, string>) => {
    const { svc, cleanup } = make(env);
    const out: string[] = [];
    for (const w of [listed, other]) {
      svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), ctx);
      out.push(await code(svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: live, seed: 1 }), ctx)));
    }
    await cleanup();
    return out;
  };
  assert.deepEqual(await starts({}), ['403:paper-only', '403:paper-only'], 'unset: nobody');
  assert.deepEqual(await starts({ EXECUTOR_LIVE_ALGOS_WALLETS: ` ${listed.address.toUpperCase().replace('0X', '0x')} ` }), ['412:key', '403:paper-only'], 'the listed wallet only (any case, spaces trimmed)');
  assert.deepEqual(await starts({ EXECUTOR_LIVE_ALGOS_WALLETS: '*' }), ['412:key', '412:key']);
  assert.deepEqual(await starts({ EXECUTOR_LIVE_ALGOS: '1' }), ['412:key', '412:key']);
  assert.deepEqual(await starts({ EXECUTOR_LIVE_ALGOS: '1', EXECUTOR_LIVE_ALGOS_WALLETS: listed.address }), ['412:key', '412:key'], 'EXECUTOR_LIVE_ALGOS=1 is everyone, whatever the list says');
  // A conditional's own algo counts too: a paper conditional that would start a real algo is refused for a wallet not listed.
  const { svc, cleanup } = make({ EXECUTOR_LIVE_ALGOS_WALLETS: listed.address });
  svc.acceptTerms(other.sign(svc.executorId, 'accept-terms', TERMS), ctx);
  const cond = { kind: 'conditional', symbol: 'BTC-USD', side: 'buy', conditions: [{ type: 'price', symbol: 'BTC-USD', source: 'mark', op: 'above', value: '1' }], then: { type: 'algo', algo: { ...TWAP, paper: false } }, paper: true };
  assert.equal(await code(svc.algoStart(other.sign(svc.executorId, 'algo-start', { spec: cond, seed: 1 }), ctx)), '403:paper-only');
  assert.equal(await code(svc.algoStart(other.sign(svc.executorId, 'algo-start', { spec: TWAP, seed: 2 }), ctx)), 'ok', 'practice runs always can');
  await cleanup();
  assert.deepEqual(liveAlgoWalletsFrom(undefined), []);
  assert.deepEqual(liveAlgoWalletsFrom(` ${listed.address}, ,${other.address.toUpperCase().replace('0X', '0x')}`), [listed.address, other.address]);
  assert.throws(() => loadConfig({ EXECUTOR_LIVE_ALGOS_WALLETS: `${listed.address},0x123`, EXECUTOR_DATA_DIR: tmpdir() }), /not a wallet address/);
});

test('GET /algos?series=0: a bot keeps its figures and loses only the series; the list itself is not touched', () => {
  const bot = { algo: { id: 'b', book: { fills: 3, series: [[1, 2, 3, 4]] } } };
  const twap = { algo: { id: 't' } };
  const [a, b] = withoutSeries<{ algo: { id: string; book?: { fills?: number; series: unknown[] } } }>([bot, twap]);
  assert.deepEqual(a!.algo.book, { fills: 3, series: [] });
  assert.equal(b, twap);
  assert.equal(bot.algo.book.series.length, 1);
});

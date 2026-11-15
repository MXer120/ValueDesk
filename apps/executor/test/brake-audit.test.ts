import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes, privateKeyToAddress } from '../../../packages/sodex-core/src/index.ts';
import { COPY_TERMS_VERSION, buildCopyRequest, copyRequestDigest, type CopyAction, type FetchLike, type MarketInfo, type OrderSink, type WebSocketLike } from '../../../packages/copy-engine/src/index.ts';
import { Alerts } from '../src/alerts.ts';
import { auditedOrderSink } from '../src/audited.ts';
import { Brake, parseBrake } from '../src/brake.ts';
import { loadConfig } from '../src/config.ts';
import { ExecutorDb } from '../src/db.ts';
import { Secrets } from '../src/secrets.ts';
import { ipPrefix } from '../src/server.ts';
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
function fakeFetch(): FetchLike {
  const ok = (data: unknown) => ({ status: 200, ok: true, text: async () => JSON.stringify({ code: 0, timestamp: Date.now(), data }) });
  return async (url) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path.endsWith('/markets/symbols')) return ok([BTC_ROW]);
    if (path.endsWith('/markets/mark-prices')) return ok([]);
    return { status: 404, ok: false, text: async () => '{"code":404,"message":"not found"}' };
  };
}
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const noWs = (): WebSocketLike => ({ readyState: 0, send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null });
const TERMS = { termsVersion: COPY_TERMS_VERSION, termsHash: `0x${'ab'.repeat(32)}`, country: 'SG', adult: true, notUsPerson: true, ownDecision: true, risksUnderstood: true };
const TWAP = { kind: 'twap', symbol: 'BTC-USD', side: 'buy', quantity: '0.01', durationMs: 600_000, slices: 10, exec: { style: 'taker', slippageBps: 20 } };
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof ApiError ? `${e.status}:${e.code}` : String(e);
  }
};

test('brake file: missing or both off is off; anything else - a typo, garbage, "yes" - is on', () => {
  assert.equal(parseBrake('{"copies": false, "algos": false}'), null);
  assert.deepEqual(parseBrake('{"copies": true, "algos": false, "reason": "x", "since": 5}'), { copies: true, algos: false, reason: 'x', since: 5, cause: 'operator' });
  assert.equal(parseBrake('{"copies": true, "cause": "maintenance"}')?.cause, 'maintenance');
  assert.equal(parseBrake('{"copies": true, "cause": "maint"}')?.cause, 'operator', 'only the exact word is planned work');
  const garbled = parseBrake('{"copies": tru');
  assert.ok(garbled && garbled.copies && garbled.algos);
  assert.equal(garbled.cause, 'operator', 'a garbled file is an emergency stop');
  const yes = parseBrake('{"copies": "yes", "algos": false}');
  assert.ok(yes?.copies && !yes.algos);
  assert.ok(parseBrake('[]')?.copies);
  assert.match(parseBrake('{}')!.reason, /paused/);
  const dir = mkdtempSync(join(tmpdir(), 'vd-brake-'));
  const file = join(dir, 'brake.json');
  const seen: unknown[] = [];
  const b = new Brake(file, (now) => seen.push(now));
  assert.equal(b.current(), null);
  writeFileSync(file, '{"copies": true, "algos": true, "reason": "Investigating."}');
  assert.equal(b.copies(Date.now() + 2_000), 'Investigating.');
  rmSync(file);
  assert.equal(b.algos(Date.now() + 4_000), null);
  assert.equal(seen.length, 2, 'told when it went on and off');
  assert.equal(new Brake(null).current(), null);
  rmSync(dir, { recursive: true, force: true });
});

test('brake on the executor: new live copies, algos, resumes and size changes are refused; paper and stopping still go; info and health say so; the audit log has it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vd-brake-svc-'));
  const file = join(dir, 'brake.json');
  const cfg = loadConfig({ EXECUTOR_PRACTICE_BOTS: '1', EXECUTOR_DATA_DIR: dir, EXECUTOR_KIND: 'hosted', EXECUTOR_EDGE: 'none', EXECUTOR_LIVE_ALGOS: '1', EXECUTOR_BRAKE_FILE: file });
  const db = new ExecutorDb(':memory:');
  const svc = new ExecutorService(cfg, db, new Secrets(dir), { fetch: fakeFetch(), factory: noWs, log: silent });
  const w = new Wallet();
  const ctx = { viewerCountry: 'SG' };
  svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), ctx);
  const paper = await svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: { ...TWAP, paper: true }, seed: 1 }), ctx);
  writeFileSync(file, JSON.stringify({ copies: true, algos: true, reason: 'Investigating a fill problem.', since: 1 }));
  svc.brake.current(Date.now() + 2_000);
  assert.equal(await code(svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: TWAP, seed: 2 }), ctx)), '503:brake');
  assert.equal(await code(svc.algoStart(w.sign(svc.executorId, 'algo-start', { spec: { ...TWAP, paper: true }, seed: 3 }), ctx)), 'ok', 'paper still starts');
  const leader = { venue: 'sodex', address: `0x${'11'.repeat(20)}` };
  assert.equal(await code(svc.subscribe(w.sign(svc.executorId, 'subscribe', { termsVersion: COPY_TERMS_VERSION, settings: { leader, sizingMode: 'fixedNotional', fixedNotionalUsd: 50 } }), ctx)), '503:brake');
  const info = svc.info(ctx);
  assert.deepEqual(info.brake, { copies: true, algos: true, reason: 'Investigating a fill problem.', since: 1 });
  assert.equal(svc.health().brake?.reason, 'Investigating a fill problem.');
  // Stopping always goes through.
  assert.equal(await code(svc.algoAct(w.sign(svc.executorId, 'algo-action', { op: 'cancel', id: paper.algo.id }), ctx)), 'ok');
  assert.ok(db.auditRows({ kind: 'brake' }).length >= 1);
  await svc.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('brake alerts: an operator brake is told on Telegram (on and off); a maintenance brake only in the audit log', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vd-brake-tg-'));
  const file = join(dir, 'brake.json');
  const cfg = loadConfig({ EXECUTOR_PRACTICE_BOTS: '1', EXECUTOR_DATA_DIR: dir, EXECUTOR_KIND: 'hosted', EXECUTOR_EDGE: 'none', EXECUTOR_BRAKE_FILE: file });
  const db = new ExecutorDb(':memory:');
  const alerts = new Alerts({ sender: async () => true, label: 'test executor', dedupeMs: 0 });
  // Already on at start (ship.sh: the new process comes up under the brake): no alert for planned work.
  writeFileSync(file, JSON.stringify({ copies: true, algos: true, reason: 'Updating the copy executor.', since: 1, cause: 'maintenance' }));
  const svc = new ExecutorService(cfg, db, new Secrets(dir), { fetch: fakeFetch(), factory: noWs, log: silent, alerts });
  let t = Date.now();
  const tick = () => svc.brake.current((t += 2_000));
  rmSync(file);
  tick();
  assert.deepEqual(alerts.sent, [], 'planned work: neither on nor off is an alert');
  writeFileSync(file, JSON.stringify({ copies: true, algos: true, reason: 'Investigating a fill problem.', since: 2 }));
  tick();
  rmSync(file);
  tick();
  assert.equal(alerts.sent.length, 2);
  assert.match(alerts.sent[0]!, /^🛑 BRAKE · BRAKE ON - test executor\nCopies held, algos held\. Reason: Investigating a fill problem\.$/);
  assert.match(alerts.sent[1]!, /^✅ RECOVERED · Brake off - test executor\n/);
  assert.ok(db.auditRows({ kind: 'brake' }).length >= 4, 'the audit log has every change, planned or not');
  await svc.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('audit log: append-only, hash-chained - a changed or removed row breaks the chain', () => {
  const db = new ExecutorDb(':memory:');
  db.audit('request', '0xAB', '/copies', { status: 200 });
  db.audit('order', '0xab', 'sub1', { step: 'send' });
  db.audit('order', '0xab', 'sub1', { step: 'answer' });
  const v = db.verifyAudit();
  assert.deepEqual({ rows: v.rows, brokenAt: v.brokenAt }, { rows: 3, brokenAt: null });
  // The hourly check walks only what came after a verified head.
  db.audit('order', '0xab', 'sub1', { step: 'later' });
  assert.deepEqual({ ...db.verifyAudit(v.head!), head: null }, { rows: 1, brokenAt: null, head: null });
  const rows = db.auditRows({ owner: '0xab' });
  assert.equal(rows.length, 4);
  assert.equal(rows[0]!.seq, 4, 'newest first');
  db.db.prepare(`UPDATE audit SET data = '{"step":"forged"}' WHERE seq = 2`).run();
  assert.equal(db.verifyAudit().brokenAt, 2);
  db.close();
  const db2 = new ExecutorDb(':memory:');
  for (let i = 0; i < 4; i++) db2.audit('x', null, null, { i });
  db2.db.prepare('DELETE FROM audit WHERE seq = 2').run();
  assert.equal(db2.verifyAudit().brokenAt, 3);
  db2.close();
});

test("audited sink: every order is written before it leaves and with SoDEX's answer, refusals and throws too", async () => {
  const db = new ExecutorDb(':memory:');
  const m = { name: 'BTC-USD' } as MarketInfo;
  let fail = false;
  const inner: OrderSink = {
    paper: false,
    async place(_a, _m, intents) {
      if (fail) throw new Error('gateway down');
      return intents.map((i) => ({ clOrdID: i.clOrdID, ok: false, orderId: null, error: 'refused: margin', outcomeUnknown: false }));
    },
    async setLeverage() {},
    async placeStop(_a, _m, st) {
      return { clOrdID: st.clOrdID, ok: true, orderId: '9', error: null, outcomeUnknown: false };
    },
    async cancel() {},
  };
  const sink = auditedOrderSink(inner, db, '0xab', 'sub1');
  const intent = { symbol: 'BTC-USD', side: 'buy', quantity: '0.001', limitPrice: '80000', reduceOnly: false, leg: 'open', notionalUsd: 80, clampedBy: null, clOrdID: 'vdc-1' };
  await sink.place(1, m, [intent as never], { id: 9, fee: 25 } as never, 80_000);
  fail = true;
  await assert.rejects(sink.place(1, m, [intent as never], null, 80_000));
  const rows = db.auditRows({ ref: 'sub1' }).reverse().map((r) => JSON.parse(r.data) as { step: string; results?: Array<{ error: string }> });
  assert.deepEqual(rows.map((r) => r.step), ['send', 'answer', 'send', 'error']);
  assert.equal(rows[1]!.results![0]!.error, 'refused: margin');
  assert.ok(!db.auditRows().some((r) => /signature|privateKey|token/i.test(r.data)));
  db.close();
});

test('the audit keeps where a request came from as its network only', () => {
  assert.equal(ipPrefix('203.0.113.77'), '203.0.113.0/24');
  assert.equal(ipPrefix('::ffff:198.51.100.9'), '198.51.100.0/24');
  assert.equal(ipPrefix('2001:db8:85a3:8d3:1319:8a2e:370:7348'), '2001:db8:85a3::/48');
});

test('a release\'s brake lapses when it outlives any release; an operator\'s never does', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Brake, MAINTENANCE_BRAKE_MAX_MS } = await import('../src/brake.ts');
  const dir = mkdtempSync(join(tmpdir(), 'vs-brake-'));
  const file = join(dir, 'brake.json');
  const t = 1_800_000_000_000;
  writeFileSync(file, JSON.stringify({ copies: true, algos: true, reason: 'Updating', since: t, cause: 'maintenance' }));
  const seen: Array<boolean> = [];
  const b = new Brake(file, (now) => seen.push(now !== null));
  assert.ok(b.current(t + 60_000), 'held during a release');
  assert.equal(b.current(t + MAINTENANCE_BRAKE_MAX_MS + 1), null, 'the machine that set it is gone');
  assert.equal(b.current(t + MAINTENANCE_BRAKE_MAX_MS + 5_000), null, 'and it stays off while the file is the same');
  assert.deepEqual(seen.at(-1), false, 'told, so the service logs it');
  writeFileSync(file, JSON.stringify({ copies: true, algos: true, reason: 'Stop', since: t }));
  const op = new Brake(file);
  assert.ok(op.current(t + 30 * 24 * 3_600_000), 'an operator\'s stands until lifted');
  rmSync(dir, { recursive: true, force: true });
});

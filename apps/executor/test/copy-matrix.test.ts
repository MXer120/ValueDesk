/**
 * The copy options at the executor's door (docs/COVERAGE-COPY.md): every rule a follower can
 * sign reaches the copy as signed; the copies a wallet may run at once, one per trader, venue and
 * kind (paper or live); "ask me each time" on an executor (held, and a change to it refused); the
 * changes a running copy refuses; a stale terms version; the region at the start and at a change.
 * The runtime behind it is the copy engine's (packages/copy-engine/test/matrix-*.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes, privateKeyToAddress } from '../../../packages/sodex-core/src/index.ts';
import {
  CONFIRM_UNAVAILABLE,
  COPY_TERMS_VERSION,
  buildCopyRequest,
  canonicalSettings,
  copyRequestDigest,
  parseSettings,
  type CopyAction,
  type FetchLike,
  type WebSocketLike,
} from '../../../packages/copy-engine/src/index.ts';
import { loadConfig } from '../src/config.ts';
import { ExecutorDb } from '../src/db.ts';
import { Secrets } from '../src/secrets.ts';
import { ApiError, ExecutorService } from '../src/service.ts';

const LEADER = '0x1111111111111111111111111111111111111111';
const LEADER2 = '0x3333333333333333333333333333333333333333';

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

const fakeFetch: FetchLike = async (url) => {
  const ok = (data: unknown) => ({ status: 200, ok: true, text: async () => JSON.stringify({ code: 0, timestamp: Date.now(), data }) });
  const path = url.replace(/^https?:\/\/[^/]+/, '');
  if (path.endsWith('/markets/symbols') || path.endsWith('/markets/mark-prices')) return ok([]);
  if (/\/api\/v1\/user\/0x[0-9a-f]{40}\/subaccounts$/.test(path)) return ok({ primaryAccountID: 7 });
  if (/\/perps\/accounts\/0x[0-9a-f]{40}\/state$/.test(path)) return ok({ aid: 7, av: '1000', P: [] });
  if (/\/user\/0x[0-9a-f]{40}\/builders$/.test(path)) return ok({ perps: [{ builderID: 234812, feeRate: 25 }], spot: [] });
  if (url.includes('hyperliquid')) return ok({ marginSummary: { accountValue: '0' }, assetPositions: [], time: Date.now() });
  return { status: 404, ok: false, text: async () => '{"code":404,"message":"not found"}' };
};
const noWs = (): WebSocketLike => ({ readyState: 0, send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null });

function make(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vd-exec-'));
  const cfg = loadConfig({ EXECUTOR_DATA_DIR: dir, EXECUTOR_EDGE: 'none', EXECUTOR_KIND: 'hosted', ...env });
  const db = new ExecutorDb(':memory:');
  const svc = new ExecutorService(cfg, db, new Secrets(dir), { fetch: fakeFetch, factory: noWs, log: { debug() {}, info() {}, warn() {}, error() {} } });
  return { svc, cleanup: async () => { await svc.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const TERMS = (country = 'SG') => ({ termsVersion: COPY_TERMS_VERSION, termsHash: `0x${'ab'.repeat(32)}`, country, adult: true, notUsPerson: true, ownDecision: true, risksUnderstood: true });
const rules = (over: Record<string, unknown> = {}) => canonicalSettings(parseSettings({ leader: { venue: 'sodex', address: LEADER }, paper: true, ...over }));

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof ApiError ? `${e.status}:${e.code}` : String(e);
  }
};

async function setup(env: Record<string, string> = {}, country = 'SG') {
  const m = make(env);
  await m.svc.start();
  const w = new Wallet();
  const ctx = { viewerCountry: country };
  m.svc.acceptTerms(w.sign(m.svc.executorId, 'accept-terms', TERMS(country)), ctx);
  const sub = (settings: Record<string, unknown>, c = ctx, termsVersion = COPY_TERMS_VERSION) => m.svc.subscribe(w.sign(m.svc.executorId, 'subscribe', { settings, termsVersion }), c);
  const act = (action: CopyAction, payload: Record<string, unknown>, c = ctx) => m.svc.act(w.sign(m.svc.executorId, action, payload), c);
  return { ...m, w, ctx, sub, act };
}

test('every rule a follower signs reaches the copy as signed: each mode, each direction, every guard and filter, both margins and venues', async () => {
  const { sub, act, cleanup } = await setup({ EXECUTOR_MAX_COPIES: '20' });
  try {
    const cases: Array<Record<string, unknown>> = [
      { sizingMode: 'proportional', allocationUsd: 250, maxLeverage: 3, stopLossPct: 0.25, takeProfitPct: 2, drawdownStopPct: 0.1 },
      { sizingMode: 'fixedRatio', ratio: 0.5, direction: 'counter', maxPositionUsd: 100, stopLossPct: null, takeProfitPct: null, drawdownStopPct: null },
      { sizingMode: 'fixedNotional', fixedNotionalUsd: 12, assetAllow: ['ETH', 'BTC'], copyExisting: true, slippageBps: 1, marginMode: 'cross', leader: { venue: 'hyperliquid', address: LEADER } },
      { sizingMode: 'fixedNotional', fixedNotionalUsd: 1_000_000, assetDeny: ['DOGE'], slippageBps: 500, maxLeverage: 50, leader: { venue: 'sodex', address: LEADER2 } },
    ];
    for (const over of cases) {
      const signed = rules(over);
      const v = await sub(signed);
      assert.deepEqual(canonicalSettings(v.subscription.settings), signed, JSON.stringify(over));
      assert.equal(v.subscription.status, 'active');
      assert.equal(v.subscription.mode, 'hosted');
      await act('stop', { id: v.subscription.id, close: false });
    }
  } finally {
    await cleanup();
  }
});

test('at most EXECUTOR_MAX_COPIES run at once (a stopped one frees its place); one per trader, venue and kind - the other venue or paper next to live is another copy', async () => {
  const { sub, act, cleanup } = await setup({ EXECUTOR_MAX_COPIES: '2' });
  try {
    const a = await sub(rules());
    assert.equal(await code(sub(rules())), '409:duplicate', 'the same trader on the same venue, paper again');
    const b = await sub(rules({ leader: { venue: 'hyperliquid', address: LEADER } }));
    assert.equal(b.subscription.settings.leader.venue, 'hyperliquid', 'the same address on Hyperliquid is another trader');
    assert.equal(await code(sub(rules({ leader: { venue: 'sodex', address: LEADER2 } }))), '429:limit');
    await act('stop', { id: a.subscription.id, close: true });
    const c = await sub(rules());
    assert.equal(c.subscription.status, 'active', 'a stopped copy frees its place, and its trader can be copied again');
  } finally {
    await cleanup();
  }
});

test('"ask me each time" on an executor: a copy that asks starts held, saying why; a change to it is refused; back to automatic it runs', async () => {
  const { sub, act, cleanup } = await setup();
  try {
    const v = await sub(rules({ approval: 'confirm' }));
    assert.deepEqual([v.subscription.status, v.subscription.statusReason], ['blocked', CONFIRM_UNAVAILABLE]);
    const id = v.subscription.id;
    const [u] = (await act('update', { id, settings: rules({ approval: 'auto' }) })).copies;
    assert.equal(u!.subscription.status, 'active');
    assert.equal(await code(act('update', { id, settings: rules({ approval: 'confirm' }) })), '409:state');
  } finally {
    await cleanup();
  }
});

test('a running copy refuses a change of its trader, of paper or live, of copy or counter-trade; a stale terms version, and a region that does not allow copying, are refused at the door', async () => {
  const { svc, w, sub, act, cleanup } = await setup();
  try {
    const v = await sub(rules());
    const id = v.subscription.id;
    for (const bad of [rules({ leader: { venue: 'sodex', address: LEADER2 } }), rules({ leader: { venue: 'hyperliquid', address: LEADER } }), rules({ paper: false }), rules({ direction: 'counter' })]) {
      assert.equal(await code(act('update', { id, settings: bad })), '409:state', JSON.stringify(bad));
    }
    assert.equal(await code(sub(rules({ leader: { venue: 'sodex', address: LEADER2 } }), undefined, '2020-01-01')), '400:terms-version');
    // Seen from the United States: no copy, no change, no resume; stopping stays open.
    const us = { viewerCountry: 'US' };
    assert.equal(await code(sub(rules({ leader: { venue: 'sodex', address: LEADER2 } }), us)), '451:region');
    assert.equal(await code(act('update', { id, settings: rules({ maxLeverage: 2 }) }, us)), '451:region');
    await act('pause', { id });
    assert.equal(await code(act('resume', { id }, us)), '451:region');
    assert.equal(await code(act('stop', { id, close: true }, us)), 'ok');
    // From the EEA: allowed (no regional leverage cap since 2026-11-10).
    assert.equal(await code(sub(rules({ leader: { venue: 'sodex', address: LEADER2 } }), { viewerCountry: 'DE' })), 'ok');
    assert.ok(svc.consents(w.address).some((c) => c.action === 'stop'));
  } finally {
    await cleanup();
  }
});

/**
 * A hosted copy holding a position on a market SoDEX has since delisted (owner, 2026-10-29):
 * the executor's copier does not close or trade it, and the follower is told once - a warn
 * notice in the wallet's notices (GET /notices) and a line in the copy's activity - not again
 * after a restart. The engine side is copy-engine test/not-on-sodex.test.ts and edge-copy.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COPY_TERMS_VERSION, DEFAULT_SETTINGS, freshState, type FetchLike, type Subscription, type WebSocketLike } from '../../../packages/copy-engine/src/index.ts';
import { loadConfig } from '../src/config.ts';
import { ExecutorDb } from '../src/db.ts';
import { Secrets } from '../src/secrets.ts';
import { ExecutorService } from '../src/service.ts';

const OWNER = `0x${'e'.repeat(40)}`;
const LEADER = `0x${'f'.repeat(40)}`;

/** SoDEX lists BTC-USD only (OLD-USD was delisted); the leader and the follower each hold 1 / 0.5 OLD-USD. */
const sodex: FetchLike = async (url) => {
  const ok = (data: unknown) => ({ status: 200, ok: true, text: async () => JSON.stringify({ code: 0, data }) });
  const path = url.replace(/^https?:\/\/[^/]+/, '');
  if (path.endsWith('/markets/symbols')) return ok([{ id: 1, name: 'BTC-USD', baseCoin: 'BTC', tickSize: '1', stepSize: '0.00001', minQuantity: '0.00001', maxQuantity: '1000', minNotional: '10', maxNotional: '5000000', maxLeverage: 40, buyLimitUpRatio: '0.05', sellLimitDownRatio: '0.05', takerFee: '0.0004', status: 'TRADING' }]);
  if (path.endsWith('/markets/mark-prices')) return ok([{ symbol: 'BTC-USD', markPrice: '80000' }]);
  if (/\/user\/0x[0-9a-f]{40}\/subaccounts$/.test(path)) return ok({ primaryAccountID: path.includes(LEADER) ? 777 : 42 });
  if (path.endsWith(`${LEADER}/state`)) return ok({ aid: 777, av: '100000', P: [{ s: 'OLD-USD', sz: '1', ep: '2' }] });
  if (path.endsWith(`${OWNER}/state`)) return ok({ aid: 42, av: '1000', am: '1000', P: [{ s: 'OLD-USD', sz: '0.5', ep: '2' }] });
  if (/\/api-keys$/.test(path)) return ok([]);
  if (/\/builders$/.test(path)) return ok({ perps: [], spot: [] });
  return { status: 404, ok: false, text: async () => '{"code":404,"message":"not found"}' };
};

test('a hosted copy on a market SoDEX delisted: kept as it is, told once in the wallet\'s notices and the copy\'s activity, not again after a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vd-delist-'));
  const db = new ExecutorDb(':memory:');
  const sub: Subscription = {
    id: 'c_old', owner: OWNER, accountId: 42, mode: 'hosted', settings: { ...DEFAULT_SETTINGS, leader: { venue: 'sodex', address: LEADER }, stopLossPct: null },
    status: 'active', statusReason: null, createdAt: 1, updatedAt: 1, startedAt: 1, country: 'SG', observedCountry: null, termsVersion: COPY_TERMS_VERSION, consent: null,
  };
  await db.saveSubscription(sub);
  await db.saveState({ ...freshState(sub.id, 1000), leaderPos: { 'OLD-USD': 1 }, leaderEquity: 100_000, owned: { 'OLD-USD': { size: 0.5, entry: 2, openedAt: 1 } } });
  const cfg = loadConfig({ EXECUTOR_PRACTICE_BOTS: '1', EXECUTOR_DATA_DIR: dir, EXECUTOR_EDGE: 'none', EXECUTOR_KIND: 'hosted', EXECUTOR_BRAKE_FILE: 'none' });
  const silent = { debug() {}, info() {}, warn() {}, error() {} };
  const noWs = (): WebSocketLike => ({ readyState: 0, send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null });
  const run = async () => {
    const svc = new ExecutorService(cfg, db, new Secrets(dir), { fetch: sodex, factory: noWs, log: silent });
    await svc.start();
    return svc;
  };
  let svc = await run();
  try {
    const told = svc.notices(OWNER, {}).filter((n) => n.kind === 'delisted');
    assert.equal(told.length, 1, `one delisted notice (got ${JSON.stringify(svc.notices(OWNER, {}).map((n) => [n.kind, n.grade]))})`);
    assert.deepEqual([told[0]!.grade, told[0]!.source, told[0]!.ref, told[0]!.paper], ['warn', 'copy', 'c_old:OLD-USD', false]);
    assert.match(told[0]!.body, /^OLD-USD is no longer listed on SoDEX\. The copy still holds a long position of 0\.5 there, and ValueDesk will not trade it any more/);
    const lines = (await db.activity({ subId: 'c_old' })).filter((e) => e.kind === 'status' && e.reason === 'delisted');
    assert.equal(lines.length, 1, 'a line in the copy\'s activity');
    await svc.runtime.refreshFollower(OWNER);
    await svc.runtime.reconcileAll();
    assert.deepEqual(svc.runtime.view('c_old')!.positions.map((p) => [p.symbol, p.size]), [['OLD-USD', 0.5]], 'the copier leaves it as it is');
    await svc.stop();
    // A restart: what was told is kept, so it is not told again.
    svc = await run();
    assert.equal(svc.notices(OWNER, {}).filter((n) => n.kind === 'delisted').length, 1, 'told once');
  } finally {
    await svc.stop().catch(() => undefined);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

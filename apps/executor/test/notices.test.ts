/**
 * The executor keeps what a follower should hear of (db.ts notices, from copy-engine notices.ts):
 * once per id, a wallet's own only, newest first, by grade, a page before a time - and a copied
 * position SoDEX liquidated reaches it from the copy runtime as an error notice.
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

const A = `0x${'a'.repeat(40)}`;
const B = `0x${'b'.repeat(40)}`;
const n = (o: Partial<{ id: string; owner: string; grade: 'info' | 'warn' | 'error'; at: number }> = {}) => ({
  id: 'algo:al_1:failed:1000', owner: A, source: 'algo' as const, ref: 'al_1', kind: 'failed' as const, grade: 'error' as const,
  title: 'TWAP sell on BTC-USD failed', body: 'No margin.', at: 1_000, paper: false, ...o,
});

test('notices: once each, the wallet\'s own, newest first, by grade and page', () => {
  const db = new ExecutorDb(':memory:');
  db.addNotice(n());
  db.addNotice(n());
  db.addNotice(n({ id: 'b', grade: 'warn', at: 2_000 }));
  db.addNotice(n({ id: 'c', grade: 'info', at: 3_000, owner: B }));
  assert.deepEqual(db.notices(A).map((x) => x.id), ['b', 'algo:al_1:failed:1000']);
  assert.deepEqual(db.notices(A, { grades: ['error'] }).map((x) => x.id), ['algo:al_1:failed:1000']);
  assert.deepEqual(db.notices(A, { before: 2_000 }).map((x) => x.id), ['algo:al_1:failed:1000']);
  assert.deepEqual(db.notices(B).map((x) => x.grade), ['info']);
  assert.equal(db.notices(A)[0]!.paper, false);
  db.close();
});

/* --------------------------------------------- a copied position liquidated ----- */

const OWNER = `0x${'c'.repeat(40)}`;
const LEADER = `0x${'d'.repeat(40)}`;

/** SoDEX's REST as the copier reads it: one market, the leader long, the follower's positions as `follower` says. */
function sodex(w: { follower: Array<{ s: string; sz: string; ep: string }> }): FetchLike {
  const ok = (data: unknown) => ({ status: 200, ok: true, text: async () => JSON.stringify({ code: 0, data }) });
  return async (url) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path.endsWith('/markets/symbols')) return ok([{ id: 1, name: 'BTC-USD', baseCoin: 'BTC', tickSize: '1', stepSize: '0.00001', minQuantity: '0.00001', maxQuantity: '1000', minNotional: '10', maxNotional: '5000000', maxLeverage: 40, buyLimitUpRatio: '0.05', sellLimitDownRatio: '0.05', takerFee: '0.0004', status: 'TRADING' }]);
    if (path.endsWith('/markets/mark-prices')) return ok([{ symbol: 'BTC-USD', markPrice: '78800' }]);
    if (/\/user\/0x[0-9a-f]{40}\/subaccounts$/.test(path)) return ok({ primaryAccountID: path.includes(LEADER) ? 777 : 42 });
    if (path.endsWith(`${LEADER}/state`)) return ok({ aid: 777, av: '100000', P: [{ s: 'BTC-USD', sz: '1', ep: '80000' }] });
    if (path.endsWith(`${OWNER}/state`)) return ok({ aid: 42, av: '1000', am: '1000', P: w.follower });
    if (/\/api-keys$/.test(path)) return ok([]);
    if (/\/builders$/.test(path)) return ok({ perps: [], spot: [] });
    return { status: 404, ok: false, text: async () => '{"code":404,"message":"not found"}' };
  };
}

test('a copied position liquidated by SoDEX: the copy\'s error notice ("closed outside the copier") is in the wallet\'s notices, as GET /notices serves them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vd-liq-'));
  const db = new ExecutorDb(':memory:');
  const w = { follower: [{ s: 'BTC-USD', sz: '0.01', ep: '80000' }] };
  // A live copy that holds 0.01 BTC of its leader's long (as the store has it after a restart).
  const sub: Subscription = {
    id: 'c_liq', owner: OWNER, accountId: 42, mode: 'hosted', settings: { ...DEFAULT_SETTINGS, leader: { venue: 'sodex', address: LEADER }, stopLossPct: null },
    status: 'active', statusReason: null, createdAt: 1, updatedAt: 1, startedAt: 1, country: 'SG', observedCountry: null, termsVersion: COPY_TERMS_VERSION, consent: null,
  };
  await db.saveSubscription(sub);
  await db.saveState({ ...freshState(sub.id, 1000), leaderPos: { 'BTC-USD': 1 }, leaderEquity: 100_000, owned: { 'BTC-USD': { size: 0.01, entry: 80_000, openedAt: 1 } } });
  const cfg = loadConfig({ EXECUTOR_PRACTICE_BOTS: '1', EXECUTOR_DATA_DIR: dir, EXECUTOR_EDGE: 'none', EXECUTOR_KIND: 'hosted', EXECUTOR_BRAKE_FILE: 'none' });
  const silent = { debug() {}, info() {}, warn() {}, error() {} };
  const noWs = (): WebSocketLike => ({ readyState: 0, send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null });
  const svc = new ExecutorService(cfg, db, new Secrets(dir), { fetch: sodex(w), factory: noWs, log: silent });
  try {
    await svc.start();
    // SoDEX took the position over: the follower's account shows none.
    w.follower = [];
    await svc.runtime.refreshFollower(OWNER);
    const errors = svc.notices(OWNER, { grades: ['error'] });
    const closed = errors.find((n) => n.kind === 'closed');
    assert.ok(closed, `an error notice of kind closed (got ${JSON.stringify(svc.notices(OWNER, {}).map((n) => [n.kind, n.grade]))})`);
    assert.equal(closed.source, 'copy');
    assert.equal(closed.ref, 'c_liq:BTC-USD');
    assert.match(closed.title, /BTC-USD closed in the copy of 0xdddd/);
    assert.match(closed.body, /closed outside the copier \(by you, or by SoDEX\)/);
    assert.equal(closed.paper, false);
    assert.equal(svc.runtime.view('c_liq')!.positions.length, 0, 'and the copy holds nothing');
  } finally {
    await svc.stop().catch(() => undefined);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

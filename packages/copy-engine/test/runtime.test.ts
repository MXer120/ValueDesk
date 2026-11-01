import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CopyRuntime,
  HyperliquidClient,
  MemoryStore,
  PaperSink,
  SodexClient,
  regionPolicy,
  type FetchLike,
  type Intent,
  type OrderSink,
  type SendResult,
  type Subscription,
  type WebSocketLike,
} from '../src/index.ts';
import { FOLLOWER, LEADER, sub } from './helpers.ts';

const LEADER_ID = 777;
const FOLLOWER_ID = 42;

class FakeWs implements WebSocketLike {
  static all: FakeWs[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeWs.all.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.({});
    }, 1);
  }
  send(d: string): void {
    this.sent.push(JSON.parse(d));
  }
  close(): void {
    this.readyState = 3;
  }
  push(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

interface World {
  leaderPositions: Array<{ s: string; sz: string; ep: string }>;
  followerPositions: Array<{ s: string; sz: string; ep: string; l: number; m: string }>;
  builderRate: number | null;
  mark: number;
  /** The follower's free margin on SoDEX (`am`), USD. */
  available?: string;
}

function fakeFetch(w: World): FetchLike {
  const ok = (data: unknown) => ({ status: 200, ok: true, text: async () => JSON.stringify({ code: 0, timestamp: Date.now(), data }) });
  return async (url) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/v1/perps/markets/symbols') {
      return ok([{ id: 1, name: 'BTC-USD', baseCoin: 'BTC', tickSize: '1', stepSize: '0.00001', minQuantity: '0.00001', maxQuantity: '1000', minNotional: '10', maxNotional: '5000000', maxLeverage: 50, buyLimitUpRatio: '0.05', sellLimitDownRatio: '0.05', takerFee: '0.0004', status: 'TRADING' }]);
    }
    if (path === '/api/v1/perps/markets/mark-prices') return ok([{ symbol: 'BTC-USD', markPrice: String(w.mark) }]);
    if (path === `/api/v1/user/${LEADER}/subaccounts`) return ok({ primaryAccountID: LEADER_ID });
    if (path === `/api/v1/perps/accounts/${LEADER}/state`) return ok({ aid: LEADER_ID, av: '100000', P: w.leaderPositions });
    if (path === `/api/v1/perps/accounts/${FOLLOWER}/state`) return ok({ aid: FOLLOWER_ID, av: '5000', am: w.available ?? '5000', P: w.followerPositions });
    if (path === `/api/v1/user/${FOLLOWER}/builders`) return ok({ perps: w.builderRate === null ? [] : [{ userID: FOLLOWER_ID, builderID: 9, feeRate: w.builderRate }], spot: [] });
    return { status: 404, ok: false, text: async () => '{"code":404,"message":"not found"}' };
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await wait(10);
  }
}

function runtime(w: World, sinkFor: (s: Subscription) => OrderSink | null, builderFor: () => Promise<{ id: number; fee: number } | null> = async () => ({ id: 9, fee: 25 })) {
  const fetch = fakeFetch(w);
  const store = new MemoryStore();
  const rt = new CopyRuntime({
    confirmGapMs: 0,
    store,
    sodex: new SodexClient({ network: 'mainnet', fetch }),
    hyperliquid: new HyperliquidClient(fetch),
    factory: (url) => new FakeWs(url),
    network: 'mainnet',
    hlMode: 'user',
    sinkFor,
    builderFor,
    policyFor: (s) => regionPolicy(s.country, s.observedCountry),
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  return { rt, store };
}

const sodexWs = () => FakeWs.all.filter((x) => x.url.endsWith('/ws/perps')).at(-1)!;
const print = (t: number, side: 'BUY' | 'SELL', qty: string, price: string, bi: number, si: number) => ({
  channel: 'trade',
  type: 'update',
  data: [{ E: Date.now(), T: Date.now(), t, s: 'BTC-USD', S: side, p: price, q: qty, bi, si }],
});

test('paper copy end to end: the leader opens, adds and closes; the copy follows with its own books', async () => {
  const w: World = { leaderPositions: [], followerPositions: [], builderRate: 25, mark: 80_000 };
  const paper = new PaperSink();
  const { rt, store } = runtime(w, () => paper);
  await rt.start();
  const s = await rt.add(sub({ paper: true }, { id: 'p1' }));
  await until(() => sodexWs()?.readyState === 1);
  // The trade stream is subscribed on every market, plus marks.
  await until(() => sodexWs().sent.some((m) => (m as { params?: { channel?: string } }).params?.channel === 'trade'));

  sodexWs().push(print(1, 'BUY', '0.6', '80000', LEADER_ID, 1002));
  sodexWs().push(print(2, 'BUY', '0.4', '80000', LEADER_ID, 1002)); // same order: coalesced
  await until(() => (rt.view(s.id)?.positions.length ?? 0) === 1);
  let v = rt.view(s.id)!;
  assert.equal(v.positions[0]!.size, 0.01); // 1 BTC of a 100k leader on a 1,000 copy
  assert.deepEqual(v.leader.positions, { 'BTC-USD': 1 });

  sodexWs().push(print(3, 'SELL', '1', '81000', 1002, LEADER_ID));
  await until(() => (rt.view(s.id)?.positions.length ?? 1) === 0);
  v = rt.view(s.id)!;
  // Bought at 80,008 (mark + 1 bp), sold at 79,992 (mark 80,000 - 1 bp): the paper sink fills at the mark.
  assert.ok(v.realizedPnl < 0 && v.realizedPnl > -1);
  assert.ok(v.fees > 0);
  const log = await store.activity({ subId: s.id });
  assert.deepEqual(log.filter((e) => e.kind === 'fill').map((e) => e.reason).reverse(), ['open', 'close']);
  assert.ok(log.every((e) => e.paper));
  await rt.stop();
});

test('positions open when copying starts are left alone until the leader is flat', async () => {
  const w: World = { leaderPositions: [{ s: 'BTC-USD', sz: '2', ep: '79000' }], followerPositions: [], builderRate: 25, mark: 80_000 };
  const paper = new PaperSink();
  const { rt } = runtime(w, () => paper);
  await rt.start();
  const s = await rt.add(sub({ paper: true }, { id: 'p2' }));
  await until(() => sodexWs()?.readyState === 1);
  await wait(20);
  sodexWs().push(print(10, 'BUY', '1', '80000', LEADER_ID, 1002));
  await wait(400);
  assert.equal(rt.view(s.id)!.positions.length, 0);
  sodexWs().push(print(11, 'SELL', '3', '80000', 1002, LEADER_ID)); // flat
  await wait(400);
  sodexWs().push(print(12, 'BUY', '1', '80000', LEADER_ID, 1002)); // a new position
  await until(() => rt.view(s.id)!.positions.length === 1);
  await rt.stop();
});

test('a leader no copy follows is read afresh by the next copy: what it held while unfollowed is not taken for its positions now', async () => {
  // Live run 2026-10-29: a copy stopped, the leader closed while nobody followed it, and the next copy of it
  // took the stale long for a pre-existing position - so it left the leader's next buy uncopied.
  const w: World = { leaderPositions: [{ s: 'BTC-USD', sz: '2', ep: '79000' }], followerPositions: [], builderRate: 25, mark: 80_000 };
  const paper = new PaperSink();
  const { rt } = runtime(w, () => paper);
  await rt.start();
  const first = await rt.add(sub({ paper: true }, { id: 'p-stale-1' }));
  await rt.stopCopy(first.id, { close: false });
  w.leaderPositions = []; // closed while unfollowed: no feed carries it
  const s = await rt.add(sub({ paper: true }, { id: 'p-stale-2' }));
  assert.deepEqual(rt.view(s.id)!.leader.positions, {}, 'the new copy reads the leader flat');
  await until(() => sodexWs()?.readyState === 1);
  await until(() => sodexWs().sent.some((m) => (m as { params?: { channel?: string } }).params?.channel === 'trade'));
  sodexWs().push(print(20, 'BUY', '1', '80000', LEADER_ID, 1002));
  await until(() => rt.view(s.id)!.positions.length === 1);
  await rt.stop();
});

test('a live copy without a covering builder approval is blocked, and unblocks once approved', async () => {
  const w: World = { leaderPositions: [], followerPositions: [], builderRate: 15, mark: 80_000 };
  const sent: Intent[][] = [];
  const sink: OrderSink = {
    paper: false,
    async place(_a, _m, intents): Promise<SendResult[]> {
      sent.push(intents);
      return intents.map((i) => ({ clOrdID: i.clOrdID, ok: true, orderId: '1', error: null, outcomeUnknown: false }));
    },
    async setLeverage() {},
    async placeStop(_a, _m, st) {
      return { clOrdID: st.clOrdID, ok: true, orderId: null, error: null, outcomeUnknown: false };
    },
    async cancel() {},
  };
  const { rt } = runtime(w, () => sink);
  await rt.start();
  const s = await rt.add(sub({}, { id: 'l1' }));
  assert.equal(rt.get(s.id)!.status, 'blocked');
  assert.match(rt.get(s.id)!.statusReason!, /copy fee/);
  w.builderRate = 25;
  await rt.checkReady(rt.get(s.id)!);
  assert.equal(rt.get(s.id)!.status, 'active');

  await until(() => sodexWs()?.readyState === 1);
  await wait(20);
  sodexWs().push(print(20, 'BUY', '1', '80000', LEADER_ID, 1002));
  await until(() => sent.length === 1);
  assert.equal(sent[0]![0]!.quantity, '0.01');
  // The follower's own fill on the public stream books the copy at the real price.
  sodexWs().push(print(21, 'BUY', '0.01', '80010', FOLLOWER_ID, 1002));
  await until(() => (rt.view(s.id)?.positions[0]?.entry ?? 0) === 80_010);
  await rt.stop();
});

test('a builder lookup that fails holds the copy back - never an order without our builder', async () => {
  const w: World = { leaderPositions: [], followerPositions: [], builderRate: 25, mark: 80_000 };
  const sent: Array<{ intents: Intent[]; builder: unknown }> = [];
  const sink: OrderSink = {
    paper: false,
    async place(_a, _m, intents, builder): Promise<SendResult[]> {
      sent.push({ intents, builder });
      return intents.map((i) => ({ clOrdID: i.clOrdID, ok: true, orderId: '1', error: null, outcomeUnknown: false }));
    },
    async setLeverage() {},
    async placeStop(_a, _m, st) {
      return { clOrdID: st.clOrdID, ok: true, orderId: null, error: null, outcomeUnknown: false };
    },
    async cancel() {},
  };
  let broken = false;
  const { rt, store } = runtime(w, () => sink, async () => {
    if (broken) throw new Error('ledger unreachable');
    return { id: 9, fee: 25 };
  });
  await rt.start();
  const s = await rt.add(sub({}, { id: 'b1' }));
  assert.equal(rt.get(s.id)!.status, 'active');
  await until(() => sodexWs()?.readyState === 1);
  await wait(20);
  broken = true;
  sodexWs().push(print(30, 'BUY', '1', '80000', LEADER_ID, 1002));
  const log = async () => (await store.activity({ subId: s.id })).filter((e) => e.reason === 'builder');
  const t0 = Date.now();
  while (!(await log()).length && Date.now() - t0 < 3000) await wait(10);
  assert.equal(sent.length, 0, 'nothing sent without the builder');
  assert.match((await log())[0]!.detail ?? '', /builder fee could not be set/);
  await rt.stop();
});

test('the region rule blocks a US follower, and the kill switch stops every copy', async () => {
  const w: World = { leaderPositions: [], followerPositions: [], builderRate: 25, mark: 80_000 };
  const paper = new PaperSink();
  const { rt } = runtime(w, () => paper);
  await rt.start();
  const us = await rt.add(sub({}, { id: 'us', country: 'US' }));
  assert.equal(rt.get(us.id)!.status, 'blocked');
  await rt.add(sub({ paper: true }, { id: 'a' }));
  await rt.add(sub({ paper: true }, { id: 'b' }));
  const stopped = await rt.stopAll(FOLLOWER, { close: false });
  assert.equal(stopped.length, 3);
  assert.ok(rt.list(FOLLOWER).every((x) => x.status === 'stopped'));
  await assert.rejects(rt.resume('a'), /cannot be restarted/);
  await rt.stop();
});

test('a live copy places no opening order its SoDEX free margin cannot carry, and says why', async () => {
  const w: World = { leaderPositions: [], followerPositions: [], builderRate: 25, mark: 80_000, available: '50' };
  const sent: Intent[][] = [];
  const sink: OrderSink = {
    paper: false,
    async place(_a, _m, intents): Promise<SendResult[]> {
      sent.push(intents);
      return intents.map((i) => ({ clOrdID: i.clOrdID, ok: true, orderId: '1', error: null, outcomeUnknown: false }));
    },
    async setLeverage() {},
    async placeStop(_a, _m, st) {
      return { clOrdID: st.clOrdID, ok: true, orderId: null, error: null, outcomeUnknown: false };
    },
    async cancel() {},
  };
  const { rt, store } = runtime(w, () => sink);
  await rt.start();
  const s = await rt.add(sub({}, { id: 'fm' }));
  await until(() => sodexWs()?.readyState === 1);
  await wait(150); // the follower's account is read
  sodexWs().push(print(30, 'BUY', '1', '80000', LEADER_ID, 1002)); // a 0.01 BTC copy needs 160 of margin at 5x
  await wait(400);
  assert.equal(sent.length, 0);
  const log = await store.activity({ subId: s.id });
  assert.ok(log.some((e) => e.kind === 'skip' && e.reason === 'free-margin'));
  await rt.stop();
});

test('brake: a live copy sends nothing while the operator brake is on, logs why, and copies the next trade once it is lifted', async () => {
  const w: World = { leaderPositions: [], followerPositions: [], builderRate: 25, mark: 80_000 };
  const sent: Intent[][] = [];
  const sink: OrderSink = {
    paper: false,
    async place(_a, _m, intents): Promise<SendResult[]> {
      sent.push(intents);
      return intents.map((i) => ({ clOrdID: i.clOrdID, ok: true, orderId: '1', error: null, outcomeUnknown: false }));
    },
    async setLeverage() {},
    async placeStop(_a, _m, st) {
      return { clOrdID: st.clOrdID, ok: true, orderId: null, error: null, outcomeUnknown: false };
    },
    async cancel() {},
  };
  const { rt, store } = runtime(w, () => sink);
  let brake: string | null = 'Investigating.';
  (rt as unknown as { host: { brake?: () => string | null } }).host.brake = () => brake;
  await rt.start();
  const s = await rt.add(sub({}, { id: 'br' }));
  await until(() => sodexWs()?.readyState === 1);
  await wait(150);
  sodexWs().push(print(40, 'BUY', '1', '80000', LEADER_ID, 1002));
  await wait(400);
  assert.equal(sent.length, 0, 'nothing sent while braked');
  const brakeLog = await store.activity({ subId: s.id });
  assert.ok(brakeLog.some((e) => e.kind === 'error' && e.reason === 'brake' && /Investigating/.test(e.detail ?? '')), JSON.stringify(brakeLog.map((e) => [e.kind, e.reason, e.detail])));
  brake = null;
  sodexWs().push(print(41, 'BUY', '1', '80000', LEADER_ID, 1002));
  await until(() => sent.length > 0);
  await rt.stop();
});

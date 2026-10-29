/**
 * A follower's copied position liquidated by SoDEX (docs/TESTING-MATRIX.md, "Follower
 * liquidated"). SoDEX's liquidation is a takeover: the position goes to another account in a
 * fill of SoDEX's own (clOrdID "liquidation:<id>", no order of the copier's; docs/research/07
 * G7), so the copier learns of it only from the follower's account, re-read every 30 s and
 * after its orders (refreshFollower): the position is gone, or smaller.
 *
 * What is pinned here: closed in full, the copy books it as closed outside the copier (an
 * error notice, a liquidation being one way), cancels its SoDEX stops there, never opens it
 * again by itself and follows the leader again once the leader is flat there (or flips), with
 * the copy's own leverage set again first; isolated, only that market goes and the copy's other
 * positions stay managed; cross, SoDEX may take every market, each told. Partly, the copy holds
 * what SoDEX left, books the part that went, sends nothing by itself, and on the leader's next
 * add goes back to its target. A runtime runs against a faked SoDEX (REST and the trade stream),
 * as audit-copy.test.ts does. An assertion that starts "BUG:" failed before its fix
 * (docs/TESTING-MATRIX.md names it); a "FINDING" is a test.todo holding a case the engine does
 * not handle yet.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CopyRuntime,
  HyperliquidClient,
  MemoryStore,
  SodexClient,
  regionPolicy,
  type EngineNotice,
  type FetchLike,
  type Intent,
  type OrderSink,
  type SendResult,
  type WebSocketLike,
} from '../src/index.ts';
import { FOLLOWER, LEADER, sub } from './helpers.ts';

const LEADER_ID = 777;
const FOLLOWER_ID = 42;

class FakeWs implements WebSocketLike {
  static all: FakeWs[] = [];
  readyState = 0;
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
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
  push(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

type Pos = { s: string; sz: string; ep: string; l: number; m: string };

/** SoDEX as the copier reads it: the leader's and the follower's positions (perps /state P[]), the marks, the builder approval. */
interface World {
  leader: Array<{ s: string; sz: string; ep: string }>;
  follower: Pos[];
  marks: Record<string, number>;
}

const world = (o: Partial<World> = {}): World => ({ leader: [], follower: [], marks: { 'BTC-USD': 80_000, 'ETH-USD': 2_000 }, ...o });

const marketRow = (id: number, name: string, base: string, tick: string, step: string) => ({
  id, name, baseCoin: base, tickSize: tick, stepSize: step, minQuantity: step, maxQuantity: '100000', minNotional: '10', maxNotional: '50000000', maxLeverage: 40, buyLimitUpRatio: '0.05', sellLimitDownRatio: '0.05', takerFee: '0.0004', status: 'TRADING',
});

function fakeFetch(w: World): FetchLike {
  const ok = (data: unknown) => ({ status: 200, ok: true, text: async () => JSON.stringify({ code: 0, timestamp: Date.now(), data }) });
  return async (url) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/v1/perps/markets/symbols') return ok([marketRow(1, 'BTC-USD', 'BTC', '1', '0.00001'), marketRow(2, 'ETH-USD', 'ETH', '0.1', '0.0001')]);
    if (path === '/api/v1/perps/markets/mark-prices') return ok(Object.entries(w.marks).map(([symbol, p]) => ({ symbol, markPrice: String(p) })));
    if (path === `/api/v1/user/${LEADER}/subaccounts`) return ok({ primaryAccountID: LEADER_ID });
    if (path === `/api/v1/perps/accounts/${LEADER}/state`) return ok({ aid: LEADER_ID, av: '100000', P: JSON.parse(JSON.stringify(w.leader)) });
    if (path === `/api/v1/perps/accounts/${FOLLOWER}/state`) return ok({ aid: FOLLOWER_ID, av: '5000', am: '5000', P: JSON.parse(JSON.stringify(w.follower)) });
    if (path === `/api/v1/user/${FOLLOWER}/builders`) return ok({ perps: [{ userID: FOLLOWER_ID, builderID: 9, feeRate: 25 }], spot: [] });
    return { status: 404, ok: false, text: async () => '{"code":404,"message":"not found"}' };
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000): Promise<boolean> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) return false;
    await wait(10);
  }
  return true;
}

/** A live sink that records what it is asked to do: orders, leverage, stops (with their size) and cancels. */
function recordingSink() {
  const placed: Intent[][] = [];
  const stops: Array<{ clOrdID: string; quantity: string; kind: string }> = [];
  const cancels: string[] = [];
  let leverage = 0;
  const sink: OrderSink = {
    paper: false,
    async place(_a, _m, intents): Promise<SendResult[]> {
      placed.push(intents);
      return intents.map((i) => ({ clOrdID: i.clOrdID, ok: true, orderId: '1', error: null, outcomeUnknown: false }));
    },
    async setLeverage() {
      leverage++;
    },
    async placeStop(_a, _m, st) {
      stops.push({ clOrdID: st.clOrdID, quantity: st.quantity, kind: st.kind });
      return { clOrdID: st.clOrdID, ok: true, orderId: null, error: null, outcomeUnknown: false };
    },
    async cancel(_a, _m, id) {
      cancels.push(id);
    },
  };
  return { sink, placed, stops, cancels, leverage: () => leverage, orders: () => placed.flat() };
}

function runtime(w: World, sink: OrderSink) {
  const fetch = fakeFetch(w);
  const store = new MemoryStore();
  const notices: EngineNotice[] = [];
  const rt = new CopyRuntime({
    store,
    sodex: new SodexClient({ network: 'mainnet', fetch }),
    hyperliquid: new HyperliquidClient(fetch),
    factory: (url) => new FakeWs(url),
    network: 'mainnet',
    hlMode: 'user',
    sinkFor: () => sink,
    builderFor: async () => ({ id: 9, fee: 25 }),
    policyFor: (s) => regionPolicy(s.country, s.observedCountry),
    onNotice: (n) => notices.push(n),
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  return { rt, store, notices };
}

const sodexWs = () => FakeWs.all.filter((x) => x.url.endsWith('/ws/perps')).at(-1)!;
let tid = 9_000;
const print = (side: 'BUY' | 'SELL', qty: string, price: string, bi: number, si: number, s: string) => ({
  channel: 'trade',
  type: 'update',
  data: [{ E: Date.now(), T: Date.now(), t: ++tid, s, S: side, p: price, q: qty, bi, si }],
});
const leaderBuys = (qty: string, s = 'BTC-USD', price = String(s === 'BTC-USD' ? 80_000 : 2_000)) => sodexWs().push(print('BUY', qty, price, LEADER_ID, 1002, s));
const leaderSells = (qty: string, s = 'BTC-USD', price = String(s === 'BTC-USD' ? 80_000 : 2_000)) => sodexWs().push(print('SELL', qty, price, 1002, LEADER_ID, s));
/** The copy's own order filled, as the public stream shows it (the follower took liquidity). */
const followerBought = (qty: string, s = 'BTC-USD', price = String(s === 'BTC-USD' ? 80_000 : 2_000)) => sodexWs().push(print('BUY', qty, price, FOLLOWER_ID, 1002, s));

const size = (rt: CopyRuntime, id: string, sym = 'BTC-USD') => rt.view(id)!.positions.find((p) => p.symbol === sym)?.size ?? 0;
/** The copy's SoDEX stops are placed 2 s after a fill (a timer); here at once. */
const placeStops = (rt: CopyRuntime, id: string, sym: string) => (rt as unknown as { refreshStops(id: string, s: string): Promise<void> }).refreshStops(id, sym);

async function ready(): Promise<void> {
  await until(() => sodexWs()?.readyState === 1);
  await wait(150); // the start-up reconciles settle
}

/** A live copy that holds 0.01 BTC copied from the leader's 1 BTC (proportional: $1,000 of the leader's $100,000), with its SoDEX stop-loss. */
async function holding(o: { id: string; settings?: Parameters<typeof sub>[0] }) {
  const w = world();
  const rec = recordingSink();
  const { rt, store, notices } = runtime(w, rec.sink);
  await rt.start();
  const s = await rt.add(sub(o.settings ?? {}, { id: o.id }));
  assert.equal(rt.get(s.id)!.status, 'active');
  await ready();
  leaderBuys('1');
  w.leader = [{ s: 'BTC-USD', sz: '1', ep: '80000' }];
  assert.ok(await until(() => rec.placed.length === 1), 'the copy opened');
  followerBought(rec.placed[0]![0]!.quantity);
  assert.ok(await until(() => size(rt, s.id) > 0));
  w.follower = [{ s: 'BTC-USD', sz: String(size(rt, s.id)), ep: '80000', l: 5, m: 'ISOLATED' }];
  await placeStops(rt, s.id, 'BTC-USD');
  return { w, rec, rt, store, notices, s };
}

/* ============================================================ in full ===== */

test('liquidated in full (isolated): closed outside the copier with an error notice, its SoDEX stop cancelled, never reopened by itself; copied again once the leader is flat, its leverage set again first', async () => {
  const { w, rec, rt, store, notices, s } = await holding({ id: 'liq-full' });
  try {
    assert.equal(size(rt, s.id), 0.01);
    assert.equal(rec.stops.length, 1, 'the copy\'s stop-loss rests on SoDEX');
    const levBefore = rec.leverage();
    const ordersBefore = rec.orders().length;
    // SoDEX takes the position over at 78,800 (its own fill, not an order of the copier's): the account shows none.
    rt.markets.setMark('BTC-USD', 78_800);
    w.follower = [];
    await rt.refreshFollower(FOLLOWER);
    assert.equal(size(rt, s.id), 0, 'the books follow SoDEX: nothing held');
    assert.ok(Math.abs(rt.view(s.id)!.realizedPnl - 0.01 * (78_800 - 80_000)) < 1e-9, `the loss is booked (${rt.view(s.id)!.realizedPnl})`);
    const said = (await store.activity({ subId: s.id })).find((e) => e.kind === 'status' && e.reason === 'closed-outside');
    assert.ok(said && said.symbol === 'BTC-USD' && /closed outside the copier/.test(said.detail ?? ''), 'its activity says it was closed outside the copier');
    assert.deepEqual(notices.filter((n) => n.kind === 'closed').map((n) => [n.source, n.ref, n.grade]), [['copy', 'liq-full:BTC-USD', 'error']], 'one error notice for the market');
    assert.ok(await until(() => rec.cancels.includes(rec.stops[0]!.clOrdID)), 'its stop-loss on SoDEX is cancelled');
    // Not reopened by itself: a re-read, a reconcile and a leader add send nothing there.
    await rt.refreshFollower(FOLLOWER);
    await rt.reconcileAll();
    leaderBuys('0.5');
    w.leader = [{ s: 'BTC-USD', sz: '1.5', ep: '80000' }];
    await wait(200);
    assert.equal(rec.orders().length, ordersBefore, 'nothing is sent while the leader still holds');
    assert.ok((await store.activity({ subId: s.id })).some((e) => e.kind === 'skip' && e.reason === 'own-position'), 'the add is skipped, and said');
    // The leader closes (nothing to close here), then opens again: copied, at the copy's own leverage.
    leaderSells('1.5');
    w.leader = [];
    await wait(200);
    assert.equal(rec.orders().length, ordersBefore, 'the leader\'s close sends nothing: the copy holds nothing');
    leaderBuys('1');
    w.leader = [{ s: 'BTC-USD', sz: '1', ep: '80000' }];
    assert.ok(await until(() => rec.orders().length === ordersBefore + 1), 'the leader\'s next open is copied');
    const open = rec.orders().at(-1)!;
    assert.deepEqual([open.symbol, open.side, open.reduceOnly, open.leg], ['BTC-USD', 'buy', false, 'open']);
    assert.equal(rec.leverage(), levBefore + 1, 'BUG: the copy\'s leverage is set again before it opens (SoDEX\'s may have been raised by hand before the liquidation)');
  } finally {
    await rt.stop();
  }
});

test('isolated vs cross: an isolated liquidation takes one market and the copy\'s other position stays managed; a cross one may take every market, each told', async () => {
  const { w, rec, rt, notices, s } = await holding({ id: 'liq-two' });
  try {
    leaderBuys('10', 'ETH-USD');
    w.leader = [{ s: 'BTC-USD', sz: '1', ep: '80000' }, { s: 'ETH-USD', sz: '10', ep: '2000' }];
    assert.ok(await until(() => rec.placed.length === 2), 'ETH copied too');
    followerBought(rec.placed[1]![0]!.quantity, 'ETH-USD');
    assert.ok(await until(() => size(rt, s.id, 'ETH-USD') > 0));
    const eth = size(rt, s.id, 'ETH-USD');
    w.follower.push({ s: 'ETH-USD', sz: String(eth), ep: '2000', l: 5, m: 'ISOLATED' });
    // Isolated: SoDEX takes BTC-USD only.
    w.follower = w.follower.filter((p) => p.s !== 'BTC-USD');
    await rt.refreshFollower(FOLLOWER);
    assert.equal(size(rt, s.id), 0);
    assert.equal(size(rt, s.id, 'ETH-USD'), eth, 'ETH-USD is untouched');
    assert.deepEqual(notices.filter((n) => n.kind === 'closed').map((n) => n.ref), ['liq-two:BTC-USD']);
    leaderSells('5', 'ETH-USD');
    w.leader = [{ s: 'BTC-USD', sz: '1', ep: '80000' }, { s: 'ETH-USD', sz: '5', ep: '2000' }];
    assert.ok(await until(() => rec.placed.length === 3), 'the leader\'s ETH reduction is still copied');
    assert.deepEqual(rec.placed[2]!.map((i) => [i.symbol, i.side, i.reduceOnly, i.leg]), [['ETH-USD', 'sell', true, 'decrease']]);
  } finally {
    await rt.stop();
  }

  // Cross: the whole account is liquidated, both copied markets at once.
  const b = await holding({ id: 'liq-cross', settings: { marginMode: 'cross' } });
  try {
    leaderBuys('10', 'ETH-USD');
    b.w.leader = [{ s: 'BTC-USD', sz: '1', ep: '80000' }, { s: 'ETH-USD', sz: '10', ep: '2000' }];
    assert.ok(await until(() => b.rec.placed.length === 2));
    followerBought(b.rec.placed[1]![0]!.quantity, 'ETH-USD');
    assert.ok(await until(() => size(b.rt, b.s.id, 'ETH-USD') > 0));
    b.w.follower = [];
    await b.rt.refreshFollower(FOLLOWER);
    assert.equal(size(b.rt, b.s.id) + size(b.rt, b.s.id, 'ETH-USD'), 0, 'nothing held on either market');
    assert.deepEqual(b.notices.filter((n) => n.kind === 'closed').map((n) => [n.ref, n.grade]).sort(), [['liq-cross:BTC-USD', 'error'], ['liq-cross:ETH-USD', 'error']], 'one error notice per market');
    assert.equal(b.rt.get(b.s.id)!.status, 'active', 'the copy goes on (it copies each market again once its leader is flat there)');
  } finally {
    await b.rt.stop();
  }
});

/* ============================================================== in part ===== */

test('liquidated in part: the copy holds what SoDEX left (the part that went booked), sends nothing by itself, resizes its stop, and goes back to its target on the leader\'s next add', async () => {
  // A fixed $800: 0.01 BTC for the leader's 1 BTC, so 0.01 per leader unit.
  const { w, rec, rt, notices, s } = await holding({ id: 'liq-part', settings: { sizingMode: 'fixedNotional', fixedNotionalUsd: 800 } });
  try {
    assert.equal(size(rt, s.id), 0.01);
    const n0 = rec.orders().length;
    // SoDEX takes 0.004 over at 78,800; 0.006 is left.
    rt.markets.setMark('BTC-USD', 78_800);
    w.follower = [{ s: 'BTC-USD', sz: '0.006', ep: '80000', l: 5, m: 'ISOLATED' }];
    await rt.refreshFollower(FOLLOWER);
    assert.equal(size(rt, s.id), 0.006, 'the books follow SoDEX');
    assert.ok(Math.abs(rt.view(s.id)!.realizedPnl - 0.004 * (78_800 - 80_000)) < 1e-9, `BUG: the part SoDEX took is booked (${rt.view(s.id)!.realizedPnl}), not left out of the copy's equity`);
    await placeStops(rt, s.id, 'BTC-USD');
    assert.ok(rec.cancels.includes(rec.stops[0]!.clOrdID), 'the old stop-loss is cancelled');
    assert.deepEqual(rec.stops.slice(1).map((x) => [x.kind, x.quantity]), [['stop-loss', '0.006']], 'and one for what is left placed');
    // Nothing by itself: a re-read and a reconcile with the leader unchanged buy nothing back.
    await rt.refreshFollower(FOLLOWER);
    await rt.reconcileAll();
    await wait(100);
    assert.equal(rec.orders().length, n0, 'no order: the copy does not "repair" the position by itself');
    // The leader trims to 0.8: the copy's target there (0.008) is above what is left, so nothing is sent either way.
    leaderSells('0.2');
    w.leader = [{ s: 'BTC-USD', sz: '0.8', ep: '80000' }];
    await wait(200);
    assert.equal(rec.orders().length, n0, 'a leader reduction to above what is left sends nothing (never buys back, never sells more)');
    // The leader adds to 1.6: the copy goes back to its target, 0.016 - the leader's add and the part SoDEX took.
    leaderBuys('0.8');
    w.leader = [{ s: 'BTC-USD', sz: '1.6', ep: '80000' }];
    assert.ok(await until(() => rec.orders().length === n0 + 1));
    assert.deepEqual([rec.orders().at(-1)!.side, rec.orders().at(-1)!.quantity, rec.orders().at(-1)!.leg], ['buy', '0.01', 'increase'], 'the add buys back to the target (0.006 + 0.01 = 0.016), within the copy\'s leverage room');
    assert.equal(notices.filter((n) => n.kind === 'closed').length, 0, 'not closed, so no "closed" notice');
  } finally {
    await rt.stop();
  }
});

test.todo('FINDING partial liquidation: a copied position SoDEX reduced (a partial liquidation, ADL, a part closed by hand) is adopted without a word - no activity line, no notice; telling it apart from a close of the copier\'s own whose fill the stream missed needs the copier to remember its recent reductions', async () => {
  const { w, rt, store, notices, s } = await holding({ id: 'liq-part-told' });
  try {
    w.follower = [{ s: 'BTC-USD', sz: '0.006', ep: '80000', l: 5, m: 'ISOLATED' }];
    await rt.refreshFollower(FOLLOWER);
    const said = (await store.activity({ subId: s.id })).some((e) => e.symbol === 'BTC-USD' && /outside|reduced|liquidat/i.test(e.detail ?? ''));
    assert.ok(said && notices.some((n) => n.ref === 'liq-part-told:BTC-USD'), 'the follower is told SoDEX took part of the copied position');
  } finally {
    await rt.stop();
  }
});

test.todo('FINDING stop-loss vs liquidation: a position liquidated past the copy\'s stop-loss level (its SoDEX stop did not fire: refused, cancelled, or the copier was down) is told as "Your stop-loss closed this copied position" (info) - closedWhy reads the mark only, not SoDEX\'s fills (a "liquidation:" clOrdID) or whether the copy\'s own stop filled', async () => {
  // Proportional at 5x, stop-loss at 50% of the margin: 10% under the entry, 72,000.
  const { w, rt, notices, s } = await holding({ id: 'liq-past-sl' });
  try {
    rt.markets.setMark('BTC-USD', 71_000);
    w.follower = [];
    await rt.refreshFollower(FOLLOWER);
    assert.deepEqual(notices.filter((n) => n.kind === 'closed').map((n) => n.grade), ['error'], 'a liquidation is an error, even past the stop-loss level');
    assert.equal(size(rt, s.id), 0);
  } finally {
    await rt.stop();
  }
});

/* ============================================================ the rest ===== */

test('a liquidation while the copy is paused or blocked is booked the same (the follower is told); the copy\'s status is left as it was', async () => {
  const { w, rt, notices, s } = await holding({ id: 'liq-paused' });
  try {
    await rt.pause(s.id);
    w.follower = [];
    await rt.refreshFollower(FOLLOWER);
    assert.equal(size(rt, s.id), 0);
    assert.deepEqual(notices.filter((n) => n.kind === 'closed').map((n) => n.grade), ['error']);
    assert.equal(rt.get(s.id)!.status, 'paused');
  } finally {
    await rt.stop();
  }
});

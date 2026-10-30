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
 * what SoDEX left, books the part that went, tells the follower (unless its own reduction
 * explains it), sends nothing by itself, and on the leader's next add goes back to its target.
 * Why it went is read from SoDEX's fills: a liquidation ("liquidation:" fill) is an error, the
 * copy's own stop (its client id filled) is info, and without a fill the stop is never named. A
 * runtime runs against a faked SoDEX (REST and the trade stream), as audit-copy.test.ts does. An
 * assertion or test that starts "BUG" failed before its fix (docs/TESTING-MATRIX.md names it).
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

/** SoDEX as the copier reads it: the leader's and the follower's positions (perps /state P[]), the marks, the builder approval, the follower's fills. */
interface World {
  leader: Array<{ s: string; sz: string; ep: string }>;
  follower: Pos[];
  marks: Record<string, number>;
  /** The follower's fills (GET .../trades); absent: the read fails (404). */
  fills?: Array<{ symbol: string; clOrdID: string; side: 'BUY' | 'SELL'; price: string; quantity: string; time: number }>;
  /** The follower's approved fee for the builder, tenths of a bp, per read (absent: 25; null: none). */
  approval?: () => number | null;
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
    if (path === `/api/v1/user/${FOLLOWER}/builders`) {
      const rate = w.approval ? w.approval() : 25;
      return ok({ perps: rate === null ? [] : [{ userID: FOLLOWER_ID, builderID: 9, feeRate: rate }], spot: [] });
    }
    if (path.startsWith(`/api/v1/perps/accounts/${FOLLOWER}/trades?`) && w.fills) return ok(w.fills);
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

/**
 * A live sink that records what it is asked to do: orders, leverage, stops (with their size) and cancels.
 * `refuse` answers an order as SoDEX refusing it (its error), or null to take it.
 */
function recordingSink(refuse?: (i: Intent) => string | null) {
  const placed: Intent[][] = [];
  const stops: Array<{ clOrdID: string; quantity: string; kind: string }> = [];
  const cancels: string[] = [];
  let leverage = 0;
  const sink: OrderSink = {
    paper: false,
    async place(_a, _m, intents): Promise<SendResult[]> {
      placed.push(intents);
      return intents.map((i) => {
        const error = refuse?.(i) ?? null;
        return { clOrdID: i.clOrdID, ok: !error, orderId: error ? null : '1', error, outcomeUnknown: false };
      });
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

function runtime(w: World, sink: OrderSink, store = new MemoryStore()) {
  const fetch = fakeFetch(w);
  const notices: EngineNotice[] = [];
  const rt = new CopyRuntime({
    confirmGapMs: 0,
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

/** SoDEX's takeover fill (its own, no order of the follower's) and a fill of one of the follower's orders, as GET .../trades lists them. */
const liquidationFill = (qty: string, price = '78800', s = 'BTC-USD') => ({ symbol: s, clOrdID: `liquidation:${++tid}`, side: 'SELL' as const, price, quantity: qty, time: Date.now() });
const fillOf = (clOrdID: string, qty: string, price: string, s = 'BTC-USD') => ({ symbol: s, clOrdID, side: 'SELL' as const, price, quantity: qty, time: Date.now() });
/** The copy's orders sent, no longer matched to the stream (as after PENDING_MS: their fills were missed). */
const forgetPending = (rt: CopyRuntime) => {
  for (const p of (rt as unknown as { pending: Array<{ until: number }> }).pending) p.until = 0;
};

const size = (rt: CopyRuntime, id: string, sym = 'BTC-USD') => rt.view(id)!.positions.find((p) => p.symbol === sym)?.size ?? 0;
/** The copy's SoDEX stops are placed 2 s after a fill (a timer); here at once. */
const placeStops = (rt: CopyRuntime, id: string, sym: string) => (rt as unknown as { refreshStops(id: string, s: string): Promise<void> }).refreshStops(id, sym);

async function ready(): Promise<void> {
  await until(() => sodexWs()?.readyState === 1);
  await wait(150); // the start-up reconciles settle
}

/** A live copy that holds 0.01 BTC copied from the leader's 1 BTC (proportional: $1,000 of the leader's $100,000), with its SoDEX stop-loss. */
async function holding(o: { id: string; settings?: Parameters<typeof sub>[0]; fills?: World['fills']; refuse?: (i: Intent) => string | null }) {
  const w = world({ fills: o.fills });
  const rec = recordingSink(o.refuse);
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

test('BUG partial liquidation: a copied position SoDEX made smaller (a partial liquidation, ADL, a part closed by hand) is told - an activity line and a notice - once; what the copy does next is unchanged', async () => {
  const { w, rec, rt, store, notices, s } = await holding({ id: 'liq-part-told' });
  try {
    const n0 = rec.orders().length;
    w.follower = [{ s: 'BTC-USD', sz: '0.006', ep: '80000', l: 5, m: 'ISOLATED' }];
    await rt.refreshFollower(FOLLOWER);
    assert.equal(size(rt, s.id), 0.006, 'the books follow SoDEX');
    const said = (await store.activity({ subId: s.id })).filter((e) => e.symbol === 'BTC-USD' && e.reason === 'reduced-outside');
    assert.equal(said.length, 1, 'one activity line');
    assert.match(said[0]!.detail ?? '', /^0\.004 of this copied position was closed outside the copier \(by you, or by SoDEX: a partial liquidation or ADL\); the copy holds the 0\.006 left\.$/);
    assert.equal(said[0]!.size, 0.004);
    const told = notices.filter((n) => n.ref === 'liq-part-told:BTC-USD');
    assert.deepEqual(told.map((n) => [n.source, n.kind, n.grade]), [['copy', 'reduced', 'warn']], 'the follower is told SoDEX took part of the copied position');
    // Told once: a re-read and a reconcile with nothing new say nothing more, and send nothing.
    await rt.refreshFollower(FOLLOWER);
    await rt.reconcileAll();
    await wait(100);
    assert.equal(notices.filter((n) => n.ref === 'liq-part-told:BTC-USD').length, 1);
    assert.equal(rec.orders().length, n0, 'no order: the copy does not "repair" the position by itself');
    assert.equal(notices.filter((n) => n.kind === 'closed').length, 0, 'not closed');
  } finally {
    await rt.stop();
  }
});

test('partial liquidation seen in SoDEX\'s fills ("liquidation:"): told as SoDEX liquidating part of the position, an error', async () => {
  const { w, rt, store, notices, s } = await holding({ id: 'liq-part-fill', fills: [] });
  try {
    w.fills = [liquidationFill('0.004')];
    w.follower = [{ s: 'BTC-USD', sz: '0.006', ep: '80000', l: 5, m: 'ISOLATED' }];
    await rt.refreshFollower(FOLLOWER);
    const said = (await store.activity({ subId: s.id })).find((e) => e.reason === 'reduced-outside');
    assert.equal(said?.detail, 'SoDEX liquidated 0.004 of this copied position; the copy holds the 0.006 left.');
    const told = notices.filter((n) => n.ref === 'liq-part-fill:BTC-USD');
    assert.deepEqual(told.map((n) => [n.kind, n.grade]), [['reduced', 'error']]);
    assert.match(told[0]!.title, /^BTC-USD partly liquidated in the copy of /);
  } finally {
    await rt.stop();
  }
});

test('a reduction of the copier\'s own whose fill the stream missed is not told as one made outside it; the part it does not explain is', async () => {
  const { w, rec, rt, store, notices, s } = await holding({ id: 'own-cut' });
  try {
    // The leader trims to 0.8: the copy sends its reduce-only 0.002, and the stream never shows the fill.
    leaderSells('0.2');
    w.leader = [{ s: 'BTC-USD', sz: '0.8', ep: '80000' }];
    assert.ok(await until(() => rec.orders().some((i) => i.leg === 'decrease')), 'the copy reduces');
    const cut = rec.orders().find((i) => i.leg === 'decrease')!;
    assert.deepEqual([cut.side, cut.reduceOnly, cut.quantity], ['sell', true, '0.002']);
    forgetPending(rt);
    w.follower = [{ s: 'BTC-USD', sz: '0.008', ep: '80000', l: 5, m: 'ISOLATED' }];
    await rt.refreshFollower(FOLLOWER);
    assert.equal(size(rt, s.id), 0.008, 'the books follow SoDEX');
    assert.equal((await store.activity({ subId: s.id })).filter((e) => e.reason === 'reduced-outside').length, 0, 'no "outside" line for its own reduction');
    assert.equal(notices.filter((n) => n.kind === 'reduced').length, 0, 'no notice');
    // Then SoDEX takes 0.003 more: that is told, and only that.
    w.follower = [{ s: 'BTC-USD', sz: '0.005', ep: '80000', l: 5, m: 'ISOLATED' }];
    await rt.refreshFollower(FOLLOWER);
    const said = (await store.activity({ subId: s.id })).filter((e) => e.reason === 'reduced-outside');
    assert.deepEqual(said.map((e) => e.size), [0.003]);
    assert.equal(notices.filter((n) => n.kind === 'reduced').length, 1);
  } finally {
    await rt.stop();
  }

  // Its own reduction missed and SoDEX's cut in one read: the part its order does not explain is told.
  const b = await holding({ id: 'own-cut-both' });
  try {
    leaderSells('0.2');
    b.w.leader = [{ s: 'BTC-USD', sz: '0.8', ep: '80000' }];
    assert.ok(await until(() => b.rec.orders().some((i) => i.leg === 'decrease')));
    forgetPending(b.rt);
    b.w.follower = [{ s: 'BTC-USD', sz: '0.006', ep: '80000', l: 5, m: 'ISOLATED' }];
    await b.rt.refreshFollower(FOLLOWER);
    const said = (await b.store.activity({ subId: b.s.id })).filter((e) => e.reason === 'reduced-outside');
    assert.deepEqual(said.map((e) => e.size), [0.002], 'only the 0.002 its order does not explain');
  } finally {
    await b.rt.stop();
  }

  // A reduction whose fill the stream did show explains nothing later: a cut after it is told whole.
  const c = await holding({ id: 'own-cut-seen' });
  try {
    leaderSells('0.2');
    c.w.leader = [{ s: 'BTC-USD', sz: '0.8', ep: '80000' }];
    assert.ok(await until(() => c.rec.orders().some((i) => i.leg === 'decrease')));
    sodexWs().push(print('SELL', '0.002', '80000', 1002, FOLLOWER_ID, 'BTC-USD'));
    assert.ok(await until(() => size(c.rt, c.s.id) === 0.008), 'its fill is booked from the stream');
    c.w.follower = [{ s: 'BTC-USD', sz: '0.006', ep: '80000', l: 5, m: 'ISOLATED' }];
    await c.rt.refreshFollower(FOLLOWER);
    const said = (await c.store.activity({ subId: c.s.id })).filter((e) => e.reason === 'reduced-outside');
    assert.deepEqual(said.map((e) => e.size), [0.002]);
  } finally {
    await c.rt.stop();
  }
});

test('BUG stop-loss vs liquidation: a position liquidated past the copy\'s stop-loss level (its SoDEX stop did not fire) is told as a liquidation, an error - from SoDEX\'s "liquidation:" fill, never from the mark', async () => {
  // Proportional at 5x, stop-loss at 50% of the margin: 10% under the entry, 72,000.
  const { w, rec, rt, store, notices, s } = await holding({ id: 'liq-past-sl', fills: [] });
  try {
    rt.markets.setMark('BTC-USD', 71_000);
    w.fills = [liquidationFill('0.01', '71000')];
    w.follower = [];
    await rt.refreshFollower(FOLLOWER);
    assert.equal(size(rt, s.id), 0);
    const told = notices.filter((n) => n.kind === 'closed');
    assert.deepEqual(told.map((n) => n.grade), ['error'], 'a liquidation is an error, even past the stop-loss level');
    assert.match(told[0]!.title, /^BTC-USD liquidated in the copy of /);
    const said = (await store.activity({ subId: s.id })).find((e) => e.kind === 'status' && e.symbol === 'BTC-USD');
    assert.deepEqual([said?.reason, said?.detail], ['closed-outside', 'SoDEX liquidated this copied position, so it was closed outside the copier. Its stops on SoDEX are cancelled; it resumes when the leader is flat.']);
    assert.ok(await until(() => rec.cancels.includes(rec.stops[0]!.clOrdID)), 'its stop-loss on SoDEX is cancelled');
  } finally {
    await rt.stop();
  }

  // SoDEX's fills not readable: past the stop's level it is still not told as the stop (that needs its fill).
  const b = await holding({ id: 'liq-past-sl-unread' });
  try {
    b.rt.markets.setMark('BTC-USD', 71_000);
    b.w.follower = [];
    await b.rt.refreshFollower(FOLLOWER);
    assert.deepEqual(b.notices.filter((n) => n.kind === 'closed').map((n) => n.grade), ['error']);
    assert.ok((await b.store.activity({ subId: b.s.id })).some((e) => e.reason === 'closed-outside' && /closed outside the copier \(by you, or by SoDEX\)/.test(e.detail ?? '')));
  } finally {
    await b.rt.stop();
  }
});

test('the copy\'s own SoDEX stop-loss filled (its client id in SoDEX\'s fills): told as its stop-loss, info; the leader\'s next add is skipped as after a stop', async () => {
  const { w, rec, rt, store, notices, s } = await holding({ id: 'own-sl', fills: [] });
  try {
    rt.markets.setMark('BTC-USD', 72_000);
    w.fills = [fillOf(rec.stops[0]!.clOrdID, '0.01', '72000')];
    w.follower = [];
    await rt.refreshFollower(FOLLOWER);
    assert.deepEqual(notices.filter((n) => n.kind === 'closed').map((n) => [n.grade, n.body]), [['info', 'Your stop-loss closed this copied position.']]);
    assert.ok((await store.activity({ subId: s.id })).some((e) => e.kind === 'status' && e.reason === 'stop-loss'));
    const n0 = rec.orders().length;
    leaderBuys('0.5');
    w.leader = [{ s: 'BTC-USD', sz: '1.5', ep: '80000' }];
    await wait(200);
    assert.equal(rec.orders().length, n0, 'not reopened while the leader holds');
    assert.ok((await store.activity({ subId: s.id })).some((e) => e.kind === 'skip' && e.reason === 'after-stop-loss'), 'skipped as after its stop-loss');
  } finally {
    await rt.stop();
  }

  // The mark at the stop's level but SoDEX's fills show someone else's close (by hand): closed outside, an error.
  const b = await holding({ id: 'by-hand-at-sl', fills: [] });
  try {
    b.rt.markets.setMark('BTC-USD', 72_000);
    b.w.fills = [fillOf('my-own-order', '0.01', '72000')];
    b.w.follower = [];
    await b.rt.refreshFollower(FOLLOWER);
    assert.deepEqual(b.notices.filter((n) => n.kind === 'closed').map((n) => n.grade), ['error']);
  } finally {
    await b.rt.stop();
  }
});

test('liquidated with no stop set: told as a liquidation (error), nothing to cancel on SoDEX', async () => {
  const { w, rec, rt, notices, s } = await holding({ id: 'liq-no-stop', settings: { stopLossPct: null, takeProfitPct: null }, fills: [] });
  try {
    assert.equal(rec.stops.length, 0, 'no stop rests on SoDEX');
    w.fills = [liquidationFill('0.01')];
    w.follower = [];
    await rt.refreshFollower(FOLLOWER);
    await wait(50);
    assert.equal(size(rt, s.id), 0);
    assert.deepEqual(notices.filter((n) => n.kind === 'closed').map((n) => [n.ref, n.grade]), [['liq-no-stop:BTC-USD', 'error']]);
    assert.match(notices.find((n) => n.kind === 'closed')!.body, /^SoDEX liquidated this copied position/);
    assert.equal(rec.cancels.length, 0, 'nothing cancelled');
  } finally {
    await rt.stop();
  }
});

test('liquidated in full while the copier was restarting: the next copier books it from the stored copy, tells it as a liquidation and cancels the stored stop', async () => {
  const { w, rec, rt, store, s } = await holding({ id: 'liq-restart', fills: [] });
  await rt.stop();
  // While no copier runs, SoDEX takes the position over.
  w.marks['BTC-USD'] = 78_800;
  w.follower = [];
  w.fills = [liquidationFill('0.01')];
  const next = runtime(w, rec.sink, store);
  try {
    await next.rt.start();
    assert.ok(await until(() => next.notices.some((n) => n.kind === 'closed')), 'told after the restart');
    assert.deepEqual(next.notices.filter((n) => n.kind === 'closed').map((n) => [n.ref, n.grade]), [['liq-restart:BTC-USD', 'error']]);
    assert.equal(size(next.rt, s.id), 0, 'the stored position is booked closed');
    assert.ok(await until(() => rec.cancels.includes(rec.stops[0]!.clOrdID)), 'the stop-loss the store kept is cancelled on SoDEX');
    assert.ok((await store.activity({ subId: s.id })).some((e) => e.reason === 'closed-outside' && /^SoDEX liquidated/.test(e.detail ?? '')));
  } finally {
    await next.rt.stop();
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

/* ===================================== SoDEX's reads disagree (2026-10-29) ===== */

/**
 * SoDEX's gateway answers an account from backends that disagree: on mainnet 2026-10-29 four of six
 * GET .../state reads seconds apart showed a BTC-USD position closed minutes before, with fresh marks
 * and equity, and nothing tells the backends apart. A change of the follower's position the copier did
 * not make is acted on only when two more reads agree on it; a position gone or smaller only with a
 * fill in SoDEX's trades that cut it (copy-engine confirm.ts, refreshFollower). `alternate` makes the
 * world answer each read of `key` from the next function in turn: a stale backend and a fresh one.
 */
function alternate<K extends 'follower' | 'leader'>(w: World, key: K, reads: Array<() => World[K]>): void {
  let n = 0;
  Object.defineProperty(w, key, {
    configurable: true,
    get: () => reads[n++ % reads.length]!(),
    // Set again by the test: one answer for every read from then on.
    set: (v: World[K]) => Object.defineProperty(w, key, { configurable: true, writable: true, enumerable: true, value: v }),
  });
}
const followerSold = (qty: string, s = 'BTC-USD', price = String(s === 'BTC-USD' ? 80_000 : 2_000)) => sodexWs().push(print('SELL', qty, price, 1002, FOLLOWER_ID, s));

test('stale: liquidated, but the reads alternate between a stale backend (still held) and a fresh one (flat): nothing is booked until they agree, then once', async () => {
  const { w, rec, rt, notices, s } = await holding({ id: 'stale-liq', fills: [] });
  try {
    const held = w.follower;
    w.fills = [liquidationFill('0.01')];
    alternate(w, 'follower', [() => [], () => held]);
    for (let i = 0; i < 3; i++) await rt.refreshFollower(FOLLOWER);
    assert.equal(size(rt, s.id), 0.01, 'the books hold the position while the reads disagree');
    assert.equal(notices.filter((n) => n.kind === 'closed').length, 0, 'nothing told');
    assert.equal(rec.cancels.length, 0, 'its stop-loss stays on SoDEX');
    // The backends agree: flat.
    w.follower = [];
    await rt.refreshFollower(FOLLOWER);
    assert.equal(size(rt, s.id), 0);
    assert.deepEqual(notices.filter((n) => n.kind === 'closed').map((n) => n.grade), ['error'], 'told once, as a liquidation');
    assert.ok(await until(() => rec.cancels.includes(rec.stops[0]!.clOrdID)), 'and its stop-loss cancelled');
  } finally {
    await rt.stop();
  }
});

test('stale: a backend that missed the opening fill reads flat while SoDEX holds the position (no fill cut it): never booked closed, its stop-loss never cancelled, nothing told', async () => {
  const { w, rec, rt, store, notices, s } = await holding({ id: 'stale-flat', fills: [] });
  try {
    const held = w.follower;
    // Every other read stale: disagree.
    alternate(w, 'follower', [() => [], () => held]);
    for (let i = 0; i < 3; i++) await rt.refreshFollower(FOLLOWER);
    // Every read stale (they agree), but SoDEX's trades hold no fill that cut the position.
    w.follower = [];
    for (let i = 0; i < 3; i++) await rt.refreshFollower(FOLLOWER);
    assert.equal(size(rt, s.id), 0.01, 'the copy still holds it');
    assert.equal(rec.cancels.length, 0, 'its stop-loss is not cancelled');
    assert.equal(notices.length, 0, 'nothing told');
    assert.ok(!(await store.activity({ subId: s.id })).some((e) => e.kind === 'status' && e.symbol === 'BTC-USD'), 'no "closed outside" line');
    // The fresh backend again: nothing to do, and the leader's close is still copied from the books.
    w.follower = held;
    await rt.refreshFollower(FOLLOWER);
    const n0 = rec.orders().length;
    leaderSells('1');
    w.leader = [];
    assert.ok(await until(() => rec.orders().length === n0 + 1), 'the leader\'s close is copied');
    assert.deepEqual([rec.orders().at(-1)!.side, rec.orders().at(-1)!.reduceOnly], ['sell', true]);
  } finally {
    await rt.stop();
  }
});

test('stale: a backend that shows the position larger (before a close of the copier\'s the stream showed) or smaller (before an add) is never adopted - no doubling, no shrinking, nothing told', async () => {
  const { w, rec, rt, notices, s } = await holding({ id: 'stale-size', fills: [] });
  try {
    const held = w.follower;
    const as = (sz: string) => [{ ...held[0]!, sz }];
    const n0 = rec.orders().length;
    const stops0 = rec.stops.length;
    alternate(w, 'follower', [() => as('0.02'), () => held]);
    for (let i = 0; i < 3; i++) await rt.refreshFollower(FOLLOWER);
    assert.equal(size(rt, s.id), 0.01, 'not doubled');
    alternate(w, 'follower', [() => as('0.005'), () => held]);
    for (let i = 0; i < 3; i++) await rt.refreshFollower(FOLLOWER);
    assert.equal(size(rt, s.id), 0.01, 'not shrunk');
    // Smaller on every read, but no fill in SoDEX's trades cut it: still not.
    w.follower = as('0.005');
    await rt.refreshFollower(FOLLOWER);
    assert.equal(size(rt, s.id), 0.01, 'not shrunk without a fill');
    assert.equal(notices.length, 0);
    await wait(2_200); // the copy's stops are resized 2 s after a change: none came
    assert.equal(rec.stops.length, stops0, 'its stop-loss not resized');
    assert.equal(rec.orders().length, n0, 'nothing sent');
    // A part closed by hand, in SoDEX's fills: now it is told, once.
    w.fills = [fillOf('by-hand-1', '0.005', '80000')];
    await rt.refreshFollower(FOLLOWER);
    assert.equal(size(rt, s.id), 0.005);
    assert.deepEqual(notices.filter((n) => n.kind === 'reduced').map((n) => n.grade), ['warn'], 'by hand: a warning');
    // Larger on every read (an add by hand): adopted, as before - three reads agree.
    w.follower = as('0.008');
    await rt.refreshFollower(FOLLOWER);
    assert.equal(size(rt, s.id), 0.008);
  } finally {
    await rt.stop();
  }
});

test('stale: a SoDEX leader read from a backend that still shows a position it closed is not reconciled - the copy is never reopened', async () => {
  const { w, rec, rt, s } = await holding({ id: 'stale-leader', fills: [] });
  try {
    const n0 = rec.orders().length;
    // The leader closes on the stream; the copy closes, and its fill is on the stream.
    leaderSells('1');
    w.leader = [];
    assert.ok(await until(() => rec.orders().length === n0 + 1), 'the close is copied');
    followerSold(rec.orders().at(-1)!.quantity);
    assert.ok(await until(() => size(rt, s.id) === 0), 'and booked');
    w.follower = [];
    // Reconciles read the leader from both backends: the stale one shows the 1 BTC it closed.
    alternate(w, 'leader', [() => [{ s: 'BTC-USD', sz: '1', ep: '80000' }], () => []]);
    for (let i = 0; i < 4; i++) {
      await rt.reconcileAll();
      await wait(20);
    }
    assert.equal(rec.orders().length, n0 + 1, 'nothing reopened');
    assert.equal(size(rt, s.id), 0);
  } finally {
    await rt.stop();
  }
});

test('stale: stopped with "close", a read shows the position flat before the stream shows the close filled, the next read held: not taken as closed, its stop-loss kept', async () => {
  const { w, rec, rt, s } = await holding({ id: 'stale-stop', fills: [] });
  try {
    const held = w.follower;
    alternate(w, 'follower', [() => [], () => held]);
    const stopped = await rt.stopCopy(s.id, { close: true });
    assert.equal(stopped.status, 'stopped');
    assert.match(stopped.statusReason ?? '', /not confirmed closed: BTC-USD/);
    assert.ok(!rec.cancels.includes(rec.stops[0]!.clOrdID), 'its stop-loss stays on SoDEX');
  } finally {
    await rt.stop();
  }
});

test('stale: an active copy whose builder approval one read misses stays active; reads that all miss it block it', async () => {
  const { w, rt, s } = await holding({ id: 'stale-approval', fills: [] });
  try {
    let n = 0;
    w.approval = () => (n++ % 2 === 0 ? null : 25);
    await rt.checkReady(rt.get(s.id)!);
    assert.equal(rt.get(s.id)!.status, 'active', 'one stale read does not block it');
    w.approval = () => null;
    await rt.checkReady(rt.get(s.id)!);
    assert.equal(rt.get(s.id)!.status, 'blocked');
    assert.match(rt.get(s.id)!.statusReason ?? '', /does not approve the ValueDesk copy fee/);
  } finally {
    await rt.stop();
  }
});

test('stale: right after the copy\'s own close, a read still showing the position is not the follower\'s own - the leader\'s next open is copied', async () => {
  // Live run 2026-10-29 (copy.size-change): the copy closed with the leader, a read 5 s later still showed
  // the position, and the leader's next buy was skipped as the follower's own position.
  const { w, rec, rt, store, s } = await holding({ id: 'stale-own-close' });
  try {
    const held = size(rt, s.id);
    leaderSells('1');
    w.leader = [];
    assert.ok(await until(() => rec.placed.length === 2), 'the copy closes with the leader');
    sodexWs().push(print('SELL', String(held), '80000', 1002, FOLLOWER_ID, 'BTC-USD'));
    assert.ok(await until(() => size(rt, s.id) === 0), 'its fill closed the books');
    // SoDEX's account read lags: every read still shows the position the copy just closed.
    await rt.refreshFollower(FOLLOWER);
    leaderBuys('1');
    w.leader = [{ s: 'BTC-USD', sz: '1', ep: '80000' }];
    assert.ok(await until(() => rec.placed.length === 3), 'the leader\'s next open is copied');
    assert.ok(!(await store.activity({ subId: s.id })).some((e) => e.kind === 'skip' && e.reason === 'own-position'), 'never skipped as the follower\'s own');
  } finally {
    await rt.stop();
  }
});

/* ======================= the copy's own stop fires on SoDEX (2026-10-29) ===== */

/**
 * Live run 2026-10-29 (copy.tp-fires, self-hosted executor): the copy's SoDEX stop fired, and the copier
 * did not notice. Its fill came on the stream as a taker fill of the follower's that matched no order of
 * the copier's (dropped); the copier's own guard then sent a reduce-only close, which SoDEX refused with
 * "position not found: 1"; the reads disagreed (a stale backend still showed the position), so nothing
 * was adopted; and the leader's next add was copied as an increase, where it must be skipped after the
 * stop. The copier's own evidence - the stop's fill, SoDEX's refusal - moves the books now, never a read.
 */
const notFound = (i: Intent) => (i.reduceOnly ? 'position not found: 1' : null);

test('BUG live run 2026-10-29: the copy\'s own stop-loss fills on the stream (no order of the copier\'s), the reads disagree, the leader adds: booked closed at once, the add skipped as after the stop, no increase sent', async () => {
  // Proportional at 5x, stop-loss at 50% of the margin: 72,000.
  const { w, rec, rt, store, notices, s } = await holding({ id: 'own-sl-stream', fills: [] });
  try {
    const held = w.follower;
    const sl = rec.stops[0]!.clOrdID;
    const n0 = rec.orders().length;
    // SoDEX fires the stop: the follower sells 0.01 as taker at 71,990; no order of the copier's is in flight.
    followerSold('0.01', 'BTC-USD', '71990');
    assert.ok(await until(() => size(rt, s.id) === 0), 'BUG: the stop\'s own fill closes the copied position in the books at once');
    assert.ok(Math.abs(rt.view(s.id)!.realizedPnl - 0.01 * (71_990 - 80_000)) < 1e-9, `booked at the fill price (${rt.view(s.id)!.realizedPnl})`);
    assert.ok(await until(() => notices.some((n) => n.kind === 'closed')));
    assert.deepEqual(notices.filter((n) => n.kind === 'closed').map((n) => [n.grade, n.body]), [['info', 'Your stop-loss closed this copied position.']]);
    assert.ok((await store.activity({ subId: s.id })).some((e) => e.kind === 'status' && e.reason === 'stop-loss'), 'its activity says its stop-loss closed it');
    assert.ok(await until(() => rec.cancels.includes(sl)), 'its stop on SoDEX is let go with the position');
    // SoDEX's reads disagree (a stale backend still shows the position) and its trades lag: nothing new there.
    alternate(w, 'follower', [() => held, () => []]);
    await rt.refreshFollower(FOLLOWER);
    assert.equal(size(rt, s.id), 0, 'a stale read does not reopen it');
    // The leader adds: skipped after the stop, nothing sent.
    leaderBuys('0.5');
    w.leader = [{ s: 'BTC-USD', sz: '1.5', ep: '80000' }];
    await wait(300);
    assert.equal(rec.orders().length, n0, 'BUG: no increase is sent after the copy\'s own stop fired');
    assert.ok((await store.activity({ subId: s.id })).some((e) => e.kind === 'skip' && e.reason === 'after-stop-loss'), 'BUG: the add is skipped as after its stop-loss');
    // Every read stale now (they agree on the closed position): still not adopted back, nothing told as outside.
    w.follower = held;
    await rt.refreshFollower(FOLLOWER);
    assert.equal(size(rt, s.id), 0, 'never reopened, doubled or shrunk by a stale read');
    const lines = await store.activity({ subId: s.id });
    assert.ok(!lines.some((e) => e.reason === 'reduced-outside' || e.reason === 'closed-outside'), 'the books are not confused: nothing "outside"');
    assert.equal(notices.filter((n) => n.kind === 'closed' || n.kind === 'reduced').length, 1, 'told once');
  } finally {
    await rt.stop();
  }
});

test('BUG SoDEX refuses the copier\'s close with "position not found" (its stop fired, the stream missed the fill): booked flat at once, told as its stop-loss from SoDEX\'s trades, never sent again; the leader\'s next add is skipped', async () => {
  const { w, rec, rt, store, notices, s } = await holding({ id: 'refused-nf', fills: [], refuse: notFound });
  try {
    const held = w.follower;
    const sl = rec.stops[0]!.clOrdID;
    // SoDEX's trades show the stop's fill; its reads disagree.
    w.fills = [fillOf(sl, '0.01', '71900')];
    alternate(w, 'follower', [() => held, () => []]);
    // The mark past the stop-loss: the copier's own guard closes too, and SoDEX refuses (the position is gone).
    rt.markets.setMark('BTC-USD', 71_900);
    assert.ok(await until(() => rec.orders().some((i) => i.leg === 'stop-loss'), 4_000), 'the copier\'s guard sends its stop-loss close');
    assert.ok(await until(() => size(rt, s.id) === 0), 'BUG: SoDEX\'s refusal books the market flat');
    assert.ok((await store.activity({ subId: s.id })).some((e) => e.kind === 'error' && e.reason === 'rejected' && /position not found/.test(e.detail ?? '')), 'the refusal is in the activity');
    assert.ok(await until(() => notices.some((n) => n.kind === 'closed')));
    assert.deepEqual(notices.filter((n) => n.kind === 'closed').map((n) => [n.grade, n.body]), [['info', 'Your stop-loss closed this copied position.']], 'told as its stop-loss, from SoDEX\'s trades');
    assert.ok(Math.abs(rt.view(s.id)!.realizedPnl - 0.01 * (71_900 - 80_000)) < 1e-9, `booked at the stop's fill price (${rt.view(s.id)!.realizedPnl})`);
    assert.ok(await until(() => rec.cancels.includes(sl)));
    // A guard pass and a reconcile later: the close is not sent again.
    await wait(2_300);
    await rt.reconcileAll();
    await wait(100);
    assert.equal(rec.orders().filter((i) => i.reduceOnly).length, 1, 'BUG: the refused close is not sent again');
    // The leader adds: skipped after the stop.
    const n0 = rec.orders().length;
    leaderBuys('0.5');
    w.leader = [{ s: 'BTC-USD', sz: '1.5', ep: '80000' }];
    await wait(300);
    assert.equal(rec.orders().length, n0, 'BUG: no increase is sent');
    assert.ok((await store.activity({ subId: s.id })).some((e) => e.kind === 'skip' && e.reason === 'after-stop-loss'), 'the add is skipped as after its stop-loss');
    // Reads that all show the position now (stale) are not adopted back.
    w.follower = held;
    await rt.refreshFollower(FOLLOWER);
    assert.equal(size(rt, s.id), 0);
  } finally {
    await rt.stop();
  }

  // The leader's reduction refused the same way, SoDEX's trades showing nothing yet: flat, closed outside, not sent again.
  const b = await holding({ id: 'refused-nf-cut', fills: [], refuse: notFound });
  try {
    const n0 = b.rec.orders().length;
    leaderSells('0.5');
    b.w.leader = [{ s: 'BTC-USD', sz: '0.5', ep: '80000' }];
    assert.ok(await until(() => size(b.rt, b.s.id) === 0), 'BUG: booked flat on the refusal');
    assert.equal(b.rec.orders().length, n0 + 1);
    assert.ok(await until(() => b.notices.some((n) => n.kind === 'closed')));
    assert.deepEqual(b.notices.filter((n) => n.kind === 'closed').map((n) => n.grade), ['error'], 'no fill names the stop: closed outside, an error');
    leaderBuys('0.5');
    b.w.leader = [{ s: 'BTC-USD', sz: '1', ep: '80000' }];
    await wait(300);
    assert.equal(b.rec.orders().length, n0 + 1, 'nothing sent again, nothing added');
    assert.ok((await b.store.activity({ subId: b.s.id })).some((e) => e.kind === 'skip' && e.reason === 'own-position'));
  } finally {
    await b.rt.stop();
  }
});

test('BUG the copy\'s take-profit fires on SoDEX, filled in two prints on the stream: booked at their price, told as its take-profit (info), its stop-loss cancelled, the leader\'s next add skipped as after a take-profit', async () => {
  // Take-profit at 50% of the margin at 5x: 88,000; the stop-loss at 72,000.
  const { w, rec, rt, store, notices, s } = await holding({ id: 'own-tp-stream', settings: { takeProfitPct: 0.5 }, fills: [] });
  try {
    assert.deepEqual(rec.stops.map((x) => x.kind), ['stop-loss', 'take-profit']);
    const [sl, tp] = [rec.stops[0]!.clOrdID, rec.stops[1]!.clOrdID];
    const n0 = rec.orders().length;
    followerSold('0.004', 'BTC-USD', '88010');
    await wait(50);
    assert.equal(size(rt, s.id), 0.01, 'a part of the stop\'s size is not booked yet');
    followerSold('0.006', 'BTC-USD', '88020');
    assert.ok(await until(() => size(rt, s.id) === 0), 'BUG: the take-profit\'s fill closes the copied position in the books');
    const pnl = 0.004 * 8_010 + 0.006 * 8_020;
    assert.ok(Math.abs(rt.view(s.id)!.realizedPnl - pnl) < 1e-6, `booked at the prints' price (${rt.view(s.id)!.realizedPnl})`);
    assert.ok(await until(() => notices.some((n) => n.kind === 'closed')));
    assert.deepEqual(notices.filter((n) => n.kind === 'closed').map((n) => [n.grade, n.body]), [['info', 'Your take-profit closed this copied position.']]);
    assert.ok((await store.activity({ subId: s.id })).some((e) => e.kind === 'status' && e.reason === 'take-profit'));
    assert.ok(await until(() => rec.cancels.includes(sl)), 'its stop-loss on SoDEX is cancelled');
    assert.ok(rec.cancels.includes(tp));
    leaderBuys('0.5');
    w.leader = [{ s: 'BTC-USD', sz: '1.5', ep: '80000' }];
    await wait(300);
    assert.equal(rec.orders().length, n0, 'BUG: no increase is sent');
    assert.ok((await store.activity({ subId: s.id })).some((e) => e.kind === 'skip' && e.reason === 'after-take-profit'), 'BUG: skipped as after its take-profit');
  } finally {
    await rt.stop();
  }
});

test('a closing print of the follower\'s away from both of the copy\'s stops (a close by hand), or larger than them, is not taken as its stop: left to the reads and SoDEX\'s trades', async () => {
  const { rt, notices, s } = await holding({ id: 'by-hand-print', settings: { takeProfitPct: 0.5 }, fills: [] });
  try {
    followerSold('0.01', 'BTC-USD', '80000');
    await wait(100);
    assert.equal(size(rt, s.id), 0.01, 'not booked from the stream');
    followerSold('0.02', 'BTC-USD', '71000');
    await wait(100);
    assert.equal(size(rt, s.id), 0.01);
    assert.equal(notices.length, 0);
  } finally {
    await rt.stop();
  }
});

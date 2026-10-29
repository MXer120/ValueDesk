/**
 * Edge cases of copy trading (planner.ts, runtime.ts) a tester would otherwise
 * meet first (docs/TESTING-MATRIX.md has the whole list): a leader flip whose
 * new side is under SoDEX's minimum, ADL on the leader's side and on the
 * follower's, a market halted or delisted while a copy holds it (delisted: left
 * as it is, and the follower told once), SoDEX down
 * when the leader closes, and the builder approval lowered under the fee
 * mid-run. The planner tests are pure; the runtime ones run a copier against
 * a faked SoDEX (REST and the trade stream), as runtime.test.ts does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CopyRuntime,
  HyperliquidClient,
  MemoryStore,
  PaperSink,
  SodexClient,
  planLeaderEvent,
  regionPolicy,
  type FetchLike,
  type EngineNotice,
  type Intent,
  type OrderSink,
  type PlanContext,
  type SendResult,
  type Subscription,
  type WebSocketLike,
} from '../src/index.ts';
import { BTC, FOLLOWER, LEADER, ev, marks, state, sub } from './helpers.ts';

/* ============================================================ planner ===== */

const ctx = (o: Partial<PlanContext> & Pick<PlanContext, 'event'>): PlanContext => ({
  sub: sub(),
  state: state(),
  market: BTC,
  markOf: marks({ 'BTC-USD': 80_000 }),
  policy: { maxLeverage: null },
  heldBy: 'nobody',
  follower: null,
  ...o,
});
const holding = (size: number) => state({ owned: { 'BTC-USD': { size, entry: 80_000, openedAt: 1 } } });
const legs = (p: { intents: Intent[] }) => p.intents.map((i) => [i.leg, i.side, i.quantity, i.reduceOnly]);

test('leader flip whose new side is under SoDEX\'s minimum: the copy is closed whole, nothing opens, it is never left on the old side', () => {
  // The leader goes from 1 BTC long to 0.001 BTC short: the copy of that short is about $0.80.
  const p = planLeaderEvent(ctx({ state: holding(0.01), event: ev('BTC-USD', 1, -0.001, 80_000) }));
  assert.deepEqual(legs(p), [['flip-close', 'sell', '0.01', true]]);
  assert.ok(p.skip, 'the open is skipped, and said');
  assert.equal(p.leaderAfter, -0.001);
});

test('leader ADL (SoDEX cut the leader\'s position, no trade of theirs): the copy follows the cut by the same fraction, reduce-only', () => {
  const p = planLeaderEvent(ctx({ state: holding(0.01), event: { ...ev('BTC-USD', 1, 0.6, 80_000), source: 'reconcile' } }));
  assert.deepEqual(legs(p), [['decrease', 'sell', '0.004', true]]);
});

test('follower ADL (SoDEX cut the copy, the books follow it): the leader\'s close closes what is held, not what was copied', () => {
  // refreshFollower books SoDEX's size: 0.01 copied, 0.0035 left after the ADL.
  const p = planLeaderEvent(ctx({ state: holding(0.0035), event: ev('BTC-USD', 1, 0, 80_000) }));
  assert.deepEqual(legs(p), [['close', 'sell', '0.0035', true]]);
});

test('a market halted or delisted while the leader trades it: nothing is sent into it, and the skip says why', () => {
  const halted = planLeaderEvent(ctx({ state: holding(0.01), market: { ...BTC, status: 'HALT' }, event: ev('BTC-USD', 1, 0, 80_000) }));
  assert.equal(halted.intents.length, 0);
  assert.equal(halted.skip, 'market-halted');
  const gone = planLeaderEvent(ctx({ state: holding(0.01), market: null, event: ev('BTC-USD', 1, 0, 80_000) }));
  assert.equal(gone.intents.length, 0);
  assert.equal(gone.skip, 'not-on-sodex');
});

test('US close-only and the EEA 2x cap, decided mid-run: a blocked copy still follows the close; an EEA one opens at 2x at most', () => {
  const blocked = planLeaderEvent(ctx({ sub: sub({}, { status: 'blocked' }), state: holding(0.01), policy: regionPolicy('US', null), event: ev('BTC-USD', 1, 0, 80_000) }));
  assert.deepEqual(legs(blocked), [['close', 'sell', '0.01', true]]);
  const add = planLeaderEvent(ctx({ sub: sub({}, { status: 'blocked' }), state: holding(0.01), policy: regionPolicy('US', null), event: ev('BTC-USD', 1, 2, 80_000) }));
  assert.equal(add.intents.length, 0, 'close-only: an add is not copied');
  // EEA: $1,000 copied at most 2x = $2,000 of exposure, whatever the follower's own cap says.
  const eea = planLeaderEvent(ctx({ sub: sub({ maxLeverage: 10, sizingMode: 'fixedNotional', fixedNotionalUsd: 5_000 }), policy: regionPolicy('DE', null), event: ev('BTC-USD', 0, 1, 80_000) }));
  assert.ok(eea.intents.length === 1 && Number(eea.intents[0]!.quantity) * 80_000 <= 2_000 + 1e-6, `opened ${eea.intents[0]?.quantity}`);
});

/* ============================================================ runtime ===== */

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

interface World {
  leader: Array<{ s: string; sz: string; ep: string }>;
  builderRate: number | null;
  status: string;
  /** SoDEX lists only ETH-USD (BTC-USD delisted). */
  delisted?: boolean;
}

function fakeFetch(w: World): FetchLike {
  const ok = (data: unknown) => ({ status: 200, ok: true, text: async () => JSON.stringify({ code: 0, timestamp: Date.now(), data }) });
  return async (url) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/v1/perps/markets/symbols') {
      const row = (id: number, name: string, base: string) => ({ id, name, baseCoin: base, tickSize: '1', stepSize: '0.00001', minQuantity: '0.00001', maxQuantity: '1000', minNotional: '10', maxNotional: '5000000', maxLeverage: 50, buyLimitUpRatio: '0.05', sellLimitDownRatio: '0.05', takerFee: '0.0004', status: name === 'BTC-USD' ? w.status : 'TRADING' });
      return ok(w.delisted ? [row(2, 'ETH-USD', 'ETH')] : [row(1, 'BTC-USD', 'BTC'), row(2, 'ETH-USD', 'ETH')]);
    }
    if (path === '/api/v1/perps/markets/mark-prices') return ok([{ symbol: 'BTC-USD', markPrice: '80000' }]);
    if (path === `/api/v1/user/${LEADER}/subaccounts`) return ok({ primaryAccountID: LEADER_ID });
    if (path === `/api/v1/perps/accounts/${LEADER}/state`) return ok({ aid: LEADER_ID, av: '100000', P: w.leader });
    if (path === `/api/v1/perps/accounts/${FOLLOWER}/state`) return ok({ aid: FOLLOWER_ID, av: '5000', am: '5000', P: [] });
    if (path === `/api/v1/user/${FOLLOWER}/builders`) return ok({ perps: w.builderRate === null ? [] : [{ userID: FOLLOWER_ID, builderID: 9, feeRate: w.builderRate }], spot: [] });
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

function runtime(w: World, sinkFor: (s: Subscription) => OrderSink | null, notices: EngineNotice[] = []) {
  const store = new MemoryStore();
  const rt = new CopyRuntime({
    store,
    sodex: new SodexClient({ network: 'mainnet', fetch: fakeFetch(w) }),
    hyperliquid: new HyperliquidClient(fakeFetch(w)),
    factory: (url) => new FakeWs(url),
    network: 'mainnet',
    hlMode: 'user',
    sinkFor,
    builderFor: async () => ({ id: 9, fee: 25 }),
    policyFor: (s) => regionPolicy(s.country, s.observedCountry),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    onNotice: (n) => notices.push(n),
  });
  return { rt, store };
}

const sodexWs = () => FakeWs.all.filter((x) => x.url.endsWith('/ws/perps')).at(-1)!;
let tid = 5_000;
const print = (side: 'BUY' | 'SELL', qty: string, bi: number, si: number) => ({ channel: 'trade', type: 'update', data: [{ E: Date.now(), T: Date.now(), t: ++tid, s: 'BTC-USD', S: side, p: '80000', q: qty, bi, si }] });
const leaderBuys = (qty: string) => sodexWs().push(print('BUY', qty, LEADER_ID, 1002));
const leaderSells = (qty: string) => sodexWs().push(print('SELL', qty, 1002, LEADER_ID));
const size = (rt: CopyRuntime, id: string) => rt.view(id)!.positions.find((p) => p.symbol === 'BTC-USD')?.size ?? 0;
const reloadMarkets = (rt: CopyRuntime) => (rt as unknown as { loadMarkets(): Promise<void> }).loadMarkets();

async function ready(): Promise<void> {
  await until(() => sodexWs()?.readyState === 1);
  await wait(150);
}

/** Paper, but SoDEX can be "down": every order then throws as fetch does. */
function flakyPaper(): { sink: OrderSink; down: { on: boolean } } {
  const inner = new PaperSink();
  const down = { on: false };
  return {
    down,
    sink: {
      paper: true,
      async place(a, m, intents, b, ref) {
        if (down.on) throw new Error('fetch failed (SoDEX unreachable)');
        return inner.place(a, m, intents, b, ref);
      },
      setLeverage: () => inner.setLeverage(),
      placeStop: (a, m, s) => inner.placeStop(a, m, s),
      cancel: () => inner.cancel(),
    },
  };
}

test('leader ADL seen only on REST (no trade print): the next reconcile copies the cut, reduce-only', async () => {
  const w: World = { leader: [], builderRate: 25, status: 'TRADING' };
  const { rt } = runtime(w, () => new PaperSink());
  await rt.start();
  try {
    const s = await rt.add(sub({ paper: true }, { id: 'adl1' }));
    await ready();
    leaderBuys('1');
    w.leader = [{ s: 'BTC-USD', sz: '1', ep: '80000' }];
    assert.ok(await until(() => size(rt, s.id) === 0.01));
    w.leader = [{ s: 'BTC-USD', sz: '0.6', ep: '80000' }]; // SoDEX auto-deleveraged 0.4
    await rt.reconcileAll();
    assert.ok(await until(() => Math.abs(size(rt, s.id) - 0.006) < 1e-12), `the copy holds ${size(rt, s.id)}, want 0.006`);
  } finally {
    await rt.stop();
  }
});

test('a leader close while the market is halted is not sent into the halt; once SoDEX trades it again the reconcile closes the copy', async () => {
  const w: World = { leader: [], builderRate: 25, status: 'TRADING' };
  const { rt, store } = runtime(w, () => new PaperSink());
  await rt.start();
  try {
    const s = await rt.add(sub({ paper: true }, { id: 'halt1' }));
    await ready();
    leaderBuys('1');
    w.leader = [{ s: 'BTC-USD', sz: '1', ep: '80000' }];
    assert.ok(await until(() => size(rt, s.id) === 0.01));
    w.status = 'HALT';
    await reloadMarkets(rt);
    leaderSells('1');
    w.leader = [];
    await wait(200);
    assert.equal(size(rt, s.id), 0.01, 'skipped while halted');
    assert.ok((await store.activity({ subId: s.id })).some((x) => x.reason === 'market-halted'), 'the skip is in its activity');
    w.status = 'TRADING';
    await reloadMarkets(rt);
    await rt.reconcileAll();
    assert.ok(await until(() => size(rt, s.id) === 0, 1500), `the copy still holds ${size(rt, s.id)} after the halt`);
  } finally {
    await rt.stop();
  }
});

test('delisted: a copy that still holds a position on a market SoDEX no longer lists is not closed or traded by the copier (a delisting is the follower\'s to act on), and the follower is told once', async () => {
  const w: World = { leader: [], builderRate: 25, status: 'TRADING' };
  const notices: EngineNotice[] = [];
  const { rt, store } = runtime(w, () => new PaperSink(), notices);
  await rt.start();
  try {
    const s = await rt.add(sub({ paper: true }, { id: 'gone1' }));
    await ready();
    leaderBuys('1');
    w.leader = [{ s: 'BTC-USD', sz: '1', ep: '80000' }];
    assert.ok(await until(() => size(rt, s.id) === 0.01));
    w.delisted = true;
    w.leader = [];
    await reloadMarkets(rt);
    await rt.reconcileAll();
    await wait(300);
    assert.equal(size(rt, s.id), 0.01, 'the copier leaves the position as it is');
    const said = (await store.activity({ subId: s.id })).filter((x) => x.kind === 'status' && x.reason === 'delisted');
    assert.equal(said.length, 1, 'a line in the copy\'s activity');
    assert.match(said[0]!.detail ?? '', /^BTC-USD is no longer listed on SoDEX\. The copy still holds a long position of 0\.01 there, and ValueDesk will not trade it any more/);
    const told = notices.filter((n) => n.kind === 'delisted');
    assert.deepEqual(told.map((n) => [n.grade, n.ref, n.title]), [['warn', 'gone1:BTC-USD', 'BTC-USD is no longer listed on SoDEX (copy of 0x1111…1111)']]);
    // The leader's close there is a "Not copied" line, not another notice: the delisting already said it.
    assert.ok((await store.activity({ subId: s.id })).some((x) => x.kind === 'skip' && x.reason === 'not-on-sodex'));
    assert.equal(notices.filter((n) => n.kind === 'not-copied').length, 0);
    // The next reads of the list do not tell it again.
    await reloadMarkets(rt);
    await reloadMarkets(rt);
    assert.equal(notices.filter((n) => n.kind === 'delisted').length, 1, 'told once');
    // Listed again, it is an ordinary market once more: the copy follows its leader (flat) and closes it.
    w.delisted = false;
    await reloadMarkets(rt);
    await rt.reconcileAll();
    assert.ok(await until(() => size(rt, s.id) === 0, 1500), `the copy still holds ${size(rt, s.id)} once SoDEX lists it again`);
  } finally {
    await rt.stop();
  }
});

test('SoDEX down when the leader closes: nothing is booked as closed; when SoDEX answers again the reconcile closes the copy once', async () => {
  const w: World = { leader: [], builderRate: 25, status: 'TRADING' };
  const flaky = flakyPaper();
  const { rt, store } = runtime(w, () => flaky.sink);
  await rt.start();
  try {
    const s = await rt.add(sub({ paper: true }, { id: 'down1' }));
    await ready();
    leaderBuys('1');
    w.leader = [{ s: 'BTC-USD', sz: '1', ep: '80000' }];
    assert.ok(await until(() => size(rt, s.id) === 0.01));
    flaky.down.on = true;
    leaderSells('1');
    w.leader = [];
    await wait(200);
    assert.equal(size(rt, s.id), 0.01, 'the close did not go out: still held in the books');
    await rt.reconcileAll(); // still down
    await wait(100);
    assert.equal(size(rt, s.id), 0.01);
    flaky.down.on = false;
    await rt.reconcileAll();
    assert.ok(await until(() => size(rt, s.id) === 0, 1500), `the copy still holds ${size(rt, s.id)}`);
    const closes = (await store.activity({ subId: s.id })).filter((x) => x.kind === 'fill' && x.reduceOnly);
    assert.equal(closes.length, 1, 'closed once, never twice');
  } finally {
    await rt.stop();
  }
});

test('builder approval lowered under the fee mid-run: the copy is blocked, adds are not copied, the leader\'s close still is (reduce-only)', async () => {
  const w: World = { leader: [], builderRate: 25, status: 'TRADING' };
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
  try {
    const s = await rt.add(sub({}, { id: 'bld1' }));
    assert.equal(rt.get(s.id)!.status, 'active');
    await ready();
    leaderBuys('1');
    assert.ok(await until(() => sent.length === 1));
    sodexWs().push(print('BUY', '0.01', FOLLOWER_ID, 1002)); // the copy's fill on the stream
    assert.ok(await until(() => size(rt, s.id) === 0.01));
    w.builderRate = 10; // the follower approved less than the 2.5 bp the copies carry
    await rt.checkReady(rt.get(s.id)!);
    assert.equal(rt.get(s.id)!.status, 'blocked');
    assert.match(rt.get(s.id)!.statusReason ?? '', /copy fee/);
    leaderBuys('1');
    await wait(200);
    assert.equal(sent.length, 1, 'the add is not copied while the fee is not approved');
    leaderSells('2');
    assert.ok(await until(() => sent.length === 2));
    assert.deepEqual(sent[1]!.map((i) => [i.side, i.quantity, i.reduceOnly]), [['sell', '0.01', true]], 'the close still goes, reduce-only');
  } finally {
    await rt.stop();
  }
});

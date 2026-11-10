/**
 * The copy options and the follower's lifecycle on the runtime (docs/COVERAGE-COPY.md): what
 * matrix-planner.test.ts cannot show because it happens over time or across copies. "Copy
 * existing" at the start and after a restart, "ask me each time" answered yes, no, with an
 * error or not at all, the rules a running copy may and may not change, the SoDEX stops
 * following a change of the rules, a drawdown halt and its resume, a stopped copy staying
 * stopped and "stop all" over copies of two leaders, a paper and a live copy of one leader
 * side by side, two leaders on one market, and a copy paused while its leader opens.
 *
 * A runtime runs against a faked SoDEX (REST and the trade stream), as audit-copy.test.ts
 * does. A test that starts "BUG" failed before its fix (listed in docs/COVERAGE-COPY.md); a
 * "FINDING" is a test.todo that holds a failing case for the owner.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIRM_UNAVAILABLE,
  CopyRuntime,
  HyperliquidClient,
  MemoryStore,
  PaperSink,
  SodexClient,
  freshState,
  regionPolicy,
  type ActivityEntry,
  type EngineNotice,
  type FetchLike,
  type Intent,
  type OrderSink,
  type RuntimeHost,
  type SendResult,
  type Subscription,
  type WebSocketLike,
} from '../src/index.ts';
import { FOLLOWER, LEADER, sub } from './helpers.ts';

const LEADER_ID = 777;
const LEADER2 = '0x3333333333333333333333333333333333333333';
const LEADER2_ID = 778;
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

type Row = { s: string; sz: string; ep: string };
interface World {
  leader: Row[];
  leader2: Row[];
  follower: Array<Row & { l: number; m: string }>;
  marks: Record<string, number>;
}
const world = (o: Partial<World> = {}): World => ({ leader: [], leader2: [], follower: [], marks: { 'BTC-USD': 80_000, 'ETH-USD': 2_000 }, ...o });

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
    if (path === `/api/v1/user/${LEADER2}/subaccounts`) return ok({ primaryAccountID: LEADER2_ID });
    if (path === `/api/v1/perps/accounts/${LEADER}/state`) return ok({ aid: LEADER_ID, av: '100000', P: JSON.parse(JSON.stringify(w.leader)) });
    if (path === `/api/v1/perps/accounts/${LEADER2}/state`) return ok({ aid: LEADER2_ID, av: '100000', P: JSON.parse(JSON.stringify(w.leader2)) });
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

/** A live sink that records what it is asked to do: orders, and the stops with their triggers. */
function recordingSink() {
  const placed: Intent[][] = [];
  const stops: Array<{ clOrdID: string; kind: string; trigger: number; quantity: string }> = [];
  const cancels: string[] = [];
  const sink: OrderSink = {
    paper: false,
    async place(_a, _m, intents): Promise<SendResult[]> {
      placed.push(intents);
      return intents.map((i) => ({ clOrdID: i.clOrdID, ok: true, orderId: '1', error: null, outcomeUnknown: false }));
    },
    async setLeverage() {},
    async placeStop(_a, _m, st) {
      stops.push({ clOrdID: st.clOrdID, kind: st.kind, trigger: Number(st.triggerPrice), quantity: st.quantity });
      return { clOrdID: st.clOrdID, ok: true, orderId: null, error: null, outcomeUnknown: false };
    },
    async cancel(_a, _m, id) {
      cancels.push(id);
    },
  };
  return { sink, placed, stops, cancels, orders: () => placed.flat() };
}

function runtime(w: World, sinkFor: (s: Subscription) => OrderSink | null, extra: { store?: MemoryStore; confirm?: RuntimeHost['confirm'] } = {}) {
  const fetch = fakeFetch(w);
  const store = extra.store ?? new MemoryStore();
  const notices: EngineNotice[] = [];
  const rt = new CopyRuntime({
    confirmGapMs: 0,
    store,
    sodex: new SodexClient({ network: 'mainnet', fetch }),
    hyperliquid: new HyperliquidClient(fetch),
    factory: (url) => new FakeWs(url),
    network: 'mainnet',
    hlMode: 'user',
    sinkFor,
    builderFor: async () => ({ id: 9, fee: 25 }),
    policyFor: (s) => regionPolicy(s.country, s.observedCountry),
    onNotice: (n) => notices.push(n),
    ...(extra.confirm ? { confirm: extra.confirm } : {}),
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  return { rt, store, notices };
}

const sodexWs = () => FakeWs.all.filter((x) => x.url.endsWith('/ws/perps')).at(-1)!;
let tid = 50_000;
const print = (side: 'BUY' | 'SELL', qty: string, price: string, bi: number, si: number, s: string) => ({
  channel: 'trade',
  type: 'update',
  data: [{ E: Date.now(), T: Date.now(), t: ++tid, s, S: side, p: price, q: qty, bi, si }],
});
const px = (s: string) => (s === 'BTC-USD' ? '80000' : '2000');
const buys = (id: number, qty: string, s = 'BTC-USD') => sodexWs().push(print('BUY', qty, px(s), id, 1002, s));
const sells = (id: number, qty: string, s = 'BTC-USD') => sodexWs().push(print('SELL', qty, px(s), 1002, id, s));
/** The copy's own order filled, as the public stream shows it (the follower took liquidity). */
const followerBought = (qty: string, s = 'BTC-USD') => sodexWs().push(print('BUY', qty, px(s), FOLLOWER_ID, 1002, s));

const size = (rt: CopyRuntime, id: string, sym = 'BTC-USD') => rt.view(id)!.positions.find((p) => p.symbol === sym)?.size ?? 0;
const log = async (store: MemoryStore, id: string): Promise<ActivityEntry[]> => store.activity({ subId: id });
const skips = async (store: MemoryStore, id: string) => (await log(store, id)).filter((e) => e.kind === 'skip').map((e) => e.reason);
const internals = (rt: CopyRuntime) => rt as unknown as { refreshStops(id: string, s: string): Promise<void>; runGuards(): Promise<void>; markets: { setMark(s: string, p: number, at?: number): void }; queues: Map<string, Promise<void>> };
const settle = async (rt: CopyRuntime) => {
  for (let i = 0; i < 5; i++) await Promise.allSettled([...internals(rt).queues.values()]);
};

async function ready(): Promise<void> {
  await until(() => sodexWs()?.readyState === 1);
  await wait(150); // the start-up reconciles settle
}

/* ======================================================== copy existing ===== */

test('copy existing: on, the leader\'s open positions are joined at the start (a coin the allow list leaves out is skipped); off, they wait until the leader is flat', async () => {
  for (const copyExisting of [true, false]) {
    const w = world({ leader: [{ s: 'BTC-USD', sz: '1', ep: '80000' }, { s: 'ETH-USD', sz: '-10', ep: '2000' }] });
    const { rt, store } = runtime(w, () => new PaperSink());
    await rt.start();
    try {
      await ready();
      const s = await rt.add(sub({ paper: true, copyExisting, assetAllow: ['BTC'] }, { id: `ex-${copyExisting}` }));
      if (copyExisting) {
        assert.ok(await until(() => size(rt, s.id) === 0.01), `joined: ${size(rt, s.id)}`);
        assert.equal(size(rt, s.id, 'ETH-USD'), 0);
        assert.ok((await skips(store, s.id)).includes('asset-not-allowed'), 'ETH is not on the list to copy');
      } else {
        await wait(200);
        assert.equal(size(rt, s.id), 0);
        buys(LEADER_ID, '1');
        w.leader[0]!.sz = '2';
        await wait(300);
        assert.ok((await skips(store, s.id)).includes('pre-existing-position'), 'the add on a position held before the start is skipped');
        assert.equal(size(rt, s.id), 0);
        // Flat, then a new open: copied.
        sells(LEADER_ID, '2');
        await wait(250);
        buys(LEADER_ID, '1');
        assert.ok(await until(() => size(rt, s.id) === 0.01), 'the next open after the leader was flat is copied');
      }
    } finally {
      await rt.stop();
    }
  }
});

test('copy existing after a restart: a position the leader opened while no copier ran is joined with "copy existing", and left alone (pre-existing) without it', async () => {
  for (const copyExisting of [true, false]) {
    const w = world({ leader: [{ s: 'BTC-USD', sz: '1', ep: '80000' }] });
    const store = new MemoryStore();
    const s = sub({ paper: true, copyExisting }, { id: `rx-${copyExisting}` });
    await store.saveSubscription(s);
    await store.saveState({ ...freshState(s.id, 1000), leaderEquity: 100_000 });
    const { rt } = runtime(w, () => new PaperSink(), { store });
    await rt.start();
    try {
      await ready();
      await rt.reconcileAll();
      if (copyExisting) assert.ok(await until(() => size(rt, s.id) === 0.01), `joined after the restart: ${size(rt, s.id)}`);
      else {
        await wait(300);
        assert.equal(size(rt, s.id), 0, 'pre-existing: not joined');
        buys(LEADER_ID, '1');
        await wait(300);
        assert.equal(size(rt, s.id), 0, 'and its add is not copied either');
        assert.ok((await skips(store, s.id)).includes('pre-existing-position'));
      }
    } finally {
      await rt.stop();
    }
  }
});

/* ===================================================== ask me each time ===== */

test('BUG "ask me each time" answered yes, no, with an error or not at all: only yes places the order; no and an error are "declined", no answer is "not confirmed in time"', async () => {
  const w = world();
  const answers: Array<boolean | 'timeout' | 'throw'> = [true, false, 'throw', 'timeout'];
  const asked: Intent[][] = [];
  const confirm: RuntimeHost['confirm'] = async (_s, intents) => {
    asked.push(intents);
    const a = answers.shift();
    if (a === 'throw') throw new Error('the prompt went away');
    return a ?? false;
  };
  const { rt, store } = runtime(w, () => new PaperSink(), { confirm });
  await rt.start();
  try {
    const s = await rt.add(sub({ paper: true, approval: 'confirm', sizingMode: 'fixedNotional', fixedNotionalUsd: 800 }, { id: 'ask' }));
    assert.equal(rt.get(s.id)!.status, 'active', 'a host that can ask runs it');
    await ready();
    buys(LEADER_ID, '1');
    assert.ok(await until(() => size(rt, s.id) === 0.01), 'yes: copied');
    for (let i = 0; i < 3; i++) {
      buys(LEADER_ID, '1');
      assert.ok(await until(() => asked.length === 2 + i));
      await settle(rt);
    }
    assert.equal(asked.length, 4, 'every change was asked about');
    assert.deepEqual(asked[0]!.map((x) => x.leg), ['open']);
    assert.equal(size(rt, s.id), 0.01, 'nothing else was placed');
    const why = (await skips(store, s.id)).filter((r) => r === 'declined' || r === 'confirm-timeout');
    assert.deepEqual(why.sort(), ['confirm-timeout', 'declined', 'declined'], `the activity says why: ${why.join(', ')}`);
  } finally {
    await rt.stop();
  }
});

test('BUG live run 2026-10-30: "ask me each time", the leader\'s close not answered: the next reconcile does not close it anyway; automatic again, it does', async () => {
  // copym.confirm in the browser: the close timed out (confirm-timeout), and closeStrays sent it at the
  // next reconcile without asking.
  const w = world();
  const answers: Array<boolean | 'timeout'> = [true, 'timeout'];
  const confirm: RuntimeHost['confirm'] = async () => answers.shift() ?? 'timeout';
  const { rt, store } = runtime(w, () => new PaperSink(), { confirm });
  await rt.start();
  try {
    const s = await rt.add(sub({ paper: true, approval: 'confirm' }, { id: 'ask-close' }));
    await ready();
    w.leader = [{ s: 'BTC-USD', sz: '1', ep: '80000' }];
    buys(LEADER_ID, '1');
    assert.ok(await until(() => size(rt, s.id) === 0.01), 'yes: copied');
    w.leader = [];
    sells(LEADER_ID, '1');
    let timedOut = false;
    for (let i = 0; i < 60 && !timedOut; i++) {
      timedOut = (await skips(store, s.id)).includes('confirm-timeout');
      if (!timedOut) await wait(50);
    }
    assert.ok(timedOut, 'the close was asked about and not answered');
    await rt.reconcileAll();
    await wait(300);
    assert.equal(size(rt, s.id), 0.01, 'not closed without asking');
    await rt.update(s.id, { settings: { ...rt.get(s.id)!.settings, approval: 'auto' } });
    await rt.reconcileAll();
    assert.ok(await until(() => size(rt, s.id) === 0), `automatic again, the copy closes what the leader closed: ${size(rt, s.id)}`);
  } finally {
    await rt.stop();
  }
});

test('"ask me each time" where nobody can ask (an executor): started held with the reason; switching a running copy to it is refused; back to automatic it runs', async () => {
  const w = world();
  const { rt, store } = runtime(w, () => new PaperSink());
  await rt.start();
  try {
    const s = await rt.add(sub({ paper: true, approval: 'confirm' }, { id: 'noask' }));
    assert.deepEqual([rt.get(s.id)!.status, rt.get(s.id)!.statusReason], ['blocked', CONFIRM_UNAVAILABLE]);
    await ready();
    buys(LEADER_ID, '1');
    await wait(300);
    assert.equal(size(rt, s.id), 0, 'nothing is copied while it waits for someone to ask');
    assert.ok((await skips(store, s.id)).includes('blocked'));
    await rt.update(s.id, { settings: { ...rt.get(s.id)!.settings, approval: 'auto' } });
    assert.equal(rt.get(s.id)!.status, 'active', 'automatic approval lifts it');
    await assert.rejects(rt.update(s.id, { settings: { ...rt.get(s.id)!.settings, approval: 'confirm' } }), (e: Error) => e.message === CONFIRM_UNAVAILABLE);
  } finally {
    await rt.stop();
  }
});

/* ================================================== changing the rules ===== */

test('a running copy cannot change its trader, switch between paper and live or between copy and counter-trade; every other rule it can', async () => {
  const w = world();
  const { rt } = runtime(w, () => new PaperSink());
  await rt.start();
  try {
    const s = await rt.add(sub({ paper: true }, { id: 'upd' }));
    const cur = () => rt.get(s.id)!.settings;
    await assert.rejects(rt.update(s.id, { settings: { ...cur(), leader: { venue: 'sodex', address: LEADER2 } } }), /trader of a copy cannot change/);
    await assert.rejects(rt.update(s.id, { settings: { ...cur(), leader: { venue: 'hyperliquid', address: LEADER } } }), /trader of a copy cannot change/);
    await assert.rejects(rt.update(s.id, { settings: { ...cur(), paper: false } }), /between paper and live/);
    await assert.rejects(rt.update(s.id, { settings: { ...cur(), direction: 'counter' } }), /between copying and counter-trading/);
    const next = { ...cur(), sizingMode: 'fixedRatio' as const, ratio: 0.5, allocationUsd: 2_000, maxLeverage: 3, maxPositionUsd: 50, stopLossPct: null, takeProfitPct: 2, drawdownStopPct: 0.1, assetAllow: ['ETH'], assetDeny: ['BTC'], copyExisting: true, slippageBps: 5, marginMode: 'cross' as const };
    const u = await rt.update(s.id, { settings: next });
    assert.deepEqual(u.settings, next);
    assert.equal(u.status, 'active');
    // The drawdown peak moves with the allocation (1,000 -> 2,000), so it never reads as a gain or loss.
    assert.equal(rt.view(s.id)!.peakEquity, 2_000);
  } finally {
    await rt.stop();
  }
});

test('BUG a change of the stop-loss, the take-profit, the leverage or the region moves the copy\'s SoDEX stops at once; a stop turned off is cancelled', async () => {
  const w = world();
  const rec = recordingSink();
  const { rt } = runtime(w, () => rec.sink);
  await rt.start();
  try {
    const s = await rt.add(sub({ sizingMode: 'fixedNotional', fixedNotionalUsd: 800, maxLeverage: 5, stopLossPct: 0.5, takeProfitPct: null }, { id: 'stp' }));
    await ready();
    buys(LEADER_ID, '1');
    w.leader = [{ s: 'BTC-USD', sz: '1', ep: '80000' }];
    assert.ok(await until(() => rec.placed.length === 1), 'opened');
    followerBought(rec.placed[0]![0]!.quantity);
    assert.ok(await until(() => size(rt, s.id) === 0.01));
    w.follower = [{ s: 'BTC-USD', sz: '0.01', ep: '80000', l: 5, m: 'ISOLATED' }];
    await internals(rt).refreshStops(s.id, 'BTC-USD');
    assert.deepEqual(rec.stops.map((x) => [x.kind, x.trigger]), [['stop-loss', 72_000]], 'a 50% stop-loss at 5x');
    const live = () => {
      const cancelled = new Set(rec.cancels);
      return rec.stops.filter((x) => !cancelled.has(x.clOrdID)).map((x) => [x.kind, x.trigger, x.quantity]);
    };
    const change = async (patch: Partial<Subscription['settings']>, extra: Partial<Subscription> = {}) => {
      await rt.update(s.id, { settings: { ...rt.get(s.id)!.settings, ...patch }, ...extra });
      await settle(rt);
    };
    await change({ stopLossPct: 0.2 });
    assert.deepEqual(live(), [['stop-loss', 76_800, '0.01']], 'the stop-loss moved to 20%');
    await change({ takeProfitPct: 1 });
    assert.deepEqual(live(), [['stop-loss', 76_800, '0.01'], ['take-profit', 96_000, '0.01']], 'a take-profit added');
    await change({ maxLeverage: 2 });
    assert.deepEqual(live(), [['stop-loss', 72_000, '0.01'], ['take-profit', 120_000, '0.01']], 'at 2x the same shares of the margin are further away');
    await change({ maxLeverage: 5 }, { country: 'DE' });
    assert.deepEqual(live(), [['stop-loss', 76_800, '0.01'], ['take-profit', 96_000, '0.01']], 'a German follower at 5x: no regional cap since 2026-11-10');
    await change({}, { country: 'SG' });
    assert.deepEqual(live(), [['stop-loss', 76_800, '0.01'], ['take-profit', 96_000, '0.01']], 'outside the EEA 5x as well');
    await change({ stopLossPct: null, takeProfitPct: null });
    assert.deepEqual(live(), [], 'both off: nothing rests on SoDEX that could still close the position');
    const n = rec.stops.length;
    await change({ slippageBps: 20 });
    assert.equal(rec.stops.length, n, 'a change that moves no trigger places nothing');
  } finally {
    await rt.stop();
  }
});

/* ======================================================== halt, resume ===== */

test('the drawdown stop halts and closes; a halted copy copies no open; resumed, it measures from the equity it has then and copies again', async () => {
  const w = world();
  const { rt, store, notices } = runtime(w, () => new PaperSink());
  await rt.start();
  try {
    const s = await rt.add(sub({ paper: true, sizingMode: 'fixedNotional', fixedNotionalUsd: 800, drawdownStopPct: 0.05, stopLossPct: null }, { id: 'dd' }));
    await ready();
    buys(LEADER_ID, '1');
    assert.ok(await until(() => size(rt, s.id) > 0));
    internals(rt).markets.setMark('BTC-USD', 72_000);
    await internals(rt).runGuards();
    assert.ok(await until(() => rt.get(s.id)!.status === 'halted' && size(rt, s.id) === 0), `halted and flat: ${rt.get(s.id)!.status} ${size(rt, s.id)}`);
    assert.ok(notices.some((n) => n.kind === 'halted' && n.grade === 'error'), 'the follower is told (an error)');
    buys(LEADER_ID, '1');
    await wait(300);
    assert.equal(size(rt, s.id), 0, 'a halted copy opens nothing');
    assert.ok((await skips(store, s.id)).includes('halted'));
    await rt.resume(s.id);
    assert.equal(rt.get(s.id)!.status, 'active');
    const v = rt.view(s.id)!;
    assert.ok(Math.abs(v.peakEquity - v.equity) < 1e-6, 'the drawdown is measured from the equity at the resume');
    await internals(rt).runGuards();
    assert.equal(rt.get(s.id)!.status, 'active', 'and does not halt again at once');
    buys(LEADER_ID, '1');
    assert.ok(await until(() => size(rt, s.id) > 0), 'the next change is copied');
  } finally {
    await rt.stop();
  }
});

/* ================================================== stopping, several ===== */

test('stop is final; "stop all" with close stops and flattens the copies of two leaders at once, and nothing is copied after', async () => {
  const w = world();
  const { rt, notices } = runtime(w, () => new PaperSink());
  await rt.start();
  try {
    const a = await rt.add(sub({ paper: true, sizingMode: 'fixedNotional', fixedNotionalUsd: 800 }, { id: 'sa' }));
    const b = await rt.add(sub({ paper: true, sizingMode: 'fixedNotional', fixedNotionalUsd: 200, leader: { venue: 'sodex', address: LEADER2 } }, { id: 'sb' }));
    await ready();
    buys(LEADER_ID, '1');
    buys(LEADER2_ID, '1', 'ETH-USD');
    assert.ok(await until(() => size(rt, a.id) === 0.01 && size(rt, b.id, 'ETH-USD') === 0.1), `${size(rt, a.id)} ${size(rt, b.id, 'ETH-USD')}`);
    const out = await rt.stopAll(FOLLOWER, { close: true });
    assert.deepEqual(out.map((x) => [x.id, x.status, x.statusReason]).sort(), [['sa', 'stopped', 'Stopped by you; positions closed.'], ['sb', 'stopped', 'Stopped by you; positions closed.']]);
    assert.deepEqual([size(rt, a.id), size(rt, b.id, 'ETH-USD')], [0, 0]);
    assert.equal(notices.filter((n) => n.kind === 'stopped').length, 0, 'what the follower did is no notice');
    buys(LEADER_ID, '1');
    buys(LEADER2_ID, '1', 'ETH-USD');
    await wait(300);
    assert.deepEqual([size(rt, a.id), size(rt, b.id, 'ETH-USD')], [0, 0], 'nothing copied after');
    await assert.rejects(rt.resume(a.id), /cannot be restarted/);
    await assert.rejects(rt.setStatus(b.id, 'paused', null), /cannot be restarted/);
    assert.deepEqual(await rt.stopAll(FOLLOWER, { close: true }), [], 'a second stop-all has nothing to stop');
  } finally {
    await rt.stop();
  }
});

test('stop keeping the positions: they stay in the books and on SoDEX, and the leader\'s close is no longer followed', async () => {
  const w = world();
  const { rt } = runtime(w, () => new PaperSink());
  await rt.start();
  try {
    const s = await rt.add(sub({ paper: true, sizingMode: 'fixedNotional', fixedNotionalUsd: 800 }, { id: 'keep' }));
    await ready();
    buys(LEADER_ID, '1');
    assert.ok(await until(() => size(rt, s.id) === 0.01));
    const x = await rt.stopCopy(s.id, { close: false });
    assert.deepEqual([x.status, x.statusReason], ['stopped', 'Stopped by you; positions kept.']);
    sells(LEADER_ID, '1');
    await wait(300);
    await rt.reconcileAll();
    assert.equal(size(rt, s.id), 0.01, 'kept: the copier no longer manages it');
  } finally {
    await rt.stop();
  }
});

test('a paper and a live copy of one leader run side by side, each in its own books (the paper one never counts as holding the market); two leaders on one market: the second copy leaves it to the first', async () => {
  const w = world();
  const rec = recordingSink();
  const paper = new PaperSink();
  const { rt, store } = runtime(w, (s) => (s.settings.paper ? paper : rec.sink));
  await rt.start();
  try {
    const live = await rt.add(sub({ sizingMode: 'fixedNotional', fixedNotionalUsd: 800 }, { id: 'pl-live' }));
    const pap = await rt.add(sub({ paper: true, sizingMode: 'fixedNotional', fixedNotionalUsd: 800 }, { id: 'pl-paper' }));
    const other = await rt.add(sub({ sizingMode: 'fixedNotional', fixedNotionalUsd: 400, leader: { venue: 'sodex', address: LEADER2 } }, { id: 'pl-other' }));
    await ready();
    buys(LEADER_ID, '1');
    assert.ok(await until(() => rec.placed.length === 1 && size(rt, pap.id) === 0.01), 'the live copy sent one order, the paper copy filled on paper');
    followerBought(rec.placed[0]![0]!.quantity);
    assert.ok(await until(() => size(rt, live.id) === 0.01));
    assert.equal(rec.orders().length, 1, 'one order reached SoDEX, not two');
    // The second leader opens the same market: the live copy of the first holds it.
    buys(LEADER2_ID, '1');
    await wait(300);
    assert.equal(rec.orders().length, 1, 'nothing sent for the second leader');
    assert.ok((await skips(store, other.id)).includes('owned-by-other-copy'));
    // The paper copy books its own fills; the live one is what SoDEX shows.
    assert.ok((await log(store, pap.id)).some((e) => e.kind === 'fill' && e.paper));
  } finally {
    await rt.stop();
  }
});

test('paused while the leader opens: nothing is copied, a resume does not open it, the leader\'s next add takes the copy to its whole target', async () => {
  const w = world();
  const { rt, store } = runtime(w, () => new PaperSink());
  await rt.start();
  try {
    const s = await rt.add(sub({ paper: true, sizingMode: 'fixedNotional', fixedNotionalUsd: 800 }, { id: 'po' }));
    await ready();
    await rt.pause(s.id);
    buys(LEADER_ID, '1');
    w.leader = [{ s: 'BTC-USD', sz: '1', ep: '80000' }];
    await wait(300);
    assert.equal(size(rt, s.id), 0);
    assert.ok((await skips(store, s.id)).includes('paused'));
    await rt.resume(s.id);
    await rt.reconcileAll();
    await wait(300);
    assert.equal(size(rt, s.id), 0, 'a resume closes strays, it never opens');
    buys(LEADER_ID, '1');
    assert.ok(await until(() => size(rt, s.id) === 0.01), `joined at the next add: ${size(rt, s.id)}`);
  } finally {
    await rt.stop();
  }
});

/* ============================================================= findings ===== */

test.todo('FINDING "ask me each time": an unanswered prompt holds the follower\'s whole queue (up to 60 s in the browser) - another copy\'s stop-loss close waits behind it', async () => {
  const w = world();
  let release: ((v: boolean) => void) | null = null;
  const confirm: RuntimeHost['confirm'] = () => new Promise<boolean>((r) => (release = r));
  const { rt } = runtime(w, () => new PaperSink(), { confirm });
  await rt.start();
  try {
    const guarded = await rt.add(sub({ paper: true, sizingMode: 'fixedNotional', fixedNotionalUsd: 800, stopLossPct: 0.1, leader: { venue: 'sodex', address: LEADER2 } }, { id: 'q-sl' }));
    const asking = await rt.add(sub({ paper: true, approval: 'confirm', sizingMode: 'fixedNotional', fixedNotionalUsd: 200 }, { id: 'q-ask' }));
    await ready();
    buys(LEADER2_ID, '1');
    assert.ok(await until(() => size(rt, guarded.id) === 0.01));
    buys(LEADER_ID, '1', 'ETH-USD'); // a prompt nobody answers yet
    assert.ok(await until(() => release !== null), 'the follower is asked');
    internals(rt).markets.setMark('BTC-USD', 78_000); // -2.5% at 5x: past the 10% stop-loss
    await internals(rt).runGuards();
    const closed = await until(() => size(rt, guarded.id) === 0, 1_000);
    release!(false);
    assert.ok(closed, `the stop-loss close of ${guarded.id} waited for the prompt of ${asking.id}`);
  } finally {
    await rt.stop();
  }
});

/**
 * Copy-trading audit (2026-10-27): adversarial tests of the planner, the
 * policy and the runtime. Every test asserts the INTENDED behaviour; a test
 * named "BUG ..." fails on the code as it stands and proves a defect.
 *
 * Run: npx tsx --test test/audit-copy.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CopyRuntime,
  HyperliquidClient,
  MemoryStore,
  PaperSink,
  SodexClient,
  applyFill,
  copyFeeFor,
  checkSettings,
  effectiveLeverage,
  freshState,
  planGuards,
  planLeaderEvent,
  regionPolicy,
  type FetchLike,
  type Intent,
  type MarketInfo,
  type OrderSink,
  type PlanContext,
  type SendResult,
  type SubState,
  type Subscription,
  type WebSocketLike,
} from '../src/index.ts';
import { BTC, ETH, FOLLOWER, LEADER, ev, marks, state, sub } from './helpers.ts';

/* ===================================================================== planner ===== */

const NO_REGION = { maxLeverage: null };
const ctx = (o: Partial<PlanContext> & Pick<PlanContext, 'event'>): PlanContext => ({
  sub: sub(),
  state: state(),
  market: BTC,
  markOf: marks({ 'BTC-USD': 80_000, 'ETH-USD': 2_000 }),
  policy: NO_REGION,
  heldBy: 'nobody',
  follower: null,
  ...o,
});

/** Apply a plan's intents as full fills at the reference price (what a filled IOC does). */
function fillAll(st: SubState, intents: Intent[], px: number): void {
  for (const i of intents) applyFill(st, i.symbol, i.side, Number(i.quantity), px, 0, 1);
}

test('BUG planner: a leader that scales out in small steps leaves the copy at its full size (each step is below one lot and is lost)', () => {
  // The copy holds 0.0005 BTC (40 USD). The leader halves 10 -> 5 BTC in 0.1 BTC steps.
  // Each step is 1% of the copy = 0.000005 BTC, below the 0.00001 step: skipped, and the
  // next step's fraction is taken of the SAME copy size, so the skipped part is never caught up.
  const st = state({ owned: { 'BTC-USD': { size: 0.0005, entry: 80_000, openedAt: 1 } }, leaderPos: { 'BTC-USD': 10 } });
  let lp = 10;
  while (lp > 5.0001) {
    const next = Math.round((lp - 0.1) * 10) / 10;
    const p = planLeaderEvent(ctx({ state: st, event: ev('BTC-USD', lp, next, 80_000) }));
    fillAll(st, p.intents, 80_000);
    st.leaderPos['BTC-USD'] = next;
    lp = next;
  }
  const held = st.owned['BTC-USD']?.size ?? 0;
  // The leader holds half: the copy should be ~0.00025 (one lot of rounding at most).
  assert.ok(held <= 0.00026, `the copy still holds ${held} BTC after the leader halved (should be ~0.00025)`);
});

test('BUG planner: fixed-amount copy - a leader that adds in small steps is never followed (each add is below the minimum order value)', () => {
  // $100 per trade: the copy opens 0.00125 BTC. The leader doubles 1 -> 2 BTC in 5% adds.
  // Each add scales the copy by 5% = $5, under SoDEX's $10 minimum: skipped, and the
  // next add is measured from the same copy size again, so the copy never grows.
  const s = sub({ sizingMode: 'fixedNotional', fixedNotionalUsd: 100 });
  const st = state({ owned: { 'BTC-USD': { size: 0.00125, entry: 80_000, openedAt: 1 } }, leaderPos: { 'BTC-USD': 1 } });
  let lp = 1;
  for (let k = 0; k < 20; k++) {
    const next = Math.round((lp + 0.05) * 100) / 100;
    const p = planLeaderEvent(ctx({ sub: s, state: st, event: ev('BTC-USD', lp, next, 80_000) }));
    fillAll(st, p.intents, 80_000);
    lp = next;
  }
  const held = st.owned['BTC-USD']?.size ?? 0;
  assert.ok(held >= 0.0023, `the leader doubled but the fixed-amount copy holds ${held} BTC (should be ~0.0025)`);
});

test('coverage planner: proportional copy - small adds accumulate (target based) and are caught up', () => {
  const st = state({ owned: { 'BTC-USD': { size: 0.0005, entry: 80_000, openedAt: 1 } }, leaderPos: { 'BTC-USD': 0.05 } });
  let lp = 0.05;
  for (let k = 0; k < 50; k++) {
    const next = Math.round((lp + 0.001) * 1000) / 1000;
    const p = planLeaderEvent(ctx({ state: st, event: ev('BTC-USD', lp, next, 80_000) }));
    fillAll(st, p.intents, 80_000);
    lp = next;
  }
  // Leader 0.1 BTC = 8,000 on 100,000 = 8% of 1,000 = 80 USD = 0.001 BTC.
  const held = st.owned['BTC-USD']!.size;
  assert.ok(Math.abs(held - 0.001) <= 0.0002, `held ${held}`);
});

test('BUG planner: a NaN leader size (malformed source) is read as flat and CLOSES the copy', () => {
  const st = state({ owned: { 'BTC-USD': { size: 0.01, entry: 80_000, openedAt: 1 } }, leaderPos: { 'BTC-USD': 1 } });
  const p = planLeaderEvent(ctx({ state: st, event: ev('BTC-USD', 1, Number.NaN, 80_000) }));
  assert.equal(p.intents.length, 0, `a NaN size placed ${p.intents.map((i) => i.leg).join(',')}`);
});

test('BUG planner: a copy that still holds a position on a market detached by a partial stop-loss is not closed when the leader closes', () => {
  // The guard's stop-loss IOC filled only half; the market was detached anyway (runtime.runGuards
  // sets detached whatever the result). Then the leader closes: the planner returns "after-stop-loss"
  // with attach, and the copy's remaining 0.005 BTC is never closed by anyone.
  const st = state({ owned: { 'BTC-USD': { size: 0.005, entry: 80_000, openedAt: 1 } }, leaderPos: { 'BTC-USD': 1 }, detached: { 'BTC-USD': 'stop-loss' } });
  const p = planLeaderEvent(ctx({ state: st, event: ev('BTC-USD', 1, 0, 70_000) }));
  assert.equal(p.intents.length, 1, `skip ${p.skip}: the leftover copy position stays open`);
  assert.equal(p.intents[0]!.reduceOnly, true);
});

test('BUG planner: a leader decrease while the copy is on the other side (missed flip) only trims the wrong-way position', () => {
  // The leader flipped long -> short while the copy was paused (positions stay); now the leader
  // trims its short. The decrease branch reduces the copy's LONG by the leader's fraction and
  // leaves it long, against the leader. The open/increase branches close a wrong-way copy first.
  const st = state({ owned: { 'BTC-USD': { size: 0.01, entry: 80_000, openedAt: 1 } }, leaderPos: { 'BTC-USD': -2 } });
  const p = planLeaderEvent(ctx({ state: st, event: ev('BTC-USD', -2, -1, 80_000) }));
  fillAll(st, p.intents, 80_000);
  const held = st.owned['BTC-USD']?.size ?? 0;
  assert.ok(held <= 0, `the copy is still long ${held} BTC while the leader is short`);
});

test('BUG planner: a blocked copy (builder approval revoked, key expiring) ignores the leader closing, leaving its position open', () => {
  const st = state({ owned: { 'BTC-USD': { size: 0.01, entry: 80_000, openedAt: 1 } }, leaderPos: { 'BTC-USD': 1 } });
  const p = planLeaderEvent(ctx({ sub: sub({}, { status: 'blocked' }), state: st, event: ev('BTC-USD', 1, 0, 80_000) }));
  assert.equal(p.intents.length, 1, `skip ${p.skip}`);
  assert.equal(p.intents[0]!.reduceOnly, true);
});

test('coverage planner: max-position cap rounds DOWN to the step, never over the cap', () => {
  const m: MarketInfo = { ...BTC, stepSize: '0.001', minQuantity: '0.001' };
  const p = planLeaderEvent(ctx({ market: m, sub: sub({ maxPositionUsd: 2_550 }), event: ev('BTC-USD', 0, 10, 80_000) }));
  const q = Number(p.intents[0]!.quantity);
  assert.ok(q * 80_000 <= 2_550, `${q} BTC = ${q * 80_000} over the 2,550 cap`);
  assert.equal(p.intents[0]!.clampedBy, 'max-position');
});

test('coverage planner: a copy below one lot is skipped (lot-size), never rounded up', () => {
  const m: MarketInfo = { ...BTC, stepSize: '0.01', minQuantity: '0.01' };
  const p = planLeaderEvent(ctx({ market: m, event: ev('BTC-USD', 0, 0.5, 80_000) })); // 400 USD = 0.005 BTC
  assert.equal(p.intents.length, 0);
  assert.equal(p.skip, 'lot-size');
});

test('coverage planner: EEA 2x caps exposure across markets (gross), not per market', () => {
  const st = state({ owned: { 'ETH-USD': { size: 0.5, entry: 2_000, openedAt: 1 } } }); // 1,000 USD already
  const p = planLeaderEvent(ctx({ state: st, sub: sub({ maxPositionUsd: 100_000 }), policy: { maxLeverage: 2 }, event: ev('BTC-USD', 0, 10, 80_000) }));
  const q = Number(p.intents[0]!.quantity);
  assert.ok(q * 80_000 <= 1_000 + 1e-6, `EEA copy got ${q * 80_000} USD on top of 1,000 with a 2x cap on 1,000`);
  // (Cosmetic: the clamp is labelled 'max-leverage', not 'region-leverage', whenever the target also exceeds the follower's own cap.)
});

test('coverage planner: Hyperliquid kPEPE (1000 units) maps to 1000PEPE-USD and sizes by notional', () => {
  const PEPE: MarketInfo = { ...BTC, id: 9, name: '1000PEPE-USD', base: '1000PEPE', tickSize: '0.000001', stepSize: '1', minQuantity: '1' };
  // The leader buys 100,000 kPEPE at 0.01 = 1,000 USD on a 100,000 account: 1% -> 10 USD on 1,000.
  const p = planLeaderEvent(ctx({ sub: sub({ leader: { venue: 'hyperliquid', address: LEADER }, maxPositionUsd: 100_000 }), market: PEPE, markOf: marks({ '1000PEPE-USD': 0.01 }), event: ev('kPEPE', 0, 100_000, 0.01, 'hyperliquid') }));
  assert.equal(p.intents[0]!.quantity, '1000');
});

test('coverage planner: paused and stopped copies place nothing', () => {
  for (const status of ['paused', 'stopped', 'halted'] as const) {
    const p = planLeaderEvent(ctx({ sub: sub({}, { status }), event: ev('BTC-USD', 0, 1, 80_000) }));
    assert.equal(p.intents.length, 0, status);
  }
});

test('coverage planner: slippage cap - buy limit never above ref x (1 + cap), sell never below', () => {
  const st = state({ owned: { 'BTC-USD': { size: 0.01, entry: 80_000, openedAt: 1 } } });
  const buy = planLeaderEvent(ctx({ sub: sub({ slippageBps: 7 }), event: ev('BTC-USD', 0, 1, 80_000) }));
  assert.ok(Number(buy.intents[0]!.limitPrice) <= 80_000 * 1.0007);
  const sell = planLeaderEvent(ctx({ sub: sub({ slippageBps: 7 }), state: st, event: ev('BTC-USD', 1, 0, 80_000) }));
  assert.ok(Number(sell.intents[0]!.limitPrice) >= 80_000 * 0.9993);
});

test('coverage guards: stop-loss closes reduce-only with the whole size', () => {
  const st = state({ owned: { 'BTC-USD': { size: 0.01, entry: 80_000, openedAt: 1 } } });
  const g = planGuards({ sub: sub({ stopLossPct: 0.5, maxLeverage: 5 }), state: st, markets: (m) => (m === 'BTC-USD' ? BTC : null), markOf: marks({ 'BTC-USD': 71_000 }), policy: NO_REGION, now: 0 });
  assert.equal(g.intents.length, 1);
  assert.equal(g.intents[0]!.reduceOnly, true);
  assert.equal(g.intents[0]!.quantity, '0.01');
});

/* ===================================================================== policy ===== */

test('coverage policy: US, its territories and sanctioned countries are blocked, declared or observed', () => {
  for (const c of ['US', 'PR', 'GU', 'VI', 'IR', 'KP', 'RU']) assert.equal(regionPolicy(c).allowed, false, c);
  assert.equal(regionPolicy('DE', 'US').allowed, false);
  assert.equal(regionPolicy('US', 'DE').allowed, false);
  assert.equal(regionPolicy(null).allowed, false);
  assert.equal(regionPolicy('SG', 'DE').maxLeverage, 2);
  assert.equal(effectiveLeverage(20, regionPolicy('FR'), 50), 2);
});

test('BUG policy: the EU outermost regions (Reunion, Guadeloupe, Martinique, French Guiana, Mayotte, Saint-Martin) and Aland are EU territory but get no 2x cap', () => {
  for (const c of ['RE', 'GP', 'MQ', 'GF', 'YT', 'MF', 'AX']) assert.equal(regionPolicy(c).maxLeverage, 2, `${c} is in the EU`);
});

test('coverage policy: the copy fee ladder steps at its thresholds; unknown volume pays the highest', () => {
  assert.equal(copyFeeFor(null), 25);
  assert.equal(copyFeeFor(Number.NaN), 25);
  assert.equal(copyFeeFor(-5), 25);
  assert.equal(copyFeeFor(99_999.99), 25);
  assert.equal(copyFeeFor(100_000), 20);
  assert.equal(copyFeeFor(499_999), 20);
  assert.equal(copyFeeFor(500_000), 15);
  assert.equal(copyFeeFor(2_000_000), 12);
  assert.equal(copyFeeFor(10_000_000), 10);
  assert.equal(copyFeeFor(1e12), 10);
});

test('coverage settings: NaN, Infinity and out-of-range numbers are refused', () => {
  const base = { leader: { venue: 'sodex', address: LEADER } };
  for (const bad of [{ allocationUsd: Number.NaN }, { allocationUsd: Infinity }, { maxLeverage: 0 }, { slippageBps: 0 }, { ratio: -1 }, { fixedNotionalUsd: '1e400' }]) {
    assert.equal(checkSettings({ ...base, ...bad }).settings, null, JSON.stringify(bad));
  }
});

/* ===================================================================== runtime ===== */

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
  leader: Array<{ s: string; sz: string; ep: string }>;
  follower: Array<{ s: string; sz: string; ep: string; l: number; m: string }>;
  builderRate: number | null;
  marks: Record<string, number>;
  /** While set, a leader REST read waits on it (the answer is the state when the read STARTED). */
  gate: Promise<void> | null;
  failBuilders: boolean;
}

const world = (o: Partial<World> = {}): World => ({ leader: [], follower: [], builderRate: 25, marks: { 'BTC-USD': 80_000, 'ETH-USD': 2_000 }, gate: null, failBuilders: false, ...o });

const marketRow = (id: number, name: string, base: string, tick: string, step: string) => ({
  id, name, baseCoin: base, tickSize: tick, stepSize: step, minQuantity: step, maxQuantity: '100000', minNotional: '10', maxNotional: '50000000', maxLeverage: 50, buyLimitUpRatio: '0.05', sellLimitDownRatio: '0.05', takerFee: '0.0004', status: 'TRADING',
});

function fakeFetch(w: World): FetchLike {
  const ok = (data: unknown) => ({ status: 200, ok: true, text: async () => JSON.stringify({ code: 0, timestamp: Date.now(), data }) });
  return async (url) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/v1/perps/markets/symbols') return ok([marketRow(1, 'BTC-USD', 'BTC', '1', '0.00001'), marketRow(2, 'ETH-USD', 'ETH', '0.1', '0.0001')]);
    if (path === '/api/v1/perps/markets/mark-prices') return ok(Object.entries(w.marks).map(([symbol, p]) => ({ symbol, markPrice: String(p) })));
    if (path === `/api/v1/user/${LEADER}/subaccounts`) return ok({ primaryAccountID: LEADER_ID });
    if (path === `/api/v1/perps/accounts/${LEADER}/state`) {
      const snap = { aid: LEADER_ID, av: '100000', P: JSON.parse(JSON.stringify(w.leader)) };
      if (w.gate) await w.gate;
      return ok(snap);
    }
    if (path === `/api/v1/perps/accounts/${FOLLOWER}/state`) return ok({ aid: FOLLOWER_ID, av: '5000', am: '5000', P: w.follower });
    if (path === `/api/v1/user/${FOLLOWER}/builders`) {
      if (w.failBuilders) return { status: 503, ok: false, text: async () => '{"code":503,"message":"unavailable"}' };
      return ok({ perps: w.builderRate === null ? [] : [{ userID: FOLLOWER_ID, builderID: 9, feeRate: w.builderRate }], spot: [] });
    }
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

function runtime(w: World, sinkFor: (s: Subscription) => OrderSink | null, extra: { store?: MemoryStore; confirm?: boolean } = {}) {
  const fetch = fakeFetch(w);
  const store = extra.store ?? new MemoryStore();
  const rt = new CopyRuntime({
    store,
    sodex: new SodexClient({ network: 'mainnet', fetch }),
    hyperliquid: new HyperliquidClient(fetch),
    factory: (url) => new FakeWs(url),
    network: 'mainnet',
    hlMode: 'user',
    sinkFor,
    builderFor: async () => ({ id: 9, fee: 25 }),
    policyFor: (s) => regionPolicy(s.country, s.observedCountry),
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  return { rt, store };
}

const sodexWs = () => FakeWs.all.filter((x) => x.url.endsWith('/ws/perps')).at(-1)!;
let tid = 1_000;
const print = (side: 'BUY' | 'SELL', qty: string, price: string, bi: number, si: number, s = 'BTC-USD') => ({
  channel: 'trade',
  type: 'update',
  data: [{ E: Date.now(), T: Date.now(), t: ++tid, s, S: side, p: price, q: qty, bi, si }],
});
const leaderBuys = (qty: string, price = '80000', s = 'BTC-USD') => sodexWs().push(print('BUY', qty, price, LEADER_ID, 1002, s));
const leaderSells = (qty: string, price = '80000', s = 'BTC-USD') => sodexWs().push(print('SELL', qty, price, 1002, LEADER_ID, s));

async function ready(): Promise<void> {
  await until(() => sodexWs()?.readyState === 1);
  await wait(150); // the start-up reconciles settle
}

/** A live sink that records what it is asked to do. */
function recordingSink(o: { rejectReduce?: boolean; leverageFailsOnce?: boolean } = {}) {
  const placed: Intent[][] = [];
  const stops: string[] = [];
  const cancels: string[] = [];
  let leverageCalls = 0;
  const sink: OrderSink = {
    paper: false,
    async place(_a, _m, intents): Promise<SendResult[]> {
      placed.push(intents);
      return intents.map((i) => (o.rejectReduce && i.reduceOnly ? { clOrdID: i.clOrdID, ok: false, orderId: null, error: 'reduce-only order refused', outcomeUnknown: false } : { clOrdID: i.clOrdID, ok: true, orderId: '1', error: null, outcomeUnknown: false }));
    },
    async setLeverage() {
      leverageCalls++;
      if (o.leverageFailsOnce && leverageCalls === 1) throw new Error('SoDEX did not answer');
    },
    async placeStop(_a, _m, st) {
      stops.push(st.clOrdID);
      return { clOrdID: st.clOrdID, ok: true, orderId: null, error: null, outcomeUnknown: false };
    },
    async cancel(_a, _m, id) {
      cancels.push(id);
    },
  };
  return { sink, placed, stops, cancels, leverage: () => leverageCalls };
}

/** A paper sink whose reduce-only orders fill only `ratio` of their size (an IOC hitting a thin book). */
function partialPaper(ratio: number): OrderSink {
  const inner = new PaperSink();
  return {
    paper: true,
    async place(a, m, intents, b, ref) {
      const r = await inner.place(a, m, intents, b, ref);
      return r.map((x, i) => (intents[i]!.reduceOnly && x.paperFill ? { ...x, paperFill: { qty: x.paperFill.qty * ratio, price: x.paperFill.price } } : x));
    },
    setLeverage: () => inner.setLeverage(),
    placeStop: (a, m, s) => inner.placeStop(a, m, s),
    cancel: () => inner.cancel(),
  };
}

const size = (rt: CopyRuntime, id: string, sym = 'BTC-USD') => rt.view(id)!.positions.find((p) => p.symbol === sym)?.size ?? 0;

test('BUG runtime: a leader close that happened while the copier was down is never copied after the restart', async () => {
  const w = world({ leader: [] }); // the leader closed while the copier was off
  const store = new MemoryStore();
  const s = sub({ paper: true }, { id: 'r1' });
  await store.saveSubscription(s);
  await store.saveState({ ...freshState('r1', 1000), leaderPos: { 'BTC-USD': 1 }, leaderEquity: 100_000, owned: { 'BTC-USD': { size: 0.01, entry: 80_000, openedAt: 1 } } });
  const { rt } = runtime(w, () => new PaperSink(), { store });
  await rt.start();
  try {
    await ready();
    await rt.reconcileAll();
    const closed = await until(() => size(rt, 'r1') === 0, 1000);
    assert.ok(closed, `the copy still holds ${size(rt, 'r1')} BTC; the leader is flat since before the restart`);
  } finally {
    await rt.stop();
  }
});

test('BUG runtime: a leader close while the copy was paused leaves the copy\'s position open after it resumes', async () => {
  const w = world();
  const { rt } = runtime(w, () => new PaperSink());
  await rt.start();
  try {
    const s = await rt.add(sub({ paper: true }, { id: 'pz' }));
    await ready();
    leaderBuys('1');
    assert.ok(await until(() => size(rt, s.id) === 0.01));
    await rt.pause(s.id);
    leaderSells('1');
    await wait(300);
    w.leader = [];
    await rt.resume(s.id);
    await rt.reconcileAll();
    const closed = await until(() => size(rt, s.id) === 0, 800);
    assert.ok(closed, `resumed copy still holds ${size(rt, s.id)} BTC of a position the leader closed`);
  } finally {
    await rt.stop();
  }
});

test('BUG runtime: a close that fills only partly is never retried; the rest stays open while the leader is flat', async () => {
  const w = world();
  const { rt } = runtime(w, () => partialPaper(0.5));
  await rt.start();
  try {
    const s = await rt.add(sub({ paper: true }, { id: 'pc' }));
    await ready();
    leaderBuys('1');
    assert.ok(await until(() => size(rt, s.id) === 0.01));
    leaderSells('1');
    assert.ok(await until(() => size(rt, s.id) === 0.005));
    await rt.reconcileAll(); // a reconcile: the leader is flat on REST too
    const closed = await until(() => size(rt, s.id) === 0, 800);
    assert.ok(closed, `the copy holds ${size(rt, s.id)} BTC, the leader nothing; nothing retries the close`);
  } finally {
    await rt.stop();
  }
});

test('BUG runtime: a reconcile whose REST read started before a stream fill undoes that fill (copy closed, then reopened a minute later)', async () => {
  const w = world();
  const { rt } = runtime(w, () => new PaperSink());
  await rt.start();
  try {
    const s = await rt.add(sub({ paper: true }, { id: 'rc1' }));
    await ready();
    let open!: () => void;
    w.gate = new Promise<void>((r) => (open = r));
    const rec = rt.reconcileAll(); // reads the leader: flat at this instant, the answer is slow
    await wait(20);
    leaderBuys('1'); // the leader buys; the stream shows it
    assert.ok(await until(() => size(rt, s.id) === 0.01));
    w.leader = [{ s: 'BTC-USD', sz: '1', ep: '80000' }];
    w.gate = null;
    open();
    await rec;
    await wait(300);
    assert.equal(size(rt, s.id), 0.01, 'the stale REST answer closed a copy of a position the leader holds');
  } finally {
    await rt.stop();
  }
});

test('BUG runtime: a reconcile that sees a fill before its stream print is flushed counts the fill twice (copy doubles)', async () => {
  const w = world();
  const { rt } = runtime(w, () => new PaperSink());
  await rt.start();
  try {
    const s = await rt.add(sub({ paper: true }, { id: 'rc2' }));
    await ready();
    w.leader = [{ s: 'BTC-USD', sz: '1', ep: '80000' }]; // REST already has the fill
    let open!: () => void;
    w.gate = new Promise<void>((r) => (open = r));
    const rec = rt.reconcileAll();
    await wait(20);
    leaderBuys('1'); // the same fill on the stream, held for COALESCE_MS
    w.gate = null;
    open();
    await rec;
    await wait(500);
    assert.equal(size(rt, s.id), 0.01, `the leader holds 1 BTC; the copy holds ${size(rt, s.id)} (2 BTC worth)`);
  } finally {
    await rt.stop();
  }
});

test('BUG runtime (live): a second leader fill before the first copy order is booked is sized from the stale position (over-copy)', async () => {
  const w = world();
  const rec = recordingSink();
  const { rt } = runtime(w, () => rec.sink);
  await rt.start();
  try {
    await rt.add(sub({}, { id: 'lv1' }));
    await ready();
    leaderBuys('1'); // copy 0.01
    assert.ok(await until(() => rec.placed.length === 1));
    leaderBuys('1'); // 200 ms later, same order still filling: target 0.02 in total
    assert.ok(await until(() => rec.placed.length === 2));
    const total = rec.placed.flat().reduce((a, i) => a + (i.side === 'buy' ? 1 : -1) * Number(i.quantity), 0);
    assert.ok(Math.abs(total - 0.02) < 1e-9, `the copier bought ${total} BTC for a leader at 2 BTC (target 0.02)`);
  } finally {
    await rt.stop();
  }
});

test('BUG runtime (live): orders in flight on another market are not counted against the leverage cap', async () => {
  const w = world();
  const rec = recordingSink();
  const { rt } = runtime(w, () => rec.sink);
  await rt.start();
  try {
    await rt.add(sub({ maxPositionUsd: 1_000_000, maxLeverage: 5 }, { id: 'lv2' })); // cap: 5 x 1,000 = 5,000 gross
    await ready();
    // 5 BTC: a 4,000 copy, inside the cap, so the ETH copy has 1,000 of room left and is placed.
    // (With 10 BTC the BTC copy alone took the whole 5,000 and ETH, rightly, got no order.)
    leaderBuys('5', '80000', 'BTC-USD');
    assert.ok(await until(() => rec.placed.length === 1));
    leaderBuys('2000', '2000', 'ETH-USD');
    assert.ok(await until(() => rec.placed.length === 2));
    const gross = rec.placed.flat().reduce((a, i) => a + i.notionalUsd, 0);
    assert.ok(gross <= 5_000 * 1.001, `gross copied exposure ${gross.toFixed(0)} USD on a 1,000 copy capped at 5x`);
  } finally {
    await rt.stop();
  }
});

test('BUG runtime: "ask me each time" (approval confirm) trades without asking where the host has no confirm (hosted / self executor)', async () => {
  const w = world();
  const { rt } = runtime(w, () => new PaperSink()); // the executor's host passes no confirm()
  await rt.start();
  try {
    const s = await rt.add(sub({ paper: true, approval: 'confirm' }, { id: 'cf' }));
    await ready();
    leaderBuys('1');
    await wait(400);
    assert.equal(size(rt, s.id), 0, 'a trade the follower must confirm was placed without asking');
  } finally {
    await rt.stop();
  }
});

test('BUG runtime: lowering a copy\'s allocation fires its drawdown stop (the peak keeps the old allocation) and closes everything', async () => {
  const w = world();
  const { rt } = runtime(w, () => new PaperSink());
  await rt.start();
  try {
    const s = await rt.add(sub({ paper: true, allocationUsd: 10_000 }, { id: 'al' }));
    await ready();
    leaderBuys('1');
    assert.ok(await until(() => size(rt, s.id) > 0));
    await rt.update(s.id, { settings: { ...s.settings, allocationUsd: 1_000 } });
    await wait(2_600); // one guard pass
    assert.equal(rt.get(s.id)!.status, 'active', `status ${rt.get(s.id)!.status}: ${rt.get(s.id)!.statusReason}`);
    assert.ok(size(rt, s.id) > 0, 'the copy was closed by the drawdown stop');
  } finally {
    await rt.stop();
  }
});

test('BUG runtime (live): a failed leverage change is remembered as done and never retried (EEA 2x not set on SoDEX)', async () => {
  const w = world();
  const rec = recordingSink({ leverageFailsOnce: true });
  const { rt } = runtime(w, () => rec.sink);
  await rt.start();
  try {
    await rt.add(sub({}, { id: 'lev', country: 'DE' }));
    await ready();
    leaderBuys('1');
    assert.ok(await until(() => rec.placed.length === 1));
    await wait(250);
    leaderBuys('1');
    assert.ok(await until(() => rec.placed.length === 2));
    assert.ok(rec.leverage() >= 2, `setLeverage was tried ${rec.leverage()} time(s); the first failed and the copy kept opening at the account's leverage`);
  } finally {
    await rt.stop();
  }
});

test('BUG runtime: a US follower stays active (and copies) when the readiness read of SoDEX fails', async () => {
  const w = world({ failBuilders: true });
  const rec = recordingSink();
  const { rt } = runtime(w, () => rec.sink);
  await rt.start();
  try {
    const s = await rt.add(sub({}, { id: 'usx', country: 'US' }));
    assert.equal(rt.get(s.id)!.status, 'blocked', 'the region rule depends on a SoDEX read succeeding');
  } finally {
    await rt.stop();
  }
});

test('coverage runtime: a US follower is blocked when SoDEX answers', async () => {
  const w = world();
  const rec = recordingSink();
  const { rt } = runtime(w, () => rec.sink);
  await rt.start();
  try {
    const s = await rt.add(sub({}, { id: 'us2', country: 'US' }));
    assert.equal(rt.get(s.id)!.status, 'blocked');
  } finally {
    await rt.stop();
  }
});

async function liveCopyWithPosition(rec: ReturnType<typeof recordingSink>, id: string) {
  const w = world();
  const { rt } = runtime(w, () => rec.sink);
  await rt.start();
  const s = await rt.add(sub({ stopLossPct: 0.5 }, { id }));
  await ready();
  leaderBuys('1');
  await until(() => rec.placed.length === 1);
  // The follower's own fill on the public stream books the copy; SoDEX holds it too.
  sodexWs().push(print('BUY', '0.01', '80000', FOLLOWER_ID, 1002));
  w.follower = [{ s: 'BTC-USD', sz: '0.01', ep: '80000', l: 5, m: 'ISOLATED' }];
  await until(() => size(rt, s.id) === 0.01);
  await until(() => rec.stops.length > 0, 3_500); // the SoDEX stop-loss is placed 2 s after the fill
  return { rt, s, w };
}

test('BUG runtime (live): stop and close whose close order is refused reports "positions closed" and removes the stop-loss of the open position', async () => {
  const rec = recordingSink({ rejectReduce: true });
  const { rt, s } = await liveCopyWithPosition(rec, 'sc');
  try {
    assert.ok(rec.stops.length > 0, 'precondition: a SoDEX stop-loss was placed');
    const out = await rt.stopCopy(s.id, { close: true });
    await wait(200);
    const open = size(rt, s.id);
    assert.ok(open > 0, 'precondition: the close was refused');
    const claimsClosed = out.status === 'stopped' && /positions closed/.test(out.statusReason ?? '');
    assert.ok(!claimsClosed, `status "${out.status}: ${out.statusReason}" while ${open} BTC is still open`);
    assert.equal(rec.cancels.length, 0, 'the stop-loss of a still-open position was cancelled');
  } finally {
    await rt.stop();
  }
});

test('BUG runtime (live): stop keeping positions cancels the SoDEX stop-loss of every position it keeps', async () => {
  const rec = recordingSink();
  const { rt, s } = await liveCopyWithPosition(rec, 'sk');
  try {
    assert.ok(rec.stops.length > 0, 'precondition: a SoDEX stop-loss was placed');
    await rt.stopCopy(s.id, { close: false });
    await wait(200);
    assert.equal(rec.cancels.length, 0, `${rec.cancels.length} stop order(s) cancelled; the kept position is now unprotected and unmanaged`);
  } finally {
    await rt.stop();
  }
});

test('coverage runtime: paper copy follows open, decrease and close with exact sizes', async () => {
  const w = world();
  const { rt } = runtime(w, () => new PaperSink());
  await rt.start();
  try {
    const s = await rt.add(sub({ paper: true }, { id: 'cv' }));
    await ready();
    leaderBuys('2');
    const near = (x: number) => () => Math.abs(size(rt, s.id) - x) <= Math.abs(x) * 0.01 + 1e-12; // proportional on the current copy equity (paper fees move it a little)
    assert.ok(await until(near(0.02)), `open: ${size(rt, s.id)}`); // 160,000 on 100,000 -> 1,600 of 1,000
    leaderSells('1');
    assert.ok(await until(near(0.01)), `decrease: ${size(rt, s.id)}`);
    leaderSells('3'); // flip to short 2
    assert.ok(await until(near(-0.02)), `flip: ${size(rt, s.id)}`);
    leaderBuys('2');
    assert.ok(await until(() => size(rt, s.id) === 0));
  } finally {
    await rt.stop();
  }
});

test('coverage runtime: the same stream print twice (reconnect replay) is copied once', async () => {
  const w = world();
  const { rt } = runtime(w, () => new PaperSink());
  await rt.start();
  try {
    const s = await rt.add(sub({ paper: true }, { id: 'dup' }));
    await ready();
    const p = print('BUY', '1', '80000', LEADER_ID, 1002);
    sodexWs().push(p);
    sodexWs().push(p);
    await wait(400);
    assert.equal(size(rt, s.id), 0.01);
    void ETH;
  } finally {
    await rt.stop();
  }
});

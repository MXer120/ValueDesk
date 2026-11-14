/**
 * SoDEX in maintenance (owner 2026-11-11: its gateway answered HTTP 503 on every route): algos and bots are held
 * (AlgoHost.venue), nothing they meet then counts as a refusal - no algo ends failed, no bot closes or stops - and a
 * child sent into the maintenance is settled minutes after SoDEX is back, once SoDEX lists it nowhere (MAINT_SETTLE_MS),
 * not after UNLISTED_SETTLE_MS (20 min).
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  AlgoRuntime,
  MAINTENANCE_UNKNOWN,
  MemoryAlgoStore,
  BOT_FEE,
  refusalKind,
  silentLogger,
  type AlgoMarket,
  type AlgoRecord,
  type AlgoSink,
  type ChildRequest,
  type ChildResult,
  type MarkInfo,
  type MarketInfo,
  type OrderUpdate,
  type Print,
  type Quote,
  type SodexClient,
  type VenueHold,
} from '../src/index.ts';
import { BTC, FOLLOWER } from './helpers.ts';

const T0 = 1_800_000_000_000;
let clock = T0;
const realNow = Date.now;
beforeEach(() => {
  clock = T0;
  Date.now = () => clock;
});
afterEach(() => {
  Date.now = realNow;
});

const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 5));
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

const MKT: MarketInfo = { ...BTC, makerFee: 0.00012 };

class FakeMarket implements AlgoMarket {
  readonly up = true;
  q: Quote = { bid: 60_000, ask: 60_002, at: 0 };
  mk = 60_001;
  orderCbs: Array<(u: OrderUpdate) => void> = [];
  start(): void {}
  stop(): void {}
  watch(): void {}
  set(bid: number, ask: number): void {
    this.q = { bid, ask, at: Date.now() };
    this.mk = (bid + ask) / 2;
  }
  quote(): Quote | null {
    return { ...this.q, at: Date.now() };
  }
  last() {
    return { price: this.mk, at: Date.now() };
  }
  mark(): MarkInfo | null {
    return { mark: this.mk, index: this.mk, funding: 0, oi: 1000, at: Date.now() };
  }
  price(): number | null {
    return this.mk;
  }
  priceAgo(): number | null {
    return null;
  }
  oiAgo(): number | null {
    return 1000;
  }
  volume() {
    return { qty: 0, usd: 0 };
  }
  onPrint(_cb: (p: Print) => void): void {}
  onOrder(cb: (u: OrderUpdate) => void): void {
    this.orderCbs.push(cb);
  }
  onState(): void {}
  order(u: Partial<OrderUpdate> & { clOrdID: string }): void {
    for (const cb of this.orderCbs) cb({ orderId: '1', symbol: 'BTC-USD', status: 'NEW', filledQty: 0, filledValue: 0, maker: null, reason: null, at: Date.now(), ...u });
  }
}

/**
 * SoDEX: `mode` 'up' takes orders (IOCs fill at the touch, the rest rest); 'gateway503' answers as SodexClient does to
 * a 503 (outcome unknown, flagged maintenance); 'text' refuses with SoDEX's maintenance words.
 */
class Exchange implements AlgoSink {
  readonly paper = false;
  mode: 'up' | 'gateway503' | 'text' = 'up';
  placed: ChildRequest[] = [];
  cancelled: string[] = [];
  resting = new Map<string, ChildRequest>();
  history = new Map<string, { clOrdID: string; orderId: string; status: string; executedQty: number; executedValue: number }>();
  position = 0;
  constructor(private readonly m: FakeMarket) {}
  async place(_a: AlgoRecord, _mk: MarketInfo, orders: ChildRequest[]): Promise<ChildResult[]> {
    if (this.mode === 'gateway503') return orders.map((o) => ({ clOrdID: o.clOrdID, ok: false, orderId: null, error: MAINTENANCE_UNKNOWN, outcomeUnknown: true, maintenance: true }));
    if (this.mode === 'text') return orders.map((o) => ({ clOrdID: o.clOrdID, ok: false, orderId: null, error: 'order rejected: system maintenance in progress', outcomeUnknown: false }));
    this.placed.push(...orders);
    for (const o of orders) {
      const touch = o.side === 'buy' ? this.m.q.ask : this.m.q.bid;
      if (o.tif === 'ioc') {
        const qty = (o.side === 'buy' ? Number(o.price) >= touch : Number(o.price) <= touch) ? Number(o.quantity) : 0;
        this.position += (o.side === 'buy' ? 1 : -1) * qty;
        this.history.set(o.clOrdID, { clOrdID: o.clOrdID, orderId: '1', status: qty > 0 ? 'FILLED' : 'CANCELED', executedQty: qty, executedValue: qty * touch });
        setImmediate(() => this.m.order({ clOrdID: o.clOrdID, status: qty > 0 ? 'FILLED' : 'CANCELED', filledQty: qty, filledValue: qty * touch, maker: false }));
      } else {
        this.resting.set(o.clOrdID, o);
        this.history.set(o.clOrdID, { clOrdID: o.clOrdID, orderId: '1', status: 'NEW', executedQty: 0, executedValue: 0 });
        setImmediate(() => this.m.order({ clOrdID: o.clOrdID, status: 'NEW' }));
      }
    }
    return orders.map((o) => ({ clOrdID: o.clOrdID, ok: true, orderId: '1', error: null, outcomeUnknown: false }));
  }
  async cancel(_a: AlgoRecord, _m: MarketInfo, ids: string[]): Promise<void> {
    if (this.mode !== 'up') throw new Error(MAINTENANCE_UNKNOWN);
    this.cancelled.push(...ids);
    for (const id of ids) {
      if (!this.resting.delete(id)) continue;
      const h = this.history.get(id);
      if (h) h.status = 'CANCELED';
      setImmediate(() => this.m.order({ clOrdID: id, status: 'CANCELED' }));
    }
  }
  async setLeverage(): Promise<void> {}
  async placeStops(): Promise<ChildResult[]> {
    return [];
  }
}

interface Rig {
  rt: AlgoRuntime;
  market: FakeMarket;
  ex: Exchange;
  store: MemoryAlgoStore;
  venue: VenueHold | null;
}

const HOLD: VenueHold = { reason: 'SoDEX is in maintenance. Nothing is sent until it is back.', since: T0, expectedEnd: null };

async function rig(): Promise<Rig> {
  const market = new FakeMarket();
  const r: Rig = { rt: null as unknown as AlgoRuntime, market, ex: new Exchange(market), store: new MemoryAlgoStore(), venue: null };
  const sodex = {
    markets: async () => [MKT],
    follower: async () => ({ equity: 1_000_000, positions: { 'BTC-USD': { size: r.ex.position, entry: 60_000, leverage: 1, leverageReported: true } } }),
    fills: async () => [],
    get: async () => [],
  } as unknown as SodexClient;
  r.rt = new AlgoRuntime({
    confirmGapMs: 0,
    store: r.store,
    sodex,
    network: 'mainnet',
    market,
    sinkFor: () => r.ex,
    log: silentLogger,
    autoTick: false,
    builderRate: () => BOT_FEE / 100_000,
    brake: () => null,
    venue: () => r.venue,
    problem: async () => null,
    account: async () => ({ equity: 1_000_000, gross: 0 }),
    // Open orders: what rests; history: every order SoDEX took. One sent into the maintenance is in neither.
    lookup: async (_a, _s, history) => (history ? [...r.ex.history.values()] : [...r.ex.history.values()].filter((h) => r.ex.resting.has(h.clOrdID))).map((h) => ({ ...h })),
  });
  await r.rt.start();
  market.set(60_000, 60_002);
  return r;
}

async function step(r: Rig, id: string, advanceMs = 0): Promise<AlgoRecord> {
  clock += advanceMs;
  await r.rt.stepNow(id, clock);
  await settle();
  return r.rt.get(id)!;
}

const add = (r: Rig, spec: Record<string, unknown>) => r.rt.add({ owner: FOLLOWER, accountId: 42, mode: 'hosted', spec: { symbol: 'BTC-USD', ...spec }, seed: 7 });
const MM = { kind: 'mm', orderUsd: 60, maxInventoryUsd: 180, chaseTicks: 2, minRepriceMs: 3_000, skewTicks: 4, maxLossUsd: 1_000_000 };
const texts = async (r: Rig, id: string) => (await r.rt.events(id, { limit: 500 })).map((e) => e.text);

test('refusals: SoDEX\'s maintenance words are their own kind, never counted (and a size like 0.503 is not one)', () => {
  assert.equal(refusalKind('order rejected: system maintenance in progress'), 'maintenance');
  assert.equal(refusalKind('Service temporarily unavailable'), 'maintenance');
  assert.equal(refusalKind('trading suspended for maintenance'), 'maintenance');
  assert.equal(refusalKind('SoDEX answered HTTP 503 after receiving the request'), 'maintenance');
  assert.equal(refusalKind('quantity 0.503 exceeds the position size'), 'position');
});

test('a bot never closes or stops because of SoDEX maintenance: 200 maintenance refusals in a row, then held while it lasts, then it goes on', async () => {
  const r = await rig();
  const a = await add(r, MM);
  await step(r, a.id);
  assert.ok(r.ex.placed.length > 0, 'it quotes');
  // The gap before the watch says so: SoDEX refuses with its maintenance words. None counts.
  r.ex.mode = 'text';
  for (const c of r.ex.resting.keys()) r.ex.resting.delete(c);
  for (const c of r.rt.get(a.id)!.children) r.market.order({ clOrdID: c.clOrdID, status: 'CANCELED' });
  await settle();
  for (let i = 0; i < 200; i++) await step(r, a.id, 4_000);
  let x = r.rt.get(a.id)!;
  assert.ok(!['failed', 'done', 'cancelled'].includes(x.status), `still on: ${x.status} ${x.statusReason}`);
  assert.equal(Number(x.k.consecRejects ?? 0), 0, 'no maintenance refusal counts');
  assert.equal(x.k.failRounds, undefined, 'no stop round');
  assert.equal(x.k.closing, undefined, 'no close');
  // The watch says maintenance: held, nothing sent (not even a cancel or a close).
  r.venue = HOLD;
  const placed = r.ex.placed.length;
  for (let i = 0; i < 30; i++) await step(r, a.id, 60_000);
  x = r.rt.get(a.id)!;
  assert.equal(x.status, 'waiting');
  assert.match(x.statusReason ?? '', /SoDEX is in maintenance/);
  assert.equal(r.ex.placed.length, placed);
  // Back: it quotes again by itself and says so.
  r.ex.mode = 'up';
  r.venue = null;
  for (let i = 0; i < 5; i++) await step(r, a.id, 4_000);
  x = r.rt.get(a.id)!;
  assert.equal(x.status, 'running', `${x.status} ${x.statusReason}`);
  assert.ok(r.ex.placed.length > placed, 'quotes again');
  assert.ok((await texts(r, a.id)).some((t) => /back from maintenance/.test(t)));
  await r.rt.stop();
});

test('an algo order never ends failed because of SoDEX maintenance (well past MAX_CONSEC_REJECTS refusals)', async () => {
  const r = await rig();
  r.ex.mode = 'text';
  const a = await add(r, { kind: 'twap', side: 'buy', quantity: '0.004', durationMs: 240_000, slices: 4, exec: { style: 'taker', slippageBps: 30 } });
  for (let i = 0; i < 60; i++) await step(r, a.id, 5_000);
  const x = r.rt.get(a.id)!;
  assert.notEqual(x.status, 'failed', `${x.statusReason}`);
  assert.equal(Number(x.k.consecRejects ?? 0), 0);
  await r.rt.stop();
});

test('a child sent into the maintenance (503) is settled minutes after SoDEX is back once it lists it nowhere, not after 20 min; the algo then goes on', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', side: 'buy', quantity: '0.004', durationMs: 240_000, slices: 4, exec: { style: 'taker', slippageBps: 30 } });
  r.ex.mode = 'gateway503';
  let x = await step(r, a.id);
  const lost = x.children.find((c) => c.state === 'unknown');
  assert.ok(lost, 'the slice is unknown, never re-sent');
  assert.equal(lost!.maint, true);
  assert.ok((await texts(r, a.id)).some((t) => /most likely not placed/.test(t)));
  // The watch says maintenance: held for an hour, nothing read or sent.
  r.venue = HOLD;
  for (let i = 0; i < 60; i++) await step(r, a.id, 60_000);
  assert.equal(r.rt.get(a.id)!.status, 'waiting');
  // SoDEX is back and lists the slice nowhere: cancelled by its id and settled within a few minutes.
  r.ex.mode = 'up';
  r.venue = null;
  const back = clock;
  for (let i = 0; i < 60 && r.rt.get(a.id)!.children.find((c) => c.clOrdID === lost!.clOrdID)!.state !== 'done'; i++) await step(r, a.id, 10_000);
  x = r.rt.get(a.id)!;
  assert.equal(x.children.find((c) => c.clOrdID === lost!.clOrdID)!.state, 'done', 'settled');
  assert.ok(clock - back <= 5 * 60_000, `settled ${(clock - back) / 1000} s after SoDEX was back`);
  assert.ok(r.ex.cancelled.includes(lost!.clOrdID), 'cancelled by its id first');
  // Nothing went out in its place before it was settled; then the rest of the size, once.
  const t = await texts(r, a.id);
  assert.ok(t.findIndex((x) => /it is over/.test(x)) > t.findIndex((x) => /^Take buy 0.004/.test(x)), 'settled before the finish was sent (events newest first)');
  // The algo goes on and fills its size exactly: what the lost slice was to buy is sent again, once.
  for (let i = 0; i < 60 && !['done', 'expired', 'failed'].includes(r.rt.get(a.id)!.status); i++) await step(r, a.id, 10_000);
  x = r.rt.get(a.id)!;
  assert.equal(x.status, 'done', `${x.status} ${x.statusReason}`);
  assert.ok(Math.abs(r.ex.position - 0.004) < 1e-9, `position ${r.ex.position}`);
  assert.ok(Math.abs(r.ex.placed.reduce((q, o) => q + Number(o.quantity), 0) - 0.004) < 1e-9, 'never more sent than the size');
  await r.rt.stop();
});

test('an unknown child that is not a maintenance one still waits UNLISTED_SETTLE_MS (nothing changed there)', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', side: 'buy', quantity: '0.004', durationMs: 240_000, slices: 4, exec: { style: 'taker', slippageBps: 30 } });
  const plain = r.ex.place.bind(r.ex);
  r.ex.place = async (_a, _m, orders) => orders.map((o) => ({ clOrdID: o.clOrdID, ok: false, orderId: null, error: 'SoDEX did not answer; the request may still have executed.', outcomeUnknown: true }));
  const x0 = await step(r, a.id);
  const lost = x0.children.find((c) => c.state === 'unknown')!;
  assert.equal(lost.maint, undefined);
  r.ex.place = plain;
  for (let i = 0; i < 30; i++) await step(r, a.id, 10_000);
  assert.notEqual(r.rt.get(a.id)!.children.find((c) => c.clOrdID === lost.clOrdID)!.state, 'done', 'still waiting after 5 min');
  await r.rt.stop();
});

/**
 * Audit of the time-sliced algo kinds (TWAP, Chase TWAP, VWAP, POV, DCA) and
 * the machinery they share (exec styles, slippage, finish, participation,
 * slice bounds, close, jitter, urgency, limit, bounds, spread guard, start
 * time / price, pause / resume / cancel, restarts, exits, paper, rejects).
 *
 * Every test asserts the INTENDED behaviour (types.ts, docs/ALGO-ORDERS.md):
 * a failing test is a bug. The harness is a copy of algo-runtime.test.ts's,
 * with a few knobs added (volume, stop answers, held cancels, async hooks).
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  AlgoRuntime,
  MemoryAlgoStore,
  silentLogger,
  twapSchedule,
  type AlgoMarket,
  type AlgoRecord,
  type AlgoSink,
  type ChildRequest,
  type ChildResult,
  type MarkInfo,
  type OrderUpdate,
  type Print,
  type PriceSource,
  type Quote,
  type SodexClient,
  type StopRequest,
} from '../src/index.ts';
import { BTC, ETH, FOLLOWER } from './helpers.ts';

const ACCOUNT = 42;
let clock = 1_800_000_000_000;
const realNow = Date.now;
beforeEach(() => {
  clock = 1_800_000_000_000;
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

class FakeMarket implements AlgoMarket {
  readonly up = true;
  quotes = new Map<string, Quote>();
  marks = new Map<string, MarkInfo>();
  printCbs: Array<(p: Print) => void> = [];
  orderCbs: Array<(u: OrderUpdate) => void> = [];
  /** What volume() answers (base units in any window). */
  vol = 0;
  start(): void {}
  stop(): void {}
  watch(): void {}
  set(symbol: string, bid: number, ask: number, mark = (bid + ask) / 2): void {
    this.quotes.set(symbol, { bid, ask, at: Date.now() });
    this.marks.set(symbol, { mark, index: mark, funding: 0.0001, oi: 1000, at: Date.now() });
  }
  quote(symbol: string): Quote | null {
    return this.quotes.get(symbol) ?? null;
  }
  last(symbol: string) {
    const m = this.marks.get(symbol);
    return m ? { price: m.mark, at: m.at } : null;
  }
  mark(symbol: string): MarkInfo | null {
    return this.marks.get(symbol) ?? null;
  }
  price(symbol: string, source: PriceSource): number | null {
    const q = this.quote(symbol);
    if (source === 'mid') return q ? (q.bid + q.ask) / 2 : null;
    return this.marks.get(symbol)?.mark ?? null;
  }
  priceAgo(): number | null {
    return null;
  }
  oiAgo(): number | null {
    return 1000;
  }
  volume(): { qty: number; usd: number } {
    return { qty: this.vol, usd: this.vol * 60_000 };
  }
  onPrint(cb: (p: Print) => void): void {
    this.printCbs.push(cb);
  }
  onOrder(cb: (u: OrderUpdate) => void): void {
    this.orderCbs.push(cb);
  }
  onState(): void {}
  print(p: Partial<Print> & { price: number; qty: number }): void {
    for (const cb of this.printCbs) cb({ symbol: 'BTC-USD', buyer: 7, seller: 8, taker: 'sell', at: Date.now(), ...p });
  }
  order(u: Partial<OrderUpdate> & { clOrdID: string }): void {
    for (const cb of this.orderCbs) cb({ orderId: '1', symbol: 'BTC-USD', status: 'NEW', filledQty: 0, filledValue: 0, maker: null, reason: null, at: Date.now(), ...u });
  }
}

class FakeSink implements AlgoSink {
  readonly paper = false;
  placed: ChildRequest[][] = [];
  cancelled: string[] = [];
  leverage: number[] = [];
  resting = new Map<string, ChildRequest & { filled: number }>();
  mode: 'ok' | 'unknown' | 'reject' = 'ok';
  autoFill = true;
  /** How placeStops answers. */
  stopMode: 'ok' | 'unknown' | 'reject' = 'ok';
  /** Cancels of exits are recorded but SoDEX does not confirm them (yet). */
  holdStopCancels = false;
  heldStopCancels: string[] = [];
  stopIds = new Set<string>();
  constructor(private readonly m: FakeMarket) {}
  get all(): ChildRequest[] {
    return this.placed.flat();
  }
  async place(_a: AlgoRecord, mk: { name: string }, orders: ChildRequest[]): Promise<ChildResult[]> {
    this.placed.push(orders);
    if (this.mode !== 'ok') return orders.map((o) => ({ clOrdID: o.clOrdID, ok: false, orderId: null, error: this.mode === 'reject' ? 'nope' : 'timeout', outcomeUnknown: this.mode === 'unknown' }));
    for (const o of orders) {
      const q = this.m.quote(mk.name)!;
      const touch = o.side === 'buy' ? q.ask : q.bid;
      const reaches = o.side === 'buy' ? Number(o.price) >= touch : Number(o.price) <= touch;
      setImmediate(() => {
        if (o.tif === 'ioc') {
          if (this.autoFill && reaches) this.m.order({ clOrdID: o.clOrdID, status: 'FILLED', filledQty: Number(o.quantity), filledValue: Number(o.quantity) * touch, maker: false });
          else this.m.order({ clOrdID: o.clOrdID, status: 'CANCELED' });
        } else {
          this.resting.set(o.clOrdID, { ...o, filled: 0 });
          this.m.order({ clOrdID: o.clOrdID, status: 'NEW' });
        }
      });
    }
    return orders.map((o) => ({ clOrdID: o.clOrdID, ok: true, orderId: '1', error: null, outcomeUnknown: false }));
  }
  async cancel(_a: AlgoRecord, _m: unknown, ids: string[]): Promise<void> {
    this.cancelled.push(...ids);
    for (const id of ids) {
      if (this.stopIds.has(id) && this.holdStopCancels) {
        this.heldStopCancels.push(id);
        continue;
      }
      const r = this.resting.get(id);
      this.resting.delete(id);
      setImmediate(() => this.m.order({ clOrdID: id, status: 'CANCELED', filledQty: r?.filled ?? 0, filledValue: (r?.filled ?? 0) * Number(r?.price ?? 0) }));
    }
  }
  releaseStopCancels(): void {
    for (const id of this.heldStopCancels.splice(0)) this.m.order({ clOrdID: id, status: 'CANCELED' });
  }
  async setLeverage(_a: AlgoRecord, _m: unknown, lev: number): Promise<void> {
    this.leverage.push(lev);
  }
  stops: StopRequest[][] = [];
  async placeStops(_a: AlgoRecord, _m: unknown, stops: StopRequest[]): Promise<ChildResult[]> {
    this.stops.push(stops);
    for (const s of stops) this.stopIds.add(s.clOrdID);
    if (this.stopMode !== 'ok') return stops.map((s) => ({ clOrdID: s.clOrdID, ok: false, orderId: null, error: this.stopMode === 'reject' ? 'stop refused' : 'timeout', outcomeUnknown: this.stopMode === 'unknown' }));
    for (const s of stops) setImmediate(() => this.m.order({ clOrdID: s.clOrdID, status: 'NEW' }));
    return stops.map((s) => ({ clOrdID: s.clOrdID, ok: true, orderId: '2', error: null, outcomeUnknown: false }));
  }
  fill(id: string, qty: number): void {
    const r = this.resting.get(id)!;
    r.filled += qty;
    const done = r.filled >= Number(r.quantity) - 1e-12;
    if (done) this.resting.delete(id);
    this.m.order({ clOrdID: id, status: done ? 'FILLED' : 'PARTIALLY_FILLED', filledQty: r.filled, filledValue: r.filled * Number(r.price), maker: true });
  }
}

interface Rig {
  rt: AlgoRuntime;
  market: FakeMarket;
  sink: FakeSink;
  store: MemoryAlgoStore;
  position: { size: number; entry: number };
  lookupRows: Array<{ clOrdID: string; orderId: string; status: string; executedQty: number; executedValue: number }>;
}

interface RigOpts {
  /** Awaited before the readiness check answers (null: none). */
  problem?: () => Promise<string | null>;
  /** The position read (time-sliced close). */
  position?: () => Promise<number | null>;
}

function runtimeOn(r: Omit<Rig, 'rt'>, o: RigOpts = {}): AlgoRuntime {
  const sodex = { markets: async () => [BTC, ETH], follower: async () => ({ positions: { 'BTC-USD': { size: r.position.size, entry: r.position.entry } } }), get: async () => [] } as unknown as SodexClient;
  return new AlgoRuntime({
    store: r.store,
    sodex,
    network: 'mainnet',
    market: r.market,
    sinkFor: () => r.sink,
    log: silentLogger,
    autoTick: false,
    ...(o.problem ? { problem: o.problem } : {}),
    ...(o.position ? { position: o.position } : {}),
    lookup: async (_a, _s, history) => (history ? r.lookupRows : []),
  });
}

async function rig(o: RigOpts = {}): Promise<Rig> {
  const market = new FakeMarket();
  const sink = new FakeSink(market);
  const store = new MemoryAlgoStore();
  const base = { market, sink, store, position: { size: 0, entry: 0 }, lookupRows: [] as Rig['lookupRows'] };
  const rt = runtimeOn(base, o);
  await rt.start();
  market.set('BTC-USD', 60_000, 60_010);
  return { ...base, rt };
}

async function step(r: Rig, id: string, advanceMs = 0, rt = r.rt): Promise<AlgoRecord> {
  clock += advanceMs;
  await rt.stepNow(id, clock);
  await settle();
  return rt.get(id)!;
}

const add = (r: Rig, spec: Record<string, unknown>) => r.rt.add({ owner: FOLLOWER, accountId: ACCOUNT, mode: 'browser', spec: { symbol: 'BTC-USD', side: 'buy', ...spec }, seed: 1 });

const sentQty = (r: Rig) => r.sink.all.reduce((x, o) => x + Number(o.quantity), 0);
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;
const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((res) => {
    open = res;
  });
  return { p, open };
};

/* =================================================================== TWAP ===== */

test('TWAP sell (taker): the cap is measured from the bid, below it, snapped up to the tick', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', side: 'sell', quantity: '0.002', durationMs: 120_000, slices: 2, exec: { style: 'taker', slippageBps: 30 } });
  await step(r, a.id);
  assert.equal(r.sink.all[0]!.side, 'sell');
  assert.equal(r.sink.all[0]!.tif, 'ioc');
  assert.equal(r.sink.all[0]!.price, '59820', 'bid 60000 less 30 bp');
});

test('slipFrom mid: a buy is capped at mid + bp (floored), a sell at mid - bp (ceiled)', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.002', durationMs: 120_000, slices: 2, exec: { style: 'taker', slippageBps: 30, slipFrom: 'mid' } });
  await step(r, a.id);
  assert.equal(r.sink.all[0]!.price, '60185');
  const b = await add(r, { kind: 'twap', side: 'sell', quantity: '0.002', durationMs: 120_000, slices: 2, exec: { style: 'taker', slippageBps: 30, slipFrom: 'mid' } });
  await step(r, b.id);
  assert.equal(r.sink.all.at(-1)!.price, '59825');
});

test('TWAP with one slice: the whole size at once, done, nothing more', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.003', durationMs: 60_000, slices: 1, exec: { style: 'taker' } });
  await step(r, a.id);
  const x = await step(r, a.id, 500);
  assert.equal(r.sink.all.length, 1);
  assert.equal(r.sink.all[0]!.quantity, '0.003');
  assert.equal(x.status, 'done');
});

test('schedule: urgency +1 puts ~e^3 more in the first slice; jitters keep times in order and inside the window, weights summing to 1', () => {
  const start = 1_800_000_000_000;
  const front = twapSchedule({ slices: 10, urgency: 1, sizeJitter: 0, timeJitter: 0, durationMs: 600_000 }, start, 7);
  assert.ok(Math.abs(front.weights[0]! / front.weights[9]! - Math.exp(3)) < 1e-6);
  const back = twapSchedule({ slices: 10, urgency: -1, sizeJitter: 0, timeJitter: 0, durationMs: 600_000 }, start, 7);
  assert.ok(back.weights[9]! > back.weights[0]!);
  const dur = 30 * 86_400_000;
  const big = twapSchedule({ slices: 2000, urgency: 0.7, sizeJitter: 0.5, timeJitter: 0.5, durationMs: dur }, start, 99);
  assert.equal(big.times.length, 2000);
  assert.equal(big.times[0], start);
  for (let i = 1; i < big.times.length; i++) assert.ok(big.times[i]! > big.times[i - 1]!, `slice ${i} in order`);
  assert.ok(big.times.at(-1)! < start + dur);
  assert.ok(big.weights.every((w) => w > 0 && Number.isFinite(w)));
  assert.ok(Math.abs(big.weights.reduce((x, y) => x + y, 0) - 1) < 1e-9);
});

test('TWAP with size and time jitter and front-loading: fills exactly the size, never more', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.01', durationMs: 300_000, slices: 10, urgency: 1, sizeJitter: 0.5, timeJitter: 0.5, exec: { style: 'taker' } });
  let x = await step(r, a.id);
  for (let i = 0; i < 40 && x.status !== 'done'; i++) x = await step(r, a.id, 10_000);
  assert.equal(x.status, 'done');
  assert.ok(near(x.filled, 0.01));
  assert.ok(sentQty(r) <= 0.01 + 1e-12);
});

test('a clock jump past the end: the rest goes in one taker, then done', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.004', durationMs: 240_000, slices: 4, exec: { style: 'taker' } });
  await step(r, a.id);
  await step(r, a.id, 3_600_000);
  const x = await step(r, a.id, 500);
  assert.deepEqual(r.sink.all.map((o) => o.quantity), ['0.001', '0.003']);
  assert.equal(x.status, 'done');
});

test('hybrid: a resting child partly filled, then cancelled, is taken only for the rest', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.002', durationMs: 120_000, slices: 2, finish: 'take', exec: { style: 'hybrid', makerShare: 0.5 } });
  await step(r, a.id);
  r.sink.fill(r.sink.all[0]!.clOrdID, 0.0004);
  await settle();
  await step(r, a.id, 31_000);
  await step(r, a.id, 500);
  assert.equal(r.sink.all[1]!.tif, 'ioc');
  assert.equal(r.sink.all[1]!.quantity, '0.0006');
  let x = r.rt.get(a.id)!;
  for (let i = 0; i < 10 && x.status !== 'done'; i++) x = await step(r, a.id, 31_000);
  assert.equal(x.status, 'done');
  assert.ok(near(x.filled, 0.002));
});

test('Chase TWAP (maker): finish "leave" pulls the resting child at the end and expires', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', label: 'Chase TWAP', quantity: '0.002', durationMs: 120_000, slices: 2, finish: 'leave', exec: { style: 'maker', chaseTicks: 2 } });
  await step(r, a.id);
  assert.equal(r.sink.all[0]!.tif, 'gtx');
  await step(r, a.id, 121_000);
  assert.ok(r.sink.cancelled.includes(r.sink.all.at(-1)!.clOrdID));
  const x = await step(r, a.id, 500);
  assert.equal(x.status, 'expired');
  assert.equal(r.sink.resting.size, 0);
  assert.ok(r.sink.all.every((o) => o.tif === 'gtx'), 'a maker never takes when it is left');
});

test('finish "take" stays within the limit price: nothing is sent past it', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.002', durationMs: 120_000, slices: 2, limitPrice: 60_050, finish: 'take', exec: { style: 'maker' } });
  await step(r, a.id);
  r.market.set('BTC-USD', 60_090, 60_100);
  await step(r, a.id, 121_000);
  await step(r, a.id, 500);
  const x = await step(r, a.id, 500);
  assert.ok(r.sink.all.every((o) => Number(o.price) <= 60_050), 'no child above the limit');
  assert.equal(x.status, 'waiting');
});

test('bounds: rush still keeps the limit price', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.004', durationMs: 240_000, slices: 4, limitPrice: 59_000, lower: { price: 59_500, then: 'rush' }, exec: { style: 'taker', slippageBps: 100 } });
  r.market.set('BTC-USD', 58_990, 59_000);
  await step(r, a.id);
  assert.equal(r.sink.all.length, 1);
  assert.equal(r.sink.all[0]!.quantity, '0.004');
  assert.ok(Number(r.sink.all[0]!.price) <= 59_000);
});

test('bounds: stop ends where it stands (expired, with what filled kept)', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.004', durationMs: 240_000, slices: 4, upper: { price: 61_000, then: 'stop' }, exec: { style: 'taker' } });
  await step(r, a.id);
  r.market.set('BTC-USD', 61_500, 61_510);
  const x = await step(r, a.id, 60_000);
  assert.equal(x.status, 'expired');
  assert.ok(near(x.filled, 0.001));
  assert.equal(r.sink.all.length, 1);
});

test('startAt in the past starts at once; in the future waits for it', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.002', durationMs: 120_000, slices: 2, startAt: clock - 3_600_000, exec: { style: 'taker' } });
  let x = await step(r, a.id);
  assert.equal(x.status, 'running');
  assert.equal(r.sink.all.length, 1);
  const b = await add(r, { kind: 'twap', quantity: '0.002', durationMs: 120_000, slices: 2, startAt: clock + 60_000, exec: { style: 'taker' } });
  x = await step(r, b.id, 1_000);
  assert.equal(x.status, 'scheduled');
  assert.equal(r.sink.all.length, 1);
  x = await step(r, b.id, 60_000);
  assert.equal(x.status, 'running');
  assert.equal(r.sink.all.length, 2);
});

test('triggerPrice: a buy below the market waits for the mark to come down to it', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.002', durationMs: 120_000, slices: 2, triggerPrice: 59_500, exec: { style: 'taker' } });
  let x = await step(r, a.id);
  assert.equal(x.status, 'scheduled');
  r.market.set('BTC-USD', 59_400, 59_410);
  x = await step(r, a.id, 1_000);
  assert.equal(x.status, 'running');
  assert.equal(r.sink.all.length, 1);
});

test('rejects: 25 refusals in a row fail the algo; nothing filled, nothing more sent', async () => {
  const r = await rig();
  r.sink.mode = 'reject';
  const a = await add(r, { kind: 'twap', quantity: '0.002', durationMs: 120_000, slices: 2, exec: { style: 'taker' } });
  let x = await step(r, a.id);
  for (let i = 0; i < 40 && x.status !== 'failed'; i++) x = await step(r, a.id, 500);
  assert.equal(x.status, 'failed');
  const n = r.sink.all.length;
  assert.equal(n, 25);
  await step(r, a.id, 500);
  assert.equal(r.sink.all.length, n);
});

test('pause pulls the resting child and sends nothing; resume carries on', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.002', durationMs: 120_000, slices: 2, exec: { style: 'maker' } });
  await step(r, a.id);
  await r.rt.pause(a.id);
  await settle();
  assert.ok(r.sink.cancelled.includes(r.sink.all[0]!.clOrdID));
  await step(r, a.id, 500);
  await step(r, a.id, 60_000);
  assert.equal(r.sink.all.length, 1, 'nothing while paused');
  await r.rt.resume(a.id);
  await step(r, a.id, 500);
  assert.equal(r.sink.all.length, 2);
});

test('BUG: cancel leaves a resting child whose placement had no answer (unknown) on the book', async () => {
  const r = await rig();
  r.sink.mode = 'unknown';
  const a = await add(r, { kind: 'twap', quantity: '0.002', durationMs: 120_000, slices: 2, exec: { style: 'maker' } });
  const x = await step(r, a.id);
  const c = x.children[0]!;
  assert.equal(c.state, 'unknown');
  r.sink.mode = 'ok';
  await r.rt.cancel(a.id);
  await settle();
  // It may well rest on SoDEX: a cancel by client id is harmless if it does not.
  assert.ok(r.sink.cancelled.includes(c.clOrdID), 'the possibly-resting child is cancelled with the algo');
});

test('BUG: a cancel that lands while a step is in flight still lets that step send a child', async () => {
  let g: ReturnType<typeof gate> | null = null;
  const r = await rig({ problem: async () => {
    if (g) await g.p;
    return null;
  } });
  const a = await add(r, { kind: 'twap', quantity: '0.004', durationMs: 240_000, slices: 4, exec: { style: 'taker' } });
  await step(r, a.id);
  assert.equal(r.sink.all.length, 1);
  g = gate();
  clock += 61_000; // the readiness check is read again (every 60 s)
  const stepping = r.rt.stepNow(a.id, clock);
  await settle();
  await r.rt.cancel(a.id);
  g.open();
  await stepping;
  await settle();
  assert.equal(r.rt.get(a.id)!.status, 'cancelled');
  assert.equal(r.sink.all.length, 1, 'no child after the trader cancelled');
});

test('BUG: a time-sliced close cancelled while its position is being read comes back to life', async () => {
  const g = gate();
  const r = await rig({ position: async () => {
    await g.p;
    return -0.004;
  } });
  const a = await add(r, { kind: 'twap', side: 'sell', closeShare: 1, durationMs: 120_000, slices: 2, exec: { style: 'taker' } });
  const stepping = r.rt.stepNow(a.id, clock);
  await settle();
  await r.rt.cancel(a.id);
  g.open();
  await stepping;
  await settle();
  assert.equal(r.rt.get(a.id)!.status, 'cancelled', 'stays cancelled');
  assert.equal(r.sink.all.length, 0, 'nothing is sent for a cancelled close');
});

test('a time-sliced close of half a position: floored to the step, reduce-only, never more than the share', async () => {
  const r = await rig();
  r.position.size = 0.00333;
  const a = await add(r, { kind: 'twap', closeShare: 0.5, durationMs: 120_000, slices: 2, exec: { style: 'taker' } });
  let x = await step(r, a.id);
  for (let i = 0; i < 5 && x.status !== 'done'; i++) x = await step(r, a.id, 61_000);
  assert.equal(x.status, 'done');
  assert.ok(r.sink.all.every((o) => o.side === 'sell' && o.reduceOnly));
  assert.ok(near(sentQty(r), 0.00166, 1e-12));
});

test('a graceful restart does not send a filled slice again and carries on the schedule', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.004', durationMs: 240_000, slices: 4, exec: { style: 'taker' } });
  await step(r, a.id);
  await r.rt.stop();
  const again = runtimeOn(r);
  await again.start();
  let x = await step(r, a.id, 1_000, again);
  assert.equal(r.sink.all.length, 1);
  for (let i = 0; i < 6 && x.status !== 'done'; i++) x = await step(r, a.id, 60_000, again);
  assert.equal(x.status, 'done');
  assert.equal(r.sink.all.length, 4);
  assert.ok(near(sentQty(r), 0.004));
});

test('BUG: after a crash (no clean stop) the runner sends the first slice again - the child was never written before it left', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.004', durationMs: 240_000, slices: 4, exec: { style: 'taker' } });
  await step(r, a.id);
  assert.equal(r.sink.all.length, 1);
  // The process dies here (no stop(), no flush): a new runner starts on the same store.
  const again = runtimeOn(r);
  await again.start();
  let x = await step(r, a.id, 1_000, again);
  for (let i = 0; i < 6 && x.status !== 'done'; i++) x = await step(r, a.id, 60_000, again);
  assert.ok(sentQty(r) <= 0.004 + 1e-12, `sent ${sentQty(r)} for a size of 0.004`);
});

test('BUG: a largest slice under SoDEX\'s minimum order is refused at the start (it used to stall the TWAP forever)', async () => {
  const r = await rig();
  // 0.0001 BTC is about $6, under the $10 minimum.
  await assert.rejects(add(r, { kind: 'twap', quantity: '0.002', durationMs: 120_000, slices: 2, maxSliceQty: '0.0001', exec: { style: 'taker' } }), /Your largest slice \(0\.0001 BTC, about \$6\) is under SoDEX's \$10 minimum\. Raise it to at least 0\.00017 BTC\./);
});

test('BUG: max participation caps each child but not the slice: one interval takes many times its share', async () => {
  const r = await rig();
  r.market.vol = 0.01; // 0.01 BTC traded in the last interval: 10% is 0.001
  const a = await add(r, { kind: 'twap', quantity: '0.01', durationMs: 600_000, slices: 1, maxParticipation: 0.1, exec: { style: 'taker' } });
  let x = await step(r, a.id);
  for (let i = 0; i < 12; i++) x = await step(r, a.id, 1_100);
  assert.ok(x.filled <= 0.001 * 2 + 1e-12, `filled ${x.filled} within 15 s while 10% of the interval's volume is 0.001`);
});

test('max participation with no volume: nothing before the end, the rest taken at the end', async () => {
  const r = await rig();
  r.market.vol = 0;
  const a = await add(r, { kind: 'twap', quantity: '0.002', durationMs: 120_000, slices: 2, maxParticipation: 0.1, exec: { style: 'taker' } });
  await step(r, a.id);
  await step(r, a.id, 60_000);
  assert.equal(r.sink.all.length, 0);
  await step(r, a.id, 61_000);
  const x = await step(r, a.id, 500);
  assert.equal(r.sink.all.length, 1);
  assert.equal(x.status, 'done');
});

test('BUG: a rush (or a catch-up) sends one child over SoDEX\'s max order value', async () => {
  const r = await rig();
  // 100 BTC in 10 slices: each ~$600k is fine; all at once is ~$5.8M > $5M.
  const a = await add(r, { kind: 'twap', quantity: '100', durationMs: 600_000, slices: 10, lower: { price: 59_000, then: 'rush' }, exec: { style: 'taker' } });
  r.market.set('BTC-USD', 58_000, 58_010);
  await step(r, a.id);
  assert.ok(r.sink.all.length > 0);
  for (const o of r.sink.all) assert.ok(Number(o.quantity) * Number(o.price) <= BTC.maxNotional!, `child ${o.quantity} @ ${o.price} = $${Math.round(Number(o.quantity) * Number(o.price))}`);
});

test('BUG (if SoDEX values an order at its limit): a sell child sized to the minimum at the bid is under the minimum at its own price', async () => {
  const r = await rig();
  r.market.set('BTC-USD', 62_500, 62_510);
  const a = await add(r, { kind: 'twap', side: 'sell', quantity: '0.00032', durationMs: 120_000, slices: 2, exec: { style: 'taker', slippageBps: 30 } });
  await step(r, a.id);
  assert.equal(r.sink.all.length, 1);
  const o = r.sink.all[0]!;
  assert.ok(Number(o.quantity) * Number(o.price) >= BTC.minNotional, `${o.quantity} @ ${o.price} = $${(Number(o.quantity) * Number(o.price)).toFixed(3)}`);
});

test('BUG: a TWAP too small for SoDEX is refused at the start (it used to end "done" with nothing sent)', async () => {
  const r = await rig();
  await assert.rejects(add(r, { kind: 'twap', quantity: '0.0001', durationMs: 60_000, slices: 1, exec: { style: 'taker' } }), /The whole order is about \$6, under SoDEX's \$10 minimum\. Raise the size to at least \$10\.\d\d\./);
  assert.equal(r.sink.all.length, 0);
});

test('BUG: the spread guard does not hold a maker (resting) child', async () => {
  const r = await rig();
  r.market.set('BTC-USD', 60_000, 60_100); // ~16.7 bp
  const a = await add(r, { kind: 'twap', quantity: '0.002', durationMs: 120_000, slices: 2, maxSpreadBps: 5, exec: { style: 'maker' } });
  const x = await step(r, a.id);
  assert.equal(r.sink.all.length, 0, 'no new child while the spread is wider than the guard');
  assert.equal(x.status, 'waiting');
});

test('BUG: lowering the size of a running TWAP leaves a bigger resting child that over-fills it', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.004', durationMs: 120_000, slices: 1, finish: 'leave', exec: { style: 'maker' } });
  await step(r, a.id);
  const orig = r.sink.all[0]!;
  assert.equal(orig.quantity, '0.004');
  await r.rt.update(a.id, { quantity: '0.002' });
  await step(r, a.id, 2_000);
  await step(r, a.id, 2_000);
  if (r.sink.resting.has(orig.clOrdID)) r.sink.fill(orig.clOrdID, 0.004);
  await settle();
  const x = await step(r, a.id, 500);
  assert.ok(x.filled <= 0.002 + 1e-12, `filled ${x.filled} of a 0.002 order`);
});

test('BUG: raising the size of a running TWAP applies to slices already sent (an extra child at once)', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.004', durationMs: 240_000, slices: 4, exec: { style: 'taker' } });
  await step(r, a.id);
  await r.rt.update(a.id, { quantity: '0.008' });
  await step(r, a.id, 1_000);
  assert.equal(r.sink.all.length, 1, 'the new size applies from the next slice on (docs: runtime.update)');
});

test('paper maker TWAP: nothing sent; it fills from the tape trading through it', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.002', durationMs: 120_000, slices: 2, paper: true, exec: { style: 'maker' } });
  let x = await step(r, a.id);
  assert.equal(r.sink.placed.length, 0);
  assert.equal(x.children[0]!.price, 60_000);
  r.market.print({ price: 60_000, qty: 0.001, taker: 'sell' });
  await settle();
  x = r.rt.get(a.id)!;
  assert.ok(near(x.filled, 0.001));
  assert.ok(near(x.makerQty, 0.001));
});

/* ================================================================== exits ===== */

test('BUG: an exit placement without an answer is never reconciled: the exits are never resized to the full fill', async () => {
  const r = await rig();
  r.sink.stopMode = 'unknown';
  const a = await add(r, { kind: 'twap', quantity: '0.004', durationMs: 120_000, slices: 2, exec: { style: 'taker' }, exits: { slPct: 0.05 } });
  await step(r, a.id);
  await step(r, a.id, 500);
  assert.equal(r.sink.stops.length, 1);
  r.sink.stopMode = 'ok';
  await step(r, a.id, 60_000);
  for (let i = 0; i < 4; i++) await step(r, a.id, 6_000);
  const x = r.rt.get(a.id)!;
  assert.equal(x.status, 'done');
  assert.equal(r.sink.stops.at(-1)![0]!.quantity, '0.004', 'a stop-loss for everything that filled');
});

test('BUG: when the algo ends while an exit resize is still being cancelled, the final exits are never placed', async () => {
  const r = await rig();
  r.sink.holdStopCancels = true;
  const a = await add(r, { kind: 'twap', quantity: '0.003', durationMs: 180_000, slices: 3, exec: { style: 'taker' }, exits: { slPct: 0.05 } });
  await step(r, a.id); // slice 1
  await step(r, a.id, 500); // exits for 0.001
  await step(r, a.id, 60_000); // slice 2
  await step(r, a.id, 500); // resize: cancel sent, SoDEX slow to confirm
  await step(r, a.id, 60_000); // slice 3
  await step(r, a.id, 500); // done
  assert.equal(r.rt.get(a.id)!.status, 'done');
  r.sink.releaseStopCancels();
  await settle();
  r.rt.tick(clock + 500);
  await settle();
  const x = r.rt.get(a.id)!;
  const live = (x.exitOrders ?? []).filter((e) => e.state === 'open' && !e.cancelling);
  assert.ok(live.some((e) => near(e.quantity, 0.003)), `live exits: ${JSON.stringify(live.map((e) => e.quantity))}`);
});

test('BUG: an exit SoDEX refuses is placed again on every tick (no backoff)', async () => {
  const r = await rig();
  r.sink.stopMode = 'reject';
  const a = await add(r, { kind: 'twap', quantity: '0.004', durationMs: 240_000, slices: 4, exec: { style: 'taker' }, exits: { slPct: 0.05 } });
  await step(r, a.id);
  for (let i = 0; i < 10; i++) await step(r, a.id, 500);
  assert.ok(r.sink.stops.length <= 2, `${r.sink.stops.length} stop placements in 5 s for one unchanged fill`);
});

/* =================================================================== VWAP ===== */

test('VWAP with no history: an even schedule, filled exactly', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'vwap', quantity: '0.002', durationMs: 900_000, slices: 3, lookbackDays: 7, exec: { style: 'taker' } });
  let x = await step(r, a.id);
  for (let i = 0; i < 10 && x.status !== 'done'; i++) x = await step(r, a.id, 300_000);
  assert.equal(x.status, 'done');
  assert.ok(near(x.filled, 0.002));
  assert.ok(sentQty(r) <= 0.002 + 1e-12);
});

/* ==================================================================== POV ===== */

test('POV with no volume: nothing is sent; at the end time with "leave" it expires', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'pov', quantity: '0.01', rate: 0.1, endAt: clock + 10_000, finish: 'leave', exec: { style: 'taker' } });
  await step(r, a.id);
  const x = await step(r, a.id, 11_000);
  assert.equal(r.sink.all.length, 0);
  assert.equal(x.status, 'expired');
});

test('POV: never more than the size, however much the market trades', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'pov', quantity: '0.002', rate: 0.5, exec: { style: 'taker' } });
  await step(r, a.id);
  r.market.print({ price: 60_000, qty: 1 });
  let x = await step(r, a.id, 500);
  for (let i = 0; i < 5 && x.status !== 'done'; i++) x = await step(r, a.id, 500);
  assert.equal(x.status, 'done');
  assert.ok(near(sentQty(r), 0.002));
});

test('BUG: a POV largest child under SoDEX\'s minimum is refused at the start (it used to never send anything)', async () => {
  const r = await rig();
  await assert.rejects(add(r, { kind: 'pov', quantity: '0.001', rate: 0.5, maxChildQty: '0.0001', endAt: clock + 10_000, finish: 'take', exec: { style: 'taker' } }), /Your largest child \(0\.0001 BTC, about \$6\) is under SoDEX's \$10 minimum\. Raise it to at least 0\.00017 BTC\./);
});

/* ==================================================================== DCA ===== */

test('DCA "wait": outside the limit it waits, then catches up the missed orders when the price is back', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'dca', perOrderUsd: 60.01, orders: 3, intervalMs: 60_000, limitPrice: 60_500, outOfBand: 'wait', exec: { style: 'taker' } });
  await step(r, a.id);
  r.market.set('BTC-USD', 61_000, 61_010);
  let x = await step(r, a.id, 60_000);
  assert.equal(x.status, 'waiting');
  x = await step(r, a.id, 60_000);
  assert.equal(r.sink.all.length, 1);
  r.market.set('BTC-USD', 60_000, 60_010);
  x = await step(r, a.id, 1_000);
  x = await step(r, a.id, 500);
  assert.equal(x.k.done, 3);
  assert.ok(near(sentQty(r), 0.003, 1e-9));
  assert.equal(x.status, 'done');
});

test('DCA total budget caps what it spends', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'dca', perOrderUsd: 60, orders: 5, intervalMs: 60_000, maxTotalUsd: 130, exec: { style: 'taker' } });
  let x = await step(r, a.id);
  for (let i = 0; i < 8 && x.status !== 'done'; i++) x = await step(r, a.id, 60_000);
  assert.equal(x.status, 'done');
  assert.ok(x.filledValue <= 130 + 1e-6, `spent ${x.filledValue}`);
  assert.ok(Number(x.k.spentUsd) <= 130 + 1e-9);
});

test('DCA dip boost: the order is multiplied when the price is that far below the average', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'dca', perOrderUsd: 60.01, orders: 2, intervalMs: 60_000, dipPct: 0.05, dipMultiplier: 2, exec: { style: 'taker' } });
  await step(r, a.id);
  r.market.set('BTC-USD', 56_000, 56_010);
  await step(r, a.id, 60_000);
  assert.equal(r.sink.all.length, 2);
  assert.ok(near(Number(r.sink.all[1]!.quantity), Math.floor((120.02 / 56_010) / 0.00001 + 1e-9) * 0.00001, 1e-9));
});

test('BUG: a maker (post-only) DCA takes its last installment at once as a taker', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'dca', perOrderUsd: 60.01, orders: 2, intervalMs: 60_000, exec: { style: 'maker' } });
  await step(r, a.id);
  assert.equal(r.sink.all[0]!.tif, 'gtx');
  await step(r, a.id, 60_000);
  for (let i = 0; i < 3; i++) await step(r, a.id, 500);
  assert.ok(r.sink.all.every((o) => o.tif === 'gtx'), `tifs: ${r.sink.all.map((o) => o.tif).join(', ')} - a maker DCA never pays the spread`);
});

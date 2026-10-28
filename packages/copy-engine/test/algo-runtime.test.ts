import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  AlgoRuntime,
  MemoryAlgoStore,
  silentLogger,
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
  type RegionPolicy,
  type SodexClient,
  type StopRequest,
  type MarketInfo,
  limitNoticeOf,
  planAlgo,
  parseAlgoSpec,
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
  // Paper fills arrive on a 0 ms timer (as a socket message would, after the request's answer).
  await new Promise((r) => setTimeout(r, 5));
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

class FakeMarket implements AlgoMarket {
  quotes = new Map<string, Quote>();
  marks = new Map<string, MarkInfo>();
  history: Array<{ t: number; s: string; p: number }> = [];
  printCbs: Array<(p: Print) => void> = [];
  orderCbs: Array<(u: OrderUpdate) => void> = [];
  watched: { symbols: string[]; owners: string[] } = { symbols: [], owners: [] };
  up = true;
  start(): void {}
  stop(): void {}
  watch(symbols: readonly string[], owners: readonly string[]): void {
    this.watched = { symbols: [...symbols], owners: [...owners] };
  }
  set(symbol: string, bid: number, ask: number, mark = (bid + ask) / 2): void {
    this.quotes.set(symbol, { bid, ask, at: Date.now() });
    this.marks.set(symbol, { mark, index: mark, funding: 0.0001, oi: 1000, at: Date.now() });
    this.history.push({ t: Date.now(), s: symbol, p: mark });
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
  priceAgo(symbol: string, _s: PriceSource, agoMs: number): number | null {
    const want = Date.now() - agoMs;
    const h = this.history.filter((x) => x.s === symbol && x.t <= want);
    return h.length ? h[h.length - 1]!.p : null;
  }
  oiAgo(): number | null {
    return 1000;
  }
  volume(): { qty: number; usd: number } {
    return { qty: 0, usd: 0 };
  }
  onPrint(cb: (p: Print) => void): void {
    this.printCbs.push(cb);
  }
  onOrder(cb: (u: OrderUpdate) => void): void {
    this.orderCbs.push(cb);
  }
  stateCbs: Array<(up: boolean) => void> = [];
  onState(cb: (up: boolean) => void): void {
    this.stateCbs.push(cb);
  }
  /** The socket going down or coming back. */
  state(up: boolean): void {
    for (const cb of this.stateCbs) cb(up);
  }
  print(p: Partial<Print> & { price: number; qty: number }): void {
    for (const cb of this.printCbs) cb({ symbol: 'BTC-USD', buyer: 7, seller: 8, taker: 'sell', at: Date.now(), ...p });
  }
  order(u: Partial<OrderUpdate> & { clOrdID: string }): void {
    for (const cb of this.orderCbs) cb({ orderId: '1', symbol: 'BTC-USD', status: 'NEW', filledQty: 0, filledValue: 0, maker: null, reason: null, at: Date.now(), ...u });
  }
}

/** A sink that answers like SoDEX would: IOCs fill at the touch when their price reaches it; resting orders rest. */
class FakeSink implements AlgoSink {
  readonly paper = false;
  placed: ChildRequest[][] = [];
  cancelled: string[] = [];
  leverage: number[] = [];
  resting = new Map<string, ChildRequest & { filled: number }>();
  mode: 'ok' | 'unknown' | 'reject' = 'ok';
  /** What a refusal says (mode 'reject'). */
  rejectWith = 'nope';
  autoFill = true;
  constructor(private readonly m: FakeMarket) {}
  get all(): ChildRequest[] {
    return this.placed.flat();
  }
  async place(_a: AlgoRecord, mk: { name: string }, orders: ChildRequest[]): Promise<ChildResult[]> {
    this.placed.push(orders);
    if (this.mode !== 'ok') return orders.map((o) => ({ clOrdID: o.clOrdID, ok: false, orderId: null, error: this.mode === 'reject' ? this.rejectWith : 'timeout', outcomeUnknown: this.mode === 'unknown' }));
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
      const r = this.resting.get(id);
      this.resting.delete(id);
      setImmediate(() => this.m.order({ clOrdID: id, status: 'CANCELED', filledQty: r?.filled ?? 0, filledValue: (r?.filled ?? 0) * Number(r?.price ?? 0) }));
    }
  }
  async setLeverage(_a: AlgoRecord, _m: unknown, lev: number): Promise<void> {
    this.leverage.push(lev);
  }
  stops: StopRequest[][] = [];
  async placeStops(_a: AlgoRecord, _m: unknown, stops: StopRequest[]): Promise<ChildResult[]> {
    this.stops.push(stops);
    for (const s of stops) setImmediate(() => this.m.order({ clOrdID: s.clOrdID, status: 'NEW' }));
    return stops.map((s) => ({ clOrdID: s.clOrdID, ok: true, orderId: '2', error: null, outcomeUnknown: false }));
  }
  /** SoDEX fires a stop: it fills in full at `price`. */
  fireStop(id: string, qty: number, price: number): void {
    this.m.order({ clOrdID: id, status: 'FILLED', filledQty: qty, filledValue: qty * price, maker: false });
  }
  /** Fill a resting order (part or all). */
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
  lookups: Array<{ history: boolean }>;
  position: { size: number; entry: number; leverage?: number; fail?: boolean };
  /** The region rules the host reports (null: none) and the account it reads. */
  policy: { value: RegionPolicy | null };
  account: { equity: number; gross: number };
  lookupRows: Array<{ clOrdID: string; orderId: string; status: string; executedQty: number; executedValue: number }>;
  /** What SoDEX lists as open orders (the order history is lookupRows). */
  openRows?: Array<{ clOrdID: string; orderId: string; status: string; executedQty: number; executedValue: number }>;
}

async function rig(markets: MarketInfo[] = [BTC, ETH]): Promise<Rig> {
  const market = new FakeMarket();
  const sink = new FakeSink(market);
  const store = new MemoryAlgoStore();
  const position: { size: number; entry: number; leverage?: number; fail?: boolean } = { size: 0, entry: 0 };
  const lookups: Rig['lookups'] = [];
  const r: Rig = { rt: null as unknown as AlgoRuntime, market, sink, store, lookups, position, policy: { value: null }, account: { equity: 1_000, gross: 0 }, lookupRows: [] };
  const sodex = { markets: async () => markets, follower: async () => {
      if (position.fail) throw new Error('state read failed');
      return { positions: { 'BTC-USD': { size: position.size, entry: position.entry, leverage: position.leverage ?? 1, leverageReported: position.leverage !== undefined } } };
    }, get: async () => [] } as unknown as SodexClient;
  r.rt = new AlgoRuntime({
    store,
    sodex,
    network: 'mainnet',
    market,
    sinkFor: () => sink,
    log: silentLogger,
    autoTick: false,
    policyFor: () => r.policy.value,
    account: async () => ({ ...r.account }),
    lookup: async (_a, _s, history) => {
      lookups.push({ history });
      return history ? r.lookupRows : (r.openRows ?? []);
    },
  });
  await r.rt.start();
  market.set('BTC-USD', 60_000, 60_010);
  return r;
}

async function step(r: Rig, id: string, advanceMs = 0): Promise<AlgoRecord> {
  clock += advanceMs;
  await r.rt.stepNow(id, clock);
  await settle();
  return r.rt.get(id)!;
}

const add = (r: Rig, spec: Record<string, unknown>) => r.rt.add({ owner: FOLLOWER, accountId: ACCOUNT, mode: 'browser', spec: { symbol: 'BTC-USD', side: 'buy', ...spec }, seed: 1 });

test('TWAP (taker): one IOC per slice when it is due, filled from the order updates, done at the end, never over the size', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.004', durationMs: 240_000, slices: 4, exec: { style: 'taker', slippageBps: 30 } });
  assert.equal(a.status, 'scheduled');
  let x = await step(r, a.id);
  assert.equal(x.status, 'running');
  assert.equal(x.arrival, 60_005);
  assert.equal(r.sink.all.length, 1);
  assert.equal(r.sink.all[0]!.tif, 'ioc');
  assert.equal(r.sink.all[0]!.quantity, '0.001');
  assert.equal(r.sink.all[0]!.price, '60190', 'the ask plus 30 bp, snapped down');
  assert.ok(Math.abs(x.filled - 0.001) < 1e-12);
  x = await step(r, a.id, 30_000);
  assert.equal(r.sink.all.length, 1, 'nothing until the next slice');
  for (let i = 0; i < 3; i++) x = await step(r, a.id, 60_000);
  assert.equal(r.sink.all.length, 4);
  x = await step(r, a.id, 30_000);
  assert.equal(x.status, 'done');
  assert.ok(Math.abs(x.filled - 0.004) < 1e-12);
  const v = r.rt.view(a.id)!;
  assert.equal(v.progress, 1);
  assert.ok(v.avgPrice === 60_010);
  assert.ok(Math.abs(v.vsArrivalBps! - -((5 / 60_005) * 10_000)) < 1e-6, 'paid half the spread vs arrival');
});

test('TWAP (maker): one resting order at the bid, re-priced when the bid moves away, grown when the next slice is due', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.002', durationMs: 120_000, slices: 2, finish: 'leave', exec: { style: 'maker', chaseTicks: 2, offsetTicks: 0 } });
  await step(r, a.id);
  assert.equal(r.sink.all.length, 1);
  assert.deepEqual([r.sink.all[0]!.tif, r.sink.all[0]!.price, r.sink.all[0]!.quantity], ['gtx', '60000', '0.001']);
  r.market.set('BTC-USD', 60_001, 60_011);
  await step(r, a.id, 2_000);
  assert.equal(r.sink.cancelled.length, 0, 'one tick is under the re-price distance');
  r.market.set('BTC-USD', 60_003, 60_013);
  await step(r, a.id, 1_000);
  assert.equal(r.sink.cancelled.length, 1, 're-priced: cancelled first');
  await step(r, a.id, 500);
  assert.deepEqual([r.sink.all[1]!.price, r.sink.all[1]!.quantity], ['60003', '0.001']);
  await step(r, a.id, 60_000);
  assert.equal(r.sink.cancelled.length, 2, 'the next slice is due: grown');
  await step(r, a.id, 500);
  assert.equal(r.sink.all[2]!.quantity, '0.002');
  r.sink.fill(r.sink.all[2]!.clOrdID, 0.002);
  await settle();
  const x = await step(r, a.id, 500);
  assert.equal(x.status, 'done');
  assert.ok(Math.abs(x.makerQty - 0.002) < 1e-12, 'all of it rested');
});

test('TWAP (hybrid): rests first, then takes what is overdue - cancelling the resting order before it takes', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.002', durationMs: 120_000, slices: 2, exec: { style: 'hybrid', makerShare: 0.5 } });
  await step(r, a.id);
  assert.equal(r.sink.all[0]!.tif, 'gtx');
  await step(r, a.id, 31_000);
  assert.equal(r.sink.cancelled.length, 1);
  await step(r, a.id, 500);
  assert.equal(r.sink.all[1]!.tif, 'ioc');
  assert.equal(r.sink.all[1]!.quantity, '0.001');
});

test('a write without an answer is never sent again; SoDEX is asked what became of it', async () => {
  const r = await rig();
  r.sink.mode = 'unknown';
  const a = await add(r, { kind: 'twap', quantity: '0.002', durationMs: 120_000, slices: 2, exec: { style: 'taker' } });
  let x = await step(r, a.id);
  assert.equal(x.children[0]!.state, 'unknown');
  r.sink.mode = 'ok';
  x = await step(r, a.id, 60_000);
  assert.equal(r.sink.all.length, 1, 'the second slice waits until the first is settled');
  r.lookupRows = [{ clOrdID: x.children[0]!.clOrdID, orderId: '9', status: 'FILLED', executedQty: 0.001, executedValue: 60.01 }];
  x = await step(r, a.id, 25_000);
  assert.ok(r.lookups.some((l) => l.history));
  assert.equal(x.children[0]!.state, 'done');
  assert.equal(r.sink.all.length, 2, 'settled: the second slice goes in the same step');
  assert.ok(Math.abs(x.filled - 0.002) < 1e-12);
});

test('POV: a share of the total volume, its own fills included - its own prints are not counted twice', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'pov', quantity: '0.01', rate: 0.2, exec: { style: 'taker' } });
  await step(r, a.id);
  assert.equal(r.sink.all.length, 0);
  r.market.print({ price: 60_000, qty: 0.02 });
  r.market.print({ price: 60_000, qty: 1, buyer: ACCOUNT });
  const x = await step(r, a.id, 1_000);
  assert.equal(x.marketQty, 0.02);
  assert.equal(r.sink.all.length, 1);
  // 20% of the total: f = 0.2 x (0.02 + f), so f = 0.005 (a quarter of what the others traded).
  assert.equal(r.sink.all[0]!.quantity, '0.005');
});

test('conditional: fires only after the condition held for its hold time, then takes', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'conditional', conditions: [{ type: 'price', symbol: 'BTC-USD', source: 'mark', op: 'below', value: 59_000 }], holdMs: 2_000, then: { type: 'market', quantity: '0.001', slippageBps: 20 } });
  await step(r, a.id);
  r.market.set('BTC-USD', 58_890, 58_910);
  await step(r, a.id, 1_000);
  await step(r, a.id, 1_000);
  assert.equal(r.sink.all.length, 0, 'held 1 s of 2');
  r.market.set('BTC-USD', 59_500, 59_510);
  await step(r, a.id, 1_500);
  r.market.set('BTC-USD', 58_890, 58_910);
  await step(r, a.id, 500);
  await step(r, a.id, 1_500);
  assert.equal(r.sink.all.length, 0, 'a wick back over the level restarts the hold');
  await step(r, a.id, 600);
  assert.equal(r.sink.all.length, 1);
  assert.equal(r.sink.all[0]!.tif, 'ioc');
  const x = await step(r, a.id, 500);
  assert.equal(x.status, 'done');
});

test('conditional: a cross needs the other side first; it can start another algo', async () => {
  const r = await rig();
  const a = await add(r, {
    kind: 'conditional',
    conditions: [{ type: 'cross', symbol: 'BTC-USD', source: 'mark', dir: 'up', value: 60_100 }],
    then: { type: 'algo', algo: { kind: 'twap', symbol: 'BTC-USD', side: 'buy', quantity: '0.002', durationMs: 120_000, slices: 2, exec: { style: 'taker' } } },
  });
  await step(r, a.id);
  r.market.set('BTC-USD', 60_200, 60_210);
  const x = await step(r, a.id, 1_000);
  assert.equal(x.status, 'done');
  const child = r.rt.list(FOLLOWER).find((c) => c.parentId === a.id);
  assert.ok(child, 'started a TWAP');
  assert.equal(child!.spec.kind, 'twap');
});

test('trailing stop on the whole position: trails the high and closes reduce-only when it turns', async () => {
  const r = await rig();
  r.position.size = 0.01;
  const a = await add(r, { kind: 'trailing', side: 'sell', trailPct: 0.01, exit: 'market' });
  assert.equal(a.spec.reduceOnly, true);
  await step(r, a.id);
  r.market.set('BTC-USD', 60_990, 61_010, 61_000);
  await step(r, a.id, 1_000);
  assert.equal(r.rt.view(a.id)!.triggerPrice, 60_390);
  r.market.set('BTC-USD', 60_370, 60_380, 60_380);
  await step(r, a.id, 1_000);
  assert.equal(r.sink.all.length, 1);
  assert.deepEqual([r.sink.all[0]!.side, r.sink.all[0]!.quantity, r.sink.all[0]!.reduceOnly], ['sell', '0.01', true]);
});

test('conditional close: reduce-only on the side of the position, whatever side was chosen', async () => {
  const r = await rig();
  r.position.size = -0.004;
  const a = await add(r, { kind: 'conditional', side: 'sell', conditions: [{ type: 'price', symbol: 'BTC-USD', source: 'mark', op: 'below', value: 70_000 }], then: { type: 'close', share: 0.5, slippageBps: 20 } });
  await step(r, a.id);
  assert.deepEqual([r.sink.all[0]!.side, r.sink.all[0]!.quantity, r.sink.all[0]!.reduceOnly], ['buy', '0.002', true]);
});

test('scale: the whole ladder in one batch; cancel pulls what still rests', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'scale', quantity: '0.01', from: 59_900, to: 59_500, orders: 5, postOnly: true });
  await step(r, a.id);
  assert.equal(r.sink.placed.length, 1);
  assert.deepEqual(r.sink.all.map((o) => o.price), ['59900', '59800', '59700', '59600', '59500']);
  r.sink.fill(r.sink.all[0]!.clOrdID, 0.002);
  await settle();
  await r.rt.cancel(a.id);
  await settle();
  assert.equal(r.sink.cancelled.length, 4);
  const x = r.rt.get(a.id)!;
  assert.equal(x.status, 'cancelled');
  assert.ok(Math.abs(x.filled - 0.002) < 1e-12);
});

test('bounds: hold pauses while the mark is past it; rush takes everything that is left', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.004', durationMs: 240_000, slices: 4, upper: { price: 61_000, then: 'hold' }, exec: { style: 'taker' } });
  r.market.set('BTC-USD', 61_500, 61_510);
  let x = await step(r, a.id);
  assert.equal(x.status, 'waiting');
  assert.match(x.statusReason!, /upper bound/);
  assert.equal(r.sink.all.length, 0);
  r.market.set('BTC-USD', 60_000, 60_010);
  x = await step(r, a.id, 1_000);
  assert.equal(x.status, 'running');
  assert.equal(r.sink.all.length, 1);
  const b = await add(r, { kind: 'twap', quantity: '0.004', durationMs: 240_000, slices: 4, lower: { price: 59_000, then: 'rush' }, exec: { style: 'taker' } });
  r.market.set('BTC-USD', 58_000, 58_010);
  await step(r, b.id);
  const sent = r.sink.all.slice(1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.quantity, '0.004', 'the rest, at once');
});

test('a hold inside a step is logged once, and the algo stays held (not flapping) until it clears', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.004', durationMs: 240_000, slices: 4, maxSpreadBps: 1, exec: { style: 'taker' } });
  r.market.set('BTC-USD', 60_000, 60_100);
  for (let i = 0; i < 4; i++) {
    await step(r, a.id, 500);
    assert.equal(r.rt.get(a.id)!.status, 'waiting', `tick ${i}`);
  }
  const lines = (await r.rt.events(a.id)).filter((e) => /spread/.test(e.text));
  assert.equal(lines.length, 1);
  assert.equal(r.sink.all.length, 0);
  r.market.set('BTC-USD', 60_000, 60_005);
  await step(r, a.id, 500);
  assert.equal(r.rt.get(a.id)!.status, 'running');
  assert.equal(r.sink.all.length, 1);
});

test('a taker that filled nothing is not sent again on the next tick', async () => {
  const r = await rig();
  r.sink.autoFill = false;
  const a = await add(r, { kind: 'conditional', conditions: [{ type: 'price', symbol: 'BTC-USD', source: 'mark', op: 'above', value: 1 }], then: { type: 'market', quantity: '0.001', slippageBps: 20 } });
  await step(r, a.id);
  assert.equal(r.sink.all.length, 1);
  await step(r, a.id, 300);
  await step(r, a.id, 300);
  assert.equal(r.sink.all.length, 1, 'waits a second after a miss');
  r.sink.autoFill = true;
  await step(r, a.id, 600);
  assert.equal(r.sink.all.length, 2);
  const x = await step(r, a.id, 300);
  assert.equal(x.status, 'done');
});

test('paper: nothing is sent; a resting order fills when the tape trades through it', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'chase', quantity: '0.002', paper: true });
  let x = await step(r, a.id);
  assert.equal(r.sink.placed.length, 0);
  assert.equal(x.children[0]!.price, 60_000);
  r.market.print({ price: 60_000, qty: 0.001, taker: 'sell' });
  await settle();
  r.market.print({ price: 59_999, qty: 0.005, taker: 'sell' });
  await settle();
  x = await step(r, a.id, 500);
  assert.equal(x.status, 'done');
  assert.ok(Math.abs(x.filled - 0.002) < 1e-12);
  assert.equal(x.makerQty, x.filled);
});

test('iceberg: one clip shows at a time and the next only after it filled', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'iceberg', quantity: '0.006', displayQty: '0.002', price: 59_990, postOnly: false });
  await step(r, a.id);
  assert.equal(r.sink.all.length, 1);
  assert.deepEqual([r.sink.all[0]!.tif, r.sink.all[0]!.price, r.sink.all[0]!.quantity], ['gtc', '59990', '0.002']);
  await step(r, a.id, 1_000);
  assert.equal(r.sink.all.length, 1);
  r.sink.fill(r.sink.all[0]!.clOrdID, 0.002);
  await settle();
  await step(r, a.id, 500);
  assert.equal(r.sink.all.length, 2);
});

test('swarm: waves of IOC clips in one batch each, the next wave after the pause', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'swarm', quantity: '0.004', clips: 4, inFlight: 2, waveMs: 1_000, slippageBps: 20 });
  await step(r, a.id);
  assert.equal(r.sink.placed.length, 1);
  assert.equal(r.sink.placed[0]!.length, 2);
  await step(r, a.id, 500);
  assert.equal(r.sink.placed.length, 1, 'waits for the pause');
  await step(r, a.id, 600);
  assert.equal(r.sink.placed.length, 2);
  const x = await step(r, a.id, 1_100);
  assert.equal(x.status, 'done');
});

test('DCA: an amount per interval; outside the limit it is skipped', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'dca', perOrderUsd: 60.01, orders: 3, intervalMs: 60_000, limitPrice: 60_500, exec: { style: 'taker' } });
  await step(r, a.id);
  assert.equal(r.sink.all[0]!.quantity, '0.001');
  r.market.set('BTC-USD', 61_000, 61_010);
  await step(r, a.id, 60_000);
  assert.equal(r.sink.all.length, 1);
  r.market.set('BTC-USD', 60_000, 60_010);
  let x = await step(r, a.id, 60_000);
  assert.equal(r.sink.all.length, 2);
  x = await step(r, a.id, 500);
  assert.equal(x.status, 'done');
  assert.equal(x.k.skipped, 1);
});

test('DCA: each order keeps its own size - rounding dust is not carried into the next one', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'dca', perOrderUsd: 70, orders: 2, intervalMs: 60_000, exec: { style: 'taker' } });
  let x = await step(r, a.id);
  const first = Number(r.sink.all[0]!.quantity);
  assert.ok(first < 70 / 60_010, 'rounded down to the step');
  x = await step(r, a.id, 500);
  assert.equal(x.status, 'running', 'the second installment is still to come');
  assert.equal(r.sink.all.length, 1);
  x = await step(r, a.id, 60_000);
  assert.equal(r.sink.all.length, 2);
  assert.equal(Number(r.sink.all[1]!.quantity), first, 'its own size, nothing of the first carried in');
  assert.equal(r.rt.get(a.id)!.children.find((c) => c.clOrdID === r.sink.all[1]!.clOrdID)!.tag, 'order 2/2');
  x = await step(r, a.id, 500);
  assert.equal(x.status, 'done');
});

test('DCA (maker): an unfilled order keeps resting by itself; the next one is placed beside it, never merged', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'dca', perOrderUsd: 60.01, orders: 3, intervalMs: 60_000, exec: { style: 'maker' } });
  await step(r, a.id);
  assert.equal(r.sink.all.length, 1);
  assert.deepEqual([r.sink.all[0]!.tif, r.sink.all[0]!.quantity], ['gtx', '0.001']);
  // The first has not filled when the second is due: two resting orders, each 0.001, nothing cancelled to grow one.
  await step(r, a.id, 60_000);
  assert.equal(r.sink.cancelled.length, 0);
  assert.equal(r.sink.all.length, 2);
  assert.deepEqual([r.sink.all[1]!.tif, r.sink.all[1]!.quantity], ['gtx', '0.001']);
  const live = r.rt.get(a.id)!.children.filter((c) => c.state === 'open');
  assert.deepEqual(live.map((c) => c.tag), ['order 1/3', 'order 2/3']);
  // Each fills as itself; the third is its own too.
  r.sink.fill(r.sink.all[0]!.clOrdID, 0.001);
  await settle();
  await step(r, a.id, 60_000);
  assert.equal(r.sink.all.length, 3);
  assert.equal(r.sink.all[2]!.quantity, '0.001');
  r.sink.fill(r.sink.all[1]!.clOrdID, 0.001);
  r.sink.fill(r.sink.all[2]!.clOrdID, 0.001);
  await settle();
  const x = await step(r, a.id, 500);
  assert.equal(x.status, 'done');
  assert.ok(Math.abs(x.filled - 0.003) < 1e-12);
});

test('DCA "wait": orders that came due while it waited go out together, each as its own order', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'dca', perOrderUsd: 60.01, orders: 3, intervalMs: 60_000, limitPrice: 60_500, outOfBand: 'wait', exec: { style: 'taker' } });
  await step(r, a.id);
  r.market.set('BTC-USD', 61_000, 61_010);
  await step(r, a.id, 60_000);
  await step(r, a.id, 60_000);
  r.market.set('BTC-USD', 60_000, 60_010);
  await step(r, a.id, 1_000);
  const batch = r.sink.placed[r.sink.placed.length - 1]!;
  assert.deepEqual(batch.map((o) => o.quantity), ['0.001', '0.001'], 'two orders of their own, not one of 0.002');
});

test('pause pulls the resting child; resume carries on; restarts ask SoDEX about live children', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'chase', quantity: '0.002' });
  await step(r, a.id);
  await r.rt.pause(a.id);
  await settle();
  assert.equal(r.sink.cancelled.length, 1);
  assert.equal(r.rt.get(a.id)!.status, 'paused');
  await r.rt.resume(a.id);
  await step(r, a.id, 500);
  assert.equal(r.sink.all.length, 2);
  await r.rt.stop();
  // A new runner on the same books: the child that was open is not trusted until SoDEX says.
  const again = new AlgoRuntime({
    store: r.store,
    sodex: { markets: async () => [BTC], get: async () => [] } as unknown as SodexClient,
    network: 'mainnet',
    market: r.market,
    sinkFor: () => r.sink,
    log: silentLogger,
    autoTick: false,
    lookup: async () => [],
  });
  await again.start();
  const back = again.get(a.id)!;
  assert.equal(back.status, 'running');
  assert.equal(back.children.find((c) => c.clOrdID === r.sink.all[1]!.clOrdID)!.state, 'unknown');
  await again.stepNow(a.id, clock + 500);
  await settle();
  assert.equal(r.sink.all.length, 2, 'nothing new while it is unknown');
});

test('bracket: the entry fills, then a take-profit and a stop-loss on SoDEX; when one fills the other is cancelled', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'bracket', quantity: '0.002', entry: 'market', slippageBps: 20, exits: { tpPct: 0.02, slPct: 0.01 } });
  let x = await step(r, a.id);
  assert.equal(r.sink.all.length, 1, 'the entry: one taker');
  x = await step(r, a.id, 500);
  assert.equal(x.status, 'done');
  assert.equal(r.sink.stops.length, 1, 'exits placed once the entry filled');
  const [tp, sl] = r.sink.stops[0]!;
  assert.deepEqual([tp!.kind, tp!.side, tp!.quantity, tp!.triggerPrice], ['tp', 'sell', '0.002', '61210']);
  assert.deepEqual([sl!.kind, sl!.side, sl!.quantity, sl!.triggerPrice], ['sl', 'sell', '0.002', '59410']);
  await settle();
  r.sink.fireStop(tp!.clOrdID, 0.002, 61_210);
  await settle();
  assert.deepEqual(r.sink.cancelled, [sl!.clOrdID], 'one cancels the other');
  const v = r.rt.view(a.id)!;
  assert.equal(v.exits!.find((e) => e.kind === 'tp')!.filled, 0.002);
});

test('exits follow a TWAP as it fills: resized (cancel, then place) at most every 5 s while it runs, final at the end', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.004', durationMs: 120_000, slices: 2, exec: { style: 'taker' }, exits: { slPct: 0.05 } });
  await step(r, a.id);
  await step(r, a.id, 500);
  assert.equal(r.sink.stops.length, 1);
  assert.equal(r.sink.stops[0]![0]!.quantity, '0.002');
  await step(r, a.id, 60_000);
  await step(r, a.id, 500);
  assert.ok(r.sink.cancelled.includes(r.sink.stops[0]![0]!.clOrdID), 'the first stop-loss is replaced');
  const x = await step(r, a.id, 61_000);
  assert.equal(x.status, 'done');
  assert.equal(r.sink.stops.at(-1)![0]!.quantity, '0.004');
});

test('paper exits fire on the mark, and one cancels the other there too', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'bracket', quantity: '0.002', entry: 'market', paper: true, exits: { tpPrice: 60_500, slPrice: 59_500 } });
  await step(r, a.id);
  const x = await step(r, a.id, 500);
  assert.equal(x.status, 'done');
  assert.equal(x.exitOrders!.filter((e) => e.state === 'open').length, 2);
  r.market.set('BTC-USD', 59_400, 59_410, 59_405);
  r.rt.tick(clock);
  await settle();
  const y = r.rt.get(a.id)!;
  assert.equal(y.exitOrders!.find((e) => e.exit === 'sl')!.filled, 0.002);
  assert.equal(y.exitOrders!.find((e) => e.exit === 'tp')!.state, 'done');
  assert.equal(r.sink.stops.length, 0, 'paper: nothing sent');
});

test('basket: one algo per market, sized at the mark, cancelled together, done when every leg is', async () => {
  const r = await rig();
  r.market.set('ETH-USD', 2_999, 3_001, 3_000);
  const a = await add(r, { kind: 'basket', legs: [{ symbol: 'BTC-USD', side: 'buy', usd: 120 }, { symbol: 'ETH-USD', side: 'sell', usd: 60 }], style: 'swarm', clips: 2, inFlight: 2, waveMs: 0, slippageBps: 20 });
  await step(r, a.id);
  const legs = r.rt.list(FOLLOWER).filter((c) => c.parentId === a.id);
  assert.equal(legs.length, 2);
  const eth = legs.find((c) => c.spec.symbol === 'ETH-USD')!;
  assert.equal(eth.spec.side, 'sell');
  assert.equal((eth.spec as { quantity: string }).quantity, '0.02');
  for (const c of legs) {
    await step(r, c.id);
    await step(r, c.id, 500);
  }
  assert.ok(legs.every((c) => r.rt.get(c.id)!.status === 'done'));
  const x = await step(r, a.id, 500);
  assert.equal(x.status, 'done');
  assert.equal(r.rt.view(a.id)!.progress, 1);
  const b = await add(r, { kind: 'basket', legs: [{ symbol: 'BTC-USD', side: 'buy', usd: 120 }, { symbol: 'ETH-USD', side: 'buy', usd: 60 }], style: 'twap', durationMs: 600_000, slices: 2, slippageBps: 20 });
  await step(r, b.id);
  await r.rt.cancel(b.id);
  assert.ok(r.rt.list(FOLLOWER).filter((c) => c.parentId === b.id).every((c) => c.status === 'cancelled'));
});

test('a position condition: it fires on the position as SoDEX reports it, read in the background', async () => {
  const r = await rig();
  r.position.size = 0.01;
  r.position.entry = 59_000;
  const a = await add(r, { kind: 'conditional', conditions: [{ type: 'position', symbol: 'BTC-USD', op: 'pnlAbove', value: 5 }], then: { type: 'market', quantity: '0.001', slippageBps: 20 } });
  await step(r, a.id);
  await step(r, a.id, 500);
  assert.equal(r.sink.all.length, 1, 'PnL 0.01 x (60005 - 59000) = $10 >= $5');
  const b = await add(r, { kind: 'conditional', conditions: [{ type: 'position', symbol: 'BTC-USD', op: 'flat' }], then: { type: 'market', quantity: '0.001', slippageBps: 20 } });
  await step(r, b.id);
  await step(r, b.id, 500);
  assert.equal(r.sink.all.length, 1, 'not flat yet');
  r.position.size = 0;
  await step(r, b.id, 6_000);
  await step(r, b.id, 500);
  assert.equal(r.sink.all.length, 2);
});

test('region rules: a blocked region holds a live algo; the EEA 2x ceiling caps the leverage and the gross exposure', async () => {
  const r = await rig();
  r.policy.value = { region: 'blocked', allowed: false, maxLeverage: null, reason: 'Copy trading is not available in your region.', country: 'US', mismatch: false };
  const a = await add(r, { kind: 'twap', quantity: '0.004', durationMs: 240_000, slices: 4, exec: { style: 'taker' }, leverage: 10 });
  let x = await step(r, a.id);
  assert.equal(x.status, 'scheduled');
  assert.match(x.statusReason!, /not available in your region/);
  r.policy.value = { region: 'eea', allowed: true, maxLeverage: 2, reason: null, country: 'DE', mismatch: false };
  r.account = { equity: 100, gross: 150 };
  x = await step(r, a.id, 61_000);
  assert.deepEqual(r.sink.leverage, [2], 'leverage set to the ceiling, not the 10x asked');
  assert.equal(r.sink.all.length, 1);
  assert.equal(r.sink.all[0]!.quantity, '0.00083', 'cut to the $50 of room left under 2x');
  r.account = { equity: 100, gross: 200 };
  x = await step(r, a.id, 61_000);
  assert.equal(x.status, 'waiting');
  assert.match(x.statusReason!, /2x leverage cap/);
  const p = await add(r, { kind: 'twap', quantity: '0.004', durationMs: 240_000, slices: 4, exec: { style: 'taker' }, paper: true });
  await step(r, p.id);
  assert.ok(r.rt.get(p.id)!.filled > 0, 'paper sends nothing, so the region rules do not hold it');
});

test("a time-sliced close: the position's size and side when it starts, reduce-only", async () => {
  const r = await rig();
  r.position.size = -0.004;
  const a = await add(r, { kind: 'twap', side: 'sell', closeShare: 1, durationMs: 120_000, slices: 2, exec: { style: 'taker' } });
  await step(r, a.id);
  assert.deepEqual([r.sink.all[0]!.side, r.sink.all[0]!.quantity, r.sink.all[0]!.reduceOnly], ['buy', '0.002', true]);
  r.position.size = 0;
  const b = await add(r, { kind: 'twap', closeShare: 0.5, durationMs: 120_000, slices: 2, exec: { style: 'taker' } });
  const y = await step(r, b.id);
  assert.equal(y.status, 'expired');
  assert.match(y.statusReason!, /no position/);
});

test('smallest and largest slice: due quantity waits for the smallest; no child above the largest', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.004', durationMs: 240_000, slices: 4, minSliceQty: '0.002', exec: { style: 'taker' } });
  await step(r, a.id);
  assert.equal(r.sink.all.length, 0, '0.001 due: under the smallest slice');
  await step(r, a.id, 60_000);
  assert.equal(r.sink.all[0]!.quantity, '0.002');
  const b = await add(r, { kind: 'twap', quantity: '0.004', durationMs: 120_000, slices: 2, maxSliceQty: '0.0015', exec: { style: 'taker' } });
  await step(r, b.id);
  assert.equal(r.sink.all.at(-1)!.quantity, '0.0015');
});

test('stopping waits for a step that is placing an order, and records what it sent before the runner goes', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'chase', quantity: '0.002' });
  // SoDEX takes its time to answer the order.
  let answer!: () => void;
  const slow = new Promise<void>((res) => { answer = res; });
  const place = r.sink.place.bind(r.sink);
  r.sink.place = async (...args) => { await slow; return place(...args); };
  r.rt.tick(clock);
  await new Promise((res) => setImmediate(res));
  let stopped = false;
  const stopping = r.rt.stop().then(() => { stopped = true; });
  await new Promise((res) => setTimeout(res, 80));
  assert.equal(stopped, false, 'stop waits while the order is on its way');
  answer();
  await stopping;
  assert.equal(r.sink.all.length, 1);
  const saved = (await r.store.algos()).find((x) => x.id === a.id)!;
  assert.equal(saved.children.length, 1, 'the order that went out is in the books');
});

test('brake: a live algo is held at once while the operator brake is on (nothing new is sent) and goes on by itself when it is lifted', async () => {
  const r = await rig();
  let brake: string | null = null;
  (r.rt as unknown as { host: { brake?: () => string | null } }).host.brake = () => brake;
  const a = await add(r, { kind: 'twap', quantity: '0.004', durationMs: 240_000, slices: 4, exec: { style: 'taker', slippageBps: 30 } });
  brake = 'Investigating.';
  const held = await step(r, a.id, 1_000);
  assert.equal(r.sink.all.length, 0, 'nothing sent while braked');
  assert.ok(held.status === 'scheduled' || held.status === 'waiting', held.status);
  assert.match(held.statusReason ?? '', /Investigating/);
  brake = null;
  await step(r, a.id, 1_000);
  assert.equal(r.sink.all.length, 1, 'sent once the brake is lifted');
});

/* ------------------------------------------------- SoDEX's limits (limits.ts) ----- */

/** BTC-USD with SoDEX's risk tiers and an open-interest cap 0.0015 BTC over what the feed shows open (1000). */
const CAPPED: MarketInfo = { ...BTC, initLeverage: 20, marginTiers: [{ maxNotionalValue: 4_000_000, maxLeverage: 40 }, { maxNotionalValue: 100_000_000, maxLeverage: 25 }], openInterestCap: 1000.0015, openInterestCapUSD: null };

test('limits: a start over SoDEX\'s position limit at the leverage is refused (with the position already held); lower leverage passes', async () => {
  const r = await rig([CAPPED, ETH]);
  r.position.size = 60;
  r.position.entry = 60_000;
  await assert.rejects(add(r, { kind: 'twap', quantity: '10', durationMs: 600_000, slices: 5, leverage: 40, exec: { style: 'taker' } }), /Your BTC-USD position would be about \$4\.2M, over SoDEX's limit of \$4M at 40x\. You hold about \$3\.6M long now\. At most about \$\d{3},\d{3} \(6\.6\d BTC\) can be bought under it\. Use a smaller size or lower leverage\./);
  const ok = await add(r, { kind: 'twap', quantity: '10', durationMs: 600_000, slices: 5, leverage: 25, exec: { style: 'taker' } });
  assert.equal(ok.status, 'scheduled');
  // Reduce-only never grows the position: not checked.
  await add(r, { kind: 'twap', quantity: '50', durationMs: 600_000, slices: 5, leverage: 40, reduceOnly: true, side: 'sell', exec: { style: 'taker' } });
});

test('limits: a child over the open interest still allowed is cut to fit; with no room it holds, sending nothing', async () => {
  const r = await rig([CAPPED, ETH]);
  const a = await add(r, { kind: 'twap', quantity: '0.004', durationMs: 120_000, slices: 2, exec: { style: 'taker', slippageBps: 30 } });
  let x = await step(r, a.id);
  assert.equal(r.sink.all.length, 1);
  const cut = Number(r.sink.all[0]!.quantity);
  assert.ok(cut >= 0.00149 && cut <= 0.0015, `cut to the room under the cap: ${cut}`);
  r.market.marks.set('BTC-USD', { ...r.market.marks.get('BTC-USD')!, oi: 1000.0015 });
  x = await step(r, a.id, 60_000);
  assert.equal(r.sink.all.length, 1, 'nothing sent at the cap');
  assert.equal(x.status, 'waiting');
  assert.equal(x.statusReason, "Held: Open interest on BTC-USD is at SoDEX's cap: nothing can be added market-wide until it drops. Nothing goes out until there is room.");
  r.market.marks.set('BTC-USD', { ...r.market.marks.get('BTC-USD')!, oi: 900 });
  x = await step(r, a.id, 1_000);
  assert.equal(x.status, 'running');
  assert.equal(r.sink.all.length, 2, 'goes on when there is room');
});

test('limits: a child that would take the position over its limit is cut (the trader traded meanwhile); at the limit it holds', async () => {
  const r = await rig([{ ...CAPPED, openInterestCap: null }, ETH]);
  r.position.size = 65;
  const a = await add(r, { kind: 'twap', quantity: '1', durationMs: 120_000, slices: 2, leverage: 40, exec: { style: 'taker', slippageBps: 30 } });
  await step(r, a.id);
  assert.equal(r.sink.all[0]!.quantity, '0.5', 'fits whole');
  // Bought by hand meanwhile: read again (positions are read again after 5 s, in the background).
  r.position.size = 66.2;
  await step(r, a.id, 6_000);
  await step(r, a.id, 54_000);
  // $4M at the child's price (60,190) is about 66.456 BTC: about 0.256 more fits.
  const q = Number(r.sink.all[1]!.quantity);
  assert.ok(q > 0.25 && q < 0.26 && (66.2 + q) * 60_190 <= 4_000_000 + 1, String(q));
  r.position.size = 66.5;
  await step(r, a.id, 6_000);
  const x = await step(r, a.id, 60_000);
  assert.equal(r.sink.all.length, 2);
  assert.equal(x.status, 'waiting');
  assert.match(x.statusReason!, /^Held: Your BTC-USD position is about \$4(\.\d\d)?M long and SoDEX's limit at 40x is \$4M: nothing more can be added\. It goes on when there is room \(a smaller position, or lower leverage\)\.$/);
});

test('limits: SoDEX refusing at its open-interest cap holds the algo (a minute, doubling) and stops it at the fourth - no retry storm', async () => {
  const r = await rig();
  r.sink.mode = 'reject';
  r.sink.rejectWith = 'order rejected: open interest cap exceeded';
  const a = await add(r, { kind: 'twap', quantity: '0.004', durationMs: 3_600_000, slices: 4, exec: { style: 'taker', slippageBps: 30 } });
  let x = await step(r, a.id);
  assert.equal(r.sink.all.length, 1);
  assert.equal(x.status, 'waiting');
  assert.match(x.statusReason!, /open-interest cap on BTC-USD is reached\. Trying again in 1 min/);
  for (let i = 0; i < 10; i++) x = await step(r, a.id, 5_000);
  assert.equal(r.sink.all.length, 1, 'nothing re-sent during the wait');
  x = await step(r, a.id, 15_000);
  assert.equal(r.sink.all.length, 2);
  assert.match(x.statusReason!, /Trying again in 2 min/);
  x = await step(r, a.id, 121_000);
  assert.equal(r.sink.all.length, 3);
  x = await step(r, a.id, 241_000);
  assert.equal(r.sink.all.length, 4);
  assert.equal(x.status, 'failed');
  assert.match(x.statusReason!, /Stopped: SoDEX's open-interest cap on BTC-USD is reached\. SoDEX refused it 4 times/);
  // An ordinary refusal is not a limit: it is not held.
  const r2 = await rig();
  r2.sink.mode = 'reject';
  const b = await add(r2, { kind: 'twap', quantity: '0.004', durationMs: 3_600_000, slices: 4, exec: { style: 'taker', slippageBps: 30 } });
  const y = await step(r2, b.id);
  assert.notEqual(y.status, 'waiting');
});

test('sizes: the start refuses what the ticket refuses, in the same words - slices are never merged or split', async () => {
  const r = await rig();
  const spec = { kind: 'twap', quantity: '0.00124', durationMs: 600_000, slices: 12, exec: { style: 'taker' } };
  const plan = planAlgo(parseAlgoSpec({ symbol: 'BTC-USD', side: 'buy', ...spec }), BTC, { now: clock, price: r.market.mark('BTC-USD')!.mark, seed: 1 });
  assert.match(plan.errors[0]!, /^Each of the 12 slices would be about \$6\.20, under SoDEX's \$10 minimum\. Use at most 7 slices/);
  await assert.rejects(add(r, spec), (e: Error) => e.message === plan.errors.join(' '));
  // Over SoDEX's largest order ($5M on this market): refused too, never split into more orders.
  await assert.rejects(add(r, { kind: 'twap', quantity: '200', durationMs: 600_000, slices: 2, exec: { style: 'taker' } }), /Each slice would be about \$6M, over SoDEX's \$5M per order on BTC-USD\. Use at least 3 slices\./);
  // A DCA ladder's levels are never merged: two prices on one tick are refused.
  await assert.rejects(add(r, { kind: 'scale', quantity: '0.01', from: 59_000, to: 58_000, orders: 3, prices: [59_000, 58_000.2, 58_000.4], label: 'DCA' }), /Orders 2 and 3 both land on 58000/);
  assert.equal((await r.store.algos()).length, 0, 'nothing was stored');
  assert.equal(r.sink.all.length, 0);
});

test('limits: the trader\'s own trades push the position to the limit mid-run - it holds with the room left, tells once, sends nothing, and goes on when there is room', async () => {
  const r = await rig([{ ...CAPPED, openInterestCap: null }, ETH]);
  r.position.size = 60;
  const a = await add(r, { kind: 'twap', quantity: '2', durationMs: 240_000, slices: 4, leverage: 40, exec: { style: 'taker', slippageBps: 30 } });
  let x = await step(r, a.id);
  assert.equal(r.sink.all.length, 1);
  // Bought by hand meanwhile, up to the limit: read again (positions are read again after 5 s).
  r.position.size = 66.6;
  await step(r, a.id, 6_000);
  x = await step(r, a.id, 54_000);
  assert.equal(r.sink.all.length, 1, 'nothing sent to be refused');
  assert.equal(x.status, 'waiting');
  assert.match(x.statusReason!, /^Held: Your BTC-USD position is about \$4(\.\d\d)?M long and SoDEX's limit at 40x is \$4M: nothing more can be added\./);
  const n = limitNoticeOf(x)!;
  assert.deepEqual([n.kind, n.what, n.title], ['position', 'held', 'TWAP on BTC-USD is held']);
  assert.match(n.text, /nothing more can be added/);
  // Ten more ticks at the limit: no order, one line in the activity, the same notice.
  for (let i = 0; i < 10; i++) x = await step(r, a.id, 5_000);
  assert.equal(r.sink.all.length, 1);
  const held = (await r.rt.events(a.id)).filter((e) => e.text.startsWith('Held: Your BTC-USD position'));
  assert.equal(held.length, 1, 'one line, not one per tick');
  assert.equal(limitNoticeOf(x)!.id, n.id, 'told once');
  // Some room again (a part closed by hand): it goes on, cut to the room - and says so, with what can still be added.
  r.position.size = 66.2;
  x = await step(r, a.id, 6_000);
  assert.equal(r.sink.all.length, 2);
  assert.ok(Number(r.sink.all[1]!.quantity) < 1, r.sink.all[1]!.quantity);
  const cut = limitNoticeOf(x)!;
  assert.deepEqual([cut.kind, cut.what, cut.title], ['position', 'cut', 'TWAP on BTC-USD: an order was cut']);
  assert.match(cut.text, /^Slice \d\/4 was cut from 0\.5 to 0\.2\d+ BTC \(about \$[\d,]+\) to stay under SoDEX's position limit on BTC-USD\. Your BTC-USD position is about \$3\.98M long and SoDEX's limit at 40x is \$4M: about \$[\d,]+ \(0\.2\d+ BTC\) can still be added\.$/);
  assert.ok((await r.rt.events(a.id)).some((e) => e.kind === 'info' && e.text === cut.text), 'in the activity too');
  assert.equal(x.k.limitHold, undefined);
});

test('limits: at the open-interest cap it holds and tells how much can still be added market-wide, in USD and in the coin', async () => {
  const r = await rig([CAPPED, ETH]);
  const a = await add(r, { kind: 'twap', quantity: '0.004', durationMs: 120_000, slices: 2, exec: { style: 'taker', slippageBps: 30 } });
  let x = await step(r, a.id);
  const cut = limitNoticeOf(x)!;
  assert.deepEqual([cut.kind, cut.what], ['oi', 'cut']);
  assert.match(cut.text, /^Slice 1\/2 was cut from 0\.002 to 0\.00149 BTC \(about \$89\.\d\d\) to stay under SoDEX's open-interest cap on BTC-USD\. Open interest on BTC-USD is at 99% of SoDEX's cap: about \$90\.\d\d \(0\.0015 BTC\) can still be added market-wide\.$/);
  r.market.marks.set('BTC-USD', { ...r.market.marks.get('BTC-USD')!, oi: 1000.0015 });
  x = await step(r, a.id, 60_000);
  assert.equal(x.status, 'waiting');
  const held = limitNoticeOf(x)!;
  assert.deepEqual([held.kind, held.what, held.title], ['oi', 'held', 'TWAP on BTC-USD is held']);
  assert.equal(held.text, "Open interest on BTC-USD is at SoDEX's cap: nothing can be added market-wide until it drops. Nothing goes out until there is room.");
});

test('limits: SoDEX refusing at its open-interest cap is told in the bell too, with the room it shows', async () => {
  const r = await rig([CAPPED, ETH]);
  r.market.marks.set('BTC-USD', { ...r.market.marks.get('BTC-USD')!, oi: 900 });
  r.sink.mode = 'reject';
  r.sink.rejectWith = 'order rejected: open interest cap exceeded';
  const a = await add(r, { kind: 'twap', quantity: '0.004', durationMs: 3_600_000, slices: 4, exec: { style: 'taker', slippageBps: 30 } });
  const x = await step(r, a.id);
  const n = limitNoticeOf(x)!;
  assert.deepEqual([n.kind, n.what], ['oi', 'held']);
  assert.match(n.text, /^SoDEX refused an order: SoDEX's open-interest cap on BTC-USD is reached\. Open interest on BTC-USD is at 89% of SoDEX's cap: about \$6\.0M \(100 BTC\) can still be added market-wide\. It tries again in 1 min\.$|^SoDEX refused an order: SoDEX's open-interest cap on BTC-USD is reached\. Open interest on BTC-USD is at 89% of SoDEX's cap: about \$6M \(100 BTC\) can still be added market-wide\. It tries again in 1 min\.$/);
});

test('POV: what is due under SoDEX\'s minimum waits - said once in its activity, not hidden', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'pov', quantity: '0.01', rate: 0.1, exec: { style: 'taker' } });
  await step(r, a.id);
  // 0.001 BTC printed by others: 0.000111 due, about $6.70 - under $10.
  r.market.print({ price: 60_000, qty: 0.001 });
  await step(r, a.id, 1_000);
  await step(r, a.id, 1_000);
  assert.equal(r.sink.all.length, 0);
  const said = (await r.rt.events(a.id)).filter((e) => e.text === "What is due waits until it reaches SoDEX's $10 minimum.");
  assert.equal(said.length, 1);
  r.market.print({ price: 60_000, qty: 0.002 });
  await step(r, a.id, 1_000);
  assert.equal(r.sink.all.length, 1, 'sent once it reaches the minimum');
});

test('orders of a wallet the socket does not follow (SoDEX: 10 per IP) are read by REST: fills booked by client order id, none lost', async () => {
  const r = await rig();
  (r.market as unknown as { followsOrders: (o: string) => boolean }).followsOrders = () => false;
  const a = await add(r, { kind: 'twap', quantity: '0.002', durationMs: 120_000, slices: 1, finish: 'leave', exec: { style: 'maker' } });
  await step(r, a.id);
  const c = r.sink.all[0]!;
  assert.equal(c.tif, 'gtx');
  // SoDEX lists it half filled: booked as its update would have been.
  r.openRows = [{ clOrdID: c.clOrdID, orderId: '9', status: 'PARTIALLY_FILLED', executedQty: 0.001, executedValue: 60 }];
  const before = r.lookups.length;
  await r.rt.pollOrders(clock + 1);
  await settle();
  assert.equal(r.lookups.length, before + 1);
  assert.ok(Math.abs(r.rt.get(a.id)!.filled - 0.001) < 1e-12);
  // Read again at once: no (one read a second for the runtime, each algo every 3 s).
  await r.rt.pollOrders(clock + 2);
  assert.equal(r.lookups.length, before + 1);
  // Gone from the open orders: the history says it filled in full - booked, not lost.
  r.openRows = [];
  r.lookupRows = [{ clOrdID: c.clOrdID, orderId: '9', status: 'FILLED', executedQty: 0.002, executedValue: 120 }];
  await r.rt.pollOrders(clock + 4_000);
  assert.equal(r.rt.get(a.id)!.children.find((x) => x.clOrdID === c.clOrdID)!.state, 'unknown');
  const x = await step(r, a.id, 25_000);
  assert.ok(Math.abs(x.filled - 0.002) < 1e-12, String(x.filled));
  assert.equal(x.status, 'done');
});

test('a wallet the socket follows is not polled; after the socket was down every algo with an order on SoDEX is read once', async () => {
  const r = await rig();
  (r.market as unknown as { followsOrders: (o: string) => boolean }).followsOrders = () => true;
  const a = await add(r, { kind: 'twap', quantity: '0.002', durationMs: 120_000, slices: 1, finish: 'leave', exec: { style: 'maker' } });
  await step(r, a.id);
  const before = r.lookups.length;
  await r.rt.pollOrders(clock + 5_000);
  assert.equal(r.lookups.length, before, 'followed: its updates come on the socket');
  // The socket was up, dropped and came back: an update sent meanwhile may be lost.
  r.market.state(true);
  r.market.state(false);
  r.market.state(true);
  r.openRows = [{ clOrdID: r.sink.all[0]!.clOrdID, orderId: '9', status: 'NEW', executedQty: 0, executedValue: 0 }];
  await r.rt.pollOrders(clock + 10_000);
  assert.equal(r.lookups.length, before + 1, 'read once after the drop');
  await r.rt.pollOrders(clock + 20_000);
  assert.equal(r.lookups.length, before + 1, 'and then left to the socket again');
});

test('limits: a position SoDEX does not report refuses the start - never counted as none', async () => {
  const r = await rig([CAPPED, ETH]);
  r.position.fail = true;
  await assert.rejects(add(r, { kind: 'twap', quantity: '0.01', durationMs: 600_000, slices: 5, leverage: 40, exec: { style: 'taker' } }), /SoDEX did not report your position on BTC-USD, so the position limit cannot be checked\. Try again in a moment\./);
  // A practice run trades its own paper book; a reduce-only order cannot grow the position: neither needs the read.
  assert.equal((await add(r, { kind: 'twap', quantity: '0.01', durationMs: 600_000, slices: 5, leverage: 40, paper: true, exec: { style: 'taker' } })).status, 'scheduled');
  assert.equal((await add(r, { kind: 'twap', side: 'sell', reduceOnly: true, quantity: '0.01', durationMs: 600_000, slices: 5, exec: { style: 'taker' } })).status, 'scheduled');
  // Read again: it starts.
  r.position.fail = false;
  assert.equal((await add(r, { kind: 'twap', quantity: '0.01', durationMs: 600_000, slices: 5, leverage: 40, exec: { style: 'taker' } })).status, 'scheduled');
});

test('limits: with no leverage of its own, the leverage of the open position (as SoDEX reports it) sets the position limit', async () => {
  const r = await rig([CAPPED, ETH]);
  // Long 60 at 40x: the $4M tier. 10 more is about $4.2M.
  r.position.size = 60;
  r.position.entry = 60_000;
  r.position.leverage = 40;
  await assert.rejects(add(r, { kind: 'twap', quantity: '10', durationMs: 600_000, slices: 5, exec: { style: 'taker' } }), /over SoDEX's limit of \$4M at 40x/);
  // At 25x (SoDEX's default here is 20x): the $100M tier.
  r.position.leverage = 25;
  await new Promise((res) => setTimeout(res, 0));
  clock += 6_000;
  assert.equal((await add(r, { kind: 'twap', quantity: '10', durationMs: 600_000, slices: 5, exec: { style: 'taker' } })).status, 'scheduled');
});

test('limits: a position whose leverage SoDEX left out is checked at the strictest tier, never at the parser’s 1x', async () => {
  // No default leverage listed either: the highest a tier allows (40x, the $4M tier).
  const { initLeverage: _i, ...bare } = CAPPED;
  const r = await rig([{ ...bare, openInterestCap: null }, ETH]);
  r.position.size = 60;
  r.position.entry = 60_000;
  await assert.rejects(add(r, { kind: 'twap', quantity: '10', durationMs: 600_000, slices: 5, exec: { style: 'taker' } }), /over SoDEX's limit of \$4M at 40x/);
  // With SoDEX's default listed (20x), that is what counts.
  const r2 = await rig([{ ...CAPPED, openInterestCap: null }, ETH]);
  r2.position.size = 60;
  assert.equal((await add(r2, { kind: 'twap', quantity: '10', durationMs: 600_000, slices: 5, exec: { style: 'taker' } })).status, 'scheduled');
});

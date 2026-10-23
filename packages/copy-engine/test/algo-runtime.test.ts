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
  type SodexClient,
} from '../src/index.ts';
import { BTC, FOLLOWER } from './helpers.ts';

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
  onState(): void {}
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
  autoFill = true;
  constructor(private readonly m: FakeMarket) {}
  get all(): ChildRequest[] {
    return this.placed.flat();
  }
  async place(_a: AlgoRecord, _m: unknown, orders: ChildRequest[]): Promise<ChildResult[]> {
    this.placed.push(orders);
    if (this.mode !== 'ok') return orders.map((o) => ({ clOrdID: o.clOrdID, ok: false, orderId: null, error: this.mode === 'reject' ? 'nope' : 'timeout', outcomeUnknown: this.mode === 'unknown' }));
    for (const o of orders) {
      const q = this.m.quote('BTC-USD')!;
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
  position: { size: number };
  lookupRows: Array<{ clOrdID: string; orderId: string; status: string; executedQty: number; executedValue: number }>;
}

async function rig(): Promise<Rig> {
  const market = new FakeMarket();
  const sink = new FakeSink(market);
  const store = new MemoryAlgoStore();
  const position = { size: 0 };
  const lookups: Rig['lookups'] = [];
  const r: Rig = { rt: null as unknown as AlgoRuntime, market, sink, store, lookups, position, lookupRows: [] };
  const sodex = { markets: async () => [BTC], follower: async () => ({ positions: { 'BTC-USD': { size: position.size } } }), get: async () => [] } as unknown as SodexClient;
  r.rt = new AlgoRuntime({
    store,
    sodex,
    network: 'mainnet',
    market,
    sinkFor: () => sink,
    log: silentLogger,
    autoTick: false,
    lookup: async (_a, _s, history) => {
      lookups.push({ history });
      return history ? r.lookupRows : [];
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

test('POV: a share of what others trade - its own prints do not count', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'pov', quantity: '0.01', rate: 0.1, exec: { style: 'taker' } });
  await step(r, a.id);
  assert.equal(r.sink.all.length, 0);
  r.market.print({ price: 60_000, qty: 0.05 });
  r.market.print({ price: 60_000, qty: 1, buyer: ACCOUNT });
  const x = await step(r, a.id, 1_000);
  assert.equal(x.marketQty, 0.05);
  assert.equal(r.sink.all.length, 1);
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

/**
 * Audit of the RESTING algo kinds (scale / DCA ladder, iceberg, chase) and what
 * they share: post-only refusals, partial fills, re-price races, tick / step
 * snapping, min notional, limit price, pause / resume / cancel, restarts,
 * exits, paper fills. Each test asserts the intended behaviour; a failing test
 * is a bug.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  AlgoRuntime,
  MemoryAlgoStore,
  checkAlgoSpec,
  parseAlgoSpec,
  scaleLadder,
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
  type ScaleSpec,
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
  quotes = new Map<string, Quote>();
  marks = new Map<string, MarkInfo>();
  printCbs: Array<(p: Print) => void> = [];
  orderCbs: Array<(u: OrderUpdate) => void> = [];
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

/**
 * A sink that behaves like SoDEX: IOCs fill at the touch when they reach it,
 * a post-only (GTX) order at or through the other side is REJECTED (as an
 * order update, or as an error answer), resting orders rest.
 */
class Sink implements AlgoSink {
  readonly paper = false;
  placed: ChildRequest[][] = [];
  cancelled: string[] = [];
  resting = new Map<string, ChildRequest & { filled: number }>();
  stops: StopRequest[][] = [];
  /** How SoDEX refuses a crossing GTX. */
  postOnly: 'update' | 'error' = 'update';
  /** The socket delivers order updates. */
  emit = true;
  /** Refuse the next N orders with an error answer. */
  rejectNext = 0;
  /** Hold every place() until this resolves. */
  gate: Promise<void> | null = null;
  onPlace: ((orders: ChildRequest[]) => Promise<void> | void) | null = null;
  constructor(private readonly m: FakeMarket) {}
  get all(): ChildRequest[] {
    return this.placed.flat();
  }
  private up(u: Partial<OrderUpdate> & { clOrdID: string }): void {
    if (this.emit) setImmediate(() => this.m.order(u));
  }
  async place(_a: AlgoRecord, mk: { name: string }, orders: ChildRequest[]): Promise<ChildResult[]> {
    this.placed.push(orders);
    if (this.onPlace) await this.onPlace(orders);
    if (this.gate) await this.gate;
    const out: ChildResult[] = [];
    for (const o of orders) {
      if (this.rejectNext > 0) {
        this.rejectNext--;
        out.push({ clOrdID: o.clOrdID, ok: false, orderId: null, error: 'insufficient margin', outcomeUnknown: false });
        continue;
      }
      const q = this.m.quote(mk.name)!;
      const touch = o.side === 'buy' ? q.ask : q.bid;
      const reaches = o.side === 'buy' ? Number(o.price) >= touch : Number(o.price) <= touch;
      if (o.tif === 'gtx' && reaches) {
        if (this.postOnly === 'error') {
          out.push({ clOrdID: o.clOrdID, ok: false, orderId: null, error: 'post-only order would take', outcomeUnknown: false });
          continue;
        }
        this.up({ clOrdID: o.clOrdID, status: 'REJECTED', reason: 'post-only order would take' });
      } else if (o.tif === 'ioc') {
        if (reaches) this.up({ clOrdID: o.clOrdID, status: 'FILLED', filledQty: Number(o.quantity), filledValue: Number(o.quantity) * touch, maker: false });
        else this.up({ clOrdID: o.clOrdID, status: 'CANCELED' });
      } else if (o.tif === 'gtc' && reaches) {
        this.up({ clOrdID: o.clOrdID, status: 'FILLED', filledQty: Number(o.quantity), filledValue: Number(o.quantity) * touch, maker: false });
      } else {
        this.resting.set(o.clOrdID, { ...o, filled: 0 });
        this.up({ clOrdID: o.clOrdID, status: 'NEW' });
      }
      out.push({ clOrdID: o.clOrdID, ok: true, orderId: '1', error: null, outcomeUnknown: false });
    }
    return out;
  }
  async cancel(_a: AlgoRecord, _m: unknown, ids: string[]): Promise<void> {
    this.cancelled.push(...ids);
    for (const id of ids) {
      const r = this.resting.get(id);
      this.resting.delete(id);
      this.up({ clOrdID: id, status: 'CANCELED', filledQty: r?.filled ?? 0, filledValue: (r?.filled ?? 0) * Number(r?.price ?? 0) });
    }
  }
  async setLeverage(): Promise<void> {}
  async placeStops(_a: AlgoRecord, _m: unknown, stops: StopRequest[]): Promise<ChildResult[]> {
    this.stops.push(stops);
    for (const s of stops) this.up({ clOrdID: s.clOrdID, status: 'NEW' });
    return stops.map((s) => ({ clOrdID: s.clOrdID, ok: true, orderId: '2', error: null, outcomeUnknown: false }));
  }
  /** Fill a resting order (part or all); the socket says so. */
  fill(id: string, qty: number): void {
    const r = this.resting.get(id)!;
    r.filled += qty;
    const done = r.filled >= Number(r.quantity) - 1e-12;
    if (done) this.resting.delete(id);
    this.m.order({ clOrdID: id, status: done ? 'FILLED' : 'PARTIALLY_FILLED', filledQty: r.filled, filledValue: r.filled * Number(r.price), maker: true });
  }
  /** What still rests on the fake book, in base units. */
  restingQty(): number {
    return [...this.resting.values()].reduce((x, r) => x + Number(r.quantity) - r.filled, 0);
  }
}

interface Rig {
  rt: AlgoRuntime;
  market: FakeMarket;
  sink: Sink;
  store: MemoryAlgoStore;
  policy: { value: RegionPolicy | null };
  account: { equity: number; gross: number };
}

function runtime(r: Pick<Rig, 'market' | 'sink' | 'store' | 'policy' | 'account'>): AlgoRuntime {
  const sodex = { markets: async () => [BTC, ETH], follower: async () => ({ positions: {} }), get: async () => [] } as unknown as SodexClient;
  return new AlgoRuntime({
    store: r.store,
    sodex,
    network: 'mainnet',
    market: r.market,
    sinkFor: () => r.sink,
    log: silentLogger,
    autoTick: false,
    policyFor: () => r.policy.value,
    account: async () => ({ ...r.account }),
    lookup: async () => [],
  });
}

async function rig(): Promise<Rig> {
  const market = new FakeMarket();
  const sink = new Sink(market);
  const store = new MemoryAlgoStore();
  const r = { market, sink, store, policy: { value: null }, account: { equity: 1_000_000, gross: 0 } } as unknown as Rig;
  r.rt = runtime(r);
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

const liveLeft = (a: AlgoRecord) => a.children.filter((c) => c.state === 'sending' || c.state === 'open' || c.state === 'unknown').reduce((x, c) => x + c.quantity - c.filled, 0);
const near = (x: number, y: number) => Math.abs(x - y) < 1e-9;
const eea: RegionPolicy = { region: 'eea', allowed: true, maxLeverage: 2, reason: null, country: 'DE', mismatch: false } as unknown as RegionPolicy;

/* ================================================================== SPEC / LADDER MATH ===== */

test('spec: a ladder price that is NaN, zero or negative is refused', () => {
  for (const p of [[60_000, Number.NaN], [60_000, 0], [60_000, -1], [60_000, 'x']]) {
    const r = checkAlgoSpec({ kind: 'scale', symbol: 'BTC-USD', side: 'buy', quantity: '0.01', from: 60_000, to: 59_000, orders: 2, prices: p });
    assert.equal(r.spec, null, `prices ${String(p)} must be refused`);
  }
});

test('spec: weights with a zero, a negative or the wrong count are refused', () => {
  for (const w of [[1, 0], [1, -1], [1], [1, 1, 1], [1, Number.NaN]]) {
    const r = checkAlgoSpec({ kind: 'scale', symbol: 'BTC-USD', side: 'buy', quantity: '0.01', from: 60_000, to: 59_000, orders: 2, prices: [60_000, 59_000], weights: w });
    assert.equal(r.spec, null, `weights ${String(w)} must be refused`);
  }
});

test('spec: one level, 101 levels and duplicate prices are refused; 100 levels are accepted', () => {
  const base = { kind: 'scale', symbol: 'BTC-USD', side: 'buy', quantity: '1', from: 60_000, to: 59_000 };
  assert.equal(checkAlgoSpec({ ...base, orders: 1 }).spec, null);
  assert.equal(checkAlgoSpec({ ...base, orders: 2, prices: [60_000] }).spec, null);
  assert.equal(checkAlgoSpec({ ...base, orders: 2, prices: Array.from({ length: 101 }, (_, i) => 60_000 - i) }).spec, null);
  assert.equal(checkAlgoSpec({ ...base, orders: 2, prices: [60_000, 60_000, 59_000] }).spec, null);
  assert.ok(checkAlgoSpec({ ...base, orders: 2, prices: Array.from({ length: 100 }, (_, i) => 60_000 - i) }).spec);
});

test('ladder: sizes are whole steps and add up to the quantity (every curve, skew extremes, jitter, 2..100 levels)', () => {
  const step = Number(BTC.stepSize);
  for (const distribution of ['flat', 'linear', 'exponential', 'bell'] as const) {
    for (const skew of [0.001, 1, 1000]) {
      for (const orders of [2, 3, 7, 100]) {
        const s = parseAlgoSpec({ kind: 'scale', symbol: 'BTC-USD', side: 'buy', quantity: '0.12345', from: 60_000, to: 50_000, orders, distribution, skew, sizeJitter: 0.3 }) as ScaleSpec;
        const l = scaleLadder(s, BTC, 7);
        const sum = l.reduce((x, y) => x + y.qty, 0);
        assert.ok(sum <= 0.12345 + 1e-12, `${distribution}/${skew}/${orders}: ${sum} over the quantity`);
        assert.ok(near(sum, 0.12345), `${distribution}/${skew}/${orders}: ${sum} short of the quantity`);
        for (const x of l) assert.ok(Math.abs(x.qty / step - Math.round(x.qty / step)) < 1e-6, `${x.qty} is not whole steps`);
        assert.equal(new Set(l.map((x) => x.price)).size, l.length, 'no duplicate price');
      }
    }
  }
});

test('ladder: explicit prices the tick merges become one level; the sizes still add up to the quantity', () => {
  const s = parseAlgoSpec({ kind: 'scale', symbol: 'BTC-USD', side: 'buy', quantity: '0.003', from: 60_000, to: 59_000, orders: 3, prices: [60_000.2, 60_000.4, 59_000], weights: [1, 1, 1] }) as ScaleSpec;
  const l = scaleLadder(s, BTC, 1);
  assert.deepEqual(l.map((x) => x.price), [60_000, 59_000]);
  assert.ok(near(l.reduce((x, y) => x + y.qty, 0), 0.003));
});

test('ladder: a coarse tick that fits fewer prices than orders drops duplicates, sizes still add up', () => {
  const s = parseAlgoSpec({ kind: 'scale', symbol: 'BTC-USD', side: 'buy', quantity: '0.01', from: 60_003, to: 60_000, orders: 10 }) as ScaleSpec;
  const l = scaleLadder(s, BTC, 1);
  assert.deepEqual(l.map((x) => x.price), [60_003, 60_002, 60_001, 60_000]);
  assert.ok(near(l.reduce((x, y) => x + y.qty, 0), 0.01));
});

/* ================================================================== SCALE RUNTIME ===== */

test('scale: 100 levels go out in two signed batches of 50', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'scale', quantity: '0.1', from: 59_900, to: 59_000, orders: 100, postOnly: true });
  const x = await step(r, a.id);
  assert.deepEqual(r.sink.placed.map((b) => b.length), [50, 50]);
  assert.ok(near(r.sink.all.reduce((s, o) => s + Number(o.quantity), 0), 0.1));
  assert.equal(x.status, 'running');
});

test('scale (sell): the ladder goes up from the first price, post-only, and is done when every level fills', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'scale', side: 'sell', quantity: '0.004', from: 60_100, to: 60_400, orders: 4, postOnly: true });
  await step(r, a.id);
  assert.deepEqual(r.sink.all.map((o) => [o.side, o.price, o.tif]), [['sell', '60100', 'gtx'], ['sell', '60200', 'gtx'], ['sell', '60300', 'gtx'], ['sell', '60400', 'gtx']]);
  for (const o of r.sink.all) r.sink.fill(o.clOrdID, Number(o.quantity));
  await settle();
  const x = await step(r, a.id, 500);
  assert.equal(x.status, 'done');
  assert.ok(near(x.filled, 0.004));
});

test('scale: post-only levels at or through the book are refused (not counted as filled) and the algo still ends', async () => {
  const r = await rig();
  // 60 050 and 60 010 are at / through the ask (60 010): SoDEX refuses them as post-only.
  const a = await add(r, { kind: 'scale', quantity: '0.004', from: 60_050, to: 59_900, orders: 4, prices: [60_050, 60_010, 59_950, 59_900], weights: [1, 1, 1, 1], postOnly: true });
  let x = await step(r, a.id);
  assert.equal(x.rejects, 2);
  assert.equal(x.filled, 0);
  for (const id of [...r.sink.resting.keys()]) r.sink.fill(id, 0.001);
  await settle();
  x = await step(r, a.id, 500);
  assert.equal(x.status, 'expired', 'ends once nothing rests');
  assert.ok(near(x.filled, 0.002));
});

test('scale: post-only levels refused as an error answer are not retried and the algo still ends', async () => {
  const r = await rig();
  r.sink.postOnly = 'error';
  const a = await add(r, { kind: 'scale', quantity: '0.004', from: 60_050, to: 59_900, orders: 4, prices: [60_050, 60_010, 59_950, 59_900], weights: [1, 1, 1, 1], postOnly: true });
  await step(r, a.id);
  for (const id of [...r.sink.resting.keys()]) r.sink.fill(id, 0.001);
  await settle();
  const x = await step(r, a.id, 500);
  assert.equal(r.sink.placed.length, 1, 'refused levels are not sent again');
  assert.equal(x.status, 'expired');
});

test('scale: a partial fill then cancel keeps exactly what filled and cancels every level still resting', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'scale', quantity: '0.01', from: 59_900, to: 59_500, orders: 5, postOnly: true });
  await step(r, a.id);
  r.sink.fill(r.sink.all[0]!.clOrdID, 0.0007);
  await settle();
  await r.rt.cancel(a.id);
  await settle();
  assert.equal(r.sink.resting.size, 0);
  assert.equal(r.sink.cancelled.length, 5);
  const x = r.rt.get(a.id)!;
  assert.equal(x.status, 'cancelled');
  assert.ok(near(x.filled, 0.0007));
});

test('scale: pause pulls every resting level', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'scale', quantity: '0.003', from: 59_900, to: 59_700, orders: 3, postOnly: true });
  await step(r, a.id);
  await r.rt.pause(a.id);
  await settle();
  assert.equal(r.sink.resting.size, 0);
  assert.equal(r.rt.get(a.id)!.status, 'paused');
});

test('BUG scale: resume after pause puts the unfilled levels back (it must not end "expired")', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'scale', quantity: '0.003', from: 59_900, to: 59_700, orders: 3, postOnly: true });
  await step(r, a.id);
  r.sink.fill(r.sink.all[0]!.clOrdID, 0.001);
  await settle();
  await r.rt.pause(a.id);
  await settle();
  await r.rt.resume(a.id);
  const x = await step(r, a.id, 500);
  assert.notEqual(x.status, 'expired', 'a resumed ladder must keep working');
  assert.ok(near(r.sink.restingQty(), 0.002), `the two unfilled levels rest again (resting ${r.sink.restingQty()})`);
});

test('BUG scale: under the region leverage cap the ladder waits for room instead of expiring unplaced', async () => {
  const r = await rig();
  r.policy.value = eea;
  r.account.equity = 100; // 2x of 100 = 200 USD of room; the ladder is ~600 USD
  const a = await add(r, { kind: 'scale', quantity: '0.01', from: 59_900, to: 59_500, orders: 5, postOnly: true });
  let x = await step(r, a.id);
  assert.equal(r.sink.placed.length, 0);
  assert.equal(x.status, 'waiting');
  r.account.equity = 100_000;
  x = await step(r, a.id, 11_000); // the account is read again after 10 s
  x = await step(r, a.id, 500);
  assert.notEqual(x.status, 'expired', 'a ladder that never went out must not end as "did not fill"');
  assert.equal(r.sink.all.length, 5, 'the ladder goes out once it fits');
});

test('BUG scale: once the algo failed (25 refusals) the next batch of the ladder is not sent', async () => {
  const r = await rig();
  r.sink.rejectNext = 50; // the first batch is refused (margin)
  const prices = Array.from({ length: 60 }, (_, i) => 59_900 - i * 10);
  const a = await add(r, { kind: 'scale', quantity: '0.06', from: prices[0], to: prices[59], orders: 60, prices, weights: prices.map(() => 1), postOnly: true });
  const x = await step(r, a.id);
  assert.equal(x.status, 'failed');
  assert.equal(r.sink.placed.length, 1, `no order may be sent for a failed algo (sent ${r.sink.placed.length} batches)`);
});

test('BUG scale: a cancel while the first batch is on its way stops the second batch going out', async () => {
  const r = await rig();
  let release!: () => void;
  r.sink.gate = new Promise<void>((res) => (release = res));
  const prices = Array.from({ length: 60 }, (_, i) => 59_900 - i * 10);
  const a = await add(r, { kind: 'scale', quantity: '0.06', from: prices[0], to: prices[59], orders: 60, prices, weights: prices.map(() => 1), postOnly: true });
  const stepping = r.rt.stepNow(a.id, clock);
  await new Promise((res) => setImmediate(res));
  await r.rt.cancel(a.id);
  r.sink.gate = null;
  release();
  await stepping;
  await settle();
  assert.equal(r.sink.placed.length, 1, 'the second batch must not be sent after the cancel');
  assert.equal(r.sink.restingQty(), 0, 'nothing of a cancelled ladder rests');
});

test('BUG scale: no level is placed past the limit price (or the spec is refused)', async () => {
  const r = await rig();
  let a: AlgoRecord;
  try {
    a = await add(r, { kind: 'scale', quantity: '0.005', from: 59_900, to: 59_500, orders: 5, limitPrice: 59_700, postOnly: true });
  } catch {
    return; // refused: fine
  }
  await step(r, a.id);
  const over = r.sink.all.filter((o) => Number(o.price) > 59_700);
  assert.equal(over.length, 0, `levels above the buy limit of 59 700: ${over.map((o) => o.price).join(', ')}`);
});

test('BUG scale (DCA at $10 a level): every level reaches the minimum, or the ladder is refused - none is silently dropped', async () => {
  const r = await rig();
  // What the DCA ticket builds for $10 per order (USD sizing) on five levels 1% apart.
  const prices = [60_000, 59_400, 58_800, 58_200, 57_600];
  const sizes = prices.map((p) => 10 / p);
  const quantity = sizes.reduce((x, y) => x + y, 0).toFixed(12).replace(/0+$/, '');
  let a: AlgoRecord;
  try {
    a = await add(r, { kind: 'scale', label: 'DCA', quantity, from: prices[0], to: prices[4], orders: 5, distribution: 'exponential', skew: 1, prices, weights: sizes, postOnly: true });
  } catch {
    return; // refused up front: fine
  }
  await step(r, a.id);
  assert.equal(r.sink.all.length, 5, `levels placed: ${r.sink.all.map((o) => `${o.quantity}@${o.price}`).join(', ')}`);
});

test('BUG scale: lowering the size below what rests pulls the excess (no over-fill)', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'scale', quantity: '0.01', from: 59_900, to: 59_500, orders: 5, postOnly: true });
  await step(r, a.id);
  r.sink.fill(r.sink.all[0]!.clOrdID, 0.002);
  await settle();
  await r.rt.update(a.id, { quantity: '0.004' });
  const x = await step(r, a.id, 500);
  assert.ok(x.filled + liveLeft(x) <= 0.004 + 1e-12, `filled ${x.filled} + still working ${liveLeft(x)} is over the new size 0.004`);
});

test('scale: exits follow the ladder as it fills (sized to the fill, resized after 5 s)', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'scale', quantity: '0.004', from: 59_900, to: 59_600, orders: 4, postOnly: true, exits: { tpPct: 0.02, slPct: 0.01 } });
  await step(r, a.id);
  r.sink.fill(r.sink.all[0]!.clOrdID, 0.001);
  await settle();
  await step(r, a.id, 500);
  assert.equal(r.sink.stops.length, 1);
  assert.deepEqual(r.sink.stops[0]!.map((s) => [s.kind, s.side, s.quantity]), [['tp', 'sell', '0.001'], ['sl', 'sell', '0.001']]);
  r.sink.fill(r.sink.all[1]!.clOrdID, 0.001);
  await settle();
  await step(r, a.id, 5_100); // cancels the old pair
  await step(r, a.id, 500); // places the new one
  const last = r.sink.stops[r.sink.stops.length - 1]!;
  assert.deepEqual(last.map((s) => s.quantity), ['0.002', '0.002']);
  const avg = (59_900 + 59_800) / 2;
  assert.equal(Number(last[0]!.triggerPrice), Math.round(avg * 1.02));
});

test('scale (sell) exits: take-profit below, stop-loss above the average, buy side, reduce-only', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'scale', side: 'sell', quantity: '0.002', from: 60_100, to: 60_200, orders: 2, postOnly: true, exits: { tpPct: 0.02, slPct: 0.01 } });
  await step(r, a.id);
  r.sink.fill(r.sink.all[0]!.clOrdID, 0.001);
  await settle();
  await step(r, a.id, 500);
  const [tp, sl] = r.sink.stops[0]!;
  assert.equal(tp!.side, 'buy');
  assert.ok(Number(tp!.triggerPrice) < 60_100 && Number(sl!.triggerPrice) > 60_100);
});

test('scale (paper): levels fill when the tape trades through them; done when all filled', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'scale', quantity: '0.002', from: 59_900, to: 59_800, orders: 2, postOnly: true, paper: true });
  let x = await step(r, a.id);
  assert.equal(r.sink.placed.length, 0);
  assert.equal(x.children.length, 2);
  r.market.print({ price: 59_950, qty: 1, taker: 'sell' });
  await settle();
  assert.equal(r.rt.get(a.id)!.filled, 0, 'a print above the bids fills nothing');
  r.market.print({ price: 59_800, qty: 1, taker: 'sell' });
  await settle();
  x = await step(r, a.id, 500);
  assert.equal(x.status, 'done');
  assert.ok(near(x.filled, 0.002));
  assert.ok(near(x.filledValue, 0.001 * 59_900 + 0.001 * 59_800), 'paper fills at the resting price');
});

test('scale (paper): a restart puts the resting levels back on the paper book, nothing doubled', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'scale', quantity: '0.002', from: 59_900, to: 59_800, orders: 2, postOnly: true, paper: true });
  await step(r, a.id);
  await r.rt.stop();
  const again = runtime(r);
  await again.start();
  await again.stepNow(a.id, clock + 500);
  await settle();
  const x = again.get(a.id)!;
  assert.equal(x.children.length, 2, 'no level is placed twice');
  r.market.print({ price: 59_800, qty: 1, taker: 'sell' });
  await settle();
  await again.stepNow(a.id, clock + 1_000);
  await settle();
  assert.equal(again.get(a.id)!.status, 'done');
});

test('scale: a restart (clean stop) asks SoDEX about the levels and places none again', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'scale', quantity: '0.003', from: 59_900, to: 59_700, orders: 3, postOnly: true });
  await step(r, a.id);
  await r.rt.stop();
  const again = runtime(r);
  await again.start();
  await again.stepNow(a.id, clock + 500);
  await settle();
  assert.equal(r.sink.all.length, 3);
  assert.ok(again.get(a.id)!.children.every((c) => c.state === 'unknown'));
});

/* ================================================================== RESTART AFTER A CRASH ===== */

test('BUG crash between "sent" and "acked": the child is in the store before the order leaves', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'chase', quantity: '0.002' });
  let saved: AlgoRecord | undefined;
  r.sink.onPlace = async () => {
    saved = (await r.store.algos()).find((x) => x.id === a.id);
  };
  await step(r, a.id);
  assert.equal(r.sink.all.length, 1);
  assert.ok(saved!.children.some((c) => c.clOrdID === r.sink.all[0]!.clOrdID), 'the stored record must hold the child it is about to send');
});

test('BUG crash after placing (no clean stop): a new runner does not place a second resting order', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'scale', quantity: '0.003', from: 59_900, to: 59_700, orders: 3, postOnly: true });
  await step(r, a.id);
  assert.equal(r.sink.all.length, 3);
  // The process dies here: no stop(), no flush. A new runner starts on the same store.
  const again = runtime(r);
  await again.start();
  await again.stepNow(a.id, clock + 500);
  await settle();
  assert.equal(r.sink.all.length, 3, `the ladder was placed again: ${r.sink.all.length} orders on SoDEX`);
});

/* ================================================================== ICEBERG ===== */

test('iceberg (pegged, post-only): one clip at the bid, re-priced when the bid moves away by the re-price distance', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'iceberg', quantity: '0.006', displayQty: '0.002', chaseTicks: 3 });
  await step(r, a.id);
  assert.deepEqual([r.sink.all[0]!.tif, r.sink.all[0]!.price, r.sink.all[0]!.quantity], ['gtx', '60000', '0.002']);
  r.market.set('BTC-USD', 60_002, 60_012);
  await step(r, a.id, 1_500);
  assert.equal(r.sink.cancelled.length, 0, '2 ticks is under the re-price distance');
  r.market.set('BTC-USD', 60_003, 60_013);
  await step(r, a.id, 500);
  assert.equal(r.sink.cancelled.length, 1);
  await step(r, a.id, 500);
  assert.equal(r.sink.all[1]!.price, '60003');
  assert.equal(r.sink.all[1]!.quantity, '0.002');
});

test('iceberg: never fills more than its size, even when a clip fills while its re-price cancel is out', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'iceberg', quantity: '0.005', displayQty: '0.002', chaseTicks: 1 });
  for (let i = 0; i < 40; i++) {
    const x = r.rt.get(a.id)!;
    if (x.status !== 'running' && x.status !== 'waiting' && x.status !== 'scheduled') break;
    await step(r, a.id, 1_000);
    const live = [...r.sink.resting.keys()];
    if (!live.length) continue;
    // Move the bid (re-price) and fill the clip in full in the same breath.
    r.market.set('BTC-USD', 60_000 + (i % 2 ? 2 : 0), 60_010 + (i % 2 ? 2 : 0));
    await r.rt.stepNow(a.id, clock);
    r.sink.fill(live[0]!, Number(r.sink.resting.get(live[0]!)!.quantity) - r.sink.resting.get(live[0]!)!.filled);
    await settle();
  }
  const x = r.rt.get(a.id)!;
  assert.ok(x.filled <= 0.005 + 1e-12, `filled ${x.filled}`);
  assert.equal(x.status, 'done');
  assert.ok(near(x.filled, 0.005));
});

test('BUG iceberg: a clip partly filled during its re-price cancel is refilled with only what was left of it', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'iceberg', quantity: '0.006', displayQty: '0.002', chaseTicks: 1 });
  await step(r, a.id);
  const first = r.sink.all[0]!.clOrdID;
  r.market.set('BTC-USD', 60_005, 60_015);
  // The cancel goes out ...
  const mkCancel = r.sink.cancel.bind(r.sink);
  r.sink.cancel = async (aa, m, ids) => {
    // ... and before it lands, 0.0015 of the clip fills.
    r.sink.fill(first, 0.0015);
    return mkCancel(aa, m, ids);
  };
  await step(r, a.id, 1_000);
  r.sink.cancel = mkCancel;
  await step(r, a.id, 500);
  const x = r.rt.get(a.id)!;
  assert.ok(near(x.filled, 0.0015));
  const second = r.sink.all[1]!;
  assert.equal(second.quantity, '0.0005', `the refill should show what is left of the clip (0.0005), not ${second.quantity}`);
});

test('iceberg: the next clip waits for the refill delay', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'iceberg', quantity: '0.004', displayQty: '0.002', price: 59_990, refillMs: 10_000 });
  await step(r, a.id);
  r.sink.fill(r.sink.all[0]!.clOrdID, 0.002);
  await settle();
  await step(r, a.id, 5_000);
  assert.equal(r.sink.all.length, 1);
  await step(r, a.id, 5_500);
  assert.equal(r.sink.all.length, 2);
  r.sink.fill(r.sink.all[1]!.clOrdID, 0.002);
  await settle();
  const x = await step(r, a.id, 500);
  assert.equal(x.status, 'done');
});

test('iceberg (sell, pegged): clips at the ask, never below the limit price', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'iceberg', side: 'sell', quantity: '0.004', displayQty: '0.002', limitPrice: 60_050 });
  await step(r, a.id);
  assert.equal(r.sink.all[0]!.price, '60050');
  assert.equal(r.sink.all[0]!.side, 'sell');
});

test('iceberg: the last clip takes the remainder when what would be left is under the minimum', async () => {
  const r = await rig();
  // 0.0005 is 30 USD; 0.00052 would leave 0.00002 (1.2 USD) after a 0.0005 clip: the last clip takes it all.
  const a = await add(r, { kind: 'iceberg', quantity: '0.00052', displayQty: '0.0005', price: 59_990 });
  await step(r, a.id);
  assert.equal(r.sink.all[0]!.quantity, '0.00052');
});

test('BUG iceberg: a "rush" bound takes the rest even while a fixed-price clip rests', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'iceberg', quantity: '0.004', displayQty: '0.002', price: 59_990, upper: { price: 61_000, then: 'rush' } });
  await step(r, a.id);
  r.market.set('BTC-USD', 61_500, 61_510);
  for (let i = 0; i < 6; i++) await step(r, a.id, 1_000);
  const iocs = r.sink.all.filter((o) => o.tif === 'ioc');
  assert.ok(iocs.length > 0, 'rush must cancel the clip and take what is left');
});

test('BUG iceberg: a fixed post-only price through the book waits; it does not burn 25 refusals and fail', async () => {
  const r = await rig();
  r.sink.postOnly = 'error';
  const a = await add(r, { kind: 'iceberg', quantity: '0.004', displayQty: '0.002', price: 60_020 });
  let x = r.rt.get(a.id)!;
  for (let i = 0; i < 30; i++) x = await step(r, a.id, 500);
  assert.notEqual(x.status, 'failed', `ended: ${x.statusReason}`);
  r.market.set('BTC-USD', 60_025, 60_035);
  x = await step(r, a.id, 500);
  assert.ok(r.sink.resting.size === 1, 'the clip goes out once the price is no longer through the book');
});

test('BUG iceberg: a fixed price past the limit price is refused, or no clip is sent past it', async () => {
  const r = await rig();
  let a: AlgoRecord;
  try {
    a = await add(r, { kind: 'iceberg', quantity: '0.004', displayQty: '0.002', price: 59_990, limitPrice: 59_900 });
  } catch {
    return;
  }
  await step(r, a.id);
  assert.equal(r.sink.all.filter((o) => Number(o.price) > 59_900).length, 0, `clip sent at ${r.sink.all[0]?.price} past the buy limit 59 900`);
});

test('BUG iceberg: a pegged clip one tick inside the spread does not chase its own price up to the ask', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'iceberg', quantity: '0.004', displayQty: '0.002', pegOffsetTicks: -1, chaseTicks: 1 });
  await step(r, a.id);
  assert.equal(r.sink.all[0]!.price, '60001');
  // The book now shows our own clip as the best bid, as SoDEX's would.
  for (let i = 0; i < 6; i++) {
    const mine = [...r.sink.resting.values()][0];
    if (mine) r.market.set('BTC-USD', Number(mine.price), 60_010);
    await step(r, a.id, 1_100);
  }
  const top = Math.max(...r.sink.all.map((o) => Number(o.price)));
  assert.ok(top <= 60_001, `the clip walked itself up to ${top} (each re-price stepping over its own bid)`);
});

test('iceberg (paper): clips fill from the tape, the next one shows after each fill, done at the size', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'iceberg', quantity: '0.004', displayQty: '0.002', paper: true });
  for (let i = 0; i < 6; i++) {
    await step(r, a.id, 500);
    r.market.print({ price: 59_999, qty: 0.0015, taker: 'sell' });
    await settle();
  }
  const x = await step(r, a.id, 500);
  assert.equal(r.sink.placed.length, 0);
  assert.equal(x.status, 'done');
  assert.ok(near(x.filled, 0.004));
});

test('iceberg: pause pulls the clip; resume shows a new one; cancel pulls it again', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'iceberg', quantity: '0.006', displayQty: '0.002', price: 59_990 });
  await step(r, a.id);
  r.sink.fill(r.sink.all[0]!.clOrdID, 0.0005);
  await settle();
  await r.rt.pause(a.id);
  await settle();
  assert.equal(r.sink.resting.size, 0);
  await step(r, a.id, 500);
  assert.equal(r.sink.all.length, 1, 'nothing new while paused');
  await r.rt.resume(a.id);
  await step(r, a.id, 500);
  assert.equal(r.sink.resting.size, 1);
  await r.rt.cancel(a.id);
  await settle();
  assert.equal(r.sink.resting.size, 0);
  assert.ok(near(r.rt.get(a.id)!.filled, 0.0005));
});

/* ================================================================== CHASE ===== */

test('chase: rests at the bid, re-prices only after the re-price pause, follows the bid', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'chase', quantity: '0.002', chaseTicks: 2, minRepriceMs: 3_000 });
  await step(r, a.id);
  assert.deepEqual([r.sink.all[0]!.price, r.sink.all[0]!.tif], ['60000', 'gtx']);
  r.market.set('BTC-USD', 60_005, 60_015);
  await step(r, a.id, 1_000);
  assert.equal(r.sink.cancelled.length, 0, 'not before the re-price pause');
  await step(r, a.id, 2_100);
  assert.equal(r.sink.cancelled.length, 1);
  await step(r, a.id, 500);
  assert.equal(r.sink.all[1]!.price, '60005');
});

test('chase: never chases past the max chase from where it started (buy) nor the limit price', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'chase', quantity: '0.002', maxChaseBps: 10, limitPrice: 60_100 });
  await step(r, a.id);
  r.market.set('BTC-USD', 60_500, 60_510);
  await step(r, a.id, 1_500);
  await step(r, a.id, 500);
  const last = r.sink.all[r.sink.all.length - 1]!;
  assert.ok(Number(last.price) <= 60_060, `re-priced to ${last.price}, past 10 bp over 60 000`);
});

test('chase (sell): never chases below the max chase from where it started', async () => {
  const r = await rig();
  // onEnd 'rest': reaching the max chase now ends the chase as set (types.ts: "When the cap or the time is reached");
  // the default 'take' would sell the rest at the market, which is not what this test is about.
  const a = await add(r, { kind: 'chase', side: 'sell', quantity: '0.002', maxChaseBps: 10, onEnd: 'rest' });
  await step(r, a.id);
  assert.equal(r.sink.all[0]!.price, '60010');
  r.market.set('BTC-USD', 59_500, 59_510);
  await step(r, a.id, 1_500);
  await step(r, a.id, 500);
  const last = r.sink.all[r.sink.all.length - 1]!;
  assert.ok(Number(last.price) >= 60_010 * (1 - 0.001) - 1e-9, `re-priced to ${last.price}`);
  assert.ok(Number(last.price) > 59_510, 'still resting (above the bid)');
});

test('chase: stalking N bp behind the bid', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'chase', quantity: '0.002', offsetBps: 10 });
  await step(r, a.id);
  assert.equal(r.sink.all[0]!.price, '59940');
});

test('chase: a partial fill then a re-price sends only the rest', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'chase', quantity: '0.002' });
  await step(r, a.id);
  r.sink.fill(r.sink.all[0]!.clOrdID, 0.0012);
  await settle();
  r.market.set('BTC-USD', 60_005, 60_015);
  await step(r, a.id, 1_500);
  await step(r, a.id, 500);
  assert.equal(r.sink.all[1]!.quantity, '0.0008');
  r.sink.fill(r.sink.all[1]!.clOrdID, 0.0008);
  await settle();
  const x = await step(r, a.id, 500);
  assert.equal(x.status, 'done');
  assert.ok(near(x.filled, 0.002));
});

test('chase: a fill that lands while the re-price cancel is out is counted once and nothing more is sent past the size', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'chase', quantity: '0.002' });
  await step(r, a.id);
  const first = r.sink.all[0]!.clOrdID;
  r.market.set('BTC-USD', 60_005, 60_015);
  const mkCancel = r.sink.cancel.bind(r.sink);
  r.sink.cancel = async (aa, m, ids) => {
    r.sink.fill(first, 0.002); // filled in full: the cancel finds nothing
    return mkCancel(aa, m, ids);
  };
  await step(r, a.id, 1_500);
  r.sink.cancel = mkCancel;
  const x = await step(r, a.id, 500);
  assert.equal(r.sink.all.length, 1);
  assert.equal(x.status, 'done');
  assert.ok(near(x.filled, 0.002));
});

test('chase: on timeout "cancel" pulls the order and expires', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'chase', quantity: '0.002', timeoutMs: 5_000, onEnd: 'cancel' });
  await step(r, a.id);
  const x = await step(r, a.id, 5_000);
  assert.equal(x.status, 'expired');
  assert.equal(r.sink.resting.size, 0);
});

test('chase: on timeout "rest" leaves the order on SoDEX (and does not cancel it on a later update)', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'chase', quantity: '0.002', timeoutMs: 5_000, onEnd: 'rest' });
  await step(r, a.id);
  const x = await step(r, a.id, 5_000);
  assert.equal(x.status, 'expired');
  assert.equal(r.sink.resting.size, 1);
  r.sink.fill(r.sink.all[0]!.clOrdID, 0.001);
  await settle();
  assert.equal(r.sink.cancelled.length, 0);
  assert.ok(near(r.rt.get(a.id)!.filled, 0.001), 'its fills still count');
});

test('chase: on timeout "take" cancels the resting order first, then takes within the limit price', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'chase', quantity: '0.002', timeoutMs: 5_000, onEnd: 'take', limitPrice: 60_020 });
  await step(r, a.id);
  await step(r, a.id, 5_000);
  assert.equal(r.sink.cancelled.length, 1);
  assert.equal(r.sink.all.filter((o) => o.tif === 'ioc').length, 0, 'never both at once');
  const x = await step(r, a.id, 500);
  const ioc = r.sink.all.find((o) => o.tif === 'ioc')!;
  assert.ok(Number(ioc.price) <= 60_020);
  assert.equal(x.status, 'running');
  const y = await step(r, a.id, 500);
  assert.equal(y.status, 'done');
});

test('chase: "take" with the touch past the limit holds, it does not take past it', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'chase', quantity: '0.002', timeoutMs: 5_000, onEnd: 'take', limitPrice: 60_005 });
  await step(r, a.id);
  r.market.set('BTC-USD', 60_100, 60_110);
  await step(r, a.id, 5_000);
  const x = await step(r, a.id, 500);
  assert.equal(r.sink.all.filter((o) => o.tif === 'ioc').length, 0);
  assert.equal(x.status, 'waiting');
});

test('BUG chase: when the max chase is reached it ends as set (onEnd), it does not sit at the cap forever', async () => {
  const r = await rig();
  // types.ts: onEnd is "When the cap or the time is reached".
  const a = await add(r, { kind: 'chase', quantity: '0.002', maxChaseBps: 5, onEnd: 'cancel' });
  await step(r, a.id);
  r.market.set('BTC-USD', 61_000, 61_010);
  let x = r.rt.get(a.id)!;
  for (let i = 0; i < 10; i++) x = await step(r, a.id, 1_000);
  assert.equal(x.status, 'expired', `still ${x.status}, resting at ${r.sink.all[r.sink.all.length - 1]!.price}`);
});

test('BUG chase: an order one tick inside the spread does not chase its own bid up to the ask', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'chase', quantity: '0.002', offsetTicks: -1, chaseTicks: 1 });
  await step(r, a.id);
  assert.equal(r.sink.all[0]!.price, '60001');
  for (let i = 0; i < 6; i++) {
    const mine = [...r.sink.resting.values()][0];
    if (mine) r.market.set('BTC-USD', Number(mine.price), 60_010);
    await step(r, a.id, 1_100);
  }
  const top = Math.max(...r.sink.all.map((o) => Number(o.price)));
  assert.ok(top <= 60_001, `the chase walked itself up to ${top}`);
});

test('BUG chase: lowering the size below what rests pulls the excess (no over-fill)', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'chase', quantity: '0.01' });
  await step(r, a.id);
  await r.rt.update(a.id, { quantity: '0.004' });
  const x = await step(r, a.id, 500);
  assert.ok(x.filled + liveLeft(x) <= 0.004 + 1e-12, `0.004 now, but ${liveLeft(x)} still rests`);
});

test('BUG chase: a cancel while the order is on its way leaves nothing resting, even with no socket update', async () => {
  const r = await rig();
  r.sink.emit = false; // the order stream is down
  let release!: () => void;
  r.sink.gate = new Promise<void>((res) => (release = res));
  const a = await add(r, { kind: 'chase', quantity: '0.002' });
  const stepping = r.rt.stepNow(a.id, clock);
  await new Promise((res) => setImmediate(res));
  await r.rt.cancel(a.id);
  release();
  await stepping;
  await settle();
  for (let i = 0; i < 3; i++) {
    clock += 10_000;
    r.rt.tick(clock);
    await settle();
  }
  assert.equal(r.rt.get(a.id)!.status, 'cancelled');
  assert.ok(r.sink.cancelled.includes(r.sink.all[0]!.clOrdID), 'the order that went out after the cancel must be cancelled');
});

test('chase: a post-only refusal (the book moved) is not counted as filled; it rests again at the new price', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'chase', quantity: '0.002' });
  // The quote the step priced from is stale: the ask has come down onto 60 000.
  const place = r.sink.place.bind(r.sink);
  let once = true;
  r.sink.place = async (...args) => {
    if (once) {
      once = false;
      r.market.set('BTC-USD', 59_990, 60_000);
    }
    return place(...args);
  };
  let x = await step(r, a.id);
  assert.equal(x.filled, 0);
  assert.equal(x.rejects, 1);
  x = await step(r, a.id, 500);
  assert.equal(r.sink.all[1]!.price, '59990');
  assert.equal(x.filled, 0);
});

test('chase (paper): a post-only order through the book is refused, never filled', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'chase', quantity: '0.002', paper: true });
  await step(r, a.id);
  // Prints above the bid do not fill a resting buy.
  r.market.print({ price: 60_005, qty: 1, taker: 'sell' });
  await settle();
  assert.equal(r.rt.get(a.id)!.filled, 0);
  r.market.print({ price: 60_000, qty: 1, taker: 'buy' });
  await settle();
  assert.equal(r.rt.get(a.id)!.filled, 0, 'a buyer-initiated print does not fill a resting buy');
});

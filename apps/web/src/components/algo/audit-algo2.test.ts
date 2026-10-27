/**
 * Audit, round 2: the ticket -> spec -> plan -> runtime path. Each kind as the
 * ticket builds it (draftToSpec) with default and extreme settings, checked by
 * the engine (checkAlgoSpec), planned (planAlgo) and, where it matters, run
 * (AlgoRuntime on a fake SoDEX). A test named "BUG ..." asserts the correct
 * behaviour and fails while the bug is there.
 * Run (from apps/web): npx tsx --test src/components/algo/audit-algo2.test.ts
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  AlgoRuntime,
  MemoryAlgoStore,
  ORACLE_VENUES,
  checkAlgoSpec,
  planAlgo,
  scaleLadder,
  silentLogger,
  type AlgoMarket,
  type AlgoRecord,
  type AlgoSink,
  type AlgoSpec,
  type ChildRequest,
  type ChildResult,
  type MarketInfo,
  type MarkInfo,
  type OrderUpdate,
  type Print,
  type PriceSource,
  type Quote,
  type SodexClient,
  type StopRequest,
} from '@copy-engine';
import { DEFAULT, DRAFT_KEY, cond, draftToSpec, hasBounds, hasLimit, legs, loadDraft, saveDraft, type Draft, type TicketShared } from './draft';
import { ALGO_MENU, type UiKind } from './menu';

const NOW = 1_800_000_000_000;
const BTC: MarketInfo = {
  id: 1, name: 'BTC-USD', base: 'BTC', tickSize: '1', stepSize: '0.00001', minQuantity: '0.00001', maxQuantity: '1000', marketMaxQuantity: null,
  minNotional: 10, maxNotional: 5_000_000, maxLeverage: 50, buyLimitUpRatio: 0.05, sellLimitDownRatio: 0.05, takerFee: 0.0004, status: 'TRADING',
};
const ETH: MarketInfo = { ...BTC, id: 2, name: 'ETH-USD', base: 'ETH', tickSize: '0.1', stepSize: '0.0001', minQuantity: '0.0001' };

const buy: TicketShared = { symbol: 'BTC-USD', side: 'buy', quantity: '0.01', reduceOnly: false, leverage: 5, marginMode: 'cross', bid: 60_000, ask: 60_010 };
const sell: TicketShared = { ...buy, side: 'sell' };

function memStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), map: m };
}

/** The form as the ticket fills it from the book (prices near the touch). */
function untouched(kind: UiKind, side: 'buy' | 'sell' = 'buy'): Draft {
  const d: Draft = { ...DEFAULT };
  if (kind === 'scale') Object.assign(d, side === 'buy' ? { from: '59900', to: '58800' } : { from: '60100', to: '61200' });
  if (kind === 'conditional') d.conds = [cond('BTC-USD', { value: side === 'buy' ? '59400' : '60600', op: side === 'buy' ? 'below' : 'above' })];
  if (kind === 'basket') d.legs = legs('BTC-USD', side);
  if (kind === 'iceberg') d.display = '0.002';
  if (kind === 'bracket') d.entryPrice = side === 'buy' ? '59900' : '60100';
  return d;
}

const errorsOf = (kind: UiKind, d: Draft, p: TicketShared) => checkAlgoSpec(draftToSpec(kind, d, p, NOW)).errors;
const specOf = (kind: UiKind, d: Draft, p: TicketShared): AlgoSpec => {
  const c = checkAlgoSpec(draftToSpec(kind, d, p, NOW));
  assert.ok(c.spec, `${kind}: ${JSON.stringify(c.errors)}`);
  return c.spec!;
};

/* ------------------------------------------------------------ a fake SoDEX ----- */

let clock = NOW;
const realNow = Date.now;
beforeEach(() => {
  clock = NOW;
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
  onPrint(_cb: (p: Print) => void): void {}
  onOrder(cb: (u: OrderUpdate) => void): void {
    this.orderCbs.push(cb);
  }
  onState(): void {}
  order(u: Partial<OrderUpdate> & { clOrdID: string }): void {
    for (const cb of this.orderCbs) cb({ orderId: '1', symbol: 'BTC-USD', status: 'NEW', filledQty: 0, filledValue: 0, maker: null, reason: null, at: Date.now(), ...u });
  }
}

class FakeSink implements AlgoSink {
  readonly paper = false;
  placed: ChildRequest[][] = [];
  stops: StopRequest[][] = [];
  constructor(private readonly m: FakeMarket) {}
  get all(): ChildRequest[] {
    return this.placed.flat();
  }
  async place(_a: AlgoRecord, mk: { name: string }, orders: ChildRequest[]): Promise<ChildResult[]> {
    this.placed.push(orders);
    for (const o of orders) {
      const q = this.m.quote(mk.name)!;
      const touch = o.side === 'buy' ? q.ask : q.bid;
      const reaches = o.side === 'buy' ? Number(o.price) >= touch : Number(o.price) <= touch;
      setImmediate(() => {
        if (o.tif === 'ioc') {
          if (reaches) this.m.order({ clOrdID: o.clOrdID, status: 'FILLED', filledQty: Number(o.quantity), filledValue: Number(o.quantity) * touch, maker: false });
          else this.m.order({ clOrdID: o.clOrdID, status: 'CANCELED' });
        } else this.m.order({ clOrdID: o.clOrdID, status: 'NEW' });
      });
    }
    return orders.map((o) => ({ clOrdID: o.clOrdID, ok: true, orderId: '1', error: null, outcomeUnknown: false }));
  }
  async cancel(_a: AlgoRecord, _m: unknown, ids: string[]): Promise<void> {
    for (const id of ids) setImmediate(() => this.m.order({ clOrdID: id, status: 'CANCELED' }));
  }
  async setLeverage(): Promise<void> {}
  async placeStops(_a: AlgoRecord, _m: unknown, stops: StopRequest[]): Promise<ChildResult[]> {
    this.stops.push(stops);
    return stops.map((s) => ({ clOrdID: s.clOrdID, ok: true, orderId: '2', error: null, outcomeUnknown: false }));
  }
}

async function rig(position = { size: 0, entry: 0 }) {
  const market = new FakeMarket();
  const sink = new FakeSink(market);
  const store = new MemoryAlgoStore();
  const sodex = { markets: async () => [BTC, ETH], follower: async () => ({ equity: 1e6, positions: { 'BTC-USD': position } }), get: async () => [] } as unknown as SodexClient;
  const rt = new AlgoRuntime({ store, sodex, network: 'mainnet', market, sinkFor: () => sink, log: silentLogger, autoTick: false, policyFor: () => null, account: async () => ({ equity: 1e6, gross: 0 }), lookup: async () => [] });
  await rt.start();
  market.set('BTC-USD', 60_000, 60_010);
  market.set('ETH-USD', 3_000, 3_000.1);
  const add = (spec: AlgoSpec, seed = 7) => rt.add({ owner: '0x2222222222222222222222222222222222222222', accountId: 42, mode: 'browser', spec, seed });
  const step = async (id: string, ms = 0) => {
    clock += ms;
    await rt.stepNow(id, clock);
    await settle();
    return rt.get(id)!;
  };
  return { rt, market, sink, add, step };
}

/* ------------------------------------------------ every kind, every side ----- */

test('every kind, untouched, buy and sell: the engine accepts the spec and the plan has no errors', () => {
  for (const side of ['buy', 'sell'] as const) {
    const p = side === 'buy' ? buy : sell;
    for (const { id } of ALGO_MENU) {
      const s = specOf(id, untouched(id, side), { ...p, quantity: '0.05' });
      const plan = planAlgo(s, BTC, { now: NOW, price: 60_005, seed: 1, positionSize: 0.1, prices: (x) => (x === 'ETH-USD' ? 3_000 : 60_005) });
      // A basket of $100 legs over 30 slices is under the minimum by design (the plan says so); everything else plans clean.
      if (id !== 'basket') assert.deepEqual(plan.errors, [], `${side} ${id}: ${plan.errors.join(' | ')}`);
    }
  }
});

test('reduce-only on every kind that opens nothing: exits are never sent, and the spec is accepted (bracket: refused, it needs exits)', () => {
  for (const { id } of ALGO_MENU) {
    const d = { ...untouched(id), exitsOn: true };
    const raw = draftToSpec(id, d, { ...buy, reduceOnly: true }, NOW);
    assert.equal(raw.exits, null, id);
    const c = checkAlgoSpec(raw);
    if (id === 'bracket') assert.ok(c.errors.exits, 'a reduce-only bracket is refused');
    else assert.deepEqual(c.errors, {}, `${id}: ${JSON.stringify(c.errors)}`);
  }
});

test('exits on every kind that offers them: the spec carries them and the plan prices them on the right side (buy and sell)', () => {
  for (const side of ['buy', 'sell'] as const) {
    for (const id of ['twap', 'chasetwap', 'vwap', 'pov', 'iceberg', 'chase', 'scale', 'dca', 'swarm', 'sweep', 'bracket'] as UiKind[]) {
      const s = specOf(id, { ...untouched(id, side), exitsOn: true }, { ...(side === 'buy' ? buy : sell), quantity: '0.05' });
      assert.deepEqual(s.exits, { tpPct: 0.02, slPct: 0.01, tpPrice: null, slPrice: null }, `${side} ${id}`);
      const plan = planAlgo(s, BTC, { now: NOW, price: 60_005, seed: 1 });
      const { tp, sl } = plan.exits!;
      const ref = plan.avgPrice ?? (s.kind === 'bracket' && s.entry === 'limit' ? s.price! : 60_005);
      const near = (x: number, y: number) => Math.abs(x - y) < 1e-6 * y;
      assert.ok(near(tp!, ref * (side === 'buy' ? 1.02 : 0.98)) && near(sl!, ref * (side === 'buy' ? 0.99 : 1.01)), `${side} ${id}: tp ${tp} sl ${sl} ref ${ref}`);
    }
  }
});

test('extremes that the engine accepts: 1-minute and 30-day TWAP, 2000 slices, 2..100-level scale, a 1000x leverage refused', () => {
  assert.deepEqual(errorsOf('twap', { ...DEFAULT, dur: '1', durUnit: 'm' }, buy), {});
  assert.deepEqual(errorsOf('twap', { ...DEFAULT, dur: '30', durUnit: 'd' }, buy), {});
  const long = specOf('twap', { ...DEFAULT, dur: '30', durUnit: 'd' }, buy) as Extract<AlgoSpec, { kind: 'twap' }>;
  assert.equal(long.slices, 2000);
  assert.deepEqual(errorsOf('twap', { ...DEFAULT, dur: '59', durUnit: 's' }, buy).durationMs !== undefined, true, 'under a minute is refused');
  assert.deepEqual(errorsOf('scale', { ...untouched('scale'), orders: '2' }, buy), {});
  assert.deepEqual(errorsOf('scale', { ...untouched('scale'), orders: '100' }, { ...buy, quantity: '1' }), {});
  assert.ok(errorsOf('scale', { ...untouched('scale'), orders: '101' }, buy).orders);
  assert.ok(errorsOf('twap', DEFAULT, { ...buy, leverage: 1000 }).leverage);
});

test('a TWAP close: reduce-only, sized from the position, no leverage change, no exits even when switched on', () => {
  const s = specOf('twap', { ...DEFAULT, twapClose: true, twapCloseShare: '50', exitsOn: true }, buy) as Extract<AlgoSpec, { kind: 'twap' }>;
  assert.equal(s.reduceOnly, true);
  assert.equal(s.closeShare, 0.5);
  assert.equal(s.exits, null);
  const plan = planAlgo(s, BTC, { now: NOW, price: 60_005, seed: 1, positionSize: -0.02 });
  assert.equal(plan.total, 0.01);
});

/* ------------------------------------------------------------ the bugs ----- */

test('BUG draft: a DCA\'s own settings (step, size x, step scale, prices mode) survive a save and a reload', () => {
  const st = memStore();
  saveDraft({ ...DEFAULT, dcaStep: '5', dcaSizing: 'geometric', dcaMult: '2', dcaStepScale: '1.5', dcaLevels: 'list' }, st);
  const d = loadDraft(st);
  // A draft saved by today's ticket has no dcaMode at all: the migration for old schedule DCAs must not touch it.
  assert.deepEqual(
    { dcaStep: d.dcaStep, dcaSizing: d.dcaSizing, dcaMult: d.dcaMult, dcaStepScale: d.dcaStepScale, dcaLevels: d.dcaLevels },
    { dcaStep: '5', dcaSizing: 'geometric', dcaMult: '2', dcaStepScale: '1.5', dcaLevels: 'list' },
  );
});

test('BUG draft: a geometric DCA of 11 buys at 2x each (or 12 at 0.5x) is accepted - its sizes are explicit, the scale skew limit does not apply', () => {
  // The ladder is sent as explicit prices and weights; `skew` (mult^(n-1) = 1024) is only a description for old executors.
  const big = draftToSpec('dca', { ...DEFAULT, dcaSizing: 'geometric', dcaMult: '2', dcaOrders: '11', dcaStep: '1', perOrder: '20' }, buy, NOW);
  assert.deepEqual(checkAlgoSpec(big).errors, {});
  const small = draftToSpec('dca', { ...DEFAULT, dcaSizing: 'geometric', dcaMult: '0.5', dcaOrders: '12', dcaStep: '1', perOrder: '100000' }, buy, NOW);
  assert.deepEqual(checkAlgoSpec(small).errors, {});
});

test('BUG draft: a limit price set on another kind is not sent with a kind whose ticket hides it (scale, trailing, sweep, basket)', () => {
  // The draft is one form for every kind: the limit typed on a TWAP stays in it when the trader switches kind.
  const d: Draft = { ...DEFAULT, limitPrice: '59000' };
  const leaks: string[] = [];
  for (const { id } of ALGO_MENU) {
    if (hasLimit(id)) continue;
    const raw = draftToSpec(id, { ...untouched(id), limitPrice: d.limitPrice }, buy, NOW);
    if (raw.limitPrice !== null) leaks.push(`${id}: limitPrice ${String(raw.limitPrice)}`);
  }
  assert.deepEqual(leaks, []);
});

test('BUG draft: bounds and the spread guard set on another kind are not sent with a kind whose ticket hides them', () => {
  const leaks: string[] = [];
  for (const { id } of ALGO_MENU) {
    if (hasBounds(id)) continue;
    const raw = draftToSpec(id, { ...untouched(id), upper: '70000', upperThen: 'stop', lower: '50000', lowerThen: 'hold', maxSpread: '1' }, buy, NOW);
    for (const k of ['upper', 'lower', 'maxSpreadBps'] as const) if (raw[k] !== null) leaks.push(`${id}.${k}`);
  }
  assert.deepEqual(leaks, []);
});

test('BUG runtime (from the draft): a trailing stop fires and sells when the price falls through it, even with a lower bound left in the draft by a TWAP', async () => {
  const r = await rig({ size: 0.01, entry: 60_000 });
  // A sell trailing stop of 1% for a long; the draft still holds "Below 59500: hold" from an earlier TWAP (not shown on a trailing stop's ticket).
  const s = specOf('trailing', { ...DEFAULT, trail: '1', lower: '59500', lowerThen: 'hold' }, { ...sell, quantity: '0.01' });
  const a = await r.add(s);
  await r.step(a.id);
  r.market.set('BTC-USD', 59_300, 59_310);
  await r.step(a.id, 1_000);
  await r.step(a.id, 1_000);
  assert.equal(r.sink.all.filter((o) => o.side === 'sell').length >= 1, true, `the stop never sold: ${r.rt.get(a.id)!.statusReason}`);
});

test('BUG runtime (from the draft): a trailing stop is not held by a spread guard left in the draft', async () => {
  const r = await rig({ size: 0.01, entry: 60_000 });
  const s = specOf('trailing', { ...DEFAULT, trail: '1', maxSpread: '1' }, { ...sell, quantity: '0.01' });
  const a = await r.add(s);
  await r.step(a.id);
  // The price falls through the stop with a 5 bp spread (a fast market).
  r.market.set('BTC-USD', 59_300, 59_330);
  await r.step(a.id, 1_000);
  await r.step(a.id, 1_000);
  assert.equal(r.sink.all.length >= 1, true, `the stop never sold: ${r.rt.get(a.id)!.statusReason}`);
});

test('BUG draft: Chase TWAP does not carry the TWAP\'s urgency (its ticket has no urgency setting)', () => {
  const s = specOf('chasetwap', { ...DEFAULT, urgency: 1 }, buy) as Extract<AlgoSpec, { kind: 'twap' }>;
  assert.equal(s.urgency, 0);
});

test('BUG draft: a TWAP/VWAP/POV\'s resting slices do not carry the chase/iceberg offset (their ticket shows none)', () => {
  // An offset of 10 ticks typed on a chase stays in the draft; Chase TWAP's pop-up has no offset field.
  for (const id of ['chasetwap', 'twap', 'vwap', 'pov'] as UiKind[]) {
    const s = specOf(id, { ...DEFAULT, exec: id === 'chasetwap' ? 'taker' : 'hybrid', offsetTicks: '10' }, buy) as Extract<AlgoSpec, { kind: 'twap' | 'vwap' | 'pov' }>;
    assert.equal(s.exec.offsetTicks, 0, id);
  }
});

test('a start delay, an end time, an expiry and a time condition typed with decimals are accepted (2.01 min, 0.07 h): the float dust vanishes at epoch-ms magnitude', () => {
  assert.deepEqual(errorsOf('twap', { ...DEFAULT, startMode: 'delay', startDelay: '2.01' }, buy), {}, 'start in 2.01 min');
  assert.deepEqual(errorsOf('pov', { ...DEFAULT, endIn: '0.07', endUnit: 'h' }, buy), {}, 'POV stop after 0.07 h');
  assert.deepEqual(errorsOf('conditional', { ...untouched('conditional'), expires: '0.07', expiresUnit: 'h' }, buy), {}, 'expires in 0.07 h');
  assert.deepEqual(errorsOf('conditional', { ...DEFAULT, conds: [cond('BTC-USD', { type: 'time', inMin: '2.01' })] }, buy), {}, 'time condition in 2.01 min');
});

test('BUG spec: a bracket\'s limit entry past the trader\'s limit price is refused (it would buy above "never buys above")', async () => {
  const raw = draftToSpec('bracket', { ...DEFAULT, entry: 'limit', entryPrice: '60500', limitPrice: '60000' }, buy, NOW);
  const c = checkAlgoSpec(raw);
  if (c.spec) {
    // Accepted: show what it does.
    const r = await rig();
    const a = await r.add(c.spec);
    await r.step(a.id);
    const past = r.sink.all.filter((o) => Number(o.price) > 60_000);
    assert.equal(past.length, 0, `entry placed at ${past[0]?.price}, past the limit of 60000`);
  }
});

test('BUG spec: a conditional\'s limit order past the trader\'s limit price is refused (it would buy above "never buys above")', async () => {
  const raw = draftToSpec('conditional', { ...DEFAULT, conds: [cond('BTC-USD', { type: 'price', op: 'below', value: '61000' })], then: 'limit', thenPrice: '60500', postOnly: false, limitPrice: '60000' }, buy, NOW);
  const c = checkAlgoSpec(raw);
  if (c.spec) {
    const r = await rig();
    const a = await r.add(c.spec);
    await r.step(a.id);
    await r.step(a.id, 1_000);
    const past = r.sink.all.filter((o) => Number(o.price) > 60_000);
    assert.equal(past.length, 0, `limit placed at ${past[0]?.price}, past the limit of 60000`);
  }
});

test('BUG draft: a Fill fast set to the six major venues keeps them after a reload (not every venue)', () => {
  const six = ['binanceFutures', 'binanceSpot', 'bitget', 'hyperliquid', 'okx', 'bybit'] as const;
  const st = memStore();
  saveDraft({ ...DEFAULT, sweepVenues: [...six] }, st);
  const d = loadDraft(st);
  assert.ok(ORACLE_VENUES.length > 6);
  assert.deepEqual([...d.sweepVenues].sort(), [...six].sort());
});

/* --------------------------------------------- plan and runtime agree ----- */

test('DCA from the ticket (buy, post-only, at market): the runtime places the plan\'s levels at the plan\'s prices and sizes', async () => {
  const s = specOf('dca', { ...DEFAULT, dcaOrders: '5', dcaStep: '1', dcaSizing: 'geometric', dcaMult: '1.5', perOrder: '100' }, buy) as Extract<AlgoSpec, { kind: 'scale' }>;
  const plan = planAlgo(s, BTC, { now: NOW, price: 60_005, seed: 7 });
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.children[0]!.price, 60_000, 'the first buy joins the bid');
  const r = await rig();
  const a = await r.add(s, 7);
  await r.step(a.id);
  assert.deepEqual(
    r.sink.all.map((o) => [Number(o.price), Number(o.quantity), o.tif]),
    plan.children.map((c) => [c.price, Number(c.qty.toFixed(5)), 'gtx']),
  );
});

test('DCA from the ticket (sell, in the coin, not post-only): the first sells at the bid (it takes), levels go up from it, every order the same coin size', async () => {
  const s = specOf('dca', { ...DEFAULT, postOnly: false, dcaUnit: 'coin', perOrder: '0.001', dcaOrders: '4', dcaStep: '2' }, sell) as Extract<AlgoSpec, { kind: 'scale' }>;
  const lad = scaleLadder(s, BTC, 1);
  assert.deepEqual(lad.map((l) => l.price), [60_000, 61_200, 62_400, 63_600]);
  assert.deepEqual(lad.map((l) => l.qty), [0.001, 0.001, 0.001, 0.001]);
  const r = await rig();
  const a = await r.add(s, 1);
  await r.step(a.id);
  assert.deepEqual(r.sink.all.map((o) => [o.side, o.price, o.quantity, o.tif]), lad.map((l) => ['sell', String(l.price), String(l.qty), 'gtc']));
});

test('TWAP sell from the ticket: what the runtime sends adds up to the plan\'s total, never more', async () => {
  const s = specOf('twap', { ...DEFAULT, dur: '5', durUnit: 'm' }, { ...sell, quantity: '0.01' });
  const plan = planAlgo(s, BTC, { now: NOW, price: 60_005, seed: 3 });
  assert.equal(plan.children.length, 5);
  const r = await rig();
  const a = await r.add(s, 3);
  let x = await r.step(a.id);
  for (let i = 0; i < 12 && x.status !== 'done'; i++) x = await r.step(a.id, 30_000);
  assert.equal(x.status, 'done');
  const sent = r.sink.all.reduce((t, o) => t + Number(o.quantity), 0);
  assert.ok(Math.abs(sent - 0.01) < 1e-12, `sent ${sent}`);
  assert.ok(r.sink.all.every((o) => o.side === 'sell' && Number(o.price) <= 60_000));
});

test('swarm from the ticket: the clips the plan shows are the ones the runtime sends (same seed)', async () => {
  const s = specOf('swarm', { ...DEFAULT, clips: '4', inFlight: 4 }, { ...buy, quantity: '0.004' });
  const plan = planAlgo(s, BTC, { now: NOW, price: 60_005, seed: 11 });
  const r = await rig();
  const a = await r.add(s, 11);
  await r.step(a.id);
  assert.deepEqual(r.sink.all.map((o) => Number(o.quantity)), plan.children.map((c) => Number(c.qty.toFixed(5))));
});

test('a conditional from the ticket that starts a TWAP with exits: the TWAP it starts carries them, the conditional none', async () => {
  const s = specOf('conditional', { ...DEFAULT, conds: [cond('BTC-USD', { type: 'price', op: 'below', value: '61000' })], then: 'twap', thenMin: '2', thenSlices: '2', exitsOn: true }, { ...buy, quantity: '0.01' });
  assert.equal(s.exits, null);
  const r = await rig();
  const a = await r.add(s);
  await r.step(a.id);
  const child = r.rt.list().find((x) => x.parentId === a.id)!;
  assert.ok(child, 'the TWAP started');
  assert.deepEqual(child.spec.exits, { tpPct: 0.02, slPct: 0.01, tpPrice: null, slPrice: null });
  await r.step(child.id);
  await r.step(child.id, 500);
  await r.step(child.id, 500);
  const stops = r.sink.stops.flat();
  assert.equal(stops.length, 2, 'exits follow the first slice');
  assert.equal(stops[0]!.quantity, '0.005');
});

test('a bracket from the ticket (sell, market entry): exits go on the buy side at the plan\'s distances from the fill', async () => {
  const s = specOf('bracket', { ...DEFAULT }, { ...sell, quantity: '0.01' });
  const r = await rig();
  const a = await r.add(s);
  await r.step(a.id);
  await r.step(a.id, 500);
  await r.step(a.id, 500);
  const stops = r.sink.stops.flat();
  assert.equal(stops.length, 2);
  const tp = stops.find((x) => x.kind === 'tp')!;
  const sl = stops.find((x) => x.kind === 'sl')!;
  assert.equal(tp.side, 'buy');
  assert.equal(Number(tp.triggerPrice), Math.round(60_000 * 0.98));
  assert.equal(Number(sl.triggerPrice), Math.round(60_000 * 1.01));
});

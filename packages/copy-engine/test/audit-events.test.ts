/**
 * Audit: the event-driven and taker kinds (conditional, trailing, bracket,
 * basket, swarm, sweep) and the exits machinery. Every test states the
 * intended behaviour; a failing test is a bug.
 * Run: npx tsx --test test/audit-events.test.ts
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  AlgoRuntime,
  MemoryAlgoStore,
  checkAlgoSpec,
  regionPolicy,
  silentLogger,
  type AlgoMarket,
  type AlgoRecord,
  type AlgoSink,
  type ChildRequest,
  type ChildResult,
  type MarketInfo,
  type MarkInfo,
  type OrderUpdate,
  type Print,
  type PriceSource,
  type Quote,
  type RegionPolicy,
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
  stopMode: 'ok' | 'unknown' | 'reject' = 'ok';
  autoFill = true;
  /** Share of an IOC that fills (the rest is cancelled). */
  iocShare = 1;
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
          if (this.autoFill && reaches) {
            const step = 0.00001;
            const f = Math.floor((Number(o.quantity) * this.iocShare) / step + 1e-9) * step;
            this.m.order({ clOrdID: o.clOrdID, symbol: mk.name, status: f >= Number(o.quantity) - 1e-12 ? 'FILLED' : 'CANCELED', filledQty: f, filledValue: f * touch, maker: false });
          } else this.m.order({ clOrdID: o.clOrdID, symbol: mk.name, status: 'CANCELED' });
        } else {
          this.resting.set(o.clOrdID, { ...o, filled: 0 });
          this.m.order({ clOrdID: o.clOrdID, symbol: mk.name, status: 'NEW' });
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
    if (this.stopMode !== 'ok') return stops.map((s) => ({ clOrdID: s.clOrdID, ok: false, orderId: null, error: this.stopMode === 'reject' ? 'stop refused' : 'timeout', outcomeUnknown: this.stopMode === 'unknown' }));
    for (const s of stops) setImmediate(() => this.m.order({ clOrdID: s.clOrdID, status: 'NEW' }));
    return stops.map((s) => ({ clOrdID: s.clOrdID, ok: true, orderId: '2', error: null, outcomeUnknown: false }));
  }
  fireStop(id: string, qty: number, price: number): void {
    this.m.order({ clOrdID: id, status: 'FILLED', filledQty: qty, filledValue: qty * price, maker: false });
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
  policy: { fn: ((a: AlgoRecord) => RegionPolicy | null) | null };
  lookupRows: Array<{ clOrdID: string; orderId: string; status: string; executedQty: number; executedValue: number }>;
  markets: MarketInfo[];
}

function runtimeFor(r: Rig, market: FakeMarket, sink: FakeSink): AlgoRuntime {
  const sodex = {
    markets: async () => r.markets,
    follower: async () => ({ equity: 1_000, positions: { 'BTC-USD': { size: r.position.size, entry: r.position.entry } } }),
    get: async () => [],
  } as unknown as SodexClient;
  return new AlgoRuntime({
    store: r.store,
    sodex,
    network: 'mainnet',
    market,
    sinkFor: () => sink,
    log: silentLogger,
    autoTick: false,
    policyFor: (a) => (r.policy.fn ? r.policy.fn(a) : null),
    account: async () => ({ equity: 1_000_000, gross: 0 }),
    lookup: async (_a, _s, history) => (history ? r.lookupRows : r.lookupRows.filter((x) => x.status === 'NEW' || x.status === 'PARTIALLY_FILLED')),
  });
}

async function rig(markets: MarketInfo[] = [BTC, ETH]): Promise<Rig> {
  const market = new FakeMarket();
  const sink = new FakeSink(market);
  const store = new MemoryAlgoStore();
  const r: Rig = { rt: null as unknown as AlgoRuntime, market, sink, store, position: { size: 0, entry: 0 }, policy: { fn: null }, lookupRows: [], markets };
  r.rt = runtimeFor(r, market, sink);
  await r.rt.start();
  market.set('BTC-USD', 60_000, 60_010);
  market.set('ETH-USD', 2_999, 3_001, 3_000);
  return r;
}

async function step(r: Rig, id: string, advanceMs = 0, rt = r.rt): Promise<AlgoRecord> {
  clock += advanceMs;
  await rt.stepNow(id, clock);
  await settle();
  return rt.get(id)!;
}

const add = (r: Rig, spec: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  r.rt.add({ owner: FOLLOWER, accountId: ACCOUNT, mode: 'browser', spec: { symbol: 'BTC-USD', side: 'buy', ...spec }, seed: 1, ...extra });

const near = (x: number, y: number) => Math.abs(x - y) < 1e-9;

/* =========================================================== CONFIRMED BUGS ===== */

test('BUG conditional: a PAPER conditional must start its child algo as paper too (never a live algo)', async () => {
  const r = await rig();
  const a = await add(r, {
    kind: 'conditional',
    paper: true,
    conditions: [{ type: 'price', symbol: 'BTC-USD', source: 'mark', op: 'above', value: 1 }],
    then: { type: 'algo', algo: { kind: 'twap', symbol: 'BTC-USD', side: 'buy', quantity: '0.002', durationMs: 120_000, slices: 2, exec: { style: 'taker' } } },
  });
  await step(r, a.id);
  const child = r.rt.list(FOLLOWER).find((c) => c.parentId === a.id)!;
  assert.ok(child, 'the child started');
  await step(r, child.id);
  assert.equal(child.spec.paper, true, 'the practice run started a LIVE algo');
  assert.equal(r.sink.all.length, 0, 'a practice run sent a real order to SoDEX');
});

test('BUG conditional: the algo it starts keeps the parent\'s declared and observed country (region rules)', async () => {
  const r = await rig();
  r.policy.fn = (x) => regionPolicy(x.country ?? null, x.observedCountry ?? null);
  const a = await add(
    r,
    {
      kind: 'conditional',
      conditions: [{ type: 'price', symbol: 'BTC-USD', source: 'mark', op: 'above', value: 1 }],
      then: { type: 'algo', algo: { kind: 'twap', symbol: 'BTC-USD', side: 'buy', quantity: '0.002', durationMs: 120_000, slices: 2, exec: { style: 'taker' } } },
    },
    { country: 'SG', observedCountry: 'SG' },
  );
  await step(r, a.id);
  assert.equal(r.rt.get(a.id)!.status, 'done');
  const child = r.rt.list(FOLLOWER).find((c) => c.parentId === a.id)!;
  assert.equal(child.country, 'SG');
  const x = await step(r, child.id);
  assert.notEqual(x.statusReason ?? '', 'Held: Choose your country of residence to copy trades.');
  assert.equal(r.sink.all.length, 1, 'the child is held forever by the region rules');
});

test('BUG conditional limit: the owner\'s order updates are still followed after it ends, so the kept limit\'s fills reach its exits', async () => {
  const r = await rig();
  const a = await add(r, {
    kind: 'conditional',
    conditions: [{ type: 'price', symbol: 'BTC-USD', source: 'mark', op: 'above', value: 1 }],
    then: { type: 'limit', quantity: '0.002', price: 59_900, postOnly: false },
    exits: { slPct: 0.02 },
  });
  const x = await step(r, a.id);
  assert.equal(x.status, 'done');
  assert.equal(r.sink.resting.size, 1, 'the limit rests on SoDEX');
  assert.ok(r.market.watched.owners.includes(FOLLOWER), 'the wallet is no longer followed: the limit\'s fills will never be seen and its exits never placed');
});

test('BUG conditional limit: after a restart, a fill of the kept limit still places its exits', async () => {
  const r = await rig();
  const a = await add(r, {
    kind: 'conditional',
    conditions: [{ type: 'price', symbol: 'BTC-USD', source: 'mark', op: 'above', value: 1 }],
    then: { type: 'limit', quantity: '0.002', price: 59_900, postOnly: false },
    exits: { slPct: 0.02 },
  });
  await step(r, a.id);
  const lim = r.sink.all[0]!;
  await r.rt.stop();
  const m2 = new FakeMarket();
  m2.set('BTC-USD', 60_000, 60_010);
  const s2 = new FakeSink(m2);
  const rt2 = runtimeFor(r, m2, s2);
  await rt2.start();
  m2.order({ clOrdID: lim.clOrdID, status: 'FILLED', filledQty: 0.002, filledValue: 0.002 * 59_900, maker: true });
  await settle();
  assert.ok(near(rt2.get(a.id)!.filled, 0.002), 'the fill of the kept limit is not booked after a restart');
  assert.equal(s2.stops.length, 1, 'no stop-loss was placed for the filled limit');
});

test('BUG conditional limit: a limit SoDEX refuses does not end the conditional as done ("placed")', async () => {
  const r = await rig();
  r.sink.mode = 'reject';
  const a = await add(r, {
    kind: 'conditional',
    conditions: [{ type: 'price', symbol: 'BTC-USD', source: 'mark', op: 'above', value: 1 }],
    then: { type: 'limit', quantity: '0.002', price: 59_900, postOnly: false },
  });
  const x = await step(r, a.id);
  assert.equal(r.sink.all.length, 1);
  assert.notEqual(x.status, 'done', `refused, yet: ${x.statusReason}`);
});

test('BUG basket: a leg that cannot start does not leave the legs before it running, nor start them twice', async () => {
  const r = await rig([BTC, { ...ETH, status: 'HALT' }]);
  const a = await add(r, { kind: 'basket', legs: [{ symbol: 'BTC-USD', side: 'buy', usd: 120 }, { symbol: 'ETH-USD', side: 'buy', usd: 60 }], style: 'twap', durationMs: 600_000, slices: 2, slippageBps: 20 });
  for (let i = 0; i < 3; i++) {
    clock += 500;
    r.rt.tick(clock);
    await settle();
  }
  const legs = r.rt.list(FOLLOWER).filter((c) => c.parentId === a.id);
  const btc = legs.filter((c) => c.spec.symbol === 'BTC-USD');
  assert.ok(btc.length <= 1, `the BTC leg was started ${btc.length} times`);
  const parent = r.rt.get(a.id)!;
  if (!['failed', 'expired', 'cancelled'].includes(parent.status)) assert.fail(`the basket is still ${parent.status} with its BTC leg running and ETH never started`);
  assert.ok(btc.every((c) => c.status !== 'running' && c.status !== 'scheduled'), 'the BTC leg runs on alone');
});

test('BUG basket: a bound that stops the basket stops its legs too', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'basket', upper: { price: 61_000, then: 'stop' }, legs: [{ symbol: 'BTC-USD', side: 'buy', usd: 120 }, { symbol: 'ETH-USD', side: 'buy', usd: 60 }], style: 'twap', durationMs: 600_000, slices: 2, slippageBps: 20 });
  await step(r, a.id);
  const legs = r.rt.list(FOLLOWER).filter((c) => c.parentId === a.id);
  assert.equal(legs.length, 2);
  r.market.set('BTC-USD', 61_500, 61_510);
  const x = await step(r, a.id, 1_000);
  assert.ok(['expired', 'done'].includes(x.status));
  for (const c of legs) assert.ok(['cancelled', 'expired', 'done'].includes(r.rt.get(c.id)!.status), `leg ${c.spec.symbol} is still ${r.rt.get(c.id)!.status} after the basket stopped`);
});

test('BUG swarm: clips under SoDEX\'s minimum are refused at the start with the fix - never merged, never dropped', async () => {
  const r = await rig();
  // $240 in 200 clips: $1.20 each, under the $10 minimum order.
  await assert.rejects(add(r, { kind: 'swarm', quantity: '0.004', clips: 200, inFlight: 20, waveMs: 0, slippageBps: 20, retries: 0 }), /Each of the 200 clips would be about \$1\.2\d, under SoDEX's \$10 minimum\. Use at most \d+ clips, or raise the size to \$[\d,]+\./);
  assert.equal(r.sink.all.length, 0);
  // At most what it names: it starts and fills the size.
  const a = await add(r, { kind: 'swarm', quantity: '0.004', clips: 20, inFlight: 20, waveMs: 0, slippageBps: 20, retries: 0 });
  let x = await step(r, a.id);
  for (let i = 0; i < 20 && x.status !== 'done' && x.status !== 'expired'; i++) x = await step(r, a.id, 500);
  assert.ok(near(x.filled, 0.004));
});

test('BUG sweep: never sends a child past the algo\'s limit price', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'sweep', quantity: '0.002', reference: 'mark', slippageBps: 50, limitPrice: 60_020 });
  await step(r, a.id);
  assert.equal(r.sink.all.length, 1);
  assert.ok(Number(r.sink.all[0]!.price) <= 60_020, `a buy limited to 60020 was sent at ${r.sink.all[0]!.price}`);
});

test('BUG exits: a refused exit is not sent again on every tick', async () => {
  const r = await rig();
  r.sink.stopMode = 'reject';
  const a = await add(r, { kind: 'twap', quantity: '0.004', durationMs: 240_000, slices: 4, exec: { style: 'taker' }, exits: { slPct: 0.05 } });
  await step(r, a.id);
  for (let i = 0; i < 10; i++) await step(r, a.id, 500);
  assert.ok(r.sink.stops.length <= 3, `${r.sink.stops.length} stop placements in 5 s`);
});

test('BUG exits: an exit whose placement got no answer is reconciled, so the exits still follow the fill', async () => {
  const r = await rig();
  r.sink.stopMode = 'unknown';
  const a = await add(r, { kind: 'twap', quantity: '0.004', durationMs: 120_000, slices: 2, exec: { style: 'taker' }, exits: { slPct: 0.05 } });
  await step(r, a.id);
  await step(r, a.id, 500);
  assert.equal(r.sink.stops.length, 1);
  const first = r.sink.stops[0]![0]!;
  // SoDEX did take it: it is in the open orders.
  r.lookupRows = [{ clOrdID: first.clOrdID, orderId: '7', status: 'NEW', executedQty: 0, executedValue: 0 }];
  r.sink.stopMode = 'ok';
  let x = await step(r, a.id, 60_000);
  for (let i = 0; i < 8; i++) x = await step(r, a.id, 30_000);
  assert.equal(x.status, 'done');
  assert.equal(r.sink.stops.at(-1)![0]!.quantity, '0.004', 'the stop-loss still covers only 0.002 of 0.004 filled');
});

test('BUG restart: a child sent just before a crash is not forgotten and sent again (conditional market)', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'conditional', conditions: [{ type: 'price', symbol: 'BTC-USD', source: 'mark', op: 'above', value: 1 }], then: { type: 'market', quantity: '0.002', slippageBps: 20 } });
  await step(r, a.id);
  assert.equal(r.sink.all.length, 1);
  // The process dies here (no stop, no flush); a new runner starts on the same store.
  const rt2 = runtimeFor(r, r.market, r.sink);
  await rt2.start();
  await step(r, a.id, 500, rt2);
  await step(r, a.id, 500, rt2);
  assert.equal(r.sink.all.length, 1, 'the trigger fired again after the restart: bought twice');
});

test('BUG bracket: a short\'s take-profit distance of 100% or more is refused, not silently dropped', async () => {
  const r = await rig();
  let a: AlgoRecord;
  try {
    a = await add(r, { kind: 'bracket', side: 'sell', quantity: '0.002', entry: 'market', slippageBps: 20, exits: { tpPct: 1.5 } });
  } catch {
    return; // refused: correct
  }
  await step(r, a.id);
  await step(r, a.id, 500);
  assert.ok(r.sink.stops.flat().some((s) => s.kind === 'tp'), 'a bracket accepted with only a take-profit has no exit at all');
});

test('BUG trailing: exits on a trailing stop are refused (they would be silently ignored)', () => {
  const whole = checkAlgoSpec({ kind: 'trailing', symbol: 'BTC-USD', side: 'sell', trailPct: 0.01, exits: { slPct: 0.02 } });
  assert.equal(whole.spec, null, 'a trailing stop on the whole position accepted exits it never places');
  const sized = checkAlgoSpec({ kind: 'trailing', symbol: 'BTC-USD', side: 'buy', quantity: '0.01', trailPct: 0.01, exits: { slPct: 0.02 } });
  assert.equal(sized.spec, null, 'a sized trailing stop accepted exits it never places');
});

/* ========================================================= REGRESSION (pass) ===== */

test('trailing sell: the stop only ratchets up with the high, never down; fires at the stop, reduce-only', async () => {
  const r = await rig();
  r.position.size = 0.01;
  const a = await add(r, { kind: 'trailing', side: 'sell', trailPct: 0.01 });
  await step(r, a.id);
  r.market.set('BTC-USD', 60_990, 61_010, 61_000);
  await step(r, a.id, 1_000);
  assert.equal(r.rt.view(a.id)!.triggerPrice, 60_390);
  r.market.set('BTC-USD', 60_490, 60_510, 60_500);
  await step(r, a.id, 1_000);
  assert.equal(r.rt.view(a.id)!.triggerPrice, 60_390, 'the stop does not follow the price down');
  assert.equal(r.sink.all.length, 0);
  r.market.set('BTC-USD', 60_380, 60_400, 60_390);
  await step(r, a.id, 1_000);
  assert.equal(r.sink.all.length, 1);
  assert.deepEqual([r.sink.all[0]!.side, r.sink.all[0]!.quantity, r.sink.all[0]!.reduceOnly], ['sell', '0.01', true]);
});

test('trailing buy (short): trails the low by a USD distance and buys back reduce-only when it turns up', async () => {
  const r = await rig();
  r.position.size = -0.01;
  const a = await add(r, { kind: 'trailing', side: 'buy', trailAbs: 100 });
  await step(r, a.id);
  assert.equal(r.rt.view(a.id)!.triggerPrice, 60_105);
  r.market.set('BTC-USD', 59_490, 59_510, 59_500);
  await step(r, a.id, 1_000);
  assert.equal(r.rt.view(a.id)!.triggerPrice, 59_600);
  r.market.set('BTC-USD', 59_540, 59_560, 59_550);
  await step(r, a.id, 1_000);
  assert.equal(r.rt.view(a.id)!.triggerPrice, 59_600, 'it does not move up');
  assert.equal(r.sink.all.length, 0);
  r.market.set('BTC-USD', 59_600, 59_620, 59_610);
  await step(r, a.id, 1_000);
  assert.deepEqual([r.sink.all[0]!.side, r.sink.all[0]!.quantity, r.sink.all[0]!.reduceOnly], ['buy', '0.01', true]);
});

test('trailing activation: not armed below it (no fire on the way down), armed at it without firing', async () => {
  const r = await rig();
  r.position.size = 0.01;
  const a = await add(r, { kind: 'trailing', side: 'sell', trailPct: 0.01, activationPrice: 61_000 });
  await step(r, a.id);
  assert.equal(r.rt.view(a.id)!.triggerPrice, null);
  r.market.set('BTC-USD', 58_990, 59_010, 59_000);
  await step(r, a.id, 1_000);
  assert.equal(r.sink.all.length, 0, 'not armed: a fall does not fire it');
  r.market.set('BTC-USD', 60_990, 61_010, 61_000);
  await step(r, a.id, 1_000);
  assert.equal(r.sink.all.length, 0, 'armed, not fired');
  assert.equal(r.rt.view(a.id)!.triggerPrice, 60_390);
  r.market.set('BTC-USD', 60_290, 60_310, 60_300);
  await step(r, a.id, 1_000);
  assert.equal(r.sink.all.length, 1);
});

test('trailing spec: exactly one of trailPct / trailAbs', () => {
  assert.equal(checkAlgoSpec({ kind: 'trailing', symbol: 'BTC-USD', side: 'sell', trailPct: 0.01, trailAbs: 50 }).spec, null);
  assert.equal(checkAlgoSpec({ kind: 'trailing', symbol: 'BTC-USD', side: 'sell' }).spec, null);
  assert.equal(checkAlgoSpec({ kind: 'trailing', symbol: 'BTC-USD', side: 'sell', trailAbs: -5 }).spec, null);
  assert.equal(checkAlgoSpec({ kind: 'trailing', symbol: 'BTC-USD', side: 'sell', trailPct: Number.NaN }).spec, null);
  assert.ok(checkAlgoSpec({ kind: 'trailing', symbol: 'BTC-USD', side: 'sell', trailAbs: 50 }).spec);
});

test('trailing whole position: no position on the side it protects -> expired, nothing sent', async () => {
  const r = await rig();
  r.position.size = -0.01;
  const a = await add(r, { kind: 'trailing', side: 'sell', trailAbs: 10 });
  await step(r, a.id);
  r.market.set('BTC-USD', 59_000, 59_010);
  const x = await step(r, a.id, 1_000);
  assert.equal(x.status, 'expired');
  assert.equal(r.sink.all.length, 0);
});

test('trailing chase exit: rests post-only first, takes after chaseMs', async () => {
  const r = await rig();
  r.position.size = 0.01;
  const a = await add(r, { kind: 'trailing', side: 'sell', trailAbs: 10, exit: 'chase', chaseMs: 2_000 });
  await step(r, a.id);
  r.market.set('BTC-USD', 59_000, 59_010);
  await step(r, a.id, 1_000);
  assert.equal(r.sink.all[0]!.tif, 'gtx');
  assert.equal(r.sink.all[0]!.reduceOnly, true);
  await step(r, a.id, 2_100);
  await step(r, a.id, 500);
  const ioc = r.sink.all.find((o) => o.tif === 'ioc');
  assert.ok(ioc, 'took after the chase time');
  assert.equal(ioc!.reduceOnly, true);
  const x = await step(r, a.id, 500);
  assert.equal(x.status, 'done');
});

test('trailing restart: the trail (high and stop) survives a restart', async () => {
  const r = await rig();
  r.position.size = 0.01;
  const a = await add(r, { kind: 'trailing', side: 'sell', trailPct: 0.01 });
  await step(r, a.id);
  r.market.set('BTC-USD', 60_990, 61_010, 61_000);
  await step(r, a.id, 1_000);
  await r.rt.stop();
  const rt2 = runtimeFor(r, r.market, r.sink);
  await rt2.start();
  r.market.set('BTC-USD', 60_490, 60_510, 60_500);
  await step(r, a.id, 1_000, rt2);
  assert.equal(rt2.view(a.id)!.triggerPrice, 60_390);
});

test('conditional all vs any', async () => {
  const r = await rig();
  const conds = [
    { type: 'price', symbol: 'BTC-USD', source: 'mark', op: 'above', value: 1 },
    { type: 'price', symbol: 'BTC-USD', source: 'mark', op: 'above', value: 70_000 },
  ];
  const all = await add(r, { kind: 'conditional', match: 'all', conditions: conds, then: { type: 'market', quantity: '0.001', slippageBps: 20 } });
  await step(r, all.id);
  await step(r, all.id, 1_000);
  assert.equal(r.sink.all.length, 0, 'all: one of two is not enough');
  const any = await add(r, { kind: 'conditional', match: 'any', conditions: conds, then: { type: 'market', quantity: '0.001', slippageBps: 20 } });
  await step(r, any.id);
  assert.equal(r.sink.all.length, 1);
});

test('conditional: expires at its expiry, never fires after it', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'conditional', expiresAt: clock + 5_000, conditions: [{ type: 'price', symbol: 'BTC-USD', source: 'mark', op: 'below', value: 50_000 }], then: { type: 'market', quantity: '0.001', slippageBps: 20 } });
  await step(r, a.id);
  let x = await step(r, a.id, 6_000);
  assert.equal(x.status, 'expired');
  r.market.set('BTC-USD', 49_000, 49_010);
  x = await step(r, a.id, 1_000);
  assert.equal(r.sink.all.length, 0);
});

test('conditional: fires exactly once (holdMs reached; nothing more after done)', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'conditional', holdMs: 1_000, conditions: [{ type: 'price', symbol: 'BTC-USD', source: 'mark', op: 'above', value: 1 }], then: { type: 'market', quantity: '0.001', slippageBps: 20 } });
  await step(r, a.id);
  assert.equal(r.sink.all.length, 0, 'not before the hold time');
  await step(r, a.id, 1_000);
  assert.equal(r.sink.all.length, 1);
  let x = await step(r, a.id, 500);
  assert.equal(x.status, 'done');
  for (let i = 0; i < 4; i++) x = await step(r, a.id, 1_000);
  assert.equal(r.sink.all.length, 1);
});

test('conditional cross down: never fires while it has only been below; fires after being above, then reaching it', async () => {
  const r = await rig();
  r.market.set('BTC-USD', 59_000, 59_010);
  const a = await add(r, { kind: 'conditional', conditions: [{ type: 'cross', symbol: 'BTC-USD', source: 'mark', dir: 'down', value: 59_500 }], then: { type: 'market', quantity: '0.001', slippageBps: 20 } });
  await step(r, a.id);
  await step(r, a.id, 1_000);
  assert.equal(r.sink.all.length, 0, 'below from the start is not a cross');
  r.market.set('BTC-USD', 60_000, 60_010);
  await step(r, a.id, 1_000);
  assert.equal(r.sink.all.length, 0);
  r.market.set('BTC-USD', 59_400, 59_410);
  await step(r, a.id, 1_000);
  assert.equal(r.sink.all.length, 1);
  assert.equal(r.sink.all[0]!.side, 'buy');
});

test('conditional on another market: an ETH condition, a BTC action', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'conditional', side: 'sell', conditions: [{ type: 'price', symbol: 'ETH-USD', source: 'mark', op: 'below', value: 2_900 }], then: { type: 'market', quantity: '0.001', slippageBps: 20 } });
  await step(r, a.id);
  assert.equal(r.sink.all.length, 0);
  r.market.set('ETH-USD', 2_800, 2_802, 2_801);
  await step(r, a.id, 1_000);
  assert.equal(r.sink.all.length, 1);
  assert.equal(r.sink.all[0]!.side, 'sell');
  assert.ok(Number(r.sink.all[0]!.price) <= 60_000, 'a sell IOC priced under the bid');
});

test('conditional ratio and move', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'conditional', conditions: [{ type: 'ratio', symbol: 'ETH-USD', other: 'BTC-USD', op: 'below', value: 0.04 }], then: { type: 'market', quantity: '0.001', slippageBps: 20 } });
  await step(r, a.id);
  assert.equal(r.sink.all.length, 0, '3000/60005 = 0.05');
  r.market.set('ETH-USD', 2_000, 2_002, 2_001);
  await step(r, a.id, 1_000);
  assert.equal(r.sink.all.length, 1);
  const b = await add(r, { kind: 'conditional', conditions: [{ type: 'move', symbol: 'BTC-USD', source: 'mark', dir: 'down', pct: 0.01, windowMs: 10_000 }], then: { type: 'market', quantity: '0.001', slippageBps: 20 } });
  r.market.set('BTC-USD', 60_000, 60_010);
  await step(r, b.id);
  assert.equal(r.sink.all.length, 1, 'no move yet');
  clock += 11_000;
  r.market.set('BTC-USD', 59_000, 59_010);
  await step(r, b.id);
  assert.equal(r.sink.all.length, 2, '59005 / 60005 - 1 = -1.67%');
});

test('bracket short: exits on the buy side, take-profit below and stop-loss above the average', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'bracket', side: 'sell', quantity: '0.002', entry: 'market', slippageBps: 20, exits: { tpPct: 0.02, slPct: 0.01 } });
  await step(r, a.id);
  const x = await step(r, a.id, 500);
  assert.equal(x.status, 'done');
  const [tp, sl] = r.sink.stops[0]!;
  assert.deepEqual([tp!.kind, tp!.side, tp!.quantity, tp!.triggerPrice], ['tp', 'buy', '0.002', '58800']);
  assert.deepEqual([sl!.kind, sl!.side, sl!.quantity, sl!.triggerPrice], ['sl', 'buy', '0.002', '60600']);
});

test('bracket limit: a partial fill then cancel leaves exits for what filled only', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'bracket', quantity: '0.002', entry: 'limit', price: 59_990, exits: { slPct: 0.01 } });
  await step(r, a.id);
  const entry = r.sink.all[0]!;
  assert.deepEqual([entry.tif, entry.price], ['gtc', '59990']);
  r.sink.fill(entry.clOrdID, 0.001);
  await settle();
  await step(r, a.id, 500);
  assert.equal(r.sink.stops.at(-1)![0]!.quantity, '0.001');
  await r.rt.cancel(a.id);
  await settle();
  const x = r.rt.get(a.id)!;
  assert.equal(x.status, 'cancelled');
  assert.ok(r.sink.cancelled.includes(entry.clOrdID));
  assert.equal(r.sink.stops.at(-1)![0]!.quantity, '0.001');
  assert.equal(x.exitOrders!.filter((e) => e.state === 'open').length, 1, 'the exit stays for what filled');
});

test('exits OCO: the stop-loss filling cancels the take-profit; nothing is re-placed after', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'bracket', quantity: '0.002', entry: 'market', slippageBps: 20, exits: { tpPct: 0.02, slPct: 0.01 } });
  await step(r, a.id);
  await step(r, a.id, 500);
  const [tp, sl] = r.sink.stops[0]!;
  await settle();
  r.sink.fireStop(sl!.clOrdID, 0.002, 59_410);
  await settle();
  assert.deepEqual(r.sink.cancelled, [tp!.clOrdID]);
  assert.equal(r.sink.stops.length, 1);
});

test('basket: pause and resume the parent pauses and resumes every leg', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'basket', legs: [{ symbol: 'BTC-USD', side: 'buy', usd: 120 }, { symbol: 'ETH-USD', side: 'sell', usd: 60 }], style: 'twap', durationMs: 600_000, slices: 2, slippageBps: 20 });
  await step(r, a.id);
  const legs = r.rt.list(FOLLOWER).filter((c) => c.parentId === a.id);
  await r.rt.pause(a.id);
  assert.ok(legs.every((c) => r.rt.get(c.id)!.status === 'paused'));
  await r.rt.resume(a.id);
  assert.ok(legs.every((c) => r.rt.get(c.id)!.status !== 'paused'));
  await r.rt.cancel(a.id);
  assert.ok(legs.every((c) => r.rt.get(c.id)!.status === 'cancelled'));
});

test('basket: a leg that ends short makes the basket end expired (not hang)', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'basket', legs: [{ symbol: 'BTC-USD', side: 'buy', usd: 120 }, { symbol: 'ETH-USD', side: 'buy', usd: 60 }], style: 'swarm', clips: 2, inFlight: 2, waveMs: 0, slippageBps: 20 });
  await step(r, a.id);
  const legs = r.rt.list(FOLLOWER).filter((c) => c.parentId === a.id);
  await r.rt.cancel(legs[1]!.id);
  for (const c of legs) {
    await step(r, c.id);
    await step(r, c.id, 500);
  }
  const x = await step(r, a.id, 500);
  assert.equal(x.status, 'expired');
});

test('swarm: retries are bounded and it never sends more than what is left', async () => {
  const r = await rig();
  r.sink.autoFill = false;
  const a = await add(r, { kind: 'swarm', quantity: '0.004', clips: 2, inFlight: 2, waveMs: 0, slippageBps: 20, retries: 2 });
  let x = await step(r, a.id);
  for (let i = 0; i < 10 && x.status !== 'expired'; i++) x = await step(r, a.id, 500);
  assert.equal(x.status, 'expired');
  assert.equal(r.sink.placed.length, 3, 'one wave and two retries');
  for (const w of r.sink.placed) assert.ok(w.reduce((s, o) => s + Number(o.quantity), 0) <= 0.004 + 1e-12);
});

test('swarm sell: IOC clips under the bid within the slippage', async () => {
  const r = await rig();
  r.sink.iocShare = 0.5;
  const a = await add(r, { kind: 'swarm', side: 'sell', quantity: '0.004', clips: 2, inFlight: 2, waveMs: 0, slippageBps: 20, retries: 3 });
  let x = await step(r, a.id);
  for (let i = 0; i < 10 && !['done', 'expired'].includes(x.status); i++) x = await step(r, a.id, 500);
  for (const o of r.sink.all) {
    assert.equal(o.side, 'sell');
    assert.ok(Number(o.price) <= 60_000 && Number(o.price) >= 60_000 * (1 - 0.002) - 1);
  }
  assert.ok(x.filled <= 0.004 + 1e-12, 'never over the size');
});

test('sweep: rounds never take it past its size (partial fills)', async () => {
  const r = await rig();
  r.sink.iocShare = 0.5;
  const a = await add(r, { kind: 'sweep', quantity: '0.004', reference: 'mark', slippageBps: 20, roundMs: 500 });
  let x = await step(r, a.id);
  for (let i = 0; i < 20 && !['done', 'expired'].includes(x.status); i++) {
    clock += 500;
    r.market.set('BTC-USD', 60_000, 60_010);
    x = await step(r, a.id);
  }
  assert.ok(x.filled <= 0.004 + 1e-12);
  assert.ok(r.sink.all.reduce((s, o) => s + Number(o.quantity), 0) <= 0.004 * 2 + 1e-12);
  assert.equal(x.status, 'done');
});

test('sweep sell: priced at the band edge rounded up (ref x (1 - slip))', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'sweep', side: 'sell', quantity: '0.002', reference: 'mark', slippageBps: 10 });
  await step(r, a.id);
  assert.deepEqual([r.sink.all[0]!.side, r.sink.all[0]!.price, r.sink.all[0]!.tif], ['sell', '59945', 'ioc']);
});

test('sweep: pauses with a stale reference and never prices off it; gives up at its timeout', async () => {
  const r = await rig();
  r.sink.autoFill = false;
  const a = await add(r, { kind: 'sweep', quantity: '0.002', reference: 'mark', slippageBps: 10, roundMs: 500, timeoutMs: 10_000 });
  await step(r, a.id);
  assert.equal(r.sink.all.length, 1);
  let x = await step(r, a.id, 6_000);
  assert.equal(x.status, 'waiting');
  assert.match(x.statusReason!, /no fresh reference/);
  assert.equal(r.sink.all.length, 1);
  x = await step(r, a.id, 5_000);
  assert.equal(x.status, 'expired');
  assert.equal(r.sink.all.length, 1);
});

test('conditional close: share of a long, sell side reduce-only; restart before firing keeps the cross armed', async () => {
  const r = await rig();
  r.position.size = 0.004;
  const a = await add(r, { kind: 'conditional', conditions: [{ type: 'cross', symbol: 'BTC-USD', source: 'mark', dir: 'up', value: 60_500 }], then: { type: 'close', share: 0.5, slippageBps: 20 } });
  await step(r, a.id);
  await r.rt.stop();
  const rt2 = runtimeFor(r, r.market, r.sink);
  await rt2.start();
  r.market.set('BTC-USD', 60_600, 60_610);
  await step(r, a.id, 1_000, rt2);
  assert.deepEqual([r.sink.all[0]!.side, r.sink.all[0]!.quantity, r.sink.all[0]!.reduceOnly], ['sell', '0.002', true]);
});

/* ============================================ ENDED ALGOS: WHAT THEY LEFT ON SODEX ===== */

test('cancel on an ended bracket pulls its live exits on SoDEX; it stays done and nothing is placed again', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'bracket', quantity: '0.002', entry: 'market', slippageBps: 20, exits: { tpPct: 0.02, slPct: 0.01 } });
  await step(r, a.id);
  let x = await step(r, a.id, 500);
  assert.equal(x.status, 'done');
  const [tp, sl] = r.sink.stops[0]!;
  await r.rt.cancel(a.id);
  await settle();
  assert.ok(r.sink.cancelled.includes(tp!.clOrdID) && r.sink.cancelled.includes(sl!.clOrdID), 'both exits are cancelled on SoDEX');
  for (let i = 0; i < 3; i++) {
    clock += 60_000;
    r.rt.tick(clock);
    await settle();
  }
  x = r.rt.get(a.id)!;
  assert.equal(x.status, 'done', 'its final status stays');
  assert.equal(r.sink.stops.length, 1, 'the exits are not placed again');
  assert.equal((x.exitOrders ?? []).filter((e) => e.state === 'open').length, 0);
});

test('cancelAll includes ended algos with live exits or a kept resting child (the kill switch leaves nothing behind)', async () => {
  const r = await rig();
  const b = await add(r, { kind: 'bracket', quantity: '0.002', entry: 'market', slippageBps: 20, exits: { slPct: 0.01 } });
  await step(r, b.id);
  await step(r, b.id, 500);
  const c = await add(r, { kind: 'chase', quantity: '0.002', timeoutMs: 5_000, onEnd: 'rest' });
  await step(r, c.id);
  const left = r.sink.all.at(-1)!;
  assert.equal((await step(r, c.id, 5_000)).status, 'expired');
  assert.ok(r.sink.resting.has(left.clOrdID), 'left resting, as chosen');
  const out = await r.rt.cancelAll(FOLLOWER);
  await settle();
  assert.deepEqual(out.map((x) => x.id).sort(), [b.id, c.id].sort());
  assert.ok(r.sink.cancelled.includes(r.sink.stops[0]![0]!.clOrdID), 'the bracket\'s stop-loss is cancelled');
  assert.ok(r.sink.cancelled.includes(left.clOrdID), 'the chase left resting is cancelled');
  assert.equal(r.sink.resting.size, 0);
  assert.equal(r.rt.get(b.id)!.status, 'done');
  assert.equal(r.rt.get(c.id)!.status, 'expired');
});

test('cancel on an ended PAPER bracket drops its exits from the paper book: the mark through them fills nothing', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'bracket', quantity: '0.002', entry: 'market', slippageBps: 20, paper: true, exits: { tpPct: 0.02, slPct: 0.01 } });
  await step(r, a.id);
  let x = await step(r, a.id, 500);
  assert.equal(x.status, 'done');
  assert.equal((x.exitOrders ?? []).filter((e) => e.state === 'open').length, 2);
  const out = await r.rt.cancelAll(FOLLOWER);
  assert.equal(out.length, 1);
  await settle();
  r.market.set('BTC-USD', 58_000, 58_010);
  r.rt.tick(clock + 500);
  await settle();
  x = r.rt.get(a.id)!;
  assert.equal(x.status, 'done');
  assert.ok((x.exitOrders ?? []).every((e) => e.state === 'done' && e.filled === 0), 'no paper exit fired after it was cancelled');
  assert.equal(r.sink.placed.length + r.sink.stops.length, 0, 'a paper run sends nothing');
});

/**
 * Bots (algo/bots.ts, the 'mm' and 'grid' kinds and bot DCAs in runtime.ts): the pure arithmetic, the spec,
 * and the runtime against one fake SoDEX - post-only orders that would take are refused, resting ones fill
 * when told, reduce-only takers fill only up to the position. Edge cases: partial fills, SoDEX's minimum and
 * tick, refusals in a row (a 429 answer), a restart, the brake, a key that is no longer good, the kill switch.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  AlgoRuntime,
  MemoryAlgoStore,
  silentLogger,
  checkAlgoSpec,
  parseAlgoSpec,
  canonicalJSON,
  emptyBook,
  bookFill,
  bookNet,
  bookVolume,
  costPerMillion,
  sampleBook,
  BOT_SERIES_MAX,
  BOT_SAMPLE_MS,
  gridPrices,
  gridStart,
  gridAfterFill,
  mmQuotes,
  BOT_FEE,
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
  forget(): void {
    this.orderCbs = [];
  }
}

type Rest = ChildRequest & { filled: number };

class Exchange implements AlgoSink {
  readonly paper = false;
  placed: ChildRequest[] = [];
  cancelled: string[] = [];
  resting = new Map<string, Rest>();
  position = 0;
  /** Answer every placement with this refusal (a 429, a key SoDEX no longer takes). */
  refuse: string | null = null;
  constructor(private readonly m: FakeMarket) {}
  async place(_a: AlgoRecord, _mk: MarketInfo, orders: ChildRequest[]): Promise<ChildResult[]> {
    if (this.refuse) return orders.map((o) => ({ clOrdID: o.clOrdID, ok: false, orderId: null, error: this.refuse, outcomeUnknown: false }));
    this.placed.push(...orders);
    for (const o of orders) {
      const q = this.m.q;
      const touch = o.side === 'buy' ? q.ask : q.bid;
      const crosses = o.side === 'buy' ? Number(o.price) >= touch : Number(o.price) <= touch;
      if (o.tif === 'gtx' && crosses) {
        setImmediate(() => this.m.order({ clOrdID: o.clOrdID, status: 'REJECTED', reason: 'post only order would take' }));
      } else if (o.tif === 'ioc') {
        let qty = crosses ? Number(o.quantity) : 0;
        if (o.reduceOnly) qty = Math.min(qty, Math.max(0, o.side === 'sell' ? this.position : -this.position));
        this.position += (o.side === 'buy' ? 1 : -1) * qty;
        setImmediate(() => this.m.order({ clOrdID: o.clOrdID, status: qty >= Number(o.quantity) - 1e-12 ? 'FILLED' : 'CANCELED', filledQty: qty, filledValue: qty * touch, maker: false }));
      } else {
        this.resting.set(o.clOrdID, { ...o, filled: 0 });
        setImmediate(() => this.m.order({ clOrdID: o.clOrdID, status: 'NEW' }));
      }
    }
    return orders.map((o) => ({ clOrdID: o.clOrdID, ok: true, orderId: '1', error: null, outcomeUnknown: false }));
  }
  async cancel(_a: AlgoRecord, _m: MarketInfo, ids: string[]): Promise<void> {
    this.cancelled.push(...ids);
    for (const id of ids) {
      const r = this.resting.get(id);
      if (!r) continue;
      this.resting.delete(id);
      setImmediate(() => this.m.order({ clOrdID: id, status: 'CANCELED', filledQty: r.filled, filledValue: r.filled * Number(r.price) }));
    }
  }
  async setLeverage(): Promise<void> {}
  async placeStops(): Promise<ChildResult[]> {
    return [];
  }
  /** A resting order fills `qty` more (a maker fill). */
  fill(id: string, qty?: number): void {
    const r = this.resting.get(id)!;
    const q = qty ?? Number(r.quantity) - r.filled;
    r.filled += q;
    this.position += (r.side === 'buy' ? 1 : -1) * q;
    const done = r.filled >= Number(r.quantity) - 1e-12;
    if (done) this.resting.delete(id);
    this.m.order({ clOrdID: id, status: done ? 'FILLED' : 'PARTIALLY_FILLED', filledQty: r.filled, filledValue: r.filled * Number(r.price), maker: true });
  }
  /** What rests now, by side. */
  side(side: 'buy' | 'sell'): Rest[] {
    return [...this.resting.values()].filter((r) => r.side === side);
  }
}

interface Rig {
  rt: AlgoRuntime;
  market: FakeMarket;
  ex: Exchange;
  store: MemoryAlgoStore;
  brake: string | null;
  problem: string | null;
}

function runtimeFor(r: Rig): AlgoRuntime {
  const sodex = {
    markets: async () => [MKT],
    follower: async () => ({ equity: 1_000_000, positions: { 'BTC-USD': { size: r.ex.position, entry: 60_000, leverage: 1, leverageReported: true } } }),
    fills: async () => [],
    get: async () => [],
  } as unknown as SodexClient;
  return new AlgoRuntime({
    confirmGapMs: 0,
    store: r.store,
    sodex,
    network: 'mainnet',
    market: r.market,
    sinkFor: () => r.ex,
    log: silentLogger,
    autoTick: false,
    builderRate: (a) => (a.spec.bot ? BOT_FEE / 100_000 : 0.00025),
    brake: () => r.brake,
    problem: async () => r.problem,
    lookup: async (_a, _s, history) =>
      [...r.ex.resting.values()].filter(() => !history).map((x) => ({ clOrdID: x.clOrdID, orderId: '1', status: 'NEW', executedQty: x.filled, executedValue: x.filled * Number(x.price) })),
  });
}

async function rig(): Promise<Rig> {
  const market = new FakeMarket();
  const r: Rig = { rt: null as unknown as AlgoRuntime, market, ex: new Exchange(market), store: new MemoryAlgoStore(), brake: null, problem: null };
  r.rt = runtimeFor(r);
  await r.rt.start();
  market.set(60_000, 60_002);
  return r;
}

async function crashAndRestart(r: Rig): Promise<void> {
  r.market.forget();
  r.rt = runtimeFor(r);
  await r.rt.start();
}

async function step(r: Rig, id: string, advanceMs = 0): Promise<AlgoRecord> {
  clock += advanceMs;
  await r.rt.stepNow(id, clock);
  await settle();
  return r.rt.get(id)!;
}

const add = (r: Rig, spec: Record<string, unknown>) => r.rt.add({ owner: FOLLOWER, accountId: 42, mode: 'hosted', spec: { symbol: 'BTC-USD', ...spec }, seed: 7 });
const MM = { kind: 'mm', orderUsd: 60, maxInventoryUsd: 180, chaseTicks: 2, minRepriceMs: 3_000, skewTicks: 4 };

/* ------------------------------------------------------------------ the spec ----- */

test('spec: a volume maker parses with its defaults and is always a bot', () => {
  const s = parseAlgoSpec({ kind: 'mm', symbol: 'BTC-USD', orderUsd: 50, maxInventoryUsd: 200 });
  assert.equal(s.kind, 'mm');
  assert.equal(s.bot, true);
  if (s.kind !== 'mm') return;
  assert.deepEqual([s.offsetTicks, s.chaseTicks, s.minRepriceMs, s.skewTicks, s.onStop, s.volumeTargetUsd, s.maxLossUsd], [0, 2, 3_000, 3, 'close', null, null]);
});

test('spec: refusals name the field', () => {
  assert.ok(checkAlgoSpec({ kind: 'mm', symbol: 'BTC-USD', orderUsd: 100, maxInventoryUsd: 50 }).errors.maxInventoryUsd);
  assert.ok(checkAlgoSpec({ kind: 'mm', symbol: 'BTC-USD', orderUsd: 5, maxInventoryUsd: 50 }).errors.orderUsd);
  assert.ok(checkAlgoSpec({ kind: 'grid', symbol: 'BTC-USD', low: 60_000, high: 59_000, levels: 10, orderUsd: 20 }).errors.high);
  assert.ok(checkAlgoSpec({ kind: 'grid', symbol: 'BTC-USD', low: 50_000, high: 70_000, levels: 61, orderUsd: 20 }).errors.levels);
  assert.ok(checkAlgoSpec({ kind: 'twap', symbol: 'BTC-USD', side: 'buy', quantity: '1', durationMs: 600_000, slices: 10, bot: true }).errors.bot);
  assert.ok(checkAlgoSpec({ kind: 'mm', symbol: 'BTC-USD', orderUsd: 50, maxInventoryUsd: 200, exits: { slPct: 0.1 } }).errors.exits);
  assert.ok(checkAlgoSpec({ kind: 'mm', symbol: 'BTC-USD', orderUsd: 50, maxInventoryUsd: 200, minRepriceMs: 200 }).errors.minRepriceMs, 'no re-price storm: at least a second');
});

test('spec: a DCA may be a bot; a spec from before bots keeps its signed text', () => {
  const dca = parseAlgoSpec({ kind: 'dca', symbol: 'BTC-USD', side: 'buy', perOrderUsd: 20, orders: 10, intervalMs: 3_600_000, bot: true, exec: { style: 'maker' } });
  assert.equal(dca.bot, true);
  const twap = parseAlgoSpec({ kind: 'twap', symbol: 'BTC-USD', side: 'buy', quantity: '1', durationMs: 600_000, slices: 10 });
  assert.ok(!canonicalJSON(twap).includes('"bot"'));
});

/* ------------------------------------------------------------------ the math ----- */

test('grid: levels on the tick, distinct, both ends; the gap nearest the price; a fill moves it', () => {
  const p = gridPrices({ low: 59_000, high: 61_000, levels: 5, spacing: 'linear' }, '1');
  assert.deepEqual(p, [59_000, 59_500, 60_000, 60_500, 61_000]);
  const g = gridPrices({ low: 100, high: 100.0003, levels: 10, spacing: 'geometric' }, '0.0001');
  assert.ok(g.length < 10 && new Set(g).size === g.length, 'levels closer than a tick merge');
  const sides = gridStart(p, 60_120);
  assert.deepEqual(sides, ['buy', 'buy', null, 'sell', 'sell']);
  assert.deepEqual(gridAfterFill(sides, 1, 'buy'), ['buy', null, 'sell', 'sell', 'sell']);
  assert.deepEqual(gridAfterFill(sides, 3, 'sell'), ['buy', 'buy', 'buy', null, 'sell']);
  assert.deepEqual(gridAfterFill(['buy', null, 'sell'], 2, 'sell'), ['buy', 'buy', null]);
  assert.deepEqual(gridAfterFill([null, 'sell'], 1, 'sell'), ['buy', null]);
  assert.deepEqual(gridAfterFill(['buy', null], 0, 'buy'), [null, 'sell']);
});

test('volume maker quotes: flat at the touch; skewed while it holds; one side at the cap; never through the book', () => {
  const q = { bid: 60_000, ask: 60_002, at: 0 };
  const s = { orderUsd: 60, maxInventoryUsd: 180, offsetTicks: 0, skewTicks: 4 };
  const flat = mmQuotes(s, q, MKT, 0, 60_001);
  assert.deepEqual(flat.map((x) => [x.side, x.price]), [['buy', 60_000], ['sell', 60_002]]);
  assert.ok(flat.every((x) => x.quantity * x.price >= 10), 'at least SoDEX\'s minimum');
  // Long $120 of a $180 cap: the bid steps back round(4 x 2/3) = 3 ticks, the ask stays at the touch.
  const long = mmQuotes(s, q, MKT, 0.002, 60_000);
  assert.deepEqual(long.map((x) => [x.side, x.price]), [['buy', 59_997], ['sell', 60_002]]);
  // At the cap: no bid at all.
  assert.deepEqual(mmQuotes(s, q, MKT, 0.003, 60_000).map((x) => x.side), ['sell']);
  // Short past the cap: no ask.
  assert.deepEqual(mmQuotes(s, q, MKT, -0.003, 60_000).map((x) => x.side), ['buy']);
  // Holding less than an order: the unwinding side closes exactly that, or SoDEX's minimum.
  const dust = mmQuotes(s, q, MKT, 0.0004, 60_000).find((x) => x.side === 'sell')!;
  assert.equal(dust.quantity, 0.0004);
  // A one-tick spread and "one tick inside": nothing at or through the other side.
  const tight = mmQuotes({ ...s, offsetTicks: -1 }, { bid: 100, ask: 101, at: 0 }, MKT, 0, 100.5);
  assert.deepEqual(tight.map((x) => x.price), [100, 101]);
  const wide = mmQuotes({ ...s, offsetTicks: -1 }, { bid: 100, ask: 104, at: 0 }, MKT, 0, 102);
  assert.deepEqual(wide.map((x) => x.price), [101, 103]);
});

test('book: volume, net PnL at the mark, cost per $1M, the series thinned', () => {
  const b = emptyBook();
  bookFill(b, 'buy', 0.001, 60, true, 0.00012, 0.00005);
  bookFill(b, 'sell', 0.001, 60.06, true, 0.00012, 0.00005);
  assert.equal(bookVolume(b), 120.06);
  // Earned the 0.06 spread, paid 1.7 bp on 120.06.
  const net = bookNet(b, 60_000);
  assert.ok(Math.abs(net - (0.06 - 120.06 * 0.00017)) < 1e-9);
  assert.ok(Math.abs(costPerMillion(b, 60_000)! - (-net / 120.06) * 1e6) < 1e-6);
  for (let i = 0; i < BOT_SERIES_MAX + 10; i++) sampleBook(b, 60_000, T0 + i * BOT_SAMPLE_MS);
  assert.ok(b.series.length <= BOT_SERIES_MAX, 'thinned, never above the cap');
  assert.equal(b.series[b.series.length - 1]![0], T0 + (BOT_SERIES_MAX + 9) * BOT_SAMPLE_MS, 'the newest point kept');
  assert.equal(sampleBook(b, 60_000, b.series[b.series.length - 1]![0] + 1), false, 'one point per interval');
});

/* --------------------------------------------------------------- the runtime ----- */

test('volume maker: two post-only quotes at the touch; fills go into the book at the bot fee', async () => {
  const r = await rig();
  const a = await add(r, MM);
  await step(r, a.id);
  assert.equal(r.ex.placed.length, 2);
  assert.ok(r.ex.placed.every((o) => o.tif === 'gtx'));
  const bid = r.ex.side('buy')[0]!;
  assert.equal(Number(bid.price), 60_000);
  assert.equal(Number(r.ex.side('sell')[0]!.price), 60_002);
  r.ex.fill(bid.clOrdID);
  await settle();
  const v = r.rt.view(a.id)!;
  assert.ok(v.bot);
  assert.equal(v.bot!.fills, 1);
  assert.ok(Math.abs(v.bot!.volume - Number(bid.quantity) * 60_000) < 1e-6);
  assert.ok(Math.abs(v.bot!.builderFees - v.bot!.volume * 0.00005) < 1e-9, 'the bot fee, 0.5 bp');
  assert.ok(Math.abs(v.bot!.tradeFees - v.bot!.volume * 0.00012) < 1e-9, 'SoDEX\'s maker fee');
  assert.equal(v.bot!.makerShare, 1);
  // The filled side goes back out next step; the other one stays where it was.
  await step(r, a.id, 500);
  assert.equal(r.ex.side('buy').length, 1);
  assert.equal(r.ex.placed.filter((o) => o.side === 'sell').length, 1);
});

test('volume maker: re-prices only past the distance and the pause; partial fills count', async () => {
  const r = await rig();
  const a = await add(r, MM);
  await step(r, a.id);
  const bid = r.ex.side('buy')[0]!;
  r.ex.fill(bid.clOrdID, 0.0004);
  await settle();
  r.market.set(60_005, 60_007);
  await step(r, a.id, 1_000);
  assert.equal(r.ex.cancelled.length, 0, 'not before the re-price pause');
  await step(r, a.id, 2_500);
  assert.ok(r.ex.cancelled.includes(bid.clOrdID), 'moved 5 ticks away: re-priced');
  await step(r, a.id, 500);
  const fresh = r.ex.side('buy')[0]!;
  // Holding $24 of a $180 cap: one tick of skew behind the new best bid.
  assert.equal(Number(fresh.price), 60_004);
  assert.ok(Math.abs(r.rt.view(a.id)!.bot!.inventory - 0.0004) < 1e-12, 'the partial fill is held');
});

test('volume maker: the cap stops the adding side; the unwinding side keeps quoting', async () => {
  const r = await rig();
  const a = await add(r, MM);
  await step(r, a.id);
  // Fill the bids up to the cap: two orders of $60 hold $120; a third would take it past $180 at this mark.
  for (let i = 0; i < 3; i++) {
    const bid = r.ex.side('buy')[0];
    if (bid) r.ex.fill(bid.clOrdID);
    await settle();
    await step(r, a.id, 4_000);
  }
  const v = r.rt.view(a.id)!;
  assert.ok(v.bot!.inventoryUsd > 119);
  assert.equal(r.ex.side('buy').length, 0, 'no bid at the cap');
  assert.equal(r.ex.side('sell').length, 1, 'the ask keeps unwinding');
  assert.equal(r.rt.get(a.id)!.status, 'running');
});

test('volume maker: stop closes what it holds - resting first, then a capped taker - and ends cancelled', async () => {
  const r = await rig();
  const a = await add(r, MM);
  await step(r, a.id);
  r.ex.fill(r.ex.side('buy')[0]!.clOrdID);
  await settle();
  await r.rt.cancel(a.id);
  await settle();
  assert.equal(r.rt.get(a.id)!.status, 'running', 'closing first');
  assert.equal(r.ex.resting.size, 0, 'its quotes pulled');
  await step(r, a.id, 500);
  const close = [...r.ex.resting.values()];
  assert.equal(close.length, 1);
  assert.equal(close[0]!.side, 'sell');
  assert.equal(close[0]!.tif, 'gtx');
  assert.equal(close[0]!.reduceOnly, true);
  // A minute passes unfilled: it takes.
  await step(r, a.id, 61_000);
  await step(r, a.id, 500);
  const took = r.ex.placed.find((o) => o.tif === 'ioc');
  assert.ok(took && took.reduceOnly && took.side === 'sell');
  await step(r, a.id, 500);
  assert.equal(r.rt.get(a.id)!.status, 'cancelled');
  assert.ok(Math.abs(r.ex.position) < 1e-12);
});

test('volume maker: the kill switch never trades - it pulls and ends at once', async () => {
  const r = await rig();
  const a = await add(r, MM);
  await step(r, a.id);
  r.ex.fill(r.ex.side('buy')[0]!.clOrdID);
  await settle();
  const placed = r.ex.placed.length;
  await r.rt.cancelAll(FOLLOWER);
  await settle();
  assert.equal(r.rt.get(a.id)!.status, 'cancelled');
  assert.equal(r.ex.resting.size, 0);
  assert.equal(r.ex.placed.length, placed, 'no close sent');
});

test('volume maker: the volume target ends it done; the loss limit ends it', async () => {
  const r = await rig();
  const a = await add(r, { ...MM, volumeTargetUsd: 100, onStop: 'keep' });
  await step(r, a.id);
  r.ex.fill(r.ex.side('buy')[0]!.clOrdID);
  r.ex.fill(r.ex.side('sell')[0]!.clOrdID);
  await settle();
  await step(r, a.id, 500);
  assert.equal(r.rt.get(a.id)!.status, 'done');
  assert.equal(r.ex.resting.size, 0);

  const b = await add(r, { ...MM, maxLossUsd: 1, onStop: 'keep' });
  await step(r, b.id);
  r.ex.fill(r.ex.side('buy')[0]!.clOrdID);
  await settle();
  r.market.set(58_000, 58_002);
  await step(r, b.id, 500);
  assert.equal(r.rt.get(b.id)!.status, 'expired');
  assert.match(r.rt.get(b.id)!.statusReason ?? '', /loss limit/);
});

test('volume maker: the brake and a key problem hold it - nothing new is sent', async () => {
  const r = await rig();
  const a = await add(r, MM);
  r.brake = 'operator brake';
  await step(r, a.id);
  assert.equal(r.ex.placed.length, 0);
  assert.match(r.rt.get(a.id)!.statusReason ?? '', /operator brake/);
  r.brake = null;
  r.problem = 'Your copy key expired. Approve a new one in copy setup.';
  await step(r, a.id, 61_000);
  assert.equal(r.ex.placed.length, 0);
  assert.match(r.rt.get(a.id)!.statusReason ?? '', /expired/);
  r.problem = null;
  await step(r, a.id, 61_000);
  assert.equal(r.ex.placed.length, 2, 'goes on by itself once it clears');
});

test('volume maker: refusals (a 429) back off per side, 3 s doubling to a minute; it goes on when SoDEX takes orders again', async () => {
  const r = await rig();
  const a = await add(r, MM);
  r.ex.refuse = 'HTTP 429 Too Many Requests';
  for (let i = 0; i < 60; i++) await step(r, a.id, 500);
  const x = r.rt.get(a.id)!;
  assert.equal(x.status, 'running', `30 s of refusals: still going (${x.rejects} refused, backing off)`);
  assert.ok(x.rejects < 25, `backed off, not one a step: ${x.rejects}`);
  r.ex.refuse = null;
  for (let i = 0; i < 130; i++) await step(r, a.id, 500);
  assert.equal(r.ex.placed.length, 2, 'placed once SoDEX takes orders again');
});

test('volume maker: a restart keeps the book and what rests; nothing is placed twice', async () => {
  const r = await rig();
  const a = await add(r, MM);
  await step(r, a.id);
  r.ex.fill(r.ex.side('buy')[0]!.clOrdID, 0.0005);
  await settle();
  await step(r, a.id, 2_100);
  await crashAndRestart(r);
  const back = r.rt.get(a.id)!;
  assert.ok(back.book && Math.abs(back.book.buyQty - 0.0005) < 1e-12, 'the book came back from the store');
  const before = r.ex.placed.length;
  await step(r, a.id, 500);
  await step(r, a.id, 500);
  assert.equal(r.ex.placed.length, before, 'its resting quotes were found, not doubled');
});

test('grid: rests on every level but the gap; a buy filled puts a sell one level up; pause and resume', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'grid', low: 59_000, high: 61_000, levels: 5, orderUsd: 30, spacing: 'linear' });
  await step(r, a.id);
  const prices = (side: 'buy' | 'sell') => r.ex.side(side).map((x) => Number(x.price)).sort((x, y) => x - y);
  assert.deepEqual(prices('buy'), [59_000, 59_500]);
  assert.deepEqual(prices('sell'), [60_500, 61_000]);
  const at = r.ex.side('buy').find((x) => Number(x.price) === 59_500)!;
  r.market.set(59_499, 59_501);
  r.ex.fill(at.clOrdID);
  await settle();
  await step(r, a.id, 500);
  assert.deepEqual(prices('sell'), [60_000, 60_500, 61_000], 'a sell at the level above');
  await r.rt.pause(a.id);
  await settle();
  assert.equal(r.ex.resting.size, 0);
  await r.rt.resume(a.id);
  await step(r, a.id, 500);
  assert.deepEqual(prices('buy'), [59_000]);
  assert.deepEqual(prices('sell'), [60_000, 60_500, 61_000], 'back as they were');
});

test('grid: a level the price is through waits instead of being refused; sizes reach SoDEX\'s minimum', async () => {
  const r = await rig();
  await assert.rejects(add(r, { kind: 'grid', low: 59_000, high: 61_000, levels: 5, orderUsd: 10, spacing: 'linear' }), /under SoDEX's \$10 minimum/, 'no silent resizing: refused in words');
  const a = await add(r, { kind: 'grid', low: 59_000, high: 61_000, levels: 5, orderUsd: 11, spacing: 'linear' });
  r.market.set(60_600, 60_602);
  await step(r, a.id);
  // The gap is nearest 60,601: 60,500. Buys at 59,000 / 59,500 / 60,000 rest; the sell at 61,000 rests.
  assert.equal(r.ex.side('buy').length, 3);
  assert.ok(r.ex.placed.every((o) => Number(o.quantity) * Number(o.price) >= 10 - 1e-9), "every level at least SoDEX's minimum");
  assert.ok(r.ex.placed.every((o) => Number(o.price) % 1 === 0), 'on the tick');
});

test('grid: an update may change the size and limits, not the range', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'grid', low: 59_000, high: 61_000, levels: 5, orderUsd: 30, spacing: 'linear' });
  await step(r, a.id);
  await assert.rejects(r.rt.update(a.id, { low: 58_000 } as never), /range and levels/);
  await r.rt.update(a.id, { orderUsd: 40, maxLossUsd: 5 });
  await settle();
  assert.equal(r.ex.resting.size, 0, 'pulled for the new size');
  await step(r, a.id, 500);
  assert.ok([...r.ex.resting.values()].every((x) => Number(x.quantity) * Number(x.price) >= 39));
});

test('bots of different users never fill each other: a stopping bot\'s taker stops one tick short of another user\'s quote, or rests', async () => {
  const r = await rig();
  const OTHER = '0x3333333333333333333333333333333333333333';
  // Another user's maker: its bid rests at the touch (60,000).
  const b = await r.rt.add({ owner: OTHER, accountId: 7, mode: 'hosted', spec: { symbol: 'BTC-USD', ...MM }, seed: 9 });
  await step(r, b.id);
  const theirBid = r.ex.side('buy').find((x) => x.clOrdID.includes(b.id.slice(1, 13)))!;
  assert.equal(Number(theirBid.price), 60_000);
  // Ours fills a bid, then stops: after a minute of resting it would take - but the only bid is theirs.
  const a = await add(r, { ...MM, onStop: 'close' });
  await step(r, a.id);
  const ours = r.ex.side('buy').find((x) => x.clOrdID.includes(a.id.slice(1, 13)))!;
  r.ex.fill(ours.clOrdID);
  r.ex.position = 0.001;
  await settle();
  await r.rt.cancel(a.id);
  await settle();
  await step(r, a.id, 500);
  await step(r, a.id, 61_000);
  await step(r, a.id, 500);
  await step(r, a.id, 500);
  const sent = r.ex.placed.filter((o) => o.clOrdID.includes(a.id.slice(1, 13)) && o.reduceOnly);
  assert.ok(sent.length >= 1);
  assert.ok(sent.every((o) => o.tif === 'gtx' || Number(o.price) > 60_000), 'no taker priced into the other user\'s bid');
  assert.ok(r.ex.resting.has(theirBid.clOrdID), 'their bid untouched');
  assert.equal(r.rt.otherBotWall(r.rt.get(a.id)!, 'BTC-USD', 'sell'), 60_000);
  assert.equal(r.rt.otherBotWall(r.rt.get(b.id)!, 'BTC-USD', 'sell'), null, 'its own quotes are no wall for itself');
});

test('volume maker edge: quotes at least edgeBps from the mid - a round trip earns twice it', () => {
  const q = { bid: 60_000, ask: 60_002, at: 0 };
  const s = { orderUsd: 60, maxInventoryUsd: 180, offsetTicks: 0, skewTicks: 4, edgeBps: 2 };
  const [bid, ask] = mmQuotes(s, q, MKT, 0, 60_001);
  // 2 bp of 60,001 = 12: the bid at or under 59,989, the ask at or over 60,013.
  assert.ok(bid!.price <= 59_989 && bid!.price >= 59_988, String(bid!.price));
  assert.ok(ask!.price >= 60_013 && ask!.price <= 60_014, String(ask!.price));
  assert.equal(mmQuotes({ ...s, edgeBps: 0 }, q, MKT, 0, 60_001)[0]!.price, 60_000, 'no edge: the touch');
  const parsed = parseAlgoSpec({ kind: 'mm', symbol: 'BTC-USD', orderUsd: 50, maxInventoryUsd: 200 });
  assert.ok(!('edgeBps' in parsed), 'no edge: not in the signed text');
});

test('grid: a level SoDEX refuses waits (3 s, doubling) instead of being sent every step into the refusal limit', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'grid', low: 59_000, high: 61_000, levels: 5, orderUsd: 30, spacing: 'linear' });
  r.ex.refuse = 'insufficient margin';
  for (let i = 0; i < 40; i++) await step(r, a.id, 500);
  const x = r.rt.get(a.id)!;
  assert.notEqual(x.status, 'failed', `still running after 20 s of refusals (${x.rejects} refused)`);
  assert.ok(x.rejects < 25, `backed off: ${x.rejects} refusals in 20 s, not one a step`);
  r.ex.refuse = null;
  for (let i = 0; i < 140; i++) await step(r, a.id, 500);
  assert.equal(r.ex.resting.size, 4, 'every level back on the book once SoDEX takes them');
});

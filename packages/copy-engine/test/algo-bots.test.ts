/**
 * Bots (algo/bots.ts, the 'mm' and 'grid' kinds and bot DCAs in runtime.ts): the pure arithmetic, the spec,
 * and the runtime against one fake SoDEX - post-only orders that would take are refused, resting ones fill
 * when told, reduce-only takers fill only up to the position. Edge cases: partial fills, SoDEX's minimum and
 * tick, refusals in a row (a 429 answer), a restart, the brake, a key that is no longer good, the kill switch.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  copyReserveUsd,
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
  bookInventory,
  costPerMillion,
  sampleBook,
  BOT_SERIES_MAX,
  BOT_SAMPLE_MS,
  gridPrices,
  gridStart,
  gridAfterFill,
  mmQuotes,
  queueShare,
  pastFair,
  FairBasis,
  PATIENT_TAKER_ACCOUNT,
  quietWindowAt,
  quietWords,
  validZone,
  checkSizes,
  botReserveUsd,
  newsAt,
  nyseHolidays,
  lseHolidays,
  type NewsEvent,
  zoneTime,
  BOT_FEE,
  type ReferenceSource,
  type RefQuote,
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

const clockTick = (ms: number) => {
  clock += ms;
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
  set(bid: number, ask: number, sizes?: { bidSz: number; askSz: number }): void {
    this.q = { bid, ask, at: Date.now(), ...(sizes ?? {}) };
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
  /** The mid 2 s ago, for the move guard (null: no history). */
  ago: number | null = null;
  priceAgo(): number | null {
    return this.ago;
  }
  oiAgo(): number | null {
    return 1000;
  }
  volume() {
    return { qty: 0, usd: 0 };
  }
  printCbs: Array<(p: Print) => void> = [];
  onPrint(cb: (p: Print) => void): void {
    this.printCbs.push(cb);
  }
  /** A public print on BTC-USD: `taker` the account that took (the buyer when it bought). */
  print(taker: number, qty: number, price = this.mk, side: 'buy' | 'sell' = 'buy'): void {
    const p: Print = { symbol: 'BTC-USD', price, qty, buyer: side === 'buy' ? taker : 5, seller: side === 'buy' ? 5 : taker, taker: side, at: Date.now() };
    for (const cb of this.printCbs) cb(p);
  }
  onOrder(cb: (u: OrderUpdate) => void): void {
    this.orderCbs.push(cb);
  }
  onState(): void {}
  order(u: Partial<OrderUpdate> & { clOrdID: string }): void {
    for (const cb of this.orderCbs) cb({ orderId: '1', symbol: 'BTC-USD', status: 'NEW', filledQty: 0, filledValue: 0, maker: null, reason: null, at: Date.now(), ...u });
  }
  forget(): void {
    this.orderCbs = [];
    this.printCbs = [];
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
      // SoDEX judges reduce-only against the account's whole position: one that would grow it is refused.
      if (o.reduceOnly && (o.side === 'sell' ? this.position <= 1e-12 : this.position >= -1e-12)) {
        setImmediate(() => this.m.order({ clOrdID: o.clOrdID, status: 'REJECTED', reason: 'reduce only order would increase position' }));
      } else if (o.tif === 'gtx' && crosses) {
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

/** The Binance reference (the executor's shared feed): `tick` is a Binance quote arriving. */
class FakeRef implements ReferenceSource {
  q: RefQuote | null = null;
  watched: string[] = [];
  private cbs: Array<(m: string) => void> = [];
  watch(markets: readonly string[]): void {
    this.watched = [...markets];
  }
  quote(): RefQuote | null {
    return this.q;
  }
  onQuote(cb: (m: string) => void): void {
    this.cbs.push(cb);
  }
  tick(bid: number, ask: number): void {
    this.q = { bid, ask, at: Date.now() };
    for (const cb of this.cbs) cb('BTC-USD');
  }
}

interface Rig {
  ref?: FakeRef;
  rt: AlgoRuntime;
  market: FakeMarket;
  ex: Exchange;
  store: MemoryAlgoStore;
  brake: string | null;
  problem: string | null;
  events?: NewsEvent[] | null;
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
    ...(r.ref ? { reference: r.ref } : {}),
    brake: () => r.brake,
    problem: async () => r.problem,
    events: () => r.events ?? null,
    lookup: async (_a, _s, history) =>
      [...r.ex.resting.values()].filter(() => !history).map((x) => ({ clOrdID: x.clOrdID, orderId: '1', status: 'NEW', executedQty: x.filled, executedValue: x.filled * Number(x.price) })),
  });
}

async function rig(ref?: FakeRef): Promise<Rig> {
  const market = new FakeMarket();
  const r: Rig = { rt: null as unknown as AlgoRuntime, market, ex: new Exchange(market), store: new MemoryAlgoStore(), brake: null, problem: null, ...(ref ? { ref } : {}) };
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
const MM = { kind: 'mm', maxLossUsd: 1_000_000, orderUsd: 60, maxInventoryUsd: 180, chaseTicks: 2, minRepriceMs: 3_000, skewTicks: 4 };

/* ------------------------------------------------------------------ the spec ----- */

test('spec: a volume maker parses with its defaults and is always a bot', () => {
  const s = parseAlgoSpec({ kind: 'mm', maxLossUsd: 1_000_000, symbol: 'BTC-USD', orderUsd: 50, maxInventoryUsd: 200 });
  assert.equal(s.kind, 'mm');
  assert.equal(s.bot, true);
  if (s.kind !== 'mm') return;
  assert.deepEqual([s.offsetTicks, s.chaseTicks, s.minRepriceMs, s.skewTicks, s.onStop, s.volumeTargetUsd, s.maxLossUsd], [0, 2, 3_000, 3, 'close', null, 1_000_000]);
});

test('spec: refusals name the field', () => {
  assert.ok(checkAlgoSpec({ kind: 'mm', maxLossUsd: 1_000_000, symbol: 'BTC-USD', orderUsd: 100, maxInventoryUsd: 50 }).errors.maxInventoryUsd);
  assert.ok(checkAlgoSpec({ kind: 'mm', maxLossUsd: 1_000_000, symbol: 'BTC-USD', orderUsd: 5, maxInventoryUsd: 50 }).errors.orderUsd);
  assert.ok(checkAlgoSpec({ kind: 'grid', maxLossUsd: 1_000_000, symbol: 'BTC-USD', low: 60_000, high: 59_000, levels: 10, orderUsd: 20 }).errors.high);
  assert.ok(checkAlgoSpec({ kind: 'grid', maxLossUsd: 1_000_000, symbol: 'BTC-USD', low: 50_000, high: 70_000, levels: 61, orderUsd: 20 }).errors.levels);
  assert.ok(checkAlgoSpec({ kind: 'twap', symbol: 'BTC-USD', side: 'buy', quantity: '1', durationMs: 600_000, slices: 10, bot: true }).errors.bot);
  assert.ok(checkAlgoSpec({ kind: 'mm', maxLossUsd: 1_000_000, symbol: 'BTC-USD', orderUsd: 50, maxInventoryUsd: 200, exits: { slPct: 0.1 } }).errors.exits);
  assert.ok(checkAlgoSpec({ kind: 'mm', maxLossUsd: 1_000_000, symbol: 'BTC-USD', orderUsd: 50, maxInventoryUsd: 200, minRepriceMs: 200 }).errors.minRepriceMs, 'no re-price storm: at least a second');
});

test('spec: only the volume maker and the grid are bots (a DCA is an algo order); a spec from before bots keeps its signed text', () => {
  assert.ok(checkAlgoSpec({ kind: 'dca', symbol: 'BTC-USD', side: 'buy', perOrderUsd: 20, orders: 10, intervalMs: 3_600_000, bot: true, exec: { style: 'maker' } }).errors.bot);
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
  assert.ok(Math.abs(v.bot!.builderFees - v.bot!.volume * 0.00001) < 1e-9, 'the bot fee, 0.1 bp');
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
  assert.ok(!r.ex.cancelled.includes(bid.clOrdID), 'the bid, behind the touch: not before the re-price pause');
  assert.ok(r.ex.cancelled.includes(r.ex.placed.find((o) => o.side === 'sell')!.clOrdID), 'the ask, ahead of the new price: pulled at once');
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

test('volume maker: every hold that stops it re-pricing takes its quotes off, and it quotes again when the hold ends', async () => {
  const holds: Array<[string, (r: Rig, on: boolean) => void]> = [
    ['brake', (r, on) => { r.brake = on ? 'operator brake' : null; }],
    ['key problem', (r, on) => { r.problem = on ? 'Your copy key expired.' : null; }],
  ];
  for (const [name, set] of holds) {
    const r = await rig();
    const a = await add(r, { ...MM, onStop: 'keep' });
    await step(r, a.id);
    assert.equal(r.ex.resting.size, 2, name);
    set(r, true);
    await step(r, a.id, 61_000);
    assert.equal(r.ex.resting.size, 0, `${name}: nothing rests while held`);
    const placed = r.ex.placed.length;
    await step(r, a.id, 500);
    assert.equal(r.ex.placed.length, placed, `${name}: nothing new while held`);
    set(r, false);
    await step(r, a.id, 61_000);
    await step(r, a.id, 500);
    assert.equal(r.ex.resting.size, 2, `${name}: quotes again by itself`);
  }
});

test('grid: the brake takes its levels off; they go back when it lifts', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'grid', maxLossUsd: 1_000_000, low: 59_000, high: 61_000, levels: 5, orderUsd: 60, onStop: 'keep' });
  await step(r, a.id);
  const levels = r.ex.resting.size;
  assert.ok(levels > 0);
  r.brake = 'operator brake';
  await step(r, a.id, 500);
  assert.equal(r.ex.resting.size, 0);
  r.brake = null;
  await step(r, a.id, 500);
  await step(r, a.id, 500);
  assert.equal(r.ex.resting.size, levels);
});

test('volume maker: the brake leaves the order closing what it holds', async () => {
  const r = await rig();
  const a = await add(r, MM);
  await step(r, a.id);
  r.ex.fill(r.ex.side('buy')[0]!.clOrdID);
  await settle();
  await r.rt.cancel(a.id);
  await settle();
  await step(r, a.id, 500);
  const closing = [...r.ex.resting.keys()];
  assert.equal(closing.length, 1, 'its close rests');
  r.brake = 'operator brake';
  await step(r, a.id, 500);
  assert.deepEqual([...r.ex.resting.keys()], closing);
});

test('volume maker: a clean stop takes its quotes off and the next start quotes again; a kill under the brake pulls them on the first step', async () => {
  const r = await rig();
  const a = await add(r, { ...MM, onStop: 'keep' });
  await step(r, a.id);
  assert.equal(r.ex.resting.size, 2);
  await r.rt.stop();
  assert.equal(r.ex.resting.size, 0, 'SIGTERM: nothing rests unattended');
  await crashAndRestart(r);
  r.market.set(60_000, 60_002);
  await step(r, a.id, 61_000);
  await step(r, a.id, 500);
  assert.equal(r.ex.resting.size, 2, 'quoting again after the start');

  // SIGKILL: no stop ran, and the brake is on when it comes back (a release): the first step pulls them.
  await crashAndRestart(r);
  r.market.set(60_000, 60_002);
  r.brake = 'release';
  await step(r, a.id, 61_000);
  assert.equal(r.ex.resting.size, 0, 'a restart under the brake takes over and pulls');
});

test('volume maker: a clean stop does not wait for ever on a cancel that hangs', async () => {
  const r = await rig();
  const a = await add(r, MM);
  await step(r, a.id);
  r.ex.cancel = () => new Promise(() => {});
  const t0 = Date.now();
  await r.rt.stop();
  assert.ok(Date.now() - t0 < 6_000);
});

test('volume maker: refusals (a 429) back off per side, half a second doubling to a minute; it goes on when SoDEX takes orders again', async () => {
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
  const a = await add(r, { kind: 'grid', maxLossUsd: 1_000_000, low: 59_000, high: 61_000, levels: 5, orderUsd: 30, spacing: 'linear' });
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
  // Owner 2026-11-08: a bot thinks in USD; a level the step puts under SoDEX's minimum goes out at it, said in a note.
  const low = await add(r, { kind: 'grid', maxLossUsd: 1_000_000, low: 59_000, high: 61_000, levels: 5, orderUsd: 10, spacing: 'linear' });
  assert.ok(low.id);
  assert.ok(checkSizes(low.spec, MKT, { price: 60_000, seed: 1, now: clock }).notes.some((n) => n.includes("SoDEX's minimum")));
  await r.rt.cancel(low.id);
  const a = await add(r, { kind: 'grid', maxLossUsd: 1_000_000, low: 59_000, high: 61_000, levels: 5, orderUsd: 11, spacing: 'linear' });
  r.market.set(60_600, 60_602);
  await step(r, a.id);
  // The gap is nearest 60,601: 60,500. Buys at 59,000 / 59,500 / 60,000 rest; the sell at 61,000 rests.
  assert.equal(r.ex.side('buy').length, 3);
  assert.ok(r.ex.placed.every((o) => Number(o.quantity) * Number(o.price) >= 10 - 1e-9), "every level at least SoDEX's minimum");
  assert.ok(r.ex.placed.every((o) => Number(o.price) % 1 === 0), 'on the tick');
});

test('grid: an update may change the size and limits, not the range', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'grid', maxLossUsd: 1_000_000, low: 59_000, high: 61_000, levels: 5, orderUsd: 30, spacing: 'linear' });
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

test('bots at one price take turns: no user keeps the front of the queue for being added first', async () => {
  const firsts = new Map<number, number>();
  const RUNS = 60;
  for (let run = 0; run < RUNS; run++) {
    const r = await rig();
    const ids: string[] = [];
    for (let u = 0; u < 5; u++) {
      const b = await r.rt.add({ owner: `0x${String(u + 1).repeat(40)}`, accountId: 100 + u, mode: 'hosted', spec: { symbol: 'BTC-USD', ...MM }, seed: u + 1 });
      ids.push(b.id);
    }
    r.rt.tick(clock);
    await settle();
    assert.equal(new Set(r.ex.placed.map((o) => ids.findIndex((id) => o.clOrdID.includes(id.slice(1, 13))))).size, 5, 'every bot still sends');
    const first = ids.findIndex((id) => r.ex.placed[0]!.clOrdID.includes(id.slice(1, 13)));
    firsts.set(first, (firsts.get(first) ?? 0) + 1);
  }
  // Uniform is 12 each of 60; each user below 2 or above 28 has a chance far under 1 in 1,000.
  for (let u = 0; u < 5; u++) {
    const n = firsts.get(u) ?? 0;
    assert.ok(n >= 2 && n <= 28, `user ${u} was first ${n} times of ${RUNS}`);
  }
});

test('volume maker edge: quotes at least edgeBps from the mid - a round trip earns twice it', () => {
  const q = { bid: 60_000, ask: 60_002, at: 0 };
  const s = { orderUsd: 60, maxInventoryUsd: 180, offsetTicks: 0, skewTicks: 4, edgeBps: 2 };
  const [bid, ask] = mmQuotes(s, q, MKT, 0, 60_001);
  // 2 bp of 60,001 = 12: the bid at or under 59,989, the ask at or over 60,013.
  assert.ok(bid!.price <= 59_989 && bid!.price >= 59_988, String(bid!.price));
  assert.ok(ask!.price >= 60_013 && ask!.price <= 60_014, String(ask!.price));
  assert.equal(mmQuotes({ ...s, edgeBps: 0 }, q, MKT, 0, 60_001)[0]!.price, 60_000, 'no edge: the touch');
  const parsed = parseAlgoSpec({ kind: 'mm', maxLossUsd: 1_000_000, symbol: 'BTC-USD', orderUsd: 50, maxInventoryUsd: 200 });
  assert.ok(!('edgeBps' in parsed), 'no edge: not in the signed text');
});

test('volume maker queue guard: the adding side waits while its own queue is thin; the unwinding side never does', () => {
  const s = { orderUsd: 60, maxInventoryUsd: 180, offsetTicks: 0, skewTicks: 4, queueGuard: 0.3 };
  const q = (bidSz: number, askSz: number) => ({ bid: 60_000, ask: 60_002, at: 0, bidSz, askSz });
  assert.equal(queueShare(q(1, 3), 'buy'), 0.25);
  assert.equal(queueShare({ bid: 1, ask: 2, at: 0 }, 'buy'), null, 'no sizes: no guard');
  // Flat: both sides add. A bid queue of 20% is thin: no bid; the ask (80%) stays.
  assert.deepEqual(mmQuotes(s, q(0.2, 0.8), MKT, 0, 60_001).map((x) => x.side), ['sell']);
  assert.deepEqual(mmQuotes(s, q(0.5, 0.5), MKT, 0, 60_001).map((x) => x.side), ['buy', 'sell']);
  // A thin ask queue: flat, the ask adds and waits; long, the ask unwinds - quoted however thin its queue.
  assert.deepEqual(mmQuotes(s, q(0.9, 0.1), MKT, 0, 60_001).map((x) => x.side), ['buy']);
  assert.deepEqual(mmQuotes(s, q(0.9, 0.1), MKT, 0.001, 60_001).map((x) => x.side), ['buy', 'sell']);
  // Off (0 or absent), and a feed without sizes: both sides.
  assert.equal(mmQuotes({ ...s, queueGuard: 0 }, q(0.05, 0.95), MKT, 0, 60_001).length, 2);
  assert.equal(mmQuotes(s, { bid: 60_000, ask: 60_002, at: 0 }, MKT, 0, 60_001).length, 2);
  assert.equal(parseAlgoSpec({ ...MM, symbol: 'BTC-USD', queueGuard: 0.3 }).kind, 'mm');
  assert.ok(checkAlgoSpec({ ...MM, symbol: 'BTC-USD', queueGuard: 0.8 }).errors.queueGuard, 'at most half');
  assert.ok(!canonicalJSON(parseAlgoSpec({ ...MM, symbol: 'BTC-USD' })).includes('queueGuard'), 'off: not in the signed text');
});

test('volume maker queue guard: a thin queue pulls the resting bid; it comes back after the pause, not every flicker', async () => {
  const r = await rig();
  r.market.set(60_000, 60_002, { bidSz: 1, askSz: 1 });
  const a = await add(r, { ...MM, queueGuard: 0.3 });
  await step(r, a.id);
  const bid = r.ex.side('buy')[0]!;
  assert.ok(bid && r.ex.side('sell').length === 1, 'both quotes rest');
  r.market.set(60_000, 60_002, { bidSz: 0.1, askSz: 1 });
  await step(r, a.id, 200);
  assert.ok(!r.ex.cancelled.includes(bid.clOrdID), 'not within half a second of going out');
  await step(r, a.id, 600);
  assert.ok(r.ex.cancelled.includes(bid.clOrdID), 'the bid queue thinned to 9%: pulled');
  assert.equal(r.ex.side('sell').length, 1, 'the ask stays');
  r.market.set(60_000, 60_002, { bidSz: 1, askSz: 1 });
  await step(r, a.id, 1_000);
  assert.equal(r.ex.side('buy').length, 0, 'not back before the re-price pause');
  await step(r, a.id, 3_000);
  assert.equal(r.ex.side('buy').length, 1, 'back once the queue is thick again and the pause is over');
});

test('volume maker in a wide spread: one tick inside each side, never closer to fair than the edge - fair is the safer of mid and mark', () => {
  const s = { orderUsd: 60, maxInventoryUsd: 180, offsetTicks: -1, skewTicks: 4, edgeBps: 3 };
  const q = { bid: 60_000, ask: 60_084, at: 0 }; // 14 bp
  // The mark agrees with the book: one tick inside on both sides - a round trip earns about 13.7 bp.
  assert.deepEqual(mmQuotes(s, q, MKT, 0, 60_042).map((x) => x.price), [60_001, 60_083]);
  // The oracle says the price is lower than the book (the book lags): the bid stays 3 bp under the mark, behind the book.
  assert.deepEqual(mmQuotes(s, q, MKT, 0, 59_990).map((x) => x.price), [59_972, 60_083]);
  // ...and higher: the ask stays 3 bp over it.
  assert.deepEqual(mmQuotes(s, q, MKT, 0, 60_090).map((x) => x.price), [60_001, 60_109]);
});

test('volume maker ladder: a quote the touch moved away from keeps its place up to the levels; a new one joins the touch; the cap holds them all', async () => {
  const r = await rig();
  const a = await add(r, { ...MM, levels: 3, orderUsd: 20, maxInventoryUsd: 200 });
  await step(r, a.id);
  const first = r.ex.side('buy')[0]!;
  r.market.set(60_001, 60_003);
  await step(r, a.id, 4_000);
  assert.ok(!r.ex.cancelled.includes(first.clOrdID), 'one tick behind the touch: kept (its place in the queue)');
  assert.deepEqual(r.ex.side('buy').map((x) => Number(x.price)).sort(), [60_000, 60_001], 'a new bid at the touch');
  r.market.set(60_003, 60_005);
  await step(r, a.id, 4_000);
  assert.ok(r.ex.cancelled.includes(first.clOrdID), 'three ticks back with three levels: pulled');
  await step(r, a.id, 500);
  assert.ok(r.ex.side('buy').some((x) => Number(x.price) === 60_003), 'and the touch has one');
  assert.ok(r.ex.side('buy').length <= 3);
  // Near the cap: the bids that could all fill never take it past the cap.
  const b = await rig();
  const x = await add(b, { ...MM, symbol: 'BTC-USD', levels: 5, orderUsd: 60, maxInventoryUsd: 130 });
  await step(b, x.id);
  for (const [bid, ask] of [[60_001, 60_003], [60_002, 60_004], [60_003, 60_005]] as const) {
    b.market.set(bid, ask);
    await step(b, x.id, 4_000);
  }
  assert.ok(b.ex.side('buy').length <= 2, `$130 cap, $60 orders: at most two bids (${b.ex.side('buy').length})`);
});

test('volume maker ladder one tick back: new quotes rest behind the touch; when the touch comes to one it stays (its queue place)', async () => {
  const r = await rig();
  const a = await add(r, { ...MM, levels: 3, offsetTicks: 1, orderUsd: 20, maxInventoryUsd: 200 });
  await step(r, a.id);
  const bid = r.ex.side('buy')[0]!;
  assert.equal(Number(bid.price), 59_999, 'one tick behind the best bid');
  // The best bid drops to it: it is the touch now, near the front of that queue - kept.
  r.market.set(59_999, 60_001);
  await step(r, a.id, 4_000);
  assert.ok(!r.ex.cancelled.includes(bid.clOrdID), 'the touch came to it: kept');
  assert.ok(r.ex.side('buy').some((x) => Number(x.price) === 59_998), 'and a new one rests a tick behind');
});

test('volume maker move guard: a mid that jumped up 2 ticks in 2 s pulls the ask that would add; the bid stays', async () => {
  const r = await rig();
  const a = await add(r, { ...MM, moveGuard: 2 });
  await step(r, a.id);
  const ask = r.ex.side('sell')[0]!;
  r.market.ago = r.market.mk;
  r.market.set(60_002, 60_004);
  await step(r, a.id, 800);
  assert.ok(r.ex.cancelled.includes(ask.clOrdID), 'the price runs up into the ask: pulled');
  r.market.ago = r.market.mk;
  await step(r, a.id, 4_000);
  assert.equal(r.ex.side('sell').length, 1, 'quiet again: the ask is back');
});

test('grid: a level SoDEX refuses waits (3 s, doubling) instead of being sent every step into the refusal limit', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'grid', maxLossUsd: 1_000_000, low: 59_000, high: 61_000, levels: 5, orderUsd: 30, spacing: 'linear' });
  r.ex.refuse = 'insufficient margin';
  for (let i = 0; i < 40; i++) await step(r, a.id, 500);
  const x = r.rt.get(a.id)!;
  assert.notEqual(x.status, 'failed', `still running after 20 s of refusals (${x.rejects} refused)`);
  assert.ok(x.rejects < 25, `backed off: ${x.rejects} refusals in 20 s, not one a step`);
  r.ex.refuse = null;
  for (let i = 0; i < 140; i++) await step(r, a.id, 500);
  assert.equal(r.ex.resting.size, 4, 'every level back on the book once SoDEX takes them');
});

/* ------------------------------------------------------- the Binance-led maker ----- */

test('Binance-led maker spec: ref is binance only; its distances only with it, in range', () => {
  const ok = parseAlgoSpec({ kind: 'mm', maxLossUsd: 1_000_000, symbol: 'BTC-USD', orderUsd: 60, maxInventoryUsd: 180, ref: 'binance', refBps: 2, pullBps: 0.5 });
  assert.ok(ok.kind === 'mm' && ok.ref === 'binance' && ok.refBps === 2 && ok.pullBps === 0.5);
  assert.match(JSON.stringify(checkAlgoSpec({ kind: 'mm', maxLossUsd: 1_000_000, symbol: 'BTC-USD', orderUsd: 60, maxInventoryUsd: 180, ref: 'okx' }).errors), /binance/);
  assert.ok(!checkAlgoSpec({ kind: 'mm', maxLossUsd: 1_000_000, symbol: 'BTC-USD', orderUsd: 60, maxInventoryUsd: 180, ref: 'binance', refBps: 80 }).spec, 'refBps above 50');
  const none = parseAlgoSpec({ kind: 'mm', maxLossUsd: 1_000_000, symbol: 'BTC-USD', orderUsd: 60, maxInventoryUsd: 180, refBps: 2 });
  assert.ok(none.kind === 'mm' && none.refBps === undefined, 'refBps without ref is dropped: a plain maker keeps its signed text');
});

test('Binance-led maker quotes: at the touch only while it is pullBps from fair; at refBps from fair inside a wide spread', () => {
  const q: Quote = { bid: 60_000, ask: 60_010, at: 0 };
  const s = { orderUsd: 60, maxInventoryUsd: 180, offsetTicks: 0, skewTicks: 0, refBps: 0, pullBps: 0.5 };
  // Fair at the mid: both touches are 0.83 bp away - quoted at the touch.
  assert.deepEqual(mmQuotes(s, q, MKT, 0, 60_005, 60_005).map((x) => x.price), [60_000, 60_010]);
  // Binance fell: fair 60,001 is 0.17 bp above the bid - the bid (it adds) is not quoted; the ask stays.
  assert.deepEqual(mmQuotes(s, q, MKT, 0, 60_005, 60_001).map((x) => `${x.side} ${x.price}`), ['sell 60010']);
  // refBps 1: 6.0005 from fair 60,005, rounded away from it -> bid 59,998 (behind the touch), ask 60,012.
  const r1 = mmQuotes({ ...s, refBps: 1 }, q, MKT, 0, 60_005, 60_005);
  assert.deepEqual(r1.map((x) => x.price), [59_998, 60_012]);
  // In a wide spread it rests inside it, refBps from fair.
  const wide: Quote = { bid: 59_900, ask: 60_100, at: 0 };
  assert.deepEqual(mmQuotes({ ...s, refBps: 2 }, wide, MKT, 0, 60_000, 60_000).map((x) => x.price), [59_988, 60_012]);
  // Holding (long): the side that unwinds (ask) rests at a quarter of refBps, the bid steps back nothing (skew 0) at refBps.
  const held = mmQuotes({ ...s, refBps: 4 }, wide, MKT, 0.001, 60_000, 60_000);
  assert.deepEqual(held.map((x) => `${x.side} ${x.price}`), ['buy 59976', 'sell 60006']);
  // pastFair: a bid above fair - pull (adding) or above fair (unwinding).
  assert.ok(pastFair('buy', 60_000, 60_002, true, 0.5));
  assert.ok(!pastFair('buy', 59_990, 60_002, true, 0.5));
  assert.ok(!pastFair('buy', 60_000, 60_002, false, 0.5));
  assert.ok(pastFair('sell', 59_998, 59_999, false, 0), 'an ask below fair');
  assert.ok(!pastFair('sell', 60_000, 59_999, false, 0));
});

test('fair basis: the first pair sets it; later pairs move it with a 30 s half-life', () => {
  const b = new FairBasis();
  assert.equal(b.fair(100), null);
  b.update(101, 100, 0);
  assert.equal(b.fair(100), 101);
  b.update(102, 100, 30_000);
  assert.ok(Math.abs(b.fair(100)! - 101.5) < 1e-9, 'half way after one half-life');
});

test('Binance-led maker: holds without a reference; quotes off it; a Binance tick pulls the quote it came past at once', async () => {
  const none = await rig();
  const a0 = await add(none, { ...MM, ref: 'binance' });
  const v0 = await step(none, a0.id);
  assert.equal(none.ex.placed.length, 0);
  assert.match(v0.statusReason ?? '', /executor only/);

  const ref = new FakeRef();
  const r = await rig(ref);
  const a = await add(r, { ...MM, ref: 'binance', pullBps: 0.1 });
  ref.tick(60_000.5, 60_001.5);
  await step(r, a.id);
  assert.deepEqual(ref.watched, ['BTC-USD']);
  assert.equal(r.ex.placed.length, 2, 'fair at the mid: both sides at the touch');
  const bid = r.ex.side('buy')[0]!;
  // Binance drops 2 bp: the bid at 60,000 is now above fair - cancelled on the tick, no step in between.
  ref.tick(59_988.5, 59_989.5);
  await settle();
  assert.ok(r.ex.cancelled.includes(bid.clOrdID), 'pulled by the tick');
  assert.ok(!r.ex.cancelled.includes(r.ex.side('sell')[0]?.clOrdID ?? 'x'), 'the ask is safer than before: it stays');
  // The next step does not put the bid back while fair is under it.
  await step(r, a.id, 500);
  assert.equal(r.ex.side('buy').length, 0);
  // A reference gone quiet for over 2 s: everything is pulled, and it holds.
  const v = await step(r, a.id, 2_500);
  assert.equal(r.ex.side('sell').length, 0);
  assert.match(v.statusReason ?? '', /Binance price/);
});

test('Binance-led maker: pickier to send than to keep - placeBps and calmBps hold new quotes back; what rests stays until pullBps', async () => {
  const ref = new FakeRef();
  const r = await rig(ref);
  // Fair at the mid (60,001): both touches 0.17 bp away. placeBps 0.5: neither goes out.
  const a = await add(r, { ...MM, ref: 'binance', placeBps: 0.5 });
  ref.tick(60_000.5, 60_001.5);
  await step(r, a.id);
  assert.equal(r.ex.placed.length, 0, 'too close to fair to send');
  // A wide book: 60,000 / 60,020, fair 60,010: 1.67 bp each way, both go out.
  r.market.set(60_000, 60_020);
  ref.tick(60_009.5, 60_010.5);
  await step(r, a.id, 500);
  assert.equal(r.ex.placed.length, 2, 'far enough: both go out');
  const b = await add(r, { ...MM, ref: 'binance', calmBps: 1, calmMs: 500 });
  clockTick(100);
  // Binance falls 3 bp within the window: the bid (it would add) waits, the ask goes out.
  ref.tick(60_009.5, 60_010.5);
  clockTick(100);
  ref.tick(59_991.5, 59_992.5);
  const before = r.ex.placed.length;
  r.market.set(59_985, 60_020);
  await step(r, b.id, 100);
  const sent = r.ex.placed.slice(before);
  assert.deepEqual(sent.map((o) => o.side), ['sell'], 'the side Binance runs at waits');
});

test('Binance-led maker: stillBps sends only in a still market, restMs cancels what has rested that long', async () => {
  const ref = new FakeRef();
  const r = await rig(ref);
  const a = await add(r, { ...MM, ref: 'binance', chaseTicks: 40, stillBps: 5, stillMs: 1_000, restMs: 3_000 });
  ref.tick(60_000.5, 60_001.5);
  await step(r, a.id);
  assert.equal(r.ex.placed.length, 0, 'the trail does not reach back a full window yet');
  clockTick(1_100);
  ref.tick(60_000.5, 60_001.5);
  await step(r, a.id);
  assert.equal(r.ex.placed.length, 2, 'still: both sides go out');
  const first = r.ex.placed.map((o) => o.clOrdID);
  for (let i = 0; i < 2; i++) {
    clockTick(1_000);
    ref.tick(60_000.5, 60_001.5);
    await step(r, a.id);
    assert.equal(r.ex.cancelled.length, 0, 'younger than restMs: it rests');
  }
  // Binance runs 3 bp up and back: nearly back at the same price, but the path is 6 bp.
  clockTick(800);
  ref.tick(60_018.5, 60_019.5);
  clockTick(50);
  ref.tick(60_000.5, 60_001.5);
  clockTick(150);
  ref.tick(60_000.5, 60_001.5);
  const before = r.ex.placed.length;
  await step(r, a.id);
  assert.deepEqual(r.ex.cancelled.filter((c) => first.includes(c)).sort(), [...first].sort(), 'rested 3 s: both cancelled');
  await step(r, a.id, 200);
  assert.equal(r.ex.placed.length, before, 'the path is over stillBps: nothing new goes out');
  clockTick(1_100);
  ref.tick(60_000.5, 60_001.5);
  await step(r, a.id);
  assert.equal(r.ex.placed.length, before + 2, 'still again: both sides are back');
});

test('restart, take over: the old bot only pulls; the new one waits for it to end, then carries what it held at the price then', async () => {
  const r = await rig();
  const old = await add(r, { ...MM, onStop: 'keep' });
  await step(r, old.id);
  r.ex.fill(r.ex.side('buy')[0]!.clOrdID);
  await settle();
  const held = r.rt.view(old.id)!.bot!.inventory;
  assert.ok(held > 0);
  await r.rt.cancel(old.id);
  const next = await r.rt.add({ owner: FOLLOWER, accountId: 42, mode: 'hosted', spec: { symbol: 'BTC-USD', ...MM, orderUsd: 60 }, seed: 7, takeOver: old.id });
  await step(r, next.id);
  await step(r, old.id, 500);
  assert.equal(r.rt.get(old.id)!.status, 'cancelled', 'the old one ends at once: nothing to close');
  await step(r, next.id, 500);
  const v = r.rt.view(next.id)!;
  assert.equal(v.algo.status, 'running');
  assert.ok(Math.abs(v.bot!.inventory - held) < 1e-12, 'it holds what the old one held');
  assert.equal(v.bot!.volume, 0, 'taking over is not volume');
  assert.ok(Math.abs(v.bot!.grossPnl) < 1e-6, 'its PnL starts at zero, from the hand-over price');
  assert.ok(Math.abs(r.ex.position - held) < 1e-12, 'nothing was traded for the hand-over');
});

test('restart, clean: the new bot waits until the old one has closed what it holds, then starts flat', async () => {
  const r = await rig();
  const old = await add(r, MM);
  await step(r, old.id);
  r.ex.fill(r.ex.side('buy')[0]!.clOrdID);
  await settle();
  await r.rt.cancel(old.id);
  const next = await r.rt.add({ owner: FOLLOWER, accountId: 42, mode: 'hosted', spec: { symbol: 'BTC-USD', ...MM }, seed: 7, after: old.id });
  await step(r, next.id, 500);
  assert.equal(r.rt.get(next.id)!.status, 'scheduled', 'waits while the old one closes');
  assert.equal([...r.ex.resting.values()].filter((o) => !o.reduceOnly).length, 0, 'the new one quotes nothing yet');
  await step(r, old.id, 500);
  await step(r, old.id, 61_000);
  await step(r, old.id, 500);
  await step(r, old.id, 500);
  assert.equal(r.rt.get(old.id)!.status, 'cancelled');
  await step(r, next.id, 500);
  const v = r.rt.view(next.id)!;
  assert.equal(v.algo.status, 'running');
  assert.equal(v.bot!.inventory, 0);
});

/* ------------------------------------------- volume maker: patient-taker gate and quiet windows ----- */

test('spec: flowGate and quiet parse with their defaults, with or without ref; a spec without them keeps its text', () => {
  const s = parseAlgoSpec({ kind: 'mm', maxLossUsd: 1_000_000, symbol: 'BTC-USD', orderUsd: 50, maxInventoryUsd: 200, flowGate: { minUsd: 25_000 }, quiet: [{ from: '09:20', to: '09:45', zone: 'new_york' }] });
  if (s.kind !== 'mm') return assert.fail('mm');
  assert.deepEqual(s.flowGate, { minUsd: 25_000, windowMs: 600_000, action: 'pause', shrink: 0.5 });
  assert.deepEqual(s.quiet, [{ from: '09:20', to: '09:45', zone: 'new_york', days: 'all' }]);
  const r = parseAlgoSpec({ kind: 'mm', maxLossUsd: 1_000_000, symbol: 'BTC-USD', orderUsd: 50, maxInventoryUsd: 200, ref: 'binance', flowGate: { minUsd: 1_000, windowMs: 60_000, action: 'shrink', shrink: 0.25 }, quiet: [{ from: '23:00', to: '01:00', zone: 'london', days: 'weekdays' }] });
  if (r.kind !== 'mm') return assert.fail('mm');
  assert.deepEqual(r.flowGate, { minUsd: 1_000, windowMs: 60_000, action: 'shrink', shrink: 0.25 });
  assert.equal(r.quiet![0]!.days, 'weekdays');
  const plain = parseAlgoSpec({ kind: 'mm', maxLossUsd: 1_000_000, symbol: 'BTC-USD', orderUsd: 50, maxInventoryUsd: 200, flowGate: null, quiet: [] });
  assert.ok(!canonicalJSON(plain).includes('flowGate') && !canonicalJSON(plain).includes('quiet'));
});

test('spec: flowGate and quiet refusals name the field', () => {
  const e = (x: Record<string, unknown>) => checkAlgoSpec({ kind: 'mm', maxLossUsd: 1_000_000, symbol: 'BTC-USD', orderUsd: 50, maxInventoryUsd: 200, ...x }).errors;
  assert.ok(e({ flowGate: 5 }).flowGate);
  assert.ok(e({ flowGate: { minUsd: 500 } })['flowGate.minUsd']);
  assert.ok(e({ flowGate: { minUsd: 200_000_000 } })['flowGate.minUsd']);
  assert.ok(e({ flowGate: {} })['flowGate.minUsd'], 'minUsd is needed');
  assert.ok(e({ flowGate: { minUsd: 5_000, windowMs: 30_000 } })['flowGate.windowMs']);
  assert.ok(e({ flowGate: { minUsd: 5_000, windowMs: 4_000_000 } })['flowGate.windowMs']);
  assert.ok(e({ flowGate: { minUsd: 5_000, windowMs: 60_000.5 } })['flowGate.windowMs']);
  assert.ok(e({ flowGate: { minUsd: 5_000, action: 'stop' } })['flowGate.action']);
  assert.ok(e({ flowGate: { minUsd: 5_000, action: 'shrink', shrink: 0.05 } })['flowGate.shrink']);
  assert.ok(e({ flowGate: { minUsd: 5_000, action: 'shrink', shrink: 1.5 } })['flowGate.shrink']);
  assert.ok(e({ quiet: 'always' }).quiet);
  const w = { from: '09:20', to: '09:45', zone: 'utc' };
  assert.ok(e({ quiet: Array.from({ length: 7 }, () => w) }).quiet, 'at most 6');
  assert.deepEqual(Object.keys(e({ quiet: Array.from({ length: 6 }, () => w) })), []);
  assert.ok(e({ quiet: [{ ...w, from: '9:20' }] })['quiet.0.from']);
  assert.ok(e({ quiet: [w, { ...w, to: '24:00' }] })['quiet.1.to']);
  assert.ok(e({ quiet: [{ ...w, to: '09:20' }] })['quiet.0.to'], 'start and end differ');
  assert.ok(e({ quiet: [{ ...w, zone: 'tokyo' }] })['quiet.0.zone']);
  assert.ok(e({ quiet: [{ ...w, days: 'weekends' }] })['quiet.0.days']);
  assert.ok(e({ quiet: [7] })['quiet.0']);
});

test('quiet windows: New York and London local time across DST; weekdays; a window past midnight goes by the day it began', () => {
  const ny = [{ from: '09:20', to: '09:45', zone: 'new_york', days: 'all' }] as const;
  // 09:30 New York is 14:30 UTC in winter (EST), 13:30 UTC in summer (EDT).
  assert.ok(quietWindowAt([...ny], Date.UTC(2026, 0, 15, 14, 30)));
  assert.equal(quietWindowAt([...ny], Date.UTC(2026, 0, 15, 13, 30)), null);
  assert.ok(quietWindowAt([...ny], Date.UTC(2026, 6, 15, 13, 30)));
  assert.equal(quietWindowAt([...ny], Date.UTC(2026, 6, 15, 14, 30)), null);
  // The weeks between the US (8 March 2026) and the UK (29 March) clock change: New York on EDT, London still on GMT.
  assert.ok(quietWindowAt([...ny], Date.UTC(2026, 2, 16, 13, 30)));
  assert.equal(zoneTime(Date.UTC(2026, 2, 16, 13, 30), 'london').minutes, 13 * 60 + 30);
  assert.equal(zoneTime(Date.UTC(2026, 6, 16, 13, 30), 'london').minutes, 14 * 60 + 30);
  // The end is not inside; the start is.
  assert.ok(quietWindowAt([...ny], Date.UTC(2026, 0, 15, 14, 20)));
  assert.equal(quietWindowAt([...ny], Date.UTC(2026, 0, 15, 14, 45)), null);
  // Weekdays: Saturday 17 January 2026 is not one.
  const wk = [{ from: '09:20', to: '09:45', zone: 'new_york', days: 'weekdays' }] as const;
  assert.ok(quietWindowAt([...wk], Date.UTC(2026, 0, 16, 14, 30)));
  assert.equal(quietWindowAt([...wk], Date.UTC(2026, 0, 17, 14, 30)), null);
  // 23:00-01:00 UTC on weekdays: Saturday 00:30 is Friday's window; Monday 00:30 would be Sunday's.
  const night = [{ from: '23:00', to: '01:00', zone: 'utc', days: 'weekdays' }] as const;
  assert.ok(quietWindowAt([...night], Date.UTC(2026, 0, 17, 0, 30)));
  assert.equal(quietWindowAt([...night], Date.UTC(2026, 0, 19, 0, 30)), null);
  assert.ok(quietWindowAt([...night], Date.UTC(2026, 0, 19, 23, 30)));
  assert.equal(quietWindowAt([...night], Date.UTC(2026, 0, 19, 1, 0)), null);
});

test('trading days: NYSE and London holidays by rule; a trading-days window skips them', () => {
  // NYSE 2026: Good Friday 3 April, Independence Day observed Friday 3 July, Thanksgiving 26 November.
  const ny26 = nyseHolidays(2026);
  for (const d of ['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25']) assert.ok(ny26.has(d), d);
  assert.equal(ny26.size, 10);
  // 2027: Juneteenth on a Saturday is Friday 18 June; Christmas on a Saturday is Friday 24 December; New Year on a Friday.
  for (const d of ['2027-01-01', '2027-03-26', '2027-06-18', '2027-07-05', '2027-12-24']) assert.ok(nyseHolidays(2027).has(d), d);
  // 2028 starts on a Saturday: NYSE takes no day for it.
  assert.ok(!nyseHolidays(2028).has('2027-12-31') && !nyseHolidays(2028).has('2028-01-03'));
  // London 2026: Easter Monday 6 April, bank holidays 4 May, 25 May, 31 August; Boxing Day on a Saturday is Monday 28 December.
  for (const d of ['2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28']) assert.ok(lseHolidays(2026).has(d), d);
  const open = [{ from: '09:25', to: '09:50', zone: 'new_york', days: 'trading' }] as const;
  // Thursday 26 November 2026 (Thanksgiving) is skipped; Wednesday the 25th is not. 09:30 EST = 14:30 UTC.
  assert.equal(quietWindowAt([...open], Date.UTC(2026, 10, 26, 14, 30)), null);
  assert.ok(quietWindowAt([...open], Date.UTC(2026, 10, 25, 14, 30)));
  // A Saturday is no trading day either.
  assert.equal(quietWindowAt([...open], Date.UTC(2026, 10, 28, 14, 30)), null);
});

test('news gate: held from before to after a timed release of its level; low and all-day ones are skipped', () => {
  const t = Date.UTC(2026, 10, 13, 13, 30);
  const evs: NewsEvent[] = [{ time: t, short: 'CPI', importance: 'high' }, { time: t + 3_600_000, short: 'Claims', importance: 'low' }, { time: t + 7_200_000, short: 'PPI', importance: 'medium' }, { time: t + 9_000_000, short: 'GDP', importance: 'high', allDay: true }];
  const g = { beforeMin: 5, afterMin: 15, level: 'high' } as const;
  assert.equal(newsAt(g, evs, t - 5 * 60_000)?.short, 'CPI');
  assert.equal(newsAt(g, evs, t - 6 * 60_000), null);
  assert.equal(newsAt(g, evs, t + 14 * 60_000)?.short, 'CPI');
  assert.equal(newsAt(g, evs, t + 15 * 60_000), null);
  assert.equal(newsAt(g, evs, t + 3_600_000), null, 'a low one never');
  assert.equal(newsAt(g, evs, t + 7_200_000), null, 'medium is not high');
  assert.equal(newsAt({ ...g, level: 'medium' }, evs, t + 7_200_000)?.short, 'PPI');
  assert.equal(newsAt(g, evs, t + 9_000_000), null, 'no time: skipped');
  assert.ok(parseAlgoSpec({ kind: 'mm', maxLossUsd: 1_000_000, symbol: 'BTC-USD', orderUsd: 50, maxInventoryUsd: 200, news: g }).kind === 'mm');
  assert.throws(() => parseAlgoSpec({ kind: 'mm', maxLossUsd: 1_000_000, symbol: 'BTC-USD', orderUsd: 50, maxInventoryUsd: 200, news: { beforeMin: 0, afterMin: 0 } }));
  assert.throws(() => parseAlgoSpec({ kind: 'mm', maxLossUsd: 1_000_000, symbol: 'BTC-USD', orderUsd: 50, maxInventoryUsd: 200, quietOnly: true }), 'trading hours need a window');
});

test('volume maker trading hours (quietOnly): quotes only inside its windows; the news gate holds around a release', async () => {
  const r = await rig();
  // T0 is 08:00 UTC: it trades 08:05-08:30 only.
  const a = await add(r, { ...MM, quiet: [{ from: '08:05', to: '08:30', zone: 'utc' }], quietOnly: true });
  const out = await step(r, a.id);
  assert.equal(r.ex.resting.size, 0, 'outside its hours nothing rests');
  assert.match(out.statusReason ?? '', /outside your trading hours/);
  await step(r, a.id, 5 * 60_000);
  await step(r, a.id, 500);
  assert.equal(r.ex.resting.size, 2, 'inside them it quotes');
  // News: a CPI release one minute on, held 2 minutes before to 10 after.
  r.events = [{ time: clock + 60_000, short: 'CPI', importance: 'high' }];
  const b = await add(r, { ...MM, news: { beforeMin: 2, afterMin: 10, level: 'high' } });
  const held = await step(r, b.id);
  assert.match(held.statusReason ?? '', /CPI .* \(news gate\)/);
  const back = await step(r, b.id, 12 * 60_000);
  assert.equal(back.status, 'running');
});

test('volume maker quiet window: pulls its quotes and holds inside it; quotes again when it ends', async () => {
  const r = await rig();
  // T0 is 08:00 UTC: the window starts five minutes on.
  const a = await add(r, { ...MM, quiet: [{ from: '08:05', to: '08:30', zone: 'utc' }] });
  await step(r, a.id);
  assert.equal(r.ex.resting.size, 2);
  const held = await step(r, a.id, 5 * 60_000);
  assert.equal(r.ex.resting.size, 0, 'nothing rests inside the window');
  assert.equal(held.status, 'waiting');
  assert.equal(held.statusReason, 'Paused: quiet window 08:05–08:30 UTC.');
  const placed = r.ex.placed.length;
  await step(r, a.id, 10 * 60_000);
  assert.equal(r.ex.placed.length, placed, 'nothing new inside the window');
  const back = await step(r, a.id, 16 * 60_000);
  await step(r, a.id, 500);
  assert.equal(back.status, 'running');
  assert.equal(r.ex.resting.size, 2, 'quotes again after it');
});

test('volume maker patient-taker gate: open while it has less than its window of history; pauses while the patient taker is quiet, quotes when it trades', async () => {
  const r = await rig();
  const a = await add(r, { ...MM, onStop: 'keep', flowGate: { minUsd: 10_000, windowMs: 60_000, action: 'pause' } });
  await step(r, a.id);
  assert.equal(r.ex.resting.size, 2, 'a fresh bot is not paused for lack of history');
  assert.ok(r.rt.view(a.id)!.working?.includes('Patient-taker gate open'));
  assert.equal((await r.rt.events(a.id, { limit: 500 })).filter((x) => x.text.startsWith('Patient-taker gate: watching')).length, 1);
  // Others trade, and the patient taker makes (it was not the taker): neither counts.
  r.market.print(77, 1);
  r.market.print(PATIENT_TAKER_ACCOUNT, 1, 60_000, 'sell');
  (r.market.printCbs[0]!)({ symbol: 'BTC-USD', price: 60_000, qty: 1, buyer: PATIENT_TAKER_ACCOUNT, seller: 9, taker: 'sell', at: Date.now() });
  const held = await step(r, a.id, 61_000);
  assert.equal(held.status, 'waiting');
  assert.equal(r.ex.resting.size, 0, 'its quotes are pulled');
  assert.match(held.statusReason!, /^Paused: the patient taker traded \$0 here in the last 1 min \(under your \$10k\)\.$/);
  // It takes $6k: still under; the line follows with no new event.
  const events = (await r.rt.events(a.id, { limit: 500 })).length;
  r.market.print(PATIENT_TAKER_ACCOUNT, 0.1);
  const still = await step(r, a.id, 500);
  assert.equal(still.statusReason, 'Paused: the patient taker traded $6k here in the last 1 min (under your $10k).');
  assert.equal(r.ex.resting.size, 0);
  assert.equal((await r.rt.events(a.id, { limit: 500 })).length, events, 'no event per figure');
  // Another $6k: $12k over the minute, the gate opens and it quotes again.
  r.market.print(PATIENT_TAKER_ACCOUNT, 0.1);
  const open = await step(r, a.id, 500);
  await step(r, a.id, 500);
  assert.equal(open.status, 'running');
  assert.equal(r.ex.resting.size, 2);
  // A minute on the prints are out of the window: paused again.
  await step(r, a.id, 61_000);
  assert.equal(r.ex.resting.size, 0);
  assert.equal(r.rt.get(a.id)!.status, 'waiting');
});

test('volume maker patient-taker gate, shrink: quotes half the size while it is quiet, never under SoDEX\'s minimum, full size once it trades', async () => {
  const r = await rig();
  const a = await add(r, { ...MM, flowGate: { minUsd: 10_000, windowMs: 60_000, action: 'shrink', shrink: 0.5 } });
  await step(r, a.id);
  const full = Number(r.ex.side('buy')[0]!.quantity);
  assert.equal(full, 0.001);
  await step(r, a.id, 61_000);
  await step(r, a.id, 500);
  assert.equal(r.rt.get(a.id)!.status, 'running', 'shrink keeps quoting');
  assert.equal(r.ex.resting.size, 2);
  assert.ok(r.ex.side('buy').every((o) => Number(o.quantity) === full / 2), 'half the size');
  // The ask at 60,002: $30 floors to 0.00049 there (the step), as the full $60 floored to 0.00099.
  assert.ok(r.ex.side('sell').every((o) => Number(o.quantity) === 0.00049));
  assert.match(r.rt.view(a.id)!.working!, /Quoting smaller, \$30 a side: the patient taker traded \$0 here in the last 1 min \(under your \$10k\)/);
  assert.equal((r.rt.get(a.id)!.spec as { orderUsd: number }).orderUsd, 60, 'the spec stays as signed');
  r.market.print(PATIENT_TAKER_ACCOUNT, 0.2);
  await step(r, a.id, 500);
  await step(r, a.id, 500);
  assert.ok(r.ex.side('buy').every((o) => Number(o.quantity) === full), 'full size again');
  assert.ok(!r.rt.view(a.id)!.working?.includes('smaller'));

  const r2 = await rig();
  const b = await add(r2, { ...MM, flowGate: { minUsd: 10_000, windowMs: 60_000, action: 'shrink', shrink: 0.1 } });
  await step(r2, b.id);
  await step(r2, b.id, 61_000);
  await step(r2, b.id, 500);
  // $6 is under SoDEX's $10 minimum: the minimum goes out.
  assert.ok(r2.ex.side('buy').length && r2.ex.side('buy').every((o) => Number(o.quantity) === 0.00017));
});

test('volume maker update: flowGate and quiet change on a running bot, checked like at the start; null turns them off', async () => {
  const r = await rig();
  const a = await add(r, MM);
  await step(r, a.id);
  await r.rt.update(a.id, { quiet: [{ from: '08:00', to: '09:00', zone: 'utc', days: 'all' }] });
  const held = await step(r, a.id, 500);
  assert.equal(held.status, 'waiting');
  assert.equal(r.ex.resting.size, 0);
  await assert.rejects(r.rt.update(a.id, { flowGate: { minUsd: 10, windowMs: 60_000, action: 'pause', shrink: 0.5 } }));
  await assert.rejects(r.rt.update(a.id, { quiet: [{ from: '08:00', to: '08:00', zone: 'utc', days: 'all' }] }));
  await r.rt.update(a.id, { quiet: null, flowGate: { minUsd: 5_000, windowMs: 120_000, action: 'shrink', shrink: 0.5 } });
  const s = r.rt.get(a.id)!.spec as { quiet?: unknown; flowGate?: unknown };
  assert.equal(s.quiet, undefined);
  assert.deepEqual(s.flowGate, { minUsd: 5_000, windowMs: 120_000, action: 'shrink', shrink: 0.5 });
  await step(r, a.id, 61_000);
  await step(r, a.id, 500);
  assert.equal(r.ex.resting.size, 2, 'quotes again');
});

test('bot takers: each print a bot made names who took it - the uninformed (1002), the informed (23342), others; its own takes are not counted', async () => {
  const r = await rig();
  const a = await add(r, MM);
  await step(r, a.id);
  const cb = r.market.printCbs[0]!;
  cb({ symbol: 'BTC-USD', price: 60_000, qty: 0.001, buyer: 42, seller: PATIENT_TAKER_ACCOUNT, taker: 'sell', at: Date.now() });
  cb({ symbol: 'BTC-USD', price: 60_002, qty: 0.002, buyer: 23342, seller: 42, taker: 'buy', at: Date.now() });
  cb({ symbol: 'BTC-USD', price: 60_002, qty: 0.001, buyer: 77, seller: 42, taker: 'buy', at: Date.now() });
  cb({ symbol: 'BTC-USD', price: 60_002, qty: 0.5, buyer: 42, seller: 9, taker: 'buy', at: Date.now() });
  cb({ symbol: 'ETH-USD', price: 3_000, qty: 1, buyer: 42, seller: 1002, taker: 'sell', at: Date.now() });
  const t = r.rt.view(a.id)!.bot!.takers!;
  assert.ok(Math.abs(t.t1002 - 60) < 1e-6, String(t.t1002));
  assert.ok(Math.abs(t.t23342 - 120.004) < 1e-6, String(t.t23342));
  assert.ok(Math.abs(t.other - 60.002) < 1e-6, 'its own take (42 the taker) is not counted');
});

test('smart margining: what a bot sets aside - a maker its max holding and a quote each side per level, a grid an order per level', () => {
  assert.equal(botReserveUsd(parseAlgoSpec({ kind: 'mm', maxLossUsd: 1_000_000, symbol: 'BTC-USD', orderUsd: 50, maxInventoryUsd: 150 })), 250);
  assert.equal(botReserveUsd(parseAlgoSpec({ kind: 'mm', maxLossUsd: 1_000_000, symbol: 'BTC-USD', orderUsd: 20, maxInventoryUsd: 100, levels: 3 })), 220);
  assert.equal(botReserveUsd(parseAlgoSpec({ kind: 'grid', maxLossUsd: 1_000_000, symbol: 'BTC-USD', low: 50_000, high: 70_000, levels: 10, orderUsd: 12 })), 120);
});

test('smart margining: a copy sets aside its allocation while it can hold positions, nothing stopped or on paper (owner 2026-11-08)', () => {
  const c = (status: string, allocationUsd: number, paper = false) => ({ status, settings: { allocationUsd, paper } });
  assert.equal(copyReserveUsd(c('active', 250)), 250);
  assert.equal(copyReserveUsd(c('paused', 150)), 150, 'paused still holds');
  assert.equal(copyReserveUsd(c('halted', 90)), 90);
  assert.equal(copyReserveUsd(c('stopped', 250)), 0);
  assert.equal(copyReserveUsd(c('active', 250, true)), 0, 'paper');
  assert.equal(copyReserveUsd(c('active', -5)), 0, 'never negative');
  // A maker with $60 holding and $20 a side sets aside $100: on a $500 account it fits beside a $400 copy, not a $450 one.
  const maker = { kind: 'mm', maxLossUsd: 1_000_000, maxInventoryUsd: 60, orderUsd: 20 } as Parameters<typeof botReserveUsd>[0];
  assert.equal(botReserveUsd(maker), 100);
  assert.ok(copyReserveUsd(c('active', 400)) + botReserveUsd(maker) <= 500);
  assert.ok(copyReserveUsd(c('active', 450)) + botReserveUsd(maker) > 500);
});

/* ------------------------------------------- several bots on one market (owner 2026-11-08) ----- */

const addSeed = (r: Rig, spec: Record<string, unknown>, seed: number) => r.rt.add({ owner: FOLLOWER, accountId: 42, mode: 'hosted', spec: { symbol: 'BTC-USD', ...spec }, seed });
const ofBot = (r: Rig, id: string, side: 'buy' | 'sell') => r.ex.side(side).filter((x) => x.clOrdID.includes(id.slice(1, 13)));

test('two bots of one wallet on one market: each unwinds only what it bought itself, without the SoDEX flag; a stopping one never takes into the other', async () => {
  const r = await rig();
  const a = await addSeed(r, MM, 11);
  const b = await addSeed(r, MM, 12);
  assert.notEqual(a.id, b.id);
  await step(r, a.id);
  await step(r, b.id);
  // A buys once; B holds nothing.
  r.ex.fill(ofBot(r, a.id, 'buy')[0]!.clOrdID);
  await settle();
  await step(r, a.id, 4_000);
  await step(r, b.id);
  const held = bookInventory(r.rt.get(a.id)!.book!);
  assert.ok(held > 0);
  assert.equal(bookInventory(r.rt.get(b.id)!.book!), 0, 'the fill of A is not in the book of B');
  const asks = ofBot(r, a.id, 'sell');
  assert.equal(asks.length, 1);
  assert.equal(asks[0]!.reduceOnly, false, 'sharing its market, it unwinds without the SoDEX reduce-only flag');
  assert.ok(Number(asks[0]!.quantity) <= held + 1e-12, 'never more than it holds itself');
  // A stops: after a minute its taker stops one tick short of B's bid (never trading with the wallet's own bot).
  const bBid = ofBot(r, b.id, 'buy')[0]!;
  assert.equal(Number(bBid.price), 60_000);
  await r.rt.cancel(a.id);
  await settle();
  await step(r, a.id, 500);
  await step(r, a.id, 61_000);
  await step(r, a.id, 500);
  await step(r, a.id, 500);
  const takes = r.ex.placed.filter((o) => o.clOrdID.includes(a.id.slice(1, 13)) && o.tif === 'ioc');
  assert.ok(takes.every((o) => Number(o.price) > 60_000), 'no taker priced into its own other bot');
  assert.ok(r.ex.resting.has(bBid.clOrdID), 'the bid of B untouched');
  assert.equal(r.rt.otherBotWall(r.rt.get(a.id)!, 'BTC-USD', 'sell'), 60_000);
});

test('a position the wallet opened by hand is left alone: SoDEX refusing the reduce-only close makes the bot close only its own holding', async () => {
  const r = await rig();
  r.ex.position = -0.01; // the wallet's own short, opened by hand
  const a = await addSeed(r, MM, 21);
  await step(r, a.id);
  r.ex.fill(ofBot(r, a.id, 'buy')[0]!.clOrdID);
  await settle();
  const held = bookInventory(r.rt.get(a.id)!.book!);
  assert.ok(held > 0);
  const before = r.ex.placed.length;
  await r.rt.cancel(a.id);
  await settle();
  // Its close goes out reduce-only (alone on the market); SoDEX refuses it: the account is short.
  for (let i = 0; i < 6 && !ofBot(r, a.id, 'sell').length; i++) await step(r, a.id, 1_500);
  const sent = r.ex.placed.slice(before).filter((o) => o.clOrdID.includes(a.id.slice(1, 13)));
  assert.ok(sent[0]?.reduceOnly, 'first try with the flag');
  assert.equal(r.rt.get(a.id)!.k.plainReduce, true, 'a position is there that is not only the holding of the bot');
  const close = ofBot(r, a.id, 'sell')[0]!;
  assert.equal(close.reduceOnly, false);
  assert.ok(Math.abs(Number(close.quantity) - held) < 1e-12, 'exactly what it bought');
  r.ex.fill(close.clOrdID);
  await settle();
  await step(r, a.id, 500);
  assert.ok(Math.abs(r.ex.position - -0.01) < 1e-12, 'the own short of the wallet is as it was');
  assert.equal(r.rt.get(a.id)!.status, 'cancelled');
  const log = (await r.rt.events(a.id, { limit: 500 })).map((e) => e.text).join(' | ');
  assert.match(log, /unwinds only what it bought or sold itself and leaves the rest of the position alone/);
});

test('a bot alone on its market whose holding was closed by hand: the reduce-only close is refused, the account reads flat, and it ends instead of opening the other way', async () => {
  const r = await rig();
  const a = await addSeed(r, MM, 31);
  await step(r, a.id);
  r.ex.fill(ofBot(r, a.id, 'buy')[0]!.clOrdID);
  await settle();
  r.ex.position = 0; // closed on SoDEX by hand
  const before = r.ex.placed.length;
  await r.rt.cancel(a.id);
  await settle();
  for (let i = 0; i < 12 && r.rt.get(a.id)!.status === 'running'; i++) await step(r, a.id, 5_000);
  const end = r.rt.get(a.id)!;
  assert.equal(end.status, 'cancelled');
  assert.match(end.statusReason ?? '', /not there any more/);
  assert.equal(end.k.plainReduce, undefined, 'never switched to unwinding without the flag');
  assert.ok(Math.abs(r.ex.position) < 1e-12, 'nothing opened the other way');
  const closes = r.ex.placed.slice(before).filter((o) => o.clOrdID.includes(a.id.slice(1, 13)));
  assert.ok(closes.length >= 1 && closes.every((o) => o.reduceOnly && o.side === 'sell'), 'every close went with the flag');
});

test('trading hours in any time zone (owner 2026-11-08): the own clock of the owner with its daylight saving, half-hour zones exact; unknown zones refused', () => {
  // 09:00-10:00 Berlin: 08:00 UTC in winter (CET), 07:00 UTC in summer (CEST).
  const ber = [{ from: '09:00', to: '10:00', zone: 'Europe/Berlin', days: 'all' }];
  assert.ok(quietWindowAt(ber, Date.UTC(2026, 0, 15, 8, 30)));
  assert.equal(quietWindowAt(ber, Date.UTC(2026, 0, 15, 7, 30)), null);
  assert.ok(quietWindowAt(ber, Date.UTC(2026, 6, 15, 7, 30)));
  assert.equal(quietWindowAt(ber, Date.UTC(2026, 6, 15, 8, 30)), null);
  // Kolkata is UTC+5:30 all year: 18:00-19:00 there is 12:30-13:30 UTC.
  const kol = [{ from: '18:00', to: '19:00', zone: 'Asia/Kolkata', days: 'weekdays' }];
  assert.ok(quietWindowAt(kol, Date.UTC(2026, 0, 15, 12, 45)));
  assert.equal(quietWindowAt(kol, Date.UTC(2026, 0, 15, 12, 15)), null);
  assert.equal(quietWindowAt(kol, Date.UTC(2026, 0, 17, 12, 45)), null, 'Saturday there');
  assert.equal(quietWords(ber[0]!), '09:00–10:00 Berlin');
  assert.equal(validZone('Europe/Berlin'), true);
  assert.equal(validZone('new_york'), true);
  assert.equal(validZone('Mars/Olympus'), false);
  assert.equal(validZone('../etc'), false);
  const e = (quiet: unknown) => checkAlgoSpec({ kind: 'mm', symbol: 'BTC-USD', orderUsd: 50, maxInventoryUsd: 200, maxLossUsd: 10, quiet }).errors;
  assert.equal(e([{ from: '09:00', to: '10:00', zone: 'Asia/Tokyo', days: 'all' }])['quiet.0.zone'], undefined);
  assert.match(e([{ from: '09:00', to: '10:00', zone: 'Mars/Olympus', days: 'all' }])['quiet.0.zone'] ?? '', /time zone name such as Europe\/Berlin/);
});

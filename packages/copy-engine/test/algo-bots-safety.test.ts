/**
 * Bots before real money (docs/BOTS-LAUNCH-AUDIT.md, 2026-11-08): every finding fixed in the engine has a test here
 * that failed before the fix. Orders left on SoDEX with nobody managing them (A1), positions left open without a loss
 * limit (A2), more risk than the user signed for (A3), wrong numbers (B) and the low ones (C).
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  AlgoFeed,
  AlgoRuntime,
  MemoryAlgoStore,
  silentLogger,
  checkAlgoSpec,
  parseAlgoSpec,
  checkSizes,
  botReserveUsd,
  botMarginUsd,
  mmQuotes,
  readBatch,
  cancelFailures,
  algoName,
  BOT_FEE,
  type AlgoMarket,
  type AlgoRecord,
  type AlgoSink,
  type ChildRequest,
  type ChildResult,
  type EngineNotice,
  type MarkInfo,
  type MarketInfo,
  type OrderUpdate,
  type Print,
  type Quote,
  type RegionPolicy,
  type SodexClient,
  type WebSocketLike,
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
  /** When the quote was last heard of (null: now). */
  qAt: number | null = null;
  orderCbs: Array<(u: OrderUpdate) => void> = [];
  printCbs: Array<(p: Print) => void> = [];
  start(): void {}
  stop(): void {}
  watch(): void {}
  set(bid: number, ask: number): void {
    this.q = { bid, ask, at: Date.now() };
    this.mk = (bid + ask) / 2;
  }
  quote(): Quote | null {
    return { ...this.q, at: this.qAt ?? Date.now() };
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
  onPrint(cb: (p: Print) => void): void {
    this.printCbs.push(cb);
  }
  print(p: Partial<Print> & { price: number; qty: number }): void {
    for (const cb of this.printCbs) cb({ symbol: 'BTC-USD', buyer: 5, seller: 6, taker: 'sell', at: Date.now(), ...p });
  }
  onOrder(cb: (u: OrderUpdate) => void): void {
    this.orderCbs.push(cb);
  }
  onState(): void {}
  order(u: Partial<OrderUpdate> & { clOrdID: string }): void {
    for (const cb of this.orderCbs) cb({ orderId: '1', symbol: 'BTC-USD', status: 'NEW', filledQty: 0, filledValue: 0, maker: null, reason: null, at: Date.now(), ...u });
  }
}

type Rest = ChildRequest & { filled: number };

class Exchange implements AlgoSink {
  readonly paper = false;
  placed: ChildRequest[] = [];
  cancelled: string[] = [];
  resting = new Map<string, Rest>();
  position = 0;
  /** Answer every placement with this refusal. */
  refuse: string | null = null;
  /** This many cancels throw. */
  cancelFail = 0;
  /** setLeverage throws while true. */
  levFail = false;
  constructor(private readonly m: FakeMarket) {}
  async place(_a: AlgoRecord, _mk: MarketInfo, orders: ChildRequest[]): Promise<ChildResult[]> {
    if (this.refuse) return orders.map((o) => ({ clOrdID: o.clOrdID, ok: false, orderId: null, error: this.refuse, outcomeUnknown: false }));
    this.placed.push(...orders);
    for (const o of orders) {
      const q = this.m.q;
      const touch = o.side === 'buy' ? q.ask : q.bid;
      const crosses = o.side === 'buy' ? Number(o.price) >= touch : Number(o.price) <= touch;
      if (o.tif === 'gtx' && crosses) setImmediate(() => this.m.order({ clOrdID: o.clOrdID, status: 'REJECTED', reason: 'post only order would take' }));
      else if (o.tif === 'ioc') {
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
    if (this.cancelFail > 0) {
      this.cancelFail--;
      throw new Error('gateway timeout');
    }
    this.cancelled.push(...ids);
    for (const id of ids) {
      const r = this.resting.get(id);
      if (!r) continue;
      this.resting.delete(id);
      setImmediate(() => this.m.order({ clOrdID: id, status: 'CANCELED', filledQty: r.filled, filledValue: r.filled * Number(r.price) }));
    }
  }
  async setLeverage(): Promise<void> {
    if (this.levFail) throw new Error('leverage change refused');
  }
  async placeStops(): Promise<ChildResult[]> {
    return [];
  }
  fill(id: string, qty?: number): void {
    const r = this.resting.get(id)!;
    const q = qty ?? Number(r.quantity) - r.filled;
    r.filled += q;
    this.position += (r.side === 'buy' ? 1 : -1) * q;
    const done = r.filled >= Number(r.quantity) - 1e-12;
    if (done) this.resting.delete(id);
    this.m.order({ clOrdID: id, status: done ? 'FILLED' : 'PARTIALLY_FILLED', filledQty: r.filled, filledValue: r.filled * Number(r.price), maker: true });
  }
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
  noSink: boolean;
  keyExp: number | null;
  makerBp: number | null;
  policy: RegionPolicy | null;
  equity: number;
  notices: EngineNotice[];
}

async function rig(o: { market?: MarketInfo } = {}): Promise<Rig> {
  const market = new FakeMarket();
  const mkt = o.market ?? MKT;
  const r: Rig = { rt: null as unknown as AlgoRuntime, market, ex: new Exchange(market), store: new MemoryAlgoStore(), brake: null, noSink: false, keyExp: null, makerBp: null, policy: null, equity: 1_000_000, notices: [] };
  const sodex = {
    markets: async () => [mkt],
    follower: async () => ({ equity: r.equity, positions: { 'BTC-USD': { size: r.ex.position, entry: 60_000, leverage: 1, leverageReported: true } } }),
    fills: async () => [],
    get: async () => [],
  } as unknown as SodexClient;
  r.rt = new AlgoRuntime({
    confirmGapMs: 0,
    store: r.store,
    sodex,
    network: 'mainnet',
    market,
    sinkFor: () => (r.noSink ? null : r.ex),
    log: silentLogger,
    autoTick: false,
    builderRate: () => BOT_FEE / 100_000,
    brake: () => r.brake,
    problem: async () => null,
    keyExpiresAt: () => r.keyExp,
    makerFeeFor: () => r.makerBp,
    policyFor: () => r.policy,
    account: async () => ({ equity: r.equity, gross: 0 }),
    onNotice: (n) => r.notices.push(n),
    lookup: async (_a, _s, history) =>
      [...r.ex.resting.values()].filter(() => !history).map((x) => ({ clOrdID: x.clOrdID, orderId: '1', status: 'NEW', executedQty: x.filled, executedValue: x.filled * Number(x.price) })),
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

async function tick(r: Rig, advanceMs = 0): Promise<void> {
  clock += advanceMs;
  r.rt.tick(clock);
  await settle();
  await settle();
}

const add = (r: Rig, spec: Record<string, unknown>, extra: { takeOver?: string } = {}) => r.rt.add({ owner: FOLLOWER, accountId: 42, mode: 'hosted', spec: { symbol: 'BTC-USD', ...spec }, seed: 7, ...extra });
const MM = { kind: 'mm', orderUsd: 60, maxInventoryUsd: 180, chaseTicks: 2, minRepriceMs: 3_000, skewTicks: 4, maxLossUsd: 1_000_000 };
const LIVE = new Set(['sending', 'open', 'unknown']);
const liveKids = (a: AlgoRecord) => a.children.filter((c) => LIVE.has(c.state));

/** A volume maker that holds one filled bid. */
async function holding(r: Rig, spec: Record<string, unknown> = {}): Promise<AlgoRecord> {
  const a = await add(r, { ...MM, ...spec });
  await step(r, a.id);
  r.ex.fill(r.ex.side('buy')[0]!.clOrdID);
  await settle();
  return r.rt.get(a.id)!;
}

/* ------------------------------------------------------------- A1: orders left on SoDEX ----- */

test('A1: a stop with no key here leaves its quotes not "cancelling"; the ended bot cancels them again once the key is back', async () => {
  const r = await rig();
  const a = await add(r, { ...MM, onStop: 'keep' });
  await step(r, a.id);
  assert.equal(r.ex.resting.size, 2);
  r.noSink = true;
  await r.rt.cancel(a.id);
  await settle();
  const ended = r.rt.get(a.id)!;
  assert.equal(ended.status, 'cancelled');
  assert.equal(liveKids(ended).length, 2);
  assert.ok(liveKids(ended).every((c) => !c.cancelling), 'nothing was cancelled, so nothing is cancelling');
  r.noSink = false;
  await tick(r, 6_000);
  assert.equal(r.ex.resting.size, 0, 'cancelled again on the timer');
  assert.equal(liveKids(r.rt.get(a.id)!).length, 0);
});

test('A1: a cancel that throws on stop is tried again on the timer for the ended bot', async () => {
  const r = await rig();
  const a = await add(r, { ...MM, onStop: 'keep' });
  await step(r, a.id);
  r.ex.cancelFail = 1;
  await r.rt.cancel(a.id);
  await settle();
  assert.equal(r.rt.get(a.id)!.status, 'cancelled');
  assert.equal(r.ex.resting.size, 2, 'the cancel failed');
  await tick(r, 6_000);
  assert.equal(r.ex.resting.size, 0);
});

test('A1: readBatch - a child with no row is unknown, a whole-batch refusal refuses every child', () => {
  const orders: ChildRequest[] = ['a', 'b'].map((id) => ({ clOrdID: id, side: 'buy', price: '1', quantity: '1', tif: 'gtx', reduceOnly: false }));
  const part = readBatch([{ code: 0, clOrdID: 'a', orderID: 7 }], orders);
  assert.deepEqual(part.map((x) => [x.ok, x.outcomeUnknown]), [[true, false], [false, true]]);
  const whole = readBatch([{ code: 1001, clOrdID: '', error: 'invalid batch' }], orders);
  assert.ok(whole.every((x) => !x.ok && !x.outcomeUnknown && x.error === 'invalid batch'));
  const own = readBatch([{ code: 0, clOrdID: 'a' }, { code: 5, clOrdID: 'b', error: 'post only' }], orders);
  assert.deepEqual(own.map((x) => x.ok), [true, false]);
});

test('A1: a cancel answer - rows refused for another reason than "gone" are failures', () => {
  assert.deepEqual(cancelFailures([{ code: 0, clOrdID: 'a' }, { code: 3, clOrdID: 'b', error: 'order not found' }]), []);
  assert.equal(cancelFailures({ orders: [{ code: 9, clOrdID: 'c', error: 'busy' }] }).length, 1);
});

test('A1: ten minutes before the key expires a bot pulls its quotes, opens nothing, warns once; a close still goes out', async () => {
  const r = await rig();
  const a = await holding(r);
  await step(r, a.id, 500);
  assert.ok(r.ex.resting.size >= 1);
  r.keyExp = clock + 5 * 60_000;
  await step(r, a.id, 500);
  assert.equal(r.ex.resting.size, 0, 'quotes pulled while the key still signs');
  assert.match(r.rt.get(a.id)!.statusReason ?? '', /expires/);
  const placed = r.ex.placed.length;
  await step(r, a.id, 6_000);
  assert.equal(r.ex.placed.length, placed, 'nothing new');
  assert.equal(r.notices.filter((n) => n.kind === 'key-expiry' && n.grade === 'warn').length, 1, 'one warning');
  await r.rt.cancel(a.id);
  await step(r, a.id, 500);
  const close = r.ex.placed.slice(placed);
  assert.ok(close.length >= 1 && close.every((o) => o.reduceOnly), 'the reduce-only close goes out');
});

/* ------------------------------------------------- A2: positions left without a loss limit ----- */

test('A2: a bound that stops a bot closes what it holds (onStop close) instead of ending with it open', async () => {
  const r = await rig();
  const a = await holding(r, { upper: { price: 61_000, then: 'stop' } });
  r.market.set(61_500, 61_502);
  const b = await step(r, a.id, 500);
  assert.ok(b.k.closing, 'closing');
  assert.equal(b.status === 'running' || b.status === 'waiting', true);
  await step(r, a.id, 500);
  assert.ok(r.ex.placed.some((o) => o.reduceOnly), 'a reduce-only close placed');
});

test('refusals a bot understands never stop it: margin refusals hold what adds, what reduces goes on (owner 2026-11-08)', async () => {
  const r = await rig();
  const a = await holding(r);
  r.ex.refuse = 'insufficient margin';
  for (let i = 0; i < 30; i++) await step(r, a.id, 61_000);
  const b = r.rt.get(a.id)!;
  assert.equal(b.status, 'running');
  assert.ok(!b.k.closing, 'not closing: margin is not a reason to stop');
  assert.ok(Number(b.k.consecRejects ?? 0) === 0, 'not counted');
  r.ex.refuse = null;
  await step(r, a.id, 31_000);
  assert.ok(r.ex.placed.length > 0, 'it quotes again once SoDEX takes orders');
});

test('refusals nothing handles: a bot waits (quotes pulled) between rounds; only after the last round it closes what it holds - even set to keep - and stops', async () => {
  const r = await rig();
  const a = await holding(r, { onStop: 'keep' });
  r.ex.refuse = 'something odd happened';
  for (let i = 0; i < 400 && !r.rt.get(a.id)!.k.closing && !['failed', 'cancelled'].includes(r.rt.get(a.id)!.status); i++) await step(r, a.id, 20_000);
  const b = r.rt.get(a.id)!;
  assert.ok(Number(b.k.failRounds ?? 0) >= 4 || b.k.closing, 'went through its rounds');
  assert.ok(b.k.closing, 'closing what it holds although On stop is keep');
  r.ex.refuse = null;
  for (let i = 0; i < 5; i++) await step(r, a.id, 61_000);
  assert.ok(r.ex.placed.some((o) => o.reduceOnly), 'the close goes out');
});

test('A2: the close is not given up for post-only refusals; three position refusals end it', async () => {
  const r = await rig();
  const a = await holding(r);
  await r.rt.cancel(a.id);
  r.ex.refuse = 'post only order would take';
  for (let i = 0; i < 6; i++) await step(r, a.id, 31_000);
  assert.ok(r.rt.get(a.id)!.k.closing, 'still closing');
  // Closed on SoDEX by hand: the account reads flat, so the refusals say the holding is gone (not a position of yours).
  r.ex.position = 0;
  r.ex.refuse = 'reduce only order rejected: no position';
  for (let i = 0; i < 4; i++) await step(r, a.id, 31_000);
  const b = r.rt.get(a.id)!;
  assert.equal(b.status, 'cancelled');
  assert.match(b.statusReason ?? '', /not there/);
});

test('A2: the loss limit bites under the brake, and the reduce-only close goes out under it', async () => {
  const r = await rig();
  const a = await holding(r, { maxLossUsd: 1 });
  r.brake = 'operator brake';
  r.market.set(58_000, 58_002);
  const b = await step(r, a.id, 500);
  assert.ok(b.k.closing, 'the loss limit was checked while braked');
  await step(r, a.id, 500);
  const close = r.ex.placed.filter((o) => o.reduceOnly);
  assert.ok(close.length >= 1, 'a reduce-only close placed under the brake');
});

test('A2: a paused bot whose end time comes closes what it holds', async () => {
  const r = await rig();
  const a = await holding(r, { endAt: T0 + 10 * 60_000 });
  await r.rt.pause(a.id);
  await settle();
  const b = await step(r, a.id, 11 * 60_000);
  assert.ok(b.k.closing);
  assert.notEqual(b.status, 'paused');
  await step(r, a.id, 500);
  assert.ok(r.ex.placed.some((o) => o.reduceOnly));
});

test('A2: a real bot needs a loss limit; practice does not', () => {
  assert.ok(checkAlgoSpec({ kind: 'mm', symbol: 'BTC-USD', orderUsd: 50, maxInventoryUsd: 200 }).errors.maxLossUsd);
  assert.ok(checkAlgoSpec({ kind: 'grid', symbol: 'BTC-USD', low: 50_000, high: 70_000, levels: 10, orderUsd: 20 }).errors.maxLossUsd);
  assert.ok(parseAlgoSpec({ kind: 'mm', symbol: 'BTC-USD', orderUsd: 50, maxInventoryUsd: 200, paper: true }));
});

/* ----------------------------------------------------------- A3: more risk than signed ----- */

const BIGMIN: MarketInfo = { ...MKT, minNotional: 100 };

test('A3: sizes, reserve and margin count the real quote (SoDEX minimum); a cap under one quote is refused', () => {
  const tiny = parseAlgoSpec({ kind: 'mm', symbol: 'BTC-USD', orderUsd: 12, maxInventoryUsd: 50, maxLossUsd: 10 });
  assert.ok(checkSizes(tiny, BIGMIN, { price: 60_000, seed: 1 }).errors.length, 'cap under one $100 quote');
  const ok = parseAlgoSpec({ kind: 'mm', symbol: 'BTC-USD', orderUsd: 12, maxInventoryUsd: 150, maxLossUsd: 10, leverage: 10 });
  assert.equal(checkSizes(ok, BIGMIN, { price: 60_000, seed: 1 }).errors.length, 0);
  assert.equal(botReserveUsd(ok), 150 + 24, 'old signature unchanged');
  assert.equal(botReserveUsd(ok, 100), 150 + 200);
  assert.equal(botMarginUsd(ok, 100), 35);
  assert.equal(botMarginUsd(ok, 100, 2), 175, 'the region ceiling (EEA 2x) caps the leverage it is counted at');
});

test('A3: quotes on a market with a large minimum - the cap counts the real size; the unwinding quote is reduce-only and never over what it holds', () => {
  const s = { orderUsd: 12, maxInventoryUsd: 150, offsetTicks: 0, skewTicks: 0 };
  const q = { bid: 60_000, ask: 60_002, at: 0 };
  const long = mmQuotes(s, q, BIGMIN, 0.002, 60_000);
  assert.ok(!long.some((x) => x.side === 'buy'), '$120 held + a $100 quote is over the $150 cap');
  const ask = long.find((x) => x.side === 'sell')!;
  assert.ok(ask.reduceOnly && ask.quantity <= 0.002 + 1e-12);
  const small = mmQuotes(s, q, BIGMIN, 0.001, 60_000);
  assert.ok(!small.some((x) => x.side === 'sell'), '$60 held is under the minimum: no ask that would flip it');
});

test('A3: a leverage change SoDEX refused holds what opens; it goes out once leverage is set', async () => {
  const r = await rig();
  const a = await add(r, { ...MM, leverage: 3 });
  r.ex.levFail = true;
  const b = await step(r, a.id);
  assert.equal(r.ex.placed.length, 0);
  assert.match(b.statusReason ?? '', /did not set 3x/);
  r.ex.levFail = false;
  await step(r, a.id, 500);
  assert.equal(r.ex.placed.length, 0, 'asked again only after a wait (no change sent every step)');
  await step(r, a.id, 61_000);
  assert.equal(r.ex.placed.length, 2);
});

test('A3: the region leverage ceiling counts each side of a two-sided batch on its own', async () => {
  const r = await rig();
  r.policy = { region: 'eea', allowed: true, maxLeverage: 2, reason: null, country: 'DE', mismatch: false } as unknown as RegionPolicy;
  r.equity = 50; // room $100: each $60 side fits, both together ($120) would not
  const a = await add(r, MM);
  await step(r, a.id);
  assert.deepEqual(r.ex.placed.map((o) => o.side).sort(), ['buy', 'sell']);
});

test('A3: SoDEX position limit - a long at its limit still quotes the ask (each side checked on its own)', async () => {
  const r = await rig({ market: { ...MKT, marginTiers: [{ maxNotionalValue: 100, maxLeverage: 50 }] } });
  r.ex.position = 0.0015; // ~$90 long of a $100 limit, held outside the bot
  const a = await add(r, MM);
  await step(r, a.id);
  assert.deepEqual(r.ex.placed.map((o) => o.side), ['sell']);
});

test('A3: a take-over waits until the old bot has nothing live on SoDEX', async () => {
  const r = await rig();
  const old = await add(r, { ...MM, onStop: 'keep' });
  await step(r, old.id);
  r.noSink = true;
  await r.rt.cancel(old.id);
  await settle();
  const b = await add(r, MM, { takeOver: old.id });
  assert.equal((await step(r, b.id)).status, 'scheduled', 'the old one still has quotes on SoDEX');
  r.noSink = false;
  await tick(r, 6_000);
  assert.equal(r.ex.resting.size, 0);
  assert.notEqual((await step(r, b.id, 500)).status, 'scheduled');
});

test('A3: a grid level cut short after a partial fill places its counterpart for the part that filled', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'grid', low: 59_000, high: 61_000, levels: 5, orderUsd: 30, spacing: 'linear', maxLossUsd: 1_000 });
  await step(r, a.id);
  const lvl = r.ex.side('buy').find((o) => Number(o.price) === 59_500)!;
  r.ex.fill(lvl.clOrdID, 0.00025);
  await settle();
  await r.rt.pause(a.id);
  await settle();
  r.market.set(59_990, 59_992);
  await r.rt.resume(a.id);
  const before = r.ex.placed.length;
  await step(r, a.id, 500);
  const fresh = r.ex.placed.slice(before);
  const sell = fresh.find((o) => o.side === 'sell' && Number(o.price) === 60_000);
  assert.ok(sell, 'the counterpart one level up');
  assert.equal(Number(sell!.quantity), 0.00025);
  const buy = fresh.find((o) => o.side === 'buy' && Number(o.price) === 59_500);
  assert.equal(Number(buy!.quantity), 0.00025, 'the level rests for what it did not fill');
});

/* ------------------------------------------------------------------- B: numbers ----- */

test('B: a resting fill is booked at the wallet\'s own maker fee when the host knows it', async () => {
  const r = await rig();
  r.makerBp = 0.5;
  const a = await holding(r);
  const v = r.rt.view(a.id)!.bot!;
  assert.ok(Math.abs(v.tradeFees - v.volume * 0.00005) < 1e-12);
});

test('B: a manual stop takes a last point; a bot that kept its position stops moving at the stop', async () => {
  const r = await rig();
  const a = await holding(r, { onStop: 'keep' });
  clock += 60_000;
  await r.rt.cancel(a.id);
  await settle();
  const ended = r.rt.get(a.id)!;
  assert.equal(ended.book!.series[ended.book!.series.length - 1]![0], clock, 'a point at the stop');
  const pnl = r.rt.view(a.id)!.bot!.netPnl;
  r.market.set(50_000, 50_002);
  assert.equal(r.rt.view(a.id)!.bot!.netPnl, pnl);
});

/* ------------------------------------------------------------------- C: the low ones ----- */

test('C: an ended bot is not credited the takers of a later fill on its account', async () => {
  const r = await rig();
  const a = await holding(r, { onStop: 'keep' });
  await r.rt.cancel(a.id);
  await settle();
  const before = JSON.stringify(r.rt.get(a.id)!.book!.takers ?? null);
  r.market.print({ price: 60_000, qty: 0.001, buyer: 42, seller: 1002, taker: 'sell' });
  assert.equal(JSON.stringify(r.rt.get(a.id)!.book!.takers ?? null), before);
});

test('C: a volume maker quote refused later on the socket backs off like one refused in the answer', async () => {
  const r = await rig();
  const a = await add(r, MM);
  await step(r, a.id);
  const bid = r.ex.side('buy')[0]!;
  r.ex.resting.delete(bid.clOrdID);
  r.market.order({ clOrdID: bid.clOrdID, status: 'REJECTED', reason: 'post only order would take' });
  await settle();
  await step(r, a.id, 100);
  assert.equal(r.ex.placed.filter((o) => o.side === 'buy').length, 1, 'not sent again at once');
  await step(r, a.id, 600);
  assert.equal(r.ex.placed.filter((o) => o.side === 'buy').length, 2, 'after the back-off');
});

test('C: a bot holds on a quote older than 3 s', async () => {
  const r = await rig();
  const a = await add(r, MM);
  r.market.qAt = clock - 5_000;
  const b = await step(r, a.id);
  assert.equal(r.ex.placed.length, 0);
  assert.match(b.statusReason ?? '', /price/);
});

test('C: the feed reads a still market\'s best prices by REST', async () => {
  const factory = (): WebSocketLike => ({ readyState: 0, send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null }) as unknown as WebSocketLike;
  const feed = new AlgoFeed({ network: 'mainnet', factory, wsOrigin: 'wss://x', bookTickers: async () => [{ symbol: 'BTC-USD', bidPx: '100', askPx: '101' }] });
  feed.watch(['BTC-USD'], []);
  assert.equal(feed.quote('BTC-USD'), null);
  await feed.refreshQuotes(clock);
  assert.deepEqual([feed.quote('BTC-USD')?.bid, feed.quote('BTC-USD')?.ask], [100, 101]);
});

test('C: paper fills need a trade through the price, and one print fills its size once, first placed first', async () => {
  const r = await rig();
  const x = await add(r, { ...MM, paper: true });
  const y = await add(r, { ...MM, paper: true });
  await step(r, x.id);
  await step(r, y.id);
  const qty = r.rt.get(x.id)!.children.find((c) => c.side === 'buy')!.quantity;
  r.market.print({ price: 60_000, qty: 1, taker: 'sell' });
  await settle();
  assert.equal(r.rt.get(x.id)!.book!.fills + r.rt.get(y.id)!.book!.fills, 0, 'a print at the price fills nothing');
  r.market.print({ price: 59_999, qty, taker: 'sell' });
  await settle();
  assert.equal(r.rt.get(x.id)!.book!.fills, 1);
  assert.equal(r.rt.get(y.id)!.book!.fills, 0, 'the print\'s size went to the first');
});

test('notices: a bot is named by its label, else "Market maker / Grid on SYMBOL" - never a side', async () => {
  const r = await rig();
  const a = await add(r, MM);
  assert.equal(algoName(a), 'Market maker on BTC-USD');
  const g = await add(r, { kind: 'grid', low: 59_000, high: 61_000, levels: 5, orderUsd: 30, maxLossUsd: 100, label: 'My grid' });
  assert.equal(algoName(g), 'My grid');
});

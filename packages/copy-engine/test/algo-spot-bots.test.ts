/**
 * Spot bots (2026-11-19): a volume maker and a grid on a SoDEX spot market ('vBTC_vUSDC'). Spot cannot go short: the
 * bot sells only what it bought itself, never coin the wallet held before it; its fees are the spot market's own, the
 * builder fee is booked on sells only (as SoDEX charges it), and its orders go out as spot orders.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  AlgoRuntime,
  MemoryAlgoStore,
  silentLogger,
  checkAlgoSpec,
  parseAlgoSpec,
  engineOf,
  isSpotMarket,
  isSpotSpec,
  isSpotBotSymbol,
  bookInventory,
  childrenAction,
  spotCancelAction,
  spotCancelAnswer,
  parseSpotMarkets,
  ALLOWED_WRITES,
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
import { FOLLOWER } from './helpers.ts';

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

const SYM = 'vBTC_vUSDC';
/** As SoDEX lists it (GET /api/v1/spot/markets/symbols, 2026-11-19). */
const SPOT_ROW = { id: 1, name: SYM, baseCoin: 'vBTC', quoteCoin: 'vUSDC', tickSize: '1', stepSize: '0.00001', minQuantity: '0.00001', maxQuantity: '0', marketMaxQuantity: '0', minNotional: '5', maxNotional: '0', buyLimitUpRatio: '1', sellLimitDownRatio: '0.5', makerFee: '0.00035', takerFee: '0.00065', status: 'TRADING' };
const SPOT: MarketInfo = parseSpotMarkets([SPOT_ROW])[0]!;

class FakeMarket implements AlgoMarket {
  readonly up = true;
  q: Quote = { bid: 60_000, ask: 60_002, at: 0 };
  orderCbs: Array<(u: OrderUpdate) => void> = [];
  printCbs: Array<(p: Print) => void> = [];
  watched: { symbols: string[]; owners: string[]; spot: string[] } = { symbols: [], owners: [], spot: [] };
  start(): void {}
  stop(): void {}
  watch(symbols: readonly string[], owners: readonly string[], spot: readonly string[] = []): void {
    this.watched = { symbols: [...symbols], owners: [...owners], spot: [...spot] };
  }
  set(bid: number, ask: number): void {
    this.q = { bid, ask, at: Date.now() };
  }
  quote(): Quote | null {
    return { ...this.q, at: Date.now() };
  }
  last() {
    return { price: (this.q.bid + this.q.ask) / 2, at: Date.now() };
  }
  /** Spot has no mark: the feed gives the mid (AlgoFeed.mark). */
  mark(): MarkInfo | null {
    const mid = (this.q.bid + this.q.ask) / 2;
    return { mark: mid, index: null, funding: null, oi: null, at: Date.now() };
  }
  price(): number | null {
    return (this.q.bid + this.q.ask) / 2;
  }
  priceAgo(): number | null {
    return null;
  }
  oiAgo(): number | null {
    return null;
  }
  volume() {
    return { qty: 0, usd: 0 };
  }
  onPrint(cb: (p: Print) => void): void {
    this.printCbs.push(cb);
  }
  print(p: Partial<Print> & { price: number; qty: number }): void {
    for (const cb of this.printCbs) cb({ symbol: SYM, buyer: 5, seller: 6, taker: 'sell', at: Date.now(), ...p });
  }
  onOrder(cb: (u: OrderUpdate) => void): void {
    this.orderCbs.push(cb);
  }
  onState(): void {}
  order(u: Partial<OrderUpdate> & { clOrdID: string }): void {
    for (const cb of this.orderCbs) cb({ orderId: '1', symbol: SYM, status: 'NEW', filledQty: 0, filledValue: 0, maker: null, reason: null, at: Date.now(), ...u });
  }
}

type Rest = ChildRequest & { filled: number };

/** SoDEX's spot exchange for one wallet: it holds `coin` vBTC from before the bot. */
class SpotExchange implements AlgoSink {
  readonly paper = false;
  placed: Array<ChildRequest & { engine: string | undefined }> = [];
  resting = new Map<string, Rest>();
  leverage = 0;
  stops = 0;
  coin = 5;
  constructor(private readonly m: FakeMarket) {}
  async place(_a: AlgoRecord, mk: MarketInfo, orders: ChildRequest[]): Promise<ChildResult[]> {
    for (const o of orders) {
      this.placed.push({ ...o, engine: mk.engine });
      const q = this.m.q;
      const touch = o.side === 'buy' ? q.ask : q.bid;
      const crosses = o.side === 'buy' ? Number(o.price) >= touch : Number(o.price) <= touch;
      if (o.tif === 'gtx' && crosses) setImmediate(() => this.m.order({ clOrdID: o.clOrdID, status: 'REJECTED', reason: 'post only order would take' }));
      else if (o.tif === 'ioc') {
        const qty = crosses ? Number(o.quantity) : 0;
        this.coin += (o.side === 'buy' ? 1 - (mk.takerFee ?? 0) : -1) * qty;
        setImmediate(() => this.m.order({ clOrdID: o.clOrdID, status: qty > 0 ? 'FILLED' : 'CANCELED', filledQty: qty, filledValue: qty * touch, maker: false }));
      } else {
        this.resting.set(o.clOrdID, { ...o, filled: 0 });
        setImmediate(() => this.m.order({ clOrdID: o.clOrdID, status: 'NEW' }));
      }
    }
    return orders.map((o) => ({ clOrdID: o.clOrdID, ok: true, orderId: '1', error: null, outcomeUnknown: false }));
  }
  async cancel(_a: AlgoRecord, _m: MarketInfo, ids: string[]): Promise<void> {
    for (const id of ids) {
      const r = this.resting.get(id);
      if (!r) continue;
      this.resting.delete(id);
      setImmediate(() => this.m.order({ clOrdID: id, status: 'CANCELED', filledQty: r.filled, filledValue: r.filled * Number(r.price) }));
    }
  }
  async setLeverage(): Promise<void> {
    this.leverage++;
  }
  async placeStops(): Promise<ChildResult[]> {
    this.stops++;
    return [];
  }
  fill(id: string): void {
    const r = this.resting.get(id)!;
    const q = Number(r.quantity) - r.filled;
    r.filled += q;
    this.coin += (r.side === 'buy' ? 1 - (SPOT.makerFee ?? 0) : -1) * q;
    this.resting.delete(id);
    this.m.order({ clOrdID: id, status: 'FILLED', filledQty: r.filled, filledValue: r.filled * Number(r.price), maker: true });
  }
  side(side: 'buy' | 'sell'): Rest[] {
    return [...this.resting.values()].filter((r) => r.side === side);
  }
}

interface Rig {
  rt: AlgoRuntime;
  market: FakeMarket;
  ex: SpotExchange;
}

async function rig(): Promise<Rig> {
  const market = new FakeMarket();
  const r: Rig = { rt: null as unknown as AlgoRuntime, market, ex: new SpotExchange(market) };
  const sodex = {
    markets: async () => [],
    spotMarkets: async () => [SPOT],
    spotBalances: async () => ({ vBTC: { total: r.ex.coin, locked: 0 }, vUSDC: { total: 100_000, locked: 0 } }),
    follower: async () => {
      throw new Error('a spot bot reads no perps account');
    },
    fills: async () => [],
    get: async () => [],
  } as unknown as SodexClient;
  r.rt = new AlgoRuntime({
    confirmGapMs: 0,
    store: new MemoryAlgoStore(),
    sodex,
    network: 'mainnet',
    market,
    sinkFor: () => r.ex,
    log: silentLogger,
    autoTick: false,
    builderRate: () => BOT_FEE / 100_000,
    // A perps maker tier the spot bot must NOT use.
    makerFeeFor: () => 0.5,
    problem: async () => null,
    lookup: async (_a, _s, history) => [...r.ex.resting.values()].filter(() => !history).map((x) => ({ clOrdID: x.clOrdID, orderId: '1', status: 'NEW', executedQty: x.filled, executedValue: x.filled * Number(x.price) })),
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

const add = (r: Rig, spec: Record<string, unknown>) => r.rt.add({ owner: FOLLOWER, accountId: 42, mode: 'hosted', spec: { symbol: SYM, engine: 'spot', ...spec }, seed: 7 });
const MM = { kind: 'mm', orderUsd: 60, maxInventoryUsd: 180, chaseTicks: 2, minRepriceMs: 3_000, skewTicks: 4, maxLossUsd: 1_000_000 };
const GRID = { kind: 'grid', low: 59_000, high: 61_000, levels: 5, orderUsd: 60, spacing: 'linear', maxLossUsd: 1_000_000 };
const LIVE = new Set(['sending', 'open', 'unknown']);
const liveKids = (a: AlgoRecord) => a.children.filter((c) => LIVE.has(c.state));
const sold = (a: AlgoRecord) => a.book!.sellQty;
/** What the bot bought, net of the coin SoDEX kept as the fee. */
const boughtNet = (a: AlgoRecord) => a.book!.buyQty + (a.book!.carryQty ?? 0);

/* ------------------------------------------------------------------ the spec ----- */

test('spec: engine is always set (perps by default, an old spec without it is perps), spot keeps the market name as SoDEX writes it', () => {
  const p = parseAlgoSpec({ ...MM, symbol: 'btc-usd' });
  assert.equal((p as { engine?: string }).engine, 'perps');
  assert.equal(p.symbol, 'BTC-USD');
  const s = parseAlgoSpec({ ...MM, symbol: SYM, engine: 'spot' });
  assert.equal((s as { engine?: string }).engine, 'spot');
  assert.equal(s.symbol, SYM);
  assert.equal(isSpotSpec(s), true);
  // A spec stored before engines: perps.
  assert.equal(engineOf({ kind: 'mm' }), 'perps');
  assert.equal(engineOf({ kind: 'twap', engine: 'spot' } as never), 'perps');
  assert.equal(isSpotMarket(SYM), true);
  assert.equal(isSpotMarket('BTC-USD'), false);
  assert.equal(isSpotBotSymbol('WSOSO_vUSDC'), true);
  assert.equal(isSpotBotSymbol('vUSDT_vUSDC'), false);
});

test('spec: a spot market with perps, a perps market with spot, and what spot does not have are field errors', () => {
  assert.ok(checkAlgoSpec({ ...MM, symbol: SYM }).errors.symbol, 'a spot name on perps');
  assert.ok(checkAlgoSpec({ ...MM, symbol: 'BTC-USD', engine: 'spot' }).errors.symbol, 'a perps name on spot');
  assert.ok(checkAlgoSpec({ ...MM, symbol: 'vUSDT_vUSDC', engine: 'spot' }).errors.symbol, 'the dollar pair');
  assert.ok(checkAlgoSpec({ ...MM, symbol: SYM, engine: 'spot', leverage: 2 }).errors.leverage);
  assert.ok(checkAlgoSpec({ ...MM, symbol: SYM, engine: 'spot', marginMode: 'isolated' }).errors.marginMode);
  assert.ok(checkAlgoSpec({ ...MM, symbol: SYM, engine: 'spot', reduceOnly: true }).errors.reduceOnly);
  assert.ok(checkAlgoSpec({ ...MM, symbol: SYM, engine: 'spot', ref: 'binance' }).errors.ref);
  assert.ok(checkAlgoSpec({ ...MM, symbol: SYM, engine: 'moon' }).errors.engine);
  // Only a volume maker or a grid trades spot.
  assert.ok(checkAlgoSpec({ kind: 'twap', symbol: SYM, side: 'buy', quantity: '1', durationMs: 600_000, slices: 5 }).errors.symbol);
  // A spot grid is a long grid: set or not; neutral or short refused.
  const g = parseAlgoSpec({ ...GRID, symbol: SYM, engine: 'spot' });
  assert.equal((g as { direction?: string }).direction, 'long');
  assert.ok(checkAlgoSpec({ ...GRID, symbol: SYM, engine: 'spot', direction: 'short' }).errors.direction);
  assert.ok(checkAlgoSpec({ ...GRID, symbol: SYM, engine: 'spot', direction: 'neutral' }).errors.direction);
});

test('markets: the spot list keeps its own fees and coin names; the sink signs spot orders and spot cancels', () => {
  assert.equal(SPOT.engine, 'spot');
  assert.equal(SPOT.base, 'vBTC');
  assert.equal(SPOT.quote, 'vUSDC');
  assert.equal(SPOT.makerFee, 0.00035);
  assert.equal(SPOT.takerFee, 0.00065);
  assert.equal(SPOT.maxLeverage, 1);
  // A market with no listed fee is left out (no assumed fee).
  assert.equal(parseSpotMarkets([{ ...SPOT_ROW, takerFee: undefined }]).length, 0);
  const act = childrenAction(42, SPOT, [{ clOrdID: 'va-x-1', side: 'sell', price: '60001', quantity: '0.001', tif: 'gtx', reduceOnly: true }], { id: 234812, fee: 10 });
  assert.equal(act.engine, 'spot');
  assert.equal(act.type, 'batchNewOrder');
  const order = (act.params as { orders: Array<Record<string, unknown>> }).orders[0]!;
  assert.equal(order.symbolID, 1);
  assert.equal('reduceOnly' in order, false, 'spot has no reduce-only flag');
  const { action, orig } = spotCancelAction(42, [{ symbolID: 1, clOrdID: 'va-x-1' }]);
  assert.equal(action.engine, 'spot');
  assert.equal(action.type, 'batchCancelOrder');
  const c = (action.params as { cancels: Array<{ clOrdID: string; origClOrdID: string }> }).cancels[0]!;
  assert.equal(c.origClOrdID, 'va-x-1');
  assert.notEqual(c.clOrdID, 'va-x-1');
  // A row naming the cancel's own id reads as the order's.
  const rows = spotCancelAnswer([{ clOrdID: c.clOrdID, code: 1, error: 'order not found' }], orig) as Array<{ clOrdID: string }>;
  assert.equal(rows[0]!.clOrdID, 'va-x-1');
  assert.ok(ALLOWED_WRITES.some((w) => w.method === 'POST' && w.path === '/api/v1/spot/trade/orders/batch'));
  assert.ok(ALLOWED_WRITES.some((w) => w.method === 'DELETE' && w.path === '/api/v1/spot/trade/orders/batch'));
});

/* ------------------------------------------------------------- practice ----- */

test('practice spot volume maker: no ask until it bought, and it never sells more than it bought', async () => {
  const r = await rig();
  const a0 = await add(r, { ...MM, paper: true });
  let a = await step(r, a0.id);
  assert.deepEqual(liveKids(a).map((c) => c.side), ['buy'], 'nothing held: a bid only (no short ask)');
  for (let round = 0; round < 6; round++) {
    // The tape sells through every bid, then buys through every ask.
    r.market.print({ price: 59_990, qty: 1, taker: 'sell' });
    await settle();
    a = await step(r, a0.id, 4_000);
    r.market.print({ price: 60_010, qty: 1, taker: 'buy' });
    await settle();
    a = await step(r, a0.id, 4_000);
    assert.ok(bookInventory(a.book!) >= -1e-12, `round ${round}: never short (${bookInventory(a.book!)})`);
    assert.ok(sold(a) <= boughtNet(a) + 1e-12, `round ${round}: sold ${sold(a)} of ${boughtNet(a)} bought`);
    const resting = liveKids(a).filter((c) => c.side === 'sell').reduce((x, c) => x + c.quantity - c.filled, 0);
    assert.ok(resting <= bookInventory(a.book!) + 1e-12, `round ${round}: asks ${resting} over what it holds ${bookInventory(a.book!)}`);
  }
  assert.ok(sold(a) > 0, 'it did sell what it bought');
  assert.equal(r.ex.placed.length, 0, 'practice sends nothing');
});

test('practice spot grid: buys first, each filled buy pairs a sell one level up, never more than it bought', async () => {
  const r = await rig();
  const a0 = await add(r, { ...GRID, paper: true });
  let a = await step(r, a0.id);
  const prices = a.k.gp as number[];
  assert.equal(liveKids(a).filter((c) => c.side === 'sell').length, 0, 'no sell before a buy filled');
  assert.ok(liveKids(a).some((c) => c.side === 'buy'));
  // The price falls through the highest buy level below it.
  const top = Math.max(...liveKids(a).filter((c) => c.side === 'buy').map((c) => c.price));
  r.market.set(top - 101, top - 99);
  r.market.print({ price: top - 100, qty: 1, taker: 'sell' });
  await settle();
  a = await step(r, a0.id, 1_000);
  const sells = liveKids(a).filter((c) => c.side === 'sell');
  assert.equal(sells.length, 1, 'one sell for the one buy');
  assert.equal(sells[0]!.price, prices[prices.indexOf(top) + 1], 'one level above the buy');
  assert.ok(sells[0]!.quantity <= bookInventory(a.book!) + 1e-12, 'within what it bought (its fee in the coin left out)');
  // It fills: flat again, the buy back on its level.
  r.market.print({ price: sells[0]!.price + 1, qty: 1, taker: 'buy' });
  await settle();
  a = await step(r, a0.id, 1_000);
  assert.ok(sold(a) <= boughtNet(a) + 1e-12);
  assert.ok(bookInventory(a.book!) >= -1e-12);
  assert.equal(liveKids(a).filter((c) => c.side === 'sell').length, 0, 'nothing left to sell');
});

/* ---------------------------------------------------------------- real ----- */

test('real spot volume maker: spot orders, no leverage or stops, builder fee on sells only, spot fees not the perps tier', async () => {
  const r = await rig();
  const a0 = await add(r, MM);
  let a = await step(r, a0.id);
  assert.deepEqual(r.ex.placed.map((o) => [o.side, o.engine]), [['buy', 'spot']]);
  assert.equal(r.ex.leverage, 0);
  r.ex.fill(r.ex.side('buy')[0]!.clOrdID);
  await settle();
  a = r.rt.get(a0.id)!;
  const b = a.book!;
  assert.equal(b.builderFees, 0, 'no builder fee on a spot buy');
  assert.ok(Math.abs(b.tradeFees - b.buyValue * 0.00035) < 1e-9, 'the spot maker fee, not the perps tier');
  assert.ok(Math.abs(bookInventory(b) - b.buyQty * (1 - 0.00035)) < 1e-12, 'the fee is taken in the coin bought');
  a = await step(r, a0.id, 4_000);
  const ask = r.ex.side('sell')[0]!;
  assert.ok(ask, 'an ask for what it bought');
  assert.ok(Number(ask.quantity) <= bookInventory(a.book!) + 1e-12);
  r.ex.fill(ask.clOrdID);
  await settle();
  a = r.rt.get(a0.id)!;
  assert.ok(Math.abs(a.book!.builderFees - a.book!.sellValue * (BOT_FEE / 100_000)) < 1e-9, 'the builder fee on the sell');
  assert.equal(r.ex.stops, 0);
});

test('real spot bot: stop with close sells only its own inventory, never the coin the wallet held before it', async () => {
  const r = await rig();
  r.ex.coin = 5; // held before the bot
  const a0 = await add(r, MM);
  await step(r, a0.id);
  r.ex.fill(r.ex.side('buy')[0]!.clOrdID);
  await settle();
  let a = r.rt.get(a0.id)!;
  const own = bookInventory(a.book!);
  assert.ok(own > 0 && own < 0.01);
  // Its ask rests; the stop pulls it and closes.
  await step(r, a0.id, 4_000);
  await r.rt.cancel(a0.id, { close: true });
  await settle();
  for (let i = 0; i < 6; i++) a = await step(r, a0.id, 70_000);
  const sells = r.ex.placed.filter((o) => o.side === 'sell');
  assert.ok(sells.length > 0, 'it closed');
  for (const o of sells) assert.ok(Number(o.quantity) <= own + 1e-12, `a sell of ${o.quantity} over its own ${own}`);
  assert.ok(r.ex.coin >= 5 - 1e-9, `the wallet's own 5 vBTC untouched (now ${r.ex.coin})`);
});

test('real spot bot: the wallet\'s other coin is not mistaken for the bot\'s (position check), coin gone from the wallet is booked out', async () => {
  const r = await rig();
  r.ex.coin = 5;
  const a0 = await add(r, MM);
  await step(r, a0.id);
  r.ex.fill(r.ex.side('buy')[0]!.clOrdID);
  await settle();
  let a = r.rt.get(a0.id)!;
  const own = bookInventory(a.book!);
  // Many minutes on: the position check reads 5 + own vBTC in the wallet - the bot keeps its own holding.
  for (let i = 0; i < 4; i++) a = await step(r, a0.id, 120_000);
  await settle();
  a = await step(r, a0.id, 1_000);
  assert.ok(Math.abs(bookInventory(a.book!) - own) < 1e-12, 'the wallet\'s 5 vBTC are not the bot\'s');
  // The wallet sold everything by hand: what the bot held is gone, booked out.
  for (const x of r.ex.side('sell')) await r.ex.cancel(a, SPOT, [x.clOrdID]);
  await settle();
  r.ex.coin = 0;
  for (let i = 0; i < 4; i++) a = await step(r, a0.id, 120_000);
  await settle();
  a = await step(r, a0.id, 1_000);
  assert.ok(bookInventory(a.book!) < 1e-12, `booked out (holds ${bookInventory(a.book!)})`);
});

test('runtime: real spot bot wallets are followed on the spot socket', async () => {
  const r = await rig();
  await add(r, MM);
  r.rt.tick(clock);
  await settle();
  assert.ok(r.market.watched.symbols.includes(SYM));
  assert.deepEqual(r.market.watched.spot, [FOLLOWER.toLowerCase()]);
});

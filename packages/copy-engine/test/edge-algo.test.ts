/**
 * Edge cases of the algo runtime (runtime.ts) a tester would otherwise meet
 * first (docs/TESTING-MATRIX.md has the whole list and where each is covered):
 * SoDEX unreachable in the middle of an algo, the brake switched on while a
 * resting child fills, the trading key expiring mid-run, duplicate and
 * out-of-order order updates, the clock stepping back, a market halted and
 * then delisted mid-run, a restart while the exits are being resized,
 * reduce-only larger than the position, exits the fills ended up past, and
 * SoDEX's tick, step and minimum on every order that leaves.
 *
 * The exchange here is one object: what it was sent, what rests on it, its
 * stops, its order history and the follower's position, so the runtime's
 * REST look-ups answer from the same truth as its order updates. A test
 * named "BUG ..." failed before its fix (the matrix names the fix).
 */
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
  type MarketInfo,
  type OrderUpdate,
  type Print,
  type PriceSource,
  type Quote,
  type RegionPolicy,
  type SodexClient,
  type StopRequest,
  type EngineNotice,
  regionPolicy,
  stopsAction,
} from '../src/index.ts';
import { BTC, ETH, FOLLOWER } from './helpers.ts';

const ACCOUNT = 42;
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

class FakeMarket implements AlgoMarket {
  readonly up = true;
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
  order(u: Partial<OrderUpdate> & { clOrdID: string }): void {
    for (const cb of this.orderCbs) cb({ orderId: '1', symbol: 'BTC-USD', status: 'NEW', filledQty: 0, filledValue: 0, maker: null, reason: null, at: Date.now(), ...u });
  }
  /** The runner that listened died (a crash): the next one subscribes afresh. */
  forget(): void {
    this.printCbs = [];
    this.orderCbs = [];
  }
}

type Row = { clOrdID: string; orderId: string; status: string; executedQty: number; executedValue: number };

/**
 * SoDEX, faked as one book: IOCs fill at the touch they reach (a reduce-only one only
 * up to the position, as the live suite's reduce-only.no-flip saw), resting orders rest,
 * stops rest until fired; every order lands in the history the look-ups read.
 */
class Exchange implements AlgoSink {
  readonly paper = false;
  placed: ChildRequest[][] = [];
  cancelled: string[] = [];
  stops: StopRequest[][] = [];
  resting = new Map<string, ChildRequest & { filled: number; symbol: string }>();
  liveStops = new Map<string, StopRequest>();
  history = new Map<string, Row>();
  /** The follower's position on SoDEX (BTC-USD), signed. */
  position = 0;
  /** SoDEX unreachable: every request throws, as fetch does. */
  down = false;
  /** Whether a cancel is confirmed on the socket (false: the update is lost). */
  echoCancels = true;
  /** The socket's order updates are held back (a slow or dropped stream) until release(). */
  mute = false;
  late: Array<Partial<OrderUpdate> & { clOrdID: string }> = [];
  constructor(private readonly m: FakeMarket) {}
  get all(): ChildRequest[] {
    return this.placed.flat();
  }
  private up(u: Partial<OrderUpdate> & { clOrdID: string }): void {
    if (this.mute) this.late.push(u);
    else setImmediate(() => this.m.order(u));
  }
  /** The held-back updates arrive now, late. */
  release(): void {
    for (const u of this.late.splice(0)) this.m.order(u);
  }
  private unreachable(): void {
    if (this.down) throw new Error('fetch failed (SoDEX unreachable)');
  }
  async place(_a: AlgoRecord, mk: MarketInfo, orders: ChildRequest[]): Promise<ChildResult[]> {
    this.unreachable();
    this.placed.push(orders);
    for (const o of orders) {
      const q = this.m.quote(mk.name)!;
      const touch = o.side === 'buy' ? q.ask : q.bid;
      const reaches = o.side === 'buy' ? Number(o.price) >= touch : Number(o.price) <= touch;
      if (o.tif === 'ioc') {
        let qty = reaches ? Number(o.quantity) : 0;
        if (o.reduceOnly) qty = Math.min(qty, Math.max(0, o.side === 'sell' ? this.position : -this.position));
        this.position += (o.side === 'buy' ? 1 : -1) * qty;
        const status = qty >= Number(o.quantity) - 1e-12 ? 'FILLED' : 'CANCELED';
        this.history.set(o.clOrdID, { clOrdID: o.clOrdID, orderId: '1', status, executedQty: qty, executedValue: qty * touch });
        this.up({ clOrdID: o.clOrdID, symbol: mk.name, status, filledQty: qty, filledValue: qty * touch, maker: false });
      } else {
        this.resting.set(o.clOrdID, { ...o, filled: 0, symbol: mk.name });
        this.history.set(o.clOrdID, { clOrdID: o.clOrdID, orderId: '1', status: 'NEW', executedQty: 0, executedValue: 0 });
        this.up({ clOrdID: o.clOrdID, symbol: mk.name, status: 'NEW' });
      }
    }
    return orders.map((o) => ({ clOrdID: o.clOrdID, ok: true, orderId: '1', error: null, outcomeUnknown: false }));
  }
  async cancel(_a: AlgoRecord, _m: MarketInfo, ids: string[]): Promise<void> {
    this.unreachable();
    this.cancelled.push(...ids);
    for (const id of ids) {
      const r = this.resting.get(id);
      const wasStop = this.liveStops.delete(id);
      if (!r && !wasStop) continue;
      this.resting.delete(id);
      const h = this.history.get(id);
      if (h) h.status = 'CANCELED';
      if (this.echoCancels) this.up({ clOrdID: id, status: 'CANCELED', filledQty: r?.filled ?? 0, filledValue: (r?.filled ?? 0) * Number(r?.price ?? 0) });
    }
  }
  async setLeverage(): Promise<void> {}
  async placeStops(_a: AlgoRecord, _m: MarketInfo, stops: StopRequest[]): Promise<ChildResult[]> {
    this.unreachable();
    this.stops.push(stops);
    for (const s of stops) {
      this.liveStops.set(s.clOrdID, s);
      this.history.set(s.clOrdID, { clOrdID: s.clOrdID, orderId: '2', status: 'NEW', executedQty: 0, executedValue: 0 });
      this.up({ clOrdID: s.clOrdID, status: 'NEW' });
    }
    return stops.map((s) => ({ clOrdID: s.clOrdID, ok: true, orderId: '2', error: null, outcomeUnknown: false }));
  }
  /** A resting order fills (part or all, `qty` more). */
  fill(id: string, qty: number): void {
    const r = this.resting.get(id)!;
    r.filled += qty;
    this.position += (r.side === 'buy' ? 1 : -1) * qty;
    const done = r.filled >= Number(r.quantity) - 1e-12;
    if (done) this.resting.delete(id);
    const h = this.history.get(id)!;
    Object.assign(h, { status: done ? 'FILLED' : 'PARTIALLY_FILLED', executedQty: r.filled, executedValue: r.filled * Number(r.price) });
    this.m.order({ clOrdID: id, symbol: r.symbol, status: done ? 'FILLED' : 'PARTIALLY_FILLED', filledQty: r.filled, filledValue: r.filled * Number(r.price), maker: true });
  }
  /** What the order look-ups answer: the open orders (stops included), or the history. */
  rows(history: boolean): Row[] {
    if (history) return [...this.history.values()].map((r) => ({ ...r }));
    return [...this.history.values()].filter((r) => this.resting.has(r.clOrdID) || this.liveStops.has(r.clOrdID)).map((r) => ({ ...r }));
  }
  /** Every live stop's size (SoDEX's view): what protects the position now. */
  stopSizes(kind: 'tp' | 'sl'): number[] {
    return [...this.liveStops.values()].filter((s) => s.kind === kind).map((s) => Number(s.quantity));
  }
}

interface Rig {
  rt: AlgoRuntime;
  market: FakeMarket;
  ex: Exchange;
  store: MemoryAlgoStore;
  /** What SoDEX's market list answers. */
  markets: MarketInfo[];
  brake: string | null;
  problem: string | null;
  /** The region rules the host reports (null: none). */
  policy: RegionPolicy | null;
}

function runtimeFor(r: Rig): AlgoRuntime {
  const sodex = {
    markets: async () => r.markets,
    follower: async () => {
      if (r.ex.down) throw new Error('fetch failed (SoDEX unreachable)');
      return { equity: 1_000_000, positions: { 'BTC-USD': { size: r.ex.position, entry: 60_000, leverage: 1, leverageReported: true } } };
    },
    get: async () => [],
  } as unknown as SodexClient;
  return new AlgoRuntime({
    store: r.store,
    sodex,
    network: 'mainnet',
    market: r.market,
    sinkFor: () => r.ex,
    log: silentLogger,
    autoTick: false,
    brake: () => r.brake,
    problem: async () => r.problem,
    policyFor: () => r.policy,
    lookup: async (_a, _s, history) => {
      if (r.ex.down) throw new Error('fetch failed (SoDEX unreachable)');
      return r.ex.rows(history);
    },
  });
}

async function rig(markets: MarketInfo[] = [BTC, ETH]): Promise<Rig> {
  const market = new FakeMarket();
  const r: Rig = { rt: null as unknown as AlgoRuntime, market, ex: new Exchange(market), store: new MemoryAlgoStore(), markets, brake: null, problem: null, policy: null };
  r.rt = runtimeFor(r);
  await r.rt.start();
  market.set('BTC-USD', 60_000, 60_010);
  market.set('ETH-USD', 3_000, 3_001);
  return r;
}

/** The runner dies without a clean stop (a crash, a kill -9) and a new one starts on the same store. */
async function crashAndRestart(r: Rig): Promise<void> {
  r.market.forget();
  r.rt = runtimeFor(r);
  await r.rt.start();
}

/** A new market list from SoDEX (the runtime re-reads it every few minutes). */
async function relist(r: Rig, markets: MarketInfo[]): Promise<void> {
  r.markets = markets;
  await (r.rt as unknown as { loadMarkets(): Promise<void> }).loadMarkets();
}

async function step(r: Rig, id: string, advanceMs = 0): Promise<AlgoRecord> {
  clock += advanceMs;
  await r.rt.stepNow(id, clock);
  await settle();
  return r.rt.get(id)!;
}

/** One tick of the runner as its timer runs it: a step that throws is logged, not raised. */
async function tick(r: Rig, advanceMs = 0): Promise<void> {
  clock += advanceMs;
  r.rt.tick(clock);
  await settle();
  await settle();
}

const add = (r: Rig, spec: Record<string, unknown>) => r.rt.add({ owner: FOLLOWER, accountId: ACCOUNT, mode: 'hosted', spec: { symbol: 'BTC-USD', side: 'buy', ...spec }, seed: 1 });
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const sum = (xs: number[]) => xs.reduce((x, y) => x + y, 0);
const texts = async (r: Rig, id: string) => (await r.rt.events(id, { limit: 500 })).map((e) => e.text);

/* ========================================================== SoDEX down ===== */

test('SoDEX down mid-algo: the slice it was sending is never sent again blind; once SoDEX answers, the TWAP finishes to the exact size', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.004', durationMs: 240_000, slices: 4, exec: { style: 'taker', slippageBps: 30 } });
  await step(r, a.id);
  assert.equal(r.ex.all.length, 1);
  r.ex.down = true;
  // Three minutes of SoDEX not answering: the runner's ticks go on.
  for (let i = 0; i < 18; i++) await tick(r, 10_000);
  let x = r.rt.get(a.id)!;
  assert.equal(r.ex.all.length, 1, 'nothing reached SoDEX while it was down');
  const lost = x.children.filter((c) => c.state !== 'done');
  assert.equal(lost.length, 1, 'the slice it tried to send is kept as unknown, not forgotten');
  assert.equal(lost[0]!.state, 'unknown');
  assert.ok(x.status !== 'failed', 'an outage does not fail the algo');
  r.ex.down = false;
  for (let i = 0; i < 20 && !['done', 'expired', 'failed'].includes(r.rt.get(a.id)!.status); i++) await tick(r, 10_000);
  x = r.rt.get(a.id)!;
  assert.equal(x.status, 'done');
  assert.ok(near(x.filled, 0.004), `filled ${x.filled}`);
  assert.ok(near(sum(r.ex.all.map((c) => Number(c.quantity))), 0.004), 'never more sent than the size');
  assert.ok(near(r.ex.position, 0.004));
});

test('SoDEX down mid-algo with a resting child: a pause is kept, the cancel is tried again, and nothing is filled twice', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'iceberg', quantity: '0.004', displayQty: '0.002', price: 59_990 });
  await step(r, a.id);
  const clip = r.ex.all[0]!;
  r.ex.fill(clip.clOrdID, 0.001);
  await settle();
  r.ex.down = true;
  await r.rt.pause(a.id);
  for (let i = 0; i < 4; i++) await tick(r, 10_000);
  assert.ok(r.ex.resting.has(clip.clOrdID), 'SoDEX was down: the clip still rests there');
  assert.ok((await texts(r, a.id)).some((t) => /Cancel failed/.test(t)), 'the failed cancel is in its activity');
  r.ex.down = false;
  for (let i = 0; i < 4; i++) await tick(r, 10_000);
  assert.equal(r.ex.resting.has(clip.clOrdID), false, 'pulled once SoDEX answers');
  const x = r.rt.get(a.id)!;
  assert.equal(x.status, 'paused');
  assert.ok(near(x.filled, 0.001));
});

/* ============================================================== brake ===== */

test('BUG brake: a resting child that fills while the brake is on gets its exits (brake.ts: "an algo\'s exits are still placed")', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'iceberg', quantity: '0.004', displayQty: '0.002', price: 59_990, exits: { slPct: 0.02 } });
  await step(r, a.id);
  const clip = r.ex.all[0]!;
  r.brake = 'ValueDesk paused all algo orders on this executor: Investigating.';
  let x = await step(r, a.id, 1_000);
  assert.equal(x.status, 'waiting');
  assert.ok(r.ex.resting.has(clip.clOrdID), 'the brake sends nothing, and pulls nothing');
  r.ex.fill(clip.clOrdID, 0.002);
  await settle();
  x = await step(r, a.id, 1_000);
  assert.deepEqual(r.ex.stopSizes('sl'), [0.002], 'the stop-loss for what filled rests on SoDEX while the brake is on');
  assert.equal(r.ex.all.length, 1, 'still no new clip while braked');
  r.brake = null;
  await step(r, a.id, 11_000);
  assert.equal(r.ex.all.length, 2, 'the next clip once it is lifted');
});

test('brake: what the follower does by hand still goes through while it is on - a cancel pulls the resting child', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'iceberg', quantity: '0.004', displayQty: '0.002', price: 59_990 });
  await step(r, a.id);
  r.brake = 'ValueDesk paused all algo orders on this executor: Updating the copy executor.';
  await step(r, a.id, 1_000);
  await r.rt.cancel(a.id);
  await settle();
  assert.equal(r.ex.resting.size, 0);
  assert.equal(r.rt.get(a.id)!.status, 'cancelled');
});

/* ======================================================== key expiry ===== */

test('the trading key expiring mid-run: the algo is held within a minute, sends nothing, keeps its exits, and goes on with a new key', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.004', durationMs: 240_000, slices: 4, exec: { style: 'taker' }, exits: { slPct: 0.05 } });
  await step(r, a.id);
  await step(r, a.id, 500);
  assert.equal(r.ex.stopSizes('sl').length, 1);
  r.problem = 'The copy key expired. Approve a new one in copy setup.';
  // The readiness answer is re-read once a minute (PROBLEM_RECHECK_MS).
  let x = await step(r, a.id, 61_000);
  assert.equal(x.status, 'waiting');
  assert.match(x.statusReason ?? '', /key expired/);
  for (let i = 0; i < 3; i++) x = await step(r, a.id, 60_000);
  assert.equal(r.ex.all.length, 1, 'nothing sent with an expired key');
  assert.deepEqual(r.ex.stopSizes('sl'), [0.001], 'the stop-loss of what filled stays on SoDEX');
  r.problem = null;
  for (let i = 0; i < 4 && r.rt.get(a.id)!.status !== 'done'; i++) x = await step(r, a.id, 61_000);
  assert.equal(r.rt.get(a.id)!.status, 'done');
  assert.ok(near(r.rt.get(a.id)!.filled, 0.004));
});

test('the key gone from this host mid-run (deleted, or not opened): held with the reason, never an order without a key', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.004', durationMs: 240_000, slices: 4, exec: { style: 'taker' } });
  await step(r, a.id);
  (r.rt as unknown as { host: { sinkFor: () => AlgoSink | null } }).host.sinkFor = () => null;
  const x = await step(r, a.id, 61_000);
  assert.equal(x.status, 'waiting');
  assert.match(x.statusReason ?? '', /trading key for this algo is not available/);
  assert.equal(r.ex.all.length, 1);
});

/* ================================================ duplicate / out of order ===== */

test('duplicate and out-of-order order updates: a fill counts once, a late partial never takes it back, a late NEW never re-opens it', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'iceberg', quantity: '0.002', displayQty: '0.002', price: 59_990 });
  await step(r, a.id);
  const id = r.ex.all[0]!.clOrdID;
  const upd = (status: string, q: number) => r.market.order({ clOrdID: id, status, filledQty: q, filledValue: q * 59_990, maker: true });
  upd('PARTIALLY_FILLED', 0.001);
  upd('PARTIALLY_FILLED', 0.001); // the socket replays it after a reconnect
  let x = r.rt.get(a.id)!;
  assert.ok(near(x.filled, 0.001), `a replayed partial counts once (${x.filled})`);
  const fees = x.fees;
  upd('FILLED', 0.002);
  upd('PARTIALLY_FILLED', 0.001); // an older update, delivered late
  upd('NEW', 0);
  upd('FILLED', 0.002);
  await settle();
  x = r.rt.get(a.id)!;
  assert.ok(near(x.filled, 0.002), `filled ${x.filled}`);
  assert.ok(near(x.filledValue, 0.002 * 59_990));
  assert.ok(near(x.fees, fees * 2), 'fees for 0.002, not more');
  assert.equal(x.children[0]!.state, 'done', 'a late NEW does not re-open a filled order');
  x = await step(r, a.id, 1_000);
  assert.equal(x.status, 'done');
  assert.equal(r.ex.all.length, 1, 'nothing more sent');
});

test('a fill read by the REST look-up (its socket update lost) and then seen late on the socket is booked once', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.004', durationMs: 240_000, slices: 4, exec: { style: 'taker' } });
  r.ex.mute = true;
  await step(r, a.id);
  const first = r.ex.all[0]!;
  // No update on the socket: after a few seconds the runtime asks SoDEX, which lists the IOC as filled.
  for (let i = 0; i < 4; i++) await step(r, a.id, 10_000);
  let x = r.rt.get(a.id)!;
  const c = x.children.find((y) => y.clOrdID === first.clOrdID)!;
  assert.equal(c.state, 'done');
  assert.ok(near(c.filled, 0.001), `booked from the history (${c.filled})`);
  r.ex.release(); // the socket's update, minutes late
  r.ex.mute = false;
  await settle();
  x = r.rt.get(a.id)!;
  assert.ok(near(x.children.find((y) => y.clOrdID === first.clOrdID)!.filled, 0.001), 'the late update adds nothing');
  for (let i = 0; i < 5 && x.status !== 'done'; i++) x = await step(r, a.id, 60_000);
  assert.equal(x.status, 'done');
  assert.ok(near(x.filled, 0.004), `filled ${x.filled}`);
  assert.ok(near(r.ex.position, 0.004), `SoDEX holds ${r.ex.position}`);
});

/* ============================================================ the clock ===== */

test('the clock stepping back (NTP) mid-TWAP: no slice is sent twice, and it finishes exactly once time catches up', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.004', durationMs: 240_000, slices: 4, exec: { style: 'taker' } });
  await step(r, a.id);
  await step(r, a.id, 60_000);
  assert.equal(r.ex.all.length, 2);
  await step(r, a.id, -90_000); // ten seconds after the start again
  await step(r, a.id, 5_000);
  assert.equal(r.ex.all.length, 2, 'nothing more is due on a clock that went back');
  for (let i = 0; i < 6; i++) await step(r, a.id, 60_000);
  const x = r.rt.get(a.id)!;
  assert.equal(x.status, 'done');
  assert.ok(near(x.filled, 0.004));
  assert.equal(r.ex.all.length, 4, 'four slices, as planned');
});

test('an order update stamped by a clock minutes ahead (SoDEX vs this host) is booked like any other', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'iceberg', quantity: '0.002', displayQty: '0.002', price: 59_990 });
  await step(r, a.id);
  const id = r.ex.all[0]!.clOrdID;
  r.market.order({ clOrdID: id, status: 'FILLED', filledQty: 0.002, filledValue: 0.002 * 59_990, maker: true, at: clock + 5 * 60_000 });
  const x = await step(r, a.id, 1_000);
  assert.equal(x.status, 'done');
  assert.ok(near(x.filled, 0.002));
});

/* ==================================================== halted / delisted ===== */

test('a market halted mid-run holds the algo (nothing sent) and it goes on when SoDEX trades it again', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.004', durationMs: 240_000, slices: 4, exec: { style: 'taker' } });
  await step(r, a.id);
  await relist(r, [{ ...BTC, status: 'HALT' }, ETH]);
  let x = await step(r, a.id, 61_000);
  assert.equal(x.status, 'waiting');
  assert.match(x.statusReason ?? '', /not trading BTC-USD/);
  assert.equal(r.ex.all.length, 1);
  await relist(r, [BTC, ETH]);
  x = await step(r, a.id, 1_000);
  assert.equal(x.status, 'running');
  assert.equal(r.ex.all.length, 2, 'the slice that came due while halted goes out');
});

test('a market delisted mid-run ends the algo (failed, saying why) and nothing more is sent; what filled keeps its record', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.004', durationMs: 240_000, slices: 4, exec: { style: 'taker' } });
  await step(r, a.id);
  await relist(r, [ETH]);
  const x = await step(r, a.id, 61_000);
  assert.equal(x.status, 'failed');
  assert.match(x.statusReason ?? '', /BTC-USD is no longer listed/);
  assert.ok(near(x.filled, 0.001));
  for (let i = 0; i < 3; i++) await tick(r, 60_000);
  assert.equal(r.ex.all.length, 1);
});

test('an empty market list (a failed read) is not a delisting: the algo goes on', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.004', durationMs: 240_000, slices: 4, exec: { style: 'taker' } });
  await step(r, a.id);
  await relist(r, []);
  const x = await step(r, a.id, 61_000);
  assert.equal(x.status, 'running');
  assert.equal(r.ex.all.length, 2);
});

test.todo('FINDING delisted: the resting children of an algo whose market vanished from the list are not cancelled (end() needs the market to cancel) - what SoDEX does with them on a delisting is unconfirmed', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'iceberg', quantity: '0.004', displayQty: '0.002', price: 59_990 });
  await step(r, a.id);
  assert.equal(r.ex.resting.size, 1);
  await relist(r, [ETH]);
  await step(r, a.id, 1_000);
  assert.equal(r.rt.get(a.id)!.status, 'failed');
  assert.equal(r.ex.resting.size, 0, 'its resting clip is cancelled when it ends');
});

test('region: a close-only place (US) may close - a reduce-only algo runs there, its slices reduce-only (owner, 2026-10-29)', async () => {
  const r = await rig();
  r.ex.position = 0.004;
  r.policy = regionPolicy('US', null);
  const a = await add(r, { kind: 'twap', side: 'sell', closeShare: 1, durationMs: 120_000, slices: 2, exec: { style: 'taker' } });
  await step(r, a.id);
  assert.equal(r.ex.all.length, 1, 'the first reduce-only slice goes out');
  assert.ok(r.ex.all.every((c) => c.reduceOnly));
});

test('region: in a close-only place an opening algo is still held; a sanctioned country (declared or seen) holds a close too', async () => {
  const open = await rig();
  open.policy = regionPolicy('US', null);
  const o = await add(open, { kind: 'twap', side: 'buy', quantity: '0.004', durationMs: 120_000, slices: 2, exec: { style: 'taker' } });
  await step(open, o.id);
  assert.equal(open.ex.all.length, 0, 'nothing opens from the US');
  assert.match(open.rt.get(o.id)!.statusReason ?? '', /United States/, 'held with the region named');

  for (const [declared, seen] of [['RU', null], ['US', 'IR']] as const) {
    const r = await rig();
    r.ex.position = 0.004;
    r.policy = regionPolicy(declared, seen);
    assert.equal(r.policy.closeOnly, false, `${declared}/${seen}: not close-only`);
    const a = await add(r, { kind: 'twap', side: 'sell', closeShare: 1, durationMs: 120_000, slices: 2, exec: { style: 'taker' } });
    await step(r, a.id);
    assert.equal(r.ex.all.length, 0, `${declared}/${seen}: held`);
  }
  assert.equal(regionPolicy('GB', 'DE').closeOnly, true, 'the UK is close-only');
  assert.equal(regionPolicy('DE', 'CA').closeOnly, true, 'seen in Canada: close-only');
  assert.equal(regionPolicy('DE', null).closeOnly, undefined, 'an allowed place: no flag');
});

/* ================================================== restart during exits ===== */

test('a crash while the exits are being resized (the cancel sent, not confirmed): after the restart exactly one stop-loss covers the whole fill', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.006', durationMs: 180_000, slices: 3, exec: { style: 'taker' }, exits: { slPct: 0.05 } });
  await step(r, a.id);
  await step(r, a.id, 500);
  assert.deepEqual(r.ex.stopSizes('sl'), [0.002]);
  r.ex.echoCancels = false;
  await step(r, a.id, 60_000); // the second slice fills
  await step(r, a.id, 6_000); // the resize: the old stop is cancelled; its confirmation is lost
  assert.deepEqual(r.ex.stopSizes('sl'), [], 'the old stop is gone on SoDEX, the new one not placed yet');
  await crashAndRestart(r);
  r.ex.echoCancels = true;
  for (let i = 0; i < 4; i++) await tick(r, 10_000);
  assert.deepEqual(r.ex.stopSizes('sl'), [0.004], 'the new runner covers the 0.004 filled so far, once');
  for (let i = 0; i < 10; i++) await tick(r, 10_000);
  const x = r.rt.get(a.id)!;
  assert.equal(x.status, 'done');
  assert.deepEqual(r.ex.stopSizes('sl'), [0.006], 'one stop-loss, for the whole 0.006');
  assert.equal(r.ex.all.length, 3, 'no slice sent again by the new runner');
});

test('a crash just after the exits were sent (no answer recorded): the new runner asks SoDEX and places no second pair', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'bracket', quantity: '0.002', entry: 'market', slippageBps: 20, exits: { tpPct: 0.02, slPct: 0.01 } });
  // SoDEX takes the stops but the answer never comes back to this runner.
  const placeStops = r.ex.placeStops.bind(r.ex);
  r.ex.placeStops = async (...args) => {
    await placeStops(...args);
    return new Promise<ChildResult[]>(() => {});
  };
  await step(r, a.id);
  void r.rt.stepNow(a.id, (clock += 500));
  await settle();
  assert.equal(r.ex.liveStops.size, 2);
  r.ex.placeStops = placeStops;
  await crashAndRestart(r);
  for (let i = 0; i < 16; i++) await tick(r, 10_000);
  assert.equal(r.ex.liveStops.size, 2, 'still one take-profit and one stop-loss');
  assert.equal(r.ex.stops.length, 1, 'never placed a second time');
});

/* ==================================================== reduce-only ===== */

test('reduce-only larger than the position: it sells the position and no more, never flips, and ends', async () => {
  const r = await rig();
  r.ex.position = 0.002;
  const a = await add(r, { kind: 'swarm', side: 'sell', reduceOnly: true, quantity: '0.005', clips: 2, inFlight: 1, waveMs: 1_000, slippageBps: 30, retries: 0 });
  let x = await step(r, a.id);
  for (let i = 0; i < 20 && !['done', 'expired', 'failed', 'cancelled'].includes(x.status); i++) x = await step(r, a.id, 1_500);
  assert.ok(near(r.ex.position, 0), `flat, not short (${r.ex.position})`);
  assert.ok(x.filled <= 0.002 + 1e-12, `sold ${x.filled}, the position was 0.002`);
  assert.ok(['done', 'expired'].includes(x.status), `it ends (${x.status}: ${x.statusReason})`);
  assert.ok(r.ex.all.every((c) => c.reduceOnly), 'every clip reduce-only');
});

test('a time-sliced close of a position that shrank meanwhile (closed by hand, ADL): never more than the position SoDEX holds', async () => {
  const r = await rig();
  r.ex.position = 0.004;
  const a = await add(r, { kind: 'twap', side: 'sell', closeShare: 1, durationMs: 120_000, slices: 2, exec: { style: 'taker' } });
  await step(r, a.id);
  assert.ok(near(r.ex.position, 0.002));
  r.ex.position = 0.0005; // the rest was taken by ADL / closed by hand
  let x = r.rt.get(a.id)!;
  for (let i = 0; i < 4 && !['done', 'expired', 'failed'].includes(x.status); i++) x = await step(r, a.id, 61_000);
  assert.ok(near(r.ex.position, 0), `flat, never short (${r.ex.position})`);
  assert.ok(r.ex.all.every((c) => c.reduceOnly));
});

/* ============================================================ exits ===== */

test('exits the fills ended up past: a take-profit under a long\'s average fill is not placed (said once), the stop-loss is', async () => {
  const r = await rig();
  // The ticket checked 60,008 against the price then (mid 60,005); the entry filled at the ask, 60,010.
  const a = await add(r, { kind: 'bracket', quantity: '0.002', entry: 'market', slippageBps: 20, exits: { tpPrice: 60_008, slPrice: 59_000 } });
  await step(r, a.id);
  const x = await step(r, a.id, 500);
  assert.equal(x.status, 'done');
  assert.deepEqual(r.ex.stopSizes('tp'), []);
  assert.deepEqual(r.ex.stopSizes('sl'), [0.002]);
  for (let i = 0; i < 3; i++) await tick(r, 10_000);
  const said = (await texts(r, a.id)).filter((t) => /take-profit at 60008 is on the wrong side of the average fill 60010/.test(t));
  assert.equal(said.length, 1, 'said once, not on every tick');
});

test('exits of a short: a stop-loss under the average fill is not placed; the take-profit below it is', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'bracket', side: 'sell', quantity: '0.002', entry: 'market', slippageBps: 20, exits: { tpPrice: 59_000, slPrice: 59_999 } });
  await step(r, a.id);
  await step(r, a.id, 500);
  assert.deepEqual(r.ex.stopSizes('tp'), [0.002]);
  assert.deepEqual(r.ex.stopSizes('sl'), [], 'filled at the bid, 60,000: a stop at 59,999 would buy back at once');
});

/* =================================================== SoDEX's grid ===== */

/** A coarse market: half-unit ticks, 0.003 lots, $10 minimum. */
const ODD: MarketInfo = { ...ETH, id: 3, name: 'ODD-USD', base: 'ODD', tickSize: '0.5', stepSize: '0.003', minQuantity: '0.003', minNotional: 10 };
const onGrid = (v: string, step: string) => {
  assert.doesNotMatch(v, /e/i, `${v} is written out, not in exponent form`);
  const k = Number(v) / Number(step);
  return Math.abs(k - Math.round(k)) < 1e-6;
};

test('every order that leaves is on SoDEX\'s grid: price on the tick, size on the step, at least the minimum - every kind, buy and sell, every step', async () => {
  const r = await rig([BTC, ETH, ODD]);
  r.market.set('ODD-USD', 2_000, 2_000.5);
  const kinds: Array<Record<string, unknown>> = [
    { kind: 'twap', quantity: '0.3', durationMs: 300_000, slices: 5, urgency: 0.4, sizeJitter: 0.3, timeJitter: 0.3, exec: { style: 'taker', slippageBps: 17 }, exits: { tpPct: 0.0137, slPct: 0.0071 } },
    { kind: 'twap', quantity: '0.06', durationMs: 300_000, slices: 5, exec: { style: 'hybrid', makerShare: 0.5 } },
    { kind: 'iceberg', quantity: '0.03', displayQty: '0.01', chaseTicks: 1 },
    { kind: 'chase', quantity: '0.012', offsetBps: 3 },
    { kind: 'scale', quantity: '0.04', from: 1_990.3, to: 1_960.7, orders: 4, postOnly: true, exits: { slPct: 0.013 } },
    { kind: 'dca', perOrderUsd: 25.37, orders: 3, intervalMs: 60_000, exec: { style: 'taker' } },
    { kind: 'swarm', quantity: '0.03', clips: 3, inFlight: 2, waveMs: 1_000, slippageBps: 23, retries: 1 },
    { kind: 'bracket', quantity: '0.009', entry: 'market', slippageBps: 21, exits: { tpPct: 0.0123, slPct: 0.0047 } },
  ];
  for (const side of ['buy', 'sell'] as const) {
    for (const k of kinds) {
      const spec = { ...k, symbol: 'ODD-USD', side, ...(k.kind === 'scale' && side === 'sell' ? { from: 2_010.3, to: 2_040.7 } : {}) };
      const a = await add(r, spec);
      for (let i = 0; i < 12; i++) {
        await step(r, a.id, 31_000);
        // Fill what rests, a third at a time, so every kind goes through its partial-fill steps too.
        for (const [id, o] of [...r.ex.resting]) if (o.symbol === 'ODD-USD') r.ex.fill(id, Math.max(Number(ODD.stepSize), Math.floor((Number(o.quantity) - o.filled) / 3 / 0.003) * 0.003));
        await settle();
      }
      await r.rt.cancel(a.id);
    }
  }
  const children = r.ex.all.filter((c) => c.price && r.rt.list(FOLLOWER).some((a) => a.spec.symbol === 'ODD-USD' && a.children.some((x) => x.clOrdID === c.clOrdID)));
  assert.ok(children.length >= 30, `enough orders to say something (${children.length})`);
  for (const c of children) {
    assert.ok(onGrid(c.price, ODD.tickSize), `price ${c.price} on the 0.5 tick`);
    assert.ok(onGrid(c.quantity, ODD.stepSize), `size ${c.quantity} on the 0.003 step`);
    assert.ok(Number(c.quantity) >= Number(ODD.minQuantity) - 1e-12, `size ${c.quantity} at least the minimum`);
    if (!c.reduceOnly) assert.ok(Number(c.quantity) * Number(c.price) >= ODD.minNotional - 1e-9, `${c.quantity} @ ${c.price} reaches SoDEX's $10`);
  }
  const stops = r.ex.stops.flat().filter((s) => Number(s.triggerPrice) > 1_000 && Number(s.triggerPrice) < 3_000);
  assert.ok(stops.length >= 4, `exits placed (${stops.length})`);
  for (const s of stops) {
    assert.ok(onGrid(s.triggerPrice, ODD.tickSize), `trigger ${s.triggerPrice} on the tick`);
    assert.ok(onGrid(s.quantity, ODD.stepSize), `stop size ${s.quantity} on the step`);
  }
});

/* ========================================== partial fills / overfill ===== */

test('overfill guard: partial fills in every step of a maker TWAP and a chase - filled plus working never passes the size, and it ends at the size exactly', async () => {
  for (const spec of [
    { kind: 'twap', quantity: '0.006', durationMs: 180_000, slices: 3, finish: 'take', exec: { style: 'maker', chaseTicks: 1 } },
    { kind: 'chase', quantity: '0.006', chaseTicks: 1 },
  ]) {
    const r = await rig();
    const a = await add(r, spec);
    let rnd = 7;
    const next = () => (rnd = (rnd * 48271) % 2147483647) / 2147483647;
    for (let i = 0; i < 80 && !['done', 'expired', 'failed'].includes(r.rt.get(a.id)!.status); i++) {
      // The bid wanders (re-prices) and resting children fill a step at a time, sometimes while their cancel is out.
      const bid = 60_000 + Math.round(next() * 6);
      r.market.set('BTC-USD', bid, bid + 10);
      for (const [id, o] of [...r.ex.resting]) if (next() < 0.5) r.ex.fill(id, Math.min(Number(o.quantity) - o.filled, 0.00025 + Math.floor(next() * 4) * 0.00025));
      const x = await step(r, a.id, 2_500);
      const working = x.children.filter((c) => c.state !== 'done').reduce((s, c) => s + Math.max(0, c.quantity - c.filled), 0);
      assert.ok(x.filled + working <= 0.006 + 1e-9, `${spec.kind}: filled ${x.filled} + working ${working} past 0.006 at step ${i}`);
    }
    const x = r.rt.get(a.id)!;
    assert.ok(near(x.filled, 0.006), `${spec.kind} filled ${x.filled}`);
    assert.ok(near(r.ex.position, 0.006), `${spec.kind}: SoDEX holds ${r.ex.position}`);
  }
});

/* ================================================ the position liquidated ===== */

/**
 * SoDEX liquidates by a takeover (docs/research/07 G7): the position goes, in a fill of SoDEX's own,
 * and no order of the algo's fills. Whether SoDEX cancels the position stops with it is not known
 * yet (the live suite's liq.algo-exits reads it); both ways are here.
 */
async function bracketWithExits(r: Rig) {
  const a = await add(r, { kind: 'bracket', quantity: '0.002', entry: 'market', slippageBps: 20, exits: { tpPct: 0.1, slPct: 0.1 } });
  await step(r, a.id);
  const x = await step(r, a.id, 500);
  assert.equal(x.status, 'done');
  assert.equal(r.ex.liveStops.size, 2, 'a take-profit and a stop-loss rest on SoDEX');
  return a;
}

test('the exits of an algo are reduce-only stops: whatever happens to the position, they can never open one', async () => {
  const r = await rig();
  const a = await bracketWithExits(r);
  assert.ok(r.rt.get(a.id)!.exitOrders!.every((x) => x.reduceOnly), 'booked reduce-only');
  const signed = stopsAction(ACCOUNT, BTC, r.ex.stops.flat(), null).params as { orders: Array<{ reduceOnly: boolean }> };
  assert.ok(signed.orders.length === 2 && signed.orders.every((o) => o.reduceOnly === true), 'signed reduce-only');
});

test('liquidated, SoDEX pulling the exits with the position: they end and are never placed again; nothing else is sent; the trader is told the position is gone', async () => {
  const r = await rig();
  const notices = noticesOf(r);
  const a = await bracketWithExits(r);
  const orders = r.ex.all.length;
  const batches = r.ex.stops.length;
  r.ex.position = 0;
  for (const id of [...r.ex.liveStops.keys()]) {
    r.ex.liveStops.delete(id);
    r.ex.history.get(id)!.status = 'CANCELED';
    r.market.order({ clOrdID: id, status: 'CANCELED' });
  }
  for (let i = 0; i < 12; i++) await tick(r, 10_000);
  const x = r.rt.get(a.id)!;
  assert.equal(x.status, 'done', 'it keeps its final status');
  assert.equal(r.ex.stops.length, batches, 'no exit is placed again');
  assert.equal(r.ex.all.length, orders, 'no order is sent');
  assert.ok(x.exitOrders!.every((e) => e.state === 'done'), 'its exits are over');
  assert.ok((await texts(r, a.id)).some((t) => /cancelled on SoDEX; its exits are not placed again/.test(t)), 'its log says SoDEX cancelled them');
  assert.deepEqual(notices.filter((n) => n.ref === a.id && n.kind === 'closed').map((n) => [n.kind, n.grade]), [['closed', 'error']], 'and that the position was closed outside the algo');
  assert.match(notices.find((n) => n.kind === 'closed')!.body, /its exits, cancelled on SoDEX, are not placed again/);
});

test('the trader cancelled the exits on SoDEX, the position still held: no notice, and they are not placed again', async () => {
  const r = await rig();
  const notices = noticesOf(r);
  const a = await bracketWithExits(r);
  const batches = r.ex.stops.length;
  for (const id of [...r.ex.liveStops.keys()]) {
    r.ex.liveStops.delete(id);
    r.ex.history.get(id)!.status = 'CANCELED';
    r.market.order({ clOrdID: id, status: 'CANCELED' });
  }
  for (let i = 0; i < 6; i++) await tick(r, 10_000);
  assert.equal(r.ex.stops.length, batches);
  assert.equal(notices.filter((n) => n.ref === a.id && n.kind === 'closed').length, 0);
});

/** The trader's notices, as the host takes them (the algo's own 'done' among them; the tests read its 'closed' ones). */
function noticesOf(r: Rig): EngineNotice[] {
  const notices: EngineNotice[] = [];
  (r.rt as unknown as { host: { onNotice?: (n: EngineNotice) => void } }).host.onNotice = (n) => notices.push(n);
  return notices;
}

test('BUG liquidated, algo: SoDEX takes the position over and leaves the exits; the stop-loss then expires with nothing to reduce - no pair is placed again, the take-profit left is cancelled, the trader is told', async () => {
  const r = await rig();
  const notices = noticesOf(r);
  const a = await bracketWithExits(r);
  const batches = r.ex.stops.length;
  const orders = r.ex.all.length;
  // SoDEX takes the position over and leaves the stops; the stop-loss triggers with nothing to reduce before the engine looked.
  r.ex.position = 0;
  const sl = [...r.ex.liveStops.values()].find((s) => s.kind === 'sl')!;
  r.ex.liveStops.delete(sl.clOrdID);
  r.ex.history.get(sl.clOrdID)!.status = 'EXPIRED';
  r.market.order({ clOrdID: sl.clOrdID, status: 'EXPIRED', reason: 'reduce only: no position' });
  for (let i = 0; i < 12; i++) await tick(r, 10_000);
  assert.equal(r.ex.stops.length, batches, 'no exit placed again for a position that is gone');
  assert.equal(r.ex.liveStops.size, 0, 'what it left on SoDEX is cancelled');
  assert.equal(r.ex.all.length, orders, 'no order is sent');
  const told = notices.filter((n) => n.ref === a.id && n.kind === 'closed');
  assert.deepEqual(told.map((n) => [n.source, n.grade]), [['algo', 'error']], 'the trader is told the position was closed outside the algo, once');
  assert.match(told[0]!.body, /closed outside this algo \(a liquidation, or by hand\).*take-profit is cancelled/);
  const x = r.rt.get(a.id)!;
  assert.equal(x.status, 'done', 'it keeps its final status');
  assert.ok(x.exitOrders!.every((e) => e.state === 'done'), 'its exits are over');
  assert.ok((await texts(r, a.id)).some((t) => /position is gone: it was closed outside this algo/.test(t)), 'its log says why');
});

test('liquidated, algo, the exits still resting: the engine finds the position gone and cancels both, places nothing, tells the trader once', async () => {
  const r = await rig();
  const notices = noticesOf(r);
  const a = await bracketWithExits(r);
  const batches = r.ex.stops.length;
  r.ex.position = 0;
  for (let i = 0; i < 3; i++) await tick(r, 10_000);
  assert.equal(r.ex.liveStops.size, 0, 'both exits are cancelled on SoDEX');
  assert.equal(r.ex.cancelled.length, 2);
  for (let i = 0; i < 12; i++) await tick(r, 10_000);
  assert.equal(r.ex.stops.length, batches, 'no exit placed again');
  assert.deepEqual(notices.filter((n) => n.ref === a.id && n.kind === 'closed').map((n) => [n.kind, n.grade]), [['closed', 'error']], 'one error notice');
  assert.match(notices.find((n) => n.kind === 'closed')!.body, /take-profit and stop-loss are cancelled on SoDEX and not placed again/);
  // A later position on that market (opened by anything else) is not touched by them.
  r.ex.position = 0.005;
  for (let i = 0; i < 6; i++) await tick(r, 10_000);
  assert.equal(r.ex.stops.length, batches);
  assert.equal(r.ex.cancelled.length, 2);
});

test('liquidated, algo with only a take-profit: the one exit is cancelled once the position is gone, and the trader is told', async () => {
  const r = await rig();
  const notices = noticesOf(r);
  const a = await add(r, { kind: 'bracket', quantity: '0.002', entry: 'market', slippageBps: 20, exits: { tpPct: 0.1 } });
  await step(r, a.id);
  assert.equal((await step(r, a.id, 500)).status, 'done');
  assert.deepEqual([...r.ex.liveStops.values()].map((s) => s.kind), ['tp']);
  r.ex.position = 0;
  for (let i = 0; i < 4; i++) await tick(r, 10_000);
  assert.equal(r.ex.liveStops.size, 0, 'the take-profit is cancelled');
  assert.equal(r.ex.stops.length, 1, 'nothing placed again');
  assert.deepEqual(notices.filter((n) => n.ref === a.id && n.kind === 'closed').map((n) => n.grade), ['error']);
  assert.match(notices.find((n) => n.kind === 'closed')!.body, /its take-profit is cancelled on SoDEX/);
});

test('liquidated, algo, the position flipped to the other side outside it: the exits of the long are cancelled as for a position gone', async () => {
  const r = await rig();
  const notices = noticesOf(r);
  const a = await bracketWithExits(r);
  r.ex.position = -0.003;
  for (let i = 0; i < 3; i++) await tick(r, 10_000);
  assert.equal(r.ex.liveStops.size, 0);
  assert.equal(notices.filter((n) => n.ref === a.id && n.kind === 'closed').length, 1);
});

test('the position still held (or not readable), algo: its exits stay; one that expires is placed again after the wait, as before', async () => {
  const r = await rig();
  const notices = noticesOf(r);
  const a = await bracketWithExits(r);
  const batches = r.ex.stops.length;
  for (let i = 0; i < 6; i++) await tick(r, 10_000);
  assert.equal(r.ex.liveStops.size, 2, 'held: both exits stay');
  assert.equal(r.ex.cancelled.length, 0);
  // SoDEX unreachable: nothing is concluded from a read that failed.
  r.ex.down = true;
  for (let i = 0; i < 3; i++) await tick(r, 10_000);
  r.ex.down = false;
  assert.equal(r.ex.liveStops.size, 2);
  // An expired stop-loss with the position still there: the pair goes out again once the wait is over.
  const sl = [...r.ex.liveStops.values()].find((s) => s.kind === 'sl')!;
  r.ex.liveStops.delete(sl.clOrdID);
  r.ex.history.get(sl.clOrdID)!.status = 'EXPIRED';
  r.market.order({ clOrdID: sl.clOrdID, status: 'EXPIRED', reason: 'trigger price out of range' });
  for (let i = 0; i < 6; i++) await tick(r, 10_000);
  assert.equal(r.ex.stops.length, batches + 1, 'placed again');
  assert.equal(r.ex.liveStops.size, 2);
  assert.equal(notices.filter((n) => n.ref === a.id && n.kind === 'closed').length, 0, 'nothing to tell');
});

test('the stop-loss fired while its update was lost (the position flat because of it): booked from SoDEX\'s history as its fill, the take-profit cancelled, no "closed outside" notice', async () => {
  const r = await rig();
  const notices = noticesOf(r);
  const a = await bracketWithExits(r);
  const sl = [...r.ex.liveStops.values()].find((s) => s.kind === 'sl')!;
  // SoDEX fires it; the socket never says so.
  r.ex.liveStops.delete(sl.clOrdID);
  Object.assign(r.ex.history.get(sl.clOrdID)!, { status: 'FILLED', executedQty: 0.002, executedValue: 0.002 * 54_000 });
  r.ex.position = 0;
  for (let i = 0; i < 4; i++) await tick(r, 10_000);
  const x = r.rt.get(a.id)!;
  assert.equal(x.exitOrders!.find((e) => e.clOrdID === sl.clOrdID)!.filled, 0.002, 'the stop-loss fill is booked');
  assert.equal(r.ex.liveStops.size, 0, 'the take-profit is cancelled (one cancels the other)');
  assert.equal(notices.filter((n) => n.ref === a.id && n.kind === 'closed').length, 0, 'not told as closed outside');
});

test('liquidated, algo, while no runner ran: the next runner finds the position gone and cancels the exits the store kept', async () => {
  const r = await rig();
  const a = await bracketWithExits(r);
  r.ex.position = 0;
  await crashAndRestart(r);
  const notices = noticesOf(r);
  for (let i = 0; i < 3; i++) await tick(r, 10_000);
  assert.equal(r.ex.liveStops.size, 0);
  assert.deepEqual(notices.filter((n) => n.ref === a.id && n.kind === 'closed').map((n) => [n.kind, n.grade]), [['closed', 'error']]);
});

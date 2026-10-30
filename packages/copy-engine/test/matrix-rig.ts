/**
 * The algo runtime against one faked SoDEX, for the option matrix
 * (matrix-algo-runtime.test.ts): a book per market whose touch the test moves,
 * a tape that trades at the touch (so resting orders fill), positions per
 * market, position stops that fire on the mark, and every order kept in the
 * history the runtime's look-ups read. After every tick the INVARIANTS that
 * hold for every algo, whatever its options, are checked on what reached the
 * exchange:
 *
 *   - every price on SoDEX's tick, every size on its step;
 *   - no order under SoDEX's minimum order value at its own price, none over its largest;
 *   - no order past the algo's limit price (on its own side);
 *   - a reduce-only algo (a close, a whole-position trailing stop) sends only reduce-only orders;
 *   - no post-only order through the book (SoDEX would refuse it), unless the trader asked for exactly that;
 *   - at most one child working at a time, for the kinds that work one (a ladder and a swarm wave are batches);
 *   - never more filled than the algo's size;
 *   - nothing at all sent for a paper algo.
 */
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
  type VenueQuote,
  ORACLE_VENUES,
} from '../src/index.ts';
import { BTC, ETH, FOLLOWER } from './helpers.ts';

export const ACCOUNT = 42;
export const T0 = 1_800_000_000_000;

export const clock = { now: T0 };

export const settle = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 2));
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

/** Settle on the event loop alone (no timer: a timer turn costs up to 15 ms on Windows). */
export const quick = async (n = 12): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

export class FakeMarket implements AlgoMarket {
  readonly up = true;
  quotes = new Map<string, Quote>();
  marks = new Map<string, MarkInfo>();
  lasts = new Map<string, number>();
  history: Array<{ t: number; s: string; p: number; oi: number }> = [];
  prints: Print[] = [];
  printCbs: Array<(p: Print) => void> = [];
  orderCbs: Array<(u: OrderUpdate) => void> = [];
  funding = 0.0001;
  oi = new Map<string, number>();
  start(): void {}
  stop(): void {}
  watch(): void {}
  set(symbol: string, bid: number, ask: number, o: { mark?: number; index?: number; last?: number } = {}): void {
    const mark = o.mark ?? (bid + ask) / 2;
    const oi = this.oi.get(symbol) ?? 1000;
    this.quotes.set(symbol, { bid, ask, at: Date.now() });
    this.marks.set(symbol, { mark, index: o.index ?? mark, funding: this.funding, oi, at: Date.now() });
    this.lasts.set(symbol, o.last ?? mark);
    this.history.push({ t: Date.now(), s: symbol, p: mark, oi });
  }
  /** The same book again, stamped now (a quote older than 15 s is no price). */
  refresh(): void {
    for (const [s, q] of [...this.quotes]) {
      const m = this.marks.get(s)!;
      this.set(s, q.bid, q.ask, { mark: m.mark, index: m.index ?? undefined, last: this.lasts.get(s) });
    }
  }
  quote(symbol: string): Quote | null {
    return this.quotes.get(symbol) ?? null;
  }
  last(symbol: string) {
    const p = this.lasts.get(symbol);
    return p === undefined ? null : { price: p, at: Date.now() };
  }
  mark(symbol: string): MarkInfo | null {
    return this.marks.get(symbol) ?? null;
  }
  price(symbol: string, source: PriceSource): number | null {
    const q = this.quote(symbol);
    const m = this.marks.get(symbol);
    if (source === 'mid') return q ? (q.bid + q.ask) / 2 : null;
    if (source === 'last') return this.lasts.get(symbol) ?? null;
    if (source === 'index') return m?.index ?? null;
    return m?.mark ?? null;
  }
  priceAgo(symbol: string, _s: PriceSource, agoMs: number): number | null {
    const want = Date.now() - agoMs;
    const h = this.history.filter((x) => x.s === symbol && x.t <= want);
    return h.length ? h[h.length - 1]!.p : null;
  }
  oiAgo(symbol: string, agoMs: number): number | null {
    const want = Date.now() - agoMs;
    const h = this.history.filter((x) => x.s === symbol && x.t <= want);
    return h.length ? h[h.length - 1]!.oi : null;
  }
  volume(symbol: string, windowMs: number): { qty: number; usd: number } {
    const from = Date.now() - windowMs;
    const ps = this.prints.filter((p) => p.symbol === symbol && p.at >= from);
    return { qty: ps.reduce((x, p) => x + p.qty, 0), usd: ps.reduce((x, p) => x + p.qty * p.price, 0) };
  }
  onPrint(cb: (p: Print) => void): void {
    this.printCbs.push(cb);
  }
  onOrder(cb: (u: OrderUpdate) => void): void {
    this.orderCbs.push(cb);
  }
  onState(): void {}
  /** Someone else trades on the tape. */
  print(symbol: string, qty: number, price?: number): void {
    const q = this.quote(symbol)!;
    const p: Print = { symbol, price: price ?? q.bid, qty, buyer: 7, seller: 8, taker: 'sell', at: Date.now() };
    this.prints.push(p);
    for (const cb of this.printCbs) cb(p);
  }
  order(u: Partial<OrderUpdate> & { clOrdID: string }): void {
    for (const cb of this.orderCbs) cb({ orderId: '1', symbol: 'BTC-USD', status: 'NEW', filledQty: 0, filledValue: 0, maker: null, reason: null, at: Date.now(), ...u });
  }
  forget(): void {
    this.printCbs = [];
    this.orderCbs = [];
  }
}

type Row = { clOrdID: string; orderId: string; status: string; executedQty: number; executedValue: number };

export interface Sent extends ChildRequest {
  symbol: string;
  algoId: string;
  /** The book when it was sent. */
  bid: number;
  ask: number;
  at: number;
}

export class Exchange implements AlgoSink {
  readonly paper = false;
  sent: Sent[] = [];
  batches = 0;
  cancelled: string[] = [];
  stopsSent: Array<StopRequest & { symbol: string }> = [];
  resting = new Map<string, Sent & { filled: number }>();
  liveStops = new Map<string, StopRequest & { symbol: string }>();
  history = new Map<string, Row>();
  positions = new Map<string, number>();
  /** The entry price SoDEX reports per market (absent: the mark when read). */
  entries = new Map<string, number>();
  leverage: Array<{ symbol: string; leverage: number; margin: string }> = [];
  /** Refuse every order (a reason SoDEX gives) while set. */
  refuse: string | null = null;
  constructor(private readonly m: FakeMarket) {}
  pos(symbol: string): number {
    return this.positions.get(symbol) ?? 0;
  }
  private move(symbol: string, side: 'buy' | 'sell', qty: number): void {
    this.positions.set(symbol, this.pos(symbol) + (side === 'buy' ? 1 : -1) * qty);
  }
  private up(u: Partial<OrderUpdate> & { clOrdID: string }): void {
    setImmediate(() => this.m.order(u));
  }
  async place(a: AlgoRecord, mk: MarketInfo, orders: ChildRequest[]): Promise<ChildResult[]> {
    this.batches++;
    const q = this.m.quote(mk.name)!;
    const out: ChildResult[] = [];
    for (const o of orders) {
      const s: Sent = { ...o, symbol: mk.name, algoId: a.id, bid: q.bid, ask: q.ask, at: Date.now() };
      this.sent.push(s);
      if (this.refuse) {
        out.push({ clOrdID: o.clOrdID, ok: false, orderId: null, error: this.refuse, outcomeUnknown: false });
        continue;
      }
      const touch = o.side === 'buy' ? q.ask : q.bid;
      const reaches = o.side === 'buy' ? Number(o.price) >= touch : Number(o.price) <= touch;
      if (o.tif === 'gtx' && reaches) {
        // SoDEX does not let a post-only order take: it is cancelled at once.
        this.history.set(o.clOrdID, { clOrdID: o.clOrdID, orderId: '1', status: 'CANCELED', executedQty: 0, executedValue: 0 });
        this.up({ clOrdID: o.clOrdID, symbol: mk.name, status: 'CANCELED', reason: 'post only would take' });
      } else if (o.tif === 'ioc' || reaches) {
        let qty = reaches ? Number(o.quantity) : 0;
        if (o.reduceOnly) qty = Math.min(qty, Math.max(0, o.side === 'sell' ? this.pos(mk.name) : -this.pos(mk.name)));
        this.move(mk.name, o.side, qty);
        const done = qty >= Number(o.quantity) - 1e-12;
        if (o.tif !== 'ioc' && !done) {
          // A limit through the book fills what it reaches and rests with the rest.
          this.resting.set(o.clOrdID, { ...s, filled: qty });
          this.history.set(o.clOrdID, { clOrdID: o.clOrdID, orderId: '1', status: 'PARTIALLY_FILLED', executedQty: qty, executedValue: qty * touch });
          this.up({ clOrdID: o.clOrdID, symbol: mk.name, status: 'PARTIALLY_FILLED', filledQty: qty, filledValue: qty * touch, maker: false });
        } else {
          const status = done ? 'FILLED' : 'CANCELED';
          this.history.set(o.clOrdID, { clOrdID: o.clOrdID, orderId: '1', status, executedQty: qty, executedValue: qty * touch });
          this.up({ clOrdID: o.clOrdID, symbol: mk.name, status, filledQty: qty, filledValue: qty * touch, maker: false });
        }
      } else {
        this.resting.set(o.clOrdID, { ...s, filled: 0 });
        this.history.set(o.clOrdID, { clOrdID: o.clOrdID, orderId: '1', status: 'NEW', executedQty: 0, executedValue: 0 });
        this.up({ clOrdID: o.clOrdID, symbol: mk.name, status: 'NEW' });
      }
      out.push({ clOrdID: o.clOrdID, ok: true, orderId: '1', error: null, outcomeUnknown: false });
    }
    return out;
  }
  async cancel(_a: AlgoRecord, mk: MarketInfo, ids: string[]): Promise<void> {
    this.cancelled.push(...ids);
    for (const id of ids) {
      const r = this.resting.get(id);
      const stop = this.liveStops.delete(id);
      if (!r && !stop) continue;
      this.resting.delete(id);
      const h = this.history.get(id);
      if (h) h.status = 'CANCELED';
      this.up({ clOrdID: id, symbol: mk.name, status: 'CANCELED', filledQty: r?.filled ?? 0, filledValue: (r?.filled ?? 0) * Number(r?.price ?? 0) });
    }
  }
  async setLeverage(_a: AlgoRecord, mk: MarketInfo, leverage: number, margin: string): Promise<void> {
    this.leverage.push({ symbol: mk.name, leverage, margin });
  }
  async placeStops(_a: AlgoRecord, mk: MarketInfo, stops: StopRequest[]): Promise<ChildResult[]> {
    for (const s of stops) {
      this.stopsSent.push({ ...s, symbol: mk.name });
      this.liveStops.set(s.clOrdID, { ...s, symbol: mk.name });
      this.history.set(s.clOrdID, { clOrdID: s.clOrdID, orderId: '2', status: 'NEW', executedQty: 0, executedValue: 0 });
      this.up({ clOrdID: s.clOrdID, symbol: mk.name, status: 'NEW' });
    }
    return stops.map((s) => ({ clOrdID: s.clOrdID, ok: true, orderId: '2', error: null, outcomeUnknown: false }));
  }
  /** The tape trades at the touch: every resting order at (or better than) it fills, in full. */
  trade(symbol?: string): void {
    for (const [id, r] of [...this.resting]) {
      if (symbol && r.symbol !== symbol) continue;
      const q = this.m.quote(r.symbol)!;
      const at = r.side === 'buy' ? Number(r.price) >= q.bid : Number(r.price) <= q.ask;
      if (at) this.fill(id, Number(r.quantity) - r.filled);
    }
  }
  fill(id: string, qty: number): void {
    const r = this.resting.get(id)!;
    let take = qty;
    if (r.reduceOnly) take = Math.min(take, Math.max(0, r.side === 'sell' ? this.pos(r.symbol) : -this.pos(r.symbol)));
    r.filled += take;
    this.move(r.symbol, r.side, take);
    const done = r.filled >= Number(r.quantity) - 1e-12;
    if (done) this.resting.delete(id);
    const h = this.history.get(id)!;
    Object.assign(h, { status: done ? 'FILLED' : 'PARTIALLY_FILLED', executedQty: r.filled, executedValue: r.filled * Number(r.price) });
    this.m.order({ clOrdID: id, symbol: r.symbol, status: done ? 'FILLED' : 'PARTIALLY_FILLED', filledQty: r.filled, filledValue: r.filled * Number(r.price), maker: true });
  }
  /** SoDEX fires every stop the mark has reached: a reduce-only market order for its size. */
  fireStops(): string[] {
    const fired: string[] = [];
    for (const [id, s] of [...this.liveStops]) {
      const mk = this.m.mark(s.symbol)!.mark;
      const trig = Number(s.triggerPrice);
      // A sell stop protects a long: its take-profit is above, its stop-loss below (a buy stop the other way round).
      const hit = s.side === 'sell' ? (s.kind === 'tp' ? mk >= trig : mk <= trig) : s.kind === 'tp' ? mk <= trig : mk >= trig;
      if (!hit) continue;
      this.liveStops.delete(id);
      const qty = Math.min(Number(s.quantity), Math.abs(this.pos(s.symbol)));
      this.move(s.symbol, s.side, qty);
      this.history.set(id, { clOrdID: id, orderId: '2', status: 'FILLED', executedQty: qty, executedValue: qty * mk });
      this.m.order({ clOrdID: id, symbol: s.symbol, status: 'FILLED', filledQty: qty, filledValue: qty * mk, maker: false });
      fired.push(id);
    }
    return fired;
  }
  rows(history: boolean): Row[] {
    if (history) return [...this.history.values()].map((r) => ({ ...r }));
    return [...this.history.values()].filter((r) => this.resting.has(r.clOrdID) || this.liveStops.has(r.clOrdID)).map((r) => ({ ...r }));
  }
  of(algoId: string): Sent[] {
    return this.sent.filter((s) => s.algoId === algoId);
  }
  restingOf(algoId: string): Array<Sent & { filled: number }> {
    return [...this.resting.values()].filter((s) => s.algoId === algoId);
  }
  stopsOf(prefix: string): Array<StopRequest & { symbol: string }> {
    return [...this.liveStops.values()].filter((s) => s.clOrdID.startsWith(prefix));
  }
}

export interface Rig {
  rt: AlgoRuntime;
  market: FakeMarket;
  ex: Exchange;
  store: MemoryAlgoStore;
  markets: MarketInfo[];
  policy: RegionPolicy | null;
  account: { equity: number; gross: number };
  /** The oracle's venues answer around this price (null: no venue answers). */
  oracleAt: number | null;
  /** Position read fails while set. */
  positionsFail: boolean;
}

function runtimeFor(r: Rig): AlgoRuntime {
  const sodex = {
    markets: async () => r.markets,
    follower: async () => {
      if (r.positionsFail) throw new Error('state read failed');
      const positions: Record<string, { size: number; entry: number; leverage: number; leverageReported: boolean }> = {};
      for (const m of r.markets) positions[m.name] = { size: r.ex.pos(m.name), entry: r.ex.entries.get(m.name) ?? r.market.mark(m.name)?.mark ?? 0, leverage: 1, leverageReported: false };
      return { equity: r.account.equity, positions };
    },
    fills: async () => [],
    markPrices: async () => [...r.market.marks].map(([symbol, m]) => ({ symbol, price: m.mark, oi: m.oi })),
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
    policyFor: () => r.policy,
    account: async () => ({ ...r.account }),
    candles: async () => [],
    oracle: async (_coin, venues) => {
      if (r.oracleAt === null) return [];
      const vs = venues?.length ? venues : ORACLE_VENUES.slice(0, 3);
      return vs.map((venue): VenueQuote => ({ venue, bid: r.oracleAt! - 1, ask: r.oracleAt! + 1, mid: r.oracleAt!, mark: r.oracleAt! + 2, at: Date.now() }));
    },
    lookup: async (_a, _s, history) => r.ex.rows(history),
  });
}

export async function rig(o: { markets?: MarketInfo[]; policy?: RegionPolicy | null } = {}): Promise<Rig> {
  const market = new FakeMarket();
  const r: Rig = { rt: null as unknown as AlgoRuntime, market, ex: new Exchange(market), store: new MemoryAlgoStore(), markets: o.markets ?? [BTC, ETH], policy: o.policy ?? null, account: { equity: 1_000_000, gross: 0 }, oracleAt: 60_005, positionsFail: false };
  r.rt = runtimeFor(r);
  await r.rt.start();
  market.set('BTC-USD', 60_000, 60_010);
  market.set('ETH-USD', 3_000, 3_001);
  return r;
}

export async function crashAndRestart(r: Rig): Promise<void> {
  r.market.forget();
  r.rt = runtimeFor(r);
  await r.rt.start();
}

export const add = (r: Rig, spec: Record<string, unknown>, mode: AlgoRecord['mode'] = 'hosted') =>
  r.rt.add({ owner: FOLLOWER, accountId: ACCOUNT, mode, spec: { symbol: 'BTC-USD', side: 'buy', ...spec }, seed: 7 });

/** The kinds that work one child at a time (a ladder, a swarm's wave, a DCA's installments and a basket's legs are several). */
const ONE_AT_A_TIME = new Set(['twap', 'vwap', 'pov', 'iceberg', 'chase', 'sweep', 'bracket', 'trailing']);

const onGrid = (v: number, unit: string) => Math.abs(v / Number(unit) - Math.round(v / Number(unit))) < 1e-6;

/** Every invariant, for every algo the runtime holds. `allowCrossingPostOnly`: the trader asked for a post-only price through the book. */
export function checkInvariants(r: Rig, o: { allowCrossingPostOnly?: boolean } = {}): void {
  for (const a of r.rt.list()) {
    const s = a.spec;
    const mine = r.ex.of(a.id);
    if (s.paper) {
      assert.equal(mine.length, 0, `${a.id} (${s.kind}) is paper: nothing reaches SoDEX`);
      continue;
    }
    for (const c of mine) {
      const m = r.markets.find((x) => x.name === c.symbol)!;
      const px = Number(c.price);
      const qty = Number(c.quantity);
      assert.ok(onGrid(px, m.tickSize), `${s.kind} ${c.clOrdID}: price ${c.price} on the tick ${m.tickSize}`);
      assert.ok(onGrid(qty, m.stepSize), `${s.kind} ${c.clOrdID}: size ${c.quantity} on the step ${m.stepSize}`);
      assert.ok(qty * px >= m.minNotional - 1e-6 && qty >= Number(m.minQuantity) - 1e-12, `${s.kind} ${c.clOrdID}: ${qty} at ${px} is SoDEX's $${m.minNotional} minimum or more`);
      assert.ok(qty <= Number(m.maxQuantity) + 1e-12, `${s.kind} ${c.clOrdID}: under SoDEX's largest order`);
      if (s.limitPrice !== null && c.symbol === s.symbol && c.side === s.side) assert.ok(s.side === 'buy' ? px <= s.limitPrice + 1e-9 : px >= s.limitPrice - 1e-9, `${s.kind} ${c.clOrdID}: ${c.side} at ${px} not past the limit ${s.limitPrice}`);
      if (s.reduceOnly) assert.ok(c.reduceOnly, `${s.kind} ${c.clOrdID}: a reduce-only algo sends reduce-only orders`);
      if (c.tif === 'gtx' && !o.allowCrossingPostOnly) assert.ok(c.side === 'buy' ? px < c.ask : px > c.bid, `${s.kind} ${c.clOrdID}: post-only ${c.side} at ${px} not through the book ${c.bid}/${c.ask}`);
    }
    if (ONE_AT_A_TIME.has(s.kind)) assert.ok(a.children.filter((c) => c.state !== 'done').length <= 1, `${s.kind} ${a.id}: one child working at a time`);
    const v = r.rt.view(a.id)!;
    const m = r.markets.find((x) => x.name === s.symbol)!;
    if (v.target !== null) assert.ok(a.filled <= v.target + Number(m.stepSize) / 2, `${s.kind} ${a.id}: filled ${a.filled} not over its size ${v.target}`);
  }
}

export interface DriveOptions {
  /** Ticks to run at most. */
  ticks?: number;
  /** Clock step per tick. */
  everyMs?: number;
  /** Before each tick: move the book, print on the tape... (i: the tick). */
  before?: (i: number, r: Rig) => void;
  /** The tape trades at the touch every tick (resting orders at it fill). */
  trade?: boolean;
  /** Another trader's volume on the tape, per tick (POV, max participation). */
  printQty?: number;
  /** Stop once this holds. */
  until?: (r: Rig) => boolean;
  allowCrossingPostOnly?: boolean;
}

const FINAL = new Set(['done', 'cancelled', 'expired', 'failed']);

/** Run the runner's ticks with the clock moving, checking every invariant after each. */
export async function drive(r: Rig, id: string | null, o: DriveOptions = {}): Promise<AlgoRecord | null> {
  const n = o.ticks ?? 200;
  for (let i = 0; i < n; i++) {
    clock.now += o.everyMs ?? 1_000;
    r.market.refresh();
    o.before?.(i, r);
    if (o.printQty) r.market.print('BTC-USD', o.printQty);
    r.rt.tick(clock.now);
    // One timer turn (paper fills come on a 0 ms timer), the rest on the event loop alone: a tick costs little.
    await settle();
    await quick();
    if (o.trade) {
      r.ex.trade();
      await quick();
    }
    if (r.ex.fireStops().length) await quick();
    checkInvariants(r, o);
    if (o.until?.(r)) break;
    if (id && !o.until && FINAL.has(r.rt.get(id)!.status) && !r.rt.list().some((x) => !FINAL.has(x.status))) break;
  }
  return id ? r.rt.get(id) : null;
}

export const near = (a: number, b: number, tol = 1e-9): boolean => Math.abs(a - b) <= tol;
export const sum = (xs: number[]): number => xs.reduce((x, y) => x + y, 0);

/**
 * Audit round 2 of the algo runtime (runtime.ts), after the round-1 fixes:
 * races between a step and the trader's pause / cancel (positions read at a
 * trailing stop's or a conditional's fire, a basket's legs starting, a
 * conditional starting its algo), reads that fail at the moment it matters,
 * resting entries across a pause, SoDEX's largest order, update()'s patch,
 * and regressions of the write-ahead saves, exits back-off and status guards.
 * Each test asserts the intended behaviour; a failing test named "BUG ..." is
 * a bug.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  AlgoRuntime,
  MemoryAlgoStore,
  maxOrderQty,
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
  readonly up = true;
  quotes = new Map<string, Quote>();
  marks = new Map<string, MarkInfo>();
  printCbs: Array<(p: Print) => void> = [];
  orderCbs: Array<(u: OrderUpdate) => void> = [];
  vol = { qty: 0, usd: 0 };
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
    return this.vol;
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

/** SoDEX, faked: IOCs fill at the touch they reach, resting orders rest, stops are taken (or refused). */
class Sink implements AlgoSink {
  readonly paper = false;
  placed: ChildRequest[][] = [];
  cancelled: string[] = [];
  resting = new Map<string, ChildRequest & { filled: number }>();
  stops: StopRequest[][] = [];
  refuseStops = 0;
  constructor(private readonly m: FakeMarket) {}
  get all(): ChildRequest[] {
    return this.placed.flat();
  }
  private up(u: Partial<OrderUpdate> & { clOrdID: string }): void {
    setImmediate(() => this.m.order(u));
  }
  async place(_a: AlgoRecord, mk: { name: string }, orders: ChildRequest[]): Promise<ChildResult[]> {
    this.placed.push(orders);
    const out: ChildResult[] = [];
    for (const o of orders) {
      const q = this.m.quote(mk.name)!;
      const touch = o.side === 'buy' ? q.ask : q.bid;
      const reaches = o.side === 'buy' ? Number(o.price) >= touch : Number(o.price) <= touch;
      if (o.tif === 'ioc') {
        if (reaches) this.up({ clOrdID: o.clOrdID, symbol: mk.name, status: 'FILLED', filledQty: Number(o.quantity), filledValue: Number(o.quantity) * touch, maker: false });
        else this.up({ clOrdID: o.clOrdID, symbol: mk.name, status: 'CANCELED' });
      } else {
        this.resting.set(o.clOrdID, { ...o, filled: 0 });
        this.up({ clOrdID: o.clOrdID, symbol: mk.name, status: 'NEW' });
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
    if (this.refuseStops > 0) {
      this.refuseStops--;
      return stops.map((s) => ({ clOrdID: s.clOrdID, ok: false, orderId: null, error: 'trigger price invalid', outcomeUnknown: false }));
    }
    for (const s of stops) this.up({ clOrdID: s.clOrdID, status: 'NEW' });
    return stops.map((s) => ({ clOrdID: s.clOrdID, ok: true, orderId: '2', error: null, outcomeUnknown: false }));
  }
}

/** A store that can run a hook while an algo is written (the trader acting while the runtime awaits the store). */
class HookStore extends MemoryAlgoStore {
  onSave: ((a: AlgoRecord) => Promise<void> | void) | null = null;
  fail = false;
  saves = 0;
  override async saveAlgo(a: AlgoRecord): Promise<void> {
    this.saves++;
    if (this.onSave) {
      const h = this.onSave;
      await h(a);
    }
    if (this.fail) throw new Error('QuotaExceededError');
    return super.saveAlgo(a);
  }
}

interface Rig {
  rt: AlgoRuntime;
  market: FakeMarket;
  sink: Sink;
  store: HookStore;
  position: { size: number; entry: number };
  /** The next N position reads fail (a timeout, a 502). */
  failReads: number;
  /** Runs when the positions are read (before they are answered). */
  onRead: (() => Promise<void> | void) | null;
}

async function rig(): Promise<Rig> {
  const market = new FakeMarket();
  const sink = new Sink(market);
  const store = new HookStore();
  const r = { market, sink, store, position: { size: 0, entry: 0 }, failReads: 0, onRead: null } as unknown as Rig;
  const sodex = {
    markets: async () => [BTC, ETH],
    follower: async () => {
      if (r.onRead) await r.onRead();
      if (r.failReads > 0) {
        r.failReads--;
        throw new Error('SoDEX did not answer (timeout)');
      }
      return { equity: 1_000_000, positions: { 'BTC-USD': { size: r.position.size, entry: r.position.entry } } };
    },
    get: async () => [],
  } as unknown as SodexClient;
  r.rt = new AlgoRuntime({ store, sodex, network: 'mainnet', market, sinkFor: () => sink, log: silentLogger, autoTick: false, lookup: async () => [] });
  await r.rt.start();
  market.set('BTC-USD', 60_000, 60_010);
  market.set('ETH-USD', 3_000, 3_001);
  return r;
}

async function step(r: Rig, id: string, advanceMs = 0): Promise<AlgoRecord> {
  clock += advanceMs;
  await r.rt.stepNow(id, clock);
  await settle();
  return r.rt.get(id)!;
}

const add = (r: Rig, spec: Record<string, unknown>) => r.rt.add({ owner: FOLLOWER, accountId: ACCOUNT, mode: 'browser', spec: { symbol: 'BTC-USD', side: 'buy', ...spec }, seed: 1 });
const FINAL = new Set(['done', 'cancelled', 'expired', 'failed']);
const childrenOf = (r: Rig, id: string) => r.rt.list(FOLLOWER).filter((x) => x.parentId === id);

/** A trailing sell on the whole position, armed, then the price falls to its stop: the next step fires it. */
async function trailingAboutToFire(r: Rig): Promise<AlgoRecord> {
  r.position = { size: 0.01, entry: 59_000 };
  const a = await add(r, { kind: 'trailing', side: 'sell', trailPct: 0.01 });
  await step(r, a.id);
  r.market.set('BTC-USD', 60_990, 61_010, 61_000);
  await step(r, a.id, 1_000);
  r.market.set('BTC-USD', 60_380, 60_400, 60_390);
  return a;
}

/* ======================================================= fire-time reads ===== */

test('BUG trailing: a position read that fails at the moment it fires is tried again - the stop still sells (it is not expired as "no long position")', async () => {
  const r = await rig();
  const a = await trailingAboutToFire(r);
  r.failReads = 1; // one timeout, just when it fires
  let x = await step(r, a.id, 1_000);
  x = await step(r, a.id, 1_000);
  const sells = r.sink.all.filter((o) => o.side === 'sell');
  assert.ok(sells.length > 0 && (x.status === 'done' || !FINAL.has(x.status)), `the trailing stop ended '${x.status}' (${x.statusReason}) and the long was never sold`);
});

test('BUG trailing: paused while it reads the position at its fire, it still sells once resumed', async () => {
  const r = await rig();
  const a = await trailingAboutToFire(r);
  r.onRead = async () => {
    r.onRead = null;
    await r.rt.pause(a.id);
  };
  await step(r, a.id, 1_000);
  assert.equal(r.rt.get(a.id)!.status, 'paused');
  await r.rt.resume(a.id);
  const x = await step(r, a.id, 1_000);
  const sells = r.sink.all.filter((o) => o.side === 'sell');
  assert.ok(sells.length > 0, `resumed, the fired trailing stop ended '${x.status}' (${x.statusReason}) without selling`);
});

test('BUG conditional close: a position read that fails when it fires is tried again, not ended as "no position to close"', async () => {
  const r = await rig();
  r.position = { size: 0.01, entry: 59_000 };
  const a = await add(r, { kind: 'conditional', side: 'sell', conditions: [{ type: 'price', symbol: 'BTC-USD', source: 'mark', op: 'above', value: 1 }], then: { type: 'close', share: 1, slippageBps: 20 } });
  r.failReads = 1;
  await step(r, a.id);
  const x = await step(r, a.id, 1_000);
  const sells = r.sink.all.filter((o) => o.side === 'sell');
  assert.ok(sells.length > 0, `the close ended '${x.status}' (${x.statusReason}) and closed nothing`);
});

/* =================================================== legs and children ===== */

const BASKET = { kind: 'basket', legs: [{ symbol: 'BTC-USD', side: 'buy', usd: 120 }, { symbol: 'ETH-USD', side: 'buy', usd: 60 }], style: 'twap', durationMs: 600_000, slices: 2, slippageBps: 20 };

test('BUG basket: cancelled while a leg is being started, that leg does not go on trading on its own', async () => {
  const r = await rig();
  const a = await add(r, BASKET);
  let done = false;
  r.store.onSave = async (x) => {
    if (!done && x.parentId === a.id) {
      done = true;
      await r.rt.cancel(a.id); // the trader's cancel lands while the first leg is written
    }
  };
  await step(r, a.id);
  r.store.onSave = null;
  assert.equal(r.rt.get(a.id)!.status, 'cancelled');
  const live = childrenOf(r, a.id).filter((c) => !FINAL.has(c.status));
  assert.deepEqual(live.map((c) => `${c.spec.symbol} ${c.status}`), [], 'a leg of the cancelled basket is still live');
});

test('BUG basket: paused while its legs start, every leg still starts on resume (it never runs on some markets only)', async () => {
  const r = await rig();
  const a = await add(r, BASKET);
  let done = false;
  r.store.onSave = async (x) => {
    if (!done && x.parentId === a.id) {
      done = true;
      await r.rt.pause(a.id);
    }
  };
  await step(r, a.id);
  r.store.onSave = null;
  await r.rt.resume(a.id);
  await step(r, a.id, 1_000);
  await step(r, a.id, 1_000);
  const legs = childrenOf(r, a.id);
  const x = r.rt.get(a.id)!;
  assert.ok(legs.length === 2 || FINAL.has(x.status), `the basket is '${x.status}' with ${legs.length} of 2 legs: ${legs.map((c) => c.spec.symbol).join(', ')} only`);
});

test('BUG conditional: paused while it starts its algo, the algo it starts does not trade (the pause covers it)', async () => {
  const r = await rig();
  const a = await add(r, {
    kind: 'conditional',
    conditions: [{ type: 'price', symbol: 'BTC-USD', source: 'mark', op: 'above', value: 1 }],
    then: { type: 'algo', algo: { kind: 'twap', symbol: 'BTC-USD', side: 'buy', quantity: '0.002', durationMs: 120_000, slices: 2, exec: { style: 'taker' } } },
  });
  let done = false;
  r.store.onSave = async (x) => {
    if (!done && x.parentId === a.id) {
      done = true;
      await r.rt.pause(a.id);
    }
  };
  await step(r, a.id);
  r.store.onSave = null;
  const [child] = childrenOf(r, a.id);
  if (child) await step(r, child.id, 61_000);
  assert.equal(r.sink.all.length, 0, `the trader paused the conditional, yet its TWAP sent ${r.sink.all.length} order(s) (conditional '${r.rt.get(a.id)!.status}', TWAP '${child?.status}')`);
});

/* ============================================================ pause ===== */

test('BUG bracket (limit entry): paused and resumed, its entry goes back on the book - it is not expired as "no longer on SoDEX"', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'bracket', quantity: '0.002', entry: 'limit', price: 59_000, exits: { slPct: 0.01 } });
  await step(r, a.id);
  assert.equal(r.sink.resting.size, 1, 'the entry rests');
  await r.rt.pause(a.id);
  await settle();
  assert.equal(r.sink.resting.size, 0, 'a pause pulls the entry');
  await r.rt.resume(a.id);
  const x = await step(r, a.id, 1_000);
  assert.ok(!FINAL.has(x.status) && r.sink.resting.size === 1, `resumed, the bracket is '${x.status}' (${x.statusReason}) with ${r.sink.resting.size} entry on the book`);
});

/* ============================================================ update ===== */

test('BUG update: only the fields it names change (limit, bounds, spread guard, label, size) - not paper, side or kind', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.002', durationMs: 600_000, slices: 2, paper: true });
  const bad: Array<[string, Record<string, unknown>, (x: AlgoRecord) => boolean]> = [
    ['paper: false', { paper: false }, (x) => x.spec.paper === true],
    ['side: sell', { side: 'sell' }, (x) => x.spec.side === 'buy'],
    ['symbol: ETH-USD', { symbol: 'ETH-USD' }, (x) => x.spec.symbol === 'BTC-USD'],
    ['reduceOnly: true', { reduceOnly: true }, (x) => x.spec.reduceOnly === false],
  ];
  const wrong: string[] = [];
  for (const [what, patch, ok] of bad) {
    await r.rt.update(a.id, patch as never).catch(() => {});
    if (!ok(r.rt.get(a.id)!)) wrong.push(what);
  }
  assert.deepEqual(wrong, [], `update() applied ${wrong.join(', ')}`);
});

/* ================================================== SoDEX's largest order ===== */

test('BUG scale: a level over SoDEX\'s largest order (max notional) is refused when the ladder is placed, or split - not sent to be refused', async () => {
  const r = await rig();
  let a: AlgoRecord | null = null;
  try {
    // 200 BTC over 2 levels near 60k: 100 BTC = $6M a level, over BTC's $5M max notional.
    a = await add(r, { kind: 'scale', quantity: '200', from: 59_000, to: 58_000, orders: 2 });
  } catch {
    return; // refused up front, like a level under the minimum: correct
  }
  await step(r, a.id);
  const over = r.sink.all.filter((o) => Number(o.quantity) > maxOrderQty(BTC, Number(o.price)) + 1e-9);
  assert.deepEqual(over.map((o) => `${o.quantity} @ ${o.price}`), [], 'a level larger than SoDEX takes was sent');
});

test('BUG bracket / conditional limit: an entry over SoDEX\'s largest order is refused up front or split, not sent to be refused', async () => {
  const sent: string[] = [];
  for (const spec of [
    { kind: 'bracket', quantity: '100', entry: 'limit', price: 59_000, exits: { slPct: 0.01 } },
    { kind: 'conditional', conditions: [{ type: 'price', symbol: 'BTC-USD', source: 'mark', op: 'above', value: 1 }], then: { type: 'limit', quantity: '100', price: 59_000 } },
  ]) {
    const r = await rig();
    let a: AlgoRecord;
    try {
      a = await add(r, spec);
    } catch {
      continue;
    }
    await step(r, a.id);
    for (const o of r.sink.all) if (Number(o.quantity) > maxOrderQty(BTC, Number(o.price)) + 1e-9) sent.push(`${spec.kind}: ${o.quantity} @ ${o.price}`);
  }
  assert.deepEqual(sent, [], 'an order larger than SoDEX takes ($5M) was sent');
});

/* ======================================================== regressions (pass) ===== */

test('write-ahead: a store that refuses every write does not stop a TWAP (it trades and finishes, the errors are logged)', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.002', durationMs: 60_000, slices: 2, exec: { style: 'taker' } });
  r.store.fail = true;
  let x = await step(r, a.id);
  x = await step(r, a.id, 30_000);
  x = await step(r, a.id, 31_000);
  x = await step(r, a.id, 1_000);
  assert.equal(x.status, 'done');
  assert.ok(Math.abs(x.filled - 0.002) < 1e-9);
});

test('status race: cancelled while its first slice is being written, nothing leaves and it stays cancelled', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.002', durationMs: 60_000, slices: 2, exec: { style: 'taker' } });
  let done = false;
  r.store.onSave = async (x) => {
    if (!done && x.id === a.id && x.children.length) {
      done = true;
      await r.rt.cancel(a.id);
    }
  };
  await step(r, a.id, 30_000);
  r.store.onSave = null;
  const x = await step(r, a.id, 1_000);
  assert.equal(x.status, 'cancelled');
  assert.equal(r.sink.all.length, 0);
});

test('exits: refused, they are tried again after 30 s, 60 s, ... and given up after 5 refusals (no storm)', async () => {
  const r = await rig();
  r.sink.refuseStops = 99;
  const a = await add(r, { kind: 'bracket', quantity: '0.002', entry: 'market', slippageBps: 20, exits: { slPct: 0.01 } });
  await step(r, a.id); // entry fills, the bracket ends, exits refused
  // SoDEX holds what the entry filled: an ended algo asks the position before it places a refused pair again.
  r.position = { size: 0.002, entry: 60_010 };
  for (let i = 0; i < 700; i++) {
    clock += 1_000;
    r.rt.tick(clock);
    await settle(1);
  }
  const x = r.rt.get(a.id)!;
  assert.equal(r.sink.stops.length, 5, `${r.sink.stops.length} placements in 700 s`);
  assert.equal(x.k.exitsGaveUp, true);
});

test('exits: cancelling an ended bracket pulls its exits, and they are not placed again', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'bracket', quantity: '0.002', entry: 'market', slippageBps: 20, exits: { slPct: 0.01, tpPct: 0.02 } });
  await step(r, a.id);
  await step(r, a.id, 1_000);
  assert.equal(r.rt.get(a.id)!.status, 'done');
  assert.equal(r.sink.stops.flat().length, 2);
  await r.rt.cancel(a.id);
  await settle();
  for (let i = 0; i < 20; i++) {
    clock += 5_000;
    r.rt.tick(clock);
    await settle(1);
  }
  assert.equal(r.sink.cancelled.length, 2);
  assert.equal(r.sink.stops.flat().length, 2, 'exits placed again after the trader cancelled them');
});

test('max participation: with no market volume nothing is sent before the end; at the end the rest is taken', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'twap', quantity: '0.002', durationMs: 60_000, slices: 2, maxParticipation: 0.1, exec: { style: 'taker' }, finish: 'take' });
  await step(r, a.id);
  await step(r, a.id, 31_000);
  assert.equal(r.sink.all.length, 0, 'a slice went out past max participation');
  const x = await step(r, a.id, 30_000);
  assert.ok(r.sink.all.length > 0);
  assert.ok(x.filled > 0);
});

test('size change: lowered under what rests, the resting child is pulled and the algo still finishes at the new size', async () => {
  const r = await rig();
  const a = await add(r, { kind: 'chase', quantity: '0.004' });
  await step(r, a.id);
  assert.equal(r.sink.resting.size, 1);
  await r.rt.update(a.id, { quantity: '0.002' });
  await settle();
  assert.equal(r.sink.resting.size, 0, 'the 0.004 child still rests after the size went to 0.002');
  await step(r, a.id, 2_000);
  const rest = [...r.sink.resting.values()];
  assert.equal(rest.length, 1);
  assert.equal(rest[0]!.quantity, '0.002');
});

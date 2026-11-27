/**
 * The hedge bot in the runtime (hedge.ts, runtime stepHedge): two wallets' legs driven by the main, a spot hedge,
 * trims at the liquidation buffer, both legs closed together, and never a resting order (the legs only take, so the
 * two accounts can never trade with each other).
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
  type Quote,
  type SodexClient,
} from '../src/index.ts';
import { BTC } from './helpers.ts';

const T0 = 1_800_000_000_000;
let clock = T0;
const realNow = Date.now;
beforeEach(() => { clock = T0; Date.now = () => clock; });
afterEach(() => { Date.now = realNow; });
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 5));
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};

const A = '0x00000000000000000000000000000000000000a1';
const B = '0x00000000000000000000000000000000000000b2';
const MKT: MarketInfo = { ...BTC, makerFee: 0.00012, maxLeverage: 40 };

class Market implements AlgoMarket {
  readonly up = true;
  q: Quote = { bid: 60_000, ask: 60_002, at: 0 };
  mk = 60_001;
  cbs: Array<(u: OrderUpdate) => void> = [];
  start(): void {}
  stop(): void {}
  watch(): void {}
  set(bid: number, ask: number): void { this.q = { bid, ask, at: Date.now() }; this.mk = (bid + ask) / 2; }
  quote(): Quote { return { ...this.q, at: Date.now() }; }
  last() { return { price: this.mk, at: Date.now() }; }
  mark(): MarkInfo { return { mark: this.mk, index: this.mk, funding: 0, oi: 1000, at: Date.now() }; }
  price(): number { return this.mk; }
  priceAgo(): null { return null; }
  oiAgo(): number { return 1000; }
  volume() { return { qty: 0, usd: 0 }; }
  onPrint(): void {}
  onOrder(cb: (u: OrderUpdate) => void): void { this.cbs.push(cb); }
  onState(): void {}
  order(u: Partial<OrderUpdate> & { clOrdID: string }): void {
    for (const cb of this.cbs) cb({ orderId: '1', symbol: 'BTC-USD', status: 'NEW', filledQty: 0, filledValue: 0, maker: null, reason: null, at: Date.now(), ...u });
  }
}

/** One account on the fake SoDEX: takers fill at the touch; anything that would rest is recorded (it must never happen). */
class Account implements AlgoSink {
  readonly paper = false;
  position = 0;
  equity = 10_000;
  coin = 0;
  placed: ChildRequest[] = [];
  rested: ChildRequest[] = [];
  constructor(private readonly m: Market) {}
  async place(_a: AlgoRecord, _mk: MarketInfo, orders: ChildRequest[]): Promise<ChildResult[]> {
    this.placed.push(...orders);
    for (const o of orders) {
      if (o.tif !== 'ioc') { this.rested.push(o); continue; }
      const touch = o.side === 'buy' ? this.m.q.ask : this.m.q.bid;
      const crosses = o.side === 'buy' ? Number(o.price) >= touch : Number(o.price) <= touch;
      let qty = crosses ? Number(o.quantity) : 0;
      if (o.reduceOnly) qty = Math.min(qty, Math.max(0, o.side === 'sell' ? this.position : -this.position));
      this.position += (o.side === 'buy' ? 1 : -1) * qty;
      setImmediate(() => this.m.order({ clOrdID: o.clOrdID, status: qty >= Number(o.quantity) - 1e-12 ? 'FILLED' : 'CANCELED', filledQty: qty, filledValue: qty * touch, maker: false }));
    }
    return orders.map((o) => ({ clOrdID: o.clOrdID, ok: true, orderId: '1', error: null, outcomeUnknown: false }));
  }
  async cancel(): Promise<void> {}
  async setLeverage(): Promise<void> {}
  async placeStops(): Promise<ChildResult[]> { return []; }
}

interface Rig { rt: AlgoRuntime; m: Market; acct: Record<string, Account> }

async function rig(): Promise<Rig> {
  const m = new Market();
  const acct: Record<string, Account> = { [A]: new Account(m), [B]: new Account(m) };
  const sodex = { markets: async () => [MKT], follower: async () => ({ equity: 10_000, positions: {} }), fills: async () => [], get: async () => [] } as unknown as SodexClient;
  const rt = new AlgoRuntime({
    confirmGapMs: 0,
    store: new MemoryAlgoStore(),
    sodex,
    network: 'mainnet',
    market: m,
    sinkFor: (a) => acct[a.owner] ?? null,
    margin: async (a) => { const x = acct[a.owner]!; return { qty: x.position, equity: x.equity, maintenance: null, liq: null, coin: x.coin }; },
    log: silentLogger,
    autoTick: false,
    builderRate: () => 0.00005,
  });
  await rt.start();
  m.set(60_000, 60_002);
  return { rt, m, acct };
}

async function step(r: Rig, id: string, ms = 2_000): Promise<AlgoRecord> {
  clock += ms;
  await r.rt.stepNow(id, clock);
  await settle();
  return r.rt.get(id)!;
}

const PAIR = { kind: 'hedge', symbol: 'BTC-USD', shape: 'pair', pairId: 'pair-test-0001', maxLossUsd: 5_000, sizeUsd: 60_000, minLiqPct: 3, growLiqPct: 6, sliceUsd: 12_000, maxSlipBps: 20, marginUsd: 1_000, leverage: 40 };
const main = (r: Rig, o: Record<string, unknown> = {}) => r.rt.add({ owner: A, accountId: 1, mode: 'hosted', seed: 1, spec: { ...PAIR, side: 'buy', role: 'main', partner: B, ...o } });
const partner = (r: Rig, o: Record<string, unknown> = {}) => r.rt.add({ owner: B, accountId: 2, mode: 'hosted', seed: 2, spec: { ...PAIR, side: 'sell', role: 'partner', partner: A, ...o } });

test('pair: the main waits for the second wallet, then grows both legs a slice at a time to the target, equal and opposite', async () => {
  const r = await rig();
  const a = await main(r);
  let x = await step(r, a.id);
  assert.equal(x.status, 'waiting');
  assert.match(x.statusReason ?? '', /second wallet/);
  assert.equal(r.acct[A]!.placed.length, 0);
  const b = await partner(r);
  await step(r, b.id);
  for (let i = 0; i < 8; i++) x = await step(r, a.id);
  assert.equal(x.status, 'running');
  // $60,000 at the start price (the mid, 60,001), in SoDEX's steps.
  assert.ok(Math.abs(r.acct[A]!.position - 60_000 / 60_001) < 1e-4, `long ${r.acct[A]!.position}`);
  assert.ok(Math.abs(r.acct[A]!.position + r.acct[B]!.position) < 1e-12, `short ${r.acct[B]!.position}`);
  // Only ever takers: nothing rested on either account, so the two can never meet.
  assert.equal(r.acct[A]!.rested.length + r.acct[B]!.rested.length, 0);
  assert.ok([...r.acct[A]!.placed, ...r.acct[B]!.placed].every((o) => o.tif === 'ioc'));
  const v = r.rt.view(a.id)!;
  assert.equal(v.bot?.hedge?.paired, true);
  assert.equal(v.bot?.hedge?.legs.length, 2);
});

test('pair at max leverage: a move against the short leg shrinks both legs back outside the buffer, never a naked leg', async () => {
  const r = await rig();
  // 2,000 margin per leg, 40x set: the size is set by the liquidation buffer, not the leverage.
  r.acct[A]!.equity = 2_000;
  r.acct[B]!.equity = 2_000;
  const a = await main(r);
  const b = await partner(r);
  await step(r, b.id);
  for (let i = 0; i < 10; i++) await step(r, a.id);
  const q0 = r.acct[A]!.position;
  assert.ok(q0 > 0 && Math.abs(q0 + r.acct[B]!.position) < 1e-9);
  // Price +3%: the short's account lost what the long's gained.
  const move = q0 * 1_800;
  r.m.set(61_800, 61_802);
  r.acct[A]!.equity += move;
  r.acct[B]!.equity -= move;
  // The next read of both accounts (HEDGE_READ_MS, 3 s) sees it.
  await step(r, a.id, 3_500);
  const q1 = r.acct[A]!.position;
  assert.ok(q1 < q0, `trimmed ${q0} -> ${q1}`);
  assert.ok(Math.abs(q1 + r.acct[B]!.position) < 1e-9, 'still equal and opposite');
  const legs = r.rt.view(a.id)!.bot!.hedge!.legs;
  assert.ok(legs.length === 2);
  assert.ok((await r.rt.events(a.id)).some((e) => /liquidation came within/.test(e.text)));
});

test('pair: stopping the main closes both legs together and ends both; stopping the partner does the same', async () => {
  for (const who of ['main', 'partner'] as const) {
    const r = await rig();
    const a = await main(r);
    const b = await partner(r);
    await step(r, b.id);
    for (let i = 0; i < 8; i++) await step(r, a.id);
    assert.ok(r.acct[A]!.position > 0.5);
    await r.rt.cancel(who === 'main' ? a.id : b.id);
    for (let i = 0; i < 14; i++) {
      await step(r, b.id);
      await step(r, a.id);
    }
    assert.ok(Math.abs(r.acct[A]!.position) < 1e-9 && Math.abs(r.acct[B]!.position) < 1e-9, `${who}: ${r.acct[A]!.position} / ${r.acct[B]!.position}`);
    assert.equal(r.rt.get(a.id)!.status, 'cancelled', who);
    assert.equal(r.rt.get(b.id)!.status, 'cancelled', who);
    assert.equal(r.acct[A]!.rested.length + r.acct[B]!.rested.length, 0);
  }
});

test('pair: a leg whose other leg moved to other servers (VIP move) closes, even with On stop: keep, rather than stay open unhedged', async () => {
  for (const moved of ['partner', 'main'] as const) {
    const r = await rig();
    const a = await main(r, { onStop: 'keep' });
    const b = await partner(r, { onStop: 'keep' });
    await step(r, b.id);
    for (let i = 0; i < 8; i++) await step(r, a.id);
    assert.ok(r.acct[A]!.position > 0.5 && r.acct[B]!.position < -0.5);
    // The VIP move hands the moved wallet's leg over: ended here, its position stays in its account.
    await r.rt.handOver(moved === 'partner' ? b.id : a.id, 'Moved to the VIP servers.');
    const stay = moved === 'partner' ? a.id : b.id;
    const own = moved === 'partner' ? A : B;
    for (let i = 0; i < 10; i++) await step(r, stay);
    assert.ok(Math.abs(r.acct[own]!.position) < 1e-9, `${moved} moved: the leg left here closed (${r.acct[own]!.position})`);
    const x = r.rt.get(stay)!;
    assert.equal(x.status, 'cancelled', moved);
    assert.match(x.statusReason ?? '', /no longer on these servers/);
    assert.equal(r.acct[A]!.rested.length + r.acct[B]!.rested.length, 0);
  }
});

test('pair: a leg that ran paired and finds no other leg at all (arrived alone on other servers) closes; one never paired keeps waiting', async () => {
  const r = await rig();
  const a = await main(r);
  const b = await partner(r);
  await step(r, b.id);
  for (let i = 0; i < 8; i++) await step(r, a.id);
  await step(r, b.id);
  assert.equal(r.rt.get(a.id)!.k.paired, true);
  assert.equal(r.rt.get(b.id)!.k.paired, true);
  // The main's record alone on a second runtime (what a VIP import gives it), the same account.
  const store = new MemoryAlgoStore();
  await store.saveAlgo(JSON.parse(JSON.stringify(r.rt.get(a.id))));
  const sodex = { markets: async () => [MKT], follower: async () => ({ equity: 10_000, positions: {} }), fills: async () => [], get: async () => [] } as unknown as SodexClient;
  const rt2 = new AlgoRuntime({ confirmGapMs: 0, store, sodex, network: 'mainnet', market: r.m, sinkFor: (x) => r.acct[x.owner] ?? null, margin: async (x) => { const c = r.acct[x.owner]!; return { qty: c.position, equity: c.equity, maintenance: null, liq: null, coin: c.coin }; }, log: silentLogger, autoTick: false, builderRate: () => 0.00005 });
  await rt2.start();
  for (let i = 0; i < 10; i++) {
    clock += 2_000;
    await rt2.stepNow(a.id, clock);
    await settle();
  }
  assert.ok(Math.abs(r.acct[A]!.position) < 1e-9, `closed (${r.acct[A]!.position})`);
  assert.match(rt2.get(a.id)!.statusReason ?? '', /no longer on these servers/);
  // Never paired: it waits for its partner and sends nothing.
  const r3 = await rig();
  const c = await main(r3);
  const y = await step(r3, c.id);
  assert.equal(y.status, 'waiting');
  assert.equal(r3.acct[A]!.placed.length, 0);
});

test('spot: the short follows the coin in the futures balance, never larger, and waits while there is none', async () => {
  const r = await rig();
  const a = await r.rt.add({ owner: A, accountId: 1, mode: 'hosted', seed: 1, spec: { kind: 'hedge', symbol: 'BTC-USD', shape: 'spot', maxLossUsd: 5_000, sizeUsd: 60_000, minLiqPct: 3, growLiqPct: 6, sliceUsd: 30_000, maxSlipBps: 20, marginUsd: 1_000 } });
  let x = await step(r, a.id);
  assert.equal(x.status, 'waiting');
  assert.match(x.statusReason ?? '', /BTC in this account's futures balance/);
  r.acct[A]!.coin = 0.75;
  for (let i = 0; i < 5; i++) x = await step(r, a.id);
  assert.ok(Math.abs(r.acct[A]!.position + 0.75) < 1e-9, `short ${r.acct[A]!.position}`);
  assert.equal(r.acct[A]!.rested.length, 0);
  // The coin goes: the short comes back to it.
  r.acct[A]!.coin = 0.5;
  for (let i = 0; i < 3; i++) await step(r, a.id);
  assert.ok(Math.abs(r.acct[A]!.position + 0.5) < 1e-9, `short ${r.acct[A]!.position}`);
});

test('spec: a pair needs its id and the second wallet; the spot shape is one short leg on cross margin', async () => {
  const { checkAlgoSpec, parseAlgoSpec } = await import('../src/index.ts');
  assert.ok(checkAlgoSpec({ ...PAIR, pairId: undefined, side: 'buy', role: 'main', partner: B }).errors.pairId);
  assert.ok(checkAlgoSpec({ ...PAIR, side: 'buy', role: 'main', partner: undefined }).errors.partner);
  assert.ok(checkAlgoSpec({ ...PAIR, side: 'buy', role: 'main', partner: B, growLiqPct: 2 }).errors.growLiqPct);
  assert.ok(checkAlgoSpec({ ...PAIR, side: 'buy', role: 'main', partner: B, marginMode: 'isolated' }).errors.marginMode);
  const s = parseAlgoSpec({ kind: 'hedge', symbol: 'BTC-USD', side: 'buy', shape: 'spot', maxLossUsd: 100, sizeUsd: 1_000, minLiqPct: 3, growLiqPct: 6, sliceUsd: 200, maxSlipBps: 20, marginUsd: 100 });
  assert.equal(s.kind, 'hedge');
  if (s.kind !== 'hedge') return;
  assert.deepEqual([s.side, s.role, s.pairId, s.partner, s.bot], ['sell', 'main', null, null, true]);
});

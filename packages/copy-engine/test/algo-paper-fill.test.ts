/**
 * Practice bots fill like real orders did (paperFill.ts, 2026-11-24): the queue by rest time, the informed taker by the
 * gap to fair, orders and cancels after the measured delay. Without a curve the older rule holds.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AlgoRuntime, MemoryAlgoStore, silentLogger, queueChance, takeRate, gapBps, drawLatency, PrintBasis, paperCurve, BOT_FEE, INFORMED_TAKER_ACCOUNT, type AlgoMarket, type AlgoRecord, type FillCurve, type MarkInfo, type MarketInfo, type OrderUpdate, type Print, type Quote, type RefQuote, type ReferenceSource, type SodexClient } from '../src/index.ts';
import { PAPER_CURVES } from '../src/algo/paperCurves.ts';
import { BTC, FOLLOWER } from './helpers.ts';

const MKT: MarketInfo = { ...BTC, makerFee: 0.00012 };
let clock = 1_800_000_000_000;
const realNow = Date.now;
beforeEach(() => { clock = 1_800_000_000_000; Date.now = () => clock; });
afterEach(() => { Date.now = realNow; });
const settle = async () => { for (let k = 0; k < 2; k++) { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); await new Promise((r) => setTimeout(r, 8)); } };

const CURVE: FillCurve = { basisMs: 60_000, gap: [0], moveMs: 300, move: [], rate: [[0], [10]], rampMs: [0, 500], ramp: [0, 1], ageMs: [0, 1_000, 3_000], age: [0, 0.5, 1], lat: [1] };

class Ref implements ReferenceSource {
  q: RefQuote | null = null;
  cbs: Array<(m: string) => void> = [];
  watch(): void {}
  quote(): RefQuote | null { return this.q; }
  onQuote(cb: (m: string) => void): void { this.cbs.push(cb); }
  tick(mid: number): void { this.q = { bid: mid - 0.5, ask: mid + 0.5, at: Date.now() }; for (const cb of this.cbs) cb('BTC-USD'); }
}
class Market implements AlgoMarket {
  readonly up = true;
  q: Quote = { bid: 60_000, ask: 60_002, at: 0 };
  prints: Array<(p: Print) => void> = [];
  start(): void {}
  stop(): void {}
  watch(): void {}
  quote(): Quote { return { ...this.q, at: Date.now() }; }
  last() { return { price: 60_001, at: Date.now() }; }
  mark(): MarkInfo { return { mark: 60_001, index: 60_001, funding: 0, oi: 1000, at: Date.now() }; }
  price(): number { return 60_001; }
  priceAgo(): null { return null; }
  oiAgo(): number { return 1000; }
  volume() { return { qty: 0, usd: 0 }; }
  onPrint(cb: (p: Print) => void): void { this.prints.push(cb); }
  onOrder(_cb: (u: OrderUpdate) => void): void {}
  onState(): void {}
  print(p: Partial<Print> & { price: number }): void { for (const cb of this.prints) cb({ symbol: 'BTC-USD', qty: 1, buyer: 5, seller: 6, taker: 'sell', at: Date.now(), ...p }); }
}

async function rig(curve: FillCurve | null, rnd: () => number) {
  const market = new Market();
  const ref = new Ref();
  const sodex = { markets: async () => [MKT], follower: async () => ({ equity: 1_000_000, positions: {} }), fills: async () => [], get: async () => [] } as unknown as SodexClient;
  const rt = new AlgoRuntime({ confirmGapMs: 0, store: new MemoryAlgoStore(), sodex, network: 'mainnet', market, sinkFor: () => null, log: silentLogger, autoTick: false, builderRate: () => BOT_FEE / 100_000, reference: ref, paperCurve: () => curve, paperRandom: rnd, problem: async () => null, account: async () => ({ equity: 1_000_000, gross: 0 }) });
  await rt.start();
  ref.tick(60_001);
  const a = await rt.add({ owner: FOLLOWER, accountId: 42, mode: 'hosted', seed: 7, spec: { symbol: 'BTC-USD', kind: 'mm', paper: true, orderUsd: 60, maxInventoryUsd: 180, chaseTicks: 40, minRepriceMs: 1_000, skewTicks: 0 } });
  const step = async () => { void rt.stepNow(a.id, clock); await settle(); };
  const go = async (ms: number, mid = 60_001) => { clock += ms; ref.tick(mid); await settle(); };
  await step();
  await settle();
  return { rt, market, ref, id: a.id, go, rec: (): AlgoRecord => rt.get(a.id)! };
}

test('queue: a young order is not reached by a print at its price, an old one is; the draw decides in between', async () => {
  const r = await rig({ ...CURVE, rate: [[0], [0]] }, () => 0.4); // past 1 s half of the orders are reached: 0.4 is one of them
  const bid = r.rec().children.find((c) => c.side === 'buy')!;
  assert.equal(bid.state, 'open');
  r.market.print({ price: bid.price });
  await settle();
  assert.equal(r.rec().book!.fills, 0, 'just landed: the queue is ahead of it');
  await r.go(1_200);
  r.market.print({ price: bid.price });
  await settle();
  assert.equal(r.rec().book!.fills, 1);
  assert.equal(r.rec().book!.takers?.other, bid.price * bid.quantity);
});

test('queue: the informed taker\'s own print fills nothing here (it is the measured rate), nor does one a tick short', async () => {
  const r = await rig({ ...CURVE, age: [1, 1, 1], rate: [[0], [0]] }, () => 0.5);
  const bid = r.rec().children.find((c) => c.side === 'buy')!;
  r.market.print({ price: bid.price, seller: INFORMED_TAKER_ACCOUNT });
  r.market.print({ price: bid.price + 1 });
  await settle();
  assert.equal(r.rec().book!.fills, 0);
});

test('taken: a quote past fair goes at the measured rate, one behind it does not', async () => {
  const r = await rig({ ...CURVE, age: [0, 0, 0] }, () => 0.5);
  r.market.print({ price: 60_001 }); // the basis
  await r.go(600);
  await r.go(1_000);
  assert.equal(r.rec().book!.fills, 0, 'bid and ask both behind fair');
  clock += 100;
  r.ref.tick(59_990); // fair under the bid: it stands past fair from here (until the pull lands)
  clock += 300;
  r.ref.tick(59_990);
  await settle();
  const b = r.rec().book!;
  assert.equal(b.fills, 1);
  assert.ok((b.takers?.t23342 ?? 0) > 0);
});

test('no curve, or no reference: the older rule (only a print through the price)', async () => {
  const r = await rig(null, () => 0);
  const bid = r.rec().children.find((c) => c.side === 'buy')!;
  r.market.print({ price: bid.price });
  await settle();
  assert.equal(r.rec().book!.fills, 0);
  r.market.print({ price: bid.price - 1 });
  await settle();
  assert.equal(r.rec().book!.fills, 1);
});

test('the pieces', () => {
  assert.equal(queueChance(CURVE, 999), 0);
  assert.equal(queueChance(CURVE, 1_000), 0.5);
  assert.equal(queueChance(CURVE, 9e9), 1);
  assert.equal(takeRate(CURVE, -0.1, 0, 600), 0);
  assert.equal(takeRate(CURVE, 0, 0, 600), 10);
  assert.equal(takeRate(CURVE, 0, 0, 100), 0, 'young');
  const two: FillCurve = { ...CURVE, move: [0.5], rate: [[0, 1], [2, 3]] };
  assert.deepEqual([takeRate(two, -1, 0.4, 600), takeRate(two, -1, 0.5, 600), takeRate(two, 1, 0, 600), takeRate(two, 1, 9, 600)], [0, 1, 2, 3]);
  assert.ok(Math.abs(gapBps('buy', 100.01, 100) - 1) < 1e-9);
  assert.ok(Math.abs(gapBps('sell', 99.99, 100) - 1) < 1e-9);
  assert.equal(drawLatency({ ...CURVE, lat: [1, 2, 3] }, 0.99), 3);
  const b = new PrintBasis();
  assert.equal(b.fair(100), null);
  b.update(101, 100, 0, 60_000);
  b.update(103, 100, 60_000, 60_000);
  assert.ok(Math.abs(b.fair(100)! - 102) < 1e-9, 'half the way after one half-life');
});

test('every shipped curve is whole: lengths fit, shares between 0 and 1, the queue never un-happens', () => {
  assert.ok(Object.keys(PAPER_CURVES).length > 0);
  for (const [s, c] of Object.entries(PAPER_CURVES)) {
    assert.equal(paperCurve(s), c);
    assert.equal(c.rate.length, c.gap.length + 1, s);
    assert.equal(c.ramp.length, c.rampMs.length, s);
    assert.equal(c.age.length, c.ageMs.length, s);
    assert.ok(c.lat.length > 0 && c.lat.every((x) => x >= 0), s);
    assert.ok(c.rate.every((row) => row.length === c.move.length + 1 && row.every((x) => x >= 0)) && c.ramp.every((x) => x >= 0 && x <= 1) && c.age.every((x) => x >= 0 && x <= 1), s);
    assert.ok(c.age.every((x, i) => i === 0 || x >= c.age[i - 1]!), s);
  }
  assert.equal(paperCurve('NOPE-USD'), null);
});

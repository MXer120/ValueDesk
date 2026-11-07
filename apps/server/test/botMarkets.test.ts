/**
 * Run: npx tsx --test test/botMarkets.test.ts   (from apps/server)
 *
 * GET /api/vs/bots/markets (flow/botMarkets.ts): on a synthetic SoDEX market the maker is the passive side, the market's
 * dominant maker is left out of the small makers, the 30 s markout has the right sign on both sides, the still-market
 * gate drops exactly the fills of the minute after a jump, and the cost is fees minus the small makers' markout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TAKER_BUYER, TAKER_SELLER, type PrintCols } from '../src/flow/codec.js';
import { analyzeMarket, weightedPercentile, BOT_BUILDER_BPS } from '../src/flow/botMarkets.js';

const P1002 = 1, P23342 = 2, DOM = 3, OTHER_TAKER = 50;
const T0 = 1_762_473_600_000; // a whole UTC hour
const N = 1200; // seconds of prints
const J = 600; // the second the market jumps 30 bp
const MAKER_BPS = 1.2;
const midAt = (k: number) => (k < J ? 100 : 100.3);
const askAt = (k: number) => midAt(k) + 0.05;
const bidAt = (k: number) => midAt(k) - 0.05;

interface P { t: number; px: number; sz: number; buyer: number; seller: number; taker: number }

/** Every second: the dominant maker sells at the ask to 1002 (t+0) and buys at the bid from 1002 (t+500); in between
 * (t+200) one small maker (10..29, in turn) is filled: even seconds it sells at the ask to another taker, odd seconds it
 * buys at the bid from 1002. */
function market(): { cols: PrintCols; small: Array<{ s: number; px: number; side: number; sz: number; taker: number }> } {
  const ps: P[] = [];
  const small: Array<{ s: number; px: number; side: number; sz: number; taker: number }> = [];
  for (let k = 0; k < N; k++) {
    const t = T0 + k * 1000;
    ps.push({ t, px: askAt(k), sz: 10, buyer: P1002, seller: DOM, taker: TAKER_BUYER });
    const maker = 10 + (k % 20);
    if (k % 2 === 0) {
      ps.push({ t: t + 200, px: askAt(k), sz: 1, buyer: OTHER_TAKER, seller: maker, taker: TAKER_BUYER });
      small.push({ s: k, px: askAt(k), side: -1, sz: 1, taker: OTHER_TAKER });
    } else {
      ps.push({ t: t + 200, px: bidAt(k), sz: 1, buyer: maker, seller: P1002, taker: TAKER_SELLER });
      small.push({ s: k, px: bidAt(k), side: 1, sz: 1, taker: P1002 });
    }
    ps.push({ t: t + 500, px: bidAt(k), sz: 10, buyer: DOM, seller: P1002, taker: TAKER_SELLER });
  }
  const n = ps.length;
  const cols: PrintCols = { n, t: new Float64Array(n), px: new Float64Array(n), sz: new Float64Array(n), buyer: new Uint32Array(n), seller: new Uint32Array(n), taker: new Uint8Array(n) };
  ps.forEach((p, i) => { cols.t[i] = p.t; cols.px[i] = p.px; cols.sz[i] = p.sz; cols.buyer[i] = p.buyer; cols.seller[i] = p.seller; cols.taker[i] = p.taker; });
  return { cols, small };
}

/** mid30 by hand: the median of the per-second mid over t+25 s .. t+35 s (11 seconds), i.e. the jump's level once 6 of them are past it. */
const mid30Of = (s: number) => (s + 35 - J + 1 >= 6 ? 100.3 : 100);
const markoutOf = (f: { s: number; px: number; side: number }) => f.side * ((mid30Of(f.s) - f.px) / f.px) * 1e4;
const vw = (fs: Array<{ px: number; sz: number; mk: number }>) => fs.reduce((a, f) => a + f.px * f.sz * f.mk, 0) / fs.reduce((a, f) => a + f.px * f.sz, 0);
const close = (a: number | null, b: number, eps = 0.011) => assert.ok(a !== null && Math.abs(a - b) <= eps, `${a} != ${b}`);

test('maker side, dominant maker left out, markout sign, gate and cost', async () => {
  const { cols, small } = market();
  const now = T0 + N * 1000 + 200_000;
  const a = await analyzeMarket(cols, { now, makerBps: MAKER_BPS, builderBps: BOT_BUILDER_BPS, id1002: P1002, id23342: P23342 }, () => undefined);
  assert.ok(a);
  const w = a.w24;
  // The 20 small makers count; the dominant maker (95 % of maker volume) does not.
  assert.equal(w.smallMakers.count, 20);
  assert.equal(w.smallMakers.fills, N);
  // Markout sign: far from the jump a maker earns its half spread on both sides (+5 bp); a maker that sold just before
  // the jump up lost ~25 bp, one that bought there earned ~35 bp.
  const withMk = small.map((f) => ({ ...f, mk: markoutOf(f) }));
  assert.ok(withMk[0]!.mk > 4.9 && withMk[1]!.mk > 4.9);
  assert.ok(withMk.find((f) => f.s === J - 10 && f.side === -1)!.mk < -24);
  assert.ok(withMk.find((f) => f.s === J - 9 && f.side === 1)!.mk > 34);
  const markout = vw(withMk);
  close(w.smallMakers.markout30Bps, markout);
  close(w.smallMakers.on1002Bps, vw(withMk.filter((f) => f.taker === P1002)));
  assert.equal(w.smallMakers.on23342Bps, null);
  // Cost = maker fee + builder fee - markout.
  close(w.estCostBps, MAKER_BPS + BOT_BUILDER_BPS - markout);
  assert.ok(w.estCostLowBps <= w.estCostBps + 0.01 && w.estCostHighBps >= w.estCostBps - 0.01);
  // The gate drops exactly the fills whose minute before held the jump (seconds J+1 .. J+60).
  const still = withMk.filter((f) => !(f.s >= J + 1 && f.s <= J + 60));
  close(w.gateCostBps, MAKER_BPS + BOT_BUILDER_BPS - vw(still));
  // Who took: 1002 took the dominant maker's fills and the small makers' buys.
  const takenBy1002 = N * 2 * 10 * 100.15 + (N / 2) * 1 * 100;
  close(w.takers.t1002, takenBy1002 / (takenBy1002 + (N / 2) * 100.2), 0.01);
  assert.equal(w.takers.t23342, 0);
  assert.equal(w.confidence, 'medium');
  // Capacity is the small makers' volume per hour; spread from opposite prints is the 10 bp quote (the 30 bp jump is one gap in thousands).
  assert.equal(w.capacityUsdH, w.smallMakers.volumeUsdH);
  close(w.spreadBps, 10, 0.05);
  assert.equal(a.hourly.length, 24);
  assert.ok(a.hourly.some((h) => h.costBps !== null));
});

test('a dominant small market: a maker with >= 10 % of maker volume is out even when it is not 23342', async () => {
  const { cols } = market();
  // Give maker 10 a print big enough to own > 10 % of maker volume.
  const n = cols.n + 1;
  const grow = (a: Float64Array | Uint32Array | Uint8Array, v: number) => { const b = new (a.constructor as Float64ArrayConstructor)(n); b.set(a as Float64Array); b[n - 1] = v; return b; };
  const t = T0 + (N - 1) * 1000 + 900;
  const big: PrintCols = {
    n, t: grow(cols.t, t) as Float64Array, px: grow(cols.px, 100.35) as Float64Array, sz: grow(cols.sz, 10_000) as Float64Array,
    buyer: grow(cols.buyer, OTHER_TAKER) as unknown as Uint32Array, seller: grow(cols.seller, 10) as unknown as Uint32Array, taker: grow(cols.taker, TAKER_BUYER) as unknown as Uint8Array,
  };
  const a = await analyzeMarket(big, { now: T0 + N * 1000 + 200_000, makerBps: MAKER_BPS, builderBps: BOT_BUILDER_BPS, id1002: P1002, id23342: P23342 }, () => undefined);
  assert.equal(a!.w24.smallMakers.count, 19);
});

test('weighted percentile', () => {
  assert.equal(weightedPercentile([5, 1, 3], [1, 1, 1], 0.1), 1);
  assert.equal(weightedPercentile([5, 1, 3], [1, 1, 1], 0.9), 5);
  assert.equal(weightedPercentile([5, 1, 3], [0, 10, 1], 0.9), 1);
});

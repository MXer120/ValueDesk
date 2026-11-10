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
import { BOT_BUILDER_BPS, BOT_MARKETS_IDLE_EVERY, BOT_MARKETS_MAX_AGE, BOT_MARKETS_TTL, analyzeMarket, cutAtProgress, extendSeries, regimeAll, servePlan, warmDue, weightedPercentile, type MinuteSeries } from '../src/flow/botMarkets.js';

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
  // Who took, among the small makers' fills (the dominant maker's are not ours to meet): 1002 took their buys.
  const smallBy1002 = (N / 2) * 1 * 100 * 0.9995;
  close(w.takers.t1002, vw(small.filter((f) => f.taker === P1002).map((f) => ({ ...f, mk: 1 }))) * smallBy1002 / (small.reduce((x, f) => x + f.px * f.sz, 0)), 0.02);
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

test('a maker that fills rarely, a person leaving a limit order, is not one like our bot', async () => {
  const { cols } = market();
  // Maker 99 fills once in the whole window: under the bot-like floor, so it is not counted among the small makers.
  const n = cols.n + 1;
  const grow = (a: Float64Array | Uint32Array | Uint8Array, v: number) => { const b = new (a.constructor as Float64ArrayConstructor)(n); b.set(a as Float64Array); b[n - 1] = v; return b; };
  const t = T0 + 5 * 1000 + 700;
  const one: PrintCols = {
    n, t: grow(cols.t, t) as Float64Array, px: grow(cols.px, 100.05) as Float64Array, sz: grow(cols.sz, 1) as Float64Array,
    buyer: grow(cols.buyer, OTHER_TAKER) as unknown as Uint32Array, seller: grow(cols.seller, 99) as unknown as Uint32Array, taker: grow(cols.taker, TAKER_BUYER) as unknown as Uint8Array,
  };
  const a = await analyzeMarket(one, { now: T0 + N * 1000 + 200_000, makerBps: MAKER_BPS, builderBps: BOT_BUILDER_BPS, id1002: P1002, id23342: P23342 }, () => undefined);
  assert.equal(a!.w24.smallMakers.count, 20);
});

test('a recorder outage (a span the coverage ledger marks short) is left out of the volume and of the hours it is divided by', async () => {
  const { cols } = market();
  const now = T0 + N * 1000 + 200_000;
  const hole: [number, number] = [T0 + 300_000, T0 + 600_000];
  // The outage: 4 of 5 prints in the span never reached the recorder.
  const keep: number[] = [];
  for (let i = 0; i < cols.n; i++) { const t = cols.t[i]!; if (!(t >= hole[0] && t < hole[1]) || i % 5 === 0) keep.push(i); }
  const lossy: PrintCols = { n: keep.length, t: new Float64Array(keep.map((i) => cols.t[i]!)), px: new Float64Array(keep.map((i) => cols.px[i]!)), sz: new Float64Array(keep.map((i) => cols.sz[i]!)), buyer: new Uint32Array(keep.map((i) => cols.buyer[i]!)), seller: new Uint32Array(keep.map((i) => cols.seller[i]!)), taker: new Uint8Array(keep.map((i) => cols.taker[i]!)) };
  const opts = { now, makerBps: MAKER_BPS, builderBps: BOT_BUILDER_BPS, id1002: P1002, id23342: P23342 };
  const naive = await analyzeMarket(lossy, opts, () => undefined);
  const fixed = await analyzeMarket(lossy, { ...opts, holes: [hole] }, () => undefined);
  // What it should read: the volume outside the outage over the hours outside it.
  let outside = 0;
  for (let i = 0; i < cols.n; i++) { const t = cols.t[i]!; if (!(t >= hole[0] && t < hole[1])) outside += cols.px[i]! * cols.sz[i]!; }
  const hours = (now - T0 - (hole[1] - hole[0])) / 3_600_000;
  close(fixed!.w24.volumeUsdH, outside / hours, 0.5);
  assert.ok(naive!.w24.volumeUsdH < fixed!.w24.volumeUsdH, `the outage lowered it: ${naive!.w24.volumeUsdH} vs ${fixed!.w24.volumeUsdH}`);
  // The small makers' fills of the outage are not counted either.
  assert.ok(fixed!.w24.smallMakers.fills < naive!.w24.smallMakers.fills);
});

test('1h and 6h windows, minute series and the regime buckets', async () => {
  const { cols } = market();
  const now = T0 + N * 1000 + 200_000; // 23 min of prints, ending 200 s before now
  const a = await analyzeMarket(cols, { now, makerBps: MAKER_BPS, builderBps: BOT_BUILDER_BPS, id1002: P1002, id23342: P23342 }, () => undefined);
  assert.ok(a);
  // Every window holds the same prints; the held hours are the market's span since its first print, never the window's.
  for (const w of [a.w1, a.w6, a.w24, a.w7]) close(w.heldH, (now - T0) / 3_600_000, 0.01);
  close(a.w1.volumeUsdH, a.w24.volumeUsdH, 0.5);
  // Minutes: all taker volume, of it 1002's (it takes the dominant maker's quotes and half the small makers').
  const ms = a.series;
  const tot = ms.tot.reduce((x, y) => x + y, 0), u = ms.u.reduce((x, y) => x + y, 0);
  const all = Array.from({ length: cols.n }, (_, i) => cols.px[i]! * cols.sz[i]!).reduce((x, y) => x + y, 0);
  close(tot, all, all * 1e-5);
  assert.ok(u / tot > 0.9, `1002 share ${u / tot}`);
  // The jump of 30 bp shows as volatility in its minute.
  const jm = Math.floor((T0 + J * 1000) / 60_000) - ms.m0;
  assert.ok(ms.vol[jm]! > 25 || ms.vol[jm + 1]! > 25, 'the jump minute moves');
  const { bucketsOf } = await import('../src/flow/botMarkets.js');
  const b1 = bucketsOf(ms, now, '1h');
  assert.equal(b1.length, 12);
  assert.equal(b1[1]!.t - b1[0]!.t, 5 * 60_000);
  // Buckets before the first print are not held; the ones with prints are.
  assert.equal(b1[0]!.volumeUsd, null);
  assert.ok(b1.filter((b) => b.volumeUsd !== null).length >= 4);
  assert.equal(bucketsOf(ms, now, '6h').length, 72);
  assert.equal(bucketsOf(ms, now, '24h').length, 96);
  assert.equal(bucketsOf(ms, now, '7d').length, 168);
});

test('ALL holds a bucket only when the markets holding it carry half the volume; minutes past the newest print in the flow are not held', () => {
  const now = Date.UTC(2026, 10, 10, 11, 0);
  const m0 = Math.floor((now - 7 * 86_400_000) / 60_000);
  const nm = Math.floor((now - 1) / 60_000) - m0 + 1;
  const mk = (perMin: number): MinuteSeries => ({ m0, tot: new Float32Array(nm).fill(perMin), u: new Float32Array(nm), f: new Float32Array(nm), vol: new Float32Array(nm), held: new Uint8Array(nm).fill(1) });
  const big = mk(1000), small = mk(10);
  // The big market is not recorded over the last 20 minutes (the indexer behind): ALL must say so, not read 10 $/min.
  for (let i = nm - 20; i < nm; i++) big.held[i] = 0;
  const series = new Map([['BTC-USD', big], ['XPL-USD', small]]);
  const h = regimeAll(series, ['BTC-USD', 'XPL-USD'], now, '1h').hours;
  assert.equal(h.at(-1)!.volumeUsd, null);
  assert.equal(h.at(-5)!.volumeUsd, null);
  assert.equal(h.at(-6)!.volumeUsd, 5 * 1010);
  // The newest print at 10:50:30: from 10:51 on nothing is held, 10:50 still is.
  const s = mk(1);
  cutAtProgress(s, Date.UTC(2026, 10, 10, 10, 50, 30));
  const at = (hh: number, mm: number): number => Math.floor(Date.UTC(2026, 10, 10, hh, mm) / 60_000) - m0;
  assert.equal(s.held[at(10, 50)], 1);
  assert.equal(s.held[at(10, 51)], 0);
  assert.equal(s.held[at(10, 59)], 0);
});

test('an old answer is never served, and the board stays warm when nobody asks (2026-11-10: 00:12 answer at 09:00)', () => {
  const now = 1_794_300_000_000;
  const min = 60_000;
  assert.equal(servePlan(null, now), 'wait', 'none yet');
  assert.equal(servePlan(now - 2 * min, now), 'serve');
  assert.equal(servePlan(now - BOT_MARKETS_TTL - 1, now), 'serve-refresh', 'past the TTL: served, a new one behind it');
  assert.equal(servePlan(now - BOT_MARKETS_MAX_AGE - 1, now), 'wait', 'too old to show');
  assert.equal(servePlan(now - 9 * 60 * min, now), 'wait', 'the overnight case');
  // Asked lately: every tick computes.
  assert.equal(warmDue(now, now - 10 * min, now - 5 * min), true);
  // Nobody asked: only once the answer nears the idle interval, so a 5 min timer computes every 10 min.
  assert.equal(warmDue(now, now - 3 * 60 * min, now - 5 * min), false);
  assert.equal(warmDue(now, now - 3 * 60 * min, now - BOT_MARKETS_IDLE_EVERY), true);
  assert.equal(warmDue(now, 0, null), true, 'never computed');
  assert.ok(BOT_MARKETS_IDLE_EVERY + BOT_MARKETS_TTL <= BOT_MARKETS_MAX_AGE, 'an idle answer is still young enough to serve at once');
});

test('the board minutes extended from the newest prints equal the ones built from scratch (history is never rebuilt)', async () => {
  const { cols } = market();
  const cut = (to: number): PrintCols => {
    let n = 0;
    while (n < cols.n && cols.t[n]! < to) n++;
    return { n, t: cols.t.slice(0, n), px: cols.px.slice(0, n), sz: cols.sz.slice(0, n), buyer: cols.buyer.slice(0, n), seller: cols.seller.slice(0, n), taker: cols.taker.slice(0, n) };
  };
  const t1 = T0 + 600_000, t2 = T0 + N * 1000 + 200_000;
  const opts = { makerBps: MAKER_BPS, builderBps: BOT_BUILDER_BPS, id1002: P1002, id23342: P23342 };
  const early = (await analyzeMarket(cut(t1), { ...opts, now: t1 }, () => undefined))!.series;
  const whole = (await analyzeMarket(cols, { ...opts, now: t2 }, () => undefined))!.series;
  // The pass re-reads from 5 min before t1, prints from one chunk earlier (as tailPass).
  const startM = Math.floor((t1 - 300_000) / 60_000);
  const ext = extendSeries(early, cut(t2), { newM0: Math.floor((t2 - 7 * 86_400_000) / 60_000), startM, now: t2, ids: { u: P1002, f: P23342 }, holes: [] });
  const d = ext.m0 - whole.m0;
  assert.equal(ext.tot.length, whole.tot.length - d);
  for (let i = 0; i < ext.tot.length; i++) {
    const w = i + d;
    assert.ok(Math.abs(ext.tot[i]! - whole.tot[w]!) < 1e-3 * Math.max(1, whole.tot[w]!), `tot minute ${i}`);
    assert.ok(Math.abs(ext.u[i]! - whole.u[w]!) < 1e-3 * Math.max(1, whole.u[w]!), `1002 minute ${i}`);
    assert.ok(Math.abs(ext.vol[i]! - whole.vol[w]!) < 1e-3, `vol minute ${i}: ${ext.vol[i]} vs ${whole.vol[w]}`);
    assert.equal(ext.held[i], whole.held[w], `held minute ${i}`);
  }
});

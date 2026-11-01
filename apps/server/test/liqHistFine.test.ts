/**
 * Run: npx tsx --test test/liqHistFine.test.ts   (from apps/server)
 *
 * The history's fine layers (owner 2026-11-01: "historial view supports 10 & 1 resolution", then
 * "want full min tick stored for full range"): with each snapshot the indexer keeps the levels at a
 * tenth of its step and at the coin's tick over its whole range (levels.ts fineSnapOf), in price
 * bands (fineBands, put back by mergeFine), and the history route serves them at the step asked
 * for a price window (liqRead.ts fineRowsOf). Checked against a brute-force bucketing of the same positions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { NOW_HI, NOW_LO, fineBandWidth, fineBands, fineHistSteps, fineSnapOf, mergeFine, snapBand, type FinePos, type FineSnap } from '../src/valuedesk/liquidations/levels.js';
import { fineRowsOf } from '../src/indexer/liqRead.js';
import { IndexStore } from '../src/indexer/store.js';
import type { Venue } from '../src/valuedesk/types.js';

function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
}

const P = 77_929;
const ST = 100;
const VS: Venue[] = ['hyperliquid', 'sodex', 'lighter'];

/** Positions 0.6x-1.4x around the price: some past (a long above the price), some of unknown leverage. */
function positions(n: number, seed = 3): FinePos[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, k) => {
    const long = r() < 0.5;
    const away = 0.4 * r() ** 2;
    const past = r() < 0.05;
    return { venue: VS[k % VS.length]!, long, liq: P * (long !== past ? 1 - away : 1 + away), usd: 100 + r() * 50_000, band: Math.floor(r() * 4) - 1 };
  });
}

/** Every position on its own: [long, short, long by band...] per bucket of `step` over [lo, hi). */
function brute(ps: FinePos[], step: number, lo: number, hi: number, venues: readonly Venue[]) {
  const m = new Map<number, number[]>();
  for (const x of ps) {
    if (!venues.includes(x.venue)) continue;
    if (x.long ? x.liq >= P : x.liq <= P) continue;
    if (x.liq < lo || x.liq >= hi) continue;
    const i = Math.floor(x.liq / step);
    const b = m.get(i) ?? [0, 0, 0, 0, 0, 0, 0, 0];
    b[x.long ? 0 : 1]! += x.usd;
    if (x.band >= 0) b[snapBand(x.long, x.band as 0 | 1 | 2) - 1]! += x.usd;
    m.set(i, b);
  }
  return m;
}

test('the steps kept: a tenth of the snapshot step and the coin tick, finest last', () => {
  assert.deepEqual(fineHistSteps(100, 1), [10, 1], 'BTC: $10 and its $1 tick');
  assert.deepEqual(fineHistSteps(100, 0.1), [10, 0.1], 'a tick finer than a hundredth');
  assert.deepEqual(fineHistSteps(100, 0), [10, 1], 'no tick known: a hundredth');
  assert.deepEqual(fineHistSteps(100, 10), [10], 'a tick of a tenth: that layer only');
  assert.deepEqual(fineHistSteps(100, 50), [50], 'a coarse tick');
  assert.deepEqual(fineHistSteps(100, 100), [], 'a tick of the step itself: nothing finer');
  assert.deepEqual(fineHistSteps(0.0001, 0.000001), [0.00001, 0.000001]);
});

test('the layers: a tenth of the step and the tick, over the whole range of the snapshot, exact per venue', () => {
  const ps = positions(20_000);
  const f = fineSnapOf(P, ST, ps, 1)!;
  assert.deepEqual(f.L.map((L) => L.st), [10, 1]);
  for (const L of f.L) {
    assert.ok(L.lo <= P * NOW_LO && L.lo > P * NOW_LO - L.st && L.hi >= P * NOW_HI && L.hi < P * NOW_HI + L.st, 'the whole range, on whole cells');
    for (const v of VS) {
      const want = brute(ps, L.st, L.lo, L.hi, [v]);
      const rows = L.v[v] ?? [];
      assert.equal(rows.length, want.size, `${v} @ ${L.st}: buckets`);
      for (const r of rows) {
        const w = want.get(r[0])!;
        assert.ok(w, `${v} @ ${L.st}: bucket ${r[0]} has positions`);
        assert.ok(Math.abs(r[1] - w[0]!) <= 1 && Math.abs(r[2] - w[1]!) <= 1, `${v} @ ${L.st}: USD at ${r[0]}`);
        for (let k = 3; k < 9; k++) assert.ok(Math.abs((r[k] ?? 0) - w[k - 1]!) <= 1, `${v} @ ${L.st}: band field ${k} at ${r[0]}`);
      }
    }
  }
  assert.deepEqual(fineSnapOf(P, ST, ps, 0.5)!.L.map((L) => L.st), [10, 0.5], 'down to the tick');
  assert.equal(fineSnapOf(P, ST, []), null, 'no position: no layers');
  assert.equal(fineSnapOf(0, ST, ps), null, 'no price: no layers');
});

test('the route: the layer that serves the step, summed up to it over the window; finer than any layer: none', () => {
  const ps = positions(20_000, 9);
  // The earlier layers (liq_hist_fine, 2026-11-01): $10 to +-12.5%, $1 to +-2.5% - still read for that day.
  const whole = fineSnapOf(P, ST, ps, 1)!;
  const clip = (L: FineSnap['L'][number], lo: number, hi: number) => ({ st: L.st, lo, hi, v: Object.fromEntries(Object.entries(L.v).map(([k, r]) => [k, r!.filter((x) => x[0] * L.st >= lo && x[0] * L.st < hi)])) });
  const f: FineSnap = { p: P, L: [clip(whole.L[0]!, 67_920, 87_920), clip(whole.L[1]!, 75_929, 79_929)] };
  const all: Venue[] = [...VS];
  // $10 over a window inside the $10 layer: that layer as kept.
  const a = fineRowsOf(f, all, { step: 10, from: 75_000, to: 79_000 })!;
  assert.deepEqual([a.lo, a.hi], [75_000, 79_000]);
  const wa = brute(ps, 10, 75_000, 79_000, all);
  assert.equal(a.b.length, wa.size);
  for (const r of a.b) assert.ok(Math.abs(r[1] - wa.get(r[0])![0]!) <= 3, `$10 long at ${r[0]}`);
  // $5: from the $1 layer (5 of them), only as far as the $1 layer reaches.
  const b = fineRowsOf(f, all, { step: 5, from: 70_000, to: 85_000 })!;
  const L1 = f.L[1]!;
  assert.ok(b.lo >= L1.lo && b.hi <= L1.hi, 'clipped to the $1 layer');
  const wb = brute(ps, 5, b.lo, b.hi, all);
  assert.equal(b.b.length, wb.size);
  for (const r of b.b) assert.ok(Math.abs(r[1] + r[2] - wb.get(r[0])![0]! - wb.get(r[0])![1]!) <= 6, `$5 at ${r[0]}`);
  // $20 (two $10 cells) over a window wider than the $10 layer: clipped to it.
  const c = fineRowsOf(f, ['sodex'], { step: 20, from: 50_000, to: 110_000 })!;
  assert.deepEqual([c.lo, c.hi], [f.L[0]!.lo, f.L[0]!.hi]);
  const wc = brute(ps, 20, c.lo, c.hi, ['sodex']);
  assert.equal(c.b.length, wc.size);
  // Finer than the finest layer, or a window outside every layer: nothing.
  assert.equal(fineRowsOf(f, all, { step: 0.5, from: 77_000, to: 78_000 }), null);
  assert.equal(fineRowsOf(f, all, { step: 10, from: 20_000, to: 30_000 }), null);
});

test('the bands: every band the layers reach, rows by their low edge; put back together, the same layers', () => {
  const ps = positions(20_000, 4);
  const f = fineSnapOf(P, ST, ps, 1)!;
  const w = fineBandWidth(P);
  assert.equal(w, 20_000, 'BTC near $78K: $20,000 bands');
  const bands = fineBands(f, w);
  assert.equal(bands[0]!.lo, f.L[0]!.lo);
  for (let k = 1; k < bands.length; k++) assert.equal(bands[k]!.lo, bands[k - 1]!.hi, 'no gap between bands');
  assert.ok(bands.at(-1)!.hi >= f.L[1]!.hi);
  const back = mergeFine([...bands].reverse().map((b) => b.f))!;
  assert.deepEqual(back.L.map((L) => [L.st, L.lo, L.hi]), f.L.map((L) => [L.st, L.lo, L.hi]));
  for (let i = 0; i < f.L.length; i++) for (const v of VS) assert.deepEqual(back.L[i]!.v[v] ?? [], f.L[i]!.v[v] ?? [], `${v} @ ${f.L[i]!.st}`);
  // A window's bands alone serve it as the whole would.
  const ask = { step: 5, from: 70_000, to: 85_000 };
  const some = mergeFine(bands.filter((b) => b.lo < ask.to && b.hi > ask.from).map((b) => b.f))!;
  assert.deepEqual(fineRowsOf(some, VS, ask), fineRowsOf(f, VS, ask));
  assert.equal(mergeFine([]), null);
});

test('the store: bands per coin, time and price, read by window newest first, pruned and thinned with the snapshots', () => {
  const s = new IndexStore(':memory:');
  const H = 3_600_000;
  const t0 = 100 * H;
  const bands = fineBands(fineSnapOf(P, ST, positions(500), 1)!, fineBandWidth(P));
  const rows = bands.map((b): [string, number, number, Uint8Array] => ['BTC', b.lo, b.hi, deflateRawSync(JSON.stringify(b.f))]);
  for (const t of [t0, t0 + H / 4, t0 + H]) s.putLiqHistFineBands(t, rows);
  assert.equal(s.liqHistFineBandFrom('BTC'), t0);
  assert.equal(s.liqHistFineBandFrom('ETH'), null);
  const got = s.liqHistFineBands('BTC', t0, t0 + H / 2, 70_000, 85_000);
  assert.deepEqual([...new Set(got.map((r) => r.t))], [t0 + H / 4, t0], 'newest first');
  assert.ok(got.every((r) => r.lo < 85_000 && r.hi > 70_000) && got.length === 4, 'only the bands of the window');
  s.pruneLiqHist(t0, t0 + 2 * H, H);
  assert.deepEqual([...new Set(s.liqHistFineBands('BTC', 0, Number.MAX_SAFE_INTEGER, 0, 1e9).map((r) => r.t))], [t0 + H, t0]);
});

test('the store: deflated layers per coin and time, read by window, pruned and thinned with the snapshots', () => {
  const s = new IndexStore(':memory:');
  const H = 3_600_000;
  const t0 = 100 * H;
  const f = fineSnapOf(P, ST, positions(500))!;
  const blob = deflateRawSync(JSON.stringify(f));
  s.putLiqHistFine(t0, [['BTC', blob]]);
  s.putLiqHistFine(t0 + H / 4, [['BTC', blob], ['ETH', blob]]);
  s.putLiqHistFine(t0 + H, [['BTC', blob]]);
  assert.equal(s.liqHistFineFrom('BTC'), t0);
  assert.equal(s.liqHistFineFrom('SOL'), null);
  const rows = s.liqHistFine('BTC', t0, t0 + H / 2);
  assert.deepEqual(rows.map((r) => r.t), [t0, t0 + H / 4]);
  const back = JSON.parse(inflateRawSync(rows[0]!.data).toString('utf8')) as FineSnap;
  assert.deepEqual(back, f);
  // Thinned to hourly before t0 + 2h: the quarter-hour one goes, the hourly ones stay; then everything before t0 + 1 ms goes.
  s.pruneLiqHist(t0, t0 + 2 * H, H);
  assert.deepEqual(s.liqHistFine('BTC', 0, Number.MAX_SAFE_INTEGER).map((r) => r.t), [t0, t0 + H]);
  s.pruneLiqHist(t0 + 1, t0 + 2 * H, H);
  assert.deepEqual(s.liqHistFine('BTC', 0, Number.MAX_SAFE_INTEGER).map((r) => r.t), [t0 + H]);
});

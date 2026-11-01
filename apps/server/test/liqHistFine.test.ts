/**
 * Run: npx tsx --test test/liqHistFine.test.ts   (from apps/server)
 *
 * The history's fine layers (owner 2026-11-01: "historial view supports 10 & 1 resolution"):
 * with each snapshot the indexer keeps the levels at a tenth and a hundredth of its step near the
 * price (levels.ts fineSnapOf), and the history route serves them at the step asked for a price
 * window (liqRead.ts fineRowsOf). Checked against a brute-force bucketing of the same positions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { FINE_LAYERS, fineSnapOf, snapBand, type FinePos, type FineSnap } from '../src/valuedesk/liquidations/levels.js';
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

test('the layers: a tenth and a hundredth of the step, over their reach around the price, exact per venue', () => {
  const ps = positions(20_000);
  const f = fineSnapOf(P, ST, ps)!;
  assert.equal(f.L.length, FINE_LAYERS.length);
  assert.deepEqual(f.L.map((L) => L.st), [10, 1]);
  for (const L of f.L) {
    const half = FINE_LAYERS[f.L.indexOf(L)]!.half;
    assert.ok(Math.abs((L.hi - L.lo) / L.st - 2 * half) < 1e-6, 'the layer spans half buckets either side');
    assert.ok(L.lo <= P && P < L.hi, 'the price inside');
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
  assert.equal(fineSnapOf(P, ST, []), null, 'no position: no layers');
  assert.equal(fineSnapOf(0, ST, ps), null, 'no price: no layers');
});

test('the route: the layer that serves the step, summed up to it over the window; finer than any layer: none', () => {
  const ps = positions(20_000, 9);
  const f = fineSnapOf(P, ST, ps)!;
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

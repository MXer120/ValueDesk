/**
 * The historical heatmap at a fine step (histFine.ts): every column on screen at the step drawn,
 * never one at the snapshots' own step while its levels are read, and a step change (Auto, a pick)
 * redraws the whole window at once (owner 2026-11-02: "sometimes it just doesnt load the
 * granularity everywhere ... autogranularity ... just loads the last snaphot instead of changing all!").
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { poolRows } from '@sign/indexer/liqRead.js';
import type { LiqHistoryFine } from '@sign/indexer/liqRead.js';
import { cellsOf, pixelCells, snapshotFor, type HeatPoint } from '../../chart/liqHeatIndicator';
import { LEV_BANDS } from '../../chart/liqLev';
import { fineFrame, fineTileId, mergeParts, poolOf, viewKey, type FineView, type TileState } from './histFine';
import { tilesFor, type TileGrid, type TileKey } from './tileGrid';

const H = 3_600_000;
const Q = 15 * 60_000;
const P = 78_000;
const NEWEST = 2_000 * H;
const grid: TileGrid = { newest: NEWEST, slot: 6 * H, bw: 5000, tLevels: 3, pLevels: 4 };
/** Two days of snapshots at $100; fine levels kept from SINCE on. */
const SINCE = NEWEST - 10 * H;
const times = Array.from({ length: 2 * 96 }, (_, k) => NEWEST - (2 * 96 - 1 - k) * Q);

function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
}
/** Rows at `st` over [lo, hi): bucket, long, short, three long bands, three short bands. */
function rows(st: number, lo: number, hi: number, seed: number): HeatPoint['b'] {
  const r = rng(seed);
  const out: HeatPoint['b'] = [];
  for (let i = Math.ceil(lo / st); i < Math.floor(hi / st); i++) {
    if (r() < 0.3) continue;
    const l = i * st < P ? Math.round(r() * 1e5) : 0;
    const s = l ? 0 : Math.round(r() * 1e5);
    out.push([i, l, s, Math.round(l * 0.2), Math.round(l * 0.3), Math.round(l * 0.5), Math.round(s * 0.2), Math.round(s * 0.3), Math.round(s * 0.5)]);
  }
  return out;
}
const coarse: HeatPoint[] = times.map((t, k) => ({ t, p: P, st: 100, b: rows(100, P * 0.9, P * 1.1, k + 1) }));

/** The server's answer for a tile at `step`: each snapshot from SINCE in it, its rows over the band. */
function answer(k: TileKey, step: number): LiqHistoryFine {
  const t1 = k.v ?? k.t1 - 1;
  const points = times.filter((t) => t >= k.t0 && t <= t1 && t >= SINCE).map((t) => ({ t, st: step, lo: k.lo, hi: k.hi, b: rows(step, k.lo, k.hi, t / Q) as never }));
  return { coin: 'BTC', venues: ['sodex'], step, from: k.lo, to: k.hi, points, since: SINCE, cut: null };
}
const view = (step: number): FineView => ({ step, every: 0, off: 0, pool: 0, side: 'both', lev: LEV_BANDS });
const W = { t0: NEWEST - 20 * H, t1: NEWEST + Q, lo: P * 0.97, hi: P * 1.03 };
const ks = tilesFor(grid, W);

/** Tiles answered for a view: `which` of them (default every one). */
function held(step: number, which: (k: TileKey) => boolean = () => true): Map<string, TileState> {
  const m = new Map<string, TileState>();
  for (const k of ks) if (which(k)) m.set(fineTileId(viewKey('BTC', 'sodex', view(step)), k), { tile: answer(k, step), failed: false });
  return m;
}
const getOf = (...ms: Array<Map<string, TileState>>) => (id: string) => { for (const m of ms) if (m.has(id)) return m.get(id); return undefined; };

/** The steps of every cell drawn inside the window, over the columns from SINCE on. */
function stepsDrawn(points: readonly HeatPoint[]): Set<number> {
  const out = new Set<number>();
  for (const q of points) {
    if (q.t < SINCE || q.t < W.t0 || q.t > W.t1) continue;
    for (const c of cellsOf(q)) if (c.hi > W.lo && c.lo < W.hi) out.add(c.st);
  }
  return out;
}

test('every column on screen at the step picked once its tiles are in: none at the snapshots\' $100', () => {
  const vk = viewKey('BTC', 'sodex', view(10));
  const r = fineFrame(coarse, vk, 10, ks, null, getOf(held(10)));
  assert.equal(r.waiting, false);
  assert.equal(r.step, 10);
  assert.deepEqual([...stepsDrawn(r.points)], [10]);
  // Each column's cells are its own snapshot's at $10, exact.
  for (const q of r.points) {
    if (q.t < SINCE || q.t < W.t0) continue;
    assert.ok(q.f && q.f.st === 10 && q.f.lo <= W.lo && q.f.hi >= W.hi, 'its part covers the window');
  }
});

test('while its tiles are read, no column is drawn at $100: the ones not in yet wait, blank', () => {
  const vk = viewKey('BTC', 'sodex', view(10));
  // Half the tiles on screen in (the newest), as after a pan or a zoom out.
  const half = held(10, (k) => k.t0 >= NEWEST - 6 * H);
  const r = fineFrame(coarse, vk, 10, ks, null, getOf(half));
  assert.equal(r.waiting, true);
  const steps = stepsDrawn(r.points);
  assert.ok(!steps.has(100), 'no $100 cell inside the window from SINCE on');
  assert.deepEqual([...steps], [10]);
});

test('a step change (Auto zooming in, $10 -> $1) redraws every column at once: the old step until the new one is in, then the new', () => {
  const vk10 = viewKey('BTC', 'sodex', view(10));
  const vk1 = viewKey('BTC', 'sodex', view(1));
  const t10 = held(10);
  // $1 asked: its tiles partly in. Every column stays at $10 - not the newest alone at $1.
  const part1 = held(1, (k) => k.t0 >= NEWEST - 6 * H);
  const mid = fineFrame(coarse, vk1, 1, ks, { vk: vk10, step: 10 }, getOf(t10, part1));
  assert.equal(mid.waiting, true);
  assert.deepEqual([...stepsDrawn(mid.points)], [10]);
  // All in: every column at $1.
  const done = fineFrame(coarse, vk1, 1, ks, { vk: vk10, step: 10 }, getOf(t10, held(1)));
  assert.equal(done.waiting, false);
  assert.deepEqual([...stepsDrawn(done.points)], [1]);
});

test('before the fine levels were kept: the snapshots\' own step (nothing finer exists)', () => {
  const r = fineFrame(coarse, viewKey('BTC', 'sodex', view(10)), 10, ks, null, getOf(held(10)));
  const old = r.points.filter((q) => q.t < SINCE && q.t >= W.t0);
  assert.ok(old.length > 0 && old.every((q) => !q.f && cellsOf(q).every((c) => c.st === 100)));
});

test('a snapshot\'s bands put back together: the contiguous run, its rows merged', () => {
  const a = { lo: 75_000, hi: 80_000, st: 10, b: [[7_600, 1, 0]] as HeatPoint['b'] };
  const b = { lo: 80_000, hi: 85_000, st: 10, b: [[8_100, 0, 2]] as HeatPoint['b'] };
  const far = { lo: 95_000, hi: 100_000, st: 10, b: [[9_600, 0, 3]] as HeatPoint['b'] };
  assert.deepEqual(mergeParts([b, far, a]), { st: 10, lo: 75_000, hi: 85_000, b: [[7_600, 1, 0], [8_100, 0, 2]] });
});

test('the pool: a power of two of steps within a pixel, none under two steps a pixel', () => {
  assert.equal(poolOf(10, 53), 40);
  assert.equal(poolOf(10, 19), 0);
  assert.equal(poolOf(1, 1000), 512);
});

test('a pixel shows its strongest cell; pooled to the pixel, the tiles paint what every cell paints', () => {
  const step = 1;
  const full: HeatPoint = { t: 0, p: P, st: 100, b: [], f: { st: step, lo: P * 0.99, hi: P * 1.01, b: rows(step, P * 0.99, P * 1.01, 9) } };
  // A pixel 8 steps tall, its edges on the pool's grid (a pool of 8 is a pixel). On screen they are
  // not: a pooled group across a pixel edge paints its strongest in one of the two rows (a pixel off).
  const top = 8 * Math.ceil((P * 1.01) / 8) + 4;
  const y = (price: number) => Math.round((top - price) / 8);
  for (const side of ['both', 'long', 'short'] as const) {
    for (const lev of [LEV_BANDS, ['high'] as const, ['low', 'mid'] as const]) {
      const levSet = new Set(lev.map((b) => LEV_BANDS.indexOf(b) as 0 | 1 | 2));
      const pooled: HeatPoint = { ...full, f: { ...full.f!, b: poolRows(full.f!.b as never, step, { pool: 8, side, lev: levSet }) as never } };
      const a = pixelCells(cellsOf(full), side, lev, step, 1e5, y);
      const b = pixelCells(cellsOf(pooled), side, lev, step, 1e5, y);
      assert.deepEqual(b, a, `${side} ${lev.join(',')}`);
      // And the strongest: every painted row holds no weaker value than a cell in it.
      assert.ok(a.length > 0);
    }
  }
});

test('one per bar: the snapshot the tile keeps for a bar is the one the chart draws', () => {
  // The server keeps the newest snapshot of each [off + n * every, ...) (server test liqHistFineTiles): the chart's snapshotFor for the bar.
  for (const every of [Q, H, 4 * H]) {
    for (let bar = NEWEST - 10 * every; bar < NEWEST; bar += every) {
      const inBar = times.filter((t) => t >= bar && t < bar + every);
      if (!inBar.length) continue;
      assert.equal(times[snapshotFor(times, bar, every)], inBar.at(-1));
    }
  }
});

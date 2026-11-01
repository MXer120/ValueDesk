/**
 * The historical heatmap in tiles (tileGrid.ts, histTiles.ts, server indexer/liqTiles.ts): the tiles a window
 * takes, the snapshots put back together from them, and the colour scales the server sends, against
 * the view's own heatScale over the same snapshots - the colours must not change with the tiling.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { histScales, snapScales, scaleKey } from '@sign/indexer/liqTiles.js';
import { heatScale, type HeatPoint } from '../../chart/liqHeatIndicator';
import { LEV_BANDS, type LevBand as WebBand } from '../../chart/liqLev';
import { assemble, bandSpanOf, mergeRows, scaleKeyOf, tileMsOf, tilesFor, type TileGrid } from './tileGrid';

const H = 3_600_000;
const SLOT = 6 * H;

function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
}

test('the colour scales the index sends are the view\'s heatScale, for every side and leverage filter', () => {
  const r = rng(5);
  // Snapshots of two steps (the newest sets the width the colours are of), rows with and without bands, a few huge.
  const pts: HeatPoint[] = Array.from({ length: 60 }, (_, k) => {
    const st = k < 30 ? 200 : 100;
    const b: HeatPoint['b'] = [];
    for (let i = 0; i < 150; i++) {
      const l = r() < 0.5 ? Math.round(r() ** 4 * 3e6) : 0;
      const s = l ? 0 : Math.round(r() ** 4 * 3e6);
      const row: HeatPoint['b'][number] = [300 + i * 3 + (k % 3), l, s];
      if (r() < 0.7) { const third = Math.round((l || s) / 3); row.push(...(l ? [third, third, 0, 0, 0, 0] : [0, 0, 0, third, 0, third])); }
      if (r() < 0.01) row[1] = 7e7;
      b.push(row);
    }
    return { t: k * 15 * 60_000, p: 78_000, st, b };
  });
  const sc = histScales(pts.map((q) => ({ st: q.st, sc: snapScales(q.b) })));
  const sets: WebBand[][] = [[...LEV_BANDS], ['low'], ['mid'], ['high'], ['low', 'mid'], ['low', 'high'], ['mid', 'high']];
  for (const side of ['both', 'long', 'short'] as const) {
    for (const lev of sets) {
      const want = heatScale(pts, side, lev);
      const got = sc[scaleKeyOf(side, lev)];
      assert.ok(got !== undefined, `${side} ${lev.join(',')}: sent`);
      assert.ok(Math.abs(got! / want - 1) < 1e-12, `${side} ${lev.join(',')}: ${got} against ${want}`);
    }
  }
  assert.equal(scaleKeyOf('long', ['low', 'high']), scaleKey('long', [0, 2]));
  assert.equal(scaleKeyOf('both', [...LEV_BANDS]), scaleKey('both', null));
});

const grid = (newest: number): TileGrid => ({ newest, slot: SLOT, bw: 5000, tLevels: 3, pLevels: 4 });

test('a window takes the tiles on screen first, few of them, and the newest slot up to the newest snapshot', () => {
  const newest = Date.UTC(2026, 10, 1, 18, 15);
  const g = grid(newest);
  // The view's default: about a day of 15m bars, the candles a few percent tall.
  const ks = tilesFor(g, { t0: newest - 26 * H, t1: newest + 15 * 60_000, lo: 75_500, hi: 80_500 });
  const near = ks.filter((k) => k.near);
  assert.ok(near.length > 0 && near.length <= 12, `on screen: ${near.length} tiles`);
  assert.ok(ks.findIndex((k) => !k.near) >= near.length, 'on screen first');
  assert.ok(ks.every((k) => k.pl === 0 && k.bw === 5000));
  assert.deepEqual([...new Set(near.map((k) => k.band))].sort(), [15, 16], '$75K-$85K');
  const open = ks.filter((k) => k.v !== undefined);
  assert.ok(open.length > 0 && open.every((k) => k.v === newest && k.tl === 0 && k.tt <= newest && k.tt + SLOT > newest), 'only the slot still filling carries v=');
  // A month at 4h bars: wider slots once final, the newest part still in 6 h slots; prices zoomed out: wider bands.
  const wide = tilesFor(g, { t0: newest - 30 * 24 * H, t1: newest, lo: 30_000, hi: 140_000 });
  assert.ok(wide.some((k) => k.tl === 2), 'the month in 4-day slots');
  assert.ok(wide.filter((k) => k.tl > 0).every((k) => k.tt + tileMsOf(g, k.tl) <= newest), 'a wide slot only once final');
  assert.ok(wide.some((k) => k.tl === 1), 'the 4-day slot still filling: its final days');
  assert.ok(wide.every((k) => k.pl === 2 && bandSpanOf(5000, 2) === 80_000), 'bands of $80K');
  assert.ok(wide.filter((k) => k.near).length <= 3 * 12, `few tiles: ${wide.filter((k) => k.near).length}`);
  assert.deepEqual(tilesFor({ ...g, newest: null }, { t0: 0, t1: 1, lo: 1, hi: 2 }), []);
  // Every time on screen is covered, once per band, by the tiles taken.
  for (const w of [{ t0: newest - 26 * H, t1: newest }, { t0: newest - 30 * 24 * H, t1: newest }]) {
    const got = tilesFor(g, { ...w, lo: 76_000, hi: 79_000 }).filter((k) => k.near && k.band === k.band);
    for (let t = w.t0; t < w.t1; t += 15 * 60_000) {
      const over = got.filter((k) => k.t0 <= t && t < k.t1);
      const bands = new Set(over.map((k) => k.band));
      assert.equal(over.length, bands.size, `one tile per band at ${new Date(t).toISOString()}`);
      assert.ok(over.length > 0, `covered at ${new Date(t).toISOString()}`);
    }
  }
});

test('snapshots put back together from tiles: every band once, a bucket two tiles hold once, unchanged ones kept', () => {
  const row = (i: number, l: number): HeatPoint['b'][number] => [i, l, 0];
  const a = { id: 'a', tile: { points: [{ t: 1, p: 100, st: 1, b: [row(10, 1), row(11, 2)] }, { t: 2, p: 101, st: 1, b: [row(10, 5)] }] } };
  const b = { id: 'b', tile: { points: [{ t: 1, p: 100, st: 1, b: [row(20, 3)] }] } };
  const wide = { id: 'w', tile: { points: [{ t: 1, p: 100, st: 1, b: [row(11, 2), row(20, 3), row(30, 4)] }] } };
  const first = assemble([a, b], new Map());
  assert.deepEqual(first.points.map((q) => q.t), [1, 2]);
  assert.deepEqual(first.points[0]!.b, [row(10, 1), row(11, 2), row(20, 3)]);
  const again = assemble([a, b, wide], first.memo);
  assert.deepEqual(again.points[0]!.b, [row(10, 1), row(11, 2), row(20, 3), row(30, 4)], 'a wider tile adds only what was missing');
  assert.equal(again.points[1], first.points[1], 'a snapshot whose tiles did not change keeps its object');
  assert.notEqual(again.points[0], first.points[0]);
  assert.deepEqual(mergeRows([[row(5, 1)]]), [row(5, 1)]);
});

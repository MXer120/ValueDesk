/**
 * The historical heatmap's tiles cut to what a view draws (perf pass 2026-11-17: slim rows, the snapshot each bar draws,
 * the slot still filling as single snapshots; server indexer/liqTiles.ts, tileGrid.ts, histTiles.ts) draw exactly what
 * today's whole tiles draw. The tiles are served here as the server cuts them (its own tileGroups, bandOf), put back
 * together as the view does (assemble), and painted by the layer itself (liqHeatIndicator.ts liqHeatTemplate.draw) on a
 * recording canvas: every rectangle and colour the same, by side and by leverage, at 1m to 1d bars.
 *   npx tsx --test src/components/liqmap/tileCut.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { bandOf, bandSpan, bandWidth, tileGroups, tileMs, type LiqTile } from '@sign/indexer/liqTiles.js';
import { boxed, heatScale, liqHeatTemplate, snapshotFor, type HeatData, type HeatPoint } from '../../chart/liqHeatIndicator';
import { LEV_BANDS } from '../../chart/liqLev';
import { assemble, drawGridOf, drawnIn, slotId, tileId, tilesFor, type TileCut, type TileGrid, type TileKey, type TileWindow } from './tileGrid';

const M = 60_000;
const Q = 15 * M;
const H = 60 * M;
const D = 24 * H;

function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
}

/** Three days of 15-minute snapshots near $80K at a $100 step, rows of every kind (with and without bands). */
function snapshots(newest: number): HeatPoint[] {
  const r = rng(11);
  const out: HeatPoint[] = [];
  for (let t = newest - 3 * D; t <= newest; t += Q) {
    const p = 80_000 + 1_500 * Math.sin(t / (7 * H)) + 300 * (r() - 0.5);
    const st = 100;
    const by = new Map<number, number[]>();
    for (let k = 0; k < 700; k++) {
      const px = p * (1 + (r() - 0.5) * 0.3);
      const i = Math.floor(px / st);
      const long = px < p;
      const row = by.get(i) ?? [i, 0, 0, 0, 0, 0, 0, 0, 0];
      const usd = Math.round(r() ** 4 * 3e6) + 50;
      row[long ? 1 : 2]! += usd;
      if (r() < 0.7) row[(long ? 3 : 6) + Math.floor(r() * 3)]! += usd;
      by.set(i, row);
    }
    const b = [...by.values()].sort((x, y) => x[0]! - y[0]!).map((row) => { let n = row.length; while (n > 3 && !row[n - 1]) n--; return row.slice(0, n); }) as HeatPoint['b'];
    out.push({ t, p, st, b });
  }
  return out;
}

/** A tile as the server answers it (liqTiles.ts liqTile: the slot up to `v`, or `at` alone, one a bar, the band, slim rows). */
function serve(snaps: readonly HeatPoint[], newest: number, k: TileKey): LiqTile {
  const end = k.tt + tileMs(k.tl);
  const upTo = Math.min(end - 1, k.v ?? Number.MAX_SAFE_INTEGER);
  const list = snaps.filter((q) => q.t >= k.tt && q.t <= upTo);
  const span = bandSpan(k.bw, k.pl);
  const points = tileGroups(list, k).map((g) => {
    const q = g.at(-1)!;
    const b = q.b.filter((r) => bandOf(r[0], q.st, span) === k.band).map((r) => (k.fields === 'ls' ? r.slice(0, 3) : r));
    return { t: q.t, p: q.p, st: q.st, b: b as LiqTile['points'][number]['b'] };
  });
  return { coin: 'BTC', venues: [], ...k, final: newest >= end, points } as LiqTile;
}

/** The newest `v` held of a key's slot still filling (histTiles.ts heldV). */
function heldVOf(held: Map<string, LiqTile>, k: TileKey): number | null {
  let v: number | null = null;
  for (const t of held.values()) if (t.v !== undefined && slotId('BTC', 'v', t) === slotId('BTC', 'v', k) && (v === null || t.v > v)) v = t.v;
  return v;
}

/** What the view holds after reading the tiles a window takes (those not held yet, as histTiles.ts fetchTile): id -> tile. */
function read(snaps: readonly HeatPoint[], g: TileGrid, w: TileWindow, cut: TileCut | undefined, held = new Map<string, LiqTile>()): Map<string, LiqTile> {
  const ks = tilesFor(g, w, cut ? { ...cut, has: (x) => held.has(tileId('BTC', 'v', x)), heldV: (x) => heldVOf(held, x) } : undefined);
  for (const k of ks) if (!held.has(tileId('BTC', 'v', k))) held.set(tileId('BTC', 'v', k), serve(snaps, g.newest!, k));
  return held;
}

/** The snapshots drawn from the tiles held, as histTiles.ts puts them together (a slim tile only for a slim view). */
const pointsOf = (held: Map<string, LiqTile>, slim: boolean): HeatPoint[] =>
  assemble([...held].filter(([, t]) => slim || t.fields !== 'ls').map(([id, tile]) => ({ id, tile })), new Map()).points;

/** The layer's paint of `points` on a 375 x 300 pane over the bars `bars`: every rectangle with its colour. */
function paint(points: HeatPoint[], bars: number[], w: TileWindow, data: Omit<HeatData, 'points'>): string[] {
  const list = bars.map((timestamp) => ({ timestamp, open: 1, high: 1, low: 1, close: 1, volume: 0 }));
  const W = 375;
  const Hpx = 300;
  const calls: string[] = [];
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textBaseline: '',
    save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, setLineDash() {}, moveTo() {}, lineTo() {}, stroke() {}, fillText() {},
    measureText: () => ({ width: 10 }),
    fillRect(x: number, y: number, a: number, b: number) { calls.push(`${this.fillStyle}|${x}|${y}|${a}|${b}`); },
  };
  const chart = {
    getDataList: () => list,
    getVisibleRange: () => ({ from: 0, to: list.length, realFrom: 0, realTo: list.length }),
    getBarSpace: () => ({ bar: Math.max(1, (W / list.length) * 0.8), halfBar: 0, gapBar: (W / list.length) * 0.2, halfGapBar: 0 }),
  };
  const xAxis = { convertTimestampToPixel: (t: number) => ((t - w.t0) / (w.t1 - w.t0)) * W };
  const yAxis = { convertToPixel: (p: number) => ((w.hi - p) / (w.hi - w.lo)) * Hpx };
  liqHeatTemplate.draw!({ ctx, chart, indicator: { extendData: boxed({ ...data, points }) }, bounding: { width: W, height: Hpx, left: 0, top: 0, right: 0, bottom: 0 }, xAxis, yAxis } as never);
  return calls;
}

const NEWEST = Date.UTC(2026, 10, 17, 13, 45);

test('cut tiles paint what whole tiles paint: by side with slim rows and one snapshot a bar, by leverage with whole rows', () => {
  const snaps = snapshots(NEWEST);
  const last = snaps.at(-1)!;
  const g: TileGrid = { newest: NEWEST, slot: 6 * H, bw: bandWidth(last.p), tLevels: 3, pLevels: 4, points: snaps.map((q) => ({ t: q.t, p: q.p, st: q.st })) };
  const scaleSide = heatScale(snaps);
  const scaleLev = heatScale(snaps, 'both', ['low', 'high']);
  let painted = 0;
  // A phone's 1m chart at the right edge, 15m, 1h and 4h at the edge and back in time, a daily chart over the three days.
  for (const [bar, n, back] of [[M, 70, 0], [15 * M, 96, 0], [H, 48, 0], [H, 60, 30 * H], [4 * H, 18, 0], [D, 4, 0], [30 * M, 50, 7 * H]] as const) {
    const lastBar = Math.floor((NEWEST - back) / bar) * bar;
    const bars = Array.from({ length: n }, (_, k) => lastBar - (n - 1 - k) * bar);
    const w: TileWindow = { t0: bars[0]!, t1: lastBar + bar, lo: last.p * 0.985, hi: last.p * 1.012 };
    const draw = drawGridOf(bars.map((timestamp) => ({ timestamp })));
    assert.equal(draw === null, bar <= 15 * M, `${bar / M}m: a bar longer than a snapshot is cut`);
    const whole = pointsOf(read(snaps, g, w, undefined), false);
    // By side, every band: slim rows, one snapshot a bar, the slot still filling as singles.
    const slim = pointsOf(read(snaps, g, w, { slim: true, draw, singles: true }), true);
    const side = { side: 'both' as const, scale: scaleSide };
    const a = paint(whole, bars, w, side);
    assert.ok(a.length > 50, `${bar / M}m: ${a.length} cells painted`);
    assert.deepEqual(paint(slim, bars, w, side), a, `${bar / M}m by side`);
    assert.deepEqual(paint(slim, bars, w, { side: 'long', scale: scaleSide }), paint(whole, bars, w, { side: 'long', scale: scaleSide }), `${bar / M}m longs only`);
    // By leverage (or a band filter): whole rows, still one snapshot a bar.
    const full = pointsOf(read(snaps, g, w, { draw, singles: true }), false);
    const lev = { side: 'both' as const, colorBy: 'lev' as const, lev: ['low', 'high'] as const, scale: scaleLev };
    assert.deepEqual(paint(full, bars, w, { ...lev, lev: [...lev.lev] }), paint(whole, bars, w, { ...lev, lev: [...lev.lev] }), `${bar / M}m by leverage`);
    assert.deepEqual(paint(full, bars, w, { side: 'both', colorBy: 'lev', lev: [...LEV_BANDS], scale: scaleSide }), paint(whole, bars, w, { side: 'both', colorBy: 'lev', lev: [...LEV_BANDS], scale: scaleSide }));
    // The hover and a click read the snapshot each bar draws: the same one, the same cells.
    const tw = whole.map((q) => q.t);
    const ts = slim.map((q) => q.t);
    for (const t of bars) {
      const i = snapshotFor(tw, t, bar);
      const j = snapshotFor(ts, t, bar);
      assert.equal(i < 0 ? null : tw[i], j < 0 ? null : ts[j], `${bar / M}m bar ${new Date(t).toISOString()}`);
    }
    // Fewer bytes held for it, never more.
    const rows = (ps: HeatPoint[]) => ps.reduce((s, q) => s + q.b.reduce((x, r) => x + r.length, 0), 0);
    if (draw) assert.ok(rows(slim) < rows(whole) / 2, `${bar / M}m: ${rows(slim)} numbers against ${rows(whole)}`);
    painted++;
  }
  assert.equal(painted, 7);
});

test('the slot still filling: read whole once, then a single per new snapshot; once passed, those held stand for it', () => {
  const snaps = snapshots(NEWEST);
  const g = (newest: number): TileGrid => ({ newest, slot: 6 * H, bw: bandWidth(snaps.at(-1)!.p), tLevels: 3, pLevels: 4, points: snaps.filter((q) => q.t <= newest).map((q) => ({ t: q.t, p: q.p, st: q.st })) });
  const p = snaps.at(-1)!.p;
  const draw = { every: H, off: 0 };
  const hhmm = (t: number | undefined) => new Date(t!).toISOString().slice(11, 16);
  // 07:45: the slot of 06:00 holds 06:00-07:45. A first view reads it in one tile up to 07:45 per band, as before.
  const before = NEWEST - 6 * H;
  const slot = Math.floor(before / (6 * H)) * 6 * H;
  const w = (newest: number): TileWindow => ({ t0: newest - 10 * H, t1: newest + Q, lo: p * 0.99, hi: p * 1.01 });
  const cut = { slim: true, draw, singles: true };
  const held = new Map<string, LiqTile>();
  const first = tilesFor(g(before), w(before), { ...cut, has: () => false, heldV: () => null }).filter((k) => k.tt === slot);
  assert.ok(first.length > 0 && first.every((k) => k.v === before && k.at === undefined && k.every === H), 'one tile up to the newest, cut to the bars');
  read(snaps, g(before), w(before), cut, held);
  // 08:00 and 08:15: that tile stays, and the snapshot drawn since comes as a single (no bars: one snapshot is one).
  const at0800 = before + Q;
  const next = tilesFor(g(at0800), w(at0800), { ...cut, has: (k) => held.has(tileId('BTC', 'v', k)), heldV: (k) => heldVOf(held, k) }).filter((k) => k.tt === slot);
  assert.deepEqual([...new Set(next.map((k) => (k.at !== undefined ? `at ${hhmm(k.at)}` : `v ${hhmm(k.v)}`)))].sort(), ['at 08:00', 'v 07:45']);
  assert.ok(next.filter((k) => k.at !== undefined).every((k) => k.every === undefined && k.fields === 'ls'));
  // The view watches the slot fill and pass (12:00): the tile up to 07:45 and a single of each snapshot drawn since.
  const after = before + 4 * H + 45 * M;
  for (let t = before; t <= after; t += Q) read(snaps, g(t), w(t), cut, held);
  const kept = tilesFor(g(after), w(after), { ...cut, has: (k) => held.has(tileId('BTC', 'v', k)), heldV: (k) => heldVOf(held, k) }).filter((k) => k.tt === slot);
  assert.ok(kept.length > 0 && kept.every((k) => k.v === before || k.at !== undefined), 'the passed slot: what was read of it, no 6 h tile');
  assert.deepEqual([...new Set(kept.filter((k) => k.at !== undefined).map((k) => hhmm(k.at)))].sort(), ['08:45', '09:45', '10:45', '11:45']);
  // A view that did not watch it reads the slot's tile.
  const cold = tilesFor(g(after), w(after), { ...cut, has: () => false, heldV: () => null }).filter((k) => k.tt === slot);
  assert.ok(cold.length > 0 && cold.every((k) => k.tl === 0 && k.at === undefined && k.v === undefined && k.every === H));
  // Either way the same paint as the whole tiles.
  const bars = Array.from({ length: 10 }, (_, k) => Math.floor(after / H) * H - (9 - k) * H);
  const wb = { t0: bars[0]!, t1: bars.at(-1)! + H, lo: p * 0.99, hi: p * 1.01 };
  const side = { side: 'both' as const, scale: heatScale(snaps) };
  const whole = paint(pointsOf(read(snaps, g(after), wb, undefined), false), bars, wb, side);
  assert.ok(whole.length > 20);
  assert.deepEqual(paint(pointsOf(read(snaps, g(after), wb, cut, held), true), bars, wb, side), whole);
  assert.deepEqual(paint(pointsOf(read(snaps, g(after), wb, cut), true), bars, wb, side), whole);
});

test('the bars a chart draws: cut only when every bar starts on one grid and is longer than a snapshot', () => {
  const at = (bar: number, n: number) => Array.from({ length: n }, (_, k) => ({ timestamp: 1_700_000_000_000 - (1_700_000_000_000 % bar) + k * bar }));
  assert.deepEqual(drawGridOf(at(H, 10)), { every: H, off: 0 });
  assert.equal(drawGridOf(at(15 * M, 10)), null, 'every snapshot drawn anyway');
  assert.equal(drawGridOf(at(M, 10)), null);
  const d = drawGridOf(at(D, 10))!;
  assert.equal(d.every, D);
  // Months: no fixed length.
  const months = [Date.UTC(2026, 7, 1), Date.UTC(2026, 8, 1), Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1)].map((timestamp) => ({ timestamp }));
  assert.equal(drawGridOf(months), null);
  // A gap at the end (a missing bar): barMsOf reads two bars, the grid no longer holds.
  const gap = at(H, 10);
  gap[9] = { timestamp: gap[8]!.timestamp + 2 * H };
  assert.equal(drawGridOf(gap), null);
  assert.equal(drawGridOf(at(8 * D, 5)), null, 'longer than the server cuts to');
});

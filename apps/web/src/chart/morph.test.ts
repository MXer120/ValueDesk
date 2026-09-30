/**
 * The skeleton (the digitised reference), the pairing of placeholders with
 * loaded bars, and the morph's geometry, timing and colour.
 *   npx tsx --test src/chart/morph.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chartStyles } from './theme';
import { SKELETON_REF, SKELETON_SERIES } from './skeletonSeries';
import { lerpLine } from './priceLine';
import {
  MORPH_HIDDEN,
  MORPH_HIDDEN_CANDLES,
  MORPH_MS,
  MORPH_OUT_TOTAL_MS,
  MORPH_SHOWN,
  MORPH_TOTAL_MS,
  RESTYLE_MS,
  lastPriceDir,
  niceY,
  barBody,
  barX,
  candleGeom,
  cssColor,
  direction,
  lerpGeom,
  matchSlots,
  mixColor,
  morphFrame,
  morphProgress,
  morphable,
  outFrame,
  over,
  pairByRecency,
  parseColor,
  skeletonFor,
  skeletonSeriesFor,
  spritesOf,
  type Geom,
  type Palette,
  type Placeholder,
  type RGBA,
  type Target,
} from './morph';

const REF_W = SKELETON_REF.plot.width;
const REF_H = SKELETON_REF.plot.height;

test('body width follows klinecharts (StoreImp._calcOptimalBarSpace)', () => {
  assert.deepEqual(barBody(6), { gapBar: 5, halfGapBar: 2 }); // theme.ts: "6 lands exactly there"
  assert.deepEqual(barBody(10), { gapBar: 7, halfGapBar: 3 });
  assert.deepEqual(barBody(1), { gapBar: 1, halfGapBar: 0 });
  assert.deepEqual(barBody(50), { gapBar: 40, halfGapBar: 20 });
  for (let b = 1; b <= 50; b += 0.37) assert.ok(barBody(b).gapBar <= Math.floor(b) && barBody(b).gapBar >= 1);
});

test('candle geometry is the rects klinecharts draws', () => {
  // open 50, close 40, high 30, low 70 (pixels; y grows down)
  assert.deepEqual(candleGeom(100, [50, 40, 30, 70], 6), {
    x: 100, wickTop: 30, wickHeight: 40, bodyLeft: 98, bodyTop: 40, bodyWidth: 5, bodyHeight: 10, bodyBottom: 50,
  });
  // A doji's body is drawn 1px tall, but a hollow candle's lower wick still
  // starts at the body's price edge.
  assert.equal(candleGeom(100, [50, 50, 45, 55], 6).bodyBottom, 50);
  assert.equal(candleGeom(100, [50, 50, 45, 55], 6).bodyHeight, 1);
  // An even body width gets the correction pixel.
  assert.equal(candleGeom(100, [50, 40, 30, 70], 50).bodyWidth, 41);
  assert.equal(direction(1, 2), 'up');
  assert.equal(direction(2, 1), 'down');
  assert.equal(direction(2, 2), 'flat');
});

// --- the series ---------------------------------------------------------------

test('the digitised series: 96 candles, a dip then the climb, OHLC-consistent', () => {
  assert.equal(SKELETON_SERIES.length, 96);
  for (const [o, h, l, c] of SKELETON_SERIES) {
    assert.ok(h >= Math.max(o, c) - 1e-9 && l <= Math.min(o, c) + 1e-9, `[${o}, ${h}, ${l}, ${c}] is not a candle`);
    assert.ok(l >= 84_300 && h <= 85_300, 'inside the reference axis');
  }
  // Consecutive candles connect: each opens at the previous close, or a pixel
  // row (1.83) off it where the reference itself shows a one-row gap.
  for (let i = 1; i < SKELETON_SERIES.length; i++) {
    assert.ok(Math.abs(SKELETON_SERIES[i]![0] - SKELETON_SERIES[i - 1]![3]) <= 2, `gap before candle ${i}`);
  }
  // The shape: from ~84,600 down to ~84,350, then up to ~85,200.
  const lows = SKELETON_SERIES.map((k) => k[2]);
  const highs = SKELETON_SERIES.map((k) => k[1]);
  const lowAt = lows.indexOf(Math.min(...lows));
  assert.ok(Math.abs(SKELETON_SERIES[0]![0] - 84_600) < 40);
  assert.ok(Math.abs(Math.min(...lows) - 84_350) < 30 && lowAt > 15 && lowAt < 35, 'the dip');
  assert.ok(Math.abs(Math.max(...highs) - 85_200) < 40 && highs.indexOf(Math.max(...highs)) > 85, 'the climb');
  const ups = SKELETON_SERIES.filter(([o, , , c]) => c > o).length;
  const downs = SKELETON_SERIES.filter(([o, , , c]) => c < o).length;
  assert.equal(ups + downs, 95, 'one flat candle');
  assert.ok(ups > 40 && downs > 35, 'both directions, the rhythm');
});

/** The rows the digitiser read off the reference (docs/skeleton-reference.png),
 *  for a few candles: [x, wickTop, wickBottom, bodyTop, bodyBottom]. */
const REF_ROWS: Array<[number, number, number, number, number, number]> = [
  // index, x, wickTop, wickBottom (last row), bodyTop, bodyBottom (last row)
  [0, 8, 395, 429, 395, 427],
  [22, 186, 513, 540, 513, 527],
  [54, 444, 369, 380, 375, 375],
  [85, 693, 201, 312, 204, 312],
  [94, 766, 65, 90, 81, 87],
  [95, 774, 85, 125, 88, 113],
];

test('barX is klinecharts\' dataIndexToCoordinate for the view a load resets to', () => {
  // StoreImp: floor(totalBarSpace - (dataCount + offsetRight / barSpace - dataIndex - 0.5) * barSpace + 0.5)
  const kc = (w: number, n: number, i: number, bar: number, off: number) => Math.floor(w - (n + off / bar - i - 0.5) * bar + 0.5);
  for (const [w, bar, off] of [[777, 6, 80], [300, 6, 80], [1204, 6, 80]] as const) {
    for (const k of [0, 1, 2, 17, 100]) assert.equal(barX(w, k, bar, off), kc(w, 500, 499 - k, bar, off), `w ${w} bar ${bar} k ${k}`);
  }
  // Off the integer grid klinecharts' own floating point (it depends on the
  // data count) can land a knife-edge .5 either way: a pixel, never more.
  // The skeleton is only a prediction; the landing reads the real positions.
  for (const [w, bar, off] of [[1003.5, 6, 80], [900, 9.3, 120], [640, 1.7, 80]] as const) {
    for (const k of [0, 1, 2, 17, 100]) assert.ok(Math.abs(barX(w, k, bar, off) - kc(w, 500, 499 - k, bar, off)) <= 1, `w ${w} bar ${bar} k ${k}`);
  }
  assert.equal(barX(777, 0, 6, 80), 694, 'the newest bar 83px in from the axis at the defaults');
});

test('at the reference size: the reference\'s own rows, on klinecharts\' grid', () => {
  const s = skeletonFor({ width: REF_W, height: REF_H, barSpace: 6, offsetRight: 80 });
  // Every slot from the left edge to the newest bar: 116 at 6px.
  assert.equal(s.length, 116);
  const lead = s.length - 96;
  for (const [j, , wt, wb, bt, bb] of REF_ROWS) {
    const g = s[lead + j]!.geom;
    assert.equal(g.wickTop, wt, `candle ${j} wick top`);
    assert.equal(g.wickTop + g.wickHeight - 1, wb, `candle ${j} wick bottom`);
    assert.equal(g.bodyTop, bt, `candle ${j} body top`);
    assert.equal(g.bodyTop + g.bodyHeight - 1, bb, `candle ${j} body bottom`);
  }
  s.forEach((k, j) => {
    assert.equal(k.geom.x, barX(REF_W, s.length - 1 - j, 6, 80), 'on the bar grid');
    assert.equal(k.geom.bodyWidth, barBody(6).gapBar, 'klinecharts\' body for the pitch');
    assert.equal(k.geom.bodyLeft, k.geom.x - barBody(6).halfGapBar);
  });
  // The newest candle stands where the newest bar will; its close is the rule.
  const newest = s[s.length - 1]!;
  assert.equal(newest.geom.x, 694);
  const [o, , , c] = SKELETON_SERIES[95]!;
  assert.ok(c < o, 'the reference ends on a down candle');
  assert.equal(newest.tone, 'down');
  assert.equal(newest.closeY, newest.geom.bodyTop + newest.geom.bodyHeight, 'a down close is the body\'s lower edge');
  // Tones follow direction on the reference part; the one flat candle takes the light tone.
  for (let j = 0; j < 96; j++) {
    const [oo, , , cc] = SKELETON_SERIES[j]!;
    assert.equal(s[lead + j]!.tone, cc < oo ? 'down' : 'up');
  }
});

test('the skeleton fills any plot on the bars\' grid, the reference\'s shape intact', () => {
  for (const [w, h, bar] of [[1100, 560, 6], [777, 589, 6], [870, 450, 9], [300, 380, 6], [1520, 700, 6], [2400, 900, 4], [640, 420, 13]] as const) {
    const s = skeletonFor({ width: w, height: h, barSpace: bar, offsetRight: 80 });
    let n = 0;
    while (barX(w, n, bar, 80) >= 0) n++;
    assert.equal(s.length, n, `every slot on screen at ${w}px`);
    for (let j = 0; j < s.length; j++) {
      const g = s[j]!.geom;
      assert.equal(g.x, barX(w, s.length - 1 - j, bar, 80));
      assert.deepEqual(g, candleGeom(g.x, [g.bodyTop, g.bodyBottom, g.wickTop, g.wickTop + g.wickHeight], bar), 'klinecharts\' geometry');
      assert.ok(Number.isInteger(g.wickTop) && Number.isInteger(g.bodyTop));
      if (j) assert.ok(g.x > s[j - 1]!.geom.x, 'left to right');
    }
    // The reference's vertical composition: ~11% headroom, ~8% floor.
    const top = Math.min(...s.map((k) => k.geom.wickTop)) / h;
    const bottom = 1 - Math.max(...s.map((k) => k.geom.wickTop + k.geom.wickHeight)) / h;
    assert.ok(Math.abs(top - 65 / REF_H) < 0.012, `headroom ${top} at ${w}`);
    assert.ok(Math.abs(bottom - (REF_H - 541) / REF_H) < 0.012, `floor ${bottom} at ${w}`);
  }
  assert.deepEqual(skeletonFor({ width: 0, height: 500 }), []);
  assert.deepEqual(skeletonFor({ width: 500, height: 0 }), []);
  assert.deepEqual(skeletonFor({ width: 60, height: 400, barSpace: 6, offsetRight: 80 }), [], 'no room for the newest bar');
  assert.deepEqual(skeletonFor({ width: 800, height: 400 }), skeletonFor({ width: 800, height: 400 }), 'deterministic');
});

test('the reference fitted to any bar count: exact, led in, or merged', () => {
  assert.deepEqual(skeletonSeriesFor(96), [...SKELETON_SERIES]);
  assert.deepEqual(skeletonSeriesFor(0), []);
  const isCandle = ([o, h, l, c]: readonly number[]) => h! >= Math.max(o!, c!) - 1e-9 && l! <= Math.min(o!, c!) + 1e-9;
  // More: the newest 96 are the reference; the lead-in runs into it seamlessly.
  for (const n of [97, 116, 190, 192, 193, 300, 500]) {
    const s = skeletonSeriesFor(n);
    assert.equal(s.length, n);
    assert.deepEqual(s.slice(-96), [...SKELETON_SERIES], `n ${n}`);
    s.forEach((k) => assert.ok(isCandle(k)));
    for (let i = 1; i < n; i++) assert.ok(Math.abs(s[i]![0] - s[i - 1]![3]) <= 2, `seam before ${i} of ${n}`);
  }
  // Fewer: merged runs; the path still starts and ends where the reference does,
  // and keeps its extremes.
  const hi = Math.max(...SKELETON_SERIES.map((k) => k[1]));
  const lo = Math.min(...SKELETON_SERIES.map((k) => k[2]));
  for (const n of [95, 48, 36, 20, 7, 1]) {
    const s = skeletonSeriesFor(n);
    assert.equal(s.length, n);
    assert.equal(s[0]![0], SKELETON_SERIES[0]![0]);
    assert.equal(s[n - 1]![3], SKELETON_SERIES[95]![3]);
    assert.equal(Math.max(...s.map((k) => k[1])), hi);
    assert.equal(Math.min(...s.map((k) => k[2])), lo);
    s.forEach((k) => assert.ok(isCandle(k)));
  }
});

// --- pairing ---------------------------------------------------------------------

test('pairing: nearest first, one placeholder per bar, never crossing, within reach', () => {
  const slots = [10, 20, 30, 40, 50];
  // Denser bars: every bar asks for its nearest; the nearest pairs are made
  // first (9->10, 21->20, 51->50 at 1px, 38->40 at 2, 33->30 at 3) and the
  // rest find their placeholder taken.
  const dense = [9, 12, 16, 21, 24, 33, 38, 44, 51, 57].map((x, i) => ({ index: 100 + i, x }));
  const m = matchSlots(slots, dense, 10);
  assert.deepEqual([...m.entries()].sort((a, b) => a[0] - b[0]), [[100, 0], [103, 1], [105, 2], [106, 3], [108, 4]]);
  // Each placeholder at most once, pairs in order (no crossing).
  const pairs = [...m.entries()].sort((a, b) => a[0] - b[0]);
  for (let k = 1; k < pairs.length; k++) assert.ok(pairs[k]![1] > pairs[k - 1]![1]);
  assert.equal(new Set(m.values()).size, m.size);
  // Sparser bars: every bar gets a placeholder, the rest are left over.
  const sparse = matchSlots(slots, [{ index: 1, x: 18 }, { index: 2, x: 47 }], 10);
  assert.deepEqual([...sparse.entries()], [[1, 1], [2, 4]]);
  // Out of reach: no pair.
  assert.equal(matchSlots(slots, [{ index: 1, x: 90 }], 10).size, 0);
  assert.equal(matchSlots([], [{ index: 1, x: 9 }], 10).size, 0);
});

/** Bars on klinecharts' grid (6px, newest 80px in) on a plot `w` wide, newest last. */
function gridBars(w: number, newest: number, count: number, bar = 6, off = 80): Array<{ index: number; x: number }> {
  const out: Array<{ index: number; x: number }> = [];
  for (let k = count - 1; k >= 0; k--) out.push({ index: newest - k, x: barX(w, k, bar, off) });
  return out;
}

test('pairing by recency: the skeleton on the grid pairs every bar with the candle under it', () => {
  for (const w of [1100, 777, 330, 2400]) {
    const s = skeletonFor({ width: w, height: 500, barSpace: 6, offsetRight: 80 });
    const bars = gridBars(w, 499, s.length + 20).filter((b) => b.x >= -6);
    const m = pairByRecency(s.map((k) => ({ x: k.geom.x })), bars, 6);
    // Every skeleton candle is taken, each by the bar at its own x; the
    // newest candle by the newest bar.
    assert.equal(m.size, s.length, `every candle has its bar at ${w}px`);
    for (const [index, k] of m) assert.equal(s[k]!.geom.x, bars.find((b) => b.index === index)!.x);
    assert.equal(m.get(499), s.length - 1, 'newest to newest');
  }
});

test('pairing by recency: a switch moves every candle onto its counterpart, newest to newest', () => {
  // The old market's bars were drawn with a narrower price axis (the plot was
  // 7px wider) and scrolled 2 bars into history; the new ones land at the default.
  const old = gridBars(784, 999, 110).map((b) => ({ x: b.x - 12 }));
  const bars = gridBars(777, 499, 110);
  const m = pairByRecency(old, bars, 6);
  assert.equal(m.size, 110);
  for (const [index, k] of m) assert.equal(k, index - 390, 'k-th newest with k-th newest');
  // Half a pitch of shift is where x-nearest pairing goes wrong; recency does not care.
  const half = gridBars(777, 499, 110).map((b) => ({ x: b.x + 3 }));
  const h = pairByRecency(half, bars, 6);
  assert.equal(h.get(499), 109);
  for (const [index, k] of h) assert.equal(k, index - 390);
  // An interrupted morph's fading leftover right of the candles does not anchor it.
  const withGhost = [...old, { x: 900, alpha: 0.2 }];
  const g = pairByRecency(withGhost, bars, 6);
  assert.equal(g.get(499), 109, 'the newest bar still pairs with the newest live candle');
  assert.ok(![...g.values()].includes(110), 'the ghost fades out where it is');
  // Fewer new bars than candles: the newest ones pair, the oldest candles fade.
  const few = pairByRecency(old, gridBars(777, 19, 20), 6);
  assert.equal(few.size, 20);
  assert.equal(few.get(19), 109);
  assert.equal(pairByRecency([], bars, 6).size, 0);
  assert.equal(pairByRecency(old, [], 6).size, 0);
});

// --- the morph --------------------------------------------------------------------

test('interpolation, and one clock for everything', () => {
  const s: Geom = { x: 10, wickTop: 0, wickHeight: 10, bodyLeft: 8, bodyTop: 2, bodyWidth: 5, bodyHeight: 4, bodyBottom: 6 };
  const t: Geom = { x: 30, wickTop: 20, wickHeight: 30, bodyLeft: 27, bodyTop: 25, bodyWidth: 7, bodyHeight: 10, bodyBottom: 35 };
  assert.equal(lerpGeom(s, t, 0), s);
  assert.equal(lerpGeom(s, t, 1), t);
  assert.equal(lerpGeom(s, t, 0.5).x, 20);
  assert.equal(MORPH_TOTAL_MS, MORPH_MS, 'no stagger: the whole morph is one candle\'s travel');
  assert.ok(MORPH_TOTAL_MS >= 400 && MORPH_TOTAL_MS <= 650, 'within the brief');
  assert.equal(morphProgress(0), 0);
  assert.equal(morphProgress(MORPH_MS), 1);
  assert.ok(morphProgress(MORPH_MS / 2) > 0.49 && morphProgress(MORPH_MS / 2) < 0.51);
  // Taking over a moving morph: ease-out leaves at speed.
  assert.ok(morphProgress(16, 'out') > 0.08);
  // The rule's own interpolation: row and colour on the same progress.
  const a = { y: 100, color: [72, 72, 72, 1] as RGBA };
  const b = { y: 200, color: [0, 180, 129, 1] as RGBA };
  assert.equal(lerpLine(a, b, 0), a);
  assert.equal(lerpLine(a, b, 1), b);
  assert.deepEqual(lerpLine(a, b, 0.25), { y: 125, color: [54, 99, 86.25, 1] });
});

test('colour: parse, composite over the card, mix to the exact target string', () => {
  assert.deepEqual(parseColor('#00b481'), [0, 180, 129, 1]);
  assert.deepEqual(parseColor('#fff'), [255, 255, 255, 1]);
  assert.deepEqual(parseColor('rgba(255, 255, 255, 0.10)'), [255, 255, 255, 0.1]);
  assert.deepEqual(parseColor(' rgb(1 2 3 / 50%) '), [1, 2, 3, 0.5]);
  assert.equal(parseColor('transparent'), null);
  assert.equal(parseColor('var(--x)'), null);
  const panel = parseColor('#1a1a1a')!;
  const down = over(parseColor('rgba(255, 255, 255, 0.10)')!, panel);
  const up = over(parseColor('rgba(255, 255, 255, 0.20)')!, panel);
  assert.equal(cssColor(down), 'rgb(49, 49, 49)');
  assert.equal(cssColor(up), 'rgb(72, 72, 72)');
  assert.equal(mixColor(down, '#00b481', 1), '#00b481');
  assert.equal(mixColor(down, '#00b481', 0), 'rgb(49, 49, 49)');
  assert.equal(mixColor(down, '#00b481', 0.5), 'rgb(24, 114, 89)'); // 48.9 before rounding
});

const PALETTE: Palette = {
  up: { body: '#00b481', border: '#00b481', wick: '#00b481' },
  down: { body: '#ef4a3c', border: '#ef4a3c', wick: '#ef4a3c' },
  flat: { body: '#c6b6ba', border: '#c6b6ba', wick: '#c6b6ba' },
};
const UP: RGBA = [72, 72, 72, 1];
const DOWN: RGBA = [49, 49, 49, 1];
const W = 777;

/** The skeleton at the reference size as the layer holds it. */
const placeholders = (): Placeholder[] =>
  skeletonFor({ width: W, height: REF_H }).map((k) => ({ geom: k.geom, color: k.tone === 'up' ? UP : DOWN }));

/** Loaded bars on klinecharts' grid (6px, newest 80px in), ending at `newest`. */
function targets(newest: number, count: number): Target[] {
  const out: Target[] = [];
  const L = 80 / 6;
  const n = newest + 1;
  for (let i = newest - count + 1; i <= newest; i++) {
    const x = Math.floor(W - (n + L - i - 0.5) * 6 + 0.5);
    const y = 300 + ((i * 7) % 40);
    out.push({ index: i, geom: candleGeom(x, [y, y + 6, y - 5, y + 12], 6), dir: i % 3 ? 'up' : 'down' });
  }
  return out;
}

function pairFor(skel: Placeholder[], t: Target[]): Map<number, number> {
  return pairByRecency(skel.map((s) => ({ x: s.geom.x, alpha: s.alpha })), t.map((b) => ({ index: b.index, x: b.geom.x })), 6);
}

test('frame 0 is the skeleton; the landing frame is exactly the loaded bars', () => {
  const skel = placeholders();
  const bars = targets(499, 115);
  const partner = pairFor(skel, bars);
  const f0 = morphFrame({ skeleton: skel, partner, targets: bars, palette: PALETTE, elapsed: 0 });
  assert.equal(f0.done, false);
  // Every placeholder is on screen at frame 0, in its own tone, where it was.
  const paired = new Set(partner.values());
  const shown = f0.ops.filter((op) => op.alpha > 0);
  assert.equal(shown.length, skel.length);
  for (const op of shown) {
    const k = skel.findIndex((s) => s.geom.x === op.geom.x && s.geom.bodyTop === op.geom.bodyTop);
    assert.ok(k >= 0, 'a placeholder, unmoved');
    assert.equal(op.paint.body, cssColor(skel[k]!.color));
  }
  assert.ok(paired.size > 0);
  const last = morphFrame({ skeleton: skel, partner, targets: bars, palette: PALETTE, elapsed: MORPH_TOTAL_MS });
  assert.equal(last.done, true);
  assert.equal(last.ops.length, bars.length);
  last.ops.forEach((op, j) => {
    assert.equal(op.geom, bars[j]!.geom, 'same object: integer-exact');
    assert.equal(op.paint, PALETTE[bars[j]!.dir], 'klinecharts colour strings');
    assert.equal(op.alpha, 1);
  });
});

test('every paired candle converges monotonically onto its bar; extras fade', () => {
  const skel = placeholders();
  const bars = targets(499, 115);
  const partner = pairFor(skel, bars);
  // Only the paired bars: their ops are the frame's last ones, in bar order
  // (the placeholders nobody took are drawn first, underneath).
  const t = bars.filter((b) => partner.has(b.index));
  const at = (ms: number) => morphFrame({ skeleton: skel, partner, targets: t, palette: PALETTE, elapsed: ms }).ops;
  const pairedOps = (ops: ReturnType<typeof at>) => ops.slice(ops.length - t.length);
  let prev = pairedOps(at(0));
  for (let ms = 16; ms <= MORPH_TOTAL_MS + 16; ms += 16) {
    const all = at(ms);
    const cur = pairedOps(all);
    assert.ok(cur.every((op) => op.alpha === 1));
    cur.forEach((op, j) => {
      const target = t[j]!.geom;
      const p = prev[j]!.geom;
      for (const key of ['x', 'bodyTop', 'wickTop', 'wickHeight', 'bodyHeight', 'bodyWidth'] as const) {
        assert.ok(Math.abs(op.geom[key] - target[key]) <= Math.abs(p[key] - target[key]) + 1e-9, `${key} moved away at ${ms}ms`);
      }
    });
    // Fading extras: placeholders nobody took go out, unpaired bars come in.
    for (const op of all.filter((o) => o.alpha < 1)) assert.ok(op.alpha > 0);
    prev = cur;
  }
});

test('a bar that arrives mid-morph has no partner and fades in where it is', () => {
  const skel = placeholders();
  const bars = targets(499, 115);
  const partner = pairFor(skel, bars);
  const grown = [...targets(500, 116)];
  const f = morphFrame({ skeleton: skel, partner, targets: grown, palette: PALETTE, elapsed: 400 });
  const added = f.ops[f.ops.length - 1]!;
  assert.ok(added.alpha > 0 && added.alpha < 1);
  assert.equal(added.geom, grown[grown.length - 1]!.geom);
});

test('klinecharts hand-over styles: candles and grid go to the layer and come back', () => {
  const bar = MORPH_HIDDEN.candle?.bar as Record<string, string>;
  assert.equal(Object.keys(bar).length, 9);
  assert.ok(Object.values(bar).every((c) => c === 'transparent'));
  assert.equal(MORPH_HIDDEN.grid?.show, false);
  assert.equal(MORPH_HIDDEN_CANDLES.grid, undefined, 'the fallback leaves the grid to klinecharts');
  // Showing them again restores every colour the hide touched, from the theme.
  const shown = MORPH_SHOWN.candle?.bar as Record<string, string>;
  assert.deepEqual(Object.keys(shown).filter((k) => k in bar).sort(), Object.keys(bar).sort());
  assert.ok(Object.keys(bar).every((k) => parseColor(shown[k]!) !== null));
  assert.equal(MORPH_SHOWN.grid?.show, chartStyles.grid?.show);
  assert.deepEqual(shown, chartStyles.candle?.bar);
  assert.ok(morphable('candle_solid') && morphable('candle_stroke'));
  assert.ok(!morphable('ohlc') && !morphable('area') && !morphable(undefined));
});

// --- the morph out, and morphs that take over from each other ------------------

test('pairing accepts slots in any order (sprites mid-morph are not sorted)', () => {
  const sorted = matchSlots([10, 20, 30], [{ index: 1, x: 19 }, { index: 2, x: 31 }], 5);
  const shuffled = matchSlots([30, 10, 20], [{ index: 1, x: 19 }, { index: 2, x: 31 }], 5);
  assert.deepEqual([...sorted.entries()], [[1, 1], [2, 2]]);
  assert.deepEqual([...shuffled.entries()], [[1, 2], [2, 0]], 'indices into the list as given');
});

test('morph out: frame 0 is the chart as it was, the last frame is exactly the skeleton', () => {
  const skel = placeholders();
  const bars = targets(499, 115);
  // The candles on screen, as the layer takes them over from klinecharts.
  const from: Placeholder[] = bars.map((b) => ({ geom: b.geom, color: parseColor(PALETTE[b.dir].body)! }));
  const pairs = matchSlots(skel.map((s) => s.geom.x), from.map((s, i) => ({ index: i, x: s.geom.x })), 9);
  const first = outFrame({ from, to: skel, pairs, elapsed: 0, width: W });
  assert.equal(first.done, false);
  // Every real candle is drawn where it was, in its own colour, fully visible.
  const visible = first.ops.filter((op) => op.alpha > 0);
  assert.equal(visible.length, from.length);
  for (const op of visible) {
    const i = from.findIndex((s) => s.geom.x === op.geom.x && s.geom.bodyTop === op.geom.bodyTop);
    assert.ok(i >= 0, 'an unmoved candle');
    assert.equal(op.alpha, 1);
  }
  const last = outFrame({ from, to: skel, pairs, elapsed: MORPH_OUT_TOTAL_MS, width: W });
  assert.equal(last.done, true);
  assert.equal(last.ops.length, skel.length);
  last.ops.forEach((op, j) => {
    assert.equal(op.geom, skel[j]!.geom, 'the skeleton itself');
    assert.equal(op.paint.body, cssColor(skel[j]!.color));
    assert.equal(op.alpha, 1);
  });
  assert.ok(MORPH_OUT_TOTAL_MS >= 350 && MORPH_OUT_TOTAL_MS <= 450, 'inside the 350-450ms brief');
});

test('morph out: paired candles converge monotonically; extras fade out, lonely placeholders fade in', () => {
  const skel = placeholders();
  const bars = targets(499, 115);
  const from: Placeholder[] = bars.map((b) => ({ geom: b.geom, color: parseColor(PALETTE[b.dir].body)! }));
  const pairs = matchSlots(skel.map((s) => s.geom.x), from.map((s, i) => ({ index: i, x: s.geom.x })), 9);
  const paired = [...pairs.entries()];
  let prev = paired.map(([i]) => from[i]!.geom);
  for (let ms = 16; ms <= MORPH_OUT_TOTAL_MS; ms += 16) {
    const f = outFrame({ from, to: skel, pairs, elapsed: ms, width: W });
    // The paired candles are the frame's last ops, in pair order.
    const cur = f.done ? paired.map(([, j]) => skel[j]!.geom) : f.ops.slice(f.ops.length - paired.length).map((op) => op.geom);
    cur.forEach((g, k) => {
      const t = skel[paired[k]![1]]!.geom;
      for (const key of ['x', 'bodyTop', 'wickTop', 'wickHeight', 'bodyHeight', 'bodyWidth'] as const) {
        assert.ok(Math.abs(g[key] - t[key]) <= Math.abs(prev[k]![key] - t[key]) + 1e-9, `${key} moved away at ${ms}ms`);
      }
    });
    prev = cur;
    if (!f.done) for (const op of f.ops) assert.ok(op.alpha > 0 && op.alpha <= 1);
  }
});

test('a morph that takes over mid-way starts from exactly what was drawn, easing out', () => {
  const skel = placeholders();
  const bars = targets(499, 115);
  const from: Placeholder[] = bars.map((b) => ({ geom: b.geom, color: parseColor(PALETTE[b.dir].body)! }));
  const pairs = matchSlots(skel.map((s) => s.geom.x), from.map((s, i) => ({ index: i, x: s.geom.x })), 9);
  // Half-way out, the new bars arrive.
  const mid = outFrame({ from, to: skel, pairs, elapsed: MORPH_OUT_TOTAL_MS / 2, width: W });
  const sprites = spritesOf(mid.ops, DOWN);
  assert.equal(sprites.length, mid.ops.length);
  sprites.forEach((s, k) => {
    assert.equal(s.geom, mid.ops[k]!.geom);
    assert.equal(s.alpha, mid.ops[k]!.alpha);
    assert.equal(cssColor(s.color), mid.ops[k]!.paint.body);
  });
  const next = targets(499, 115).map((t) => ({ ...t, geom: { ...t.geom, bodyTop: t.geom.bodyTop - 40, wickTop: t.geom.wickTop - 40, bodyBottom: t.geom.bodyBottom - 40 } }));
  const partner = matchSlots(sprites.map((s) => s.geom.x), next.map((t) => ({ index: t.index, x: t.geom.x })), 9);
  // Frame 0 of the take-over draws the same candles, the same way.
  const f0 = morphFrame({ skeleton: sprites, partner, targets: next, palette: PALETTE, elapsed: 0, curve: 'out' });
  const key = (op: { geom: Geom; alpha: number }) => `${op.geom.x}|${op.geom.bodyTop}|${op.geom.wickHeight}|${op.alpha.toFixed(6)}`;
  assert.deepEqual(f0.ops.map(key).sort(), mid.ops.filter((op) => op.alpha > 0).map(key).sort(), 'no jump at the take-over');
  // Easing out: the first 16ms already cover a good share of the way (no restart from rest).
  const e16 = morphFrame({ skeleton: sprites, partner, targets: next, palette: PALETTE, elapsed: 16, curve: 'out' }).ops.find((op) => op.alpha === 1 || op.e > 0)!;
  assert.ok(e16.e > 0.08, `ease-out leaves at speed (e=${e16.e.toFixed(3)} after 16ms)`);
  // And it still lands exactly on the bars.
  const done = morphFrame({ skeleton: sprites, partner, targets: next, palette: PALETTE, elapsed: MORPH_TOTAL_MS, curve: 'out' });
  assert.equal(done.done, true);
  done.ops.forEach((op, j) => {
    assert.equal(op.geom, next[j]!.geom);
    assert.equal(op.paint, PALETTE[next[j]!.dir]);
  });
});

test('switch restyle: the candles on screen turn grey where they stand, quickly and all at once', () => {
  // A switch pairs every candle with itself (same geometry), so the out-morph
  // is a pure colour change that ends after RESTYLE_MS with no stagger.
  const W = 600;
  const from: Placeholder[] = [0, 1, 2, 3].map((i) => ({
    geom: candleGeom(40 + i * 120, [100 + i, 90 + i, 80 + i, 120 + i], 6),
    color: [38, 166, 154, 1] as RGBA,
  }));
  const grey: RGBA = [60, 60, 60, 1];
  const to: Placeholder[] = from.map((s) => ({ geom: s.geom, color: grey }));
  const pairs = new Map(from.map((_, i) => [i, i] as [number, number]));
  const mid = outFrame({ from, to, pairs, elapsed: RESTYLE_MS / 2, width: W, ms: RESTYLE_MS, stagger: 0 });
  assert.equal(mid.done, false);
  assert.equal(mid.ops.length, from.length);
  mid.ops.forEach((op, i) => {
    assert.deepEqual(op.geom, from[i]!.geom, 'geometry never moves during a restyle');
    assert.equal(op.alpha, 1);
  });
  // No stagger: the leftmost and rightmost candle are equally far along.
  assert.equal(mid.ops[0]!.paint.body, mid.ops[3]!.paint.body);
  const end = outFrame({ from, to, pairs, elapsed: RESTYLE_MS, width: W, ms: RESTYLE_MS, stagger: 0 });
  assert.equal(end.done, true, 'done after RESTYLE_MS');
  end.ops.forEach((op, i) => {
    assert.deepEqual(op.geom, from[i]!.geom);
    assert.equal(op.paint.body, cssColor(grey));
  });
});

test('a switch in the middle of a morph keeps both greys: each candle carries its tone', () => {
  // Fast timeframe changes: the new bars are morphing in when the next switch
  // comes. Early in the morph every candle is still nearly grey, so a tone
  // guessed from the colour came out the same for all of them.
  const skel = placeholders().map((s, i) => ({ ...s, tone: skeletonFor({ width: W, height: REF_H })[i]!.tone }));
  const bars = targets(499, 115);
  const partner = pairFor(skel, bars);
  for (const ms of [16, 60, 200, MORPH_TOTAL_MS / 2, MORPH_TOTAL_MS - 16]) {
    const f = morphFrame({ skeleton: skel, partner, targets: bars, palette: PALETTE, elapsed: ms });
    const sprites = spritesOf(f.ops, DOWN);
    const tones = new Set(sprites.map((s) => s.tone));
    assert.ok(tones.has('up') && tones.has('down'), `both greys survive a switch at ${ms}ms`);
    // A candle growing into a bar takes that bar's direction.
    const grown = f.ops.slice(f.ops.length - bars.length);
    grown.forEach((op, j) => assert.equal(op.tone, bars[j]!.dir === 'down' ? 'down' : 'up'));
  }
  // The restyle keeps the tones it is given, and hands them on.
  const from = spritesOf(morphFrame({ skeleton: skel, partner, targets: bars, palette: PALETTE, elapsed: 60 }).ops, DOWN);
  const to = from.map((s) => ({ geom: s.geom, color: s.tone === 'up' ? UP : DOWN, tone: s.tone }));
  const out = outFrame({ from, to, pairs: new Map(from.map((_, i) => [i, i] as [number, number])), elapsed: 80, width: W, ms: RESTYLE_MS, stagger: 0 });
  spritesOf(out.ops, DOWN).forEach((s, i) => assert.equal(s.tone, to[i]!.tone));
});

test('last-price rule: klinecharts nice pixel and colour rule', () => {
  // YAxisImp.convertToNicePixel: rounded, kept inside 5%..98% of the pane.
  assert.equal(niceY(123.4, 400), 123);
  assert.equal(niceY(123.5, 400), 124);
  assert.equal(niceY(2, 400), 20, 'clamped to 5% from the top');
  assert.equal(niceY(399, 400), 392, 'clamped to 98%');
  // CandleLastPriceView: against the previous close by default, or the open.
  assert.equal(lastPriceDir(101, 100, 102, undefined), 'down', 'below the previous close');
  assert.equal(lastPriceDir(101, 100, 100.5, undefined), 'up');
  assert.equal(lastPriceDir(101, 100, undefined, undefined), 'flat', 'no previous bar: compares with itself');
  assert.equal(lastPriceDir(101, 100, 102, 'current_open'), 'up', 'current_open ignores the previous close');
});

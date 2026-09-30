/**
 * The price axis: the % A L state machine, the span maths, the fit a view
 * lands on, and PriceFit carrying the axis through a move.
 *   npx tsx --test src/chart/yScale.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AxisCreateRangeCallback, AxisRange, Chart as KChart, KLineData, YAxis } from 'klinecharts';
import {
  INITIAL_SCALE,
  PriceFit,
  addGap,
  fitSpan,
  gapRates,
  holdRange,
  isAutoFit,
  kindOf,
  lerpSpan,
  pannedRange,
  rangeOfSpan,
  scaleReducer,
  stripGap,
  templateRange,
  visibleWindow,
  type ScaleAction,
  type ScaleState,
  type Span,
} from './yScale';
import { easeView, interpolateView, type View } from './viewTween';

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

// --- % A L ------------------------------------------------------------------------

test('% A L: L and % exclude each other, both off is linear, A defaults on', () => {
  const run = (...acts: ScaleAction['type'][]) => acts.reduce<ScaleState>((s, type) => scaleReducer(s, { type } as ScaleAction), INITIAL_SCALE);
  assert.deepEqual(INITIAL_SCALE, { mode: 'normal', auto: true });
  assert.equal(run('log').mode, 'logarithm');
  assert.equal(run('log', 'log').mode, 'normal', 'L toggles');
  assert.equal(run('percent').mode, 'percentage');
  assert.equal(run('percent', 'percent').mode, 'normal', '% toggles');
  assert.equal(run('log', 'percent').mode, 'percentage', '% turns L off');
  assert.equal(run('percent', 'log').mode, 'logarithm', 'L turns % off');
  // A: a toggle; the user taking the axis turns it off; a refit turns it on.
  assert.equal(run('auto').auto, false);
  assert.equal(run('auto', 'auto').auto, true);
  assert.equal(run('manual').auto, false);
  assert.equal(run('manual', 'manual').auto, false);
  assert.equal(run('manual', 'fit').auto, true, 'klinecharts refitting the axis on its own is read back as A on');
  // Changing the scale type never touches A (owner's rule), in either state.
  assert.deepEqual(run('auto', 'log'), { mode: 'logarithm', auto: false });
  assert.deepEqual(run('manual', 'percent'), { mode: 'percentage', auto: false });
  assert.deepEqual(run('log'), { mode: 'logarithm', auto: true });
  assert.deepEqual(run('auto', 'log', 'percent', 'log'), { mode: 'logarithm', auto: false });
  // A refit keeps the scale type.
  assert.equal(run('log', 'manual', 'fit').mode, 'logarithm');
  // No-ops return the same object (no re-render).
  const s = run('manual');
  assert.equal(scaleReducer(s, { type: 'manual' }), s);
  assert.equal(scaleReducer(INITIAL_SCALE, { type: 'fit' }), INITIAL_SCALE);
  assert.equal(kindOf('logarithm'), 'log');
  assert.equal(kindOf('normal'), 'linear');
  assert.equal(kindOf('percentage'), 'linear');
});

// --- spans -------------------------------------------------------------------------

test('lerpSpan: exact ends, linear in the axis space (log10 on the log axis)', () => {
  const a: Span = { from: 80_000, to: 81_000 };
  const b: Span = { from: 84_000, to: 86_000 };
  assert.deepEqual(lerpSpan(a, b, 0, 'linear'), a);
  assert.deepEqual(lerpSpan(a, b, 1, 'linear'), b);
  assert.deepEqual(lerpSpan(a, b, 1, 'log'), b);
  assert.deepEqual(lerpSpan(a, b, -1, 'log'), a);
  const m = lerpSpan(a, b, 0.5, 'linear');
  assert.ok(close(m.from, 82_000) && close(m.to, 83_500));
  const g = lerpSpan(a, b, 0.5, 'log');
  assert.ok(close(g.from, Math.sqrt(80_000 * 84_000)) && close(g.to, Math.sqrt(81_000 * 86_000)));
  // Monotonic both ends, both spaces.
  for (const kind of ['linear', 'log'] as const) {
    let prev = a;
    for (let i = 1; i <= 100; i++) {
      const s = lerpSpan(a, b, i / 100, kind);
      assert.ok(s.from >= prev.from && s.to >= prev.to);
      prev = s;
    }
  }
});

test('gap: the rates klinecharts uses, and stripGap undoes addGap exactly', () => {
  assert.deepEqual(gapRates(undefined, 500), { top: 0.2, bottom: 0.1 });
  assert.deepEqual(gapRates({ top: 0.15, bottom: 0.05 }, 500), { top: 0.15, bottom: 0.05 });
  assert.deepEqual(gapRates({ top: 50, bottom: 25 }, 500), { top: 0.1, bottom: 0.05 }, 'px when >= 1');
  const rates = gapRates(undefined, 500);
  for (const kind of ['linear', 'log'] as const) {
    for (const s of [{ from: 84_000, to: 84_600 }, { from: 0.0012, to: 0.0019 }, { from: 99, to: 101 }]) {
      const shown = addGap(s, rates, kind);
      assert.ok(shown.from < s.from && shown.to > s.to);
      const back = stripGap(shown, rates, kind);
      assert.ok(close(back.from, s.from, 1e-12) && close(back.to, s.to, 1e-12), `${kind} ${JSON.stringify(s)}`);
    }
  }
  // klinecharts: realFrom - range * bottom, realTo + range * top.
  const r = addGap({ from: 100, to: 200 }, rates, 'linear');
  assert.ok(close(r.from, 90) && close(r.to, 220));
  const d = rangeOfSpan({ from: 1, to: 3 });
  assert.deepEqual(d, { from: 1, to: 3, range: 2, realFrom: 1, realTo: 3, realRange: 2, displayFrom: 1, displayTo: 3, displayRange: 2 });
});

/** klinecharts' StoreImp._adjustVisibleRange, verbatim, as the oracle. */
function klineWindow(n: number, barSpace: number, L0: number, total: number) {
  const visible = total / barSpace;
  const leftMin = Math.max(0, 2);
  const rightMin = Math.max(0, 2);
  let L = L0;
  const maxRight = visible - Math.min(leftMin, n);
  if (L > maxRight) L = maxRight;
  const minRight = -n + Math.min(rightMin, n);
  if (L < minRight) L = minRight;
  let to = Math.round(L + n + 0.5);
  const realTo = to;
  if (to > n) to = n;
  let from = Math.round(to - visible) - 1;
  if (from < 0) from = 0;
  const realFrom = L > 0 ? Math.round(n + L - visible) - 1 : from;
  return { realFrom, realTo };
}

test('visibleWindow is the range klinecharts auto-fits over, clamps included', () => {
  for (const n of [500, 40, 3, 1]) {
    for (const b of [1, 2.5, 6, 10.629, 23, 50]) {
      for (const L of [-1e6, -812.3, -41.2, -1, 0, 0.3, 80 / 6, 57.9, 1e6]) {
        for (const w of [775, 1023, 331]) {
          const k = klineWindow(n, b, L, w);
          const got = visibleWindow(n, b, L, w);
          assert.deepEqual(got, { from: Math.max(0, k.realFrom), to: Math.min(n, k.realTo) }, `n=${n} b=${b} L=${L} w=${w}`);
        }
      }
    }
  }
  assert.deepEqual(visibleWindow(0, 6, 1, 775), { from: 0, to: 0 });
});

const bar = (i: number, lo: number, hi: number): KLineData => ({ timestamp: i, open: lo, high: hi, low: lo, close: (lo + hi) / 2, volume: 1 });

test('fitSpan: the extent klinecharts fits - bars, the line value, indicators', () => {
  const bars = [bar(0, 10, 20), bar(1, 12, 30), bar(2, 5, 15), bar(3, 40, 50)];
  assert.deepEqual(fitSpan({ bars, value: 'hl' }, { from: 0, to: 2 }), { from: 10, to: 30 });
  assert.deepEqual(fitSpan({ bars, value: 'hl' }, { from: 1, to: 4 }), { from: 5, to: 50 });
  assert.deepEqual(fitSpan({ bars, value: 'close' }, { from: 0, to: 3 }), { from: 10, to: 21 });
  assert.equal(fitSpan({ bars, value: 'hl' }, { from: 2, to: 2 }), null);
  assert.equal(fitSpan({ bars: [], value: 'hl' }, { from: 0, to: 5 }), null);
  // Out-of-range windows are clipped to the data.
  assert.deepEqual(fitSpan({ bars, value: 'hl' }, { from: -5, to: 99 }), { from: 5, to: 50 });
  // An MA running above the candles widens the fit; a BOLL band below too.
  const ma = { result: [{ ma: 25 }, { ma: 35 }, {}, { ma: 45 }], figures: [{ key: 'ma' }] };
  const boll = { result: [{ dn: 8 }, { dn: 9 }, { dn: 3 }, {}], figures: [{ key: 'dn' }, { key: 'up' }] };
  assert.deepEqual(fitSpan({ bars, value: 'hl', indicators: [ma, boll] }, { from: 0, to: 2 }), { from: 8, to: 35 });
  // Declared min/max (an oscillator's 0..100) only apply when there is data.
  const osc = { result: [], figures: [], minValue: 0, maxValue: 100 };
  assert.deepEqual(fitSpan({ bars, value: 'hl', indicators: [osc] }, { from: 0, to: 1 }), { from: 0, to: 100 });
  assert.equal(fitSpan({ bars: [], value: 'hl', indicators: [osc] }, { from: 0, to: 1 }), null);
});

// --- PriceFit through a whole move -----------------------------------------------

/**
 * A chart just big enough for PriceFit: a linear price axis whose createRange
 * is whatever overrideYAxis installed, laid out the way createRangeImp does it
 * (template range, then the 20/10 gap), with klinecharts' auto flag.
 */
function fakeChart(bars: KLineData[], width = 600, height = 400) {
  let auto = true;
  let range: AxisRange = rangeOfSpan({ from: 0, to: 10 });
  const identity: AxisCreateRangeCallback = (p) => p.defaultRange;
  let createRange = identity;
  const view: View = { barSpace: 6, rightBars: 80 / 6 };
  const axis = {
    gap: { top: 0.2, bottom: 0.1 },
    get createRange() {
      return createRange;
    },
    getRange: () => range,
    getAutoCalcTickFlag: () => auto,
    setAutoCalcTickFlag: (v: boolean) => {
      auto = v;
    },
    setRange: (r: AxisRange) => {
      auto = false;
      range = r;
    },
    realValueToValue: (v: number) => v,
    realValueToDisplayValue: (v: number) => v,
  };
  const c = {
    getDataList: () => bars,
    getStyles: () => ({ candle: { type: 'candle_solid', area: { value: 'close' } } }),
    getIndicators: () => [],
    getYAxes: () => [axis],
    getSize: () => ({ width, height }),
    overrideYAxis: (o: { createRange?: AxisCreateRangeCallback }) => {
      if (o.createRange) createRange = o.createRange;
      auto = true;
    },
  };
  /** klinecharts' layout: when auto, the range is createRange's answer plus the gap. */
  const layout = () => {
    if (!auto) return range;
    const w = visibleWindow(bars.length, view.barSpace, view.rightBars, width);
    const fitted = fitSpan({ bars, value: 'hl' }, w) ?? { from: 0, to: 10 };
    const r = createRange({ chart: c as unknown as KChart, paneId: 'candle_pane', defaultRange: rangeOfSpan(fitted) });
    const shown = addGap({ from: r.realFrom, to: r.realTo }, gapRates(axis.gap, height), 'linear');
    range = rangeOfSpan(shown);
    return range;
  };
  return { c: c as unknown as KChart, axis: axis as unknown as YAxis, view, layout, isAuto: () => auto };
}

const series = (n: number) => Array.from({ length: n }, (_, i) => bar(i, 100 + Math.sin(i / 9) * 20 + i * 0.1, 110 + Math.sin(i / 9) * 20 + i * 0.1));

test('PriceFit: a pass-through until a move, and the wrap never stacks', () => {
  const { c, axis, layout } = fakeChart(series(300));
  const fit = new PriceFit();
  const base = templateRange(axis.createRange);
  c.overrideYAxis({ createRange: fit.wrap(base, 'linear') });
  const auto = layout();
  // Re-wrapping a wrapper unwraps it first.
  assert.equal(templateRange(axis.createRange), base);
  c.overrideYAxis({ createRange: fit.wrap(templateRange(axis.createRange), 'linear') });
  assert.deepEqual(layout(), auto);
  assert.equal(fit.moving, false);
});

test('PriceFit: from a dragged range to the destination fit, eased, no jump either end', () => {
  const { c, axis, view, layout, isAuto } = fakeChart(series(300));
  const fit = new PriceFit();
  c.overrideYAxis({ createRange: fit.wrap(templateRange(axis.createRange), 'linear') });
  layout();
  // The user drags the axis: a manual range well away from the fit.
  const dragged = rangeOfSpan({ from: 40, to: 400 });
  assert.ok(holdRange(axis, dragged));
  assert.equal(isAutoFit(axis), false);
  assert.deepEqual(layout(), dragged, 'manual: klinecharts leaves it');
  // Reset: zoom in and scroll, and fit y on the same clock.
  const from: View = { ...view };
  const dest: View = { barSpace: 10, rightBars: -40 };
  assert.equal(fit.begin(c, dest, 600), true);
  assert.equal(isAutoFit(axis), true, 'klinecharts asks createRange again');
  // Before the first frame the axis is exactly where it was.
  let r = layout();
  assert.ok(close(r.from, dragged.from) && close(r.to, dragged.to), 'no jump at the start');
  const shown: AxisRange[] = [r];
  for (let i = 1; i <= 25; i++) {
    const e = easeView(i / 25);
    Object.assign(view, interpolateView(from, dest, 600, e));
    fit.step(c, e, dest, 600);
    r = layout();
    shown.push(r);
  }
  assert.equal(fit.moving, false, 'handed back at e = 1');
  // The last frame IS the destination's own auto-fit (the pass-through).
  const target = addGap(fitSpan({ bars: c.getDataList(), value: 'hl' }, visibleWindow(300, dest.barSpace, dest.rightBars, 600))!, gapRates(undefined, 400), 'linear');
  assert.ok(close(r.from, target.from) && close(r.to, target.to));
  // Every frame moves the same way, by the eased step - monotonic, no overshoot.
  for (const k of ['from', 'to'] as const) {
    const up = target[k] > dragged[k];
    for (let i = 1; i < shown.length; i++) {
      const d = shown[i]![k] - shown[i - 1]![k];
      assert.ok(up ? d >= -1e-9 : d <= 1e-9, `${k} not monotonic at ${i}`);
      const want = (easeView(i / 25) - easeView((i - 1) / 25)) * (target[k] - dragged[k]);
      assert.ok(Math.abs(d - want) <= Math.abs(target[k] - dragged[k]) * 1e-9 + 1e-9, `${k} step ${i}: ${d} vs ${want}`);
    }
  }
});

test('PriceFit: nothing to move when already fitting there; end() hands back mid-move', () => {
  const { c, axis, view, layout } = fakeChart(series(300));
  const fit = new PriceFit();
  c.overrideYAxis({ createRange: fit.wrap(templateRange(axis.createRange), 'linear') });
  layout();
  assert.equal(fit.begin(c, { ...view }, 600), false, 'same view, auto: no y move');
  holdRange(axis, rangeOfSpan({ from: 0, to: 1000 }));
  assert.equal(fit.begin(c, { ...view }, 600), true, 'manual: the A button eases back');
  fit.step(c, 0.3, { ...view }, 600);
  const mid = layout();
  fit.end();
  const after = layout();
  assert.notDeepEqual(mid, after, 'cancelled: plain auto-fit from the next layout');
  assert.equal(fit.moving, false);
});

test('pannedRange: the content follows the pointer', () => {
  const { axis } = fakeChart(series(10));
  const base = rangeOfSpan({ from: 100, to: 200 });
  const down = pannedRange(axis, base, 40, 400);
  assert.ok(close(down.from, 110) && close(down.to, 210), 'dragging down shows higher prices');
  const up = pannedRange(axis, base, -40, 400);
  assert.ok(close(up.from, 90) && close(up.to, 190));
  assert.deepEqual(pannedRange(axis, base, 0, 400), base);
});

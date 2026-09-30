/**
 * The view tween: easing, the window interpolation, zoom anchoring, reading
 * the scroll position back out of the x-axis mapping, painting in the frame,
 * and the rAF driver (time-based, the price axis on the same clock).
 *   npx tsx --test src/chart/viewTween.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Chart as KChart } from 'klinecharts';
import { DEFAULT_BAR_SPACE, DEFAULT_OFFSET_RIGHT } from './theme';
import {
  BAR_SPACE_MAX,
  BAR_SPACE_MIN,
  TWEEN_MS,
  ViewTween,
  cubicBezier,
  defaultView,
  easeInOutCubic,
  easeView,
  interpolateView,
  latestView,
  offsetPx,
  paintNow,
  sameView,
  solveRightBars,
  zoomView,
  type View,
  type YMotion,
} from './viewTween';

const W = 775;
const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

test('ease-in-out-cubic: pinned ends, symmetric, monotonic, gentle at both ends', () => {
  assert.equal(easeInOutCubic(0), 0);
  assert.equal(easeInOutCubic(1), 1);
  assert.equal(easeInOutCubic(-1), 0);
  assert.equal(easeInOutCubic(2), 1);
  assert.ok(close(easeInOutCubic(0.5), 0.5));
  let prev = 0;
  for (let i = 1; i <= 1000; i++) {
    const t = i / 1000;
    const e = easeInOutCubic(t);
    assert.ok(e >= prev, `monotonic at ${t}`);
    assert.ok(close(e, 1 - easeInOutCubic(1 - t), 1e-12), `symmetric at ${t}`);
    prev = e;
  }
  // Slow start and slow finish: the first and last 10% of the time cover
  // well under 10% of the distance.
  assert.ok(easeInOutCubic(0.1) < 0.01);
  assert.ok(1 - easeInOutCubic(0.9) < 0.01);
});

test('the default view is what a fresh chart shows', () => {
  const v = defaultView();
  assert.equal(v.barSpace, DEFAULT_BAR_SPACE);
  assert.ok(close(offsetPx(v), DEFAULT_OFFSET_RIGHT));
  const l = latestView({ barSpace: 11, rightBars: -300 });
  assert.equal(l.barSpace, 11);
  assert.ok(close(offsetPx(l), DEFAULT_OFFSET_RIGHT));
});

const STARTS: View[] = [
  { barSpace: 10.63, rightBars: -41.2 }, // zoomed in, dragged back (the measured case)
  { barSpace: 24, rightBars: -900 }, // far back in history
  { barSpace: 2.2, rightBars: 3 }, // zoomed out
  { barSpace: 6, rightBars: 60 }, // default zoom, dragged forward
  { barSpace: 40, rightBars: 1.5 },
  { barSpace: 1.4, rightBars: -120 },
];

test('interpolation lands exactly on both ends', () => {
  const to = defaultView();
  for (const from of STARTS) {
    assert.deepEqual(interpolateView(from, to, W, 0), from);
    assert.deepEqual(interpolateView(from, to, W, 1), to);
  }
});

test('bar space and right offset each converge monotonically - one movement, no overshoot', () => {
  const targets = [defaultView(), ...STARTS.map((s) => latestView(s)), ...STARTS.map((s) => zoomView(s, 1.2, W))];
  for (const ease of [easeInOutCubic, easeView]) for (const from of STARTS) {
    for (const to of targets) {
      const bs: number[] = [];
      const off: number[] = [];
      const raw: number[] = [];
      for (let i = 0; i <= 200; i++) {
        const v = interpolateView(from, to, W, ease(i / 200));
        assert.ok(v.barSpace > 0 && Number.isFinite(v.barSpace));
        bs.push(v.barSpace);
        off.push(offsetPx(v));
        raw.push(v.rightBars * v.barSpace);
      }
      for (const [name, s] of [['barSpace', bs], ['offset', off], ['raw offset', raw]] as const) {
        const up = s[s.length - 1]! >= s[0]!;
        for (let i = 1; i < s.length; i++) {
          const d = s[i]! - s[i - 1]!;
          assert.ok(up ? d >= -1e-9 : d <= 1e-9, `${name} not monotonic from ${JSON.stringify(from)} to ${JSON.stringify(to)} at ${i}`);
        }
        // Stays between its ends.
        const lo = Math.min(s[0]!, s[s.length - 1]!);
        const hi = Math.max(s[0]!, s[s.length - 1]!);
        assert.ok(s.every((x) => x >= lo - 1e-9 && x <= hi + 1e-9), `${name} overshoots`);
      }
    }
  }
});

test('zoom keeps the anchored bar under the anchor, at every frame of the tween', () => {
  const at = (v: View, x: number) => v.rightBars - (W - x) / v.barSpace;
  for (const from of STARTS) {
    for (const factor of [1.2, 0.8, 3, 0.25]) {
      for (const x of [W / 2, 0, W, 123.4]) {
        const to = zoomView(from, factor, W, x);
        if (to.barSpace === from.barSpace * factor) assert.ok(close(at(to, x), at(from, x), 1e-9));
        for (let i = 0; i <= 50; i++) {
          const v = interpolateView(from, to, W, easeInOutCubic(i / 50));
          assert.ok(close(at(v, x), at(from, x), 1e-7), `anchor drifted at ${i}`);
        }
      }
    }
  }
});

test('zoom targets are clamped to the bar-space range klinecharts accepts', () => {
  assert.equal(zoomView({ barSpace: 45, rightBars: 2 }, 1.2, W).barSpace, BAR_SPACE_MAX);
  assert.equal(zoomView({ barSpace: 1.1, rightBars: 2 }, 0.8, W).barSpace, BAR_SPACE_MIN);
});

test('sameView: sub-pixel differences are the same picture', () => {
  assert.ok(sameView(defaultView(), { barSpace: 6, rightBars: 80 / 6 + 0.001 }));
  assert.ok(!sameView(defaultView(), { barSpace: 6, rightBars: 80 / 6 + 0.01 }));
  assert.ok(!sameView(defaultView(), { barSpace: 6.01, rightBars: 80 / 6 }));
});

test('the scroll position is recovered exactly from the floored x-axis mapping', () => {
  // klinecharts' StoreImp.dataIndexToCoordinate, verbatim.
  const mapper = (n: number, L: number, b: number, w: number) => (i: number) =>
    Math.floor(w - (n + L - i - 0.5) * b + 0.5);
  const cases: Array<[number, number, number, number]> = [];
  for (const b of [1, 1.37, 6, 10.629366, 23.5, 50]) {
    for (const L of [-812.37, -41.2, -1, -0.49, 0, 0.3, 80 / 6, 57.9]) {
      for (const w of [775, 1023, 331]) cases.push([500, L, b, w]);
    }
  }
  for (const [n, L, b, w] of cases) {
    const got = solveRightBars(mapper(n, L, b, w), n, w, b);
    assert.ok(Math.abs(got - L) * b < 1e-6, `n=${n} L=${L} b=${b} w=${w}: got ${got}`);
  }
});

// --- easing ------------------------------------------------------------------------

test('cubicBezier reproduces CSS timing functions', () => {
  const linear = cubicBezier(0, 0, 1, 1);
  const inOut = cubicBezier(0.42, 0, 0.58, 1);
  const ease = cubicBezier(0.25, 0.1, 0.25, 1);
  for (let i = 0; i <= 100; i++) assert.ok(close(linear(i / 100), i / 100, 1e-7));
  assert.ok(close(inOut(0.5), 0.5, 1e-7));
  for (let i = 1; i < 100; i++) assert.ok(close(inOut(i / 100), 1 - inOut(1 - i / 100), 1e-6), 'symmetric');
  // CSS `ease` at the quarter points (reference values to 1e-3).
  assert.ok(Math.abs(ease(0.25) - 0.4094) < 1e-3);
  assert.ok(Math.abs(ease(0.5) - 0.8024) < 1e-3);
  assert.ok(Math.abs(ease(0.75) - 0.9604) < 1e-3);
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
  assert.equal(ease(-3), 0);
  assert.equal(ease(7), 1);
});

test('the move easing leaves at once and lands with no velocity', () => {
  assert.ok(TWEEN_MS >= 350 && TWEEN_MS <= 450, 'inside the 350-450ms brief');
  let prev = 0;
  for (let i = 1; i <= 1000; i++) {
    const e = easeView(i / 1000);
    assert.ok(e >= prev, 'monotonic');
    prev = e;
  }
  // An even share of the distance per 60 Hz frame.
  const even = 1000 / 60 / TWEEN_MS;
  const first = easeView(even);
  assert.ok(first > 0.4 * even && first < even, `first frame moves ${(first / even).toFixed(2)} of an even frame`);
  const last = 1 - easeView(1 - even);
  assert.ok(last < 0.05 * even, 'soft landing');
  // Ease-in-out-cubic, for comparison, barely moves on its first frame.
  assert.ok(easeInOutCubic(even) < 0.02 * even);
});

// --- paintNow ------------------------------------------------------------------------

test('paintNow: frames asked for by the layout run in this frame; the caller gets real ones', async () => {
  const realRaf: FrameRequestCallback[] = [];
  const g = globalThis as unknown as { window?: unknown };
  const fakeWindow = {
    requestAnimationFrame: (cb: FrameRequestCallback): number => {
      realRaf.push(cb);
      return realRaf.length;
    },
  };
  g.window = fakeWindow;
  try {
    const order: string[] = [];
    // klinecharts: a change queues a layout microtask, which asks rAF to paint.
    const chartChange = () => {
      void Promise.resolve().then(() => {
        fakeWindow.requestAnimationFrame(() => order.push('paint'));
      });
    };
    paintNow(chartChange, () => order.push('after'));
    // The caller's own next step, asked for right after paintNow: a real frame.
    fakeWindow.requestAnimationFrame(() => order.push('next-step'));
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(order, ['paint', 'after'], 'painted in the microtasks, before any later task');
    assert.equal(realRaf.length, 1, 'only the next step went to the browser');
    realRaf[0]!(0);
    assert.deepEqual(order, ['paint', 'after', 'next-step']);
    // requestAnimationFrame is handed back.
    fakeWindow.requestAnimationFrame(() => order.push('later'));
    assert.equal(realRaf.length, 2);
  } finally {
    delete g.window;
  }
});

// --- the driver ----------------------------------------------------------------------

/** A chart store reduced to what ViewTween touches (StoreImp's own arithmetic). */
function fakeChart(width = 775, n = 500) {
  let b = 6;
  let L = 80 / 6;
  let scrollOn = true;
  const c = {
    getBarSpace: () => ({ bar: b, halfBar: b / 2, gapBar: 5, halfGapBar: 2 }),
    setBarSpace: (v: number) => {
      if (v === b || v < BAR_SPACE_MIN || v > BAR_SPACE_MAX) return;
      b = v;
    },
    getOffsetRightDistance: () => Math.max(0, L * b),
    setOffsetRightDistance: (d: number) => {
      L = d / b;
    },
    scrollByDistance: (d: number) => {
      if (scrollOn) L -= d / b;
    },
    isScrollEnabled: () => scrollOn,
    setScrollEnabled: (v: boolean) => {
      scrollOn = v;
    },
    getDataList: () => new Array(n),
    getSize: () => ({ width, height: 400 }),
    convertToPixel: (p: { dataIndex: number }) => ({ x: Math.floor(width - (n + L - p.dataIndex - 0.5) * b + 0.5) }),
  };
  return {
    c: c as unknown as KChart,
    view: (): View => ({ barSpace: b, rightBars: L }),
    scroll: (v: boolean) => {
      scrollOn = v;
    },
  };
}

/** A frame clock: requestAnimationFrame callbacks run when tick(t) says so. */
function frames() {
  const g = globalThis as unknown as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };
  const saved = { raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame };
  let queue = new Map<number, FrameRequestCallback>();
  let id = 0;
  g.requestAnimationFrame = (cb: FrameRequestCallback) => {
    queue.set(++id, cb);
    return id;
  };
  g.cancelAnimationFrame = (i: number) => queue.delete(i);
  return {
    tick(t: number) {
      const q = queue;
      queue = new Map();
      for (const cb of q.values()) cb(t);
    },
    pending: () => queue.size,
    restore() {
      g.requestAnimationFrame = saved.raf;
      g.cancelAnimationFrame = saved.caf;
    },
  };
}

class RecordingY implements YMotion {
  began = 0;
  steps: number[] = [];
  ended = 0;
  constructor(private readonly moves: boolean) {}
  begin(): boolean {
    this.began++;
    return this.moves;
  }
  step(_c: KChart, e: number): void {
    this.steps.push(e);
  }
  end(): void {
    this.ended++;
  }
}

test('ViewTween: time-based - every frame is the eased curve at that frame\'s time', () => {
  const clock = frames();
  try {
    const { c, view } = fakeChart();
    const from = view();
    const dest: View = { barSpace: 10.5, rightBars: -120 };
    const moving: boolean[] = [];
    const t = new ViewTween(() => c, undefined, (m) => moving.push(m));
    t.start(dest);
    assert.deepEqual(moving, [true]);
    // Irregular frames: 60 Hz with a dropped frame, then a 144 Hz burst, then late ones.
    for (const now of [1000, 1016.7, 1033.3, 1066.7, 1073.6, 1080.6, 1087.5, 1100, 1200, 1300, 1400, 1419, 1500]) {
      clock.tick(now);
      const want = interpolateView(from, dest, 775, easeView(Math.min(1, (now - 1000) / TWEEN_MS)));
      const got = view();
      assert.ok(Math.abs(got.barSpace - want.barSpace) < 1e-9, `bar space at ${now}`);
      assert.ok(Math.abs(got.rightBars - want.rightBars) * got.barSpace < 1e-6, `offset at ${now}`);
    }
    assert.equal(t.running, false);
    assert.equal(clock.pending(), 0);
    assert.deepEqual(moving, [true, false]);
  } finally {
    clock.restore();
  }
});

test('ViewTween: the price axis rides the same clock; y-only moves, cancel, a disabled scroll, reduced motion', () => {
  const clock = frames();
  try {
    const { c, view, scroll } = fakeChart();
    const y = new RecordingY(true);
    new ViewTween(() => c, y).start({ barSpace: 6, rightBars: -50 }, { fitY: true });
    for (const now of [0, 100, 200, 300, 420]) clock.tick(now);
    assert.equal(y.began, 1);
    assert.deepEqual(y.steps, [0, 100, 200, 300, 420].map((ms) => easeView(ms / TWEEN_MS)));
    assert.equal(y.ended, 1);
    // A y-only move (A switching back on): the view stays, the axis moves.
    const here = view();
    const y2 = new RecordingY(true);
    new ViewTween(() => c, y2).start((v) => v, { fitY: true });
    for (const now of [0, 210, 420]) clock.tick(now);
    assert.deepEqual(view(), here);
    assert.deepEqual(y2.steps, [0, easeView(0.5), 1]);
    // Nothing to move on either axis: no move at all.
    const t3 = new ViewTween(() => c, new RecordingY(false));
    t3.start((v) => v, { fitY: true });
    assert.equal(t3.running, false);
    // Cancel: stops dead where the last frame left it, and hands y back.
    const y4 = new RecordingY(true);
    const t4 = new ViewTween(() => c, y4);
    t4.start({ barSpace: 20, rightBars: 3 }, { fitY: true });
    clock.tick(0);
    clock.tick(100);
    const mid = view();
    t4.cancel();
    clock.tick(200);
    assert.deepEqual(view(), mid);
    assert.equal(y4.ended, 1);
    // The second press of a double click turns scrolling off; the move still follows.
    const t5 = new ViewTween(() => c);
    t5.start({ barSpace: 6, rightBars: 80 / 6 });
    clock.tick(0);
    scroll(false);
    clock.tick(150);
    const e = easeView(150 / TWEEN_MS);
    assert.ok(Math.abs(view().rightBars - interpolateView(mid, { barSpace: 6, rightBars: 80 / 6 }, 775, e).rightBars) < 1e-6);
    scroll(true);
    clock.tick(500);
    assert.ok(sameView(view(), { barSpace: 6, rightBars: 80 / 6 }));
    // Reduced motion: a one-frame cut.
    const t6 = new ViewTween(() => c);
    t6.start({ barSpace: 12, rightBars: -10 }, { ms: 0 });
    clock.tick(0);
    assert.equal(view().barSpace, 12);
    assert.equal(t6.running, false);
  } finally {
    clock.restore();
  }
});

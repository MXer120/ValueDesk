/**
 *   npx tsx --test src/components/orderbook/sparkSampler.test.ts
 *
 * THE PROPERTY UNDER TEST: once a point is drawn as final, nothing about it
 * changes - which samples it covers, its value, its x on the absolute time axis
 * - through any number of later samples, live-tip wobbles and window roll-offs.
 * And the y-band moves only when the data leaves it or it has become loose.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bucketSizeFor,
  extentOf,
  fitBand,
  nextBand,
  pointsAttr,
  stablePoints,
  type Band,
  type BandOptions,
  type Recording,
  type SparkPoint,
} from './sparkSampler';

function rng(seed: number) {
  let x = seed;
  return () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
}

/**
 * A recorder exactly like the book's: a closed sample per "second" into a
 * `capacity`-bounded window, with the live tip re-averaged on every push in
 * between. Yields the Recording after every event.
 */
function* simulate(capacity: number, seconds: number, seed: number, pushesPerSecond = 3) {
  const r = rng(seed);
  let history: number[] = [];
  let start = 0;
  let level = 50;
  for (let t = 0; t < seconds; t++) {
    let sum = 0;
    let count = 0;
    for (let k = 0; k < pushesPerSecond; k++) {
      level += (r() - 0.5) * 2;
      sum += level;
      count++;
      yield { history, start, live: sum / count, gen: 0 } as Recording;
    }
    history = [...history, sum / count];
    if (history.length > capacity) {
      const drop = history.length - capacity;
      history = history.slice(drop);
      start += drop;
    }
    yield { history, start, live: null, gen: 0 } as Recording;
  }
}

test('bucketSizeFor: 1 while every sample fits, else the smallest power of two that does', () => {
  // 60 samples at >= 2px each need 120px.
  assert.equal(bucketSizeFor(60, 400, 2), 1);
  assert.equal(bucketSizeFor(60, 120, 2), 1);
  assert.equal(bucketSizeFor(60, 118, 2), 2); // 59 points max -> 30 buckets of 2
  assert.equal(bucketSizeFor(60, 29, 2), 8); // 14 points max -> 8 buckets of 8
  assert.equal(bucketSizeFor(60, 4, 2), 32); // floor 2 points
  for (let w = 1; w < 500; w++) {
    const s = bucketSizeFor(60, w, 2);
    assert.equal(s & (s - 1), 0, `power of two at ${w}px`);
    assert.ok(Math.ceil(60 / s) <= Math.max(2, Math.floor(w / 2)), `fits at ${w}px`);
    if (s > 1) assert.ok(Math.ceil(60 / (s / 2)) > Math.max(2, Math.floor(w / 2)), `smallest at ${w}px`);
  }
});

test('s = 1 draws every closed sample as final, and the live sample as the one moving point', () => {
  const rec: Recording = { history: [1, 2, 3], start: 10, live: 3.5, gen: 0 };
  assert.deepEqual(stablePoints(rec, 1), [
    { i: 10, v: 1, final: true },
    { i: 11, v: 2, final: true },
    { i: 12, v: 3, final: true },
    { i: 13, v: 3.5, final: false },
  ]);
  assert.deepEqual(stablePoints({ ...rec, live: null }, 1).map((p) => p.final), [true, true, true]);
  assert.deepEqual(stablePoints({ history: [], start: 0, live: null, gen: 0 }, 1), []);
});

test('buckets are aligned to the ABSOLUTE index, and a partly aged-off bucket is dropped whole', () => {
  // start 5 with s = 4: bucket [4..7] has lost index 4, so it is skipped; [8..11] is complete.
  const rec: Recording = { history: [5, 6, 7, 8, 9, 10, 11, 12, 13], start: 5, live: 14, gen: 0 };
  const pts = stablePoints(rec, 4, (v) => v);
  assert.deepEqual(pts, [
    { i: 11, v: (8 + 9 + 10 + 11) / 4, final: true },
    { i: 14, v: (12 + 13 + 14) / 3, final: false },
  ]);
  // The mapping is applied per sample, before averaging.
  const sell = stablePoints(rec, 4, (v) => 100 - v);
  assert.equal(sell[0]!.v, 100 - (8 + 9 + 10 + 11) / 4);
});

for (const s of [1, 2, 4, 8, 16]) {
  test(`a final point never changes afterwards (bucket size ${s}, 20 minutes of 1s samples)`, () => {
    const seen = new Map<number, number>(); // i -> v of every point ever drawn as final
    let finals = 0;
    let checks = 0;
    let prevFinal: SparkPoint[] = [];
    for (const rec of simulate(60, 1_200, 1234 + s)) {
      const pts = stablePoints(rec, s);
      const final = pts.filter((p) => p.final);
      for (const p of final) {
        const was = seen.get(p.i);
        if (was === undefined) {
          seen.set(p.i, p.v);
          finals++;
        } else {
          assert.equal(p.v, was, `point @${p.i} changed ${was} -> ${p.v}`);
          checks++;
        }
      }
      // Only the newest point may be non-final.
      assert.ok(pts.slice(0, -1).every((p) => p.final), 'a non-final point that is not the newest');
      // The drawn history only ever loses points on the LEFT and gains them on the RIGHT:
      // what two consecutive frames share is identical, in the same order.
      const shared = prevFinal.filter((p) => final.some((q) => q.i === p.i));
      const head = final.slice(0, shared.length);
      assert.deepEqual(head, shared, 'history reshaped between frames');
      if (shared.length && prevFinal.length) {
        // Anything dropped came off the front.
        const dropped = prevFinal.filter((p) => !final.some((q) => q.i === p.i));
        for (const d of dropped) assert.ok(d.i < shared[0]!.i, `point @${d.i} vanished from the middle`);
      }
      prevFinal = final;
      // The text the renderer writes for the final points is a prefix-stable function of them.
      assert.equal(pointsAttr(final), final.map((p) => `${p.i},${+p.v.toPrecision(10)}`).join(' '));
    }
    assert.ok(finals > 1_200 / s - 5, `drew ${finals} final points`);
    assert.ok(checks > 10_000 / s, `re-checked ${checks} times`);
  });
}

test('the old stride decimation DID reshape history (the regression this replaces)', () => {
  // Today's Sparkline: idxs = round(k * (n-1)/(maxPts-1)) over the CURRENT series.
  const oldIdxs = (n: number, maxPts: number) => {
    if (n <= maxPts) return [...Array(n).keys()];
    const stride = (n - 1) / (maxPts - 1);
    return [...Array(maxPts).keys()].map((k) => Math.round(k * stride));
  };
  // 60 samples into 14 vertices, one more sample: which ABSOLUTE samples are drawn changes.
  const a = new Set(oldIdxs(60, 14).map((i) => i + 100)); // window starts at abs 100
  const b = new Set(oldIdxs(60, 14).map((i) => i + 101)); // one second later
  const common = [...a].filter((i) => b.has(i));
  assert.ok(common.length < a.size - 2, 'the stride picked mostly different samples one second later');
  // The stable scheme at the same density keeps every shared vertex.
  const r1: Recording = { history: Array.from({ length: 60 }, (_, k) => k), start: 100, live: null, gen: 0 };
  const r2: Recording = { history: Array.from({ length: 60 }, (_, k) => k + 1), start: 101, live: null, gen: 0 };
  const s = bucketSizeFor(60, 29, 2);
  const p1 = stablePoints(r1, s).filter((p) => p.final);
  const p2 = stablePoints(r2, s).filter((p) => p.final);
  for (const p of p1) {
    const q = p2.find((x) => x.i === p.i);
    if (q) assert.equal(q.v, p.v);
  }
});

const BS: BandOptions = { pad: 0.25, minSpan: 2, loose: 2.5, floor: 0, ceil: 100 };
const SPREAD: BandOptions = { pad: 0.25, minSpan: 0.01, loose: 2.5, floor: 0 };

test('fitBand: padded, centred, never below minSpan, clamped to floor/ceil', () => {
  assert.deepEqual(fitBand(45, 55, BS), { lo: 42.5, hi: 57.5 });
  const flat = fitBand(0.119, 0.119, SPREAD);
  assert.ok(Math.abs(flat.hi - flat.lo - 0.01) < 1e-12 && flat.lo < 0.119 && flat.hi > 0.119);
  // Near the floor the band slides up instead of going negative.
  const low = fitBand(0.001, 0.002, SPREAD);
  assert.equal(low.lo, 0);
  assert.ok(low.hi >= 0.002);
  // A share hugging 100 stays inside [0, 100].
  const high = fitBand(97, 100, BS);
  assert.ok(high.hi <= 100 && high.lo >= 0 && high.lo <= 97);
});

test('nextBand returns the SAME band while the data stays inside it and it is not loose', () => {
  const b0 = fitBand(45, 55, BS);
  assert.equal(nextBand(b0, 46, 54, BS), b0);
  assert.equal(nextBand(b0, 42.6, 57.4, BS), b0);
  // Leaving it refits.
  const b1 = nextBand(b0, 44, 58, BS)!;
  assert.notEqual(b1, b0);
  assert.ok(b1.lo <= 44 && b1.hi >= 58);
  // A band 2.5x looser than a fresh fit shrinks; just under that it holds.
  const wide = fitBand(40, 60, BS); // span 30
  assert.equal(nextBand(wide, 48, 56, BS), wide); // fresh span 12: 30 / 12 = 2.5 -> not MORE than 2.5x
  assert.notEqual(nextBand(wide, 49, 56, BS), wide); // fresh span 10.5: 2.86x -> shrink
  // Garbage in, band unchanged.
  assert.equal(nextBand(b0, Number.NaN, 1, BS), b0);
  assert.equal(nextBand(null, 1, 2, BS)!.lo < 1, true);
});

test('a noisy but steady series moves the band rarely; a spike expands it once and it shrinks back once', () => {
  const r = rng(99);
  let band: Band | null = null;
  let moves = 0;
  const window: number[] = [];
  // 10 minutes of a share wandering 48..52 with a 20s spike to 70 in the middle.
  for (let t = 0; t < 600; t++) {
    const spike = t >= 300 && t < 320;
    const v = spike ? 70 : 50 + (r() - 0.5) * 4;
    window.push(v);
    if (window.length > 60) window.shift();
    const e = extentOf([window.map((x, i) => ({ i, v: x, final: true }))])!;
    const next = nextBand(band, e.lo, e.hi, BS);
    if (next !== band) moves++;
    band = next;
    // Every drawn value is always inside the band it is drawn with.
    assert.ok(e.lo >= band!.lo && e.hi <= band!.hi);
  }
  // First fit, a few refits while the first minute fills out, the spike, the shrink after it ages off.
  assert.ok(moves <= 8, `band moved ${moves} times in 600 samples`);
});

test('a flat 1-tick spread with the mid drifting draws flat, and the band does not chase the drift', () => {
  // BTC: one tick is 1/mid*1e4 bps; the mid random-walks by a few dollars.
  const r = rng(5);
  let mid = 83_859;
  let band: Band | null = null;
  let moves = 0;
  const window: number[] = [];
  for (let t = 0; t < 600; t++) {
    mid += (r() - 0.5) * 20;
    window.push((1 / mid) * 1e4);
    if (window.length > 60) window.shift();
    const e = extentOf([window.map((x, i) => ({ i, v: x, final: true }))])!;
    const next = nextBand(band, e.lo, e.hi, SPREAD);
    if (next !== band) moves++;
    band = next;
  }
  // The drift is ~0.0001 bps against a 0.01 bps floor on the band: one fit, no chasing.
  assert.equal(moves, 1);
  // Drawn into a 26px chart, the whole minute spans well under a pixel.
  const e = extentOf([window.map((x, i) => ({ i, v: x, final: true }))])!;
  assert.ok(((e.hi - e.lo) / (band!.hi - band!.lo)) * 26 < 1);
});

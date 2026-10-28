/**
 *   npx tsx --test src/components/orderbook/bpsPrecision.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setNumStyle } from '../../numStyle';
import {
  bpsMinSpan,
  decadeOf,
  decimalsForMagnitude,
  fmtBps,
  referenceMagnitude,
  stableBpsDecimals,
} from './bpsPrecision';

setNumStyle('comma-dot');

/** One tick of spread, in bps of the mid - the smallest non-zero spread a market can quote. */
const tickBps = (tick: number, mid: number) => (tick / mid) * 10_000;

/** Tick sizes as the venue publishes them, at live-like mids. */
const MARKETS = [
  { name: 'BTC-USD', tick: 1, mid: 83_859 },
  { name: 'ETH-USD', tick: 0.1, mid: 2_687.5 },
  { name: 'SOL-USD', tick: 0.01, mid: 121.2 },
  { name: 'DOGE-USD', tick: 0.00001, mid: 0.09708 },
];

/** Deterministic PRNG. */
function rng(seed: number) {
  let x = seed;
  return () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
}

test('decadeOf is exact at powers of ten', () => {
  for (let e = -8; e <= 8; e++) {
    assert.equal(decadeOf(10 ** e), e, `10^${e}`);
    assert.equal(decadeOf(10 ** e * 1.0000001), e, `just over 10^${e}`);
    assert.equal(decadeOf(10 ** e * 0.9999999), e - 1, `just under 10^${e}`);
  }
});

test('three significant figures, clamped to [1, 4] decimals', () => {
  // The examples in the brief.
  assert.equal(fmtBps(12.34, decimalsForMagnitude(12.34)!), '12.3 bps');
  assert.equal(fmtBps(1.034, decimalsForMagnitude(1.034)!), '1.03 bps');
  assert.equal(fmtBps(0.1192, decimalsForMagnitude(0.1192)!), '0.119 bps');
  assert.equal(fmtBps(0.04123, decimalsForMagnitude(0.04123)!), '0.0412 bps');
  // Never fewer than 1 decimal...
  assert.equal(decimalsForMagnitude(123.4), 1);
  assert.equal(decimalsForMagnitude(98_765), 1);
  assert.equal(fmtBps(123.44, 1), '123.4 bps');
  // ...and never more than 4.
  assert.equal(decimalsForMagnitude(0.004), 4);
  assert.equal(decimalsForMagnitude(1e-9), 4);
  assert.equal(fmtBps(0.00412, decimalsForMagnitude(0.00412)!), '0.0041 bps');
  // The format clamps a stray argument too.
  assert.equal(fmtBps(0.5, 9), '0.5000 bps');
  assert.equal(fmtBps(0.5, 0), '0.5 bps');
  // No magnitude, no answer.
  assert.equal(decimalsForMagnitude(0), null);
  assert.equal(decimalsForMagnitude(-1), null);
  assert.equal(decimalsForMagnitude(Number.NaN), null);
});

test('per coin: one tick at the live mid prints with 3 significant figures', () => {
  const want: Record<string, string> = {
    'BTC-USD': '0.119 bps',
    'ETH-USD': '0.372 bps',
    'SOL-USD': '0.825 bps',
    'DOGE-USD': '1.03 bps',
  };
  for (const m of MARKETS) {
    const q = tickBps(m.tick, m.mid);
    const d = stableBpsDecimals(referenceMagnitude([q]), null);
    assert.equal(fmtBps(q, d), want[m.name], m.name);
  }
});

test('per coin: consecutive tick steps and 1s averages between them always print differently', () => {
  for (const m of MARKETS) {
    const q = tickBps(m.tick, m.mid);
    // A minute of 1s averages of a book that sits at 1-5 ticks.
    const r = rng(7);
    const window: number[] = [];
    for (let i = 0; i < 60; i++) window.push(q * (1 + Math.floor(r() * 5) * r()));
    const d = stableBpsDecimals(referenceMagnitude(window), null);
    for (let k = 1; k < 10; k++) {
      assert.notEqual(fmtBps(k * q, d), fmtBps((k + 1) * q, d), `${m.name}: ${k} vs ${k + 1} ticks at ${d} dp`);
    }
    // Every reading in the window keeps at least 3 significant digits.
    for (const v of window) {
      const digits = v.toFixed(d).replace('.', '').replace(/^0+/, '');
      assert.ok(digits.length >= 3 || d === 4, `${m.name}: ${v} -> ${v.toFixed(d)}`);
    }
  }
});

test('a book flipping between 1 and 2 ticks across a decade edge does not flicker', () => {
  // 1 tick = 0.09 bps, 2 ticks = 0.18 bps: per-reading decimals would be 4, 3, 4, 3...
  const q = 0.09;
  assert.notEqual(decimalsForMagnitude(q), decimalsForMagnitude(2 * q));
  let d: number | null = null;
  const window: number[] = [];
  const trace: number[] = [];
  for (let i = 0; i < 600; i++) {
    const v = i % 2 ? q : 2 * q;
    window.push(v);
    if (window.length > 60) window.shift();
    d = stableBpsDecimals(referenceMagnitude(window), d);
    trace.push(d);
  }
  // The very first reading alone (2 ticks, 0.18) is a 3 dp number; the moment
  // a 1-tick reading joins the window the decimals settle at 4 - ONE switch,
  // then constant for the remaining ten minutes.
  const switches = trace.filter((x, i) => i > 0 && x !== trace[i - 1]).length;
  assert.ok(switches <= 1, `switched ${switches} times`);
  assert.deepEqual(new Set(trace.slice(1)), new Set([4]));
  assert.equal(fmtBps(q, d!), '0.0900 bps');
  assert.equal(fmtBps(2 * q, d!), '0.1800 bps');
});

test('a mid drifting across a decade edge switches decimals once, not on every drift', () => {
  // SOL-like: tick 0.001 at a mid wandering around 100 -> one tick wanders around 0.1 bps.
  const r = rng(42);
  let mid = 99.5;
  let d: number | null = null;
  let switches = 0;
  const window: number[] = [];
  for (let i = 0; i < 3_600; i++) {
    mid += (r() - 0.5) * 0.05; // a random walk that crosses 100.0 many times
    const v = tickBps(0.001, mid);
    window.push(v);
    if (window.length > 60) window.shift();
    const next = stableBpsDecimals(referenceMagnitude(window), d);
    if (d !== null && next !== d) switches++;
    d = next;
  }
  assert.ok(switches <= 1, `switched ${switches} times`);
});

test('the dead band holds inside +-10% of an edge and yields past it', () => {
  // 3 dp is the plain answer on [0.1, 1).
  assert.equal(stableBpsDecimals(0.5, null), 3);
  // Just under the lower edge: 4 dp is the plain answer, but 3 dp is held...
  assert.equal(stableBpsDecimals(0.095, 3), 3);
  // ...until the reference is more than 10% under it.
  assert.equal(stableBpsDecimals(0.09, 3), 4);
  // Upper edge, the same both ways.
  assert.equal(stableBpsDecimals(1.05, 3), 3);
  assert.equal(stableBpsDecimals(1.2, 3), 2);
  assert.equal(stableBpsDecimals(0.95, 2), 2);
  assert.equal(stableBpsDecimals(0.85, 2), 3);
  // The clamped ends are open: 1 dp holds for any wide spread, 4 dp for any narrow one.
  assert.equal(stableBpsDecimals(5_000, 1), 1);
  assert.equal(stableBpsDecimals(1e-7, 4), 4);
  // A far jump is taken directly.
  assert.equal(stableBpsDecimals(25, 4), 1);
});

test('no reading keeps what is shown (and 2 dp on a first call)', () => {
  assert.equal(stableBpsDecimals(null, null), 2);
  assert.equal(stableBpsDecimals(null, 4), 4);
  assert.equal(referenceMagnitude([]), null);
  assert.equal(referenceMagnitude([0, 0, Number.NaN, null, undefined, -1]), null);
  assert.equal(referenceMagnitude([0.3, 0, 0.2, Number.POSITIVE_INFINITY, 0.25]), 0.2);
});

test('the chart never zooms finer than the readout can print', () => {
  assert.equal(bpsMinSpan(3), 0.01);
  assert.equal(bpsMinSpan(1), 1);
  assert.ok(Math.abs(bpsMinSpan(4) - 0.001) < 1e-15);
});

test('the readout follows the number format (default 1.234,5)', () => {
  setNumStyle('dot-comma');
  try {
    assert.equal(fmtBps(0.1192, decimalsForMagnitude(0.1192)!), '0,119 bps');
  } finally {
    setNumStyle('comma-dot');
  }
});

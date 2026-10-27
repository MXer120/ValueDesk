/**
 * A story's coin move since it came out (moves.ts moveSince): the open of the
 * candle the story falls in against the newest close - 5-minute candles for the
 * last day, hourly ones before.
 *   npx tsx --test src/components/news/moves.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Kline } from '../../api';
import { moveSince } from './moves';

const M5 = 5 * 60_000;
const H1 = 60 * 60_000;
const NOW = Date.UTC(2026, 9, 27, 12, 0);

const k = (t: number, o: number | string, c: number | string = o): Kline => ({ t, o: String(o), h: String(o), l: String(o), c: String(c), v: '1', q: '1', n: 1 });
/** Newest first, as the server sends them: `n` candles of `span` ending with the one opening at `last`. */
function candles(last: number, span: number, n: number, open: (i: number) => number, close = open): Kline[] {
  return Array.from({ length: n }, (_, i) => k(last - i * span, open(i), close(i)));
}
type S = Parameters<typeof moveSince>[0];

// The day: 288 five-minute candles, the newest opening at NOW, closing at 110.
const m5 = candles(NOW, M5, 288, (i) => 100 + (i === 0 ? 0 : i / 1000), (i) => (i === 0 ? 110 : 100));
// The week before: hourly candles opening at 80.
const h1 = candles(Math.floor(NOW / H1) * H1, H1, 200, () => 80);
const s: S = { m5, h1 } as S;

test('within the day: the 5-minute candle the story falls in, against the newest close', () => {
  const t = NOW - 10 * M5 + 90_000; // inside the candle opening 10 candles back
  const then = Number(m5[10]!.o);
  assert.ok(Math.abs(moveSince(s, t)! - ((110 - then) / then) * 100) < 1e-9);
  assert.ok(Math.abs(moveSince(s, NOW)! - 10) < 1e-9, 'a story in the newest candle: its open (100) to its close (110)');
});

test('before the day: the hourly candle instead', () => {
  const t = m5[m5.length - 1]!.t - 3 * H1 - 1;
  assert.ok(Math.abs(moveSince(s, t)! - 37.5) < 1e-9, '80 -> 110');
});

test('the oldest 5-minute candle\'s own open is still "the day"', () => {
  const oldest = m5[m5.length - 1]!;
  const v = moveSince(s, oldest.t)!;
  assert.ok(Math.abs(v - ((110 - Number(oldest.o)) / Number(oldest.o)) * 100) < 1e-9);
});

test('older than the history, or after the newest candle closed (stale candles): no move', () => {
  assert.equal(moveSince(s, h1[h1.length - 1]!.t - 1), null);
  assert.equal(moveSince(s, NOW + M5), null, 'the newest candle ended before the story: the price at its time is not known');
});

test('a gap in the candles (no trade that hour): no move rather than a neighbour\'s price', () => {
  const gappy: S = { m5: [k(NOW, 100, 110), k(NOW - 3 * M5, 90)], h1: [] } as S;
  assert.equal(moveSince(gappy, NOW - 2 * M5 + 1), null);
  assert.ok(Math.abs(moveSince(gappy, NOW - 3 * M5 + 1)! - ((110 - 90) / 90) * 100) < 1e-9);
});

test('nothing to read: no series, no 5-minute candles, no time, a zero or broken price', () => {
  assert.equal(moveSince(null, NOW), null);
  assert.equal(moveSince(undefined, NOW), null);
  assert.equal(moveSince({ m5: [], h1 } as S, NOW - 3 * H1), null);
  assert.equal(moveSince(s, 0), null);
  assert.equal(moveSince({ m5: [k(NOW, 0, 110)], h1: [] } as S, NOW), null, 'an open of 0');
  assert.equal(moveSince({ m5: [k(NOW, 100, 'x')], h1: [] } as S, NOW), null, 'a close that is not a number');
  assert.equal(moveSince({ m5: [k(NOW, -5, 110)], h1: [] } as S, NOW), null, 'a negative open');
});

test('a fall is negative; no change is 0', () => {
  assert.ok(Math.abs(moveSince({ m5: [k(NOW, 200, 150)], h1: [] } as S, NOW + 1)! - -25) < 1e-9);
  assert.equal(moveSince({ m5: [k(NOW, 150, 150)], h1: [] } as S, NOW), 0);
});

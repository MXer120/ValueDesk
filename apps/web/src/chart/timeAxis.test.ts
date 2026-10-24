/**
 * The TradingView-style time axis: round steps, calendar names, collisions.
 *   npx tsx --test src/chart/timeAxis.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseStep, crosshairLabel, intervalToMs, timeTicks, timestampLookup } from './timeAxis';

const MIN = 60_000;
const DAY = 86_400_000;
/** Every label 7px a character - close enough to Asap at 12px. */
const measure = (t: string) => t.length * 7;

function ticksFor(times: number[], interval: string, barSpace: number, width = 1000) {
  const at = timestampLookup(times.length, (i) => times[i]!, interval);
  return timeTicks({
    from: 0,
    to: times.length - 1,
    timestampAt: at,
    coordAt: (i) => 20 + i * barSpace,
    barSpace,
    intervalMs: intervalToMs(interval),
    width,
    tz: 'utc',
    measure,
  });
}

test('intraday ticks land on round times and name the new day', () => {
  // 1h bars from 2026-10-23 05:00 UTC for 48 hours.
  const start = Date.UTC(2026, 9, 23, 5);
  const times = Array.from({ length: 48 }, (_, i) => start + i * 60 * MIN);
  const ticks = ticksFor(times, '1h', 12);
  const texts = ticks.map((t) => t.text);
  assert.ok(texts.includes('24'), `midnight is named by its day: ${texts.join(' ')}`);
  for (const t of texts) {
    if (t.includes(':')) assert.match(t, /^(00|02|04|06|08|10|12|14|16|18|20|22):00$/, `round hour: ${t}`);
  }
  // Left to right, no overlaps.
  for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i]!.coord > ticks[i - 1]!.coord);
});

test('daily ticks name the month where it turns, and the month beats a nearby day', () => {
  const start = Date.UTC(2026, 6, 17);
  const times = Array.from({ length: 100 }, (_, i) => start + i * DAY);
  const texts = ticksFor(times, '1D', 6).map((t) => t.text);
  for (const m of ['Aug', 'Sep', 'Oct']) assert.ok(texts.includes(m), `${m} in ${texts.join(' ')}`);
  assert.ok(!texts.some((t) => t.includes(':')), 'no clock times on a daily chart');
});

test('a year boundary is labelled with the year', () => {
  const start = Date.UTC(2025, 10, 1);
  const times = Array.from({ length: 120 }, (_, i) => start + i * DAY);
  const texts = ticksFor(times, '1D', 5).map((t) => t.text);
  assert.ok(texts.includes('2026'), texts.join(' '));
});

test('the step widens as the bars get narrower', () => {
  const wide = chooseStep(MIN, 12, 60);
  const narrow = chooseStep(MIN, 2, 60);
  assert.ok(narrow.approxMs > wide.approxMs);
  assert.ok(wide.approxMs * (12 / MIN) >= 60);
});

test('labels never clip at the left or right edge', () => {
  const start = Date.UTC(2026, 9, 24, 0, 0);
  const times = Array.from({ length: 200 }, (_, i) => start + i * MIN);
  const ticks = ticksFor(times, '1m', 6, 400);
  for (const t of ticks) {
    const half = measure(t.text) / 2;
    assert.ok(t.coord - half >= 4 && t.coord + half <= 400, `${t.text} at ${t.coord}`);
  }
});

test('times continue past the last bar, monthly bars by calendar month', () => {
  const jan = Date.UTC(2026, 0, 1);
  const feb = Date.UTC(2026, 1, 1);
  const at = timestampLookup(2, (i) => [jan, feb][i]!, '1M');
  assert.equal(at(2), Date.UTC(2026, 2, 1));
  assert.equal(at(-1), Date.UTC(2025, 11, 1));
  const m = timestampLookup(2, (i) => [0, MIN][i]!, '1m');
  assert.equal(m(5), 5 * MIN);
  assert.equal(timestampLookup(0, () => 0, '1m')(0), null);
});

test('crosshair label carries the weekday, and the time only intraday', () => {
  const ts = Date.UTC(2026, 9, 24, 14, 45);
  assert.equal(crosshairLabel(ts, 5 * MIN, 'utc'), "Sat 24 Oct '26  14:45");
  assert.equal(crosshairLabel(ts, DAY, 'utc'), "Sat 24 Oct '26");
  assert.equal(crosshairLabel(ts, 30 * DAY, 'utc'), "Oct '26");
});

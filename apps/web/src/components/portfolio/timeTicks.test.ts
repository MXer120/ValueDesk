import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dotGrid, timeTicks } from './timeTicks';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FROM = new Date(2026, 9, 31, 11, 37).getTime();

const gaps = (ts: number[]) => ts.slice(1).map((t, i) => t - ts[i]!);

test('dots: a column on every datapoint and one between, thinned only where they would merge', () => {
  assert.equal(dotGrid(600, 7).x, 50, '6 gaps of 100 px');
  assert.equal(dotGrid(600, 25).x, 12.5, '24 gaps of 25 px');
  assert.equal(dotGrid(600, 301).x, 16, 'every point would be 1 px apart: every 8th');
  assert.equal(Number.isInteger(dotGrid(600, 301).x / (600 / 300 / 2)), true, 'still on the datapoints');
  assert.equal(dotGrid(600, 7).y, 18);
  assert.equal(dotGrid(600, 25).y, 12.5);
});

test('24 hours read in hours, at one step, with the date only at midnight', () => {
  const ticks = timeTicks(FROM, FROM + DAY, 8);
  assert.ok(ticks.length >= 4);
  assert.equal(new Set(gaps(ticks.map((t) => t.t))).size, 1);
  assert.ok(ticks.some((t) => /^\d\d:00$/.test(t.label)));
  assert.ok(ticks.some((t) => t.label === 'Nov 1'), 'midnight names the day');
});

test('7 days show every day when there is room, and fewer at one step when not', () => {
  const wide = timeTicks(FROM, FROM + 7 * DAY, 10);
  assert.equal(wide.length, 7);
  assert.deepEqual(wide.slice(0, 3).map((t) => t.label), ['Nov 1', 'Nov 2', 'Nov 3']);
  const narrow = timeTicks(FROM, FROM + 7 * DAY, 4);
  assert.ok(narrow.length >= 3 && narrow.length <= 4);
  assert.equal(new Set(gaps(narrow.map((t) => t.t))).size, 1);
});

test('never more labels than fit, and all inside the range', () => {
  for (const span of [DAY, 7 * DAY, 14 * DAY, 30 * DAY, 200 * DAY, 900 * DAY]) {
    for (const max of [3, 5, 8, 12]) {
      const ticks = timeTicks(FROM, FROM + span, max);
      assert.ok(ticks.length <= max + 1, `${span / DAY} d in ${max}: ${ticks.length}`);
      assert.ok(ticks.length >= 1);
      for (const t of ticks) assert.ok(t.t >= FROM && t.t <= FROM + span);
    }
  }
});

test('long ranges read in months, with the year once it changes', () => {
  const ticks = timeTicks(new Date(2025, 10, 15).getTime(), new Date(2026, 9, 15).getTime(), 6);
  assert.ok(ticks.some((t) => t.label === 'Jan 2026'));
});

test('an empty or backwards range has no labels', () => {
  assert.deepEqual(timeTicks(FROM, FROM, 5), []);
  assert.deepEqual(timeTicks(FROM, FROM - 1, 5), []);
});

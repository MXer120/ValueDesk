import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatNumber, formatTime, numberFormat } from './intlCache';

const VALUES = [
  0, -0, 1, -1, 0.5, -0.5, 0.004999, 0.005, 0.12648, 1.005, 2.5, 9.995, 12.3456789, 999.995,
  9_999.5, 10_000, 79_290, 84_824.004, 123_456.789, 999_999, 1_000_000, 1_234_567.891, 9.87e9, 1.5e12,
  -3.14159, -12_345.678, 1e-9, 123456789.123456789, Number.MAX_SAFE_INTEGER, NaN, Infinity, -Infinity,
];

// Every option shape the app formats with (format.ts, explore/model.ts, leaderboard, book, palette).
const OPTIONS: Array<Intl.NumberFormatOptions | undefined> = [
  undefined,
  { maximumFractionDigits: 0 },
  { minimumFractionDigits: 2, maximumFractionDigits: 2 },
  { minimumFractionDigits: 0, maximumFractionDigits: 8 },
  { minimumFractionDigits: 1, maximumFractionDigits: 1 },
  { notation: 'compact', maximumFractionDigits: 1 },
  { notation: 'compact', maximumFractionDigits: 2 },
  { maximumSignificantDigits: 6 },
  ...[0, 1, 2, 3, 4, 5, 6, 8, 10].map((dp) => ({ minimumFractionDigits: dp, maximumFractionDigits: dp })),
];

test('formatNumber returns exactly what toLocaleString returns', () => {
  for (const locale of ['en-US', 'en-GB', 'de-DE']) {
    for (const o of OPTIONS) {
      for (const v of VALUES) {
        assert.equal(formatNumber(v, locale, o), v.toLocaleString(locale, o), `${v} ${locale} ${JSON.stringify(o)}`);
      }
    }
  }
});

test('the formatter is built once per locale + options', () => {
  const a = numberFormat('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  const b = numberFormat('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  assert.equal(a, b);
  assert.notEqual(a, numberFormat('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }));
});

test('invalid options still throw, as toLocaleString does', () => {
  assert.throws(() => (1).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 1 }), RangeError);
  assert.throws(() => formatNumber(1, 'en-US', { minimumFractionDigits: 3, maximumFractionDigits: 1 }), RangeError);
});

test('formatTime returns exactly what toLocaleTimeString returns', () => {
  const opts: Intl.DateTimeFormatOptions[] = [
    { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false },
    { hour: '2-digit', minute: '2-digit', hour12: false },
    { hour: 'numeric', minute: '2-digit' },
  ];
  const times = [0, 1, 1_790_780_400_000, 1_790_780_400_000 + 45_296_789, Date.UTC(2026, 0, 1, 23, 59, 59), -86_400_000];
  for (const o of opts) {
    for (const t of times) {
      assert.equal(formatTime(t, 'en-GB', o), new Date(t).toLocaleTimeString('en-GB', o), `${t} ${JSON.stringify(o)}`);
      assert.equal(formatTime(new Date(t), 'en-US', o), new Date(t).toLocaleTimeString('en-US', o));
    }
  }
});

test('formatTime: invalid times and option sets without a time field behave like toLocaleTimeString', () => {
  assert.equal(formatTime(NaN, 'en-GB', { hour: '2-digit' }), new Date(NaN).toLocaleTimeString('en-GB', { hour: '2-digit' }));
  assert.equal(formatTime(9e15, 'en-GB', { hour: '2-digit' }), new Date(9e15).toLocaleTimeString('en-GB', { hour: '2-digit' }));
  const dayOnly: Intl.DateTimeFormatOptions = { weekday: 'short' };
  assert.equal(formatTime(1_790_780_400_000, 'en-GB', dayOnly), new Date(1_790_780_400_000).toLocaleTimeString('en-GB', dayOnly));
});

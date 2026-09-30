/**
 * How a win rate reads: exact, estimate, too few closes, older server.
 *   npx tsx --test src/winRateView.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { winRateView } from './winRateView';

const fmtDate = (ms: number) => `D${ms}`;

test('no figure: a dash, muted, no tooltip', () => {
  assert.deepEqual(winRateView({}), { text: '—', approx: false, title: undefined, tone: 'muted' });
  assert.deepEqual(winRateView({ winRate: null, winRateExact: true, winRateCloses: 0 }), { text: '—', approx: false, title: undefined, tone: 'muted' });
  assert.equal(winRateView({ winRate: Number.NaN }).text, '—');
});

test('too few closes for an estimate: the dash says why', () => {
  const v = winRateView({ winRate: null, winRateExact: false, winRateCloses: 4 });
  assert.equal(v.text, '—');
  assert.equal(v.approx, false);
  assert.equal(v.title, 'Only 4 closes held so far. An estimate needs 10.');
  assert.equal(winRateView({ winRate: null, winRateExact: false, winRateCloses: 1 }).title, 'Only 1 close held so far. An estimate needs 10.');
});

test('an older server (no winRateExact): today’s cell, no ≈, no tooltip', () => {
  assert.deepEqual(winRateView({ winRate: 0.625 }), { text: '62.5%', approx: false, title: undefined, tone: 'pos' });
});

test('exact: plain, "every close in the window"', () => {
  const v = winRateView({ winRate: 0.5, winRateExact: true, winRateCloses: 12 });
  assert.equal(v.text, '50.0%');
  assert.equal(v.approx, false);
  assert.equal(v.tone, 'warn');
  assert.equal(v.title, 'Every close in the window (12 closes).');
  assert.equal(winRateView({ winRate: 1, winRateExact: true, winRateCloses: 1 }).title, 'Every close in the window (1 close).');
  assert.equal(winRateView({ winRate: 1, winRateExact: true }).title, 'Every close in the window.');
});

test('estimate: ≈, the closes it is from and since when', () => {
  const v = winRateView({ winRate: 0.3, winRateExact: false, winRateCloses: 1500, winRateFrom: 42 }, { fmtDate });
  assert.equal(v.text, '30.0%');
  assert.equal(v.approx, true);
  assert.equal(v.tone, 'neg');
  assert.equal(v.title, 'Estimate from the last 1,500 closed trades held (since D42). The full window is still being read.');
  const noFrom = winRateView({ winRate: 0.3, winRateExact: false, winRateCloses: 20, winRateFrom: null }, { fmtDate });
  assert.equal(noFrom.title, 'Estimate from the last 20 closed trades held. The full window is still being read.');
});

test('a profile sample (Scan): "from the last N closes since"', () => {
  const v = winRateView({ winRate: 0.55, winRateExact: false, winRateCloses: 37, winRateFrom: 7 }, { context: 'sample', fmtDate });
  assert.equal(v.approx, true);
  assert.equal(v.tone, 'pos');
  assert.equal(v.title, 'From the last 37 closes since D7.');
  // Exact on a sample has no window to name: the caller keeps its own hint.
  assert.equal(winRateView({ winRate: 0.55, winRateExact: true, winRateCloses: 37 }, { context: 'sample' }).title, undefined);
});

test('dp and clamping', () => {
  assert.equal(winRateView({ winRate: 0.12345 }, { dp: 2 }).text, '12.35%');
  assert.equal(winRateView({ winRate: 1.2 }).text, '100.0%');
});

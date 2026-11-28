import test from 'node:test';
import assert from 'node:assert/strict';
import { tidyHoldings } from './holdingRows';

// US Cash Yield (vBOXX) as SoSoValue reported it on 2026-11-25.
const BOXX = [
  { ticker: '2SPY  261218P10010010', name: 'SPY 12/18/2026 10010.01 P', weight: 0.945 },
  { ticker: '2SPY  261218C00010010', name: 'SPY 12/18/2026 10.01 C', weight: 0.0721 },
  { ticker: 'FGXXX', name: 'FIRST AMERICAN GOVERNMENT OBLI FIRST AM', weight: 0.0033 },
  { ticker: '2QQQ  261230C10005010', name: 'QQQ 12/30/2026 10005.01 C', weight: 0 },
  { ticker: '2QQQ  261230P00015010', name: 'QQQ 12/30/2026 15.01 P', weight: 0 },
  { ticker: '2SPY  261218P00010010', name: 'SPY 12/18/2026 10.01 P', weight: 0 },
  { ticker: '2SPY  261218C10010010', name: 'SPY 12/18/2026 10010.01 C', weight: 0 },
  { ticker: '2QQQ  261230C00015010', name: 'QQQ 12/30/2026 15.01 C', weight: -0.0011 },
  { ticker: 'Cash&Other', name: 'Cash & Other', weight: -0.0032 },
  { ticker: '2QQQ  261230P10005010', name: 'QQQ 12/30/2026 10005.01 P', weight: -0.0161 },
];

test('box spreads: the option legs are one row, no 0% and no negative rows, nothing lost from the sum', () => {
  const t = tidyHoldings(BOXX);
  assert.deepEqual(t.rows.map((r) => r.name), ['Box spreads: SPY, QQQ options']);
  assert.ok(t.rows.every((r) => r.weight > 0));
  assert.ok(Math.abs(t.rows[0]!.weight - 0.9999) < 1e-9);
  // Cash 0.33% held, 0.32% owed: nets to about 0, named as netted rather than shown as 0.01%.
  assert.ok(Math.abs(t.netted - 0.0001) < 1e-9);
  const sum = t.rows.reduce((s, r) => s + r.weight, 0) + t.netted;
  assert.ok(Math.abs(sum - BOXX.reduce((s, r) => s + r.weight, 0)) < 1e-9);
});

test('an ordinary fund is left as it is, apart from rows at 0', () => {
  const rows = [{ ticker: 'NVDA', name: 'NVIDIA CORP', weight: 0.08 }, { ticker: 'AAPL', name: 'APPLE INC', weight: 0.07 }, { ticker: 'X', name: 'Tiny', weight: 0 }];
  const t = tidyHoldings(rows);
  assert.deepEqual(t.rows.map((r) => r.ticker), ['NVDA', 'AAPL']);
  assert.equal(t.netted, 0);
});

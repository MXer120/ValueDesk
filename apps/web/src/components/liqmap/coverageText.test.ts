/**
 * The heatmap's coverage labels.
 *   npx tsx --test src/components/liqmap/coverageText.test.ts   (from apps/web)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverageText } from './coverageText';

const fmt = (v: number) => String(Math.round(v * 100) / 100);
// SoDEX's figures from production, 2026-10-30 (DriftStats, today).
const sodexAcc = { since: 1, checked: 54_669, matched: 54_669, n: 10_719, within01: 2_838, within1: 3_204, within5: 3_595, usd: 25_518_558_390, usd1: 24_179_439_401, moved: 50_478, window: 'today' as const };

test('accuracy is the drift between reads, not the match at a read', () => {
  const t = coverageText({ oi: 915, oiUsd: 70e6, long: 916, short: 915, longKnown: 916, shortKnown: 915, positions: 491, past: 0, price: 77_165, accuracy: sodexAcc, computed: false }, 'SoDEX', 'BTC', fmt);
  assert.equal(t.accuracy, '26% ≤0.1%', 'was "100% exact"');
  assert.ok(t.lines.some((l) => l.includes('26.5% within 0.1%') && l.includes('29.9% within 1%')), t.lines.join('\n'));
  assert.ok(t.lines.some((l) => l === 'Weighted by USD: 94.8% within 1%'), t.lines.join('\n'));
  assert.ok(t.lines.some((l) => l.includes('54,669 of 54,669')), 'the read match stays, as what it is');
});

test('no liquidation price is known, not missing: "% priced" is of the rest', () => {
  // Hyperliquid SOL, 2026-10-30: longs 2,708,290 of which 2,193,270 priced - most of the rest 1x longs.
  const c = { oi: 2_686_072, oiUsd: null, long: 2_708_290, short: 2_690_850, longKnown: 2_193_270, shortKnown: 2_690_630, longNone: 500_000, shortNone: 0, positions: 13_457, past: 0, price: 94.8, accuracy: null, computed: false };
  const t = coverageText(c, 'Hyperliquid', 'SOL', fmt);
  assert.equal(t.priced, null, '99.7% of what can be liquidated is priced: no "% priced" badge (it read 90%)');
  assert.ok(t.lines.some((l) => l.startsWith('500000 SOL (9.3%) has no liquidation price')), t.lines.join('\n'));
  const old = coverageText({ ...c, longNone: undefined, shortNone: undefined }, 'Hyperliquid', 'SOL', fmt);
  assert.equal(old.priced, '90% priced', 'an older server: everything without a price counts as not known');
  assert.equal(t.accuracy, 'checking');
});

test('arcus: computed; share over 105% shows as >100', () => {
  const t = coverageText({ oi: 100, oiUsd: null, long: 120, short: 110, longKnown: 120, shortKnown: 110, positions: 3, past: 0, price: 1, accuracy: null, computed: true }, 'Arcus', 'X', fmt);
  assert.equal(t.accuracy, 'computed');
  assert.equal(t.share, '>100% of OI');
  assert.equal(t.priced, null);
});

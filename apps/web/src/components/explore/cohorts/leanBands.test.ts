/**
 * The lean chart's bands: rebuilt stretches and gaps in a cohort's series.
 *   npx tsx --test src/components/explore/cohorts/leanBands.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bandsOf } from './LeanChart';

const H = 3_600_000;
const Q = 15 * 60_000;
const T0 = Date.UTC(2026, 9, 16, 12);

test('bands: a run of rebuilt points is one band; a long step with no points is a gap', () => {
  const series = [
    ...Array.from({ length: 20 }, (_, i) => ({ t: T0 + i * Q })),
    ...Array.from({ length: 5 }, (_, i) => ({ t: T0 + 6 * H + i * H, rebuilt: true })),
    ...Array.from({ length: 20 }, (_, i) => ({ t: T0 + 11 * H + i * Q })),
    ...Array.from({ length: 20 }, (_, i) => ({ t: T0 + 40 * H + i * Q })),
  ];
  assert.deepEqual(bandsOf(series), [
    { from: T0 + 6 * H, to: T0 + 10 * H, kind: 'rebuilt' },
    { from: T0 + 11 * H + 19 * Q, to: T0 + 40 * H, kind: 'gap' },
  ]);
});

test('bands: an evenly spaced series has none; a lone rebuilt point is an hour wide', () => {
  assert.deepEqual(bandsOf(Array.from({ length: 50 }, (_, i) => ({ t: T0 + i * Q }))), []);
  assert.deepEqual(bandsOf([]), []);
  const lone = bandsOf([{ t: T0 }, { t: T0 + H, rebuilt: true }, { t: T0 + 2 * H }]);
  assert.deepEqual(lone, [{ from: T0 + H / 2, to: T0 + 1.5 * H, kind: 'rebuilt' }]);
});

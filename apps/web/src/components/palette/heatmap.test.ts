/**
 * The palette's Home market map and its links into Explore's cohort pages.
 *   npx tsx --test src/components/palette/heatmap.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CohortMarket } from '@sign/valuescan/cohorts/model.js';
import {
  COHORTS_PATH,
  MARKET_MAP_PATH,
  cohortAssetPath,
  flattenMapAssets,
  mapTotals,
  traderSizeCohort,
} from './model';

const m = (coin: string, long: number, short: number, extra: Partial<CohortMarket> = {}): CohortMarket => ({
  coin, sector: 'majors', long, short, upnl: 0, holders: 1, ...extra,
});

test('flattenMapAssets: every sector in one list, biggest gross exposure first', () => {
  const out = flattenMapAssets([
    { assets: [m('ETH', 50, 10), m('BTC', 100, 40)] },
    { assets: [m('DOGE', 5, 70), m('PEPE', 1, 0)] },
  ]);
  assert.deepEqual(out.map((x) => x.coin), ['BTC', 'DOGE', 'ETH', 'PEPE']);
});

test('flattenMapAssets: drops assets nobody holds, merges a coin listed twice', () => {
  const out = flattenMapAssets([
    { assets: [m('BTC', 10, 5, { upnl: 3, holders: 2 }), m('ZERO', 0, 0)] },
    { assets: [m('BTC', 1, 4, { upnl: -1, holders: 1 })] },
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual({ ...out[0] }, { coin: 'BTC', sector: 'majors', long: 11, short: 9, upnl: 2, holders: 3 });
});

test('flattenMapAssets: ignores malformed figures and does not mutate its input', () => {
  const input = [{ assets: [m('BAD', Number.NaN, 1), m('NEG', -5, 1), m('OK', 1, 1)] }];
  const snapshot = JSON.stringify(input);
  assert.deepEqual(flattenMapAssets(input).map((x) => x.coin), ['OK']);
  assert.equal(JSON.stringify(input), snapshot);
  assert.deepEqual(flattenMapAssets([]), []);
});

test('flattenMapAssets: equal sizes keep a stable (alphabetical) order', () => {
  assert.deepEqual(flattenMapAssets([{ assets: [m('SOL', 5, 5), m('ADA', 5, 5)] }]).map((x) => x.coin), ['ADA', 'SOL']);
});

test('mapTotals: long and short notional and the long share', () => {
  assert.deepEqual(mapTotals([m('A', 30, 10), m('B', 10, 50)]), { long: 40, short: 60, longShare: 0.4 });
  assert.deepEqual(mapTotals([]), { long: 0, short: 0, longShare: null });
});

test('cohortAssetPath: the market map page for one coin, as Cohorts.tsx reads it', () => {
  assert.equal(cohortAssetPath('BTC'), '/explore?view=cohorts&section=map&focus=coin:BTC');
  assert.equal(cohortAssetPath('kpepe'), '/explore?view=cohorts&section=map&focus=coin:KPEPE');
  assert.equal(new URLSearchParams(cohortAssetPath('eth').split('?')[1]).get('focus'), 'coin:ETH');
  // Nothing usable: the map itself, never a focus Cohorts.tsx would reject.
  assert.equal(cohortAssetPath(' / '), MARKET_MAP_PATH);
  assert.equal(COHORTS_PATH, '/explore?view=cohorts');
});

test('traderSizeCohort: account value to the cohort pages\' size bands', () => {
  assert.equal(traderSizeCohort(12_000_000), 'apex');
  assert.equal(traderSizeCohort(2_000_000), 'whale');
  assert.equal(traderSizeCohort(250_000), 'large');
  assert.equal(traderSizeCohort(20_000), 'medium');
  assert.equal(traderSizeCohort(50), 'small');
  assert.equal(traderSizeCohort(0), null);
  assert.equal(traderSizeCohort(null), null);
  assert.equal(traderSizeCohort(undefined), null);
  assert.equal(traderSizeCohort(Number.NaN), null);
});

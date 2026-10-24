/**
 * Rebuilding cohort history the index did not record (indexer/cohortRebuild.ts):
 * which hours are missing, a wallet's funding rows as hourly positions, which
 * wallets are read, and one hour summed over every scope.
 *
 *   npx tsx --test test/cohortRebuild.test.ts   (from apps/server)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HOUR_MS, MIN_SHOWN_MS, REBUILD_WINDOW_MS, checkEdges, histOf, missingSpans, needsEquityHistory, peakNotional,
  positionsAt, priceAt, rebuildHour, rebuildRate, rebuildSample, resumedAfterOutage, sizeProxy, valueAt, venueOfSymbol,
  type Bridge, type RebuildWallet,
} from '../src/indexer/cohortRebuild.js';
import { IndexStore } from '../src/indexer/store.js';
import { hlFundingRows } from '../src/indexer/cohortSource.js';
import { hlInfo } from '../src/valuescan/hyperliquid/index.js';
import { allScopes } from '../src/indexer/cohortTracker.js';
import { scopeKey } from '../src/valuescan/cohorts/model.js';

const H = HOUR_MS;
const Q = 15 * 60_000;
const T0 = Date.UTC(2026, 9, 16, 12);

/** Recorded points every 15 minutes over [from, to]. */
const every15 = (from: number, to: number) => Array.from({ length: Math.floor((to - from) / Q) + 1 }, (_, i) => from + i * Q);

test('missing spans: hours with no recorded point within 45 minutes, between recorded points', () => {
  const now = T0 + 9 * 24 * H;
  // Recorded until 17:30, nothing until 12:30 seven days later (the 2026-10-16 outage).
  const rec = [...every15(T0, T0 + 5.5 * H), ...every15(T0 + 7 * 24 * H + 0.5 * H, now)];
  const spans = missingSpans(rec, now);
  assert.equal(spans.length, 1);
  assert.equal(spans[0]!.from, T0 + 7 * H, '19:00: 18:00 is 30 minutes from 17:30');
  assert.equal(spans[0]!.to, T0 + 7 * 24 * H - H, '11:00: 12:00 is 30 minutes from 12:30');
  // A restart's gap of an hour leaves no two missing hours.
  assert.deepEqual(missingSpans([...every15(T0, T0 + 2 * H), ...every15(T0 + 3.5 * H, T0 + 6 * H)], now), []);
  // Gone from the 30-day window within a week: not worth the reads.
  const old = now - REBUILD_WINDOW_MS + MIN_SHOWN_MS - 24 * H;
  assert.deepEqual(missingSpans([old - Q, old + 10 * H], now), []);
});

test('the last outage: when the recording resumed after a gap of an hour or more', () => {
  const rec = [...every15(T0, T0 + 5.5 * H), ...every15(T0 + 7 * 24 * H, T0 + 7 * 24 * H + 3 * H)];
  assert.equal(resumedAfterOutage(rec), T0 + 7 * 24 * H);
  assert.equal(resumedAfterOutage(every15(T0, T0 + 30 * H)), 0, 'no gap');
  assert.equal(resumedAfterOutage([T0, T0 + 45 * 60_000]), 0, 'a missed point or two is not an outage');
});

test('funding rows as hourly runs: a size held hour after hour is one run; a closed hour ends it', () => {
  const rows = [
    ...[0, 1, 2].map((i) => ({ time: T0 + i * H + 7, coin: 'BTC', szi: -2 })),
    { time: T0 + 3 * H, coin: 'BTC', szi: -3 },
    { time: T0 + 5 * H, coin: 'BTC', szi: -3 },
    { time: T0 + H, coin: 'xyz:GOLD', szi: 10 },
    { time: T0 + 2 * H, coin: 'ETH', szi: 0 },
  ];
  const w = histOf(rows, 4);
  assert.deepEqual(w.p.BTC, [[T0, -2, 3], [T0 + 3 * H, -3, 1], [T0 + 5 * H, -3, 1]]);
  assert.deepEqual(w.p['xyz:GOLD'], [[T0 + H, 10, 1]]);
  assert.equal(w.p.ETH, undefined, 'a zero size is no position');
  assert.equal(w.w, 4);
  assert.deepEqual(positionsAt(w, T0 + H).map((p) => [p.symbol, p.szi]), [['BTC', -2], ['xyz:GOLD', 10]]);
  assert.deepEqual(positionsAt(w, T0 + 4 * H), [], 'closed that hour');
  assert.deepEqual(positionsAt(w, T0 + 5 * H).map((p) => p.szi), [-3]);
  assert.equal(venueOfSymbol('BTC'), 'hyperliquid');
  assert.equal(venueOfSymbol('xyz:GOLD'), 'tradexyz');
  assert.equal(venueOfSymbol('flx:OIL'), null);
});

test('values between points, prices near the hour, and the equity check', () => {
  const pts: Array<[number, number]> = [[T0, 100], [T0 + 4 * H, 300]];
  assert.equal(valueAt(pts, T0 - H), 100);
  assert.equal(valueAt(pts, T0 + H), 150);
  assert.equal(valueAt(pts, T0 + 9 * H), 300);
  assert.equal(valueAt([], T0), null);
  const px = new Map([[T0, 10], [T0 + 2 * H, 12]]);
  assert.equal(priceAt(px, T0), 10);
  assert.equal(priceAt(px, T0 + H), 10, 'the hour before when the hour has none');
  assert.equal(priceAt(px, T0 + 6 * H), null);
  const w = histOf([{ time: T0, coin: 'BTC', szi: 2 }, { time: T0, coin: 'ETH', szi: -10 }, { time: T0 + H, coin: 'BTC', szi: 1 }], 1);
  assert.equal(peakNotional(w, (s) => (s === 'BTC' ? 100_000 : 4_000)), 240_000);
  assert.equal(needsEquityHistory(240_000, 1_000_000), false);
  assert.equal(needsEquityHistory(240_000, 5_000), true, 'held 48x the equity it has now');
  assert.equal(needsEquityHistory(20_000, null), false, 'small against the $1K floor');
});

test('which wallets: every large one, a fixed sample of the rest, each standing for 1 / rate', () => {
  assert.equal(sizeProxy(50_000, 30_000_000), 3_000_000, 'its volume says it held more than its equity now');
  assert.equal(sizeProxy(null, undefined), 0);
  assert.deepEqual([2e6, 5e5, 5e4, 10].map(rebuildRate), [1, 0.25, 0.1, 0.02]);
  assert.deepEqual(rebuildSample('0xabc', 2e6), { counts: true, weight: 1 });
  let picked = 0;
  for (let i = 0; i < 20_000; i++) {
    const r = rebuildSample(`0x${i.toString(16).padStart(40, '0')}`, 500);
    if (r.counts) { picked++; assert.equal(r.weight, 50); }
  }
  assert.ok(picked > 300 && picked < 500, `about 1 in 50: ${picked}`);
  const a = '0x00000000000000000000000000000000000000ff';
  assert.deepEqual(rebuildSample(a, 500), rebuildSample(a, 500), 'the same wallets every time');
});

test('one hour: the reads netted per scope, other venues bridged, a scope of those alone left out', () => {
  const t = T0 + 10 * H;
  const wallets: RebuildWallet[] = [
    {
      // A $6M Apex wallet, long BTC on Hyperliquid and short GOLD on trade.xyz.
      address: '0xa',
      hist: histOf([{ time: t, coin: 'BTC', szi: 10 }, { time: t, coin: 'xyz:GOLD', szi: -100 }], 1),
      now: { hyperliquid: { pnl: 2_000_000, equity: 6_000_000, label: null }, tradexyz: { pnl: null, equity: 6_000_000, label: null } },
    },
    {
      // A sampled small wallet standing for 50: short ETH.
      address: '0xb',
      hist: histOf([{ time: t, coin: 'ETH', szi: -1 }], 50),
      now: { hyperliquid: { pnl: -500, equity: 2_000, label: null } },
    },
    {
      // Withdrawn since: its equity then (from its portfolio) puts it in Whale, not Small.
      address: '0xc',
      hist: { ...histOf([{ time: t, coin: 'BTC', szi: -20 }], 1), eq: [[t - H, 3_000_000], [t + H, 3_000_000]] },
      now: { hyperliquid: { pnl: 10_000, equity: 500, label: null } },
    },
  ];
  const px: Record<string, number> = { BTC: 100_000, ETH: 4_000, 'xyz:GOLD': 4_000 };
  const price = (s: string) => px[s] ?? null;
  const edge = (tt: number, apexLong: number): Bridge['left'] => ({ t: tt, series: new Map([['apex', [apexLong, 0]]]) });
  const lighter: Bridge = {
    left: edge(t - 10 * H, 1_000_000), right: edge(t + 10 * H, 3_000_000),
    mixLeft: { t: t - 10 * H, mix: new Map([['apex', { c: { BTC: [1_000_000, 0] }, s: { majors: [1_000_000, 0] } }]]) },
    mixRight: { t: t + 10 * H, mix: new Map([['apex', { c: { BTC: [3_000_000, 0] }, s: { majors: [3_000_000, 0] } }]]) },
  };
  const h = rebuildHour(t, wallets, price, new Map([['lighter', lighter]]), true);
  const row = (scope: string, cohort: string) => h.series.find((r) => r.scope === scope && r.cohort === cohort);
  assert.deepEqual([row('hyperliquid', 'apex')!.long, row('hyperliquid', 'apex')!.short], [1_000_000, 0]);
  assert.deepEqual([row('tradexyz', 'apex')!.long, row('tradexyz', 'apex')!.short], [0, 400_000]);
  assert.deepEqual([row('hyperliquid+tradexyz', 'apex')!.long, row('hyperliquid+tradexyz', 'apex')!.short], [1_000_000, 400_000]);
  assert.deepEqual([row('hyperliquid', 'small')!.long, row('hyperliquid', 'small')!.short], [0, 200_000], 'one wallet standing for 50');
  assert.deepEqual([row('hyperliquid', 'whale')!.long, row('hyperliquid', 'whale')!.short], [0, 2_000_000], 'its equity then');
  // Lighter halfway between its edges: 2M long added to Apex.
  assert.deepEqual([row('hyperliquid+lighter', 'apex')!.long, row('hyperliquid+lighter', 'apex')!.short], [3_000_000, 0]);
  assert.equal(row('lighter', 'apex'), undefined, 'a scope of bridged venues alone keeps its gap');
  assert.equal(row('hyperliquid+sodex', 'apex'), undefined, 'SoDEX has no bridge here');
  assert.ok(h.series.every((r) => r.rebuilt && r.t === t));
  const scopes = new Set(h.series.map((r) => r.scope));
  assert.equal(scopes.size, allScopes().filter((s) => s.some((v) => v === 'hyperliquid' || v === 'tradexyz') && s.every((v) => v === 'hyperliquid' || v === 'tradexyz' || v === 'lighter')).length);
  const mix = JSON.parse(h.mix.find((r) => r.scope === scopeKey(['hyperliquid', 'lighter']) && r.cohort === 'apex')!.data);
  assert.deepEqual(mix.c.BTC, [3_000_000, 0], 'the reads plus the bridged mix');
  assert.deepEqual(mix.s.majors, [3_000_000, 0]);
});

test('the check: long share and gross against the recording at the edges', () => {
  const t = T0;
  const c = checkEdges(
    new Map([[t, new Map([['apex', [60, 40] as [number, number]]])], [t + H, new Map([['apex', [50, 50] as [number, number]]])]]),
    new Map([[t, new Map([['apex', [55, 45] as [number, number]]])]]),
  );
  assert.equal(c.hours, 1);
  assert.deepEqual(c.cohorts.apex, { sharePts: 5, grossPct: 0 });
});

test('funding reads take every page\'s weight from the rebuild\'s bucket first, and refuse a history past the page cap', async () => {
  const calls: string[] = [];
  const pace = { reserve: (w: number) => { calls.push(`reserve ${w}`); return 0; }, charge: (w: number) => { calls.push(`charge ${w}`); } };
  const page = (t0: number, n: number) => Array.from({ length: n }, (_, i) => ({ time: t0 + Math.floor(i / 50) * H, delta: { coin: `C${i % 50}`, szi: '1' } }));
  const post = hlInfo.post.bind(hlInfo);
  try {
    let n = 0;
    hlInfo.post = (async () => [page(T0, 500), page(T0 + 10 * H, 500), page(T0 + 20 * H, 10)][n++]) as typeof hlInfo.post;
    const { rows, cost } = await hlFundingRows('0xa', T0, T0 + 30 * H, pace);
    assert.equal(rows.length, 1_010);
    assert.deepEqual(calls, ['reserve 20', 'charge 25', 'reserve 20', 'charge 25', 'reserve 20', 'charge 1']);
    assert.equal(cost, 20 + 25 + 20 + 25 + 20 + 1);
    // A wallet whose pages never end is refused, not cut short.
    let t = T0;
    hlInfo.post = (async () => page((t += H), 500)) as typeof hlInfo.post;
    await assert.rejects(hlFundingRows('0xb', T0, T0 + 1e6 * H), /over \d+ pages/);
  } finally {
    hlInfo.post = post;
  }
});

test('store: rebuilt rows are marked and never count as recorded; reads per span come and go', () => {
  const s = new IndexStore(':memory:');
  s.putCohortSeries([{ scope: 'hyperliquid', cohort: 'apex', t: T0, long: 1, short: 2 }]);
  s.putCohortSeries([{ scope: 'hyperliquid', cohort: 'apex', t: T0 + H, long: 3, short: 4, rebuilt: true }]);
  assert.deepEqual(s.cohortSeries('hyperliquid', 0).map((r) => [r.t, r.rebuilt]), [[T0, false], [T0 + H, true]]);
  assert.deepEqual(s.cohortSeries('hyperliquid', 0, 'apex', T0).map((r) => r.t), [T0], 'up to toT');
  assert.deepEqual(s.cohortSeriesRecorded('hyperliquid', 'apex', 0), [T0]);
  s.putCohortMix([{ scope: 'hyperliquid', cohort: 'apex', t: T0 + H, data: '{"c":{},"s":{}}', rebuilt: true }]);
  assert.equal(s.cohortMix('hyperliquid', 0)[0]!.rebuilt, true);
  s.putCohortHist(T0, 'w', [['0xa', '{"p":{},"w":1}'], ['0xb', '{"p":{},"w":2}']], 1);
  s.putCohortHist(T0, 'px', [['BTC', '[]']], 1);
  assert.deepEqual([...s.cohortHistKeys(T0, 'w')].sort(), ['0xa', '0xb']);
  assert.equal(s.cohortHist(T0, 'px').get('BTC'), '[]');
  assert.deepEqual(s.cohortHistSpans(), [T0]);
  s.dropCohortHist(T0);
  assert.deepEqual(s.cohortHistSpans(), []);
  assert.ok(s.schemaReady());
});

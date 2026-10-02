/**
 * What the index sends: only what a client reads.
 *
 *   - Explore segment rows: the trader, the account value and the windows of
 *     the six tables (valuescan/explore.ts wireRow). The segments themselves -
 *     who is in them, in which order - are cut from the full rows as before.
 *   - Screener rows: without `enrichedAt` (valuescan/screener.ts wireRow).
 *
 * (`label: null` is dropped for every index route in perf.ts: test/perf.test.ts.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SEGMENT_IDS,
  WIRE_PNL_WINDOWS,
  WIRE_ROI_WINDOWS,
  WIRE_VOLUME_WINDOWS,
  assemble,
  buildSegments,
  wireRow,
} from '../src/valuescan/explore.js';
import { wireRow as screenerWireRow } from '../src/valuescan/screener.js';
import { toScreenerRow } from '../src/valuescan/screener/model.js';
import type { LeaderboardPage, TraderRow, Venue } from '../src/valuescan/types.js';

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const addr = (n: number) => `0x${String(n).padStart(40, '0')}`;

/** A full leaderboard row, with everything a provider can put on one. */
function full(venue: Venue, n: number, p: Partial<TraderRow> = {}): TraderRow {
  return {
    venue,
    address: addr(n),
    label: null,
    accountId: venue === 'sodex' ? 1000 + n : null,
    accountValue: 50_000 + n * 1000,
    pnl: { '1d': n, '7d': n * 20, '30d': n * 100, all: n * 300 },
    roi: { '1d': 0.001 * n, '7d': 0.01 * n, '30d': 0.02 * n, all: 0.5 },
    volume: { '1d': 1e5 + n, '7d': 5e5 + n, '30d': 2e6 + n, all: 9e6 },
    winRate: 0.6,
    winRateExact: true,
    winRateCloses: 40,
    winRateFrom: null,
    trades: 120,
    tradesCapped: false,
    assets: ['BTC', 'ETH'],
    maxDrawdown: 0.2,
    sharpe: 1.1,
    lastActive: NOW - n * 60_000,
    spark: Array.from({ length: 30 }, (_, i) => i * n),
    tags: ['whale'],
    rank: n,
    rankChange: 1,
    ...p,
  };
}

const page = (rows: TraderRow[], total = rows.length): LeaderboardPage => ({ rows, total, updatedAt: NOW - 30_000, source: 'test' });

const POOL: TraderRow[] = [
  ...Array.from({ length: 14 }, (_, i) => full('sodex', i + 1)),
  ...Array.from({ length: 14 }, (_, i) => full('hyperliquid', i + 21)),
  // No ROI, no 7D figures, no account value: still a top-pnl row.
  full('hyperliquid', 60, { accountValue: null, roi: {}, pnl: { '30d': 9_999_999 }, volume: { '1d': 5 } }),
];

test('wireRow: the six fields the page reads, the shown windows only, absent figures left out', () => {
  const w = wireRow(full('sodex', 3));
  assert.deepEqual(Object.keys(w).sort(), ['accountValue', 'address', 'pnl', 'roi', 'venue', 'volume']);
  assert.deepEqual(w, {
    venue: 'sodex',
    address: addr(3),
    accountValue: 53_000,
    pnl: { '30d': 300, '7d': 60, all: 900 },
    roi: { '30d': 0.06 },
    volume: { '7d': 500_003 },
  });
  assert.deepEqual(Object.keys(w.pnl).sort(), [...WIRE_PNL_WINDOWS].sort());
  assert.deepEqual(Object.keys(w.roi), [...WIRE_ROI_WINDOWS]);
  assert.deepEqual(Object.keys(w.volume), [...WIRE_VOLUME_WINDOWS]);

  // null, missing and non-finite all mean "no figure": none is sent, the maps stay.
  const sparse = wireRow(full('hyperliquid', 4, { accountValue: Number.NaN, pnl: { '30d': null, '7d': 0 }, roi: {}, volume: { '7d': Number.POSITIVE_INFINITY } }));
  assert.deepEqual(sparse, { venue: 'hyperliquid', address: addr(4), accountValue: null, pnl: { '7d': 0 }, roi: {}, volume: {} });
});

test('explore: the same traders in the same order as the full rows give; only the row shape is smaller', () => {
  const harvests = (['sodex', 'hyperliquid'] as const).map((venue) => ({
    venue,
    pages: [page(POOL.filter((r) => r.venue === venue), 500)],
    errors: [],
  }));
  const res = assemble(harvests, NOW);
  const fullSegments = buildSegments(POOL);

  assert.deepEqual(res.segments.map((s) => s.id), [...SEGMENT_IDS]);
  for (const seg of res.segments) {
    const want = fullSegments.find((s) => s.id === seg.id)!;
    assert.equal(seg.title, want.title);
    assert.equal(seg.subtitle, want.subtitle);
    assert.deepEqual(seg.rows.map((r) => `${r.venue}:${r.address}`), want.rows.map((r) => `${r.venue}:${r.address}`), `${seg.id}: same rows, same order`);
    for (const [i, r] of seg.rows.entries()) {
      assert.deepEqual(r, wireRow(want.rows[i]!), `${seg.id} row ${i}`);
      assert.deepEqual(Object.keys(r).sort(), ['accountValue', 'address', 'pnl', 'roi', 'venue', 'volume']);
    }
  }
  assert.ok(res.segments.find((s) => s.id === 'top-pnl')!.rows.length > 10, 'both venues contribute');
  assert.equal(res.segments[0]!.rows[0]!.address, addr(60), 'a row without ROI or account value still ranks');

  // The KPIs still come from the FULL pool (24h volume is a window the rows no longer carry).
  assert.equal(res.kpis.tracked, 1000);
  assert.equal(res.kpis.volume24h, POOL.reduce((s, r) => s + (r.volume['1d'] ?? 0), 0));
  assert.deepEqual(res.kpis.venues, ['sodex', 'hyperliquid']);

  // And the answer is a fraction of what the full rows would be.
  const before = JSON.stringify({ ...res, segments: fullSegments });
  const after = JSON.stringify(res);
  assert.ok(after.length < before.length / 2, `${after.length} vs ${before.length} bytes`);
  for (const gone of ['spark', 'label', 'accountId', 'winRate', 'trades', 'tags', 'lastActive', 'maxDrawdown', 'sharpe', 'assets', 'rank', '1d']) {
    assert.equal(after.includes(`"${gone}":`), false, `${gone} is not sent`);
  }
});

test('screener: a sent row is the row without enrichedAt', () => {
  const row = toScreenerRow(full('hyperliquid', 7), undefined, ['sodex'], NOW);
  assert.equal(row.enrichedAt, null);
  const sent = screenerWireRow(row);
  assert.equal('enrichedAt' in sent, false);
  const { enrichedAt: _dropped, ...rest } = row;
  assert.deepEqual(sent, rest);
  assert.equal('enrichedAt' in row, true, 'the server row itself is untouched');
});

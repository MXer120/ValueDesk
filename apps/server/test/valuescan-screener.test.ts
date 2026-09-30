/**
 * Screener tests: strategy classification, activity, query parsing, filters,
 * presets, sort, the enrichment merge, the pool harvest/cache, the background
 * enricher's pacing rules and the Hyperliquid market mapper.
 *
 * DELIBERATELY OFFLINE: providers are stubs, the enricher's clock and timer
 * are injected, nothing opens a socket.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HIGH_WINRATE_MIN_TRADES,
  PRESETS,
  activeBucket,
  activeWithinSpan,
  classify,
  enrichmentFromProfile,
  isDormant,
  matchesText,
  parseScreenerQuery,
  passes,
  recencyKey,
  screen,
  sortRows,
  toScreenerRow,
  type Enrichment,
  type ScreenerRow,
} from '../src/valuescan/screener/model.js';
import { Enricher, isRateLimited } from '../src/valuescan/screener/enrich.js';
import { POOL_STALE_MAX_MS, POOL_TTL_MS, PoolCache, harvestPool, type VenuePool } from '../src/valuescan/screener/pool.js';
import { mapAssetCtxs } from '../src/valuescan/screener/assets.js';
import { assemble, enrichTargets } from '../src/valuescan/screener.js';
import {
  NotAvailable,
  type LeaderboardQuery,
  type TraderProfile,
  type TraderRow,
  type Venue,
  type VenueProvider,
} from '../src/valuescan/types.js';

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const H = 3_600_000;
const D = 24 * H;

const A1 = '0x1111111111111111111111111111111111111111';
const A2 = '0x2222222222222222222222222222222222222222';
const A3 = '0x3333333333333333333333333333333333333333';

function row(p: Partial<TraderRow> & { address?: string } = {}): TraderRow {
  return {
    venue: 'hyperliquid',
    address: A1,
    label: null,
    accountValue: 100_000,
    pnl: {},
    roi: {},
    volume: {},
    ...p,
  };
}

function srow(p: Partial<TraderRow> = {}, e?: Enrichment, alsoOn: Venue[] = []): ScreenerRow {
  return toScreenerRow(row(p), e, alsoOn, NOW);
}

function enrich(p: Partial<Enrichment> = {}): Enrichment {
  return {
    at: NOW - H,
    missing: false,
    winRate: null,
    trades: null,
    lastActive: null,
    maxDrawdown: null,
    accountValue: null,
    positions: null,
    maxLeverage: null,
    openNotional: null,
    tags: [],
    ...p,
  };
}

const Q = (q: Record<string, string> = {}) => parseScreenerQuery(q);

/* ------------------------------------------------------------------------ */
/* classify                                                                  */
/* ------------------------------------------------------------------------ */

test('classify: a venue-measured hold-time tag wins over turnover', () => {
  // Turnover alone would say scalper (10,000x), the venue measured swing holds.
  const c = classify({ tags: ['swing'], accountValue: 1_000, volume: { '30d': 10_000_000 } });
  assert.equal(c.strategy, 'swing');
});

test('classify: turnover thresholds pick the style', () => {
  const at = (turnover: number) =>
    classify({ accountValue: 100_000, volume: { '30d': 100_000 * turnover } }).strategy;
  assert.equal(at(5_000), 'scalper');
  assert.equal(at(1_000), 'scalper');
  assert.equal(at(999), 'intraday');
  assert.equal(at(150), 'intraday');
  assert.equal(at(149), 'swing');
  assert.equal(at(15), 'swing');
  assert.equal(at(14.9), 'position');
  assert.equal(at(0.5), 'position');
});

test('classify: no style from thin or missing data', () => {
  // Account too small for the ratio to mean anything.
  assert.equal(classify({ accountValue: 500, volume: { '30d': 1e9 } }).strategy, null);
  // No 30D volume known.
  assert.equal(classify({ accountValue: 1e6, volume: { '7d': 1e6 } }).strategy, null);
  // Zero volume and nothing open: dormant, not a position trader.
  assert.equal(classify({ accountValue: 1e6, volume: { '30d': 0 } }).strategy, null);
  // Zero volume but holding something: a position holder.
  assert.equal(classify({ accountValue: 1e6, volume: { '30d': 0 }, positions: 2 }).strategy, 'position');
});

test('classify: traits', () => {
  assert.deepEqual(classify({ accountValue: 2e6, volume: {} }).traits, ['whale']);
  assert.deepEqual(classify({ tags: ['whale'], accountValue: 10, volume: {} }).traits, ['whale']);
  assert.deepEqual(classify({ accountValue: 1, volume: {}, maxLeverage: 25 }).traits, ['high-leverage']);
  assert.deepEqual(classify({ accountValue: 1, volume: {}, maxLeverage: 19 }).traits, []);
  assert.deepEqual(classify({ tags: ['vault', 'high-leverage'], accountValue: 1, volume: {} }).traits, ['high-leverage', 'vault']);
});

/* ------------------------------------------------------------------------ */
/* activity                                                                  */
/* ------------------------------------------------------------------------ */

test('activeBucket: tightest window with volume, or the exact last fill, whichever is tighter', () => {
  assert.equal(activeBucket({ volume: { '1d': 5, '7d': 10 } }, NOW), '1d');
  assert.equal(activeBucket({ volume: { '1d': 0, '7d': 10 } }, NOW), '7d');
  assert.equal(activeBucket({ volume: { '30d': 10 } }, NOW), '30d');
  assert.equal(activeBucket({ volume: { '1d': 0, '7d': 0, '30d': 0 } }, NOW), null);
  assert.equal(activeBucket({ volume: { '30d': 10 }, lastActive: NOW - 2 * H }, NOW), '1d');
  assert.equal(activeBucket({ volume: { '1d': 10 }, lastActive: NOW - 20 * D }, NOW), '1d');
  assert.equal(activeBucket({ volume: {}, lastActive: NOW - 40 * D }, NOW), null);
});

test('activeWithinSpan: exact beats bucket; 1h needs an exact fill', () => {
  const byVol = srow({ volume: { '1d': 1 } });
  assert.equal(activeWithinSpan(byVol, '24h', NOW), true);
  assert.equal(activeWithinSpan(byVol, '7d', NOW), true);
  assert.equal(activeWithinSpan(byVol, '1h', NOW), false);
  const exact = srow({ volume: {}, lastActive: NOW - 30 * 60_000 });
  assert.equal(activeWithinSpan(exact, '1h', NOW), true);
  const week = srow({ volume: { '7d': 1 } });
  assert.equal(activeWithinSpan(week, '24h', NOW), false);
  assert.equal(activeWithinSpan(week, '30d', NOW), true);
  assert.equal(activeWithinSpan(srow({ volume: {} }), '30d', NOW), false);
});

test('recencyKey: exact when known, else the bucket floor', () => {
  assert.equal(recencyKey(srow({ volume: {}, lastActive: NOW - 3 * D }), NOW), NOW - 3 * D);
  assert.equal(recencyKey(srow({ volume: { '1d': 1 } }), NOW), NOW - D);
  assert.equal(recencyKey(srow({ volume: {} }), NOW), null);
});

test('isDormant: known zero 30D volume with no other evidence; hidden unless dormant=1', () => {
  const idle = srow({ volume: { '30d': 0, all: 5 } });
  assert.equal(isDormant(idle), true);
  assert.equal(isDormant(srow({ volume: {} })), false); // unknown is not zero
  assert.equal(isDormant(srow({ volume: { '30d': 0, '1d': 3 } })), false);
  assert.equal(isDormant(srow({ volume: { '30d': 0 } }, enrich({ positions: 1 }))), false);
  assert.equal(isDormant(srow({ volume: { '30d': 0 }, lastActive: NOW - 3 * D })), false);
  assert.equal(passes(idle, Q(), NOW), false);
  assert.equal(passes(idle, Q({ dormant: '1' }), NOW), true);
});

/* ------------------------------------------------------------------------ */
/* merge of row + enrichment                                                 */
/* ------------------------------------------------------------------------ */

test('toScreenerRow: row fields win, enrichment fills gaps, lastActive takes the later, tags union', () => {
  const r = toScreenerRow(
    row({ winRate: 0.7, tags: ['vault'], lastActive: NOW - 5 * D, accountValue: null, volume: { '30d': 0 } }),
    enrich({ winRate: 0.4, trades: 50, lastActive: NOW - H, accountValue: 2e6, positions: 3, maxLeverage: 25, tags: ['whale'] }),
    ['sodex'],
    NOW,
  );
  assert.equal(r.winRate, 0.7);
  assert.equal(r.trades, 50);
  assert.equal(r.lastActive, NOW - H);
  assert.equal(r.accountValue, 2e6);
  assert.deepEqual([...(r.tags ?? [])].sort(), ['vault', 'whale']);
  assert.deepEqual(r.traits, ['whale', 'high-leverage', 'vault']);
  assert.equal(r.strategy, 'position'); // no 30D volume but 3 open positions
  assert.equal(r.positions, 3);
  assert.equal(r.activeWithin, '1d');
  assert.deepEqual(r.alsoOn, ['sodex']);
  assert.equal(r.enrichedAt, NOW - H);
});

test('toScreenerRow: a "missing" enrichment adds nothing but is still dated', () => {
  const r = toScreenerRow(row(), enrich({ missing: true, winRate: 0.9 }), [], NOW);
  assert.equal(r.winRate, null);
  assert.equal(r.enrichedAt, NOW - H);
});

test('enrichmentFromProfile: positions, max leverage, tags', () => {
  const p: TraderProfile = {
    summary: { ...row(), winRate: 0.55, trades: 120, lastActive: NOW - H, maxDrawdown: 0.2, tags: ['swing'] },
    positions: [
      { symbol: 'BTC', side: 'long', size: 1, notional: 100_000, entryPx: null, markPx: null, liqPx: null, uPnl: null, leverage: 10 },
      { symbol: 'ETH', side: 'short', size: 1, notional: 50_000, entryPx: null, markPx: null, liqPx: null, uPnl: null, leverage: 30 },
    ],
    equity: {},
    updatedAt: NOW,
    source: 'test',
  };
  const e = enrichmentFromProfile(p, NOW);
  assert.equal(e.positions, 2);
  assert.equal(e.maxLeverage, 30);
  assert.equal(e.openNotional, 150_000);
  assert.equal(e.winRate, 0.55);
  assert.deepEqual(e.tags, ['swing']);
  const none = enrichmentFromProfile(null, NOW);
  assert.equal(none.missing, true);
  assert.equal(none.positions, null);
});

/* ------------------------------------------------------------------------ */
/* query parsing                                                             */
/* ------------------------------------------------------------------------ */

test('parseScreenerQuery: defaults', () => {
  const q = Q();
  assert.equal(q.view, 'traders');
  assert.equal(q.preset, 'all');
  assert.equal(q.sort, 'pnl');
  assert.equal(q.window, '30d');
  assert.equal(q.volWindow, '1d');
  assert.equal(q.dir, 'desc');
  assert.equal(q.limit, 100);
  assert.equal(q.offset, 0);
  assert.equal(q.minWinRate, null);
  assert.deepEqual(q.strategies, []);
});

test('parseScreenerQuery: percents, lists, presets and bad input', () => {
  const q = Q({ minWinRate: '60', minRoi: '-5', strategy: 'whale,bogus,scalper', active: '24h', q: '  0xABC ' });
  assert.equal(q.minWinRate, 0.6);
  assert.equal(q.minRoi, -0.05);
  assert.deepEqual(q.strategies, ['whale', 'scalper']);
  assert.equal(q.active, '24h');
  assert.equal(q.q, '0xabc');
  // Preset supplies sort and window unless the query does.
  assert.equal(Q({ preset: 'rising' }).window, '7d');
  assert.equal(Q({ preset: 'rising', window: '30d' }).window, '30d');
  assert.equal(Q({ preset: 'high-winrate' }).sort, 'winRate');
  assert.equal(Q({ preset: 'high-winrate', sort: 'volume' }).sort, 'volume');
  // Garbage falls back, never throws.
  const bad = Q({ preset: 'x', sort: 'y', window: 'z', minWinRate: 'abc', limit: '99999', offset: '-4', active: '2h', minVolume: 'any' });
  assert.equal(bad.preset, 'all');
  assert.equal(bad.sort, 'pnl');
  assert.equal(bad.window, '30d');
  assert.equal(bad.minWinRate, null);
  assert.equal(bad.limit, 500);
  assert.equal(bad.offset, 0);
  assert.equal(bad.active, null);
  assert.equal(bad.minVolume, null);
  assert.equal(Q({ minWinRate: '150' }).minWinRate, 1);
  assert.equal(Q({ view: 'assets' }).view, 'assets');
});

/* ------------------------------------------------------------------------ */
/* filters                                                                   */
/* ------------------------------------------------------------------------ */

test('matchesText: address prefix with or without 0x and account id; never a name', () => {
  const r = { address: '0xabcdef0000000000000000000000000000000000', label: 'Big Fish', accountId: 1225 };
  assert.equal(matchesText(r, '0xabcd'), true);
  assert.equal(matchesText(r, 'abcd'), true);
  assert.equal(matchesText(r, 'bcd'), false);
  assert.equal(matchesText(r, 'fish'), false, 'no username is searched (valuescan/labels.ts)');
  assert.equal(matchesText(r, '1225'), true);
  assert.equal(matchesText(r, '122'), false);
  assert.equal(matchesText(r, ''), true);
});

test('passes: every filter, and unknown values are excluded', () => {
  const known = srow({ accountValue: 500_000, volume: { '1d': 2e6, '30d': 1e7 }, roi: { '30d': 0.2 } }, enrich({ winRate: 0.65, trades: 40 }));
  const unknown = srow({ accountValue: null, volume: {}, roi: {} });

  assert.equal(passes(known, Q({ minWinRate: '60' }), NOW), true);
  assert.equal(passes(known, Q({ minWinRate: '70' }), NOW), false);
  assert.equal(passes(unknown, Q({ minWinRate: '0' }), NOW), false);

  assert.equal(passes(known, Q({ minVolume: '1000000' }), NOW), true);
  assert.equal(passes(known, Q({ minVolume: '1000000', volWindow: '7d' }), NOW), false);
  assert.equal(passes(unknown, Q({ minVolume: '0' }), NOW), false);

  assert.equal(passes(known, Q({ minAccountValue: '100000' }), NOW), true);
  assert.equal(passes(known, Q({ minAccountValue: '1000000' }), NOW), false);
  assert.equal(passes(unknown, Q({ minAccountValue: '0' }), NOW), false);

  assert.equal(passes(known, Q({ minRoi: '10' }), NOW), true);
  assert.equal(passes(known, Q({ minRoi: '25' }), NOW), false);
  assert.equal(passes(unknown, Q({ minRoi: '-100' }), NOW), false);

  // 1e7 / 5e5 = 20x turnover -> swing.
  assert.equal(known.strategy, 'swing');
  assert.equal(passes(known, Q({ strategy: 'swing' }), NOW), true);
  assert.equal(passes(known, Q({ strategy: 'scalper,swing' }), NOW), true);
  assert.equal(passes(known, Q({ strategy: 'scalper' }), NOW), false);
  const whale = srow({ accountValue: 3e6 });
  assert.equal(passes(whale, Q({ strategy: 'whale' }), NOW), true);

  assert.equal(passes(known, Q({ active: '24h' }), NOW), true);
  assert.equal(passes(known, Q({ active: '1h' }), NOW), false);
  assert.equal(passes(unknown, Q({ active: '30d' }), NOW), false);

  assert.equal(passes(known, Q({ q: A1.slice(0, 8) }), NOW), true);
  assert.equal(passes(known, Q({ q: A2.slice(0, 8) }), NOW), false);
});

/* ------------------------------------------------------------------------ */
/* presets                                                                   */
/* ------------------------------------------------------------------------ */

test('preset consistent: profitable over 7D, 30D and all time', () => {
  assert.equal(PRESETS.consistent.test(srow({ pnl: { '7d': 1, '30d': 1, all: 1 } })), true);
  assert.equal(PRESETS.consistent.test(srow({ pnl: { '7d': -1, '30d': 1, all: 1 } })), false);
  assert.equal(PRESETS.consistent.test(srow({ pnl: { '30d': 1, all: 1 } })), false);
});

test('preset high-winrate: >= 60% on enough trades; unknown trade count is allowed, unknown win rate is not', () => {
  assert.equal(PRESETS['high-winrate'].test(srow({}, enrich({ winRate: 0.6, trades: HIGH_WINRATE_MIN_TRADES }))), true);
  assert.equal(PRESETS['high-winrate'].test(srow({}, enrich({ winRate: 0.9, trades: 3 }))), false);
  assert.equal(PRESETS['high-winrate'].test(srow({}, enrich({ winRate: 0.7, trades: null }))), true);
  assert.equal(PRESETS['high-winrate'].test(srow({}, enrich({ winRate: 0.59, trades: 100 }))), false);
  assert.equal(PRESETS['high-winrate'].test(srow()), false);
});

test('preset whales, low-drawdown, rising, most-active', () => {
  assert.equal(PRESETS.whales.test(srow({ accountValue: 1e6 })), true);
  assert.equal(PRESETS.whales.test(srow({ accountValue: 999_999 })), false);
  assert.equal(PRESETS.whales.test(srow({ accountValue: 10, tags: ['whale'] })), true);

  assert.equal(PRESETS['low-drawdown'].test(srow({ pnl: { '30d': 5 } }, enrich({ maxDrawdown: 0.1 }))), true);
  assert.equal(PRESETS['low-drawdown'].test(srow({ pnl: { '30d': 5 } }, enrich({ maxDrawdown: 0.3 }))), false);
  assert.equal(PRESETS['low-drawdown'].test(srow({ pnl: { '30d': -5 } }, enrich({ maxDrawdown: 0.05 }))), false);
  assert.equal(PRESETS['low-drawdown'].test(srow({ pnl: { '30d': 5 } })), false);

  assert.equal(PRESETS.rising.test(srow({ pnl: { '7d': 6_000, all: 10_000 } })), true);
  assert.equal(PRESETS.rising.test(srow({ pnl: { '7d': 4_000, all: 10_000 } })), false);
  assert.equal(PRESETS.rising.test(srow({ pnl: { '7d': 500, all: 600 } })), false); // under the $1k floor
  assert.equal(PRESETS.rising.test(srow({ pnl: { '7d': 5e6, all: -500 } })), false);

  assert.equal(PRESETS['most-active'].test(srow({ volume: { '1d': 1 } })), true);
  assert.equal(PRESETS['most-active'].test(srow({ volume: { '7d': 1 } })), true);
  assert.equal(PRESETS['most-active'].test(srow({ volume: { '30d': 1 } })), false);
});

/* ------------------------------------------------------------------------ */
/* sort + screen                                                             */
/* ------------------------------------------------------------------------ */

test('sortRows: unknowns last in both directions, ties by address', () => {
  const a = srow({ address: A1 }, enrich({ winRate: 0.5 }));
  const b = srow({ address: A2 }, enrich({ winRate: 0.8 }));
  const c = srow({ address: A3 });
  const desc = sortRows([c, a, b], { ...Q(), sort: 'winRate' }, NOW).map((r) => r.address);
  assert.deepEqual(desc, [A2, A1, A3]);
  const asc = sortRows([c, a, b], { ...Q(), sort: 'winRate', dir: 'asc' }, NOW).map((r) => r.address);
  assert.deepEqual(asc, [A1, A2, A3]);
});

test('sortRows: ROI on under-capitalised accounts ranks as unknown', () => {
  // +4,000,000% on $100 of capital (PnL / ROI), funded to $4M afterwards.
  const tiny = srow({ address: A1, accountValue: 4e6, pnl: { '30d': 4_000 }, roi: { '30d': 40_000 } });
  const real = srow({ address: A2, accountValue: 1e6, pnl: { '30d': 200_000 }, roi: { '30d': 0.25 } });
  const out = sortRows([tiny, real], { ...Q(), sort: 'roi' }, NOW).map((r) => r.address);
  assert.deepEqual(out, [A2, A1]);
});

test('sortRows: last active mixes exact fills and volume buckets correctly', () => {
  const exact2d = srow({ address: A1, volume: {}, lastActive: NOW - 2 * D });
  const today = srow({ address: A2, volume: { '1d': 5 } });
  const never = srow({ address: A3, volume: {} });
  const out = sortRows([exact2d, never, today], { ...Q(), sort: 'lastActive' }, NOW).map((r) => r.address);
  assert.deepEqual(out, [A2, A1, A3]);
});

test('screen: filters, sorts, pages and counts', () => {
  const rows = Array.from({ length: 30 }, (_, i) =>
    srow({ address: `0x${String(i).padStart(40, '0')}`, pnl: { '30d': i * 100 } }));
  const page = screen(rows, { ...Q({ limit: '10', offset: '5' }) }, NOW);
  assert.equal(page.total, 30);
  assert.equal(page.rows.length, 10);
  assert.equal(page.rows[0]!.pnl['30d'], 2400);
});

/* ------------------------------------------------------------------------ */
/* pool                                                                      */
/* ------------------------------------------------------------------------ */

function provider(venue: Venue, fn: (q: LeaderboardQuery) => TraderRow[] | Error): VenueProvider {
  return {
    venue,
    async leaderboard(q) {
      const out = fn(q);
      if (out instanceof Error) throw out;
      return { rows: out, total: out.length, updatedAt: NOW - 5 * 60_000, source: 'stub' };
    },
    trader: async () => null,
    fills: async () => [],
    whales: async () => [],
    positioning: async () => [],
  };
}

test('harvestPool: merges one trader seen in several slices, window by window', async () => {
  const p = provider('sodex', (q) => {
    if (q.sort === 'pnl' && q.window === '30d') return [row({ venue: 'sodex', address: A1, pnl: { '30d': 10 } })];
    if (q.sort === 'volume' && q.window === '1d') return [row({ venue: 'sodex', address: A1.toUpperCase().replace('0X', '0x'), volume: { '1d': 99 } })];
    if (q.sort === 'accountValue') return new Error('slow host');
    return [row({ venue: 'sodex', address: A2 })];
  });
  const pool = await harvestPool(p, undefined, () => NOW);
  const a1 = pool.rows.find((r) => r.address === A1)!;
  assert.equal(a1.pnl['30d'], 10);
  assert.equal(a1.volume['1d'], 99);
  assert.equal(pool.rows.length, 2);
  assert.equal(pool.slices.ok, pool.slices.asked - 1);
  assert.equal(pool.updatedAt, NOW - 5 * 60_000);
});

test('harvestPool: NotAvailable on the first slice stops asking; all failing throws', async () => {
  let asked = 0;
  const na = provider('hyperliquid', () => {
    asked++;
    return new NotAvailable('not built');
  });
  await assert.rejects(harvestPool(na, undefined, () => NOW), NotAvailable);
  assert.equal(asked, 1);
  const down = provider('hyperliquid', () => new Error('down'));
  await assert.rejects(harvestPool(down, undefined, () => NOW), /down/);
});

test('PoolCache: fresh, then stale-while-refresh, then a failure is remembered briefly', async () => {
  let t = NOW;
  let builds = 0;
  let fail = false;
  const cache = new PoolCache(async (p) => {
    builds++;
    if (fail) throw new Error('boom');
    return { venue: p.venue, rows: [row()], updatedAt: t, builtAt: t, slices: { ok: 1, asked: 1 } } satisfies VenuePool;
  }, () => t);
  const p = provider('hyperliquid', () => []);
  const first = await cache.get(p);
  assert.equal(builds, 1);
  t += POOL_TTL_MS - 1;
  assert.equal(await cache.get(p), first);
  assert.equal(builds, 1);
  t += 2;
  assert.equal(await cache.get(p), first); // stale served at once
  await new Promise((r) => setImmediate(r));
  assert.equal(builds, 2); // ...while one rebuild ran
  // Past the stale window with the upstream down: throws, then does not re-ask for a while.
  fail = true;
  t += POOL_STALE_MAX_MS + 1;
  await assert.rejects(cache.get(p), /boom/);
  const before = builds;
  await assert.rejects(cache.get(p), /boom/);
  assert.equal(builds, before);
});

/* ------------------------------------------------------------------------ */
/* enricher                                                                  */
/* ------------------------------------------------------------------------ */

function makeEnricher(o: {
  fetch?: (a: string) => Promise<TraderProfile | null>;
  gate?: () => boolean;
  clock: { t: number };
}) {
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  const calls: string[] = [];
  const e = new Enricher({
    venue: 'hyperliquid',
    fetchProfile: async (a) => {
      calls.push(a);
      return o.fetch ? o.fetch(a) : null;
    },
    intervalMs: 10_000,
    ttlMs: 60_000,
    maxAgeMs: 10 * 60_000,
    maxTargets: 2,
    idleStopMs: 5 * 60_000,
    pauseMs: 120_000,
    retryBaseMs: 30_000,
    gate: o.gate,
    now: () => o.clock.t,
    schedule: (fn, ms) => {
      const job = { fn, ms };
      scheduled.push(job);
      return () => {
        const i = scheduled.indexOf(job);
        if (i >= 0) scheduled.splice(i, 1);
      };
    },
  });
  return { e, calls, scheduled };
}

test('Enricher: demand never fetches inline; ticks walk never-read targets first, capped by maxTargets', async () => {
  const clock = { t: NOW };
  const { e, calls, scheduled } = makeEnricher({ clock });
  e.demand([A1, A2, A3]);
  assert.equal(calls.length, 0);
  assert.equal(scheduled.length, 1);
  await e.tick();
  await e.tick();
  await e.tick();
  assert.deepEqual(calls, [A1, A2]); // A3 is past maxTargets
  assert.equal(e.nextTarget(), null); // all fresh
  assert.ok(e.get(A1)?.missing);
  // After the TTL, the stalest comes back first.
  clock.t += 61_000;
  assert.equal(e.nextTarget(), A1);
});

test('Enricher: a closed gate skips the turn; a failure backs off; a rate limit pauses the venue', async () => {
  const clock = { t: NOW };
  let open = false;
  let mode: 'fail' | 'limit' | 'ok' = 'fail';
  const { e, calls } = makeEnricher({
    clock,
    gate: () => open,
    fetch: async () => {
      if (mode === 'fail') throw new Error('upstream 500');
      if (mode === 'limit') throw Object.assign(new Error('Too Many Requests'), { status: 429 });
      return null;
    },
  });
  e.demand([A1, A2]);
  await e.tick();
  assert.equal(calls.length, 0);
  open = true;
  await e.tick();
  assert.deepEqual(calls, [A1]); // failed
  assert.equal(e.nextTarget(), A2); // A1 is backing off
  mode = 'limit';
  await e.tick();
  assert.deepEqual(calls, [A1, A2]);
  await e.tick(); // paused
  assert.equal(calls.length, 2);
  clock.t += 120_001;
  mode = 'ok';
  await e.tick(); // A1's back-off (30s) and the pause are both over
  assert.equal(calls.length, 3);
});

test('Enricher: stops when idle and restarts on the next demand', async () => {
  const clock = { t: NOW };
  const { e, calls, scheduled } = makeEnricher({ clock });
  e.demand([A1]);
  const job = scheduled.shift()!;
  clock.t += 5 * 60_000 + 1;
  job.fn(); // the timer fires with nobody asking any more
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 0);
  assert.equal(scheduled.length, 0); // not re-armed
  assert.equal(e.running, false);
  e.demand([A1]);
  assert.equal(scheduled.length, 1);
});

test('isRateLimited', () => {
  assert.equal(isRateLimited({ status: 429 }), true);
  assert.equal(isRateLimited(new Error('error code: 1015')), true);
  assert.equal(isRateLimited(Object.assign(new Error('x'), { name: 'RateLimitedError' })), true);
  assert.equal(isRateLimited(new Error('HTTP 500')), false);
  assert.equal(isRateLimited(null), false);
});

/* ------------------------------------------------------------------------ */
/* glue                                                                      */
/* ------------------------------------------------------------------------ */

test('enrichTargets: round-robin over PnL, account value, 24h volume, 7D PnL', () => {
  const rows = [
    row({ address: A1, pnl: { '30d': 100, '7d': 1 }, accountValue: 1, volume: { '1d': 1 } }),
    row({ address: A2, pnl: { '30d': 1, '7d': 1 }, accountValue: 100, volume: { '1d': 1 } }),
    row({ address: A3, pnl: { '30d': 2, '7d': 100 }, accountValue: 2, volume: { '1d': 100 } }),
  ];
  assert.deepEqual(enrichTargets(rows, 3), [A1, A2, A3]);
  assert.deepEqual(enrichTargets(rows, 2), [A1, A2]);
});

test('assemble: cross-venue presence and enriched count', () => {
  const pools: VenuePool[] = [
    { venue: 'sodex', rows: [row({ venue: 'sodex', address: A1 }), row({ venue: 'sodex', address: A2 })], updatedAt: NOW, builtAt: NOW, slices: { ok: 1, asked: 1 } },
    { venue: 'hyperliquid', rows: [row({ address: A1 })], updatedAt: NOW, builtAt: NOW, slices: { ok: 1, asked: 1 } },
  ];
  const { rows, enrichedCount } = assemble(
    pools,
    (v, a) => (v === 'sodex' && a === A1 ? enrich({ winRate: 0.5 }) : a === A2 ? enrich({ missing: true }) : undefined),
    NOW,
  );
  assert.equal(rows.length, 3);
  assert.equal(enrichedCount, 1);
  assert.deepEqual(rows.find((r) => r.venue === 'sodex' && r.address === A1)!.alsoOn, ['hyperliquid']);
  assert.deepEqual(rows.find((r) => r.address === A2)!.alsoOn, []);
});

/* ------------------------------------------------------------------------ */
/* assets                                                                    */
/* ------------------------------------------------------------------------ */

test('mapAssetCtxs: price, change, OI in USD, dex prefix, delisted dropped', () => {
  const raw = [
    { universe: [{ name: 'BTC', maxLeverage: 40 }, { name: 'OLD', isDelisted: true }, { name: 'GOLD', maxLeverage: 25 }] },
    [
      { markPx: '110000', prevDayPx: '100000', dayNtlVlm: '5000000000', openInterest: '20000', funding: '0.0000125' },
      { markPx: '1' },
      { midPx: '3900.5', prevDayPx: '0', dayNtlVlm: 'x' },
    ],
  ];
  const out = mapAssetCtxs(raw, '');
  assert.equal(out.length, 2);
  assert.equal(out[0]!.symbol, 'BTC');
  assert.equal(out[0]!.changePct, 10);
  assert.equal(out[0]!.openInterestUsd, 20000 * 110000);
  assert.equal(out[0]!.maxLeverage, 40);
  assert.equal(out[1]!.price, 3900.5);
  assert.equal(out[1]!.changePct, null);
  assert.equal(out[1]!.volume24h, null);
  assert.equal(mapAssetCtxs(raw, 'xyz')[1]!.symbol, 'xyz:GOLD');
  assert.equal(mapAssetCtxs([{ universe: [{ name: 'xyz:TSLA' }] }, [{}]], 'xyz')[0]!.symbol, 'xyz:TSLA');
  assert.deepEqual(mapAssetCtxs(null, ''), []);
});

/**
 * Run: npx tsx --test test/winrate.test.ts   (from apps/server)
 *
 * The shared win rate (valuedesk/winRate.ts), the index's coverage freshness
 * across stream restarts, the cohorts' sampling rule, SoDEX analytics that
 * cannot be used, and the label rule.
 */
process.env.VALUESCAN_INDEX_STREAMS = '0';
process.env.VALUESCAN_INDEX_COHORTS = '0';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WIN_RATE_MIN_CLOSES, closeRuns, winRateOf } from '../src/valuedesk/winRate.js';
import { CLOSES_DEF, IndexStore, type FillRow } from '../src/indexer/store.js';
import { spanCovers } from '../src/indexer/boards.js';
import { Lane, isTransient } from '../src/indexer/lanes.js';
import { LighterStream, lighterPrint, type Print } from '../src/indexer/streams.js';
import { aggregate, netWallet, sampleRule, sampledVenue, sampleHash, type WalletVenue } from '../src/valuedesk/cohorts/model.js';
import { chartSuspect, rebaseWindow, closedStats, type PortfolioChart } from '../src/valuedesk/sodex/mappers.js';
import { labelMatches, shownLabel } from '../src/valuedesk/labels.js';
import { matchesText, toScreenerRow } from '../src/valuedesk/screener/model.js';
import type { TraderRow } from '../src/valuedesk/types.js';

const DAY = 86_400_000;
const T0 = 20_000 * DAY;

// --- the definition ------------------------------------------------------------------------

test('winRateOf: exact from one close; an estimate only from WIN_RATE_MIN_CLOSES', () => {
  assert.deepEqual(winRateOf(1, 2, true), { winRate: 0.5, winRateExact: true, winRateCloses: 2 });
  assert.deepEqual(winRateOf(3, WIN_RATE_MIN_CLOSES - 1, false), { winRate: null, winRateExact: false, winRateCloses: WIN_RATE_MIN_CLOSES - 1 });
  assert.equal(winRateOf(4, WIN_RATE_MIN_CLOSES, false).winRate, 4 / WIN_RATE_MIN_CLOSES);
  assert.equal(winRateOf(0, 0, true).winRate, null, 'no close, no figure');
  assert.equal(winRateOf(null, null, false).winRateCloses, null, 'nothing held');
  assert.equal(winRateOf(99, 10, true).winRate, 1, 'wins never exceed closes');
});

test('closeRuns: one close per run of reducing fills in a market and direction', () => {
  const f = (symbol: string, t: number, side: number, closedPnl: number | null) => ({ symbol, t, side, closedPnl });
  // A position closed in five slices (a TWAP): one close, a loss.
  const twap = closeRuns([1, 2, 3, 4, 5].map((i) => f('ZEC', i, 1, -100)));
  assert.deepEqual([twap.closes, twap.wins], [1, 0]);
  // Take profit, add (an opening fill), take profit again: two closes.
  const two = closeRuns([f('BTC', 1, -1, 5), f('BTC', 2, 1, 0), f('BTC', 3, -1, 7)]);
  assert.deepEqual([two.closes, two.wins], [2, 2]);
  // Reducing in the other direction ends the run; markets never mix; order does not matter.
  const mixed = closeRuns([f('ETH', 3, 1, -4), f('BTC', 2, -1, 3), f('ETH', 1, -1, 2)]);
  assert.deepEqual([mixed.closes, mixed.wins], [3, 2]);
  // A run whose partial results net to zero is break-even: not in the denominator.
  const even = closeRuns([f('SOL', 1, -1, 5), f('SOL', 2, -1, -5)]);
  assert.deepEqual([even.closes, even.wins], [0, 0]);
  // Fills of unknown result (stream prints) are skipped.
  assert.equal(closeRuns([f('BTC', 1, -1, null)]).closes, 0);
});

test('closedStats (SoDEX): one closed position = one close; exact only below the sample limit', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ realizedPnL: i < 9 ? '1' : '-1', createdAt: i, updatedAt: 100 + i }));
  const all = closedStats(rows);
  assert.deepEqual([all.closes, all.wins, all.winRateExact, all.winRate], [12, 9, true, 0.75]);
  const capped = closedStats(rows.slice(0, 5), 5);
  assert.equal(capped.winRateExact, false);
  assert.equal(capped.winRate, null, 'five closes of a capped sample is too few for an estimate');
  assert.equal(capped.firstClosedAt, 100);
});

// --- the store: closes by the definition, per day ---------------------------------------------

const fill = (o: Partial<FillRow> & { id: string; t: number }): FillRow => ({
  venue: 'arcus', address: '0xa', symbol: 'BTC', side: -1, px: 10, sz: 1, fee: null, closedPnl: null, oid: null, src: 1, ...o,
});

function built(s: IndexStore, venue: FillRow['venue'] = 'arcus', a = '0xa'): void {
  s.windowStats(venue, a, 0);
  while (s.buildAggregates(1_000) > 0) { /* build */ }
}

test('store: window closes are runs, the same from the aggregates and from a scan', () => {
  const s = new IndexStore(':memory:', { aggRefreshMs: 0 });
  // Day 0: a sliced close (3 fills, one run, +6); day 1: two separate closes (+2, -1).
  s.putFills([
    fill({ id: 'a1', t: T0 + 10, closedPnl: 2, oid: 'o1' }),
    fill({ id: 'a2', t: T0 + 20, closedPnl: 2, oid: 'o2' }),
    fill({ id: 'a3', t: T0 + 30, closedPnl: 2, oid: 'o3' }),
    fill({ id: 'b1', t: T0 + DAY + 10, closedPnl: 2, oid: 'o4' }),
    fill({ id: 'b2', t: T0 + DAY + 20, side: 1, closedPnl: 0, oid: 'o5' }),
    fill({ id: 'b3', t: T0 + DAY + 30, closedPnl: -1, oid: 'o6' }),
  ]);
  built(s);
  const st = s.windowStats('arcus', '0xa', 0);
  assert.deepEqual([st.closes, st.wins], [3, 2]);
  const scan = (s as unknown as { windowStatsScan: (v: string, a: string, f: number) => { closes: number; wins: number } }).windowStatsScan('arcus', '0xa', 0);
  assert.deepEqual([scan.closes, scan.wins], [3, 2]);
  s.close();
});

test('store: aggregates from the older definition keep serving until their re-sum lands', () => {
  const s = new IndexStore(':memory:', { aggRefreshMs: 0 });
  s.putFills([1, 2, 3].map((i) => fill({ id: `f${i}`, t: T0 + i, closedPnl: -1, oid: `o${i}` })));
  built(s);
  // Pretend these day rows were summed per order (three closes) before the migration.
  s.db.exec("UPDATE fill_day SET closes = 3, wins = 0; UPDATE fill_agg SET built_at = 1; DELETE FROM meta WHERE key LIKE 'closes_def%'");
  assert.equal(s.migrateCloses(), 1);
  assert.equal(s.windowStats('arcus', '0xa', 0).closes, 3, 'the old figure stands while the re-sum runs');
  while (s.buildAggregates(1_000) > 0) { /* re-sum */ }
  assert.equal(s.windowStats('arcus', '0xa', 0).closes, 1, 'one run');
  assert.equal(s.getMeta('closes_def'), CLOSES_DEF);
  assert.equal(s.migrateCloses(), 0, 'done once');
  s.close();
});

// --- coverage across stream restarts ---------------------------------------------------------

test('coverage: the stream moves held ranges up only within one connection; a gap waits for a catch-up read', () => {
  const s = new IndexStore(':memory:');
  const now = T0 + 10 * 3_600_000;
  // Read at T0 by REST; the socket has been up since before that.
  s.addCoverage('arcus', '0xa', 'fills', { fromT: T0 - 30 * DAY, toT: T0 }, T0);
  s.addCoverage('arcus', '0xb', 'fills', { fromT: T0 - 30 * DAY, toT: T0 }, T0);
  assert.equal(s.advanceCoverage('arcus', ['fills'], T0 - 1_000, now), 2);
  const a = s.coverage('arcus', '0xa', 'fills')!;
  assert.equal(a.toT, now, 'moved up with the stream');
  assert.equal(a.restAt, T0, 'the last REST read is unchanged (closes and realised PnL come from it)');
  // A restart: the new socket came up after the held range ends.
  const later = now + 3 * 3_600_000;
  assert.equal(s.advanceCoverage('arcus', ['fills'], now + 60_000, later), 0, 'the downtime is not claimed');
  const cov = s.coverage('arcus', '0xa', 'fills')!;
  const opts = (socket: number | null) => ({ staleMs: 10 * 60_000, streamSince: socket });
  assert.equal(spanCovers(cov, T0 - 30 * DAY, later, opts(now + 60_000)), false, 'the gap makes it stale');
  assert.equal(spanCovers(cov, T0 - 30 * DAY, now + 5 * 60_000, opts(now + 60_000)), true, 'fresh for a few minutes after the restart');
  // The catch-up read covers only the gap, and merges with what was held.
  const merged = s.addCoverage('arcus', '0xa', 'fills', { fromT: now, toT: later }, later);
  assert.deepEqual([merged.fromT, merged.toT], [T0 - 30 * DAY, later]);
  assert.equal(spanCovers(merged, T0 - 30 * DAY, later + 60_000, opts(now + 60_000)), true);
  assert.deepEqual(s.staleCoverage('arcus', 'fills', later, 10).map((r) => r.address), ['0xb']);
  s.close();
});

test('coverage: a venue whose prints name sub-accounts moves only wallets whose indices are known', () => {
  const s = new IndexStore(':memory:');
  s.addCoverage('lighter', '0xa', 'fills', { fromT: 0, toT: T0, exhausted: true }, T0);
  s.addCoverage('lighter', '0xb', 'fills', { fromT: 0, toT: T0, exhausted: true }, T0);
  s.putExtIndex('lighter', [{ idx: '77', address: '0xa' }]);
  assert.equal(s.advanceCoverage('lighter', ['fills'], T0 - 1, T0 + 1_000, true), 1);
  assert.equal(s.coverage('lighter', '0xb', 'fills')!.toT, T0);
  assert.deepEqual([...s.extIndex('lighter')], [['77', '0xa']]);
  s.close();
});

test('coverage: moving the sub-account venue reads its indices once, not once per row (2026-11-13: 9-14 s a turn)', () => {
  const s = new IndexStore(':memory:');
  const N = 1_000;
  const M = 50_000;
  for (let i = 0; i < N; i++) s.addCoverage('lighter', `0x${i}`, 'fills', { fromT: 0, toT: T0, exhausted: true }, T0);
  s.putExtIndex('lighter', Array.from({ length: M }, (_, i) => ({ idx: String(i), address: `0x${i}` })));
  const t = performance.now();
  assert.equal(s.advanceCoverage('lighter', ['fills'], T0 - 1, T0 + 1_000, true), N);
  assert.ok(performance.now() - t < 2_000, 'one pass over the indices, not one per row');
  s.close();
});

// --- board rank snapshots and trader stats -------------------------------------------------------

test('store: rank snapshots answer "where was it a day ago", and trader stats round-trip', () => {
  const s = new IndexStore(':memory:');
  const key = { venue: 'arcus' as const, window: '30d' as const, side: 'top' as const, filter: 'any' as const };
  s.snapshotBoardRanks(key, T0, [{ address: '0xa', rank: 5 }, { address: '0xb', rank: 1 }], 0);
  s.snapshotBoardRanks(key, T0 + 3_600_000, [{ address: '0xa', rank: 2 }], 0);
  const ref = s.boardRanksAt(key, T0 + 30 * 60_000)!;
  assert.equal(ref.t, T0);
  assert.equal(ref.ranks.get('0xa'), 5);
  assert.equal(s.boardRanksFirst(key), T0);
  assert.equal(s.boardRanksAt(key, T0 - 1), null);
  s.snapshotBoardRanks(key, T0 + 2 * 3_600_000, [], T0 + 1);
  assert.equal(s.boardRanksAt(key, T0), null, 'older snapshots are pruned');

  s.putTraderStats([{ venue: 'arcus', window: '30d', address: '0xa', trades: 12, tradesExact: false, wins: 7, closes: 11, winExact: false, winFrom: T0, at: T0 }]);
  const st = s.traderStats('arcus', '30d', ['0xa', '0xz']);
  assert.equal(st.size, 1);
  assert.deepEqual({ ...st.get('0xa')!, venue: undefined }, { venue: undefined, window: '30d', address: '0xa', trades: 12, tradesExact: false, wins: 7, closes: 11, winExact: false, winFrom: T0, at: T0 });
  s.close();
});

test('store: boards carry the win rate provenance and rank change', () => {
  const s = new IndexStore(':memory:');
  s.writeBoard(
    { venue: 'arcus', window: '30d', side: 'top', filter: 'any', updatedAt: 5, sourceAt: 4, complete: true, pending: 0, scanned: 1, note: null, rankSince: 3 },
    [{ rank: 1, venue: 'arcus', address: '0xa', label: null, accountId: null, pnl: 10, volume: 1, trades: 30, tradesCapped: true,
      winRate: 0.6, winExact: false, winCloses: 25, winFrom: 2, rankChange: 4, accountValue: 9, assets: [] }],
  );
  const b = s.readBoard('arcus', '30d', 'top', 'any')!;
  assert.equal(b.meta.rankSince, 3);
  const r = b.rows[0]!;
  assert.deepEqual([r.winRate, r.winExact, r.winCloses, r.winFrom, r.rankChange], [0.6, false, 25, 2, 4]);
  s.close();
});

// --- the engine: a board row under the policy ------------------------------------------------------

test('engine: a board row shows an exact win rate once the window is held, an estimate before', async () => {
  // No lane runs here (nothing may reach a venue from a test); restored at the end.
  const realStart = Lane.prototype.start;
  (Lane.prototype as unknown as { start: () => void }).start = () => {};
  const { Indexer } = await import('../src/indexer/engine.js');
  const s = new IndexStore(':memory:', { aggRefreshMs: 0 });
  const now = T0 + 40 * DAY;
  const ix = new Indexer(s, () => now);
  ix.start();
  const from = now - 30 * DAY;
  s.putPnl('arcus', '30d', [{ address: '0xa', pnl: 500, volume: 1 }, { address: '0xb', pnl: 400, volume: 1 }], now, now);
  // 0xa: 12 closes held from 10 days ago only (an estimate); 0xb: 2 closes, held back past the window start (exact).
  const closes = (a: string, n: number, t0: number) => Array.from({ length: n }, (_, i) => [
    fill({ address: a, id: `${a}o${i}`, t: t0 + i * 1_000, side: 1, closedPnl: 0, oid: `${a}x${i}` }),
    fill({ address: a, id: `${a}c${i}`, t: t0 + i * 1_000 + 500, side: -1, closedPnl: i % 3 ? 1 : -1, oid: `${a}y${i}` }),
  ]).flat();
  s.putFills([...closes('0xa', 12, now - 5 * DAY), ...closes('0xb', 2, now - 5 * DAY)]);
  s.addCoverage('arcus', '0xa', 'fills', { fromT: now - 10 * DAY, toT: now }, now);
  s.addCoverage('arcus', '0xb', 'fills', { fromT: from - DAY, toT: now }, now);
  built(s, 'arcus', '0xa');
  built(s, 'arcus', '0xb');
  // Where the board stood a day ago: 0xb was first.
  s.snapshotBoardRanks({ venue: 'arcus', window: '30d', side: 'top', filter: 'any' }, now - DAY - 1_000, [{ address: '0xb', rank: 1 }], 0);
  const built_ = new Map();
  await (ix as unknown as { buildBoard: (...a: unknown[]) => Promise<string[]> }).buildBoard('arcus', '30d', 'top', 'any', null, now, built_);
  ix.stop();
  const b = s.readBoard('arcus', '30d', 'top', 'any')!;
  const [a, bb] = b.rows;
  assert.equal(a!.address, '0xa');
  assert.equal(a!.winExact, false);
  assert.equal(a!.winCloses, 12);
  assert.equal(a!.winRate, 8 / 12, 'an estimate from 12 held closes');
  assert.equal(a!.winFrom, now - 10 * DAY);
  assert.equal(bb!.winExact, true);
  assert.equal(bb!.winRate, 0.5, 'exact from two closes');
  assert.equal(bb!.rankChange, -1, 'first a day ago, second now');
  assert.equal(a!.rankChange, null, 'not on the board a day ago');
  assert.equal(b.meta.rankSince, now - DAY - 1_000);
  assert.equal(s.boardRanksAt({ venue: 'arcus', window: '30d', side: 'top', filter: 'any' }, now)?.t, now, 'a snapshot is stamped when it was taken');
  const st = s.traderStats('arcus', '30d', ['0xa']).get('0xa');
  assert.equal(st?.closes, 12, 'every surface reads the same figures');
  s.close();
  Lane.prototype.start = realStart;
});

// --- cohorts: the sampled tail --------------------------------------------------------------------

test('sampling: a tail wallet counts only in the sample; a cohort never counts more wallets than it has', () => {
  const rate = 0.1;
  // Find tail addresses in and out of the sample.
  const inS: string[] = [];
  const outS: string[] = [];
  for (let i = 0; inS.length < 3 || outS.length < 30; i++) {
    const a = `0x${i.toString(16).padStart(40, '0')}`;
    (sampleHash(a) < rate ? inS : outS).push(a);
  }
  assert.deepEqual(sampleRule(rate, inS[0]!, 500), { counts: true, weight: 10 });
  assert.deepEqual(sampleRule(rate, outS[0]!, 500), { counts: false, weight: 1 });
  assert.deepEqual(sampleRule(rate, outS[0]!, 50_000), { counts: true, weight: 1 }, 'above the tail: itself');
  assert.deepEqual(sampleRule(1, outS[0]!, 5), { counts: true, weight: 1 }, 'an unsampled venue');
  const book = { equity: 500, at: 1, positions: [{ symbol: 'BTC', szi: 1, entry: 100 }] };
  // An out-of-sample tail wallet that WAS read (it was large then) contributes no positions.
  assert.equal(sampledVenue(rate, outS[0]!, { pnl: 2e6, equity: 500, label: null }, book).positions, null);
  assert.ok(sampledVenue(rate, inS[0]!, { pnl: 2e6, equity: 500, label: null }, book).positions);
  // The Lighter case: 1 sampled + 29 unsampled tail wallets read, all in one PnL cohort.
  const mark = () => 100;
  const wallets = [inS[0]!, ...outS.slice(0, 29)].map((a) => netWallet(a, new Map([['lighter', sampledVenue(rate, a, { pnl: 2e6, equity: 500, label: null }, book) as WalletVenue]]), mark));
  const ep = aggregate(wallets).find((c) => c.id === 'extremely-profitable')!;
  assert.equal(ep.wallets, 10, 'the one sampled wallet stands for ten; the other 29 do not count again');
  assert.equal(ep.long, 1_000, 'its position too');
  // A small cohort where the sample overshoots: capped at the wallets it has.
  const tiny = aggregate([wallets[0]!]).find((c) => c.id === 'extremely-profitable')!;
  assert.equal(tiny.wallets, 1);
});

// --- SoDEX analytics that cannot be used ------------------------------------------------------------

const chart = (pts: Array<[number, number, number]>): PortfolioChart => ({
  account_id: 1, window: '1Y', market_type: 'ALL', total_pnl_usd: String(pts.at(-1)?.[2] ?? 0), roi: '0',
  chart: pts.map(([t, av, pnl]) => ({ ts_ms: t, account_value_usd: String(av), pnl_usd: String(pnl), roi: '0' })),
});

test('chartSuspect: a transfer booked as profit, a chart that stopped, and normal accounts', () => {
  // Account 23342's shape: 0, then value == PnL at every point after a $5.07M step.
  const noDeposits = chart([[1, 0, 0], [2, 0, 0], [3, 5_073_540, 5_073_540], [4, 5_000_000, 5_000_000], [5, 4_995_892, 4_995_892]]);
  assert.equal(chartSuspect(noDeposits), 'no-deposits-recorded');
  // A normal account: $100K deposited, PnL on top.
  const normal = chart([[1, 100_000, 0], [2, 104_000, 4_000], [3, 150_000, 50_000], [4, 151_000, 51_000]]);
  assert.equal(chartSuspect(normal), null);
  assert.equal(chartSuspect(normal, 160_000), null, 'live a little above the hourly chart is normal');
  assert.equal(chartSuspect(normal, 17_000_000), 'live-mismatch');
  assert.equal(chartSuspect(normal, 32), null, 'live far below: vault deposits, normal');
  // One big winning trade on a funded account is not suspect.
  const bigWin = chart([[1, 1_000_000, 0], [2, 1_000_000, 0], [3, 1_900_000, 900_000], [4, 1_910_000, 910_000]]);
  assert.equal(chartSuspect(bigWin), null);
  // A balance that appears from nothing as profit, even when a later deposit breaks value == PnL.
  const jump = chart([[1, 0, 0], [2, 2_000_000, 2_000_000], [3, 2_500_000, 2_010_000]]);
  assert.equal(chartSuspect(jump), 'single-jump');
  assert.equal(chartSuspect(null), null);
});

test('rebaseWindow: a window from the 1Y chart, rebased to 0 at its start', () => {
  const year = [{ t: 1, accountValue: 10, pnl: 5 }, { t: 5, accountValue: 12, pnl: 7 }, { t: 9, accountValue: 15, pnl: 10 }];
  assert.deepEqual(rebaseWindow(year, 4)!.map((p) => p.pnl), [2, 5]);
  assert.equal(rebaseWindow(year, 8), null, 'one point is not a curve');
});

// --- the index lanes -------------------------------------------------------------------------------

test('lanes: a struggling upstream is backed off, doubling, and a success resets it', async () => {
  assert.equal(isTransient(new Error('non-JSON response (HTTP 503): Request Timeout')), true);
  assert.equal(isTransient(new Error('The operation was aborted due to timeout')), true);
  assert.equal(isTransient(Object.assign(new Error('bad'), { status: 400 })), false);
  const lane = new Lane({ name: 't', perMin: 1e9, transientBaseMs: 1_000, sleep: () => new Promise((r) => setImmediate(r)) });
  let n = 0;
  lane.add({ key: 'a', prio: 1, run: async () => { n++; throw new Error('HTTP 503'); } });
  const t0 = Date.now();
  lane.start();
  for (let i = 0; i < 40 && lane.backoffUntil === 0; i++) await new Promise((r) => setTimeout(r, 5));
  lane.stop();
  assert.equal(n, 1);
  assert.ok(lane.backoffUntil - t0 >= 900, 'backing off');
});

test('lanes: shares are of the spend, so cheap reserved reads get their share of the budget', async () => {
  const ran: string[] = [];
  const lane = new Lane({ name: 't', perMin: 1e9, shares: [{ prefix: 'coh:', share: 0.5 }], sleep: () => new Promise((r) => setImmediate(r)) });
  // Checks cost 3 each, cohort reads 1: half the SPEND is ~3 cohort reads per check.
  for (let i = 0; i < 40; i++) lane.add({ key: `q:${i}`, prio: 9_000, run: async () => { ran.push('q'); return 3; } });
  for (let i = 0; i < 80; i++) lane.add({ key: `coh:${i}`, prio: 1, run: async () => { ran.push('coh'); return 1; } });
  lane.start();
  for (let i = 0; i < 100 && ran.length < 40; i++) await new Promise((r) => setTimeout(r, 5));
  lane.stop();
  const coh = ran.slice(0, 40).filter((r) => r === 'coh').length;
  assert.ok(coh >= 25, `cohort reads got ${coh} of 40 tasks (by count they would get ~20)`);
});

// --- the Lighter stream --------------------------------------------------------------------------

test('Lighter stream: prints name both sub-accounts; up only once every market is confirmed', async () => {
  const got: Print[] = [];
  const st = new LighterStream((p) => got.push(p), async () => new Map([[0, 'ETH'], [1, 'BTC']]), 'ws://127.0.0.1:9', () => {});
  (st as unknown as { groups: number[][]; confirmed: Array<Set<number>>; readyAt: Array<number | null> }).groups = [[0, 1]];
  (st as unknown as { confirmed: Array<Set<number>> }).confirmed = [new Set()];
  (st as unknown as { readyAt: Array<number | null> }).readyAt = [null];
  (st as unknown as { symbols: Map<number, string> }).symbols = new Map([[0, 'ETH'], [1, 'BTC']]);
  const trade = { trade_id: 9, trade_id_str: '9', market_id: 1, size: '0.5', price: '80000', ask_account_id: 11, bid_account_id: 22, timestamp: 1_000 };
  st.handle(0, { type: 'subscribed/trade', channel: 'trade:0', trades: [] });
  assert.equal((st as unknown as { readyAt: Array<number | null> }).readyAt[0], null, 'one of two markets');
  st.handle(0, { type: 'subscribed/trade', channel: 'trade:1', trades: [trade] });
  assert.ok((st as unknown as { readyAt: Array<number | null> }).readyAt[0]! > 0, 'both confirmed');
  st.handle(0, { type: 'update/trade', channel: 'trade:1', trades: [trade], liquidation_trades: [{ ...trade, trade_id_str: '10' }] });
  assert.deepEqual(got.map((p) => [p.id, p.symbol, p.buyer, p.seller]), [['9', 'BTC', '22', '11'], ['10', 'BTC', '22', '11']], 'deduplicated');
  assert.equal(lighterPrint({ ...trade, market_id: 5 }, () => null), null, 'an unknown market is dropped');
});

// --- labels at the API edge ------------------------------------------------------------------------

test('labels: no name leaves the server, and no search matches one (screener, both providers)', async () => {
  const { matchesQuery: hlMatches } = await import('../src/valuedesk/hyperliquid/leaderboard.js');
  const { matchesQuery: sodexMatches } = await import('../src/valuedesk/sodex/mappers.js');
  const row: TraderRow = { venue: 'hyperliquid', address: '0xabc0000000000000000000000000000000000001', label: 'Loracle', accountValue: null, pnl: {}, roi: {}, volume: {} };
  assert.equal(shownLabel(row.address, 'Loracle'), null);
  assert.equal(toScreenerRow(row, undefined, [], 0).label, null);
  assert.equal(labelMatches(row.address, 'Loracle', 'lora'), false);
  assert.equal(matchesText(row, 'lora'), false, 'the screener search');
  assert.equal(hlMatches(row.address, 'Loracle', 'lora'), false, 'the Hyperliquid leaderboard search');
  assert.equal(sodexMatches(row, 'lora'), false, 'the SoDEX leaderboard search');
  assert.equal(matchesText(row, '0xabc0'), true, 'addresses still match');
  assert.equal(hlMatches(row.address, 'Loracle', 'abc0'), true);
});

test('store: the chunked day scan equals the SQL scan across chunk boundaries and shared timestamps', () => {
  const s = new IndexStore(':memory:', { aggRefreshMs: 0 });
  const rows: FillRow[] = [];
  // 3,500 fills in groups of 7 per timestamp (one block, several makers), two markets, both sides.
  for (let i = 0; i < 3_500; i++) {
    const t = T0 + Math.floor(i / 7) * 1_000;
    rows.push(fill({ venue: 'hyperliquid', id: `x${i}`, t, symbol: i % 2 ? 'BTC' : 'ETH', side: i % 3 ? 1 : -1, px: 1 + (i % 5), sz: 2, closedPnl: i % 11 === 0 ? (i % 2 ? 3 : -2) : 0, oid: `o${i}` }));
  }
  s.putFills(rows);
  built(s, 'hyperliquid', '0xa');
  const scan = (s as unknown as { windowStatsScan: (v: string, a: string, f: number) => unknown }).windowStatsScan;
  for (const from of [0, T0 + 123_456, T0 + 400_000]) {
    assert.deepEqual(s.windowStats('hyperliquid', '0xa', from), scan.call(s, 'hyperliquid', '0xa', from), `from ${from}`);
  }
  s.close();
});

test('cohorts: a restart re-reads only the largest books; a long outage the $100K+ ones', async () => {
  const { gapRereadFloor } = await import('../src/indexer/cohortTracker.js');
  assert.equal(gapRereadFloor(20_000), 1_000_000, 'a restart: seconds of missed prints');
  assert.equal(gapRereadFloor(30 * 60_000), 100_000);
  assert.equal(gapRereadFloor(Number.POSITIVE_INFINITY), 100_000, 'unknown downtime counts as long');
});

test('store: a REST fill with no realised PnL (Lighter sends null on opens) ends a run; a stream print does not', () => {
  const s = new IndexStore(':memory:', { aggRefreshMs: 0 });
  s.putFills([
    fill({ venue: 'lighter', id: 'c1', t: T0 + 10, side: -1, closedPnl: 5, oid: 'a' }),
    fill({ venue: 'lighter', id: 'o1', t: T0 + 20, side: 1, closedPnl: null, oid: 'b' }), // REST open: ends the run
    fill({ venue: 'lighter', id: 'c2', t: T0 + 30, side: -1, closedPnl: -2, oid: 'c' }),
    fill({ venue: 'lighter', id: 'p1', t: T0 + 40, side: 1, closedPnl: null, oid: null, src: 0 }), // stream print: unknown
    fill({ venue: 'lighter', id: 'c3', t: T0 + 50, side: -1, closedPnl: -1, oid: 'd' }),
  ]);
  built(s, 'lighter', '0xa');
  const st = s.windowStats('lighter', '0xa', 0);
  assert.deepEqual([st.closes, st.wins], [2, 1], '+5 | open | -2, -1 (the print does not split it)');
  const scan = (s as unknown as { windowStatsScan: (v: string, a: string, f: number) => { closes: number; wins: number } }).windowStatsScan('lighter', '0xa', 0);
  assert.deepEqual([scan.closes, scan.wins], [2, 1]);
  s.close();
});

test('SoDEX rank lookups: not while the PnL is fresh, and not again soon after "not ranked"', async () => {
  const { lookupDue } = await import('../src/indexer/engine.js');
  const H = 3_600_000;
  assert.equal(lookupDue(null, null, 10 * H, H), true, 'never asked');
  assert.equal(lookupDue(9.5 * H, null, 10 * H, H), false, 'fresh');
  assert.equal(lookupDue(8 * H, null, 10 * H, H), true, 'stale');
  assert.equal(lookupDue(null, 9 * H, 10 * H, H), false, 'unranked an hour ago: not every 10 minutes');
  assert.equal(lookupDue(null, 10 * H - 13 * H, 10 * H, H), true, 'unranked long ago: ask again');
});

test('store: "not ranked" answers persist, and expire', () => {
  const s = new IndexStore(':memory:');
  s.putUnranked('sodex', '1d', '0xa', 1_000);
  s.putUnranked('sodex', '30d', '0xb', 5_000);
  assert.deepEqual([...s.unrankedSince('sodex', 2_000)], [['30d|0xb', 5_000]], 'the old answer is gone');
  assert.deepEqual([...s.unrankedSince('sodex', 0)], [['30d|0xb', 5_000]], 'and was deleted');
  s.close();
});

test('priorities: the leaderboard opening boards and the rows on screen come first', async () => {
  const { rowPrio, VIS_PRIO, WATCH_PRIO } = await import('../src/indexer/engine.js');
  const p30 = rowPrio('30d', 'top', 0, 1);
  assert.ok(p30 >= VIS_PRIO && p30 < WATCH_PRIO);
  assert.ok(rowPrio('30d', 'top', 99, 1) > rowPrio('7d', 'top', 0, 1), '30d before 7d');
  assert.ok(rowPrio('7d', 'top', 99, 1) > rowPrio('1d', 'top', 0, 1), '7d before 1d');
  assert.equal(rowPrio('30d', 'worst', 0, 123), 123, 'other boards keep their own');
  assert.equal(rowPrio('ytd', 'top', 0, 7), 7);
  assert.ok(rowPrio('1d', 'top', 99, 1) > 8_000, 'above every trade check');
});

test('lanes: a higher-priority request raises a queued task, and may bring its own run', async () => {
  const lane = new Lane({ name: 't', perMin: 1e9 });
  const ran: string[] = [];
  lane.add({ key: 'h:a', prio: 10, run: async () => { ran.push('old'); return 0; } });
  lane.add({ key: 'h:a', prio: 5, replace: true, run: async () => { ran.push('lower'); return 0; } });
  assert.equal(lane.prioOf('h:a'), 10, 'a lower request changes nothing');
  lane.add({ key: 'h:a', prio: 50, replace: true, run: async () => { ran.push('new'); return 0; } });
  assert.equal(lane.prioOf('h:a'), 50);
  assert.deepEqual(lane.urgentByKind(20), { h: 1 });
  const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const l2 = lane as unknown as { o: { sleep?: (ms: number) => Promise<void> } };
  l2.o.sleep = () => realSleep(1);
  lane.start();
  for (let i = 0; i < 50 && !ran.length; i++) await realSleep(5);
  lane.stop();
  assert.deepEqual(ran, ['new']);
});

test('engine: a history read first queued by a short board is raised and reaches back for the 30d board', async () => {
  const realStart = Lane.prototype.start;
  (Lane.prototype as unknown as { start: () => void }).start = () => {};
  const { Indexer } = await import('../src/indexer/engine.js');
  const s = new IndexStore(':memory:');
  const now = T0 + 40 * DAY;
  const ix = new Indexer(s, () => now);
  const q = (ix as unknown as { queueHistory: (v: string, a: string, f: number, p: number) => void }).queueHistory.bind(ix);
  const { readPrio } = await import('../src/indexer/engine.js');
  q('hyperliquid', '0xa', now - DAY, 4_100);
  q('hyperliquid', '0xa', now - 30 * DAY, 23_400);
  // Nothing held: the cheap newest page goes first, reaching back comes after (both above the checks).
  assert.equal(ix.hl.prioOf('h:0xa'), readPrio(23_400, 'first'));
  assert.equal(ix.hl.prioOf('b:0xa'), readPrio(23_400, 'back'));
  assert.ok(readPrio(23_400, 'first') > readPrio(21_100, 'catchup') && readPrio(21_100, 'back') > 8_000);
  assert.equal((ix as unknown as { histFrom: Map<string, number> }).histFrom.get('b:0xa'), now - 30 * DAY);
  q('sodex', '0xb', now - DAY, 4_100);
  q('sodex', '0xb', now - 30 * DAY, 23_400);
  assert.equal(ix.sgw.prioOf('h:closes:0xb'), readPrio(23_400, 'first') - 50);
  assert.equal(ix.sgw.prioOf('b:closes:0xb'), readPrio(23_400, 'back') - 50);
  s.close();
  Lane.prototype.start = realStart;
});

test('store: stream rows inside a REST-read range go a slice at a time, the REST rows stay', async () => {
  const s = new IndexStore(':memory:');
  const rows: FillRow[] = [];
  for (let i = 0; i < 4_500; i++) rows.push(fill({ venue: 'hyperliquid', id: `s${i}`, t: T0 + i, src: 0 }));
  rows.push(fill({ venue: 'hyperliquid', id: 'rest', t: T0 + 10, src: 1, closedPnl: 1, oid: 'o' }));
  rows.push(fill({ venue: 'hyperliquid', id: 'later', t: T0 + 9_999, src: 0 }));
  s.putFills(rows);
  let pauses = 0;
  await s.dropStreamRowsAsync('hyperliquid', '0xa', T0, T0 + 5_000, async () => { pauses++; });
  assert.ok(pauses >= 2, 'sliced');
  const left = s.db.prepare("SELECT id FROM fills WHERE venue = 'hyperliquid' ORDER BY id").all() as Array<{ id: string }>;
  assert.deepEqual(left.map((r) => r.id), ['later', 'rest']);
  s.close();
});

test('store: a REST-read range with no stream rows left is read once and nothing is written (2026-11-09: 39 s a minute)', async () => {
  const s = new IndexStore(':memory:');
  const rows: FillRow[] = [];
  for (let i = 0; i < 9_000; i++) rows.push(fill({ venue: 'hyperliquid', id: `r${i}`, t: T0 + i, src: 1, closedPnl: 0, oid: `o${i}` }));
  rows.push(fill({ venue: 'hyperliquid', id: 's-late', t: T0 + 8_999, src: 0 }));
  s.putFills(rows);
  const changes = () => Number((s.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n);
  const before = changes();
  let pauses = 0;
  await s.dropStreamRowsAsync('hyperliquid', '0xa', T0, T0 + 8_998, async () => { pauses++; });
  assert.equal(changes(), before, 'no write: only REST rows in the range');
  // Slices sized by time since 2026-11-23 (store.ts nextDropPage): 250 rows first, doubling while quick, 50 at the least.
  assert.ok(pauses >= 4 && pauses <= 9_000 / 50, `one pass in slices, not the range again per slice (${pauses})`);
  await s.dropStreamRowsAsync('hyperliquid', '0xa', T0, T0 + 9_000, async () => {});
  assert.equal(changes() - before, 1, 'the one stream row in range goes');
  assert.equal(Number((s.db.prepare("SELECT COUNT(*) AS n FROM fills WHERE venue = 'hyperliquid'").get() as { n: number }).n), 9_000);
  s.close();
});

/**
 * Run: npx tsx --test test/retention.test.ts   (from apps/server)
 *
 * Retention of raw fills and closes (indexer/store.ts). Old days live on in
 * their day rows, and no figure the app shows may move when the raw rows go:
 * not for windows inside the retention, not for `ytd`, not for `all`.
 */
process.env.VALUESCAN_INDEX_STREAMS = '0';
process.env.VALUESCAN_INDEX_COHORTS = '0';
// These test the sweep itself, which runs only with the owner's word (src/retention.ts): given here.
process.env.VALUESCAN_PRUNE = 'fills';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { IndexStore, MIN_ROW_T, RETAIN_DAYS_DEFAULT, RETAIN_DAYS_MIN, retainDays, settledDays, type CloseRow, type FillRow } from '../src/indexer/store.js';
import { INDEX_WINDOWS, windowStart } from '../src/indexer/windows.js';
import { winRateOf } from '../src/valuedesk/winRate.js';
import { Lane } from '../src/indexer/lanes.js';
import { fixFillTimes } from '../src/indexer/ext/arcus.js';
import type { Venue } from '../src/valuedesk/types.js';

const DAY = 86_400_000;
/** "Now" for every test: mid-day and mid-year, so rolling windows start inside a day and `ytd` starts 165 days back. */
const NOW = Date.UTC(2025, 5, 15, 13, 37, 11);
/** Histories start here: 226 days before NOW. */
const START = Date.UTC(2024, 10, 1);
const RETAIN = 100;
const KEEP_DAY = Math.floor(NOW / DAY) - RETAIN;
const CUT = KEEP_DAY * DAY;
const YEAR_DAY = Math.floor(Date.UTC(2025, 0, 1) / DAY);

/** The same pseudo-random history on every run. */
function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 4294967296;
}

/**
 * A trading history: 2-7 executions on most days, some filled in two parts at
 * one timestamp, three markets, opens and closes with profit and loss. Every
 * amount is a multiple of 1/8, so sums are exact in any order.
 */
function fillsOf(venue: Venue, address: string, o: { seed: number; from?: number; to?: number; stream?: number; xyz?: boolean; skip?: number[]; force?: number[] }): FillRow[] {
  const r = rng(o.seed);
  const out: FillRow[] = [];
  const symbols = o.xyz ? ['xyz:AAPL', 'BTC', 'xyz:TSLA'] : ['BTC', 'ETH', 'SOL'];
  const to = o.to ?? NOW;
  let n = 0;
  for (let day = Math.floor((o.from ?? START) / DAY); day * DAY < to; day++) {
    const quiet = r() < 0.15;
    if (o.skip?.includes(day) || (quiet && !o.force?.includes(day))) continue;
    const trades = 2 + Math.floor(r() * 6);
    for (let k = 0; k < trades; k++) {
      const t = day * DAY + Math.floor(r() * 86_000) * 1_000 + 500;
      const symbol = symbols[Math.floor(r() * 3)]!;
      const side = r() < 0.5 ? 1 : -1;
      const parts = r() < 0.3 ? 2 : 1;
      for (let p = 0; p < parts; p++) {
        const closing = r() < 0.45;
        const sign = r() < 0.6 ? 1 : -1;
        const stream = r() < (o.stream ?? 0);
        const px = [100, 250.5, 1000.25][Math.floor(r() * 3)]!;
        const sz = [0.5, 1, 2, 4][Math.floor(r() * 4)]!;
        const fee = [0.125, 0.25, 0.5][Math.floor(r() * 3)]!;
        const pnl = [0.25, 1.5, 12.75][Math.floor(r() * 3)]!;
        if (t >= to) continue;
        out.push({
          venue, address, id: `${o.seed}-${n++}`, t, symbol, side: side as 1 | -1, px, sz,
          fee: stream ? null : fee, closedPnl: stream ? null : closing ? sign * pnl : 0, oid: stream ? null : `o${n}`, src: stream ? 0 : 1,
        });
      }
    }
  }
  return out;
}

/** SoDEX closed positions: up to three on most days, opened up to three days earlier. */
function closesOf(address: string, seed: number): CloseRow[] {
  const r = rng(seed);
  const out: CloseRow[] = [];
  let n = 0;
  for (let day = Math.floor(START / DAY) + 3; day * DAY < NOW; day++) {
    const k = Math.floor(r() * 4);
    for (let i = 0; i < k; i++) {
      const t = day * DAY + Math.floor(r() * 86_000) * 1_000;
      const openedT = t - Math.floor(r() * 3 * DAY);
      const pnl = (r() < 0.55 ? 1 : -1) * [0.5, 2.25, 10][Math.floor(r() * 3)]!;
      if (t < NOW) out.push({ venue: 'sodex', address, id: `c${seed}-${n++}`, t, openedT, symbol: 'BTC-USD', pnl });
    }
  }
  return out;
}

function built(s: IndexStore, venue: Venue, address: string): void {
  s.windowStats(venue, address, 0);
  while (s.buildAggregates(1_000) > 0) { /* build */ }
}

/** Remove a temp dir. Windows can hold a just-closed database file for a moment: retry, and never fail a test over it. */
function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  } catch { /* left for the OS */ }
}

const count = (s: IndexStore, sql: string, ...p: Array<string | number>): number => (s.db.prepare(sql).get(...p) as { n: number }).n;

/** Everything the indexer reads about one trader, for every window the app has. */
function figures(s: IndexStore, venue: Venue, address: string, now = NOW): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const w of INDEX_WINDOWS) {
    const from = windowStart(w, now);
    const st = s.windowStats(venue, address, from);
    const ev = s.closeEvidence(venue, address, from);
    out[w] = {
      stats: st,
      orders: s.orderCount(venue, address, from),
      atLeastTwo: s.hasTrades(venue, address, from, 2),
      winRate: winRateOf(st.wins, st.closes, true),
      realized: s.realized(venue, address, from),
      // The caller only asks whether there is a round trip at all.
      evidence: { closes: ev.closes, roundTrip: ev.roundTrips > 0 },
    };
  }
  out.extent = s.fillExtent(venue, address);
  return out;
}

async function figuresAsync(s: IndexStore, venue: Venue, address: string, now = NOW): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const pause = async (): Promise<void> => {};
  for (const w of INDEX_WINDOWS) {
    const from = windowStart(w, now);
    out[w] = {
      stats: await s.windowStatsAsync(venue, address, from, pause),
      orders: await s.orderCountAsync(venue, address, from, pause),
      realized: await s.realizedAsync(venue, address, from, pause),
    };
  }
  return out;
}

/** A store with three indexed traders: Hyperliquid (with xyz fills, mirrored under trade.xyz), Arcus, SoDEX. */
function seeded(path = ':memory:'): IndexStore {
  const s = new IndexStore(path, { aggRefreshMs: 0, retainDays: RETAIN });
  // REST and stream rows, some on trade.xyz markets; a fill on 1 January for sure.
  s.putFills(fillsOf('hyperliquid', '0xa', { seed: 1, stream: 0.25, xyz: true, force: [YEAR_DAY] }));
  s.addCoverage('hyperliquid', '0xa', 'fills', { fromT: 0, toT: NOW, exhausted: true }, NOW);
  // No fill on 1 January: `ytd` starts on a day without a day row.
  s.putFills(fillsOf('arcus', '0xc', { seed: 2, skip: [YEAR_DAY] }));
  s.addCoverage('arcus', '0xc', 'fills', { fromT: START, toT: NOW }, NOW);
  // SoDEX: fills from the stream only, win rate from closed positions.
  s.putFills(fillsOf('sodex', '0xb', { seed: 3, stream: 1 }));
  s.putCloses(closesOf('0xb', 4));
  s.addCoverage('sodex', '0xb', 'closes', { fromT: START, toT: NOW }, NOW);
  for (const [v, a] of TRADERS) built(s, v, a);
  return s;
}

const TRADERS: ReadonlyArray<[Venue, string]> = [['hyperliquid', '0xa'], ['tradexyz', '0xa'], ['arcus', '0xc'], ['sodex', '0xb']];
const all = (s: IndexStore): unknown => TRADERS.map(([v, a]) => figures(s, v, a));

// --- the policy ---------------------------------------------------------------------------------

test('retention: the kept days come from the environment, never below the 7d window', () => {
  const was = process.env.VALUESCAN_INDEX_RETAIN_DAYS;
  delete process.env.VALUESCAN_INDEX_RETAIN_DAYS;
  assert.equal(retainDays(), RETAIN_DAYS_DEFAULT);
  assert.equal(RETAIN_DAYS_DEFAULT, 100, 'the longest rolling window (90d) plus a margin');
  process.env.VALUESCAN_INDEX_RETAIN_DAYS = '45';
  assert.equal(retainDays(), 45);
  process.env.VALUESCAN_INDEX_RETAIN_DAYS = '3';
  assert.equal(retainDays(), RETAIN_DAYS_MIN);
  process.env.VALUESCAN_INDEX_RETAIN_DAYS = 'soon';
  assert.equal(retainDays(), RETAIN_DAYS_DEFAULT);
  if (was === undefined) delete process.env.VALUESCAN_INDEX_RETAIN_DAYS;
  else process.env.VALUESCAN_INDEX_RETAIN_DAYS = was;
});

test('retention: a day is settled when the held range starts before it (or nothing older exists) and ends after it', () => {
  const d = (n: number) => n * DAY;
  // Held from the middle of day 10 to the middle of day 50; raw rows from day 5; days before 40 are old.
  assert.deepEqual(settledDays({ fromT: d(10) + 5, toT: d(50) + 5, exhausted: false }, d(5), 40), { lo: 11, hi: 40 });
  assert.deepEqual(settledDays({ fromT: d(10), toT: d(50), exhausted: false }, d(5), 40), { lo: 10, hi: 40 }, 'a range that starts at midnight covers that day');
  assert.deepEqual(settledDays({ fromT: d(10) + 5, toT: d(50), exhausted: true }, d(5), 40), { lo: 5, hi: 40 }, 'nothing older exists: what is held before it is final too');
  assert.deepEqual(settledDays({ fromT: 0, toT: d(20) + 5, exhausted: true }, d(5), 40), { lo: 5, hi: 20 }, 'days the range does not reach stay raw');
  assert.equal(settledDays({ fromT: d(45), toT: d(50), exhausted: false }, d(5), 40), null, 'held only inside the retention: nothing to freeze');
});

// --- the proof: nothing moves -----------------------------------------------------------------------

test('retention: every figure is the same before and after pruning - windows inside the retention, ytd and all', async () => {
  const s = seeded();
  const rawBefore = count(s, 'SELECT COUNT(*) AS n FROM fills');
  const oldBefore = count(s, 'SELECT COUNT(*) AS n FROM fills WHERE t < ?', CUT);
  const closesOld = count(s, 'SELECT COUNT(*) AS n FROM closes WHERE t < ?', CUT);
  assert.ok(oldBefore > 500 && closesOld > 50, 'there is something to prune');
  const before = all(s);
  const beforeAsync = await Promise.all(TRADERS.map(([v, a]) => figuresAsync(s, v, a)));

  const st = s.pruneNow(NOW);

  // Everything older than the kept days is gone, nothing newer is touched.
  assert.equal(count(s, 'SELECT COUNT(*) AS n FROM fills WHERE t < ?', CUT), 0);
  assert.equal(count(s, 'SELECT COUNT(*) AS n FROM closes WHERE t < ?', CUT), 0);
  assert.equal(count(s, 'SELECT COUNT(*) AS n FROM fills'), rawBefore - oldBefore);
  assert.equal(st.totals.fills, oldBefore);
  assert.equal(st.totals.closes, closesOld);
  assert.equal(st.keepFromDay, KEEP_DAY);
  // The day rows of those days are final, the newer ones are not.
  assert.equal(count(s, 'SELECT COUNT(*) AS n FROM fill_day WHERE day < ? AND COALESCE(frozen, 0) = 0', KEEP_DAY), 0);
  assert.equal(count(s, 'SELECT COUNT(*) AS n FROM fill_day WHERE day >= ? AND frozen = 1', KEEP_DAY), 0);
  assert.equal(st.totals.days, count(s, 'SELECT COUNT(*) AS n FROM fill_day WHERE frozen = 1'));
  assert.equal(count(s, 'SELECT COUNT(*) AS n FROM fill_prune'), 0, 'no deletion left in flight');
  assert.equal(s.dayFrozen('hyperliquid', '0xa', YEAR_DAY), true);
  assert.equal(s.dayFrozen('arcus', '0xc', YEAR_DAY), false, 'a day without a fill has no day row to freeze');

  assert.deepEqual(all(s), before, 'windowStats, orderCount, the trade test, win rates, realised PnL, close evidence, extent');
  assert.deepEqual(await Promise.all(TRADERS.map(([v, a]) => figuresAsync(s, v, a))), beforeAsync, 'and the board builds\' non-blocking readers');
  // The non-blocking readers answer what the blocking ones answer.
  for (const [i, [v, a]] of TRADERS.entries()) {
    const sync = figures(s, v, a) as Record<string, { stats: unknown; orders: number; realized: unknown }>;
    const asyn = beforeAsync[i] as Record<string, { stats: unknown; orders: number; realized: unknown }>;
    for (const w of INDEX_WINDOWS) {
      assert.deepEqual(asyn[w]!.stats, sync[w]!.stats, `${v} ${w} stats`);
      assert.equal(asyn[w]!.orders, sync[w]!.orders);
      assert.deepEqual(asyn[w]!.realized, sync[w]!.realized, `${v} ${w} realised`);
    }
  }
  // A second sweep finds nothing: the first one took it all.
  assert.deepEqual(s.pruneNow(NOW).totals, st.totals);
  s.close();
});

test('retention: the figures hold at every step of a prune, and across a restart in the middle of one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-retention-'));
  const path = join(dir, 'index.db');
  const open: IndexStore[] = [];
  try {
    let s = seeded(path);
    open.push(s);
    const before = all(s);
    // One unit of work per call (a wallet looked at, a stretch summed and frozen, a slice of 40 rows deleted).
    let calls = 0;
    let midway = 0;
    const inFlight = (x: IndexStore): number => count(x, 'SELECT COUNT(*) AS n FROM fill_prune');
    const unit = (x: IndexStore): void => {
      (x as unknown as { slice: number }).slice = 40;
      x.pruneStep(1_000, NOW, 1);
    };
    for (; calls < 400 && midway < 6; calls++) {
      unit(s);
      if (inFlight(s) > 0) midway++;
      assert.deepEqual(all(s), before, `after call ${calls}`);
    }
    assert.ok(midway >= 6 && inFlight(s) === 1, 'stopped with a stretch frozen and only part of its raw rows deleted');
    assert.ok(count(s, 'SELECT COUNT(*) AS n FROM fills WHERE t < ?', CUT) > 0);
    s.close();

    // A new process: the frozen days are read from their day rows, the leftover raw rows are not counted twice.
    s = new IndexStore(path, { aggRefreshMs: 0, retainDays: RETAIN });
    open.push(s);
    assert.deepEqual(all(s), before, 'after the restart');
    // The interrupted deletion is finished first, then the sweep goes on.
    let resumed = 0;
    for (; resumed < 400 && s.retention(NOW).lastSweepAt !== NOW; resumed++) {
      unit(s);
      assert.deepEqual(all(s), before, `resumed, call ${resumed}`);
    }
    assert.ok(resumed > 20 && s.retention(NOW).lastSweepAt === NOW, `the sweep finished, ${resumed} units later`);
    assert.equal(count(s, 'SELECT COUNT(*) AS n FROM fills WHERE t < ?', CUT), 0);
    assert.equal(inFlight(s), 0);
    assert.deepEqual(all(s), before);
    s.close();
  } finally {
    for (const x of open) {
      try {
        x.close();
      } catch { /* closed already */ }
    }
    cleanup(dir);
  }
});

test('retention: one step is a slice - a backlog is never deleted in one go', () => {
  const s = seeded();
  const old = count(s, 'SELECT COUNT(*) AS n FROM fills WHERE t < ?', CUT);
  // No budget, no work.
  s.pruneStep(0, NOW);
  assert.equal(count(s, 'SELECT COUNT(*) AS n FROM fills WHERE t < ?', CUT), old);
  assert.equal(s.retention(NOW).sweeping, false);
  // Unit by unit: no unit deletes more than one slice.
  let prev = old;
  let most = 0;
  let units = 0;
  for (; units < 2_000 && prev > 0; units++) {
    (s as unknown as { slice: number }).slice = 25;
    s.pruneStep(1_000, NOW, 1);
    const left = count(s, 'SELECT COUNT(*) AS n FROM fills WHERE t < ?', CUT);
    most = Math.max(most, prev - left);
    prev = left;
  }
  assert.equal(prev, 0);
  assert.equal(most, 25, 'a unit is one slice of rows at most');
  assert.ok(units > old / 25, `${old} old rows took ${units} units`);
  s.close();
});

// --- a frozen day is final -------------------------------------------------------------------------

test('retention: a frozen day is never summed again - late rows, stream-row drops and rebuilds leave it alone', async () => {
  const s = seeded();
  const before = all(s);
  s.pruneNow(NOW);
  const frozen = count(s, 'SELECT COUNT(*) AS n FROM fill_day WHERE frozen = 1');
  const day = (s.db.prepare("SELECT MIN(day) AS d FROM fill_day WHERE venue = 'hyperliquid' AND address = '0xa' AND frozen = 1").get() as { d: number }).d;

  // A read hands a frozen day's rows over again (REST), and a stray stream row: both dropped, counted.
  const late0 = s.retention(NOW).totals.late;
  const again = fillsOf('hyperliquid', '0xa', { seed: 1, stream: 0.25, xyz: true, force: [YEAR_DAY] }).filter((f) => Math.floor(f.t / DAY) === day);
  assert.ok(again.length > 0);
  s.putFills(again);
  s.putFills([{ venue: 'hyperliquid', address: '0xa', id: 'stray', t: day * DAY + 5, symbol: 'BTC', side: 1, px: 1, sz: 1, fee: null, closedPnl: null, oid: null, src: 0 }]);
  s.putCloses([{ venue: 'sodex', address: '0xb', id: 'again', t: CUT - 3 * DAY, openedT: CUT - 4 * DAY, symbol: 'BTC-USD', pnl: 5 }]);
  assert.equal(count(s, 'SELECT COUNT(*) AS n FROM fills WHERE t < ?', CUT), 0);
  assert.equal(count(s, 'SELECT COUNT(*) AS n FROM closes WHERE t < ?', CUT), 0);
  assert.ok(s.retention(NOW).totals.late > late0 + again.length, 'rows for frozen days are refused (the xyz ones under both venues)');
  s.flushAggregates(1_000);
  assert.deepEqual(all(s), before);

  // A REST page arrived for [0, now]: the stream rows in it go, day by day. Frozen days are not among those days.
  await s.dropStreamRowsAsync('hyperliquid', '0xa', 0, NOW, async () => {});
  s.dropStreamRows('sodex', '0xb', 0, CUT);
  s.flushAggregates(10_000);
  while (s.buildAggregates(1_000) > 0) { /* dirty days */ }
  assert.equal(count(s, 'SELECT COUNT(*) AS n FROM fill_day WHERE frozen = 1'), frozen, 'every frozen row is still there');

  // A re-sum of every day row (a new close definition) and a first build: the frozen rows stay as they are.
  const frozenRows = () => s.db.prepare('SELECT * FROM fill_day WHERE frozen = 1 ORDER BY venue, address, day').all();
  const rowsBefore = frozenRows();
  const s2 = s as unknown as { queueAgg: (v: Venue, a: string, rebuild: boolean) => void };
  for (const [v, a] of TRADERS) s2.queueAgg(v, a, true);
  while (s.buildAggregates(1_000) > 0) { /* re-sum */ }
  assert.deepEqual(frozenRows(), rowsBefore);
  s.db.exec("DELETE FROM fill_agg WHERE venue = 'arcus'");
  (s as unknown as { aggReady: Map<string, boolean> }).aggReady.clear();
  built(s, 'arcus', '0xc');
  assert.deepEqual(frozenRows(), rowsBefore);
  assert.deepEqual(figures(s, 'arcus', '0xc'), (before as unknown[])[2]);
  s.close();
});

// --- which days may be frozen --------------------------------------------------------------------

test('retention: only days the held range vouches for are frozen; the rest waits for a read to finish them', () => {
  const s = new IndexStore(':memory:', { aggRefreshMs: 0, retainDays: RETAIN });
  s.putFills(fillsOf('lighter', '0xa', { seed: 5 }));
  // Held from the middle of a day 30 days into the history (a reach-back that stopped there), not exhausted.
  const heldFrom = START + 30 * DAY + 12 * 3_600_000;
  s.addCoverage('lighter', '0xa', 'fills', { fromT: heldFrom, toT: NOW }, NOW);
  built(s, 'lighter', '0xa');
  const before = figures(s, 'lighter', '0xa');
  const firstSettled = Math.ceil(heldFrom / DAY);
  const orphans = count(s, 'SELECT COUNT(*) AS n FROM fills WHERE t < ?', firstSettled * DAY);
  assert.ok(orphans > 50);

  s.pruneNow(NOW);
  assert.equal(count(s, 'SELECT COUNT(*) AS n FROM fills WHERE t >= ? AND t < ?', firstSettled * DAY, CUT), 0, 'held, old: pruned');
  assert.equal(count(s, 'SELECT COUNT(*) AS n FROM fills WHERE t < ?', firstSettled * DAY), orphans, 'older than the held range, and the day it starts in: kept');
  assert.equal(count(s, 'SELECT COUNT(*) AS n FROM fill_day WHERE day < ? AND frozen = 1', firstSettled), 0);
  assert.deepEqual(figures(s, 'lighter', '0xa'), before);
  // Rows for those days are still taken (the reach-back goes on), and re-read rows just replace themselves.
  s.putFills(fillsOf('lighter', '0xa', { seed: 5, to: firstSettled * DAY }));
  assert.equal(count(s, 'SELECT COUNT(*) AS n FROM fills WHERE t < ?', firstSettled * DAY), orphans);

  // The reach-back completes: the held range now starts at the beginning. The next sweep takes those days too.
  s.addCoverage('lighter', '0xa', 'fills', { fromT: 0, toT: heldFrom, exhausted: true }, NOW);
  s.pruneNow(NOW);
  assert.equal(count(s, 'SELECT COUNT(*) AS n FROM fills WHERE t < ?', CUT), 0);
  assert.deepEqual(figures(s, 'lighter', '0xa'), before);

  // A held range that ended long ago (the trader is no longer followed): days after its end are not vouched for.
  s.putFills(fillsOf('lighter', '0xd', { seed: 6 }));
  const heldTo = START + 60 * DAY + 3_600_000;
  s.addCoverage('lighter', '0xd', 'fills', { fromT: 0, toT: heldTo, exhausted: true }, NOW);
  built(s, 'lighter', '0xd');
  const beforeD = figures(s, 'lighter', '0xd');
  s.pruneNow(NOW);
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM fills WHERE address = '0xd' AND t < ?", Math.floor(heldTo / DAY) * DAY), 0);
  assert.ok(count(s, "SELECT COUNT(*) AS n FROM fills WHERE address = '0xd' AND t >= ? AND t < ?", Math.floor(heldTo / DAY) * DAY, CUT) > 0);
  assert.deepEqual(figures(s, 'lighter', '0xd'), beforeD);
  s.close();
});

test('retention: a wallet no read ever landed for keeps the kept days only, and nothing once it has gone quiet', () => {
  const s = new IndexStore(':memory:', { aggRefreshMs: 0, retainDays: RETAIN });
  // Stream prints since the start, no held range: nothing vouches for them.
  s.putFills(fillsOf('hyperliquid', '0xe', { seed: 8, stream: 1 }));
  // The same, but its last print is three weeks old: nothing tracks it any more.
  s.putFills(fillsOf('hyperliquid', '0xf', { seed: 9, stream: 1, to: NOW - 21 * DAY }));
  built(s, 'hyperliquid', '0xe');
  built(s, 'hyperliquid', '0xf');
  const before = figures(s, 'hyperliquid', '0xe') as Record<string, unknown>;
  const kept = count(s, "SELECT COUNT(*) AS n FROM fills WHERE address = '0xe' AND t >= ?", CUT);

  const st = s.pruneNow(NOW);
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM fills WHERE address = '0xe'"), kept, 'the old days are gone, raw rows');
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM fill_day WHERE address = '0xe' AND day < ?", KEEP_DAY), 0, 'and day rows: none is frozen');
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM fills WHERE address = '0xf'"), 0);
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM fill_day WHERE address = '0xf'") + count(s, "SELECT COUNT(*) AS n FROM fill_agg WHERE address = '0xf'"), 0);
  assert.ok(st.totals.dropped > 0 && st.totals.days === 0);
  const after = figures(s, 'hyperliquid', '0xe') as Record<string, unknown>;
  for (const w of ['1d', '7d', '30d', '90d'] as const) assert.deepEqual(after[w], before[w], `${w}: inside the kept days, unchanged`);
  assert.notDeepEqual(after.all, before.all, 'all time is a lower bound for a wallet with no held range, now from the kept days');

  // A read lands while old days are going: what is left of them stays (a held range may claim it).
  s.putFills(fillsOf('hyperliquid', '0xg', { seed: 10, stream: 1 }));
  (s as unknown as { slice: number }).slice = 10;
  (s as unknown as { sweepDay: number }).sweepDay = -1;
  for (let i = 0; i < 50 && s.retention(NOW).pending.dropping === 0; i++) s.pruneStep(1, NOW);
  assert.equal(s.retention(NOW).pending.dropping, 1);
  const leftG = count(s, "SELECT COUNT(*) AS n FROM fills WHERE address = '0xg' AND t < ?", CUT);
  assert.ok(leftG > 0);
  s.addCoverage('hyperliquid', '0xg', 'fills', { fromT: 0, toT: NOW, exhausted: true }, NOW);
  assert.equal(s.retention(NOW).pending.dropping, 0);
  s.pruneNow(NOW);
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM fills WHERE address = '0xg' AND t < ?", CUT), 0);
  assert.ok(count(s, "SELECT COUNT(*) AS n FROM fill_day WHERE address = '0xg' AND frozen = 1") > 0, 'now held: its old days are frozen, not dropped');
  s.close();
});

test('retention: forget() drops a trader in slices, and lets go when the trader is wanted again', () => {
  const s = new IndexStore(':memory:', { aggRefreshMs: 0, retainDays: RETAIN });
  const rows: FillRow[] = [];
  for (let i = 0; i < 6_500; i++) rows.push({ venue: 'arcus', address: '0xa', id: `m${i}`, t: NOW - DAY + i * 10, symbol: 'BTC', side: 1, px: 100, sz: 1, fee: 0.125, closedPnl: 0, oid: `o${i}`, src: 1 });
  s.putFills(rows);
  s.addCoverage('arcus', '0xa', 'fills', { fromT: 0, toT: NOW, exhausted: true }, NOW);
  built(s, 'arcus', '0xa');
  s.forget('arcus', '0xa');
  // Not indexed any more at once; the raw rows go in slices.
  assert.deepEqual(s.indexedAddresses('arcus'), []);
  assert.equal(count(s, 'SELECT COUNT(*) AS n FROM fill_day') + count(s, 'SELECT COUNT(*) AS n FROM fill_agg'), 0);
  assert.equal(count(s, 'SELECT COUNT(*) AS n FROM fills'), 4_500, 'the first 2,000 at once, the rest queued');
  assert.equal(s.retention(NOW).pending.dropping, 1);
  s.pruneNow(NOW);
  assert.equal(count(s, 'SELECT COUNT(*) AS n FROM fills'), 0);

  // A small trader is gone at once, as before.
  s.putFills(rows.slice(0, 50).map((f) => ({ ...f, address: '0xb' })));
  s.addCoverage('arcus', '0xb', 'fills', { fromT: 0, toT: NOW, exhausted: true }, NOW);
  s.forget('arcus', '0xb');
  assert.equal(count(s, 'SELECT COUNT(*) AS n FROM fills'), 0);
  assert.equal(s.retention(NOW).pending.dropping, 0);

  // Forgotten, then on a board again before the slices finished: what is left stays, nothing new is deleted.
  s.putFills(rows);
  s.addCoverage('arcus', '0xa', 'fills', { fromT: 0, toT: NOW, exhausted: true }, NOW);
  s.forget('arcus', '0xa');
  s.putFills([{ ...rows[0]!, id: 'fresh', t: NOW - 5 }]);
  assert.equal(s.retention(NOW).pending.dropping, 0);
  s.pruneStep(50, NOW);
  assert.equal(count(s, 'SELECT COUNT(*) AS n FROM fills'), 4_501);
  s.close();
});

// --- broken timestamps ------------------------------------------------------------------------------

test('insert guard: a fill or close with a time no venue can have produced is never stored', () => {
  const s = new IndexStore(':memory:');
  const f = (id: string, t: number): FillRow => ({ venue: 'arcus', address: '0xa', id, t, symbol: 'HYPE-USD', side: 1, px: 52.7, sz: 0.3, fee: 0.01, closedPnl: 0, oid: null, src: 1 });
  const good = Date.UTC(2026, 7, 3, 12);
  s.putFills([
    f('zero', 0),
    f('seconds', Math.floor(good / 1_000)),
    f('micros', good * 1_000),
    f('nan', Number.NaN),
    f('1999', Date.UTC(1999, 0, 1)),
    f('next-year', Date.now() + 400 * DAY),
    f('good', good),
    f('first', MIN_ROW_T),
  ]);
  assert.deepEqual((s.db.prepare('SELECT id FROM fills ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id), ['first', 'good']);
  s.putCloses([
    { venue: 'sodex', address: '0xb', id: 'c0', t: 0, openedT: null, symbol: 'BTC-USD', pnl: 1 },
    { venue: 'sodex', address: '0xb', id: 'c1', t: good, openedT: good - 5, symbol: 'BTC-USD', pnl: 1 },
  ]);
  assert.equal(count(s, 'SELECT COUNT(*) AS n FROM closes'), 1);
  const st = s.retention();
  assert.equal(st.totals.badTime, 7);
  assert.match(st.lastBad ?? '', /sodex 0xb c0 t=0/);
  // An xyz fill is refused under both venues it would be filed under.
  s.putFills([{ ...f('x', 0), venue: 'hyperliquid', symbol: 'xyz:AAPL' }]);
  assert.equal(s.retention().totals.badTime, 9);
  assert.equal(count(s, 'SELECT COUNT(*) AS n FROM fills'), 2);
  s.close();
});

test('retention: stored fills on 1 January 1970 take their neighbour\'s time (Arcus trade ids run in order) or go', () => {
  const s = new IndexStore(':memory:', { aggRefreshMs: 0, retainDays: RETAIN });
  const T = Date.UTC(2025, 4, 3, 12, 4, 41, 377);
  const f = (venue: Venue, id: string, t: number, symbol = 'HYPE-USD'): FillRow => ({ venue, address: '0xd2', id, t, symbol, side: 1, px: 52.5, sz: 2, fee: 0.125, closedPnl: 0, oid: null, src: 1 });
  // What the index held: two timed fills of a burst and, between and after them, fills stored with time 0.
  s.putFills([f('arcus', '188802', T), f('arcus', '188816', T + 265), f('arcus', '188790', T - 5_000, 'BTC-USD'), f('lighter', '77', T)]);
  const ins = s.db.prepare("INSERT INTO fills (venue, address, id, t, symbol, side, px, sz, fee, closed_pnl, oid, src) VALUES (?, '0xd2', ?, 0, ?, 1, 52.5, 2, 0.125, 0, NULL, 1)");
  for (const id of ['188803', '188804', '188806', '188815', '188817', '188820']) ins.run('arcus', id, 'HYPE-USD');
  ins.run('arcus', '188791', 'BTC-USD'); // its only neighbour by id in that market is 188790
  ins.run('arcus', '500000', 'HYPE-USD'); // no fill near it: cannot be placed
  ins.run('lighter', '78', 'HYPE-USD'); // not a venue whose ids say anything about time
  s.addCoverage('arcus', '0xd2', 'fills', { fromT: 0, toT: NOW, exhausted: true }, NOW);
  s.addCoverage('lighter', '0xd2', 'fills', { fromT: 0, toT: NOW, exhausted: true }, NOW);
  built(s, 'arcus', '0xd2');
  built(s, 'lighter', '0xd2');
  assert.equal(s.fillExtent('arcus', '0xd2').minT, 0, 'the history seemed to start in 1970');
  assert.equal(count(s, 'SELECT COUNT(*) AS n FROM fill_day WHERE day = 0'), 2);

  const st = s.pruneNow(NOW);
  const t = (id: string): number | undefined => (s.db.prepare("SELECT t FROM fills WHERE venue = 'arcus' AND id = ?").get(id) as { t: number } | undefined)?.t;
  assert.equal(t('188803'), T, 'the fill before it');
  assert.equal(t('188804'), T);
  assert.equal(t('188815'), T + 265, 'the fill after it is nearer');
  assert.equal(t('188817'), T + 265);
  assert.equal(t('188820'), T + 265);
  assert.equal(t('188791'), T - 5_000, 'a neighbour in the same market only');
  assert.equal(t('500000'), undefined);
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM fills WHERE venue = 'lighter'"), 1);
  assert.deepEqual([st.totals.repaired, st.totals.unrepairable], [7, 2]);
  assert.equal(count(s, 'SELECT COUNT(*) AS n FROM fills WHERE t < ?', MIN_ROW_T), 0);
  assert.equal(count(s, 'SELECT COUNT(*) AS n FROM fill_day WHERE day < 18262'), 0, 'the 1970 day rows are gone');
  s.flushAggregates(1_000);
  assert.equal(s.fillExtent('arcus', '0xd2').minT, T - 5_000);
  // Eight HYPE fills at two timestamps and two BTC fills at one, all buys: three executions.
  assert.equal(s.windowStats('arcus', '0xd2', 0).trades, 3);
  assert.equal(s.windowStats('arcus', '0xd2', 0).volume, 10 * 105);
  s.close();
});

test('Arcus pages: a fill answered with createdAt 0 takes the nearest timed fill\'s time before anything is stored', () => {
  const T = Date.UTC(2026, 7, 3, 12, 4, 41, 377);
  const f = (id: string, t: number) => ({ id, t, symbol: 'HYPE-USD', side: 'BUY' as const, price: 52.7, size: 0.3, fee: 0.01, closedPnl: 0, orderId: null });
  // Newest first, as Arcus answers.
  const page = [f('188821', T + 300), f('188820', 0), f('188817', 0), f('188816', T + 265), f('188815', 0), f('188804', 0), f('188803', 0), f('188802', T)];
  const fixed = fixFillTimes(page, T + 3_600_000);
  // Each takes the nearest timed fill in the page; at equal distance the older one.
  assert.deepEqual(fixed.map((x) => [x.id, x.t - T]), [
    ['188821', 300], ['188820', 300], ['188817', 265], ['188816', 265], ['188815', 265], ['188804', 0], ['188803', 0], ['188802', 0],
  ]);
  assert.equal(Math.min(...fixed.map((x) => x.t)), T, 'the page\'s oldest time is a real one again (paging goes on from it)');
  assert.deepEqual(fixFillTimes([f('1', 0), f('2', 0)], T), [], 'no time to go by: left out, not guessed');
  const clean = [f('2', T + 1), f('1', T)];
  assert.deepEqual(fixFillTimes(clean, T + 10), clean);
  assert.deepEqual(fixFillTimes([f('9', T * 1_000), f('8', T)], T + 10).map((x) => x.t), [T, T], 'microseconds are no time either');
});

// --- coverage semantics -----------------------------------------------------------------------------

test('coverage: a trader whose raw rows were pruned is still covered for long windows - exact trades and win rate from the day rows', async () => {
  const realStart = Lane.prototype.start;
  (Lane.prototype as unknown as { start: () => void }).start = () => {};
  const { Indexer } = await import('../src/indexer/engine.js');
  const s = new IndexStore(':memory:', { aggRefreshMs: 0, retainDays: RETAIN });
  s.putFills(fillsOf('arcus', '0xa', { seed: 11, force: [YEAR_DAY] }));
  s.addCoverage('arcus', '0xa', 'fills', { fromT: 0, toT: NOW, exhausted: true }, NOW);
  built(s, 'arcus', '0xa');
  for (const w of ['30d', 'all'] as const) s.putPnl('arcus', w, [{ address: '0xa', pnl: 500, volume: null }], NOW, NOW);

  type Ix = {
    buildBoard: (...a: unknown[]) => Promise<string[]>;
    pickStats: (v: Venue, a: string, w: string, from: number, now: number) => { stats: unknown; covered: boolean; capped: boolean; wrExact: boolean; wrFrom: number | null };
    tradeState: (v: Venue, a: string, w: string, from: number, now: number) => { n: number | null; exact: boolean };
  };
  const read = async (): Promise<Record<string, unknown>> => {
    const ix = new Indexer(s, () => NOW);
    ix.start();
    const out: Record<string, unknown> = {};
    for (const w of ['30d', 'all'] as const) {
      for (const filter of ['any', 'active'] as const) {
        await (ix as unknown as Ix).buildBoard('arcus', w, 'top', filter, null, NOW, new Map());
        out[`${w}|${filter}`] = s.readBoard('arcus', w, 'top', filter)!.rows.map(({ rankChange: _r, ...row }) => row);
      }
    }
    // 90d and ytd: the per-trader figures every board row is made of.
    for (const w of ['90d', 'ytd', 'all'] as const) {
      const from = windowStart(w, NOW);
      out[w] = { pick: (ix as unknown as Ix).pickStats('arcus', '0xa', w, from, NOW), trades: (ix as unknown as Ix).tradeState('arcus', '0xa', w, from, NOW) };
    }
    ix.stop();
    return out;
  };

  const before = await read();
  const old = count(s, 'SELECT COUNT(*) AS n FROM fills WHERE t < ?', CUT);
  s.pruneNow(NOW);
  assert.equal(count(s, 'SELECT COUNT(*) AS n FROM fills WHERE t < ?', CUT), 0);
  assert.ok(old > 300);
  const after = await read();
  assert.deepEqual(after, before);

  const row = (after['all|active'] as Array<Record<string, unknown>>)[0]!;
  assert.equal(row.tradesCapped, false, 'the count is exact, not "at least"');
  assert.equal(row.winExact, true);
  assert.ok((row.trades as number) > 500 && (row.winCloses as number) > 100, 'the pruned days are in it');
  for (const w of ['90d', 'ytd', 'all'] as const) {
    const x = after[w] as { pick: { covered: boolean; capped: boolean; wrExact: boolean; wrFrom: number | null }; trades: { exact: boolean } };
    assert.deepEqual([x.pick.covered, x.pick.capped, x.pick.wrExact, x.pick.wrFrom, x.trades.exact], [true, false, true, null, true], w);
  }
  // The held range itself is untouched, and so is what the Hyperliquid cap check reads.
  assert.deepEqual(s.coverage('arcus', '0xa', 'fills'), { fromT: 0, toT: NOW, exhausted: true, capped: false, restAt: NOW });
  s.close();
  Lane.prototype.start = realStart;
});

test('coverage: the Hyperliquid 10k-cap check still sees the pruned fills (their count and the oldest one\'s time)', () => {
  const s = new IndexStore(':memory:', { aggRefreshMs: 0, retainDays: RETAIN });
  const rows = fillsOf('hyperliquid', '0xa', { seed: 12 });
  s.putFills(rows);
  s.addCoverage('hyperliquid', '0xa', 'fills', { fromT: 0, toT: NOW, exhausted: true }, NOW);
  built(s, 'hyperliquid', '0xa');
  const first = Math.min(...rows.map((r) => r.t));
  assert.deepEqual(s.fillExtent('hyperliquid', '0xa'), { count: rows.length, minT: first });
  s.pruneNow(NOW);
  assert.ok(count(s, 'SELECT COUNT(*) AS n FROM fills') < rows.length / 2);
  assert.deepEqual(s.fillExtent('hyperliquid', '0xa'), { count: rows.length, minT: first });
  assert.equal(s.fillExtent('hyperliquid', '0xa', 10).count >= 10, true, 'raw rows are counted up to a cap');
  s.close();
});

test('retention below a window\'s length: that window starts at 00:00 UTC of its first day', () => {
  const s = new IndexStore(':memory:', { aggRefreshMs: 0, retainDays: 30 });
  s.putFills(fillsOf('arcus', '0xa', { seed: 13 }));
  s.addCoverage('arcus', '0xa', 'fills', { fromT: 0, toT: NOW, exhausted: true }, NOW);
  built(s, 'arcus', '0xa');
  const from90 = windowStart('90d', NOW);
  const dayStart = Math.floor(from90 / DAY) * DAY;
  const wholeDay = figures(s, 'arcus', '0xa', dayStart + 90 * DAY) as Record<string, unknown>;
  const before = figures(s, 'arcus', '0xa') as Record<string, unknown>;
  s.pruneNow(NOW);
  const after = figures(s, 'arcus', '0xa') as Record<string, unknown>;
  for (const w of ['1d', '7d', 'ytd', 'all'] as const) assert.deepEqual(after[w], before[w], w);
  assert.deepEqual((after['90d'] as { stats: unknown }).stats, (wholeDay['90d'] as { stats: unknown }).stats, '90d now counts its whole first day');
  s.close();
});

// --- trade.xyz realised PnL from the day rows ----------------------------------------------------------

test('trade.xyz: realised PnL per window comes from the day rows and one first-day scan, before and after pruning', async () => {
  const s = seeded();
  const pause = async (): Promise<void> => {};
  const { TradexyzVenue } = await import('../src/indexer/ext/tradexyz.js');
  const pnl = async (): Promise<Record<string, unknown>> => {
    const x = new TradexyzVenue();
    x.start({ store: s, now: () => NOW, streamSince: () => null, onPrint: () => {}, hlLane: new Lane({ name: 'never-started', perMin: 1e9 }) });
    await x.refresh(NOW);
    return Object.fromEntries(INDEX_WINDOWS.map((w) => [w, s.pnlOf('tradexyz', w, '0xa')]));
  };
  const before = await pnl();
  for (const w of INDEX_WINDOWS) {
    const r = s.realized('tradexyz', '0xa', windowStart(w, NOW));
    assert.ok(r.fills > 0);
    assert.deepEqual([(before[w] as { pnl: number }).pnl, (before[w] as { volume: number }).volume], [r.pnl, r.volume], w);
  }
  s.pruneNow(NOW);
  assert.deepEqual(await pnl(), before);

  // Day rows from before they carried the realised PnL: the raw rows answer while they are summed again.
  s.db.exec("UPDATE fill_agg SET def = NULL WHERE venue = 'tradexyz'; UPDATE fill_day SET net = NULL, fills = NULL WHERE venue = 'tradexyz' AND COALESCE(frozen, 0) = 0");
  (s as unknown as { netReady: Map<string, boolean> }).netReady.clear();
  const from = windowStart('30d', NOW);
  assert.deepEqual(await s.realizedAsync('tradexyz', '0xa', from, pause), s.realized('tradexyz', '0xa', from));
  assert.equal(s.aggBacklog.rebuild + s.aggBacklog.first, 1, 'a re-sum is queued');
  while (s.buildAggregates(1_000) > 0) { /* re-sum */ }
  assert.equal(count(s, "SELECT COUNT(*) AS n FROM fill_day WHERE venue = 'tradexyz' AND net IS NULL"), 0);
  assert.deepEqual(await s.realizedAsync('tradexyz', '0xa', from, pause), s.realized('tradexyz', '0xa', from));
  s.close();
});

// --- the other tables --------------------------------------------------------------------------------

test('all-time snapshots: the last 100 days and the one ytd is measured from are kept; activity is pruned per venue', () => {
  const s = new IndexStore(':memory:');
  const today = Math.floor(NOW / DAY);
  const put = (venue: Venue, day: number) => s.putCumPnl(venue, day, [{ address: '0xa', pnl: day }, { address: '0xb', pnl: -day }]);
  for (const d of [YEAR_DAY - 40, YEAR_DAY - 2, YEAR_DAY + 1, today - 150, today - 100, today - 99, today]) put('hyperliquid', d);
  for (const d of [today - 150, today - 30]) put('lighter', d); // started after 1 January: no ytd anchor
  s.addActivity([
    { venue: 'sodex', acct: '1', hour: (today - 50) * 24, trades: 1, volume: 1 },
    { venue: 'sodex', acct: '1', hour: (today - 2) * 24, trades: 1, volume: 1 },
    { venue: 'arcus', acct: '0xa', hour: (today - 500) * 24, trades: 1, volume: 1 },
  ]);
  const cum = { beforeDay: today - 100, yearStartDay: YEAR_DAY };
  let n = 0;
  for (let i = 0; i < 10; i++) {
    const k = s.pruneActivityChunk((today - 36) * 24, today - 400, 3, cum);
    if (!k) break;
    n += k;
  }
  const days = (v: Venue) => (s.db.prepare('SELECT DISTINCT day FROM cum_pnl_day WHERE venue = ? ORDER BY day').all(v) as Array<{ day: number }>).map((r) => r.day);
  assert.deepEqual(days('hyperliquid'), [YEAR_DAY - 2, today - 100, today - 99, today]);
  assert.deepEqual(days('lighter'), [today - 30]);
  // ytd still measures from the snapshot at (or just before) 1 January, 90d from the one 90 days back.
  assert.equal(s.cumPnlAt('hyperliquid', YEAR_DAY).get('0xa'), YEAR_DAY - 2);
  assert.equal(s.cumPnlSince('hyperliquid'), YEAR_DAY - 2);
  assert.equal(s.cumPnlAt('hyperliquid', today - 90).get('0xa'), today - 99);
  assert.equal(count(s, 'SELECT COUNT(*) AS n FROM activity_hour'), 1);
  assert.equal(count(s, 'SELECT COUNT(*) AS n FROM activity_day'), 2, 'day rows are kept 400 days');
  assert.equal(n, 2 * 4 + 1 + 1 + 1);
  s.close();
});

// --- space -------------------------------------------------------------------------------------------

test('space: a new file hands freed pages back in slices; an older file reuses them until it is compacted offline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-space-'));
  const open: IndexStore[] = [];
  try {
    const rows: FillRow[] = [];
    for (let i = 0; i < 30_000; i++) rows.push({ venue: 'arcus', address: '0xa', id: `row-${i}`, t: NOW - DAY + i, symbol: 'BTC-USD', side: 1, px: 100, sz: 1, fee: 0.125, closedPnl: 0, oid: `order-${i}`, src: 1 });
    const pages = (s: IndexStore): number => Number(Object.values(s.db.prepare('PRAGMA page_count').get() as Record<string, number>)[0]);
    const free = (s: IndexStore): number => Number(Object.values(s.db.prepare('PRAGMA freelist_count').get() as Record<string, number>)[0]);

    // Created by this code: incremental auto-vacuum from the first page on.
    const fresh = join(dir, 'new.db');
    let s = new IndexStore(fresh);
    open.push(s);
    assert.equal(s.retention().autoVacuum, true);
    s.putFills(rows);
    s.addCoverage('arcus', '0xa', 'fills', { fromT: 0, toT: NOW, exhausted: true }, NOW);
    const full = pages(s);
    s.forget('arcus', '0xa');
    s.pruneNow(NOW);
    assert.ok(free(s) > full / 2, 'the deleted rows left free pages');
    assert.equal(s.reclaimStep(), 0, 'a reserve stays for the next inserts (64 MB by default)');
    let steps = 0;
    while (s.reclaimStep(16, 64) > 0) steps++;
    assert.ok(steps > 5, 'handed back a slice at a time');
    assert.ok(pages(s) < full / 2 && free(s) <= 16, `the file shrank from ${full} to ${pages(s)} pages`);
    assert.ok(s.retention().totals.reclaimedPages >= steps * 32);
    s.close();

    // Created before: no auto-vacuum. Freed pages are reused, the file keeps its size.
    const old = join(dir, 'old.db');
    const raw = new DatabaseSync(old);
    raw.exec('CREATE TABLE made_earlier (x)');
    raw.close();
    s = new IndexStore(old);
    open.push(s);
    assert.equal(s.retention().autoVacuum, false);
    s.putFills(rows);
    s.addCoverage('arcus', '0xa', 'fills', { fromT: 0, toT: NOW, exhausted: true }, NOW);
    const fullOld = pages(s);
    s.forget('arcus', '0xa');
    s.pruneNow(NOW);
    assert.equal(s.reclaimStep(0, 64), 0);
    assert.equal(pages(s), fullOld);
    s.putFills(rows.slice(0, 20_000));
    assert.equal(pages(s), fullOld, 'new rows went into the freed pages: no growth');
    s.forget('arcus', '0xa');
    s.pruneNow(NOW);
    s.close();

    // The offline step (indexer stopped) rewrites the file once and switches it over.
    const { compact } = await import('../src/indexer/compact.js');
    const r = compact(old);
    assert.equal(r.before.autoVacuum, 0);
    assert.equal(r.after.autoVacuum, 2);
    assert.ok(r.after.db < r.before.db / 2 && r.after.free === 0, `${r.before.db} -> ${r.after.db} bytes`);
    assert.equal(statSync(old).size, r.after.db);
    s = new IndexStore(old);
    open.push(s);
    assert.equal(s.retention().autoVacuum, true);
    s.close();
  } finally {
    for (const x of open) {
      try {
        x.close();
      } catch { /* closed already */ }
    }
    cleanup(dir);
  }
});

// --- the day rows themselves: level with their fills, whatever happens ---------------------------------------

const scanOf = (s: IndexStore, venue: Venue, address: string, from = 0): unknown =>
  (s as unknown as { windowStatsScan: (v: Venue, a: string, f: number) => unknown }).windowStatsScan(venue, address, from);

test('day rows: a day that is behind its fills is remembered across a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-dirty-'));
  const path = join(dir, 'index.db');
  const open: IndexStore[] = [];
  const f = (id: string, t: number): FillRow => ({ venue: 'arcus', address: '0xa', id, t, symbol: 'BTC', side: 1, px: 100, sz: 1, fee: 0.125, closedPnl: 0, oid: id, src: 1 });
  try {
    // A day is summed again at most every ten minutes (the indexer's setting).
    let s = new IndexStore(path, { aggRefreshMs: 600_000 });
    open.push(s);
    s.putFills([f('a', NOW - 3_000)]);
    built(s, 'arcus', '0xa');
    s.putFills([f('b', NOW - 2_000)]);
    assert.equal(s.windowStats('arcus', '0xa', 0).trades, 2, 'the first change is summed at once');
    s.putFills([f('c', NOW - 1_000)]);
    assert.equal(s.windowStats('arcus', '0xa', 0).trades, 2, 'the next one waits for the interval');
    assert.equal(count(s, 'SELECT COUNT(*) AS n FROM fill_dirty'), 1, 'and is written down');
    s.close();

    // The process restarts before that interval is over. (The mark used to be in memory only: the day stayed at 2.)
    s = new IndexStore(path, { aggRefreshMs: 600_000 });
    open.push(s);
    assert.equal(s.flushAggregates(1_000), 0);
    assert.equal(s.windowStats('arcus', '0xa', 0).trades, 3);
    assert.equal(count(s, 'SELECT COUNT(*) AS n FROM fill_dirty'), 0);
    s.close();
  } finally {
    for (const x of open) {
      try {
        x.close();
      } catch { /* closed already */ }
    }
    cleanup(dir);
  }
});

test('day rows: rows that arrive while a re-sum runs are summed once it has landed', () => {
  const s = new IndexStore(':memory:', { aggRefreshMs: 0 });
  const rows = fillsOf('arcus', '0xa', { seed: 21 });
  s.putFills(rows);
  built(s, 'arcus', '0xa');
  const x = s as unknown as { queueAgg: (v: Venue, a: string, r: boolean) => void; rebuilding: Map<string, unknown>; scanStep: (job: unknown, n: number) => boolean };
  x.queueAgg('arcus', '0xa', true);
  const job = x.rebuilding.get('arcus|0xa');
  // The re-sum has read the first days...
  x.scanStep(job, 200);
  // ...when a fill arrives for one of them, and that day's row is brought level before the re-sum is done.
  s.putFills([{ ...rows[0]!, id: 'late', t: rows[0]!.t + 1, symbol: 'DOGE', px: 1_000_000 }]);
  s.flushAggregates(1_000);
  assert.deepEqual(s.windowStats('arcus', '0xa', 0), scanOf(s, 'arcus', '0xa'));
  // The re-sum lands with what it read before the fill arrived. The day is summed once more.
  while (s.buildAggregates(1_000) > 0) { /* re-sum */ }
  s.flushAggregates(1_000);
  assert.deepEqual(s.windowStats('arcus', '0xa', 0), scanOf(s, 'arcus', '0xa'));
  assert.equal(s.windowStats('arcus', '0xa', 0).assets[0], 'DOGE');
  s.close();
});

test('SoDEX day rows start at the first close, not the first stream fill; a re-sum keeps them', () => {
  const s = new IndexStore(':memory:', { aggRefreshMs: 0 });
  const closes = closesOf('0xb', 4);
  // Closed positions from months back (read before anything else), stream prints for the last five days only.
  s.putCloses(closes);
  s.putFills(fillsOf('sodex', '0xb', { seed: 3, stream: 1, from: NOW - 5 * DAY }));
  built(s, 'sodex', '0xb');
  const wins = closes.filter((c) => c.pnl > 0).length;
  assert.deepEqual([s.windowStats('sodex', '0xb', 0).closes, s.windowStats('sodex', '0xb', 0).wins], [closes.length, wins]);
  (s as unknown as { queueAgg: (v: Venue, a: string, r: boolean) => void }).queueAgg('sodex', '0xb', true);
  while (s.buildAggregates(1_000) > 0) { /* re-sum */ }
  assert.deepEqual([s.windowStats('sodex', '0xb', 0).closes, s.windowStats('sodex', '0xb', 0).wins], [closes.length, wins]);
  s.close();
});

test('definition 4: every trader\'s day rows are summed again from their fills, SoDEX included', () => {
  const s = new IndexStore(':memory:', { aggRefreshMs: 0 });
  s.putFills(fillsOf('arcus', '0xc', { seed: 2 }));
  s.putFills(fillsOf('sodex', '0xb', { seed: 3, stream: 1, from: NOW - 5 * DAY }));
  s.putCloses(closesOf('0xb', 4));
  built(s, 'arcus', '0xc');
  built(s, 'sodex', '0xb');
  const right = [s.windowStats('arcus', '0xc', 0), s.windowStats('sodex', '0xb', 0)];
  // As the index was on 2026-10-02: rows short of their fills, SoDEX rows without the closes before the first fill, no `net`.
  const firstFill = Math.floor((NOW - 5 * DAY) / DAY);
  s.db.exec(`UPDATE fill_day SET trades = trades - 1, net = NULL, fills = NULL WHERE venue = 'arcus' AND trades > 2;
    DELETE FROM fill_day WHERE venue = 'sodex' AND day < ${firstFill};
    UPDATE fill_agg SET built_at = 1, def = NULL; DELETE FROM meta WHERE key LIKE 'closes_def%'`);
  assert.notDeepEqual([s.windowStats('arcus', '0xc', 0), s.windowStats('sodex', '0xb', 0)], right);
  assert.equal(s.migrateCloses(), 2);
  assert.equal(s.aggBacklog.rebuild, 2);
  while (s.buildAggregates(1_000) > 0) { /* re-sum */ }
  assert.deepEqual([s.windowStats('arcus', '0xc', 0), s.windowStats('sodex', '0xb', 0)], right);
  assert.equal(count(s, 'SELECT COUNT(*) AS n FROM fill_day WHERE net IS NULL OR fills IS NULL'), 0);
  assert.equal(s.getMeta('closes_def'), '4');
  assert.equal(s.migrateCloses(), 0, 'once');
  s.close();
});

test('activity: one account\'s stream trades are read through the account index, not by testing every account\'s rows', () => {
  const s = new IndexStore(':memory:');
  const rows: Array<{ venue: Venue; acct: string; hour: number; trades: number; volume: number }> = [];
  for (let a = 0; a < 300; a++) for (let h = 0; h < 40; h++) rows.push({ venue: 'hyperliquid', acct: `0x${a}`, hour: 480_000 + h, trades: 1 + (a % 3), volume: 10 });
  s.addActivity(rows);
  assert.equal(s.activityTrades('hyperliquid', '0x7', { hour: 480_010 }), 30 * 2);
  assert.equal(s.activityTrades('hyperliquid', '0x7', { day: 20_000 }), 40 * 2);
  assert.equal(s.activityTrades('hyperliquid', '0xnobody', { hour: 0 }), 0);
  // The plan: a search of the account's own rows (12,000 rows of other accounts are never touched).
  const plan = (sql: string): string => (s.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('hyperliquid', '0x7', 0) as Array<{ detail: string }>).map((r) => r.detail).join(' ');
  assert.match(plan('SELECT COALESCE(SUM(trades), 0) AS n FROM activity_hour INDEXED BY activity_hour_acct WHERE venue = ? AND acct = ? AND hour >= ?'), /activity_hour_acct \(venue=\? AND acct=\? AND hour>\?\)/);
  assert.match(plan('SELECT COALESCE(SUM(trades), 0) AS n FROM activity_day INDEXED BY activity_day_acct WHERE venue = ? AND acct = ? AND day >= ?'), /activity_day_acct \(venue=\? AND acct=\? AND day>\?\)/);
  s.close();
});

test('retention: without the owner saying so (VALUESCAN_PRUNE) the sweep deletes nothing, however old', () => {
  const was = process.env.VALUESCAN_PRUNE;
  delete process.env.VALUESCAN_PRUNE;
  try {
    const s = seeded();
    const before = all(s);
    const old = count(s, 'SELECT COUNT(*) AS n FROM fills WHERE t < ?', CUT);
    assert.ok(old > 0);
    s.pruneNow(NOW);
    assert.equal(count(s, 'SELECT COUNT(*) AS n FROM fills WHERE t < ?', CUT), old, 'every raw row kept');
    assert.deepEqual(all(s), before);
    s.close();
  } finally {
    process.env.VALUESCAN_PRUNE = was;
  }
});

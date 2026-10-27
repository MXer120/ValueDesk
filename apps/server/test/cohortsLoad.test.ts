/**
 * The cohort load behind /api/vs/cohorts* (indexer/read.ts): the same answers as
 * netting and summing the tables in one go, a rebuild from behind that never
 * builds inside a request while the pages are in use, and one that lets other
 * work run while it does.
 *
 *   npx tsx --test test/cohortsLoad.test.ts   (from apps/server)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IndexStore } from '../src/indexer/store.js';
import { TAIL_RATE } from '../src/indexer/cohortTracker.js';
import { KEEP_WARM_MS, LOAD_TTL_MS, _cohortLoad, cohortDetail, cohortFocus, cohortMap, cohortWallets, cohortsRead, warmCohorts } from '../src/indexer/read.js';
import {
  MARGIN_SIBLING, aggregate, cohortsOf, holdsPosition, perpEquity, sampledVenue, scopeKey, scopeWallets, sumCohorts, walletRow,
  type CohortFilter, type NettedWallet, type WalletVenue,
} from '../src/valuedesk/cohorts/model.js';
import { VENUES, type Venue } from '../src/valuedesk/types.js';

const dir = mkdtempSync(join(tmpdir(), 'vs-cohorts-'));
const DB = join(dir, 'index.db');
process.env.VALUESCAN_INDEX_DB = DB;
after(() => {
  _cohortLoad.reset();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* a handle still open on Windows */ }
});

const COINS = ['BTC', 'ETH', 'SOL', 'DOGE', 'HYPE', 'xyz:TSLA', 'LINK', 'PEPE'];
const MARK: Record<string, number> = { BTC: 60_000, ETH: 3_000, SOL: 150, DOGE: 0.2, HYPE: 40, 'xyz:TSLA': 250, LINK: 15, PEPE: 0.00001 };

/** Deterministic pseudo-random numbers. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
const addr = (venue: string, i: number) => `0x${venue.slice(0, 2)}${String(i).padStart(38, '0')}`.slice(0, 42);

/** Fill the cohort tables: `n` wallets on a venue, every third without a book, some books without a member. */
function seed(w: IndexStore, venue: Venue, n: number, seedNo: number, at: number): void {
  const r = rng(seedNo);
  const members = [];
  const books = [];
  for (let i = 0; i < n; i++) {
    const address = addr(venue, i);
    const equity = r() < 0.1 ? null : Math.round(r() ** 4 * 8_000_000 * 100) / 100;
    if (i % 11 !== 0) {
      members.push({
        address, pnl: r() < 0.05 ? null : Math.round((r() - 0.45) * 3_000_000), equity, label: i % 50 === 0 ? `name ${i}` : null,
        pnl1d: r() < 0.5 ? Math.round((r() - 0.5) * 10_000) : null, pnl7d: Math.round((r() - 0.5) * 50_000), pnl30d: r() < 0.2 ? null : Math.round((r() - 0.5) * 200_000),
      });
    }
    if (i % 3 !== 0) {
      const positions = Array.from({ length: Math.floor(r() * 4) }, () => {
        const symbol = COINS[Math.floor(r() * COINS.length)]!;
        return { symbol, szi: Math.round((r() - 0.4) * 1000) / 10, entry: r() < 0.9 ? MARK[symbol]! * (0.8 + r() * 0.4) : null };
      });
      // Every seventh Hyperliquid book a unified account: its perp equity is its collateral.
      const unified = venue === 'hyperliquid' && i % 7 === 0;
      books.push({ venue, address, equity, positions, at: at - Math.floor(r() * 100_000), collateral: unified ? (equity ?? 0) * 3 + 50_000 : null, spotAt: unified ? at : null });
    }
  }
  w.putCohortMembers(venue, members, at);
  w.putCohortBooks(books);
}

/** trade.xyz books on Hyperliquid's addresses (the same accounts' xyz dex). */
function seedXyz(w: IndexStore, n: number, at: number): void {
  const r = rng(11);
  const books = [];
  for (let i = 1; i < n; i += 2) {
    books.push({ venue: 'tradexyz' as Venue, address: addr('hyperliquid', i), equity: Math.round(r() * 3_000_000), positions: [{ symbol: 'xyz:TSLA', szi: Math.round(r() * 1000), entry: 240 }], at: at - 5 });
  }
  w.putCohortBooks(books);
}

/** The load as it was built before paging and slicing: every table in one statement, one loop. */
function oracle(s: IndexStore) {
  const per = new Map<Venue, Map<string, WalletVenue>>();
  const coverage: Record<string, { members: number; covered: number }> = {};
  let booksAt = 0;
  for (const venue of VENUES) {
    const members = s.cohortMembers(venue);
    const books = s.cohortBooks(venue);
    const sib = MARGIN_SIBLING[venue];
    const sibBooks = sib ? s.cohortBooks(sib) : undefined;
    const m = new Map<string, WalletVenue>();
    let covered = 0;
    for (const address of new Set([...members.keys(), ...books.keys()])) {
      const mem = members.get(address);
      const b = books.get(address);
      const w = sampledVenue(TAIL_RATE[venue], address, mem && {
        pnl: mem.pnl, equity: mem.equity, label: mem.label,
        pnlRange: { '1d': mem.pnl1d ?? null, '7d': mem.pnl7d ?? null, '30d': mem.pnl30d ?? null },
      }, b, perpEquity(venue, b, sibBooks?.get(address)));
      if (w.positions) { covered++; booksAt = Math.max(booksAt, b!.at); }
      m.set(address, w);
    }
    per.set(venue, m);
    coverage[venue] = { members: m.size, covered };
  }
  const marks = s.cohortMarks();
  const mark = (v: Venue, sym: string) => marks.get(`${v}|${sym}`) ?? null;
  return {
    booksAt, coverage,
    wallets: (venues: readonly Venue[]): NettedWallet[] => scopeWallets(venues, per, mark),
  };
}

const T0 = Date.now();
const writer = new IndexStore(DB);
seed(writer, 'sodex', 900, 1, T0);
seed(writer, 'hyperliquid', 5_300, 2, T0);
seed(writer, 'lighter', 4_100, 3, T0);
seedXyz(writer, 1_200, T0);
writer.putCohortMarks(VENUES.flatMap((v) => COINS.map((c): [string, number] => [`${v}|${c}`, MARK[c]!])), T0);

const ALL: Venue[] = [...VENUES];
const TWO: Venue[] = ['sodex', 'hyperliquid'];
const HL_XYZ: Venue[] = ['hyperliquid', 'tradexyz'];
const NONE: CohortFilter = {};
const ETH: CohortFilter = { coin: 'ETH' };

test('the paged readers give the same rows, in the same order, as the whole-table ones', () => {
  for (const venue of ['sodex', 'hyperliquid', 'lighter', 'arcus'] as Venue[]) {
    for (const size of [1, 7, 2_000, 10_000]) {
      const members: Array<[string, unknown]> = [];
      for (let from = ''; ;) {
        const page = writer.cohortMembersPage(venue, from, size);
        for (const r of page) members.push([r.address, r]);
        if (page.length < size) break;
        from = page[page.length - 1]!.address;
      }
      const books: Array<[string, unknown]> = [];
      for (let from = ''; ;) {
        const page = writer.cohortBooksPage(venue, from, size);
        books.push(...page);
        if (page.length < size) break;
        from = page[page.length - 1]![0];
      }
      if (size === 1 && venue !== 'sodex') continue; // one row at a time: checked on the small venue only
      assert.deepEqual(members, [...writer.cohortMembers(venue)], `${venue} members, pages of ${size}`);
      assert.deepEqual(books, [...writer.cohortBooks(venue)], `${venue} books, pages of ${size}`);
    }
  }
});

test('every cohort answer equals netting and summing the tables in one go', () => {
  _cohortLoad.reset();
  const want = oracle(writer);
  for (const venues of [ALL, TWO, HL_XYZ, ['tradexyz'] as Venue[], ['lighter'] as Venue[]]) {
    const wallets = want.wallets(venues);
    for (const f of [NONE, ETH, { sector: 'majors' } as CohortFilter]) {
      const sums = sumCohorts(wallets, f);
      const stats = sums.cohorts;
      const list = cohortsRead(venues, f)!;
      assert.deepEqual(list.cohorts.map(({ spark: _spark, ...c }) => c), stats.map(({ markets: _markets, ...c }) => c), `${scopeKey(venues)} cohorts`);
      assert.equal(list.at, want.booksAt);
      assert.deepEqual(list.coverage, Object.fromEntries(venues.map((v) => [v, want.coverage[v]])));
      const detail = cohortDetail(venues, 'apex', '7d', f)!;
      assert.deepEqual(detail.cohort, stats.find((x) => x.id === 'apex'));
      const focus = cohortFocus(venues, f, '7d')!;
      assert.deepEqual(focus.cohorts.map((c) => [c.id, c.wallets, c.long, c.short, c.upnl]), stats.map((c) => [c.id, c.wallets, c.long, c.short, c.upnl]));
      assert.deepEqual(focus.total, { long: sums.all.long, short: sums.all.short, upnl: sums.all.upnl, wallets: sums.all.wallets, inProfit: sums.all.inProfit, inLoss: sums.all.inLoss });
      // Every count is of wallets holding a position the filter keeps.
      for (const c of stats) {
        const holders = wallets.filter((w) => cohortsOf(w).includes(c.id) && holdsPosition(w, f) && w.weight === 1).length;
        assert.ok(c.wallets >= holders, `${c.id}: ${c.wallets} >= ${holders}`);
      }
    }
    const all = sumCohorts(wallets, NONE).all;
    const bySector = new Map<string, unknown[]>();
    for (const m of all.markets) {
      if (m.long + m.short > 0) bySector.set(m.sector, [...(bySector.get(m.sector) ?? []), m]);
    }
    assert.deepEqual(Object.fromEntries(cohortMap(venues, null)!.sectors.map((x) => [x.sector, x.assets])), Object.fromEntries(bySector), `${scopeKey(venues)} map`);
    assert.deepEqual(cohortsRead(venues, ETH)!.coins.map((c) => c.coin), all.markets.map((m) => m.coin), 'the asset picker: every coin, unfiltered');
    for (const id of ['whale', 'small', 'rekt'] as const) {
      const rows = cohortWallets(venues, id, NONE, { sort: 'equity', dir: 'desc', offset: 0, limit: 25 })!;
      const expect = wallets.filter((w) => cohortsOf(w).includes(id) && holdsPosition(w, NONE)).map((w) => ({ ...walletRow(w, NONE, '30d'), label: null }))
        .sort((a, b) => (b.equity ?? 0) - (a.equity ?? 0));
      assert.equal(rows.total, expect.length, `${scopeKey(venues)} ${id}: only wallets holding a position`);
      assert.ok(rows.rows.every((r) => r.value !== null && r.lean !== null));
      assert.deepEqual(rows.rows.map((r) => [r.address, r.equity, r.value, r.pnlRange]), expect.slice(0, 25).map((r) => [r.address, r.equity, r.value, r.pnlRange]));
    }
  }
  // A unified Hyperliquid account is sized by its collateral; a standard one by its dexes summed.
  const hl = want.wallets(HL_XYZ);
  const u = hl.find((w) => w.address === addr('hyperliquid', 7))!;
  assert.equal(u.equity, (writer.cohortBook('hyperliquid', u.address)!.equity ?? 0) * 3 + 50_000);
  const std = hl.find((w) => w.address === addr('hyperliquid', 1))!;
  assert.equal(std.equity, (writer.cohortBook('hyperliquid', std.address)!.equity ?? 0) + writer.cohortBook('tradexyz', std.address)!.equity!);
  assert.equal(_cohortLoad.built.inPlace, 1, 'one load served all of it');
});

test('while the pages are in use the load is rebuilt from behind, with what they asked for netted and summed ahead', async () => {
  _cohortLoad.reset();
  const first = cohortsRead(ALL, NONE)!;
  cohortsRead(TWO, ETH);
  assert.deepEqual(_cohortLoad.built, { inPlace: 1, behind: 0 });
  assert.equal(_cohortLoad.state().armed, true, 'a rebuild is scheduled ahead of the expiry');

  // The index moves: a wallet that outweighs everything joins.
  writer.putCohortMembers('sodex', [{ address: addr('sodex', 999_999), pnl: 5e9, equity: 9e9, label: null, pnl1d: null, pnl7d: null, pnl30d: null }], Date.now());
  writer.putCohortBooks([{ venue: 'sodex', address: addr('sodex', 999_999), equity: 9e9, positions: [{ symbol: 'BTC', szi: 1_000_000, entry: 50_000 }], at: Date.now() + 5 }]);
  assert.deepEqual(cohortsRead(ALL, NONE), first, 'inside the minute: the load in use');

  _cohortLoad.age(LOAD_TTL_MS - 10_000);
  await _cohortLoad.rebuild();
  assert.deepEqual(_cohortLoad.built, { inPlace: 1, behind: 1 });
  const st = _cohortLoad.state();
  assert.deepEqual(st.scopes.sort(), [scopeKey(ALL), scopeKey(TWO)].sort(), 'both sets were netted ahead');
  assert.ok(st.stats.includes(`${scopeKey(ALL)}|`) && st.stats.includes(`${scopeKey(TWO)}|c:ETH`), `summed ahead: ${st.stats.join(' ')}`);
  assert.equal(st.armed, true, 'and the next rebuild is scheduled');

  const next = cohortsRead(ALL, NONE)!;
  assert.deepEqual(_cohortLoad.built, { inPlace: 1, behind: 1 }, 'the read built nothing');
  const want = oracle(writer);
  assert.deepEqual(next.cohorts.map(({ spark: _s, ...c }) => c), aggregate(want.wallets(ALL), NONE).map(({ markets: _m, ...c }) => c));
  assert.ok(next.cohorts.find((c) => c.id === 'apex')!.long > first.cohorts.find((c) => c.id === 'apex')!.long + 5e10, 'the new wallet is in');
});

test('a read during a rebuild is answered from the load in use, expired or not', async () => {
  _cohortLoad.reset();
  cohortsRead(ALL, NONE);
  const running = _cohortLoad.rebuild(); // runs its first slice, then gives the thread back
  assert.equal(_cohortLoad.state().rebuilding, true, 'still at work (it yields between slices)');
  _cohortLoad.age(LOAD_TTL_MS + 5_000);
  assert.ok(cohortsRead(ALL, NONE));
  assert.equal(_cohortLoad.built.inPlace, 1, 'no second build inside the request');
  await running;
  assert.deepEqual(_cohortLoad.built, { inPlace: 1, behind: 1 });
});

test('a rebuild that fails leaves the load in use and waits before it tries again', async () => {
  _cohortLoad.reset();
  const before = cohortsRead(TWO, NONE);
  const real = IndexStore.prototype.cohortMembersPage;
  IndexStore.prototype.cohortMembersPage = () => { throw new Error('disk I/O error'); };
  try {
    await _cohortLoad.rebuild();
  } finally {
    IndexStore.prototype.cohortMembersPage = real;
  }
  assert.deepEqual(_cohortLoad.built, { inPlace: 1, behind: 0 });
  assert.equal(_cohortLoad.state().rebuilding, false);
  assert.deepEqual(cohortsRead(TWO, NONE), before, 'still answering');
  assert.equal(_cohortLoad.state().armed, true, 'the next attempt is on a timer, not in a loop');
});

test('once nobody has asked for a while the rebuilds stop; the next read is answered from the old load at once and a rebuild starts behind it', async () => {
  _cohortLoad.reset();
  const before = cohortsRead(TWO, NONE);
  _cohortLoad.age(KEEP_WARM_MS + 1_000);
  await _cohortLoad.rebuild();
  assert.deepEqual(_cohortLoad.built, { inPlace: 1, behind: 0 }, 'nothing was rebuilt for nobody');
  assert.equal(_cohortLoad.state().armed, false);
  assert.deepEqual(cohortsRead(TWO, NONE), before, 'answered from the load it has: no build inside the request');
  assert.deepEqual(_cohortLoad.built, { inPlace: 1, behind: 0 });
  assert.equal(_cohortLoad.state().rebuilding, true, 'a rebuild from behind is under way');
  while (_cohortLoad.state().rebuilding) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(_cohortLoad.built, { inPlace: 1, behind: 1 });
  assert.equal(_cohortLoad.state().armed, true, 'and the next one is scheduled');
});

test('at the start the default page is built from behind, so its first read builds nothing', async () => {
  _cohortLoad.reset();
  await warmCohorts(ALL);
  assert.deepEqual(_cohortLoad.built, { inPlace: 0, behind: 1 });
  assert.ok(_cohortLoad.state().stats.includes(`${scopeKey(ALL)}|`), 'every venue, no filter: summed ahead');
  assert.ok(cohortsRead(ALL, NONE));
  assert.deepEqual(_cohortLoad.built, { inPlace: 0, behind: 1 }, 'the first read built nothing');
});

test('a rebuild from behind lets other work run: no gap near the time the whole build takes', async () => {
  _cohortLoad.reset();
  const big = new IndexStore(DB);
  seed(big, 'tradexyz', 40_000, 7, Date.now());
  big.db.close();

  const t0 = performance.now();
  cohortsRead(ALL, NONE);
  const inPlaceMs = performance.now() - t0;

  let last = performance.now();
  let maxGap = 0;
  let ticks = 0;
  const beat = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    ticks++;
  }, 1);
  last = performance.now();
  const t1 = performance.now();
  await _cohortLoad.rebuild();
  const behindMs = performance.now() - t1;
  clearInterval(beat);

  assert.deepEqual(_cohortLoad.built, { inPlace: 1, behind: 1 });
  assert.ok(ticks >= 5, `other work ran ${ticks} times during the ${behindMs.toFixed(0)} ms rebuild`);
  assert.ok(maxGap < Math.max(120, inPlaceMs / 3), `longest hold ${maxGap.toFixed(0)} ms; the same build in place holds ${inPlaceMs.toFixed(0)} ms`);
});

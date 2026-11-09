/**
 * Run: node --import tsx --test apps/server/test/cohortWorker.test.ts   (from the repo root)
 *
 * The cohort passes on the heatmap thread (indexer/cohortCore.ts, 2026-11-09) give what they give on the indexer's thread:
 * on one fixture of books (empty ones, a venue's own account, every flag the plan reads), members, marks, archive holders,
 * read list, traded wallets and PnL read times - the history step's rows, every venue's plan, the PnL scan, the members'
 * diff (twice: everything, then only what moved) and the open interest rereads (and those equal the one-coin function).
 * Then the tracker itself: its history step threaded = inline, and status() cheap with 300k books.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { VENUES, type Venue } from '../src/valuedesk/types.js';
import { INTERNAL_WALLETS, isExcluded } from '../src/valuedesk/internalWallets.js';
import { liqCoin } from '../src/valuedesk/liquidations/levels.js';
import { liveLink, type LiveLink } from '../src/indexer/liqLiveThread.js';
import {
  MemberSigs, decodeRows, encodeMembers, planDue, pnlScan, recordCompute,
  type Book, type CohortIn, type CohortView, type Member, type MembersWire, type PlanAsk, type PlanOut, type DueList, type RecordOut,
} from '../src/indexer/cohortCore.js';
import { oiRereads, oiRereadsMany, type OiAsk } from '../src/indexer/oiCheck.js';
import { CohortTracker, type CohortDeps } from '../src/indexer/cohortTracker.js';
import { Lane } from '../src/indexer/lanes.js';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

const NOW = Date.UTC(2026, 10, 9, 12, 7);
const DAY = 86_400_000;
const SYMS: Record<Venue, string[]> = {
  hyperliquid: ['BTC', 'ETH', 'SOL', 'kPEPE', 'DOGE'],
  tradexyz: ['xyz:TSLA', 'xyz:NVDA', 'xyz:GOLD'],
  sodex: ['BTC-USD', 'ETH-USD', 'SOL-USD'],
  lighter: ['BTC', 'ETH', 'HYPE'],
  arcus: ['BTC', 'ETH'],
};
const PX: Record<string, number> = { BTC: 80_000, ETH: 3_000, SOL: 150, kPEPE: 0.012, DOGE: 0.2, HYPE: 30, 'xyz:TSLA': 250, 'xyz:NVDA': 120, 'xyz:GOLD': 2_400, 'BTC-USD': 80_010, 'ETH-USD': 3_001, 'SOL-USD': 150.1 };
const SODEX_COINS: ReadonlySet<string> = new Set(['BTC', 'ETH', 'SOL']);
const COUNT: Record<Venue, number> = { hyperliquid: 900, tradexyz: 400, sodex: 300, lighter: 500, arcus: 150 };
const addr = (i: number) => `0x${i.toString(16).padStart(40, '0')}`;

interface World {
  books: Map<Venue, Map<string, Book>>;
  members: Map<Venue, Map<string, Member>>;
  marks: Map<string, number>;
  seeds: Map<Venue, Map<string, number>>;
  readList: string[];
  wanted: Map<Venue, string[]>;
  pnlAt: Map<string, number>;
  unknownLighter: Set<string>;
}

function world(seed: number): World {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const books = new Map<Venue, Map<string, Book>>(VENUES.map((v) => [v, new Map()]));
  const members = new Map<Venue, Map<string, Member>>(VENUES.map((v) => [v, new Map()]));
  for (const v of VENUES) {
    for (let i = 0; i < COUNT[v]; i++) {
      // Hyperliquid and trade.xyz share most addresses (one account), Lighter some of Hyperliquid's: netted across scopes.
      const a = v === 'tradexyz' ? addr(i * 2) : v === 'lighter' && i % 3 === 0 ? addr(i) : addr(i + (VENUES.indexOf(v) + 1) * 100_000);
      const pos = new Map<string, { szi: number; entry: number | null; iso?: number | null; lev?: number | null; fix?: number | null }>();
      const n = r() < 0.25 ? 0 : 1 + Math.floor(r() * 3);
      let ntl = 0;
      for (let j = 0; j < n; j++) {
        const sym = pick(SYMS[v]);
        const usd = 10 * 10 ** (r() * 5.5);
        const p: { szi: number; entry: number | null; iso?: number | null; lev?: number | null; fix?: number | null } = { szi: (r() < 0.5 ? -1 : 1) * usd / PX[sym]!, entry: r() < 0.05 ? null : PX[sym]! * (0.9 + r() * 0.2) };
        const k = r();
        if (k < 0.1) { p.iso = usd * 0.1; p.lev = 10; } else if (k < 0.13) { p.iso = null; p.lev = null; } else if (k < 0.16) p.fix = r() < 0.5 ? null : PX[sym]! * 0.7;
        pos.set(sym, p);
        ntl += usd;
      }
      const eqRoll = r();
      const book: Book = {
        equity: eqRoll < 0.05 ? null : eqRoll < 0.1 ? 0 : ntl * (0.01 + r() * 0.5) + r() * 2e6 * (r() < 0.1 ? 1 : 0.01),
        cash: r() < 0.3 ? null : ntl * 0.2,
        at: NOW - Math.floor(r() ** 2 * 12 * DAY),
        pos,
      };
      if (v === 'hyperliquid' && r() < 0.15) book.collateral = r() < 0.2 ? null : 50_000 * r();
      if (v === 'hyperliquid' && r() < 0.5) book.spotAt = r() < 0.3 ? Date.UTC(2026, 9, 20) : NOW - DAY;
      if (r() < 0.3) book.filledAt = book.at + Math.floor(r() * 3 * 60 * 60_000);
      if (r() < 0.08) book.opened = true;
      if (r() < 0.05) book.liqMiss = true;
      books.get(v)!.set(a, book);
      if (r() < 0.85) {
        const m: Member = { pnl: r() < 0.1 ? null : (r() - 0.4) * 3e6, equity: r() < 0.1 ? null : book.equity ?? r() * 1e6, label: r() < 0.05 ? `w${i}` : null };
        if (v === 'hyperliquid' && r() < 0.6) m.ranked = true;
        const pr = r();
        if (pr < 0.4) m.pnlRange = { '1d': (r() - 0.5) * 1e4, '7d': r() < 0.2 ? null : (r() - 0.5) * 1e5, '30d': (r() - 0.5) * 1e6 };
        else if (pr < 0.6) m.pnlRange = { '7d': (r() - 0.5) * 1e5 };
        members.get(v)!.set(a, m);
      }
    }
    // Members with no book (the leaderboard's, a venue's lists).
    for (let i = 0; i < COUNT[v] / 5; i++) members.get(v)!.set(addr(900_000 + VENUES.indexOf(v) * 10_000 + i), { pnl: (r() - 0.5) * 1e5, equity: r() * 3e6, label: null, ...(v === 'hyperliquid' && r() < 0.5 ? { ranked: true } : {}) });
  }
  // A venue's own account: out of the heatmap and of the cohorts, its book kept (hedged pairs on SoDEX).
  for (const [v, set] of Object.entries(INTERNAL_WALLETS) as Array<[Venue, ReadonlySet<string>]>) {
    for (const a of set) books.get(v)?.set(a, { equity: 5e6, cash: 1e6, at: NOW - DAY, pos: new Map([[SYMS[v][0]!, { szi: 10, entry: PX[SYMS[v][0]!]! }]]) });
  }
  const marks = new Map<string, number>();
  for (const v of VENUES) for (const s of SYMS[v]) if (s !== 'DOGE') marks.set(`${v}|${s}`, PX[s]! * (1 + (r() - 0.5) * 0.01));
  const seeds = new Map<Venue, Map<string, number>>();
  for (const v of ['hyperliquid', 'lighter'] as Venue[]) {
    const m = new Map<string, number>();
    const own = [...books.get(v)!.keys()];
    for (let i = 0; i < 200; i++) m.set(r() < 0.3 ? pick(own) : addr(700_000 + VENUES.indexOf(v) * 10_000 + i), 10 ** (r() * 6));
    seeds.set(v, m);
  }
  const hlAddrs = [...books.get('hyperliquid')!.keys()];
  const readList = Array.from({ length: 300 }, (_, i) => (r() < 0.3 ? pick(hlAddrs) : r() < 0.1 ? [...seeds.get('hyperliquid')!.keys()][i % 200]! : addr(600_000 + i)));
  const wanted = new Map<Venue, string[]>();
  for (const v of VENUES) wanted.set(v, Array.from({ length: 40 }, (_, i) => (r() < 0.3 ? pick([...members.get(v)!.keys()]) : addr(500_000 + VENUES.indexOf(v) * 1_000 + i))));
  const pnlAt = new Map<string, number>();
  for (const a of hlAddrs) if (r() < 0.6) pnlAt.set(a, NOW - Math.floor(r() * 10 * DAY));
  const unknownLighter = new Set([...books.get('lighter')!.keys()].filter(() => r() < 0.3));
  return { books, members, marks, seeds, readList, wanted, pnlAt, unknownLighter };
}

function viewOf(w: World): CohortView {
  return {
    books: (v) => w.books.get(v)!,
    members: (v) => w.members.get(v),
    mark: (k) => w.marks.get(k),
    pnlAt: (a) => w.pnlAt.get(a),
    seeds: (v) => w.seeds.get(v),
    readList: () => w.readList,
    sodexCoins: () => SODEX_COINS,
  };
}

const breathe = () => new Promise<void>((r) => setImmediate(r));
const port = () => 21_000 + Math.floor(Math.random() * 20_000);
const open: LiveLink[] = [];
after(async () => { for (const l of open) await l.stop(); });

/** The heatmap thread handed the world as the tracker hands it: every book in order, the rest as CohortIn before the books. */
function threadOf(w: World): LiveLink {
  const state = (): CohortIn[] => [
    ...VENUES.map((venue): CohortIn => ({ k: 'members', venue, w: encodeMembers(w.members.get(venue)!) })),
    { k: 'seeds', v: [...w.seeds].map(([v, m]): [Venue, string[], Float64Array] => [v, [...m.keys()], Float64Array.from(m.values())]) },
    { k: 'readList', a: w.readList },
    { k: 'pnlAt', a: [...w.pnlAt.keys()], at: Float64Array.from(w.pnlAt.values()), all: true },
  ];
  const l = liveLink({
    source: { account: () => undefined, priceOf: () => null, tiersOf: () => null, priceOfCoin: () => null, wanted: () => false, extra: () => ({}) },
    crossed: () => {},
    now: () => Date.now(),
    breathe,
    book: (v, a) => w.books.get(v)?.get(a),
    noLive: (v, a) => isExcluded(v, a),
    allKeys: () => VENUES.flatMap((v) => [...w.books.get(v)!.keys()].map((a) => `${v}|${a}`)),
    allMarks: () => w.marks,
    allCoinPx: () => [],
    wanted: () => SODEX_COINS,
    cohortState: state,
    port: port(),
  }, true);
  open.push(l);
  for (const v of VENUES) for (const [a, b] of w.books.get(v)!) { if (b.pos.size) l.touch(v, a); else l.changed(v, a); }
  l.start();
  return l;
}

const W = world(42);
const view = viewOf(W);
let thread: LiveLink;

test('the history step: the heatmap thread writes the rows the indexer\'s thread writes', async () => {
  thread = threadOf(W);
  const ask = { seriesT: NOW - (NOW % 900_000), mixT: NOW - (NOW % 3_600_000), doMix: true };
  const inline = await recordCompute(view, ask, breathe, 30);
  const threaded = await thread.cohort({ op: 'record', ask }) as RecordOut;
  assert.ok(inline.series.length >= 31 * 10 && inline.mix.length === inline.series.length, `rows: ${inline.series.length} series, ${inline.mix.length} mix`);
  assert.ok(inline.series.some((s) => s.long > 0) && inline.series.some((s) => s.short > 0));
  assert.deepEqual(threaded, inline);
});

test('every venue\'s plan: the same reads, priorities, totals and counts on either thread', async () => {
  const branches = new Set<number>();
  for (const venue of VENUES) {
    for (const [cap, scan, gap, floor, staleBefore] of [[1_000_000, true, NOW - DAY, 100_000, NOW - 3 * DAY], [50, true, 0, 1_000_000, 0], [0, false, 0, 100_000, 0]] as const) {
      const ask: PlanAsk = { venue, now: NOW, cap, scan, streamed: venue !== 'arcus', gap, floor, staleBefore, startedAt: NOW - 2 * DAY };
      const wanted = W.wanted.get(venue)!;
      const inline = await planDue(view, ask, {
        wanted: { has: (a) => wanted.includes(a), list: () => wanted },
        known: (a) => !W.unknownLighter.has(a),
      }, breathe, 30);
      const threaded = await thread.cohort({ op: 'plan', ask, wanted, unknown: venue === 'lighter' ? [...W.unknownLighter] : [] }) as PlanOut;
      assert.deepEqual(threaded, inline, `${venue} cap ${cap}`);
      if (scan) for (const [, p] of inline.due) branches.add(Math.floor(p / 100));
      if (scan) assert.ok(inline.due.length > 0, `${venue}: something is due`);
    }
  }
  // The fixture reaches the plan's rules: read list (100), tail/reconcile (3xx-4xx), SoDEX schedule (5xx-8xx), refreshes and re-reads (8xx-9xx), new (1xxx).
  for (const b of [1, 4, 9, 10, 11]) assert.ok([...branches].some((x) => x === b || (b >= 10 && x >= b)), `priority band ${b}xx reached: ${[...branches].sort((a, z) => a - z)}`);
});

test('the perp PnL scan: the same holders in the same order', async () => {
  for (const outage of [false, true]) {
    const ask = { now: NOW, perpSince: NOW - 8 * DAY, outage, startedAt: NOW - DAY };
    const inline = await pnlScan(view, ask, breathe, 30);
    const threaded = await thread.cohort({ op: 'pnl', ask }) as DueList;
    assert.ok(inline.a.length > 100);
    assert.deepEqual({ a: threaded.a, p: [...threaded.p] }, { a: inline.a, p: [...inline.p] });
  }
});

test('the members\' diff: every member first, then only the ones that moved, the same rows on either thread', async () => {
  const sigs = new MemberSigs();
  const venue: Venue = 'hyperliquid';
  const first = await sigs.changes(venue, W.members.get(venue)!, breathe, 30);
  const firstT = decodeRows(await thread.cohort({ op: 'members', venue, w: encodeMembers(W.members.get(venue)!) }) as MembersWire);
  assert.equal(first.length, W.members.get(venue)!.size);
  assert.deepEqual(firstT, first);
  const next = new Map([...W.members.get(venue)!].map(([a, m]) => [a, { ...m }]));
  let i = 0;
  for (const m of next.values()) {
    if (i++ % 7 === 0) m.equity = (m.equity ?? 0) * 1.5 + 1_000;
    else if (i % 11 === 0 && m.pnl !== null) m.pnl *= 1.0001; // under three significant digits: no row
  }
  const second = await sigs.changes(venue, next, breathe, 30);
  const secondT = decodeRows(await thread.cohort({ op: 'members', venue, w: encodeMembers(next) }) as MembersWire);
  assert.ok(second.length > 0 && second.length < next.size / 5, `moved: ${second.length}`);
  assert.deepEqual(secondT, second);
  // Put back: the next tests read the fixture's members.
  thread.cohortIn({ k: 'members', venue, w: encodeMembers(W.members.get(venue)!) });
});

test('the open interest rereads: one pass for every coin = the one-coin function, on either thread', async () => {
  for (const venue of ['hyperliquid', 'sodex', 'lighter'] as Venue[]) {
    const coins = [...new Set(SYMS[venue].map(liqCoin))];
    const asks: OiAsk[] = coins.map((coin, i) => ({ coin, limit: 5 + i * 20, sides: i % 2 ? { long: true, short: false } : undefined, gapAt: i % 3 ? NOW - 2 * DAY : undefined }));
    const one = asks.map((a) => oiRereads(W.books.get(venue)!, a.coin, liqCoin, NOW, a.limit, { sides: a.sides, gapAt: a.gapAt }));
    const many = await oiRereadsMany(W.books.get(venue)!.entries(), asks, liqCoin, NOW, breathe, 30);
    assert.deepEqual(many, one, venue);
    assert.deepEqual(await thread.cohort({ op: 'oi', venue, asks, now: NOW }), one, `${venue} on the thread`);
    assert.ok(one.some((l) => l.length > 0));
  }
});

// --- the tracker itself ------------------------------------------------------------------------------

const lane = () => new Lane({ name: 'x', perMin: 1e6 });

type TrackerInside = {
  books: Map<Venue, Map<string, Book>>;
  members: Map<Venue, Map<string, Member>>;
  marks: Map<string, number>;
  sodexCoins: Set<string>;
  seeds: Map<Venue, Map<string, number>>;
  readList: string[];
  live: LiveLink;
  record(): Promise<void>;
  status(): Record<string, unknown>;
  stop(): void;
};

function tracker(w: World, threaded: boolean, store: Record<string, unknown>): TrackerInside {
  process.env.VALUESCAN_LIQ_LIVE_THREAD = threaded ? '1' : '0';
  process.env.VALUESCAN_COHORT_WORKER = threaded ? '1' : '0';
  const deps = {
    store, now: () => NOW, hlSnapshot: async () => null, streamSince: () => 1,
    lighter: { lane: lane(), pacer: {} }, arcus: { lane: lane(), pacer: {} }, sodexGate: () => 0,
  } as unknown as CohortDeps;
  const t = new CohortTracker(deps) as unknown as TrackerInside;
  delete process.env.VALUESCAN_LIQ_LIVE_THREAD;
  delete process.env.VALUESCAN_COHORT_WORKER;
  for (const v of VENUES) t.books.set(v, w.books.get(v)!);
  t.members = w.members;
  t.marks = w.marks;
  t.sodexCoins = new Set(SODEX_COINS);
  return t;
}

test('the tracker\'s history step: threaded writes what inline writes', async () => {
  const written = (into: { series?: unknown; mix?: unknown }) => ({
    putCohortSeries: (rows: unknown) => { into.series = rows; },
    putCohortSeriesSliced: async (rows: unknown) => { into.series = rows; },
    putCohortMix: (rows: unknown) => { into.mix = rows; },
    putCohortMixSliced: async (rows: unknown) => { into.mix = rows; },
    getMeta: () => null,
  });
  const a: { series?: unknown; mix?: unknown } = {};
  const b: { series?: unknown; mix?: unknown } = {};
  const inline = tracker(W, false, written(a));
  const threaded = tracker(W, true, written(b));
  assert.equal(inline.live.threaded, false);
  assert.equal(threaded.live.threaded, true);
  // The start: every book handed to the thread (the members go with cohortState, before the books).
  for (const v of VENUES) for (const [addr2, bk] of W.books.get(v)!) { if (bk.pos.size) threaded.live.touch(v, addr2); else threaded.live.changed(v, addr2); }
  threaded.live.start();
  open.push(threaded.live);
  await inline.record();
  await threaded.record();
  assert.ok(Array.isArray(a.series) && (a.series as unknown[]).length > 0);
  assert.deepEqual(b.series, a.series);
  assert.deepEqual(b.mix, a.mix);
  assert.deepEqual((threaded.status().thread as { cohorts: boolean; ranHere: number }), { cohorts: true, ranHere: 0 });
});

test('status() costs nothing with 300k books, 100k archive holders and a 300k read list', (tc) => {
  const big: World = { ...world(7), books: new Map(VENUES.map((v) => [v, new Map()])) };
  const r = rng(9);
  for (let i = 0; i < 300_000; i++) big.books.get(VENUES[i % 5]!)!.set(addr(i), { equity: r() * 1e5, at: NOW, pos: new Map([['BTC', { szi: 1, entry: 1 }]]) });
  const t = tracker(big, false, { getMeta: () => null });
  t.seeds = new Map([['hyperliquid', new Map(Array.from({ length: 100_000 }, (_, i): [string, number] => [addr(i * 3), 1]))]]);
  t.readList = Array.from({ length: 300_000 }, (_, i) => addr(i * 7));
  t.status();
  const t0 = performance.now();
  for (let i = 0; i < 100; i++) t.status();
  const per = (performance.now() - t0) / 100;
  // Before: the unread counts went over the archive's holders and the read list on every call (2026-11-08: 1.5-3.5% of a profile).
  const o0 = performance.now();
  let unread = 0;
  for (const k of t.seeds.get('hyperliquid')!.keys()) if (!t.books.get('hyperliquid')!.has(k)) unread++;
  for (const a of t.readList) if (!t.books.get('hyperliquid')!.has(a)) unread++;
  const old = performance.now() - o0;
  tc.diagnostic(`status() ${per.toFixed(3)} ms a call; the counts it made before took ${old.toFixed(1)} ms (${unread} unread)`);
  assert.ok(per < 0.5, `status() ${per.toFixed(3)} ms a call (the counts alone took ${old.toFixed(1)} ms, ${unread} unread)`);
});

test('a pass the heatmap thread cannot run (it is down) runs on this thread: the history is still written', async () => {
  const a: { series?: unknown } = {};
  const b: { series?: unknown } = {};
  const store = (into: { series?: unknown }) => ({ putCohortSeries: (rows: unknown) => { into.series = rows; }, putCohortSeriesSliced: async (rows: unknown) => { into.series = rows; }, putCohortMix: () => {}, putCohortMixSliced: async () => {}, getMeta: () => null });
  const inline = tracker(W, false, store(a));
  const threaded = tracker(W, true, store(b));
  threaded.live.start();
  await threaded.live.stop();
  await inline.record();
  await threaded.record();
  assert.deepEqual(b.series, a.series);
  assert.equal((threaded.status().thread as { ranHere: number }).ranHere, 1);
});

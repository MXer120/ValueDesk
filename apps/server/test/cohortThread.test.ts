/**
 * Run: npx tsx --test test/cohortThread.test.ts   (from apps/server)
 *
 * The cohort jobs on their own thread (indexer/cohortThread.ts) answer what they answer inline, the venues' markets coming
 * from this thread (the tiers' `now` flag kept), and the load's internal open
 * interest arriving here for the live heatmap.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IndexStore } from '../src/indexer/store.js';
import type { Venue } from '../src/valuedesk/types.js';
import type { VenueMarkets } from '../src/valuedesk/liquidations/rules.js';
import { tiersOf } from '../src/valuedesk/liquidations/math.js';
import { INTERNAL_WALLETS } from '../src/valuedesk/internalWallets.js';

const dir = mkdtempSync(join(tmpdir(), 'vs-cohort-thread-'));
const DB = join(dir, 'index.db');
process.env.VALUESCAN_INDEX_DB = DB;

const COINS = ['BTC', 'ETH', 'SOL', 'xyz:TSLA'];
const MARK: Record<string, number> = { BTC: 60_000, ETH: 3_000, SOL: 150, 'xyz:TSLA': 250 };
const addr = (venue: string, i: number) => `0x${venue.slice(0, 2)}${String(i).padStart(38, '0')}`.slice(0, 42);

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

const T0 = Date.now();
const writer = new IndexStore(DB);
for (const [venue, n, sd] of [['sodex', 300, 1], ['hyperliquid', 900, 2]] as Array<[Venue, number, number]>) {
  const r = rng(sd);
  const members = [];
  const books = [];
  for (let i = 0; i < n; i++) {
    const address = addr(venue, i);
    const equity = Math.round(r() ** 3 * 5_000_000);
    members.push({ address, pnl: Math.round((r() - 0.45) * 2_000_000), equity, label: i % 40 === 0 ? `name ${i}` : null, pnl1d: null, pnl7d: Math.round((r() - 0.5) * 50_000), pnl30d: Math.round((r() - 0.5) * 100_000) });
    if (i % 3 !== 0) {
      books.push({ venue, address, equity, at: T0 - 1_000, positions: Array.from({ length: 1 + Math.floor(r() * 3) }, () => {
        const symbol = COINS[Math.floor(r() * COINS.length)]!;
        return { symbol, szi: Math.round((r() - 0.45) * 1000) / 10, entry: MARK[symbol]! * (0.9 + r() * 0.2) };
      }) });
    }
  }
  writer.putCohortMembers(venue, members, T0);
  writer.putCohortBooks(books);
}
// SoDEX's own BTC pair: internal open interest the live heatmap takes off.
const pair = [...(INTERNAL_WALLETS.sodex ?? [])].slice(0, 2);
if (pair.length === 2) {
  writer.putCohortMembers('sodex', pair.map((address) => ({ address, pnl: 1, equity: 10_000_000, label: null, pnl1d: null, pnl7d: null, pnl30d: null })), T0);
  writer.putCohortBooks(pair.map((address, k) => ({ venue: 'sodex' as Venue, address, equity: 10_000_000, positions: [{ symbol: 'BTC-USD', szi: k ? 900 : -900, entry: 60_000 }], at: T0 })));
}
writer.putCohortMarks((['sodex', 'hyperliquid'] as Venue[]).flatMap((v) => COINS.map((c): [string, number] => [`${v}|${c}`, MARK[c]!])), T0);

after(async () => {
  const { stopCohortThread } = await import('../src/indexer/cohortThread.js');
  await stopCohortThread();
  writer.close();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* a handle on Windows */ }
});

/** The answer without the load's own times (two loads are built, a moment apart). */
function same(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(same);
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'at' && k !== 'asOf' && k !== 'booksAt').map(([k, v]) => [k, same(v)]));
  return x;
}

test('every cohort job on the thread answers what it answers inline; markets come from this thread with their tiers whole', async () => {
  const L = await import('../src/indexer/liqRead.js');
  const C = await import('../src/indexer/cohortThread.js');
  const R = await import('../src/indexer/read.js');
  // BTC priced from the tiers; SOL's carry `now` (the venue publishes its levels, none computed): were the flag lost on
  // the way to the thread, its SOL answer would differ from the inline one.
  const plain = tiersOf([{ lb: 0, r: 0.01 }, { lb: 1_000_000, r: 0.02 }]);
  const flagged = tiersOf([{ lb: 0, r: 0.01 }, { lb: 1_000_000, r: 0.02 }], { now: true });
  const markets = (venues: readonly Venue[]) => new Map<Venue, VenueMarkets | null>(venues.map((v) => [v, {
    tiers: new Map(COINS.map((c) => [v === 'sodex' && c === 'BTC' ? 'BTC-USD' : c, c === 'SOL' ? flagged : plain])),
    oi: new Map(COINS.map((c) => [v === 'sodex' && c === 'BTC' ? 'BTC-USD' : c, { oi: 10_000, px: MARK[c]! }])),
    at: T0,
  }]));
  let asked = 0;
  // This thread's markets (the venues are never asked in a test); the thread's asks come here.
  L.setMarketsSource(async (venues) => { asked++; return { markets: markets(venues), sodex: null }; });
  const V: Venue[] = ['sodex', 'hyperliquid'];
  const someone = addr('hyperliquid', 1);
  const jobs: Parameters<typeof C.cohortJob>[0][] = [
    { op: 'cohorts', venues: V, f: {} },
    { op: 'cohorts', venues: ['hyperliquid'], f: { coin: 'ETH' } },
    { op: 'detail', venues: V, cohort: 'whale' as never, range: '7d', f: {} },
    { op: 'map', venues: V, cohort: null },
    { op: 'focus', venues: V, f: { coin: 'BTC' }, range: '7d' },
    { op: 'wallets', venues: V, cohort: 'whale' as never, f: {}, o: { sort: 'equity', dir: 'desc', offset: 0, limit: 20, range: '30d' } },
    { op: 'excluded' },
    { op: 'liqOf', coin: 'BTC', venues: ['hyperliquid'], wallets: [someone] },
    { op: 'liqFine', coin: 'BTC', venues: ['hyperliquid'], ask: { step: 1_000, from: 1_000, to: 200_000 }, wallets: [], side: null, lev: null },
    { op: 'liqWallets', coin: 'BTC', venues: ['hyperliquid'], side: 'long', from: 1, to: 1e9, limit: 25, wallets: [], lev: null },
    { op: 'positions', venues: ['hyperliquid'], wallets: [someone] },
    { op: 'liqFine', coin: 'SOL', venues: ['hyperliquid'], ask: { step: 5, from: 5, to: 300 }, wallets: [], side: null, lev: null },
  ];
  process.env.VALUESCAN_COHORT_THREAD = '0';
  const inline: Array<string | null> = [];
  for (const j of jobs) inline.push(await C.cohortJob(j));
  R._cohortLoad.reset();
  process.env.VALUESCAN_COHORT_THREAD = '1';
  try {
    const askedInline = asked;
    for (let i = 0; i < jobs.length; i++) {
      const t = await C.cohortJob(jobs[i]!);
      assert.ok(t !== null && inline[i] !== null, `${jobs[i]!.op}: an answer`);
      assert.deepEqual(same(JSON.parse(t!)), same(JSON.parse(inline[i]!)), jobs[i]!.op);
    }
    assert.ok(asked > askedInline, 'the thread asked this thread for the markets');
    // The markets as they cross to the thread (a structured clone): tiers whole, their `now` flag kept.
    const m = markets(['hyperliquid']);
    const back = structuredClone(m);
    const hl = back.get('hyperliquid')!;
    assert.deepEqual([...hl.tiers.get('BTC')!], [...plain]);
    assert.equal(hl.tiers.get('SOL')!.now, true);
    assert.equal(hl.tiers.get('BTC')!.now, undefined);
    assert.deepEqual(hl.oi.get('ETH'), { oi: 10_000, px: 3_000 });
    assert.equal(R.cohortInternal(), null, 'no load on this thread');
    // The internal open interest of the thread's load reaches this thread.
    if (pair.length === 2) {
      for (let k = 0; k < 40 && R.internalOiNow('sodex', 'BTC') === 0; k++) await new Promise((r) => setTimeout(r, 100));
      assert.ok(R.internalOiNow('sodex', 'BTC') > 0, 'internal OI pushed');
    }
    assert.ok(C.cohortThreadStats.done >= jobs.length);
  } finally {
    delete process.env.VALUESCAN_COHORT_THREAD;
    L.setMarketsSource(null);
  }
});

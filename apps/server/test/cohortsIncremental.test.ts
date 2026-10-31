/**
 * The cohort load kept current from what changed (indexer/read.ts INCREMENTAL, store.ts
 * COHORT_REV_SCHEMA) gives exactly what a load read in full from the same file gives: after
 * random member and book writes, members removed (and back), excluded wallets, a margin
 * sibling's book, a tail whose counting rate flips and marks that move - load after load.
 *
 *   npx tsx --test test/cohortsIncremental.test.ts   (from apps/server)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { COHORT_TOMB_KEEP_MS, IndexStore, type CohortMemberRow } from '../src/indexer/store.js';
import { TAIL_FULL_SHARE } from '../src/indexer/cohortTracker.js';
import { HEDGED_WALLETS, INTERNAL_WALLETS } from '../src/valuedesk/internalWallets.js';
import { LOAD_TTL_MS, _cohortLoad, cohortBooksNow, cohortMap, cohortWallets, cohortsRead, excludedNow, internalOiNow, warmCohorts } from '../src/indexer/read.js';
import type { CohortFilter } from '../src/valuedesk/cohorts/model.js';
import { VENUES, type Venue } from '../src/valuedesk/types.js';

const dir = mkdtempSync(join(tmpdir(), 'vs-cohorts-inc-'));
const DB = join(dir, 'index.db');
process.env.VALUESCAN_INDEX_DB = DB;
after(() => {
  _cohortLoad.reset();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* a handle still open on Windows */ }
});

const COINS = ['BTC', 'ETH', 'SOL', 'DOGE', 'HYPE', 'xyz:TSLA', 'LINK', 'PEPE', 'BTC-USD'];
const MARK: Record<string, number> = { BTC: 60_000, ETH: 3_000, SOL: 150, DOGE: 0.2, HYPE: 40, 'xyz:TSLA': 250, LINK: 15, PEPE: 0.00001, 'BTC-USD': 60_000 };
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
const r = rng(42);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const addr = (venue: string, i: number) => `0x${(venue === 'tradexyz' ? 'hy' : venue.slice(0, 2))}${i.toString(16).padStart(38, '0')}`;
/** Addresses per venue (trade.xyz shares Hyperliquid's: the same accounts' xyz dex). */
const N: Record<Venue, number> = { sodex: 300, hyperliquid: 1_200, tradexyz: 600, lighter: 1_500, arcus: 300 };
const EXCLUDED: Array<[Venue, string]> = [
  ...[...(INTERNAL_WALLETS.sodex ?? [])].map((a): [Venue, string] => ['sodex', a]),
  ...[...(HEDGED_WALLETS.hyperliquid ?? [])].slice(0, 2).map((a): [Venue, string] => ['hyperliquid', a]),
];

function member(address: string, small = false): CohortMemberRow {
  const equity = small ? Math.round(r() * 9_000) : r() < 0.1 ? null : Math.round(r() ** 4 * 8_000_000 * 100) / 100;
  return {
    address, pnl: r() < 0.05 ? null : Math.round((r() - 0.45) * 3_000_000), equity, label: r() < 0.05 ? `name ${address.slice(-3)}` : null,
    pnl1d: r() < 0.5 ? Math.round((r() - 0.5) * 10_000) : null, pnl7d: Math.round((r() - 0.5) * 50_000), pnl30d: r() < 0.2 ? null : Math.round((r() - 0.5) * 200_000),
  };
}
function book(venue: Venue, address: string, small = false) {
  const positions = Array.from({ length: Math.floor(r() * 4) }, () => {
    const symbol = venue === 'tradexyz' ? 'xyz:TSLA' : pick(COINS);
    return { symbol, szi: Math.round((r() - 0.4) * 1000) / 10, entry: r() < 0.9 ? MARK[symbol]! * (0.8 + r() * 0.4) : null };
  });
  const equity = small ? Math.round(r() * 9_000) : Math.round(r() ** 4 * 8_000_000 * 100) / 100;
  const unified = venue === 'hyperliquid' && r() < 0.15;
  return { venue, address, equity, positions, at: Date.now() - Math.floor(r() * 100_000), collateral: unified ? equity * 3 + 50_000 : null, spotAt: unified ? Date.now() : null, cash: r() < 0.5 ? r() * 1000 : null };
}
const marks = new Map<string, number>(VENUES.flatMap((v) => COINS.map((c): [string, number] => [`${v}|${c}`, MARK[c]!])));

const writer = new IndexStore(DB);
// The start: every venue's members and books; Lighter's members all in the tail and all read
// (so its rate is the full one until wallets with no book join).
for (const v of VENUES) {
  const lighter = v === 'lighter';
  writer.putCohortMembers(v, Array.from({ length: N[v] }, (_, i) => i).filter((i) => lighter || i % 9 !== 0).map((i) => member(addr(v, i), lighter)), Date.now());
  writer.putCohortBooks(Array.from({ length: N[v] }, (_, i) => i).filter((i) => lighter || i % 3 !== 0).map((i) => book(v, addr(v, i), lighter)));
}
writer.putCohortMembers('sodex', EXCLUDED.filter(([v]) => v === 'sodex').map(([, a]) => member(a)), Date.now());
writer.putCohortBooks(EXCLUDED.map(([v, a]) => ({ ...book(v, a), positions: [{ symbol: v === 'sodex' ? 'BTC-USD' : 'BTC', szi: -900 + r() * 10, entry: 60_000 }] })));
// The same addresses on Arcus, where they are not excluded: every set with SoDEX or Hyperliquid
// in it leaves them out (outOfCohorts), Arcus alone counts them.
writer.putCohortMembers('arcus', EXCLUDED.map(([, a]) => member(a)), Date.now());
writer.putCohortBooks(EXCLUDED.map(([, a]) => book('arcus', a)));
writer.putCohortMarks([...marks], Date.now());

/** One minute of the indexer: members and books rewritten, some members gone (one comes back), new wallets, marks. */
function minute(): void {
  for (const v of VENUES) {
    const n = N[v];
    const some = (k: number) => Array.from({ length: k }, () => Math.floor(r() * n * 1.1));
    writer.putCohortMembers(v, [...new Set(some(Math.ceil(n * 0.03)))].map((i) => member(addr(v, i), v === 'lighter')), Date.now());
    writer.putCohortBooks([...new Set(some(Math.ceil(n * 0.03)))].map((i) => book(v, addr(v, i), v === 'lighter')));
    const gone = [...new Set(some(Math.ceil(n * 0.01)))].map((i) => addr(v, i));
    writer.dropCohortMembers(v, gone);
    // Back within the same minute: the tombstone and the new row are read in the order they were written.
    if (gone.length) writer.putCohortMembers(v, [member(gone[0]!, v === 'lighter')], Date.now());
  }
  // An excluded wallet's book moves too (the excluded page and the heatmap's OI read it).
  const [ev, ea] = pick(EXCLUDED);
  writer.putCohortBooks([{ ...book(ev, ea), positions: [{ symbol: ev === 'sodex' ? 'BTC-USD' : 'BTC', szi: -900 + r() * 10, entry: 60_000 }] }]);
  writer.putCohortBooks([book('arcus', pick(EXCLUDED)[1])]);
  if (r() < 0.5) writer.dropCohortMembers('arcus', [pick(EXCLUDED)[1]]);
  else writer.putCohortMembers('arcus', [member(pick(EXCLUDED)[1])], Date.now());
  // Some marks move.
  for (const k of marks.keys()) if (r() < 0.3) marks.set(k, marks.get(k)! * (0.98 + r() * 0.04));
  const rows = [...marks];
  writer.putCohortMarks(rows, Date.now());
}

const ALL: Venue[] = [...VENUES];
const TWO: Venue[] = ['sodex', 'hyperliquid'];
const HL_XYZ: Venue[] = ['hyperliquid', 'tradexyz'];
const LIGHTER: Venue[] = ['lighter'];
const ARCUS: Venue[] = ['arcus'];
const SODEX_ARCUS: Venue[] = ['sodex', 'arcus'];
const SCOPES = [ALL, TWO, HL_XYZ, LIGHTER, ARCUS, SODEX_ARCUS];
const FILTERS: CohortFilter[] = [{}, { coin: 'ETH' }, { sector: 'majors' } as CohortFilter];

/** Everything the pages read, with the load's own time taken out. */
function answers() {
  const out: Record<string, unknown> = {};
  for (const venues of SCOPES) {
    for (const f of FILTERS) {
      const { asOf: _a, ...list } = cohortsRead(venues, f)!;
      out[`list ${venues} ${JSON.stringify(f)}`] = list;
    }
    out[`map ${venues}`] = cohortMap(venues, null);
    out[`map whale ${venues}`] = cohortMap(venues, 'whale');
    for (const id of ['whale', 'small', 'rekt', 'apex'] as const) {
      for (const sort of ['equity', 'upnl', 'pnl'] as const) {
        const { asOf: _a, ...rows } = cohortWallets(venues, id, {}, { sort, dir: 'desc', offset: 0, limit: 40 })!;
        out[`wallets ${venues} ${id} ${sort}`] = rows;
      }
    }
  }
  out.oi = VENUES.flatMap((v) => ['BTC', 'ETH'].map((c) => internalOiNow(v, c)));
  out.excluded = excludedNow();
  return out;
}

/** The load in use against one read in full from the same file: every table and every answer. */
function sameAsFull(label: string): void {
  const inc = _cohortLoad.dump(SCOPES)!;
  const incAnswers = answers();
  const full = _cohortLoad.withFull(() => ({ dump: _cohortLoad.dump(SCOPES)!, answers: answers() }));
  // The per-venue maps in the same order (the sums iterate them), then everything else.
  for (const [i, [v, entries]] of inc.per.entries()) {
    const want = full.dump.per[i]!;
    assert.equal(v, want[0], `${label}: venue order`);
    assert.deepEqual((entries as Array<[string, unknown]>).map(([a]) => a), (want[1] as Array<[string, unknown]>).map(([a]) => a), `${label}: ${v} address order`);
  }
  assert.deepEqual(inc, full.dump, `${label}: the load`);
  assert.deepEqual(incAnswers, full.answers, `${label}: the answers`);
}

test('load after load, the load kept current equals a load read in full', async () => {
  _cohortLoad.reset();
  await warmCohorts(ALL);
  answers(); // every scope and filter asked: the rebuilds net and sum them ahead
  sameAsFull('the first load');
  assert.deepEqual(_cohortLoad.kind, { full: 2, incremental: 0 }, 'the first load and the comparison: both in full');

  // Lighter's tail: a few wallets with no book join, the share read drops under TAIL_FULL_SHARE and
  // every Lighter wallet counts as the old sample; once they are read it flips back.
  const sampled: number[] = [];
  const lighterNew = Array.from({ length: Math.ceil(N.lighter * (1 - TAIL_FULL_SHARE) * 3) }, (_, i) => addr('lighter', 50_000 + i));
  for (let i = 0; i < 8; i++) {
    minute();
    if (i === 2) writer.putCohortMembers('lighter', lighterNew.map((a) => member(a, true)), Date.now());
    if (i === 5) {
      const unread = [...writer.cohortMembers('lighter').keys()].filter((a) => !writer.cohortBook('lighter', a));
      writer.putCohortBooks(unread.map((a) => book('lighter', a, true)));
    }
    // A member leaves while its book stays; a trade.xyz book moves its Hyperliquid twin's perp equity.
    if (i === 3) writer.dropCohortMembers('hyperliquid', [addr('hyperliquid', 1), addr('hyperliquid', 2)]);
    if (i === 4) writer.putCohortBooks([{ ...book('tradexyz', addr('hyperliquid', 1)), equity: 4_000_000 }]);
    _cohortLoad.age(LOAD_TTL_MS);
    await _cohortLoad.rebuild();
    sameAsFull(`load ${i + 2}`);
    const weights = new Set([...cohortBooksNow()!.per.get('lighter')!.values()].map((w) => w.weight));
    if (weights.has(10)) sampled.push(i);
  }
  assert.ok(sampled.includes(2) && sampled.includes(4), `Lighter counted as its old sample once wallets with no book joined (loads ${sampled})`);
  assert.ok(!sampled.includes(5) && !sampled.includes(7), 'and every wallet as itself once they were read');
  assert.equal(_cohortLoad.kind.incremental, 8, 'every later load from what changed');
});

test('a load whose removals were pruned in the meantime reads everything again, and still equals a full one', async () => {
  _cohortLoad.reset();
  await warmCohorts(ALL);
  answers();
  minute();
  _cohortLoad.age(LOAD_TTL_MS);
  await _cohortLoad.rebuild();
  assert.deepEqual(_cohortLoad.kind, { full: 1, incremental: 1 });
  // Removals the load has not read, then pruned: their tombstones are past keeping.
  const old = Date.now() - COHORT_TOMB_KEEP_MS - 60_000;
  writer.dropCohortMembers('arcus', [addr('arcus', 10), addr('arcus', 11)], old);
  writer.dropCohortMembers('arcus', [addr('arcus', 12)]);
  assert.ok(writer.cohortRevState()!.floor > 0, 'the old tombstones are gone');
  _cohortLoad.age(LOAD_TTL_MS);
  await _cohortLoad.rebuild();
  assert.deepEqual(_cohortLoad.kind, { full: 2, incremental: 1 }, 'read in full: it could not know what was removed');
  sameAsFull('after the gap');
  minute();
  _cohortLoad.age(LOAD_TTL_MS);
  await _cohortLoad.rebuild();
  assert.equal(_cohortLoad.kind.incremental, 2, 'and from what changed again after it');
  sameAsFull('the load after the gap');
});

test('the write sequence: every put and removal numbered in order, the reader sees only what came after', () => {
  const s0 = writer.cohortRevState()!;
  writer.putCohortMembers('sodex', [member(addr('sodex', 7))], Date.now());
  writer.putCohortBooks([book('sodex', addr('sodex', 7)), book('sodex', addr('sodex', 8))]);
  writer.dropCohortMembers('sodex', [addr('sodex', 7), addr('sodex', 999_999)]); // the second was never a member: no tombstone
  const s1 = writer.cohortRevState()!;
  assert.equal(s1.rev, s0.rev + 4, 'one member, two books, one removal');
  assert.equal(s1.epoch, s0.epoch);
  assert.deepEqual(writer.cohortMembersSince('sodex', s0.rev, s1.rev, 10), [], 'the member put is gone again');
  assert.deepEqual(writer.cohortBooksSince('sodex', s0.rev, s1.rev, 10).map((x) => [x.address, x.rev]), [[addr('sodex', 7), s0.rev + 2], [addr('sodex', 8), s0.rev + 3]]);
  assert.deepEqual(writer.cohortTombsSince('sodex', s0.rev, s1.rev), [{ kind: 'm', address: addr('sodex', 7), rev: s0.rev + 4 }]);
  assert.deepEqual(writer.cohortBooksSince('sodex', s1.rev, s1.rev, 10), [], 'nothing after the last number');
  // A second writer on the file (a test's, compact.ts) carries on the same sequence.
  const other = new IndexStore(DB);
  other.putCohortBooks([book('arcus', addr('arcus', 3))]);
  other.db.close();
  assert.equal(writer.cohortRevState()!.rev, s1.rev + 1);
});

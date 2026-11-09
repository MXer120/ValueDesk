/**
 * GET /api/vs/wallet/fills - a tracked wallet's fills from the index (indexer/walletFills.ts): answered only
 * for the span coverage says is complete, in the VsFill shape the venues' reads answer, newest first.
 */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { FillRow, IndexStore } from '../src/indexer/store.js';

const dir = mkdtempSync(join(tmpdir(), 'vs-walletfills-'));
process.env.VALUESCAN_INDEX_DB = join(dir, 'index.db');

const DAY = 86_400_000;
const NOW = Date.now();
const HL = '0x' + 'a'.repeat(40);
const LATE = '0x' + 'b'.repeat(40);
const SODEX = '0x' + 'c'.repeat(40);
const NEW = '0x' + 'd'.repeat(40);
const UNKNOWN = '0x' + 'e'.repeat(40);
const BUSY = '0x' + 'f'.repeat(40);

let store: IndexStore;
let app: FastifyInstance;

const fill = (venue: FillRow['venue'], address: string, id: string, t: number, over: Partial<FillRow> = {}): FillRow => ({
  venue, address, id, t, symbol: 'BTC', side: 1, px: 100_000, sz: 0.01, fee: 0.4, closedPnl: null, oid: `o${id}`, src: 1, ...over,
});

before(async () => {
  const { IndexStore } = await import('../src/indexer/store.js');
  store = new IndexStore(process.env.VALUESCAN_INDEX_DB!);
  store.putFills([
    fill('hyperliquid', HL, '11', NOW - 20 * DAY, { side: -1, closedPnl: 12.5 }),
    fill('hyperliquid', HL, '12', NOW - 2 * DAY, { symbol: 'ETH', px: 3_000, sz: 2, fee: null }),
    fill('hyperliquid', HL, '13', NOW - 2 * DAY, { symbol: 'ETH', px: 3_000, sz: 1 }),
    fill('hyperliquid', HL, '14', NOW - 10_000),
    // Older than the held span: not part of any answer.
    fill('hyperliquid', HL, '10', NOW - 50 * DAY),
    fill('hyperliquid', LATE, '21', NOW - 3 * DAY),
    fill('hyperliquid', LATE, '22', NOW - 2 * DAY),
    fill('hyperliquid', LATE, '23', NOW - 1 * DAY),
    fill('sodex', SODEX, 'BTC-USD:1', NOW - 5 * DAY, { symbol: 'BTC-USD' }),
    fill('hyperliquid', NEW, '31', NOW - 3 * DAY),
  ]);
  store.addCoverage('hyperliquid', HL, 'fills', { fromT: NOW - 40 * DAY, toT: NOW - 30_000 }, NOW);
  // Held from 7 days back only.
  store.addCoverage('hyperliquid', LATE, 'fills', { fromT: NOW - 7 * DAY, toT: NOW - 10 * 60_000 }, NOW);
  // SoDEX perps held, spot not: its fill list is both engines.
  store.addCoverage('sodex', SODEX, 'perps', { fromT: NOW - 40 * DAY, toT: NOW }, NOW);
  // A wallet the venue has nothing older for: its whole history is held.
  store.addCoverage('hyperliquid', NEW, 'fills', { fromT: NOW - 4 * DAY, toT: NOW, exhausted: true }, NOW);
  // A busy wallet: 700 fills, two to a millisecond, held up to an hour ago.
  store.putFills(Array.from({ length: 700 }, (_, i) => fill('hyperliquid', BUSY, `b${String(i).padStart(4, '0')}`, NOW - 2 * 3_600_000 - Math.floor(i / 2) * 60_000)));
  store.addCoverage('hyperliquid', BUSY, 'fills', { fromT: NOW - 10 * DAY, toT: NOW - 3_600_000 }, NOW);
  // Held on Arcus, which the route does not answer (its stream prints sit beside REST fills).
  store.putFills([fill('arcus', SODEX, 'a1', NOW - DAY)]);
  store.addCoverage('arcus', SODEX, 'fills', { fromT: NOW - 40 * DAY, toT: NOW }, NOW);

  const { valuedeskRoutes } = await import('../src/routes/valuedesk.js');
  app = Fastify();
  await app.register(valuedeskRoutes);
  await app.ready();
});

after(async () => {
  await app?.close();
  const { closeReader } = await import('../src/indexer/reader.js');
  closeReader();
  store?.close();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle */ }
});

const get = async (q: string) => {
  const r = await app.inject({ method: 'GET', url: `/api/vs/wallet/fills?${q}` });
  return { status: r.statusCode, body: r.json(), cache: r.headers['cache-control'] };
};

test('covered: the window\'s fills newest first, in the venues\' VsFill shape, with how far the index holds', async () => {
  const from = NOW - 30 * DAY;
  const { status, body } = await get(`venue=hyperliquid&address=${HL.toUpperCase().replace('0X', '0x')}&from=${from}&limit=5000`);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.covered, true);
  assert.equal(body.heldTo, NOW - 30_000);
  // 14 is after heldTo (the browser reads that tail from the venue); 10 is before `from`.
  assert.deepEqual(body.fills.map((f: { id: string }) => f.id), ['13', '12', '11']);
  for (const f of body.fills) {
    assert.deepEqual(Object.keys(f), ['id', 'time', 'symbol', 'side', 'px', 'sz', 'notional', 'fee', 'closedPnl', 'dir', 'oid']);
  }
  assert.deepEqual(body.fills[1], { id: '12', time: NOW - 2 * DAY, symbol: 'ETH', side: 'buy', px: 3_000, sz: 2, notional: 6_000, fee: null, closedPnl: null, dir: null, oid: 'o12' });
  assert.equal(body.fills[2].side, 'sell');
  assert.equal(body.fills[2].closedPnl, 12.5);
});

test('covered: `limit` keeps the newest, `to` cuts the end', async () => {
  const from = NOW - 30 * DAY;
  const two = await get(`venue=hyperliquid&address=${HL}&from=${from}&limit=2`);
  assert.deepEqual(two.body.fills.map((f: { id: string }) => f.id), ['13', '12']);
  const early = await get(`venue=hyperliquid&address=${HL}&from=${from}&to=${NOW - 10 * DAY}&limit=50`);
  assert.equal(early.body.covered, true);
  assert.deepEqual(early.body.fills.map((f: { id: string }) => f.id), ['11']);
});

test('not covered: the index holds the wallet from a later time than asked, an unknown wallet, a missing engine', async () => {
  const from = NOW - 30 * DAY;
  const late = await get(`venue=hyperliquid&address=${LATE}&from=${from}&limit=5000`);
  assert.equal(late.status, 200);
  assert.deepEqual(Object.keys(late.body).sort(), ['covered', 'ok', 'reason']);
  assert.equal(late.body.covered, false);
  assert.equal((await get(`venue=hyperliquid&address=${UNKNOWN}&from=${from}&limit=5000`)).body.covered, false);
  assert.equal((await get(`venue=sodex&address=${SODEX}&from=${from}&limit=5000`)).body.covered, false, 'SoDEX spot is not held');
  assert.equal((await get(`venue=arcus&address=${SODEX}&from=${from}&limit=5000`)).body.covered, false, 'Arcus is not answered');
  assert.equal((await get(`venue=tradexyz&address=${HL}&from=${from}&limit=5000`)).body.covered, false, 'trade.xyz is not answered');
  // No `from`: "the newest N" is only known complete when the held span has N.
  assert.equal((await get(`venue=hyperliquid&address=${LATE}&limit=200`)).body.covered, false);
  // More than one answer carries.
  assert.equal((await get(`venue=hyperliquid&address=${HL}&from=${from}&limit=20000`)).body.covered, false);
});

test('covered although the window starts earlier: the newest `limit` all fall inside the held span', async () => {
  const r = await get(`venue=hyperliquid&address=${LATE}&from=${NOW - 30 * DAY}&limit=3`);
  assert.equal(r.body.covered, true);
  assert.deepEqual(r.body.fills.map((f: { id: string }) => f.id), ['23', '22', '21']);
  assert.equal((await get(`venue=hyperliquid&address=${LATE}&limit=2`)).body.covered, true);
});

test('covered from any time when the venue has nothing older (exhausted)', async () => {
  const r = await get(`venue=hyperliquid&address=${NEW}&from=${NOW - 30 * DAY}&limit=5000`);
  assert.equal(r.body.covered, true);
  assert.deepEqual(r.body.fills.map((f: { id: string }) => f.id), ['31']);
});

test('a from that is not on a five-minute step is cut exactly, from the kept copy', async () => {
  const from = NOW - 2 * DAY + 1; // just after fills 12 and 13
  const r = await get(`venue=hyperliquid&address=${HL}&from=${from}&limit=5000`);
  assert.equal(r.body.covered, true);
  assert.deepEqual(r.body.fills.map((f: { id: string }) => f.id), []);
  const r2 = await get(`venue=hyperliquid&address=${HL}&from=${NOW - 2 * DAY}&limit=5000`);
  assert.deepEqual(r2.body.fills.map((f: { id: string }) => f.id), ['13', '12']);
});

test('bad requests are 400s; the read walks fills_t backwards with no sort', async () => {
  assert.equal((await get('venue=hyperliquid&address=0x123&limit=5')).status, 400);
  assert.equal((await get(`venue=nowhere&address=${HL}&limit=5`)).status, 400);
  const plan = (store as unknown as { db: { prepare(s: string): { all(...a: unknown[]): Array<{ detail: string }> } } }).db
    .prepare(`EXPLAIN QUERY PLAN SELECT id, t, symbol, side, px, sz, fee, closed_pnl, oid FROM fills INDEXED BY fills_t
       WHERE venue = ? AND address = ? AND t >= ? AND t <= ? ORDER BY t DESC, id DESC LIMIT ?`)
    .all('hyperliquid', HL, 0, NOW, 10)
    .map((r) => r.detail);
  assert.ok(plan.some((d) => /fills_t/.test(d)), plan.join(' | '));
  assert.ok(!plan.some((d) => /TEMP B-TREE/.test(d)), plan.join(' | '));
  // The next slice's read too.
  const next = (store as unknown as { db: { prepare(s: string): { all(...a: unknown[]): Array<{ detail: string }> } } }).db
    .prepare(`EXPLAIN QUERY PLAN SELECT id, t, symbol, side, px, sz, fee, closed_pnl, oid FROM fills INDEXED BY fills_t
       WHERE venue = ? AND address = ? AND t >= ? AND t <= ? AND (t < ? OR id < ?) ORDER BY t DESC, id DESC LIMIT ?`)
    .all('hyperliquid', HL, 0, NOW, NOW, 'x', 10)
    .map((r) => r.detail);
  assert.ok(next.some((d) => /fills_t/.test(d)) && !next.some((d) => /TEMP B-TREE/.test(d)), next.join(' | '));
});

test('a long answer is read in slices: the same rows, in the same order, as one read', async () => {
  const from = NOW - 5 * DAY; // on a five-minute step or not, the answer is the same
  const r = await get(`venue=hyperliquid&address=${BUSY}&from=${from}&limit=600`);
  assert.equal(r.body.covered, true);
  const one = store.walletFillRows('hyperliquid', BUSY, from, NOW - 3_600_000, 600).map((x) => x.id);
  assert.equal(one.length, 600);
  assert.deepEqual(r.body.fills.map((f: { id: string }) => f.id), one);
  assert.equal(new Set(one).size, 600);
});

test('the kept answer, once the held span has grown at its end: only the new rows are read onto it', async () => {
  const from = Math.floor((NOW - 5 * DAY) / 300_000) * 300_000;
  const before = await get(`venue=hyperliquid&address=${BUSY}&from=${from}&limit=600`);
  store.putFills([fill('hyperliquid', BUSY, 'n1', NOW - 50 * 60_000), fill('hyperliquid', BUSY, 'n2', NOW - 40 * 60_000)]);
  store.addCoverage('hyperliquid', BUSY, 'fills', { fromT: NOW - 3_600_000, toT: NOW - 30 * 60_000 }, NOW);
  const after = await get(`venue=hyperliquid&address=${BUSY}&from=${from}&limit=600`);
  assert.equal(after.body.heldTo, NOW - 30 * 60_000);
  assert.deepEqual(after.body.fills.map((f: { id: string }) => f.id), ['n2', 'n1', ...before.body.fills.slice(0, 598).map((f: { id: string }) => f.id)]);
  // ...and it is what a fresh read answers.
  const { clearWalletFills } = await import('../src/indexer/walletFills.js');
  clearWalletFills();
  assert.deepEqual((await get(`venue=hyperliquid&address=${BUSY}&from=${from}&limit=600`)).body, after.body);
});

test('REST rows only: the answer ends before the oldest stream print it meets, beside a REST fill or after the last REST read', async () => {
  const MIX = '0x' + '9'.repeat(40);
  const ONLY = '0x' + '8'.repeat(40);
  const T = NOW - 2 * DAY;
  store.putFills([
    fill('hyperliquid', MIX, 'r1', NOW - 5 * DAY),
    fill('hyperliquid', MIX, 'r2', NOW - 4 * DAY),
    // An xyz: order's REST fill (aggregated) with two of its stream prints left beside it (production 2026-11-07).
    fill('hyperliquid', MIX, 'r3', T, { symbol: 'xyz:KORU', sz: 715 }),
    fill('hyperliquid', MIX, 's1', T, { symbol: 'xyz:KORU', sz: 484, fee: null, oid: null, src: 0 }),
    fill('hyperliquid', MIX, 's2', T, { symbol: 'xyz:KORU', sz: 231, fee: null, oid: null, src: 0 }),
    fill('hyperliquid', MIX, 'r4', NOW - DAY),
    // After the last REST read: the stream's only.
    fill('hyperliquid', MIX, 's3', NOW - 3_600_000, { fee: null, oid: null, src: 0 }),
    fill('hyperliquid', ONLY, 's4', NOW - 3 * DAY, { fee: null, oid: null, src: 0 }),
    fill('hyperliquid', ONLY, 's5', NOW - DAY, { fee: null, oid: null, src: 0 }),
  ]);
  store.addCoverage('hyperliquid', MIX, 'fills', { fromT: NOW - 10 * DAY, toT: NOW - 60_000 }, NOW);
  store.addCoverage('hyperliquid', ONLY, 'fills', { fromT: NOW - 10 * DAY, toT: NOW - 60_000 }, NOW);
  const from = NOW - 7 * DAY;
  const mix = (await get(`venue=hyperliquid&address=${MIX}&from=${from}&limit=5000`)).body;
  assert.equal(mix.covered, true);
  // Up to the millisecond before the oldest print; the REST fill at that millisecond, r4 and s3 are the venue's to answer.
  assert.equal(mix.heldTo, T - 1);
  assert.deepEqual(mix.fills.map((f: { id: string }) => f.id), ['r2', 'r1']);
  // A limit below the REST rows there: still none past the print.
  const two = (await get(`venue=hyperliquid&address=${MIX}&from=${from}&limit=1`)).body;
  assert.deepEqual([two.heldTo, two.fills.map((f: { id: string }) => f.id)], [T - 1, ['r2']]);
  // Only stream prints in the window, newer than any REST row: the stream's only copies, given to the held end (2026-11-07).
  const only = (await get(`venue=hyperliquid&address=${ONLY}&from=${from}&limit=5000`)).body;
  assert.deepEqual([only.covered, only.heldTo, only.fills.map((f: { id: string }) => f.id)], [true, NOW - 60_000, ['s5', 's4']]);
  // Once REST has replaced the prints (dropStreamRows), the whole held span is answered.
  store.dropStreamRows('hyperliquid', MIX, NOW - 10 * DAY, NOW);
  const { clearWalletFills } = await import('../src/indexer/walletFills.js');
  clearWalletFills();
  const clean = (await get(`venue=hyperliquid&address=${MIX}&from=${from}&limit=5000`)).body;
  assert.deepEqual([clean.heldTo, clean.fills.map((f: { id: string }) => f.id)], [NOW - 60_000, ['r4', 'r3', 'r2', 'r1']]);
});

test('one kept answer per wallet: a later window start is cut from it, a grown held span reads only the new rows', async () => {
  const W = '0x' + '7'.repeat(40);
  store.putFills([fill('hyperliquid', W, 'a1', NOW - 20 * DAY), fill('hyperliquid', W, 'a2', NOW - 2 * DAY)]);
  store.addCoverage('hyperliquid', W, 'fills', { fromT: NOW - 25 * DAY, toT: NOW - 60_000 }, NOW);
  const { walletFillsKept } = await import('../src/indexer/walletFills.js');
  const before = walletFillsKept().wallets;
  const a = (await get(`venue=hyperliquid&address=${W}&from=${NOW - 24 * DAY}&limit=5000`)).body;
  const b = (await get(`venue=hyperliquid&address=${W}&from=${NOW - 3 * DAY}&limit=5000`)).body;
  assert.deepEqual(a.fills.map((f: { id: string }) => f.id), ['a2', 'a1']);
  assert.deepEqual(b.fills.map((f: { id: string }) => f.id), ['a2']);
  // Before the held span, with fewer fills than the limit: not covered, as before.
  assert.equal((await get(`venue=hyperliquid&address=${W}&from=${NOW - 30 * DAY}&limit=5000`)).body.covered, false);
  assert.equal(walletFillsKept().wallets, before + 1, 'both windows from one kept answer');
  // The held span grows (the stream moves to_t up): the new rows are in front - the stream's print after the last REST
  // row too, the only copy of that fill (2026-11-07) - nothing else read again.
  store.putFills([fill('hyperliquid', W, 'a3', NOW - 40_000), fill('hyperliquid', W, 's1', NOW - 30_000, { fee: null, oid: null, src: 0 })]);
  store.setCoverage('hyperliquid', W, 'fills', { ...store.coverage('hyperliquid', W, 'fills')!, toT: NOW });
  const c = (await get(`venue=hyperliquid&address=${W}&from=${NOW - 3 * DAY}&limit=5000`)).body;
  assert.deepEqual([c.heldTo, c.fills.map((f: { id: string }) => f.id)], [NOW, ['s1', 'a3', 'a2']]);
  assert.equal(c.fills[0].fee, null, 'a stream print carries no fee; the replay prices the taker rate');
  // Read whole, the same answer.
  const { clearWalletFills } = await import('../src/indexer/walletFills.js');
  clearWalletFills();
  const d = (await get(`venue=hyperliquid&address=${W}&from=${NOW - 3 * DAY}&limit=5000`)).body;
  assert.deepEqual(d, c);
});

test('the held span never starts before the raw rows the retention kept (a frozen day has only its sums)', async () => {
  const { heldSpan } = await import('../src/indexer/walletFills.js');
  const stub = (cov: { fromT: number; toT: number; exhausted: boolean; capped: boolean }, rawFromDay: number) =>
    ({ rawFromDay: () => rawFromDay, coverage: () => ({ ...cov, restAt: 0 }) }) as unknown as IndexStore;
  const day = Math.floor(NOW / DAY);
  // Held from 200 days back, raw rows from 100 days back: the span starts there.
  assert.deepEqual(heldSpan(stub({ fromT: NOW - 200 * DAY, toT: NOW, exhausted: false, capped: false }, day - 100), 'hyperliquid', HL), { lo: (day - 100) * DAY, hi: NOW });
  // Exhausted, but its first rows are frozen: not "from the beginning" either.
  assert.deepEqual(heldSpan(stub({ fromT: NOW - 200 * DAY, toT: NOW, exhausted: true, capped: false }, day - 100), 'hyperliquid', HL), { lo: (day - 100) * DAY, hi: NOW });
  // Exhausted only by the venue's cap: older fills exist.
  assert.deepEqual(heldSpan(stub({ fromT: NOW - 5 * DAY, toT: NOW, exhausted: true, capped: true }, 0), 'hyperliquid', HL), { lo: NOW - 5 * DAY, hi: NOW });
  assert.deepEqual(heldSpan(stub({ fromT: NOW - 5 * DAY, toT: NOW, exhausted: true, capped: false }, 0), 'hyperliquid', HL), { lo: 0, hi: NOW });
});

test('GET /api/vs/last-trades: each Hyperliquid wallet\'s newest fills row (a stream print too), unknown ones left out', async () => {
  const r = await app.inject({ method: 'GET', url: `/api/vs/last-trades?venue=hyperliquid&addresses=${HL},${BUSY.toUpperCase().replace('0X', '0x')},${UNKNOWN},nonsense` });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { ok: true, at: { [HL]: NOW - 10_000, [BUSY]: NOW - 40 * 60_000 } });
  // Hyperliquid only: the hint is for hlPeek.
  assert.deepEqual((await app.inject({ method: 'GET', url: `/api/vs/last-trades?venue=sodex&addresses=${SODEX}` })).json(), { ok: true, at: {} });
  assert.equal((await app.inject({ method: 'GET', url: '/api/vs/last-trades?venue=hyperliquid&addresses=' })).statusCode, 400);
  // One step down fills_t, no scan of the wallet's rows.
  const plan = (store as unknown as { db: { prepare(s: string): { all(...a: unknown[]): Array<{ detail: string }> } } }).db
    .prepare('EXPLAIN QUERY PLAN SELECT MAX(t) AS t FROM fills INDEXED BY fills_t WHERE venue = ? AND address = ?').all('hyperliquid', HL).map((x) => x.detail);
  assert.ok(plan.some((d) => /COVERING INDEX fills_t/.test(d)), plan.join(' | '));
});

test('the positions at the answer\'s end: the book plus the fills since (or less those before it); none when a book lies outside the held span', async () => {
  const P = '0x' + '6'.repeat(40);
  // BTC long 2 at the book's read, then bought 1 and sold 0.5; ETH short 3 at the read, closed by a buy of 3; xyz:GOLD on its own book.
  const bookAt = NOW - 3 * 3_600_000;
  store.putCohortBooks([
    { venue: 'hyperliquid', address: P, equity: 1000, positions: [{ symbol: 'BTC', szi: 2, entry: 100 }, { symbol: 'ETH', szi: -3, entry: 10 }], at: bookAt },
    { venue: 'tradexyz', address: P, equity: 50, positions: [{ symbol: 'xyz:GOLD', szi: 4, entry: 2000 }], at: bookAt },
  ]);
  store.putFills([
    fill('hyperliquid', P, 'p0', bookAt - 3_600_000, { symbol: 'BTC', side: 1, sz: 7 }), // before the read: in the book already
    fill('hyperliquid', P, 'p1', bookAt + 60_000, { symbol: 'BTC', side: 1, sz: 1 }),
    fill('hyperliquid', P, 'p2', bookAt + 120_000, { symbol: 'BTC', side: -1, sz: 0.5 }),
    fill('hyperliquid', P, 'p3', bookAt + 180_000, { symbol: 'ETH', side: 1, sz: 3 }),
    fill('hyperliquid', P, 'p4', bookAt + 240_000, { symbol: 'xyz:GOLD', side: -1, sz: 1 }),
  ]);
  store.addCoverage('hyperliquid', P, 'fills', { fromT: NOW - 5 * DAY, toT: NOW - 60_000 }, NOW);
  const a = (await get(`venue=hyperliquid&address=${P}&from=${NOW - DAY}&limit=5000`)).body;
  assert.deepEqual(a.positions, [{ symbol: 'BTC', side: 'long', size: 2.5 }, { symbol: 'xyz:GOLD', side: 'long', size: 3 }]);
  const { positionsAt, heldSpan } = await import('../src/indexer/walletFills.js');
  const span = heldSpan(store, 'hyperliquid', P)!;
  // At a time before the book's read: the fills between come off it.
  assert.deepEqual(await positionsAt(store, 'hyperliquid', P, bookAt - 2 * 3_600_000, span), [{ symbol: 'BTC', side: 'short', size: 5 }, { symbol: 'ETH', side: 'short', size: 3 }, { symbol: 'xyz:GOLD', side: 'long', size: 4 }]);
  // A book read after the held span ends: the fills between are not all held - nothing said.
  assert.equal(await positionsAt(store, 'hyperliquid', P, NOW - 60_000, { lo: span.lo, hi: bookAt - 1 }), null);
});

test('saved to disk and read back after a start: the same answer, then topped up from there', async () => {
  const S = '0x' + '5'.repeat(40);
  store.putFills([fill('hyperliquid', S, 'k1', NOW - 2 * DAY), fill('hyperliquid', S, 'k2', NOW - DAY)]);
  store.addCoverage('hyperliquid', S, 'fills', { fromT: NOW - 10 * DAY, toT: NOW - 120_000 }, NOW);
  const W = await import('../src/indexer/walletFills.js');
  W.setWalletFillsDir(join(dir, 'copy-fills'));
  try {
    const q = `venue=hyperliquid&address=${S}&from=${NOW - 3 * DAY}&limit=5000`;
    const a = (await get(q)).body;
    assert.ok((await W.saveWalletFills()) >= 1);
    W.clearWalletFills(); // a start: nothing in memory
    // Read back without touching the index's rows: a row written now below the saved end is not in the answer.
    store.putFills([fill('hyperliquid', S, 'k9', NOW - 1.5 * DAY)]);
    const b = (await get(q)).body;
    assert.deepEqual(b, a);
    // The held span grows: topped up from the saved end.
    store.putFills([fill('hyperliquid', S, 'k3', NOW - 60_000)]);
    store.setCoverage('hyperliquid', S, 'fills', { ...store.coverage('hyperliquid', S, 'fills')!, toT: NOW });
    const c = (await get(q)).body;
    assert.deepEqual(c.fills.map((f: { id: string }) => f.id), ['k3', 'k2', 'k1']);
  } finally {
    W.setWalletFillsDir(null);
    W.clearWalletFills();
  }
});

test('on the fills read thread (production): the same answers byte for byte, and no fills statement runs on the API thread', async () => {
  const { IndexStore } = await import('../src/indexer/store.js');
  const W = await import('../src/indexer/walletFills.js');
  const R = await import('../src/indexer/liqReadThread.js');
  // 2026-11-09: the held span, the books of the positions and the last-trades hints joined them on that thread.
  const P = '0x' + '6'.repeat(40);
  const urls = [
    `/api/vs/wallet/fills?venue=hyperliquid&address=${HL}&from=${NOW - 30 * DAY}&limit=5000`, `/api/vs/wallet/fills?venue=hyperliquid&address=${BUSY}&from=${NOW - 5 * DAY}&limit=5000`,
    `/api/vs/wallet/fills?venue=hyperliquid&address=${BUSY}&from=${NOW - 5 * DAY}&limit=300`, `/api/vs/wallet/fills?venue=hyperliquid&address=${P}&from=${NOW - DAY}&limit=5000`,
    `/api/vs/wallet/fills?venue=sodex&address=${SODEX}&from=${NOW - 30 * DAY}&limit=100`, `/api/vs/wallet/fills?venue=hyperliquid&address=${UNKNOWN}&limit=100`,
    `/api/vs/wallet/fills?venue=hyperliquid&address=${LATE}&from=${NOW - 30 * DAY}&limit=100`, `/api/vs/last-trades?venue=hyperliquid&addresses=${HL},${BUSY},${UNKNOWN},${P},${HL}`,
  ];
  const ask = async (u: string) => (await app.inject({ method: 'GET', url: u })).body;
  W.clearWalletFills();
  const inline: string[] = [];
  for (const q of urls) inline.push(await ask(q));
  assert.ok(JSON.parse(inline[3]!).positions?.length, 'a wallet with its positions');
  const reads = ['walletFillRows', 'fillsNetBySymbol', 'coverage', 'rawFromDay', 'newestRowT', 'cohortBook'] as const;
  const kept = reads.map((k) => IndexStore.prototype[k]);
  try {
    W.clearWalletFills();
    process.env.VALUESCAN_LIQ_THREAD = '1';
    for (const k of reads) (IndexStore.prototype as unknown as Record<string, unknown>)[k] = () => { throw new Error(`${k} ran on the API thread`); };
    for (let i = 0; i < urls.length; i++) assert.equal(await ask(urls[i]!), inline[i]);
    assert.ok(JSON.parse(inline[1]!).fills.length >= 700, "the busy wallet in several slices");
    assert.ok(R.liqReadStats.done >= 3, JSON.stringify(R.liqReadStats));
  } finally {
    reads.forEach((k, i) => { (IndexStore.prototype as unknown as Record<string, unknown>)[k] = kept[i]; });
    delete process.env.VALUESCAN_LIQ_THREAD;
    await R.stopLiqReadThread();
    W.clearWalletFills();
  }
});

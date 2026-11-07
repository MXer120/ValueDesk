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

/**
 * The leaderboard indexer: board picking, coverage, the store, stream parsing.
 *   npx tsx --test test/indexer.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeBoards, pickBoard, spanCovers, tradeCheck, type Candidate } from '../src/indexer/boards.js';
import { pnlSince } from '../src/indexer/hlSource.js';
import { sodexCloseRow, sodexFillRow } from '../src/indexer/sodexSource.js';
import { IndexStore, type FillRow } from '../src/indexer/store.js';
import { Dedup, hlPrint, sodexPrint } from '../src/indexer/streams.js';
import { DAY_MS, tradeKey, windowStart, yearStartUtc } from '../src/indexer/windows.js';

const cand = (address: string, pnl: number, volume: number | null = 1): Candidate => ({ address, pnl, volume });

// --- windows ------------------------------------------------------------------------

/** Let the store's background day-aggregate build finish (the engine runs it on a timer). */
function built(s: IndexStore): void {
  s.windowStats('hyperliquid', '0xa', 0); s.windowStats('sodex', '0xb', 0);
  while (s.buildAggregates(10_000) > 0) { /* build */ }
}

test('window starts: rolling windows, year start, all time', () => {
  const now = Date.UTC(2026, 8, 28, 12);
  assert.equal(windowStart('1d', now), now - DAY_MS);
  assert.equal(windowStart('30d', now), now - 30 * DAY_MS);
  assert.equal(windowStart('ytd', now), Date.UTC(2026, 0, 1));
  assert.equal(yearStartUtc(now), Date.UTC(2026, 0, 1));
  assert.equal(windowStart('all', now), 0);
});

test('a trade is one execution: block time + market + side', () => {
  assert.equal(tradeKey(1, 'BTC', 1), tradeKey(1, 'BTC', 1));
  assert.notEqual(tradeKey(1, 'BTC', 1), tradeKey(1, 'BTC', -1));
  assert.notEqual(tradeKey(1, 'BTC', 1), tradeKey(2, 'BTC', 1));
});

// --- boards --------------------------------------------------------------------------

test('active board: zero-volume wallets are skipped without a check, unknowns wait, known ones rank', () => {
  const checks: string[] = [];
  const res = pickBoard(
    [cand('a', 100, 0), cand('b', 90), cand('c', 80), cand('d', 70), cand('e', 60)],
    (c) => {
      checks.push(c.address);
      return c.address === 'b' ? 'yes' : c.address === 'c' ? 'unknown' : c.address === 'd' ? 'no' : 'yes';
    },
    { filter: 'active', size: 2 },
  );
  assert.deepEqual(checks, ['b', 'c', 'd', 'e']);
  assert.deepEqual(res.picks.map((p) => p.address), ['b', 'e']);
  assert.deepEqual(res.pending, ['c']);
  // c outranks e and is not checked yet: the board is provisional.
  assert.equal(res.complete, false);
});

test('active board is complete when full with nothing unchecked above, or when every candidate is checked', () => {
  const full = pickBoard([cand('a', 3), cand('b', 2), cand('c', 1)], () => 'yes', { filter: 'active', size: 2 });
  assert.equal(full.complete, true);
  assert.equal(full.scanned, 2);
  const short = pickBoard([cand('a', 3), cand('b', 2)], (c) => (c.address === 'a' ? 'yes' : 'no'), { filter: 'active', size: 5 });
  assert.equal(short.complete, true);
  assert.equal(short.picks.length, 1);
});

test('the walk stops once enough wallets wait for a check', () => {
  const many = Array.from({ length: 50 }, (_, i) => cand(`w${i}`, 100 - i));
  const res = pickBoard(many, () => 'unknown', { filter: 'active', size: 10, maxPending: 5 });
  assert.equal(res.pending.length, 5);
  assert.equal(res.picks.length, 0);
  assert.equal(res.complete, false);
});

test('any board takes the first hundred without checks; duplicates and NaN are dropped', () => {
  const res = pickBoard([cand('a', 2, 0), cand('a', 2), cand('b', Number.NaN), cand('c', 1)], () => {
    throw new Error('no check expected');
  }, { filter: 'any', size: 5 });
  assert.deepEqual(res.picks.map((p) => p.address), ['a', 'c']);
});

test('trade check: two orders qualify; fewer only answer "no" when the whole window is held', () => {
  assert.equal(tradeCheck(2, false), 'yes');
  assert.equal(tradeCheck(1, true), 'no');
  assert.equal(tradeCheck(1, false), 'unknown');
  assert.equal(tradeCheck(0, true), 'no');
});

test('a held range covers a window when it reaches back to the start and up to now (or the stream carries it)', () => {
  const now = 1_000_000;
  const o = { staleMs: 1_000, streamSince: null };
  assert.equal(spanCovers(null, 0, now, o), false);
  assert.equal(spanCovers({ fromT: 100, toT: now, exhausted: false }, 200, now, o), true);
  assert.equal(spanCovers({ fromT: 300, toT: now, exhausted: false }, 200, now, o), false);
  assert.equal(spanCovers({ fromT: 300, toT: now, exhausted: true }, 200, now, o), true);
  assert.equal(spanCovers({ fromT: 100, toT: now - 5_000, exhausted: false }, 200, now, o), false);
  assert.equal(spanCovers({ fromT: 100, toT: now - 5_000, exhausted: false }, 200, now, { staleMs: 1_000, streamSince: now - 9_000 }), true);
});

test('venue=all merges both hundreds by PnL', () => {
  const top = mergeBoards([[{ pnl: 5 }, { pnl: 1 }], [{ pnl: 3 }]], 'top', 2);
  assert.deepEqual(top.map((r) => r.pnl), [5, 3]);
  const worst = mergeBoards([[{ pnl: -5 }, { pnl: -1 }], [{ pnl: -3 }]], 'worst', 2);
  assert.deepEqual(worst.map((r) => r.pnl), [-5, -3]);
});

// --- store ----------------------------------------------------------------------------

/** Fixture times start here (a UTC midnight in 2024): the store refuses a fill or close before 2020. */
const B = 20_000 * DAY_MS;

const fill = (o: Partial<FillRow> & { id: string; t: number }): FillRow => ({
  venue: 'hyperliquid',
  address: '0xa',
  symbol: 'BTC',
  side: 1,
  px: 100,
  sz: 1,
  fee: null,
  closedPnl: null,
  oid: null,
  src: 1,
  ...o,
});

test('store: a REST fill replaces the stream row with the same id; a stream row never downgrades it', () => {
  const s = new IndexStore(':memory:');
  s.putFills([fill({ id: '1', t: B + 10, src: 0 })]);
  s.putFills([fill({ id: '1', t: B + 10, oid: '9', src: 1, closedPnl: 5 })]);
  s.putFills([fill({ id: '1', t: B + 10, src: 0 })]);
  built(s);
  const st = s.windowStats('hyperliquid', '0xa', 0);
  assert.equal(st.trades, 1);
  assert.equal(st.closes, 1);
  assert.equal(st.wins, 1);
  s.close();
});

test('store: orders, volume, top assets and HL win rate in a window', () => {
  const s = new IndexStore(':memory:');
  s.putFills([
    // Two fills of one execution (same block, market, side): one trade.
    fill({ id: '1', t: B + 100, oid: 'A', symbol: 'ETH', px: 10, sz: 1 }),
    fill({ id: '2', t: B + 100, oid: 'A', symbol: 'ETH', px: 10, sz: 1 }),
    fill({ id: '3', t: B + 200, oid: 'B', symbol: 'BTC', px: 100, sz: 1, closedPnl: 3 }),
    fill({ id: '4', t: B + 300, oid: 'C', symbol: 'SOL', px: 1, sz: 1, closedPnl: -1 }),
    fill({ id: '5', t: B + 50, oid: 'Z', symbol: 'DOGE', px: 1, sz: 1 }),
  ]);
  built(s);
  assert.equal(s.orderCount('hyperliquid', '0xa', B + 100), 3);
  built(s);
  const st = s.windowStats('hyperliquid', '0xa', B + 100);
  assert.equal(st.trades, 3);
  assert.equal(st.volume, 121);
  assert.deepEqual(st.assets, ['BTC', 'ETH', 'SOL']);
  assert.equal(st.closes, 2);
  assert.equal(st.wins, 1);
  s.close();
});

test('store: SoDEX win rate comes from closed positions', () => {
  const s = new IndexStore(':memory:');
  s.putCloses([
    { venue: 'sodex', address: '0xb', id: '1', t: B + 10, openedT: B + 1, symbol: 'BTC-USD', pnl: 5 },
    { venue: 'sodex', address: '0xb', id: '2', t: B + 20, openedT: B + 2, symbol: 'BTC-USD', pnl: -1 },
    { venue: 'sodex', address: '0xb', id: '3', t: B + 30, openedT: B + 25, symbol: 'BTC-USD', pnl: 2 },
  ]);
  built(s);
  const st = s.windowStats('sodex', '0xb', B + 15);
  assert.equal(st.closes, 2);
  assert.equal(st.wins, 1);
  // Two closes since 15 prove two trades; the position opened at 25 and closed at 30 is a round trip.
  assert.deepEqual(s.closeEvidence('sodex', '0xb', B + 15), { closes: 2, roundTrips: 1 });
  assert.deepEqual(s.closeEvidence('sodex', '0xb', B + 26), { closes: 1, roundTrips: 0 });
  s.close();
});

test('store: coverage merges touching ranges, keeps the held range for a detached older piece, and replaces on a newer gap', () => {
  const s = new IndexStore(':memory:');
  s.addCoverage('sodex', '0xc', 'perps', { fromT: 100, toT: 200 }, 1);
  let c = s.addCoverage('sodex', '0xc', 'perps', { fromT: 50, toT: 100, exhausted: true }, 2);
  assert.deepEqual([c.fromT, c.toT, c.exhausted], [50, 200, true]);
  c = s.addCoverage('sodex', '0xc', 'perps', { fromT: 150, toT: 300 }, 3);
  assert.deepEqual([c.fromT, c.toT, c.exhausted], [50, 300, true]);
  c = s.addCoverage('sodex', '0xc', 'perps', { fromT: 0, toT: 10 }, 4);
  assert.deepEqual([c.fromT, c.toT], [50, 300]);
  c = s.addCoverage('sodex', '0xc', 'perps', { fromT: 500, toT: 600 }, 5);
  assert.deepEqual([c.fromT, c.toT, c.exhausted], [500, 600, false]);
  s.close();
});

test('store: versions move on every write for that trader only', () => {
  const s = new IndexStore(':memory:');
  const v0 = s.version('hyperliquid', '0xa');
  s.putFills([fill({ id: '1', t: B + 1 })]);
  assert.ok(s.version('hyperliquid', '0xa') > v0);
  assert.equal(s.version('hyperliquid', '0xother'), 0);
  s.close();
});

test('store: boards round-trip, and active accounts sum stream activity', () => {
  const s = new IndexStore(':memory:');
  s.writeBoard(
    { venue: 'sodex', window: '30d', side: 'worst', filter: 'active', updatedAt: 5, sourceAt: 4, complete: true, pending: 0, scanned: 3, note: null },
    [{ rank: 1, venue: 'sodex', address: '0xd', label: null, accountId: 7, pnl: -10, volume: 50, trades: 3, tradesCapped: false, winRate: 0.5, accountValue: 9, assets: ['BTC-USD'] }],
  );
  const b = s.readBoard('sodex', '30d', 'worst', 'active');
  assert.ok(b);
  assert.equal(b.meta.complete, true);
  assert.deepEqual(b.rows[0]!.assets, ['BTC-USD']);
  assert.equal(b.rows[0]!.accountId, 7);
  assert.equal(s.readBoard('sodex', '30d', 'top', 'active'), null);

  s.addActivity([
    { venue: 'sodex', acct: '11', hour: 100 * 24, trades: 1, volume: 10 },
    { venue: 'sodex', acct: '11', hour: 101 * 24 + 5, trades: 2, volume: 30 },
    { venue: 'sodex', acct: '12', hour: 101 * 24 + 6, trades: 1, volume: 99 },
  ]);
  s.addActivity([{ venue: 'sodex', acct: '11', hour: 101 * 24 + 5, trades: 1, volume: 1 }]);
  assert.deepEqual(s.activeAccounts('sodex', { day: 101 }, 2, 10), [{ acct: '11', trades: 3, volume: 31 }]);
  assert.deepEqual(s.activeAccounts('sodex', { hour: 101 * 24 + 6 }, 1, 10), [{ acct: '12', trades: 1, volume: 99 }]);
  assert.equal(s.activityTrades('sodex', '11', { hour: 0 }), 4);
  assert.equal(s.activityTrades('sodex', '11', { day: 101 }), 3);
  s.close();
});

test('store: all-time PnL snapshots answer "as of a day"', () => {
  const s = new IndexStore(':memory:');
  s.putCumPnl('hyperliquid', 10, [{ address: '0xa', pnl: 1 }]);
  s.putCumPnl('hyperliquid', 12, [{ address: '0xa', pnl: 5 }]);
  assert.equal(s.cumPnlSince('hyperliquid'), 10);
  assert.equal(s.cumPnlAt('hyperliquid', 11).get('0xa'), 1);
  assert.equal(s.cumPnlAt('hyperliquid', 13).get('0xa'), 5);
  assert.equal(s.cumPnlAt('hyperliquid', 9).size, 0);
  s.close();
});

// --- sources ---------------------------------------------------------------------------

test('pnlSince measures from the last point at or before the cutoff', () => {
  const pts = [{ t: 1, pnl: 0 }, { t: 5, pnl: 3 }, { t: 9, pnl: 10 }];
  assert.equal(pnlSince(pts, 6), 7);
  assert.equal(pnlSince(pts, 0), 10);
  assert.equal(pnlSince([], 0), null);
});

test('SoDEX trade and close rows: side, per-symbol trade id, dollar fees only', () => {
  const f = sodexFillRow('0xe', { symbol: 'ETH-USD', tradeID: 5, orderID: 9, side: 'SELL', price: '2670', quantity: '2', fee: '1.5', feeCoin: 'vUSDC', time: 42 });
  assert.ok(f);
  assert.deepEqual([f.id, f.side, f.oid, f.fee], ['ETH-USD:5', -1, '9', 1.5]);
  const spotBuy = sodexFillRow('0xe', { symbol: 'vBTC_vUSDC', tradeID: 6, side: 'BUY', price: '1', quantity: '1', fee: '0.001', feeCoin: 'vBTC', time: 1 });
  assert.equal(spotBuy?.fee, null);
  const c = sodexCloseRow('0xe', { id: 11, symbol: 'ETH-USD', realizedPnL: '-3.5', createdAt: 50, updatedAt: 99 });
  assert.deepEqual(c, { venue: 'sodex', address: '0xe', id: '11', t: 99, openedT: 50, symbol: 'ETH-USD', pnl: -3.5 });
});

// --- streams ----------------------------------------------------------------------------

test('stream prints: HL users are [buyer, seller]; SoDEX bi / si are account ids', () => {
  const hl = hlPrint({ coin: 'BTC', side: 'A', px: '100', sz: '2', time: 5, hash: '0x', tid: 77, users: ['0xAA', '0xBB'] });
  assert.deepEqual(hl, { venue: 'hyperliquid', id: '77', t: 5, symbol: 'BTC', px: 100, sz: 2, buyer: '0xaa', seller: '0xbb', taker: 'seller' });
  assert.equal(hlPrint({ coin: 'BTC', side: 'B', px: '100', sz: '2', time: 5, hash: '0x', tid: 78, users: ['0xAA', '0xBB'] })!.taker, 'buyer', 'B: the buyer took liquidity');
  const sx = sodexPrint({ T: 9, t: 3, s: 'BTC-USD', p: '10', q: '1', bi: 1002, si: 23342 });
  assert.deepEqual(sx, { venue: 'sodex', id: 'BTC-USD:3', t: 9, symbol: 'BTC-USD', px: 10, sz: 1, buyer: '1002', seller: '23342' });
  assert.equal(sodexPrint({ T: 9, t: 3, s: 'BTC-USD', p: '10', q: '1' }), null);
});

test('dedup drops repeats and forgets the oldest past its cap', () => {
  const d = new Dedup(10);
  assert.equal(d.add('a'), true);
  assert.equal(d.add('a'), false);
  for (let i = 0; i < 20; i++) d.add(String(i));
  assert.equal(d.add('a'), true);
});

// --- extra venues ------------------------------------------------------------------------

test('Arcus prints: side is the taker\'s, timestamps are µs, addresses lower-case', async () => {
  const { arcusPrint } = await import('../src/indexer/streams.js');
  const p = arcusPrint({
    marketDisplayName: 'BTC-USD', side: 'SELL', price: '100', size: '2', tradeId: '9', timestamp: 1_000_000_500,
    makerAddress: '0xAA', takerAddress: '0xBB',
  });
  assert.deepEqual(p, { venue: 'arcus', id: '9', t: 1_000_000, symbol: 'BTC-USD', px: 100, sz: 2, buyer: '0xaa', seller: '0xbb', taker: 'seller' });
  assert.equal(arcusPrint({ marketDisplayName: 'BTC-USD', price: '1', size: '1', tradeId: '1', timestamp: 1 }), null);
});

test('store: Hyperliquid xyz fills and held ranges are mirrored under tradexyz; realised PnL nets fees', () => {
  const s = new IndexStore(':memory:');
  s.putFills([
    fill({ id: '1', t: B + 100, symbol: 'xyz:AAPL', closedPnl: 10, fee: 1 }),
    fill({ id: '2', t: B + 200, symbol: 'BTC', closedPnl: 50, fee: 2 }),
    fill({ id: '3', t: B + 300, symbol: 'xyz:TSLA', closedPnl: -4, fee: 0.5 }),
  ]);
  s.addCoverage('hyperliquid', '0xa', 'fills', { fromT: 0, toT: B + 400, exhausted: true }, B + 400);
  assert.deepEqual(s.realized('tradexyz', '0xa', 0), { pnl: 4.5, volume: 200, fills: 2 });
  assert.equal(s.realized('tradexyz', '0xa', B + 150).fills, 1);
  assert.equal(s.coverage('tradexyz', '0xa', 'fills')?.exhausted, true);
  built(s);
  assert.equal(s.orderCount('hyperliquid', '0xa', 0), 3);
  s.close();
});

test('boards: a top board holds only gains, a worst board only losses', () => {
  const list = [cand('a', 5), cand('b', 1), cand('c', -2)];
  assert.deepEqual(pickBoard(list, () => 'yes', { filter: 'any', side: 'top' }).picks.map((p) => p.address), ['a', 'b']);
  const worst = [cand('c', -2), cand('b', 1), cand('a', 5)];
  assert.deepEqual(pickBoard(worst, () => 'yes', { filter: 'any', side: 'worst' }).picks.map((p) => p.address), ['c']);
});

test('Arcus closedPnl is stored gross: an opening fill is 0, a close adds its fee back', async () => {
  const { grossPnl } = await import('../src/valuedesk/extra/arcus.js');
  assert.equal(grossPnl(-14.88, 14.88, 'OPEN_SHORT'), 0);
  assert.ok(Math.abs(grossPnl(0.07, 0.003, 'CLOSE_SHORT')! - 0.073) < 1e-12);
  assert.equal(grossPnl(null, 1, 'CLOSE_LONG'), null);
});

test('store: stream rows inside a REST-held range are dropped (HL ids differ between the two)', () => {
  const s = new IndexStore(':memory:');
  s.putFills([fill({ id: 's1', t: B + 100, src: 0 }), fill({ id: 's2', t: B + 300, src: 0 }), fill({ id: 'r1', t: B + 100, oid: '5', src: 1 })]);
  s.dropStreamRows('hyperliquid', '0xa', 0, B + 200);
  assert.equal(s.fillExtent('hyperliquid', '0xa').count, 2);
  s.close();
});

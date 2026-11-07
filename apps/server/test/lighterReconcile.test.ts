/**
 * Run: npx tsx --test test/lighterReconcile.test.ts   (from apps/server)
 *
 * Audit 2026-10-30: Lighter's books held more than Lighter's own open interest - ETH long 47,810 /
 * short 48,267 against 30,865 open (155%), SOL short 326,713 against 159,030 (205%), BTC short 2,560
 * against 2,089 (122%). Ways a position outlived its close, each closed here:
 *
 *   1. A print applied twice. Each stream's first message per market after subscribing is a
 *      snapshot of recent prints; the dedup that drops them on a reconnect starts empty in a new
 *      process, so after every restart the snapshot moved the saved books again - and a print the
 *      stream delivered late, older than the read that replaced the book, moved a book that held it.
 *   2. A book outside the tail sample (Lighter reads 10% of its small wallets) was never read again,
 *      and the live map kept its positions for good.
 *   3. Nothing compared the books with the venue: now a check over the open interest logs, shows the
 *      ratio in the status, and reads the coin's holders again (a read replaces the book whole).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_RECONCILE_MS, OI_PRIO, PRINT_SKEW_MS, applyFill, crossedPrio, liqBacklogPrio, pollTtl, printApplies, routineTtl, tailBookDue, reconcileTtl, type Book,
} from '../src/indexer/cohortTracker.js';
import { OI_EXCESS, OI_REREAD_MIN_AGE_MS, oiCheck, oiOver, oiRereads, oiStatus, overSides } from '../src/indexer/oiCheck.js';
import { liqCoin } from '../src/valuedesk/liquidations/levels.js';
import type { Venue } from '../src/valuedesk/types.js';

const T0 = 1_793_380_000_000;

test('a print the saved books already hold is not applied again after a restart; one the read holds is not applied to it', () => {
  // A wallet closed 5 ETH long at T0 + 10 s; the indexer saved the empty book and restarted.
  const book: Book = { equity: 1_000, at: T0, pos: new Map([['ETH', { szi: 5, entry: 2_200 }]]) };
  const close = { t: T0 + 10_000, d: -5, px: 2_240 };
  if (printApplies(book, close.t, 0)) applyFill(book, 'ETH', close.d, close.px);
  assert.equal(book.pos.size, 0, 'closed');
  const replayBefore = T0 + 10_000; // the newest print time the saved books hold
  // After the restart the stream's snapshot repeats the print: before the fix it opened a 5 ETH short.
  if (printApplies(book, close.t, replayBefore)) applyFill(book, 'ETH', close.d, close.px);
  assert.equal(book.pos.size, 0, 'the snapshot replay does not move it');
  assert.equal(printApplies(book, replayBefore + 1, replayBefore), true, 'a new print does');

  // A read asked at T0 + 60 s replaced the book; a print from T0 + 50 s delivered after it is in the read.
  const read: Book = { equity: 1_000, at: T0 + 61_000, reqAt: T0 + 60_000, pos: new Map([['ETH', { szi: 3, entry: 2_250 }]]) };
  assert.equal(printApplies(read, T0 + 50_000, 0), false, 'older than the read: held by it');
  assert.equal(printApplies(read, T0 + 60_000 - PRINT_SKEW_MS + 1, 0), true, 'within the clocks\' skew: applied, as before');
  assert.equal(printApplies(read, T0 + 70_000, 0), true);
  assert.equal(printApplies(read, 5, 0), true, 'not a time in ms: applied as before');
});

test('a book outside the tail sample is read again on its schedule; an empty one is not', () => {
  const ttl = reconcileTtl(5_000, 'lighter');
  const book = { at: T0, pos: new Map([['SOL', { szi: -1_000, entry: 95 }]]) };
  assert.equal(tailBookDue(book, T0 + ttl - 1, ttl), false);
  assert.equal(tailBookDue(book, T0 + ttl, ttl), true, 'before the fix it was never read again');
  assert.equal(tailBookDue({ at: T0, pos: new Map() }, T0 + ttl * 10, ttl), false);
  assert.equal(tailBookDue(undefined, T0 + ttl, ttl), false, 'no book: a tail wallet outside the sample is still never read');
});

test('books over the open interest: found, shown per venue, and the holders read again oldest first', () => {
  // The audit's figures (Lighter, 2026-10-30) and a Hyperliquid coin in line with its open interest.
  const totals = new Map<string, Map<Venue, [number, number]>>([
    ['ETH', new Map<Venue, [number, number]>([['lighter', [47_810, 48_267]], ['hyperliquid', [496_757, 496_876]]])],
    ['SOL', new Map<Venue, [number, number]>([['lighter', [177_098, 326_713]]])],
    ['BTC', new Map<Venue, [number, number]>([['lighter', [2_266.86, 2_560.46]], ['hyperliquid', [20_645, 20_617.6]]])],
  ]);
  const OI: Record<string, number> = { 'lighter|ETH': 30_864.64, 'lighter|SOL': 159_030.24, 'lighter|BTC': 2_089.36, 'hyperliquid|ETH': 495_982.64, 'hyperliquid|BTC': 20_518.17 };
  const rows = oiCheck(totals, (v, c) => OI[`${v}|${c}`] ?? null);
  const over = oiOver(rows);
  assert.deepEqual(over.map((r) => `${r.venue}|${r.coin}`), ['lighter|SOL', 'lighter|ETH', 'lighter|BTC']);
  assert.ok(Math.abs(over[0]!.ratio - 2.0544) < 1e-3, `SOL ${over[0]!.ratio}`);
  assert.ok(rows.find((r) => r.venue === 'hyperliquid' && r.coin === 'BTC')!.ratio < OI_EXCESS, 'Hyperliquid within 5%');
  const st = oiStatus(rows);
  assert.equal(st.lighter!.over, 3);
  assert.equal(st.lighter!.worst, 2.0544);
  assert.equal(st.hyperliquid!.over, 0);
  assert.ok(st.hyperliquid!.worst > 1 && st.hyperliquid!.worst < 1.01);

  const now = T0 + 10 * 86_400_000;
  const books = new Map([
    ['0xold', { at: T0, pos: new Map([['SOL', { szi: -500 }]]) }],
    ['0xolder', { at: T0 - 86_400_000, pos: new Map([['SOL', { szi: -900 }]]) }],
    ['0xfresh', { at: now - OI_REREAD_MIN_AGE_MS + 1, pos: new Map([['SOL', { szi: -50 }]]) }],
    ['0xeth', { at: T0 - 5 * 86_400_000, pos: new Map([['ETH', { szi: 2 }]]) }],
    ['0xclosed', { at: T0 - 5 * 86_400_000, pos: new Map([['SOL', { szi: 0 }]]) }],
  ]);
  assert.deepEqual(oiRereads(books, 'SOL', liqCoin, now, 10), ['0xolder', '0xold'], 'SOL holders, largest first, none just read');
  assert.deepEqual(oiRereads(books, 'SOL', liqCoin, now, 1), ['0xolder']);
});

test('over-OI rereads: the over side only, books read before the last gap first, then the largest', () => {
  // trade.xyz ORCL, 2026-11-07: books long 46,939 / short 54,581 against 47,137 open (116%). The excess was one
  // 6,817 short closed on the venue 3.8 days before - the third-largest short, read before the restarts.
  const row = { long: 46_939, short: 54_581, oi: 47_137 };
  assert.deepEqual(overSides(row), { long: false, short: true });
  assert.deepEqual(overSides({ long: 47_810, short: 48_267, oi: 30_865 }), { long: true, short: true }, 'both sides over');
  const now = T0 + 10 * 86_400_000;
  const gapAt = now - 11 * 3_600_000;
  const H = 60_000;
  const books = new Map([
    ['0xbig', { at: now - 600 * H, pos: new Map([['xyz:ORCL', { szi: -16_315 }]]) }],
    ['0xbig2', { at: now - 600 * H, pos: new Map([['xyz:ORCL', { szi: -12_817 }]]) }],
    ['0xphantom', { at: now - 5_448 * H, pos: new Map([['xyz:ORCL', { szi: -6_817 }]]) }],
    ['0xsmallold', { at: now - 6_000 * H, pos: new Map([['xyz:ORCL', { szi: -1_455 }]]) }],
    ['0xlong', { at: now - 9_000 * H, pos: new Map([['xyz:ORCL', { szi: 20_000 }]]) }],
  ]);
  const got = oiRereads(books, 'ORCL', liqCoin, now, 2, { sides: overSides(row), gapAt });
  assert.deepEqual(got, ['0xphantom', '0xsmallold'], 'read before the gap first, largest of those first; no long, none read since the gap');
  assert.deepEqual(oiRereads(books, 'ORCL', liqCoin, now, 10, { sides: overSides(row), gapAt }), ['0xphantom', '0xsmallold', '0xbig', '0xbig2']);
});

test('an empty Hyperliquid or trade.xyz book the stream follows is re-read monthly, not weekly', () => {
  const week = 7 * 86_400_000;
  assert.equal(routineTtl(500, 'hyperliquid', true, 1), week, 'a book holding something: weekly');
  assert.equal(routineTtl(500, 'hyperliquid', true, 0), EMPTY_RECONCILE_MS);
  assert.equal(routineTtl(500, 'tradexyz', true, 0), EMPTY_RECONCILE_MS);
  assert.equal(routineTtl(500, 'hyperliquid', false, 0), pollTtl(500), 'stream not following: polled as before');
  assert.equal(routineTtl(500, 'sodex', true, 0), reconcileTtl(500, 'sodex'), 'SoDEX misses prints');
  assert.equal(routineTtl(500, 'lighter', true, 0), reconcileTtl(500, 'lighter'), 'Lighter prints name sub-accounts');
  assert.equal(routineTtl(2_000_000, 'hyperliquid', true, 0), EMPTY_RECONCILE_MS);
});

test('over-OI rereads run before the never-read and gap reads, after the crossed books', () => {
  assert.ok(OI_PRIO < crossedPrio(0));
  assert.ok(OI_PRIO > liqBacklogPrio(1e12, 1));
  assert.ok(OI_PRIO > 1_000 + 300 + 300, 'above a never-read $1K wallet the stream saw trade');
});

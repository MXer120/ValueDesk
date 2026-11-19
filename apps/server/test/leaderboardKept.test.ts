/**
 * Run: npx tsx --test test/leaderboardKept.test.ts   (from apps/server)
 *
 * The leaderboard's boards and netted pools kept between reads (indexer/read.ts boardOf / netPoolOf, 2026-11-18): every
 * page is byte for byte what the code before them answered for the same file - a verbatim copy of that code below is the
 * reference - on a first read, a kept read, after a board or a venue's trader_win rows are written again, and after a
 * SoDEX account id is learned. With the handler time of both on synthetic boards of production's shape (the benchmark
 * prints it; the local API has no production index).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { IndexStore, type BoardRow, type NetRow, type TraderWin } from '../src/indexer/store.js';
import { closeReader, reader } from '../src/indexer/reader.js';
import { boardPage, clearKeptBoards, keptStats, markSodexTrades, netPage, type BoardPage } from '../src/indexer/read.js';
import { mergeBoards } from '../src/indexer/boards.js';
import { BOARD_SIZE, MIN_TRADES, type BoardFilter, type Side } from '../src/indexer/windows.js';
import { labelMatches, shownLabel } from '../src/valuedesk/labels.js';
import { winRateOf } from '../src/valuedesk/winRate.js';
import { VENUES, type BoardWindow, type TraderRow, type Venue } from '../src/valuedesk/types.js';

const dir = mkdtempSync(join(tmpdir(), 'vs-lb-kept-'));
const DB = join(dir, 'index.db');
process.env.VALUESCAN_INDEX_DB = DB;
closeReader();

const NOW = Date.now() - 60_000;
const A = (i: number): string => `0x${i.toString(16).padStart(40, '0')}`;
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
const COINS = ['BTC', 'ETH', 'SOL', 'HYPE', 'XRP', 'DOGE'];

/**
 * Production's shape (store.ts trader_win: each venue's top and worst pools plus the other venues' members it ranks), a
 * little larger than measured to be safe: 1,000 rows per venue and window, 300 top, 300 worst, 400 cross ('x'), about a
 * third of the addresses on two or more venues. Boards of 100 rows per venue, side and filter.
 */
const PER_VENUE = 1_000;
function winsOf(venue: Venue, seed: number): TraderWin[] {
  const r = rng(seed);
  const rows: TraderWin[] = [];
  const offset = VENUES.indexOf(venue) * 650;
  for (let i = 0; i < PER_VENUE; i++) {
    const address = A(offset + i);
    const pool = i < 300 ? 'top' : i < 600 ? 'worst' : 'x';
    const pnl = pool === 'top' ? 1e6 * r() + 1 : pool === 'worst' ? -1e6 * r() - 1 : (r() - 0.5) * 1e5;
    rows.push({
      venue, address, pool, pnl, volume: r() < 0.1 ? null : Math.round(r() * 1e7), trades: r() < 0.15 ? null : Math.floor(r() * 40),
      exact: r() < 0.8, wins: r() < 0.2 ? null : Math.floor(r() * 10), closes: r() < 0.2 ? null : 10 + Math.floor(r() * 10), winExact: r() < 0.7,
      accountValue: r() < 0.3 ? null : Math.round(r() * 1e6), label: i % 97 === 0 ? `name ${i}` : null,
      assets: [COINS[Math.floor(r() * 6)]!, COINS[Math.floor(r() * 6)]!, COINS[Math.floor(r() * 6)]!],
    });
  }
  return rows;
}

function boardOfRows(venue: Venue, side: Side, filter: BoardFilter, seed: number): BoardRow[] {
  const r = rng(seed);
  return Array.from({ length: BOARD_SIZE }, (_, i) => ({
    rank: i + 1, venue, address: A(VENUES.indexOf(venue) * 650 + (side === 'top' ? i : 300 + i)), label: i % 31 === 0 ? `n${i}` : null,
    accountId: venue === 'sodex' ? 7_000 + i : null, pnl: side === 'top' ? 1e6 - i * 1_000 : -1e6 + i * 1_000, volume: Math.round(r() * 1e7),
    trades: filter === 'active' ? 2 + Math.floor(r() * 30) : Math.floor(r() * 30), tradesCapped: r() < 0.1, winRate: r() < 0.2 ? null : r(),
    winExact: r() < 0.5, winCloses: 10, winFrom: null, rankChange: Math.floor((r() - 0.5) * 10), accountValue: Math.round(r() * 1e6),
    assets: [COINS[i % 6]!, COINS[(i + 1) % 6]!],
  }));
}

const writer = new IndexStore(DB);
const WINDOW: BoardWindow = '30d';
function writeBoards(at: number): void {
  let seed = 100;
  for (const venue of VENUES) {
    for (const side of ['top', 'worst'] as const) {
      for (const filter of ['any', 'active'] as const) {
        writer.writeBoard({ venue, window: WINDOW, side, filter, updatedAt: at, sourceAt: at - 1_000, complete: venue !== 'lighter', pending: venue === 'arcus' ? 3 : 0, scanned: 400, note: null, rankSince: venue === 'sodex' ? at - 86_400_000 : null }, boardOfRows(venue, side, filter, seed++));
      }
    }
  }
}
VENUES.forEach((v, i) => writer.writeTraderWin(v, WINDOW, winsOf(v, i + 1)));
writeBoards(NOW);
for (let i = 0; i < 200; i += 3) writer.upsertAccount('sodex', A(VENUES.indexOf('sodex') * 650 + i), { accountId: 9_000 + i });

after(() => {
  closeReader();
  writer.close();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* a handle on Windows */ }
});

// --- the code before (verbatim, 706c1a26 indexer/read.ts and store.ts), the reference ------------------------------------

const WINDOW_WORD: Record<BoardWindow, string> = { '1d': '24 hours', '7d': '7 days', '30d': '30 days', '90d': '90 days', ytd: 'year to date', all: 'all time' };
const VENUE_WORD: Record<Venue, string> = { sodex: 'SoDEX', hyperliquid: 'Hyperliquid', tradexyz: 'trade.xyz', lighter: 'Lighter', arcus: 'Arcus' };

function oldNetCandidates(s: IndexStore, venues: readonly Venue[], window: BoardWindow, side: Side): NetRow[] {
  if (!venues.length) return [];
  const inList = venues.map(() => '?').join(', ');
  const rows = (s as unknown as { db: { prepare(sql: string): { all(...a: unknown[]): unknown[] } } }).db.prepare(
    `SELECT t.address, t.venue, t.pnl, t.volume, t.trades, t.exact, t.wins, t.closes, t.account_value, t.label, t.assets,
         t.win_exact, a.account_id
       FROM trader_win t
       LEFT JOIN accounts a ON a.venue = t.venue AND a.address = t.address
       WHERE t.win = ? AND t.venue IN (${inList}) AND t.address IN (
         SELECT address FROM trader_win WHERE win = ? AND venue IN (${inList}) AND pool = ?)`,
  ).all(window, ...venues, window, ...venues, side) as Array<Record<string, unknown>>;
  const by = new Map<string, NetRow>();
  const add = (a: number | null, b: unknown): number | null => (typeof b === 'number' ? (a ?? 0) + b : a);
  for (const r of rows) {
    const address = r.address as string;
    let assets: string[] = [];
    try {
      const x = JSON.parse(String(r.assets ?? '[]'));
      if (Array.isArray(x)) assets = x.filter((s): s is string => typeof s === 'string');
    } catch { /* none */ }
    const cur = by.get(address) ?? {
      address, venues: [], pnl: 0, volume: null, trades: null, exact: true, wins: null, closes: null, winExact: true,
      accountValue: null, label: null, assets: [],
    };
    cur.venues.push(r.venue as Venue);
    cur.pnl += r.pnl as number;
    cur.volume = add(cur.volume, r.volume);
    cur.trades = add(cur.trades, r.trades);
    cur.exact = cur.exact && r.exact === 1;
    cur.wins = add(cur.wins, r.wins);
    cur.closes = add(cur.closes, r.closes);
    cur.winExact = cur.winExact && r.win_exact === 1 && typeof r.closes === 'number';
    cur.accountValue = add(cur.accountValue, r.account_value);
    cur.label = cur.label ?? (typeof r.label === 'string' ? r.label : null);
    cur.assets = [...new Set([...cur.assets, ...assets])];
    if (r.venue === 'sodex' && typeof r.account_id === 'number') cur.accountId = r.account_id;
    by.set(address, cur);
  }
  return [...by.values()];
}

function oldToRow(r: BoardRow, window: BoardWindow, rank: number): TraderRow {
  return {
    venue: r.venue, address: r.address, label: shownLabel(r.address, r.label), accountId: r.accountId, accountValue: r.accountValue,
    pnl: { [window]: r.pnl }, roi: {}, volume: { [window]: r.volume }, winRate: r.winRate,
    winRateExact: r.winRate === null ? undefined : !!r.winExact, winRateCloses: r.winCloses ?? null, winRateFrom: r.winFrom ?? null,
    trades: r.trades, tradesCapped: r.tradesCapped, assets: r.assets, rank, rankChange: r.rankChange ?? null,
  } as TraderRow;
}

function oldBoardPage(venue: Venue | 'all' | readonly Venue[], window: BoardWindow, side: Side, filter: BoardFilter, o: { limit: number; offset: number; q?: string }): BoardPage | null {
  const s = reader();
  if (!s) return null;
  const venues: readonly Venue[] = venue === 'all' ? VENUES : typeof venue === 'string' ? [venue] : venue;
  let boards;
  try {
    boards = venues.map((v) => s.readBoard(v, window, side, filter)).filter((b) => b !== null);
  } catch {
    return null;
  }
  if (!boards.length) return null;
  let rows = boards.length === 1 ? boards[0]!.rows : mergeBoards(boards.map((b) => b.rows), side);
  if (boards.length > 1) rows = rows.map((r) => ({ ...r, rankChange: null }));
  const q = o.q?.trim().toLowerCase();
  if (q) rows = rows.filter((r) => r.address.includes(q) || labelMatches(r.address, r.label, q));
  const which = side === 'worst' ? 'Lowest' : 'Highest';
  const who = filter === 'active' ? 'traders with more than one trade' : 'traders';
  const what = venues.length === 1 && venues[0] === 'tradexyz' ? 'realised PnL (closed trades, net of fees)' : 'PnL';
  const shownRows = rows.slice(o.offset, o.offset + o.limit).map((r, i) => oldToRow(r, window, o.offset + i + 1));
  const sodexTrades = markSodexTrades(shownRows, window);
  return {
    ...(sodexTrades ? { sodexTrades } : {}),
    rows: shownRows,
    total: rows.length,
    updatedAt: Math.max(...boards.map((b) => b.meta.sourceAt || b.meta.updatedAt)),
    source: `ValueDesk index. ${which} ${what} over ${WINDOW_WORD[window]} among ${who} in that window.`,
    index: {
      complete: boards.every((b) => b.meta.complete) && boards.length === venues.length,
      pending: boards.reduce((n, b) => n + b.meta.pending, 0),
      updatedAt: Math.min(...boards.map((b) => b.meta.updatedAt)),
      rankSince: boards.length === 1 ? boards[0]!.meta.rankSince ?? null : null,
    },
  };
}

function oldNetToRow(r: NetRow, window: BoardWindow, rank: number): TraderRow {
  const wr = winRateOf(r.wins, r.closes, r.winExact);
  return {
    venue: r.venues[0]!, venues: r.venues, address: r.address, label: shownLabel(r.address, r.label), accountId: r.accountId ?? undefined,
    accountValue: r.accountValue, pnl: { [window]: r.pnl }, roi: {}, volume: { [window]: r.volume }, winRate: wr.winRate,
    winRateExact: wr.winRate === null ? undefined : wr.winRateExact, winRateCloses: wr.winRateCloses, trades: r.trades, tradesCapped: !r.exact,
    assets: r.assets.slice(0, 3), rank, rankChange: null,
  } as TraderRow;
}

function oldNetPage(venues: readonly Venue[], window: BoardWindow, side: Side, filter: BoardFilter, o: { limit: number; offset: number; q?: string }): BoardPage | null {
  const s = reader();
  if (!s) return null;
  let rows: NetRow[];
  const set = venues.includes('hyperliquid') ? venues.filter((v) => v !== 'tradexyz') : venues;
  try {
    rows = oldNetCandidates(s, set, window, side);
  } catch {
    return null;
  }
  if (!rows.length) return null;
  rows.sort((a, b) => (side === 'worst' ? a.pnl - b.pnl : b.pnl - a.pnl));
  const picked: NetRow[] = [];
  let pending = 0;
  for (const r of rows) {
    if (picked.length >= BOARD_SIZE) break;
    if (side === 'top' ? r.pnl <= 0 : r.pnl >= 0) break;
    if (filter === 'active') {
      if ((r.trades ?? 0) < MIN_TRADES) {
        if (!r.exact) pending++;
        continue;
      }
    }
    picked.push(r);
  }
  const q = o.q?.trim().toLowerCase();
  const shown = q ? picked.filter((r) => r.address.includes(q) || labelMatches(r.address, r.label, q)) : picked;
  const metas = venues.map((v) => s.readBoard(v, window, side, filter)?.meta).filter((m) => !!m);
  const which = side === 'worst' ? 'Lowest' : 'Highest';
  const who = filter === 'active' ? ', among traders with more than one trade in that window' : '';
  const shownRows = shown.slice(o.offset, o.offset + o.limit).map((r, i) => oldNetToRow(r, window, o.offset + i + 1));
  const sodexTrades = markSodexTrades(shownRows, window);
  return {
    ...(sodexTrades ? { sodexTrades } : {}),
    rows: shownRows,
    total: shown.length,
    updatedAt: Math.max(0, ...metas.map((m) => m.sourceAt || m.updatedAt)),
    source: `ValueDesk index. ${which} PnL over ${WINDOW_WORD[window]}, netted per address across ${venues.map((v) => VENUE_WORD[v]).join(' + ')}${who}.`,
    index: {
      complete: pending === 0 && metas.length === venues.length && metas.every((m) => m.complete),
      pending,
      updatedAt: Math.min(...metas.map((m) => m.updatedAt), Date.now()),
    },
  };
}

// --- the checks ------------------------------------------------------------------------------------------------------------

type Ask = { venues: Venue[]; side: Side; filter: BoardFilter; o: { limit: number; offset: number; q?: string } };
const ALL5 = [...VENUES];
const ASKS: Ask[] = [
  // The default view: every venue, netted, 30 days, top, 2+ trades (web lbState.ts).
  { venues: ALL5, side: 'top', filter: 'active', o: { limit: 100, offset: 0 } },
  { venues: ALL5, side: 'top', filter: 'any', o: { limit: 100, offset: 0 } },
  { venues: ALL5, side: 'worst', filter: 'active', o: { limit: 100, offset: 0 } },
  { venues: ['sodex', 'hyperliquid'], side: 'top', filter: 'any', o: { limit: 50, offset: 50 } },
  { venues: ['lighter', 'sodex', 'arcus'], side: 'worst', filter: 'any', o: { limit: 100, offset: 0, q: '0x' } },
  { venues: ALL5, side: 'top', filter: 'any', o: { limit: 100, offset: 0, q: 'name' } },
  { venues: ['tradexyz', 'arcus'], side: 'top', filter: 'active', o: { limit: 100, offset: 0 } },
];

function sameAsBefore(label: string): void {
  for (const a of ASKS) {
    const want = JSON.stringify(oldNetPage(a.venues, WINDOW, a.side, a.filter, a.o));
    assert.equal(JSON.stringify(netPage(a.venues, WINDOW, a.side, a.filter, a.o)), want, `${label}: net ${JSON.stringify(a)}`);
    assert.equal(JSON.stringify(boardPage(a.venues, WINDOW, a.side, a.filter, a.o)), JSON.stringify(oldBoardPage(a.venues, WINDOW, a.side, a.filter, a.o)), `${label}: boards ${JSON.stringify(a)}`);
  }
  for (const v of ['sodex', 'all'] as const) {
    assert.equal(JSON.stringify(boardPage(v, WINDOW, 'top', 'any', { limit: 100, offset: 0 })), JSON.stringify(oldBoardPage(v, WINDOW, 'top', 'any', { limit: 100, offset: 0 })), `${label}: board ${v}`);
  }
}

test('netted and board pages are byte for byte the code before: first read, kept read, after writes and a learned account id', () => {
  clearKeptBoards();
  sameAsBefore('first read');
  const read = keptStats.netRead;
  assert.ok(read > 0, 'the pools were read');
  sameAsBefore('kept read');
  assert.equal(keptStats.netRead, read, 'the second round read no pool again');
  assert.ok(keptStats.netHit > 0 && keptStats.boardHit > 0, 'answered from what was kept');

  // One venue's trader_win written again (a build): its version moves, every pool holding it is read again.
  const changed = winsOf('hyperliquid', 77).map((r, i) => (i === 5 ? { ...r, pnl: 9e9, label: 'moved' } : r));
  writer.writeTraderWin('hyperliquid', WINDOW, changed);
  sameAsBefore('after trader_win');
  assert.ok(keptStats.netRead > read, 'read again');
  const top = netPage(ALL5, WINDOW, 'top', 'any', { limit: 3, offset: 0 })!;
  assert.equal(top.rows[0]!.address, A(VENUES.indexOf('hyperliquid') * 650 + 5), 'the moved row leads');

  // The boards written again: their rows are read again.
  const boardsRead = keptStats.boardRead;
  writeBoards(NOW + 5_000);
  sameAsBefore('after boards');
  assert.ok(keptStats.boardRead > boardsRead);

  // A SoDEX account id learned for a row on screen (the pool's version does not move for it): shown at once.
  const net = netPage(['sodex', 'lighter'], WINDOW, 'top', 'any', { limit: 100, offset: 0 })!;
  const noId = net.rows.find((r) => r.venues?.includes('sodex') && r.accountId === undefined)!;
  assert.ok(noId, 'a SoDEX row without an id');
  writer.upsertAccount('sodex', noId.address, { accountId: 123_456 });
  sameAsBefore('after an account id');
  assert.equal(netPage(['sodex', 'lighter'], WINDOW, 'top', 'any', { limit: 100, offset: 0 })!.rows.find((r) => r.address === noId.address)!.accountId, 123_456);
});

test('a kept pool is not changed by what a request does with its rows', () => {
  clearKeptBoards();
  const a = netPage(ALL5, WINDOW, 'top', 'any', { limit: 100, offset: 0 })!;
  const before = JSON.stringify(netPage(ALL5, WINDOW, 'top', 'any', { limit: 100, offset: 0 }));
  // What the route does to the rows it sends (curves, trade counts): on copies.
  for (const r of a.rows) { r.spark = [1, 2]; r.tradesCapped = true; r.venues?.push('arcus'); r.assets?.push('X'); }
  const b = boardPage('sodex', WINDOW, 'top', 'any', { limit: 100, offset: 0 })!;
  for (const r of b.rows) r.assets?.push('X');
  assert.equal(JSON.stringify(netPage(ALL5, WINDOW, 'top', 'any', { limit: 100, offset: 0 })), before);
  assert.equal(JSON.stringify(boardPage('sodex', WINDOW, 'top', 'any', { limit: 100, offset: 0 })), JSON.stringify(oldBoardPage('sodex', WINDOW, 'top', 'any', { limit: 100, offset: 0 })));
});

test('a file without trader_win versions (an older writer) keeps nothing and answers as before', () => {
  clearKeptBoards();
  const s = reader()!;
  const keys = VENUES.map((v) => `tw|${v}|${WINDOW}`);
  const saved = keys.map((k) => writer.getMeta(k));
  for (const k of keys) writer.db.prepare('DELETE FROM meta WHERE key = ?').run(k);
  try {
    assert.equal(s.traderWinVersion(ALL5, WINDOW), null);
    const read = keptStats.netRead;
    sameAsBefore('no versions');
    sameAsBefore('no versions, again');
    assert.equal(keptStats.netHit, 0, 'nothing kept');
    assert.ok(keptStats.netRead > read);
  } finally {
    keys.forEach((k, i) => { if (saved[i] !== null) writer.setMeta(k, saved[i]!); });
  }
  assert.ok(s.traderWinVersion(ALL5, WINDOW));
});

test('writeTraderWin moves the version every time, past the clock too', () => {
  const s = reader()!;
  const v0 = s.traderWinVersion(['arcus'], WINDOW);
  writer.writeTraderWin('arcus', WINDOW, winsOf('arcus', 5));
  const v1 = s.traderWinVersion(['arcus'], WINDOW);
  writer.writeTraderWin('arcus', WINDOW, winsOf('arcus', 5));
  const v2 = s.traderWinVersion(['arcus'], WINDOW);
  assert.notEqual(v0, v1);
  assert.notEqual(v1, v2);
  writer.setMeta(`tw|arcus|${WINDOW}`, String(Date.now() + 86_400_000));
  writer.writeTraderWin('arcus', WINDOW, winsOf('arcus', 5));
  assert.equal(Number(writer.getMeta(`tw|arcus|${WINDOW}`)), Number(s.traderWinVersion(['arcus'], WINDOW)!.split('|')[1]));
  assert.ok(Number(writer.getMeta(`tw|arcus|${WINDOW}`)) > Date.now() + 86_000_000, 'one more than the last, not the clock');
});

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

test('benchmark: the default leaderboard read, the code before against a kept read', (t) => {
  clearKeptBoards();
  const ask = ASKS[0]!;
  const N = 60;
  const before: number[] = [];
  const kept: number[] = [];
  const miss: number[] = [];
  for (let i = 0; i < N; i++) {
    let t0 = performance.now();
    oldNetPage(ask.venues, WINDOW, ask.side, ask.filter, ask.o);
    before.push(performance.now() - t0);
    // A read that finds nothing kept (after each build): the pool read as before, plus its versions.
    clearKeptBoards();
    t0 = performance.now();
    netPage(ask.venues, WINDOW, ask.side, ask.filter, ask.o);
    miss.push(performance.now() - t0);
    t0 = performance.now();
    netPage(ask.venues, WINDOW, ask.side, ask.filter, ask.o);
    kept.push(performance.now() - t0);
  }
  const b = median(before);
  const k = median(kept);
  const s = reader()!;
  const rows = (s.db.prepare(`SELECT COUNT(*) AS n FROM trader_win WHERE win = ?`).get(WINDOW) as { n: number }).n;
  const line = `netPage 5 venues 30d top 2+ trades (${rows} trader_win rows): before ${b.toFixed(2)} ms median, nothing kept ${median(miss).toFixed(2)} ms, kept ${k.toFixed(3)} ms median (${(b / k).toFixed(0)}x)`;
  t.diagnostic(line);
  console.log(line);
  assert.ok(k < b, line);

  const bb: number[] = [];
  const bk: number[] = [];
  for (let i = 0; i < N; i++) {
    let t0 = performance.now();
    oldBoardPage('sodex', WINDOW, 'top', 'active', { limit: 100, offset: 0 });
    bb.push(performance.now() - t0);
    t0 = performance.now();
    boardPage('sodex', WINDOW, 'top', 'active', { limit: 100, offset: 0 });
    bk.push(performance.now() - t0);
  }
  const line2 = `boardPage sodex 30d top: before ${median(bb).toFixed(3)} ms median, kept ${median(bk).toFixed(3)} ms median`;
  t.diagnostic(line2);
  console.log(line2);
});

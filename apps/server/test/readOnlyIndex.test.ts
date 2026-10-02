/**
 * Run: npx tsx --test test/readOnlyIndex.test.ts   (from apps/server)
 *
 * The API side reads the index through a READ-ONLY connection
 * (indexer/reader.ts). It must never write to the file or migrate it: in
 * production it is a process of its own (VALUESCAN_INDEXER=0) next to the
 * indexer, which owns the only writing connection.
 *
 *   - a copy of an index, opened and read the way the API does, is byte for
 *     byte and to the millisecond of its mtime what it was;
 *   - a file the writer has not brought to this code's schema reads as "no
 *     index" and is left alone - the reader no longer migrates it;
 *   - a missing file creates nothing;
 *   - the dev setup still works: the writer on a worker thread, the reader on
 *     the main thread of the same process.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { IndexStore, type TraderWin } from '../src/indexer/store.js';
import { RETRY_MS, closeReader, reader } from '../src/indexer/reader.js';
import { _cohortLoad, attachStats, boardPage, cohortsRead, indexerStatus, netPage, winRatesFor } from '../src/indexer/read.js';
import { boardHoldings } from '../src/indexer/held.js';
import type { TraderRow, Venue } from '../src/valuescan/types.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'vs-ro-'));
  dirs.push(d);
  return d;
}
after(() => {
  _cohortLoad.reset();
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } catch { /* left for the OS */ }
  }
});

const NOW = Date.UTC(2026, 9, 2, 12);
/** An mtime no test run can produce by itself. */
const OLD = new Date('2001-02-03T04:05:06.000Z');
const A = (i: number): string => `0x${i.toString(16).padStart(40, '0')}`;

/** What the file is: every byte, its size and its mtime. */
function snap(path: string): { sha: string; size: number; mtimeMs: number } {
  const st = statSync(path);
  return { sha: createHash('sha256').update(readFileSync(path)).digest('hex'), size: st.size, mtimeMs: st.mtimeMs };
}

/** Rows in every table the API reads. */
function seed(w: IndexStore): void {
  for (const venue of ['hyperliquid', 'sodex'] as const) {
    const all: string[] = [];
    const wins: TraderWin[] = [];
    for (const side of ['top', 'worst'] as const) {
      const base = side === 'top' ? 0 : 100;
      const rows = Array.from({ length: 5 }, (_, i) => ({
        rank: i + 1, venue, address: A(base + i), label: i === 0 ? 'first' : null, accountId: venue === 'sodex' ? 5_000 + base + i : null,
        pnl: side === 'top' ? 1_000 - i : -1_000 + i, volume: 50_000, trades: 12, tradesCapped: false,
        winRate: 0.6, winExact: true, winCloses: 5, winFrom: null, rankChange: 0, accountValue: 10_000, assets: ['BTC'],
      }));
      w.writeBoard({ venue, window: '30d', side, filter: 'any', updatedAt: NOW, sourceAt: NOW, complete: true, pending: 0, scanned: 10, note: null, rankSince: null }, rows);
      wins.push(...rows.map((r): TraderWin => ({
        venue, address: r.address, pool: side, pnl: r.pnl, volume: r.volume, trades: r.trades, exact: true, wins: 3, closes: 5, winExact: true,
        accountValue: r.accountValue, label: r.label, assets: r.assets,
      })));
      all.push(...rows.map((r) => r.address));
    }
    w.writeTraderWin(venue, '30d', wins);
    w.putTraderStats(all.map((address) => ({ venue, window: '30d' as const, address, trades: 12, tradesExact: true, wins: 3, closes: 5, winExact: true, winFrom: null, at: NOW })));
    w.putCohortMembers(venue, all.map((address, i) => ({ address, pnl: 1_000 * (i + 1), equity: 200_000 * (i + 1), label: null, pnl1d: 1, pnl7d: 7, pnl30d: 30 })), NOW);
    w.putCohortBooks(all.map((address, i) => ({
      venue, address, equity: 200_000 * (i + 1), at: NOW - i,
      positions: [{ symbol: venue === 'sodex' ? 'BTC-USD' : 'BTC', szi: i % 2 ? -1 : 2, entry: 59_000 }],
    })));
  }
  w.putCohortMarks([['hyperliquid|BTC', 60_000], ['sodex|BTC-USD', 60_100]], NOW);
  w.putCohortSeries([{ scope: 'hyperliquid', cohort: 'whale', t: NOW - 900_000, long: 10, short: 5 }]);
  w.upsertAccount('sodex', A(0), { accountId: 5_000 });
  w.setMeta('indexer_status', JSON.stringify({ ok: true }));
}

/** A finished index file with nothing beside it (the writer's close folds the log into it). */
function makeIndex(dir: string, name = 'index.db'): string {
  const path = join(dir, name);
  const w = new IndexStore(path);
  seed(w);
  w.close();
  return path;
}

function copyWithOldTime(src: string, to: string): string {
  copyFileSync(src, to);
  utimesSync(to, OLD, OLD);
  return to;
}

test('a read-only store leaves a copy of the index as it was: every byte, its size and its mtime', () => {
  const dir = tmp();
  const copy = copyWithOldTime(makeIndex(dir), join(dir, 'copy.db'));
  const before = snap(copy);
  assert.equal(before.mtimeMs, OLD.getTime());

  const r = new IndexStore(copy, { readOnly: true });
  try {
    assert.equal(r.schemaReady(), true);
    // Everything the API side reads.
    assert.equal(r.readBoard('hyperliquid', '30d', 'top', 'any')!.rows.length, 5);
    assert.equal(r.netCandidates(['hyperliquid', 'sodex'], '30d', 'top').length, 5);
    assert.equal(r.traderStats('sodex', '30d', [A(0), A(100)]).size, 2);
    assert.equal(r.cohortMembersPage('hyperliquid', '', 100).length, 10);
    assert.equal(r.cohortBooksPage('sodex', '', 100).length, 10);
    assert.equal(r.cohortBook('sodex', A(1))!.positions[0]!.szi, -1);
    assert.equal(r.cohortMarks().get('sodex|BTC-USD'), 60_100);
    assert.equal(r.cohortSeries('hyperliquid', 0).length, 1);
    assert.deepEqual(r.cohortMix('hyperliquid', 0), []);
    assert.equal(r.accountAddress('sodex', 5_000), A(0));
    assert.equal(r.getMeta('indexer_status'), JSON.stringify({ ok: true }));
    // ... and nothing it could write with: SQLite itself refuses.
    assert.throws(() => r.setMeta('schema', '2'), /readonly/i);
    assert.throws(() => r.db.exec('CREATE TABLE x (a)'), /readonly/i);
    assert.throws(() => r.db.exec("DELETE FROM fills WHERE venue = 'arcus'"), /readonly/i);
  } finally {
    r.close();
  }
  assert.deepEqual(snap(copy), before);
  // SQLite keeps a WAL-mode file's index of its log beside it even for a reader; the log itself stays empty.
  if (existsSync(`${copy}-wal`)) assert.equal(statSync(`${copy}-wal`).size, 0);
});

test('the API reads - boards, netting, stats, cohorts, positioning - leave the file as it was', () => {
  const dir = tmp();
  const copy = copyWithOldTime(makeIndex(dir), join(dir, 'copy.db'));
  const before = snap(copy);
  process.env.VALUESCAN_INDEX_DB = copy;
  _cohortLoad.reset();
  try {
    const page = boardPage('hyperliquid', '30d', 'top', 'any', { limit: 50, offset: 0 });
    assert.equal(page?.total, 5);
    assert.equal(boardPage('all', '30d', 'worst', 'any', { limit: 50, offset: 0 })?.rows.length, 10);
    assert.equal(netPage(['hyperliquid', 'sodex'], '30d', 'top', 'any', { limit: 50, offset: 0 })?.total, 5);
    const rows: TraderRow[] = [{ venue: 'sodex', address: A(0), label: null, pnl: {}, roi: {}, volume: {} } as TraderRow];
    attachStats(rows, '30d');
    assert.equal(rows[0]!.trades, 12);
    assert.equal(winRatesFor('hyperliquid', '30d', [A(1)]).get(A(1))?.trades, 12);
    const cohorts = cohortsRead(['hyperliquid', 'sodex'] as Venue[], {});
    assert.equal(cohorts?.coverage.hyperliquid?.members, 10);
    assert.deepEqual(indexerStatus(), { ok: true });
    assert.equal(boardHoldings('sodex')?.held, 10);
    assert.throws(() => reader()!.setMeta('schema', '2'), /readonly/i);
  } finally {
    _cohortLoad.reset();
  }
  assert.deepEqual(snap(copy), before);
});

test('what a killed writer leaves behind - a log not folded in yet: the reader reads it and changes neither file', () => {
  const dir = tmp();
  const path = join(dir, 'live.db');
  const w = new IndexStore(path);
  let crashed: string;
  try {
    seed(w);
    // The writer is still open: the rows above are in the log, not in the main file. Copied now, the
    // three files are what a process killed at this moment leaves (`tsx watch` does that on every save).
    assert.ok(statSync(`${path}-wal`).size > 0);
    crashed = join(dir, 'crashed.db');
    for (const ext of ['', '-wal', '-shm']) copyFileSync(path + ext, crashed + ext);
  } finally {
    w.close();
  }
  utimesSync(crashed, OLD, OLD);
  const before = { db: snap(crashed), wal: snap(`${crashed}-wal`).sha };

  const r = new IndexStore(crashed, { readOnly: true });
  try {
    assert.equal(r.schemaReady(), true);
    assert.equal(r.readBoard('sodex', '30d', 'worst', 'any')!.rows.length, 5);
    assert.equal(r.cohortBooksPage('hyperliquid', '', 100).length, 10);
    assert.equal(r.getMeta('indexer_status'), JSON.stringify({ ok: true }));
  } finally {
    r.close();
  }
  assert.deepEqual({ db: snap(crashed), wal: snap(`${crashed}-wal`).sha }, before);
});

test('the check can see a write: the read-write open the API used to do changes the same copy', () => {
  const dir = tmp();
  const copy = copyWithOldTime(makeIndex(dir), join(dir, 'copy.db'));
  const before = snap(copy);
  new IndexStore(copy).close();
  const after = snap(copy);
  assert.notEqual(after.mtimeMs, before.mtimeMs);
  assert.notEqual(after.sha, before.sha);
});

test('a file the writer has not migrated yet reads as "no index" and is left alone; the writer migrates it', () => {
  const dir = tmp();
  const old = copyWithOldTime(makeIndex(dir), join(dir, 'old.db'));
  // As an older release left it: without a column and a table this code reads.
  const raw = new DatabaseSync(old);
  raw.exec('ALTER TABLE boards DROP COLUMN rank_change; DROP TABLE fill_dirty;');
  raw.close();
  utimesSync(old, OLD, OLD);
  const before = snap(old);
  const columns = (): string[] => {
    const db = new DatabaseSync(old, { readOnly: true });
    try { return (db.prepare('PRAGMA table_info(boards)').all() as Array<{ name: string }>).map((c) => c.name); } finally { db.close(); }
  };
  assert.equal(columns().includes('rank_change'), false);

  process.env.VALUESCAN_INDEX_DB = old;
  _cohortLoad.reset();
  try {
    const direct = new IndexStore(old, { readOnly: true });
    assert.equal(direct.schemaReady(), false);
    direct.close();
    assert.equal(reader(), null);
    assert.equal(boardPage('hyperliquid', '30d', 'top', 'any', { limit: 10, offset: 0 }), null);
    assert.equal(boardHoldings('hyperliquid'), null);
    assert.equal(indexerStatus(), null);
    assert.deepEqual(snap(old), before, 'the reader added nothing');
    assert.equal(columns().includes('rank_change'), false);

    // The writer starts: the same file is brought up to date, by it alone.
    new IndexStore(old).close();
    assert.equal(columns().includes('rank_change'), true);
    // A failed attempt stands for RETRY_MS (no re-opening on every request) ...
    assert.ok(RETRY_MS >= 1_000);
    assert.equal(reader(), null);
    // ... and after it the file is read.
    closeReader();
    assert.notEqual(reader(), null);
    assert.equal(boardPage('hyperliquid', '30d', 'top', 'any', { limit: 10, offset: 0 })?.total, 5);
  } finally {
    _cohortLoad.reset();
  }
});

test('no index file: a reader creates nothing, not even the directory', () => {
  const dir = tmp();
  const path = join(dir, 'not-there', 'index.db');
  process.env.VALUESCAN_INDEX_DB = path;
  _cohortLoad.reset();
  try {
    assert.equal(reader(), null);
    assert.equal(boardPage('sodex', '30d', 'top', 'any', { limit: 10, offset: 0 }), null);
    assert.throws(() => new IndexStore(path, { readOnly: true }));
    assert.equal(existsSync(join(dir, 'not-there')), false);
    // The writer does create it.
    new IndexStore(path).close();
    assert.equal(existsSync(path), true);
  } finally {
    _cohortLoad.reset();
  }
});

test('the dev setup: the writer on a worker thread, the read-only reader on this one, in one process', async () => {
  const dir = tmp();
  const path = join(dir, 'index.db');
  const worker = new Worker(new URL('./readOnlyIndex.worker.ts', import.meta.url), { workerData: { path } });
  const next = (type: string): Promise<{ type: string; n?: number }> => new Promise((resolve, reject) => {
    const onMessage = (m: { type: string; n?: number }) => {
      if (m.type !== type) return;
      worker.off('message', onMessage);
      worker.off('error', reject);
      resolve(m);
    };
    worker.on('message', onMessage);
    worker.once('error', reject);
  });
  process.env.VALUESCAN_INDEX_DB = path;
  _cohortLoad.reset();
  try {
    await next('ready');
    // The writer has created the file and its schema; the reader opens it read-only beside it.
    const r = reader();
    assert.notEqual(r, null);
    assert.equal(boardPage('hyperliquid', '30d', 'top', 'any', { limit: 50, offset: 0 }), null, 'no board yet');

    worker.postMessage({ type: 'write', n: 3 });
    await next('wrote');
    assert.equal(boardPage('hyperliquid', '30d', 'top', 'any', { limit: 50, offset: 0 })?.total, 3);
    assert.deepEqual(indexerStatus(), { n: 3 });

    // The writer keeps writing while the reader's connection is open, and the reader sees each commit.
    for (const n of [7, 2, 40]) {
      worker.postMessage({ type: 'write', n });
      await next('wrote');
      assert.equal(boardPage('hyperliquid', '30d', 'top', 'any', { limit: 100, offset: 0 })?.total, n);
      assert.deepEqual(indexerStatus(), { n });
    }
    assert.equal(reader(), r, 'one connection, kept');
    assert.throws(() => r!.setMeta('indexer_status', 'x'), /readonly/i);
    assert.deepEqual(indexerStatus(), { n: 40 });
  } finally {
    _cohortLoad.reset();
    worker.postMessage({ type: 'stop' });
    await Promise.race([next('stopped'), new Promise((resolve) => setTimeout(resolve, 5_000))]).catch(() => {});
    await worker.terminate();
  }
});

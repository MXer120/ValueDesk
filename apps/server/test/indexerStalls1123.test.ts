/**
 * Run: npx tsx --test test/indexerStalls1123.test.ts   (from apps/server)
 *
 * The indexer stalls left after v0.2.243 (production stall profiles 2026-11-22/23):
 * - the checkpoint thread ended in the middle of a slow run, its work moved into the indexer's COMMITs (57 s);
 * - FULL checkpoints holding the write lock while the disk was slow, or while a reader kept them from finishing;
 * - the end of every Hyperliquid fill sync: up to 50,000 rows counted at once (fillExtent), and 2,000 rows a slice read
 *   with a table lookup each when the stream's copies were dropped (dropStreamRowsAsync).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Checkpointer, isHung } from '../src/indexer/checkpointer.js';
import { DROP_SLICE_MS, IndexStore, nextDropPage, type FillRow } from '../src/indexer/store.js';
import { HL_REACHABLE_FILLS, markCapped } from '../src/indexer/hlSource.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (what: string, ok: () => boolean, ms = 8_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`timed out: ${what}`);
    await sleep(10);
  }
};
const A = '0x00000000000000000000000000000000000000aa';
const T0 = 1_790_000_000_000;
const row = (i: number, src: 0 | 1, address = A): FillRow => ({
  venue: 'hyperliquid', address, id: `${src ? 'r' : 's'}${i}`, t: T0 + i * 1_000, symbol: 'BTC', side: 1, px: 100, sz: 1,
  fee: src ? 0.01 : null, closedPnl: src ? 0 : null, oid: null, src,
});
const tmp = () => mkdtempSync(join(tmpdir(), 'vs-st1123-'));
const rm = (dir: string) => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });

test('checkpoint hung rule: silence between runs ends it, a long run only past its own limit', () => {
  assert.equal(isHung(0, 0, 200_000, 180_000, 1_800_000), true, 'silent between runs');
  assert.equal(isHung(0, 100_000, 200_000, 180_000, 1_800_000), false);
  // 195 s inside one run (production 2026-11-23): working, not hung.
  assert.equal(isHung(5_000, 5_000, 200_000, 180_000, 1_800_000), false);
  assert.equal(isHung(5_000, 5_000, 1_900_000, 180_000, 1_800_000), true, 'a run past 30 min');
});

test('checkpoint thread: a run longer than hungMs is not ended', async () => {
  const seen: boolean[] = [];
  const dir = tmp();
  const path = join(dir, 'i.db');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (x)');
  // Each run holds 400 ms (a slow disk), the silence limit is 60 ms: before, the watchdog ended it at once.
  const c = new Checkpointer(path, (on) => seen.push(on), { everyMs: 20, hungMs: 60, runHungMs: 60_000, testRunHoldMs: 400 });
  try {
    await until('runs done', () => c.state.runs >= 3);
    assert.equal(c.state.restarts, 0, `never ended: ${JSON.stringify(c.state)}`);
    assert.deepEqual(seen, [false]);
  } finally {
    c.stop();
    db.close();
    rm(dir);
  }
});

test('checkpoint thread: a run past runHungMs is ended and the writer told', async () => {
  const seen: boolean[] = [];
  const dir = tmp();
  const path = join(dir, 'i.db');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (x)');
  const c = new Checkpointer(path, (on) => seen.push(on), { everyMs: 20, hungMs: 60, runHungMs: 100, testRunHoldMs: 5_000, restartAfterMs: 60_000 });
  try {
    await until('writer told', () => seen.includes(true));
    assert.match(c.state.lastError ?? '', /one run for/);
  } finally {
    c.stop();
    db.close();
    rm(dir);
  }
});

test('checkpoint thread: no FULL run after a slow PASSIVE one', async () => {
  const dir = tmp();
  const path = join(dir, 'i.db');
  const store = new IndexStore(path);
  try {
    // Every PASSIVE run counts as slow (limit -1 ms): FULL runs are skipped and counted, none is made.
    store.startCheckpointer({ everyMs: 20, restartFrames: 1, restartGapMs: 0, restartMaxPassiveMs: -1 });
    await until('thread up', () => store.checkpointStatus?.running === true);
    let i = 0;
    const start = Date.now();
    while (Date.now() - start < 1_500) {
      store.putFills(Array.from({ length: 200 }, () => row(i++, 1)));
      await sleep(5);
    }
    await until('a skip', () => (store.checkpointStatus?.fullsSkippedSlow ?? 0) > 0);
    assert.equal(store.checkpointStatus!.fulls, 0, JSON.stringify(store.checkpointStatus));
  } finally {
    store.close();
    rm(dir);
  }
});

test('the checkpoint thread gone: the writer thread checkpoints, not the indexer thread; without the writer thread, this connection', async () => {
  const dir = tmp();
  const path = join(dir, 'i.db');
  const store = new IndexStore(path);
  const auto = () => (store.db.prepare('PRAGMA wal_autocheckpoint').get() as { wal_autocheckpoint: number }).wal_autocheckpoint;
  try {
    store.startWriter({ force: true });
    store.startCheckpointer({ everyMs: 20 });
    await until('both up', () => store.checkpointStatus?.running === true && store.writerStatus?.running === true);
    assert.equal(auto(), 0);
    const ck = (store as unknown as { checkpointer: Checkpointer }).checkpointer;
    await ck.kill();
    await until('thread gone', () => store.checkpointStatus?.running === false);
    assert.equal(auto(), 0, 'the writer thread is up: this connection still leaves it');
    const w = (store as unknown as { writer: { kill(): Promise<number> } }).writer;
    await w.kill();
    await until('writer gone', () => store.writerStatus?.running === false);
    assert.ok(auto() > 0, 'neither thread: this connection checkpoints');
  } finally {
    store.close();
    rm(dir);
  }
});

test('drop slices follow their time: halved when slow, doubled when quick, within bounds', () => {
  assert.equal(nextDropPage(2_000, 10_000), 1_000);
  assert.equal(nextDropPage(60, 10_000), 50);
  assert.equal(nextDropPage(250, 1), 500);
  assert.equal(nextDropPage(2_000, 1), 2_000);
  assert.equal(nextDropPage(250, DROP_SLICE_MS), 250);
});

test('dropStreamRowsAsync in many slices drops every stream row of the range and nothing else', async () => {
  const dir = tmp();
  const store = new IndexStore(join(dir, 'i.db'));
  try {
    const rows: FillRow[] = [];
    for (let i = 0; i < 6_000; i++) rows.push(row(i, i % 3 === 0 ? 1 : 0));
    rows.push(row(1, 0, '0x00000000000000000000000000000000000000bb'));
    store.putFills(rows);
    let pauses = 0;
    // [1,000 s, 5,000 s]: rows 1,000..5,000 of A.
    await store.dropStreamRowsAsync('hyperliquid', A, T0 + 1_000_000, T0 + 5_000_000, async () => { pauses++; });
    const left = store.db.prepare('SELECT id, t, src FROM fills WHERE address = ? AND venue = ?').all(A, 'hyperliquid') as Array<{ id: string; t: number; src: number }>;
    const i = (r: { t: number }) => (r.t - T0) / 1_000;
    assert.equal(left.filter((r) => r.src === 0 && i(r) >= 1_000 && i(r) <= 5_000).length, 0, 'stream rows of the range gone');
    assert.equal(left.filter((r) => r.src === 1).length, 2_000, 'REST rows all kept');
    assert.equal(left.filter((r) => r.src === 0).length, rows.filter((r) => r.address === A && r.src === 0 && (i(r) < 1_000 || i(r) > 5_000)).length, 'stream rows outside the range kept');
    assert.ok(pauses >= 2, `loop let in between slices (${pauses})`);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM fills WHERE address = ?').get('0x00000000000000000000000000000000000000bb') as { n: number }).n, 1, 'other wallets untouched');
  } finally {
    store.close();
    rm(dir);
  }
});

test('fillCountAsync counts as fillExtent does, up to its cap, with the loop let in', async () => {
  const dir = tmp();
  const store = new IndexStore(join(dir, 'i.db'));
  try {
    store.putFills(Array.from({ length: 2_500 }, (_, i) => row(i, 1)));
    let pauses = 0;
    const pause = async () => { pauses++; };
    assert.equal(await store.fillCountAsync('hyperliquid', A, 50_000, pause), store.fillExtent('hyperliquid', A).count);
    assert.equal(await store.fillCountAsync('hyperliquid', A, 50_000, pause), 2_500);
    assert.ok(pauses >= 2);
    assert.equal(await store.fillCountAsync('hyperliquid', A, 1_200, pause), 1_200);
    assert.equal(await store.fillCountAsync('hyperliquid', '0xnone', 100, pause), 0);
    assert.equal(store.fillMinT('hyperliquid', A), store.fillExtent('hyperliquid', A).minT);
    assert.equal(store.fillMinT('hyperliquid', '0xnone'), null);
  } finally {
    store.close();
    rm(dir);
  }
});

test('markCapped: capped at the oldest held fill once HL_REACHABLE_FILLS-100 are held; fewer, or a range already there, unchanged', async () => {
  const dir = tmp();
  const store = new IndexStore(join(dir, 'i.db'));
  try {
    const B = '0x00000000000000000000000000000000000000cc';
    store.addCoverage('hyperliquid', A, 'fills', { fromT: T0 - 86_400_000, toT: T0 + 20_000_000 }, T0 + 20_000_000);
    store.addCoverage('hyperliquid', B, 'fills', { fromT: T0 - 86_400_000, toT: T0 + 20_000_000 }, T0 + 20_000_000);
    store.putFills(Array.from({ length: HL_REACHABLE_FILLS - 100 }, (_, i) => row(i + 5, 1)));
    store.putFills(Array.from({ length: 300 }, (_, i) => row(i + 5, 1, B)));
    await markCapped(store, A);
    await markCapped(store, B);
    const a = store.coverage('hyperliquid', A, 'fills')!;
    assert.equal(a.fromT, T0 + 5_000);
    assert.equal(a.capped, true);
    assert.equal(a.exhausted, true);
    const b = store.coverage('hyperliquid', B, 'fills')!;
    assert.equal(b.fromT, T0 - 86_400_000, 'too few to be capped');
    assert.ok(!b.capped);
  } finally {
    store.close();
    rm(dir);
  }
});

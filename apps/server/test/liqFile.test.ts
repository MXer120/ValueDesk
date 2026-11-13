/**
 * The level change log in a file of its own (store.ts LIQ_SCHEMA / liqDbPath, 2026-11-12): where it lives, the writer
 * thread writing it while the index's write lock is taken, readers before and after the move, and tools/liqSplit.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { IndexStore, LIQ_SCHEMA, hasTable, liqDbPath } from '../src/indexer/store.js';
import { liqSplit, liqUnsplit } from '../src/indexer/liqSplit.js';

const dir = () => mkdtempSync(join(tmpdir(), 'vs-liqfile-'));
const rm = (d: string) => rmSync(d, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 });
const all = (db: DatabaseSync, sql: string) => db.prepare(sql).all().map((r) => JSON.stringify(r));
const quiet = { log: () => {} };

/** An index as production's is before the split: the change log's tables in the index file. */
function oldIndex(path: string): IndexStore {
  const raw = new DatabaseSync(path);
  raw.exec(LIQ_SCHEMA);
  raw.close();
  return new IndexStore(path);
}

/** A step of `n` positions: new wallets, moves and closes. */
function step(k: number, n: number) {
  const changed = Array.from({ length: n }, (_, i) => ({
    aid: i % 5 === 0 ? `0xw${k}-${i}` : 10_000 + i, coin: i % 3 ? 'BTC' : 'ETH', venue: i % 2, side: i % 2 ? 1 : -1, liq: 100 + i + k, usd: 1_000 + i,
    sym: 'BTC', sz: 0.5 + i, entry: 99, mark: 101 + k, iso: i % 2 === 0, lev: 10, eq: 5_000, cash: null, readAt: k,
  }));
  const closed = Array.from({ length: Math.floor(n / 10) }, (_, i) => ({ aid: 50_000 + i, coin: 'SOL', venue: 1, mark: 20 }));
  const fresh = [...new Set(changed.flatMap((c) => (typeof c.aid === 'string' ? [c.aid] : [])))];
  return { changed, closed, fresh };
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, new Promise<T>((_, no) => setTimeout(() => no(new Error(`${what}: not done in ${ms} ms`)), ms).unref())]);

test('a new index keeps the change log in its own file, and the index file has none of its tables', () => {
  const d = dir();
  const path = join(d, 'x.db');
  const s = new IndexStore(path);
  try {
    assert.equal(s.liqFile, join(d, 'x-liq.db'));
    assert.equal(liqDbPath(path), s.liqFile);
    assert.ok(existsSync(s.liqFile!));
    for (const t of ['liq_addr', 'liq_log', 'liq_cur']) assert.equal(hasTable(s.db, t), false, `${t} not in the index`);
    const ids = s.putLiqLog(1_000, ['0xa'], [{ aid: '0xa', coin: 'BTC', venue: 0, side: 1, liq: 50, usd: 9 }], []);
    assert.equal(s.liqCur().length, 1);
    assert.deepEqual(s.liqLog([ids.get('0xa')!], 'BTC', 0).map((r) => r.liq), [50]);
    assert.ok(s.schemaReady(), 'a reader of the index needs nothing of the log');
  } finally {
    s.close();
    rm(d);
  }
});

test('an index from before keeps the log in the index file, written as before (also by the writer thread)', async () => {
  const d = dir();
  const path = join(d, 'old.db');
  const s = oldIndex(path);
  try {
    assert.equal(s.liqFile, null);
    assert.equal(existsSync(liqDbPath(path)), false, 'no liq file made');
    s.startWriter({ force: true, targetMs: 2, maxRows: 100 });
    const x = step(1, 500);
    await s.putLiqLogSliced(1_000, x.fresh, x.changed, x.closed, async () => {});
    assert.equal(s.writerStatus!.liqFile, false);
    assert.equal(Number((s.db.prepare('SELECT COUNT(*) AS n FROM liq_log').get() as { n: number }).n), 550);
  } finally {
    s.close();
    rm(d);
  }
});

test('writer thread: a step goes in while another process holds the index write lock and the store has writes waiting', async () => {
  const d = dir();
  const path = join(d, 'x.db');
  const s = new IndexStore(path, { aggRefreshMs: 0 });
  const blocker = new DatabaseSync(path);
  try {
    s.startWriter({ force: true, targetMs: 5, maxRows: 200 });
    const ctl = (s as unknown as { ctl: Int32Array }).ctl;
    blocker.exec('BEGIN IMMEDIATE');
    // A write of the indexer's thread waiting: the thread gives way to it on the index file, not on the log's.
    Atomics.add(ctl, 0, 1);
    let streamDone = false;
    const stream = s.putFillsAsync([{ venue: 'hyperliquid', address: '0x01', id: 'f1', t: Date.now(), symbol: 'BTC', side: 1, px: 1, sz: 1, fee: null, closedPnl: null, oid: null, src: 1 }], { stream: true }).then(() => { streamDone = true; });
    const x = step(2, 3_000);
    const ids = await withTimeout(s.putLiqLogSliced(2_000, x.fresh, x.changed, x.closed, async () => {}), 20_000, 'the step');
    assert.equal(ids.size, x.fresh.length);
    assert.equal(Number((s.liqDb!.prepare('SELECT COUNT(*) AS n FROM liq_log WHERE t = 2000').get() as { n: number }).n), 3_300);
    assert.equal(streamDone, false, 'the index file is still locked: the stream row waits');
    const st = s.writerStatus!;
    assert.equal(st.liqFile, true);
    assert.ok(st.liqTxs >= 2 && st.liqRows === 3_300, `liq transactions ${st.liqTxs}, rows ${st.liqRows}`);
    Atomics.sub(ctl, 0, 1);
    Atomics.notify(ctl, 0);
    blocker.exec('ROLLBACK');
    await withTimeout(stream, 20_000, 'the stream row');
    assert.ok(s.writerStatus!.yieldMs >= 0);
  } finally {
    try { blocker.exec('ROLLBACK'); } catch { /* none open */ }
    blocker.close();
    s.close();
    rm(d);
  }
});

test('a reader: the log empty before its file exists; through a split while it runs it finds the new file', () => {
  const d = dir();
  try {
    // No log yet: empty, no error.
    const freshPath = join(d, 'fresh.db');
    new IndexStore(freshPath).close();
    rmSync(liqDbPath(freshPath), { force: true });
    const r0 = new IndexStore(freshPath, { readOnly: true });
    assert.deepEqual(r0.liqCur(), []);
    assert.equal(r0.liqLogFrom(), null);
    r0.close();

    const path = join(d, 'x.db');
    const w = oldIndex(path);
    const ids = w.putLiqLog(1_000, ['0xa', '0xb'], [
      { aid: '0xa', coin: 'ETH', venue: 0, side: 1, liq: 2_500, usd: 10_000 },
      { aid: '0xb', coin: 'ETH', venue: 0, side: -1, liq: 2_700, usd: 20_000 },
    ], []);
    w.close();
    const r = new IndexStore(path, { readOnly: true });
    try {
      assert.equal(r.liqCur().length, 2, 'from the index file');
      liqSplit(path, quiet);
      assert.equal(r.liqCur().length, 2, 'from the new file');
      assert.deepEqual([...r.liqAddrIds(['0xa', '0xb']).values()].sort(), [...ids.values()].sort());
      assert.equal(r.liqAt('ETH', [0], 1_000, 2_400, 2_600).length, 1);
    } finally {
      r.close();
    }
  } finally {
    rm(d);
  }
});

test('liqSplit: an exact copy, the old tables kept, the index uses the file; undo brings them back with the rows since', async () => {
  const d = dir();
  const path = join(d, 'x.db');
  try {
    const w = oldIndex(path);
    for (let k = 1; k <= 4; k++) {
      const x = step(k, 2_000);
      await w.putLiqLogSliced(k * 900_000, x.fresh, x.changed, x.closed, async () => {});
    }
    const before = {
      log: all(w.db, 'SELECT * FROM liq_log ORDER BY aid, coin, venue, t'),
      cur: all(w.db, 'SELECT * FROM liq_cur ORDER BY aid, coin, venue'),
      addr: all(w.db, 'SELECT * FROM liq_addr ORDER BY id'),
    };
    w.close();

    const r = liqSplit(path, quiet);
    let curAfter = -1;
    assert.equal(r.rows.liq_log, before.log.length);
    assert.equal(r.file, liqDbPath(path));
    assert.equal(existsSync(`${r.file}.part`), false);
    assert.throws(() => liqSplit(path, quiet), /holds no liq_log/, 'once only');

    const s = new IndexStore(path);
    try {
      assert.equal(s.liqFile, r.file);
      assert.ok(hasTable(s.db, 'liq_log_old') && hasTable(s.db, 'liq_cur_old') && hasTable(s.db, 'liq_addr_old'), 'kept');
      assert.equal(hasTable(s.db, 'liq_log'), false);
      const lq = s.liqDb!;
      assert.deepEqual(all(lq, 'SELECT * FROM liq_log ORDER BY aid, coin, venue, t'), before.log);
      assert.deepEqual(all(lq, 'SELECT * FROM liq_cur ORDER BY aid, coin, venue'), before.cur);
      assert.deepEqual(all(lq, 'SELECT * FROM liq_addr ORDER BY id'), before.addr);
      assert.deepEqual(all(s.db, 'SELECT * FROM liq_log_old ORDER BY aid, coin, venue, t'), before.log);
      assert.ok(all(lq, "SELECT name FROM sqlite_master WHERE name = 'liq_log_cell'").length === 1, 'the cell index');
      assert.equal((lq.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
      // The tracker goes on from the moved state: a new address gets the next id.
      const ids = s.putLiqLog(5 * 900_000, ['0xlater'], [{ aid: '0xlater', coin: 'BTC', venue: 0, side: 1, liq: 1, usd: 1 }], [{ aid: 10_003, coin: 'ETH', venue: 1 }]);
      assert.equal(ids.get('0xlater'), before.addr.length + 1);
      curAfter = all(lq, 'SELECT * FROM liq_cur').length;
    } finally {
      s.close();
    }

    const u = liqUnsplit(path, { ...quiet, now: 42 });
    assert.deepEqual(u.added, { liq_addr: 1, liq_log: 2, liq_cur: curAfter });
    assert.equal(existsSync(liqDbPath(path)), false);
    assert.ok(existsSync(`${liqDbPath(path)}.undone-42`), 'kept');
    const back = new IndexStore(path);
    try {
      assert.equal(back.liqFile, null);
      assert.equal(all(back.db, 'SELECT * FROM liq_log').length, before.log.length + 2);
      assert.equal(back.liqAddrIds(['0xlater']).size, 1);
    } finally {
      back.close();
    }
  } finally {
    rm(d);
  }
});

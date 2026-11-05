import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Checkpointer } from '../src/indexer/checkpointer.js';
import { SlicedWork } from '../src/indexer/slicedWork.js';
import { IndexStore, type FillRow } from '../src/indexer/store.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (what: string, ok: () => boolean, ms = 8_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`timed out: ${what}`);
    await sleep(10);
  }
};

test('sliced work: a small flush runs within the call, in order', () => {
  const ran: number[] = [];
  const w = new SlicedWork({ budgetMs: 1_000, onError: (e) => assert.fail(String(e)) });
  w.add([() => ran.push(1), () => ran.push(2), () => ran.push(3)]);
  assert.deepEqual(ran, [1, 2, 3]);
  assert.equal(w.backlog, 0);
});

test('sliced work: past its budget the loop is let in, and nothing runs out of order', async () => {
  let clock = 0;
  const ran: string[] = [];
  let resumed = 0;
  const w = new SlicedWork({ budgetMs: 10, now: () => clock, onError: (e) => assert.fail(String(e)), onResume: () => resumed++ });
  const slow = (name: string) => () => { ran.push(name); clock += 10; };
  w.add([slow('a'), slow('b'), slow('c')]);
  assert.deepEqual(ran, ['a'], 'one slow step, then the loop');
  assert.equal(w.backlog, 2);
  // The next flush arrives before the first has finished: its steps go behind, none runs in between.
  w.add([slow('d')]);
  assert.deepEqual(ran, ['a']);
  await until('all ran', () => w.backlog === 0);
  assert.deepEqual(ran, ['a', 'b', 'c', 'd']);
  assert.equal(resumed, 3);
});

test('sliced work: a stop finishes everything within the call, and the waiting turn finds nothing to do', async () => {
  let clock = 0;
  const ran: number[] = [];
  const w = new SlicedWork({ budgetMs: 1, now: () => clock, onError: (e) => assert.fail(String(e)) });
  w.add([1, 2, 3].map((n) => () => { ran.push(n); clock += 5; }));
  assert.deepEqual(ran, [1]);
  w.drain();
  assert.deepEqual(ran, [1, 2, 3]);
  await sleep(5);
  assert.deepEqual(ran, [1, 2, 3], 'nothing twice');
});

test('sliced work: a failing step is told and the next still runs', () => {
  const errs: unknown[] = [];
  const ran: number[] = [];
  const w = new SlicedWork({ budgetMs: 1_000, onError: (e) => errs.push(e) });
  w.add([() => { throw new Error('x'); }, () => ran.push(2)]);
  assert.equal(errs.length, 1);
  assert.deepEqual(ran, [2]);
});

const fill = (i: number): FillRow => ({
  venue: 'hyperliquid', address: `0x${String(i % 7).padStart(40, '0')}`, id: `f${i}`, t: 1_780_000_000_000 + i, symbol: 'BTC', side: i % 2 ? 1 : 0,
  px: 100 + i, sz: 1, fee: 0.1, closedPnl: 0, oid: null, src: 0,
} as FillRow);

test('checkpoint thread: the WAL is moved into the file by the thread, and every row reads back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-ckpt-'));
  const path = join(dir, 'i.db');
  const store = new IndexStore(path);
  try {
    store.startCheckpointer({ everyMs: 20 });
    await until('thread up', () => store.checkpointStatus?.running === true);
    assert.equal((store.db.prepare('PRAGMA wal_autocheckpoint').get() as { wal_autocheckpoint: number }).wal_autocheckpoint, 0, 'the writer leaves it to the thread');
    const size0 = statSync(path).size;
    let i = 0;
    for (let b = 0; b < 40; b++) store.putFills(Array.from({ length: 200 }, () => fill(i++)));
    await until('checkpointed', () => (store.checkpointStatus?.runs ?? 0) > 2 && store.checkpointStatus!.done === store.checkpointStatus!.log && statSync(path).size > size0);
    const n = store.db.prepare('SELECT COUNT(*) AS n FROM fills').get() as { n: number };
    assert.equal(n.n, 8_000);
    const other = new DatabaseSync(path, { readOnly: true });
    assert.equal((other.prepare('SELECT COUNT(*) AS n FROM fills').get() as { n: number }).n, 8_000, 'another reader sees the same');
    other.close();
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test('checkpoint thread: when it dies the writer checkpoints for itself, and a new one takes over', async () => {
  const seen: boolean[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'vs-ckpt-'));
  const path = join(dir, 'i.db');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (x)');
  const c = new Checkpointer(path, (on) => seen.push(on), { everyMs: 10, restartAfterMs: 20 });
  try {
    await until('up', () => c.state.running);
    assert.deepEqual(seen, [false]);
    await c.kill();
    await until('writer told', () => seen.includes(true));
    assert.equal(c.state.restarts, 1);
    await until('back', () => c.state.running);
    assert.deepEqual(seen, [false, true, false]);
  } finally {
    c.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
  assert.equal(seen.at(-1), true, 'stopped: the writer does them again');
});

test('checkpoint thread: a hung thread is ended', async () => {
  const seen: boolean[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'vs-ckpt-'));
  const path = join(dir, 'i.db');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (x)');
  // Asked for a run so far apart that it says nothing after its first word.
  const c = new Checkpointer(path, (on) => seen.push(on), { everyMs: 60_000, hungMs: 60, restartAfterMs: 60_000 });
  try {
    await until('writer told', () => seen.includes(true));
    assert.equal(c.state.running, false);
  } finally {
    c.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

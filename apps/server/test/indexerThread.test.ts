import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Checkpointer } from '../src/indexer/checkpointer.js';
import { SlicedWork, readInSlices } from '../src/indexer/slicedWork.js';
import { IndexStore, type FillRow } from '../src/indexer/store.js';
import { flushBudget, inKeyOrder } from '../src/indexer/engine.js';

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

test('read in slices: all of it within the call when it fits, and the loop let in when it does not', async () => {
  const run = (budgetMs: number) => {
    let left = 3;
    let done = 0;
    let clock = 0;
    readInSlices({ budgetMs, now: () => clock, page: () => { clock += 10; return left-- > 0 ? 1 : 0; }, done: () => done++, onError: (e) => assert.fail(String(e)) });
    return { get done() { return done; } };
  };
  assert.equal(run(1_000).done, 1, 'within the call');
  const slow = run(5);
  assert.equal(slow.done, 0, 'after one page the loop goes first');
  await until('all read', () => slow.done === 1);
});

test('read in slices: a stop ends it, and done never runs', async () => {
  let stopped = false;
  let pages = 0;
  let done = 0;
  let clock = 0;
  readInSlices({ budgetMs: 1, now: () => clock, stopped: () => stopped, page: () => { clock += 5; return ++pages; }, done: () => done++, onError: (e) => assert.fail(String(e)) });
  stopped = true;
  await sleep(10);
  assert.equal(pages, 1);
  assert.equal(done, 0);
});

test('a flush that falls behind gets more of the thread, and catches up where a flat slice never would', async () => {
  assert.equal(flushBudget(0), 40);
  assert.equal(flushBudget(1_000), 400, 'behind: one bounded slice, not seconds of the thread');
  assert.equal(flushBudget(5, 300), 300, 'as long as the rest of the thread took');
  assert.equal(flushBudget(5, 9_000), 400, 'and no longer');
  assert.equal(flushBudget(3_000), 900, 'far behind it climbs');
  assert.equal(flushBudget(10_000), 2_000);
  // A turn of the loop costs 400 ms of other work; a step 100 ms; 2.5 steps arrive per second. A model of the thread, not a measurement.
  const simulate = (budget: (b: number) => number) => {
    let backlog = 500;
    for (let t = 0; t < 600; ) {
      const run = Math.min(backlog, Math.max(1, Math.ceil(budget(backlog) / 100)));
      const spent = run * 100 + 400;
      backlog = backlog - run + (spent / 1000) * 2.5;
      t += spent / 1000;
    }
    return backlog;
  };
  assert.ok(simulate(() => 40) > 500, 'flat: behind for good');
  assert.ok(simulate(flushBudget) < 100, 'scaled: catches up');
});

test('sliced work: the budget is asked of the backlog at each turn', async () => {
  const asked: number[] = [];
  let clock = 0;
  const w = new SlicedWork({ budgetMs: (b) => { asked.push(b); return 1; }, now: () => clock, onError: (e) => assert.fail(String(e)) });
  w.add([1, 2, 3].map(() => () => { clock += 5; }));
  await until('done', () => w.backlog === 0);
  assert.deepEqual(asked, [3, 2, 1]);
});

test('sliced work: a step that ran is let go at once, with a backlog still standing, and its order holds across the cut', async () => {
  let clock = 0;
  const ran: number[] = [];
  const w = new SlicedWork({ budgetMs: 1, now: () => clock, onError: (e) => assert.fail(String(e)) });
  const inside = w as unknown as { queue: Array<() => void> };
  const steps = Array.from({ length: 3_000 }, (_, k) => () => { ran.push(k); clock += 5; });
  w.add(steps.slice(0, 1_500));
  let sawCut = false;
  // More arrive while it runs: the queue never stands empty, as under a backlog that does not drain.
  w.add(steps.slice(1_500));
  while (w.backlog > 0) {
    const held = new Set(inside.queue);
    for (let k = 0; k < ran.length; k++) assert.ok(!held.has(steps[k]!), `step ${k} ran and is still held`);
    if (inside.queue.length < 3_000) sawCut = true;
    await new Promise((r) => setImmediate(r));
  }
  assert.ok(sawCut, 'the queue was cut down while work still waited');
  assert.deepEqual(ran, Array.from({ length: 3_000 }, (_, i) => i));
});

test('sliced work: a turn is told how long the rest of the thread took since the last one', async () => {
  const gaps: number[] = [];
  let clock = 1_000;
  const w = new SlicedWork({ budgetMs: (_b, gap) => { gaps.push(gap); return 1; }, now: () => clock, onResume: () => { clock += 70; }, onError: (e) => assert.fail(String(e)) });
  w.add([1, 2].map(() => () => { clock += 5; }));
  await until('done', () => w.backlog === 0);
  assert.deepEqual(gaps, [0, 70], 'the first turn has nothing before it');
});

test('a stream row reaching the writer after a REST read answered for its time is not counted beside the REST row', async () => {
  const B = Date.now() - 3_600_000;
  const row = (id: string, t: number, src: 0 | 1): FillRow => ({ venue: 'hyperliquid', address: '0xa', id, t, symbol: 'BTC', side: 1, px: 100, sz: 1, fee: src ? 0.1 : null, closedPnl: src ? 0 : null, oid: src ? 'o' : null, src });
  const s = new IndexStore(':memory:', { aggRefreshMs: 0 });
  try {
    s.putFills([row('s-written', B + 100, 0), row('rest', B + 100, 1)]);
    await s.dropStreamRowsAsync('hyperliquid', '0xa', B, B + 1_000, async () => {});
    s.putFills([row('s-queued', B + 500, 0), row('s-queued2', B + 1_000, 0)]);
    assert.equal(s.streamUnderRest, 2);
    s.putFills([row('s-after', B + 1_001, 0), row('rest-late', B + 600, 1)]);
    const ids = (s.db.prepare("SELECT id FROM fills WHERE venue = 'hyperliquid' ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id);
    assert.deepEqual(ids, ['rest', 'rest-late', 's-after'], 'REST rows and later prints stay; nothing else');
    s.dropStreamRows('hyperliquid', '0xa', B + 2_000, B + 3_000);
    s.putFills([row('s-other', B + 1_500, 0), row('s-under-second', B + 2_500, 0)]);
    assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM fills WHERE id = 's-other'").get() as { n: number }).n, 1, 'between two read ranges: kept');
    assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM fills WHERE id = 's-under-second'").get() as { n: number }).n, 0);
    // The xyz mirror's held range goes with it.
    const xyz = { ...row('x', B + 200, 0), symbol: 'xyz:TSLA' };
    s.putFills([xyz]);
    assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM fills WHERE id = 'x'").get() as { n: number }).n, 0);
  } finally {
    s.close();
  }
});

test('an xyz print of a wallet both venues track reaches putFills once, and is stored once under each', async () => {
  const { Indexer } = await import('../src/indexer/engine.js');
  const s = new IndexStore(':memory:');
  try {
    const now = Date.now();
    const ix = new Indexer(s, () => now) as unknown as {
      trackedHl: Set<string>; trackedExt: Map<string, Set<string>>; pendingFills: FillRow[];
      onPrint(p: unknown): void; flush(): void; stopped: boolean; cohorts: { onPrint(): void };
    };
    ix.cohorts.onPrint = () => {};
    ix.trackedHl = new Set(['0xboth', '0xhlonly']);
    ix.trackedExt.set('tradexyz', new Set(['0xboth', '0xxyzonly']));
    const print = { venue: 'hyperliquid', symbol: 'xyz:TSLA', id: 'p1', t: now - 1_000, px: 100, sz: 1, buyer: '0xboth', seller: '0xhlonly' };
    ix.onPrint(print);
    ix.onPrint({ ...print, id: 'p2', buyer: '0xxyzonly', seller: '0xnobody' });
    assert.deepEqual(ix.pendingFills.map((f) => `${f.venue} ${f.address} ${f.id}`).sort(), [
      'hyperliquid 0xboth p1', 'hyperliquid 0xhlonly p1', 'tradexyz 0xxyzonly p2',
    ]);
    ix.stopped = true;
    ix.flush();
    const rows = (s.db.prepare('SELECT venue, address, id FROM fills ORDER BY venue, address, id').all() as Array<{ venue: string; address: string; id: string }>).map((f) => `${f.venue} ${f.address} ${f.id}`);
    assert.deepEqual(rows, ['hyperliquid 0xboth p1', 'hyperliquid 0xhlonly p1', 'tradexyz 0xboth p1', 'tradexyz 0xhlonly p1', 'tradexyz 0xxyzonly p2']);
  } finally {
    s.close();
  }
});

test('checkpoint thread: under a writer that never pauses the WAL starts over and its file stops growing, and every row reads back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-ckpt-'));
  const path = join(dir, 'i.db');
  const store = new IndexStore(path);
  try {
    store.startCheckpointer({ everyMs: 20, restartFrames: 400, restartGapMs: 50 });
    await until('thread up', () => store.checkpointStatus?.running === true);
    let i = 0;
    const sizes: number[] = [];
    // At least 3 s, then until a full checkpoint has finished (20 s at most): on a loaded CI box 3 s was not always enough
    // for one to find the reader-free moment it needs (2026-11-07).
    const start = Date.now();
    let n = 0;
    while (Date.now() - start < 3_000 || (Date.now() - start < 20_000 && (store.checkpointStatus!.fulls - store.checkpointStatus!.fullsBusy) === 0)) {
      store.putFills(Array.from({ length: 150 }, () => fill(i++)));
      n++;
      if (n % 25 === 0) sizes.push(statSync(`${path}-wal`).size);
      await new Promise((r) => setImmediate(r));
    }
    const st = store.checkpointStatus!;
    assert.ok(st.fulls - st.fullsBusy > 0, `full checkpoints finished: ${JSON.stringify(st)}`);
    assert.equal(st.errors, 0);
    assert.ok(st.log < i, 'the WAL started over: it holds fewer frames than rows written');
    assert.ok(sizes.length > 2, 'wrote long enough to see it');
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM fills').get() as { n: number }).n, i);
    assert.equal((store.db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout, 200_000, 'the writer waits, it never errors, on that lock');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test('checkpoint thread: no full checkpoint while the passive run left more than restartMaxBehind frames (it would hold the write lock while it copies them: 34 s on production 2026-11-09)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-ckpt-'));
  const path = join(dir, 'i.db');
  const store = new IndexStore(path);
  try {
    store.startCheckpointer({ everyMs: 20, restartFrames: 400, restartGapMs: 50, restartMaxBehind: -1 });
    await until('thread up', () => store.checkpointStatus?.running === true);
    let i = 0;
    const start = Date.now();
    // At least 2 s and 6 passive runs (15 s at most): a loaded CI runner managed fewer than 6 in 2 s (v0.2.205 CI).
    while (Date.now() - start < 2_000 || (store.checkpointStatus!.runs <= 5 && Date.now() - start < 15_000)) {
      store.putFills(Array.from({ length: 150 }, () => fill(i++)));
      await new Promise((r) => setImmediate(r));
    }
    const st = store.checkpointStatus!;
    assert.ok(st.runs > 5, 'the passive runs went on');
    assert.equal(st.fulls, 0, `no full run: ${JSON.stringify(st)}`);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM fills').get() as { n: number }).n, i);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test('Lighter at the start: a wallet with tens of thousands of sub-accounts takes no time, and every index is found', async () => {
  const { LighterVenue } = await import('../src/indexer/ext/lighter.js');
  const was = process.env.VALUESCAN_INDEX_STREAMS;
  process.env.VALUESCAN_INDEX_STREAMS = '0';
  const rows = new Map<string, string>();
  for (let i = 0; i < 60_000; i++) rows.set(String(i), i < 50_000 ? '0xbig' : `0x${i % 7}`);
  const v = new LighterVenue();
  const ctx = { store: { extIndex: () => rows, getMeta: () => null }, now: Date.now, streamSince: () => null, onPrint: () => {} } as never;
  try {
    const t0 = Date.now();
    v.start(ctx);
    assert.ok(Date.now() - t0 < 2_000, `${Date.now() - t0} ms`);
    assert.equal(v.accountsOf('0xbig')!.length, 50_000);
    assert.equal(v.addressOf('49999'), '0xbig');
    assert.equal(v.addressOf('59999'), `0x${59999 % 7}`);
    assert.equal(v.accountsOf('0xnobody'), null);
  } finally {
    v.stop();
    if (was === undefined) delete process.env.VALUESCAN_INDEX_STREAMS;
    else process.env.VALUESCAN_INDEX_STREAMS = was;
  }
});

test('fills written in key order hold the same rows, and copies of one id keep their order', () => {
  const row = (address: string, id: string, src: number) => ({ venue: 'hyperliquid', address, id, src });
  const sorted = inKeyOrder([row('0xb', '2', 0), row('0xa', '9', 0), row('0xb', '1', 1), row('0xb', '2', 1)]);
  assert.deepEqual(sorted.map((r) => `${r.address}|${r.id}|${r.src}`), ['0xa|9|0', '0xb|1|1', '0xb|2|0', '0xb|2|1']);
});

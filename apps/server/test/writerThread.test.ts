/**
 * The bulk writes on their own thread (writerThread.ts, 2026-11-09): the same rows and marks as putFills on the indexer's
 * thread, a day's `fill_dirty` row in the fill's own transaction (any snapshot of the file is a crash point), the store
 * writing for itself when the thread dies, a stop that spills exactly what the thread did not write, the change log's ids,
 * a flush whose coverage moves only after its rows are in the file, and the indexer's own writes not held behind it.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { IndexStore, type FillRow } from '../src/indexer/store.js';
import type { Venue } from '../src/valuedesk/types.js';
import { Indexer } from '../src/indexer/engine.js';

const DAY = 86_400_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (what: string, ok: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`timed out: ${what}`);
    await sleep(5);
  }
};
const today = Math.floor(Date.now() / DAY) * DAY;

/** `n` fills over `wallets` wallets and the last `days` days; `tag` makes the ids. Some are xyz (filed under trade.xyz too). */
function fills(n: number, o: { tag: string; wallets?: number; days?: number; src?: 0 | 1; px?: number }): FillRow[] {
  const wallets = o.wallets ?? 50;
  const days = o.days ?? 3;
  return Array.from({ length: n }, (_, i) => ({
    venue: 'hyperliquid' as const,
    address: `0x${(i % wallets).toString(16).padStart(40, '0')}`,
    id: `${o.tag}${i}`,
    t: today - (i % days) * DAY + 1_000 + i,
    symbol: i % 9 === 0 ? 'xyz:TSLA' : 'BTC',
    side: i % 2 ? 1 : -1,
    px: (o.px ?? 100) + (i % 7),
    sz: 1 + (i % 3),
    fee: o.src === 0 ? null : 0.01,
    closedPnl: null,
    oid: o.src === 0 ? null : `o${i}`,
    src: o.src ?? 1,
  }));
}

const dir = () => mkdtempSync(join(tmpdir(), 'vs-writer-'));
/** The change log's tables are in their own file (store.ts liqDbPath). */
const conn = (s: IndexStore, sql: string) => (/\bliq_(log|cur|addr)\b/.test(sql) ? s.liqDb! : s.db);
const count = (s: IndexStore, sql: string, ...p: Array<string | number>) => Number((conn(s, sql).prepare(sql).get(...p) as { n: number }).n);
const table = (s: IndexStore, sql: string) => conn(s, sql).prepare(sql).all().map((r) => JSON.stringify(r));

interface Priv { dirtyDays: Set<string>; versions: Map<string, number> }
const priv = (s: IndexStore) => s as unknown as Priv;

/** Every wallet's day rows built, so changed fills take `fill_dirty` marks; then the marks cleaned. */
function ready(s: IndexStore, rows: FillRow[]): void {
  s.putFills(rows);
  for (const a of new Set(rows.map((r) => r.address))) s.windowStats('hyperliquid', a, 0);
  while (s.buildAggregates(1_000) > 0) { /* build */ }
  while (s.flushAggregates(1_000) > 0) { /* sum */ }
}

test('writer thread: the rows, the dirty days and the versions are those putFills leaves', async () => {
  const d = dir();
  const a = new IndexStore(join(d, 'a.db'), { aggRefreshMs: 0 });
  const b = new IndexStore(join(d, 'b.db'), { aggRefreshMs: 0 });
  try {
    const seed = fills(400, { tag: 's' });
    ready(a, seed);
    ready(b, seed);
    assert.ok(b.startWriter({ force: true, targetMs: 5, maxRows: 300 }));
    // New rows, rows already held (no change), stream copies of REST rows (no downgrade), REST rows replacing stream rows,
    // and changed figures: every kind putFills tells apart.
    const batches = [
      fills(3_000, { tag: 'n' }),
      fills(400, { tag: 's' }),
      fills(200, { tag: 'n', src: 0 }),
      fills(500, { tag: 'm', src: 0 }),
      fills(500, { tag: 'm', src: 1 }),
      fills(300, { tag: 'n', px: 200 }),
    ];
    for (const rows of batches) {
      a.putFills(rows);
      await b.putFillsAsync(rows);
    }
    assert.equal(b.writerStatus!.running, true);
    assert.ok(b.writerStatus!.txs > 5, `cut into transactions by time and rows (${b.writerStatus!.txs})`);
    for (const sql of ['SELECT * FROM fills ORDER BY venue, address, id', 'SELECT * FROM fill_dirty ORDER BY venue, address, day']) {
      assert.deepEqual(table(b, sql), table(a, sql), sql);
    }
    assert.ok(count(b, 'SELECT COUNT(*) AS n FROM fill_dirty') > 0, 'marks were due');
    assert.deepEqual([...priv(b).dirtyDays].sort(), [...priv(a).dirtyDays].sort(), 'the same days behind their fills');
    // A version is a cache key: bumped once per answered part instead of once per call, but for the same traders.
    assert.deepEqual([...priv(b).versions.keys()].sort(), [...priv(a).versions.keys()].sort(), 'the same traders bumped');
    // Read on this thread after the answer: the rows are there.
    assert.equal(b.windowStats('hyperliquid', seed[0]!.address, 0).trades, a.windowStats('hyperliquid', seed[0]!.address, 0).trades);
  } finally {
    a.close();
    b.close();
    rmSync(d, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 });
  }
});

test('writer thread: a fill and its day mark are in one transaction, in every snapshot, and a death mid-way loses nothing', async () => {
  const d = dir();
  const path = join(d, 'x.db');
  const s = new IndexStore(path, { aggRefreshMs: 0 });
  const seed = fills(500, { tag: 's', wallets: 200, days: 5 });
  ready(s, seed);
  assert.equal(count(s, 'SELECT COUNT(*) AS n FROM fill_dirty'), 0);
  s.startWriter({ force: true, targetMs: 2, maxRows: 200, restartAfterMs: 60_000 });
  const look = new DatabaseSync(path, { readOnly: true });
  // A new fill whose day has no mark: what a crash at this moment would leave.
  const orphans = look.prepare(`SELECT COUNT(*) AS n FROM fills f WHERE f.venue = 'hyperliquid' AND f.id LIKE 'n%' AND NOT EXISTS
    (SELECT 1 FROM fill_dirty d WHERE d.venue = f.venue AND d.address = f.address AND d.day = CAST(f.t / ${DAY} AS INTEGER))`);
  const written = look.prepare("SELECT COUNT(*) AS n FROM fills WHERE id LIKE 'n%'");
  try {
    const rows = fills(40_000, { tag: 'n', wallets: 200, days: 5 });
    const want = rows.length + rows.filter((r) => r.symbol.startsWith('xyz:')).length;
    const done = s.putFillsAsync(rows);
    let looks = 0;
    let killedAt = -1;
    while (Number((written.get() as { n: number }).n) < want) {
      assert.equal(Number((orphans.get() as { n: number }).n), 0, 'every fill written has its day marked in the same snapshot');
      looks++;
      const n = Number((written.get() as { n: number }).n);
      if (killedAt < 0 && n > want / 4) {
        killedAt = n;
        await s.killWriter();
      }
      await sleep(1);
    }
    await done;
    assert.ok(looks > 3 && killedAt > 0 && killedAt < want, `looked ${looks} times, killed at ${killedAt}/${want}`);
    // 40k rows behind: past INLINE_MAX_ROWS a new thread takes them on at once (2.36M rows on the indexer's thread held it
    // 40 min on 2026-11-09); the small-backlog case (written here) is the next test.
    assert.equal(s.writerOn, true, 'a new thread took the backlog');
    assert.equal(s.writerStatus!.inlineOps, 0);
    assert.equal(s.writerStatus!.restarts, 1);
    assert.equal(Number((written.get() as { n: number }).n), want, 'every row once');
    assert.equal(Number((orphans.get() as { n: number }).n), 0);
    // After a death every row the thread wrote without an answer counts as changed: its day is behind (memory and file).
    const days = new Set(rows.map((r) => `hyperliquid|${r.address}|${Math.floor(r.t / DAY)}`));
    for (const k of days) assert.ok(priv(s).dirtyDays.has(k), k);
    s.close();
    // Reopened: the marks are on disk.
    const r = new IndexStore(path, { aggRefreshMs: 0 });
    for (const k of days) assert.ok(priv(r).dirtyDays.has(k), `reopened ${k}`);
    r.close();
  } finally {
    look.close();
    rmSync(d, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 });
  }
});

test('writer thread: dead, its ops are written here; a minute later (here: 150 ms) it is back', async () => {
  const d = dir();
  const s = new IndexStore(join(d, 'x.db'), { aggRefreshMs: 0 });
  try {
    s.startWriter({ force: true, restartAfterMs: 150 });
    await s.putFillsAsync(fills(100, { tag: 'a' }));
    await s.killWriter();
    await until('the death noticed', () => !s.writerOn);
    // Down: written inline, within the call.
    const p = s.putFillsAsync(fills(100, { tag: 'b' }));
    assert.equal(count(s, "SELECT COUNT(*) AS n FROM fills WHERE id LIKE 'b%'"), 112);
    await p;
    await until('back up', () => s.writerOn && s.writerStatus!.running);
    await s.putFillsAsync(fills(100, { tag: 'c' }));
    await s.addActivityAsync([{ venue: 'sodex', acct: '7', hour: 1000, trades: 2, volume: 5 }]);
    assert.equal(count(s, 'SELECT COUNT(*) AS n FROM fills'), 336);
    assert.equal(count(s, 'SELECT SUM(trades) AS n FROM activity_hour'), 2);
  } finally {
    s.close();
    rmSync(d, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 });
  }
});

test('writer thread: a stop spills exactly the rows it did not write, and the next start writes them once', async () => {
  const d = dir();
  const path = join(d, 'x.db');
  const s = new IndexStore(path, { aggRefreshMs: 0 });
  s.startWriter({ force: true, targetMs: 1, maxRows: 100 });
  const rows = fills(30_000, { tag: 'n', wallets: 300 });
  const want = new Set(rows.flatMap((r) => [`hyperliquid|${r.id}`, ...(r.symbol.startsWith('xyz:') ? [`tradexyz|${r.id}`] : [])]));
  const act = Array.from({ length: 2_000 }, (_, i) => ({ venue: 'sodex' as Venue, acct: String(i), hour: 400_000 + (i % 5), trades: 1, volume: 2 }));
  const p1 = s.putFillsAsync(rows);
  const p2 = s.addActivityAsync(act);
  p1.catch(() => {});
  p2.catch(() => {});
  await until('some written', () => count(s, 'SELECT COUNT(*) AS n FROM fills') > 2_000);
  let spilled: { fills: FillRow[]; activity: typeof act } | null = null;
  s.stopWriter((x) => {
    spilled = x;
    s.spillWrites([{ kind: 'fills', rows: x.fills }, { kind: 'activity', rows: x.activity }]);
  });
  await assert.rejects(p1, /stopped/);
  const got = spilled as unknown as { fills: FillRow[]; activity: typeof act };
  const inFile = new Set((s.db.prepare('SELECT venue, id FROM fills').all() as Array<{ venue: string; id: string }>).map((r) => `${r.venue}|${r.id}`));
  assert.ok(inFile.size > 0 && got.fills.length > 0, `${inFile.size} written, ${got.fills.length} spilled`);
  // The spill holds originals; a copy only where its original was written. Replayed, the copies come back.
  for (const f of got.fills) {
    assert.ok(!inFile.has(`${f.venue}|${f.id}`), `spilled and written: ${f.venue} ${f.id}`);
    if (f.venue === 'tradexyz') assert.ok(inFile.has(`hyperliquid|${f.id}`), 'a copy spilled alone has its original written');
  }
  const actWritten = count(s, 'SELECT COALESCE(SUM(trades), 0) AS n FROM activity_hour');
  assert.equal(actWritten + got.activity.length, act.length, 'activity: written + spilled = sent');
  s.close();
  // The next start, through the thread again: every row once.
  const s2 = new IndexStore(path, { aggRefreshMs: 0 });
  s2.startWriter({ force: true });
  try {
    for (const part of s2.spilledWrites()) await s2.replaySpillAsync(part.id);
    const after = (s2.db.prepare('SELECT venue, id FROM fills').all() as Array<{ venue: string; id: string }>).map((r) => `${r.venue}|${r.id}`);
    assert.equal(after.length, want.size);
    assert.deepEqual(new Set(after), want);
    assert.equal(count(s2, 'SELECT COALESCE(SUM(trades), 0) AS n FROM activity_hour'), act.length, 'each activity row once');
    assert.equal(s2.spilledWrites().length, 0);
  } finally {
    s2.close();
    rmSync(d, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 });
  }
});

test('writer thread: the indexer stop spills the flush the thread was writing; coverage moves only after the rows are in', async () => {
  const d = dir();
  const path = join(d, 'x.db');
  const now = Date.now();
  const s = new IndexStore(path, { aggRefreshMs: 0 });
  s.startWriter({ force: true, targetMs: 1, maxRows: 50 });
  const ix = new Indexer(s, () => now) as unknown as {
    pendingFills: FillRow[]; act: Map<string, { trades: number; volume: number }>;
    flush(): void; stop(lap?: (s: string) => void): void; replaySpill(): number;
    trackStreams(at: number): void; advanceCoverage(at: number): void;
  };
  const look = new DatabaseSync(path, { readOnly: true });
  const seen: number[] = [];
  ix.advanceCoverage = () => { seen.push(Number((look.prepare("SELECT COUNT(*) AS n FROM fills WHERE id LIKE 'f%'").get() as { n: number }).n)); };
  ix.trackStreams = () => {};
  try {
    const first = fills(3_000, { tag: 'f', src: 0 });
    const firstWant = first.length + first.filter((r) => r.symbol.startsWith('xyz:')).length;
    ix.pendingFills = [...first];
    ix.flush();
    assert.equal(seen.length, 0, 'not before the rows are written');
    await until('the flush done', () => seen.length > 0);
    assert.equal(seen[0], firstWant, 'when coverage moved, every row of its flush was in the file');
    // A second flush, stopped while the thread writes it.
    ix.pendingFills = fills(20_000, { tag: 'g', src: 0, wallets: 400 });
    ix.act.set(`sodex|7|${Math.floor(now / 3_600_000)}`, { trades: 3, volume: 30 });
    ix.flush();
    await until('partly written', () => count(s, "SELECT COUNT(*) AS n FROM fills WHERE id LIKE 'g%'") > 500);
    const steps: string[] = [];
    ix.stop((x) => steps.push(x));
    const written = count(s, "SELECT COUNT(*) AS n FROM fills WHERE id LIKE 'g%'");
    const spillRows = count(s, 'SELECT COALESCE(SUM(json_array_length(rows)), 0) AS n FROM write_spill');
    assert.ok(spillRows > 0 && written > 0, `${written} written, ${spillRows} spilled`);
    assert.ok(steps.some((x) => /^write backlog \(\d+ steps; spilled \d+ rows\)$/.test(x)), steps.join(' | '));
    s.close();
    const s2 = new IndexStore(path, { aggRefreshMs: 0 });
    s2.startWriter({ force: true });
    const ix2 = new Indexer(s2, () => now) as unknown as { replaySpill(): number; stop(): void };
    ix2.replaySpill();
    const gWant = 20_000 + Math.ceil(20_000 / 9);
    await until('the spill written', () => count(s2, "SELECT COUNT(*) AS n FROM fills WHERE id LIKE 'g%'") === gWant && s2.spilledWrites().length === 0);
    assert.equal(count(s2, "SELECT COUNT(*) AS n FROM fills WHERE id LIKE 'g%'"), gWant, 'every row once');
    assert.equal(count(s2, 'SELECT COALESCE(SUM(trades), 0) AS n FROM activity_hour'), 3);
    ix2.stop();
    s2.close();
  } finally {
    look.close();
    rmSync(d, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 });
  }
});

test('writer thread: the change log step gives the same rows and ids as on this thread', async () => {
  const d = dir();
  const a = new IndexStore(join(d, 'a.db'));
  const b = new IndexStore(join(d, 'b.db'));
  try {
    b.startWriter({ force: true, targetMs: 1, maxRows: 100 });
    const t = Date.now();
    const step = (k: number) => {
      const changed = Array.from({ length: 3_000 }, (_, i) => ({
        aid: i % 3 === 0 ? `0xnew${k}-${i}` : i + 1, coin: i % 2 ? 'BTC' : 'ETH', venue: i % 4, side: i % 2 ? 1 : -1, liq: 100 + i, usd: 1_000 + i,
        sym: 'BTC', sz: i % 5 ? 0.5 : Number.NaN, entry: 99, mark: 101, iso: i % 2 === 0, lev: 10, eq: 5_000, cash: null, readAt: t,
      }));
      const closed = Array.from({ length: 500 }, (_, i) => ({ aid: 5_000 + i, coin: 'SOL', venue: 1, mark: 20 }));
      const fresh = [...new Set(changed.flatMap((c) => (typeof c.aid === 'string' ? [c.aid] : [])))];
      return { changed, closed, fresh };
    };
    for (const k of [1, 2]) {
      const x = step(k);
      const ia = await a.putLiqLogSliced(t + k, x.fresh, x.changed, x.closed, async () => {});
      const ib = await b.putLiqLogSliced(t + k, x.fresh, x.changed, x.closed, async () => {});
      assert.deepEqual([...ib].sort(), [...ia].sort(), 'the same ids');
      assert.equal(ib.size, x.fresh.length);
    }
    for (const sql of ['SELECT * FROM liq_log ORDER BY aid, coin, venue, t', 'SELECT * FROM liq_cur ORDER BY aid, coin, venue', 'SELECT * FROM liq_addr ORDER BY id']) {
      assert.deepEqual(table(b, sql), table(a, sql), sql);
    }
  } finally {
    a.close();
    b.close();
    rmSync(d, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 });
  }
});

test('writer thread: a liq step goes ahead of a stream backlog, and every stream row still lands once, in order, across a death', async () => {
  const d = dir();
  const path = join(d, 'x.db');
  const ref = new IndexStore(join(d, 'ref.db'), { aggRefreshMs: 0 });
  const s = new IndexStore(path, { aggRefreshMs: 0 });
  try {
    s.startWriter({ force: true, targetMs: 2, maxRows: 100, restartAfterMs: 60_000 });
    const backlog = [fills(20_000, { tag: 'a', wallets: 100 }), fills(20_000, { tag: 'b', wallets: 100 }), fills(20_000, { tag: 'c', wallets: 100, px: 300 })];
    const t = Date.now();
    const changed = Array.from({ length: 2_000 }, (_, i) => ({ aid: i % 4 === 0 ? `0xq${i}` : 100_000 + i, coin: 'BTC', venue: 0, side: 1, liq: 50 + i, usd: 500 + i }));
    const fresh = [...new Set(changed.flatMap((c) => (typeof c.aid === 'string' ? [c.aid] : [])))];
    let filled = 0;
    const streams = backlog.map((rows) => s.putFillsAsync(rows, { stream: true }).then(() => { filled++; }));
    // Sent after 60k stream rows: answered while they are still being written (2026-11-09: the step waited 4.7 h).
    const ids = await s.putLiqLogSliced(t, fresh, changed, [], async () => {});
    assert.equal(filled, 0, 'the step was written before the stream backlog');
    assert.equal(ids.size, fresh.length);
    assert.equal(count(s, 'SELECT COUNT(*) AS n FROM liq_log WHERE t = ?', t), changed.length);
    // A death mid-backlog: meta.writer_done names stream ops only, so the store settles exactly what is in the file.
    await s.killWriter();
    await Promise.all(streams);
    for (const rows of backlog) ref.putFills(rows);
    assert.deepEqual(table(s, 'SELECT * FROM fills ORDER BY venue, address, id'), table(ref, 'SELECT * FROM fills ORDER BY venue, address, id'), 'every stream row once');
    // Another step after the death: still ids and rows.
    const again = await s.putLiqLogSliced(t + 1, ['0xlate'], [{ aid: '0xlate', coin: 'ETH', venue: 0, side: -1, liq: 9, usd: 90 }], [], async () => {});
    assert.equal(again.size, 1);
  } finally {
    ref.close();
    s.close();
    rmSync(d, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 });
  }
});

test('writer thread: a stall of this thread longer than the hang limit does not end a writer that answered meanwhile', async () => {
  const d = dir();
  const s = new IndexStore(join(d, 'x.db'), { aggRefreshMs: 0 });
  try {
    s.startWriter({ force: true, targetMs: 2, maxRows: 100, hungMs: 1_500 });
    await until('thread up', () => s.writerStatus!.running);
    const done = s.putFillsAsync(fills(30_000, { tag: 'w', wallets: 100 }));
    // This thread blocked well past hungMs while the writer works and posts answers (2026-11-09: an 81 s stall here).
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4_000);
    await done;
    assert.equal(s.writerStatus!.restarts, 0, 'not ended as hung');
    assert.equal(s.writerStatus!.inlineOps, 0, 'nothing written on this thread');
  } finally {
    s.close();
    rmSync(d, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 });
  }
});

test('writer thread: a death with a big backlog hands it to a new thread at once, not to this one', async () => {
  const d = dir();
  const ref = new IndexStore(join(d, 'ref.db'), { aggRefreshMs: 0 });
  const s = new IndexStore(join(d, 'x.db'), { aggRefreshMs: 0 });
  try {
    s.startWriter({ force: true, targetMs: 2, maxRows: 100, restartAfterMs: 60_000 });
    const rows = fills(50_000, { tag: 'h', wallets: 100 });
    const done = s.putFillsAsync(rows);
    await until('some written', () => s.writerStatus!.rows > 2_000);
    await s.killWriter();
    await done;
    assert.equal(s.writerStatus!.inlineOps, 0, 'the backlog went to the new thread');
    assert.equal(s.writerStatus!.running, true);
    ref.putFills(rows);
    assert.deepEqual(table(s, 'SELECT * FROM fills ORDER BY venue, address, id'), table(ref, 'SELECT * FROM fills ORDER BY venue, address, id'), 'every row once');
  } finally {
    ref.close();
    s.close();
    rmSync(d, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 });
  }
});

test("writer thread: this thread's writes wait for a row and a commit, not a transaction", async () => {
  const d = dir();
  const s = new IndexStore(join(d, 'x.db'), { aggRefreshMs: 0 });
  try {
    // Long transactions on purpose: without the count each of this thread's writes could wait up to 400 ms.
    s.startWriter({ force: true, targetMs: 400, maxRows: 5_000 });
    const big = s.putFillsAsync(fills(150_000, { tag: 'n', wallets: 2_000, days: 2 }));
    await until('the thread writing', () => (s.writerStatus?.txs ?? 0) > 0);
    s.lockWaits.samples = [];
    const end = Date.now() + 2_000;
    let i = 0;
    while (Date.now() < end && s.writerStatus!.pendingOps > 0) {
      s.tx(() => s.setMeta('probe', String(i++)));
      s.setMeta('probe2', String(i));
      await sleep(5);
    }
    const w = s.lockWaits.samples.sort((x, y) => x - y);
    s.lockWaits.samples = null;
    const p99 = w[Math.floor(w.length * 0.99)] ?? 0;
    console.log(`lock wait: ${w.length} writes, p50 ${(w[Math.floor(w.length / 2)] ?? 0).toFixed(1)} ms, p99 ${p99.toFixed(1)} ms, max ${(w[w.length - 1] ?? 0).toFixed(1)} ms`);
    assert.ok(w.length > 50, `${w.length} writes measured`);
    assert.ok(p99 < 300, `p99 lock wait ${p99.toFixed(1)} ms (max ${w[w.length - 1]!.toFixed(1)} ms)`);
    await big;
  } finally {
    s.close();
    rmSync(d, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 });
  }
});

test('writer thread: a stop that finds it hung ends it, takes the lock, and spills exactly what it did not write', async () => {
  const d = dir();
  const path = join(d, 'x.db');
  const s = new IndexStore(path, { aggRefreshMs: 0 });
  s.startWriter({ force: true, stopWaitMs: 300 });
  const w = (s as unknown as { writer: { hangForTest(ms: number): void } }).writer;
  try {
    const first = fills(2_000, { tag: 'a' });
    await s.putFillsAsync(first);
    // Hung for a minute in a transaction holding the lock and a row of its own; an op queued behind it.
    w.hangForTest(60_000);
    const later = fills(3_000, { tag: 'b' });
    const p = s.putFillsAsync(later);
    p.catch(() => {});
    await sleep(100);
    let spilled: FillRow[] = [];
    const t0 = Date.now();
    s.stopWriter((x) => {
      spilled = x.fills;
      s.spillWrites([{ kind: 'fills', rows: x.fills }]);
    });
    const ms = Date.now() - t0;
    assert.ok(ms < 10_000, `the stop took ${ms} ms, not the minute of the hang`);
    await assert.rejects(p, /stopped/);
    assert.equal(count(s, "SELECT COUNT(*) AS n FROM fills WHERE id = 'hang'"), 0, 'its open transaction rolled back');
    assert.equal(count(s, "SELECT COUNT(*) AS n FROM fills WHERE id LIKE 'a%'"), 2_000 + Math.ceil(2_000 / 9), 'what it wrote stays');
    assert.equal(count(s, "SELECT COUNT(*) AS n FROM fills WHERE id LIKE 'b%'"), 0);
    assert.equal(spilled.length, later.length, 'every row it did not write, once (originals: the replay copies the xyz rows again)');
    s.close();
    const s2 = new IndexStore(path, { aggRefreshMs: 0 });
    for (const part of s2.spilledWrites()) s2.replaySpill(part.id);
    assert.equal(count(s2, "SELECT COUNT(*) AS n FROM fills WHERE id LIKE 'b%'"), 3_000 + Math.ceil(3_000 / 9));
    s2.close();
  } finally {
    rmSync(d, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 });
  }
});

test('writer thread: a wallet read goes ahead of the stream backlog and lands with it once, across a death', async () => {
  const d = dir();
  const ref = new IndexStore(join(d, 'ref.db'), { aggRefreshMs: 0 });
  const s = new IndexStore(join(d, 'x.db'), { aggRefreshMs: 0 });
  try {
    s.startWriter({ force: true, targetMs: 2, maxRows: 100, restartAfterMs: 60_000 });
    const stream = [fills(25_000, { tag: 'a', wallets: 100 }), fills(25_000, { tag: 'b', wallets: 100 })];
    const read = fills(2_000, { tag: 'r', wallets: 3, src: 1 });
    let streamed = 0;
    const flushes = stream.map((rows) => s.putFillsAsync(rows, { stream: true }).then(() => { streamed++; }));
    // A lane's read sent after 50k stream rows (2026-11-09: the HL lane waited 110 min behind them).
    await s.putFillsAsync(read);
    assert.equal(streamed, 0, 'the read was answered before the stream backlog');
    await s.killWriter();
    await Promise.all(flushes);
    for (const rows of [...stream, read]) ref.putFills(rows);
    assert.deepEqual(table(s, 'SELECT * FROM fills ORDER BY venue, address, id'), table(ref, 'SELECT * FROM fills ORDER BY venue, address, id'), 'every row once');
  } finally {
    ref.close();
    s.close();
    rmSync(d, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 });
  }
});

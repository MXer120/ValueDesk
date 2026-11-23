import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IndexStore, type FillRow } from '../src/indexer/store.js';
import { FILLS_HELD_MAX, Indexer, WRITER_HOLD_ROWS } from '../src/indexer/engine.js';

/** 2026-11-23: the writer thread's queue grew without a bound (14.5M rows) and the status said 0. */

interface Priv {
  pendingFills: FillRow[];
  act: Map<string, { trades: number; volume: number }>;
  handing: boolean;
  replaying: number;
  overflowed: number;
  unsentFills: FillRow[];
  flushTick(): void;
  replaySpill(): number;
  oldestUnwrittenMs(): number;
  stop(lap?: (s: string) => void): void;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (what: string, ok: () => boolean, ms = 60_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`timed out: ${what}`);
    await sleep(5);
  }
};
const row = (i: number, t: number): FillRow => ({
  venue: 'hyperliquid', address: `0x${(i % 97).toString(16).padStart(40, '0')}`, id: `b${i}`, t, symbol: 'BTC', side: i % 2 ? 1 : -1,
  px: 100 + (i % 9), sz: 1, fee: null, closedPnl: null, oid: null, src: 0,
});
const rows = (from: number, n: number, t: number) => Array.from({ length: n }, (_, i) => row(from + i, t));
const fillCount = (s: IndexStore) => Number((s.db.prepare('SELECT COUNT(*) AS n FROM fills').get() as { n: number }).n);
const trades = (s: IndexStore) => Number((s.db.prepare('SELECT COALESCE(SUM(trades), 0) AS n FROM activity_hour').get() as { n: number }).n);
const spill = (s: IndexStore) => Number((s.db.prepare('SELECT COUNT(*) AS n FROM write_spill').get() as { n: number }).n);
const clean = (d: string) => rmSync(d, { recursive: true, force: true, maxRetries: 60, retryDelay: 50 });

test('backlog: the thread holds a bounded queue, the rest waits and is written once; the age is reported', async () => {
  const d = mkdtempSync(join(tmpdir(), 'vs-back-'));
  const s = new IndexStore(join(d, 'x.db'), { aggRefreshMs: 0 });
  try {
    s.startWriter({ force: true, targetMs: 2, maxRows: 200 });
    await until('thread up', () => s.writerStatus!.running);
    const ix = new Indexer(s) as unknown as Priv;
    const now = Date.now() - 60_000;
    const hour = Math.floor(now / 3_600_000);
    let max = 0;
    for (let k = 0; k < 10; k++) {
      ix.pendingFills.push(...rows(k * 12_000, 12_000, now));
      const key = `sodex|7|${hour}`;
      const a = ix.act.get(key) ?? { trades: 0, volume: 0 };
      ix.act.set(key, { trades: a.trades + 3, volume: a.volume + 30 });
      ix.flushTick();
      await sleep(10);
      max = Math.max(max, s.writerPendingRows);
    }
    assert.ok(ix.oldestUnwrittenMs() > 0, 'rows wait: the status says how long');
    while (ix.pendingFills.length || ix.act.size || ix.handing || s.writerPendingRows) {
      ix.flushTick();
      await sleep(5);
      max = Math.max(max, s.writerPendingRows);
    }
    assert.ok(max <= WRITER_HOLD_ROWS + 5_000 + 1, `the queue is bounded (${max})`);
    assert.equal(fillCount(s), 120_000);
    assert.equal(trades(s), 30, 'activity once, however it was added up');
    await until('nothing waits', () => ix.oldestUnwrittenMs() === 0);
  } finally {
    s.close();
    clean(d);
  }
});

test('backlog: a stop in the middle of handing rows over loses none and writes none twice', async () => {
  const d = mkdtempSync(join(tmpdir(), 'vs-back-'));
  const path = join(d, 'x.db');
  let s = new IndexStore(path, { aggRefreshMs: 0 });
  try {
    s.startWriter({ force: true, targetMs: 2, maxRows: 100 });
    await until('thread up', () => s.writerStatus!.running);
    let ix = new Indexer(s) as unknown as Priv;
    const now = Date.now() - 60_000;
    ix.pendingFills = rows(0, 60_000, now);
    for (let i = 0; i < 12_000; i++) ix.act.set(`hyperliquid|w${i}|${Math.floor(now / 3_600_000)}`, { trades: 2, volume: 5 });
    ix.flushTick();
    await sleep(30);
    assert.ok(ix.unsentFills.length > 0, 'still being handed over');
    ix.pendingFills.push(...rows(60_000, 500, now));
    ix.stop();
    assert.ok(spill(s) > 0);
    s.close();
    s = new IndexStore(path, { aggRefreshMs: 0 });
    s.startWriter({ force: true });
    await until('thread up again', () => s.writerStatus!.running);
    ix = new Indexer(s) as unknown as Priv;
    ix.replaySpill();
    assert.equal(ix.replaying, 1, 'the coverage waits for the spill');
    await until('the spill written', () => spill(s) === 0 && ix.replaying === 0);
    assert.equal(fillCount(s), 60_500);
    assert.equal(trades(s), 24_000);
  } finally {
    s.close();
    clean(d);
  }
});

test('backlog: past the memory limit the fills go to disk and come back', async () => {
  const d = mkdtempSync(join(tmpdir(), 'vs-back-'));
  const s = new IndexStore(join(d, 'x.db'), { aggRefreshMs: 0 });
  try {
    s.startWriter({ force: true });
    await until('thread up', () => s.writerStatus!.running);
    const ix = new Indexer(s) as unknown as Priv;
    const now = Date.now() - 60_000;
    ix.handing = true; // the thread is busy with an earlier flush
    ix.pendingFills = rows(0, FILLS_HELD_MAX + 1, now);
    ix.flushTick();
    await until('moved to the spill', () => ix.overflowed === FILLS_HELD_MAX + 1);
    assert.equal(ix.pendingFills.length, 0, 'out of memory');
    ix.handing = false;
    await until('all back', () => ix.replaying === 0 && spill(s) === 0, 170_000);
    assert.equal(fillCount(s), FILLS_HELD_MAX + 1);
  } finally {
    s.close();
    clean(d);
  }
});

test('backlog: a liquidation step and the stream rows are written by different threads', async () => {
  const d = mkdtempSync(join(tmpdir(), 'vs-back-'));
  const s = new IndexStore(join(d, 'x.db'), { aggRefreshMs: 0 });
  try {
    s.startWriter({ force: true, targetMs: 5, maxRows: 200 });
    await until('thread up', () => s.writerStatus!.running);
    const t = Date.now();
    const changed = Array.from({ length: 60_000 }, (_, i) => ({ aid: 1_000 + i, coin: `C${i % 50}`, venue: 0, side: 1, liq: 50 + i, usd: 500 }));
    let step = false;
    const liq = s.putLiqLogSliced(t, [], changed, [], async () => {}).then(() => { step = true; });
    await s.putFillsAsync(rows(0, 2_000, t - 60_000), { stream: true });
    assert.equal(step, false, 'the rows did not wait for the step');
    await liq;
    assert.equal(s.writerStatus!.liqRows, changed.length);
    assert.equal(s.writerStatus!.liqPendingRows, 0);
  } finally {
    s.close();
    clean(d);
  }
});

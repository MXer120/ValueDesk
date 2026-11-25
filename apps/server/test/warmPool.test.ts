/** The warm-up pool (indexer/warmPool.ts): its lookups are valid against the real schema, and rows land the same with it on. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IndexStore, type FillRow } from '../src/indexer/store.js';

test('warm-up: no bad lookup, every row written, the spill written back through it', async () => {
  process.env.VALUESCAN_WARM_THREADS = '3';
  const path = join(mkdtempSync(join(tmpdir(), 'warm-')), 'i.db');
  const s = new IndexStore(path);
  try {
    assert.ok(s.startWriter({ force: true }));
    const now = Date.now();
    const rows: FillRow[] = Array.from({ length: 900 }, (_, i) => ({
      venue: 'hyperliquid', address: `0x${(i % 37).toString(16).padStart(40, '0')}`, id: `id${i}`, t: now - i * 1000, symbol: i % 5 ? 'BTC' : 'xyz:TSLA',
      side: 1, px: 1, sz: 1, fee: 0, closedPnl: null, oid: null, src: 1,
    }) as unknown as FillRow);
    await s.putFillsAsync(rows);
    const hour = Math.floor(now / 3_600_000);
    const act = Array.from({ length: 200 }, (_, i) => ({ venue: 'lighter' as const, acct: `a${i}`, hour, trades: 1, volume: 2 }));
    await s.warmActivity(act);
    await s.addActivityAsync(act);
    const changed = Array.from({ length: 300 }, (_, i) => ({ aid: `0x${i.toString(16).padStart(40, '0')}`, coin: 'BTC', venue: 1, side: 1, liq: 100 + i, usd: 5 }));
    const ids = await s.putLiqLogSliced(now - 900_000, changed.map((c) => c.aid), changed, [], async () => {});
    assert.equal(ids.size, 300);
    await s.putLiqLogSliced(now, [], changed.map((c) => ({ ...c, aid: ids.get(c.aid)! })), [], async () => {});
    s.spillWrites([{ kind: 'fills', rows: rows.map((r) => ({ ...r, id: `x${r.id}` })) }, { kind: 'activity', rows: act }]);
    const parts = s.spillBatch(0, 10);
    assert.equal(parts.length, 2);
    await s.replayBatch(parts);
    assert.equal(s.spillBatch(0, 10).length, 0);
    const w = s.warmStatus!;
    assert.equal(w.bad, 0);
    assert.equal(w.timeouts, 0);
    assert.ok(w.keys > 2_000);
    const n = (sql: string) => Number((s.db.prepare(sql).get() as { n: number }).n);
    assert.equal(n('SELECT COUNT(*) AS n FROM fills'), 2 * (900 + 180));
    assert.equal(n("SELECT SUM(trades) AS n FROM activity_hour WHERE venue = 'lighter'"), 400);
  } finally {
    delete process.env.VALUESCAN_WARM_THREADS;
    s.stopWriter();
    s.close();
  }
});

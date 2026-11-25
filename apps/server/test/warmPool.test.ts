/** The warm-up pool (indexer/warmPool.ts): its lookups are valid against the real schema, and rows land the same with it on. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IndexStore, type FillRow } from '../src/indexer/store.js';

const n0 = (s: IndexStore) => Number((s.db.prepare('SELECT COUNT(*) AS n FROM fills').get() as { n: number }).n);

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
    // Cohort members on the writer thread: every row, its rev one after another, the sequence's end in meta.
    const member = (i: number, pnl: number) => ({ address: `0x${i.toString(16).padStart(40, '0')}`, pnl, equity: 1, label: null, pnl1d: null, pnl7d: 2, pnl30d: null });
    const before = s.cohortRevState()!.rev;
    await s.putCohortMembersAsync('lighter', Array.from({ length: 300 }, (_, i) => member(i, i)), now);
    await s.putCohortMembersAsync('lighter', Array.from({ length: 20 }, (_, i) => member(i, -1)), now);
    s.putCohortMembers('lighter', [member(400, 7)], now);
    assert.equal(s.cohortMembers('lighter').size, 301);
    assert.equal(s.cohortMembers('lighter').get(member(3, 0).address)!.pnl, -1);
    assert.equal(s.cohortRevState()!.rev, before + 321);
    const revs = (s.db.prepare("SELECT rev FROM cohort_member WHERE venue = 'lighter' ORDER BY rev").all() as Array<{ rev: number }>).map((r) => r.rev);
    assert.equal(new Set(revs).size, 301);
    assert.equal(revs.at(-1), before + 321);
    await s.warmCohort('members', Array.from({ length: 100 }, (_, i): [string, string] => ['lighter', member(i, 0).address]));
    await s.warmCohort('books', Array.from({ length: 100 }, (_, i): [string, string] => ['lighter', member(i, 0).address]));
    const left = n0(s);
    await s.dropStreamRowsAsync('hyperliquid', rows[0]!.address, 0, now, async () => {});
    assert.equal(n0(s), left, 'no stream row, nothing dropped');
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

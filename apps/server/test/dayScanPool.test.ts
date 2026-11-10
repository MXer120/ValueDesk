/**
 * Run: npx tsx --test test/dayScanPool.test.ts   (from apps/server)
 *
 * A window's first day read on the reader threads (dayScanPool.ts) gives exactly what the indexer's own loop gives.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IndexStore, type FillRow } from '../src/indexer/store.js';

const DAY = 86_400_000;

function fill(o: Partial<FillRow> & { id: string; t: number }): FillRow {
  return { venue: 'hyperliquid', address: '0xa', symbol: 'BTC', side: 1, px: 100, sz: 1, fee: 0.1, closedPnl: null, oid: null, src: 1, ...o };
}

function rowsOf(address: string, venue: 'hyperliquid' | 'sodex', day: number, n: number): FillRow[] {
  const rows: FillRow[] = [];
  // Blocks of several fills at one time, two markets, both sides, opening (0), closing and unknown PnL, fees and none,
  // REST and stream rows - over three chunks of the scan.
  for (let i = 0; i < n; i++) {
    rows.push(fill({
      venue, address, id: `${address}-${i}`, t: day + 60_000 + Math.floor(i / 3) * 30_000, oid: `${address}o${i >> 1}`,
      symbol: i % 5 ? 'BTC' : 'ETH', side: i % 7 < 4 ? 1 : -1, px: 100 + (i % 13) * 0.37, sz: 0.1 + (i % 11) * 0.013,
      closedPnl: i % 4 === 0 ? 0 : i % 4 === 1 ? ((i % 9) - 4) * 1.17 : i % 4 === 2 ? null : 0.31,
      fee: i % 6 ? 0.0123 * (i % 6) : null, src: i % 10 ? 1 : 0,
    }));
  }
  return rows;
}

test('first days read on reader threads equal the inline read, held for later starts, prefetched side by side', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-dayscan-'));
  const pooled = new IndexStore(join(dir, 'index.db'), { aggRefreshMs: 0 });
  const inline = new IndexStore(':memory:', { aggRefreshMs: 0 });
  try {
    assert.equal(pooled.startDayScans(2), true);
    assert.equal(inline.startDayScans(2), false, 'never on a memory file');
    const yesterday = Math.floor(Date.now() / DAY) * DAY - DAY;
    const wallets = ['0xa', '0xb', '0xc', '0xd'];
    const rows = [...wallets.flatMap((a, i) => rowsOf(a, 'hyperliquid', yesterday, 900 + i * 700)), ...rowsOf('0xs', 'sodex', yesterday, 1_200)];
    const closes = [
      { venue: 'sodex' as const, address: '0xs', id: 'c1', t: yesterday + 3_600_000, openedT: yesterday, symbol: 'BTC-USD', pnl: 4 },
      { venue: 'sodex' as const, address: '0xs', id: 'c2', t: yesterday + 5 * 3_600_000, openedT: yesterday + 60_000, symbol: 'BTC-USD', pnl: -1 },
    ];
    for (const s of [pooled, inline]) {
      s.putFills(rows);
      s.putCloses(closes);
      for (const a of wallets) s.windowStats('hyperliquid', a, 0);
      s.windowStats('sodex', '0xs', 0);
      while (s.buildAggregates(1_000) > 0) { /* build */ }
    }
    const pause = async () => {};
    const read = async (s: IndexStore, venue: 'hyperliquid' | 'sodex', a: string, from: number) => ({
      stats: await s.windowStatsAsync(venue, a, from, pause),
      orders: await s.orderCountAsync(venue, a, from, pause),
      realized: await s.realizedAsync(venue, a, from, pause),
    });
    // Ahead of time, all wallets at once (the boards' picks), then the sums.
    const first = yesterday + 15 * 60_000;
    await pooled.prefetchPartials('hyperliquid', wallets, first, pause);
    const st = pooled.dayScanStatus!;
    assert.equal(st.on, true);
    assert.equal(st.done, wallets.length, 'one read per wallet, on the threads');
    assert.equal(st.failed, 0);
    for (const a of wallets) assert.deepEqual(await read(pooled, 'hyperliquid', a, first), await read(inline, 'hyperliquid', a, first), `${a} from ${first}`);
    assert.equal(pooled.dayScanStatus!.done, wallets.length, 'the sums found them read');
    // Later starts in that finished day: from the rows the threads handed back, the same figures.
    for (const from of [first + 1, yesterday + 3_600_000 + 30_000, yesterday + 5 * 3_600_000 + 7]) {
      for (const a of wallets) assert.deepEqual(await read(pooled, 'hyperliquid', a, from), await read(inline, 'hyperliquid', a, from), `${a} from ${from}`);
    }
    assert.equal(pooled.dayScanStatus!.done, wallets.length, 'later starts read nothing again');
    assert.ok(pooled.heldPartials.hits >= wallets.length * 3, 'they came from what is held');
    // SoDEX: closes from the closes table, read by the thread too.
    for (const from of [first, yesterday + 2 * 3_600_000]) assert.deepEqual(await read(pooled, 'sodex', '0xs', from), await read(inline, 'sodex', '0xs', from), `sodex from ${from}`);
    // A late fill on that day: read again, and the figures follow.
    const late = [fill({ id: 'late', t: yesterday + 4 * 3_600_000, oid: 'lo', closedPnl: 2.5, side: -1 })];
    for (const s of [pooled, inline]) { s.putFills(late); s.flushAggregates(1_000); }
    const from = yesterday + 3 * 3_600_000;
    assert.deepEqual(await read(pooled, 'hyperliquid', '0xa', from), await read(inline, 'hyperliquid', '0xa', from), 'after a late fill');
  } finally {
    pooled.close();
    inline.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with the threads gone, first days are read inline: same figures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-dayscan-'));
  const s = new IndexStore(join(dir, 'index.db'), { aggRefreshMs: 0 });
  const ref = new IndexStore(':memory:', { aggRefreshMs: 0 });
  try {
    const yesterday = Math.floor(Date.now() / DAY) * DAY - DAY;
    const rows = rowsOf('0xa', 'hyperliquid', yesterday, 1_500);
    for (const x of [s, ref]) {
      x.putFills(rows);
      x.windowStats('hyperliquid', '0xa', 0);
      while (x.buildAggregates(1_000) > 0) { /* build */ }
    }
    s.startDayScans(1);
    // Every read on the thread fails: the reads fall back to the loop here.
    (s as unknown as { dayScans: { scan: () => Promise<never> } }).dayScans.scan = () => Promise.reject(new Error('gone'));
    const pause = async () => {};
    const from = yesterday + 15 * 60_000;
    assert.deepEqual(await s.windowStatsAsync('hyperliquid', '0xa', from, pause), await ref.windowStatsAsync('hyperliquid', '0xa', from, pause));
  } finally {
    s.close();
    ref.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

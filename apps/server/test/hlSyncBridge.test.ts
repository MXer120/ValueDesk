/**
 * Run: npx tsx --test test/hlSyncBridge.test.ts   (from apps/server)
 *
 * A Hyperliquid catch-up after a stream break reads only the gap (indexer/hlSource.ts hlSyncFills `streamSince`), not up
 * to now: the stream's rows after its connection began stay, and the held range ends just past that start, where the
 * engine's advanceCoverage takes it to now.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IndexStore } from '../src/indexer/store.js';
import { BRIDGE_PAST_MS, hlSyncFills } from '../src/indexer/hlSource.js';
import { hlInfo } from '../src/valuedesk/hyperliquid/index.js';

const A = '0x00000000000000000000000000000000000000aa';
const H = 3_600_000;

const raw = (tid: number, time: number) => ({ coin: 'BTC', px: '100', sz: '1', side: 'B', time, tid, fee: '0.01', closedPnl: '0', oid: tid });

test('a catch-up after a stream break asks only for the gap and keeps the stream rows after it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-bridge-'));
  const store = new IndexStore(join(dir, 'i.db'));
  const post = hlInfo.post;
  try {
    const now = Math.floor(Date.now() / 1000) * 1000 - 2 * H;
    const heldTo = now - 19 * H;
    const since = now - 3 * H;
    store.addCoverage('hyperliquid', A, 'fills', { fromT: now - 30 * 24 * H, toT: heldTo }, heldTo);
    // What the stream stored since its connection began: two prints, kept as they are.
    store.putFills([
      { venue: 'hyperliquid', address: A, id: 's1', t: since + 2 * H, symbol: 'BTC', side: 1, px: 100, sz: 1, fee: null, closedPnl: null, oid: null, src: 0 },
      { venue: 'hyperliquid', address: A, id: 's2', t: since + 2.5 * H, symbol: 'BTC', side: -1, px: 101, sz: 1, fee: null, closedPnl: null, oid: null, src: 0 },
    ]);
    const asked: Array<Record<string, unknown>> = [];
    hlInfo.post = (async (body: Record<string, unknown>) => {
      asked.push(body);
      // Hyperliquid answers what falls in [startTime, endTime]: two fills in the gap.
      return [raw(1, heldTo + H), raw(2, since - H)].filter((f) => f.time >= Number(body.startTime) && (body.endTime === undefined || f.time <= Number(body.endTime)));
    }) as typeof hlInfo.post;

    await hlSyncFills(store, A, now, { maxPages: 1, now, streamSince: since });

    assert.equal(asked.length, 1, 'one page');
    assert.equal(asked[0]!.startTime, heldTo);
    assert.equal(asked[0]!.endTime, since + BRIDGE_PAST_MS, 'only the gap, to just past the connection start');
    const cov = store.coverage('hyperliquid', A, 'fills')!;
    assert.equal(cov.toT, since + BRIDGE_PAST_MS);
    const ids = store.walletFillRows('hyperliquid', A, 0, Number.MAX_SAFE_INTEGER, 100).map((r) => String(r.id)).reverse();
    assert.deepEqual(ids, ['1', '2', 's1', 's2'], 'the gap from REST, the stream rows after it kept');

    // No break since the held range ended (or no stream): read to now, as before.
    asked.length = 0;
    await hlSyncFills(store, A, now, { maxPages: 1, now: now + H, streamSince: null });
    assert.equal(asked.length, 1);
    assert.equal(asked[0]!.endTime, undefined);
  } finally {
    hlInfo.post = post;
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

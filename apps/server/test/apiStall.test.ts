/**
 * The 2026-11-07 outage's fixes: the liquidation history built on its own thread (same answers, a full thread says
 * busy), the newest snapshot's coins found without scanning the table, and the API's loop watch.
 *
 *   npx tsx --test test/apiStall.test.ts   (from apps/server)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'vs-api-stall-'));
process.env.VALUESCAN_INDEX_DB = join(dir, 'index.db');

const { IndexStore } = await import('../src/indexer/store.js');
const { liqJob, okJson, stopLiqThread, liqThreadStats } = await import('../src/indexer/liqHistThread.js');
const { LoopWatch } = await import('../src/loopWatch.js');
const { mark } = await import('../src/indexer/busy.js');

const w = new IndexStore(process.env.VALUESCAN_INDEX_DB);
const now = Date.now();
const snap = (p: number) => JSON.stringify({ p, st: 10, v: { hyperliquid: [[p / 10 - 3, 1_000, 0, 0, 0, 0, 0, 0, 0], [p / 10 + 3, 0, 2_000, 0, 0, 0, 0, 0, 0]] } });
for (let k = 0; k < 20; k++) w.putLiqHist(now - (20 - k) * 15 * 60_000, [['BTC', snap(60_000 + k * 10)], ['ETH', snap(3_000 + k)]]);
// SOL stopped a snapshot before the newest: not one of the newest snapshot's coins.
w.putLiqHist(now - 21 * 15 * 60_000, [['SOL', snap(150)]]);

after(async () => {
  await stopLiqThread();
  w.close();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* a handle on Windows */ }
});

test('the newest snapshot\'s coins, walked coin by coin, are what the old statement gave', () => {
  assert.deepEqual(w.liqHistCoins(), ['BTC', 'ETH']);
  const old = (w.db.prepare('SELECT coin FROM liq_hist WHERE t = (SELECT MAX(t) FROM liq_hist)').all() as Array<{ coin: string }>).map((r) => r.coin);
  assert.deepEqual(w.liqHistCoins(), old);
});

test('the history built on its own thread is the inline answer, byte for byte', async () => {
  const job = { kind: 'history' as const, coin: 'BTC', venues: ['hyperliquid' as const], range: '1d' as const, wallets: [], known: null };
  process.env.VALUESCAN_LIQ_THREAD = '0';
  const inline = await liqJob(job);
  process.env.VALUESCAN_LIQ_THREAD = '1';
  try {
    const threaded = await liqJob(job);
    assert.equal(threaded, inline);
    const body = JSON.parse(okJson(threaded)!);
    assert.equal(body.ok, true);
    assert.equal(body.points.length, 20);
    assert.deepEqual(body.coins, ['BTC', 'ETH']);
    // Identical asks at once share one build.
    const before = liqThreadStats.done;
    const three = await Promise.all([liqJob(job), liqJob(job), liqJob(job)]);
    assert.ok(three.every((x) => x === inline));
    assert.equal(liqThreadStats.done - before, 1);
  } finally {
    delete process.env.VALUESCAN_LIQ_THREAD;
  }
});

test('okJson: the route\'s answer around the body, null without an index', () => {
  assert.equal(okJson('null'), null);
  assert.equal(okJson('{}'), '{"ok":true}');
  assert.equal(okJson('{"a":1}'), '{"ok":true,"a":1}');
});

test('the loop watch counts a stall, names what started it and what was in flight, and says so in health', async () => {
  const lines: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const lw = new LoopWatch((obj, msg) => lines.push({ obj, msg }));
  assert.deepEqual(lw.health(), { stalls: 0, longestMs: 0, lastMinuteMs: 0, last: null, slowRequests: 0 });
  const t = Date.now();
  mark('req:/api/vs/liquidations/history');
  lw.onLate(400, t + 5_000);
  assert.equal(lw.health().stalls, 0, 'under a second is not a stall');
  lw.onLate(3_200, t + 3_250);
  const h = lw.health(t + 3_300);
  assert.equal(h.stalls, 1);
  assert.equal(h.longestMs, 3_200);
  assert.equal(h.lastMinuteMs, 3_200);
  assert.equal(h.last?.by, 'req:/api/vs/liquidations/history');
  assert.equal(lw.health(t + 3_250 + 61_000).lastMinuteMs, 0, 'a minute on, the last minute holds none');
  await new Promise((r) => setTimeout(r, 1_100));
  assert.match(lines[0]!.msg, /api thread stalled 3\.2 s, started by req:\/api\/vs\/liquidations\/history/);
  lw.stop();
});

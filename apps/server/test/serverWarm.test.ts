/**
 * Run: npx tsx --test test/serverWarm.test.ts   (from apps/server)
 *
 * The holds and warm-ups of the 2026-11-18 phone pass, each against the rule it must keep:
 *   - aheadValue.ts: SoDEX's internal pair and maintenance flag read again just before they lapse while asked - never an
 *     older value than the 15 s hold handed out, a failure never kept, nothing read while nobody asks;
 *   - the screener's Hyperliquid markets answer with the time they were read (a 30 s poll revalidates to a 304);
 *   - the screener's pools read once 15 minutes old while nobody asks (never past their 20-minute stale limit);
 *   - the leaderboard podium read ahead once its kept curve lapsed, at most once per row per TTL;
 *   - the hosted gate's 429s counted per class and client, without an address.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AheadValue } from '../src/aheadValue.js';
import { hlAssetsAt, resetAssetsCache, ASSETS_TTL_MS } from '../src/valuedesk/screener/assets.js';
import { SCREENER_IDLE_EVERY, SCREENER_WARM_MS, screenerLookDue } from '../src/valuedesk/screener.js';
import { POOL_STALE_MAX_MS } from '../src/valuedesk/screener/pool.js';
import { clearCurves, warmPodium } from '../src/valuedesk/curves.js';
import { LimitedCount } from '../src/hosted.js';
import type { TraderRow } from '../src/valuedesk/types.js';

function clock(start = 1_000_000): { now: () => number; at: (t: number) => void; add: (ms: number) => void } {
  let t = start;
  return { now: () => t, at: (x) => { t = x; }, add: (ms) => { t += ms; } };
}

test('AheadValue: held 15 s, one read at a time, a read ahead only while asked, never an older value', async () => {
  const c = clock();
  let reads = 0;
  let fail = false;
  const v = new AheadValue(async () => {
    reads++;
    if (fail) throw new Error('down');
    return { n: reads, at: c.now() };
  }, { ttlMs: 15_000, askedWithinMs: 20_000, now: c.now, timers: false });

  // Coalesced: two asks, one read.
  const [a, b] = await Promise.all([v.get(), v.get()]);
  assert.equal(reads, 1);
  assert.equal(a, b);
  c.add(10_000);
  assert.equal((await v.get()).n, 1, 'held');
  assert.equal(v.tick(), false, 'not due yet');
  // Due 15 s - lead (0.5 s for a read that took no time) after the read: asked 4 s ago, so read ahead.
  c.add(4_600);
  assert.equal(v.dueAt(), 1_000_000 + 15_000 - 500);
  assert.equal(v.tick(), true);
  await new Promise((r) => setImmediate(r));
  assert.equal(reads, 2);
  // A request after the old one's 15 s: the new value, with no wait (no read of its own).
  c.add(1_000);
  const got = await v.get();
  assert.equal(got.n, 2);
  assert.equal(reads, 2);
  assert.equal(v.stats.waited, 2, 'only the first two requests (sharing one read) waited');

  // Nobody asks for longer than askedWithinMs: nothing is read ahead.
  c.add(21_000);
  assert.equal(v.tick(), false);
  assert.equal(reads, 2);
  // And the next ask after the value lapsed reads (and waits), as the 15 s hold did.
  assert.equal((await v.get()).n, 3);
  assert.equal(v.stats.waited, 3);

  // A failed read ahead is not kept: the held value stays only until its own 15 s.
  c.add(14_600);
  v.get();
  fail = true;
  assert.equal(v.tick(), true);
  await new Promise((r) => setImmediate(r));
  assert.equal(v.stats.failed, 1);
  c.add(500);
  await assert.rejects(v.get(), /down/, 'lapsed and the read fails: an error, not the old value');
  fail = false;
  assert.equal((await v.get()).n, 6);
});

test('AheadValue: the lead follows the last read time, within 0.5-5 s and a third of the TTL', async () => {
  const c = clock();
  const v = new AheadValue(async () => { c.add(1_200); return 1; }, { ttlMs: 15_000, askedWithinMs: 20_000, now: c.now, timers: false });
  await v.get();
  assert.equal(v.lead(), 2_400);
  const slow = new AheadValue(async () => { c.add(9_000); return 1; }, { ttlMs: 15_000, askedWithinMs: 20_000, now: c.now, timers: false });
  await slow.get();
  assert.equal(slow.lead(), 5_000);
});

test('screener assets: updatedAt is when the markets were read, the same for every request until they are read again', async () => {
  resetAssetsCache();
  const c = clock(5_000_000);
  let posts = 0;
  const info = {
    post: async <T>(body: { dex?: string }): Promise<T> => {
      posts++;
      return [{ universe: [{ name: body.dex ? 'TSLA' : 'BTC', maxLeverage: 10 }] }, [{ markPx: '100', prevDayPx: '90', dayNtlVlm: String(posts), openInterest: '1' }]] as T;
    },
  };
  const a = await hlAssetsAt(info as never, c.now);
  c.add(20_000);
  const b = await hlAssetsAt(info as never, c.now);
  assert.equal(a.at, 5_000_000);
  assert.equal(b.at, a.at, 'the same answer, the same time');
  assert.equal(b.rows, a.rows);
  assert.equal(posts, 2, 'two dexes, read once');
  c.add(ASSETS_TTL_MS);
  const stale = await hlAssetsAt(info as never, c.now);
  assert.equal(stale.at, a.at, 'served while it is read again, with its own time');
  await new Promise((r) => setImmediate(r));
  const fresh = await hlAssetsAt(info as never, c.now);
  assert.equal(fresh.at, c.now());
  resetAssetsCache();
});

test('screener pools: read while visited; while idle once 15 minutes old, inside the 20-minute stale limit', () => {
  const now = 100 * 3_600_000;
  assert.equal(screenerLookDue(now, now - 60_000, now - 30_000), true, 'visited: the pool cache decides');
  const idle = now - SCREENER_WARM_MS - 1;
  assert.equal(screenerLookDue(now, idle, now - 60_000), false);
  assert.equal(screenerLookDue(now, idle, now - SCREENER_IDLE_EVERY), true);
  assert.equal(screenerLookDue(now, idle, null), true, 'none yet');
  assert.ok(SCREENER_IDLE_EVERY + 60_000 + 60_000 < POOL_STALE_MAX_MS, 'a look a minute late and a minute-long build stay inside the stale limit');
});

test('podium warm-up: rows whose curve lapsed (or was never read), at most once per row per TTL', async () => {
  clearCurves();
  // trade.xyz rows: no venue read (it publishes no curve), so the round can be counted without I/O.
  const rows = [1, 2, 3, 4].map((i) => ({ venue: 'tradexyz', address: `0x${String(i).padStart(40, '0')}`, pnl: {}, roi: {}, volume: {} }) as unknown as TraderRow);
  const t = 50_000_000;
  assert.equal(await warmPodium(rows, '30d', t), 3, 'the podium only');
  assert.equal(await warmPodium(rows, '30d', t + 60_000), 0, 'tried within the TTL');
  assert.equal(await warmPodium(rows, '30d', t + 10 * 60_000 + 1), 3, 'again after it');
  clearCurves();
});

test('hosted gate refusals are counted per class and client, never by address', () => {
  const c = new LimitedCount();
  assert.equal(c.flush(), null);
  for (let i = 0; i < 5; i++) c.note('read', '203.0.113.7', '/api/vs/leaderboard');
  c.note('read', '198.51.100.1', '/api/health');
  c.note('upstream', '198.51.100.1', '/api/vs/sodex/mm-daily');
  const m = c.flush()!;
  assert.deepEqual(m.refused, { read: 6, upstream: 1 });
  assert.equal(m.clients, 2);
  assert.equal(m.mostFromOne, 5);
  assert.deepEqual(m.routes[0], ['/api/vs/leaderboard', 5]);
  assert.doesNotMatch(JSON.stringify(m), /203\.0|198\.51/, 'no address leaves it');
  assert.equal(c.flush(), null, 'the next minute starts empty');
  assert.deepEqual(c.total, { read: 6, upstream: 1 });
});

test('AheadValue: a failed read ahead is not tried again for the same held value (no read per request while upstream fails)', async () => {
  const c = clock();
  let reads = 0;
  let fail = false;
  const v = new AheadValue(async () => {
    reads++;
    if (fail) throw new Error('down');
    return reads;
  }, { ttlMs: 15_000, askedWithinMs: 20_000, now: c.now, timers: false });
  assert.equal(await v.get(), 1);
  c.add(14_600);
  fail = true;
  assert.equal(v.tick(), true);
  await new Promise((r) => setImmediate(r));
  assert.equal(reads, 2);
  // Still held: requests get the held value, and no look reads ahead again for it.
  assert.equal(await v.get(), 1);
  assert.equal(v.tick(), false);
  assert.equal(await v.get(), 1);
  assert.equal(reads, 2);
  // Lapsed: a request reads again (as the old hold did); a good value then reads ahead as before.
  c.add(500);
  fail = false;
  assert.equal(await v.get(), 3);
  c.add(14_600);
  assert.equal(v.tick(), true);
});

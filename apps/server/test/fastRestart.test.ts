/**
 * A stop and a start that cost seconds (2026-11-07): the write backlog goes to a spill and comes back exactly once, the
 * build answers and the HL leaderboard are handed to the next start, the stop is timed and published, the boards' HL reads
 * are not starved by the cohort reads, and a stall leaves its last minute of samples.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { IndexStore, type FillRow } from '../src/indexer/store.js';
import { Indexer } from '../src/indexer/engine.js';
import { statusRow, stopLaps } from '../src/indexer/worker.js';
import { HlInfoClient } from '../src/valuedesk/hyperliquid/info.js';
import { HlLeaderboardStore, LbSnapshot, parseLeaderboard } from '../src/valuedesk/hyperliquid/leaderboard.js';
import { loadLeaderboardFile, saveLeaderboardFile } from '../src/valuedesk/hyperliquid/leaderboardFile.js';
import { mergeProfiles, StallProfiler, type CpuProfile } from '../src/indexer/stallProfiler.js';
import { mark, resumed, startedBefore, within } from '../src/indexer/busy.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (what: string, ok: () => boolean, ms = 8_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`timed out: ${what}`);
    await sleep(5);
  }
};

interface IxPriv {
  pendingFills: FillRow[];
  act: Map<string, { trades: number; volume: number }>;
  writes: { backlog: number; waiting: boolean };
  cache: Map<string, { ver: number; at: number; value: unknown }>;
  flush(): void;
  replaySpill(): number;
  saveWarm(): void;
  loadWarm(): number;
  reusable(hit: { ver: number; at: number }, ver: number, now: number, sticky: boolean): boolean;
  stop(lap?: (s: string) => void): void;
}

const fill = (i: number, t: number): FillRow => ({
  venue: 'hyperliquid', address: `0x${(i % 7).toString(16).padStart(40, '0')}`, id: `p${i}`, t: t + i, symbol: 'BTC', side: i % 2 ? 1 : -1,
  px: 100 + i, sz: 1, fee: null, closedPnl: null, oid: null, src: 0,
});
const fillCount = (s: IndexStore) => (s.db.prepare('SELECT COUNT(*) AS n FROM fills').get() as { n: number }).n;
const activity = (s: IndexStore) => ({ ...(s.db.prepare('SELECT COALESCE(SUM(trades), 0) AS t, COALESCE(SUM(volume), 0) AS v FROM activity_hour').get() as { t: number; v: number }) });
const spillRows = (s: IndexStore) => {
  try { return (s.db.prepare('SELECT COUNT(*) AS n FROM write_spill').get() as { n: number }).n; } catch { return 0; }
};

/** A writer with a backlog: rows queued while the write queue waits for its turn, then the stop. */
function stopWithBacklog(path: string, now: number, steps: string[]): void {
  const s = new IndexStore(path, { aggRefreshMs: 0 });
  const ix = new Indexer(s, () => now) as unknown as IxPriv;
  // The queue waits for a turn of the loop that never comes before the stop: everything flushed stays unwritten.
  ix.writes.waiting = true;
  ix.pendingFills = Array.from({ length: 120 }, (_, i) => fill(i, now - 60_000));
  ix.act.set(`sodex|7|${Math.floor(now / 3_600_000)}`, { trades: 3, volume: 30 });
  ix.flush();
  assert.equal(fillCount(s), 0, 'a backlog: nothing written yet');
  ix.pendingFills = Array.from({ length: 30 }, (_, i) => fill(120 + i, now - 30_000));
  ix.act.set(`sodex|8|${Math.floor(now / 3_600_000)}`, { trades: 2, volume: 20 });
  ix.stop((step) => steps.push(step));
  assert.equal(fillCount(s), 0, 'the stop wrote no fill row: they are in the spill');
  assert.equal(activity(s).t, 0, 'nor any activity');
  assert.ok(spillRows(s) >= 5, `the spill holds the parts (${spillRows(s)})`);
  s.close();
}

test('stop: the write backlog goes to the spill, and the next start writes every row exactly once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-spill-'));
  const path = join(dir, 'index.db');
  const now = Date.now();
  try {
    const steps: string[] = [];
    stopWithBacklog(path, now, steps);
    assert.ok(steps.some((x) => /^write backlog \(\d+ steps; spilled 152 rows\)$/.test(x)), steps.join(' | '));

    const s = new IndexStore(path, { aggRefreshMs: 0 });
    const ix = new Indexer(s, () => now) as unknown as IxPriv;
    assert.equal(ix.replaySpill(), 152);
    await until('the spill written', () => ix.writes.backlog === 0);
    assert.equal(fillCount(s), 150);
    assert.deepEqual(activity(s), { t: 5, v: 50 });
    assert.equal(spillRows(s), 0, 'each part left the spill as it was written');
    // A second start finds nothing: nothing is counted twice.
    assert.equal(ix.replaySpill(), 0);
    assert.deepEqual(activity(s), { t: 5, v: 50 });
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test('stop: a start that ends midway through the spill leaves only the rest, and the next writes that once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-spill-'));
  const path = join(dir, 'index.db');
  const now = Date.now();
  try {
    stopWithBacklog(path, now, []);
    // Two parts written, then the process dies.
    let s = new IndexStore(path, { aggRefreshMs: 0 });
    const parts = s.spilledWrites();
    s.replaySpill(parts[0]!.id);
    s.replaySpill(parts[1]!.id);
    s.replaySpill(parts[1]!.id);
    const mid = activity(s).t;
    s.close();
    s = new IndexStore(path, { aggRefreshMs: 0 });
    const ix = new Indexer(s, () => now) as unknown as IxPriv;
    assert.equal(ix.replaySpill(), 152 - parts[0]!.rows - parts[1]!.rows);
    await until('the rest written', () => ix.writes.backlog === 0);
    assert.equal(fillCount(s), 150);
    assert.deepEqual(activity(s), { t: 5, v: 50 });
    assert.ok(mid <= 5);
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test('stop: rows a stop finds already written are not spilled again, and a stop during the replay keeps the rest in the spill', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-spill-'));
  const path = join(dir, 'index.db');
  const now = Date.now();
  try {
    stopWithBacklog(path, now, []);
    const s = new IndexStore(path, { aggRefreshMs: 0 });
    const ix = new Indexer(s, () => now) as unknown as IxPriv;
    ix.writes.waiting = true;
    ix.replaySpill();
    // Stopped before any replay step ran: the spill keeps every part, and nothing is added to it.
    const before = spillRows(s);
    ix.stop();
    assert.equal(spillRows(s), before);
    assert.equal(fillCount(s), 0);
    s.close();
    const s2 = new IndexStore(path, { aggRefreshMs: 0 });
    const ix2 = new Indexer(s2, () => now) as unknown as IxPriv;
    ix2.replaySpill();
    await until('written', () => ix2.writes.backlog === 0);
    assert.equal(fillCount(s2), 150);
    assert.deepEqual(activity(s2), { t: 5, v: 50 });
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test('stop: with no backlog the last rows are spilled too, and a stop that cannot spill writes them as before', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-spill-'));
  const path = join(dir, 'index.db');
  const now = Date.now();
  try {
    const s = new IndexStore(path, { aggRefreshMs: 0 });
    const ix = new Indexer(s, () => now) as unknown as IxPriv;
    ix.pendingFills = Array.from({ length: 60 }, (_, i) => fill(i, now - 10_000));
    ix.stop();
    assert.equal(fillCount(s), 0, 'an idle queue: the last rows are spilled, none written in the stop');
    assert.equal(spillRows(s), 2);
    s.close();
    const s2 = new IndexStore(path, { aggRefreshMs: 0 });
    const ix2 = new Indexer(s2, () => now) as unknown as IxPriv;
    s2.spillWrites = () => { throw new Error('disk full'); };
    ix2.pendingFills = Array.from({ length: 60 }, (_, i) => fill(100 + i, now - 10_000));
    ix2.stop();
    assert.equal(fillCount(s2), 60, 'written in the stop, as before the spill');
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test('warm cache: the build answers go to the next start; one whose trader changed since is reused only by age', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-warm-'));
  const path = join(dir, 'index.db');
  const now = Date.now();
  let s: IndexStore = new IndexStore(path, { aggRefreshMs: 0 });
  try {
    let ix = new Indexer(s, () => now) as unknown as IxPriv;
    const a = '0x' + 'a'.repeat(40);
    const b = '0x' + 'b'.repeat(40);
    ix.cache.set(`t|hyperliquid|${a}|30d`, { ver: 0, at: now - 60_000, value: { n: 12, exact: true } });
    // b's data changed after its answer was computed.
    s.putFills([{ ...fill(1, now - 5_000), address: b }]);
    ix.cache.set(`s|hyperliquid|${b}|30d`, { ver: 0, at: now - 60_000, value: { stats: { trades: 1 } } });
    // Too old to hand over.
    ix.cache.set(`t|hyperliquid|${b}|7d`, { ver: 1, at: now - 3 * 3_600_000, value: { n: 1, exact: false } });
    // The last build took 10 minutes: an unchanged answer is reused for 15 (reuseMs), in the next process too.
    (ix as unknown as { lastBuildMs: number }).lastBuildMs = 10 * 60_000;
    ix.saveWarm();
    s.close();
    assert.ok(existsSync(join(dir, 'warm-cache.json')));

    s = new IndexStore(path, { aggRefreshMs: 0 });
    ix = new Indexer(s, () => now) as unknown as IxPriv;
    assert.equal(ix.loadWarm(), 2);
    assert.ok(!existsSync(join(dir, 'warm-cache.json')), 'the file is taken');
    const ta = ix.cache.get(`t|hyperliquid|${a}|30d`)!;
    const sb = ix.cache.get(`s|hyperliquid|${b}|30d`)!;
    assert.deepEqual(ta.value, { n: 12, exact: true });
    // Unchanged trader: reusable past the sticky age, as long as its version holds.
    assert.equal(ix.reusable(ta, s.version('hyperliquid', a), now + 6 * 60_000, false), true);
    s.putFills([{ ...fill(2, now - 1_000), address: a }]);
    assert.equal(ix.reusable(ta, s.version('hyperliquid', a), now + 6 * 60_000, false), false, 'a new row of its trader ends it');
    // Changed trader: only within the sticky age.
    assert.equal(ix.reusable(sb, s.version('hyperliquid', b), now, true), true);
    assert.equal(ix.reusable(sb, s.version('hyperliquid', b), now + 6 * 60_000, false), false);
    assert.equal(ix.cache.has(`t|hyperliquid|${b}|7d`), false);
  } finally {
    try { s.close(); } catch { /* closed */ }
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test('stop timing: each step of a second or more is logged as it ends, and all of them at the end', () => {
  const lines: string[] = [];
  let t = 1_000;
  const lap = stopLaps(1_000, (l) => lines.push(l), () => t);
  t += 200; lap('lanes and streams');
  t += 4_500; lap('write backlog (12 steps; spilled 600 rows)');
  t += 50; lap('held rows');
  lap.done();
  assert.deepEqual(lines, [
    '[indexer] stop: write backlog (12 steps; spilled 600 rows) 4500 ms',
    '[indexer] stopped in 4750 ms: lanes and streams 200 ms, write backlog (12 steps; spilled 600 rows) 4500 ms, held rows 50 ms',
  ]);
});

test('status row: a stop says stopping, and since when; a running indexer does not', () => {
  const run = JSON.parse(statusRow({ lastBuildMs: 5 }, 10, 42)) as Record<string, unknown>;
  assert.deepEqual(run, { lastBuildMs: 5, at: 10, pid: 42 });
  const stop = JSON.parse(statusRow({ lastBuildMs: 5 }, 20, 42, 15)) as Record<string, unknown>;
  assert.equal(stop.stopping, true);
  assert.equal(stop.stoppingSince, 15);
});

test('HL leaderboard file: written and read back whole; too old, another layout or a broken file is none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-lb-'));
  const file = join(dir, 'hl-leaderboard.bin');
  try {
    const parsed = parseLeaderboard({
      leaderboardRows: [
        { ethAddress: '0x' + '1'.repeat(40), accountValue: '100.5', displayName: 'one', windowPerformances: [['day', { pnl: '1', roi: '0.1', vlm: '10' }], ['allTime', { pnl: '-3', roi: '-0.3', vlm: '30' }]] },
        { ethAddress: '0x' + '2'.repeat(40), accountValue: '7', displayName: null, windowPerformances: [['month', { pnl: '2', roi: '0.2', vlm: '20' }]] },
      ],
    } as never);
    const now = Date.now();
    const snap = new LbSnapshot(parsed, now - 20 * 60_000, '"etag-1"', now - 10 * 60_000);
    saveLeaderboardFile(file, snap);
    const back = loadLeaderboardFile(file, now)!;
    assert.ok(back);
    assert.deepEqual(back.data.addresses, parsed.addresses);
    assert.deepEqual(back.data.labels, parsed.labels);
    assert.deepEqual([...back.data.accountValue], [...parsed.accountValue]);
    for (const k of Object.keys(parsed.cols) as Array<keyof typeof parsed.cols>) {
      assert.deepEqual([...back.data.cols[k]].map(String), [...parsed.cols[k]].map(String), k);
    }
    assert.equal(back.etag, '"etag-1"');
    assert.equal(back.rankOf('0x' + '1'.repeat(40), 'pnl', '1d'), snap.rankOf('0x' + '1'.repeat(40), 'pnl', '1d'));
    assert.equal(loadLeaderboardFile(file, now + 45 * 60_000), null, 'numbers over an hour old');
    // Seeded into a store: the boards get it at once, and HL is asked at the next call (with its ETag).
    const asked: Array<Record<string, string>> = [];
    const store = new HlLeaderboardStore('http://hl.test/lb', (async (_u: unknown, init?: { headers?: Record<string, string> }) => {
      asked.push(init?.headers ?? {});
      return new Response(null, { status: 304 });
    }) as never);
    assert.equal(store.seed(back), true);
    assert.equal(store.seed(back), false, 'only when none is loaded');
    return store.snapshot().then(async (got) => {
      assert.equal(got, back);
      await until('HL asked', () => asked.length === 1);
      assert.equal(asked[0]!['If-None-Match'], '"etag-1"');
      // A cut file is none, and removed.
      const buf = readFileSync(file);
      const { writeFileSync } = await import('node:fs');
      writeFileSync(file, buf.subarray(0, buf.length - 8));
      assert.equal(loadLeaderboardFile(file, now), null);
      assert.equal(existsSync(file), false);
    });
  } finally {
    setTimeout(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }), 100).unref();
  }
});

test('HL budget: in the indexer a background read waits for headroom only so long, then takes its turn behind the debt', async () => {
  let t = 0;
  let sent = 0;
  const client = new HlInfoClient('http://hl.test/info', 600, (async () => { sent++; return new Response('[]', { status: 200 }); }) as never, async (ms) => { t += ms; });
  client.clock = () => t;
  // The bucket kept in debt by the cohort reads: never 150 above the request.
  client.budget.msUntil = () => 1_000;
  client.budget.reserve = () => 0;
  client.backgroundMaxWaitMs = 10_000;
  await client.post({ type: 'userFills', user: '0x1' } as never, { background: true });
  assert.equal(sent, 1, 'the read went out');
  assert.ok(t >= 10_000 && t <= 12_000, `after the cap (${t} ms waited)`);
  // The API's client (no cap) would still be waiting: it never sees the headroom.
  const api = new HlInfoClient('http://hl.test/info', 600, (async () => { sent++; return new Response('[]', { status: 200 }); }) as never, async (ms) => { t += ms; if (t > 200_000) throw new Error('still waiting'); });
  api.clock = () => t;
  api.budget.msUntil = () => 1_000;
  await assert.rejects(api.post({ type: 'userFills', user: '0x2' } as never, { background: true }), /still waiting/);
});

test('stall profile: profiles one after another merge under one root, trimmed to the last minute', () => {
  const frame = (name: string) => ({ functionName: name, scriptId: '1', url: 'x.js', lineNumber: 1, columnNumber: 1 });
  const p1: CpuProfile = { nodes: [{ id: 1, callFrame: frame('(root)'), children: [2] }, { id: 2, callFrame: frame('old') }], startTime: 0, endTime: 50_000_000, samples: [2, 2], timeDeltas: [10_000_000, 30_000_000] };
  const p2: CpuProfile = { nodes: [{ id: 1, callFrame: frame('(root)'), children: [2] }, { id: 2, callFrame: frame('stall') }], startTime: 50_000_000, endTime: 100_000_000, samples: [2, 2, 2], timeDeltas: [5_000_000, 20_000_000, 20_000_000] };
  const m = mergeProfiles([p1, p2], 60_000_000);
  // Kept: from 40 s on - p1's sample at 40 s and all three of p2's.
  assert.equal(m.samples!.length, 4);
  assert.equal(m.startTime, 40_000_000);
  assert.equal(m.endTime, 100_000_000);
  assert.deepEqual(m.timeDeltas, [0, 15_000_000, 20_000_000, 20_000_000]);
  const byName = new Map(m.nodes.map((n) => [n.callFrame.functionName, n.hitCount]));
  assert.equal(byName.get('stall'), 3);
  assert.equal(byName.get('old'), 1);
  assert.equal(m.nodes[0]!.children!.length, 2, 'both trees under one root');
});

test('stall profile: a stall writes the last samples to a file, once in the gap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-stall-'));
  const lines: string[] = [];
  const p = new StallProfiler(dir, 'test-stall', { stallMs: 200, gapMs: 60_000, segmentMs: 60_000, sampleUs: 1_000, log: (l) => lines.push(l) });
  try {
    p.start();
    await sleep(100);
    const t0 = Date.now();
    let x = 0;
    while (Date.now() - t0 < 300) x += Math.sqrt(x + 1);
    p.onLag(300);
    p.onLag(400);
    await until('a file', () => p.lastFile !== null, 5_000);
    const files = readdirSync(dir).filter((f) => f.endsWith('.cpuprofile'));
    assert.equal(files.length, 1, 'one file in the gap');
    const prof = JSON.parse(readFileSync(join(dir, files[0]!), 'utf8')) as CpuProfile;
    assert.ok(prof.samples!.length > 50, `samples kept (${prof.samples!.length})`);
    assert.match(lines[0]!, /thread stalled 0 s: the last minute of samples is in/);
  } finally {
    p.stop();
    await sleep(50);
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test('stall labels: work that resumes after an await is named after itself, not after the timer that marked last', async () => {
  let resume!: () => void;
  const answer = new Promise<void>((r) => { resume = r; });
  const work = within('lane:hl:q', async () => {
    await answer;
    // The fetch thread's answer (or a yield of the loop) marks the waiting work again as it resumes.
    resumed();
    const t = Date.now();
    while (Date.now() - t < 5) { /* the long stretch */ }
    return Date.now();
  });
  await sleep(5);
  mark('coh:live');
  await sleep(5);
  resume();
  const at = await work;
  assert.equal(startedBefore(at), 'lane:hl:q');
});

/**
 * Run: npx tsx --test test/cohortKept.test.ts   (from apps/server)
 *
 * The cohort answers kept on the API thread (indexer/cohortThread.ts cohortAnswer, 2026-11-18): a kept answer is byte for
 * byte what the thread builds at that moment (runCohortJob, the path every request took before), it is handed out only
 * while the load and the kept reads beside it stand, a new load or a moved load time is read again, the routes send it
 * trimmed with the same ETag, and on the thread as inline. With the time of a request before and now (the benchmark
 * prints it; synthetic books - the local API has no production index).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { brotliDecompressSync } from 'node:zlib';
import Fastify from 'fastify';
import { IndexStore } from '../src/indexer/store.js';
import type { Venue } from '../src/valuedesk/types.js';
import { COHORTS } from '../src/valuedesk/cohorts/model.js';
import { omitNullLabels, perfPlugin, weakEtag } from '../src/perf.js';

const dir = mkdtempSync(join(tmpdir(), 'vs-cohort-kept-'));
const DB = join(dir, 'index.db');
process.env.VALUESCAN_INDEX_DB = DB;

const COINS = ['BTC', 'ETH', 'SOL', 'HYPE', 'xyz:TSLA', 'DOGE', 'XRP', 'SUI'];
const MARK: Record<string, number> = { BTC: 60_000, ETH: 3_000, SOL: 150, HYPE: 30, 'xyz:TSLA': 250, DOGE: 0.2, XRP: 0.6, SUI: 2 };
const addr = (venue: string, i: number) => `0x${venue.slice(0, 2)}${String(i).padStart(38, '0')}`.slice(0, 42);
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

const T0 = Date.now();
const writer = new IndexStore(DB);
for (const [venue, n, sd] of [['sodex', 2_000, 1], ['hyperliquid', 6_000, 2]] as Array<[Venue, number, number]>) {
  const r = rng(sd);
  const members = [];
  const books = [];
  for (let i = 0; i < n; i++) {
    const address = addr(venue, i);
    const equity = Math.round(r() ** 3 * 5_000_000);
    members.push({ address, pnl: Math.round((r() - 0.45) * 2_000_000), equity, label: i % 40 === 0 ? `name ${i}` : null, pnl1d: null, pnl7d: Math.round((r() - 0.5) * 50_000), pnl30d: Math.round((r() - 0.5) * 100_000) });
    if (i % 3 !== 0) {
      books.push({ venue, address, equity, at: T0 - 1_000, positions: Array.from({ length: 1 + Math.floor(r() * 3) }, () => {
        const symbol = COINS[Math.floor(r() * COINS.length)]!;
        return { symbol, szi: Math.round((r() - 0.45) * 1000) / 10, entry: MARK[symbol]! * (0.9 + r() * 0.2) };
      }) });
    }
  }
  writer.putCohortMembers(venue, members, T0);
  writer.putCohortBooks(books);
}
writer.putCohortMarks((['sodex', 'hyperliquid'] as Venue[]).flatMap((v) => COINS.map((c): [string, number] => [`${v}|${c}`, MARK[c]!])), T0);
// A week of the 15-minute series for every cohort, as the page's sparklines read it.
{
  const r = rng(9);
  const rows = [];
  for (const scope of ['hyperliquid,sodex', 'sodex', 'hyperliquid']) {
    for (const c of COHORTS) for (let t = T0 - 7 * 86_400_000; t < T0; t += 900_000) rows.push({ scope, cohort: c.id, t, long: r() * 1e8, short: r() * 1e8 });
  }
  writer.putCohortSeries(rows);
}

after(async () => {
  const { stopCohortThread } = await import('../src/indexer/cohortThread.js');
  await stopCohortThread();
  writer.close();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* a handle on Windows */ }
});

const V: Venue[] = ['sodex', 'hyperliquid'];
const JOBS = [
  { op: 'cohorts', venues: V, f: {} },
  { op: 'cohorts', venues: ['hyperliquid'], f: { coin: 'ETH' } },
  { op: 'detail', venues: V, cohort: 'whale', range: '7d', f: {} },
  { op: 'map', venues: V, cohort: null },
  { op: 'focus', venues: V, f: { coin: 'BTC' }, range: '7d' },
  { op: 'excluded' },
] as const;

test('a kept answer is byte for byte what the thread builds now; a new load or a moved load time is read again', async () => {
  const C = await import('../src/indexer/cohortThread.js');
  const R = await import('../src/indexer/read.js');
  C.clearKeptAnswers();
  for (const job of JOBS) {
    const first = await C.cohortAnswer(job as never);
    assert.equal(first.memo, 'miss', job.op);
    assert.ok(first.json, job.op);
    assert.equal(await C.runCohortJob(job as never), first.json, `${job.op}: the build`);
    const again = await C.cohortAnswer(job as never);
    assert.equal(again.memo, 'hit', job.op);
    assert.equal(again.json, first.json, job.op);
    // What every request did before: built on the thread, here and now. The same text.
    assert.equal(await C.runCohortJob(job as never), again.json, `${job.op}: kept = built now`);
  }
  // Not kept: a cohort's wallets read their win rates from the file's live rows.
  const wallets = await C.cohortAnswer({ op: 'wallets', venues: V, cohort: 'whale', f: {}, o: { sort: 'equity', dir: 'desc', offset: 0, limit: 20, range: '30d' } } as never);
  assert.equal(wallets.memo, 'off');

  // A new load swapped in: read again, and the new text is the thread's.
  const job = JOBS[0];
  const was = (await C.cohortAnswer(job as never)).json!;
  await new Promise((r) => setTimeout(r, 5));
  await R._cohortLoad.rebuild();
  const fresh = await C.cohortAnswer(job as never);
  assert.equal(fresh.memo, 'miss', 'a new load');
  assert.notEqual(fresh.json, was, 'its asOf moved');
  assert.equal(await C.runCohortJob(job as never), fresh.json);
  assert.equal((await C.cohortAnswer(job as never)).memo, 'hit');

  // The load's time moved (the tests' clock): not handed out.
  R._cohortLoad.age(1_000);
  assert.notEqual((await C.cohortAnswer(job as never)).memo, 'hit');
});

test('an answer stands until the load\'s minute, the series\' minute and the OI check\'s 30 s, whichever is first', async () => {
  const C = await import('../src/indexer/cohortThread.js');
  const R = await import('../src/indexer/read.js');
  for (const job of JOBS) {
    const now = Date.now();
    const a = await C.runCohortJobKept(job as never);
    assert.ok(a.until > now, `${job.op}: kept for a while`);
    assert.ok(a.until <= now + 60_000 + 5, `${job.op}: at most a minute`);
    assert.ok(a.from, job.op);
  }
  const at = JSON.parse((await C.runCohortJob(JOBS[0] as never))!).asOf as number;
  const a = await C.runCohortJobKept(JOBS[0] as never);
  assert.ok(a.until <= at + R.LOAD_TTL_MS, 'within the load\'s own minute');
  const w = await C.runCohortJobKept({ op: 'wallets', venues: V, cohort: 'whale', f: {}, o: { sort: 'equity', dir: 'desc', offset: 0, limit: 5 } } as never);
  assert.equal(w.until, 0);
});

test('the routes send a kept answer trimmed, with the same ETag, a 304 on a match and its parts in Server-Timing', async () => {
  const C = await import('../src/indexer/cohortThread.js');
  const { valuedeskRoutes } = await import('../src/routes/valuedesk.js');
  C.clearKeptAnswers();
  const app = Fastify();
  await app.register(perfPlugin);
  await app.register(valuedeskRoutes);
  await app.ready();
  try {
    const url = '/api/vs/cohorts/map?venues=sodex,hyperliquid';
    const one = await app.inject({ method: 'GET', url });
    const two = await app.inject({ method: 'GET', url });
    const built = await C.runCohortJob({ op: 'map', venues: V, cohort: null });
    assert.equal(one.statusCode, 200);
    assert.equal(one.body, omitNullLabels(built!), 'the thread\'s text, trimmed');
    assert.equal(two.body, one.body);
    assert.equal(two.headers.etag, one.headers.etag);
    assert.equal(two.headers.etag, weakEtag(Buffer.from(omitNullLabels(built!))));
    assert.match(String(one.headers['server-timing']), /memo;desc=miss/);
    assert.match(String(two.headers['server-timing']), /memo;desc=hit/);
    assert.match(String(two.headers['server-timing']), /thr;dur=0[,]/);
    assert.match(String(two.headers['server-timing']), /tot;dur=[\d.]+$/);
    const br = await app.inject({ method: 'GET', url, headers: { 'accept-encoding': 'br' } });
    assert.equal(brotliDecompressSync(br.rawPayload).toString('utf8'), one.body);
    const not = await app.inject({ method: 'GET', url, headers: { 'if-none-match': String(one.headers.etag) } });
    assert.equal(not.statusCode, 304);
    // The cohorts page itself, with its label trim (a cohort answer names no one, but the rule is the route's).
    const coh = await app.inject({ method: 'GET', url: '/api/vs/cohorts?venues=sodex,hyperliquid' });
    assert.equal(coh.body, omitNullLabels((await C.runCohortJob({ op: 'cohorts', venues: V, f: {} }))!));
  } finally {
    await app.close();
  }
});

test('on the thread: kept after the thread says what it reads from, and the same text as its build', async () => {
  const C = await import('../src/indexer/cohortThread.js');
  process.env.VALUESCAN_COHORT_THREAD = '1';
  try {
    const job = { op: 'map', venues: V, cohort: null } as const;
    let first = await C.cohortAnswer(job as never);
    // The thread's first load posts what it reads from; the first answer may come before this thread has heard it.
    for (let i = 0; i < 20 && (await C.cohortAnswer(job as never)).memo !== 'hit'; i++) await new Promise((r) => setTimeout(r, 50));
    const kept = await C.cohortAnswer(job as never);
    assert.equal(kept.memo, 'hit');
    first = await C.cohortAnswer(job as never);
    assert.equal(first.json, kept.json);
    const state = C.cohortThreadState();
    assert.ok(state.kept_hits! >= 2 && state.waiting === 0, JSON.stringify(state));
  } finally {
    delete process.env.VALUESCAN_COHORT_THREAD;
    await C.stopCohortThread();
  }
});

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

test('benchmark: a cohort request before (a build per request) and kept', async (t) => {
  const C = await import('../src/indexer/cohortThread.js');
  C.clearKeptAnswers();
  for (const job of [JOBS[0], JOBS[3], JOBS[4]]) {
    const before: number[] = [];
    const kept: number[] = [];
    await C.cohortAnswer(job as never);
    let size = 0;
    for (let i = 0; i < 30; i++) {
      let t0 = performance.now();
      const built = await C.runCohortJob(job as never);
      before.push(performance.now() - t0);
      size = built!.length;
      t0 = performance.now();
      const a = await C.cohortAnswer(job as never);
      a.body?.();
      kept.push(performance.now() - t0);
      assert.equal(a.memo, 'hit');
    }
    const line = `${job.op} ${JSON.stringify(job.venues ?? [])} (${(size / 1024).toFixed(0)} KB): build per request ${median(before).toFixed(2)} ms median (inline, no thread hop), kept ${median(kept).toFixed(3)} ms median`;
    t.diagnostic(line);
    console.log(line);
  }
  // On the thread: the round trip a request made before, against a kept answer.
  process.env.VALUESCAN_COHORT_THREAD = '1';
  try {
    const job = JOBS[0];
    for (let i = 0; i < 40 && (await C.cohortAnswer(job as never)).memo !== 'hit'; i++) await new Promise((r) => setTimeout(r, 50));
    const trip: number[] = [];
    const kept: number[] = [];
    for (let i = 0; i < 20; i++) {
      C.clearKeptAnswers();
      let t0 = performance.now();
      await C.cohortAnswer(job as never);
      trip.push(performance.now() - t0);
      t0 = performance.now();
      const a = await C.cohortAnswer(job as never);
      kept.push(performance.now() - t0);
      assert.equal(a.memo, 'hit');
    }
    const line = `cohorts on the thread: a request before ${median(trip).toFixed(2)} ms median (job + hop, an idle thread), kept ${median(kept).toFixed(3)} ms median`;
    t.diagnostic(line);
    console.log(line);
  } finally {
    delete process.env.VALUESCAN_COHORT_THREAD;
    await C.stopCohortThread();
  }
});

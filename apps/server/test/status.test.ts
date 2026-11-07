/**
 * The status page's prober, record and route (ops/status.ts, routes/status.ts):
 * what each probe calls up, degraded or down, that a minute is counted once and
 * a gap stays a gap, how long anything is kept, and the cached public answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import Fastify from 'fastify';

import { StatusStore, probeAll, probeTargetsFromEnv, proberEnabled, startStatusProber, STATUS_KEEP_DAYS, type ProbeTargets } from '../src/ops/status.js';
import { STATUS_DAYS, dayTone, lastDays, minutesExpected, uptimeOf } from '../src/ops/statusModel.js';
import { statusRoutes, STATUS_CACHE_MS } from '../src/routes/status.js';
import { CACHE_POLICIES, perfPlugin } from '../src/perf.js';
import { FAIL_MIN, IndexerJudge, LAG_LIMIT_MS, LAG_MINUTES, LAG_OF, LANE_STALL_MS } from '../src/ops/indexerJudge.js';
import { tempDir } from './builderFakes.js';

const DIR = tempDir('vs-status-');
let caseNo = 0;
const store = () => new StatusStore(join(DIR, `status-${caseNo++}.db`));
const T0 = Date.UTC(2026, 9, 27, 12, 0, 0);
const MIN = 60_000;
const DAY = 86_400_000;
const TARGETS: ProbeTargets = { site: 'https://site.test', executor: 'https://site.test', executorSecret: null };

type Answer = { status: number; body: string; type?: string } | 'fail';
function fakeFetch(answers: Record<string, Answer>, seen: Array<{ url: string; headers: Record<string, string> }> = []) {
  return (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
    const a = answers[url];
    if (!a || a === 'fail') throw new Error('ECONNREFUSED');
    return new Response(a.body, { status: a.status, headers: { 'content-type': a.type ?? 'application/json' } });
  }) as unknown as typeof fetch;
}
const ALL_UP: Record<string, Answer> = {
  'https://site.test/': { status: 200, body: '<!doctype html><div id="root"></div>', type: 'text/html; charset=utf-8' },
  'https://site.test/api/health': { status: 200, body: '{"ok":true}' },
  'https://site.test/api/copy/v1/health': { status: 200, body: '{"ok":true,"db":true,"feeds":{"sodex":true}}' },
};
const indexer = (at: number, streams: Record<string, boolean> = { sodex: true, hyperliquid: true }) => () => ({ at, sockets: streams });

test('probes: up, degraded and down for each service', async () => {
  const up = await probeAll({ targets: TARGETS, fetch: fakeFetch(ALL_UP), indexerStatus: indexer(T0 - 20_000), now: () => T0 });
  assert.deepEqual(up.map((s) => `${s.service}:${s.state}`), ['website:up', 'api:up', 'executor:up', 'indexer:up']);
  assert.ok(up.slice(0, 3).every((s) => typeof s.ms === 'number'));

  const mixed = await probeAll({
    targets: TARGETS,
    fetch: fakeFetch({
      'https://site.test/': { status: 200, body: '{}', type: 'application/json' },
      'https://site.test/api/health': { status: 502, body: '{"error":"bad gateway"}' },
      'https://site.test/api/copy/v1/health': { status: 200, body: '{"ok":false,"db":true,"feeds":{"sodex":false}}' },
    }),
    indexerStatus: indexer(T0 - 20_000, { sodex: true, hyperliquid: false }),
    now: () => T0,
    recheckMs: 0,
    indexerRecheckMs: 0,
  });
  assert.deepEqual(mixed.map((s) => `${s.service}:${s.state}`), ['website:down', 'api:down', 'executor:degraded', 'indexer:degraded']);

  const down = await probeAll({ targets: TARGETS, fetch: fakeFetch({}), indexerStatus: () => { throw new Error('no index'); }, now: () => T0 });
  assert.deepEqual(down.map((s) => `${s.service}:${s.state}`), ['website:down', 'api:down', 'executor:down', 'indexer:down']);
  const stale = await probeAll({ targets: TARGETS, fetch: fakeFetch(ALL_UP), indexerStatus: indexer(T0 - 10 * MIN), now: () => T0 });
  assert.equal(stale[3]!.state, 'down', 'an indexer that stopped publishing is down');
});

test('probes: no answer is asked once more before it counts; a bad answer is not', async () => {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  let drops = 1;
  const flaky = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: {} });
    if (url.endsWith('/api/copy/v1/health') && drops-- > 0) throw new Error('ECONNRESET');
    return fakeFetch(ALL_UP)(url, init);
  }) as unknown as typeof fetch;
  const r = await probeAll({ targets: TARGETS, fetch: flaky, retryMs: 0 });
  assert.equal(r.find((s) => s.service === 'executor')!.state, 'up', 'one dropped connection is not a down minute');
  assert.equal(seen.filter((s) => s.url.endsWith('/api/copy/v1/health')).length, 2);
  const bad: Array<{ url: string; headers: Record<string, string> }> = [];
  await probeAll({ targets: TARGETS, retryMs: 0, fetch: fakeFetch({ ...ALL_UP, 'https://site.test/api/health': { status: 502, body: '{}' } }, bad) });
  assert.equal(bad.filter((s) => s.url.endsWith('/api/health')).length, 1, 'a 502 is an answer: not asked again');
  const down = await probeAll({ targets: TARGETS, retryMs: 0, fetch: fakeFetch({}) });
  assert.equal(down.find((s) => s.service === 'executor')!.state, 'down', 'twice no answer: down');
});

test('probes: boards over an hour old are degraded, even with every stream up; a start with no build yet is not', async () => {
  const stateOf = async (lastBuildAt: number) => (await probeAll({ targets: TARGETS, fetch: fakeFetch(ALL_UP), now: () => T0, indexerRecheckMs: 0, indexerStatus: () => ({ at: T0 - 20_000, sockets: { sodex: true }, lastBuildAt }) })).find((s) => s.service === 'indexer')!.state;
  assert.equal(await stateOf(T0 - 10 * MIN), 'up');
  assert.equal(await stateOf(T0 - 61 * MIN), 'degraded');
  assert.equal(await stateOf(0), 'up');
});

test('probes: a process with no build yet is judged by when the boards were written, not called up for hours', async () => {
  const stateOf = async (boardsAt: number) => (await probeAll({ targets: TARGETS, fetch: fakeFetch(ALL_UP), now: () => T0, indexerRecheckMs: 0, indexerStatus: () => ({
    at: T0 - 5_000, streams: { sodex: 1, hyperliquid: 1 }, lastBuildAt: 0, boardsAt,
  }) })).find((s) => s.service === 'indexer')!.state;
  assert.equal(await stateOf(T0 - 10 * MIN), 'up');
  assert.equal(await stateOf(T0 - 61 * MIN), 'degraded');
});

test('probes: an indexer stream back by the next status is up; down in both is degraded; a stale status is down at once', async () => {
  const healthy = { sodex: true, hyperliquid: true };
  const sequence = (...streams: Array<Record<string, boolean>>) => {
    let n = 0;
    return () => {
      n++;
      return indexer(T0 - 20_000, streams[Math.min(n, streams.length) - 1]!)();
    };
  };
  const stateOf = async (status: () => unknown) => (await probeAll({ targets: TARGETS, fetch: fakeFetch(ALL_UP), indexerStatus: status, now: () => T0, indexerRecheckMs: 0 })).find((s) => s.service === 'indexer')!.state;
  assert.equal(await stateOf(sequence({ sodex: false, hyperliquid: true }, healthy)), 'up', 'a reconnect');
  assert.equal(await stateOf(sequence({ sodex: false, hyperliquid: true }, { sodex: false, hyperliquid: true })), 'degraded', 'still down');
  let reads = 0;
  const stale = indexer(T0 - 10 * MIN);
  assert.equal(await stateOf(() => { reads++; return stale(); }), 'down');
  assert.equal(reads, 1, 'not asked again');
});

/** One indexer status a minute from T0: lanes as given, every stream up, the boards fresh. */
type LaneNow = { queued: number; done: number; failed?: number };
async function indexerRounds(rounds: Array<{ lanes?: Record<string, LaneNow>; lag?: number }>, judge = new IndexerJudge()) {
  const out: Array<{ state: string; why: string[] }> = [];
  for (const [i, r] of rounds.entries()) {
    const t = T0 + i * MIN;
    const s = (await probeAll({
      targets: TARGETS, fetch: fakeFetch(ALL_UP), now: () => t, indexerRecheckMs: 0, indexerJudge: judge,
      indexerStatus: () => ({ at: t - 5_000, sockets: { sodex: 1, hyperliquid: 1 }, lastBuildAt: t - 5 * MIN, lanes: r.lanes ?? {}, loopLagMs: { lastMinute: r.lag ?? 300, sinceStart: 40_000 } }),
    })).find((x) => x.service === 'indexer')!;
    out.push({ state: s.state, why: s.why ?? [] });
  }
  return out;
}
const minutesOf = <T>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i));

test('probes: a lane with work that finishes none for its limit is degraded; a long queue that moves is not', async () => {
  const limit = LANE_STALL_MS.sdata! / MIN;
  // sdata keeps thousands queued at its pace (production 2026-11-07: 3,142 queued, ~12 done a minute).
  const moving = await indexerRounds(minutesOf(limit + 10, (i) => ({ lanes: { sdata: { queued: 5_000 - i, done: 13_000 + 12 * i } } })));
  assert.ok(moving.every((r) => r.state === 'up'), 'a long queue that moves is up');
  // Even slowly: one read in the window is progress.
  const slow = await indexerRounds(minutesOf(limit + 10, (i) => ({ lanes: { sdata: { queued: 5_000, done: 100 + Math.floor(i / (limit - 1)) } } })));
  assert.ok(slow.every((r) => r.state === 'up'), 'one read a window is still progress');
  // 2026-11-06 14:44: the gateway lane froze with work queued.
  const frozen = await indexerRounds(minutesOf(limit + 3, () => ({ lanes: { sdata: { queued: 5_683, done: 200 } } })));
  assert.deepEqual(frozen.slice(0, limit).map((r) => r.state), Array(limit).fill('up'), 'not before its limit');
  assert.equal(frozen[limit]!.state, 'degraded');
  assert.deepEqual(frozen[limit]!.why, ['lane:sdata']);
  // An empty lane does nothing and is fine.
  const idle = await indexerRounds(minutesOf(limit + 5, () => ({ lanes: { strades: { queued: 0, done: 0 } } })));
  assert.ok(idle.every((r) => r.state === 'up'));
  // sgw waits out a rate limit 15 minutes by design: not degraded at 16.
  const pause = await indexerRounds(minutesOf(17, () => ({ lanes: { sgw: { queued: 170, done: 3_000 } } })));
  assert.ok(pause.every((r) => r.state === 'up'), 'a rate-limit pause is not a stall');
});

test('probes: an indexer restart (counts from zero) and a hole in the readings start the window again', async () => {
  const limit = LANE_STALL_MS.hl! / MIN;
  const judge = new IndexerJudge();
  // Frozen at 900 until just before the limit, then a restart: frozen again at 0.
  const rounds = [...minutesOf(limit - 1, () => ({ lanes: { hl: { queued: 2_500, done: 900 } } })), ...minutesOf(limit + 1, () => ({ lanes: { hl: { queued: 2_500, done: 0 } } }))];
  const r = await indexerRounds(rounds, judge);
  assert.ok(r.slice(0, -1).every((x) => x.state === 'up'), 'the restart is not counted as a stall of the old process');
  assert.equal(r.at(-1)!.state, 'degraded', 'the new process frozen for the whole limit is');
  // A fresh judge (the prober restarted) has no readings to claim anything from.
  const one = await indexerRounds([{ lanes: { hl: { queued: 2_500, done: 0 } } }]);
  assert.equal(one[0]!.state, 'up');
});

test('probes: reads failing and the thread far behind are degraded; a pause or a few failures are not', async () => {
  const fails = await indexerRounds(minutesOf(8, (i) => ({ lanes: { hl: { queued: 2_500, done: 100 + i, failed: 2 * i } } })));
  assert.equal(fails[4]!.state, 'up', '8 failures are under the limit');
  assert.equal(fails[5]!.state, 'degraded', `${FAIL_MIN} failed against 5 done`);
  assert.deepEqual(fails[5]!.why, ['fail:hl']);
  const mostlyOk = await indexerRounds(minutesOf(8, (i) => ({ lanes: { hl: { queued: 2_500, done: 100 + 40 * i, failed: 2 * i } } })));
  assert.ok(mostlyOk.every((r) => r.state === 'up'), 'failures while most reads succeed');
  // 5 s is an ordinary minute (2026-11-07 10:40); a single long stall is not enough.
  const lags = [5_000, LAG_LIMIT_MS, 3_000, LAG_LIMIT_MS + 5_000, 4_000, 20_000, 30_000, 2_000, 16_000];
  const r = await indexerRounds(lags.map((lag) => ({ lag })));
  assert.deepEqual(r.map((x) => x.state), [...Array(8).fill('up'), 'degraded'], `${LAG_MINUTES} minutes of ${LAG_OF} over ${LAG_LIMIT_MS} ms`);
  assert.deepEqual(r.at(-1)!.why, ['lag']);
});

test('probes: what is behind comes with the sample, the boards and streams included', async () => {
  const s = (await probeAll({ targets: TARGETS, fetch: fakeFetch(ALL_UP), now: () => T0, indexerRecheckMs: 0, indexerStatus: () => ({ at: T0 - 5_000, sockets: { sodex: null, hyperliquid: 1 }, lastBuildAt: T0 - 2 * 3_600_000 }) })).find((x) => x.service === 'indexer')!;
  assert.equal(s.state, 'degraded');
  assert.deepEqual(s.why, ['stream:sodex', 'boards']);
  const up = (await probeAll({ targets: TARGETS, fetch: fakeFetch(ALL_UP), now: () => T0, indexerStatus: indexer(T0 - 5_000) })).find((x) => x.service === 'indexer')!;
  assert.equal(up.why, undefined);
});

test('probes: an indexer not publishing with boards under an hour old is degraded, not down; stopping on purpose is said', async () => {
  const stateOf = async (status: Record<string, unknown>) => (await probeAll({ targets: TARGETS, fetch: fakeFetch(ALL_UP), now: () => T0, indexerRecheckMs: 0, indexerStatus: () => status })).find((x) => x.service === 'indexer')!;
  const base = { at: T0 - 5 * MIN, sockets: { sodex: 1 } };
  const paused = await stateOf({ ...base, lastBuildAt: T0 - 50 * MIN, boardsAt: T0 - 8 * MIN });
  assert.deepEqual([paused.state, paused.why], ['degraded', ['paused']]);
  assert.equal((await stateOf({ ...base, lastBuildAt: T0 - 61 * MIN, boardsAt: T0 - 61 * MIN })).state, 'down', 'boards over an hour old');
  assert.equal((await stateOf({ ...base, lastBuildAt: 0 })).state, 'down', 'no boards');
  const stopping = await stateOf({ ...base, stopping: true });
  assert.deepEqual([stopping.state, stopping.why], ['degraded', ['stopping']]);
  assert.equal((await stateOf({ ...base, at: T0 - 30 * MIN, stopping: true })).state, 'down', 'a stop that never ended is not maintenance');
});

test('probes: a feed reconnecting is asked again; still not ok is degraded', async () => {
  const HEALTH = 'https://site.test/api/copy/v1/health';
  let notOk = 1;
  const reconnecting = (async (url: string, init: RequestInit) => {
    if (url === HEALTH && notOk-- > 0) return new Response('{"ok":false,"feeds":{"sodex":false}}', { status: 200 });
    return fakeFetch(ALL_UP)(url, init);
  }) as unknown as typeof fetch;
  const back = await probeAll({ targets: TARGETS, fetch: reconnecting, retryMs: 0, recheckMs: 0 });
  assert.equal(back.find((s) => s.service === 'executor')!.state, 'up');
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const still = await probeAll({ targets: TARGETS, retryMs: 0, recheckMs: 0, fetch: fakeFetch({ ...ALL_UP, [HEALTH]: { status: 200, body: '{"ok":false}' } }, seen) });
  assert.equal(still.find((s) => s.service === 'executor')!.state, 'degraded');
  assert.equal(seen.filter((s) => s.url === HEALTH).length, 2, 'asked exactly twice');
});

test('probes: the visitor way failing with the executor answering is degraded, not down', async () => {
  const DIRECT = 'https://executor.test/api/copy/v1/health';
  const targets: ProbeTargets = { ...TARGETS, executorDirect: 'https://executor.test', directSecret: 'the-secret' };
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const run = (answers: Record<string, Answer>) => probeAll({ targets, retryMs: 0, recheckMs: 0, fetch: fakeFetch(answers, seen) }).then((r) => r.find((s) => s.service === 'executor')!.state);
  const { 'https://site.test/api/copy/v1/health': _way, ...noWay } = ALL_UP;

  assert.equal(await run({ ...noWay, [DIRECT]: { status: 200, body: '{"ok":true}' } }), 'degraded', 'no answer on the way, the executor fine');
  assert.equal(seen.find((s) => s.url === DIRECT)?.headers['X-Origin-Verify'], 'the-secret');
  assert.equal(seen.find((s) => s.url.startsWith('https://site.test'))?.headers['X-Origin-Verify'], undefined, 'the public site never gets it');
  assert.equal(await run({ ...noWay, 'https://site.test/api/copy/v1/health': { status: 504, body: 'gateway timeout' }, [DIRECT]: { status: 200, body: '{"ok":true}' } }), 'degraded', 'a 504 on the way, the executor fine');
  assert.equal(await run({ ...noWay, [DIRECT]: { status: 403, body: 'forbidden' } }), 'down', 'a refusal says nothing about its health');
  assert.equal(await run(noWay), 'down', 'no answer anywhere');

  seen.length = 0;
  assert.equal(await run(ALL_UP), 'up');
  assert.equal(seen.some((s) => s.url === DIRECT), false, 'a good answer asks nothing more');

  assert.deepEqual(
    probeTargetsFromEnv({ VALUESCAN_STATUS_EXECUTOR_DIRECT_URL: 'https://executor.test/', VALUESCAN_ORIGIN_SECRET: 'current-secret,next-secret' }),
    { site: 'https://www.valuedesk.so', executor: 'https://www.valuedesk.so', executorSecret: null, executorDirect: 'https://executor.test', directSecret: 'current-secret' },
  );
});

test('probes: the executor directly gets the origin secret, the public site never does', async () => {
  // The health check's EXECUTOR_URL (loopback on the executor's own box) is not this probe's.
  assert.deepEqual(probeTargetsFromEnv({ EXECUTOR_URL: 'http://127.0.0.1:8799' }), { site: 'https://www.valuedesk.so', executor: 'https://www.valuedesk.so', executorSecret: null });
  const t = probeTargetsFromEnv({ VALUESCAN_STATUS_EXECUTOR_URL: 'https://13-140-77-201.sslip.io/', VALUESCAN_ORIGIN_SECRET: 'current-secret,next-secret' });
  assert.deepEqual(t, { site: 'https://www.valuedesk.so', executor: 'https://13-140-77-201.sslip.io', executorSecret: 'current-secret' });
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  await probeAll({ targets: t, fetch: fakeFetch({}, seen) });
  for (const s of seen) {
    const secret = s.headers['X-Origin-Verify'];
    assert.equal(secret, s.url.startsWith('https://13-140-77-201.sslip.io') ? 'current-secret' : undefined, s.url);
  }
});

test('record: a minute counts once, a day adds up, a gap is no data', () => {
  const s = store();
  s.record([{ service: 'website', state: 'up', ms: 80 }], T0);
  s.record([{ service: 'website', state: 'down', ms: null }], T0 + 10_000); // same minute: ignored
  s.record([{ service: 'website', state: 'down', ms: null }], T0 + MIN);
  s.record([{ service: 'website', state: 'degraded', ms: 900 }], T0 + 2 * MIN);
  const r = s.report(T0 + 2 * MIN + 5_000);
  const web = r.services.find((x) => x.id === 'website')!;
  assert.equal(web.days.length, STATUS_DAYS);
  assert.deepEqual(web.days.at(-1), ['2026-10-27', 1, 1, 1]);
  assert.deepEqual(web.days.at(-2), ['2026-10-26', 0, 0, 0]);
  assert.equal(web.state, 'degraded');
  assert.equal(web.latencyMs, 900);
  assert.equal(web.uptime, 66.667);
  assert.equal(dayTone(web.days.at(-2)!), 'nodata');
  // No service ever probed: unknown, every day no data.
  const exec = r.services.find((x) => x.id === 'executor')!;
  assert.equal(exec.state, 'unknown');
  assert.equal(exec.uptime, null);
  assert.ok(exec.days.every((d) => dayTone(d) === 'nodata'));
  // The prober stopped: the last state is not claimed any more.
  assert.equal(s.report(T0 + 30 * MIN).services[0]!.state, 'unknown');
  s.close();
});

test('record: everything is kept unless the owner allows pruning; then samples two days, tallies STATUS_KEEP_DAYS', () => {
  const fill = (s: StatusStore) => {
    s.record([{ service: 'api', state: 'up', ms: 10 }], T0 - (STATUS_KEEP_DAYS + 5) * DAY);
    s.record([{ service: 'api', state: 'up', ms: 10 }], T0 - 3 * DAY);
    s.record([{ service: 'api', state: 'up', ms: 10 }], T0);
    return (s as unknown as { db: { prepare: (q: string) => { get: () => { n: number } } } }).db;
  };
  const kept = store();
  const k = fill(kept);
  assert.equal(k.prepare('SELECT COUNT(*) AS n FROM samples').get().n, 3);
  assert.equal(k.prepare('SELECT COUNT(*) AS n FROM days').get().n, 3);
  kept.close();
  process.env.VALUESCAN_PRUNE = 'status';
  try {
    const s = store();
    const db = fill(s);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM samples').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM days').get().n, 2);
    s.close();
  } finally {
    delete process.env.VALUESCAN_PRUNE;
  }
});

test('model: the day tone, the days, the expected minutes', () => {
  assert.equal(dayTone(['d', 1440, 0, 0]), 'up');
  assert.equal(dayTone(['d', 1400, 40, 0]), 'degraded');
  assert.equal(dayTone(['d', 1430, 0, 10]), 'partial');
  assert.equal(dayTone(['d', 1000, 0, 440]), 'down');
  assert.equal(dayTone(['d', 0, 0, 0]), 'nodata');
  const days = lastDays(T0, 3);
  assert.deepEqual(days, ['2026-10-25', '2026-10-26', '2026-10-27']);
  assert.equal(minutesExpected('2026-10-26', T0), 1440);
  assert.equal(minutesExpected('2026-10-27', T0), 720);
  assert.equal(uptimeOf([['a', 999, 0, 1]]), 99.9);
});

test('prober: on for a hosted server unless switched off, off locally unless switched on', async () => {
  assert.equal(proberEnabled({}, true), true);
  assert.equal(proberEnabled({ VALUESCAN_STATUS_PROBE: '0' }, true), false);
  assert.equal(proberEnabled({}, false), false);
  assert.equal(proberEnabled({ VALUESCAN_STATUS_PROBE: '1' }, false), true);
  const s = store();
  const p = startStatusProber({ store: s, targets: TARGETS, fetch: fakeFetch(ALL_UP), indexerStatus: indexer(Date.now()), firstAfterMs: 60_000, everyMs: 60_000 });
  await p.tick();
  p.stop();
  assert.deepEqual(s.report().services.map((x) => x.state), ['up', 'up', 'up', 'up']);
  s.close();
});

test('route: public, cached 30 s in the process and at the edge', async () => {
  const s = store();
  let t = T0;
  const app = Fastify();
  await app.register(perfPlugin);
  await app.register(statusRoutes, { store: s, now: () => t });
  await app.ready();
  s.record([{ service: 'website', state: 'up', ms: 50 }], T0);
  const a = await app.inject({ method: 'GET', url: '/api/vs/status' });
  assert.equal(a.statusCode, 200);
  assert.equal(a.headers['cache-control'], CACHE_POLICIES['/api/vs/status']!.cacheControl);
  assert.match(String(a.headers['cache-control']), /public, max-age=30/);
  const body = a.json() as { ok: boolean; services: Array<{ id: string; state: string }> };
  assert.equal(body.ok, true);
  assert.deepEqual(body.services.map((x) => x.id), ['website', 'api', 'executor', 'indexer']);
  // A new sample within the cache window is not read yet; after it, it is.
  s.record([{ service: 'api', state: 'down', ms: null }], T0 + 5_000);
  t += 10_000;
  assert.equal(((await app.inject({ method: 'GET', url: '/api/vs/status' })).json() as typeof body).services[1]!.state, 'unknown');
  t += STATUS_CACHE_MS;
  assert.equal(((await app.inject({ method: 'GET', url: '/api/vs/status' })).json() as typeof body).services[1]!.state, 'down');
  await app.close();
  s.close();
});

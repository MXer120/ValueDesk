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
  });
  assert.deepEqual(mixed.map((s) => `${s.service}:${s.state}`), ['website:down', 'api:down', 'executor:degraded', 'indexer:degraded']);

  const down = await probeAll({ targets: TARGETS, fetch: fakeFetch({}), indexerStatus: () => { throw new Error('no index'); }, now: () => T0 });
  assert.deepEqual(down.map((s) => `${s.service}:${s.state}`), ['website:down', 'api:down', 'executor:down', 'indexer:down']);
  const stale = await probeAll({ targets: TARGETS, fetch: fakeFetch(ALL_UP), indexerStatus: indexer(T0 - 10 * MIN), now: () => T0 });
  assert.equal(stale[3]!.state, 'down', 'an indexer that stopped publishing is down');
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

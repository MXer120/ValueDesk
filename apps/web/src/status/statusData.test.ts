/**
 * The status page's data (statusData.ts) and route (router.ts): the server's
 * report when it answers, the browser's own check of the executor when it does
 * not, the headline, and what a day bar says.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStatusPath, legalForPath, tabForPath } from '../router';
import { checkExecutor, dayBar, fmtUptime, loadStatus, overallOf } from './statusData';

const T0 = Date.UTC(2026, 9, 27, 12, 0, 0);

const respond = (map: Record<string, { status: number; body: unknown } | 'fail'>, seen: string[] = []) =>
  (async (url: string) => {
    seen.push(url);
    const a = map[url];
    if (!a || a === 'fail') throw new TypeError('Failed to fetch');
    return new Response(typeof a.body === 'string' ? a.body : JSON.stringify(a.body), { status: a.status });
  }) as unknown as typeof fetch;

const REPORT = {
  ok: true,
  at: T0,
  probeEveryS: 60,
  services: [{ id: 'website', name: 'Website', state: 'up', checkedAt: T0, latencyMs: 80, uptime: 100, days: [['2026-10-27', 720, 0, 0]] }],
};

test('/status is a page of its own: not a tab, not a legal page', () => {
  assert.equal(isStatusPath('/status'), true);
  assert.equal(isStatusPath('/Status/'), true);
  assert.equal(isStatusPath('/statuses'), false);
  assert.equal(isStatusPath('/'), false);
  assert.equal(tabForPath('/status'), null);
  assert.equal(legalForPath('/status'), null);
});

test('the report, when the status service answers - and nothing else is asked', async () => {
  const seen: string[] = [];
  const v = await loadStatus(respond({ '/api/vs/status': { status: 200, body: REPORT } }, seen));
  assert.equal(v.kind, 'report');
  assert.deepEqual(seen, ['/api/vs/status']);
});

test('unreachable: the page says so and asks the executor itself', async () => {
  const seen: string[] = [];
  const up = await loadStatus(respond({ '/api/vs/status': { status: 502, body: '<html>' }, '/api/copy/v1/health': { status: 200, body: { ok: true } } }, seen), () => T0);
  assert.deepEqual(up, { kind: 'unreachable', at: T0, executor: { state: 'up', ms: (up as { executor: { ms: number } }).executor.ms, at: T0 } });
  assert.deepEqual(seen, ['/api/vs/status', '/api/copy/v1/health']);
  const offline = await loadStatus(respond({}));
  assert.equal(offline.kind === 'unreachable' && offline.executor.state, 'down');
  // A 200 that is not a report (a proxy's page) is not taken for one.
  const odd = await loadStatus(respond({ '/api/vs/status': { status: 200, body: { hello: 1 } }, '/api/copy/v1/health': { status: 200, body: { ok: false } } }));
  assert.equal(odd.kind === 'unreachable' && odd.executor.state, 'degraded');
  assert.equal((await checkExecutor(respond({ '/api/copy/v1/health': { status: 503, body: { ok: false } } }))).state, 'down');
});

test('the headline and the bars', () => {
  assert.equal(overallOf(['up', 'up', 'unknown']), 'operational');
  assert.equal(overallOf(['up', 'degraded']), 'degraded');
  assert.equal(overallOf(['degraded', 'down']), 'outage');
  assert.equal(overallOf(['unknown']), 'unknown');
  assert.deepEqual(dayBar(['2026-10-26', 0, 0, 0], T0), { tone: 'nodata', title: '26 Oct 2026 · no data' });
  assert.deepEqual(dayBar(['2026-10-26', 1440, 0, 0], T0), { tone: 'up', title: '26 Oct 2026 · 100% up' });
  assert.equal(dayBar(['2026-10-26', 1380, 0, 60], T0).title, '26 Oct 2026 · 95.83% up · 1 h down');
  // Today: 720 minutes have passed; 600 probed leaves 2 h without data.
  assert.equal(dayBar(['2026-10-27', 590, 10, 0], T0).title, '27 Oct 2026 · 100% up · 10 min degraded · 2 h no data');
  assert.equal(fmtUptime(null), '–');
  assert.equal(fmtUptime(99.98123), '99.981%');
  assert.equal(fmtUptime(100), '100%');
  assert.equal(fmtUptime(97.5), '97.50%');
});

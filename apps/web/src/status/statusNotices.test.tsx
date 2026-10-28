/**
 * The status page's incidents and maintenance on the page (statusData.ts,
 * StatusPage.tsx) and in the app's banner (SiteNoticeBanner.tsx): what a service's
 * pill says, a day bar's tooltip, a notice's card - always as text - and the banner
 * read from /api/health.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { installViteStubs, staticMarkup } from '../components/macro/testEnv';
import { setNumStyle } from '../numStyle';

// These cases read the en-US format (1,234.56); the app's default (1.234,56) is checked separately.
setNumStyle('comma-dot');

installViteStubs();
const { createElement } = await import('react');
const render = await staticMarkup();
const D = await import('./statusData');
const { NoticeCard, DayTip } = await import('./StatusPage');
const { SiteNoticeBanner } = await import('./SiteNoticeBanner');
type Notice = import('./statusData').Notice;

const T0 = Date.UTC(2026, 9, 27, 12, 0, 0);
const MIN = 60_000;
const H = 3_600_000;

const incident = (o: Partial<Notice> = {}): Notice => ({
  id: 7, kind: 'incident', title: 'Copies are late', impact: 'major', components: ['executor'], startsAt: T0 - H, endsAt: null, closedAt: null,
  updates: [{ at: T0 - H, stage: 'investigating', text: 'Looking into it.' }, { at: T0 - 30 * MIN, stage: 'identified', text: 'A feed stalled.' }], ...o,
});
const maint = (o: Partial<Notice> = {}): Notice => ({
  id: 8, kind: 'maintenance', title: 'Database upgrade', impact: null, components: ['api', 'indexer'], startsAt: T0 + H, endsAt: T0 + 2 * H, closedAt: null,
  updates: [{ at: T0 - H, stage: 'scheduled', text: '' }], ...o,
});

test('a service: the probe, made worse by an open incident; maintenance in progress', () => {
  assert.equal(D.shownState('up', 'executor', [incident()], T0), 'partial');
  assert.equal(D.shownState('up', 'executor', [incident({ impact: 'minor' })], T0), 'degraded');
  assert.equal(D.shownState('down', 'executor', [incident({ impact: 'minor' })], T0), 'down', 'never better than the probe');
  assert.equal(D.shownState('up', 'api', [incident()], T0), 'up', 'another service');
  assert.equal(D.shownState('up', 'executor', [incident({ closedAt: T0 - MIN })], T0), 'up', 'resolved');
  assert.equal(D.shownState('down', 'api', [maint()], T0 + 90 * MIN), 'maintenance');
  assert.equal(D.shownState('up', 'api', [maint()], T0), 'up', 'not begun');
  assert.equal(D.overallShown(['up', 'maintenance']), 'maintenance');
  assert.equal(D.overallShown(['partial', 'maintenance']), 'outage');
  assert.equal(D.overallShown(['up', 'unknown']), 'operational');
});

test('loadStatus: notices checked one by one, the rest still shows', async () => {
  const body = {
    ok: true, at: T0, probeEveryS: 60, services: [],
    notices: [incident(), { id: 'x' }, { ...maint(), components: ['nope'] }],
  };
  const f = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  const v = await D.loadStatus(f);
  assert.equal(v.kind, 'report');
  assert.deepEqual(v.kind === 'report' && v.report.notices!.map((n) => n.id), [7]);
});

test('a day bar tells its day: uptime, minutes, and that day\'s incidents and maintenance', () => {
  const d = D.dayDetail(['2026-10-27', 600, 20, 30], 'executor', [incident({ closedAt: T0 - 5 * MIN })], T0);
  assert.equal(d.tone, 'partial');
  assert.equal(d.date, '27 Oct 2026');
  assert.equal(d.uptime, '95.38% up');
  assert.deepEqual(d.facts, ['30 min down', '20 min degraded', '1 h 10 min no data']);
  assert.deepEqual(d.notices, [{ id: 7, label: 'Major incident', title: 'Copies are late', times: '27 Oct 11:00 – 11:55 UTC' }]);
  const m = D.dayDetail(['2026-10-27', 0, 0, 0], 'api', [maint()], T0 + 90 * MIN);
  assert.equal(m.tone, 'maintenance');
  assert.equal(m.uptime, null);
  assert.equal(m.notices[0]!.times, '27 Oct 13:00 – 14:00 UTC');

  const html = render(createElement(DayTip, { d, index: 89, count: 90 }));
  assert.match(html, /role="tooltip"/);
  assert.match(html, /class="st-tip is-end"/);
  assert.match(html, /<b>27 Oct 2026<\/b><span>95\.38% up · 30 min down · 20 min degraded · 1 h 10 min no data<\/span>/);
  assert.match(html, /Major incident: Copies are late<small>27 Oct 11:00 – 11:55 UTC<\/small>/);
  assert.match(render(createElement(DayTip, { d: m, index: 0, count: 90 })), /No data/);
});

test('a notice card: title, impact, components, times and the timeline newest first - as text', () => {
  const evil = incident({ title: '<img src=x onerror=alert(1)>', updates: [{ at: T0 - H, stage: 'investigating', text: '<script>alert(1)</script>\nline two' }] });
  const html = render(createElement(NoticeCard, { n: evil, now: T0, open: true }));
  assert.ok(!html.includes('<img'), 'no markup from the owner\'s text');
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /id="notice-7"/);
  assert.match(html, /Major incident/);
  assert.match(html, /Copy &amp; algo executor · since 27 Oct 11:00 UTC/);
  const two = render(createElement(NoticeCard, { n: incident(), now: T0 }));
  assert.ok(two.indexOf('Identified') < two.indexOf('Investigating'), 'newest first');
  const m = render(createElement(NoticeCard, { n: maint(), now: T0 }));
  assert.match(m, /Maintenance/);
  assert.match(m, /Scheduled/);
  assert.match(m, /Data API, Indexer · 27 Oct 13:00 – 14:00 UTC/);
});

test('the app banner: from /api/health, silent without a notice, plain text', () => {
  assert.equal(render(createElement(SiteNoticeBanner, { health: { ok: true } })), '');
  assert.equal(render(createElement(SiteNoticeBanner, { health: null })), '');
  assert.equal(render(createElement(SiteNoticeBanner, { health: { notices: [{ id: 1, kind: 'bogus', title: 'x', phase: 'active', startsAt: T0 }] } })), '');
  const health = {
    notices: [
      { id: 7, kind: 'incident', title: 'Copies are <late>', impact: 'major', phase: 'active', startsAt: T0, endsAt: null },
      { id: 8, kind: 'maintenance', title: 'DB', impact: null, phase: 'upcoming', startsAt: T0 + H, endsAt: T0 + 2 * H },
    ],
  };
  const html = render(createElement(SiteNoticeBanner, { health }));
  assert.match(html, /class="banner warn banner--status"/);
  assert.match(html, /Incident: Copies are &lt;late&gt;/);
  assert.match(html, /\(and 1 more\)/);
  assert.match(html, /href="\/status#notice-7"/);
  assert.equal(D.healthNoticeText({ id: 8, kind: 'maintenance', title: 'DB', impact: null, phase: 'upcoming', startsAt: T0 + H, endsAt: T0 + 2 * H }), 'Scheduled maintenance: DB, 27 Oct 13:00 – 14:00 UTC');
  assert.equal(D.healthNoticeText({ id: 8, kind: 'maintenance', title: 'DB', impact: null, phase: 'in_progress', startsAt: T0, endsAt: T0 + H }), 'Maintenance in progress: DB, until 13:00 UTC');
  assert.equal(D.healthNoticeText({ id: 9, kind: 'incident', title: 'All down', impact: 'critical', phase: 'active', startsAt: T0, endsAt: null }), 'Outage: All down');
  const info = render(createElement(SiteNoticeBanner, { health: { notices: [health.notices[1]] } }));
  assert.match(info, /class="banner info banner--status"/);
  // The data service not answering: the line on its own, to the status page.
  const down = render(createElement(SiteNoticeBanner, { health: null, down: true }));
  assert.match(down, /class="banner warn banner--status"/);
  assert.match(down, /Our data service is not answering/);
  assert.ok(down.includes('href="/status"'), 'to the status page');
});

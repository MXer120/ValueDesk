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
const { NoticeCard, NoticeRow, NoticeLists, DayTip } = await import('./StatusPage');
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
  assert.equal(D.overallShown(['partial', 'maintenance']), 'partial');
  assert.equal(D.overallShown(['partial', 'down']), 'outage');
  assert.equal(D.overallShown(['up', 'unknown']), 'operational');
});

test('the headline icon: a check, a warning for degraded or partly down, an X for down', () => {
  assert.equal(D.heroTone('operational'), 'ok');
  assert.equal(D.heroTone('degraded'), 'warn');
  assert.equal(D.heroTone('partial'), 'warn');
  assert.equal(D.heroTone('outage'), 'down');
  assert.equal(D.heroTone('unreachable'), 'down');
  assert.equal(D.heroTone('maintenance'), 'maintenance');
  assert.equal(D.heroTone('unknown'), 'unknown');
  assert.equal(D.OVERALL_SHOWN_TEXT.partial, 'Partial outage');
});

test('current and past: open and scheduled now, the rest newest first', () => {
  const old = incident({ id: 1, startsAt: T0 - 48 * H, closedAt: T0 - 47 * H });
  const newer = incident({ id: 2, startsAt: T0 - 5 * H, closedAt: T0 - 4 * H });
  const done = maint({ id: 3, startsAt: T0 - 3 * H, endsAt: T0 - 2 * H });
  const { current, past } = D.splitNotices([old, maint(), done, incident(), newer], T0);
  assert.deepEqual(current.map((n) => n.id), [7, 8], 'the open incident, then the maintenance to come');
  assert.deepEqual(past.map((n) => n.id), [3, 2, 1]);
  assert.equal(D.noticeDuration(newer, T0), '1 h');
  assert.equal(D.noticeDuration(incident({ startsAt: T0 - 275 * MIN, closedAt: T0 }), T0), '4 h 35 min');
});

test('a past notice is one slim row: title, kind, start, duration - its timeline only when opened', () => {
  const n = incident({ title: 'Indexer <slow>', closedAt: T0 - 5 * MIN });
  const shut = render(createElement(NoticeRow, { n, now: T0, open: false, onToggle: () => {} }));
  assert.match(shut, /id="notice-7"/);
  assert.match(shut, /aria-expanded="false"/);
  assert.match(shut, /Indexer &lt;slow&gt;/);
  assert.match(shut, /Partial outage/);
  assert.match(shut, /27 Oct 11:00</);
  assert.match(shut, /55 min/);
  assert.ok(!shut.includes('st-timeline'), 'no timeline while shut');
  const open = render(createElement(NoticeRow, { n, now: T0, open: true, onToggle: () => {} }));
  assert.match(open, /aria-expanded="true"/);
  assert.ok(open.indexOf('Identified') < open.indexOf('Investigating'), 'its timeline, newest first');
});

test('the lists: Current by default, Past behind the app switch', () => {
  const past = incident({ id: 1, closedAt: T0 - 5 * MIN });
  const html = render(createElement(NoticeLists, { notices: [past], now: T0 }));
  assert.match(html, /class="lbp-seg" role="tablist"/);
  assert.match(html, /aria-selected="true" class="is-on">Current</);
  assert.match(html, /aria-selected="false" class="">Past</);
  assert.match(html, /No incidents or maintenance right now\./);
  assert.ok(!html.includes('notice-1'), 'past rows only behind the switch');
  const shown = render(createElement(NoticeLists, { notices: [past], now: T0, initialTab: 'past', initialOpen: 1 }));
  assert.match(shown, /class="st-row is-major is-open"/);
  const open = render(createElement(NoticeLists, { notices: [incident()], now: T0 }));
  assert.match(open, /class="st-notice is-major is-open"/);
});

test('past: the newest ten, then a page at a time; a linked notice opens on its page', () => {
  const many = Array.from({ length: 23 }, (_, i) => incident({ id: 100 + i, startsAt: T0 - (i + 2) * 60 * MIN, closedAt: T0 - (i + 1) * 60 * MIN }));
  const first = render(createElement(NoticeLists, { notices: many, now: T0, initialTab: 'past' }));
  assert.equal((first.match(/class="st-row /g) ?? []).length, 10);
  assert.match(first, /1–10 of 23/);
  assert.match(first, /aria-current="page" class="is-on">1</);
  const linked = render(createElement(NoticeLists, { notices: many, now: T0, initialTab: 'past', initialOpen: 121 }));
  assert.match(linked, /21–23 of 23/);
  assert.match(linked, /id="notice-121"/);
  const few = render(createElement(NoticeLists, { notices: many.slice(0, 4), now: T0, initialTab: 'past' }));
  assert.ok(!few.includes('st-pager'), 'no pages for ten or fewer');
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
  assert.deepEqual(d.notices, [{ id: 7, label: 'Partial outage', title: 'Copies are late', times: '27 Oct 11:00 – 11:55 UTC' }]);
  const m = D.dayDetail(['2026-10-27', 0, 0, 0], 'api', [maint()], T0 + 90 * MIN);
  assert.equal(m.tone, 'maintenance');
  assert.equal(m.uptime, null);
  assert.equal(m.notices[0]!.times, '27 Oct 13:00 – 14:00 UTC');

  const html = render(createElement(DayTip, { d, index: 89, count: 90 }));
  assert.match(html, /role="tooltip"/);
  assert.match(html, /class="st-tip is-end"/);
  assert.match(html, /<b>27 Oct 2026<\/b><span>95\.38% up · 30 min down · 20 min degraded · 1 h 10 min no data<\/span>/);
  assert.match(html, /Partial outage: Copies are late<small>27 Oct 11:00 – 11:55 UTC<\/small>/);
  assert.match(render(createElement(DayTip, { d: m, index: 0, count: 90 })), /No data/);
});

test('a day with more than one kind of issue: the longest in full colour, the shorter ones dashed', () => {
  // 60 min maintenance (13:00-14:00) and 12 probed minutes degraded: maintenance full, degraded dashed.
  const done = maint({ closedAt: T0 + 2 * H });
  const d = D.dayDetail(['2026-10-27', 1300, 12, 0], 'api', [done], T0 + 12 * H);
  assert.equal(d.tone, 'maintenance');
  assert.deepEqual(d.extra, [{ tone: 'degraded', minutes: 12 }]);
  assert.ok(d.facts.includes('12 min degraded') && d.facts.includes('1 h maintenance'), 'the tooltip lists each with its duration');
  // Degraded the longer one: it takes the full colour, maintenance goes dashed.
  const e = D.dayDetail(['2026-10-27', 1200, 120, 0], 'api', [done], T0 + 12 * H);
  assert.equal(e.tone, 'degraded');
  assert.deepEqual(e.extra, [{ tone: 'maintenance', minutes: 60 }]);
  // One kind only: no dashes, and the bar's colour is the old rule's.
  const one = D.dayDetail(['2026-10-27', 1300, 12, 0], 'api', [], T0 + 12 * H);
  assert.equal(one.tone, 'degraded');
  assert.deepEqual(one.extra, []);
  const tied = D.dayIssues(['2026-10-27', 1300, 30, 30], [], T0 + 12 * H);
  assert.deepEqual(tied.map((x) => x.tone), ['partial', 'degraded'], 'a tie: the worse one in full colour');
});

test('a notice card: title, impact, components, times and the timeline newest first - as text', () => {
  const evil = incident({ title: '<img src=x onerror=alert(1)>', updates: [{ at: T0 - H, stage: 'investigating', text: '<script>alert(1)</script>\nline two' }] });
  const html = render(createElement(NoticeCard, { n: evil, now: T0, open: true }));
  assert.ok(!html.includes('<img'), 'no markup from the owner\'s text');
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /id="notice-7"/);
  assert.match(html, /Partial outage/);
  assert.match(html, /Copy &amp; algo executor · since 27 Oct 11:00 UTC/);
  const two = render(createElement(NoticeCard, { n: incident(), now: T0 }));
  assert.ok(two.indexOf('Identified') < two.indexOf('Investigating'), 'newest first');
  const m = render(createElement(NoticeCard, { n: maint(), now: T0 }));
  assert.match(m, /Maintenance/);
  assert.match(m, /Scheduled/);
  assert.match(m, /Data API, Indexer · 27 Oct 13:00 – 14:00 UTC/);
});

test('the app banner: scheduled maintenance only, from /api/health, plain text - incidents are notifications (IncidentNote.tsx)', () => {
  assert.equal(render(createElement(SiteNoticeBanner, { health: { ok: true } })), '');
  assert.equal(render(createElement(SiteNoticeBanner, { health: null })), '');
  assert.equal(render(createElement(SiteNoticeBanner, { health: { notices: [{ id: 1, kind: 'bogus', title: 'x', phase: 'active', startsAt: T0 }] } })), '');
  const incident = { id: 7, kind: 'incident', title: 'Copies are <late>', impact: 'major', phase: 'active', startsAt: T0, endsAt: null };
  const upcoming = (id: number, title: string) => ({ id, kind: 'maintenance', title, impact: null, phase: 'upcoming', startsAt: T0 + H, endsAt: T0 + 2 * H });
  assert.equal(render(createElement(SiteNoticeBanner, { health: { notices: [incident] } })), '', 'no bar for an incident (owner, 2026-10-29)');
  const html = render(createElement(SiteNoticeBanner, { health: { notices: [incident, upcoming(8, 'DB <move>'), upcoming(9, 'Cache')] } }));
  assert.match(html, /class="banner info banner--status"/);
  assert.match(html, /Scheduled maintenance: DB &lt;move&gt;/);
  assert.doesNotMatch(html, /Copies are/);
  assert.match(html, /\(and 1 more\)/);
  assert.match(html, /href="\/status#notice-8"/);
  assert.equal(D.healthNoticeText({ id: 8, kind: 'maintenance', title: 'DB', impact: null, phase: 'upcoming', startsAt: T0 + H, endsAt: T0 + 2 * H }), 'Scheduled maintenance: DB, 27 Oct 13:00 – 14:00 UTC');
  assert.equal(D.healthNoticeText({ id: 8, kind: 'maintenance', title: 'DB', impact: null, phase: 'in_progress', startsAt: T0, endsAt: T0 + H }), 'Maintenance in progress: DB, until 13:00 UTC');
  assert.equal(D.healthNoticeText({ id: 9, kind: 'incident', title: 'All down', impact: 'critical', phase: 'active', startsAt: T0, endsAt: null }), 'Outage: All down');
});

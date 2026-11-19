/**
 * The incident notification (incidentState.ts, IncidentNote.tsx): an open incident as a card
 * like the maintenance one, not a bar (owner, 2026-10-29) - amber, red for an outage or the
 * data service not answering; the services, the latest words, since when and the status page
 * on hover; gone when resolved or clicked away, back when it gets worse.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { installViteStubs, staticMarkup } from '../components/macro/testEnv';

installViteStubs();
const { createElement } = await import('react');
const render = await staticMarkup();
const I = await import('./incidentState');
const { IncidentCard } = await import('./IncidentNote');
type HealthNotice = import('./statusData').HealthNotice;

const T0 = Date.UTC(2026, 9, 29, 21, 0, 0);
const incident = (o: Partial<HealthNotice> = {}): HealthNotice => ({
  id: 22, kind: 'incident', title: 'Indexer degraded - a data stream is down', impact: 'minor', phase: 'active',
  startsAt: T0, endsAt: null, components: ['indexer'], ...o,
});
const health = (...notices: unknown[]) => ({ ok: true, notices });

test('from /api/health: open incidents only, worst first', () => {
  const list = I.incidentsShown(health(
    incident(),
    incident({ id: 23, impact: 'critical', title: 'All down' }),
    { id: 24, kind: 'maintenance', title: 'Update v0.2.84', impact: null, phase: 'in_progress', startsAt: T0, endsAt: T0 + 60_000 },
  ), []);
  assert.deepEqual(list.map((n) => n.id), [23, 22]);
  assert.deepEqual(I.incidentsShown(null, []), []);
  assert.deepEqual(I.incidentsShown({ ok: true }, []), []);
});

test('clicked away it stays away; worse, it is back; resolved, its X is forgotten - a failed poll forgets nothing', () => {
  const d = I.dismissIncident([], I.incidentKey(incident()));
  assert.deepEqual(d, ['22:minor']);
  assert.deepEqual(I.incidentsShown(health(incident()), d), []);
  assert.deepEqual(I.incidentsShown(health(incident({ impact: 'major' })), d).map((n) => n.id), [22], 'minor to major is news again');
  assert.equal(I.pruneDismissed(d, null), d, 'no answer: kept');
  assert.equal(I.pruneDismissed(d, health(incident())), d, 'still open: kept');
  assert.deepEqual(I.pruneDismissed(d, health()), [], 'resolved: forgotten');
  assert.deepEqual(I.parseDismissed('["22:minor","x",3,"7:critical"]'), ['22:minor', '7:critical']);
  assert.deepEqual(I.parseDismissed('{not json'), []);
  assert.deepEqual(I.parseDismissed(null), []);
});

test('the card: a notification like the maintenance one, the status page inside it', () => {
  const v = I.incidentView(incident({ note: 'Lighter is back on 1 of 2 sockets.' }), 'Europe/Berlin');
  assert.equal(v.title, 'Minor incident');
  assert.equal(v.since, 'Since 29 Oct 21:00 UTC (22:00 your time)');
  const html = render(createElement(IncidentCard, { v, href: '/status#notice-22', onDismiss: () => {} }));
  assert.match(html, /class="toast mn-note mn-note--warn"/);
  assert.match(html, /role="status"/);
  assert.match(html, /Minor incident<\/span>/);
  assert.match(html, /Indexer degraded - a data stream is down<\/span>/);
  assert.match(html, /is-partial[^]*Indexer[^]*Degraded/);
  assert.match(html, /Lighter is back on 1 of 2 sockets\./);
  assert.match(html, /Since 29 Oct 21:00 UTC/);
  assert.match(html, /href="\/status#notice-22"[^>]*>Status page →/);
  assert.match(html, /aria-label="Dismiss"/);
  assert.doesNotMatch(html, /banner|toast__timer/, 'no bar, and it does not go by itself');
  assert.equal(I.incidentView(incident(), 'UTC').since, 'Since 29 Oct 21:00 UTC');
  const major = I.incidentView(incident({ impact: 'major' }), 'UTC');
  assert.equal(major.title, 'Partial outage');
  assert.deepEqual(major.rows.map((r) => r.state), ['Partly down']);
  const outage = I.incidentView(incident({ impact: 'critical', components: ['api', 'indexer'] }), 'UTC');
  assert.equal(outage.tone, 'down');
  assert.equal(outage.title, 'Outage');
  const outHtml = render(createElement(IncidentCard, { v: outage, href: '/status#notice-22', onDismiss: () => {} }));
  assert.match(outHtml, /mn-note--down/);
  assert.match(outHtml, /is-down[^]*Data API[^]*Down[^]*Indexer[^]*Down/);
});

test('the data service not answering: a red card of its own, to the status page', () => {
  const html = render(createElement(IncidentCard, { v: I.DOWN_VIEW, href: '/status', onDismiss: () => {} }));
  assert.match(html, /mn-note--down/);
  assert.match(html, /Data service not answering/);
  assert.match(html, /may be out of date/);
  assert.ok(html.includes('href="/status"'));
  assert.doesNotMatch(html, /mn-note__parts|mn-note__eta/);
});

test("offline, or both ValueDesk and SoDEX silent: the visitor's connection is named, never the service", () => {
  assert.equal(I.connectionView({ online: false, down: false, sodexDown: false }), I.OFFLINE_VIEW, 'the browser says offline: at once');
  assert.equal(I.connectionView({ online: false, down: true, sodexDown: true }), I.OFFLINE_VIEW);
  assert.equal(I.connectionView({ online: true, down: false, sodexDown: true }), null, 'SoDEX reconnecting alone is the chart\'s notice, not a card');
  assert.equal(I.connectionView({ online: true, down: true, sodexDown: true }), I.LINK_VIEW, 'both silent: the link');
  assert.equal(I.connectionView({ online: true, down: true, sodexDown: false }), I.DOWN_VIEW, 'SoDEX answers, ValueDesk does not: the service');
  assert.equal(I.OFFLINE_VIEW.tone, 'warn');
  assert.equal(I.LINK_VIEW.tone, 'warn');
});

test('the offline card: no status page link (it would not load), what to check instead', () => {
  const html = render(createElement(IncidentCard, { v: I.OFFLINE_VIEW, href: '/status', onDismiss: () => {} }));
  assert.match(html, /mn-note--warn/);
  assert.match(html, /You(&#x27;|')re offline/);
  assert.match(html, /Check Wi-Fi or mobile data/);
  assert.ok(!html.includes('href="/status"'));
  const link = render(createElement(IncidentCard, { v: I.LINK_VIEW, href: '/status', onDismiss: () => {} }));
  assert.match(link, /slow or offline/);
  assert.ok(link.includes('href="/status"'), 'the slow link may still be an outage: the status page stays');
});

test('one X on a minor indexer-only incident quiets the next ones for a day; major or other services still show', async () => {
  const { indexerMinor, quietUntil, QUIET_MS } = await import('./incidentState');
  assert.equal(indexerMinor({ impact: 'minor', components: ['indexer'] }), true);
  assert.equal(indexerMinor({ impact: 'major', components: ['indexer'] }), false);
  assert.equal(indexerMinor({ impact: 'minor', components: ['indexer', 'api'] }), false);
  assert.equal(indexerMinor({ impact: 'minor', components: [] }), false);
  assert.equal(quietUntil('abc'), 0);
  assert.equal(QUIET_MS, 86_400_000);
});

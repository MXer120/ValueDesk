/**
 * The maintenance notification (maintState.ts, MaintNote.tsx): blue with the expected end
 * and a countdown while a maintenance runs, the parts down / partly down / not affected
 * on hover, green with a checkmark once it is done - and only a click takes it away.
 * What this browser remembers across /api/health answers, reloads and tabs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { installViteStubs, staticMarkup } from '../components/macro/testEnv';

installViteStubs();
const { createElement } = await import('react');
const render = await staticMarkup();
const M = await import('./maintState');
const { MaintCard } = await import('./MaintNote');
const { SiteNoticeBanner } = await import('./SiteNoticeBanner');
type MaintSeen = import('./maintState').MaintSeen;

const T0 = Date.UTC(2026, 9, 29, 14, 0, 0);
const MIN = 60_000;
const H = 3_600_000;

const PARTS = [
  { id: 'website', impact: 'none', text: 'No interruption: the new version loads with your next page.' },
  { id: 'api', impact: 'none', text: '' },
  { id: 'executor', impact: 'partial', text: 'Copies and algo orders pause for about a minute, then go on. Stops already on SoDEX stay.' },
  { id: 'indexer', impact: 'down', text: 'Boards are not updated.' },
];
const live = (o: Record<string, unknown> = {}) => ({
  id: 12, kind: 'maintenance', title: 'Update v0.2.71', impact: null, phase: 'in_progress', startsAt: T0, endsAt: T0 + 4 * MIN,
  components: ['executor', 'indexer'], closedAt: null, parts: PARTS, holdOpen: true, ...o,
});
const health = (...notices: unknown[]) => ({ ok: true, notices });

test('read from /api/health: maintenance in progress or completed, checked one by one', () => {
  const list = M.maintNoticesOf(health(
    live(),
    live({ id: 13, phase: 'completed', closedAt: T0 + MIN, parts: [{ id: 'db', impact: 'down' }] }),
    live({ id: 14, phase: 'upcoming' }),
    { id: 15, kind: 'incident', title: 'x', phase: 'active', startsAt: T0 },
    { id: 'x', kind: 'maintenance' },
    null,
  ));
  assert.deepEqual(list.map((n) => `${n.id}:${n.phase}`), ['12:in_progress', '13:completed']);
  assert.deepEqual(list[0]!.parts!.map((p) => p.id), ['website', 'api', 'executor', 'indexer']);
  assert.equal(list[0]!.holdOpen, true);
  assert.equal('parts' in list[1]!, false, 'no valid part: none');
  assert.deepEqual(M.maintNoticesOf({ ok: true }), []);
  assert.deepEqual(M.maintNoticesOf(null), []);
});

test('remembered: blue once seen in progress, green when completed, never for one it did not see', () => {
  let s = M.maintStep([], health(live()), T0 + 10_000);
  assert.equal(s.length, 1);
  assert.equal(s[0]!.seenAt, T0 + 10_000);
  assert.equal(s[0]!.doneAt, null);
  assert.equal(M.maintStep(s, health(live()), T0 + 40_000), s, 'the same answer: the same state (no write)');
  assert.equal(M.maintStep(s, null, T0 + 40_000), s, 'the data service away is not the end of it');
  assert.equal(M.maintStep(s, { ok: false }, T0 + 40_000), s);
  // Past its expected end, still in progress (held open): still blue.
  s = M.maintStep(s, health(live()), T0 + 9 * MIN);
  assert.equal(s[0]!.doneAt, null);
  s = M.maintStep(s, health(live({ phase: 'completed', closedAt: T0 + 9 * MIN })), T0 + 10 * MIN);
  assert.equal(s[0]!.doneAt, T0 + 9 * MIN, 'green from when it was completed');
  assert.deepEqual(M.maintStep([], health(live({ phase: 'completed', closedAt: T0 })), T0), [], 'not seen in progress: nothing to turn green');
  // Reopened: blue again.
  assert.equal(M.maintStep(s, health(live()), T0 + 11 * MIN)[0]!.doneAt, null);
});

test('gone from the list: completed (it left the list, or was taken off) - unless the list was full', () => {
  const s = M.maintStep([], health(live()), T0);
  assert.equal(M.maintStep(s, health(), T0 + 3 * H)[0]!.doneAt, T0 + 3 * H);
  const incidents = [1, 2, 3].map((id) => ({ id, kind: 'incident', title: `I${id}`, impact: 'major', phase: 'active', startsAt: T0, endsAt: null }));
  assert.equal(M.maintStep(s, health(...incidents), T0 + MIN), s, 'three open: it may only have been cut off');
});

test('only a click takes it away, in every tab; the store survives a reload and is bounded', () => {
  const s = M.maintStep([], health(live(), live({ id: 13, startsAt: T0 + MIN })), T0);
  assert.deepEqual(M.maintShown(s).map((x) => x.id), [12, 13]);
  const d = M.maintDismiss(s, 12);
  assert.deepEqual(M.maintShown(d).map((x) => x.id), [13]);
  assert.deepEqual(M.maintShown(M.maintStep(d, health(live({ phase: 'completed', closedAt: T0 + MIN })), T0 + 2 * MIN)).map((x) => x.id), [13], 'clicked away stays away when it turns green');
  // Another tab clicked it away.
  const other = M.withDismissals(s, d);
  assert.deepEqual(M.maintShown(other).map((x) => x.id), [13]);
  assert.equal(M.withDismissals(d, d), d, 'nothing new: the same state');
  // Stored and read back.
  assert.deepEqual(M.parseMaint(JSON.stringify(d)), d);
  assert.deepEqual(M.parseMaint('{nope'), []);
  assert.deepEqual(M.parseMaint(JSON.stringify([{ id: 'x' }, null, 4])), []);
  assert.deepEqual(M.parseMaint(null), []);
  let many: import('./maintState').MaintState = [];
  for (let i = 1; i <= M.MAINT_KEEP + 5; i++) many = M.maintStep(many, health(live({ id: i })), T0 + i);
  assert.equal(many.length, M.MAINT_KEEP);
  assert.equal(many[0]!.id, 6, 'the oldest seen go first');
});

test('what it says: the countdown, past the expected end, done; times on the viewer\'s clock and in UTC', () => {
  const [s] = M.maintStep([], health(live()), T0);
  const v = M.maintView(s!, T0 + 55_000, 'Europe/Berlin');
  assert.deepEqual(v, { tone: 'live', title: 'Maintenance', line: 'Back by 15:04', left: '3:05', when: '15:04 (14:04 UTC)' });
  assert.equal(M.maintView(s!, T0, 'UTC').when, '14:04 UTC', 'a UTC clock: once');
  const late = M.maintView(s!, T0 + 6 * MIN, 'UTC');
  assert.equal(late.line, 'Taking a little longer than planned');
  assert.equal(late.left, null);
  const done = M.maintView({ ...s!, doneAt: T0 + 7 * MIN }, T0 + 8 * MIN, 'UTC');
  assert.deepEqual(done, { tone: 'done', title: 'Maintenance complete', line: 'Everything runs normally again.', left: null, when: '14:07 UTC' });
  assert.equal(M.maintView({ ...s!, endsAt: null }, T0).line, 'In progress');
  assert.equal(M.leftText(0), null);
  assert.equal(M.leftText(999), '0:01');
  assert.equal(M.leftText(65 * MIN), '1 h 05 min');
  // The parts: down first, then partly down, then not affected; without parts, the ones it touches.
  assert.deepEqual(M.maintParts(s!).map((r) => `${r.name}:${r.impact}`), ['Indexer:down', 'Copy & algo executor:partial', 'Website:none', 'Data API:none']);
  assert.deepEqual(M.maintParts({ ...s!, parts: null }).map((r) => `${r.name}:${r.impact}`), ['Copy & algo executor:affected', 'Indexer:affected']);
});

test('the card: blue with its parts and countdown, green with a checkmark when done', () => {
  const [s] = M.maintStep([], health(live()), T0) as [MaintSeen];
  const html = render(createElement(MaintCard, { s, now: T0 + 55_000, onDismiss: () => {}, timeZone: 'UTC' }));
  assert.match(html, /class="toast mn-note mn-note--live"/);
  assert.match(html, /role="status"/);
  assert.match(html, /Maintenance<\/span>/);
  assert.ok(html.includes('Back by 14:04<span class="mn-note__left"> · <!-- -->3:05<!-- --> left</span>') || /Back by 14:04.{0,60}3:05.{0,20} left<\/span>/.test(html), html.slice(0, 400));
  assert.match(html, /3:05/);
  assert.match(html, /Partly down/);
  assert.match(html, /Not affected/);
  assert.match(html, /is-down[^]*Indexer[^]*Down/);
  assert.match(html, /Copies and algo orders pause for about a minute/);
  assert.match(html, /Expected end 14:04 UTC · <b>3:05<\/b> left/);
  assert.match(html, /aria-label="Dismiss"/);
  assert.match(html, /href="\/status#notice-12"/);
  const done = render(createElement(MaintCard, { s: { ...s, doneAt: T0 + 7 * MIN }, now: T0 + 8 * MIN, onDismiss: () => {}, timeZone: 'UTC' }));
  assert.match(done, /class="toast mn-note mn-note--done"/);
  assert.match(done, /Maintenance complete/);
  assert.match(done, /Everything runs normally again\./);
  assert.match(done, /M3\.5 8\.4 6\.6 11\.4 12\.6 4\.8/, 'the checkmark');
  assert.match(done, /Back to normal/);
  assert.match(done, /Completed 14:07 UTC\./);
  assert.doesNotMatch(done, /pause for about a minute/, 'done: no more what-to-expect lines');
});

test('the banner leaves maintenance in progress to the notification; upcoming and incidents stay there', () => {
  assert.equal(render(createElement(SiteNoticeBanner, { health: health(live()) })), '');
  assert.match(render(createElement(SiteNoticeBanner, { health: health(live({ phase: 'upcoming', startsAt: T0 + H, endsAt: T0 + 2 * H })) })), /Scheduled maintenance/);
  assert.equal(render(createElement(SiteNoticeBanner, { health: health(live({ phase: 'completed' })) })), '');
});

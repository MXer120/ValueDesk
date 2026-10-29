/**
 * The maintenance notification (maintState.ts, MaintNote.tsx): blue with its estimated end
 * while a maintenance runs (past it, "taking longer than expected"), the parts down / partly down / not affected
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
const { MaintCard, MAINT_DONE_MS } = await import('./MaintNote');
const { TTL } = await import('../toast');
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

test('remembered: blue once seen in progress, green ONLY on the server\'s completed ok, never for one it did not see', () => {
  let s = M.maintStep([], health(live()), T0 + 10_000);
  assert.equal(s.length, 1);
  assert.equal(s[0]!.seenAt, T0 + 10_000);
  assert.equal(s[0]!.end, null);
  assert.equal(M.maintStep(s, health(live()), T0 + 40_000), s, 'the same answer: the same state (no write)');
  assert.equal(M.maintStep(s, null, T0 + 40_000), s, 'the data service away is not the end of it');
  assert.equal(M.maintStep(s, { ok: false }, T0 + 40_000), s);
  // Past its estimate, still in progress (held open by the server): still blue - no timer turns it green.
  s = M.maintStep(s, health(live()), T0 + 30 * MIN);
  assert.equal(s[0]!.end, null);
  const ok = M.maintStep(s, health(live({ phase: 'completed', closedAt: T0 + 31 * MIN, outcome: 'ok', note: 'Done: everything runs normally again.' })), T0 + 32 * MIN);
  assert.deepEqual([ok[0]!.end, ok[0]!.doneAt], ['ok', T0 + 31 * MIN], 'green from when it was completed ok');
  assert.deepEqual(M.maintStep([], health(live({ phase: 'completed', closedAt: T0, outcome: 'ok' })), T0), [], 'not seen in progress: nothing to turn green');
  // Reopened: blue again.
  assert.equal(M.maintStep(ok, health(live()), T0 + 33 * MIN)[0]!.end, null);
});

test('never green without the server\'s ok: a rollback and an unconfirmed end are amber, a window that ran out just goes', () => {
  const s = M.maintStep([], health(live()), T0);
  const rb = M.maintStep(s, health(live({ phase: 'completed', closedAt: T0 + 5 * MIN, outcome: 'rolled_back', note: 'The update was rolled back; everything runs as before.' })), T0 + 6 * MIN);
  assert.equal(rb[0]!.end, 'rolled_back');
  assert.equal(rb[0]!.note, 'The update was rolled back; everything runs as before.');
  // A release's maintenance completed by the clock (ship.sh never confirmed it): amber.
  assert.equal(M.maintStep(s, health(live({ phase: 'completed', closedAt: null })), T0 + 70 * MIN)[0]!.end, 'unconfirmed');
  // Closed without an outcome (a server older than outcomes): not ok either.
  assert.equal(M.maintStep(s, health(live({ phase: 'completed', closedAt: T0 + MIN })), T0 + 2 * MIN)[0]!.end, 'unconfirmed');
  // A plain maintenance whose window ran out: not shown any more - and not green.
  const plain = M.maintStep([], health(live({ holdOpen: false, parts: undefined })), T0);
  const ran = M.maintStep(plain, health(live({ holdOpen: false, parts: undefined, phase: 'completed', closedAt: null })), T0 + H);
  assert.equal(ran[0]!.end, 'ended');
  assert.deepEqual(M.maintShown(ran), []);
  // Gone from a complete list: how it ended is not known here - it just goes.
  const gone = M.maintStep(s, health(), T0 + 3 * H);
  assert.equal(gone[0]!.end, 'ended');
  assert.deepEqual(M.maintShown(gone), []);
  const incidents = [1, 2, 3].map((id) => ({ id, kind: 'incident', title: `I${id}`, impact: 'major', phase: 'active', startsAt: T0, endsAt: null }));
  assert.equal(M.maintStep(s, health(...incidents), T0 + MIN), s, 'three open: it may only have been cut off');
  assert.equal(M.endOf({ outcome: 'ok', closedAt: null }, true), 'unconfirmed', 'ok needs a completion');
});

test('only a click takes it away, in every tab; the store survives a reload and is bounded', () => {
  const s = M.maintStep([], health(live(), live({ id: 13, startsAt: T0 + MIN })), T0);
  assert.deepEqual(M.maintShown(s).map((x) => x.id), [12, 13]);
  const d = M.maintDismiss(s, 12);
  assert.deepEqual(M.maintShown(d).map((x) => x.id), [13]);
  assert.deepEqual(M.maintShown(M.maintStep(d, health(live({ phase: 'completed', closedAt: T0 + MIN, outcome: 'ok' }), live({ id: 13, startsAt: T0 + MIN })), T0 + 2 * MIN)).map((x) => x.id), [13], 'clicked away stays away when it turns green');
  // Another tab clicked it away.
  const other = M.withDismissals(s, d);
  assert.deepEqual(M.maintShown(other).map((x) => x.id), [13]);
  assert.equal(M.withDismissals(d, d), d, 'nothing new: the same state');
  // Stored and read back; one kept before `end` existed (v0.2.71-73) ended as completed.
  assert.deepEqual(M.parseMaint(JSON.stringify(d)), d);
  const old = M.parseMaint(JSON.stringify([{ ...s[0], end: undefined, note: undefined, doneAt: T0 + MIN }]));
  assert.deepEqual([old[0]!.end, old[0]!.note], ['ok', null]);
  assert.deepEqual(M.parseMaint('{nope'), []);
  assert.deepEqual(M.parseMaint(JSON.stringify([{ id: 'x' }, null, 4])), []);
  assert.deepEqual(M.parseMaint(null), []);
  let many: import('./maintState').MaintState = [];
  for (let i = 1; i <= M.MAINT_KEEP + 5; i++) many = M.maintStep(many, health(live({ id: i })), T0 + i);
  assert.equal(many.length, M.MAINT_KEEP);
  assert.equal(many[0]!.id, 6, 'the oldest seen go first');
});

test('what it says: an ESTIMATE - "expected by", "about N min"; past it, taking longer (never 0, never negative); how it ended', () => {
  const [s] = M.maintStep([], health(live()), T0);
  const v = M.maintView(s!, T0 + 55_000, 'Europe/Berlin');
  assert.deepEqual(v, {
    tone: 'live', title: 'Maintenance', line: 'Expected by 15:04', left: 'about 4 min',
    eta: 'Expected by 15:04 (14:04 UTC), about 4 min left - an estimate, not a promise.',
  });
  assert.equal(M.maintView(s!, T0, 'UTC').eta, 'Expected by 14:04 UTC, about 4 min left - an estimate, not a promise.', 'a UTC clock: once');
  assert.equal(M.maintView(s!, T0 + 3.5 * MIN, 'UTC').left, 'under a minute');
  for (const at of [T0 + 4 * MIN, T0 + 4 * MIN + 1, T0 + 40 * MIN, T0 + 5 * H]) {
    const late = M.maintView(s!, at, 'UTC');
    assert.deepEqual([late.tone, late.line, late.left], ['live', 'Taking longer than expected', null], 'past the estimate: still blue, no 0, no negative');
    assert.equal(late.eta, 'It was expected by 14:04 UTC; it is taking longer than expected.');
  }
  const done = M.maintView({ ...s!, end: 'ok', doneAt: T0 + 7 * MIN }, T0 + 8 * MIN, 'UTC');
  assert.deepEqual(done, { tone: 'done', title: 'Maintenance complete', line: 'Everything runs normally again.', left: null, eta: 'Completed 14:07 UTC.' });
  assert.deepEqual(M.maintView({ ...s!, end: 'rolled_back', doneAt: T0 + 7 * MIN }, T0 + 8 * MIN, 'UTC').tone, 'warn');
  assert.equal(M.maintView({ ...s!, end: 'rolled_back', doneAt: T0 + 7 * MIN }, T0, 'UTC').title, 'Update rolled back');
  assert.equal(M.maintView({ ...s!, end: 'unconfirmed', doneAt: T0 + H }, T0, 'UTC').line, 'Not confirmed: some parts may not work normally.');
  assert.equal(M.maintView({ ...s!, endsAt: null }, T0).line, 'In progress');
  assert.equal(M.leftText(0), null);
  assert.equal(M.leftText(-5000), null);
  assert.equal(M.leftText(999), 'under a minute');
  assert.equal(M.leftText(61_000), 'about 2 min');
  assert.equal(M.leftText(65 * MIN), 'about 1 h 05 min');
  // The parts: down first, then partly down, then not affected; without parts, the ones it touches.
  assert.deepEqual(M.maintParts(s!).map((r) => `${r.name}:${r.impact}`), ['Indexer:down', 'Copy & algo executor:partial', 'Website:none', 'Data API:none']);
  assert.deepEqual(M.maintParts({ ...s!, parts: null }).map((r) => `${r.name}:${r.impact}`), ['Copy & algo executor:affected', 'Indexer:affected']);
});

test('the card: blue with its parts and the estimate, green with a checkmark when done ok, amber when not', () => {
  const [s] = M.maintStep([], health(live()), T0) as [MaintSeen];
  const html = render(createElement(MaintCard, { s, now: T0 + 55_000, onDismiss: () => {}, timeZone: 'UTC' }));
  assert.match(html, /class="toast mn-note mn-note--live"/);
  assert.match(html, /role="status"/);
  assert.match(html, /Maintenance<\/span>/);
  assert.match(html, /Expected by 14:04.{0,60}about 4 min.{0,20} left<\/span>/);
  assert.match(html, /Partly down/);
  assert.match(html, /Not affected/);
  assert.match(html, /is-down[^]*Indexer[^]*Down/);
  assert.match(html, /Copies and algo orders pause for about a minute/);
  assert.match(html, /an estimate, not a promise/);
  assert.match(html, /aria-label="Dismiss"/);
  assert.match(html, /href="\/status#notice-12"/);
  const late = render(createElement(MaintCard, { s, now: T0 + 30 * MIN, onDismiss: () => {}, timeZone: 'UTC' }));
  assert.match(late, /mn-note--live/);
  assert.match(late, /Taking longer than expected/);
  assert.doesNotMatch(late, /mn-note__left|0 min|about -|left -/, 'no countdown past the estimate');
  const done = render(createElement(MaintCard, { s: { ...s, end: 'ok', doneAt: T0 + 7 * MIN }, now: T0 + 8 * MIN, onDismiss: () => {}, timeZone: 'UTC' }));
  assert.match(done, /class="toast mn-note mn-note--done"/);
  assert.match(done, /Maintenance complete/);
  assert.match(done, /Everything runs normally again\./);
  assert.match(done, /M3\.5 8\.4 6\.6 11\.4 12\.6 4\.8/, 'the checkmark');
  assert.match(done, /Back to normal/);
  assert.match(done, /Completed 14:07 UTC\./);
  assert.doesNotMatch(done, /pause for about a minute/, 'done: no more what-to-expect lines');
  // Done, it goes by itself as good news does (its timer bar); in progress, only the X takes it.
  assert.equal(MAINT_DONE_MS, TTL.ok);
  assert.match(done, new RegExp(`class="toast__timer" style="animation-duration:${MAINT_DONE_MS}ms"`));
  assert.doesNotMatch(html, /toast__timer/, 'in progress: no timer');
  // Rolled back, or held because a part is not healthy: amber or blue with what is still affected, never the checkmark, no timer.
  const rb = render(createElement(MaintCard, { s: { ...s, end: 'rolled_back', doneAt: T0 + 7 * MIN, note: 'The update was rolled back; everything runs as before.' }, now: T0 + 8 * MIN, onDismiss: () => {}, timeZone: 'UTC' }));
  assert.match(rb, /class="toast mn-note mn-note--warn"/);
  assert.match(rb, /Update rolled back/);
  assert.match(rb, /As before/);
  assert.match(rb, /The update was rolled back; everything runs as before\./);
  assert.doesNotMatch(rb, /M3\.5 8\.4 6\.6 11\.4 12\.6 4\.8|toast__timer|Back to normal/);
  const held = { ...s, parts: s.parts!.map((p) => (p.id === 'executor' ? { ...p, impact: 'down' as const } : p)), note: 'The update of the copy executor did not go through: copies and algo orders are held.' };
  const heldHtml = render(createElement(MaintCard, { s: held, now: T0 + 6 * MIN, onDismiss: () => {}, timeZone: 'UTC' }));
  assert.match(heldHtml, /mn-note--live/);
  assert.match(heldHtml, /is-down[^]*Copy &amp; algo executor[^]*Down/);
  assert.match(heldHtml, /did not go through: copies and algo orders are held/);
});

test('the banner leaves maintenance in progress to the notification; upcoming and incidents stay there', () => {
  assert.equal(render(createElement(SiteNoticeBanner, { health: health(live()) })), '');
  assert.match(render(createElement(SiteNoticeBanner, { health: health(live({ phase: 'upcoming', startsAt: T0 + H, endsAt: T0 + 2 * H })) })), /Scheduled maintenance/);
  assert.equal(render(createElement(SiteNoticeBanner, { health: health(live({ phase: 'completed' })) })), '');
});

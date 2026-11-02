/**
 * A release's maintenance notice (ops/shipNotice.ts, `status.sh ship` from
 * deploy/release/ship.sh): what it names for each part, when it should be over, held
 * in progress until the ship completes it, and what /api/health carries of it for the
 * app's notification - the completed ones too, for a while.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { StatusStore } from '../src/ops/status.js';
import {
  DONE_LISTED_MS, HOLD_OPEN_MS, healthNotices, noticePhase, noticeSpan, parseNotice, type Notice,
} from '../src/ops/statusModel.js';
import { SHIP_EFFECTS, partChangesOf, shipMinutes, shipNotice, shipPartsOf } from '../src/ops/shipNotice.js';
import { runStatusCommand } from '../src/ops/statusCommands.js';
import { tempDir } from './builderFakes.js';

const DIR = tempDir('vs-ship-notice-');
let caseNo = 0;
const dbPath = () => join(DIR, `status-${caseNo++}.db`);
const T0 = Date.UTC(2026, 9, 29, 14, 0, 0);
const MIN = 60_000;
const H = 3_600_000;

test('a release names every part: what it restarts by its measured cost, the rest not affected', () => {
  const n = shipNotice('v0.2.71', ['executor', 'web'], T0)!;
  assert.equal(n.kind, 'maintenance');
  assert.equal(n.title, 'Update v0.2.71');
  assert.deepEqual(n.components, ['executor'], 'the status page marks only what it touches');
  assert.deepEqual(n.parts!.map((p) => `${p.id}:${p.impact}`), ['website:none', 'api:none', 'executor:partial', 'indexer:none']);
  assert.equal(n.parts!.find((p) => p.id === 'executor')!.text, SHIP_EFFECTS.executor.text);
  assert.equal(n.parts!.find((p) => p.id === 'website')!.text, SHIP_EFFECTS.website.text, 'the web, shipped: says it does not pause');
  assert.equal(n.parts!.find((p) => p.id === 'api')!.text, '', 'not released: nothing to say');
  assert.equal(n.startsAt, T0);
  assert.equal(n.endsAt, T0 + 4 * MIN, 'executor 3 min + 1');
  assert.equal(n.stage, 'in_progress');
  assert.equal(n.holdOpen, true);
  assert.match(n.text!, /about 4 minutes/);

  assert.equal(shipNotice('v0.2.71', ['web'], T0), null, 'a web-only ship has no downtime and posts nothing');
  assert.equal(shipNotice('v0.2.71', [], T0), null);
  assert.equal(shipMinutes(['indexer', 'api', 'executor', 'web'], T0), 13);
  assert.equal(shipMinutes(['indexer', 'api', 'executor'], Date.UTC(2026, 9, 29, 1, 27)), 15, 'the first build after midnight UTC is the long one');
  assert.equal(shipMinutes(['api'], T0), 2);
  assert.deepEqual(shipPartsOf(' indexer,API,,api '), ['indexer', 'api']);
  assert.throws(() => shipPartsOf('db'), /unknown part "db"/);
});

test('held open: in progress past its planned end until resolved, by the clock an hour after it at the latest', () => {
  const s = new StatusStore(dbPath());
  const n = s.notices.create(shipNotice('v0.2.71', ['indexer', 'api'], T0)!, T0);
  const end = n.endsAt!;
  assert.equal(noticePhase(n, end - MIN), 'in_progress');
  assert.equal(noticePhase(n, end + 10 * MIN), 'in_progress', 'a release that takes longer is never shown as done');
  assert.equal(noticePhase(n, end + HOLD_OPEN_MS), 'completed', 'a ship that died (the laptop) ends with its maintenance window');
  assert.deepEqual(noticeSpan(n, end + 10 * MIN), [T0, end + 10 * MIN]);
  // An update keeps what it names; resolving completes it.
  const u = s.notices.update(n.id, { text: 'Still reconnecting: Lighter.' }, end + 5 * MIN);
  assert.deepEqual(u.parts, n.parts);
  assert.equal(u.holdOpen, true);
  const r = s.notices.resolve(n.id, 'Done: everything runs normally again.', end + 12 * MIN);
  assert.equal(noticePhase(r, end + 12 * MIN), 'completed');
  assert.deepEqual(noticeSpan(r, end + H), [T0, end + 12 * MIN]);
  // A plain maintenance still completes at its end.
  const plain = s.notices.create({ kind: 'maintenance', title: 'DB', components: ['api'], startsAt: T0, endsAt: T0 + H }, T0);
  assert.equal(noticePhase(plain, T0 + H), 'completed');
  s.close();
});

test('parts are checked: known services and impacts, each once, in the page order; maintenance only', () => {
  const base = {
    id: 3, kind: 'maintenance', title: 'Update', impact: null, components: ['api'], startsAt: T0, endsAt: T0 + H, closedAt: null,
    updates: [{ at: T0, stage: 'in_progress', text: '' }],
  };
  const n = parseNotice({
    ...base,
    holdOpen: true,
    parts: [
      { id: 'indexer', impact: 'partial', text: '  behind\u0000 ' },
      { id: 'api', impact: 'down', text: 'x'.repeat(500) },
      { id: 'api', impact: 'none', text: 'twice' },
      { id: 'db', impact: 'down', text: '' },
      { id: 'executor', impact: 'gone', text: '' },
      null,
    ],
  })!;
  assert.deepEqual(n.parts!.map((p) => `${p.id}:${p.impact}`), ['api:down', 'indexer:partial']);
  assert.equal(n.parts![1]!.text, 'behind');
  assert.equal(n.parts![0]!.text.length, 200);
  assert.equal(n.holdOpen, true);
  assert.equal('parts' in parseNotice({ ...base, parts: [{ id: 'db', impact: 'down' }] })!, false, 'none left: no parts');
  assert.equal('holdOpen' in parseNotice({ ...base, holdOpen: 'yes' })!, false);
  const inc = parseNotice({ ...base, kind: 'incident', impact: 'major', endsAt: null, updates: [{ at: T0, stage: 'investigating', text: '' }], parts: base.updates, holdOpen: true })!;
  assert.equal('parts' in inc || 'holdOpen' in inc, false, 'an incident has neither');
});

test('/api/health: the parts and the hold ride along; a completed maintenance is listed for two hours, after the open ones', () => {
  const ship = (o: Partial<Notice>): Notice => ({ ...(parseNotice({ id: 1, ...shipNotice('v1', ['executor'], T0)!, impact: null, closedAt: null, updates: [{ at: T0, stage: 'in_progress', text: '' }] }) as Notice), ...o });
  const live = ship({ id: 10 });
  const [h] = healthNotices([live], T0 + MIN);
  assert.equal(h!.phase, 'in_progress');
  assert.equal(h!.holdOpen, true);
  assert.equal(h!.closedAt, null);
  assert.deepEqual(h!.parts, live.parts);

  const done = ship({ id: 9, closedAt: T0 + 5 * MIN });
  const incidents: Notice[] = [1, 2, 3].map((id) => ({
    id, kind: 'incident', title: `I${id}`, impact: 'major', components: ['api'], startsAt: T0, endsAt: null, closedAt: null,
    updates: [{ at: T0, stage: 'investigating', text: '' }],
  }));
  const at = T0 + 6 * MIN;
  assert.deepEqual(healthNotices([done, live, ...incidents], at).map((n) => `${n.id}:${n.phase}`), ['1:active', '2:active', '3:active', '9:completed'],
    'three open at most, then the completed - its notification still turns green');
  assert.deepEqual(healthNotices([done], T0 + 5 * MIN + DONE_LISTED_MS).map((n) => n.id), [9]);
  assert.deepEqual(healthNotices([done], T0 + 5 * MIN + DONE_LISTED_MS + 1), [], 'gone after two hours');
  const plainDone: Notice = { ...done, id: 8, parts: undefined, holdOpen: undefined, endsAt: T0 + 2 * MIN, closedAt: null };
  delete plainDone.parts;
  delete plainDone.holdOpen;
  assert.deepEqual(healthNotices([plainDone], at).map((n) => `${n.id}:${n.phase}:${'parts' in n}`), ['8:completed:false'], 'completed by the clock: listed too');
  const scheduledDone: Notice = { ...plainDone, id: 7, startsAt: at + H, endsAt: at + 2 * H, closedAt: at - MIN };
  assert.deepEqual(healthNotices([scheduledDone], at), [], 'cancelled before it began: never in progress, not listed');
});

test('command: ship posts it, resolve completes it, show names the parts', () => {
  const s = new StatusStore(dbPath());
  const r = runStatusCommand(['ship', 'v0.2.71', '--parts=indexer,api,web'], s.notices, { now: T0 });
  assert.equal(r.code, 0, r.text);
  assert.equal(r.changed, true);
  assert.match(r.text, /^posted #1 · maintenance · in progress · api,indexer · "Update v0\.2\.71"/);
  assert.equal(/#(\d+)/.exec(r.text)![1], '1', 'ship.sh reads the id as the first #number');
  const show = runStatusCommand(['show', '1'], s.notices, { now: T0 });
  assert.match(show.text, /parts: website none, api partial, executor none, indexer partial \(open until resolved\)/);
  assert.equal(runStatusCommand(['resolve', '1', 'Done: everything runs normally again.'], s.notices, { now: T0 + 9 * MIN }).code, 0);
  assert.equal(noticePhase(s.notices.get(1)!, T0 + 9 * MIN), 'completed');
  assert.equal(runStatusCommand(['ship', 'v0.2.71', '--parts=web'], s.notices, { now: T0 }).code, 1, 'web only: nothing posted');
  assert.match(runStatusCommand(['ship', 'v0.2.71', '--parts=db'], s.notices, { now: T0 }).text, /unknown part "db"/);
  assert.equal(runStatusCommand(['ship', '--parts=api'], s.notices, { now: T0 }).code, 2);
  assert.equal(s.notices.all().length, 1);
  s.close();
});

test('completed how: ok (the app turns green) or rolled back (never green); by the clock, no outcome at all', () => {
  const s = new StatusStore(dbPath());
  const post = () => s.notices.create(shipNotice('v0.2.74', ['executor', 'api'], T0)!, T0);
  const a = post();
  assert.equal(s.notices.resolve(a.id, undefined, T0 + 5 * MIN).outcome, 'ok', 'completed by hand or by ship.sh after its checks');
  const [ha] = healthNotices([s.notices.get(a.id)!], T0 + 6 * MIN);
  assert.equal(ha!.outcome, 'ok');
  assert.equal(ha!.note, 'The maintenance is complete.', 'the latest words, once there are more than the first');
  const b = post();
  const rb = runStatusCommand(['resolve', String(b.id), '--outcome=rolled-back'], s.notices, { now: T0 + 5 * MIN });
  assert.equal(rb.code, 0, rb.text);
  assert.equal(s.notices.get(b.id)!.outcome, 'rolled_back');
  assert.equal(s.notices.get(b.id)!.updates.at(-1)!.text, 'The update was rolled back; everything runs as before.');
  assert.match(runStatusCommand(['resolve', String(b.id), '--outcome=maybe'], s.notices, { now: T0 }).text, /outcome is ok or rolled_back/);
  // Opened again: how it was closed is forgotten.
  assert.equal('outcome' in s.notices.update(b.id, { stage: 'in_progress', text: 'Again.' }, T0 + 6 * MIN), false);
  // Its window ended (a ship that died, an hour past its end): completed by the clock, with no outcome.
  const c = post();
  const late = c.endsAt! + HOLD_OPEN_MS;
  assert.equal(noticePhase(c, late), 'completed');
  const [hc] = healthNotices([c], late);
  assert.equal(hc!.phase, 'completed');
  assert.equal('outcome' in hc! || 'note' in hc!, false, 'never "back to normal" on the clock');
  // An incident has no outcome.
  const inc = s.notices.create({ kind: 'incident', title: 'x', components: ['api'] }, T0);
  assert.throws(() => s.notices.resolve(inc.id, undefined, T0, 'ok'), /only a maintenance has an outcome/);
  assert.equal('outcome' in s.notices.resolve(inc.id, undefined, T0), false);
  // A stored outcome without a completion is not one.
  assert.equal('outcome' in parseNotice({ ...c, outcome: 'ok' })!, false);
  s.close();
});

test('a release completed ok folds in an older release left open on the same parts (#66, 2026-11-02); others stay', () => {
  const s = new StatusStore(dbPath());
  const ship = (tag: string, parts: Parameters<typeof shipNotice>[1], at: number) => s.notices.create(shipNotice(tag, parts, at)!, at);
  const stuck = ship('v0.2.133', ['api', 'indexer'], T0);
  s.notices.update(stuck.id, { stage: 'in_progress', text: 'The indexer restarted; its first rebuild is taking longer than usual.' }, T0 + 30 * MIN);
  const executorOnly = ship('v0.2.132', ['executor'], T0 - H);
  const byHand = ship('v0.2.131', ['api'], T0 - 2 * H);
  s.notices.resolve(byHand.id, undefined, T0 - 2 * H + 5 * MIN, 'rolled_back');
  const later = T0 + 9 * H;
  assert.equal(noticePhase(s.notices.get(stuck.id)!, later), 'completed', 'ran out on the clock: no outcome (the app shows it amber)');
  // A newer release of the api alone does not cover the indexer.
  const apiOnly = ship('v0.2.138', ['api'], later);
  s.notices.resolve(apiOnly.id, 'Done.', later + 2 * MIN);
  assert.equal(s.notices.get(stuck.id)!.closedAt, null);
  // One that restarted and checked both does.
  const both = ship('v0.2.136', ['indexer', 'api', 'web'], later + H);
  s.notices.resolve(both.id, 'Done: everything runs normally again.', later + H + 10 * MIN);
  const folded = s.notices.get(stuck.id)!;
  assert.equal(folded.outcome, 'ok');
  assert.equal(folded.closedAt, later + H + 10 * MIN);
  assert.match(folded.updates.at(-1)!.text, /checked by Update v0\.2\.136/);
  const [h] = healthNotices([folded], later + H + 11 * MIN);
  assert.equal(h!.outcome, 'ok', '/api/health lists it completed ok again, so the app turns the amber card green');
  // A browser not open in the two hours after: still listed (a late ok), for a week.
  assert.equal(healthNotices([folded], later + H + 10 * MIN + 5 * H)[0]?.id, stuck.id);
  assert.equal(healthNotices([folded], later + H + 10 * MIN + 8 * 24 * H).length, 0);
  const onTime = s.notices.get(both.id)!;
  assert.equal(healthNotices([onTime], later + H + 10 * MIN + 3 * H).length, 0, 'one completed in its window: two hours, as before');
  assert.equal(s.notices.get(executorOnly.id)!.closedAt, null, 'a part this release did not check: left as it was');
  assert.equal(s.notices.get(byHand.id)!.outcome, 'rolled_back', 'completed by hand: never rewritten');
  // A rollback folds in nothing.
  const stuck2 = ship('v0.2.141', ['api'], later + 2 * H);
  const rolled = ship('v0.2.142', ['api'], later + 3 * H);
  s.notices.resolve(rolled.id, undefined, later + 3 * H + MIN, 'rolled_back');
  assert.equal(s.notices.get(stuck2.id)!.closedAt, null);
  s.close();
});

test('what is still affected: update --parts sets parts impact now (the plan\'s words go with a changed impact); the note says why', () => {
  const s = new StatusStore(dbPath());
  const n = s.notices.create(shipNotice('v0.2.74', ['executor', 'indexer'], T0)!, T0);
  const r = runStatusCommand(['update', String(n.id), '--parts=executor:down', 'The update of the copy executor did not go through: copies and algo orders are held.'], s.notices, { now: T0 + 3 * MIN });
  assert.equal(r.code, 0, r.text);
  const u = s.notices.get(n.id)!;
  assert.deepEqual(u.parts!.map((p) => `${p.id}:${p.impact}`), ['website:none', 'api:none', 'executor:down', 'indexer:partial']);
  assert.equal(u.parts!.find((p) => p.id === 'executor')!.text, '', 'down now: the planned "pause for about a minute" would contradict it');
  assert.equal(u.parts!.find((p) => p.id === 'indexer')!.text, SHIP_EFFECTS.indexer.text, 'untouched: its words kept');
  runStatusCommand(['update', String(n.id), '--parts=indexer:partial'], s.notices, { now: T0 + 4 * MIN });
  assert.equal(s.notices.get(n.id)!.parts!.find((p) => p.id === 'indexer')!.text, SHIP_EFFECTS.indexer.text, 'the same impact: its words kept');
  assert.equal(noticePhase(u, T0 + 3 * MIN), 'in_progress', 'still open');
  const [h] = healthNotices([u], T0 + 3 * MIN);
  assert.equal(h!.note, 'The update of the copy executor did not go through: copies and algo orders are held.');
  assert.deepEqual(partChangesOf('web:none, indexer:partial').map((p) => `${p.id}:${p.impact}`), ['website:none', 'indexer:partial'], 'ship parts or services');
  assert.throws(() => partChangesOf('executor'), /part:impact/);
  assert.throws(() => partChangesOf('db:down'), /unknown part "db"/);
  assert.match(runStatusCommand(['update', String(n.id), '--parts=executor:gone'], s.notices, { now: T0 }).text, /impact is down, partial, none/);
  const inc = s.notices.create({ kind: 'incident', title: 'x', components: ['api'] }, T0);
  assert.match(runStatusCommand(['update', String(inc.id), '--parts=api:down'], s.notices, { now: T0 }).text, /only a maintenance has parts/);
  s.close();
});

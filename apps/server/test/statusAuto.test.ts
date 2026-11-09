/**
 * The automatic incidents (ops/statusAuto.ts): what the probes' record opens, escalates
 * and resolves by itself, a stretch with no probe at all, the owner's word standing over
 * theirs, and the one replay of the record already there.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { StatusStore } from '../src/ops/status.js';
import { AUTO } from '../src/ops/statusAuto.js';
import type { ServiceId } from '../src/ops/statusModel.js';
import { tempDir } from './builderFakes.js';

const DIR = tempDir('vs-status-auto-');
let caseNo = 0;
const store = () => new StatusStore(join(DIR, `auto-${caseNo++}.db`));
const M0 = Math.floor(Date.UTC(2026, 9, 27, 12, 0, 0) / 60_000);
type St = 'up' | 'degraded' | 'down';

/** Play `states` for one service, a minute each from `start`; the other services up. */
function play(s: StatusStore, svc: ServiceId, states: St[], start = M0): number {
  states.forEach((state, i) => {
    const m = start + i;
    const others = (['website', 'api', 'executor', 'indexer'] as const).filter((x) => x !== svc).map((service) => ({ service, state: 'up' as const }));
    s.auto.observe(m, [...others, { service: svc, state }], m * 60_000);
  });
  return start + states.length;
}
const rep = (n: number, st: St): St[] => Array(n).fill(st);

test('down three minutes opens a major incident from the first bad minute; up five minutes resolves it', () => {
  const s = store();
  let m = play(s, 'api', [...rep(AUTO.downMin - 1, 'down')]);
  assert.equal(s.notices.all().length, 0, 'two minutes are not yet an incident');
  m = play(s, 'api', ['down'], m);
  const [n] = s.notices.all();
  assert.ok(n);
  assert.equal(n.title, 'Data API not answering');
  assert.equal(n.impact, 'major');
  assert.deepEqual(n.components, ['api']);
  assert.equal(n.startsAt, M0 * 60_000);
  assert.equal(n.closedAt, null);
  assert.ok(s.auto.isAuto(n.id));
  m = play(s, 'api', rep(AUTO.clearMin - 1, 'up'), m);
  assert.equal(s.notices.get(n.id)!.closedAt, null, 'four minutes up are not yet back');
  play(s, 'api', ['up'], m);
  const done = s.notices.get(n.id)!;
  assert.ok(done.closedAt);
  assert.equal(done.updates.at(-1)!.stage, 'resolved');
  assert.match(done.updates.at(-1)!.text, /Not answering for about 3 min/);
  s.close();
});

test('degraded ten minutes opens a minor incident; going down keeps the indexer minor (only the figures fall behind)', () => {
  const s = store();
  let m = play(s, 'indexer', rep(AUTO.degradedMin - 1, 'degraded'));
  assert.equal(s.notices.all().length, 0);
  m = play(s, 'indexer', ['degraded'], m);
  const [n] = s.notices.all();
  assert.equal(n!.impact, 'minor');
  assert.equal(n!.title, 'Indexer degraded - figures may be behind');
  play(s, 'indexer', rep(AUTO.downMin, 'down'), m);
  const up = s.notices.get(n!.id)!;
  assert.equal(up.impact, 'minor', 'the indexer down is never major');
  assert.equal(up.title, 'Indexer not publishing - data is not current');
  assert.equal(s.notices.all().length, 1, 'the same incident, not a second');
  s.close();
});

test('a stretch with no probe at all is a resolved incident on the Data API', () => {
  const s = store();
  const m = play(s, 'website', rep(3, 'up'));
  play(s, 'website', rep(2, 'up'), m + 20);
  const [n] = s.notices.all();
  assert.ok(n);
  assert.equal(n.title, 'Data API was not running');
  assert.equal(n.startsAt, m * 60_000);
  assert.equal(n.closedAt, (m + 20) * 60_000);
  assert.match(n.updates[0]!.text, /20 min/);
  // A short restart is not one.
  const s2 = store();
  const k = play(s2, 'website', rep(3, 'up'));
  play(s2, 'website', rep(2, 'up'), k + AUTO.gapMin - 1);
  assert.equal(s2.notices.all().length, 0);
  s.close();
  s2.close();
});

test("the owner's own incident or maintenance stands instead; one they resolve stays closed until the service is back", () => {
  const s = store();
  s.notices.create({ kind: 'incident', title: 'Executor upgrade trouble', components: ['executor'], startsAt: M0 * 60_000 }, M0 * 60_000);
  play(s, 'executor', rep(15, 'down'));
  assert.equal(s.notices.all().length, 1, 'only the owner\'s');

  const t = store();
  let m = play(t, 'api', rep(AUTO.downMin, 'down'));
  const [n] = t.notices.all();
  t.notices.resolve(n!.id, 'Known, fixing.', m * 60_000);
  m = play(t, 'api', rep(30, 'down'), m);
  assert.equal(t.notices.all().length, 1, 'not opened again while still down');
  m = play(t, 'api', rep(AUTO.clearMin, 'up'), m);
  play(t, 'api', rep(AUTO.downMin, 'down'), m);
  assert.equal(t.notices.all().length, 2, 'a new outage after it was back is a new incident');
  s.close();
  t.close();
});

/** The indexer's samples with what is behind, a minute each from `start`; the others up. */
function playWhy(s: StatusStore, rows: Array<[St, string[]]>, start = M0): number {
  rows.forEach(([state, why], i) => {
    const m = start + i;
    const others = (['website', 'api', 'executor'] as const).map((service) => ({ service, state: 'up' as const }));
    s.auto.observe(m, [...others, { service: 'indexer', state, why }], m * 60_000);
  });
  return start + rows.length;
}

test('an indexer incident says what is behind in plain words; something new is one update, said once', () => {
  const s = store();
  let m = playWhy(s, Array(AUTO.degradedMin).fill(['degraded', ['lane:sdata']]));
  const [n] = s.notices.all();
  assert.ok(n);
  assert.equal(n.title, 'Indexer degraded - figures may be behind');
  assert.match(n.updates[0]!.text, /^Since .*: SoDEX PnL, rank and account value reads have stopped making progress: some SoDEX leaderboard figures may be hours old\. Detected by our automatic checks/);
  m = playWhy(s, Array(3).fill(['degraded', ['lane:sdata', 'lane:sgw']]), m);
  const later = s.notices.get(n.id)!;
  assert.equal(later.updates.length, 2, 'one update, not one a minute');
  assert.match(later.updates[1]!.text, /^Now also: SoDEX wallet trade reads have stopped making progress/);
  playWhy(s, Array(AUTO.clearMin).fill(['up', []]), m);
  assert.ok(s.notices.get(n.id)!.closedAt, 'resolved when it keeps up again');
  // Codes it does not know, or a replayed record with none: the general words.
  const r = store();
  playWhy(r, Array(AUTO.degradedMin).fill(['degraded', ['nonsense']]));
  assert.match(r.notices.all()[0]!.updates[0]!.text, /one of the indexer's data streams has been down/);
  s.close();
  r.close();
});

test("planned maintenance stays maintenance: a ship's window or the indexer stopping on purpose opens nothing", () => {
  const s = store();
  // ship.sh's maintenance for the indexer, 10 minutes, then the lanes still behind inside it.
  s.notices.create({ kind: 'maintenance', title: 'Update v0.2.183', components: ['api', 'indexer'], startsAt: M0 * 60_000, endsAt: (M0 + 10) * 60_000 }, M0 * 60_000);
  playWhy(s, Array(15).fill(['degraded', ['lag']]));
  assert.equal(s.notices.all().length, 1, "only the ship's maintenance");
  const t = store();
  let m = playWhy(t, Array(25).fill(['degraded', ['stopping']]));
  assert.equal(t.notices.all().length, 0, 'a stop of 25 minutes the indexer announced');
  // A bad run does not carry across the stop: after it, ten fresh minutes are needed.
  m = playWhy(t, Array(AUTO.degradedMin - 1).fill(['degraded', ['paused']]), m);
  assert.equal(t.notices.all().length, 0);
  playWhy(t, [['degraded', ['paused']]], m);
  assert.match(t.notices.all()[0]!.updates[0]!.text, /stopped publishing new data/);
  s.close();
  t.close();
});

test('the record already there is played once', () => {
  const s = store();
  const now = (M0 + 120) * 60_000;
  for (let i = 0; i < 60; i++) {
    const m = M0 + i;
    s.record([{ service: 'website', state: 'up', ms: 5 }, { service: 'api', state: i >= 10 && i < 20 ? 'down' : 'up', ms: 5 }], m * 60_000);
  }
  assert.equal(s.replayAuto(now), 60);
  const list = s.notices.all();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.startsAt, (M0 + 10) * 60_000);
  assert.ok(list[0]!.closedAt);
  assert.equal(s.replayAuto(now), 0, 'never twice');
  s.close();
});

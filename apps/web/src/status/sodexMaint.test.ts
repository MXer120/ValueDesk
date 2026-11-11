/**
 * SoDEX's own maintenance in the app (owner 2026-11-11): the card's words, the banner line for an
 * announced one, and the order ticket's flag - all from /api/health's notices with source 'sodex'
 * (apps/server/src/ops/sodexWatch.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maintShown, maintStep, maintView, parseMaint } from './maintState';
import { healthNoticeText } from './statusData';
import { sodexMaintOf } from './sodexMaint';

const T0 = Date.UTC(2026, 10, 11, 16, 20);
const MIN = 60_000;
const parts = [
  { id: 'website', impact: 'partial', text: 'Orders, deposits and withdrawals pause on SoDEX. Your funds stay in your SoDEX account.' },
  { id: 'executor', impact: 'partial', text: 'Copies, algos and bots wait, and pick up again when SoDEX is back.' },
];
const live = {
  id: 140, kind: 'maintenance', title: 'SoDEX network upgrade', impact: null, phase: 'in_progress', startsAt: T0, endsAt: T0 + 60 * MIN,
  components: ['website', 'executor', 'indexer'], closedAt: null, parts, source: 'sodex', link: 'https://sodex.com/announcement?id=470',
};

test('SoDEX maintenance: blue "trading paused" with SoDEX estimate, green "SoDEX is back" on ok', () => {
  let st = maintStep([], { notices: [live] }, T0 + MIN);
  const [s] = maintShown(st);
  assert.ok(s);
  assert.equal(s.sodex, true);
  assert.equal(s.link, 'https://sodex.com/announcement?id=470');
  const v = maintView(s, T0 + 2 * MIN, 'UTC');
  assert.equal(v.tone, 'live');
  assert.equal(v.title, 'SoDEX maintenance');
  assert.match(v.line, /^Trading paused · expected by 17:20$/);
  assert.equal(v.left, 'about 58 min');
  assert.match(v.eta!, /SoDEX's estimate/);
  // Past SoDEX's estimate it stays blue and says so.
  assert.equal(maintView(s, T0 + 70 * MIN, 'UTC').line, 'Trading paused · taking longer');
  // Kept across a reload with its source and link.
  const back = parseMaint(JSON.stringify(st));
  assert.equal(back[0]!.sodex, true);
  assert.equal(back[0]!.link, live.link);
  // SoDEX normal again: the server completes it ok - green.
  st = maintStep(st, { notices: [{ ...live, phase: 'completed', closedAt: T0 + 75 * MIN, outcome: 'ok' }] }, T0 + 76 * MIN);
  const done = maintView(maintShown(st)[0]!, T0 + 76 * MIN, 'UTC');
  assert.equal(done.tone, 'done');
  assert.equal(done.title, 'SoDEX is back');
});

test('a link that is not SoDEX\'s own is dropped', () => {
  const st = maintStep([], { notices: [{ ...live, link: 'https://evil.example/phish' }] }, T0);
  assert.equal(maintShown(st)[0]!.link, undefined);
});

test('the banner line for an announced SoDEX maintenance, and in progress', () => {
  const upcoming = { ...live, phase: 'upcoming', title: 'SoDEX Mainnet Upgrade Notice', startsAt: T0 + 86_400_000, endsAt: T0 + 86_400_000 + 2 * 3_600_000 };
  assert.match(healthNoticeText(upcoming as never), /^Announced by SoDEX: SoDEX Mainnet Upgrade Notice, /);
  assert.match(healthNoticeText(live as never), /^SoDEX maintenance in progress, expected until .*: trading on SoDEX is paused$/);
  // Ours stay as they were.
  assert.match(healthNoticeText({ ...live, source: undefined, title: 'v0.2.229' } as never), /^Maintenance in progress: v0\.2\.229/);
});

test('the order ticket flag: on only for SoDEX maintenance in progress; no answer leaves it as it was', () => {
  assert.equal(sodexMaintOf({ notices: [live] }), true);
  assert.equal(sodexMaintOf({ notices: [{ ...live, source: undefined }] }), false, 'our own maintenance does not stop SoDEX orders');
  assert.equal(sodexMaintOf({ notices: [{ ...live, phase: 'upcoming' }] }), false);
  assert.equal(sodexMaintOf({ notices: [] }), false);
  assert.equal(sodexMaintOf(null), null);
  assert.equal(sodexMaintOf({ error: 'x' }), null);
});

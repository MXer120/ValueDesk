/**
 * The status page's incidents and maintenance (ops/statusNotices.ts, statusModel.ts),
 * the owner's commands (ops/statusCommands.ts) from the CLI (tools/status-post.ts) and
 * Telegram (ops/statusTelegram.ts, the hook in telegramReplies.ts), the route's notices
 * and Atom feed, the backup export, and the backfill from the health check's journal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';

import { StatusStore, historyPath, startStatusProber, writeHistory } from '../src/ops/status.js';
import {
  ANNOUNCE_AHEAD_MS, cleanText, dayToneWith, healthNotices, noticePhase, noticesOnDay, parseNotice, type Notice,
} from '../src/ops/statusModel.js';
import { NoticeError, componentsOf, healthNoticeReader } from '../src/ops/statusNotices.js';
import { fmtWindow, parseWhen, runStatusCommand, tokenize } from '../src/ops/statusCommands.js';
import { commandOf, statusTelegramHandler } from '../src/ops/statusTelegram.js';
import { pollReplies } from '../src/ops/telegramReplies.js';
import { FeedbackStore } from '../src/ops/feedbackThreads.js';
import { atomFeed, statusRoutes, FEED_CACHE, FEED_PATH, xml } from '../src/routes/status.js';
import { perfPlugin } from '../src/perf.js';
import { HOSTED_ROUTES } from '../src/hosted.js';
import { runTool, samplesFromHealthEntry } from '../tools/status-post.js';
import { tempDir } from './builderFakes.js';

const DIR = tempDir('vs-notices-');
let caseNo = 0;
const dbPath = () => join(DIR, `status-${caseNo++}.db`);
const T0 = Date.UTC(2026, 9, 27, 12, 0, 0);
const MIN = 60_000;
const H = 3_600_000;
const DAY = 86_400_000;

test('model: text is plain, cleaned and cut; a notice is checked field by field', () => {
  assert.equal(cleanText('  a\u0000b \u202e c\r\n\n\n\nd  ', 100), 'a b c\n\nd');
  assert.equal(cleanText('x'.repeat(20), 10), `${'x'.repeat(9)}…`);
  assert.equal(cleanText(42, 10), '');
  const good = { id: 1, kind: 'incident', title: 'T', impact: 'major', components: ['executor', 'nope'], startsAt: T0, endsAt: null, closedAt: null, updates: [{ at: T0, stage: 'investigating', text: '<b>hi</b>' }] };
  const n = parseNotice(good)!;
  assert.deepEqual(n.components, ['executor']);
  assert.equal(n.updates[0]!.text, '<b>hi</b>', 'kept as text: the page and the feed escape it');
  assert.equal(parseNotice({ ...good, impact: 'huge' }), null);
  assert.equal(parseNotice({ ...good, components: ['nope'] }), null);
  assert.equal(parseNotice({ ...good, updates: [{ at: T0, stage: 'scheduled', text: '' }] }), null, 'a maintenance stage on an incident');
  assert.equal(parseNotice({ ...good, kind: 'maintenance', impact: null, endsAt: T0 - 1 }), null, 'a window ends after it starts');
  assert.equal(parseNotice({ ...good, id: -1 }), null);
});

const maint = (o: Partial<Notice> = {}): Notice => ({
  id: 2, kind: 'maintenance', title: 'DB', impact: null, components: ['api'], startsAt: T0 + H, endsAt: T0 + 2 * H, closedAt: null,
  updates: [{ at: T0, stage: 'scheduled', text: '' }], ...o,
});
const incident = (o: Partial<Notice> = {}): Notice => ({
  id: 1, kind: 'incident', title: 'Copies late', impact: 'major', components: ['executor'], startsAt: T0, endsAt: null, closedAt: null,
  updates: [{ at: T0, stage: 'investigating', text: 'Looking' }], ...o,
});

test('model: phases by the clock, the days a notice touches, the bar colour', () => {
  const m = maint();
  assert.equal(noticePhase(m, T0), 'upcoming');
  assert.equal(noticePhase(m, T0 + H), 'in_progress');
  assert.equal(noticePhase(m, T0 + 2 * H), 'completed', 'a window completes by itself at its end');
  assert.equal(noticePhase({ ...m, closedAt: T0 + 90 * MIN }, T0 + 95 * MIN), 'completed');
  assert.equal(noticePhase({ ...m, updates: [...m.updates, { at: T0 + 10 * MIN, stage: 'in_progress', text: '' }] }, T0 + 20 * MIN), 'in_progress', 'started early');
  assert.equal(noticePhase(incident(), T0 + DAY), 'active');
  assert.equal(noticePhase(incident({ closedAt: T0 + H }), T0 + 2 * H), 'resolved');

  // An incident from 23:00 to 01:00 touches both days; a maintenance not begun touches none.
  const late = incident({ startsAt: Date.UTC(2026, 9, 26, 23), closedAt: Date.UTC(2026, 9, 27, 1) });
  assert.deepEqual(noticesOnDay([late], 'executor', '2026-10-26', T0).map((n) => n.id), [1]);
  assert.deepEqual(noticesOnDay([late], 'executor', '2026-10-27', T0).map((n) => n.id), [1]);
  assert.deepEqual(noticesOnDay([late], 'executor', '2026-10-28', T0 + DAY), []);
  assert.deepEqual(noticesOnDay([late], 'api', '2026-10-27', T0), [], 'another component');
  assert.deepEqual(noticesOnDay([maint()], 'api', '2026-10-27', T0), [], 'upcoming: not on a bar yet');
  assert.deepEqual(noticesOnDay([maint()], 'api', '2026-10-27', T0 + 90 * MIN).map((n) => n.id), [2]);

  const up: [string, number, number, number] = ['2026-10-27', 720, 0, 0];
  assert.equal(dayToneWith(up, []), 'up');
  assert.equal(dayToneWith(up, [maint()]), 'maintenance');
  assert.equal(dayToneWith(up, [incident({ impact: 'minor' })]), 'degraded');
  assert.equal(dayToneWith(up, [incident({ impact: 'major' }), maint()]), 'partial', 'an incident wins over maintenance');
  assert.equal(dayToneWith(['d', 0, 0, 0], [incident({ impact: 'critical' })]), 'down');
  assert.equal(dayToneWith(['d', 100, 0, 900], [incident({ impact: 'minor' })]), 'down', 'never better than the probes');
});

test('model: the app banner - worst incident first, maintenance in progress, upcoming within a day', () => {
  const list = [
    maint({ id: 5, startsAt: T0 + ANNOUNCE_AHEAD_MS + H, endsAt: T0 + ANNOUNCE_AHEAD_MS + 2 * H }),
    maint({ id: 4, startsAt: T0 + H, endsAt: T0 + 2 * H }),
    incident({ id: 3, impact: 'minor' }),
    incident({ id: 2, impact: 'critical' }),
    incident({ id: 1, closedAt: T0 }),
  ];
  assert.deepEqual(healthNotices(list, T0).map((n) => `${n.id}:${n.phase}`), ['2:active', '3:active', '4:upcoming']);
  assert.deepEqual(healthNotices(list, T0, 1).map((n) => n.id), [2]);
  assert.deepEqual(healthNotices([maint()], T0 + 90 * MIN).map((n) => n.phase), ['in_progress']);
});

test('store: create, update, resolve, reopen, delete - one transaction each, checked', () => {
  const s = new StatusStore(dbPath());
  const n = s.notices.create({ kind: 'incident', title: '  Copies are late ', components: ['executor'], impact: 'major', text: 'Looking.' }, T0);
  assert.equal(n.id, 1);
  assert.equal(n.title, 'Copies are late');
  const u = s.notices.update(1, { stage: 'identified', text: 'A feed stalled.' }, T0 + MIN);
  assert.deepEqual(u.updates.map((x) => x.stage), ['investigating', 'identified']);
  const r = s.notices.resolve(1, undefined, T0 + 2 * MIN);
  assert.equal(r.closedAt, T0 + 2 * MIN);
  assert.equal(r.updates.at(-1)!.text, 'This incident has been resolved.');
  // Another stage after resolving opens it again.
  assert.equal(s.notices.update(1, { stage: 'monitoring', text: 'Back again.' }, T0 + 3 * MIN).closedAt, null);
  assert.throws(() => s.notices.update(1, { stage: 'scheduled' }, T0), NoticeError);
  assert.throws(() => s.notices.update(9, { text: 'x' }, T0), /no notice #9/);
  assert.throws(() => s.notices.create({ kind: 'incident', title: '', components: ['api'] }, T0), /title/);
  assert.throws(() => s.notices.create({ kind: 'incident', title: 'x', components: ['db'] }, T0), /unknown component "db"/);
  assert.throws(() => s.notices.create({ kind: 'incident', title: 'x', components: ['api'], startsAt: T0 + H }, T0), /future/);
  assert.throws(() => s.notices.create({ kind: 'maintenance', title: 'x', components: ['api'], startsAt: T0, endsAt: T0 - 1 }, T0), /after the start/);
  assert.throws(() => s.notices.create({ kind: 'maintenance', title: 'x', components: ['api'], startsAt: T0, endsAt: T0 + 8 * DAY }, T0), /7 days/);
  const m = s.notices.create({ kind: 'maintenance', title: 'DB', components: ['all'], startsAt: T0 + H, endsAt: T0 + 2 * H }, T0);
  assert.equal(m.id, 2);
  assert.deepEqual(m.components, ['website', 'api', 'executor', 'indexer']);
  assert.equal(m.updates[0]!.stage, 'scheduled');
  assert.deepEqual(s.notices.update(2, { endsAt: T0 + 3 * H }, T0).updates.length, 1, 'a moved window alone adds no update');
  assert.equal(s.notices.get(2)!.endsAt, T0 + 3 * H);
  // The report carries them; delete takes one away.
  assert.deepEqual(s.report(T0 + 4 * MIN).notices!.map((x) => x.id), [2, 1]);
  assert.equal(s.notices.remove(2), true);
  assert.equal(s.notices.remove(2), false);
  // A second connection (the CLI next to the API) sees and adds to the same record.
  const other = new StatusStore(s.path);
  assert.equal(other.notices.create({ kind: 'incident', title: 'Two', components: ['api'] }, T0).id, 3);
  assert.equal(s.notices.get(3)!.title, 'Two');
  other.close();
  s.close();
  assert.deepEqual(componentsOf(['api, indexer', 'API']), ['api', 'indexer']);
});

test('health reader: cached 30 s, never throws', () => {
  const s = new StatusStore(dbPath());
  let t = T0;
  let opens = 0;
  const read = healthNoticeReader(() => { opens += 1; return s.notices; }, { now: () => t });
  assert.deepEqual(read(), []);
  s.notices.create({ kind: 'incident', title: 'Down', components: ['api'], impact: 'critical' }, T0);
  t += 10_000;
  assert.deepEqual(read(), [], 'still the cached answer');
  t += 30_000;
  assert.deepEqual(read().map((n) => n.title), ['Down']);
  assert.equal(opens, 1);
  const broken = healthNoticeReader(() => { throw new Error('no file'); });
  assert.deepEqual(broken(), []);
  s.close();
});

test('commands: words, times and the grammar', () => {
  assert.deepEqual(tokenize('incident "Copies are late" --components=executor we\'re on it'), ['incident', 'Copies are late', '--components=executor', "we're", 'on', 'it']);
  assert.deepEqual(tokenize('\u201cSmart quotes\u201d \u2014impact=major --start="2026-10-28 02:00"'), ['Smart quotes', '--impact=major', '--start=2026-10-28 02:00']);
  assert.equal(parseWhen('now', T0), T0);
  assert.equal(parseWhen('+90m', T0), T0 + 90 * MIN);
  assert.equal(parseWhen('+2h', T0, { base: T0 + H }), T0 + 3 * H);
  assert.equal(parseWhen('2026-10-28T02:00', T0), Date.UTC(2026, 9, 28, 2));
  assert.equal(parseWhen('2026-10-28 02:00', T0), Date.UTC(2026, 9, 28, 2));
  assert.equal(parseWhen('2026-10-28T04:00+02:00', T0), Date.UTC(2026, 9, 28, 2));
  assert.equal(parseWhen('02:00', T0, { prefer: 'future' }), Date.UTC(2026, 9, 28, 2), 'the next 02:00');
  assert.equal(parseWhen('11:00', T0, { prefer: 'past' }), Date.UTC(2026, 9, 27, 11));
  assert.equal(parseWhen('13:00', T0, { prefer: 'past' }), Date.UTC(2026, 9, 26, 13), 'the last 13:00');
  assert.throws(() => parseWhen('tomorrow', T0), /not a time/);
  assert.equal(fmtWindow(Date.UTC(2026, 9, 28, 2), Date.UTC(2026, 9, 28, 3)), '28 Oct 02:00 – 03:00 UTC');

  const s = new StatusStore(dbPath());
  const run = (line: string, now = T0) => runStatusCommand(tokenize(line), s.notices, { now, allowDelete: true });
  const a = run('incident "Copies are late" --components=executor --impact=major We are looking into it.');
  assert.equal(a.code, 0, a.text);
  assert.equal(a.changed, true);
  assert.match(a.text, /^posted #1 · major incident · open \(investigating\) · executor · "Copies are late"/);
  assert.match(a.text, /Investigating - We are looking into it\./);
  assert.equal(run('update 1 identified A feed stalled.', T0 + MIN).code, 0);
  assert.equal(run('update #1 --impact=critical', T0 + 2 * MIN).code, 0);
  assert.equal(s.notices.get(1)!.impact, 'critical');
  assert.match(run('update 1 completed done').text, /its stages are investigating, identified, monitoring, resolved/);
  assert.match(run('update 1').text, /nothing to update/);
  assert.match(run('resolve 1 All good.', T0 + 3 * MIN).text, /^resolved #1/);
  const m = run('maint "DB upgrade" --start=2026-10-28T02:00 --end=+1h --components=api,indexer Leaderboards may not load.');
  assert.equal(m.code, 0, m.text);
  assert.match(m.text, /#2 · maintenance · upcoming · api,indexer · "DB upgrade" · 28 Oct 02:00 – 03:00 UTC/);
  assert.match(run('maintenance "x" --components=api').text, /needs --start/);
  assert.match(run('incident "x" --components=api --impact=huge').text, /minor, major or critical/);
  assert.match(run('incident "x" --components=api --colour=red').text, /unknown option --colour/);
  assert.match(run('list', T0 + 5 * MIN).text, /Open and upcoming:\n {2}#2 .*\nLast closed:\n {2}#1 /);
  assert.match(run('show 2').text, /Scheduled - Leaderboards may not load\./);
  assert.equal(run('show 9').code, 1);
  assert.equal(run('frobnicate').code, 2);
  assert.match(run('help').text, /^Status page commands:/);
  assert.equal(runStatusCommand(['delete', '2'], s.notices, { now: T0 }).code, 2, 'not from Telegram');
  assert.equal(run('delete 2').code, 0);
  s.close();
});

const TOKEN = '123456:' + 'A'.repeat(35);
const CHAT = '-1001234';

test('telegram: only the owner chat, only commands that are not replies, each message once', async () => {
  const path = dbPath();
  const said: Array<{ text: string; replyTo: number }> = [];
  const handler = statusTelegramHandler({ open: () => new StatusStore(path), reply: async (text, replyTo) => said.push({ text, replyTo }), now: () => T0, env: {} });
  assert.deepEqual(commandOf('/incident@ValueDeskBot "x"'), { name: 'incident', rest: '"x"' });
  assert.equal(commandOf('/start'), null);
  assert.equal(commandOf('hello'), null);

  // Through the feedback reply loop, with Telegram faked.
  const updates = [
    { update_id: 10, message: { message_id: 50, chat: { id: -999 }, text: '/incident "Evil" --components=api' } },
    { update_id: 11, message: { message_id: 51, chat: { id: Number(CHAT) }, text: '/incident "Copies are late" --components=executor --impact=major Looking.' } },
    { update_id: 12, message: { message_id: 52, chat: { id: Number(CHAT) }, text: '/status' } },
    { update_id: 13, message: { message_id: 53, chat: { id: Number(CHAT) }, text: '/start' } },
    { update_id: 14, message: { message_id: 54, chat: { id: Number(CHAT) }, text: '/resolve 1', reply_to_message: { message_id: 7 } } },
    { update_id: 15, message: { message_id: 55, chat: { id: Number(CHAT) }, text: '/incident "no components"' } },
  ];
  let round = 0;
  const fake = (async () => new Response(JSON.stringify({ ok: true, result: round++ === 0 ? updates : [] }), { status: 200 })) as unknown as typeof fetch;
  const fb = new FeedbackStore(join(DIR, 'feedback.db'));
  const r = await pollReplies(fb, { token: TOKEN, chatId: CHAT, fetch: fake, timeoutS: 0, onCommand: handler });
  assert.deepEqual(r, { ok: true, stored: 0 });
  const s = new StatusStore(path);
  assert.deepEqual(s.notices.all().map((n) => n.title), ['Copies are late'], 'nothing from another chat, nothing from a reply');
  assert.deepEqual(said.map((x) => x.replyTo), [51, 52, 55]);
  assert.match(said[0]!.text, /^posted #1/);
  assert.match(said[1]!.text, /Open and upcoming:/);
  assert.match(said[2]!.text, /name the affected components[\s\S]*Status page commands:/);
  // The same message again (a restart before the offset was kept) is not posted twice.
  assert.equal(await handler({ text: '/incident "Copies are late" --components=executor', messageId: 51 }), true);
  assert.equal(s.notices.all().length, 1);
  // A group chat with STATUS_TELEGRAM_USER_IDS: only those senders.
  const strict = statusTelegramHandler({ open: () => new StatusStore(path), reply: async (text, replyTo) => said.push({ text, replyTo }), now: () => T0, env: { STATUS_TELEGRAM_USER_IDS: '42' } });
  assert.equal(await strict({ text: '/incident "x" --components=api', messageId: 60, fromId: 7 }), true);
  assert.equal(s.notices.all().length, 1);
  assert.equal(await strict({ text: '/incident "x" --components=api', messageId: 61, fromId: 42 }), true);
  assert.equal(s.notices.all().length, 2);
  // Off: not handled at all.
  const off = statusTelegramHandler({ open: () => new StatusStore(path), now: () => T0, env: { VALUESCAN_STATUS_TELEGRAM: '0' } });
  assert.equal(await off({ text: '/status', messageId: 70 }), false);
  s.close();
});

test('route: notices in the report, the Atom feed, both cacheable and on the hosted list', async () => {
  const s = new StatusStore(dbPath());
  s.notices.create({ kind: 'incident', title: 'Copies <late> & "slow"', components: ['executor'], impact: 'major', text: '<script>x</script>' }, T0);
  const app = Fastify();
  await app.register(perfPlugin);
  await app.register(statusRoutes, { store: s, now: () => T0 + MIN, site: 'https://site.test/' });
  await app.ready();
  const a = await app.inject({ method: 'GET', url: '/api/vs/status' });
  assert.equal((a.json() as { notices: Notice[] }).notices[0]!.title, 'Copies <late> & "slow"');
  const f = await app.inject({ method: 'GET', url: FEED_PATH });
  assert.equal(f.statusCode, 200);
  assert.match(String(f.headers['content-type']), /^application\/atom\+xml/);
  assert.equal(f.headers['cache-control'], FEED_CACHE);
  assert.match(f.body, /<title type="text">Copies &lt;late&gt; &amp; &quot;slow&quot; \(Investigating\)<\/title>/);
  assert.match(f.body, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.ok(!f.body.includes('<script>'));
  assert.match(f.body, /<id>https:\/\/site\.test\/status#notice-1<\/id>/);
  assert.ok(HOSTED_ROUTES.some((r) => r.url === FEED_PATH && r.method === 'GET'));
  await app.close();
  assert.equal(xml('a\u0001<'), 'a&lt;');
  assert.match(atomFeed([], 'https://x.test', T0), /<updated>2026-10-27T12:00:00Z<\/updated>/);
  s.close();
});

test('backup: the history file changes only with finished days and notices, and fills a new record', () => {
  const s = new StatusStore(dbPath());
  const file = historyPath(s.path);
  s.record([{ service: 'api', state: 'up', ms: 1 }], T0 - DAY);
  s.record([{ service: 'api', state: 'down', ms: null }], T0);
  assert.equal(writeHistory(s, file, T0), true);
  assert.equal(writeHistory(s, file, T0), false, 'unchanged');
  s.record([{ service: 'api', state: 'up', ms: 1 }], T0 + MIN);
  assert.equal(writeHistory(s, file, T0 + MIN), false, 'today is not in it');
  s.notices.create({ kind: 'incident', title: 'X', components: ['api'] }, T0);
  assert.equal(writeHistory(s, file, T0 + MIN), true);
  const h = JSON.parse(readFileSync(file, 'utf8')) as { days: Record<string, unknown[]>; notices: unknown[] };
  assert.deepEqual(h.days.api, [['2026-10-26', 1, 0, 0]]);
  assert.equal(h.notices.length, 1);

  // A restored server: a new status.db next to the restored file is filled at start.
  const fresh = new StatusStore(join(DIR, 'restored', 'status.db'));
  writeFileSync(historyPath(fresh.path), readFileSync(file));
  const p = startStatusProber({ store: fresh, targets: { site: 'https://x.test', executor: 'https://x.test', executorSecret: null }, fetch: (async () => { throw new Error('offline'); }) as unknown as typeof fetch, firstAfterMs: 3_600_000 });
  p.stop();
  assert.deepEqual(fresh.report(T0).services.find((x) => x.id === 'api')!.days.at(-2), ['2026-10-26', 1, 0, 0]);
  assert.equal(fresh.notices.all().length, 1);
  // Never over what is there.
  assert.deepEqual(fresh.restoreHistory(readFileSync(file, 'utf8'), T0), { days: 0, notices: 0 });
  assert.throws(() => fresh.restoreHistory('{"kind":"other"}', T0), /not a status history/);
  fresh.close();
  s.close();
});

// --- the backfill from the health check's journal -----------------------------------------------

const pass = (at: number, checks: Record<string, { ok: boolean; warn?: boolean; note?: string }>) =>
  JSON.stringify({ __REALTIME_TIMESTAMP: String(at * 1000 + 123), MESSAGE: JSON.stringify({ ok: true, server: 's1', failed: [], warned: [], checks }) });
const ALL_OK = { api: { ok: true }, indexer: { ok: true, note: 'status 5 s old' }, 'peer:site': { ok: true }, 'peer:site-copy': { ok: true } };

test('backfill: a health pass is a minute of each service', () => {
  const at = T0 + 30_000;
  assert.deepEqual(samplesFromHealthEntry(JSON.parse(pass(at, ALL_OK))).map((x) => `${x.service}:${x.state}:${x.minute}`), [
    `website:up:${T0 / MIN}`, `api:up:${T0 / MIN}`, `executor:up:${T0 / MIN}`, `indexer:up:${T0 / MIN}`,
  ]);
  const bad = samplesFromHealthEntry(JSON.parse(pass(at, {
    api: { ok: false }, indexer: { ok: true, warn: true, note: 'streams down: lighter' }, 'peer:site': { ok: false, note: 'site does not answer' },
    'peer:site-copy': { ok: false, note: 'www.valuedesk.so/api/copy/v1/health answered ok:false' },
  })));
  assert.deepEqual(bad.map((x) => `${x.service}:${x.state}`), ['website:down', 'api:down', 'executor:degraded', 'indexer:degraded']);
  const unjudged = samplesFromHealthEntry(JSON.parse(pass(at, { api: { ok: false }, indexer: { ok: true, warn: true, note: 'not judged: /api/vs/index/health did not answer' } })));
  assert.deepEqual(unjudged.map((x) => x.service), ['api'], 'not judged is no data');
  assert.deepEqual(samplesFromHealthEntry({ MESSAGE: 'Started Valuescan health check.', __REALTIME_TIMESTAMP: '1' }), []);
  assert.deepEqual(samplesFromHealthEntry({ MESSAGE: [1, 2], __REALTIME_TIMESTAMP: '1' }), []);
});

test('backfill: only before the record begins, each minute once, dry run keeps nothing', async () => {
  const path = dbPath();
  const s = new StatusStore(path);
  // The prober began at T0.
  s.record([{ service: 'api', state: 'up', ms: 1 }, { service: 'website', state: 'up', ms: 1 }], T0);
  s.close();
  // Journal: 10:00-12:04 every minute (12:00-12:04 overlap the prober), one duplicate, one junk line.
  const lines: string[] = ['-- No entries --', 'not json'];
  for (let t = T0 - 2 * H; t <= T0 + 4 * MIN; t += MIN) lines.push(pass(t + 5_000, ALL_OK));
  lines.push(pass(T0 - 2 * H + 40_000, { ...ALL_OK, api: { ok: false } }));
  const input = lines.join('\n');
  const now = T0 + 10 * MIN;

  const dry = await runTool(['backfill', '--dry-run'], { path, now, stdin: input });
  assert.equal(dry.code, 0, dry.text);
  assert.match(dry.text, /would add:/);
  assert.match(dry.text, /api {7}2026-10-27 {2}\+120 up, \+0 degraded, \+0 down/);
  let r = new StatusStore(path);
  assert.deepEqual(r.report(now).services.find((x) => x.id === 'api')!.days.at(-1), ['2026-10-27', 1, 0, 0], 'the dry run kept nothing');
  r.close();

  const done = await runTool(['backfill'], { path, now, stdin: input });
  assert.equal(done.code, 0, done.text);
  r = new StatusStore(path);
  const day = (id: string) => r.report(now).services.find((x) => x.id === id)!.days.at(-1);
  assert.deepEqual(day('api'), ['2026-10-27', 121, 0, 0], '120 minutes before the prober, the first pass of a minute wins, + the prober\'s one');
  assert.deepEqual(day('website'), ['2026-10-27', 121, 0, 0]);
  // The executor and the indexer were never probed: every minute of the journal counts.
  assert.deepEqual(day('executor'), ['2026-10-27', 125, 0, 0]);
  r.close();
  assert.ok(existsSync(historyPath(path)));

  const again = await runTool(['backfill'], { path, now, stdin: input });
  assert.equal(again.code, 1);
  assert.match(again.text, /nothing to add/);
  assert.equal((await runTool(['backfill'], { path, now, stdin: 'junk' })).code, 1);
  assert.equal((await runTool(['backfill', '--nope'], { path, now, stdin: '' })).code, 2);
});

test('cli: the commands write and refresh the backup file', async () => {
  const path = dbPath();
  const a = await runTool(['incident', 'Copies are late', '--components=executor', '--impact=major', 'Looking into it.'], { path, now: T0 });
  assert.equal(a.code, 0, a.text);
  const h = JSON.parse(readFileSync(historyPath(path), 'utf8')) as { notices: Notice[] };
  assert.equal(h.notices[0]!.title, 'Copies are late');
  assert.equal((await runTool(['delete', '1'], { path, now: T0 })).code, 0);
  assert.equal((JSON.parse(readFileSync(historyPath(path), 'utf8')) as { notices: Notice[] }).notices.length, 0);
  assert.equal((await runTool(['restore'], { path, now: T0 })).code, 2);
});

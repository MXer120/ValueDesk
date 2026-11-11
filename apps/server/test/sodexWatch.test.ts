import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { NoticeStore } from '../src/ops/statusNotices.js';
import { healthNotices, noticePhase } from '../src/ops/statusModel.js';
import { SodexWatch, parseWindow, plainText, readFlag, scopeOf, STREAK } from '../src/ops/sodexWatch.js';

const T0 = Date.UTC(2026, 10, 11, 16, 20);
const MIN = 60_000;

/** A fake alpha-biz: the flag and announcements as the test sets them; `down` = unreachable. */
function biz() {
  const st = {
    flag: { status: 'NORMAL', maintenanceDuration: 1, updateTime: Math.floor(T0 / 1000) } as Record<string, unknown>,
    down: false,
    articles: [] as Array<{ id: number; title: string; createdAt: number; body: string }>,
    detailCalls: 0,
  };
  const f = (async (url: string) => {
    if (st.down) throw new Error('fetch failed');
    const body = url.includes('/maintenance/status')
      ? { code: 0, data: st.flag, message: 'success' }
      : url.includes('/announcements/detail/')
        ? (() => {
          st.detailCalls += 1;
          const id = Number(/detail\/(\d+)/.exec(url)![1]);
          const a = st.articles.find((x) => x.id === id);
          return { code: 0, data: { id, title: a?.title, body: a?.body } };
        })()
        : { code: 0, data: { articles: st.articles.map(({ id, title, createdAt }) => ({ id, title, createdAt })) } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { st, f };
}

const setup = () => {
  const notices = new NoticeStore(new DatabaseSync(':memory:'));
  const b = biz();
  const watch = new SodexWatch(notices, { fetch: b.f, biz: 'https://biz.test' });
  return { notices, watch, ...b };
};

test('the flag is read as sodex.com reads it; anything else is no information', () => {
  assert.deepEqual(readFlag({ code: 0, data: { status: 'NORMAL' } }), { kind: 'normal' });
  const r = readFlag({ code: 0, data: { status: 'CHAIN_MAINTENANCE', maintenanceDuration: 1, updateTime: 1794413973 } });
  assert.equal(r.kind, 'maintenance');
  assert.equal(r.kind === 'maintenance' && r.hours, 1);
  assert.equal(r.kind === 'maintenance' && r.updatedAt, 1794413973000);
  assert.equal(readFlag({ code: 0, data: { status: 'all_maintenance' } }).kind, 'maintenance');
  assert.equal(readFlag({ code: 0, data: { status: 'SOMETHING_NEW' } }).kind, 'unknown');
  assert.equal(readFlag({ code: 1, data: { status: 'CHAIN_MAINTENANCE' } }).kind, 'unknown');
  assert.equal(readFlag(null).kind, 'unknown');
  assert.equal(readFlag({ code: 0, data: { status: 'CHAIN_MAINTENANCE', maintenanceDuration: -3, updateTime: 'x' } }).kind === 'maintenance', true);
});

test('windows in the forms SoDEX has written', () => {
  // Announcement 458 (2026-10-19), as its HTML body reads.
  const t458 = plainText('<p>Maintenance Window</p><p>October 19, 2026, 15:00 UTC – October 19, 2026, 21:00 UTC </p><p>Scope of Impact</p>');
  assert.deepEqual(parseWindow(t458), { start: Date.UTC(2026, 9, 19, 15), end: Date.UTC(2026, 9, 19, 21) });
  // Announcement 209 (2026-01-29).
  const t209 = 'our third-party hosting partner will be conducting routine node maintenance from 10:00 to 12:00 (UTC) on January 29, 2026. During this time';
  assert.deepEqual(parseWindow(t209), { start: Date.UTC(2026, 0, 29, 10), end: Date.UTC(2026, 0, 29, 12) });
  // An end given as a time only, a UTC+8 window, and one across midnight.
  assert.deepEqual(parseWindow('Nov 12, 2026 08:00 – 10:00 (UTC+8)'), { start: Date.UTC(2026, 10, 12, 0), end: Date.UTC(2026, 10, 12, 2) });
  assert.deepEqual(parseWindow('December 31, 2026, 23:00 UTC - 01:00 UTC'), { start: Date.UTC(2026, 11, 31, 23), end: Date.UTC(2027, 0, 1, 1) });
  assert.deepEqual(parseWindow('from 2026-11-20 06:00 to 2026-11-20 08:30 UTC'), { start: Date.UTC(2026, 10, 20, 6), end: Date.UTC(2026, 10, 20, 8, 30) });
  assert.equal(parseWindow('We will upgrade soon. Stay tuned.'), null);
  // More than 7 days is not a window this posts.
  assert.equal(parseWindow('October 1, 2026, 00:00 UTC – October 20, 2026, 00:00 UTC'), null);
});

test('scope: Wealth, deposits and withdrawals, or trading', () => {
  assert.equal(scopeOf('SoDEX Wealth Scheduled Maintenance Notice', ''), 'wealth');
  assert.equal(scopeOf('Notification of Scheduled Maintenance for Deposit and Withdrawal Services-2026-01-29', ''), 'funds');
  assert.equal(scopeOf('SoDEX Network Upgrade', 'All trading will be paused.'), 'trading');
  assert.equal(scopeOf('Scheduled System Maintenance', 'SoDEX trading, deposits, withdrawals, and other platform services will remain unaffected. Wealth pauses.'), 'wealth');
});

test('two maintenance readings open one notice in progress; two NORMAL complete it ok', async () => {
  const { notices, watch, st } = setup();
  await watch.step(T0); // announcements read, NORMAL
  st.flag = { status: 'CHAIN_MAINTENANCE', maintenanceDuration: 1, updateTime: Math.floor(T0 / 1000) };
  await watch.step(T0 + MIN);
  assert.equal(notices.all().length, 0, 'one reading is not enough');
  await watch.step(T0 + 2 * MIN);
  const n = notices.all()[0]!;
  assert.ok(n);
  assert.equal(n.source, 'sodex');
  assert.equal(n.title, 'SoDEX network upgrade');
  assert.equal(noticePhase(n, T0 + 2 * MIN), 'in_progress');
  assert.deepEqual(n.components, ['website', 'executor', 'indexer']);
  assert.equal(n.endsAt, T0 + 60 * MIN, 'SoDEX estimate: updateTime + 1 h');
  assert.equal(n.holdOpen, undefined, 'never held open: a release ok must not fold it');
  // Still in maintenance past its estimate: the end moves on, the notice stays open.
  for (let m = 3; m <= 90; m++) await watch.step(T0 + m * MIN);
  const still = notices.get(n.id)!;
  assert.equal(noticePhase(still, T0 + 90 * MIN), 'in_progress');
  assert.ok(still.endsAt! >= T0 + 90 * MIN + 14 * MIN);
  assert.equal(notices.all().length, 1, 'one notice, not one per round');
  // The app shows it as SoDEX's.
  const h = healthNotices(notices.all(), T0 + 90 * MIN);
  assert.equal(h[0]!.source, 'sodex');
  // Back to NORMAL: one reading is not enough, two complete it ok.
  st.flag = { status: 'NORMAL' };
  await watch.step(T0 + 91 * MIN);
  assert.equal(notices.get(n.id)!.closedAt, null);
  await watch.step(T0 + 92 * MIN);
  const done = notices.get(n.id)!;
  assert.equal(done.outcome, 'ok');
  assert.equal(noticePhase(done, T0 + 92 * MIN), 'completed');
});

test('an unreachable flag is no information: it neither opens nor closes', async () => {
  const { notices, watch, st } = setup();
  st.flag = { status: 'ALL_MAINTENANCE', maintenanceDuration: 2, updateTime: Math.floor(T0 / 1000) };
  await watch.step(T0);
  st.down = true;
  await watch.step(T0 + MIN);
  await watch.step(T0 + 2 * MIN);
  assert.equal(notices.all().length, 0, 'down rounds do not count towards the streak');
  st.down = false;
  await watch.step(T0 + 3 * MIN);
  const n = notices.all()[0]!;
  assert.equal(n.title, 'SoDEX maintenance');
  st.flag = { status: 'NORMAL' };
  await watch.step(T0 + 4 * MIN);
  st.down = true;
  for (let m = 5; m < 10; m++) await watch.step(T0 + m * MIN);
  assert.equal(notices.get(n.id)!.closedAt, null, 'an unreachable flag does not close it either');
});

test('closed by the owner by hand: no new one until SoDEX is NORMAL again', async () => {
  const { notices, watch, st } = setup();
  st.flag = { status: 'CHAIN_MAINTENANCE', maintenanceDuration: 1, updateTime: Math.floor(T0 / 1000) };
  for (let m = 0; m < STREAK; m++) await watch.step(T0 + m * MIN);
  const n = notices.all()[0]!;
  notices.update(n.id, { stage: 'completed', outcome: 'ok', text: 'closed by hand' }, T0 + 5 * MIN);
  for (let m = 6; m < 12; m++) await watch.step(T0 + m * MIN);
  assert.equal(notices.all().length, 1);
  st.flag = { status: 'NORMAL' };
  await watch.step(T0 + 12 * MIN);
  await watch.step(T0 + 13 * MIN);
  st.flag = { status: 'CHAIN_MAINTENANCE', maintenanceDuration: 1, updateTime: Math.floor((T0 + 14 * MIN) / 1000) };
  await watch.step(T0 + 14 * MIN);
  await watch.step(T0 + 15 * MIN);
  assert.equal(notices.all().length, 2, 'the next maintenance opens again');
});

test('an announced maintenance is posted once, scheduled, with its link and scope; the flag then takes it', async () => {
  const { notices, watch, st } = setup();
  const start = T0 + 2 * 86_400_000;
  st.articles = [
    { id: 470, title: 'SoDEX Mainnet Upgrade Notice', createdAt: Math.floor(T0 / 1000), body: '<p>Maintenance Window</p><p>November 13, 2026, 16:20 UTC – November 13, 2026, 18:20 UTC</p>' },
    { id: 471, title: 'SoDEX Wealth Scheduled Maintenance Notice', createdAt: Math.floor(T0 / 1000), body: '<p>November 14, 2026, 03:00 UTC – November 14, 2026, 05:00 UTC</p>' },
    { id: 469, title: 'SoDEX Recurring Buy Is Live', createdAt: Math.floor(T0 / 1000), body: '<p>no</p>' },
    { id: 458, title: 'SoDEX Wealth Scheduled Maintenance Notice', createdAt: Math.floor(Date.UTC(2026, 9, 18) / 1000), body: '<p>October 19, 2026, 15:00 UTC – October 19, 2026, 21:00 UTC</p>' },
  ];
  await watch.step(T0);
  const all = notices.all();
  assert.equal(all.length, 2, 'the two future maintenance windows, not the listing or the old one');
  const trade = all.find((n) => n.link === 'https://sodex.com/announcement?id=470')!;
  assert.equal(trade.startsAt, start);
  assert.equal(noticePhase(trade, T0), 'upcoming');
  assert.deepEqual(trade.components, ['website', 'executor', 'indexer']);
  const wealth = all.find((n) => n.link === 'https://sodex.com/announcement?id=471')!;
  assert.deepEqual(wealth.components, ['website']);
  // Read again ten minutes later: nothing posted twice, no detail fetched again.
  const calls = st.detailCalls;
  await watch.step(T0 + 11 * MIN);
  assert.equal(notices.all().length, 2);
  assert.equal(st.detailCalls, calls);
  // On the day, the flag turns: the announced notice is the one that goes in progress.
  st.flag = { status: 'CHAIN_MAINTENANCE', maintenanceDuration: 2, updateTime: Math.floor(start / 1000) };
  await watch.step(start);
  await watch.step(start + MIN);
  assert.equal(notices.all().length, 2, 'no second notice');
  assert.equal(noticePhase(notices.get(trade.id)!, start + MIN), 'in_progress');
  st.flag = { status: 'NORMAL' };
  await watch.step(start + 30 * MIN);
  await watch.step(start + 31 * MIN);
  assert.equal(notices.get(trade.id)!.outcome, 'ok');
});

test('only sodex.com links are kept on a notice', () => {
  const notices = new NoticeStore(new DatabaseSync(':memory:'));
  assert.throws(() => notices.create({ kind: 'maintenance', source: 'sodex', link: 'https://evil.example/x', title: 'x', components: ['website'], startsAt: T0, endsAt: T0 + MIN }, T0));
  const n = notices.create({ kind: 'maintenance', source: 'sodex', link: 'https://sodex.com/announcement?id=1', title: 'x', components: ['website'], startsAt: T0, endsAt: T0 + MIN }, T0);
  assert.equal(notices.get(n.id)!.link, 'https://sodex.com/announcement?id=1');
});

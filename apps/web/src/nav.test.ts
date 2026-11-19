/**
 * The tap's answer (nav.ts): the pending store only the nav bars read, the latest request winning, the spinner after
 * SLOW_MS, and in-place links. Run (from apps/web): npx tsx --test src/nav.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SLOW_MS, afterNextPaint, beginNav, cancelNav, isLatestNav, navTicket, openPath, pendingNav, plainClick, setPathOpener, settleNav } from './nav';
import { litFromKey, routeKeyForPath, routeKeyOf } from './router';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a navigation lights its target at once; the spinner joins only past SLOW_MS', async () => {
  beginNav('tab:portfolio');
  assert.deepEqual(pendingNav(), { key: 'tab:portfolio', slow: false });
  await sleep(SLOW_MS + 30);
  assert.deepEqual(pendingNav(), { key: 'tab:portfolio', slow: true });
  cancelNav();
  assert.equal(pendingNav(), null);
});

test('it clears in the commit its page lands in - not for another page, and a newer tap replaces it', async () => {
  beginNav('tab:bots');
  settleNav('tab:trade');
  assert.equal(pendingNav()?.key, 'tab:bots', 'the old page re-rendering does not end it');
  beginNav('sodex:points');
  await sleep(SLOW_MS / 2);
  settleNav('tab:bots');
  assert.equal(pendingNav()?.key, 'sodex:points', 'the earlier target landing late does not end the newer one');
  settleNav('sodex:points');
  assert.equal(pendingNav(), null);
  await sleep(SLOW_MS);
  assert.equal(pendingNav(), null, 'no spinner after it landed');
});

test('the latest request wins', () => {
  const a = navTicket();
  const b = navTicket();
  assert.equal(isLatestNav(a), false);
  assert.equal(isLatestNav(b), true);
});

test('afterNextPaint runs once (a timer stands in where there are no frames)', async () => {
  let n = 0;
  afterNextPaint(() => n++);
  await sleep(600);
  assert.equal(n, 1);
});

test('openPath goes through the app, else the browser', () => {
  const seen: string[] = [];
  const off = setPathOpener((u) => seen.push(u));
  openPath('/scan?find=0xabc');
  off();
  assert.deepEqual(seen, ['/scan?find=0xabc']);
});

test('only a plain left click is taken in place', () => {
  const base = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, button: 0, defaultPrevented: false };
  assert.equal(plainClick(base), true);
  for (const k of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey', 'defaultPrevented'] as const) assert.equal(plainClick({ ...base, [k]: true }), false, k);
  assert.equal(plainClick({ ...base, button: 1 }), false);
});

test('one key per page, whatever kind; the bars light from it what App lights for the page itself', () => {
  assert.equal(routeKeyForPath('/trade'), 'tab:trade');
  assert.equal(routeKeyForPath('/scan?x'.split('?')[0]!), 'tab:scan');
  assert.equal(routeKeyForPath('/points'), 'sodex:points');
  assert.equal(routeKeyForPath('/wealth/fund-1'), 'sodex:wealth');
  assert.equal(routeKeyForPath('/terms'), 'legal:terms');
  assert.equal(routeKeyForPath('/status'), 'status');
  assert.equal(routeKeyForPath('/limits'), 'limits');
  assert.equal(routeKeyForPath('/excluded'), 'excluded');
  assert.equal(routeKeyForPath('/wallet'), null, 'not a page of ours (it lands on the default)');
  assert.equal(routeKeyForPath('/'), null);
  const r = { tab: 'trade' as const, legal: null, status: false, excluded: false, limits: false, sodex: null };
  assert.equal(routeKeyOf(r), 'tab:trade');
  assert.equal(routeKeyOf({ ...r, sodex: 'points' }), 'sodex:points');
  assert.equal(routeKeyOf({ ...r, status: true, sodex: 'points' }), 'status', 'status is shown over a SoDEX view');
  assert.equal(routeKeyOf({ ...r, legal: 'terms', status: true }), 'legal:terms', 'a legal page over everything');
  for (const key of ['tab:bots', 'sodex:points', 'legal:risk', 'status', 'excluded', 'limits']) {
    const lit = litFromKey(key);
    assert.equal(routeKeyOf({ ...r, ...lit, tab: lit.tab ?? 'trade' }), key);
  }
  assert.deepEqual(litFromKey('tab:portfolio'), { tab: 'portfolio', sodex: null, legal: null, status: false, excluded: false, limits: false });
});

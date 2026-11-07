/**
 * Where algo orders run: ValueDesk by default, kept under its own key, the
 * old draft's choice moved over once; this browser alone from a close-only
 * place, the stored choice untouched (AlgoTicket.test.ts renders it).
 * Run (from apps/web): npx tsx --test src/components/algo/executor.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DRAFT_KEY, DEFAULT } from './draft';
import { DEFAULT_PLACE, EXECUTOR_KEY, PLACES, readExecutor, writeExecutor } from './executor';

function memStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), map: m };
}

test('ValueDesk is the default, and first in the choice', () => {
  assert.equal(DEFAULT_PLACE, 'hosted');
  assert.equal(PLACES[0]![0], 'hosted');
  assert.deepEqual(PLACES.map(([v]) => v), ['hosted', 'browser'], 'no self-hosted (owner 2026-11-07)');
  assert.equal(readExecutor(memStore()), 'hosted');
  assert.equal(readExecutor(null), 'hosted');
});

test('the choice is kept under its own key', () => {
  const store = memStore();
  writeExecutor('self', store);
  assert.equal(store.map.get(EXECUTOR_KEY), '"self"');
  assert.equal(readExecutor(store), 'hosted', 'self-hosted from before runs on ValueDesk');
  writeExecutor('browser', store);
  assert.equal(readExecutor(store), 'browser');
  assert.equal(store.map.has(DRAFT_KEY), false, 'the draft is not touched');
});

test('the old draft\'s place moves over once, as ValueDesk now that self-hosted is gone', () => {
  const store = memStore({ [DRAFT_KEY]: JSON.stringify({ ...DEFAULT, place: 'self' }) });
  assert.equal(readExecutor(store), 'hosted');
  assert.equal(store.map.get(EXECUTOR_KEY), '"hosted"');
  // Once moved, the executor's own key decides, whatever the draft still says.
  writeExecutor('hosted', store);
  assert.equal(readExecutor(store), 'hosted');
});

test("the old default, Browser, saved in every draft unasked, is not kept: ValueDesk instead", () => {
  const store = memStore({ [DRAFT_KEY]: JSON.stringify({ ...DEFAULT, place: 'browser' }) });
  assert.equal(readExecutor(store), 'hosted');
  assert.equal(store.map.get(EXECUTOR_KEY), '"hosted"');
});

test('a draft without a place, or with a bad one, gives the default', () => {
  assert.equal(readExecutor(memStore({ [DRAFT_KEY]: JSON.stringify(DEFAULT) })), 'hosted');
  assert.equal(readExecutor(memStore({ [DRAFT_KEY]: JSON.stringify({ place: 'moon' }) })), 'hosted');
  assert.equal(readExecutor(memStore({ [DRAFT_KEY]: '{broken' })), 'hosted');
  assert.equal(readExecutor(memStore({ [EXECUTOR_KEY]: '"moon"' })), 'hosted');
});

test('blocked storage never throws', () => {
  const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(readExecutor(blocked), 'hosted');
  assert.doesNotThrow(() => writeExecutor('self', blocked));
});

test('blocked: an executor that cannot start, with or without a wallet; never connect-wallet or the browser', async () => {
  const { blockedState } = await import('./executor');
  const down = { ready: false, why: 'The ValueDesk executor is not reachable right now.' };
  assert.equal(blockedState('hosted', { ready: true, why: null }, true), null);
  assert.equal(blockedState('hosted', down, false)?.short, 'ValueDesk executor unreachable');
  assert.equal(blockedState('hosted', { ready: false, why: 'Connect your wallet.' }, false), null);
  assert.equal(blockedState('hosted', { ready: false, why: 'Connect your wallet.' }, true), null);
  assert.equal(blockedState('browser', { ready: false, why: 'Connect a wallet to run it live.' }, true), null);
  const b = blockedState('hosted', down, true);
  assert.equal(b?.short, 'ValueDesk executor unreachable');
  assert.match(b!.message, /not reachable.*Open Advanced to run it elsewhere/);
  const key = blockedState('self', { ready: false, why: 'Register the key of your copier in Copy → Set up ("Approve agent").' }, true);
  assert.equal(key?.short, 'Self-hosted copier key missing');
  assert.match(key!.message, /Or open Advanced/);
  assert.equal(blockedState('hosted', { ready: false, why: 'Accept the terms of the ValueDesk executor in Copy → Set up.' }, true)?.short, 'ValueDesk executor not set up');
});

test('only this browser from a close-only place, or where the country is unknown; not open, not blocked', async () => {
  const { browserOnly } = await import('./executor');
  assert.equal(browserOnly({ access: { level: 'close-only' } }), true);
  assert.equal(browserOnly({ access: { level: 'close-only' }, located: true }), true);
  // Unknown country: the order button treats it as close-only (useTradeGate.ts), so does the place.
  assert.equal(browserOnly({ access: { level: 'open' }, located: false }), true);
  assert.equal(browserOnly({ access: { level: 'open' }, located: true }), false);
  assert.equal(browserOnly({ access: { level: 'open' } }), false);
  // A blocked place runs nothing anywhere: the button says "Not available", the place is left alone.
  assert.equal(browserOnly({ access: { level: 'blocked' } }), false);
  assert.equal(browserOnly({ access: { level: 'blocked' }, located: false }), false);
  assert.equal(browserOnly(null), false);
  assert.equal(browserOnly(undefined), false);
});

test('where only the browser may run it, it runs there whatever is stored; the stored choice is not touched', async () => {
  const { runPlace, blockedState, BROWSER_ONLY_LINE } = await import('./executor');
  // The copy terms a close-only place cannot sign no longer stand before a closing algo.
  const terms = { ready: false, why: 'Accept the terms of the ValueDesk executor in Copy → Set up.' };
  assert.equal(blockedState(runPlace('hosted', false), terms, true)?.short, 'ValueDesk executor not set up');
  assert.equal(blockedState(runPlace('hosted', true), terms, true), null);
  assert.equal(blockedState(runPlace('self', true), terms, true), null);
  for (const stored of ['hosted', 'browser', 'self'] as const) {
    assert.equal(runPlace(stored, true), 'browser');
    assert.equal(runPlace(stored, false), stored);
  }
  const store = memStore();
  writeExecutor('hosted', store);
  assert.equal(runPlace(readExecutor(store), true), 'browser');
  assert.equal(store.map.get(EXECUTOR_KEY), '"hosted"', 'the choice made elsewhere is kept for later');
  assert.equal(runPlace(readExecutor(store), false), 'hosted');
  assert.equal(BROWSER_ONLY_LINE, 'From your region, algos run in this browser and can only close or reduce positions.');
});

test('the blocked notice is raised once per state', async () => {
  const { noticeFor } = await import('./executor');
  assert.equal(noticeFor(null, 'A'), 'A');
  assert.equal(noticeFor('A', 'A'), null);
  assert.equal(noticeFor('A', 'B'), 'B');
  assert.equal(noticeFor('A', null), null);
  assert.equal(noticeFor(null, null), null);
});

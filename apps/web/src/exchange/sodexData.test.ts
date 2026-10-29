/**
 * The data host's client (sodexData.ts dataHostClient): one dropped connection
 * is tried once more and closes nothing; a second in a row, or a 429, opens the
 * cooldown every tab keeps; a read meeting a short cooldown waits it out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimitedError, UnreachableError } from './errors';
import { dataHostClient } from './sodexData';
import type { KeyValueStore, LedgerDeps } from './ledger';

const ORIGIN = 'https://data.test';
const PATH = '/api/v1/leaderboard/rank?window_type=7D&sort_by=pnl&wallet_address=0x48d98beb9dfce0a24f284e7653f05609b058ad96';

function memStore(): KeyValueStore {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, data }), { status: 200 });

/** One tab's client on a shared store and clock; `sleep` moves the clock. */
function rig(store: KeyValueStore = memStore(), clock = { t: 1_000_000 }, offline = false) {
  const deps: LedgerDeps = { store, locks: null, now: () => clock.t, sleep: async (ms) => void (clock.t += ms) };
  const calls: number[] = [];
  const state: { reply: () => Response | 'throw' } = { reply: () => ok({ found: false }) };
  const fetchImpl = (async () => {
    calls.push(clock.t);
    const out = state.reply();
    if (out === 'throw') throw new TypeError('Failed to fetch');
    return out;
  }) as typeof fetch;
  const client = dataHostClient({ deps, fetchImpl, origin: () => ORIGIN, offline: () => offline });
  return { client, calls, state, clock, store };
}

test('data host: one dropped connection is tried once more - and closes nothing when that answers', async () => {
  const r = rig();
  let n = 0;
  r.state.reply = () => (++n === 1 ? 'throw' : ok({ found: true }));
  assert.deepEqual(await r.client.get(PATH), { found: true });
  assert.equal(r.calls.length, 2);
  assert.equal(r.client.cool.left('host'), 0, 'no cooldown: the leaderboard, ranks and charts of every tab keep going');
});

test('data host: a second unreadable failure in a row opens the cooldown; another tab waits a short one out', async () => {
  const store = memStore();
  const clock = { t: 1_000_000 };
  const tab1 = rig(store, clock);
  const tab2 = rig(store, clock);
  tab1.state.reply = () => 'throw';
  await assert.rejects(tab1.client.get(PATH), UnreachableError);
  assert.equal(tab1.calls.length, 2, 'tried once more, not again and again');
  const left = tab1.client.cool.left('host');
  assert.ok(left >= 15_000, 'then treated as a possible 1015');
  // Long left: refused at once, without asking.
  await assert.rejects(tab2.client.get(PATH), RateLimitedError);
  assert.equal(tab2.calls.length, 0);
  // Short left (as the gateway's COOL_WAIT_MAX_MS): waited out, then sent.
  const coolEnd = clock.t + left;
  clock.t = coolEnd - 5_000;
  assert.deepEqual(await tab2.client.get(PATH), { found: false });
  assert.equal(tab2.calls.length, 1);
  assert.ok(tab2.calls[0]! >= coolEnd, 'sent once the cooldown was over, not into it');
  assert.equal(tab2.client.cool.left('host'), 0, 'and an answer ends it');
});

test('data host: a 429 is never replayed and opens the cooldown', async () => {
  const r = rig();
  r.state.reply = () => new Response('error code: 1015', { status: 429 });
  await assert.rejects(r.client.get(PATH));
  assert.equal(r.calls.length, 1);
  assert.ok(r.client.cool.left('host') >= 15_000);
});

test('data host: unreadable failures while the browser is offline open no cooldown', async () => {
  const r = rig(memStore(), { t: 1_000_000 }, true);
  r.state.reply = () => 'throw';
  await assert.rejects(r.client.get(PATH), UnreachableError);
  assert.equal(r.client.cool.left('host'), 0, 'nothing was refused: the request never left');
});

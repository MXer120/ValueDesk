/**
 * The browser's SoDEX gateway client (sodexGateway.ts): the server's weights
 * and cache lifetimes, dedupe, backoff on 429 / 1015 / 503, and the history
 * drip that keeps /trades and /orders/history under Cloudflare's 1015 limit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SodexApiError } from '@sodex-core';
import { weightFor } from '@sign/sodex/restCore.js';
import { RateLimitedError, UnreachableError } from './errors';
import { GatewayClient, HISTORY_COOL, HISTORY_DRIP } from './sodexGateway';
import type { KeyValueStore, LedgerDeps } from './ledger';

const A = '0x48d98beb9dfce0a24f284e7653f05609b058ad96';
const ORIGIN = 'https://gw.test';

function memStore(): KeyValueStore {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

interface Rig {
  client: GatewayClient;
  deps: LedgerDeps;
  clock: { t: number };
  calls: Array<{ path: string; t: number }>;
  reply: (path: string) => Response | Promise<Response> | 'throw';
}

function rig(store: KeyValueStore = memStore(), clock = { t: 1_000_000 }): Rig {
  const deps: LedgerDeps = { store, locks: null, now: () => clock.t, sleep: async (ms) => void (clock.t += ms) };
  const r = {} as Rig;
  r.clock = clock;
  r.deps = deps;
  r.calls = [];
  r.reply = () => ok([]);
  const fetchImpl = (async (input: string | URL) => {
    const path = String(input).slice(ORIGIN.length);
    r.calls.push({ path, t: clock.t });
    const out = await r.reply(path);
    if (out === 'throw') throw new TypeError('Failed to fetch');
    return out;
  }) as typeof fetch;
  r.client = new GatewayClient({ deps, fetchImpl, origin: () => ORIGIN, now: () => clock.t });
  return r;
}

const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, data }), { status: 200 });

test('gateway: every read is billed at the server\'s documented weight (restCore.weightFor)', async () => {
  const r = rig();
  await r.client.get('/api/v1/perps/markets/symbols');
  await r.client.get(`/api/v1/perps/accounts/${A}/state`);
  await r.client.get(`/api/v1/perps/accounts/${A}/positions/history?limit=200`);
  const expected = weightFor('/api/v1/perps/markets/symbols') + weightFor(`/api/v1/perps/accounts/${A}/state`) + weightFor('/positions/history', 200);
  assert.equal(r.client.budget.spent(), expected);
  assert.equal(expected, 2 + 5 + 30);
});

test('gateway: market lists are shared for the server\'s TTL; account reads only dedupe concurrent calls', async () => {
  const r = rig();
  await r.client.get('/api/v1/perps/markets/symbols');
  r.clock.t += 59_000;
  await r.client.get('/api/v1/perps/markets/symbols');
  assert.equal(r.calls.length, 1, 'symbols: 60 s');
  r.clock.t += 2_000;
  await r.client.get('/api/v1/perps/markets/symbols');
  assert.equal(r.calls.length, 2);

  const path = `/api/v1/perps/accounts/${A}/positions`;
  await Promise.all([r.client.get(path), r.client.get(path), r.client.get(path)]);
  assert.equal(r.calls.filter((c) => c.path === path).length, 1, 'three panels, one request');
  await r.client.get(path);
  assert.equal(r.calls.filter((c) => c.path === path).length, 2, 'but a later read is fresh (fills must show at once)');
});

test('gateway: a 429 is never replayed, and the cooldown quiets every tab', async () => {
  const store = memStore();
  const clock = { t: 1_000_000 };
  const tab1 = rig(store, clock);
  const tab2 = rig(store, clock);
  tab1.reply = () => new Response(JSON.stringify({ code: 429, error: 'too many requests' }), { status: 429 });
  await assert.rejects(tab1.client.get(`/api/v1/perps/accounts/${A}/state`), SodexApiError);
  assert.equal(tab1.calls.length, 1, 'no retry into a rate limit');
  await assert.rejects(tab2.client.get(`/api/v1/perps/accounts/${A}/state`), RateLimitedError);
  assert.equal(tab2.calls.length, 0, 'the other tab does not even ask');
  // Another endpoint is not cooling down.
  await tab2.client.get('/api/v1/perps/markets/tickers');
  assert.equal(tab2.calls.length, 1);
});

test('gateway: Cloudflare 1015 (a plain-text 429) opens the cooldown too', async () => {
  const r = rig();
  r.reply = () => new Response('error code: 1015', { status: 429 });
  await assert.rejects(r.client.get(`/api/v1/spot/accounts/${A}/state`));
  assert.ok(r.client.cooldownLeft(`/api/v1/spot/accounts/${A}/state`) >= 15_000);
  assert.equal(r.calls.length, 1);
});

test('gateway: an unreadable failure on a history path is treated as a 1015 - never replayed', async () => {
  const r = rig();
  r.reply = () => 'throw';
  await assert.rejects(r.client.get(`/api/v1/perps/accounts/${A}/trades?limit=100`), RateLimitedError);
  assert.equal(r.calls.length, 1);
  assert.ok(r.client.cooldownLeft(`/api/v1/perps/accounts/${A}/trades`) >= HISTORY_COOL.baseMs);
  // Every history read of every engine now waits it out, without asking.
  r.reply = () => ok([]);
  await assert.rejects(r.client.get(`/api/v1/spot/accounts/${A}/orders/history?limit=100`), RateLimitedError);
  assert.equal(r.calls.length, 1, 'no history read goes out into a possible 1015');
  r.clock.t += HISTORY_COOL.baseMs;
  await r.client.get(`/api/v1/spot/accounts/${A}/orders/history?limit=100`);
  assert.equal(r.calls.length, 2, 'after the cooldown, history reads resume');
  r.reply = () => 'throw';
  // Elsewhere a dropped connection is tried once more, then reported as unreachable.
  await assert.rejects(r.client.get('/api/v1/perps/markets/tickers'), UnreachableError);
  assert.equal(r.calls.filter((c) => c.path.includes('tickers')).length, 2);
});

test('gateway: 503 and transient envelopes are retried with backoff, then answer', async () => {
  const r = rig();
  let n = 0;
  r.reply = () => (++n < 3 ? new Response('upstream down', { status: 503 }) : ok({ aid: 7 }));
  const t0 = r.clock.t;
  assert.deepEqual(await r.client.get(`/api/v1/perps/accounts/${A}/state`), { aid: 7 });
  assert.equal(r.calls.length, 3);
  assert.ok(r.clock.t > t0, 'backed off between attempts');
  n = 0;
  r.reply = () => (++n < 2 ? new Response(JSON.stringify({ code: -1, error: 'internal server error: invalid character' }), { status: 200 }) : ok([]));
  await r.client.get(`/api/v1/perps/accounts/${A}/fundings?limit=100`);
  assert.equal(n, 2, 'the intermittent error envelope is replayed');
  n = 0;
  r.reply = () => {
    n++;
    return new Response(JSON.stringify({ code: 400, error: 'bad symbol' }), { status: 400 });
  };
  await assert.rejects(r.client.get('/api/v1/perps/markets/NOPE/orderbook?limit=20'), SodexApiError);
  assert.equal(n, 1, 'a definite rejection is final');
});

test(`gateway: /trades and /orders/history share ONE drip - never more than ${HISTORY_DRIP.max} of them in ${HISTORY_DRIP.windowMs / 1000} s`, async () => {
  const r = rig();
  for (let i = 0; i < 10; i++) await r.client.get(`/api/v1/perps/accounts/${A}/trades?limit=100&endTime=${9_000 - i}`);
  const trades = r.calls.filter((c) => c.path.includes('/trades')).map((c) => c.t);
  for (let i = HISTORY_DRIP.max; i < trades.length; i++) {
    assert.ok(trades[i]! - trades[i - HISTORY_DRIP.max]! >= HISTORY_DRIP.windowMs, `request ${i} waited for the window`);
  }
  // Order history counts against the same four (Cloudflare counts them together).
  r.clock.t += HISTORY_DRIP.windowMs;
  for (let i = 0; i < HISTORY_DRIP.max; i++) await r.client.get(`/api/v1/spot/accounts/${A}/trades?limit=100&endTime=${i}`);
  const t0 = r.clock.t;
  await r.client.get(`/api/v1/spot/accounts/${A}/orders/history?limit=100&endTime=1`);
  assert.ok(r.clock.t - t0 >= 1, 'the order history read waited for the trades window');
  const all = r.calls.filter((c) => /\/(trades|orders\/history)\?/.test(c.path)).map((c) => c.t);
  for (let i = HISTORY_DRIP.max; i < all.length; i++) assert.ok(all[i]! - all[i - HISTORY_DRIP.max]! >= HISTORY_DRIP.windowMs);
  // Positions history is not limited that way.
  const t1 = r.clock.t;
  for (let i = 0; i < 8; i++) await r.client.get(`/api/v1/perps/accounts/${A}/positions/history?limit=100&endTime=${i}`);
  assert.equal(r.clock.t, t1, 'positions history is not dripped');
});

test('gateway: two tabs share the drip - one read past it waits, whichever tab sends it', async () => {
  const store = memStore();
  const clock = { t: 1_000_000 };
  const tab1 = rig(store, clock);
  const tab2 = rig(store, clock);
  for (let i = 0; i < HISTORY_DRIP.max; i++) await tab1.client.get(`/api/v1/perps/accounts/${A}/trades?limit=100&endTime=${i}`);
  const t0 = clock.t;
  await tab2.client.get(`/api/v1/spot/accounts/${A}/trades?limit=100`);
  assert.ok(clock.t - t0 >= 1, 'tab 2 waited for tab 1\'s window');
});

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

test('gateway: a history page is the last good copy of its path - and fresh for a reader of any priority', async () => {
  const r = rig();
  const path = `/api/v1/perps/accounts/${A}/trades?limit=100`;
  r.reply = () => ok([{ id: 1 }]);
  await r.client.get(path);
  assert.deepEqual(r.client.lastGood<unknown>(path)?.value, [{ id: 1 }], 'the stale-page fallback finds it');
  await r.client.get(path, { priority: 'background' });
  assert.equal(r.calls.length, 1, 'within the cache lifetime a background reader takes the answer, not a slot');
});

/** Virtual time for reads that wait on each other: `sleep` parks on a timer; `until` runs what can run, then jumps to the next timer. */
function virtualTime(start: number) {
  const timers: Array<{ at: number; fire: () => void }> = [];
  const clock = { t: start };
  const sleep = (ms: number) => new Promise<void>((fire) => void timers.push({ at: clock.t + Math.max(0, ms), fire }));
  async function until<T>(p: Promise<T>): Promise<T> {
    let settled = false;
    const out = p.finally(() => void (settled = true));
    out.catch(() => undefined);
    for (let guard = 0; !settled; guard++) {
      if (guard > 100_000) throw new Error('virtual time: runaway');
      await new Promise((r) => setImmediate(r));
      if (settled || timers.length === 0) continue;
      timers.sort((a, b) => a.at - b.at);
      const next = timers.shift()!;
      clock.t = Math.max(clock.t, next.at);
      next.fire();
    }
    return out;
  }
  return { clock, sleep, until };
}

/** A client on virtual time, for reads that queue behind each other. */
function vrig() {
  const vt = virtualTime(1_000_000);
  const deps: LedgerDeps = { store: memStore(), locks: null, now: () => vt.clock.t, sleep: vt.sleep };
  const calls: Array<{ path: string; t: number }> = [];
  const state: { reply: (path: string) => Response | Promise<Response> | 'throw' } = { reply: () => ok([]) };
  // Like fetch: a request whose signal aborts is cancelled.
  const cancelled = (signal?: AbortSignal | null) =>
    new Promise<never>((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const path = String(input).slice(ORIGIN.length);
    calls.push({ path, t: vt.clock.t });
    const out = await Promise.race([state.reply(path), cancelled(init?.signal)]);
    if (out === 'throw') throw new TypeError('Failed to fetch');
    return out;
  }) as typeof fetch;
  const client = new GatewayClient({ deps, fetchImpl, origin: () => ORIGIN, now: () => vt.clock.t, hidden: () => false });
  return { vt, client, calls, state };
}

test('gateway: a history read waiting for its slot is not sent into a cooldown that opened meanwhile', async () => {
  const r = vrig();
  const trades = (n: number) => `/api/v1/perps/accounts/${A}/trades?limit=100&endTime=${n}`;
  await r.vt.until(Promise.all([r.client.get(trades(1)), r.client.get(trades(2))])); // the drip is full
  const t0 = r.vt.clock.t;
  const outcome = r.client.get(trades(3)).then(() => 'sent' as const, (e: unknown) => e);
  await r.vt.until(r.vt.sleep(10_000));
  assert.equal(r.calls.length, 2, 'the third waits for a slot');
  // A refusal elsewhere (another tab's read, a 1015): history closes for HISTORY_COOL.
  r.client.historyCool.hit('history');
  const e = await r.vt.until(outcome);
  assert.ok(e instanceof RateLimitedError, 'it ends as rate-limited, like a read started now would');
  assert.ok(r.vt.clock.t - t0 < 12_000, 'at its next look, not a minute later');
  assert.equal(r.calls.length, 2, 'never sent');
  assert.equal(r.client.historyDrip.spent(), 2, 'and no slot taken');
});

test('gateway: a reader that leaves drops a history read still waiting for its slot; one already sent completes and is kept', async () => {
  const r = vrig();
  const page = (n: number) => `/api/v1/spot/accounts/${A}/orders/history?limit=100&endTime=${n}`;

  // Sent, then the reader leaves: the request is not cancelled (its slot is spent).
  let answer!: (res: Response) => void;
  r.state.reply = () => new Promise<Response>((res) => (answer = res));
  const gone = new AbortController();
  const sent = r.client.get(page(1), { signal: gone.signal });
  await r.vt.until(r.vt.sleep(100));
  assert.equal(r.calls.length, 1);
  gone.abort();
  answer(ok([{ id: 7 }]));
  assert.deepEqual(await r.vt.until(sent), [{ id: 7 }]);
  assert.deepEqual(r.client.lastGood<unknown>(page(1))?.value, [{ id: 7 }], 'kept for whoever reads that page next');

  // Waiting for a slot, then the reader leaves: never sent, no slot.
  r.state.reply = () => ok([]);
  await r.vt.until(r.client.get(page(2))); // the drip is full now
  const left = new AbortController();
  const waiting = r.client.get(page(3), { signal: left.signal }).then(() => 'sent', (e: unknown) => (e as Error).name);
  await r.vt.until(r.vt.sleep(5_000));
  left.abort();
  assert.equal(await r.vt.until(waiting), 'AbortError');
  assert.equal(r.calls.length, 2);
  assert.equal(r.client.historyDrip.spent(), 2);

  // The same page asked for again is a new read, not the dropped one.
  const t1 = r.vt.clock.t;
  await r.vt.until(r.client.get(page(3)));
  assert.equal(r.calls.length, 3);
  assert.ok(r.calls[2]!.t >= 1_000_000 + HISTORY_DRIP.windowMs && r.calls[2]!.t > t1, 'sent when a slot freed');

  // Any other read is cancelled when its reader leaves, as before.
  r.state.reply = () => new Promise<Response>(() => undefined);
  const bye = new AbortController();
  const state = r.client.get(`/api/v1/perps/accounts/${A}/state`, { signal: bye.signal }).then(() => 'answered', (e: unknown) => (e as Error).name);
  await r.vt.until(r.vt.sleep(100));
  bye.abort();
  assert.equal(await r.vt.until(state), 'AbortError');
});

test('gateway: onSent tells when a read actually leaves - after its wait for a slot, not when it was asked for', async () => {
  const r = vrig();
  const trades = (n: number) => `/api/v1/perps/accounts/${A}/trades?limit=100&endTime=${n}`;
  await r.vt.until(Promise.all([r.client.get(trades(1)), r.client.get(trades(2))])); // the drip is full
  const asked = r.vt.clock.t;
  let sentAt = 0;
  await r.vt.until(r.client.get(trades(3), { onSent: () => void (sentAt = r.vt.clock.t) }));
  assert.ok(sentAt >= asked + HISTORY_DRIP.windowMs);
  assert.equal(sentAt, r.calls[2]!.t);
  // Answered from the cache: nothing was sent.
  let again = 0;
  await r.vt.until(r.client.get(trades(3), { onSent: () => void again++ }));
  assert.equal(again, 0);
  // ttlMs 0 (a table catching up): never the cached answer.
  await r.vt.until(r.client.get(trades(3), { ttlMs: 0, onSent: () => void again++ }));
  assert.equal(again, 1);
  assert.equal(r.calls.length, 4);
});

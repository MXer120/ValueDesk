/**
 * Rate limits, refusals and alerts (2026-10-28):
 *   - the per-IP gate (copy-engine sodex.ts): a 429 / Cloudflare 1015 opens one
 *     cooldown for every caller (Retry-After honoured, never retried into),
 *     opening orders wait for it while closes and stops still go, the budget
 *     keeps its last share for closes, each account stays under SoDEX's order
 *     rate, and nothing but orders, cancels and leverage is ever sent;
 *   - the guard (guard.ts): deterministic refusals hold a copy instead of
 *     repeating it, a refused key holds the whole wallet;
 *   - the alerts (alerts.ts): deduplicated, capped, no secret in them;
 *   - the HTTP layer: a self-hosted copier refuses foreign Host names (DNS
 *     rebinding) and a wallet cannot spend the SoDEX budget on key checks.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes, privateKeyToAddress } from '../../../packages/sodex-core/src/index.ts';
import {
  AccountRate,
  COPY_TERMS_VERSION,
  IpRateLimitedError,
  SendQueue,
  LocalRefusal,
  OutcomeUnknownError,
  SodexClient,
  WeightBudget,
  buildCopyRequest,
  canonicalSettings,
  copyRequestDigest,
  parseSettings,
  retryAfterMs,
  writeShape,
  type AlgoRecord,
  type AlgoSink,
  type ChildResult,
  type CopyAction,
  type FetchLike,
  type MarketInfo,
  type WebSocketLike,
} from '../../../packages/copy-engine/src/index.ts';
import { Alerts, ReachWatch, lastRunCrashed, scrub, shortWallet, telegramSender } from '../src/alerts.ts';
import { loadConfig, type ExecutorConfig } from '../src/config.ts';
import { ExecutorDb } from '../src/db.ts';
import { ErrorGuard, classifyRejection, guardedAlgoSink, type GuardHost } from '../src/guard.ts';
import { Secrets } from '../src/secrets.ts';
import { createExecutorServer, hostAllowed } from '../src/server.ts';
import { ExecutorService } from '../src/service.ts';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/* ------------------------------------------------------------ the gate ----- */

test('gate: a 429 opens one cooldown; opening writes wait for it, protective writes still go', async () => {
  const b = new WeightBudget(1200);
  const events: string[] = [];
  b.onEvent = (e) => events.push(e.kind);
  const t = Date.now();
  const ms = b.penalise('/x', null, t, () => 0.5, t);
  assert.equal(ms, 15_000, 'base 15 s (no jitter at 0.5)');
  // Requests that were already on their way get the same 429: they do not double it.
  assert.equal(b.penalise('/x', null, t + 10, () => 0.5, t - 5), 15_000 - 10);
  assert.deepEqual(events, ['rate-limited']);
  await assert.rejects(b.admitWrite(1, 'open'), (e: unknown) => e instanceof LocalRefusal && /cooling down/.test(e.message));
  await b.admitWrite(1, 'protect'); // never refused
  // A read waits at most 20 s for a cooldown; a longer one fails at once.
  b.penalise('/x', 60_000, Date.now(), () => 0.5, Date.now() + 1);
  await assert.rejects(b.take(5), (e: unknown) => e instanceof LocalRefusal);
  // An answer to a request sent before the 429 does not lift it; one sent after does.
  b.cleared(t - 1);
  assert.ok(b.cooldownLeft() > 0);
  b.cleared(Date.now() + 1);
  assert.equal(b.cooldownLeft(), 0);
  assert.deepEqual(events, ['rate-limited', 'rate-cleared']);
});

test('gate: a request sent into the ban doubles the cooldown, to 5 min at most; Retry-After wins when longer', () => {
  const b = new WeightBudget();
  let t = 1_000_000;
  const lens: number[] = [];
  for (let i = 0; i < 7; i++) {
    lens.push(b.penalise('/x', null, t, () => 0.5, t));
    t += 1;
  }
  assert.deepEqual(lens.slice(0, 3), [15_000, 30_000, 60_000]);
  assert.equal(lens.at(-1), 300_000);
  const c = new WeightBudget();
  assert.equal(c.penalise('/x', 120_000, 0, () => 0.5, 0), 120_000);
  assert.equal(retryAfterMs('7'), 7_000);
  assert.equal(retryAfterMs(new Date(Date.now() + 30_000).toUTCString())! > 25_000, true);
  assert.equal(retryAfterMs('soon'), null);
});

test('gate: the last share of the minute is kept for closes and stops', async () => {
  const b = new WeightBudget(100, 0.75, 0.9);
  b.charge(89);
  await b.admitWrite(1, 'open'); // 90 of 100
  await assert.rejects(b.admitWrite(1, 'open'), /nearly spent/);
  await b.admitWrite(1, 'protect');
  await b.admitWrite(15, 'protect'); // past the line, still sent
  assert.ok(b.used() > 100);
});

test("gate: an account's opening orders stop at 90% of SoDEX's 20/s and 600/min; closes use all of it", async () => {
  const r = new AccountRate(20, 600, 0.9);
  for (let i = 0; i < 18; i++) await r.admit(42, 1, 'open');
  await assert.rejects(r.admit(42, 1, 'open'), (e: unknown) => e instanceof LocalRefusal && e.reason === 'account-rate');
  await r.admit(7, 1, 'open'); // another account is not touched
  await r.admit(42, 2, 'protect'); // 20 this second
  const t0 = Date.now();
  await r.admit(42, 1, 'protect'); // the 21st waits for the next second rather than be refused
  assert.ok(Date.now() - t0 >= 900);
});

test('gate: what a signed write is, from its body', () => {
  assert.deepEqual(writeShape('DELETE', '/api/v1/perps/trade/orders', '{"accountID":42,"cancels":[{"symbolID":1},{"symbolID":2}]}'), { accountId: 42, orders: 2, priority: 'protect' });
  assert.deepEqual(writeShape('POST', '/api/v1/perps/trade/orders', '{"accountID":42,"symbolID":1,"orders":[{"reduceOnly":true},{"reduceOnly":true}]}'), { accountId: 42, orders: 2, priority: 'protect' });
  assert.equal(writeShape('POST', '/api/v1/perps/trade/orders', '{"accountID":42,"orders":[{"reduceOnly":true},{"reduceOnly":false}]}').priority, 'open', 'a flip (close + open) is an opening');
  assert.equal(writeShape('POST', '/api/v1/perps/trade/leverage', '{"accountID":42}').priority, 'open');
  assert.equal(writeShape('POST', '/x', 'not json').accountId, 0);
});

interface Answer {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

function scripted(answers: Answer[] | ((url: string, method: string) => Answer)): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${url.replace(/^https?:\/\/[^/]+/, '')}`);
    const a = typeof answers === 'function' ? answers(url, init?.method ?? 'GET') : answers.shift() ?? { status: 200, body: '{"code":0,"data":[]}' };
    const h = a.headers ?? {};
    return { status: a.status, ok: a.status < 300, text: async () => a.body, headers: { get: (n: string) => h[n.toLowerCase()] ?? null } };
  };
  return { fetch, calls };
}

test('client: a 429 is never retried, opens the cooldown with Retry-After; a 5xx read is retried', async () => {
  const s = scripted([{ status: 429, body: 'error code: 1015', headers: { 'retry-after': '30' } }]);
  const c = new SodexClient({ network: 'testnet', fetch: s.fetch });
  await assert.rejects(c.markPrices(), /429/);
  assert.equal(s.calls.length, 1, 'not retried into the ban');
  assert.ok(c.budget.cooldownLeft() >= 29_000 && c.budget.cooldownLeft() <= 30_000);
  // A read now fails at once (30 s > the 20 s a read may wait): nothing more is sent.
  await assert.rejects(c.markPrices(), (e: unknown) => e instanceof LocalRefusal);
  assert.equal(s.calls.length, 1);

  const t = scripted([{ status: 502, body: 'bad gateway' }, { status: 200, body: '{"code":0,"data":[]}' }]);
  const d = new SodexClient({ network: 'testnet', fetch: t.fetch });
  assert.deepEqual(await d.markPrices(), []);
  assert.equal(t.calls.length, 2);
  assert.ok(d.reach.lastOkAt > 0 && d.reach.failingSince === 0);
});

test("client: Cloudflare's 1015 page on a write is 'not executed', not an unknown outcome; only orders, cancels and leverage leave", async () => {
  const s = scripted([{ status: 429, body: '<html>error code: 1015</html>' }]);
  const c = new SodexClient({ network: 'testnet', fetch: s.fetch });
  // An opening order is never queued or sent again: its 429 goes back to the caller as 'not executed'.
  const order = { method: 'POST' as const, gatewayPath: '/api/v1/perps/trade/orders', headers: {}, body: '{"accountID":42,"orders":[{"reduceOnly":false}]}' };
  await assert.rejects(c.send(order), (e: unknown) => e instanceof IpRateLimitedError && !(e instanceof OutcomeUnknownError));
  assert.ok(c.budget.cooldownLeft() > 0);
  for (const path of ['/api/v1/perps/accounts/transfers', '/api/v1/spot/trade/orders', '/api/v1/perps/accounts/api-keys']) {
    await assert.rejects(c.send({ ...order, gatewayPath: path }), (e: unknown) => e instanceof LocalRefusal && e.reason === 'not-allowed');
  }
  await assert.rejects(c.send({ ...order, method: 'DELETE', gatewayPath: '/api/v1/perps/accounts/api-keys' }), /not an action this copier sends/);
  assert.equal(s.calls.length, 1, 'nothing else was sent');
  // While it cools down an opening order is refused locally - never sent.
  await assert.rejects(c.send({ ...order, body: '{"accountID":42,"orders":[{"reduceOnly":false}]}' }), (e: unknown) => e instanceof LocalRefusal);
  assert.equal(s.calls.length, 1);
});

test('client: no answer at all marks SoDEX unreachable', async () => {
  const c = new SodexClient({ network: 'testnet', fetch: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(c.markPrices());
  assert.ok(c.reach.failingSince > 0 && /fetch failed/.test(c.reach.lastError ?? ''));
});

/* ----------------------------------------------------------- the guard ----- */

test('guard: refusals sorted into classes', () => {
  const cases: Array<[string, string]> = [
    ['insufficient margin', 'margin'],
    ['Not enough balance to place order', 'margin'],
    ['order notional below minimum 10', 'size'],
    ['price out of range of the band', 'size'],
    ['reduce only order would increase position', 'size'],
    ['open interest cap exceeded', 'limit'],
    ['too many open orders', 'limit'],
    ['api key not found', 'key'],
    ['invalid signature', 'key'],
    ['no copy key is available', 'key'],
    ['Rate limit exceeded for address', 'account-rate'],
    ["Not sent: SoDEX's rate limit is cooling down (12 s left)", 'local'],
    ['Not sent: account 42 is at SoDEX\'s order rate (20 a second)', 'account-rate'],
    ['SoDEX rate limit (HTTP 429) - backing off', 'ip-rate'],
    ['position not found: 1', 'gone'],
    ['no position to reduce', 'gone'],
    ['order not found', 'gone'],
    ['order already filled', 'gone'],
    ['order already canceled', 'gone'],
    ['code 77', 'unknown'],
  ];
  for (const [text, want] of cases) assert.equal(classifyRejection(text), want, text);
});

function guardHarness(t0 = 1_000_000) {
  let now = t0;
  const alerts: Array<{ kind: string; ref: string }> = [];
  const held: Array<{ id: string; reason: string; until: number; wallet: boolean }> = [];
  const refused: string[] = [];
  const host: GuardHost = {
    alert: (kind, o) => alerts.push({ kind, ref: o.ref }),
    held: (t, reason, until, wallet) => held.push({ id: t.id, reason, until, wallet }),
    keyRefused: (owner) => refused.push(owner),
    now: () => now,
  };
  return { guard: new ErrorGuard(host), alerts, held, refused, tick: (ms: number) => (now += ms), now: () => now };
}

const no = (error: string) => ({ ok: false, error, outcomeUnknown: false });
const OWNER = '0x' + 'ab'.repeat(20);

test('guard: lack of margin holds that copy at once (closes go on); a second hold within a day lasts twice as long', () => {
  const h = guardHarness();
  const c = { kind: 'copy' as const, id: 'c1', owner: OWNER };
  h.guard.record(c, [no('insufficient margin')]);
  assert.equal(h.held.length, 1);
  assert.match(h.guard.holdOf(c)!, /Held for 10 min: SoDEX refused an order for lack of margin/);
  assert.equal(h.guard.holdOf({ kind: 'copy', id: 'c2', owner: OWNER }), null, 'another copy of the wallet is not held');
  assert.equal(h.alerts.length, 0, "the follower's own margin is not an operator alert");
  h.tick(10 * 60_000 + 1);
  assert.equal(h.guard.holdOf(c), null, 'it ends by itself');
  h.guard.record(c, [no('insufficient margin')]);
  assert.match(h.guard.holdOf(c)!, /Held for 20 min/);
});

test('guard: a size refusal holds after 3 within 10 minutes; a fill in between clears the count', () => {
  const h = guardHarness();
  const c = { kind: 'copy' as const, id: 'c1', owner: OWNER };
  h.guard.record(c, [no('notional below minimum')]);
  h.guard.record(c, [no('notional below minimum')]);
  h.guard.record(c, [{ ok: true, error: null, outcomeUnknown: false }]);
  h.guard.record(c, [no('notional below minimum')]);
  assert.equal(h.held.length, 0);
  h.guard.record(c, [no('notional below minimum'), no('notional below minimum')]);
  assert.equal(h.held.length, 1);
});

test('guard: an unknown refusal is an alert each time (deduplicated by Alerts) and holds after 5; no answer and the local gate hold nothing', () => {
  const h = guardHarness();
  const c = { kind: 'copy' as const, id: 'c1', owner: OWNER };
  for (let i = 0; i < 4; i++) h.guard.record(c, [no('code 77')]);
  h.guard.record(c, [{ ok: false, error: 'SoDEX did not answer', outcomeUnknown: true }]);
  h.guard.record(c, [no("Not sent: SoDEX's rate limit is cooling down")]);
  h.guard.record(c, [no('SoDEX rate limit (HTTP 429)')]);
  assert.equal(h.held.length, 0);
  h.guard.record(c, [no('code 77')]);
  assert.equal(h.held.length, 1);
  assert.equal(h.alerts.filter((a) => a.kind === 'order-rejected').length, 5);
  assert.equal(h.alerts.filter((a) => a.kind === 'sub-held').length, 1);
});

test('guard: "position not found" (a close of a position already gone) is no alert and holds nothing, however often (ValueDesk 2026-10-30: three Telegram alerts "for a reason the executor does not know")', () => {
  const h = guardHarness();
  const c = { kind: 'copy' as const, id: 'c3l01', owner: OWNER };
  const a = { kind: 'algo' as const, id: 'a2j6p', owner: OWNER };
  for (let i = 0; i < 10; i++) {
    h.guard.record(c, [no('position not found: 1')]);
    h.guard.record(a, [no('position not found: 1')]);
    h.guard.recordError(a, new Error('order already canceled'));
  }
  assert.equal(h.alerts.length, 0, 'no operator alert');
  assert.equal(h.held.length, 0, 'nothing held');
  assert.equal(h.guard.holdOf(c), null);
});

test('guard: a refused key holds every copy and algo of the wallet and asks for the key to be checked again', () => {
  const h = guardHarness();
  h.guard.record({ kind: 'algo', id: 'a1', owner: OWNER }, [no('api key not found')]);
  assert.deepEqual(h.refused, [OWNER]);
  assert.equal(h.held[0]!.wallet, true);
  assert.ok(h.guard.holdOf({ kind: 'copy', id: 'c9', owner: OWNER }));
  assert.ok(h.guard.holdOf({ kind: 'algo', id: 'a2', owner: OWNER }));
  assert.equal(h.guard.holdOf({ kind: 'copy', id: 'c9', owner: '0x' + 'cd'.repeat(20) }), null);
  assert.ok(h.alerts.some((a) => a.kind === 'key-refused'));
  // Algos hold themselves on margin and limits (algo/runtime.ts): the guard leaves those to them.
  h.guard.record({ kind: 'algo', id: 'a3', owner: '0x' + 'cd'.repeat(20) }, [no('insufficient margin')]);
  assert.equal(h.held.length, 1);
});

test("guard: an algo's order the local gate refused is tried again once the cooldown allows, not counted as refused", async () => {
  const h = guardHarness();
  let n = 0;
  const inner = {
    paper: false,
    place: async (): Promise<ChildResult[]> => (++n < 3 ? [{ clOrdID: 'x', ok: false, orderId: null, error: "Not sent: SoDEX's rate limit is cooling down (1 s left)", outcomeUnknown: false }] : [{ clOrdID: 'x', ok: true, orderId: '9', error: null, outcomeUnknown: false }]),
  } as unknown as AlgoSink;
  const sink = guardedAlgoSink(inner, h.guard, { cooldownLeft: () => 0 }, 10_000);
  const out = await sink.place({ id: 'a1', owner: OWNER } as AlgoRecord, {} as MarketInfo, []);
  assert.equal(n, 3);
  assert.equal(out[0]!.ok, true);
  // With no time left to wait it gives up and answers the refusal.
  n = -100;
  const quick = guardedAlgoSink(inner, h.guard, { cooldownLeft: () => 0 }, 0);
  assert.equal((await quick.place({ id: 'a1', owner: OWNER } as AlgoRecord, {} as MarketInfo, []))[0]!.ok, false);
});

/* ----------------------------------------------------------- the alerts ----- */

function alertHarness(perHour = 30) {
  let now = 5_000_000;
  const sent: string[] = [];
  const alerts = new Alerts({ sender: async (t) => (sent.push(t), true), label: 'test-exec (testnet)', now: () => now, perHour });
  return { alerts, sent, tick: (ms: number) => (now += ms) };
}

test('alerts: one message per kind and subject in 10 minutes, then one count of the rest', () => {
  const h = alertHarness();
  h.alerts.raise('order-rejected', 'copy:c1', 'one');
  h.alerts.raise('order-rejected', 'copy:c1', 'two');
  h.alerts.raise('order-rejected', 'copy:c1', 'three');
  h.alerts.raise('order-rejected', 'copy:c2', 'other copy');
  assert.equal(h.sent.length, 2);
  h.tick(10 * 60_000);
  h.alerts.flush();
  assert.equal(h.sent.length, 3);
  assert.match(h.sent[2]!, /x 2 more in the last 10 min[\s\S]*three/);
  h.alerts.raise('order-rejected', 'copy:c1', 'later');
  assert.equal(h.sent.length, 4, 'a new window');
});

test('alerts: at most 30 an hour, then one muted note, and the count of what was dropped when the hour is over', () => {
  const h = alertHarness(30);
  for (let i = 0; i < 40; i++) h.alerts.raise('sub-held', `copy:c${i}`, `held ${i}`);
  assert.equal(h.sent.length, 31);
  assert.match(h.sent[30]!, /^ℹ️ INFO · Alerts muted/);
  h.tick(61 * 60_000);
  h.alerts.flush();
  assert.match(h.sent.at(-1)!, /^ℹ️ INFO · Alerts on again[\s\S]*10 alert\(s\) were not sent/);
});

test('alerts: the first line says what it is - a failure, back to normal, or a brake set by hand', () => {
  const h = alertHarness();
  h.alerts.raise('order-rejected', 'copy:c1', 'no margin');
  h.alerts.raise('sodex-up', '', 'SoDEX answers again.');
  h.alerts.raise('brake-on', '', 'Copies held.');
  h.alerts.raise('crash-restart', '', 'last run did not stop cleanly');
  assert.deepEqual(h.sent.map((t) => t.split('\n')[0]), [
    '🚨 FAILURE · Order refused - test-exec (testnet)',
    '✅ RECOVERED · SoDEX reachable again - test-exec (testnet)',
    '🛑 BRAKE · BRAKE ON - test-exec (testnet)',
    '🚨 FAILURE · STARTED AFTER A CRASH - test-exec (testnet)',
  ]);
  h.alerts.raise('order-rejected', 'copy:c1', 'again');
  h.tick(10 * 60_000);
  h.alerts.flush();
  assert.match(h.sent.at(-1)!, /^🚨 FAILURE · Order refused - test-exec \(testnet\)\nx 1 more/, 'the count of repeats keeps the label');
});

test('alerts: no secret, no full wallet in a message; off without a well-formed token and chat', async () => {
  const wallet = '0x' + '1234567890'.repeat(4);
  const text = scrub(`wallet ${wallet} key 0x${'ab'.repeat(32)} sig 0x${'cd'.repeat(65)} token 123456789:${'A'.repeat(35)} session ${'aB3'.repeat(14)}x`);
  assert.ok(!text.includes(wallet) && text.includes(shortWallet(wallet)));
  assert.ok(!/ab{0}abababababababab/.test(text) && !text.includes('ab'.repeat(32)) && !text.includes('cd'.repeat(65)));
  assert.ok(!text.includes('A'.repeat(35)) && !text.includes('aB3'.repeat(14)));
  assert.equal(telegramSender({ token: null, chatId: '1' }), null);
  assert.equal(telegramSender({ token: 'not-a-token', chatId: '1' }), null);
  assert.equal(telegramSender({ token: `123:${'a'.repeat(30)}`, chatId: 'drop table' }), null);
  const seen: Array<{ url: string; body: unknown }> = [];
  const fake = (async (url: string, init: { body: string }) => {
    seen.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ ok: true }) };
  }) as unknown as typeof fetch;
  const send = telegramSender({ token: `123:${'a'.repeat(30)}`, chatId: '-1001' }, fake)!;
  assert.equal(await send('hello'), true);
  assert.equal(seen[0]!.url, `https://api.telegram.org/bot123:${'a'.repeat(30)}/sendMessage`);
  assert.deepEqual(seen[0]!.body, { chat_id: '-1001', text: 'hello', disable_web_page_preview: true });
  const failing = telegramSender({ token: `123:${'a'.repeat(30)}`, chatId: '1' }, (async () => { throw new Error('down'); }) as unknown as typeof fetch)!;
  assert.equal(await failing('x'), false, 'never throws');
  const off = new Alerts({ sender: null, label: 'x' });
  off.raise('fatal', '', 'nothing happens');
  assert.equal(off.sent.length, 0);
});

test('alerts: SoDEX unreachable for 3 minutes, and back; a start after a crash', () => {
  const h = alertHarness();
  const w = new ReachWatch(h.alerts, 3 * 60_000);
  const t = 10_000_000;
  w.check({ lastOkAt: 0, failingSince: t, lastError: 'fetch failed' }, t + 60_000);
  assert.equal(h.sent.length, 0);
  w.check({ lastOkAt: 0, failingSince: t, lastError: 'fetch failed' }, t + 3 * 60_000);
  w.check({ lastOkAt: 0, failingSince: t, lastError: 'fetch failed' }, t + 4 * 60_000);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!, /SoDEX UNREACHABLE/);
  w.check({ lastOkAt: t + 5 * 60_000, failingSince: 0, lastError: null }, t + 5 * 60_000);
  assert.match(h.sent[1]!, /SoDEX reachable again/);

  const db = new ExecutorDb(':memory:');
  assert.equal(lastRunCrashed(db), null);
  db.audit('process', null, null, { event: 'start' });
  db.audit('process', null, null, { event: 'stop', why: 'SIGTERM' });
  assert.equal(lastRunCrashed(db), null);
  db.audit('process', null, null, { event: 'start' });
  assert.match(lastRunCrashed(db)!, /ended without stopping/);
  db.audit('process', null, null, { event: 'stop', why: 'uncaught exception' });
  assert.match(lastRunCrashed(db)!, /uncaught exception/);
  db.close();
});

/* ------------------------------------------------------------ the HTTP layer ----- */

test('self-hosted: loopback names and IP literals pass the Host check; any other name is refused unless allowed', () => {
  for (const h of ['127.0.0.1:8799', 'localhost:8799', 'LOCALHOST', '[::1]:8799', 'app.localhost', '192.168.1.20:8799', undefined]) assert.equal(hostAllowed(h, []), true, String(h));
  for (const h of ['evil.example', 'evil.example:8799', '127.0.0.1.nip.io', 'localhost.evil.example', '[::1]evil']) assert.equal(hostAllowed(h, []), false, h);
  assert.equal(hostAllowed('copier.lan:8799', ['copier.lan']), true);
});

function raw(port: number, path: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path, method: o.method ?? 'GET', headers: o.headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    r.on('error', reject);
    r.end(o.body);
  });
}

test('HTTP: a self-hosted copier answers 421 to a foreign Host; key checks are capped per wallet', async () => {
  let verifies = 0;
  const svc = {
    info: () => ({ ok: true }),
    health: () => ({ ok: true }),
    audit: () => undefined,
    authenticate: (t: string | null) => (t === 'tok' ? OWNER : (() => { throw new Error('no'); })()),
    verifyKey: async () => (verifies++, null),
  } as unknown as ExecutorService;
  const cfg = { kind: 'self', allowedOrigins: [], originSecrets: [], allowedHosts: [] } as unknown as ExecutorConfig;
  const server = createExecutorServer(svc, cfg, silent);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    assert.equal(await raw(port, '/api/copy/v1/info', { headers: { Host: 'rebind.attacker.example' } }), 421);
    assert.equal(await raw(port, '/api/copy/v1/info', { headers: { Host: `127.0.0.1:${port}` } }), 200);
    const codes: number[] = [];
    for (let i = 0; i < 13; i++) codes.push(await raw(port, '/api/copy/v1/keys/verify', { method: 'POST', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: '{}' }));
    assert.deepEqual(codes.slice(0, 12), Array(12).fill(200));
    assert.equal(codes[12], 429);
    assert.equal(verifies, 12, 'the 13th never reached SoDEX');
  } finally {
    server.close();
  }
});

/* ------------------------------------------------------- the service, whole ----- */

class Wallet {
  readonly pk = secp256k1.utils.randomPrivateKey();
  readonly address = privateKeyToAddress(this.pk).toLowerCase();
  sign(executor: string, action: CopyAction, payload: unknown) {
    const r = buildCopyRequest({ action, owner: this.address, executor, payload, chainId: 42161, now: Date.now() });
    const sig = secp256k1.sign(hexToBytes(copyRequestDigest(r)), this.pk);
    const out = new Uint8Array(65);
    out.set(sig.toCompactRawBytes(), 0);
    out[64] = 27 + sig.recovery;
    return { ...r, signature: bytesToHex(out) };
  }
}

const LEADER = '0x1111111111111111111111111111111111111111';
const TERMS = { termsVersion: COPY_TERMS_VERSION, termsHash: `0x${'ab'.repeat(32)}`, country: 'SG', adult: true, notUsPerson: true, ownDecision: true, risksUnderstood: true };
const noWs = (): WebSocketLike => ({ readyState: 0, send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null });

test('service: a live copy SoDEX refuses for margin is held (blocked, with the reason); an idle key is wiped from memory', async () => {
  const keys: Record<string, Array<{ name: string; publicKey: string; expiresAt: number }>> = {};
  const sentOrders: string[] = [];
  const ok = (data: unknown) => ({ status: 200, ok: true, text: async () => JSON.stringify({ code: 0, data }) });
  const fetch: FetchLike = async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (init?.method === 'POST' && path === '/api/v1/perps/trade/orders') {
      sentOrders.push(String(init.body));
      const body = JSON.parse(String(init.body)) as { orders: Array<{ clOrdID: string }> };
      return ok(body.orders.map((o) => ({ clOrdID: o.clOrdID, code: 1001, error: 'insufficient margin' })));
    }
    if (path.endsWith('/markets/symbols') || path.endsWith('/markets/mark-prices')) return ok([]);
    let m = /\/perps\/accounts\/(0x[0-9a-f]{40})\/api-keys$/.exec(path);
    if (m) return ok(keys[m[1]!] ?? []);
    m = /\/user\/(0x[0-9a-f]{40})\/subaccounts$/.exec(path);
    if (m) return ok({ primaryAccountID: 42 });
    if (/\/state$/.test(path)) return ok({ aid: 42, av: '1000', am: '1000', P: [] });
    if (/\/builders$/.test(path)) return ok({ perps: [{ builderID: 234812, feeRate: 25 }], spot: [] });
    return { status: 404, ok: false, text: async () => '{"code":404,"message":"not found"}' };
  };
  const dir = mkdtempSync(join(tmpdir(), 'vd-limits-'));
  const cfg = loadConfig({ EXECUTOR_DATA_DIR: dir, EXECUTOR_EDGE: 'none', EXECUTOR_KIND: 'hosted', EXECUTOR_BRAKE_FILE: 'none' });
  const db = new ExecutorDb(':memory:');
  const raised: string[] = [];
  const alerts = new Alerts({ sender: async (t) => (raised.push(t), true), label: 't' });
  const svc = new ExecutorService(cfg, db, new Secrets(dir), { fetch, factory: noWs, log: silent, alerts });
  try {
    await svc.start();
    const w = new Wallet();
    const ctx = { viewerCountry: 'SG' };
    svc.acceptTerms(w.sign(svc.executorId, 'accept-terms', TERMS), ctx);
    const k = svc.createKey(w.sign(svc.executorId, 'create-key', { accountId: 42, days: 30 }), ctx);
    keys[w.address] = [{ name: k.name, publicKey: k.address, expiresAt: Date.now() + 30 * 86_400_000 }];
    const settings = canonicalSettings(parseSettings({ leader: { venue: 'sodex', address: LEADER }, paper: false }));
    const v = await svc.subscribe(w.sign(svc.executorId, 'subscribe', { settings, termsVersion: COPY_TERMS_VERSION }), ctx);
    const sub = svc.runtime.get(v.subscription.id)!;
    const sink = (svc as unknown as { sinkFor(s: typeof sub): import('../../../packages/copy-engine/src/index.ts').OrderSink }).sinkFor(sub);
    const market = { id: 1, name: 'BTC-USD', maxLeverage: 20 } as unknown as MarketInfo;
    const intent = { clOrdID: 'vd1', side: 'buy', quantity: '0.001', limitPrice: '100000', reduceOnly: false, symbol: 'BTC-USD', leg: 'open', notionalUsd: 100 };
    const r = await sink.place(42, market, [intent as never], null, 100_000);
    assert.equal(r[0]!.ok, false);
    assert.equal(sentOrders.length, 1);
    await new Promise((res) => setTimeout(res, 50));
    const now = svc.runtime.get(sub.id)!;
    assert.equal(now.status, 'blocked');
    assert.match(now.statusReason ?? '', /^Held for 10 min: SoDEX refused an order for lack of margin/);
    assert.ok(db.auditRows({ kind: 'hold' }).length === 1, 'the hold is in the audit log');
    assert.ok(!raised.some((t) => /Held after errors/.test(t)), "a follower's margin is not an operator alert");

    // The opened key: wiped (zeroed) when the executor stops - never left in memory.
    const ref = (svc as unknown as { signer(o: string): { privateKey: Uint8Array } }).signer(w.address);
    assert.ok(ref.privateKey.some((b) => b !== 0));
    await svc.stop();
    assert.ok(ref.privateKey.every((b) => b === 0));
  } finally {
    await svc.stop().catch(() => undefined);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------ the send queue ----- */

/** A queue on a fresh budget whose minute is full until `freeInMs` from now. */
function queueHarness(perMinute = 1200, freeInMs = 0) {
  const budget = new WeightBudget(perMinute);
  if (freeInMs) budget.charge(perMinute, Date.now() - 60_000 + freeInMs);
  const rate = new AccountRate();
  return { budget, rate, q: new SendQueue(budget, rate) };
}

test('queue: cancels, then stops and closes, then leverage leave first; one account keeps its own order', async () => {
  const { q } = queueHarness(10, 300);
  const order: string[] = [];
  const job = (name: string) => async () => {
    order.push(name);
    return name;
  };
  const all = [
    q.submit('leverage', 1, 1, job('A1 leverage')),
    q.submit('protect', 2, 1, job('B close')),
    q.submit('protect', 1, 1, job('A2 stop')),
    q.submit('cancel', 3, 1, job('C cancel')),
    q.submit('protect', 1, 1, job('A3 close')),
  ];
  assert.equal(q.stats().waiting, 5, 'the minute is full: they wait, none is refused');
  // An opening order while closes wait: refused at once, never queued.
  await assert.rejects(q.submit('open', 4, 1, job('D open')), (e: unknown) => e instanceof LocalRefusal && /Not sent: SoDEX's rate limit is reached; closes and stops go first/.test(e.message));
  await Promise.all(all);
  assert.deepEqual(order, ['C cancel', 'B close', 'A1 leverage', 'A2 stop', 'A3 close']);
  assert.ok(!order.includes('D open'));
  assert.equal(q.stats().waiting, 0);
});

test("queue: an account's next write waits for the answer to the one before", async () => {
  const { q } = queueHarness();
  let release!: () => void;
  const log: string[] = [];
  const first = q.submit('cancel', 1, 1, () => new Promise<void>((r) => (release = () => (log.push('cancel done'), r()))));
  const second = q.submit('protect', 1, 1, async () => void log.push('replace sent'));
  const other = q.submit('protect', 2, 1, async () => void log.push('other account'));
  await other;
  assert.deepEqual(log, ['other account'], 'another account is not held up');
  release();
  await Promise.all([first, second]);
  assert.deepEqual(log, ['other account', 'cancel done', 'replace sent']);
});

test('queue: with budget free, protective writes drain at once (not one a second)', async () => {
  const { q } = queueHarness(1200, 200);
  let n = 0;
  const jobs = Array.from({ length: 60 }, (_, i) => q.submit('protect', 100 + i, 1, async () => void n++));
  const t0 = Date.now();
  await Promise.all(jobs);
  assert.equal(n, 60);
  assert.ok(Date.now() - t0 < 1_500, `${Date.now() - t0} ms`);
  // A free budget and an empty queue: an opening order leaves at once.
  assert.equal(await q.submit('open', 999, 1, async () => 'sent'), 'sent');
});

test('queue: a 429 sends the item again once the ban is over - one probe at a time, no storm; nothing is lost', async () => {
  const { q, budget } = queueHarness();
  let calls = 0;
  let banned = true;
  const job = (name: string) => async () => {
    calls++;
    if (banned) {
      budget.penalise('/api/v1/perps/trade/orders', null, Date.now(), Math.random, Date.now());
      throw new IpRateLimitedError('/api/v1/perps/trade/orders');
    }
    budget.cleared(Date.now());
    return name;
  };
  const items = [q.submit('protect', 1, 1, job('a')), q.submit('protect', 2, 1, job('b')), q.submit('cancel', 3, 1, job('c'))];
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(calls, 1, 'the first 429 stops the rest: no request is sent into the ban');
  assert.equal(q.stats().waiting, 3, 'the refused one is back in the queue');
  assert.ok(q.stats().cooldownMs > 0);
  await assert.rejects(q.submit('open', 9, 1, job('open')), /closes and stops go first/);
  await new Promise((r) => setTimeout(r, 2_300));
  assert.equal(calls, 2, 'one probe after 2 s');
  banned = false;
  const out = await Promise.all(items);
  assert.deepEqual(out.sort(), ['a', 'b', 'c']);
  assert.ok(q.stats().resent >= 2);
});

test('queue: any answer but a 429 goes back to the caller - never sent twice', async () => {
  const { q } = queueHarness();
  let calls = 0;
  await assert.rejects(q.submit('protect', 1, 1, async () => { calls++; throw new OutcomeUnknownError('no answer'); }), OutcomeUnknownError);
  await assert.rejects(q.submit('protect', 1, 1, async () => { calls++; throw new Error('reduce only order would increase position'); }), /reduce only/);
  assert.equal(calls, 2);
});

test('queue: closes waiting over 10 s are reported once (the alert); health shows the queue', async () => {
  const { q, budget } = queueHarness();
  const events: unknown[] = [];
  q.onEvent = (e) => events.push(e);
  budget.penalise('/x', 120_000, Date.now(), Math.random, Date.now() + 1);
  const realNow = Date.now;
  (q as unknown as { probing: boolean }).probing = true; // a probe on its way: nothing else leaves
  const pending = q.submit('protect', 1, 1, async () => 'x').catch(() => 'never');
  try {
    Date.now = () => realNow() + 11_000;
    await new Promise((r) => setTimeout(r, 1_200));
    assert.equal(events.length, 1);
    assert.equal((events[0] as { kind: string }).kind, 'queue-slow');
    assert.ok(q.stats().oldestMs >= 10_000 && q.stats().byClass.protect === 1);
  } finally {
    Date.now = realNow;
    (q as unknown as { probing: boolean }).probing = false;
    budget.cleared(Date.now() + 1);
  }
  assert.equal(await pending, 'x');
});

test('alerts: every alert is in the executor log, scrubbed, also with no Telegram configured (a self-hosted copier; the live suite reads it)', () => {
  const logged: Array<{ msg: string; data?: Record<string, unknown> }> = [];
  const alerts = new Alerts({ sender: null, label: 'self-hosted copier (mainnet)', log: { warn: (msg, data) => logged.push({ msg, data }) } });
  alerts.raise('order-rejected', 'copy:c1', `Copy c1: SoDEX refused an order for a reason the executor does not know: code 77 0x${'ab'.repeat(32)}`);
  assert.equal(logged.length, 1);
  assert.equal(logged[0]!.msg, 'alert');
  assert.equal(logged[0]!.data!.kind, 'order-rejected');
  assert.match(String(logged[0]!.data!.text), /code 77/);
  assert.doesNotMatch(String(logged[0]!.data!.text), /abababab/, 'long hex cut out');
});

/**
 * Client error reports (routes/reports.ts, ops/clientErrors.ts): what is checked,
 * what is kept and what never is, the limits, the alert to the owner, the owner's
 * tool; the scrub they share with the web; the Telegram sender (ops/telegram.ts);
 * how the hosted gate treats the report routes. Feedback itself: feedback.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import Fastify from 'fastify';

import { DEFAULT_LIMITS, installHostedGate, type HostedConfig } from '../src/hosted.js';
import { KeyedLimiter } from '../src/rateLimit.js';
import { REPORT_LIMITS, reportRoutes, type ReportRouteOptions } from '../src/routes/reports.js';
import { ALERTS_PER_DAY, ClientErrorStore, parseBatch } from '../src/ops/clientErrors.js';
import { FeedbackStore } from '../src/ops/feedbackThreads.js';
import { TELEGRAM_MAX_CHARS, sendTelegram, telegramText } from '../src/ops/telegram.js';
import {
  browserFamily, errorFingerprint, framesFromStack, scrubFrame, scrubRoute, scrubText,
} from '../src/ops/scrub.js';
import { tempDir } from './builderFakes.js';

const DIR = tempDir('vs-reports-');
const SITE = 'https://www.valuedesk.so';
const WALLET = '0x04fb1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b';
let caseNo = 0;

async function appFor(o: Partial<ReportRouteOptions> & { hosted?: boolean } = {}) {
  const dir = join(DIR, `case-${caseNo++}`);
  const sent: string[] = [];
  const store = o.errorStore ?? new ClientErrorStore(join(dir, 'client-errors.db'));
  const app = Fastify();
  await app.register(reportRoutes, {
    feedbackStore: new FeedbackStore(join(dir, 'feedback.db')),
    errorStore: store,
    limiter: o.limiter ?? new KeyedLimiter(),
    limits: o.limits,
    owner: o.owner ?? { message: async (t: string) => (sent.push(t), sent.length), photo: async () => null },
    now: o.now,
  });
  if (o.hosted) {
    const cfg: HostedConfig = { enabled: true, trustProxy: false, originSecrets: [], limits: DEFAULT_LIMITS };
    installHostedGate(app, { cfg, site: [SITE] });
  }
  await app.ready();
  return { app, sent, store };
}

const post = (app: Awaited<ReturnType<typeof appFor>>['app'], url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, payload: typeof payload === 'string' ? payload : JSON.stringify(payload), headers: { 'content-type': 'application/json', origin: SITE, ...headers } });

const flush = () => new Promise((r) => setImmediate(r));

// --- the scrub -----------------------------------------------------------------------------

test('scrub: no address, key, e-mail, query, origin, long number or typed text survives', () => {
  const s = scrubText(
    `Failed for ${WALLET} sig 0x${'ab'.repeat(65)} at https://www.valuedesk.so/scan?address=${WALLET}#x ` +
      `token eyJhbGciOiJIUzI1NiJ9abcdefGHIJKLmnop1234 mail me@example.com amount 1234567.89 "my secret note typed into the box"`,
  );
  for (const bad of [WALLET.slice(2), 'ab'.repeat(20), 'valuedesk.so', 'address=', 'eyJhbGci', 'me@example.com', '1234567', 'secret note']) {
    assert.ok(!s.includes(bad), `${bad} leaked: ${s}`);
  }
  assert.match(s, /\/scan/);
  assert.ok(scrubText('x'.repeat(5000)).length <= 300);
  // A message stays readable.
  assert.equal(scrubText("Cannot read properties of undefined (reading 'map')"), "Cannot read properties of undefined (reading 'map')");
});

test('scrub: frames are function + path + line, from V8 and Firefox stacks', () => {
  const v8 = `TypeError: x is undefined\n    at renderRow (https://www.valuedesk.so/assets/Portfolio-AbC123de.js?v=2:10:5)\n    at https://www.valuedesk.so/assets/index-ZZ99yy11.js:1:200\n    at <anonymous>`;
  assert.deepEqual(framesFromStack(v8), ['renderRow /assets/Portfolio-AbC123de.js:10:5', '/assets/index-ZZ99yy11.js:1:200']);
  const ff = `renderRow@https://www.valuedesk.so/assets/Portfolio-AbC123de.js:10:5\n@https://www.valuedesk.so/assets/index-ZZ99yy11.js:1:200`;
  assert.deepEqual(framesFromStack(ff), ['renderRow /assets/Portfolio-AbC123de.js:10:5', '/assets/index-ZZ99yy11.js:1:200']);
  assert.ok(framesFromStack(Array(40).fill('at f (https://a.b/c.js:1:1)').join('\n')).length <= 10);
  assert.equal(scrubFrame(`f https://x.y/a.js?addr=${WALLET}:1:2`), 'f /a.js:1:2');
});

test('scrub: a route keeps its words, loses its variable parts', () => {
  assert.equal(scrubRoute(`/scan?address=${WALLET}`), '/scan');
  assert.equal(scrubRoute(`/scan/${WALLET}/x`), '/scan/:address/x');
  assert.equal(scrubRoute('/copy/12345/Ünicode'), '/copy/:id/:id');
  assert.equal(scrubRoute(42), '/');
});

test('scrub: the browser is a family and a major version, never the user agent', () => {
  assert.equal(browserFamily('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.70 Safari/537.36'), 'chrome 130');
  assert.equal(browserFamily('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0.2849.56'), 'edge 130');
  assert.equal(browserFamily('Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0'), 'firefox 131');
  assert.equal(browserFamily('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'), 'safari 18 mobile');
  assert.equal(browserFamily(undefined), 'other');
});

test('fingerprint: the same error across builds and lines, a different one apart', () => {
  const a = { kind: 'error', name: 'TypeError', message: 'x is undefined at row 12', frames: ['renderRow /assets/Portfolio-AbC123de.js:10:5'] };
  const b = { ...a, message: 'x is undefined at row 7', frames: ['renderRow /assets/Portfolio-QwE987rt.js:11:9'] };
  assert.equal(errorFingerprint(a), errorFingerprint(b));
  assert.notEqual(errorFingerprint(a), errorFingerprint({ ...a, name: 'RangeError' }));
  assert.match(errorFingerprint(a), /^[0-9a-f]{16}$/);
});

// --- client errors ------------------------------------------------------------------------------

const batch = (over: Record<string, unknown> = {}) => ({
  build: 'commit-abc123',
  route: `/scan?address=${WALLET}`,
  browser: 'chrome 130',
  errors: [{ kind: 'error', name: 'TypeError', message: `x is undefined for ${WALLET}`, frames: ['renderRow /assets/Portfolio-AbC123de.js:10:5'], count: 3 }],
  ...over,
});

test('client errors: counted per fingerprint, scrubbed again on arrival, one alert for a new one', async () => {
  const { app, sent, store } = await appFor();
  assert.equal((await post(app, '/api/vs/client-errors', batch())).statusCode, 200);
  // The same error from a later build, sent as text/plain the way sendBeacon sends it.
  const again = batch({ build: 'commit-def456', errors: [{ kind: 'error', name: 'TypeError', message: `x is undefined for ${WALLET}`, frames: ['renderRow /assets/Portfolio-QwE987rt.js:12:5'], count: 2 }] });
  assert.equal((await post(app, '/api/vs/client-errors', again, { 'content-type': 'text/plain;charset=UTF-8' })).statusCode, 200);
  await flush();
  const rows = store.top();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.count, 5);
  assert.equal(rows[0]!.reports, 2);
  assert.equal(rows[0]!.lastBuild, 'commit-def456');
  assert.equal(rows[0]!.lastRoute, '/scan');
  assert.ok(!JSON.stringify(rows).includes(WALLET.slice(2)), 'no address stored');
  assert.equal(sent.length, 1, 'one alert, for the first sighting only');
  assert.match(sent[0]!, /new client error \(error\)/);
  assert.ok(!sent[0]!.includes(WALLET.slice(2)));
  assert.match(sent[0]!, new RegExp(rows[0]!.fp));
});

test('client errors: a boundary keeps its name; refused - wrong kind, too many, not JSON, too big', async () => {
  const { app, store } = await appFor();
  const b = batch({ errors: [{ kind: 'boundary', name: 'Error', message: 'boom', frames: [], boundary: 'Portfolio', count: 1 }] });
  assert.equal((await post(app, '/api/vs/client-errors', b)).statusCode, 200);
  assert.equal(store.top()[0]!.boundary, 'Portfolio');
  const bad = async (payload: unknown, status = 400) => assert.equal((await post(app, '/api/vs/client-errors', payload, { 'content-type': 'text/plain' })).statusCode, status);
  await bad(batch({ errors: [{ kind: 'warning', message: 'x' }] }));
  await bad(batch({ errors: [] }));
  await bad(batch({ errors: Array(11).fill({ kind: 'error', message: 'x' }) }));
  await bad('{not json');
  await bad(batch({ errors: [{ kind: 'error', message: 'x', frames: Array(10).fill('y'.repeat(1000)) }] }), 413);
  // Counts are capped, frames cut.
  const p = parseBatch(batch({ errors: [{ kind: 'error', message: 'x', count: 1e9, frames: Array(30).fill('f /a.js:1:1') }] }));
  assert.ok(p.ok && p.batch.errors[0]!.count === 1000 && p.batch.errors[0]!.frames.length === 10);
});

test('client errors: alerts are capped per day for all fingerprints together', async () => {
  const { app, sent } = await appFor({ limits: { ...REPORT_LIMITS, errors: { max: 1000, windowMs: 60_000 } } });
  for (let i = 0; i < ALERTS_PER_DAY + 5; i++) {
    const r = await post(app, '/api/vs/client-errors', batch({ errors: [{ kind: 'error', name: `E${'abcdefghijklmnopqrstuvwxyz'[i]}${i}`, message: 'distinct', count: 1 }] }));
    assert.equal(r.statusCode, 200);
  }
  await flush();
  assert.equal(sent.length, ALERTS_PER_DAY);
});

test('client errors: the store keeps at most its cap, the longest unseen first out', () => {
  const store = new ClientErrorStore(join(DIR, `cap-${caseNo++}.db`), { maxRows: 3 });
  for (let i = 0; i < 5; i++) {
    const p = parseBatch(batch({ errors: [{ kind: 'error', name: `E${'abcde'[i]}`, message: 'm', count: 1 }] }));
    assert.ok(p.ok);
    store.record(p.batch, 1_000 + i);
  }
  const names = store.top({ order: 'recent' }).map((r) => r.name);
  assert.deepEqual(names, ['Ee', 'Ed', 'Ec']);
  store.close();
});

test('client errors: a client is limited per minute', async () => {
  const { app } = await appFor();
  for (let i = 0; i < REPORT_LIMITS.errors.max; i++) assert.equal((await post(app, '/api/vs/client-errors', batch())).statusCode, 200);
  assert.equal((await post(app, '/api/vs/client-errors', batch())).statusCode, 429);
});

// --- through the hosted gate ---------------------------------------------------------------------

test('hosted: both need the site Origin; a GET is a 404', async () => {
  const { app } = await appFor({ hosted: true });
  const auth = { authorization: `Bearer ${'T'.repeat(43)}` };
  assert.equal((await post(app, '/api/vs/feedback', { category: 'bug', message: 'hello there' }, auth)).statusCode, 200);
  assert.equal((await post(app, '/api/vs/feedback', { category: 'bug', message: 'hello there' }, { ...auth, origin: 'https://evil.example' })).statusCode, 403);
  assert.equal((await post(app, '/api/vs/feedback/poll', { tokens: [] }, { origin: 'https://evil.example' })).statusCode, 403);
  assert.equal((await post(app, '/api/vs/client-errors', batch(), { origin: 'https://evil.example' })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/api/vs/feedback' })).statusCode, 404);
});

// --- Telegram ----------------------------------------------------------------------------------------

test('telegram: off without both variables, plain text, capped, and never throws', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response('{"ok":true,"result":{"message_id":7}}', { status: 200 });
  }) as unknown as typeof fetch;
  const token = '123456:' + 'A'.repeat(35);
  assert.equal(await sendTelegram('hi', { token: '', chatId: '1', fetch: fake }), false);
  assert.equal(await sendTelegram('hi', { token, chatId: '', fetch: fake }), false);
  assert.equal(await sendTelegram('hi', { token: 'not a token/../x', chatId: '1', fetch: fake }), false);
  assert.equal(calls.length, 0);
  assert.equal(await sendTelegram(`a\u0000b\n${'x'.repeat(5000)}`, { token, chatId: '-100', fetch: fake }), true);
  assert.equal(calls[0]!.url, `https://api.telegram.org/bot${token}/sendMessage`);
  assert.equal(calls[0]!.body.parse_mode, undefined);
  assert.equal(calls[0]!.body.disable_web_page_preview, true);
  assert.equal((calls[0]!.body.text as string).length, TELEGRAM_MAX_CHARS);
  assert.ok((calls[0]!.body.text as string).startsWith('ab\n'));
  assert.equal(telegramText('ok\ttab'), 'ok\ttab');
  const throwing = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
  assert.equal(await sendTelegram('hi', { token, chatId: '1', fetch: throwing }), false);
  const status500 = (async () => new Response('no', { status: 500 })) as unknown as typeof fetch;
  assert.equal(await sendTelegram('hi', { token, chatId: '1', fetch: status500 }), false);
  const hanging = ((_u: string, init: RequestInit) => new Promise((_r, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
  const t0 = Date.now();
  assert.equal(await sendTelegram('hi', { token, chatId: '1', fetch: hanging, timeoutMs: 50 }), false);
  assert.ok(Date.now() - t0 < 2000);
});

// --- the owner's tool ------------------------------------------------------------------------------

test('tools/client-errors.ts: top, show and clear', async () => {
  const { runTool } = await import('../tools/client-errors.js');
  const path = join(DIR, `cli-${caseNo++}.db`);
  assert.equal(runTool(['top'], { path }).code, 1, 'no database yet');
  const s = new ClientErrorStore(path);
  const now = 1_800_000_000_000;
  for (const [name, count] of [['TypeError', 9], ['RangeError', 2]] as const) {
    const p = parseBatch(batch({ errors: [{ kind: 'error', name, message: `bad ${name}`, frames: ['f /assets/a.js:1:2'], count }] }));
    assert.ok(p.ok);
    s.record(p.batch, now - 3_600_000);
  }
  s.close();
  const top = runTool(['top', '--days', '1'], { path, now });
  assert.equal(top.code, 0);
  assert.ok(top.text.indexOf('TypeError') < top.text.indexOf('RangeError'), 'most counted first');
  assert.match(top.text, /1h ago/);
  const rows = JSON.parse(runTool(['top', '--json'], { path, now }).text) as Array<{ fp: string; name: string }>;
  assert.equal(rows.length, 2);
  assert.match(runTool(['show', rows[0]!.fp], { path, now }).text, /at f \/assets\/a\.js:1:2/);
  assert.equal(runTool(['show', 'nothex'], { path }).code, 2);
  assert.equal(runTool(['top', '--days', 'x'], { path }).code, 2);
  assert.equal(runTool(['clear', rows[0]!.fp], { path }).code, 0);
  assert.equal(JSON.parse(runTool(['top', '--json'], { path, now }).text).length, 1);
  assert.equal(runTool(['clear', '--all'], { path }).text, 'cleared 1 error');
  assert.equal(runTool(['nonsense'], { path }).code, 2);
});

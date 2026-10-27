/**
 * Feedback as a chat (routes/reports.ts, ops/feedback*.ts, ops/telegramReplies.ts):
 * the thread token as the only key to a thread, what a message may carry and
 * what is refused (a private key, a seed phrase), screenshots judged by their
 * bytes (a polyglot, a renamed file), the forward to Telegram as one reply chain
 * per thread, and the owner's replies read back from Telegram.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateSync } from 'node:zlib';
import { join } from 'node:path';
import Fastify from 'fastify';

import { KeyedLimiter } from '../src/rateLimit.js';
import { REPORT_LIMITS, reportRoutes, type OwnerChannel, type ReportRouteOptions } from '../src/routes/reports.js';
import { FeedbackStore, bearer, tokenHash } from '../src/ops/feedbackThreads.js';
import { parseFeedback } from '../src/ops/feedback.js';
import { findSecret } from '../src/ops/secrets.js';
import { checkImage } from '../src/ops/imageCheck.js';
import { pollReplies, repliesEnabled } from '../src/ops/telegramReplies.js';
import { tempDir } from './builderFakes.js';

const DIR = tempDir('vs-feedback-');
const SITE = 'https://www.valuedesk.so';
const WALLET = '0x04fb1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b';
const TOKEN_A = 'A'.repeat(20) + 'a_b-c'.repeat(4) + 'xyz';
const TOKEN_B = 'B'.repeat(43);
const CHAT = '-1001234';
let caseNo = 0;

// --- images, made by hand -------------------------------------------------------------------

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
function png(w = 4, h = 3, extra: Buffer[] = []): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(Math.min(h, 4) * (1 + Math.min(w, 4) * 3)); // the header decides; the pixels are not read
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...extra, chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function jpeg(w = 16, h = 9): Buffer {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]), sof, Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0]), Buffer.alloc(64, 0x55), Buffer.from([0xff, 0xd9])]);
}
function webp(w = 10, h = 20): Buffer {
  const v = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14);
  const data = Buffer.concat([Buffer.from([0x2f]), Buffer.from([v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]), Buffer.alloc(5)]);
  const body = Buffer.concat([Buffer.from('WEBPVP8L', 'latin1'), Buffer.from([data.length, 0, 0, 0]), data]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), size, body]);
}

test('images: PNG, JPEG and WebP by their bytes, with their dimensions', () => {
  assert.deepEqual(checkImage(png(4, 3)), { ok: true, kind: 'png', width: 4, height: 3 });
  assert.deepEqual(checkImage(jpeg(16, 9)), { ok: true, kind: 'jpeg', width: 16, height: 9 });
  assert.deepEqual(checkImage(webp(10, 20)), { ok: true, kind: 'webp', width: 10, height: 20 });
});

test('images: a polyglot, a renamed file, markup inside, a cut file, impossible sizes - all refused', () => {
  const bad = (b: Buffer, why: RegExp) => {
    const r = checkImage(b);
    assert.ok(!r.ok && why.test(r.error), `${r.ok ? 'accepted' : r.error}`);
  };
  bad(Buffer.concat([png(), Buffer.from('<script>alert(1)</script>')]), /after the end of the PNG/);
  bad(Buffer.concat([jpeg(), Buffer.from('PK\u0003\u0004zip')]), /after the end of the JPEG/);
  bad(Buffer.concat([webp(), Buffer.from('<?php system($_GET[1]); ?>')]), /after the end of the WebP/);
  bad(png(4, 3, [chunk('tEXt', Buffer.from('Comment\u0000<script src=//x></script>'))]), /something other than an image/);
  bad(Buffer.from('<html><body>hello, I am "screenshot.png"</body></html>'), /only PNG, JPEG and WebP/);
  bad(Buffer.from('GIF89a' + 'x'.repeat(40)), /only PNG, JPEG and WebP/);
  bad(png().subarray(0, 40), /cut short/);
  bad(png(0, 3), /impossible dimensions/);
  bad(png(20_000, 20_000), /impossible dimensions/);
  bad(Buffer.alloc(3 * 1024 * 1024, 1), /larger than 2 MB/);
});

// --- secrets ---------------------------------------------------------------------------------

test('secrets: a private key or a seed phrase is refused; a transaction link and ordinary words pass', () => {
  assert.equal(findSecret(`my key is 0x${'ab12'.repeat(16)}`), 'private-key');
  assert.equal(findSecret(`${'9f'.repeat(32)} please help`), 'private-key');
  assert.equal(findSecret('xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi'), 'private-key');
  assert.equal(findSecret('abandon ability able about above absent absorb abstract absurd abuse access accident'), 'seed-phrase');
  assert.equal(findSecret('1. abandon 2. ability 3. able 4. about 5. above 6. absent 7. absorb 8. abstract 9. absurd 10. abuse 11. access 12. accident'), 'seed-phrase');
  assert.equal(findSecret(`see https://arbiscan.io/tx/0x${'ab12'.repeat(16)}`), null);
  assert.equal(findSecret(`address ${WALLET} shows the wrong balance`), null);
  assert.equal(findSecret('When I open the copy page and switch to hosted mode the table about my orders is empty for a while'), null);
  const r = parseFeedback({ message: `here: ${'9f'.repeat(32)}` });
  assert.ok(!r.ok && r !== null && (r as { code?: string }).code === 'secret');
});

test('the page info is projected: known fields, checked, cut - nothing else gets through', () => {
  const r = parseFeedback({
    message: 'hello',
    context: {
      route: `/scan/${WALLET}?x=1`, build: 'commit-abc', browser: 'chrome 130', os: 'windows', viewport: '1440x900', dpr: 1.25,
      lang: 'de-DE', timeZone: 'Europe/Berlin', sockets: 'hub open · sodex open', walletConnected: true, modes: ['hosted', 'hosted', 'evil'],
      errors: ['0123456789abcdef', 'nothex'], element: { path: 'main > div.panel', role: 'button', label: `Send 1234567 to ${WALLET}`, panel: 'Positions' },
      userAgent: 'Mozilla/5.0 the full thing', cookies: 'a=b',
    },
  });
  assert.ok(r.ok === true);
  const c = r.feedback.context!;
  assert.equal(c.route, '/scan/:address');
  assert.deepEqual(c.modes, ['hosted']);
  assert.deepEqual(c.errors, ['0123456789abcdef']);
  assert.ok(!c.element!.label!.includes(WALLET.slice(2)) && !c.element!.label!.includes('1234567'));
  assert.ok(!('userAgent' in c) && !('cookies' in c));
  assert.equal(parseFeedback({ message: 'x', wallet: 'not an address' }).ok, false);
  assert.equal(parseFeedback({ message: 'x', contact: '@me' }).ok, false, 'the contact field is gone');
});

// --- the routes --------------------------------------------------------------------------------

interface Sent { kind: 'message' | 'photo'; text: string; replyTo: number | null; id: number }

async function appFor(o: Partial<ReportRouteOptions> = {}) {
  const dir = join(DIR, `case-${caseNo++}`);
  const store = new FeedbackStore(join(dir, 'feedback.db'));
  const sent: Sent[] = [];
  let next = 100;
  const owner: OwnerChannel = {
    message: async (text, replyTo) => (sent.push({ kind: 'message', text, replyTo, id: ++next }), next),
    photo: async (_b, _t, caption, replyTo) => (sent.push({ kind: 'photo', text: caption, replyTo, id: ++next }), next),
  };
  const forwards: Array<Promise<void>> = [];
  const app = Fastify();
  await app.register(reportRoutes, {
    feedbackStore: store,
    limiter: o.limiter ?? new KeyedLimiter(),
    limits: o.limits,
    owner: o.owner ?? owner,
    onForward: (p: Promise<void>) => forwards.push(p),
    now: o.now,
  });
  await app.ready();
  const settled = () => Promise.all(forwards);
  return { app, store, sent, settled, dir };
}

type App = Awaited<ReturnType<typeof appFor>>['app'];
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const post = (app: App, url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, payload: JSON.stringify(payload), headers: { 'content-type': 'application/json', origin: SITE, ...headers } });
const upload = (app: App, bytes: Buffer, token = TOKEN_A, type = 'application/octet-stream') =>
  app.inject({ method: 'POST', url: '/api/vs/feedback/upload', payload: bytes, headers: { 'content-type': type, origin: SITE, ...auth(token) } });

test('threads: the token is the key - none or a malformed one is a 401, another token sees nothing', async () => {
  const { app } = await appFor();
  assert.equal((await post(app, '/api/vs/feedback', { message: 'hi' })).statusCode, 401);
  assert.equal((await post(app, '/api/vs/feedback', { message: 'hi' }, { authorization: 'Bearer short' })).statusCode, 401);
  assert.equal((await post(app, '/api/vs/feedback', { message: 'hi' }, { authorization: TOKEN_A })).statusCode, 401, 'Bearer, exactly');
  const r = await post(app, '/api/vs/feedback', { category: 'bug', message: 'The chart froze' }, auth(TOKEN_A));
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  const mine = await post(app, '/api/vs/feedback/thread', {}, auth(TOKEN_A));
  assert.deepEqual((mine.json() as { messages: Array<{ from: string; text: string }> }).messages.map((m) => [m.from, m.text]), [['user', 'The chart froze']]);
  assert.equal((await post(app, '/api/vs/feedback/thread', {}, auth(TOKEN_B))).statusCode, 404);
  assert.equal((await post(app, '/api/vs/feedback/thread', {})).statusCode, 401);
  // A token in the URL is no token.
  assert.equal((await app.inject({ method: 'POST', url: `/api/vs/feedback/thread?token=${TOKEN_A}`, payload: '{}', headers: { 'content-type': 'application/json' } })).statusCode, 401);
  assert.equal(bearer(`Bearer ${TOKEN_A}`), TOKEN_A);
});

test('threads: only the token\'s hash is stored', async () => {
  const { app, dir } = await appFor();
  await post(app, '/api/vs/feedback', { message: 'secret-free text' }, auth(TOKEN_A));
  const { readFileSync, readdirSync } = await import('node:fs');
  const raw = readdirSync(dir).filter((f) => f.startsWith('feedback.db')).map((f) => readFileSync(join(dir, f)).toString('latin1')).join('');
  assert.ok(!raw.includes(TOKEN_A), 'the token itself is nowhere on disk');
  assert.ok(raw.includes(tokenHash(TOKEN_A)));
});

test('forward: one Telegram chain per thread, follow-ups and screenshots as replies to it', async () => {
  const { app, sent, settled } = await appFor();
  const ctx = { route: '/trade', build: 'commit-abc', browser: 'chrome 130', walletConnected: false, element: { path: 'div.panel > button', role: 'button', label: 'Buy', panel: 'Order entry' } };
  await post(app, '/api/vs/feedback', { category: 'bug', message: 'Buy does nothing', context: ctx, wallet: WALLET }, auth(TOKEN_A));
  await settled();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.replyTo, null);
  assert.match(sent[0]!.text, /^ValueDesk feedback \(bug\) · thread #1/);
  assert.match(sent[0]!.text, /Element \[Order entry\] div\.panel > button "Buy" \(button\)/);
  assert.match(sent[0]!.text, new RegExp(`Wallet ${WALLET}`));
  assert.match(sent[0]!.text, /Reply to this message/);
  const a = (await upload(app, png())).json() as { id: string };
  const b = (await upload(app, jpeg())).json() as { id: string };
  await post(app, '/api/vs/feedback', { message: 'Here is how it looks', images: [a.id, b.id] }, auth(TOKEN_A));
  await settled();
  assert.deepEqual(sent.slice(1).map((s) => [s.kind, s.replyTo]), [['message', 101], ['photo', 102], ['photo', 102]]);
  assert.match(sent[1]!.text, /^Thread #1 · the visitor wrote/);
  // Another browser, another chain.
  await post(app, '/api/vs/feedback', { message: 'Hello' }, auth(TOKEN_B));
  await settled();
  assert.equal(sent.at(-1)!.replyTo, null);
  assert.match(sent.at(-1)!.text, /thread #2/);
});

test('owner replies: only the owner\'s chat, only replies to a thread\'s message; the offset is kept', async () => {
  const { app, store, settled } = await appFor();
  await post(app, '/api/vs/feedback', { message: 'Is hosted copy down?' }, auth(TOKEN_A));
  await settled();
  const calls: Array<Record<string, unknown>> = [];
  const updates = [
    { update_id: 500, message: { message_id: 900, chat: { id: -999 }, text: 'a stranger', reply_to_message: { message_id: 101 } } },
    { update_id: 501, message: { message_id: 901, chat: { id: Number(CHAT) }, text: 'not a reply' } },
    { update_id: 502, message: { message_id: 902, chat: { id: Number(CHAT) }, text: 'reply to something else', reply_to_message: { message_id: 55 } } },
    { update_id: 503, message: { message_id: 903, chat: { id: Number(CHAT) }, text: 'It is back up - sorry!', reply_to_message: { message_id: 101 } } },
  ];
  let round = 0;
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, ...(JSON.parse(String(init.body)) as object) });
    return new Response(JSON.stringify({ ok: true, result: round++ === 0 ? updates : [] }), { status: 200 });
  }) as unknown as typeof fetch;
  const o = { token: '123456:' + 'A'.repeat(35), chatId: CHAT, fetch: fake, timeoutS: 0 };
  assert.deepEqual(await pollReplies(store, o), { ok: true, stored: 1 });
  assert.deepEqual(await pollReplies(store, o), { ok: true, stored: 0 });
  assert.equal(calls[0]!.offset, 0);
  assert.equal(calls[1]!.offset, 504, 'the next round starts after the last update');
  assert.ok(String(calls[0]!.url).endsWith('/getUpdates'));
  const poll = await post(app, '/api/vs/feedback/poll', { tokens: [TOKEN_A, TOKEN_B] });
  assert.deepEqual((poll.json() as { threads: unknown[] }).threads.map((t) => (t as { owner: number } | null)?.owner ?? null), [1, null]);
  const thread = (await post(app, '/api/vs/feedback/thread', {}, auth(TOKEN_A))).json() as { messages: Array<{ from: string; text: string }> };
  assert.deepEqual(thread.messages.map((m) => [m.from, m.text]), [['user', 'Is hosted copy down?'], ['owner', 'It is back up - sorry!']]);
  // The owner may answer the answer: a reply to their own message lands in the same thread.
  assert.equal(store.threadForTg(903), 1);
  // A restart reads the offset back.
  const again = new FeedbackStore(join(DIR, 'reopen.db'));
  assert.equal(again.getMeta('tg_offset'), null);
  assert.equal(store.getMeta('tg_offset'), '504');
  assert.equal(repliesEnabled({ ALERT_TELEGRAM_TOKEN: o.token, ALERT_TELEGRAM_CHAT_ID: CHAT }, true), true);
  assert.equal(repliesEnabled({ ALERT_TELEGRAM_TOKEN: o.token, ALERT_TELEGRAM_CHAT_ID: CHAT, VALUESCAN_FEEDBACK_REPLIES: '0' }, true), false);
  assert.equal(repliesEnabled({ ALERT_TELEGRAM_TOKEN: o.token, ALERT_TELEGRAM_CHAT_ID: CHAT }, false), false);
  assert.equal(repliesEnabled({ ALERT_TELEGRAM_TOKEN: '', ALERT_TELEGRAM_CHAT_ID: '' }, true), false);
  const failing = (async () => new Response('{"ok":false,"error_code":409}', { status: 409 })) as unknown as typeof fetch;
  assert.deepEqual(await pollReplies(store, { ...o, fetch: failing }), { ok: false, stored: 0 });
});

test('screenshots: checked bytes, three per message, back only to the token, with safe headers', async () => {
  const { app } = await appFor();
  const ok = await upload(app, png(), TOKEN_A, 'image/png');
  assert.equal(ok.statusCode, 200);
  const id = (ok.json() as { id: string }).id;
  assert.match(id, /^[0-9a-f]{24}$/);
  // A page named and typed as an image is still a page.
  assert.equal((await upload(app, Buffer.from('<html>hi</html>'.padEnd(64, ' ')), TOKEN_A, 'image/png')).statusCode, 400);
  assert.equal((await upload(app, Buffer.concat([png(), Buffer.from('<script>x</script>')]))).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/vs/feedback/upload', payload: png(), headers: { 'content-type': 'application/octet-stream' } })).statusCode, 401);
  assert.equal((await upload(app, Buffer.alloc(2 * 1024 * 1024 + 10, 1))).statusCode, 413);
  await upload(app, jpeg());
  await upload(app, webp());
  assert.equal((await upload(app, png())).statusCode, 409, 'a fourth pending screenshot');
  const get = (token: string) => app.inject({ method: 'GET', url: `/api/vs/feedback/image?id=${id}`, headers: auth(token) });
  const mine = await get(TOKEN_A);
  assert.equal(mine.statusCode, 200);
  assert.equal(mine.headers['content-type'], 'image/png');
  assert.equal(mine.headers['x-content-type-options'], 'nosniff');
  assert.match(String(mine.headers['content-disposition']), /^inline; filename="screenshot\.png"$/);
  assert.match(String(mine.headers['content-security-policy']), /default-src 'none'/);
  assert.ok(Buffer.from(mine.rawPayload).equals(png()));
  assert.equal((await get(TOKEN_B)).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/api/vs/feedback/image?id=${id}` })).statusCode, 401);
  // Sent with a message: still the token's, through its thread.
  await post(app, '/api/vs/feedback', { message: 'see image', images: [id] }, auth(TOKEN_A));
  assert.equal((await get(TOKEN_A)).statusCode, 200);
  // Another token cannot attach it.
  await post(app, '/api/vs/feedback', { message: 'stealing', images: [id] }, auth(TOKEN_B));
  const theirs = (await post(app, '/api/vs/feedback/thread', {}, auth(TOKEN_B))).json() as { messages: Array<{ images: string[] }> };
  assert.deepEqual(theirs.messages[0]!.images, []);
});

test('screenshots never sent are removed after an hour', async () => {
  const { store } = await appFor();
  const img = store.addImage(TOKEN_A, { kind: 'png', width: 4, height: 3 }, png(), 1_000);
  assert.ok(store.image(TOKEN_A, img.id));
  assert.equal(store.sweep(1_000 + 61 * 60_000), 1);
  assert.equal(store.image(TOKEN_A, img.id), null);
});

test('messages: a secret is refused in red words, a bot is answered and dropped, limits per client', async () => {
  let t = 1_800_000_000_000;
  const { app, sent, settled } = await appFor({ now: () => t });
  const r = await post(app, '/api/vs/feedback', { message: `key ${'ab'.repeat(32)}` }, auth(TOKEN_A));
  assert.equal(r.statusCode, 400);
  assert.equal((r.json() as { code: string }).code, 'secret');
  assert.equal((await post(app, '/api/vs/feedback', { message: 'cheap watches', website: 'http://spam' }, auth(TOKEN_A))).statusCode, 200);
  await settled();
  assert.equal(sent.length, 0);
  assert.equal((await post(app, '/api/vs/feedback/thread', {}, auth(TOKEN_A))).statusCode, 404, 'nothing was kept');
  for (let i = 2; i < REPORT_LIMITS.feedback.max; i++) assert.equal((await post(app, '/api/vs/feedback', { message: `m${i}` }, auth(TOKEN_A))).statusCode, 200);
  assert.equal((await post(app, '/api/vs/feedback', { message: 'one too many' }, auth(TOKEN_A))).statusCode, 429);
  t += REPORT_LIMITS.feedback.windowMs;
  assert.equal((await post(app, '/api/vs/feedback', { message: 'later' }, auth(TOKEN_A))).statusCode, 200);
  assert.equal((await post(app, '/api/vs/feedback/poll', { tokens: Array(11).fill(TOKEN_A) })).statusCode, 400);
  assert.equal((await post(app, '/api/vs/feedback/poll', { tokens: ['short'] })).statusCode, 400);
});

test('Telegram failing never changes the answer', async () => {
  const down: OwnerChannel = { message: () => Promise.reject(new Error('down')), photo: () => new Promise(() => {}) };
  const { app } = await appFor({ owner: down });
  assert.equal((await post(app, '/api/vs/feedback', { message: 'still kept' }, auth(TOKEN_A))).statusCode, 200);
});

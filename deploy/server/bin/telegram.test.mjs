// node --test deploy/server/bin/telegram.test.mjs
//
// The Telegram sender with a stand-in fetch: nothing leaves the machine, and the
// token is made up for each run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiBase, checkSettings, recentChats, scrub, sendTelegram } from './telegram.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = `7${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}:${randomBytes(27).toString('base64url')}`;

/** A fetch that answers like Telegram and records what it was asked. */
function fakeFetch(answer = { ok: true, result: { message_id: 1 } }, status = 200) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (answer instanceof Error) throw answer;
    return { ok: status >= 200 && status < 300, status, json: async () => answer };
  };
  f.calls = calls;
  return f;
}

test('a message goes to sendMessage of the bot, as plain text, cut to the limit', async () => {
  const fetchImpl = fakeFetch();
  const r = await sendTelegram({ token: TOKEN, chatId: '-1001234567890', text: `x${'y'.repeat(5000)}`, fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  const body = fetchImpl.calls[0].body;
  assert.equal(body.chat_id, '-1001234567890');
  assert.equal(body.parse_mode, undefined, 'no markup: a note can never break the message');
  assert.ok(body.text.length <= 4000 && body.text.endsWith('(cut)'));
});

test('errors never carry the token', async () => {
  const leaky = new Error(`connect failed for https://api.telegram.org/bot${TOKEN}/sendMessage`);
  const r1 = await sendTelegram({ token: TOKEN, chatId: '42', text: 'hi', fetchImpl: fakeFetch(leaky) });
  assert.equal(r1.ok, false);
  assert.ok(!r1.error.includes(TOKEN), r1.error);
  const r2 = await sendTelegram({ token: TOKEN, chatId: '42', text: 'hi', fetchImpl: fakeFetch({ ok: false, description: `Unauthorized ${TOKEN}` }, 401) });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /Telegram answered 401/);
  assert.ok(!r2.error.includes(TOKEN), r2.error);
  assert.ok(!scrub(`bot${TOKEN}`, '').includes(TOKEN), 'even without being told the token, its shape is removed');
});

test('settings are checked before anything is sent', async () => {
  assert.match(checkSettings('', '1'), /not set/);
  assert.match(checkSettings('nonsense', '1'), /does not look like a bot token/);
  assert.match(checkSettings(TOKEN, ''), /CHAT_ID is not set/);
  assert.match(checkSettings(TOKEN, 'not a chat'), /not a chat id/);
  assert.equal(checkSettings(TOKEN, '@valuedesk_alerts'), null);
  const fetchImpl = fakeFetch();
  const r = await sendTelegram({ token: TOKEN, chatId: '', text: 'hi', fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(fetchImpl.calls.length, 0);
  assert.throws(() => apiBase('http://example.com'), /must be https/);
  assert.equal(apiBase('http://127.0.0.1:9999/'), 'http://127.0.0.1:9999');
  assert.equal(apiBase(''), 'https://api.telegram.org');
});

test('the chats that wrote to the bot are listed once each, for the setup', async () => {
  const fetchImpl = fakeFetch({
    ok: true,
    result: [
      { update_id: 1, message: { chat: { id: 111, type: 'private', first_name: 'Owner', username: 'owner' } } },
      { update_id: 2, message: { chat: { id: 111, type: 'private', first_name: 'Owner', username: 'owner' } } },
      { update_id: 3, my_chat_member: { chat: { id: -100222, type: 'group', title: 'ValueDesk alerts' } } },
    ],
  });
  const r = await recentChats({ token: TOKEN, fetchImpl });
  assert.equal(r.ok, true);
  assert.deepEqual(r.chats, [
    { id: '111', kind: 'private', name: 'Owner (@owner)' },
    { id: '-100222', kind: 'group', name: 'ValueDesk alerts' },
  ]);
  assert.match(fetchImpl.calls[0].url, /\/getUpdates$/);
});

test('the command line refuses to run without settings and prints no token', () => {
  const r = spawnSync(process.execPath, [join(HERE, 'telegram.mjs'), 'send', 'hello'], {
    encoding: 'utf8', env: { ...process.env, ALERT_TELEGRAM_TOKEN: '', ALERT_TELEGRAM_CHAT_ID: '' },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not sent: ALERT_TELEGRAM_TOKEN is not set/);
  const u = spawnSync(process.execPath, [join(HERE, 'telegram.mjs'), 'bogus'], { encoding: 'utf8' });
  assert.equal(u.status, 2);
});

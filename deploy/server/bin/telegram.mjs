#!/usr/bin/env node
// Telegram messages for the operations scripts: the health check's alerts, the
// off-server backup's failures, the off-box uptime watcher (.github/workflows/uptime.yml)
// and the one-time setup (telegram-setup.sh). Node's own fetch, no package.
//
//   node telegram.mjs send "text"     one message (the text may also come on stdin: send -)
//   node telegram.mjs send --kind=failure "text"   the same, its first line labelled (LABELS below)
//   node telegram.mjs chats           the chats that wrote to the bot lately (getUpdates):
//                                     id, kind, name - for finding the chat id once
//
// SETTINGS (environment): ALERT_TELEGRAM_TOKEN (the bot's token from @BotFather) and
// ALERT_TELEGRAM_CHAT_ID (the chat the bot writes to). On a server they are in
// /etc/valuescan/alert.env (root 0600; systemd hands them to the units that alert).
// ALERT_TELEGRAM_API replaces https://api.telegram.org - for the tests only, and only
// with another https:// address or a loopback http:// one.
//
// THE TOKEN IS A SECRET: it is part of every request's URL, so it is never logged -
// every error message passes through scrub() before anybody sees it. A message itself
// must never carry a secret either; the callers send check names and short notes.
//
// WHAT A MESSAGE IS, on its first line (owner, 2026-10-29: "for TG I need to know the difference
// between maintenance caused and actual failure"). Every operations message starts with one of:
//   🔧 MAINTENANCE  planned work - a release (ship.sh), a brake set --maintenance: expected, it goes on by itself
//   🛑 BRAKE        trading stopped by hand (brake.sh on): an operator's decision, not planned work
//   🚨 FAILURE      something broke that nobody planned: look at it
//   ✅ RECOVERED    back to normal after a failure or a brake
//   ℹ️ INFO          about the alerts themselves (muted, on again)
// The copy executor's alerts (apps/executor/src/alerts.ts) use the same five. The API's own messages
// (feedback, client errors, status commands: apps/server/src/ops/telegram.ts) are not alerts and stay as they are.
//
// As a module: import { labelled, sendTelegram } from './telegram.mjs'.

const DEFAULT_API = 'https://api.telegram.org';
const TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;
const CHAT_RE = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;
// Telegram's limit is 4096 characters per message.
const MAX_TEXT = 4000;

export const LABELS = Object.freeze({
  maintenance: '🔧 MAINTENANCE',
  brake: '🛑 BRAKE',
  failure: '🚨 FAILURE',
  recovered: '✅ RECOVERED',
  info: 'ℹ️ INFO',
});

/** "🚨 FAILURE · text": the label of `kind` (a key of LABELS) before the text. */
export function labelled(kind, text) {
  const label = LABELS[kind];
  if (!label) throw new Error(`unknown kind "${kind}" (${Object.keys(LABELS).join(', ')})`);
  return `${label} · ${String(text ?? '').trim()}`;
}

/** The API base: https only, or plain http on loopback (the tests' stand-in). */
export function apiBase(value) {
  const v = String(value ?? '').trim().replace(/\/+$/, '') || DEFAULT_API;
  let u;
  try {
    u = new URL(v);
  } catch {
    throw new Error('ALERT_TELEGRAM_API is not a URL');
  }
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error('ALERT_TELEGRAM_API must be https:// (or http:// on loopback for tests)');
  return v;
}

/** Removes the token (and anything shaped like one) from a text meant for a log. */
export function scrub(text, token) {
  let s = String(text ?? '');
  if (token) s = s.split(token).join('<token>');
  return s.replace(/bot\d{5,}:[A-Za-z0-9_-]{20,}/g, 'bot<token>').replace(/\b\d{5,}:[A-Za-z0-9_-]{30,}\b/g, '<token>');
}

export function checkSettings(token, chatId) {
  if (!token) return 'ALERT_TELEGRAM_TOKEN is not set';
  if (!TOKEN_RE.test(token)) return 'ALERT_TELEGRAM_TOKEN does not look like a bot token (digits, a colon, then letters)';
  if (chatId !== undefined) {
    if (!chatId) return 'ALERT_TELEGRAM_CHAT_ID is not set';
    if (!CHAT_RE.test(chatId)) return 'ALERT_TELEGRAM_CHAT_ID is not a chat id (a number, or @channelname)';
  }
  return null;
}

async function call(method, payload, { token, api, timeoutMs, fetchImpl }) {
  const url = `${apiBase(api)}/bot${token}/${method}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
      signal: ctrl.signal,
    });
    let body = null;
    try {
      body = await res.json();
    } catch { /* not JSON */ }
    if (!res.ok || body?.ok !== true) {
      return { ok: false, status: res.status, error: scrub(`Telegram answered ${res.status}${body?.description ? `: ${body.description}` : ''}`, token).slice(0, 300) };
    }
    return { ok: true, status: res.status, result: body.result };
  } catch (e) {
    const why = e?.name === 'AbortError' ? `no answer within ${Math.round(timeoutMs / 1000)} s` : String(e?.cause?.code ?? e?.message ?? e);
    return { ok: false, status: 0, error: scrub(`Telegram could not be reached (${why})`, token).slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One message. Never throws: { ok, error? }. The text is cut to Telegram's limit;
 * no markup (parse_mode is not set), so nothing in a note can break the message.
 */
export async function sendTelegram({ token, chatId, text, api, timeoutMs = 10_000, fetchImpl = globalThis.fetch } = {}) {
  const bad = checkSettings(token, String(chatId ?? ''));
  if (bad) return { ok: false, error: bad };
  let t = String(text ?? '').trim();
  if (!t) return { ok: false, error: 'empty message' };
  if (t.length > MAX_TEXT) t = `${t.slice(0, MAX_TEXT - 20)}\n... (cut)`;
  try {
    return await call('sendMessage', { chat_id: String(chatId), text: t, disable_web_page_preview: true }, { token, api, timeoutMs, fetchImpl });
  } catch (e) {
    return { ok: false, error: scrub(String(e?.message ?? e), token) };
  }
}

/** The chats in the bot's pending updates (someone wrote to it): [{id, kind, name}]. */
export async function recentChats({ token, api, timeoutMs = 15_000, fetchImpl = globalThis.fetch } = {}) {
  const bad = checkSettings(token);
  if (bad) return { ok: false, error: bad, chats: [] };
  const r = await call('getUpdates', { timeout: 0, allowed_updates: ['message', 'channel_post', 'my_chat_member'] }, { token, api, timeoutMs, fetchImpl });
  if (!r.ok) return { ...r, chats: [] };
  const seen = new Map();
  for (const u of r.result ?? []) {
    const chat = u.message?.chat ?? u.channel_post?.chat ?? u.my_chat_member?.chat;
    if (!chat || chat.id === undefined) continue;
    const name = chat.title ?? [chat.first_name, chat.last_name].filter(Boolean).join(' ') ?? '';
    seen.set(String(chat.id), { id: String(chat.id), kind: chat.type ?? '?', name: `${name}${chat.username ? ` (@${chat.username})` : ''}`.trim() });
  }
  return { ok: true, chats: [...seen.values()] };
}

// --- command line ----------------------------------------------------------------------------------
const isMain = Boolean(process.argv[1]) && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const kind = args.find((a) => a.startsWith('--kind='))?.slice(7);
  const arg = args.slice(1).find((a) => !a.startsWith('--kind='));
  const token = (process.env.ALERT_TELEGRAM_TOKEN ?? '').trim();
  const chatId = (process.env.ALERT_TELEGRAM_CHAT_ID ?? '').trim();
  const api = process.env.ALERT_TELEGRAM_API;
  if (cmd === 'send') {
    let text = arg ?? '';
    if (text === '-') {
      text = '';
      for await (const chunk of process.stdin) text += chunk;
    }
    let r;
    if (kind !== undefined && !LABELS[kind]) r = { ok: false, error: `unknown --kind "${kind}" (${Object.keys(LABELS).join(', ')})` };
    else r = await sendTelegram({ token, chatId, text: kind && text.trim() ? labelled(kind, text) : text, api });
    if (!r.ok) {
      console.error(`telegram: not sent: ${r.error}`);
      process.exitCode = 1;
    } else console.error('telegram: sent');
  } else if (cmd === 'chats') {
    const r = await recentChats({ token, api });
    if (!r.ok) {
      console.error(`telegram: ${r.error}`);
      process.exitCode = 1;
    } else if (!r.chats.length) {
      console.error('telegram: nobody wrote to the bot lately - send it a message (any text) in Telegram, then run this again');
      process.exitCode = 3;
    } else {
      for (const c of r.chats) console.log(`${c.id}\t${c.kind}\t${c.name}`);
    }
  } else {
    console.error('usage: telegram.mjs send [--kind=maintenance|brake|failure|recovered|info] "text" | send - (text on stdin) | chats');
    process.exitCode = 2;
  }
}

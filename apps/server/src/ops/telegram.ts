/**
 * Telegram, the owner's channel: the feedback form's messages and screenshots,
 * new client errors (routes/reports.ts), and the owner's replies, read back by
 * long polling (ops/telegramReplies.ts).
 *
 * Configured by ALERT_TELEGRAM_TOKEN (a bot's token, from @BotFather) and
 * ALERT_TELEGRAM_CHAT_ID (the chat the bot writes to). Either one unset: nothing
 * is sent and the caller carries on - the reports are on disk either way.
 *
 * NEVER THROWS, NEVER HANGS. A report must not fail because Telegram is slow or
 * down, so every send is a short-timeout fetch whose every failure is a `false`.
 * Plain text only (no parse_mode): what a visitor typed can never become markup
 * or a link preview in the owner's chat. The token is never logged - it is part
 * of the request URL, so not even the URL is.
 */

export interface TelegramOptions {
  token?: string;
  chatId?: string;
  /** Test seam. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Telegram's own limit is 4096 characters; the rest is cut with a mark. */
export const TELEGRAM_MAX_CHARS = 4000;
const TIMEOUT_MS = 5_000;

const env = (k: string): string => process.env[k]?.trim() ?? '';

/** Whether a send would be attempted at all. */
export const telegramConfigured = (o: TelegramOptions = {}): boolean => !!((o.token ?? env('ALERT_TELEGRAM_TOKEN')) && (o.chatId ?? env('ALERT_TELEGRAM_CHAT_ID')));

/** The text as sent: control characters out (newlines and tabs stay), at most TELEGRAM_MAX_CHARS. */
export function telegramText(text: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return clean.length > TELEGRAM_MAX_CHARS ? `${clean.slice(0, TELEGRAM_MAX_CHARS - 1)}…` : clean;
}

const TOKEN_RE = /^\d{1,20}:[A-Za-z0-9_-]{20,80}$/;

/**
 * One Bot API call: its `result`, or null for every failure (not configured, a
 * malformed token, a timeout, an HTTP error, `ok: false`). JSON bodies, or a
 * FormData for a photo. `chat_id` is added here, always the configured chat.
 */
export async function telegramCall<T = unknown>(method: string, body: Record<string, unknown> | FormData, o: TelegramOptions = {}): Promise<T | null> {
  const token = o.token ?? env('ALERT_TELEGRAM_TOKEN');
  const chatId = o.chatId ?? env('ALERT_TELEGRAM_CHAT_ID');
  // A token is "<digits>:<letters, digits, _ and ->"; anything else would change the URL's meaning.
  if (!token || !chatId || !TOKEN_RE.test(token) || !/^[A-Za-z]{3,40}$/.test(method)) return null;
  try {
    const form = body instanceof FormData;
    if (form) body.set('chat_id', chatId);
    const res = await (o.fetch ?? fetch)(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      ...(form ? {} : { headers: { 'Content-Type': 'application/json' } }),
      body: form ? body : JSON.stringify(method === 'getUpdates' ? body : { chat_id: chatId, ...body }),
      signal: AbortSignal.timeout(o.timeoutMs ?? TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: T } | null;
    return res.ok && json?.ok ? (json.result ?? null) : null;
  } catch {
    return null;
  }
}

/** Send one message. True when Telegram accepted it; false for every other outcome. */
export async function sendTelegram(text: string, o: TelegramOptions = {}): Promise<boolean> {
  return (await sendTelegramMessage(text, {}, o)) !== null;
}

/** Send one message, as a reply when `replyTo` is given. Its message_id, or null. */
export async function sendTelegramMessage(text: string, m: { replyTo?: number | null } = {}, o: TelegramOptions = {}): Promise<number | null> {
  const r = await telegramCall<{ message_id?: number }>('sendMessage', {
    text: telegramText(text),
    disable_web_page_preview: true,
    ...(m.replyTo ? { reply_parameters: { message_id: m.replyTo, allow_sending_without_reply: true } } : {}),
  }, o);
  return typeof r?.message_id === 'number' ? r.message_id : null;
}

/** Send one screenshot (sendPhoto, multipart), as a reply when `replyTo` is given. Its message_id, or null. */
export async function sendTelegramPhoto(bytes: Uint8Array, type: string, m: { caption?: string; replyTo?: number | null } = {}, o: TelegramOptions = {}): Promise<number | null> {
  const form = new FormData();
  form.set('photo', new Blob([bytes], { type }), type === 'image/png' ? 'screenshot.png' : type === 'image/webp' ? 'screenshot.webp' : 'screenshot.jpg');
  if (m.caption) form.set('caption', telegramText(m.caption).slice(0, 1000));
  if (m.replyTo) form.set('reply_parameters', JSON.stringify({ message_id: m.replyTo, allow_sending_without_reply: true }));
  const r = await telegramCall<{ message_id?: number }>('sendPhoto', form, { timeoutMs: 20_000, ...o });
  return typeof r?.message_id === 'number' ? r.message_id : null;
}

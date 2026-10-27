/**
 * The owner's replies (owner, 2026-10-27: "if i respond it should be a
 * notification ... Should just be a chat basically").
 *
 * The owner answers a visitor by REPLYING, in Telegram, to the bot's message
 * that carried the visitor's feedback (or to any later message of that chain).
 * This loop asks Telegram for new messages by long polling (getUpdates, one
 * request held open up to POLL_S seconds - no webhook, no public endpoint), and
 * keeps a message only when:
 *   - it is in ALERT_TELEGRAM_CHAT_ID, the owner's chat - anything from anyone
 *     else who finds the bot is dropped unread;
 *   - it replies to a message this server sent for a thread (feedbackThreads.ts tg).
 * Its text (or a photo's caption) becomes the owner's message in that thread; the
 * visitor's browser finds it on its next poll and shows it in the bell.
 *
 * The update offset is kept in feedback.db, so a restart neither loses nor
 * repeats a reply. Never throws; a failure waits and tries again (5 s, doubling
 * to 2 minutes). Runs in the API process on a hosted server with Telegram
 * configured, unless VALUESCAN_FEEDBACK_REPLIES=0; locally only with =1 (two
 * processes polling one bot take each other's updates - Telegram answers 409).
 */
import { telegramCall, telegramConfigured, type TelegramOptions } from './telegram.js';
import type { FeedbackStore } from './feedbackThreads.js';

export const POLL_S = 50;
const OFFSET_KEY = 'tg_offset';
const MAX_REPLY_CHARS = 4000;

interface TgMessage {
  message_id?: number;
  chat?: { id?: number | string };
  text?: string;
  caption?: string;
  reply_to_message?: { message_id?: number };
  from?: { id?: number }; // [status hook] for ops/statusTelegram.ts
}
interface TgUpdate {
  update_id?: number;
  message?: TgMessage;
}

// [status hook] The status page's commands (/incident, /update, ... - ops/statusTelegram.ts): true when handled.
export type StatusCommandHook = (m: { text: string; messageId: number; fromId?: number }) => Promise<boolean>;

export interface ReplyLog {
  info(o: object, msg: string): void;
  warn(o: object, msg: string): void;
}

/** One getUpdates round: what was stored. Exported for tests. */
export async function pollReplies(store: FeedbackStore, o: TelegramOptions & { timeoutS?: number; now?: () => number; onCommand?: StatusCommandHook } = {}): Promise<{ ok: boolean; stored: number }> {
  const chatId = String(o.chatId ?? process.env.ALERT_TELEGRAM_CHAT_ID?.trim() ?? '');
  const offset = Number(store.getMeta(OFFSET_KEY) ?? 0) || 0;
  const timeoutS = o.timeoutS ?? POLL_S;
  const updates = await telegramCall<TgUpdate[]>(
    'getUpdates',
    { offset, timeout: timeoutS, allowed_updates: ['message'] },
    { ...o, timeoutMs: (timeoutS + 15) * 1000 },
  );
  if (!Array.isArray(updates)) return { ok: false, stored: 0 };
  let next = offset;
  let stored = 0;
  for (const u of updates) {
    if (typeof u?.update_id !== 'number') continue;
    next = Math.max(next, u.update_id + 1);
    const m = u.message;
    if (!m || String(m.chat?.id ?? '') !== chatId) continue;
    const replyTo = m.reply_to_message?.message_id;
    const text = (typeof m.text === 'string' ? m.text : typeof m.caption === 'string' ? m.caption : '').trim();
    // [status hook] A command (not a reply) from this chat - checked above - goes to the status page's handler.
    if (o.onCommand && typeof replyTo !== 'number' && typeof m.message_id === 'number' && text.startsWith('/')
      && (await o.onCommand({ text, messageId: m.message_id, fromId: m.from?.id }).catch(() => true))) continue;
    if (typeof replyTo !== 'number' || typeof m.message_id !== 'number' || !text) continue;
    if (store.addOwnerReply(replyTo, text.slice(0, MAX_REPLY_CHARS), m.message_id, (o.now ?? Date.now)())) stored += 1;
  }
  if (next !== offset) store.setMeta(OFFSET_KEY, String(next));
  return { ok: true, stored };
}

export interface ReplyPoller {
  stop(): void;
}

/** Poll for as long as the process runs. */
export function startReplyPoller(store: FeedbackStore, o: TelegramOptions & { log?: ReplyLog; onCommand?: StatusCommandHook } = {}): ReplyPoller {
  let stopped = false;
  let wait = 5_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const loop = async (): Promise<void> => {
    if (stopped) return;
    const r = await pollReplies(store, o).catch(() => ({ ok: false, stored: 0 }));
    if (r.stored) o.log?.info({ replies: r.stored }, 'feedback: owner replies stored');
    if (r.ok) wait = 5_000;
    else {
      o.log?.warn({ retryInS: wait / 1000 }, 'feedback: Telegram getUpdates failed (another poller on this bot, or Telegram down)');
      wait = Math.min(wait * 2, 120_000);
    }
    if (!stopped) {
      timer = setTimeout(() => void loop(), r.ok ? 0 : wait);
      timer.unref?.();
    }
  };
  void loop();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/** Whether this process reads the owner's replies (see the header). */
export function repliesEnabled(env: Readonly<Record<string, string | undefined>>, hosted: boolean): boolean {
  const v = env.VALUESCAN_FEEDBACK_REPLIES?.trim();
  if (v === '0' || !telegramConfigured({ token: env.ALERT_TELEGRAM_TOKEN?.trim(), chatId: env.ALERT_TELEGRAM_CHAT_ID?.trim() })) return false;
  return hosted || v === '1';
}

/**
 * The status page from the owner's Telegram chat: the same commands as the CLI
 * (ops/statusCommands.ts), as bot commands.
 *
 *   /incident "Copies are delayed" --components=executor --impact=major We are looking into it.
 *   /update 7 identified A SoDEX feed stalled; restarting it.
 *   /resolve 7 Copies are back to normal.
 *   /maint "Database upgrade" --start=2026-10-28T02:00 --end=+1h --components=api,indexer
 *   /status            open and upcoming notices (/status help: the grammar)
 *   /show 7            one notice and its timeline
 *
 * The messages come from the feedback reply loop (ops/telegramReplies.ts, its
 * `onCommand` hook), which has already dropped every message from any chat but
 * ALERT_TELEGRAM_CHAT_ID. Here, in addition: only a message that is not a reply and
 * starts with one of the commands above; when STATUS_TELEGRAM_USER_IDS is set (a
 * group chat), only from those Telegram user ids; each message once (its id is kept
 * in status.db, so a restart that sees it again does not post it twice). Delete is
 * not offered here - only on the server. VALUESCAN_STATUS_TELEGRAM=0 turns this off.
 *
 * Never throws: whatever happens, the owner gets an answer (or nothing, for a
 * message that is not a status command).
 */
import { sendTelegramMessage, type TelegramOptions } from './telegram.js';
import { runStatusCommand, tokenize, COMMAND_HELP } from './statusCommands.js';
import { writeHistory, type StatusStore } from './status.js';

export interface CommandMessage {
  text: string;
  messageId: number;
  fromId?: number;
}

const COMMANDS: Record<string, string> = {
  incident: 'incident',
  update: 'update',
  resolve: 'resolve',
  maint: 'maintenance',
  maintenance: 'maintenance',
  status: 'list',
  show: 'show',
};

const LAST_KEY = 'tg_last_command';

/** "/incident@SomeBot rest" -> ["incident", "rest"]; null when it is not one of ours. */
export function commandOf(text: string): { name: string; rest: string } | null {
  const m = /^\/([a-z_]+)(?:@[A-Za-z0-9_]{3,64})?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  const name = COMMANDS[m[1]!.toLowerCase()];
  return name ? { name, rest: m[2] ?? '' } : null;
}

export interface StatusTelegramOptions extends TelegramOptions {
  open: () => StatusStore;
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
  /** Test seam: what is said back. */
  reply?: (text: string, replyTo: number) => Promise<unknown>;
  site?: string;
  log?: { warn(o: object, msg: string): void };
}

/** The hook for the reply loop: true when the message was a status command (handled here). */
export function statusTelegramHandler(o: StatusTelegramOptions): (m: CommandMessage) => Promise<boolean> {
  const env = o.env ?? process.env;
  const users = (env.STATUS_TELEGRAM_USER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const off = env.VALUESCAN_STATUS_TELEGRAM?.trim() === '0';
  const reply = o.reply ?? ((text: string, replyTo: number) => sendTelegramMessage(text, { replyTo }, o));
  let store: StatusStore | null = null;
  return async (m) => {
    const c = commandOf(m.text);
    if (!c || off) return false;
    if (users.length && !users.includes(String(m.fromId ?? ''))) return true; // ours, but not this sender's: dropped unanswered
    let text: string;
    try {
      store ??= o.open();
      const last = Number(store.notices.getMeta(LAST_KEY) ?? 0) || 0;
      if (m.messageId <= last) return true;
      store.notices.setMeta(LAST_KEY, String(m.messageId));
      const words = tokenize(c.rest);
      const argv = c.name === 'list' && words[0]?.toLowerCase() === 'help' ? ['help'] : [c.name, ...words];
      const r = runStatusCommand(argv, store.notices, { now: (o.now ?? Date.now)(), site: o.site });
      if (r.changed) writeHistory(store);
      text = r.code === 2 && !r.text.startsWith('Status page commands') ? `${r.text}\n\n${COMMAND_HELP}` : r.text;
    } catch (e) {
      o.log?.warn({ err: e instanceof Error ? e.message : String(e) }, 'status: a Telegram command failed');
      text = 'That did not work (the status record could not be written). Try again, or use status.sh on server 1.';
    }
    await reply(text, m.messageId).catch(() => null);
    return true;
  };
}

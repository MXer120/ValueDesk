/**
 * The executor's alerts to the operator's Telegram chat: what needs a person
 * now (an order refused for a reason nobody planned for, a key that does not
 * open, SoDEX unreachable or rate limiting this IP, the brake, a copy held
 * after repeated refusals, a start after a crash, a broken audit chain).
 *
 * CONFIGURED as the API's alerts are (apps/server/src/ops/telegram.ts):
 * ALERT_TELEGRAM_TOKEN and ALERT_TELEGRAM_CHAT_ID, which systemd reads from
 * /etc/valuescan/alert.env (root, 0600; written by
 * deploy/server/bin/telegram-setup.sh) into the environment at start - the
 * unit's `EnvironmentFile=-/etc/valuescan/alert.env`. Either unset (no file
 * yet, a self-hosted copier): alerts are off, silently.
 *
 * NEVER NOISY:
 *   - one message per kind and subject (a copy, an algo, a wallet) within
 *     DEDUPE_MS; what comes after it within that time is counted and told in
 *     one follow-up ("x 14 in the last 10 min");
 *   - at most PER_HOUR messages an hour in all, then one "muted" note, and
 *     when the hour is over a note of how many were dropped.
 * NEVER A SECRET: messages are made here from the executor's own words; a
 * wallet is shortened (0x1234…abcd), long hex (a key, a signature) and
 * anything shaped like a bot token is cut out before sending.
 * NEVER IN THE WAY: a send is a short-timeout fetch whose every failure is
 * dropped; an alert never throws into the code that raised it.
 */

import { readFileSync } from 'node:fs';

export type AlertKind =
  | 'order-rejected'
  | 'key-decrypt'
  | 'key-refused'
  | 'sodex-down'
  | 'sodex-up'
  | 'rate-limited'
  | 'rate-cleared'
  | 'brake-on'
  | 'brake-off'
  | 'sub-held'
  | 'crash-restart'
  | 'fatal'
  | 'audit-broken'
  | 'queue-slow'
  | 'vip-move-unknown'
  | 'vip-key-mismatch'
  | 'bot-health'
  | 'bot-health-ok';

/** Sends one plain-text message; true when it was accepted. Never throws. */
export type AlertSender = (text: string) => Promise<boolean>;

export const DEDUPE_MS = 10 * 60_000;
export const PER_HOUR = 30;
const HOUR_MS = 60 * 60_000;
const TIMEOUT_MS = 5_000;
const MAX_CHARS = 3500;
const TOKEN_RE = /^\d{1,20}:[A-Za-z0-9_-]{20,80}$/;
const CHAT_RE = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;

const LABEL: Record<AlertKind, string> = {
  'order-rejected': 'Order refused',
  'key-decrypt': 'KEY DID NOT OPEN',
  'key-refused': 'Key refused by SoDEX',
  'sodex-down': 'SoDEX UNREACHABLE',
  'sodex-up': 'SoDEX reachable again',
  'rate-limited': 'RATE LIMITED by SoDEX',
  'rate-cleared': 'Rate limit lifted',
  'brake-on': 'BRAKE ON',
  'brake-off': 'Brake off',
  'sub-held': 'Held after errors',
  'crash-restart': 'STARTED AFTER A CRASH',
  fatal: 'EXECUTOR STOPPING ON AN ERROR',
  'audit-broken': 'AUDIT CHAIN BROKEN',
  'queue-slow': 'CLOSES AND STOPS WAITING',
  'vip-move-unknown': 'VIP MOVE NOT CONFIRMED',
  'vip-key-mismatch': 'VIP KEY DOES NOT MATCH',
  'bot-health': 'BOT UNHEALTHY (our side)',
  'bot-health-ok': 'Bot healthy again',
};

/**
 * What a message is, on its first line - the five labels of the servers' scripts
 * (deploy/server/bin/telegram.mjs LABELS, which says what each means). Nothing here is
 * planned work: the brake of a release (cause 'maintenance', brake.ts) raises no alert.
 */
export type AlertClass = 'maintenance' | 'brake' | 'failure' | 'recovered' | 'info';
export const LABELS: Record<AlertClass, string> = {
  maintenance: '🔧 MAINTENANCE',
  brake: '🛑 BRAKE',
  failure: '🚨 FAILURE',
  recovered: '✅ RECOVERED',
  info: 'ℹ️ INFO',
};
export const CLASS: Record<AlertKind, AlertClass> = {
  'order-rejected': 'failure',
  'key-decrypt': 'failure',
  'key-refused': 'failure',
  'sodex-down': 'failure',
  'sodex-up': 'recovered',
  'rate-limited': 'failure',
  'rate-cleared': 'recovered',
  'brake-on': 'brake',
  'brake-off': 'recovered',
  'sub-held': 'failure',
  'crash-restart': 'failure',
  fatal: 'failure',
  'audit-broken': 'failure',
  'queue-slow': 'failure',
  'vip-move-unknown': 'failure',
  'vip-key-mismatch': 'failure',
  'bot-health': 'failure',
  'bot-health-ok': 'recovered',
};
const head = (c: AlertClass, what: string): string => `${LABELS[c]} · ${what}`;

/** 0x1234…abcd: enough to tell wallets apart in a chat, not the address. */
export const shortWallet = (a: string): string => (/^0x[0-9a-fA-F]{40}$/.test(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

/** The text as sent: no long hex, no token-shaped string, wallets shortened, no control characters, bounded. */
export function scrub(text: string): string {
  // eslint-disable-next-line no-control-regex
  let t = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  t = t.replace(/0x[0-9a-fA-F]{41,}/g, '0x[cut]');
  t = t.replace(/\b0x[0-9a-fA-F]{40}\b/g, (m) => shortWallet(m));
  t = t.replace(/\b\d{6,20}:[A-Za-z0-9_-]{30,}\b/g, '[cut]');
  t = t.replace(/\b[A-Za-z0-9_-]{43}\b/g, (m) => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) ? '[cut]' : m));
  return t.length > MAX_CHARS ? `${t.slice(0, MAX_CHARS - 1)}…` : t;
}

/** The Telegram sender, from ALERT_TELEGRAM_TOKEN / ALERT_TELEGRAM_CHAT_ID; null when either is missing or malformed. */
export function telegramSender(env: { token?: string | null; chatId?: string | null }, fetchFn: typeof fetch = fetch): AlertSender | null {
  const token = env.token?.trim() ?? '';
  const chatId = env.chatId?.trim() ?? '';
  if (!TOKEN_RE.test(token) || !CHAT_RE.test(chatId)) return null;
  return async (text) => {
    try {
      const res = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Plain text (no parse_mode): nothing in a message can become markup or a link preview.
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const json = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      return res.ok && json?.ok === true;
    } catch {
      return false;
    }
  };
}

interface Window {
  firstAt: number;
  /** Raised again after the first message, not sent. */
  more: number;
  lastText: string;
  kind: AlertKind;
}

export interface AlertsOptions {
  sender: AlertSender | null;
  /** Who is speaking: e.g. "valuedesk-mainnet-tokyo (hosted)". */
  label: string;
  now?: () => number;
  dedupeMs?: number;
  perHour?: number;
  log?: { warn(msg: string, data?: Record<string, unknown>): void };
}

export class Alerts {
  private windows = new Map<string, Window>();
  private sentAt: number[] = [];
  private muted: { since: number; dropped: number } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight = new Set<Promise<unknown>>();
  /** Everything sent (tests, and the last few for the health view). */
  readonly sent: string[] = [];

  constructor(private readonly o: AlertsOptions) {}

  get enabled(): boolean {
    return this.o.sender !== null;
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  /** Start the follow-up timer (counts of repeats, the end of a mute). */
  start(): void {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => this.flush(), 30_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Raise an alert. `subject` is what it is about (a copy, an algo, a wallet;
   * '' for the executor as a whole): the same kind and subject within the
   * dedupe window is one message and a count.
   */
  raise(kind: AlertKind, subject: string, text: string): void {
    // Every alert is in the executor's log too (scrubbed as the message is), sent or not: a copier without Telegram, a
    // muted hour ("the executor's log keeps them") and the live suite, which fails a scenario on an unknown refusal.
    try {
      this.o.log?.warn('alert', { kind, text: scrub(text) });
    } catch {
      /* an alert never throws into its caller */
    }
    if (!this.enabled) return;
    try {
      const now = this.now();
      const key = `${kind}|${subject}`;
      const w = this.windows.get(key);
      if (w && now - w.firstAt < (this.o.dedupeMs ?? DEDUPE_MS)) {
        w.more++;
        w.lastText = text;
        return;
      }
      if (w) this.followUp(key, w);
      this.windows.set(key, { firstAt: now, more: 0, lastText: text, kind });
      if (this.windows.size > 5_000) this.flush();
      this.emit(`${head(CLASS[kind], `${LABEL[kind]} - ${this.o.label}`)}\n${text}`);
    } catch {
      /* an alert never throws into its caller */
    }
  }

  /** Send what waits: counts of repeats whose window ended, and the end of a mute. */
  flush(): void {
    const now = this.now();
    for (const [key, w] of this.windows) {
      if (now - w.firstAt < (this.o.dedupeMs ?? DEDUPE_MS)) continue;
      this.followUp(key, w);
      this.windows.delete(key);
    }
    this.capWindow(now);
  }

  /** Wait for the sends on their way (a stopping process sends its last alert). */
  async drain(ms = 3_000): Promise<void> {
    await Promise.race([Promise.allSettled([...this.inflight]), new Promise((r) => setTimeout(r, ms).unref?.())]);
  }

  private followUp(_key: string, w: Window): void {
    if (w.more > 0) this.emit(`${head(CLASS[w.kind], `${LABEL[w.kind]} - ${this.o.label}`)}\nx ${w.more} more in the last ${Math.round((this.o.dedupeMs ?? DEDUPE_MS) / 60_000)} min. Last:\n${w.lastText}`);
    w.more = 0;
  }

  private capWindow(now: number): void {
    while (this.sentAt.length && now - this.sentAt[0]! >= HOUR_MS) this.sentAt.shift();
    if (this.muted && this.sentAt.length < (this.o.perHour ?? PER_HOUR)) {
      const dropped = this.muted.dropped;
      this.muted = null;
      if (dropped) this.send(`${head('info', `Alerts on again - ${this.o.label}`)}\n${dropped} alert(s) were not sent while muted; the executor's log has them.`, now);
    }
  }

  private emit(text: string): void {
    const now = this.now();
    this.capWindow(now);
    if (this.muted) {
      this.muted.dropped++;
      return;
    }
    if (this.sentAt.length >= (this.o.perHour ?? PER_HOUR)) {
      this.muted = { since: now, dropped: 1 };
      this.send(`${head('info', `Alerts muted - ${this.o.label}`)}\nMore than ${this.o.perHour ?? PER_HOUR} alerts in an hour; the next are dropped until the hour is over (the executor's log keeps them).`, now);
      return;
    }
    this.send(text, now);
  }

  private send(text: string, now: number): void {
    const clean = scrub(text);
    this.sentAt.push(now);
    this.sent.push(clean);
    if (this.sent.length > 50) this.sent.shift();
    const p = this.o.sender!(clean)
      .then((ok) => {
        if (!ok) this.o.log?.warn('alert: Telegram did not take the message', {});
      })
      .catch(() => undefined)
      .finally(() => this.inflight.delete(p));
    this.inflight.add(p);
  }
}

/**
 * Raise "SoDEX unreachable" once REST has failed for `afterMs` without an
 * answer in between, and "reachable again" when it answers after that.
 */
export class ReachWatch {
  private down = false;
  constructor(
    private readonly alerts: Alerts,
    private readonly afterMs = 3 * 60_000,
  ) {}

  check(reach: { lastOkAt: number; failingSince: number; lastError: string | null }, now = Date.now()): void {
    if (reach.failingSince && now - reach.failingSince >= this.afterMs) {
      if (!this.down) {
        this.down = true;
        this.alerts.raise('sodex-down', '', `No answer from SoDEX's REST for ${Math.round((now - reach.failingSince) / 60_000)} min (last error: ${reach.lastError ?? 'none'}). Copies and algos cannot trade.`);
      }
    } else if (this.down && !reach.failingSince) {
      this.down = false;
      this.alerts.raise('sodex-up', '', 'SoDEX answers again.');
    }
  }
}

/**
 * How the last run ended, from the audit log's last 'process' row: a 'start'
 * with no 'stop' after it is a run that died (killed, out of memory, power);
 * a stop on an error is a crash too. Null: the last run stopped cleanly.
 */
export function lastRunCrashed(db: { auditRows(q: { kind?: string; limit?: number }): Array<{ at: number; data: string }> }): string | null {
  const last = db.auditRows({ kind: 'process', limit: 1 })[0];
  if (!last) return null;
  let d: { event?: string; why?: string } = {};
  try {
    d = JSON.parse(last.data) as typeof d;
  } catch {
    return null;
  }
  if (d.event === 'start') return `the run started ${new Date(last.at).toISOString()} ended without stopping (killed, out of memory, or the machine went down)`;
  if (d.event === 'stop' && (d.why === 'unhandled rejection' || d.why === 'uncaught exception')) return `the last run stopped on an ${d.why} at ${new Date(last.at).toISOString()}`;
  return null;
}

/**
 * The maintenance window open on this server for `part` (deploy/server/bin/maint.sh writes it:
 * {"what", "parts": [...], "until"}), as its `what`; null when none is open for it or the file
 * cannot be read. A run killed inside one was planned (the live suite's crash test, a person's
 * restart): no "started after a crash" alert then, only the log line.
 */
export function maintenanceFor(file: string | null, part: string, now = Date.now()): string | null {
  if (!file) return null;
  try {
    const w = JSON.parse(readFileSync(file, 'utf8')) as { what?: unknown; parts?: unknown; until?: unknown };
    if (!(Number(w.until) > now) || !Array.isArray(w.parts) || !w.parts.includes(part)) return null;
    return typeof w.what === 'string' && w.what ? w.what.slice(0, 80) : 'maintenance';
  } catch {
    return null;
  }
}

/**
 * PRODUCTION LOGGING - one small logger for the whole web app.
 *
 *   import { logger } from './log';
 *   const log = logger('chart');
 *   log.warn('klines request failed, retrying', { symbol, interval, status, attempt });
 *
 * LEVELS
 *   error  something is broken for the user (an empty chart, a failed order read, a crashed panel).
 *          Always printed, production included.
 *   warn   degraded but recovering (a retry, a reconnect, a stale feed, a fallback path taken).
 *          Always printed.
 *   info   notable lifecycle events (a symbol switch, a subscription opened, a recovery finished).
 *          Printed in dev, and in production only when the namespace is enabled.
 *   debug  high-volume detail (per-request timing, per-frame state). Printed only when enabled.
 *
 * ENABLING VERBOSE OUTPUT (works in production, no rebuild, nothing sensitive):
 *   - URL:      ?debug=chart,book   or   ?debug=*    (this tab only; kept in sessionStorage)
 *   - Console:  __vs.enable('chart')  /  __vs.enable('*')  /  __vs.disable()   (persists in localStorage)
 *
 * EVERY entry, at every level and whether printed or not, also lands in an in-memory ring buffer
 * (the last BUFFER_MAX entries). `__vs.logs()` returns it and `__vs.dump()` returns it as JSON for a
 * bug report, so a user can hand over exactly what happened before a failure.
 *
 * SAFETY
 *   - Values under key names that look like secrets (private key, signature, token, seed, passphrase,
 *     api key, authorization, cookie) are replaced with '[redacted]' before anything is printed or
 *     stored. Wallet ADDRESSES are public and are not redacted.
 *   - Long strings and big arrays are truncated, objects are copied two levels deep, and Errors become
 *     { name, message, stack }, so logging can never retain large live objects or leak a key by accident.
 *   - Identical messages repeating within DEDUPE_MS print once. The next print after the window says
 *     how many were suppressed, so a failure loop cannot flood the console or freeze the page.
 *
 * REMOTE REPORTING: setLogSink(fn) receives every warn/error entry (already sanitised), for a future
 * error tracker. Nothing leaves the browser today.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  /** ms since epoch */
  t: number;
  level: LogLevel;
  /** subsystem: 'chart', 'book', 'ws', 'wallet', 'api', 'global', ... */
  ns: string;
  msg: string;
  data?: unknown;
  /** How many identical entries were suppressed before this one (dedupe). */
  suppressed?: number;
}

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  /** True when this namespace prints debug output. Guard expensive debug payloads with it. */
  readonly debugEnabled: boolean;
}

const BUFFER_MAX = 500;
const DEDUPE_MS = 5_000;
const MAX_STRING = 500;
const MAX_ARRAY = 20;
const MAX_KEYS = 40;
const SECRET_KEY = /(private|secret|signature|\bsig\b|mnemonic|seed|passphrase|password|token|api[-_]?key|authorization|cookie)/i;

const STORAGE_KEY = 'vs.debug';
const SESSION_KEY = 'vs.debug.session';

const IS_DEV = typeof import.meta !== 'undefined' && !!import.meta.env?.DEV;

/* --------------------------------------------------------------------------
 * Which namespaces print info/debug.
 * ------------------------------------------------------------------------ */

let enabled: Set<string> | '*' | null = null;

function parseList(raw: string | null | undefined): Set<string> | '*' | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  if (s === '*' || s === 'all' || s === '1' || s === 'true') return '*';
  const set = new Set(s.split(',').map((x) => x.trim()).filter(Boolean));
  return set.size ? set : null;
}

function readEnabled(): Set<string> | '*' | null {
  let fromUrl: string | null = null;
  try {
    fromUrl = new URLSearchParams(window.location.search).get('debug');
    if (fromUrl !== null) sessionStorage.setItem(SESSION_KEY, fromUrl);
  } catch { /* storage or URL unavailable: fall through */ }
  let raw: string | null = fromUrl;
  try { raw ??= sessionStorage.getItem(SESSION_KEY); } catch { /* ignore */ }
  try { raw ??= localStorage.getItem(STORAGE_KEY); } catch { /* ignore */ }
  return parseList(raw);
}

function isEnabled(ns: string): boolean {
  if (enabled === null) return false;
  return enabled === '*' || enabled.has(ns);
}

/* --------------------------------------------------------------------------
 * Sanitising.
 * ------------------------------------------------------------------------ */

function clip(s: string): string {
  return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}… (${s.length} chars)` : s;
}

function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string') return clip(value as string);
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') return `${(value as bigint).toString()}n`;
  if (t === 'function' || t === 'symbol') return `[${t}]`;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: clip(value.message),
      stack: value.stack ? clip(value.stack.split('\n').slice(0, 8).join('\n')) : undefined,
      ...(value as { status?: unknown }).status !== undefined ? { status: (value as { status?: unknown }).status } : {},
      ...(value as { code?: unknown }).code !== undefined ? { code: (value as { code?: unknown }).code } : {},
    };
  }
  if (typeof Event !== 'undefined' && value instanceof Event) {
    return { event: value.type };
  }
  if (depth >= 2) return Array.isArray(value) ? `[array(${value.length})]` : '[object]';
  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY).map((v) => sanitize(v, depth + 1));
    return value.length > MAX_ARRAY ? [...head, `… +${value.length - MAX_ARRAY} more`] : head;
  }
  if (t === 'object') {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (n++ >= MAX_KEYS) { out['…'] = 'more keys omitted'; break; }
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : sanitize(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/* --------------------------------------------------------------------------
 * Ring buffer, dedupe, sink.
 * ------------------------------------------------------------------------ */

const buffer: LogEntry[] = [];
const lastSeen = new Map<string, { at: number; suppressed: number }>();
let sink: ((e: LogEntry) => void) | null = null;

/** Receive every warn/error entry (sanitised). Pass null to remove. */
export function setLogSink(fn: ((e: LogEntry) => void) | null): void {
  sink = fn;
}

/** A copy of the recent entries, oldest first. */
export function recentLogs(): LogEntry[] {
  return buffer.slice();
}

function push(entry: LogEntry): void {
  buffer.push(entry);
  if (buffer.length > BUFFER_MAX) buffer.splice(0, buffer.length - BUFFER_MAX);
}

const CONSOLE: Record<LogLevel, (...a: unknown[]) => void> = {
  debug: (...a) => console.debug(...a),
  info: (...a) => console.info(...a),
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
};

function emit(level: LogLevel, ns: string, msg: string, data: unknown): void {
  const clean = data === undefined ? undefined : sanitize(data);
  const now = Date.now();
  const entry: LogEntry = { t: now, level, ns, msg, ...(clean === undefined ? {} : { data: clean }) };
  push(entry);

  const shouldPrint =
    level === 'error' || level === 'warn' || (level === 'info' && (IS_DEV || isEnabled(ns))) || (level === 'debug' && isEnabled(ns));
  if (shouldPrint) {
    const key = `${level}|${ns}|${msg}`;
    const seen = lastSeen.get(key);
    if (seen && now - seen.at < DEDUPE_MS) {
      seen.suppressed += 1;
    } else {
      const suppressed = seen?.suppressed ?? 0;
      lastSeen.set(key, { at: now, suppressed: 0 });
      if (lastSeen.size > 1_000) lastSeen.clear();
      if (suppressed) entry.suppressed = suppressed;
      const head = `[vs:${ns}] ${msg}${suppressed ? ` (+${suppressed} identical suppressed)` : ''}`;
      try {
        if (clean === undefined) CONSOLE[level](head);
        else CONSOLE[level](head, clean);
      } catch { /* a broken console must never break the app */ }
    }
  }

  if (sink && (level === 'warn' || level === 'error')) {
    try { sink(entry); } catch { /* a broken sink must never break the app */ }
  }
}

/** A namespaced logger. Cheap to create; create one per module. */
export function logger(ns: string): Logger {
  return {
    debug: (msg, data) => emit('debug', ns, msg, data),
    info: (msg, data) => emit('info', ns, msg, data),
    warn: (msg, data) => emit('warn', ns, msg, data),
    error: (msg, data) => emit('error', ns, msg, data),
    get debugEnabled() { return isEnabled(ns); },
  };
}

/* --------------------------------------------------------------------------
 * Global wiring: uncaught errors, unhandled rejections, and the __vs console handle.
 * Call once from main.tsx. Idempotent (safe under hot reload).
 * ------------------------------------------------------------------------ */

declare global {
  interface Window {
    __vs?: {
      logs: () => LogEntry[];
      dump: () => string;
      enable: (namespaces: string) => void;
      disable: () => void;
      enabled: () => string;
    };
    __vsLogInstalled?: boolean;
  }
}

export function installGlobalLogging(): void {
  if (typeof window === 'undefined') return;
  enabled = readEnabled();

  window.__vs = {
    logs: recentLogs,
    dump: () => JSON.stringify(recentLogs(), null, 2),
    enable: (namespaces: string) => {
      try { localStorage.setItem(STORAGE_KEY, namespaces); } catch { /* ignore */ }
      enabled = parseList(namespaces);
    },
    disable: () => {
      try { localStorage.removeItem(STORAGE_KEY); sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
      enabled = null;
    },
    enabled: () => (enabled === null ? '(none)' : enabled === '*' ? '*' : [...enabled].join(',')),
  };

  if (window.__vsLogInstalled) return;
  window.__vsLogInstalled = true;

  const g = logger('global');
  window.addEventListener('error', (e) => {
    g.error('uncaught error', {
      message: e.message,
      source: e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined,
      error: e.error,
    });
  });
  window.addEventListener('unhandledrejection', (e) => {
    g.error('unhandled promise rejection', { reason: e.reason });
  });
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) enabled = readEnabled();
  });

  const on = window.__vs.enabled();
  if (on !== '(none)') g.info('verbose logging enabled', { namespaces: on });
}

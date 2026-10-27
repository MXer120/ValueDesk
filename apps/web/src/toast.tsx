/**
 * Notifications, top right.
 *
 * WHY THIS REPLACES INLINE ERROR TEXT. Errors used to render as a line of red
 * prose inside whichever panel failed - `<p className="status err">` in a dozen
 * components. That has three problems on a dashboard. The message appears in a
 * panel you may not be looking at, or one scrolled out of view; it reflows the
 * panel, so a transient failure makes the layout jump; and the text was written
 * for a developer, not a trader - "did not respond within 20s. The backend's
 * shared request budget may be temporarily exhausted (heavy multi-tab use
 * exhausts it fastest) - it recovers on its own within a minute" is a paragraph
 * where a sentence would do.
 *
 * So failures surface here instead: one place, always in the same corner,
 * dismissible instantly, and carrying a CODE you can quote.
 *
 * WHY A CODE. "It said something about a request budget" is not reportable. A
 * short stable code is: the same failure always produces the same code, so it
 * can be searched, and two different failures never collide into one story. The
 * code is derived from the SOURCE and the shape of the message, not from its
 * variable parts, so `/api/acct/perps/positions` timing out is one code however
 * many addresses it happens for.
 *
 * WHY IT IS REACHABLE FROM NON-REACT CODE. `api.ts` is a plain module and has no
 * hooks; it is also where most failures are first seen. The emitter below lets
 * any module report one without threading a callback through every caller.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { CoinIcon } from './components/CoinIcon';
import { logger } from './log';

// Error detail for the console, through the logger's redaction (never raw text).
const toastLog = logger('toast');

export type Severity = 'error' | 'warn' | 'info' | 'ok';

export interface Toast {
  id: number;
  severity: Severity;
  /** Short, human. One sentence, no stack traces, no advice paragraphs. */
  message: string;
  /** `E-A3F2`. Absent for `ok`/`info`, which nobody needs to quote. */
  code?: string;
  /** How many times this same code has fired while the toast has been up. */
  count: number;
  /** Offered as a button when the caller knows how to try again. */
  retry?: () => void;
  /** A trading event, drawn with its own glyph (order placed / cancelled / filled). */
  kind?: TradeKind;
  /** The coin it is about - its logo leads the card, the glyph rides on it. */
  coin?: string;
  /** Bold first line; `message` is then the detail line under it. */
  title?: string;
}

export type TradeKind = 'placed' | 'cancelled' | 'filled' | 'partial';

/* ---------------------------------------------------------------------------
 * The code.
 * ------------------------------------------------------------------------ */

/**
 * A short, stable, human-quotable code.
 *
 * FNV-1a over `source` plus the message with its variable parts stripped. The
 * stripping is what makes it stable: an address, a number, a duration or a hex
 * blob differs between two occurrences of the SAME fault, and a code that
 * changed with them would be useless for searching.
 */
export function errorCode(source: string, message: string): string {
  const shape = message
    .replace(/0x[0-9a-fA-F]{6,}/g, '#')
    .replace(/\d+(\.\d+)?/g, '#')
    .toLowerCase()
    .slice(0, 160);
  let h = 0x811c9dc5;
  for (const ch of `${source}|${shape}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `E-${h.toString(36).toUpperCase().slice(0, 4).padStart(4, '0')}`;
}

/* ---------------------------------------------------------------------------
 * Turning whatever we caught into one sentence.
 * ------------------------------------------------------------------------ */

/**
 * The short version of a failure.
 *
 * Long backend explanations are recognised and replaced rather than truncated -
 * cutting a paragraph mid-clause reads as a bug, and the useful half is usually
 * at the front anyway. Anything unrecognised is trimmed to its first sentence.
 */
export function shortMessage(source: string, raw: string): string {
  const m = raw.trim();
  // Already the app's own generic line ("Positions couldn't load.") - keep it.
  if (/couldn't load\.$|stopped working\.$/.test(m)) return m;
  if (/did not respond within|request budget|temporarily exhausted|timed out|timeout/i.test(m)) {
    return `${source} took too long. Try again.`;
  }
  if (/failed to fetch|networkerror|load failed|could not be reached|unreadable answer|fetch failed/i.test(m)) {
    return `${source}: no connection. Try again.`;
  }
  if (/rate limit|too many|\b429\b|1015/i.test(m)) return `${source}: too many requests. Try again in a minute.`;
  if (/unauthor|\b401\b/i.test(m)) return `${source} needs you to sign in again.`;
  if (/\b403\b|forbidden/i.test(m)) return `${source} was refused.`;
  if (/\b5\d\d\b|internal server|bad gateway|service unavailable/i.test(m)) return `${source}: the server had a problem. Try again.`;
  /*
   * Anything else is shown only when it reads as a sentence for a person (a
   * venue's "Insufficient balance"). Technical text - a status code, a path, a
   * JSON fragment, an error class name - becomes "<source> failed."; the detail
   * is in the console under the same code (notifyError logs it).
   */
  const first = (m.split(/(?<=[.!?])\s/)[0] ?? m).trim();
  const technical = !first || /^HTTP\b|\bHTTP \d|[{}[\]<>]|\/api\/|https?:|0x[0-9a-f]{6}|Error:|error code|undefined|null|NaN|\b[A-Z][a-z]+Error\b/.test(first);
  if (technical || first.length > 120) return `${source} failed. Try again.`;
  return first;
}

/* ---------------------------------------------------------------------------
 * The emitter, so non-React modules can report.
 * ------------------------------------------------------------------------ */

type Emit = (t: Omit<Toast, 'id' | 'count'>) => void;
let sink: Emit | null = null;
/** Queued until the provider mounts, so a failure during boot is not lost. */
const pending: Array<Omit<Toast, 'id' | 'count'>> = [];

function emit(t: Omit<Toast, 'id' | 'count'>): void {
  if (sink) sink(t);
  else if (pending.length < 20) pending.push(t);
}

/** Report a failure from anywhere, including plain modules. */
export function notifyError(source: string, e: unknown, retry?: () => void): string {
  const raw = e instanceof Error ? e.message : String(e ?? 'Unknown error');
  /*
   * THE CODE COMES FROM THE MESSAGE WE SHOW, NOT THE ONE WE CAUGHT.
   *
   * Two reports of the same fault often differ in their tail - one carries an
   * extra clause of backend advice, the other does not - and hashing the raw
   * text gave them different codes, which defeats both the dedupe and the point
   * of having a code at all. `shortMessage` has already collapsed them to one
   * sentence by here, so hashing THAT makes the code a stable function of what
   * the user is actually looking at.
   */
  const message = shortMessage(source, raw);
  const code = errorCode(source, message);
  // The detail lives in the console, findable by the code the toast shows.
  toastLog.warn(`[${code}] ${source}`, { detail: raw });
  emit({ severity: 'error', message, code, retry });
  return code;
}

export function notify(severity: Severity, message: string): void {
  emit({ severity, message });
}

/**
 * A trading event: "Limit buy placed" / "0.0125 BTC @ 84,211". Placed and
 * cancelled are informational, fills are good news.
 */
export function notifyTrade(kind: TradeKind, o: { coin?: string; title: string; detail: string }): void {
  emit({ severity: kind === 'filled' || kind === 'partial' ? 'ok' : 'info', kind, coin: o.coin, title: o.title, message: o.detail });
}

/* ---------------------------------------------------------------------------
 * The provider.
 * ------------------------------------------------------------------------ */

interface Api {
  toasts: Toast[];
  push: Emit;
  dismiss: (id: number) => void;
}

const Ctx = createContext<Api | null>(null);

/** Errors stay until dismissed; everything else clears itself. */
const TTL: Record<Severity, number> = { error: 0, warn: 12_000, info: 6_000, ok: 4_000 };
const MAX = 4;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = useCallback<Emit>((t) => {
    setToasts((list) => {
      /*
       * SAME CODE, SAME TOAST. A panel that retries on a timer would otherwise
       * stack twenty identical errors and bury everything else. The count goes
       * up instead, which is also more informative: "×7" says it is persistent.
       */
      const at = t.code ? list.findIndex((x) => x.code === t.code) : -1;
      if (at >= 0) {
        const copy = list.slice();
        copy[at] = { ...(copy[at] as Toast), count: (copy[at] as Toast).count + 1, retry: t.retry };
        return copy;
      }
      /* Oldest out first, and never drop an error for an `ok`. */
      const next = [...list, { ...t, id: seq.current += 1, count: 1 }];
      return next.length <= MAX ? next : next.slice(next.length - MAX);
    });
  }, []);

  /* Wire the module-level emitter, and flush anything reported before mount. */
  useEffect(() => {
    sink = push;
    while (pending.length) push(pending.shift() as Omit<Toast, 'id' | 'count'>);
    return () => { sink = null; };
  }, [push]);

  const api = useMemo<Api>(() => ({ toasts, push, dismiss }), [toasts, push, dismiss]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <ToastRail toasts={toasts} onDismiss={dismiss} />
    </Ctx.Provider>
  );
}

export function useToast(): Api {
  return useContext(Ctx) ?? { toasts: [], push: () => {}, dismiss: () => {} };
}

/**
 * Report an error the moment a component's async state turns bad.
 *
 * The call sites this replaces rendered `{error && <p className="status err">}`.
 * They now render nothing and call this instead, so a failure lands in one known
 * corner rather than reflowing whichever panel happened to fail.
 */
export function useErrorToast(error: unknown, source: string, retry?: () => void): void {
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (!error) { last.current = null; return; }
    const raw = error instanceof Error ? error.message : String(error);
    /* Only on CHANGE: these come from polling hooks that re-render constantly. */
    if (last.current === raw) return;
    last.current = raw;
    notifyError(source, error, retry);
  }, [error, source, retry]);
}

/* ---------------------------------------------------------------------------
 * The rail.
 * ------------------------------------------------------------------------ */

function ToastRail({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  /* Docked in the navbar's notification lane when the bar offers one (NavBar.tsx
     #vs-notify-slot, the rail layout); else the floating stack, top right. */
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const find = () => setSlot(document.getElementById('vs-notify-slot'));
    find();
    const mo = new MutationObserver(find);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);
  const rail = (
    <div className={`toasts${slot ? ' is-docked' : ''}`}>
      <div id="vs-toast-pin" />
      {toasts.length > 0 && (
        <div className="toasts__live" aria-live="polite">
          {/* Docked, the newest sits at the lane's right end: the lane runs right to left. */}
          {toasts.map((t) => <ToastCard key={t.id} t={t} onDismiss={onDismiss} />)}
        </div>
      )}
    </div>
  );
  return slot ? createPortal(rail, slot) : rail;
}

function ToastCard({ t, onDismiss }: { t: Toast; onDismiss: (id: number) => void }) {
  /* Leaving fades out first (the whole app closes this way - motion.css). */
  const [leaving, setLeaving] = useState(false);
  const close = useCallback(() => {
    setLeaving(true);
    window.setTimeout(() => onDismiss(t.id), 170);
  }, [onDismiss, t.id]);
  const ttl = TTL[t.severity];
  /* Held while the pointer is on it (it opens to its full words then): the time left is kept
     and runs on when the pointer leaves, as its timer bar does (shell.css pauses the bar). */
  const [held, setHeld] = useState(false);
  const left = useRef(ttl);
  useEffect(() => {
    left.current = ttl;
  }, [t.id, ttl]);
  useEffect(() => {
    if (!ttl || held) return;
    const from = Date.now();
    const timer = window.setTimeout(close, left.current);
    return () => {
      window.clearTimeout(timer);
      left.current = Math.max(0, left.current - (Date.now() - from));
    };
  }, [t.id, ttl, close, held]);

  return (
    <div
      className={`toast toast--${t.severity}${t.kind ? ` toast--${t.kind}` : ''}${leaving ? ' is-leaving' : ''}`}
      /* An error interrupts; everything else waits its turn. */
      role={t.severity === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
    >
      <span className="toast__ic" aria-hidden="true">
        {t.coin ? <CoinIcon coin={t.coin} size={30} /> : <span className="toast__glyph"><Glyph t={t} /></span>}
        {t.coin && <span className="toast__badge"><Glyph t={t} /></span>}
      </span>
      <div className="toast__body">
        {t.title && <span className="toast__title">{t.title}</span>}
        <span className={t.title ? 'toast__detail' : 'toast__msg'}>{t.message}</span>
        {(t.code || t.count > 1) && (
          <span className="toast__meta">
            {t.code}
            {t.count > 1 ? ` ×${t.count}` : ''}
          </span>
        )}
      </div>
      {t.retry && (
        <button type="button" className="toast__retry" onClick={() => { close(); t.retry?.(); }}>
          Retry
        </button>
      )}
      {/* One click, always in the same place, no confirmation. */}
      <button type="button" className="toast__x" aria-label="Dismiss" onClick={close}>
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M2.5 2.5 9.5 9.5M9.5 2.5 2.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      </button>
      {ttl > 0 && !leaving && <span className="toast__timer" style={{ animationDuration: `${ttl}ms` }} />}
    </div>
  );
}

/** One glyph per kind of news, 16px, currentColor. */
function Glyph({ t }: { t: Toast }) {
  const k = t.kind ?? t.severity;
  const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (k) {
    case 'filled':
      return <svg viewBox="0 0 16 16" width="14" height="14"><path d="M3.5 8.4 6.6 11.4 12.6 4.8" {...stroke} /></svg>;
    case 'partial':
      return <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="5.6" {...stroke} /><path d="M8 4.2A3.8 3.8 0 0 1 11.8 8H8Z" fill="currentColor" /></svg>;
    case 'placed':
      return <svg viewBox="0 0 16 16" width="14" height="14"><path d="M3 4.5h10M3 8h10M3 11.5h6" {...stroke} /><circle cx="12.3" cy="11.5" r="1.4" fill="currentColor" /></svg>;
    case 'cancelled':
      return <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="5.6" {...stroke} /><path d="M5.9 5.9 10.1 10.1M10.1 5.9 5.9 10.1" {...stroke} /></svg>;
    case 'error':
      return <svg viewBox="0 0 16 16" width="14" height="14"><path d="M8 2.4 14.2 13.2H1.8Z" {...stroke} /><path d="M8 6.4v3" {...stroke} /><circle cx="8" cy="11.3" r="0.8" fill="currentColor" /></svg>;
    case 'warn':
      return <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="5.6" {...stroke} /><path d="M8 5v3.4" {...stroke} /><circle cx="8" cy="10.8" r="0.8" fill="currentColor" /></svg>;
    case 'ok':
      return <svg viewBox="0 0 16 16" width="14" height="14"><path d="M3.5 8.4 6.6 11.4 12.6 4.8" {...stroke} /></svg>;
    default:
      return <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="5.6" {...stroke} /><path d="M8 7.3v3.6" {...stroke} /><circle cx="8" cy="5.2" r="0.8" fill="currentColor" /></svg>;
  }
}

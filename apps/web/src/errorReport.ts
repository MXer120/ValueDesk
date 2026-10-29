/**
 * CLIENT ERROR REPORTS: what crashes in a visitor's browser reaches the owner
 * (POST /api/vs/client-errors - apps/server routes/reports.ts, ops/clientErrors.ts;
 * the privacy policy's "Error reports").
 *
 * Three sources: window `error` (an uncaught exception), `unhandledrejection` (a
 * promise nobody caught), and the app's error boundaries (components/ErrorBoundary.tsx
 * calls reportBoundaryError) - a panel that crashed and shows Retry.
 *
 * WHAT IS SENT is decided by @sign/ops/scrub, the same code the server checks with
 * again: the error's type, its message with every address, key, long number, URL
 * query and long quoted text taken out, up to ten frames as function + script
 * path + line, the page's path with its variable parts replaced, the build and the
 * browser's family. Never a wallet address, a key or signature, a query string, an
 * origin or anything a person typed; nothing that identifies the visitor.
 *
 * HOW MUCH: one entry per fingerprint (the same error again only raises its count),
 * batched - sent FLUSH_MS after the first new one, or at once with sendBeacon when
 * the page is hidden or closed - at most MAX_PER_SESSION entries a browser session
 * (an error seen again after its batch left is one more), and once a page throws more than NOISY_PER_MINUTE a minute, only one in
 * NOISY_SAMPLE of the further new ones is kept.
 *
 * ON in a production build; in development only with localStorage `vs.reportErrors`
 * = 1 (a dev server's own HMR errors are no one's report).
 */
import { browserFamily, errorFingerprint, framesFromStack, scrubName, scrubRoute, scrubShort, scrubText } from '@sign/ops/scrub.js';
import { BUILD_ID } from './buildInfo';
import { reloadUnderway } from './lazyPage';

export type ReportKind = 'error' | 'rejection' | 'boundary';

export interface PendingError {
  kind: ReportKind;
  name: string;
  message: string;
  frames: string[];
  boundary?: string;
  count: number;
}

export const ENDPOINT = '/api/vs/client-errors';
export const FLUSH_MS = 5_000;
export const MAX_PER_BATCH = 10;
/** Under the server's 8 KB body limit (apps/server ops/clientErrors.ts BATCH_BODY_LIMIT), with room. */
export const MAX_BATCH_BYTES = 7_000;
export const MAX_PER_SESSION = 30;
export const NOISY_PER_MINUTE = 10;
export const NOISY_SAMPLE = 10;
const SESSION_KEY = 'vs.errorReports';

/** Messages that are noise, not bugs: the browser's own, an extension's, a cross-origin script's. */
const IGNORE: readonly RegExp[] = [
  /^Script error\.?$/i,
  /ResizeObserver loop/i,
  /^Non-Error promise rejection captured/i,
  /\b(chrome|moz|safari-web)-extension:\/\//i,
];

export interface ReporterEnv {
  send: (body: string, beacon: boolean) => void;
  now: () => number;
  random: () => number;
  route: () => string;
  userAgent: () => string;
  session: () => Storage | null;
  setTimer: (fn: () => void, ms: number) => unknown;
}

/** The last few fingerprints seen on this page, newest first: the feedback form's page info sends them. */
const RECENT: string[] = [];
function noteRecent(fp: string): void {
  const i = RECENT.indexOf(fp);
  if (i >= 0) RECENT.splice(i, 1);
  RECENT.unshift(fp);
  RECENT.length = Math.min(RECENT.length, 5);
}
export const recentErrorFingerprints = (): string[] => RECENT.slice();

/** One reporter: the queue, the caps, the flush. Exported for tests; the app uses the one below. */
export class ErrorReporter {
  private readonly queue = new Map<string, PendingError>();
  /** Fingerprints this page has queued or sent: a repeat only counts. */
  private readonly known = new Set<string>();
  private recent: number[] = [];
  private timer: unknown = null;
  private disabled = false;

  constructor(private readonly env: ReporterEnv) {}

  private sessionCount(): number {
    try {
      return Number(this.env.session()?.getItem(SESSION_KEY) ?? 0) || 0;
    } catch {
      return 0;
    }
  }

  private bumpSession(n: number): void {
    try {
      this.env.session()?.setItem(SESSION_KEY, String(this.sessionCount() + n));
    } catch {
      /* private mode: the page's own count still caps it */
    }
  }

  /** Queue one error (already scrubbed by `capture`). */
  add(e: Omit<PendingError, 'count'> | null): void {
    if (this.disabled || !e) return;
    const fp = errorFingerprint(e);
    noteRecent(fp);
    const queued = this.queue.get(fp);
    if (queued) {
      queued.count += 1;
      return;
    }
    if (this.sessionCount() + this.queue.size >= MAX_PER_SESSION) return;
    if (this.known.has(fp)) {
      // Sent already from this page: counted again in the next batch, as its own entry.
      this.queue.set(fp, { ...e, count: 1 });
      this.schedule();
      return;
    }
    const now = this.env.now();
    this.recent = this.recent.filter((t) => now - t < 60_000);
    this.recent.push(now);
    if (this.recent.length > NOISY_PER_MINUTE && this.env.random() * NOISY_SAMPLE >= 1) return;
    this.known.add(fp);
    this.queue.set(fp, { ...e, count: 1 });
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = this.env.setTimer(() => {
      this.timer = null;
      this.flush(false);
    }, FLUSH_MS);
  }

  /**
   * Send what is queued: sendBeacon when the page is going away, else a fetch.
   * Batches of at most MAX_PER_BATCH entries and MAX_BATCH_BYTES (the server takes
   * 8 KB); going away, every batch leaves now, else the next one after FLUSH_MS.
   */
  flush(beacon: boolean): void {
    while (this.queue.size) {
      const head = {
        build: scrubShort(BUILD_ID),
        route: scrubRoute(this.env.route()),
        browser: browserFamily(this.env.userAgent()),
      };
      const errors: unknown[] = [];
      let size = JSON.stringify({ ...head, errors }).length;
      for (const [fp, e] of this.queue) {
        if (errors.length >= MAX_PER_BATCH) break;
        const entry = { kind: e.kind, name: e.name, message: e.message, frames: e.frames, ...(e.boundary ? { boundary: e.boundary } : {}), count: e.count };
        const add = JSON.stringify(entry).length + 1;
        // One entry that is too big alone leaves with its frames cut down.
        if (size + add > MAX_BATCH_BYTES && errors.length) break;
        errors.push(size + add > MAX_BATCH_BYTES ? { ...entry, frames: entry.frames.slice(0, 2) } : entry);
        size += add;
        this.queue.delete(fp);
      }
      this.bumpSession(errors.length);
      try {
        this.env.send(JSON.stringify({ ...head, errors }), beacon);
      } catch {
        /* a report must never become an error of its own */
      }
      if (!beacon) {
        if (this.queue.size) this.schedule();
        return;
      }
    }
  }

  /** Stop for good (tests; a page that must not report). */
  stop(): void {
    this.disabled = true;
    this.queue.clear();
  }
}

/**
 * An Error, a rejection reason or anything thrown, as a report entry - or null
 * for noise (IGNORE), judged on the raw message and stack before they are scrubbed.
 */
export function capture(kind: ReportKind, thrown: unknown, extra: { message?: string; boundary?: string } = {}): Omit<PendingError, 'count'> | null {
  // The page is reloading to the current build: what breaks in between is the old build going.
  if (reloadUnderway()) return null;
  const err = thrown instanceof Error ? thrown : null;
  const raw =
    err?.message ??
    extra.message ??
    (typeof thrown === 'string' ? thrown : thrown === undefined || thrown === null ? String(thrown) : `non-error ${typeof thrown} thrown`);
  if (IGNORE.some((re) => re.test(raw) || (typeof err?.stack === 'string' && re.test(err.stack)))) return null;
  return {
    kind,
    name: scrubName(err?.name ?? (kind === 'rejection' ? 'UnhandledRejection' : 'Error')),
    message: scrubText(raw) || '(no message)',
    frames: framesFromStack(err?.stack),
    ...(extra.boundary ? { boundary: scrubShort(extra.boundary) } : {}),
  };
}

// --- the app's reporter ----------------------------------------------------------------------

let reporter: ErrorReporter | null = null;

function enabled(): boolean {
  if (typeof window === 'undefined') return false;
  if (import.meta.env?.PROD) return true;
  try {
    return window.localStorage.getItem('vs.reportErrors') === '1';
  } catch {
    return false;
  }
}

function browserSend(body: string, beacon: boolean): void {
  // text/plain: a "simple" request, which sendBeacon may send without a preflight; the server reads it as JSON.
  const blob = new Blob([body], { type: 'text/plain;charset=UTF-8' });
  if (beacon && typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(ENDPOINT, blob)) return;
  void fetch(ENDPOINT, { method: 'POST', body: blob, keepalive: true, credentials: 'omit' }).catch(() => {});
}

/** Install once, from main.tsx, before the first render. Idempotent. */
export function installErrorReporting(): void {
  if (reporter || !enabled()) return;
  reporter = new ErrorReporter({
    send: browserSend,
    now: Date.now,
    random: Math.random,
    route: () => window.location.pathname,
    userAgent: () => navigator.userAgent,
    session: () => window.sessionStorage,
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
  });
  const r = reporter;
  window.addEventListener('error', (e) => {
    // A resource that failed to load (an <img>) reaches here too, without an error: not a crash.
    if (!(e instanceof ErrorEvent)) return;
    r.add(capture('error', e.error, { message: e.message }));
  });
  window.addEventListener('unhandledrejection', (e) => r.add(capture('rejection', e.reason)));
  // The page is going away: what is queued leaves now, the one way that survives the unload.
  window.addEventListener('pagehide', () => r.flush(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') r.flush(true);
  });
}

/** An error boundary caught a crash (components/ErrorBoundary.tsx). */
export function reportBoundaryError(boundary: string, error: unknown): void {
  reporter?.add(capture('boundary', error, { boundary }));
}

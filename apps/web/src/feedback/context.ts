/**
 * The page and browser info a feedback message carries - "Recommended", on by
 * default (owner, 2026-10-27: "everything that could help us as devs"). The form
 * shows it, line by line, before it is sent (FeedbackDialog.tsx); the server
 * projects it again field by field (apps/server ops/feedback.ts projectContext).
 *
 * Useful and not sensitive: the page's path without its variable parts, the
 * build, browser and OS families, window size and pixel ratio, language and time
 * zone, the app's connection state, whether the browser is online, how long the
 * page has been open, whether a wallet is connected (its address goes with every
 * message anyway, apart from this info - FeedbackDialog.tsx), the copy modes in
 * use, the last client error fingerprints (errorReport.ts) and the right-clicked
 * element.
 */
import { browserFamily, scrubRoute } from '@sign/ops/scrub.js';
import { BUILD_ID } from '../buildInfo';
import type { ElementInfo } from './element';

export interface FeedbackContext {
  route: string;
  build: string;
  browser: string;
  os: string;
  viewport: string | null;
  dpr: number | null;
  lang: string | null;
  timeZone: string | null;
  sockets: string | null;
  walletConnected: boolean;
  /** The address sent is not the connected wallet's: typed into the form, or changed there (FeedbackDialog.tsx). */
  walletTyped?: boolean;
  online: boolean | null;
  /** Seconds since the page loaded. */
  pageAgeS: number | null;
  modes: string[];
  errors: string[];
  element: ElementInfo | null;
}

/** "windows", "macos", "ios", "android", "linux", "chromeos", or "other" - never the version string. */
export function osFamily(ua: string): string {
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/CrOS/.test(ua)) return 'chromeos';
  if (/Windows/.test(ua)) return 'windows';
  if (/Mac OS X|Macintosh/.test(ua)) return 'macos';
  if (/Linux/.test(ua)) return 'linux';
  return 'other';
}

export interface ContextSources {
  pathname: string;
  userAgent: string;
  innerWidth: number;
  innerHeight: number;
  devicePixelRatio: number;
  language: string | null;
  timeZone: string | null;
  sockets: string | null;
  walletConnected: boolean;
  online: boolean | null;
  pageAgeS: number | null;
  modes: string[];
  errors: string[];
}

export function buildContext(s: ContextSources, element: ElementInfo | null): FeedbackContext {
  const vw = Math.round(s.innerWidth);
  const vh = Math.round(s.innerHeight);
  return {
    route: scrubRoute(s.pathname),
    build: BUILD_ID,
    browser: browserFamily(s.userAgent),
    os: osFamily(s.userAgent),
    viewport: vw > 0 && vh > 0 ? `${vw}x${vh}` : null,
    dpr: Number.isFinite(s.devicePixelRatio) && s.devicePixelRatio > 0 ? Math.round(s.devicePixelRatio * 100) / 100 : null,
    lang: s.language && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/.test(s.language) ? s.language : null,
    timeZone: s.timeZone,
    sockets: s.sockets,
    walletConnected: s.walletConnected,
    online: s.online,
    pageAgeS: s.pageAgeS !== null && Number.isFinite(s.pageAgeS) && s.pageAgeS >= 0 ? Math.round(s.pageAgeS) : null,
    modes: [...new Set(s.modes)],
    errors: s.errors.slice(0, 5),
    element,
  };
}

/** The connected wallet App.tsx remembers (`ot.address`), or null. */
export function connectedWallet(): string | null {
  try {
    const raw = localStorage.getItem('ot.address');
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** What this browser says right now. Async: the copy modes come from the copy code, loaded on demand. */
export async function gatherSources(): Promise<ContextSources> {
  let sockets: string | null = null;
  let modes: string[] = [];
  let errors: string[] = [];
  try {
    const { hub } = await import('../ws');
    sockets = [`hub ${hub.state}`, ...Object.entries(hub.upstream).map(([k, v]) => `${k} ${v}`)].join(' · ');
  } catch { /* the stream code is not loaded */ }
  try {
    const live = await import('../copy/live');
    modes = live.copyRows(live.getLiveCopy()).map((r) => r.mode);
  } catch { /* no copy state */ }
  try {
    errors = (await import('../errorReport')).recentErrorFingerprints();
  } catch { /* none */ }
  let timeZone: string | null = null;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch { /* none */ }
  return {
    pathname: window.location.pathname,
    userAgent: navigator.userAgent,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    language: navigator.language ?? null,
    timeZone,
    sockets,
    walletConnected: connectedWallet() !== null,
    online: typeof navigator.onLine === 'boolean' ? navigator.onLine : null,
    pageAgeS: typeof performance !== 'undefined' ? performance.now() / 1000 : null,
    modes,
    errors,
  };
}

/** The lines the form shows under "What will be sent". */
export function contextRows(c: FeedbackContext): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ['Page', c.route],
    ['Build', c.build],
    ['Browser', `${c.browser} on ${c.os}`],
    ['Window', `${c.viewport ?? '?'}${c.dpr ? ` at ${c.dpr}x` : ''}`],
    ['Language, time zone', `${c.lang ?? '?'} · ${c.timeZone ?? '?'}`],
    ['Connection', c.sockets ?? 'unknown'],
    ['Wallet connected', c.walletConnected ? 'yes' : 'no'],
    ['Online', c.online === null ? 'unknown' : c.online ? 'yes' : 'no'],
    ['Page open for', c.pageAgeS === null ? 'unknown' : c.pageAgeS < 120 ? `${c.pageAgeS} s` : `${Math.round(c.pageAgeS / 60)} min`],
    ['Copy modes in use', c.modes.length ? c.modes.join(', ') : 'none'],
    ['Recent errors', c.errors.length ? c.errors.join(', ') : 'none'],
  ];
  if (c.element) rows.push(['Element', `${c.element.path}${c.element.label ? ` “${c.element.label}”` : ''}${c.element.panel ? ` in ${c.element.panel}` : ''}`]);
  return rows;
}

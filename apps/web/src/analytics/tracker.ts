/**
 * ValueDesk's own usage analytics, in the browser - ONLY after consent
 * (legal/analyticsConsent.ts; what is measured: the Cookies page, section 5, and
 * apps/server/src/ops/analyticsModel.ts, which the server enforces).
 *
 * Until the visitor allows it, nothing here touches storage or the network: no
 * id, no request. Once allowed:
 *   - a page view per route change (the route only: addresses and ids replaced,
 *     no query) and how long the page was visible;
 *   - `track(name, details)` from the app's features - names from FEATURES only,
 *     details a few short words or numbers (never amounts, addresses or typed text);
 *   - page speed once per load (LCP, CLS, INP, FCP, TTFB);
 *   - a random visitor id (localStorage vd.an.v1, renewed after 13 months) and a
 *     visit id (sessionStorage vd.an.visit, a new one after 30 minutes idle);
 *   - the connected wallet's address, so the admin's user list can show use beside
 *     the builder volume the server counts for that wallet anyway.
 * Batches go to this site's own /api/vs/a every 15 s and when the page is hidden
 * (sendBeacon). Withdrawing consent stops everything and deletes both ids.
 */
import { analyticsAllowed, subscribeAnalyticsConsent } from '../legal/analyticsConsent';
import { BUILD_ID } from '../buildInfo';
import {
  ANALYTICS_MAX_EVENTS, ANALYTICS_VERSION, FEATURES, VISITOR_MAX_AGE_MS, VISIT_IDLE_MS, type AnalyticsBatch, type AnalyticsEvent,
} from '@sign/ops/analyticsModel';

const VISITOR_KEY = 'vd.an.v1';
const VISIT_KEY = 'vd.an.visit';
const ENDPOINT = '/api/vs/a';
const FLUSH_MS = 15_000;
/** At most this many events wait; a tab left open for days does not grow without end. */
const QUEUE_MAX = 500;

type Details = Record<string, string | number | boolean>;

/** The route as analytics records it: path words kept, addresses and ids replaced, no query. */
export function routeOf(pathname: string): string {
  const segs = pathname.split(/[?#]/)[0]!.split('/').filter(Boolean).slice(0, 4).map((seg) => {
    if (/^0x[0-9a-f]{6,}$/i.test(seg)) return ':address';
    return /^[a-z][a-z0-9-]{0,31}$/i.test(seg) ? seg.toLowerCase() : ':id';
  });
  return `/${segs.join('/')}`;
}

/** 16 random bytes, base64url: 22 characters. */
export function randomId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function readJson<T>(store: Storage, key: string): T | null {
  try {
    return JSON.parse(store.getItem(key) ?? 'null') as T | null;
  } catch {
    return null;
  }
}
function writeJson(store: Storage, key: string, v: unknown): void {
  try {
    store.setItem(key, JSON.stringify(v));
  } catch {
    /* storage off: ids for this page only */
  }
}

/** This browser's visitor id; a new one after 13 months. */
function visitorId(now: number): string {
  const v = readJson<{ id?: string; at?: number }>(localStorage, VISITOR_KEY);
  if (v?.id && /^[A-Za-z0-9_-]{22}$/.test(v.id) && typeof v.at === 'number' && now - v.at < VISITOR_MAX_AGE_MS) return v.id;
  const id = randomId();
  writeJson(localStorage, VISITOR_KEY, { id, at: now });
  return id;
}

/** This tab's visit id; a new one after 30 minutes without an event. */
function visitId(now: number): string {
  const v = readJson<{ id?: string; last?: number }>(sessionStorage, VISIT_KEY);
  const id = v?.id && /^[A-Za-z0-9_-]{22}$/.test(v.id) && typeof v.last === 'number' && now - v.last < VISIT_IDLE_MS ? v.id : randomId();
  writeJson(sessionStorage, VISIT_KEY, { id, last: now });
  return id;
}

export function browserOf(ua: string): { browser: string; os: string } {
  const m = (re: RegExp) => re.exec(ua)?.[1];
  const browser = m(/Edg\/(\d+)/) ? `edge ${m(/Edg\/(\d+)/)}` : m(/OPR\/(\d+)/) ? `opera ${m(/OPR\/(\d+)/)}` : m(/Firefox\/(\d+)/) ? `firefox ${m(/Firefox\/(\d+)/)}`
    : m(/Chrome\/(\d+)/) ? `chrome ${m(/Chrome\/(\d+)/)}` : m(/Version\/(\d+).*Safari/) ? `safari ${m(/Version\/(\d+).*Safari/)}` : 'other';
  const os = /iPhone|iPad|iPod/.test(ua) ? 'ios' : /Android/.test(ua) ? 'android' : /Windows/.test(ua) ? 'windows' : /Mac OS X|Macintosh/.test(ua) ? 'macos' : /Linux/.test(ua) ? 'linux' : 'other';
  return { browser, os };
}

/** The external site a visit came from (host only), and its campaign tags. */
export function sourceOf(referrer: string, search: string, ownHost: string): { ref?: string; utm?: AnalyticsBatch['ctx']['utm'] } {
  let ref: string | undefined;
  try {
    const h = referrer ? new URL(referrer).hostname.toLowerCase() : '';
    if (h && h !== ownHost.toLowerCase()) ref = h.replace(/^www\./, '');
  } catch {
    /* not a URL */
  }
  const q = new URLSearchParams(search);
  const word = (k: string) => {
    const v = q.get(k)?.trim();
    return v && /^[\w .+-]{1,60}$/.test(v) ? v : undefined;
  };
  const utm = { source: word('utm_source'), medium: word('utm_medium'), campaign: word('utm_campaign') };
  return { ...(ref ? { ref } : {}), ...(utm.source || utm.medium || utm.campaign ? { utm } : {}) };
}

/**
 * Feature uses the app already announces on window (components/account/actions.ts WALLET_EVENTS,
 * the dashboard's, feedback's, settings', the terms'): counted without touching those modules.
 */
export const EVENT_FEATURES: Readonly<Record<string, string>> = {
  'wallet:enable-trading': 'trading.enable',
  'wallet:deposit': 'deposit.open',
  'wallet:withdraw': 'withdraw.open',
  'wallet:transfer': 'transfer.open',
  'vs:open-feedback': 'feedback.open',
  'vd:sign-site-terms': 'terms.sign',
  'dash:edit': 'layout.edit',
  'dash:reset': 'layout.reset',
  'vs:settings': 'settings.change',
};

// --- the running tracker -------------------------------------------------------------------

let installed = false;
let running = false;
let queue: AnalyticsEvent[] = [];
let ctx: AnalyticsBatch['ctx'] = {};
let walletOf: () => string | null = () => null;
let page: { path: string; visibleMs: number; since: number | null } | null = null;
let timers: Array<ReturnType<typeof setInterval>> = [];
let vitalsSent = false;
const vitals: Record<string, number> = {};

function push(e: AnalyticsEvent): void {
  if (!running) return;
  queue.push(e);
  if (queue.length > QUEUE_MAX) queue = queue.slice(-QUEUE_MAX);
}

/** Record a feature use. A no-op without consent, and for a name not in FEATURES. */
export function track(name: string, d?: Details): void {
  if (!running || !Object.hasOwn(FEATURES, name)) return;
  push({ t: Date.now(), k: 'feature', p: routeOf(location.pathname), n: name, ...(d ? { d } : {}) });
}

function closePage(now: number): void {
  if (!page) return;
  const ms = page.visibleMs + (page.since !== null ? now - page.since : 0);
  if (ms >= 500) push({ t: now, k: 'time', p: page.path, ms: Math.round(ms) });
  page = null;
}

function openPage(now: number): void {
  const path = routeOf(location.pathname);
  page = { path, visibleMs: 0, since: document.visibilityState === 'visible' ? now : null };
  push({ t: now, k: 'view', p: path });
}

function flush(beacon = false): void {
  if (!running || !queue.length) return;
  const now = Date.now();
  while (queue.length) {
    const batch: AnalyticsBatch = {
      v: ANALYTICS_VERSION, consent: 'analytics', visitor: visitorId(now), visit: visitId(now), ctx,
      ...(walletOf() ? { wallet: walletOf()! } : {}),
      events: queue.splice(0, ANALYTICS_MAX_EVENTS),
    };
    const body = JSON.stringify(batch);
    // text/plain: no preflight, and what sendBeacon can send.
    if (beacon && typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'text/plain' }))) continue;
    void fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'text/plain' }, body, keepalive: true, credentials: 'omit' }).catch(() => null);
  }
}

function sendVitals(now: number): void {
  if (vitalsSent) return;
  vitalsSent = true;
  for (const [n, v] of Object.entries(vitals)) push({ t: now, k: 'vital', p: routeOf(location.pathname), n, ms: Math.round(n === 'CLS' ? v * 1000 : v) });
}

function observeVitals(): void {
  if (typeof PerformanceObserver === 'undefined') return;
  const watch = (type: string, cb: (list: PerformanceObserverEntryList) => void, extra: Record<string, unknown> = {}) => {
    try {
      new PerformanceObserver(cb).observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
    } catch {
      /* not supported by this browser */
    }
  };
  watch('largest-contentful-paint', (l) => {
    const last = l.getEntries().at(-1);
    if (last) vitals.LCP = last.startTime;
  });
  watch('paint', (l) => {
    for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') vitals.FCP = e.startTime;
  });
  watch('layout-shift', (l) => {
    for (const e of l.getEntries() as Array<PerformanceEntry & { value?: number; hadRecentInput?: boolean }>) {
      if (!e.hadRecentInput && typeof e.value === 'number') vitals.CLS = (vitals.CLS ?? 0) + e.value;
    }
  });
  watch('event', (l) => {
    for (const e of l.getEntries()) vitals.INP = Math.max(vitals.INP ?? 0, e.duration);
  }, { durationThreshold: 40 });
  const nav = performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined;
  if (nav && nav.responseStart > 0) vitals.TTFB = nav.responseStart;
}

function begin(): void {
  if (running || !analyticsAllowed()) return;
  running = true;
  const now = Date.now();
  const { browser, os } = browserOf(navigator.userAgent);
  const w = innerWidth;
  ctx = {
    lang: navigator.language || undefined,
    tz: (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch {
        return undefined;
      }
    })(),
    screen: `${screen.width}x${screen.height}`,
    device: w < 768 ? 'mobile' : w < 1100 && navigator.maxTouchPoints > 0 ? 'tablet' : 'desktop',
    browser,
    os,
    theme: matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark',
    ...sourceOf(document.referrer, location.search, location.hostname),
    landing: routeOf(location.pathname),
    build: BUILD_ID,
  };
  openPage(now);
  observeVitals();
  // The connected wallet, read from the app's wallet module once analytics runs (never before).
  void import('../walletconnect').then((m) => {
    walletOf = () => m.getWalletSnapshot().address?.toLowerCase() ?? null;
  }).catch(() => null);
  let path = location.pathname;
  let wallet = walletOf();
  const quietUntil = now + 5_000;
  timers = [
    // Route changes: the app moves with history.pushState; a look every second finds them.
    setInterval(() => {
      const w = walletOf();
      // A connection restored as the page loads is no new connect.
      if (w && w !== wallet && Date.now() > quietUntil) track('wallet.connect');
      wallet = w;
      if (location.pathname === path) return;
      path = location.pathname;
      const t = Date.now();
      closePage(t);
      openPage(t);
    }, 1_000),
    setInterval(() => flush(), FLUSH_MS),
  ];
}

function end(): void {
  running = false;
  queue = [];
  page = null;
  for (const t of timers) clearInterval(t);
  timers = [];
  try {
    localStorage.removeItem(VISITOR_KEY);
    sessionStorage.removeItem(VISIT_KEY);
  } catch {
    /* storage off */
  }
}

/** Install once at boot. Does nothing - no storage, no request - until the visitor allows analytics. */
export function startAnalytics(o: { wallet?: () => string | null } = {}): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  if (o.wallet) walletOf = o.wallet;
  for (const [event, name] of Object.entries(EVENT_FEATURES)) addEventListener(event, () => track(name));
  subscribeAnalyticsConsent(() => (analyticsAllowed() ? begin() : end()));
  document.addEventListener('visibilitychange', () => {
    if (!running || !page) return;
    const now = Date.now();
    if (document.visibilityState === 'hidden') {
      if (page.since !== null) page.visibleMs += now - page.since;
      page.since = null;
      sendVitals(now);
      flush(true);
    } else {
      page.since = now;
    }
  });
  addEventListener('pagehide', () => {
    if (!running) return;
    const now = Date.now();
    closePage(now);
    sendVitals(now);
    flush(true);
  });
  begin();
}

/** For tests: what is waiting, and a clean slate. */
export function _queueForTests(): readonly AnalyticsEvent[] {
  return queue;
}
export function _resetForTests(): void {
  end();
  installed = false;
  vitalsSent = false;
}

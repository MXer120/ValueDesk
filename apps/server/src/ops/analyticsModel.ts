/**
 * ValueDesk's own product analytics: what the browser may send, shared by the web
 * (apps/web/src/analytics/, through the @sign alias) and the server that takes it
 * (ops/analytics.ts, POST /api/vs/a). Pure.
 *
 * Sent ONLY after the visitor allowed analytics ("Accept all" in the terms popup,
 * or the switch on the Cookies page - apps/web/src/legal/analyticsConsent.ts), to
 * ValueDesk's own server and nowhere else. No cookie, no IP address kept, no
 * fingerprint, no session recording, no keystrokes or form contents, no amounts.
 *
 * What one batch holds:
 *   visitor   a random id this browser keeps (localStorage vd.an.v1) until consent
 *             is withdrawn or 13 months pass - new vs returning visitors, retention
 *   visit     a random id of this tab's visit (sessionStorage), 30 minutes idle ends it
 *   ctx       language, time zone, screen size, device class, browser and OS family,
 *             theme, the external site the visit came from (its host only), UTM
 *             tags, the landing page, the build
 *   wallet    the connected wallet address, if any (links the visit to the user list)
 *   events    page views (route only, addresses replaced), active time on a page,
 *             named feature uses (FEATURES), page speed (VITALS)
 * The server adds the country and region Vercel's edge resolved for the request.
 */

export const ANALYTICS_VERSION = 1;
/** One batch: a request every few seconds at most from one tab. */
export const ANALYTICS_MAX_EVENTS = 50;
export const ANALYTICS_BODY_LIMIT = 16 * 1024;
/** The visitor id is renewed after this (13 months). */
export const VISITOR_MAX_AGE_MS = 395 * 86_400_000;
/** A visit ends after this long without an event. */
export const VISIT_IDLE_MS = 30 * 60_000;

export const EVENT_KINDS = ['view', 'time', 'feature', 'vital'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/**
 * The feature names the app sends, with what each means on the admin page. A
 * name not in this list is dropped by the server - so a typo or an old build
 * cannot fill the table with names nobody can read.
 */
export const FEATURES: Readonly<Record<string, string>> = {
  'wallet.connect': 'Connected a wallet',
  'onboarding.open': 'Welcome flow: opened',
  'onboarding.step': 'Welcome flow: reached a step',
  'onboarding.done': 'Welcome flow: finished',
  'onboarding.skip': 'Welcome flow: skipped',
  'terms.sign': 'Signed the terms',
  'trading.enable': 'Enabled trading (API key)',
  'builder.approve': 'Approved the builder fee',
  'order.place': 'Placed an order',
  'order.cancel': 'Cancelled an order',
  'position.close': 'Closed a position',
  'algo.start': 'Started an algo order',
  'algo.stop': 'Stopped an algo order',
  'copy.start': 'Started copying a trader',
  'copy.stop': 'Stopped copying',
  'bot.start': 'Started a bot',
  'bot.stop': 'Stopped a bot',
  'deposit.open': 'Opened deposit',
  'withdraw.open': 'Opened withdraw',
  'transfer.open': 'Opened transfer',
  'widget.add': 'Added a widget',
  'widget.remove': 'Removed a widget',
  'layout.edit': 'Edited the dashboard layout',
  'layout.reset': 'Reset the dashboard layout',
  'layout.save': 'Saved a layout',
  'layout.restore': 'Restored a layout',
  'palette.open': 'Opened the command palette',
  'search.run': 'Searched',
  'chart.open': 'Opened a chart',
  'chart.export': 'Exported a chart',
  'trader.open': 'Opened a trader profile',
  'cohort.open': 'Opened a cohort',
  'liq.open': 'Opened the liquidation heatmap',
  'news.open': 'Opened a news item',
  'calendar.open': 'Opened an economic event',
  'livefeed.play': 'Played a live stream',
  'alert.create': 'Created an alert',
  'watchlist.add': 'Added to the watchlist',
  'feedback.open': 'Opened feedback',
  'feedback.send': 'Sent feedback',
  'share.card': 'Shared a card',
  'settings.change': 'Changed a setting',
  'theme.change': 'Changed the theme',
  'privacy.toggle': 'Toggled privacy mode',
};

/** Page speed, as the browser measures it (web-vitals names). */
export const VITALS = ['LCP', 'INP', 'CLS', 'FCP', 'TTFB'] as const;

export const DEVICES = ['desktop', 'tablet', 'mobile'] as const;

export interface AnalyticsEvent {
  /** ms since the epoch, the browser's clock. */
  t: number;
  k: EventKind;
  /** The route, e.g. /trader/:address (no query, no address). */
  p: string;
  /** A feature name (FEATURES) or a vital (VITALS). */
  n?: string;
  /** Active ms on the page (time), the vital's value (vital; CLS x 1000). */
  ms?: number;
  /** A few short details of a feature use, e.g. {venue: "sodex", type: "limit"}. Never an amount or an address. */
  d?: Record<string, string | number | boolean>;
}

export interface AnalyticsBatch {
  v: number;
  /** The visitor's declaration that analytics was allowed - the browser sends nothing without it. */
  consent: 'analytics';
  visitor: string;
  visit: string;
  ctx: {
    lang?: string;
    tz?: string;
    screen?: string;
    device?: (typeof DEVICES)[number];
    browser?: string;
    os?: string;
    theme?: string;
    ref?: string;
    utm?: { source?: string; medium?: string; campaign?: string };
    landing?: string;
    build?: string;
  };
  wallet?: string;
  events: AnalyticsEvent[];
}

/** A visitor or visit id: 16 random bytes, base64url. */
export const ANALYTICS_ID = /^[A-Za-z0-9_-]{22}$/;

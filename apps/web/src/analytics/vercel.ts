/**
 * Vercel Web Analytics and Speed Insights (owner 2026-11-07: "enable web analytics of vercel & speed
 * insights if thats free/cheap"), under the same consent as ValueDesk's own analytics
 * (legal/analyticsConsent.ts: "Accept all", the one-time prompt, the Cookies page switch).
 *
 *   - Only on the production site (PRODUCTION_HOSTS): not on beta, dev.valuedesk.so (the admin entry never
 *     imports this), previews or localhost.
 *   - Nothing loads before the visitor allows analytics; a withdrawal drops every later event at once
 *     (beforeSend), as the script cannot be unloaded.
 *   - Both scripts and their beacons are same-origin (/_vercel/insights/*, /_vercel/speed-insights/*), so the
 *     CSP stays 'self'. Neither sets a cookie.
 *   - Wallet addresses in a path (/trader/0x..., /copy/0x...) are replaced before anything is sent, and the
 *     query and hash are dropped: Vercel gets the page, never whose page.
 *   - Speed Insights samples SPEED_SAMPLE_RATE of page loads, so its free 10,000 data points per 30 days last
 *     (each sampled load sends a few Web Vitals); Web Analytics counts every allowed page view (50,000 a
 *     month free on Hobby, then it pauses - no charge).
 *
 * The project needs Web Analytics and Speed Insights switched on in the Vercel dashboard (the owner's click);
 * until then the two script paths answer 404 and nothing is counted.
 */
import { inject, type BeforeSendEvent } from '@vercel/analytics';
import { injectSpeedInsights } from '@vercel/speed-insights';
import { analyticsAllowed, subscribeAnalyticsConsent } from '../legal/analyticsConsent';

export const PRODUCTION_HOSTS: ReadonlySet<string> = new Set(['www.valuedesk.so', 'valuedesk.so']);
/** One page load in ten sends its Web Vitals. */
export const SPEED_SAMPLE_RATE = 0.1;

const WALLET = /0x[0-9a-fA-F]{40}/g;

/** The URL Vercel may see: origin and path, wallet addresses replaced, no query, no hash. Null: send nothing. */
export function cleanUrl(raw: string, allowed: boolean): string | null {
  if (!allowed) return null;
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname.replace(WALLET, '[wallet]')}`;
  } catch {
    return null;
  }
}

let started = false;

function load(): void {
  if (started) return;
  started = true;
  const before = <T extends { url: string }>(e: T): T | null => {
    const url = cleanUrl(e.url, analyticsAllowed());
    return url ? { ...e, url } : null;
  };
  inject({ mode: 'production', scriptSrc: '/_vercel/insights/script.js', beforeSend: (e: BeforeSendEvent) => before(e) });
  injectSpeedInsights({ sampleRate: SPEED_SAMPLE_RATE, scriptSrc: '/_vercel/speed-insights/script.js', beforeSend: (e) => before(e) });
}

/** Once at boot (main.tsx). Loads nothing until the visitor allows analytics on a production host. */
export function startVercelInsights(host = typeof location === 'undefined' ? '' : location.hostname): void {
  if (!PRODUCTION_HOSTS.has(host)) return;
  if (analyticsAllowed()) load();
  else subscribeAnalyticsConsent(() => {
    if (analyticsAllowed()) load();
  });
}

/**
 * Consent for ValueDesk's own usage analytics (§ 25(1) TDDDG, Art. 6(1)(a) GDPR;
 * the Cookies page, section 5, says what is measured; apps/web/src/analytics/).
 *
 * Nothing is measured or sent before the visitor allows it: "Accept all" in the
 * terms popup (next to an equally visible "Only necessary", never pre-selected,
 * never a condition of the terms - LegalGate.tsx), or the switch on the Cookies
 * page, where it is withdrawn too. Withdrawing stops the tracker at once and
 * deletes its visitor number from this browser (analytics/usage.ts listens).
 * Kept in this browser only. A "no" is kept too ("Only necessary" in the terms popup,
 * "No thanks" in the prompt, a withdrawal), so that nobody is asked twice
 * (AnalyticsPrompt.tsx asks only those who never decided).
 */
import { useSyncExternalStore } from 'react';

const KEY = 'vd.consent.analytics.v1';

const listeners = new Set<() => void>();
/** When the visitor allowed analytics (ms), or null; undefined: not read yet. */
let allowedAt: number | null | undefined;
/** When the visitor said no (ms), or null. */
let declinedAt: number | null = null;

function load(): number | null {
  if (allowedAt !== undefined) return allowedAt;
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { allowedAt?: unknown; declinedAt?: unknown } | null;
    allowedAt = typeof v?.allowedAt === 'number' && Number.isFinite(v.allowedAt) ? v.allowedAt : null;
    declinedAt = typeof v?.declinedAt === 'number' && Number.isFinite(v.declinedAt) ? v.declinedAt : null;
  } catch {
    allowedAt = null;
  }
  return allowedAt;
}

function save(o: { allowedAt: number } | { declinedAt: number }): void {
  allowedAt = 'allowedAt' in o ? o.allowedAt : null;
  declinedAt = 'declinedAt' in o ? o.declinedAt : null;
  try {
    localStorage.setItem(KEY, JSON.stringify(o));
  } catch {
    /* private mode: for this page only */
  }
  for (const l of listeners) l();
}

export const analyticsAllowedAt = (): number | null => load();
export const analyticsAllowed = (): boolean => load() !== null;
/** The visitor answered either way (allowed, or said no / withdrew). */
export const analyticsDecided = (): boolean => load() !== null || declinedAt !== null;
export const allowAnalytics = (now = Date.now()): void => save({ allowedAt: load() ?? now });
/** "No": nothing is measured, and the visitor is not asked again. A withdrawal is the same. */
export const declineAnalytics = (now = Date.now()): void => save({ declinedAt: now });
export const revokeAnalytics = (): void => declineAnalytics();

export function subscribeAnalyticsConsent(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useAnalyticsAllowedAt(): number | null {
  return useSyncExternalStore(subscribeAnalyticsConsent, analyticsAllowedAt, analyticsAllowedAt);
}

/** For tests. */
export function _resetAnalyticsConsentForTests(): void {
  allowedAt = undefined;
  declinedAt = null;
}

/**
 * Consent for ValueDesk's own usage analytics (§ 25(1) TDDDG, Art. 6(1)(a) GDPR;
 * the Cookies page, section 5, says what is measured; apps/web/src/analytics/).
 *
 * Nothing is measured or sent before the visitor allows it: "Accept all" in the
 * terms popup (next to an equally visible "Only necessary", never pre-selected,
 * never a condition of the terms - LegalGate.tsx), or the switch on the Cookies
 * page, where it is withdrawn too. Withdrawing stops the tracker at once and
 * deletes its visitor number from this browser (analytics/tracker.ts listens).
 * Kept in this browser only.
 */
import { useSyncExternalStore } from 'react';

const KEY = 'vd.consent.analytics.v1';

const listeners = new Set<() => void>();
/** When the visitor allowed analytics (ms), or null; undefined: not read yet. */
let allowedAt: number | null | undefined;

function load(): number | null {
  if (allowedAt !== undefined) return allowedAt;
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { allowedAt?: unknown } | null;
    allowedAt = typeof v?.allowedAt === 'number' && Number.isFinite(v.allowedAt) ? v.allowedAt : null;
  } catch {
    allowedAt = null;
  }
  return allowedAt;
}

function save(at: number | null): void {
  allowedAt = at;
  try {
    if (at === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify({ allowedAt: at }));
  } catch {
    /* private mode: for this page only */
  }
  for (const l of listeners) l();
}

export const analyticsAllowedAt = (): number | null => load();
export const analyticsAllowed = (): boolean => load() !== null;
export const allowAnalytics = (now = Date.now()): void => save(load() ?? now);
export const revokeAnalytics = (): void => save(null);

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
}

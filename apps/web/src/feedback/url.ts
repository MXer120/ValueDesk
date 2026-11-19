/**
 * The build's Discord (community) invite, on its own: the More menu and the beta page link to it from the
 * entry, and importing it from feedback.ts brought that module's secret check - the 2,048-word seed-phrase
 * list (@sign/ops/secrets) - into every page's first render. Only the feedback form needs that, and it loads
 * on its first open (FeedbackHost.tsx).
 *
 * VITE_FEEDBACK_URL (the owner's Discord invite, https) adds a "Discord" button
 * to the form; without it that button says "coming soon".
 */

/** A usable Discord (or other community) page: https, nothing else. Anything else counts as unset. */
export function feedbackUrlFrom(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}

/** The build's Discord invite, or null. */
export const FEEDBACK_URL: string | null = feedbackUrlFrom(import.meta.env?.VITE_FEEDBACK_URL);

import { ExecutorError } from '../copy/executor';

/**
 * A sign-in that did not go through (owner 2026-11-09: "getting method not allowed when signing in + the error message
 * is permanent"): a warning that closes by itself, in words - never an error toast that stays until closed, never the
 * server's raw text. One the wallet cancelled says nothing.
 */
export function signInWords(e: unknown): string | null {
  const m = e instanceof Error ? e.message : String(e);
  if (/reject|denied|cancel/i.test(m)) return null;
  if (e instanceof ExecutorError) {
    if (e.status === 405 || e.status === 404 || e.status === 502 || e.status === 503 || e.status === 504) return "Your bots' servers did not answer the sign-in just now. Your bots keep running. Try again in a minute.";
    if (e.status === 429) return 'Too many sign-ins just now. Try again in a minute.';
  }
  if (/timed out|timeout|failed to fetch|network/i.test(m)) return 'The sign-in got no answer. Check your connection and try again.';
  return /^[A-Z][^{}<>]{0,160}[.!?]$/.test(m.trim()) ? m.trim() : 'The sign-in did not go through. Try again.';
}

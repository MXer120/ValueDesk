import { ExecutorError } from '../copy/executor';
import { logger } from '../log';

const log = logger('bots');

/**
 * A sign-in that did not go through (owner 2026-11-09: "getting method not allowed when signing in + the error message
 * is permanent"): a warning that closes by itself, in words - never an error toast that stays until closed, never the
 * server's raw text. One the wallet cancelled says nothing.
 *
 * The executor's signature refusals (copy-engine api.ts verifyCopyRequest) each get their own sentence (owner
 * 2026-11-28: a user saw only "The sign-in did not go through. Try again." and nobody could tell why): the device's
 * clock, a signature that took too long, another account in the wallet, a stale day key. Any other refusal keeps the
 * plain sentence; its reason goes to the log.
 */
export function signInWords(e: unknown): string | null {
  const m = e instanceof Error ? e.message : String(e);
  if (/reject|denied|cancel/i.test(m)) return null;
  if (e instanceof ExecutorError) {
    if (e.status === 405 || e.status === 404 || e.status === 502 || e.status === 503 || e.status === 504) return "Your bots' servers did not answer the sign-in just now. Your bots keep running. Try again in a minute.";
    if (e.status === 429) return 'Too many sign-ins just now. Try again in a minute.';
    if (e.code === 'signature') {
      if (/too far from now/i.test(m)) return "Your device's clock is off, so the sign-in was refused. Set the date and time to automatic, then sign in again.";
      if (/has expired/i.test(m)) return 'The signature arrived after its 5 minutes ran out. Sign in again and confirm in your wallet right away.';
      if (/another executor/i.test(m)) return 'Your bots changed servers while you signed. Sign in again.';
      if (/day key/i.test(m)) return "This browser's daily key no longer holds. Sign in again; your wallet asks once.";
      if (/not from this wallet|another wallet|cannot be read/i.test(m)) return 'The signature came from another account than the connected one. Switch your wallet to the connected address, then sign in again.';
    }
  }
  if (/timed out|timeout|failed to fetch|network/i.test(m)) return 'The sign-in got no answer. Check your connection and try again.';
  if (/^[A-Z][^{}<>]{0,160}[.!?]$/.test(m.trim())) return m.trim();
  log.warn('bots: sign-in refused', { error: m, status: e instanceof ExecutorError ? e.status : null, code: e instanceof ExecutorError ? e.code : null });
  return 'The sign-in did not go through. Try again.';
}

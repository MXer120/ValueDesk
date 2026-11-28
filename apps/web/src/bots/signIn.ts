import { ExecutorError } from '../copy/executor';
import { logger } from '../log';

const log = logger('bots');

/**
 * A sign-in that did not go through (owner 2026-11-09: "getting method not allowed when signing in + the error message
 * is permanent"): a warning that closes by itself, never the server's raw text. One the wallet cancelled says nothing.
 *
 * Every failure is one sentence with an error code (owner 2026-11-28: "just an error code for everything and we should
 * have the logs so we know the exact issue"): the code names the cause, the executor logs the refusal with the wallet
 * and the same reason (server.ts), so a user's screenshot is enough to find it.
 *   SIG-CLOCK   the request's time is more than 15 min from the executor's      SIG-LATE   signed after its deadline
 *   SIG-SERVER  signed for another executor (bots moved meanwhile)              SIG-DAYKEY this browser's day key refused
 *   SIG-ACCOUNT signed by another account than the connected wallet             SIG-OTHER  any other signature refusal
 *   DOWN        the executor did not answer (404/405/5xx)                        BUSY       rate-limited (429)
 *   NET         no answer at all (network)                                      HTTP-<n>   any other refusal
 *   WALLET      the wallet itself failed before anything was sent
 */
export function signInCode(e: unknown): string | null {
  const m = e instanceof Error ? e.message : String(e);
  if (/reject|denied|cancel/i.test(m)) return null;
  if (e instanceof ExecutorError) {
    if (e.code === 'network' || e.status === 0) return 'NET';
    if (e.status === 405 || e.status === 404 || e.status === 502 || e.status === 503 || e.status === 504) return 'DOWN';
    if (e.status === 429) return 'BUSY';
    if (e.code === 'signature') {
      if (/too far from now/i.test(m)) return 'SIG-CLOCK';
      if (/has expired/i.test(m)) return 'SIG-LATE';
      if (/another executor/i.test(m)) return 'SIG-SERVER';
      if (/day key/i.test(m)) return 'SIG-DAYKEY';
      if (/not from this wallet|another wallet|cannot be read/i.test(m)) return 'SIG-ACCOUNT';
      return 'SIG-OTHER';
    }
    return `HTTP-${e.status}`;
  }
  if (/timed out|timeout|failed to fetch|network/i.test(m)) return 'NET';
  return 'WALLET';
}

export function signInWords(e: unknown): string | null {
  const code = signInCode(e);
  if (!code) return null;
  log.warn('bots: sign-in failed', { code, error: e instanceof Error ? e.message : String(e), status: e instanceof ExecutorError ? e.status : null });
  return `The sign-in did not go through. Try again. Code: ${code}`;
}

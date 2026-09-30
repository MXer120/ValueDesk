/**
 * Origin allow-listing for a loopback-only server.
 *
 * WebSocket upgrades are NOT covered by CORS: a browser will happily open a
 * socket to 127.0.0.1 from any origin, and the page on the other end could then
 * read this user's account stream. CORS also does not *prevent* a cross-origin
 * POST from executing - it only stops the response being read - and for a signed
 * trading action the side effect is the whole problem.
 *
 * A missing Origin is allowed: native clients (curl, the sodex CLI, test
 * scripts) omit it, and they can reach loopback regardless. The threat being
 * closed off is a malicious *web page*, and browsers always attach an Origin.
 *
 * Note this parses the URL rather than substring-matching, so
 * `http://localhost.evil.example` is correctly rejected.
 */
export function isAllowedOrigin(origin: string | undefined | null, extra: readonly string[] = []): boolean {
  if (!origin) return true;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return true;
  // A hosted deployment's own site(s), by exact origin (VALUETRADE_ALLOWED_ORIGINS).
  return extra.some((e) => {
    try {
      return new URL(e).origin === u.origin;
    } catch {
      return false;
    }
  });
}
